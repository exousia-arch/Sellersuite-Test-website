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
// Amazon labels the first line "ASIN=[...]" in some downloads and "ASIN or Product=[...]" in others; the Brand view names a brand, not an ASIN
{
  const v = clone(d.sqpRows); v[0][0] = 'ASIN=["B0SAMPLE01"]'; assert.equal(S.parseSqp(v).asin, 'B0SAMPLE01');
  v[0][0] = '﻿ASIN=["B0SAMPLE01"]'; assert.equal(S.parseSqp(v).asin, 'B0SAMPLE01', 'BOM before the first label');
  v[0][0] = 'Brand=["Acme"]'; assert.throws(() => S.parseSqp(v), /ASIN view/);
  v[0][0] = 'MyASIN=["B0SAMPLE01"]'; assert.throws(() => S.parseSqp(v), /ASIN view/, 'only a label that is exactly ASIN counts');
}
const monthly = clone(d.sqpRows); monthly[0] = ['ASIN or Product=["B0SAMPLE01"]', 'Reporting Range=["Monthly"]', 'Select year=["2026"]', 'Select month=["September"]'];
monthly[1] = monthly[1].map(h => ' ' + h.toUpperCase() + ' ');
const m = S.parseSqp(monthly); assert.equal(m.range, 'monthly'); assert.equal(m.from, '2026-09-01'); assert.equal(m.to, '2026-09-30');
const feb = clone(monthly); feb[0][3] = 'Select month=["February"]'; assert.equal(S.parseSqp(feb).to, '2026-02-28');
// bad inputs give clear errors, never a crash
assert.throws(() => S.parseSqp([['x']]), /no data rows/);
assert.throws(() => S.parseSqp([['Not metadata'], d.sqpRows[1], d.sqpRows[2]]), /ASIN view/);
const daily = clone(d.sqpRows); daily[0][1] = 'Reporting Range=["Daily"]'; assert.throws(() => S.parseSqp(daily), /Weekly, Monthly and Quarterly/);
{ // quarterly: the dates when the first line has them, else the year and the quarter number
  const q1 = clone(d.sqpRows); q1[0][1] = 'Reporting Range=["Quarterly"]'; q1[0][2] = 'Select quarter=["Quarter 3 | 2026-07-01 - 2026-09-30 2026"]'; const a = S.parseSqp(q1); assert.deepEqual([a.range, a.from, a.to], ['quarterly', '2026-07-01', '2026-09-30']);
  const q2 = clone(d.sqpRows); q2[0][1] = 'Reporting Range=["Quarterly"]'; q2[0][2] = 'Select year=["2026"]'; q2[0].push('Select quarter=["Quarter 4"]'); const b = S.parseSqp(q2); assert.deepEqual([b.from, b.to], ['2026-10-01', '2026-12-31']);
  const q3 = clone(d.sqpRows); q3[0][1] = 'Reporting Range=["Quarterly"]'; q3[0][2] = 'Select year=["2026"]'; q3[0].push('Select quarter=["Q1"]'); assert.deepEqual([S.parseSqp(q3).from, S.parseSqp(q3).to], ['2026-01-01', '2026-03-31']);
  const q4 = clone(d.sqpRows); q4[0][1] = 'Reporting Range=["Quarterly"]'; q4[0][2] = 'Select year=["2026"]'; assert.throws(() => S.parseSqp(q4), /quarter/);
}
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
// a NOMINATED ranking keyword (loose) falls back to any campaign of this ASIN that targets it; a "rank" campaign still wins when there is one
const looseBulk = S.buildBulk(withPlain.map(r => (r['Campaign ID'] === 'c1' ? Object.assign({}, r, { 'Campaign Name (Informational only)': 'SP-Exact-B0SAMPLE01-blue widget set' }) : r)), d.termRows, '');
assert.deepEqual(S.suggestRanking(looseBulk, 'B0SAMPLE01', 'blue widget set'), []);
assert.deepEqual(S.suggestRanking(looseBulk, 'B0SAMPLE01', 'blue widget set', true).sort(), ['c1', 'c5']);
assert.deepEqual(S.suggestRanking(plainBulk, 'B0SAMPLE01', 'blue widget set', true), ['c1']);
assert.deepEqual(S.suggestRanking(bulk, 'B0SAMPLE01', 'red widget', true), []);
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
assert.equal(S.periodCheck(sq, { dates: null }).status, 'unknown'); assert.match(S.periodCheck(sq, { dates: null }).note, /carries no dates.*confirm/);
// a bulk file name without dates (Amazon's newer names): the dates the user confirmed are checked the same way
{
  const ok = S.periodCheck(sq, { dates: { from: sq.from, to: sq.to, manual: true } }), bad = S.periodCheck(sq, { dates: { from: '2026-09-27', to: '2026-10-03', manual: true } });
  assert.equal(ok.status, 'match'); assert.match(ok.note, /you confirmed/); assert.equal(bad.status, 'mismatch'); assert.match(bad.note, /you said the bulk file covers 2026-09-27 to 2026-10-03/);
  assert.equal(S.datesFromName('9a3e51d9-7ab1-441f-b4f9-91dbcdcc61aa-UnifiedWorkbook.xlsx'), null, 'the new names carry no dates'); assert.equal(S.pulledFromName('9a3e51d9-7ab1-441f-b4f9-91dbcdcc61aa-UnifiedWorkbook.xlsx'), null);
  // the pulled date: the old name's timestamp, else the workbook's creation time, never one from before the period
  assert.equal(S.usablePulled('2026-10-12T09:00:00Z', sq), '2026-10-12T09:00:00.000Z'); assert.equal(S.usablePulled('2026-09-01T00:00:00Z', sq), null, 'before the period began'); assert.equal(S.usablePulled('2999-01-01T00:00:00Z', sq), null, 'in the future'); assert.equal(S.usablePulled('nonsense', sq), null); assert.equal(S.usablePulled(null, sq), null);
  const pay = (b, name) => S.savePayload(sq, b, ['blue widget set'], {}, 'B', name, null, {}, [], false).pulled, made = Object.assign({}, bulk, { pulledAt: '2026-10-12T09:00:00.000Z' });
  assert.equal(pay(made, '9a3e51d9-UnifiedWorkbook.xlsx'), '2026-10-12T09:00:00.000Z', 'no timestamp in the name: the workbook\'s creation time'); assert.equal(pay(bulk, '9a3e51d9-UnifiedWorkbook.xlsx'), null, 'neither: no pulled date');
  assert.equal(pay(made, 'bulk-1-20261004-20261010-1792000000000.xlsx'), new Date(1792000000000).toISOString(), 'the old name\'s timestamp still wins');
}
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
// ---- phase 2: what gets saved, and how history is read back
{
  const tracked = ['blue widget set', 'blue widget', 'widget organizer'], rank = { 'blue widget set': ['c1', 'c4'], 'blue widget': ['c2'] };
  const pay = S.savePayload(sq, bulk, tracked, rank, '  Acme  ', 'bulk-123-20261004-20261010-1761228000000.xlsx');
  assert.equal(pay.brand, 'Acme'); assert.equal(pay.asin, 'B0SAMPLE01'); assert.equal(pay.cadence, 'weekly'); assert.equal(pay.from, '2026-10-04'); assert.equal(pay.to, '2026-10-10');
  assert.equal(pay.pulled, new Date(1761228000000).toISOString()); assert.equal(S.pulledFromName('bulk-sample-20261004-20261010-1.xlsx'), null); assert.equal(S.pulledFromName('x.xlsx'), null);
  assert.equal(pay.keywords.length, 3);
  // same shape rules the database enforces (sqp_valid): known keys, numbers only, no negatives, nothing deep
  const TOP = ['volume', 'price', 'share', 'market', 'asin', 'cm', 'term', 'allppc', 'pl', 'rank', 'manual'], LEAF = ['imp', 'clicks', 'orders', 'spend', 'sales', 'click', 'purchase', 'market', 'asin'], PL = ['top', 'rest', 'product', 'business', 'other'];
  const okNum = v => v === null || (typeof v === 'number' && isFinite(v) && v >= 0 && v <= 1e12);
  for (const k of pay.keywords) {
    assert.ok(JSON.stringify(k.data).length < 6000); assert.ok(k.ranking.length <= 10 && JSON.stringify(k.ranking).length <= 2000);
    for (const [a, v] of Object.entries(k.data)) {
      assert.ok(TOP.includes(a), 'top key ' + a);
      if (typeof v === 'number') { assert.ok(okNum(v)); continue; }
      for (const [b, w] of Object.entries(v)) {
        if (typeof w === 'object' && w !== null) { assert.equal(a, 'pl'); assert.ok(PL.includes(b)); for (const [c3, x] of Object.entries(w)) { assert.ok(['imp', 'clicks', 'orders', 'spend'].includes(c3)); assert.ok(okNum(x)); } }
        else { assert.ok((a === 'rank' ? ['organic', 'sponsored', 'date'] : a === 'manual' ? ['clicks', 'orders'] : LEAF).includes(b), 'leaf ' + b); assert.ok(okNum(w)); }
      }
    }
    assert.ok(!JSON.stringify(k).includes('Customer') && !JSON.stringify(k).includes('blue widget cheap'), 'no search-term rows are saved');
  }
  const k1 = pay.keywords[0];
  assert.equal(k1.query, 'blue widget set'); assert.deepEqual(k1.ranking.map(r => r.id), ['c1', 'c4']);
  assert.equal(k1.data.cm.clicks, 123); assert.equal(k1.data.term.clicks, 125);        // both bases kept (c1 + c4)
  assert.equal(k1.data.market.clicks, 780); assert.ok(k1.data.allppc.clicks >= k1.data.term.clicks, 'all PPC on the term includes the ranking campaigns');
  assert.ok(k1.data.pl.top && !('sales' in k1.data.pl.top), 'placements keep imp, clicks, orders, spend only');
  assert.equal(pay.keywords[2].ranking.length, 0); assert.equal(pay.keywords[2].data.cm, undefined, 'no ranking campaign: no campaign numbers');
  // a tracked keyword missing from the report still saves (no market line), campaigns that are not in the bulk file are dropped, caps hold
  const odd = S.savePayload(sq, bulk, ['not in report'], { 'not in report': ['nope'] }, 'Acme', '');
  assert.equal(odd.keywords[0].data.market, undefined); assert.deepEqual(odd.keywords[0].ranking, []); assert.equal(odd.pulled, null);
  assert.equal(S.savePayload(sq, bulk, Array.from({ length: 80 }, (_, i) => 'q' + i), {}, 'A', '').keywords.length, 50);
  assert.equal(S.savePayload(m, bulk, ['x'], {}, 'A', '').cadence, 'monthly');
  // history -> series
  const hist = { periods: [{ id: 'p1', from: '2026-09-27', to: '2026-10-03', pulled: '2026-10-08T00:00:00Z' }, { id: 'p2', from: '2026-10-04', to: '2026-10-10', pulled: '2026-10-23T00:00:00Z' }, { id: 'p3', from: '2026-10-11', to: '2026-10-17', pulled: null }],
    rows: [{ p: 'p1', k: 'K1', d: k1.data }, { p: 'p2', k: 'K1', d: { ...k1.data, volume: 1500 } }, { p: 'p2', k: 'K2', d: k1.data }] };
  const sr = S.series(hist, 'K1', 'cm');
  assert.equal(sr.length, 3); assert.equal(sr[0].missing, false); assert.equal(sr[2].missing, true, 'a week without this keyword is a gap, not a zero');
  near(sr[0].ranking.cvr, k1.data.cm.orders / k1.data.cm.clicks); near(sr[0].market.cvr, 30 / 780); assert.equal(sr[1].volume, 1500);
  assert.equal(S.series(hist, 'K1', 'term')[0].ranking.clicks, k1.data.term.clicks);
  assert.deepEqual(sr.map(x => x.young), [true, true, false], 'pulled < 14 days after the period ended = still maturing; unknown pull date is not flagged');
  assert.equal(S.series({ periods: [], rows: [] }, 'K1', 'cm').length, 0); assert.equal(S.series({}, 'K1', 'cm').length, 0);
  assert.equal(S.nextPeriod(hist.periods, 'weekly'), '2026-10-18'); assert.equal(S.nextPeriod([{ from: '2026-12-01' }], 'monthly'), '2027-01-01'); assert.equal(S.nextPeriod([], 'weekly'), null);
}
// ---- optional Helium 10 Cerebro report: an organic rank snapshot per keyword
{
  const rows = [{ '﻿Keyword Phrase': 'Blue Widget Set', 'Organic Rank': '4', 'Sponsored Rank': '-', 'Search Volume': '1,200' },
    { '﻿Keyword Phrase': 'blue widget', 'Organic Rank': '-', 'Sponsored Rank': '12', 'Search Volume': '3000' }, { '﻿Keyword Phrase': '', 'Organic Rank': '1' }];
  const cer = S.parseCerebro(rows, 'US_AMAZON_cerebro_b0sample01_2026-10-12.csv');
  assert.equal(cer.asin, 'B0SAMPLE01'); assert.equal(cer.date, '2026-10-12'); assert.equal(cer.ranks.size, 2, 'blank keyword skipped');
  assert.deepEqual(cer.ranks.get('blue widget set'), { organic: 4, sponsored: 0, volume: 1200 });
  assert.deepEqual(cer.ranks.get('blue widget'), { organic: 0, sponsored: 12, volume: 3000 }, '"-" is not ranked (0)');
  assert.equal(S.parseCerebro(rows, 'my file.csv').asin, null);
  assert.throws(() => S.parseCerebro([{ 'Keyword Phrase': 'x' }], 'f'), /Organic Rank/); assert.throws(() => S.parseCerebro([], 'f'), /no rows/); assert.throws(() => S.parseCerebro([{ 'Keyword Phrase': '', 'Organic Rank': '1' }], 'f'), /no keywords/);
  // is the report usable for this SQP period?
  assert.equal(S.cerebroCheck(sq, null), null);
  assert.equal(S.cerebroCheck(sq, cer).status, 'ok');
  assert.equal(S.cerebroCheck(sq, { ...cer, asin: 'B0OTHER001' }).status, 'asin', 'another ASIN: ranks are not used');
  assert.equal(S.cerebroCheck(sq, { ...cer, date: '2026-10-30' }).status, 'late'); assert.equal(S.cerebroCheck(sq, { ...cer, date: '2026-10-01' }).status, 'early'); assert.equal(S.cerebroCheck(sq, { ...cer, date: null }).status, 'unknown');
  // compare: a keyword missing from the file is unknown (null), not "not ranked"
  const on = k => S.compare(sq, bulk, k, { cerebro: cer }).rank;
  assert.deepEqual(on('blue widget set'), { organic: 4, sponsored: 0, volume: 1200, date: '2026-10-12' }); assert.equal(on('blue widget').organic, 0); assert.equal(on('red widget'), null);
  assert.equal(S.compare(sq, bulk, 'blue widget set', {}).rank, null);
  // saved: ranks travel inside data (date as yyyymmdd) and come back through series
  const pay = S.savePayload(sq, bulk, ['blue widget set', 'blue widget', 'red widget'], {}, 'Acme', '', cer);
  assert.deepEqual(pay.keywords[0].data.rank, { organic: 4, sponsored: 0, volume: 1200, date: 20261012 }); assert.deepEqual(pay.keywords[1].data.rank, { organic: 0, sponsored: 12, volume: 3000, date: 20261012 });
  assert.equal(pay.keywords[2].data.rank, undefined, 'keyword not in the report: nothing stored');
  assert.equal(S.savePayload(sq, bulk, ['blue widget set'], {}, 'Acme', '').keywords[0].data.rank, undefined, 'no Cerebro report: no rank key');
  const sr = S.series({ periods: [{ id: 'p1', from: '2026-10-04', to: '2026-10-10' }, { id: 'p2', from: '2026-10-11', to: '2026-10-17' }], rows: [{ p: 'p1', k: 'K', d: pay.keywords[0].data }, { p: 'p2', k: 'K', d: { volume: 5 } }] }, 'K', 'cm');
  assert.deepEqual(sr[0].rank, { organic: 4, sponsored: 0, volume: 1200, date: '2026-10-12' }); assert.equal(sr[1].rank, null, 'a period without a Cerebro report has no rank (gap)');
}
// ---- campaign-level tracking: a campaign instead of a keyword (no market, no ASIN)
{
  const cc = S.compareCampaign(bulk, 'c1', {}), ref = S.compare(sq, bulk, 'blue widget set', { rankIds: ['c1'] });
  assert.equal(cc.key, 'campaign:c1'); assert.equal(cc.campaign, true); assert.equal(cc.query, bulk.camps.get('c1').name);
  assert.equal(cc.market, null); assert.equal(cc.asin, null); assert.equal(cc.allppc, null); assert.deepEqual(cc.rankIds, ['c1']);
  assert.deepEqual([cc.recon.cm.clicks, cc.recon.cm.orders], [ref.recon.cm.clicks, ref.recon.cm.orders], 'same campaign row as the keyword view');
  assert.equal(cc.recon.term.clicks, bulk.terms.filter(t => t.id === 'c1').reduce((a, t) => a + t.m.clicks, 0), 'search-term view = all search-term rows of the campaign');
  assert.equal(cc.ranking, cc.recon.cm); assert.equal(S.compareCampaign(bulk, 'c1', { basis: 'term' }).ranking.clicks, cc.recon.term.clicks);
  assert.ok(cc.placements.total.clicks > 0);
  assert.equal(S.compareCampaign(bulk, 'nope', {}), null);
  assert.deepEqual(S.compareCampaign(bulk, 'c1', { manual: { clicks: 2, orders: 5 } }).flags.filter(f => f === 'manualOdd'), ['manualOdd']);
  // saved: after the keywords, as rows whose query is campaign:<id>; the id is lower-cased, unknown ids are skipped, the 50 cap covers both
  const pay = S.savePayload(sq, bulk, ['blue widget set'], {}, 'Acme', '', null, { 'campaign:c1': { clicks: 10, orders: 1 } }, ['c1', 'c2', 'nope']);
  assert.deepEqual(pay.keywords.map(k => k.query), ['blue widget set', 'campaign:c1', 'campaign:c2']);
  const k = pay.keywords[1];
  assert.equal(k.display, bulk.camps.get('c1').name); assert.deepEqual(k.ranking, [{ id: 'c1', name: bulk.camps.get('c1').name }]); assert.equal(k.query, k.query.toLowerCase().trim());
  assert.deepEqual(Object.keys(k.data).sort(), ['cm', 'manual', 'pl', 'term']); assert.equal(k.data.cm.clicks, cc.recon.cm.clicks); assert.deepEqual(k.data.manual, { clicks: 10, orders: 1 });
  assert.equal(pay.keywords[2].data.manual, undefined, 'manual numbers only where typed');
  assert.equal(S.savePayload(sq, bulk, Array.from({ length: 49 }, (_, i) => 'q' + i), {}, 'A', '', null, {}, ['c1', 'c2', 'c3']).keywords.length, 50, 'keywords and campaigns share the 50 cap');
  assert.equal(S.savePayload(sq, bulk, ['blue widget set'], {}, 'A', '', null, {}, ['c1', 'c1', 'c1']).keywords.length, 2, 'a campaign is saved once');
  // "also save each ranking campaign separately": the ranking campaigns of the tracked keywords join the ticked campaigns, no duplicates, only ids in the bulk file
  const rk = { 'blue widget set': ['c1', 'c4'], 'blue widget': ['c2', 'c1', 'nope'] };
  assert.deepEqual(S.saveCampaignIds(bulk, ['blue widget set', 'blue widget'], rk, ['c3'], true), ['c3', 'c1', 'c4', 'c2']);
  assert.deepEqual(S.saveCampaignIds(bulk, ['blue widget set', 'blue widget'], rk, ['c3'], false), ['c3'], 'off: only the ticked campaigns');
  assert.deepEqual(S.saveCampaignIds(bulk, ['blue widget set'], rk, [], true), ['c1', 'c4']); assert.deepEqual(S.saveCampaignIds(bulk, [], {}, undefined, true), []);
  assert.deepEqual(S.savePayload(sq, bulk, ['blue widget set'], rk, 'A', '', null, {}, [], true).keywords.map(k => k.query), ['blue widget set', 'campaign:c1', 'campaign:c4']);
  // viewing ONE related campaign next to the keyword: market, ASIN, volume stay the keyword's; ranking and manual are the campaign's
  const kp = [{ id: 'p1', missing: false, young: true, market: 'M1', asin: 'A1', volume: 5, ranking: 'KR1', manual: null }, { id: 'p2', missing: false, young: false, market: 'M2', asin: 'A2', volume: 6, ranking: 'KR2', manual: 'KM2' }, { id: 'p3', missing: true }, { id: 'p4', missing: false, market: 'M4', ranking: 'KR4' }];
  const cp = [{ id: 'p1', missing: false, young: false, ranking: 'CR1', manual: 'CM1' }, { id: 'p2', missing: true }, { id: 'p3', missing: false, young: false, ranking: 'CR3', manual: null }, { id: 'p4', missing: true }];
  const mg = S.mergeCampaign(kp, cp);
  assert.deepEqual([mg[0].market, mg[0].ranking, mg[0].manual, mg[0].young, mg[0].volume], ['M1', 'CR1', 'CM1', false, 5]);
  assert.deepEqual([mg[1].market, mg[1].ranking, mg[1].manual, mg[1].missing], ['M2', null, null, false], 'campaign gap: the keyword lines stay, the campaign line has a gap');
  assert.deepEqual([mg[2].missing, mg[2].ranking, mg[2].market], [false, 'CR3', undefined], 'keyword gap but the campaign was saved: the campaign line shows');
  assert.equal(mg[3].ranking, null); assert.equal(S.mergeCampaign([], []).length, 0);
  assert.equal(kp[1].ranking, 'KR2', 'inputs are not changed');
  assert.equal(S.savePayload(sq, bulk, ['blue widget set'], {}, 'A', '').keywords.length, 1, 'no campaigns ticked: nothing extra');
  // history reads a campaign entry like any other: its campaign row is the "ranking" line
  const sr = S.series({ periods: [{ id: 'p1', from: '2026-10-04', to: '2026-10-10' }], rows: [{ p: 'p1', k: 'K', d: k.data }] }, 'K', 'cm');
  assert.equal(sr[0].ranking.clicks, cc.recon.cm.clicks); assert.equal(sr[0].market, null); near(sr[0].manual.cvr, 0.1);
}
// ---- manual check: clicks and orders typed in from Campaign Manager, kept apart from the bulk file
{
  const m = { clicks: 118, orders: 4 }, c = S.compare(sq, bulk, 'blue widget set', { rankIds: ['c1'], manual: m });
  near(c.manual.cvr, 4 / 118); assert.equal(c.manual.clicks, 118); assert.equal(c.manual.imp, null, 'no impressions typed: none shown');
  assert.ok(c.manual.clicks !== c.recon.cm.clicks || c.manual.orders !== c.recon.cm.orders, 'the typed numbers are not the bulk numbers');
  near(c.index.manual, (4 / 118) / (30 / 780));
  for (const bad of [undefined, {}, { clicks: 5 }, { orders: 1 }, { clicks: null, orders: 2 }]) assert.equal(S.compare(sq, bulk, 'blue widget set', { manual: bad }).manual, null, 'needs both numbers');
  assert.equal(S.compare(sq, bulk, 'blue widget set', { manual: { clicks: 0, orders: 0 } }).manual.cvr, null, '0 clicks: no CVR, not 0%');
  assert.ok(S.compare(sq, bulk, 'blue widget set', { manual: { clicks: 2, orders: 5 } }).flags.includes('manualOdd'), 'orders above clicks is flagged');
  assert.ok(!c.flags.includes('manualOdd'));
  // saved as two numbers, read back through series
  const pay = S.savePayload(sq, bulk, ['blue widget set', 'blue widget'], { 'blue widget set': ['c1'] }, 'Acme', '', null, { 'blue widget set': m });
  assert.deepEqual(pay.keywords[0].data.manual, m); assert.equal(pay.keywords[1].data.manual, undefined, 'only the keyword you typed for');
  assert.equal(S.savePayload(sq, bulk, ['blue widget set'], {}, 'Acme', '').keywords[0].data.manual, undefined);
  const sr = S.series({ periods: [{ id: 'p1', from: '2026-10-04', to: '2026-10-10' }, { id: 'p2', from: '2026-10-11', to: '2026-10-17' }], rows: [{ p: 'p1', k: 'K', d: pay.keywords[0].data }, { p: 'p2', k: 'K', d: { volume: 5 } }] }, 'K', 'cm');
  assert.equal(sr[0].manual.clicks, 118); near(sr[0].manual.cvr, 4 / 118); assert.equal(sr[1].manual, null, 'a period without typed numbers is a gap');
}
// ---- manual check against a chosen campaign
{
  const typed = { clicks: 118, orders: 4 }, ref = S.compareCampaign(bulk, 'c2', {});
  const c = S.compare(sq, bulk, 'blue widget set', { rankIds: ['c1'], manual: { ...typed, camp: 'c2' } });
  assert.equal(c.manualBulk.id, 'c2'); assert.equal(c.manualBulk.name, bulk.camps.get('c2').name);
  assert.equal(c.manualBulk.cm.clicks, ref.recon.cm.clicks); assert.equal(c.manualBulk.term.clicks, ref.recon.term.clicks, 'compared with that campaign, not the ranking campaign');
  assert.equal(S.compare(sq, bulk, 'blue widget set', { rankIds: ['c1'], manual: typed }).manualBulk, null, 'no campaign picked: the ranking campaigns are the reference');
  assert.equal(S.compare(sq, bulk, 'blue widget set', { manual: { ...typed, camp: 'nope' } }).manualBulk, null, 'an unknown campaign is ignored');
  assert.equal(S.compare(sq, bulk, 'blue widget set', { manual: { camp: 'c2' } }).manualBulk, null, 'no numbers typed: nothing to compare');
  assert.equal(S.compareCampaign(bulk, 'c1', { manual: typed }).manualBulk.id, 'c1', 'a campaign card is compared with itself');
  // saved: the ranking list marks the campaign the numbers are for; a campaign outside the ranking set is added and flagged
  const snap = (rankIds, manual) => S.savePayload(sq, bulk, ['blue widget set'], { 'blue widget set': rankIds }, 'Acme', '', null, { 'blue widget set': manual }).keywords[0];
  assert.deepEqual(snap(['c1', 'c2'], { ...typed, camp: 'c2' }).ranking.map(r => [r.id, !!r.manual, !!r.notRank]), [['c1', false, false], ['c2', true, false]]);
  assert.deepEqual(snap(['c1'], { ...typed, camp: 'c2' }).ranking.map(r => [r.id, !!r.manual, !!r.notRank]), [['c1', false, false], ['c2', true, true]]);
  assert.deepEqual(snap(['c1'], typed).ranking, [{ id: 'c1', name: bulk.camps.get('c1').name }], 'no campaign picked: ranking list unchanged');
  assert.ok(JSON.stringify(snap(['c1'], { ...typed, camp: 'c2' }).ranking).length <= 2000, 'fits the database limit');
}
let real = 0;
if (existsSync('SQP Tracker')) for (const f of readdirSync('SQP Tracker').filter(n => /cerebro.*\.csv$/i.test(n))) {
  const [head, ...body] = csv(readFileSync('SQP Tracker/' + f, 'utf8').replace(/^﻿/, ''));
  const c = S.parseCerebro(body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]]))), f);
  assert.ok(c.ranks.size > 0 && /^[A-Z0-9]{10}$/.test(c.asin) && /^\d{4}-\d{2}-\d{2}$/.test(c.date));
  for (const r of c.ranks.values()) assert.ok(Number.isInteger(r.organic) && r.organic >= 0 && r.organic < 400, 'organic rank in range');
  real++;
}
if (existsSync('SQP Tracker')) for (const f of readdirSync('SQP Tracker').filter(n => /Search_Query_Performance.*\.csv$/i.test(n))) {
  const r = S.parseSqp(csv(readFileSync('SQP Tracker/' + f, 'utf8').replace(/^﻿/, '')));
  assert.match(r.asin, /^[A-Z0-9]{10}$/); assert.ok(r.list.length > 0 && r.from <= r.to);
  for (const x of r.list) for (const k of ['market', 'asin']) { const v = x[k].cvr; assert.ok(v === null || (v >= 0 && v <= 1), 'CVR in range'); }
  real++;
}
// ---- harvest ideas: several weekly reports of one ASIN + a bulk file
{
  const day = k => { const t = new Date(Date.UTC(2026, 7, 16 + 7 * k)), e = new Date(t.getTime() + 6 * 864e5), f = x => x.toISOString().slice(0, 10); return [f(t), f(e)]; };
  // buys: query -> purchases for that week index
  const week = (k, buys, asin) => {
    const rows = JSON.parse(JSON.stringify(d.sqpRows)), [a, b] = day(k);
    rows[0][0] = 'ASIN=["' + (asin || 'B0SAMPLE01') + '"]'; rows[0][2] = 'Select week=["Week ' + (33 + k) + ' | ' + a + ' - ' + b + ' 2026"]';
    rows.forEach((r, i) => { if (i > 1 && buys[r[0]]) r[14] = String(buys[r[0]][k]); else if (i > 1) r[14] = '0'; });
    return S.parseSqp(rows);
  };
  const B = { 'widget organizer': [0, 1, 0, 2, 1, 1, 2, 1], 'red widget': [2, 2, 2, 2, 0, 0, 0, 0], 'widget storage box': [0, 0, 0, 0, 0, 0, 0, 4], 'cheap widgets': [0, 0, 0, 0, 1, 1, 1, 0], 'blue widget': [3, 3, 3, 3, 3, 3, 3, 3], 'blue widget set': [2, 2, 2, 2, 2, 2, 2, 2] };
  const eight = Array.from({ length: 8 }, (_, k) => week(k, B));
  const hb = S.buildBulk(d.campRows, d.termRows.concat([
    { 'Campaign ID': 'c3', 'Customer Search Term': 'widget storage box', Impressions: 500, Clicks: 20, Orders: 2, Spend: 10, Sales: 60 },
    { 'Campaign ID': 'c4', 'Customer Search Term': 'cheap widgets', Impressions: 500, Clicks: 20, Orders: 5, Spend: 10, Sales: 60 }]), d.fileName);
  const h = S.harvestCandidates(eight, hb), by = q => h.rows.find(r => r.query === q);
  assert.deepEqual(h.skus, [], 'no SKU in the sample bulk file');
  const withSku = S.buildBulk(d.campRows.map(r => (r.Entity === 'Product Ad' ? Object.assign({}, r, { SKU: r['ASIN (Informational only)'] === 'B0SAMPLE01' ? 'FBA-1' : 'OTHER' }) : r)), d.termRows, d.fileName);
  assert.deepEqual(S.harvestCandidates(eight, withSku).skus, ['FBA-1'], 'the SKUs of THIS ASIN\'s product ads, for the Campaign Creator row');
  assert.deepEqual(h.rows.map(r => r.query), ['widget organizer', 'red widget', 'widget storage box', 'cheap widgets'], 'qualifying terms, best first; targeted ones are left out');
  assert.equal(h.weeks, 8); assert.ok(h.has4 && h.has8 && !h.gap); assert.equal(h.alreadyTargeted, 2, 'blue widget (phrase) and blue widget set (exact) are targeted');
  assert.equal(by('widget organizer').status, 'strong'); assert.equal(by('widget organizer').w4.buys, 5); assert.equal(by('widget organizer').w4.active, 4); assert.equal(by('widget organizer').w8.buys, 8);
  assert.equal(by('red widget').status, 'cooling'); assert.equal(by('red widget').w4.buys, 0, 'cooling: strong over 8 weeks, nothing in the last 4');
  assert.equal(by('cheap widgets').status, 'recent'); assert.deepEqual(by('cheap widgets').reasons, ['asin'], 'orders in ANOTHER ASIN\'s campaign do not count as SP conversions');
  const st = by('widget storage box'); assert.equal(st.status, 'sp'); assert.deepEqual(st.reasons, ['sp']); assert.equal(st.sp.orders, 2); near(st.sp.cpc, 0.5);
  // one purchase week is not "consistent": 4 purchases in a single week is not enough unless it converted from SP; lowering minWeeks lets it in
  assert.ok(!S.harvestCandidates(eight, S.buildBulk(d.campRows, d.termRows, d.fileName)).rows.some(r => r.query === 'widget storage box'));
  assert.ok(S.harvestCandidates(eight, S.buildBulk(d.campRows, d.termRows, d.fileName), { minWeeks: 1 }).rows.some(r => r.query === 'widget storage box'));
  // thresholds
  assert.ok(!S.harvestCandidates(eight, hb, { min4: 99, min8: 99 }).rows.some(r => r.query === 'widget organizer'));
  // only 4 to 7 weeks: the 4-week window only
  const four = S.harvestCandidates(eight.slice(4), hb); assert.ok(four.has4 && !four.has8); assert.equal(by4(four, 'widget organizer').status, 'recent'); assert.equal(by4(four, 'widget organizer').w8, null);
  function by4(r, q) { return r.rows.find(x => x.query === q); }
  assert.equal(S.harvestCandidates(eight.slice(0, 3), hb).rows.length, 0); assert.equal(S.harvestCandidates(eight.slice(0, 3), hb).has4, false, 'fewer than 4 weeks: nothing is suggested');
  // order does not matter, duplicates are ignored, a gap is flagged, monthly and other-ASIN reports are handled
  const shuf = [eight[5], eight[2], eight[7], eight[0], eight[3], eight[1], eight[6], eight[4], eight[4]]; const hs = S.harvestCandidates(shuf, hb);
  assert.deepEqual(hs.rows.map(r => r.query), h.rows.map(r => r.query)); assert.equal(hs.dupes, 1);
  assert.ok(S.harvestCandidates(eight.filter((_, k) => k !== 5), hb).gap, 'a missing week is flagged');
  const monthly = JSON.parse(JSON.stringify(d.sqpRows)); monthly[0][1] = 'Reporting Range=["Monthly"]'; monthly[0][2] = 'Select year=["2026"]'; monthly[0].push('Select month=["August"]');
  assert.throws(() => S.harvestCandidates(eight.concat([S.parseSqp(monthly)]), hb), /mix weekly and monthly/, 'weekly and monthly periods overlap: one type at a time');
  assert.throws(() => S.harvestCandidates(eight.slice(0, 4).concat([week(4, B, 'B0OTHERASN')]), hb), /different ASINs/);
  assert.throws(() => S.harvestCandidates([], hb), /weekly SQP reports/);
  assert.equal(h.cadence, 'weekly'); assert.equal(h.shortN, 4); assert.equal(h.longN, 8); assert.equal(h.unit, 'week');
  // ---- monthly: one month is enough; three give the longer view
  const hb2 = S.buildBulk(d.campRows, d.termRows, d.fileName);   // no untargeted Sponsored Products terms
  const MN = ['July', 'August', 'September'], mrep = (i, buys) => {
    const rows = JSON.parse(JSON.stringify(d.sqpRows)); rows[0][1] = 'Reporting Range=["Monthly"]'; rows[0][2] = 'Select year=["2026"]'; rows[0].push('Select month=["' + MN[i] + '"]');
    rows.forEach((r, k) => { if (k > 1) r[14] = String(buys[r[0]] ? buys[r[0]][i] : 0); }); return S.parseSqp(rows);
  };
  const MB = { 'widget organizer': [5, 4, 6], 'red widget': [4, 4, 0], 'cheap widgets': [0, 0, 1] };
  const one = S.harvestCandidates([mrep(2, MB)], hb2);
  assert.ok(one.has4 && !one.has8 && one.cadence === 'monthly' && one.shortN === 1 && one.longN === 3, 'one month is enough');
  assert.deepEqual(one.rows.map(r => r.query), ['widget organizer'], 'one month: 6 purchases qualify (3 needed); 1 does not'); assert.equal(one.rows[0].status, 'recent'); assert.equal(one.rows[0].w8, null);
  const three = S.harvestCandidates([2, 0, 1].map(i => mrep(i, MB)), hb2), tb = q => three.rows.find(r => r.query === q);
  assert.ok(three.has8 && !three.gap); assert.equal(tb('widget organizer').status, 'strong'); assert.equal(tb('widget organizer').w8.buys, 15); assert.equal(tb('red widget').status, 'cooling', '8 purchases over 3 months, none this month');
  assert.ok(!tb('cheap widgets'));
  assert.ok(S.harvestCandidates([mrep(0, MB), mrep(2, MB)], hb2).gap, 'July and September without August is a gap');
  assert.equal(S.harvestCandidates([mrep(2, MB)], hb2, { min4: 7 }).rows.length, 0, 'the minimum can still be set');
  assert.match(S.harvestPlan([mrep(2, MB)]), /1 monthly report.*last month.*add reports for the last 3 months/);
  assert.match(S.harvestPlan(eight), /8 weekly reports.*last 4 weeks and last 8 weeks.*3 and 5/);
  // ---- quarterly: one quarter is enough; two give the longer view
  const qrep = (q, buys) => {
    const rows = JSON.parse(JSON.stringify(d.sqpRows)); rows[0][1] = 'Reporting Range=["Quarterly"]'; rows[0][2] = 'Select year=["2026"]'; rows[0].push('Select quarter=["Quarter ' + q + '"]');
    rows.forEach((r, k) => { if (k > 1) r[14] = String(buys[r[0]] ? buys[r[0]][q - 2] : 0); }); return S.parseSqp(rows);
  };
  const QB = { 'widget organizer': [8, 9], 'red widget': [3, 2] };
  const q1x = S.harvestCandidates([qrep(3, QB)], hb2); assert.ok(q1x.has4 && !q1x.has8 && q1x.cadence === 'quarterly'); assert.deepEqual(q1x.rows.map(r => r.query), ['widget organizer'], 'one quarter: 9 purchases qualify (8 needed)');
  const q2x = S.harvestCandidates([qrep(2, QB), qrep(3, QB)], hb2); assert.equal(q2x.rows.find(r => r.query === 'widget organizer').status, 'strong'); assert.equal(q2x.rows.find(r => r.query === 'widget organizer').w8.buys, 17);
  assert.ok(!q2x.rows.some(r => r.query === 'red widget'), '5 purchases over two quarters are below the 14 needed');
  assert.throws(() => S.harvestCandidates([qrep(3, QB), mrep(2, MB)], hb2), /mix quarterly and monthly/);
}
// ---- ranking keyword ideas (last 4 weeks)
{
  const base = { vol: 1000, mImp: 50000, aImp: 1000, mClk: 800, aClk: 25, mBuy: 40, aBuy: 4, mP: 24.99, aP: 24.99 };
  // per query: fields that differ from `base`; arrays = one value per week (index 0 = oldest of the four)
  const Q = {
    'grow kw': {}, 'weak cvr': { aBuy: 1 }, 'no purchases': { aBuy: 0 }, 'tiny kw': { vol: 100 }, 'known kw': {}, 'blue widget set': {}, 'blue widget': {},
    'overexposed kw': { aImp: 25000 }, 'volatile kw': { vol: [1000, 3000, 500, 2500] }, 'falling kw': { aImp: [2000, 2000, 500, 500] }, 'pricey kw': { aP: 40 }, 'rare kw': { _weeks: [2, 3] }
  };
  const val = (v, k) => (Array.isArray(v) ? v[k] : v);
  const week = k => {
    const t = new Date(Date.UTC(2026, 8, 6 + 7 * k)), e = new Date(t.getTime() + 6 * 864e5), f = x => x.toISOString().slice(0, 10);
    const rows = [['ASIN=["B0SAMPLE01"]', 'Reporting Range=["Weekly"]', 'Select week=["Week ' + (36 + k) + ' | ' + f(t) + ' - ' + f(e) + ' 2026"]'], d.sqpRows[1]];
    Object.keys(Q).forEach(q => {
      if (Q[q]._weeks && !Q[q]._weeks.includes(k)) return;
      const g = n => val(Q[q][n] !== undefined ? Q[q][n] : base[n], k);
      rows.push([q, '50', String(g('vol')), String(g('mImp')), String(g('aImp')), '5.0', String(g('mClk')), '40', String(g('aClk')), '3', String(g('mP')), String(g('aP')), String(g('mBuy')), '1.5', String(g('aBuy')), '2']);
    });
    return S.parseSqp(rows);
  };
  const four = [0, 1, 2, 3].map(week), r = S.rankingCandidates(four, bulk, { known: ['Known KW'] }), by = q => r.rows.find(x => x.query === q);
  assert.ok(r.has4 && !r.has8 && !r.hasCerebro && !r.gap); assert.equal(r.weeks, 4);
  assert.equal(by('grow kw').tier, 'strong'); assert.deepEqual(by('grow kw').signals, ['under', 'room', 'rising', 'stable']); near(by('grow kw').cvrRatio, 3.2); near(by('grow kw').buyShare, 0.1); near(by('grow kw').exposure, 5);
  assert.equal(by('grow kw').rank, null, 'no Cerebro report: no rank filter, no rank signal');
  assert.equal(by('weak cvr').tier, 'watch'); assert.deepEqual(by('weak cvr').missed, ['cvr'], 'CVR a little under the market: watch, not strong'); near(by('weak cvr').cvrRatio, 0.8);
  for (const q of ['no purchases', 'tiny kw', 'pricey kw', 'rare kw']) assert.ok(!by(q), q + ' does not pass the hard filters');
  assert.ok(!by('known kw') && !by('blue widget set') && !by('blue widget'), 'already ranking: nominated, or a Rank campaign targets it'); assert.equal(r.alreadyRanking, 3);
  assert.ok(!by('overexposed kw').signals.includes('under') && by('overexposed kw').signals.includes('room'));
  assert.ok(!by('volatile kw').signals.includes('stable') && by('volatile kw').signals.includes('under'));
  assert.ok(!by('falling kw').signals.includes('rising'), 'a falling impression share is not "holding or rising"');
  assert.deepEqual(r.rows.map(x => x.tier), r.rows.map(x => x.tier).slice().sort((a, b) => ({ strong: 0, test: 1, watch: 2 }[a] - { strong: 0, test: 1, watch: 2 }[b])), 'strong first, watch last');
  // thresholds are editable
  assert.ok(!S.rankingCandidates(four, bulk, { minVol: 5000 }).rows.length, 'a higher volume bar removes everything');
  assert.equal(S.rankingCandidates(four, bulk, { minCvr: 0.7, known: ['Known KW'] }).rows.find(x => x.query === 'weak cvr').tier, 'strong', 'with a lower CVR bar it passes outright');
  assert.ok(!S.rankingCandidates(four, bulk, { minCvr: 5 }).rows.some(x => x.query === 'grow kw'), 'a stricter CVR bar drops it');
  // Cerebro: skip what already ranks in the top, reward striking distance, unknown stays in with no rank signal
  const cer = { ranks: new Map([['grow kw', { organic: 20, sponsored: 0 }], ['overexposed kw', { organic: 3, sponsored: 0 }]]) }, rc = S.rankingCandidates(four, bulk, { cerebro: cer });
  assert.ok(rc.hasCerebro && rc.alreadyTop === 1 && !rc.rows.some(x => x.query === 'overexposed kw'), 'organic rank 3 is already there');
  assert.ok(rc.rows.find(x => x.query === 'grow kw').signals.includes('striking') && rc.rows.find(x => x.query === 'grow kw').rank.organic === 20);
  assert.equal(rc.rows.find(x => x.query === 'weak cvr').rank, 'unknown'); assert.ok(!rc.rows.find(x => x.query === 'weak cvr').signals.includes('striking'));
  assert.ok(!S.rankingCandidates(four, bulk, { cerebro: { ranks: new Map([['grow kw', { organic: 90, sponsored: 0 }]]) } }).rows.find(x => x.query === 'grow kw').signals.includes('striking'), 'rank 90 is too far to count as striking distance');
  // fewer than four weeks, other ASIN, shuffled order and 8 weeks
  assert.equal(S.rankingCandidates(four.slice(0, 3), bulk).has4, false); assert.equal(S.rankingCandidates(four.slice(0, 3), bulk).rows.length, 0);
  assert.deepEqual(S.rankingCandidates([four[2], four[0], four[3], four[1]], bulk, { known: ['Known KW'] }).rows.map(x => x.query), r.rows.map(x => x.query));
  assert.throws(() => S.rankingCandidates([], bulk), /weekly SQP reports/);
  const eight = [0, 1, 2, 3, 4, 5, 6, 7].map(week); assert.ok(S.rankingCandidates(eight, bulk).has8);
}
// ---- ranking ideas from saved history
{
  const M = { volume: 1000, price: { market: 24.99, asin: 24.99 }, market: { imp: 50000, clicks: 800, orders: 40 }, asin: { imp: 1000, clicks: 25, orders: 4 } };
  const h = {
    periods: [3, 1, 0, 2].map(i => ({ id: 'p' + i, from: new Date(Date.UTC(2026, 8, 6 + 7 * i)).toISOString().slice(0, 10), to: '2026-09-12', pulled: null })),   // out of order on purpose
    keywords: [{ id: 'k1', query: 'hist grow', display: 'Hist Grow', ranking: [] }, { id: 'k2', query: 'hist ranked', display: 'hist ranked', ranking: [{ id: 'c1', name: 'SP-Rank' }] },
      { id: 'k3', query: 'hist other', display: 'hist other', ranking: [{ id: 'c2', name: 'SP-Other', notRank: 1 }] }, { id: 'k4', query: 'campaign:c9', display: 'SP-Camp', ranking: [] }],
    rows: []
  };
  [0, 1, 2, 3].forEach(i => ['k1', 'k2', 'k3', 'k4'].forEach(k => { if (k === 'k3' && i === 1) return; h.rows.push({ p: 'p' + i, k, d: Object.assign({}, M, k === 'k1' && i === 3 ? { rank: { organic: 20, sponsored: 0, date: 20261001 } } : {}) }); }));
  const hr = S.historyReports(h, 'B0HIST0001');
  assert.deepEqual(hr.reports.map(r => r.from), ['2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27'], 'oldest first'); assert.ok(hr.reports.every(r => r.range === 'weekly' && r.asin === 'B0HIST0001'));
  assert.equal(hr.reports[0].list.length, 3, 'tracked campaigns are not keywords'); assert.ok(!hr.reports[1].queries.has('hist other'), 'a keyword not saved that week is absent, not zero');
  assert.deepEqual(hr.known, ['hist ranked'], 'only a keyword with a ranking campaign is already ranking (a notRank flag is not a campaign)');
  assert.equal(hr.cerebro.ranks.get('hist grow').organic, 20);
  const r = S.rankingCandidates(hr.reports, null, { known: hr.known, cerebro: hr.cerebro }), by = q => r.rows.find(x => x.query === q);
  assert.equal(by('Hist Grow').tier, 'strong'); assert.ok(by('Hist Grow').signals.includes('striking')); assert.ok(!by('hist ranked'), 'excluded: it has a ranking campaign');
  assert.ok(by('hist other'), 'seen in 3 of the 4 weeks is enough'); assert.equal(by('hist other').rank, 'unknown'); assert.equal(by('hist other').sp, null, 'no bulk file in history mode');
  assert.equal(S.rankingCandidates(hr.reports.slice(0, 3), null, { known: hr.known }).has4, false);
}
// ---- the dates in a bulk file name: Amazon's old names and the way people rename their files
{
  const dn = (n, y) => S.datesFromName(n, y), r = (f, t) => ({ from: f, to: t });
  assert.deepEqual(dn('bulk-a1ouo6z7pldj0f-20261004-20261010-1792763823922.xlsx'), r('2026-10-04', '2026-10-10'));
  assert.deepEqual(dn('Bulk October 4-10.xlsx', 2026), r('2026-10-04', '2026-10-10')); assert.deepEqual(dn('Bulk September 1-30.xlsx', 2026), r('2026-09-01', '2026-09-30')); assert.deepEqual(dn('bulk NOV 1 - 7.xlsx', 2026), r('2026-11-01', '2026-11-07'));
  assert.deepEqual(dn('Nov 28 - Dec 4.xlsx', 2026), r('2026-11-28', '2026-12-04')); assert.deepEqual(dn('Dec 28 - Jan 3.xlsx', 2026), r('2026-12-28', '2027-01-03'), 'across the new year'); assert.deepEqual(dn('Dec 28 - Jan 3 2027.xlsx', 2026), r('2026-12-28', '2027-01-03'), 'a year written at the end belongs to the last day');
  assert.deepEqual(dn('Bulk Oct. 4th-10th.xlsx', 2026), r('2026-10-04', '2026-10-10')); assert.deepEqual(dn('Bulk October 4 to 10 2025.xlsx', 2026), r('2025-10-04', '2025-10-10'), 'a year in the name wins');
  assert.deepEqual(dn('bulk 2026-11-01 to 2026-11-07.xlsx'), r('2026-11-01', '2026-11-07')); assert.deepEqual(dn('bulk_2026-11-01_2026-11-07.xlsx'), r('2026-11-01', '2026-11-07'));
  for (const n of ['a1b7c073-1995-41bf-a1a1-dfe85550acf2-UnifiedWorkbook.xlsx', 'marketing 1-7.xlsx', 'allow bidding 1-7.xlsx', 'Bulk Feb 30-31.xlsx', 'Bulk May 9-3.xlsx', 'Bulk October.xlsx', 'report.xlsx', '']) assert.equal(dn(n, 2026), null, n + ' carries no dates');
  assert.equal(dn('Bulk November 1-7.xlsx'), null, 'a name without a year needs the report\'s year');
  assert.equal(S.periodCheck(sq, { dates: dn('Bulk October 4-10.xlsx', 2026) }).status, 'match'); assert.equal(S.periodCheck(sq, { dates: dn('Bulk October 11-17.xlsx', 2026) }).status, 'mismatch');
}
// ---- a second opinion on the dates, from the data
{
  const camps = extra => d.campRows.map(r => (r.Entity === 'Campaign' && extra[r['Campaign ID']] ? Object.assign({}, r, extra[r['Campaign ID']]) : r));
  const mk = (extra, terms) => S.buildBulk(camps(extra), terms || d.termRows, 'x.xlsx'), texts = o => o.map(x => x.level + ':' + x.text);
  assert.deepEqual(S.dateSense(sq, mk({})), [], 'no dates in the file: nothing to say');
  const late = S.dateSense(sq, mk({ c1: { 'Start Date': '20261115' } })); assert.equal(late.length, 1); assert.equal(late[0].level, 'warn'); assert.match(late[0].text, /1 campaign that started after the SQP week ended \(the latest on 2026-11-15\) has activity.*reaches past 2026-10-10/);
  const early = S.dateSense(sq, mk({ c2: { 'End Date': '20260930' } })); assert.equal(early[0].level, 'warn'); assert.match(early[0].text, /ended before the SQP week began \(the earliest on 2026-09-30\).*starts before 2026-10-04/);
  const inside = S.dateSense(sq, mk({ c1: { 'Start Date': '20261006' }, c2: { 'Start Date': '20200101' } })); assert.equal(inside.length, 1); assert.equal(inside[0].level, 'ok'); assert.match(inside[0].text, /started inside the SQP week \(the latest on 2026-10-06\)/);
  assert.equal(S.dateSense(sq, mk({ c1: { 'Start Date': '20261115', Impressions: 0, Spend: 0, Clicks: 0, Orders: 0, Sales: 0 } })).length, 0, 'a campaign with no activity says nothing');
  assert.equal(S.dateSense(sq, mk({ c1: { 'Start Date': '2026-11-15' } }))[0].level, 'warn', 'yyyy-mm-dd dates are read too');
  // ad clicks against the ASIN's SQP clicks, over many queries
  const qs = Array.from({ length: 25 }, (_, i) => 'query ' + i), rows = [d.sqpRows[0], d.sqpRows[1]].concat(qs.map(q => [q, '50', '1000', '50000', '1000', '5.0', '800', '40', '10', '3', '24.99', '24.99', '40', '1.5', '4', '2']));
  const sq25 = S.parseSqp(rows), terms = k => qs.map(q => ({ 'Campaign ID': 'c1', 'Customer Search Term': q, Impressions: 100, Clicks: k, Orders: 0, Spend: 1, Sales: 0 }));
  const high = S.dateSense(sq25, mk({}, terms(30))); assert.equal(high.length, 1); assert.equal(high[0].level, 'warn'); assert.match(high[0].text, /For 25 of 25 queries your ads got more than twice the clicks.*longer period/);
  const fine = S.dateSense(sq25, mk({}, terms(12))); assert.equal(fine[0].level, 'ok'); assert.match(fine[0].text, /only 0 of 25 queries/);
  assert.equal(S.dateSense(sq25, mk({}, terms(15)))[0].level, 'ok', 'ads at 1.5x the ASIN clicks (a campaign with several ASINs) are not twice: no warning');
  assert.equal(S.dateSense(sq25, mk({}, terms(30).slice(0, 10))).length, 0, 'too few queries to judge'); assert.equal(S.dateSense(sq25, S.buildBulk(camps({}), [], 'x.xlsx')).length, 0, 'no search term data: no click check');
  const mixed = n => terms(12).map((t, i) => (i < n ? Object.assign(t, { Clicks: 30 }) : t)); assert.equal(S.dateSense(sq25, mk({}, mixed(5))).length, 0, '5 of 25 (20%): between the two limits, quiet'); assert.equal(S.dateSense(sq25, mk({}, mixed(7)))[0].level, 'warn', '7 of 25 (28%) warns'); assert.equal(S.dateSense(sq25, mk({}, mixed(3)))[0].level, 'ok', '3 of 25 (12%) is fine');
}
console.log('sqp: all checks pass' + (real ? ` (+${real} real report${real > 1 ? 's' : ''} parsed)` : ''));
