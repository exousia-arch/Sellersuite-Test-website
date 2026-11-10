// Tests for the Bulk Optimizer engine (gated/tools/optimizer.js), with synthetic data. Run: node optimizer.test.mjs
import assert from 'node:assert/strict';
await import('./gated/tools/optimizer.js');
const O = globalThis.OPT;
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, a + ' vs ' + b);

const SP_COLS = ['Product', 'Entity', 'Operation', 'Campaign ID', 'Ad Group ID', 'Keyword ID', 'Product Targeting ID', 'Campaign Name (Informational only)', 'Start Date', 'State', 'Campaign State (Informational only)', 'Ad Group State (Informational only)',
  'Ad Group Default Bid', 'Bid', 'Keyword Text', 'Match Type', 'Bidding Strategy', 'Product Targeting Expression', 'Impressions', 'Clicks', 'Spend', 'Sales', 'Orders', 'ACOS', 'CPC', 'ROAS', 'Placement', 'Percentage'];
const sheet = (cols, objs) => [cols].concat(objs.map(o => cols.map(c => (c in o ? o[c] : ''))));
const camp = (id, o = {}) => Object.assign({ Product: 'Sponsored Products', Entity: 'Campaign', 'Campaign ID': id, 'Campaign Name (Informational only)': 'SP-Camp-' + id, 'Start Date': '20260105', State: 'enabled', 'Bidding Strategy': 'Dynamic bids - down only', Impressions: 5000, Clicks: 50, Spend: 40, Sales: 200, Orders: 10 }, o);
const grp = (cid, aid, o = {}) => Object.assign({ Product: 'Sponsored Products', Entity: 'Ad Group', 'Campaign ID': cid, 'Ad Group ID': aid, State: 'enabled', 'Campaign State (Informational only)': 'enabled', 'Ad Group Default Bid': 0.4, Impressions: 4000, Clicks: 40, Spend: 30, Sales: 150, Orders: 8 }, o);
// a keyword row: m = [impressions, clicks, spend, sales, orders]
const kw = (cid, aid, id, text, bid, m, o = {}) => Object.assign({ Product: 'Sponsored Products', Entity: 'Keyword', 'Campaign ID': cid, 'Ad Group ID': aid, 'Keyword ID': id, 'Campaign Name (Informational only)': 'SP-Camp-' + cid, State: 'enabled', 'Campaign State (Informational only)': 'enabled',
  'Ad Group State (Informational only)': 'enabled', Bid: bid, 'Keyword Text': text, 'Match Type': 'Exact', Impressions: m[0], Clicks: m[1], Spend: m[2], Sales: m[3], Orders: m[4] }, o);

// ---- one SP sheet covering every rule
const adj = (cid, place, pct) => ({ Product: 'Sponsored Products', Entity: 'Bidding Adjustment', 'Campaign ID': cid, 'Campaign State (Informational only)': 'enabled', Placement: place, Percentage: pct });
const spRows = [camp('c1'), grp('c1', 'g1'), adj('c1', 'Placement Top', '60.0'), adj('c1', 'Placement Rest Of Search', '0.0'), adj('c1', 'Placement Product Page', '80.0'), adj('c1', 'Placement Amazon Business', '10.0'), adj('c1', '', ''),
  kw('c1', 'g1', 'k1', 'roas 0.8', 1.0, [1000, 20, 20, 16, 2]),      // ROAS 0.8: <= 1 -> -20%
  kw('c1', 'g1', 'k2', 'roas 3.5', 1.0, [1000, 20, 20, 70, 4]),      // 3.5: only <= 4 -> -5%
  kw('c1', 'g1', 'k3', 'roas 2.5', 1.0, [1000, 20, 20, 50, 4]),      // 2.5: <= 3 and <= 4 -> the tighter one, -10%
  kw('c1', 'g1', 'k4', 'roas 4.5', 0.9, [1000, 20, 20, 90, 6]),      // 4.5, bid <= 1 -> +5%
  kw('c1', 'g1', 'k5', 'roas 6', 0.9, [1000, 20, 20, 120, 6]),       // 6 -> >= 5 -> +8%
  kw('c1', 'g1', 'k6', 'roas 6 high bid', 1.2, [1000, 20, 20, 120, 6]),   // above the cap: unchanged
  kw('c1', 'g1', 'k7', 'roas 4 exactly', 1.0, [1000, 20, 20, 80, 5]),     // 4.0 matches <= 4 (low wins), not the raise
  kw('c1', 'g1', 'k8', 'zero 45 clicks', 1.0, [3000, 45, 30, 0, 0]),      // -30%
  kw('c1', 'g1', 'k9', 'zero 26 clicks', 1.0, [3000, 26, 20, 0, 0]),      // -20%
  kw('c1', 'g1', 'k10', 'zero 3 clicks', 1.0, [3000, 3, 2, 0, 0]),        // -10%
  kw('c1', 'g1', 'k11', 'zero 2 clicks', 1.0, [3000, 2, 1, 0, 0]),        // between: no rule
  kw('c1', 'g1', 'k12', 'low traffic', 0.5, [200, 1, 0.4, 0, 0]),         // 1 click, 200 impressions -> +8%
  kw('c1', 'g1', 'k13', 'busy 1 click', 0.5, [500, 1, 0.4, 0, 0]),        // 500 impressions: no rule
  kw('c1', 'g1', 'k14', 'no traffic', 0.5, [0, 0, 0, 0, 0]),              // 0 impressions -> +8%
  kw('c1', 'g1', 'k15', 'low traffic high bid', 1.5, [100, 0, 0, 0, 0]),  // above the cap
  kw('c1', 'g1', 'k16', 'no bid', '', [100, 0, 0, 0, 0]),                  // the ad group default bid 0.40 is used
  kw('c1', 'g1', 'k17', 'at floor', 0.02, [1000, 20, 20, 16, 2]),         // already at the minimum
  kw('c1', 'g1', 'k18', 'near floor', 0.03, [1000, 20, 20, 16, 2]),       // -20% = 0.024 -> the floor 0.02
  kw('c1', 'g1', 'k19', 'paused kw', 1.0, [1000, 20, 20, 16, 2], { State: 'paused' }),
  kw('c2', 'g2', 'k20', 'paused campaign', 1.0, [1000, 20, 20, 16, 2], { 'Campaign State (Informational only)': 'paused' }),
  kw('c3', 'g3', 'k21', 'paused group', 1.0, [1000, 20, 20, 16, 2], { 'Ad Group State (Informational only)': 'paused' }),
  kw('c4', 'g4', 'k22', 'rank campaign kw', 1.0, [1000, 20, 20, 16, 2], { 'Campaign Name (Informational only)': 'SP-Exact-B0X-Rank' }),
  Object.assign(kw('c1', 'g1', 'k23', '', 1.0, [1000, 20, 20, 16, 2]), { Entity: 'Product Targeting', 'Keyword ID': '', 'Product Targeting ID': 'p1', 'Keyword Text': '', 'Match Type': '', 'Product Targeting Expression': 'close-match' }),
  { Product: 'Sponsored Products', Entity: 'Product Ad', 'Campaign ID': 'c1', 'Ad Group ID': 'g1', State: 'enabled', Impressions: 9999 },
  { Product: 'Sponsored Products', Entity: 'Negative Keyword', 'Campaign ID': 'c1', 'Ad Group ID': 'g1', State: 'enabled', 'Keyword Text': 'neg' }];
