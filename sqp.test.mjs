// node sqp.test.mjs — checks for the SQP Tracker engine (sqp.js). Synthetic data only: no real account numbers here.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
await import('./gated/tools/sqp.js');
const S = globalThis.SQP, near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, a + ' vs ' + b);
const clone = x => JSON.parse(JSON.stringify(x));
const d = S.sample(), sq = S.parseSqp(d.sqpRows), bulk = S.buildBulk(d.campRows, d.termRows, d.fileName);

// ---- SQP parsing
assert.equal(sq.asin, 'B0SAMPLE01'); assert.equal(sq.range, 'weekly'); assert.equal(sq.from, '2026-10-04'); assert.equal(sq.to, '2026-10-10');
assert.equal(sq.list.length, 6); assert.equal(sq.skippedBlank, 1, 'blank-query row is skipped');
const q = sq.queries.get('blue widget set');
near(q.market.cvr, 30 / 780); near(q.asin.cvr, 1 / 18); near(q.market.ctr, 780 / 52000); near(q.asin.ctr, 18 / 2400);   // computed from counts, not Amazon's per-search rates
assert.equal(sq.queries.get('widget storage box').asin.cvr, 0);       // 0 purchases on 9 clicks is a real zero
assert.equal(q.volume, 1200);
// monthly header + case/space-insensitive column names
const monthly = clone(d.sqpRows); monthly[0] = ['ASIN or Product=["B0SAMPLE01"]', 'Reporting Range=["Monthly"]', 'Select year=["2026"]', 'Select month=["September"]'];
monthly[1] = monthly[1].map(h => ' ' + h.toUpperCase() + ' ');
const m = S.parseSqp(monthly); assert.equal(m.range, 'monthly'); assert.equal(m.from, '2026-09-01'); assert.equal(m.to, '2026-09-30');
const feb = clone(monthly); feb[0][3] = 'Select month=["February"]'; assert.equal(S.parseSqp(feb).to, '2026-02-28');
// bad inputs give clear errors, never a crash
assert.throws(() => S.parseSqp([['x']]), /no data rows/);
assert.throws(() => S.parseSqp([['Not metadata'], d.sqpRows[1], d.sqpRows[2]]), /ASIN view/);
const quarterly = clone(d.sqpRows); quarterly[0][1] = 'Reporting Range=["Quarterly"]'; assert.throws(() => S.parseSqp(quarterly), /Weekly and Monthly/);
const nocol = clone(d.sqpRows); nocol[1][3] = 'Impressions: Gesamt'; assert.throws(() => S.parseSqp(nocol), /Missing column/);
const onlyBlank = [d.sqpRows[0], d.sqpRows[1], ['', ...d.sqpRows[2].slice(1)]]; assert.throws(() => S.parseSqp(onlyBlank), /No search queries/);
const dup = [...d.sqpRows, d.sqpRows[2].slice()]; assert.equal(S.parseSqp(dup).duplicates, 1);
assert.equal(S.norm('  "+Blue   Widget" '), 'blue widget');

// ---- bulk parsing
assert.deepEqual(bulk.dates, { from: '2026-10-04', to: '2026-10-10' });
assert.equal(S.datesFromName('Bulk October 4-10.xlsx'), null);
assert.deepEqual(S.asinCampaigns(bulk, 'B0SAMPLE01').sort(), ['c1', 'c2', 'c3']);     // c4 advertises another ASIN
const c2 = bulk.camps.get('c2');
assert.equal(c2.placements.other.clicks, 100, 'row with no placement name goes to Other');
assert.equal(c2.placements.top.clicks, 150); assert.equal(c2.placements.business, undefined);
assert.throws(() => S.buildBulk([{ Entity: 'Campaign' }], [], 'x'), /Missing column/);
assert.throws(() => S.buildBulk([], [], 'x'), /empty or missing/);
// ASIN falls back to the campaign name when there are no product-ad ASINs
const noAds = S.buildBulk(d.campRows.filter(r => r.Entity !== 'Product Ad'), d.termRows, '');
assert.deepEqual(S.asinCampaigns(noAds, 'B0SAMPLE01').sort(), ['c1', 'c2', 'c3'].filter(id => noAds.camps.get(id).name.toUpperCase().includes('B0SAMPLE01')));

// ---- ranking suggestions: only this ASIN, only "rank", only the exact keyword
assert.deepEqual(S.suggestRanking(bulk, 'B0SAMPLE01', 'blue widget set'), ['c1']);      // not c4 (other ASIN), not c2 ("blue widget", not the set)
assert.deepEqual(S.suggestRanking(bulk, 'B0SAMPLE01', 'blue widget'), ['c2']);
assert.deepEqual(S.suggestRanking(bulk, 'B0SAMPLE01', 'red widget'), []);

