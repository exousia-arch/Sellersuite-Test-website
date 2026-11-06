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
console.log('sqp: all checks pass' + (real ? ` (+${real} real report${real > 1 ? 's' : ''} parsed)` : ''));