const model = O.buildModel({ 'Sponsored Products Campaigns': sheet(SP_COLS, spRows), 'SP_COLUMN_IDS': [['x']], 'Config': [['y']] });
assert.deepEqual(model.order, ['sp']); const P = model.products.sp;
assert.equal(P.targets.length, 23); assert.equal(P.targets.filter(t => t.active).length, 20, 'paused target, paused campaign and paused ad group are not active');
const byText = {}; const run = (rules = O.defaultRules(), opts = {}) => { const r = O.optimize(model, { mode: 'shared', shared: rules }, opts); r.results.forEach(x => { byText[x.t.text || x.t.row[P.col['Product Targeting Expression']]] = x; }); return r; };
let r = run();
const exp = (txt, status, nb) => { const x = byText[txt]; assert.ok(x, txt + ' is missing'); assert.equal(x.status, status, txt + ': ' + x.status + ' / ' + x.why); if (nb != null) near(x.newBid, nb, 1e-9); return x; };
exp('roas 0.8', 'change', 0.8); assert.match(byText['roas 0.8'].rule, /Low performing: ROAS <= 1/); near(byText['roas 0.8'].pct, -20);
exp('roas 3.5', 'change', 0.95); exp('roas 2.5', 'change', 0.9); assert.match(byText['roas 2.5'].rule, /<= 3/);
exp('roas 4.5', 'change', 0.95); exp('roas 6', 'change', 0.97); assert.match(byText['roas 6'].rule, /Performing: ROAS >= 5/);
exp('roas 6 high bid', 'same'); assert.equal(byText['roas 6 high bid'].why, 'Bid is above the cap');
exp('roas 4 exactly', 'change', 0.95); assert.match(byText['roas 4 exactly'].rule, /Low performing/, 'a low tier is checked before the raise');
exp('zero 45 clicks', 'change', 0.7); exp('zero 26 clicks', 'change', 0.8); exp('zero 3 clicks', 'change', 0.9); exp('zero 2 clicks', 'same'); assert.equal(byText['zero 2 clicks'].why, 'No rule matched');
exp('low traffic', 'change', 0.54); assert.match(byText['low traffic'].rule, /low traffic: impressions <= 300/); exp('busy 1 click', 'same'); exp('no traffic', 'change', 0.54);
exp('low traffic high bid', 'same'); assert.equal(byText['low traffic high bid'].why, 'Bid is above the cap');
exp('no bid', 'change', 0.43); assert.equal(byText['no bid'].oldBid, 0.4); assert.ok(byText['no bid'].t.bidFromGroup, 'the ad group default bid stands in for the missing bid');
exp('at floor', 'same'); assert.equal(byText['at floor'].why, 'At the minimum bid'); exp('near floor', 'change', 0.02);
assert.ok(!byText['paused kw'] && !byText['paused campaign'] && !byText['paused group'], 'inactive targets are not optimized');
exp('rank campaign kw', 'same'); assert.equal(byText['rank campaign kw'].why, 'Skipped: ranking campaign');
exp('close-match', 'change', 0.8, 'a product-targeting row is optimized too');
assert.equal(r.summary.total, 20); assert.equal(r.summary.changed, r.results.filter(x => x.status === 'change').length); assert.equal(r.summary.up + r.summary.down, r.summary.changed);
// the rank campaign is optimized when the option is off; excluded words
assert.equal(run(O.defaultRules(), { skipRank: false }).results.find(x => x.t.text === 'rank campaign kw').status, 'change');
assert.equal(run(O.defaultRules(), { skipWords: ['camp-c1'] }).results.filter(x => x.status === 'change').length, 0, 'every campaign here is named SP-Camp-c1 or similar');
// floors and a maximum bid
assert.equal(run(O.defaultRules(), { floors: { sp: 0.5 } }).results.find(x => x.t.text === 'roas 0.8').newBid, 0.8);
assert.equal(run(O.defaultRules(), { floors: { sp: 0.9 } }).results.find(x => x.t.text === 'roas 0.8').newBid, 0.9, 'a decrease never goes below the floor');
assert.equal(run(O.defaultRules(), { maxBid: 0.93 }).results.find(x => x.t.text === 'roas 4.5').newBid, 0.93, 'an increase stops at the maximum bid');
assert.equal(run(O.defaultRules(), { maxBid: 0.9 }).results.find(x => x.t.text === 'roas 4.5').why, 'At the maximum bid', 'a bid already at the maximum is not raised');
const minc = O.defaultRules(); minc.perfMinClicks = 25; assert.equal(run(minc).results.find(x => x.t.text === 'roas 4.5').why, 'Fewer than 25 clicks: not raised');
// spend instead of clicks
const sp = O.defaultRules(); sp.zero.by = 'spend'; sp.zero.tiers = [{ at: 25, pct: 30 }, { at: 15, pct: 20 }, { at: 1, pct: 5 }, { at: null, pct: null }, { at: null, pct: null }];
assert.equal(run(sp).results.find(x => x.t.text === 'zero 45 clicks').newBid, 0.7); assert.equal(run(sp).results.find(x => x.t.text === 'zero 26 clicks').newBid, 0.8); assert.equal(run(sp).results.find(x => x.t.text === 'zero 3 clicks').newBid, 0.95);
// ACOS: the thresholds convert (ROAS 4 = ACOS 25%), the direction flips
const ac = O.convertMetric(O.defaultRules(), 'acos'); assert.equal(ac.metric, 'acos'); assert.deepEqual(ac.low.map(t => t.at).slice(0, 4), [100, 50, 33.3, 25]); assert.deepEqual(ac.perf.map(t => t.at).slice(0, 2), [25, 20]); assert.equal(ac.low[5].at, null);
const ra = run(ac); assert.equal(ra.results.find(x => x.t.text === 'roas 2.5').newBid, 0.9, 'ROAS 2.5 = ACOS 40%: tiers >= 33.3 and >= 25, the tighter (largest) 33.3 -> -10%');
assert.equal(ra.results.find(x => x.t.text === 'roas 6').newBid, 0.97, 'ROAS 6 = ACOS 16.7%: <= 20 -> +8%');
// RPC: dollars per click, no conversion
const rp = O.convertMetric(O.defaultRules(), 'rpc'); assert.equal(rp.low[0].at, null); rp.low[0] = { at: 1, pct: 25 }; rp.low[1] = { at: 2, pct: 10 }; rp.perf[0] = { at: 5, pct: 6, cap: 1 };
const rr = run(rp); assert.equal(rr.results.find(x => x.t.text === 'roas 0.8').newBid, 0.75, 'RPC 0.8 <= 1 -> -25%'); assert.equal(rr.results.find(x => x.t.text === 'roas 6').newBid, 0.95, 'RPC 6 >= 5 -> +6%');
assert.equal(O.convertMetric(ac, 'roas').low[0].at, 1); assert.equal(O.convertMetric(ac, 'roas').low[2].at, 3, 'converting back lands on the original');
// separate rule sets per ad type
{
  const sbSheet = sheet(['Product', 'Entity', 'Operation', 'Campaign ID', 'Ad Group ID', 'Keyword ID', 'Campaign Name (Informational only)', 'Start Date', 'State', 'Campaign State (Informational only)', 'Bid Optimization', 'Bid Multiplier', 'Bid', 'Keyword Text', 'Match Type', 'Impressions', 'Clicks', 'Spend', 'Sales', 'Orders'], [
    { Product: 'Sponsored Brands', Entity: 'Campaign', 'Campaign ID': 's1', 'Campaign Name (Informational only)': 'SB-One', 'Start Date': '20210304', State: 'enabled', 'Bid Optimization': 'Manual', 'Bid Multiplier': '-75.0%' },
    { Product: 'Sponsored Brands', Entity: 'Ad Group (Read Only)', 'Campaign ID': 's1', 'Ad Group ID': 'sg1', 'Campaign State (Informational only)': 'enabled' },
    { Product: 'Sponsored Brands', Entity: 'Keyword', 'Campaign ID': 's1', 'Ad Group ID': 'sg1', 'Keyword ID': 'sk1', 'Campaign Name (Informational only)': 'SB-One', State: 'enabled', 'Campaign State (Informational only)': 'enabled', Bid: 1.0, 'Keyword Text': 'sb kw', 'Match Type': 'Broad', Impressions: 1000, Clicks: 20, Spend: 20, Sales: 16, Orders: 2 },
    { Product: 'Sponsored Brands', Entity: 'Campaign', 'Campaign ID': 's2', 'Campaign Name (Informational only)': 'SB-Auto', 'Start Date': '20250918', State: 'enabled', 'Bid Optimization': 'Auto' },
    { Product: 'Sponsored Brands', Entity: 'Keyword', 'Campaign ID': 's2', 'Ad Group ID': 'sg2', 'Keyword ID': 'sk2', 'Campaign Name (Informational only)': 'SB-Auto', State: 'enabled', 'Campaign State (Informational only)': 'enabled', Bid: 1.0, 'Keyword Text': 'sb auto kw', 'Match Type': 'Broad', Impressions: 1000, Clicks: 20, Spend: 20, Sales: 16, Orders: 2 }]);
  const sbm = sheet(['Product', 'Entity', 'Operation', 'Campaign ID', 'Ad Group ID', 'Keyword ID', 'Campaign Name (Informational only)', 'Start Date', 'State', 'Campaign State (Informational only)', 'Bid Optimization', 'Placement', 'Percentage', 'Bid', 'Keyword Text', 'Match Type', 'Impressions', 'Clicks', 'Spend', 'Sales', 'Orders'], [
    ...['Top of Search:50', 'Other:20', 'Detail Page:30', 'Home:40'].map(x => ({ Product: 'Sponsored Brands', Entity: 'Bidding Adjustment by Placement', 'Campaign ID': 'm1', 'Campaign State (Informational only)': 'enabled', Placement: x.split(':')[0], Percentage: +x.split(':')[1] })),
    { Product: 'Sponsored Brands', Entity: 'Campaign', 'Campaign ID': 'm1', 'Campaign Name (Informational only)': 'SBM-One', 'Start Date': '20260127', State: 'enabled', 'Bid Optimization': 'false' },
    { Product: 'Sponsored Brands', Entity: 'Ad Group', 'Campaign ID': 'm1', 'Ad Group ID': 'mg1', State: 'enabled' }, { Product: 'Sponsored Brands', Entity: 'Ad Group', 'Campaign ID': 'm1', 'Ad Group ID': 'mg2', State: 'paused' },
    { Product: 'Sponsored Brands', Entity: 'Keyword', 'Campaign ID': 'm1', 'Ad Group ID': 'mg1', 'Keyword ID': 'mk1', 'Campaign Name (Informational only)': 'SBM-One', State: 'enabled', 'Campaign State (Informational only)': 'enabled', Bid: 1.0, 'Keyword Text': 'sbm kw', 'Match Type': 'Exact', Impressions: 1000, Clicks: 20, Spend: 20, Sales: 16, Orders: 2 },
    { Product: 'Sponsored Brands', Entity: 'Keyword', 'Campaign ID': 'm1', 'Ad Group ID': 'mg2', 'Keyword ID': 'mk2', 'Campaign Name (Informational only)': 'SBM-One', State: 'enabled', 'Campaign State (Informational only)': 'enabled', Bid: 1.0, 'Keyword Text': 'sbm paused group kw', 'Match Type': 'Exact', Impressions: 1000, Clicks: 20, Spend: 20, Sales: 16, Orders: 2 }]);
  const sd = sheet(['Product', 'Entity', 'Operation', 'Campaign ID', 'Ad Group ID', 'Targeting ID', 'Campaign Name (Informational only)', 'Start Date', 'State', 'Campaign State (Informational only)', 'Ad Group State (Informational only)', 'Ad Group Default Bid', 'Bid', 'Bid Optimization', 'Cost Type', 'Targeting Expression', 'Impressions', 'Clicks', 'Spend', 'Sales', 'Orders'], [
    { Product: 'Sponsored Display', Entity: 'Campaign', 'Campaign ID': 'd1', 'Campaign Name (Informational only)': 'SD-One', 'Start Date': '20240117', State: 'enabled', 'Cost Type': 'cpc' },
    { Product: 'Sponsored Display', Entity: 'Ad Group', 'Campaign ID': 'd1', 'Ad Group ID': 'dg1', State: 'enabled', 'Bid Optimization': 'Optimize for conversions', 'Ad Group Default Bid': 0.02 },
    { Product: 'Sponsored Display', Entity: 'Contextual Targeting', 'Campaign ID': 'd1', 'Ad Group ID': 'dg1', 'Targeting ID': 'dt1', 'Campaign Name (Informational only)': 'SD-One', State: 'enabled', 'Campaign State (Informational only)': 'enabled', 'Ad Group State (Informational only)': 'enabled', Bid: 1.0, 'Targeting Expression': 'category="1"', Impressions: 1000, Clicks: 20, Spend: 20, Sales: 0, Orders: 0 },
    { Product: 'Sponsored Display', Entity: 'Campaign', 'Campaign ID': 'd2', 'Campaign Name (Informational only)': 'SD-vcpm', 'Start Date': '20240117', State: 'enabled', 'Cost Type': 'vcpm' },
    { Product: 'Sponsored Display', Entity: 'Audience Targeting', 'Campaign ID': 'd2', 'Ad Group ID': 'dg2', 'Targeting ID': 'dt2', 'Campaign Name (Informational only)': 'SD-vcpm', State: 'enabled', 'Campaign State (Informational only)': 'enabled', 'Ad Group State (Informational only)': 'enabled', Bid: 2.0, 'Targeting Expression': 'views', Impressions: 1000, Clicks: 20, Spend: 20, Sales: 0, Orders: 0 }]);
  const all = O.buildModel({ 'Sponsored Products Campaigns': sheet(SP_COLS, spRows), 'Sponsored Brands Campaigns': sbSheet, 'SB Multi Ad Group Campaigns': sbm, 'Sponsored Display Campaigns': sd });
  assert.deepEqual(all.order, ['sp', 'sb', 'sbm', 'sd']);
  assert.equal(all.products.sb.targets.filter(t => t.active).length, 2, 'SB has no ad group state: target and campaign decide'); assert.equal(all.products.sbm.targets.filter(t => t.active).length, 1, 'SB Multi: the paused ad group row switches its target off');
  assert.equal(all.products.sd.targets.filter(t => t.active).length, 2);
  const shared = { mode: 'shared', shared: O.defaultRules() }, ra = O.optimize(all, shared, { skipManaged: false });
  const f = (key, txt) => ra.results.find(x => x.p === key && (x.t.text === txt));
  assert.equal(f('sb', 'sb kw').newBid, 0.8); assert.ok(f('sb', 'sb auto kw').t.managed && !f('sbm', 'sbm kw').t.managed && f('sd', 'category="1"').t.managed, 'Amazon-managed bids are flagged');
  assert.equal(f('sb', 'sb auto kw').status, 'change'); assert.equal(O.optimize(all, shared, { skipManaged: true }).results.find(x => x.t.text === 'sb auto kw').why, 'Skipped: Amazon adjusts these bids');
  const col2 = (o, n) => o.header.indexOf(n), tr = (o, n, c) => o.rows.find(r => r[col2(o, 'Keyword Text')] === n || r[col2(o, 'Targeting Expression')] === n)[col2(o, c)];
  const osb = O.sheetOutput(all.products.sb, {}), osbm = O.sheetOutput(all.products.sbm, {}), osd = O.sheetOutput(all.products.sd, {});
  assert.equal(tr(osb, 'sb kw', 'Bidding Strategy'), 'Bid optimization: Manual'); assert.equal(tr(osb, 'sb kw', 'Start Date'), '2021-03-04'); assert.equal(tr(osb, 'sb auto kw', 'Bidding Strategy'), 'Bid optimization: Auto');
  assert.equal(tr(osbm, 'sbm kw', 'Bidding Strategy'), 'Bid optimization: off'); assert.equal(tr(osd, 'category="1"', 'Bidding Strategy'), 'Optimize for conversions'); assert.equal(tr(osd, 'category="1"', 'Start Date'), '2024-01-17');
  assert.deepEqual(['TOS %', 'ROS %', 'PP %', 'ABP %'].map(c => tr(osb, 'sb kw', c)), [-75, '', '', ''], 'SB: the campaign bid multiplier is the top-of-search adjustment'); assert.deepEqual(['TOS %', 'ROS %', 'PP %', 'ABP %'].map(c => tr(osbm, 'sbm kw', c)), [50, 20, 30, ''], 'SB Multi Ad Group: Top of Search, Other (rest of search), Detail Page; Home has no column');
  assert.deepEqual(['TOS %', 'ROS %', 'PP %', 'ABP %'].map(c => tr(osd, 'category="1"', c)), ['', '', '', ''], 'SD has no placement adjustments');
  assert.equal(osb.structure, 3, 'SB: 2 campaigns + the read-only ad group row'); assert.equal(osbm.rows.length, 3, 'SB Multi: campaign, the enabled ad group, one target (the paused group and its target are out)');
  assert.equal(f('sd', 'views').why, 'Skipped: per-thousand-impressions bid'); assert.equal(f('sd', 'category="1"').newBid, 0.85, 'SD: 20 clicks, no orders -> the >= 15 tier, -15%');
}

