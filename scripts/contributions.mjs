// Draws the contribution cards in README.md: one card for the whole year and
// one per most-active public repo, each a heatmap of soft rounded squares.
//   GITHUB_TOKEN=… node scripts/contributions.mjs <login> <out-dir>
import {mkdirSync, writeFileSync} from 'node:fs';

const [login = 'Reubencfernandes', outDir = 'dist'] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error('Set GITHUB_TOKEN.');

const REPO_CARDS = 4;
const REPO_WEEKS = 26;

const QUERY = `query($login: String!, $since: DateTime!) {
  user(login: $login) {
    year: contributionsCollection {
      totalCommitContributions totalPullRequestContributions totalIssueContributions
      totalPullRequestReviewContributions restrictedContributionsCount
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
    }
    recent: contributionsCollection(from: $since) {
      commitContributionsByRepository(maxRepositories: 25) {
        repository { name isPrivate isFork description }
        contributions(first: 100, orderBy: {field: OCCURRED_AT, direction: DESC}) { totalCount nodes { occurredAt commitCount } }
      }
    }
  }
}`;

async function fetchData() {
  const since = new Date(Date.now() - REPO_WEEKS * 7 * 864e5).toISOString();
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'contribution-cards'},
    body: JSON.stringify({query: QUERY, variables: {login, since}}),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(JSON.stringify(body.errors || body));
  return body.data.user;
}

// ---- data -----------------------------------------------------------------

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);

/** Columns of 7 days (Sunday first) ending with the week that holds `last`. */
function weekGrid(counts, last, weeks) {
  const end = new Date(`${last}T00:00:00Z`);
  const start = addDays(end, -end.getUTCDay() - (weeks - 1) * 7);
  return Array.from({length: weeks}, (_, w) => Array.from({length: 7}, (_, d) => {
    const date = addDays(start, w * 7 + d);
    const key = iso(date);
    return key > last ? null : {date: key, count: counts.get(key) || 0};
  }));
}

/** 0–4 like GitHub: quartiles of the non-zero days in view. */
function leveller(columns) {
  const values = columns.flat().filter((c) => c?.count > 0).map((c) => c.count).sort((a, b) => a - b);
  const q = (p) => values[Math.min(values.length - 1, Math.floor(p * values.length))] ?? 1;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  return (n) => (n <= 0 ? 0 : n <= cuts[0] ? 1 : n <= cuts[1] ? 2 : n <= cuts[2] ? 3 : 4);
}

function streaks(days) {
  let best = 0;
  let run = 0;
  for (const d of days) {
    run = d.count > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  // Today still counts as "on a streak" until it ends without a contribution.
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].count > 0) current++;
    else if (i === days.length - 1) continue;
    else break;
  }
  return {current, best};
}

// ---- drawing --------------------------------------------------------------

const THEMES = {
  dark: {
    card: '#1b1b21', stroke: '#2b2b34', empty: '#26262e', text: '#f2f2f5', muted: '#8d8d99',
    pill: '#24242c', iconBg: 0.16,
  },
  light: {
    card: '#ffffff', stroke: '#e4e4ea', empty: '#eeeef2', text: '#18181d', muted: '#6b6b76',
    pill: '#f2f2f6', iconBg: 0.14,
  },
};
const ACCENTS = ['#8b8df9', '#f2a65a', '#5ccfe6', '#6fd39a', '#f27f9b'];
const OPACITY = [0, 0.3, 0.52, 0.76, 1];
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
const fmt = (n) => n.toLocaleString('en-US');

const ICONS = {
  // A commit on a line.
  commit: '<circle cx="12" cy="12" r="3.6"/><path d="M2.5 12h5.9M15.6 12h5.9"/>',
  // Code brackets.
  code: '<path d="M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5"/>',
  check: '<path d="m6.5 12.5 3.6 3.6 7.4-8"/>',
  flame: '<path d="M12 3.5c.6 2.6 3.9 4.4 3.9 8.4a3.9 3.9 0 0 1-7.8 0c0-1.7.8-2.9 1.9-3.9.1 1.4.8 2.3 1.7 2.6-.3-2.6-.6-4.6.3-7.1z"/>',
};