// a non-"rank" campaign targeting the very same keyword (same ASIN) must NOT be suggested as a ranking campaign
const withPlain = d.campRows.concat(d.campRows.filter(r => r['Campaign ID'] === 'c1').map(r => Object.assign({}, r, { 'Campaign ID': 'c5', 'Campaign Name (Informational only)': 'SP-Exact-B0SAMPLE01-blue widget set' })));
const plainBulk = S.buildBulk(withPlain, d.termRows, '');
assert.ok(plainBulk.camps.has('c5') && S.asinCampaigns(plainBulk, 'B0SAMPLE01').includes('c5'));
assert.deepEqual(S.suggestRanking(plainBulk, 'B0SAMPLE01', 'blue widget set'), ['c1']);
// with no keyword rows, only the exact QUOTED phrase in the name counts ("blue widget" must not pick the "blue widget set" campaign)
const noKw = S.buildBulk(d.campRows.filter(r => r.Entity !== 'Keyword'), d.termRows, '');
assert.deepEqual(S.suggestRanking(noKw, 'B0SAMPLE01', 'blue widget'), ['c2']);
assert.deepEqual(S.suggestRanking(noKw, 'B0SAMPLE01', 'blue widget set'), ['c1']);

// ---- comparison: Campaign Manager view vs search-term view
const cm = S.compare(sq, bulk, 'blue widget', { basis: 'cm', overlay: true, rankIds: ['c2'] });
const tm = S.compare(sq, bulk, 'blue widget', { basis: 'term', overlay: true, rankIds: ['c2'] });
assert.equal(cm.ranking.clicks, 200); near(cm.ranking.cvr, 9 / 200); near(cm.ranking.cpc, 160 / 200);
assert.equal(tm.ranking.clicks, 180); near(tm.ranking.cvr, 8 / 180);                    // only the exact term, no "blue widget cheap"
assert.equal(cm.allppc.clicks, 240);                                                     // c1 has no "blue widget" term; c2 180 + c3 60
assert.equal(cm.recon.cm.clicks, 200); assert.equal(cm.recon.term.clicks, 180); assert.equal(cm.recon.kw.clicks, 300);
near(cm.index.ranking, (9 / 200) / (52 / 1500)); near(cm.index.asin, (2 / 60) / (52 / 1500));
assert.equal(cm.placements.rows.other.clicks, 100); assert.equal(cm.placements.labelled.clicks, 198); assert.equal(cm.placements.total.clicks, 298);
assert.ok(cm.flags.includes('variants') && cm.flags.includes('ppcExceedsAsin') && !cm.flags.includes('lowSample'));
// no overlay -> no all-PPC series; no ranking campaign -> no ranking series
assert.equal(S.compare(sq, bulk, 'blue widget', { rankIds: ['c2'] }).allppc, null);
const none = S.compare(sq, bulk, 'red widget', { overlay: true });
assert.equal(none.ranking, null); assert.equal(none.placements, null); assert.equal(none.allppc.clicks, 0); assert.equal(none.allppc.cvr, null);   // zero clicks -> no CVR, not 0%
// a query outside the SQP report is flagged, never shown as zero
const miss = S.compare(sq, bulk, 'not in report', { rankIds: [] }); assert.equal(miss.market, null); assert.ok(miss.flags.includes('missingSqp'));
// low sample
const low = S.compare(sq, bulk, 'blue widget set', { basis: 'cm', rankIds: ['c4'] }); assert.ok(low.flags.includes('lowSample'));   // 5 clicks
// campaign ids that do not exist are ignored (stale selections)
assert.equal(S.compare(sq, bulk, 'blue widget', { rankIds: ['nope'] }).ranking, null);

// ---- period check
assert.equal(S.periodCheck(sq, bulk).status, 'match');
assert.equal(S.periodCheck(sq, { dates: { from: '2026-09-27', to: '2026-10-03' } }).status, 'mismatch');
assert.equal(S.periodCheck(sq, { dates: null }).status, 'unknown');
assert.equal(S.periodCheck(m, { dates: { from: '2026-10-04', to: '2026-10-10' } }).status, 'mismatch');   // week-long bulk file vs a monthly report

// ---- optional smoke test on real SQP downloads if present (invariants only, no numbers)
function csv(text) {
  const rows = []; let row = [], f = '', qt = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (qt) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else qt = false; } else f += c; }
    else if (c === '"') qt = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x !== ''));
}
let real = 0;
if (existsSync('SQP Tracker')) for (const f of readdirSync('SQP Tracker').filter(n => /Search_Query_Performance.*\.csv$/i.test(n))) {
  const r = S.parseSqp(csv(readFileSync('SQP Tracker/' + f, 'utf8').replace(/^﻿/, '')));
  assert.match(r.asin, /^[A-Z0-9]{10}$/); assert.ok(r.list.length > 0 && r.from <= r.to);
  for (const x of r.list) for (const k of ['market', 'asin']) { const v = x[k].cvr; assert.ok(v === null || (v >= 0 && v <= 1), 'CVR in range'); }
  real++;
}
console.log('sqp: all checks pass' + (real ? ` (+${real} real report${real > 1 ? 's' : ''} parsed)` : ''));