// ---- Sort & Filter layout
{
  const out = O.sheetOutput(P, {}), H = out.header, ex = i => H[P.col.Entity + 1 + i];
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(ex), ['New Bid', 'Old Bid', 'Minimum Bid', 'Maximum Bid', 'RPC', 'RPC Check', 'RPC Status', 'Bidding Strategy', 'Start Date', 'TOS %', 'ROS %', 'PP %', 'ABP %'], 'the added columns sit right after Entity');
  assert.equal(H.length, P.header.length + 13); assert.equal(H[P.col.Entity + 14], 'Operation', 'the original columns follow, in order');
  assert.equal(out.rows.length, 22); assert.equal(out.targets, 20); assert.equal(out.structure, 2, 'the enabled campaign and ad group rows are kept');
  const col = n => H.indexOf(n), cell = (row, n) => row[col(n)], cell2 = (o, r, n) => r[o.header.indexOf(n)];
  assert.deepEqual(out.rows.slice(0, 2).map(r => cell(r, 'Entity')), ['Campaign', 'Ad Group'], 'sorted by impressions, high to low');
  const texts = out.rows.map(r => cell(r, 'Keyword Text') || cell(r, 'Product Targeting Expression'));
  assert.deepEqual(texts.slice(2, 6), ['zero 45 clicks', 'zero 26 clicks', 'zero 3 clicks', 'zero 2 clicks'], '3000 impressions: spend high to low');
  assert.deepEqual(texts.slice(6, 11), ['roas 0.8', 'at floor', 'near floor', 'rank campaign kw', 'close-match'], '1000 impressions and 20 spend: ACOS high to low (125%), ties keep the file order');
  assert.equal(texts[11], 'roas 2.5'); assert.equal(texts[12], 'roas 3.5');
  assert.ok(out.rows.every(r => cell(r, 'New Bid') === ''), 'New Bid is blank in Sort & Filter');
  const row = n => out.rows.find(r => cell(r, 'Keyword Text') === n);
  assert.equal(cell(row('roas 0.8'), 'Old Bid'), 1); assert.equal(cell(row('roas 0.8'), 'Minimum Bid'), 1); assert.equal(cell(row('roas 0.8'), 'Maximum Bid'), 1);
  assert.equal(cell(row('zero 45 clicks'), 'Minimum Bid'), 0.67, 'min of CPC 0.667 and bid 1'); assert.equal(cell(row('zero 45 clicks'), 'Maximum Bid'), 1);
  assert.equal(cell(row('roas 4.5'), 'Minimum Bid'), 0.9, 'CPC 1.00 vs bid 0.90: the bid is the lower'); assert.equal(cell(row('roas 4.5'), 'Maximum Bid'), 1);
  assert.equal(cell(row('no traffic'), 'Minimum Bid'), '', 'no clicks: no CPC to compare, left blank'); assert.equal(cell(row('no traffic'), 'Maximum Bid'), '');
  assert.equal(cell(row('no bid'), 'Old Bid'), 0.4, 'the ad group default bid is the current bid when the row has none');
  assert.ok(out.rows.filter(r => cell(r, 'Campaign ID') === 'c1').every(r => cell(r, 'Bidding Strategy') === 'Dynamic bids - down only' && cell(r, 'Start Date') === '2026-01-05'), 'strategy and start date come from the campaign');
  assert.equal(cell(row('rank campaign kw'), 'Bidding Strategy'), '', 'a campaign that is not in the file has none');
  // Operation is Update on every row; the source rows are untouched
  assert.ok(out.rows.every(r => cell(r, 'Operation') === 'Update'), 'Operation = Update on every row'); assert.equal(P.rows.find(r => r[P.col['Keyword Text']] === 'roas 0.8')[P.col.Operation], '');
  // RPC = sales / clicks (blank without clicks); the check compares the bid with it
  assert.equal(cell(row('roas 0.8'), 'RPC'), 0.8); assert.equal(cell(row('roas 4.5'), 'RPC'), 4.5); assert.equal(cell(row('no traffic'), 'RPC'), ''); assert.equal(cell(out.rows[0], 'RPC'), 4, 'campaign rows get an RPC too (200 / 50)');
  assert.equal(cell(row('roas 0.8'), 'RPC Check'), 'Too high (125%)', 'a $1.00 bid on a $0.80 RPC'); assert.equal(cell(row('roas 4.5'), 'RPC Check'), 'OK (20%)'); assert.equal(cell(row('roas 6'), 'RPC Check'), 'OK (15%)');
  assert.equal(cell(row('zero 45 clicks'), 'RPC Check'), '', 'no orders: no RPC to judge the bid by');
  assert.equal(cell(O.sheetOutput(P, { rpcCheck: { high: 100, low: 20 } }).rows.find(r => cell2(O.sheetOutput(P, {}), r, 'Keyword Text') === 'roas 6'), 'RPC Check'), 'Too low (15%)', 'the limits are editable');
  // placements: the campaign's adjustments, on every row of the campaign
  assert.deepEqual(['TOS %', 'ROS %', 'PP %', 'ABP %'].map(n => cell(row('roas 0.8'), n)), [60, 0, 80, 10]); assert.deepEqual(['TOS %', 'ROS %', 'PP %', 'ABP %'].map(n => cell(out.rows[0], n)), [60, 0, 80, 10]);
  assert.deepEqual(['TOS %', 'ROS %', 'PP %', 'ABP %'].map(n => cell(row('rank campaign kw'), n)), ['', '', '', ''], 'a campaign without adjustment rows has none');
  assert.equal(cell(out.rows[0], 'Old Bid'), '', 'campaign rows have no bid columns');
  assert.equal(O.sheetOutput(P, { includeStructure: false }).rows.length, 20); assert.ok(O.sheetOutput(P, { includeStructure: false }).rows.every(r => cell(r, 'Entity') !== 'Campaign'));
  // review layout: New Bid filled for the changed rows, with the rule and the change
  const opt = O.optimize(model, { mode: 'shared', shared: O.defaultRules() }), rev = O.sheetOutput(P, {}, opt.plan.sp), RH = rev.header;
  assert.deepEqual(RH.slice(P.col.Entity + 14, P.col.Entity + 16), ['Rule applied', 'Change %']);
  const rr = n => rev.rows.find(r => r[RH.indexOf('Keyword Text')] === n), rc = n => rr(n)[RH.indexOf(n === undefined ? '' : n)];
  const v = (n, c) => rr(n)[RH.indexOf(c)];
  assert.equal(v('roas 0.8', 'RPC Check'), 'Too high (100%)', 'in the review the check is on the new bid ($0.80 on a $0.80 RPC)'); assert.equal(v('roas 0.8', 'Operation'), 'Update');
  assert.equal(v('roas 0.8', 'New Bid'), 0.8); assert.equal(v('roas 0.8', 'Old Bid'), 1); assert.match(v('roas 0.8', 'Rule applied'), /Low performing/); assert.equal(v('roas 0.8', 'Change %'), -20);
  assert.equal(v('zero 2 clicks', 'New Bid'), ''); assert.equal(v('zero 2 clicks', 'Rule applied'), 'No rule matched'); assert.equal(v('rank campaign kw', 'Rule applied'), 'Skipped: ranking campaign');
  // upload file: the changed rows only, original columns, Operation = Update and the new bid
  const up = O.uploadOutput(P, opt.plan.sp); assert.deepEqual(up.header, P.header);
  assert.equal(up.rows.length, opt.summary.changed); assert.ok(up.rows.every(r => r[P.col.Operation] === 'Update' && typeof r[P.col.Bid] === 'number'));
  const u = n => up.rows.find(r => r[P.col['Keyword Text']] === n); assert.equal(u('roas 0.8')[P.col.Bid], 0.8); assert.equal(u('no bid')[P.col.Bid], 0.43, 'the default bid is written as an explicit bid'); assert.equal(u('roas 0.8')[P.col.Entity], 'Keyword');
  assert.equal(P.rows.find(r => r[P.col['Keyword Text']] === 'roas 0.8')[P.col.Operation], '', 'the source rows are not changed');
  assert.equal(O.uploadOutput(P, opt.plan.sp, x => x.t.text !== 'roas 0.8').rows.length, opt.summary.changed - 1, 'a changed row can be left out');
  // separate rule sets
  const sep = O.defaultRules(); sep.low = sep.low.map(t => ({ at: t.at, pct: t.pct == null ? null : t.pct * 2 }));
  const mix = O.optimize(model, { mode: 'separate', shared: O.defaultRules(), sp: sep }); assert.equal(mix.results.find(x => x.t.text === 'roas 0.8').newBid, 0.6, 'separate: -40%');
  assert.equal(O.optimize(model, { mode: 'shared', shared: O.defaultRules(), sp: sep }).results.find(x => x.t.text === 'roas 0.8').newBid, 0.8, 'shared mode ignores the separate sets');
  assert.equal(O.optimize(model, { mode: 'separate', shared: O.defaultRules() }).results.find(x => x.t.text === 'roas 0.8').newBid, 0.8, 'a product without its own set uses the shared one');
  assert.equal(O.optimize(model, { mode: 'shared', shared: O.defaultRules() }, { products: [] }).results.length, 0, 'an unticked ad type is left out');
}
// ---- RPC stats, RPC check, rule sanitizing
{
  const st = O.rpcStats(model); assert.equal(st.n, 11, 'active targets with orders'); assert.ok(st.min <= st.p25 && st.p25 <= st.median && st.median <= st.p75 && st.p75 <= st.max); near(st.min, 0.8); near(st.max, 6);
  assert.equal(O.rpcStats(model, []), null); assert.equal(O.rpcCheck(1, 0, 50, 10), '', 'no RPC: no check'); assert.equal(O.rpcCheck(0.5, 10, 50, 10), 'Too low (5%)'); assert.equal(O.rpcCheck(5, 10, 50, 10), 'OK (50%)', 'exactly at the limit is fine'); assert.equal(O.rpcCheck(5.1, 10, 50, 10), 'Too high (51%)');
  const dirty = { metric: 'bogus', low: [{ at: -5, pct: 500 }, { at: 'x', pct: 10 }], perf: 'nope', zero: { by: 'spend', lowClicks: -2, tiers: [{ at: 7, pct: 20 }] }, zeroLow: [{ at: 100, pct: 5, cap: 'z' }], perfMinClicks: 'a' };
  const clean = O.sanitizeRules(dirty);
  assert.equal(clean.metric, 'roas'); assert.deepEqual(clean.low[0], { at: null, pct: 100 }); assert.deepEqual(clean.low[1], { at: null, pct: 10 }); assert.equal(clean.low.length, 6); assert.equal(clean.low[5].at, null, 'missing tiers are blank');
  assert.deepEqual(clean.perf, O.defaultRules().perf, 'not a list: the default'); assert.equal(clean.zero.by, 'spend'); assert.equal(clean.zero.lowClicks, 1, 'invalid number: the default'); assert.equal(clean.zero.tiers.length, 5); assert.equal(clean.zero.tiers[0].at, 7);
  assert.deepEqual(clean.zeroLow[0], { at: 100, pct: 5, cap: null }); assert.equal(clean.perfMinClicks, 0);
  assert.deepEqual(O.sanitizeRules(null), O.defaultRules()); assert.deepEqual(O.sanitizeRules(O.defaultRules()), O.defaultRules(), 'a valid rule set is unchanged');
  const ac = O.convertMetric(O.defaultRules(), 'acos'); assert.deepEqual(O.sanitizeRules(JSON.parse(JSON.stringify(ac))), ac, 'JSON round trip (a saved profile)');
}
// ---- account benchmarks, RPC status and RPC thresholds as a % of the benchmark
{
  const bench = O.benchmarks(model), b = O.benchFor(bench, 'sp', 'product');
  assert.equal(b.n, 17, 'active targets with clicks'); near(b.rpc, 610 / 298, 1e-9); near(b.acos, 273.8 / 610, 1e-9); near(b.spend, 273.8 / 17, 1e-9); assert.equal(O.benchFor(bench, 'sp', 'account').n, 17, 'one ad type: both scopes agree');
  assert.equal(O.benchFor(O.benchmarks(model, []), 'sp', 'product'), null);
  const tgt = n => P.targets.find(t => t.text === n || t.row[P.col['Product Targeting Expression']] === n), st = (n, c, sc) => O.rpcStatus(tgt(n), O.benchFor(bench, 'sp', sc || 'product'), c);
  assert.deepEqual([st('roas 4.5').tone, st('roas 4.5').label, Math.round(st('roas 4.5').pct)], ['green', 'Ideal', 220]);
  assert.equal(st('roas 3.5').tone, 'green'); assert.equal(st('roas 2.5').tone, 'green', 'RPC 2.50 is 122% of the benchmark and ACOS 40% is within the account ACOS (44.9%)');
  assert.deepEqual([st('roas 0.8').tone, st('roas 0.8').label], ['red', 'Bad'], 'RPC 39% of the benchmark');
  assert.deepEqual([st('zero 45 clicks').tone, st('zero 45 clicks').label], ['red', 'Bleeding'], 'no orders and $30 spend against an average of $16'); assert.equal(st('zero 26 clicks').label, 'Bleeding');
  assert.deepEqual([st('zero 3 clicks').tone, st('zero 3 clicks').label], ['grey', 'Not enough data'], '3 clicks is too few to judge');
  assert.equal(st('no traffic').tone, 'grey', 'no clicks at all');
  assert.equal(st('roas 2.5', { greenAt: 150 }).tone, 'yellow', 'RPC 122% of the benchmark, below the 150% bar'); assert.equal(st('roas 3.5', { greenAt: 150 }).tone, 'green');
  assert.equal(st('roas 2.5', { targetAcos: 35 }).tone, 'yellow', 'ACOS 40% is above the 35% target but within 125% of it'); assert.equal(st('roas 2.5', { targetAcos: 30 }).tone, 'red', 'beyond 125% of a 30% target'); assert.equal(st('roas 3.5', { targetAcos: 35 }).tone, 'green');
  assert.equal(st('zero 3 clicks', { bleed: 1.5 }).label, 'Bleeding', 'a lower bleed level catches it even below the click minimum'); assert.equal(st('zero 45 clicks', { bleed: 100 }).tone, 'red', 'below the bleed level it is judged on RPC: 0% of the benchmark');
  assert.equal(st('roas 0.8', { yellowAt: 30 }).tone, 'red', 'ACOS 125% is a loss'); assert.equal(O.rpcStatus(tgt('roas 4.5'), null), null); assert.equal(O.rpcStatus(tgt('roas 4.5'), { rpc: 0 }), null, 'no benchmark: no status');
  assert.equal(O.statusText(st('roas 4.5')), '🟢 Ideal (220%)'); assert.equal(O.statusText(st('zero 45 clicks')), '🔴 Bleeding'); assert.equal(O.statusText(st('zero 3 clicks')), '⚪ Not enough data'); assert.equal(O.statusText(null), '');
  // in the sheet
  const out = O.sheetOutput(P, { bench }), col = n => out.header.indexOf(n), row = n => out.rows.find(r => r[col('Keyword Text')] === n);
  assert.equal(row('roas 4.5')[col('RPC Status')], '🟢 Ideal (220%)'); assert.equal(row('roas 0.8')[col('RPC Status')], '🔴 Bad (39%)'); assert.equal(row('zero 45 clicks')[col('RPC Status')], '🔴 Bleeding'); assert.equal(out.rows[0][col('RPC Status')], '', 'campaign rows have none');
  assert.equal(O.sheetOutput(P, {}).rows.find(r => r[col('Keyword Text')] === 'roas 4.5')[col('RPC Status')], '', 'no benchmark passed: the column is empty');
  assert.equal(O.sheetOutput(P, { bench, rpcStatus: { targetAcos: 35 } }).rows.find(r => r[col('Keyword Text')] === 'roas 2.5')[col('RPC Status')], '🟡 Below ideal (122%)');
  // scope: per ad type or the whole account
  const sdModel = O.buildModel({ 'Sponsored Products Campaigns': sheet(SP_COLS, spRows), 'Sponsored Display Campaigns': sheet(['Product', 'Entity', 'Operation', 'Campaign ID', 'Ad Group ID', 'Targeting ID', 'Campaign Name (Informational only)', 'State', 'Campaign State (Informational only)', 'Ad Group State (Informational only)', 'Bid', 'Targeting Expression', 'Impressions', 'Clicks', 'Spend', 'Sales', 'Orders'], [
    { Product: 'Sponsored Display', Entity: 'Contextual Targeting', 'Campaign ID': 'd1', 'Ad Group ID': 'dg1', 'Targeting ID': 'dt1', 'Campaign Name (Informational only)': 'SD-One', State: 'enabled', 'Campaign State (Informational only)': 'enabled', 'Ad Group State (Informational only)': 'enabled', Bid: 1, 'Targeting Expression': 'category="1"', Impressions: 1000, Clicks: 20, Spend: 5, Sales: 60, Orders: 3 }]) });
  const bb = O.benchmarks(sdModel), sdT = sdModel.products.sd.targets[0];
  near(O.benchFor(bb, 'sd', 'product').rpc, 3); assert.ok(O.benchFor(bb, 'sd', 'account').rpc < 3 && O.benchFor(bb, 'sd', 'account').rpc > 2, 'the account benchmark mixes both ad types');
  assert.equal(O.rpcStatus(sdT, O.benchFor(bb, 'sd', 'product')).pct, 100, 'against its own ad type it is exactly at the benchmark'); assert.ok(O.rpcStatus(sdT, O.benchFor(bb, 'sd', 'account')).pct > 100, 'against the whole account it looks better');
  // RPC thresholds as a % of the benchmark
  const rb = O.setRpcBasis(O.convertMetric(O.defaultRules(), 'rpc'), 'bench'); assert.equal(rb.rpcBasis, 'bench'); assert.deepEqual(rb.low.slice(0, 3), [{ at: 50, pct: 20 }, { at: 70, pct: 10 }, { at: 85, pct: 5 }]); assert.deepEqual(rb.perf[0], { at: 120, pct: 5, cap: 1 }); assert.equal(rb.perf[2].at, null);
  const rr = O.optimize(model, { mode: 'shared', shared: rb }), f = n => rr.results.find(x => x.t.text === n);
  assert.equal(f('roas 0.8').newBid, 0.8); assert.equal(f('roas 0.8').rule, 'Low performing: RPC <= 50% of benchmark'); assert.equal(f('roas 3.5').newBid, 1.08); assert.equal(f('roas 3.5').rule, 'Performing: RPC >= 150% of benchmark', 'the most demanding tier met');
  assert.equal(f('roas 2.5').newBid, 1.05, 'RPC 122%: the >= 120% tier'); assert.equal(f('roas 6 high bid').why, 'Bid is above the cap');
  assert.equal(O.optimize(model, { mode: 'shared', shared: rb }, { rpcStatus: { scope: 'account' } }).results.find(x => x.t.text === 'roas 3.5').newBid, 1.08, 'account scope: the same on one ad type');
  assert.equal(O.optimize(model, { mode: 'shared', shared: rb }, { bench: { product: { sp: { rpc: 0 } }, account: { rpc: 0 } } }).results.find(x => x.t.text === 'roas 3.5').why, 'No account benchmark to compare the RPC with');
  const back = O.setRpcBasis(rb, 'abs'); assert.equal(back.rpcBasis, 'abs'); assert.ok(back.low.every(t => t.at === null) && back.perf.every(t => t.at === null) && back.perf[0].cap === 1);
  assert.equal(O.sanitizeRules({ rpcBasis: 'bench' }).rpcBasis, 'bench'); assert.equal(O.sanitizeRules({ rpcBasis: 'x' }).rpcBasis, 'abs'); assert.equal(O.convertMetric(rb, 'roas').rpcBasis, 'abs');
}
// ---- leaving out ranking, catch-all and low-bid campaigns (found by name; only what is in the file)
{
  const K = O.KINDS, hit = (k, n) => K[k].rx.test(n);
  for (const n of ['SP-Exact-B0X-"bungee cords"-Rank', 'Rank-TOS', 'SP-Phrase-RANK', 'ranking test', 'X_Ranking_Y']) assert.ok(hit('rank', n), n + ' is a ranking campaign');
  for (const n of ['SP-Exact-Frankfurt-Widgets', 'Drank', 'Rankine', 'SP-Auto']) assert.ok(!hit('rank', n), n + ' is not');
  for (const n of ['SP-Auto-Catch all- Audience', 'Catch All | Defense | Phrase', 'SP-Auto-B2B-Catch All- SFP', 'catchall', 'Catch-All', 'SP_catch_all']) assert.ok(hit('catchall', n), n + ' is a catch-all campaign');
  for (const n of ['Catch the wave', 'SP-Auto-Catchy']) assert.ok(!hit('catchall', n), n + ' is not');
  for (const n of ['B017WZ2F8A_SP AUTO LOW BID', 'SP-AUTO-B0CG-LOW BID-SPRING SALE', 'x low-bid y', 'LowBid', 'low bids', 'SP_lowbid_x']) assert.ok(hit('lowbid', n), n + ' is a low-bid campaign');
  for (const n of ['allow bidding test', 'Below bid', 'Lowest bid', 'SP-Exact-Slow Bidder']) assert.ok(!hit('lowbid', n), n + ' is not');
  assert.equal(O.excludeReason('SP-Auto-Catch All', { catchall: true }, []), 'Skipped: catch-all campaign'); assert.equal(O.excludeReason('SP-Auto-Catch All', { rank: true }, []), ''); assert.equal(O.excludeReason('x defense y', {}, ['defense']), 'Skipped: excluded by name');
  const names = { c1: 'SP-Normal', c2: 'SP-Exact-B0X-Rank', c3: 'SP-Auto-Catch all- Audience', c4: 'B0X_SP AUTO LOW BID', c5: 'SP-Exact-Frankfurt-Widgets', c6: 'allow bidding test' };
  const rows = []; Object.keys(names).forEach(id => { rows.push(camp(id, { 'Campaign Name (Informational only)': names[id] })); rows.push(grp(id, 'g' + id)); rows.push(kw(id, 'g' + id, 'k' + id, 'kw ' + id, 1.0, [1000, 45, 30, 0, 0], { 'Campaign Name (Informational only)': names[id] })); });
  rows.push(camp('c7', { State: 'paused', 'Campaign Name (Informational only)': 'Paused Catch All' }));   // a paused campaign does not count
  const m = O.buildModel({ 'Sponsored Products Campaigns': sheet(SP_COLS, rows) }), cc = O.campaignCounts(m);
  assert.deepEqual([cc.rank.campaigns, cc.rank.targets, cc.catchall.campaigns, cc.catchall.targets, cc.lowbid.campaigns, cc.lowbid.targets], [1, 1, 1, 1, 1, 1], 'only the real matches, active ones'); assert.equal(cc.rank.byProduct.sp, 1);
  assert.deepEqual(O.campaignCounts(O.buildModel({ 'Sponsored Products Campaigns': sheet(SP_COLS, [camp('c1'), grp('c1', 'g1'), kw('c1', 'g1', 'k1', 'a', 1, [10, 1, 1, 0, 0])]) })).catchall, { campaigns: 0, targets: 0, byProduct: {} }, 'nothing of that kind in the file: nothing to offer');
  const texts = o => O.sheetOutput(m.products.sp, o).rows.map(r => r[O.sheetOutput(m.products.sp, o).header.indexOf('Campaign ID')]);
  assert.equal(texts({}).length, 18, 'no exclusion: every active row (6 campaigns x campaign, ad group, target)');
  assert.deepEqual(new Set(texts({ skipRank: true })), new Set(['c1', 'c3', 'c4', 'c5', 'c6']), 'ranking campaigns leave the sorted file, all their rows');
  assert.deepEqual(new Set(texts({ skipRank: true, skipCatchAll: true, skipLowBid: true })), new Set(['c1', 'c5', 'c6']), 'all three; look-alike names stay'); assert.equal(texts({ skipCatchAll: true, skipLowBid: true, skipRank: true }).length, 9);
  assert.deepEqual(new Set(texts({ skipWords: ['normal'] })), new Set(['c2', 'c3', 'c4', 'c5', 'c6']), 'extra words leave rows out of the sorted file too');
  const res = (o) => O.optimize(m, { mode: 'shared', shared: O.defaultRules() }, o).results, why = (rs, t) => rs.find(x => x.t.text === t);
  assert.equal(why(res({}), 'kw c2').why, 'Skipped: ranking campaign', 'ranking is skipped unless turned off'); assert.equal(why(res({}), 'kw c3').status, 'change'); assert.equal(why(res({}), 'kw c4').status, 'change');
  assert.equal(why(res({ skipCatchAll: true }), 'kw c3').why, 'Skipped: catch-all campaign'); assert.equal(why(res({ skipLowBid: true }), 'kw c4').why, 'Skipped: low-bid campaign');
  assert.equal(why(res({ skipRank: false }), 'kw c2').status, 'change'); assert.equal(why(res({ skipCatchAll: true, skipLowBid: true }), 'kw c5').status, 'change', 'a look-alike name is optimized'); assert.equal(why(res({ skipCatchAll: true, skipLowBid: true }), 'kw c6').status, 'change');
}
// ---- the reference columns at the end of the upload file
{
  const opt = O.optimize(model, { mode: 'shared', shared: O.defaultRules() }), bench = O.benchmarks(model);
  const up = O.uploadOutput(P, opt.plan.sp, null, { withExtras: true, bench }), xi = n => P.header.length + O.EXTRA.indexOf(n), u = n => up.rows.find(r => r[P.col['Keyword Text']] === n);
  assert.deepEqual(up.header.slice(0, P.header.length), P.header, 'the original columns first, unchanged'); assert.deepEqual(up.header.slice(P.header.length), O.EXTRA, 'the reference columns at the very end');
  assert.ok(up.rows.every(r => r.length === P.header.length + O.EXTRA.length && r[P.col.Operation] === 'Update'));
  assert.equal(u('roas 0.8')[P.col.Bid], 0.8); assert.equal(u('roas 0.8')[xi('New Bid')], 0.8); assert.equal(u('roas 0.8')[xi('Old Bid')], 1); assert.equal(u('roas 0.8')[xi('RPC')], 0.8); assert.equal(u('roas 0.8')[xi('RPC Check')], 'Too high (100%)', 'the check is on the new bid');
  assert.deepEqual(['TOS %', 'ROS %', 'PP %', 'ABP %'].map(n => u('roas 0.8')[xi(n)]), [60, 0, 80, 10]); assert.equal(u('roas 0.8')[xi('Start Date')], '2026-01-05'); assert.equal(u('roas 0.8')[xi('Bidding Strategy')], 'Dynamic bids - down only');
  assert.deepEqual(O.uploadOutput(P, opt.plan.sp).header, P.header, 'without the option: the original columns only'); assert.ok(O.uploadOutput(P, opt.plan.sp, null, { withExtras: false }).rows.every(r => r.length === P.header.length));
}
// ---- bleeding Product Pages placements
{
  const ppRow = (cid, pct, m) => ({ Product: 'Sponsored Products', Entity: 'Bidding Adjustment', 'Campaign ID': cid, 'Campaign State (Informational only)': 'enabled', Placement: 'Placement Product Page', Percentage: String(pct), Impressions: m[0], Clicks: m[1], Spend: m[2], Sales: m[3], Orders: m[4] });
  const cn = id => ({ 'Campaign Name (Informational only)': 'SP-' + id });
  const rows = [
    camp('cA', cn('A')), grp('cA', 'gA'), ppRow('cA', 80, [4000, 40, 50, 0, 0]), kw('cA', 'gA', 'a1', 'a one', 1.0, [1000, 30, 20, 0, 0], cn('A')), kw('cA', 'gA', 'a2', 'a two', 2.0, [1000, 20, 10, 120, 6], cn('A')), kw('cA', 'gA', 'a3', 'a three', 1.5, [500, 5, 3, 0, 0], cn('A')),
    camp('cB', cn('B')), grp('cB', 'gB'), ppRow('cB', 50, [1000, 10, 10, 100, 5]), kw('cB', 'gB', 'b1', 'b one', 1.0, [1000, 10, 10, 100, 5], cn('B')),
    camp('cC', cn('C')), grp('cC', 'gC'), ppRow('cC', 0, [2000, 20, 30, 40, 3]), kw('cC', 'gC', 'c1', 'c one', 2.0, [1000, 20, 30, 40, 3], cn('C')),
    camp('cE', cn('E')), grp('cE', 'gE'), ppRow('cE', 60, [2000, 15, 30, 20, 2]), kw('cE', 'gE', 'e1', 'e one', 1.8, [800, 15, 30, 20, 2], cn('E')),
    camp('cD', Object.assign(cn('D'), { State: 'paused' })), ppRow('cD', 40, [2000, 50, 90, 0, 0])];   // a paused campaign is not looked at
  const m = O.buildModel({ 'Sponsored Products Campaigns': sheet(SP_COLS, rows) }), bench = O.benchmarks(m), SPm = m.products.sp;
  const an = O.ppAnalysis(m, { acosLimit: 50 }, bench), by = c => an.rows.find(x => x.cid === c);
  assert.deepEqual(an.rows.map(x => x.cid), ['cA', 'cC', 'cE', 'cB'], 'active campaigns with a Product Pages row, most spend first'); near(an.bleedSpend, (50 + 10 + 30 + 30) / 4); near(by('cA').cpc, 1.25);
  assert.deepEqual([by('cA').bleeding, by('cB').bleeding, by('cC').bleeding, by('cE').bleeding], [true, false, true, true]);
  assert.equal(by('cA').reason, 'No sales on Product Pages'); assert.equal(by('cC').reason, 'ACOS 75% on Product Pages'); assert.equal(by('cE').reason, 'ACOS 150% on Product Pages');
  assert.deepEqual(O.ppAnalysis(m, { acosLimit: 500 }, bench).rows.filter(x => x.bleeding).map(x => x.cid), ['cA', 'cE'], 'an ACOS above 100% is always bleeding, whatever the limit');
  assert.deepEqual(O.ppAnalysis(m, { acosLimit: 50, minClicks: 25 }, bench).rows.filter(x => x.bleeding).map(x => x.cid), ['cA'], 'too few Product Pages clicks to judge an ACOS (no sales and a big spend still counts)');
  assert.deepEqual(O.ppAnalysis(m, { acosLimit: 500, bleedSpend: 60 }, bench).rows.filter(x => x.bleeding).map(x => x.cid), ['cE'], 'a higher bleed level: only the ACOS case is left');
  assert.equal(O.ppAnalysis(m, { acosLimit: 50 }, bench, []).rows.length, 0);
  // the plan: recommendation or manual, only ever lower
  const A = by('cA'), plan = (pp, f) => O.ppPlan(f || A, pp, 0.02);
  assert.deepEqual([plan({ action: 'placement' }).placement, plan({ action: 'placement' }).bid], [40, null], 'recommendation: half the adjustment is removed'); assert.equal(plan({ action: 'placement', cut: 100 }).placement, 0); assert.equal(plan({ action: 'placement', cut: 25 }).placement, 60);
  assert.equal(plan({ action: 'placement', placeMode: 'manual', placeManual: 20 }).placement, 20); assert.equal(plan({ action: 'placement', placeMode: 'manual', placeManual: 90 }).placement, null, 'a manual adjustment that is not lower is refused'); assert.match(plan({ action: 'placement', placeMode: 'manual', placeManual: 90 }).notes[0], /not lower than 80%/);
  assert.match(plan({ action: 'placement', placeMode: 'manual' }).notes[0], /Type the new adjustment/); assert.match(plan({ action: 'placement' }, by('cC')).notes[0], /already 0%/);
  assert.deepEqual([plan({ action: 'bids' }).placement, plan({ action: 'bids' }).bid], [null, 1.13], 'recommendation: 10% under the Product Pages CPC of $1.25'); assert.equal(plan({ action: 'bids', margin: 20 }).bid, 1);
  assert.equal(plan({ action: 'bids', bidMode: 'manual', bidManual: 0.7 }).bid, 0.7); assert.equal(O.ppPlan(A, { action: 'bids', bidMode: 'manual', bidManual: 0.01 }, 0.1).bid, 0.1, 'never under the floor'); assert.match(plan({ action: 'bids', bidMode: 'manual' }).notes[0], /Type the desired bid/);
  assert.deepEqual([plan({ action: 'both' }).placement, plan({ action: 'both' }).bid], [40, 1.13]); assert.deepEqual(plan({ action: 'none' }), { placement: null, bid: null, notes: [] });
  assert.match(O.ppPlan(Object.assign({}, A, { cpc: null }), { action: 'bids' }, 0.02).notes[0], /No Product Pages clicks/);
  // inside Optimize
  const rules = { mode: 'shared', shared: O.defaultRules() }, run = pp => O.optimize(m, rules, { bench, pp: Object.assign({ acosLimit: 50 }, pp) }), f = (r, t) => r.results.find(x => x.t.text === t);
  const none = run({ action: 'none' }); assert.equal(none.summary.placements, 0, 'no action chosen: nothing changes'); assert.ok(!none.results.some(x => x.kind === 'placement'));
  const both = run({ action: 'both' }), pl = both.results.filter(x => x.kind === 'placement');
  assert.deepEqual(pl.map(x => [x.t.campName, x.oldPct, x.newPct, x.pct]), [['SP-A', 80, 40, -50], ['SP-E', 60, 30, -50]], 'Product Pages adjustments lowered (cC is already at 0%, cB is not bleeding)'); assert.equal(both.summary.placements, 2);
  assert.equal(both.summary.total, 6, 'the placement changes are not counted as targets (6 active targets)'); assert.ok(Object.keys(both.summary.byRule).includes('Bleeding Product Pages: lower the placement adjustment'));
  assert.equal(f(both, 'a three').newBid, 1.13); assert.equal(f(both, 'a three').rule, 'Bleeding Product Pages: bid under the Product Pages CPC ($1.25)'); near(f(both, 'a three').pct, (1.13 / 1.5 - 1) * 100, 0.01);
  assert.equal(f(both, 'a one').newBid, 0.8, 'the rules already cut this bid lower than the Product Pages bid: that one stays'); assert.equal(f(both, 'a two').status, 'same', 'a green target is spared'); assert.equal(f(both, 'a two').oldBid, 2);
  assert.equal(f(run({ action: 'bids', spare: false }), 'a two').newBid, 1.13, 'spare off: it is lowered too');
  assert.equal(f(run({ action: 'bids' }), 'e one').newBid, 1.44, 'cE: the Product Pages bid (1.80) is not lower than the rules (ROAS 0.67: -20% = 1.44), so the rules stand');
  assert.ok(!run({ action: 'bids' }).results.some(x => x.kind === 'placement'), 'bids only: no placement change'); assert.ok(run({ action: 'placement' }).results.every(x => x.kind === 'placement' || !/Product Pages/.test(x.rule)), 'placement only: no Product Pages bid change');
  assert.equal(run({ action: 'placement' }).results.filter(x => x.kind === 'placement').length, 2);
  assert.equal(f(run({ action: 'bids', bidMode: 'manual', bidManual: 0.5 }), 'a three').newBid, 0.5); assert.equal(f(run({ action: 'bids', bidMode: 'manual', bidManual: 0.5 }), 'a three').rule, 'Bleeding Product Pages: bid set to $0.50');
  assert.equal(f(run({ action: 'bids', bidMode: 'manual', bidManual: 5 }), 'a three').newBid, 1.35, 'a manual bid above the current one is not applied: the rules (-10%) stand'); assert.ok(!/Product Pages/.test(f(run({ action: 'bids', bidMode: 'manual', bidManual: 5 }), 'a three').rule));
  const ex = O.optimize(m, rules, { bench, skipWords: ['sp-a'], pp: { action: 'both', acosLimit: 50 } }); assert.ok(!ex.results.some(x => x.kind === 'placement' && x.t.campName === 'SP-A') && f(ex, 'a three').why === 'Skipped: excluded by name', 'an excluded campaign is left alone, placement included');
  // the upload file: the placement row is the original "Bidding Adjustment" row with the new Percentage
  const up = O.uploadOutput(SPm, both.plan.sp, null, {}), pr = up.rows.filter(r => r[SPm.col.Entity] === 'Bidding Adjustment');
  assert.equal(pr.length, 2); assert.deepEqual(pr.map(r => [r[SPm.col['Campaign ID']], r[SPm.col.Placement], r[SPm.col.Percentage], r[SPm.col.Operation]]), [['cA', 'Placement Product Page', 40, 'Update'], ['cE', 'Placement Product Page', 30, 'Update']]);
  assert.equal(SPm.rows[both.results.find(x => x.kind === 'placement').ri][SPm.col.Percentage], '80', 'the source row is not changed');
  assert.equal(O.uploadOutput(SPm, both.plan.sp, x => x.kind !== 'placement').rows.filter(r => r[SPm.col.Entity] === 'Bidding Adjustment').length, 0, 'a placement change can be left out');
  const upx = O.uploadOutput(SPm, both.plan.sp, null, { withExtras: true, bench }); assert.ok(upx.rows.every(r => r.length === upx.header.length), 'reference columns on the placement rows too');
  const so = O.sheetOutput(SPm, { bench }); assert.ok(!so.rows.some(r => r[so.header.indexOf('Entity')] === 'Bidding Adjustment'), 'placement rows are not in the sorted file');
}
console.log('optimizer: all checks pass');