function icon(name, x, y, size, color, width = 2) {
  const s = size / 24;
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</g>`;
}

function pill(x, y, label, t, accent, withFlame = false) {
  const w = label.length * 7.4 + (withFlame ? 34 : 20);
  const text = withFlame ? accent : t.muted;
  return {
    width: w,
    svg: `<g transform="translate(${x} ${y})">
      <rect width="${w}" height="26" rx="13" fill="${withFlame ? accent : t.pill}" fill-opacity="${withFlame ? 0.16 : 1}"/>
      ${withFlame ? icon('flame', 9, 6, 14, accent, 1.8) : ''}
      <text x="${withFlame ? 27 : 10}" y="17.5" font-family="${MONO}" font-size="12" fill="${text}">${esc(label)}</text>
    </g>`,
  };
}

function pills(x, y, items, t, accent) {
  let cx = x;
  return items.map(([label, flame]) => {
    const p = pill(cx, y, label, t, accent, flame);
    cx += p.width + 8;
    return p.svg;
  }).join('');
}

function grid(columns, x, y, cell, gap, accent, t, monthLabels) {
  const level = leveller(columns);
  const pitch = cell + gap;
  const r = Math.round(cell * 0.28 * 10) / 10;
  const out = [];
  if (monthLabels) {
    let lastCol = -4;
    let lastMonth = -1;
    columns.forEach((col, w) => {
      const first = col.find(Boolean);
      if (!first) return;
      const month = Number(first.date.slice(5, 7)) - 1;
      if (month !== lastMonth && w - lastCol >= 3 && w <= columns.length - 2) {
        out.push(`<text x="${x + w * pitch}" y="${y - 9}" font-family="${MONO}" font-size="11" fill="${t.muted}">${MONTHS[month]}</text>`);
        lastCol = w;
      }
      lastMonth = month;
    });
  }
  columns.forEach((col, w) => col.forEach((day, d) => {
    if (!day) return;
    const cx = x + w * pitch;
    const cy = y + d * pitch;
    const lv = level(day.count);
    out.push(lv
      ? `<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="${r}" fill="${accent}" fill-opacity="${OPACITY[lv]}"><title>${day.date}: ${day.count}</title></rect>`
      : `<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="${r}" fill="${t.empty}"/>`);
  }));
  return out.join('');
}

function header(x, y, width, title, subtitle, iconName, accent, t, done) {
  return `
    <rect x="${x}" y="${y}" width="46" height="46" rx="13" fill="${accent}" fill-opacity="${t.iconBg}"/>
    ${icon(iconName, x + 11, y + 11, 24, accent)}
    <text x="${x + 62}" y="${y + 21}" font-family="${FONT}" font-size="19" font-weight="650" fill="${t.text}">${esc(title)}</text>
    <text x="${x + 62}" y="${y + 40}" font-family="${FONT}" font-size="13" fill="${t.muted}">${esc(subtitle)}</text>
    <rect x="${x + width - 46}" y="${y}" width="46" height="46" rx="13" fill="${done ? accent : t.pill}" ${done ? '' : `stroke="${t.stroke}"`}/>
    ${icon('check', x + width - 35, y + 11, 24, done ? t.card : t.muted, 2.4)}`;
}

function render(data, theme) {
  const t = THEMES[theme];
  const W = 840;
  const P = 24;
  const parts = [];

  // Year card.
  const days = data.year.contributionCalendar.weeks.flatMap((w) => w.contributionDays)
    .map((d) => ({date: d.date, count: d.contributionCount}));
  const last = days.at(-1).date;
  const counts = new Map(days.map((d) => [d.date, d.count]));
  const yearCols = weekGrid(counts, last, 53);
  const {current, best} = streaks(days);
  const weekStart = iso(addDays(new Date(`${last}T00:00:00Z`), -new Date(`${last}T00:00:00Z`).getUTCDay()));
  const thisWeek = days.filter((d) => d.date >= weekStart).reduce((s, d) => s + d.count, 0);
  const total = data.year.contributionCalendar.totalContributions;
  const accent = ACCENTS[0];
  const yearH = 284;
  parts.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${yearH}" rx="24" fill="${t.card}" stroke="${t.stroke}"/>`);
  parts.push(header(P, P, W - 2 * P, 'Contributions', `${fmt(total)} in the last year${data.year.restrictedContributionsCount ? ', private work included' : ''}`, 'commit', accent, t, (counts.get(last) || 0) > 0));
  parts.push(grid(yearCols, P, 118, 12, 3, accent, t, true));
  parts.push(pills(P, 238, [
    [`${current} day streak`, true],
    [`${fmt(thisWeek)} this week`],
    [`best streak ${best} days`],
    [`${fmt(data.year.totalCommitContributions)} public commits`],
    ...(data.year.restrictedContributionsCount ? [[`${fmt(data.year.restrictedContributionsCount)} private`]] : []),
  ], t, accent));

  // Repo cards: the most active public repos over the last six months.
  const repos = data.recent.commitContributionsByRepository
    .filter((r) => !r.repository.isPrivate && !r.repository.isFork)
    .sort((a, b) => b.contributions.totalCount - a.contributions.totalCount)
    .slice(0, REPO_CARDS);
  const cardW = (W - 16) / 2;
  const cardH = 240;
  repos.forEach((repo, i) => {
    const x = (i % 2) * (cardW + 16);
    const y = yearH + 16 + Math.floor(i / 2) * (cardH + 16);
    const color = ACCENTS[(i + 1) % ACCENTS.length];
    const perDay = new Map();
    for (const n of repo.contributions.nodes) {
      const key = n.occurredAt.slice(0, 10);
      perDay.set(key, (perDay.get(key) || 0) + n.commitCount);
    }
    const commits = [...perDay.values()].reduce((s, n) => s + n, 0);
    const cols = weekGrid(perDay, last, REPO_WEEKS);
    const repoWeek = [...perDay].filter(([d]) => d >= weekStart).reduce((s, [, n]) => s + n, 0);
    const desc = repo.repository.description || 'Public repository';
    parts.push(`<g transform="translate(${x} ${y})">
      <rect x="0.5" y="0.5" width="${cardW - 1}" height="${cardH}" rx="22" fill="${t.card}" stroke="${t.stroke}"/>
      ${header(20, 20, cardW - 40, repo.repository.name, desc.length > 44 ? `${desc.slice(0, 43)}…` : desc, 'code', color, t, repoWeek > 0)}
      ${grid(cols, 20, 84, 11, 3.3, color, t, false)}
      ${pills(20, 196, [[`${fmt(commits)} commits`, true], [`${perDay.size} active days`]], t, color)}
    </g>`);
  });

  const H = yearH + (repos.length ? 16 + Math.ceil(repos.length / 2) * (cardH + 16) - 16 : 0) + 1;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${login}: ${fmt(total)} contributions in the last year`)}">
${parts.join('\n')}
</svg>
`;
}

const data = await fetchData();
mkdirSync(outDir, {recursive: true});
for (const theme of Object.keys(THEMES)) {
  writeFileSync(`${outDir}/contributions-${theme}.svg`, render(data, theme));
}
console.log(`Wrote ${outDir}/contributions-{dark,light}.svg (${fmt(data.year.contributionCalendar.totalContributions)} contributions)`);
