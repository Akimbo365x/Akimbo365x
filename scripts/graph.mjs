// Draws the contribution curve shown on the profile (assets/activity-graph.svg).
// Run by .github/workflows/activity-graph.yml every day; no dependency, Node 20+.
//
// With GITHUB_TOKEN set, counts come from the GraphQL API (private contributions
// included when "Private contributions" is enabled on the profile). Without it,
// they are read from the public contributions calendar, which is handy locally.

import { writeFileSync, mkdirSync } from "node:fs";

const USER = process.env.GRAPH_USER || "Akimbo365x";
const DAYS = Number(process.env.GRAPH_DAYS || 31);
const OUT = process.env.GRAPH_OUT || "assets/activity-graph.svg";

async function fromGraphQL(token) {
  const query = `query($login: String!) { user(login: $login) { contributionsCollection {
    contributionCalendar { weeks { contributionDays { date contributionCount } } } } } }`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { login: USER } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors || json));
  return json.data.user.contributionsCollection.contributionCalendar.weeks
    .flatMap((w) => w.contributionDays)
    .map((d) => ({ date: d.date, count: d.contributionCount }));
}

async function fromPublicCalendar() {
  const res = await fetch(`https://github.com/users/${USER}/contributions`);
  if (!res.ok) throw new Error(`contributions page: HTTP ${res.status}`);
  const html = await res.text();
  // Each day is a <td data-date=... id=X> with a <tool-tip for=X>"N contributions on ..."</tool-tip>.
  const dateById = new Map();
  for (const m of html.matchAll(/<td[^>]*data-date="([\d-]+)"[^>]*id="([^"]+)"/g)) dateById.set(m[2], m[1]);
  const days = [];
  for (const m of html.matchAll(/<tool-tip[^>]*for="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
    const date = dateById.get(m[1]);
    if (!date) continue;
    const n = m[2].match(/^(\d+)/);
    days.push({ date, count: n ? Number(n[1]) : 0 });
  }
  if (!days.length) throw new Error("no day found on the contributions page");
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

// Monotone cubic (Fritsch–Carlson): smooth, hits every value, and never swings
// below zero or above a peak the way a plain spline does next to a spike.
function smoothPath(pts) {
  const n = pts.length;
  const dx = [], s = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    s[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
  }
  const m = [s[0]];
  for (let i = 1; i < n - 1; i++) m[i] = s[i - 1] * s[i] <= 0 ? 0 : (s[i - 1] + s[i]) / 2;
  m[n - 1] = s[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (s[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / s[i], b = m[i + 1] / s[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * s[i]; m[i + 1] = t * b * s[i]; }
  }
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], k = dx[i] / 3;
    d += ` C${f(x0 + k)},${f(y0 + m[i] * k)} ${f(x1 - k)},${f(y1 - m[i + 1] * k)} ${f(x1)},${f(y1)}`;
  }
  return d;
}
const f = (n) => Math.round(n * 10) / 10;

// Y axis: a step of 1, 2 or 5 × 10^k giving about twenty ticks, like 0, 5, 10 … 100.
function yScale(max) {
  const raw = Math.max(max, 5) / 20;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = Math.max(1, [1, 2, 5, 10].map((k) => k * p).find((v) => v >= raw - 1e-9));
  return { step, top: Math.ceil(Math.max(max, 5) / step) * step };
}

function render(days) {
  const W = 1200, H = 430;
  const L = 78, R = 28, T = 58, B = 72;
  const w = W - L - R, h = H - T - B;
  const { step, top } = yScale(Math.max(...days.map((d) => d.count)));
  const x = (i) => L + (w * i) / (days.length - 1);
  const y = (v) => T + h - (h * v) / top;
  const pts = days.map((d, i) => [x(i), y(d.count)]);
  const line = smoothPath(pts);
  const total = days.reduce((s, d) => s + d.count, 0);
  const font = `'Segoe UI',Ubuntu,'Helvetica Neue',Arial,sans-serif`;

  const grid = [], labels = [];
  for (let v = 0; v <= top; v += step) {
    const yy = f(y(v));
    grid.push(`<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/>`);
    labels.push(`<text x="${L - 12}" y="${yy + 4}" text-anchor="end">${v}</text>`);
  }
  days.forEach((d, i) => {
    const xx = f(x(i));
    grid.push(`<line x1="${xx}" x2="${xx}" y1="${T}" y2="${T + h}"/>`);
    labels.push(`<text x="${xx}" y="${T + h + 22}" text-anchor="middle">${Number(d.date.slice(8))}</text>`);
  });
  const dots = pts.map(([px, py], i) =>
    `<circle cx="${f(px)}" cy="${f(py)}" r="4.5" style="animation-delay:${(0.5 + i * 0.03).toFixed(2)}s"><title>${days[i].date}: ${days[i].count} contributions</title></circle>`).join("");

  const first = days[0].date, last = days[days.length - 1].date;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${USER}: ${total} contributions from ${first} to ${last}">
<style>
  .grid line{stroke:#e6edf3;stroke-opacity:.08;stroke-width:1}
  .labels text{fill:#c9d1d9;font:400 13px ${font}}
  .title{fill:#70d6e8;font:700 20px ${font}}
  .axis{fill:#c9d1d9;font:600 14px ${font}}
  .line{fill:none;stroke:#f0f6fc;stroke-width:3;stroke-linecap:round;stroke-linejoin:round;
        stroke-dasharray:6000;stroke-dashoffset:6000;animation:draw 1.8s cubic-bezier(.4,0,.2,1) forwards}
  .area{fill:url(#fade);opacity:0;animation:show 1s ease-out .9s forwards}
  .dots circle{fill:#f0f6fc;stroke:#0d1117;stroke-width:1.5;opacity:0;animation:show .35s ease-out forwards}
  @keyframes draw{to{stroke-dashoffset:0}}
  @keyframes show{to{opacity:1}}
</style>
<defs>
  <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#3fb8c9" stop-opacity=".42"/>
    <stop offset=".6" stop-color="#3fb8c9" stop-opacity=".12"/>
    <stop offset="1" stop-color="#3fb8c9" stop-opacity="0"/>
  </linearGradient>
  <filter id="glow" x="-5%" y="-20%" width="110%" height="140%">
    <feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<rect width="${W}" height="${H}" rx="10" fill="#0d1117"/>
<text x="${W / 2}" y="34" class="title" text-anchor="middle">${USER}'s Contribution Graph</text>
<g class="grid">${grid.join("")}</g>
<path d="${line} L${f(x(days.length - 1))},${T + h} L${L},${T + h} Z" class="area"/>
<path d="${line}" class="line" filter="url(#glow)"/>
<g class="dots">${dots}</g>
<g class="labels">${labels.join("")}</g>
<text x="${L + w / 2}" y="${H - 18}" class="axis" text-anchor="middle">Days</text>
<text x="24" y="${T + h / 2}" class="axis" text-anchor="middle" transform="rotate(-90 24 ${T + h / 2})">Contributions</text>
</svg>
`;
}

const token = process.env.GITHUB_TOKEN;
const all = token ? await fromGraphQL(token) : await fromPublicCalendar();
const today = new Date().toISOString().slice(0, 10);
const days = all.filter((d) => d.date <= today).slice(-DAYS);
mkdirSync(OUT.split("/").slice(0, -1).join("/") || ".", { recursive: true });
writeFileSync(OUT, render(days));
console.log(`${OUT}: ${days.length} days, ${days.reduce((s, d) => s + d.count, 0)} contributions`);
