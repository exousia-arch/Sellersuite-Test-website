// node dayparting.test.mjs: checks the engine (reference-export parity, damping, windows, repeat check, goals, ranking).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
await import('./dayparting.js'); // package is type:module → the script attaches DP to globalThis
const DP = globalThis.DP;

function csv(text) { // tiny RFC4180 parser (quotes, commas)
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [h, ...d] = rows.filter(r => r.length > 1);
  return d.map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}

const { records, currency } = DP.parseRows(csv(readFileSync('Sample Data - Amazon SP Hourly campaign Report.csv', 'utf8')));
const a = DP.aggregate(records, 5);
const r2 = x => Math.round(x * 100) / 100;
assert.equal(currency, 'USD');
assert.equal(a.total.imp, 293151); assert.equal(a.total.clicks, 1322); assert.equal(a.total.orders, 136);
assert.equal(r2(a.total.spend), 4328.51); assert.equal(r2(a.total.sales), 3792.63);
assert.equal(a.k, 49);                                           // trust threshold = ceil(5 x clicks per order)
assert.equal(a.dow[0].imp, 35467); assert.equal(r2(a.dow[1].rpc), 4.4);
assert.equal(r2(a.hour[14].rpc), 7.03);

// 1) the undamped ("raw") move still reproduces the reference export exactly
const R = DP.analyze(records, { conf: 5, basis: 'rpc' }), raw = k => R.groups[k].map(x => x.raw);
assert.deepEqual(raw('Days'), [-0.1, 0.55, 0.25, -0.2, -0.05, -0.05, -0.3]);
assert.deepEqual(raw('Weekdays vs weekends'), [0.1, -0.15]);
assert.deepEqual(raw('8-hour blocks'), [-0.1, 0.1, 0]);
assert.deepEqual(raw('4-hour blocks'), [-0.85, 0.25, -0.3, 0.45, 0.15, -0.25]);

// 2) damping only ever pulls toward zero, never past it or the other way
for (const g of Object.values(R.groups)) for (const x of g) assert.ok(Math.abs(x.adj) <= Math.abs(x.raw) && x.adj * x.raw >= 0, x.label);
const h1 = R.groups.Hours[1]; assert.ok(h1.raw === -1 && h1.adj > -1);   // 01:00 earned $0 on 19 clicks: damped, not -100%
assert.ok(Math.abs(R.groups.Hours[14].trust - 56 / (56 + 49)) < 1e-9);

// 3) repeat check + windows
assert.ok(R.range && R.range.days === 14);
for (const w of R.win.weekdays.concat(R.win.weekends)) {
  assert.ok(w.to - w.from >= 2 && w.tier !== 0 && w.adj * w.tier >= 0);
  assert.ok(['repeats', 'mixed', 'thin'].includes(w.stab));
}
const sorted = R.win.weekdays.every((w, i, l) => !i || l[i - 1].to <= w.from); assert.ok(sorted);

// 4) goal / margin / efficiency basis
const G = DP.analyze(records, { conf: 5, basis: 'roas', goal: 0.3, margin: 0.4 });
assert.equal(G.waste.kind, 'goal'); assert.equal(G.waste.bench, 0.3);
assert.ok(G.waste.total <= G.a.total.spend && G.waste.total > 0);
assert.equal(r2(G.profit), r2(G.a.total.sales * 0.4 - G.a.total.spend));
const d1 = G.groups.Days[1]; assert.equal(d1.toGoal, Math.max(-1, Math.round((0.3 * d1.b.rpc / d1.b.cpc - 1) * 20) / 20));
assert.equal(DP.analyze(records, { margin: 0.35 }).waste.kind, 'breakeven');
assert.equal(DP.analyze(records, {}).waste.kind, 'average');

// 5) campaign ranking
const rank = DP.rankCampaigns(records, { conf: 5, basis: 'rpc' });
assert.equal(rank.length, 58);
const order = { 'Start here': 0, 'Test': 1, 'Flat': 2, 'Needs data': 3 };
assert.ok(rank.every((c, i, l) => !i || order[l[i - 1].verdict] <= order[c.verdict]));

// 6) fewer than 4 days: no halves, repeat check reports n/a, nothing crashes
const short = records.filter(r => r.day < records[0].day + 2), S = DP.analyze(short, {});
assert.equal(S.range, null); assert.equal(S.groups.Hours[0].stab, 'n/a');

assert.equal(DP.num('1.234,56 €'), 1234.56); assert.equal(DP.num('$1,234.5'), 1234.5);
assert.equal(DP.dowOf('Sep 17, 2026'), 3);                       // Thursday
console.log('dayparting: all checks pass');
