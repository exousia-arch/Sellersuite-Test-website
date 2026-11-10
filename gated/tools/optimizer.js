// PPCBench Bulk Optimizer (Pro). Files are read and written in the browser: nothing is uploaded or stored.
// Works on Amazon's unified bulk workbook: Sponsored Products, Sponsored Brands, SB Multi Ad Group and Sponsored Display sheets.
//   Sort & Filter : the active rows (campaign, ad group and target all enabled), sorted by impressions, spend, then ACOS (high to low), plus reference
//                   columns (right after the ROAS column, New Bid nearest to it; at the end when there is no ROAS column): New Bid (blank here), Old Bid, Minimum Bid, Maximum Bid (CPC vs bid), RPC (sales per click), an RPC check of the bid, an RPC status
//                   against the account's own benchmark (green / yellow / red / grey),
//                   Bidding Strategy, Start Date and the placement adjustments TOS, ROS, PP, ABP. Operation is "Update" on every row.
//   Optimize      : new target bids from rules (ROAS, ACOS or RPC), shown in the same layout, plus an upload file with Update rows only.
// The engine below is pure (runs in node for tests); the UI is at the bottom (browser only).
//
// Facts this relies on (checked against a real unified download):
//  - Amazon declares some sheets one row tall (A1) although the cells are there: the reader must widen the range.
//  - A target is active only if its own State, its campaign's state and its ad group's state are all "enabled". Sponsored Brands has no
//    ad group state at all; SB Multi Ad Group has it only on the Ad Group rows; Sponsored Products and Display carry it on the target row.
//  - Metrics (Impressions, Clicks, Spend, Sales, Orders) sit on the target row. ACOS is a ratio in the file. We recompute ACOS, ROAS, CPC and RPC from the counts.
(function (root) {
  'use strict';
  const num = v => {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n;
  };
  const has = v => v !== '' && v != null;
  const low = v => String(v == null ? '' : v).trim().toLowerCase();
  const r2 = v => Math.round((v + Number.EPSILON) * 100) / 100;
  const valid = v => typeof v === 'number' && isFinite(v);

  // sheet = the sheet's name; targets = the entities that carry a bid; groups = the ad group entities; floor = the lowest bid Amazon accepts (editable)
  const PRODUCTS = {
    sp:  { label: 'Sponsored Products', short: 'SP', sheet: /^sponsored products campaigns$/i, targets: ['Keyword', 'Product Targeting'], groups: ['Ad Group'], floor: 0.02 },
    sb:  { label: 'Sponsored Brands', short: 'SB', sheet: /^sponsored brands campaigns$/i, targets: ['Keyword'], groups: ['Ad Group (Read Only)', 'Ad Group'], floor: 0.1 },
    sbm: { label: 'SB Multi Ad Group', short: 'SB Multi', sheet: /^sb multi ad group campaigns$/i, targets: ['Keyword'], groups: ['Ad Group'], floor: 0.1 },
    sd:  { label: 'Sponsored Display', short: 'SD', sheet: /^sponsored display campaigns$/i, targets: ['Contextual Targeting', 'Audience Targeting'], groups: ['Ad Group'], floor: 0.02 }
  };
  const ORDER = ['sp', 'sb', 'sbm', 'sd'];
  const EXTRA = ['New Bid', 'Old Bid', 'Minimum Bid', 'Maximum Bid', 'RPC', 'RPC Check', 'RPC Status', 'Bidding Strategy', 'Start Date', 'TOS %', 'ROS %', 'PP %', 'ABP %'], EXTRA_REVIEW = ['Rule applied', 'Change %'];

  // ------------------------------------------------------------------ the workbook
  // sheets = { sheetName: array of arrays, header row first }. Sheets that are not one of the four ad types are ignored.
  function buildModel(sheets) {
    const model = { products: {}, order: [] };
    Object.keys(sheets || {}).forEach(name => {
      const k = ORDER.find(x => PRODUCTS[x].sheet.test(String(name).trim())); if (!k || model.products[k]) return;
      const p = buildProduct(k, name, sheets[name]); if (p) { model.products[k] = p; model.order.push(k); }
    });
    model.order.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    return model;
  }

  function buildProduct(key, sheetName, aoa) {
    if (!aoa || aoa.length < 2) return null;
    const P = PRODUCTS[key], header = aoa[0].map(h => String(h == null ? '' : h).trim()), col = {};
    header.forEach((h, i) => { if (h && !(h in col)) col[h] = i; });
    if (!('Entity' in col) || !('Campaign ID' in col)) return null;
    const g = (r, c) => (c in col ? r[col[c]] : ''), rows = aoa.slice(1).filter(r => r.some(has));
    const camps = new Map(), groups = new Map(), tset = new Set(P.targets);
    rows.forEach(r => {
      const e = String(g(r, 'Entity')).trim();
      if (e === 'Campaign') camps.set(String(g(r, 'Campaign ID')), r); else if (P.groups.includes(e)) groups.set(String(g(r, 'Ad Group ID')), r);
    });
    const p = { key, label: P.label, short: P.short, sheet: sheetName, header, col, rows, camps, groups, g, targets: [], kinds: new Array(rows.length).fill(null), active: new Array(rows.length).fill(false), floor: P.floor, place: new Map(), pp: new Map() };
    collectPlacements(p);
    const campState = id => { const c = camps.get(id); return c ? low(g(c, 'State')) : ''; };
    const groupState = id => { const a = groups.get(id); return a ? low(g(a, 'State')) : ''; };
    const okState = s => s === '' || s === 'enabled';
    rows.forEach((r, ri) => {
      const e = String(g(r, 'Entity')).trim(), cid = String(g(r, 'Campaign ID')), aid = String(g(r, 'Ad Group ID'));
      const cs = low(g(r, 'Campaign State (Informational only)')) || campState(cid), as = low(g(r, 'Ad Group State (Informational only)')) || groupState(aid);
      if (e === 'Campaign') { p.kinds[ri] = 'campaign'; p.active[ri] = low(g(r, 'State')) === 'enabled'; return; }
      if (P.groups.includes(e)) { p.kinds[ri] = 'group'; p.active[ri] = okState(low(g(r, 'State'))) && okState(cs); return; }
      if (!tset.has(e)) return;
      p.kinds[ri] = 'target';
      const t = targetRecord(p, r, ri, e, cid, aid);
      t.active = p.active[ri] = low(g(r, 'State')) === 'enabled' && okState(cs) && okState(as);
      p.targets.push(t);
    });
    return p;
  }

  // metrics from the counts (the file's own ACOS is a ratio and is 0 when there are no sales, which would hide the worst rows)
  function metrics(g, r) {
    const imp = num(g(r, 'Impressions')), clicks = num(g(r, 'Clicks')), spend = num(g(r, 'Spend')), sales = num(g(r, 'Sales')), orders = num(g(r, 'Orders'));
    return { imp, clicks, spend, sales, orders, cpc: clicks ? spend / clicks : null, roas: spend ? sales / spend : null, acos: sales ? spend / sales : (spend > 0 ? Infinity : null), rpc: clicks ? sales / clicks : null };
  }

  function targetRecord(p, r, ri, entity, cid, aid) {
    const g = p.g, m = metrics(g, r), camp = p.camps.get(cid), grp = p.groups.get(aid);
    let bid = has(g(r, 'Bid')) ? num(g(r, 'Bid')) : null, fromGroup = false;
    if (bid === null && grp && has(g(grp, 'Ad Group Default Bid'))) { bid = num(g(grp, 'Ad Group Default Bid')); fromGroup = true; }
    const text = String(g(r, 'Keyword Text') || g(r, 'Product Targeting Expression') || g(r, 'Targeting Expression') || g(r, 'Resolved Product Targeting Expression (Informational only)') || g(r, 'Resolved Targeting Expression (Informational only)') || '');
    let managed = false;   // Amazon itself adjusts bids for this campaign
    if (p.key === 'sb') managed = low(camp && g(camp, 'Bid Optimization')) === 'auto';
    else if (p.key === 'sbm') managed = low(camp && g(camp, 'Bid Optimization')) === 'true';
    else if (p.key === 'sd') managed = low(grp && g(grp, 'Bid Optimization')).startsWith('optimize for');
    const cost = low(g(r, 'Cost Type')) || low(camp && g(camp, 'Cost Type'));
    return Object.assign({ p: p.key, ri, row: r, entity, campId: cid, agId: aid, text, match: String(g(r, 'Match Type') || ''), bid, bidFromGroup: fromGroup, managed, vcpm: cost === 'vcpm',
      campName: String(g(r, 'Campaign Name (Informational only)') || g(r, 'Campaign Name') || (camp && (g(camp, 'Campaign Name (Informational only)') || g(camp, 'Campaign Name'))) || ''), active: false }, m);
  }

  // Placement bid adjustments (%) per campaign: top of search, rest of search, product pages, Amazon Business.
  //  SP: "Bidding Adjustment" rows (Placement Top / Rest Of Search / Product Page / Amazon Business); SB Multi Ad Group: "Bidding Adjustment by
  //  Placement" rows (Top of Search / Other / Detail Page; Home has no column here); SB: the campaign's Bid Multiplier is the top-of-search adjustment.
  function placementKey(label) {
    const s = low(label);
    if (/amazon business/.test(s)) return 'abp'; if (/top/.test(s)) return 'tos'; if (/rest of search|^other$/.test(s)) return 'ros'; if (/product page|detail page/.test(s)) return 'pp'; return null;
  }
  function collectPlacements(p) {
    const g = p.g, put = (cid, k, v) => { if (!k || !has(v)) return; const m = p.place.get(cid) || {}; m[k] = num(v); p.place.set(cid, m); };
    p.rows.forEach((r, ri) => {
      const e = String(g(r, 'Entity')).trim(), cid = String(g(r, 'Campaign ID')), isPlace = (p.key === 'sp' && e === 'Bidding Adjustment') || (p.key === 'sbm' && e === 'Bidding Adjustment by Placement');
      if (isPlace && placementKey(g(r, 'Placement')) === 'pp') p.pp.set(cid, { ri, pct: num(g(r, 'Percentage')), m: metrics(g, r) });
      if (p.key === 'sp' && e === 'Bidding Adjustment') put(cid, placementKey(g(r, 'Placement')), g(r, 'Percentage'));
      else if (p.key === 'sbm' && e === 'Bidding Adjustment by Placement') put(cid, placementKey(g(r, 'Placement')), g(r, 'Percentage'));
      else if (p.key === 'sb' && e === 'Campaign') put(cid, 'tos', g(r, 'Bid Multiplier'));
    });
  }
  // Is a bid too high or too low for what a click earns? bid / RPC is the ACOS you would have at the average click: above `high` % is too high, below `low` % too low.
  function rpcCheck(bid, rpc, high, low) {
    if (!valid(bid) || !valid(rpc) || rpc <= 0 || bid <= 0) return '';
    const pc = Math.round(bid / rpc * 100), tag = bid / rpc * 100 > high ? 'Too high' : bid / rpc * 100 < low ? 'Too low' : 'OK';
    return tag + ' (' + pc + '%)';
  }
  // ---- account benchmarks and the RPC status (green / yellow / red / grey)
  // The benchmark is the account's own performance over its active targets with clicks: RPC = total sales / total clicks (weighted, so one lucky
  // click cannot set the bar), ACOS = total spend / total sales, and the average spend per target (the default "bleeding" level).
  // Per ad type (SB and SD clicks cost more than SP) or the whole account.
  function benchmarks(model, products) {
    const agg = () => ({ clicks: 0, spend: 0, sales: 0, n: 0 }), by = {}, acc = agg();
    model.order.forEach(k => {
      if (products && !products.includes(k)) return; const a = by[k] = agg();
      model.products[k].targets.forEach(t => { if (!t.active || !(t.clicks > 0)) return; [a, acc].forEach(x => { x.clicks += t.clicks; x.spend += t.spend; x.sales += t.sales; x.n++; }); });
    });
    const fin = a => ({ n: a.n, rpc: a.clicks ? a.sales / a.clicks : null, acos: a.sales ? a.spend / a.sales : null, spend: a.n ? a.spend / a.n : null, cpc: a.clicks ? a.spend / a.clicks : null });
    const out = { product: {}, account: fin(acc) }; Object.keys(by).forEach(k => { out.product[k] = fin(by[k]); }); return out;
  }
  const benchFor = (bench, key, scope) => (bench ? (scope === 'account' ? bench.account : bench.product[key]) || null : null);
  const STATUS_ICON = { green: '🟢', yellow: '🟡', red: '🔴', grey: '⚪' };
  // c: targetAcos (% , blank = the account's own ACOS), minClicks, bleed ($, blank = the account's average spend per target), greenAt / yellowAt (% of the benchmark RPC), slack (% of the target ACOS)
  //   green  : RPC at or above the benchmark and ACOS within the target
  //   yellow : RPC between yellowAt and greenAt of the benchmark, or ACOS above the target but within the slack
  //   red    : RPC under yellowAt, ACOS beyond the slack or above 100%, or "bleeding" (no orders, spend at or above the bleed level)
  //   grey   : fewer than minClicks clicks (too little to judge)
  function rpcStatus(t, b, c) {
    c = Object.assign({ targetAcos: null, minClicks: 10, bleed: null, greenAt: 100, yellowAt: 70, slack: 125 }, c);
    if (!b || !(b.rpc > 0)) return null;
    const bleed = c.bleed > 0 ? c.bleed : b.spend;
    if (t.orders === 0 && t.spend > 0 && t.spend >= bleed) return { tone: 'red', label: 'Bleeding', pct: null };
    if (!(t.clicks > 0) || t.clicks < c.minClicks) return { tone: 'grey', label: 'Not enough data', pct: null };
    const pct = t.rpc / b.rpc * 100, tgt = c.targetAcos > 0 ? c.targetAcos / 100 : b.acos, acos = t.sales > 0 ? t.spend / t.sales : Infinity, haveT = isFinite(tgt) && tgt > 0;
    if (acos > 1 || pct < c.yellowAt || (haveT && acos > tgt * c.slack / 100)) return { tone: 'red', label: 'Bad', pct };
    if (pct < c.greenAt || (haveT && acos > tgt)) return { tone: 'yellow', label: 'Below ideal', pct };
    return { tone: 'green', label: 'Ideal', pct };
  }
  const statusText = s => (s ? STATUS_ICON[s.tone] + ' ' + s.label + (s.pct == null ? '' : ' (' + Math.round(s.pct) + '%)') : '');

  // ---- campaigns to leave out, recognised by their names (the UI offers only the kinds that exist in the file)
  const KINDS = {
    rank:     { rx: /(^|[^a-z])rank(ing|s)?(?![a-z])/i, why: 'Skipped: ranking campaign' },       // "...-Rank", "Rank-TOS", "Ranking" (not "Frankfurt")
    catchall: { rx: /catch[\s_-]*all/i, why: 'Skipped: catch-all campaign' },                      // "Catch All", "Catch all-", "catch-all"
    lowbid:   { rx: /(^|[^a-z])low[\s_-]*bids?(?![a-z])/i, why: 'Skipped: low-bid campaign' }     // "LOW BID", "low-bid", "LowBid" (not "allow bidding")
  };
  const nameOfRow = (p, r) => { const c = p.camps.get(String(p.g(r, 'Campaign ID'))); return String((c && (p.g(c, 'Campaign Name (Informational only)') || p.g(c, 'Campaign Name'))) || p.g(r, 'Campaign Name (Informational only)') || p.g(r, 'Campaign Name') || ''); };
  // the reason a campaign is left out, or ''. on = { rank, catchall, lowbid } (booleans), words = extra lower-case name fragments
  function excludeReason(name, on, words) {
    name = String(name || '');
    for (const k of Object.keys(KINDS)) if (on[k] && KINDS[k].rx.test(name)) return KINDS[k].why;
    const n = low(name); return (words || []).some(w => n.includes(w)) ? 'Skipped: excluded by name' : '';
  }
  // How many active campaigns and active targets of each kind the file has (per ad type too).
  function campaignCounts(model) {
    const out = {}; Object.keys(KINDS).forEach(k => { out[k] = { campaigns: 0, targets: 0, byProduct: {} }; });
    model.order.forEach(key => {
      const p = model.products[key];
      p.rows.forEach((r, ri) => { if (p.kinds[ri] !== 'campaign' || !p.active[ri]) return; const n = nameOfRow(p, r); Object.keys(KINDS).forEach(k => { if (KINDS[k].rx.test(n)) out[k].campaigns++; }); });
      p.targets.forEach(t => { if (!t.active) return; Object.keys(KINDS).forEach(k => { if (KINDS[k].rx.test(t.campName)) { out[k].targets++; out[k].byProduct[key] = (out[k].byProduct[key] || 0) + 1; } }); });
    });
    return out;
  }

  // ---- Product Pages placements
  // Per campaign the file has a "Product Page" placement row (SP) or "Detail Page" row (SB Multi Ad Group) with its own clicks, spend and sales and the
  // bid adjustment %. Bleeding = spend with no sales, or an ACOS beyond the limit (and always above 100%).
  // pp (settings): minClicks, bleedSpend ($, null = the average Product Pages spend per campaign), acosLimit (%, null = target ACOS x slack),
  //   action none | placement | bids | both, placeMode rec | manual, cut (% of the adjustment to remove), placeManual (the new adjustment %),
  //   bidMode rec | manual, margin (% below the Product Pages CPC), bidManual ($), spare (leave green RPC targets alone)
  const ppConfig = (pp, rs) => Object.assign({ minClicks: 10, bleedSpend: null, acosLimit: null, action: 'none', placeMode: 'rec', cut: 50, placeManual: null, bidMode: 'rec', margin: 10, bidManual: null, spare: true }, pp, { targetAcos: rs && rs.targetAcos, slack: rs && rs.slack > 0 ? rs.slack : 125 });
  function ppAnalysis(model, cfg, bench, products) {
    cfg = ppConfig(cfg, cfg); const found = [];
    model.order.forEach(key => {
      if (products && !products.includes(key)) return; const p = model.products[key];
      p.pp.forEach((x, cid) => {
        const camp = p.camps.get(cid); if (!camp || low(p.g(camp, 'State')) !== 'enabled') return;
        found.push({ p: key, cid, name: nameOfRow(p, camp), ri: x.ri, pct: x.pct, imp: x.m.imp, clicks: x.m.clicks, spend: x.m.spend, sales: x.m.sales, orders: x.m.orders, cpc: x.m.cpc, acos: x.m.sales > 0 ? x.m.spend / x.m.sales : null, bleeding: false, reason: '' });
      });
    });
    const withSpend = found.filter(f => f.spend > 0), avgSpend = withSpend.length ? withSpend.reduce((a, f) => a + f.spend, 0) / withSpend.length : null;
    const bleed = cfg.bleedSpend > 0 ? cfg.bleedSpend : avgSpend, base = cfg.targetAcos > 0 ? cfg.targetAcos : (bench && bench.account && bench.account.acos > 0 ? bench.account.acos * 100 : null);
    const limit = cfg.acosLimit > 0 ? cfg.acosLimit : base === null ? null : base * cfg.slack / 100;
    found.forEach(f => {
      if (f.spend > 0 && f.orders === 0 && bleed !== null && f.spend >= bleed) { f.bleeding = true; f.reason = 'No sales on Product Pages'; }
      else if (f.clicks >= cfg.minClicks && f.acos !== null && (f.acos * 100 > 100 || (limit !== null && f.acos * 100 > limit))) { f.bleeding = true; f.reason = 'ACOS ' + Math.round(f.acos * 100) + '% on Product Pages'; }
    });
    found.sort((a, b) => b.spend - a.spend);
    return { rows: found, bleedSpend: bleed, acosLimit: limit };
  }
  // What to do about one bleeding campaign: a lower Product Pages adjustment, and/or a target bid under the Product Pages CPC. Only ever lowers.
  function ppPlan(f, pp, floor) {
    pp = ppConfig(pp, pp); const out = { placement: null, bid: null, notes: [] };
    if (pp.action === 'placement' || pp.action === 'both') {
      if (!(f.pct > 0)) out.notes.push('Adjustment is already 0%');
      else {
        const np = pp.placeMode === 'manual' ? (valid(pp.placeManual) && pp.placeManual >= 0 ? Math.min(900, Math.round(pp.placeManual)) : null) : Math.floor(f.pct * (1 - Math.min(100, pp.cut) / 100));
        if (np === null) out.notes.push('Type the new adjustment %'); else if (np < f.pct) out.placement = np; else out.notes.push('That adjustment is not lower than ' + f.pct + '%');
      }
    }
    if (pp.action === 'bids' || pp.action === 'both') {
      const b = pp.bidMode === 'manual' ? pp.bidManual : (f.cpc > 0 ? r2(f.cpc * (1 - Math.min(100, pp.margin) / 100)) : null);
      if (valid(b) && b > 0) out.bid = r2(Math.max(b, floor || 0)); else out.notes.push(pp.bidMode === 'manual' ? 'Type the desired bid' : 'No Product Pages clicks to take a CPC from');
    }
    return out;
  }

  // The spread of RPC over the active targets that have orders, to sanity-check RPC thresholds against.
  function rpcStats(model, products) {
    const v = [];
    model.order.forEach(k => { if (products && !products.includes(k)) return; model.products[k].targets.forEach(t => { if (t.active && t.orders > 0 && t.rpc !== null) v.push(t.rpc); }); });
    if (!v.length) return null; v.sort((a, b) => a - b);
    const q = f => v[Math.min(v.length - 1, Math.floor(f * (v.length - 1) + 0.5))];
    return { n: v.length, min: v[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: v[v.length - 1] };
  }

  const iso = v => { const s = String(v == null ? '' : v).trim(); return /^\d{8}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6) : s; };
  // The strategy label of a campaign. SP has a real bidding strategy; the other ad types have a bid optimization switch.
  function strategyOf(p, cid, aid) {
    const c = p.camps.get(cid), g = p.g;
    if (p.key === 'sp') return c ? String(g(c, 'Bidding Strategy') || '') : '';
    if (p.key === 'sb') { const v = c ? String(g(c, 'Bid Optimization') || '') : ''; return v ? 'Bid optimization: ' + v : ''; }
    if (p.key === 'sbm') { const v = low(c ? g(c, 'Bid Optimization') : ''); return v === 'true' ? 'Bid optimization: on' : v === 'false' ? 'Bid optimization: off' : ''; }
    const a = p.groups.get(aid); return a ? String(g(a, 'Bid Optimization') || '') : '';
  }
  const startOf = (p, cid) => { const c = p.camps.get(cid); return c ? iso(p.g(c, 'Start Date')) : ''; };

  // The reference columns of one row (New Bid ... ABP %). Shared by the sorted / review files and by the upload file (where they go at the end).
  function makeExtras(p, o, plan) {
    const g = p.g, rc = Object.assign({ high: 50, low: 10 }, o.rpcCheck), rs = o.rpcStatus || {}, bm = benchFor(o.bench, p.key, rs.scope), byIdx = new Map(p.targets.map(t => [t.ri, t]));
    return ri => {
      const r = p.rows[ri], cid = String(g(r, 'Campaign ID')), aid = String(g(r, 'Ad Group ID')), t = byIdx.get(ri), res = plan && plan.get(ri);
      let oldBid = '', minBid = '', maxBid = '', newBid = '', check = '', status = '';
      const m = metrics(g, r), rpc = m.clicks > 0 ? r2(m.sales / m.clicks) : '', pl = p.place.get(cid) || {};
      if (t) {
        if (t.bid !== null) oldBid = t.bid;
        if (t.bid !== null && t.clicks > 0 && t.cpc !== null) { minBid = r2(Math.min(t.cpc, t.bid)); maxBid = r2(Math.max(t.cpc, t.bid)); }
        if (res && res.status === 'change' && res.kind !== 'placement') newBid = res.newBid;
        if (t.orders > 0 && t.rpc !== null) check = rpcCheck(newBid !== '' ? newBid : t.bid, t.rpc, rc.high, rc.low);   // the bid you would end up with
        status = statusText(rpcStatus(t, bm, rs));
      }
      return [newBid, oldBid, minBid, maxBid, rpc, check, status, strategyOf(p, cid, aid), startOf(p, cid), pl.tos === undefined ? '' : pl.tos, pl.ros === undefined ? '' : pl.ros, pl.pp === undefined ? '' : pl.pp, pl.abp === undefined ? '' : pl.abp];
    };
  }

  // ------------------------------------------------------------------ Sort & Filter (and the review layout of Optimize)
  // Only the target rows (the entities that carry a bid): SP Keyword and Product Targeting, SB and SB Multi Ad Group Keyword, SD Contextual and Audience Targeting.
  // plan: Map(ri -> result) from optimize() for the review layout.
  function sheetOutput(p, o, plan) {
    o = o || {}; const oi = p.col.Operation, extras = makeExtras(p, o, plan);
    const g = p.g, at = 'ROAS' in p.col ? p.col.ROAS + 1 : p.header.length, review = !!plan, rowsOut = [];   // `at`: where the added columns go
    const keep = [], on = { rank: !!o.skipRank, catchall: !!o.skipCatchAll, lowbid: !!o.skipLowBid }, words = (o.skipWords || []).map(low).filter(Boolean), anyOut = on.rank || on.catchall || on.lowbid || words.length > 0;
    p.rows.forEach((r, ri) => { const k = p.kinds[ri]; if (k !== 'target' || !p.active[ri]) return; if (anyOut && excludeReason(nameOfRow(p, r), on, words)) return; keep.push(ri); });
    const metr = new Map(), key = ri => { let m = metr.get(ri); if (!m) { m = metrics(g, p.rows[ri]); metr.set(ri, m); } return m; };
    const acosKey = m => (m.acos === null ? -1 : m.acos);
    keep.sort((a, b) => { const x = key(a), y = key(b); return (y.imp - x.imp) || (y.spend - x.spend) || (acosKey(y) - acosKey(x)) || (a - b); });
    keep.forEach(ri => {
      const r = p.rows[ri], res = plan && plan.get(ri), extra = extras(ri);
      if (review) extra.push(res ? (res.status === 'change' ? res.rule : res.why) : '', res && res.status === 'change' ? res.pct : '');
      const base = r.slice(); if (oi !== undefined) base[oi] = 'Update';   // every row says Update, so the layout is ready for the Operation column
      rowsOut.push(base.slice(0, at).concat(extra, base.slice(at)));
    });
    const hdr = p.header.slice(0, at).concat(EXTRA, review ? EXTRA_REVIEW : [], p.header.slice(at));
    return { header: hdr, rows: rowsOut, targets: keep.filter(ri => p.kinds[ri] === 'target').length, structure: 0 };
  }

  // ------------------------------------------------------------------ rules
  const blank = cap => (cap ? { at: null, pct: null, cap: null } : { at: null, pct: null });
  const fill = (list, n, cap) => list.concat(Array.from({ length: n - list.length }, () => blank(cap)));
  // The same four blocks as the Excel sheet this replaces. metric: roas | acos | rpc.
  function defaultRules() {
    return {
      metric: 'roas',
      low: fill([{ at: 1, pct: 20 }, { at: 2, pct: 15 }, { at: 3, pct: 10 }, { at: 4, pct: 5 }], 6),
      perf: fill([{ at: 4, pct: 5, cap: 1 }, { at: 5, pct: 8, cap: 1 }], 5, true),
      zero: { by: 'clicks', lowClicks: 1, tiers: fill([{ at: 40, pct: 30 }, { at: 25, pct: 20 }, { at: 15, pct: 15 }, { at: 3, pct: 10 }], 5) },
      zeroLow: fill([{ at: 300, pct: 8, cap: 1 }], 5, true),
      perfMinClicks: 0,
      rpcBasis: 'abs'   // RPC thresholds in dollars ('abs') or as a % of the account benchmark RPC ('bench')
    };
  }
  // Changing the metric converts ROAS <-> ACOS (ACOS % = 100 / ROAS); RPC has no equivalent, so its thresholds start empty.
  function convertMetric(rules, to) {
    const out = JSON.parse(JSON.stringify(rules)), from = rules.metric; if (from === to) return out;
    const conv = at => { if (!valid(at) || at <= 0) return null; if (from === 'rpc' || to === 'rpc') return null; return to === 'acos' ? Math.round(1000 / at) / 10 : Math.round(100 / at * 100) / 100; };
    ['low', 'perf'].forEach(k => out[k].forEach(t => { t.at = conv(t.at); }));
    out.metric = to; out.rpcBasis = 'abs'; return out;
  }
  // RPC thresholds as a % of the account benchmark RPC start from sensible tiers; back to dollars they start empty.
  function setRpcBasis(rules, basis) {
    const out = JSON.parse(JSON.stringify(rules)); out.rpcBasis = basis === 'bench' ? 'bench' : 'abs';
    out.low = out.low.map(() => ({ at: null, pct: null })); out.perf = out.perf.map(t => ({ at: null, pct: null, cap: t.cap }));
    if (out.rpcBasis === 'bench') { [[50, 20], [70, 10], [85, 5]].forEach(([at, pct], i) => { out.low[i] = { at, pct }; }); [[120, 5], [150, 8]].forEach(([at, pct], i) => { out.perf[i] = { at, pct, cap: out.perf[i].cap }; }); }
    return out;
  }
  // Rules from outside (a saved profile, an imported file) -> a complete, valid rule set. Anything unusable falls back to the default.
  function sanitizeRules(x) {
    const d = defaultRules(), n = v => (valid(v) && v >= 0 ? v : null), out = defaultRules(); x = x && typeof x === 'object' ? x : {};
    out.metric = ['roas', 'acos', 'rpc'].includes(x.metric) ? x.metric : d.metric;
    const tiers = (src, def, cap) => def.map((t, i) => { const s = Array.isArray(src) && src[i] && typeof src[i] === 'object' ? src[i] : null; if (!s) return Array.isArray(src) ? blank(cap) : t; const o = { at: n(s.at), pct: n(s.pct) }; if (o.pct !== null && o.pct > 100) o.pct = 100; if (cap) o.cap = n(s.cap); return o; });
    out.low = tiers(x.low, d.low); out.perf = tiers(x.perf, d.perf, true); out.zeroLow = tiers(x.zeroLow, d.zeroLow, true);
    const z = x.zero && typeof x.zero === 'object' ? x.zero : {};
    out.zero = { by: z.by === 'spend' ? 'spend' : 'clicks', lowClicks: n(z.lowClicks) === null ? d.zero.lowClicks : z.lowClicks, tiers: tiers(z.tiers, d.zero.tiers) };
    out.perfMinClicks = n(x.perfMinClicks) === null ? 0 : x.perfMinClicks; out.rpcBasis = x.rpcBasis === 'bench' ? 'bench' : 'abs';
    return out;
  }
  const METRIC_LABEL = { roas: 'ROAS', acos: 'ACOS', rpc: 'RPC' };
  const rulesFor = (rulesBy, key) => (rulesBy.mode === 'separate' && rulesBy[key] ? rulesBy[key] : rulesBy.shared);

  // The tightest matching tier: for <= the smallest threshold met, for >= the largest threshold met.
  function pickTier(tiers, ok, op) {
    const c = tiers.filter(t => valid(t.at) && valid(t.pct) && t.pct > 0 && ok(t));
    if (!c.length) return null;
    return c.reduce((a, b) => (op === '<=' ? (b.at < a.at ? b : a) : (b.at > a.at ? b : a)));
  }
  const fmtAt = (metric, at, bench) => (metric === 'acos' ? at + '%' : metric === 'rpc' ? (bench ? at + '% of benchmark' : '$' + at) : String(at));

  // One target + its rules -> { dir, pct, rule, ruleKey } or { why } when nothing applies.
  function decide(t, R, bm) {
    const M = R.metric, ML = METRIC_LABEL[M], oldBid = t.bid, bench = M === 'rpc' && R.rpcBasis === 'bench';
    if (t.orders > 0) {
      if (bench && !(bm && bm.rpc > 0)) return { why: 'No account benchmark to compare the RPC with' };
      const val = bench ? (t.rpc === null ? null : t.rpc / bm.rpc * 100) : M === 'roas' ? t.roas : M === 'rpc' ? t.rpc : (t.acos === null ? null : t.acos * 100);
      if (val === null) return { why: 'No spend to measure ' + ML };
      const lowOp = M === 'acos' ? '>=' : '<=', perfOp = M === 'acos' ? '<=' : '>=';
      const cmp = (op, at) => (op === '<=' ? val <= at : val >= at);
      const lo = pickTier(R.low, x => cmp(lowOp, x.at), lowOp);
      if (lo) return { dir: 'down', pct: lo.pct, ruleKey: 'low', rule: 'Low performing: ' + ML + ' ' + lowOp + ' ' + fmtAt(M, lo.at, bench) };
      const matched = R.perf.filter(x => valid(x.at) && valid(x.pct) && x.pct > 0 && cmp(perfOp, x.at));
      if (!matched.length) return { why: 'No rule matched' };
      if (R.perfMinClicks > 0 && t.clicks < R.perfMinClicks) return { why: 'Fewer than ' + R.perfMinClicks + ' clicks: not raised' };
      const pf = pickTier(matched, x => !valid(x.cap) || oldBid <= x.cap, perfOp);
      if (!pf) return { why: 'Bid is above the cap' };
      return { dir: 'up', pct: pf.pct, ruleKey: 'perf', rule: 'Performing: ' + ML + ' ' + perfOp + ' ' + fmtAt(M, pf.at, bench) };
    }
    const Z = R.zero;
    if (t.clicks > Z.lowClicks) {
      const val = Z.by === 'spend' ? t.spend : t.clicks, z = pickTier(Z.tiers, x => val >= x.at, '>=');
      if (!z) return { why: 'No rule matched' };
      return { dir: 'down', pct: z.pct, ruleKey: 'zero', rule: 'No orders: ' + (Z.by === 'spend' ? 'spend >= $' : 'clicks >= ') + z.at };
    }
    const matched = R.zeroLow.filter(x => valid(x.at) && valid(x.pct) && x.pct > 0 && t.imp <= x.at);
    if (!matched.length) return { why: 'No rule matched' };
    const zl = pickTier(matched, x => !valid(x.cap) || oldBid <= x.cap, '<=');
    if (!zl) return { why: 'Bid is above the cap' };
    return { dir: 'up', pct: zl.pct, ruleKey: 'zerolow', rule: 'No orders, low traffic: impressions <= ' + zl.at };
  }

  // ------------------------------------------------------------------ Optimize
  // rulesBy = { mode: 'shared' | 'separate', shared: rules, sp?: rules, sb?, sbm?, sd? }
  // o = { products, skipRank, skipManaged, skipWords: [], floors: {sp: .02, ...}, maxBid }
  // -> { results: [per active target], plan: { key: Map(ri -> result) }, summary }
  function optimize(model, rulesBy, o) {
    o = Object.assign({ products: model.order.slice(), skipRank: true, skipManaged: false, skipWords: [], floors: {}, maxBid: null }, o);
    const words = (o.skipWords || []).map(low).filter(Boolean), on = { rank: !!o.skipRank, catchall: !!o.skipCatchAll, lowbid: !!o.skipLowBid }, results = [], plan = {}, bench = o.bench || benchmarks(model, o.products), scope = o.rpcStatus && o.rpcStatus.scope;
    model.order.forEach(key => {
      if (!o.products.includes(key)) return;
      const p = model.products[key], R = rulesFor(rulesBy, key), floor = valid(o.floors[key]) ? o.floors[key] : p.floor; plan[key] = new Map();
      p.targets.forEach(t => {
        if (!t.active) return;
        const res = { p: key, ri: t.ri, t, status: 'same', oldBid: t.bid, newBid: null, pct: null, rule: '', ruleKey: '', why: '' }, out = excludeReason(t.campName, on, words);
        if (out) res.why = out;
        else if (t.vcpm) res.why = 'Skipped: per-thousand-impressions bid';
        else if (t.managed && o.skipManaged) res.why = 'Skipped: Amazon adjusts these bids';
        else if (t.bid === null) res.why = 'Skipped: no bid';
        else {
          const d = o.onlyPP ? { why: 'Not part of this run' } : decide(t, R, benchFor(bench, key, scope)); res.ruleKey = d.ruleKey || '';   // onlyPP: just the Product Pages changes
          if (!d.dir) res.why = d.why;
          else {
            let nb = r2(t.bid * (d.dir === 'down' ? 1 - d.pct / 100 : 1 + d.pct / 100));
            if (d.dir === 'down') nb = Math.max(nb, floor); else if (valid(o.maxBid) && o.maxBid > 0) nb = Math.min(nb, Math.max(o.maxBid, t.bid));
            nb = r2(nb);
            if (d.dir === 'down' && nb >= t.bid) res.why = t.bid <= floor ? 'At the minimum bid' : 'Rounds to the same bid';
            else if (d.dir === 'up' && nb <= t.bid) res.why = valid(o.maxBid) && t.bid >= o.maxBid ? 'At the maximum bid' : 'Rounds to the same bid';
            else { res.status = 'change'; res.newBid = nb; res.pct = r2((nb / t.bid - 1) * 100); res.rule = d.rule; res.why = d.rule; }
          }
        }
        results.push(res); plan[key].set(t.ri, res);
      });
    });
    // Bleeding Product Pages placements (only when an action is chosen): a lower adjustment and/or target bids under the Product Pages CPC
    const pp = o.pp && o.pp.action && o.pp.action !== 'none' ? ppConfig(o.pp, o.rpcStatus) : null;
    if (pp) {
      ppAnalysis(model, pp, bench, o.products).rows.filter(f => f.bleeding && !excludeReason(f.name, on, words)).forEach(f => {
        const key = f.p, p = model.products[key], floor = valid(o.floors[key]) ? o.floors[key] : p.floor, pl = ppPlan(f, pp, floor);
        if (pl.placement !== null) {
          const t = { campName: f.name, campId: f.cid, text: 'Product Pages placement', match: '', managed: false, vcpm: false, clicks: f.clicks, spend: f.spend, sales: f.sales, orders: f.orders, imp: f.imp, cpc: f.cpc, rpc: f.clicks ? f.sales / f.clicks : null, roas: f.spend ? f.sales / f.spend : null, acos: f.acos, bid: null, bidFromGroup: false, active: true };
          const res = { p: key, ri: f.ri, t, kind: 'placement', status: 'change', oldBid: null, newBid: null, oldPct: f.pct, newPct: pl.placement, pct: r2((pl.placement / f.pct - 1) * 100), rule: 'Bleeding Product Pages: lower the placement adjustment', ruleKey: 'pp-place', why: f.reason };
          results.push(res); plan[key].set(f.ri, res);
        }
        if (pl.bid !== null) p.targets.forEach(t => {
          if (!t.active || t.campId !== f.cid) return; const res = plan[key].get(t.ri); if (!res || res.kind === 'placement' || /^Skipped/.test(res.why) || t.bid === null) return;
          if (pp.spare) { const s = rpcStatus(t, benchFor(bench, key, scope), o.rpcStatus); if (s && s.tone === 'green') return; }   // a target that does well is left alone
          const cur = res.status === 'change' ? res.newBid : t.bid; if (!(pl.bid < cur) || !(pl.bid < t.bid)) return;   // only when it really lowers the current bid
          res.status = 'change'; res.newBid = pl.bid; res.pct = r2((pl.bid / t.bid - 1) * 100); res.ruleKey = 'pp-bid';
          res.rule = pp.bidMode === 'manual' ? 'Bleeding Product Pages: bid set to $' + pl.bid.toFixed(2) : 'Bleeding Product Pages: bid under the Product Pages CPC ($' + f.cpc.toFixed(2) + ')'; res.why = res.rule;
        });
      });
    }
    return { results, plan, summary: summarize(results) };
  }

  function summarize(results) {
    const s = { total: 0, changed: 0, up: 0, down: 0, placements: 0, ppBids: 0, byRule: {}, byProduct: {}, unchanged: {} };
    results.forEach(r => {
      if (r.kind === 'placement') { s.placements++; s.byRule[r.rule] = (s.byRule[r.rule] || 0) + 1; return; }   // Product Pages placement changes are counted apart from targets
      s.total++;
      const bp = s.byProduct[r.p] || (s.byProduct[r.p] = { total: 0, changed: 0 }); bp.total++;
      if (r.status === 'change') { s.changed++; bp.changed++; if (r.ruleKey === 'pp-bid') s.ppBids++; if (r.newBid > r.oldBid) s.up++; else s.down++; s.byRule[r.rule] = (s.byRule[r.rule] || 0) + 1; }
      else s.unchanged[r.why] = (s.unchanged[r.why] || 0) + 1;
    });
    return s;
  }

  // The upload file: the original row of every changed target with Operation = Update and the new Bid. Only these rows, in the original column order.
  const isProductPages = res => res.kind === 'placement' || res.ruleKey === 'pp-bid';
  // o.part: 'main' (the rule-based changes) or 'pp' (the Product Pages ones: placement rows and the target bids they lowered); each change is in exactly one of them.
  // o.withExtras: add the reference columns (New Bid ... ABP %) at the END of every row. A changed Product Pages placement is the original
  // "Bidding Adjustment" row with the new Percentage.
  function uploadOutput(p, plan, selected, o) {
    const rows = [], oi = p.col.Operation, bi = p.col.Bid, pi = p.col.Percentage, ex = o && o.withExtras ? makeExtras(p, o, plan) : null, header = ex ? p.header.concat(EXTRA.map(n => (p.header.includes(n) ? n + ' (reference)' : n))) : p.header;   // a name the sheet already has (Start Date, Bidding Strategy) is marked, so no header appears twice
    if (oi === undefined || bi === undefined) return { header, rows };
    plan.forEach((res, ri) => {
      if (res.status !== 'change' || (selected && !selected(res))) return;
      const isPP = isProductPages(res); if ((o && o.part === 'main' && isPP) || (o && o.part === 'pp' && !isPP)) return;
      const r = p.rows[ri].slice(); r[oi] = 'Update';
      if (res.kind === 'placement') { if (pi === undefined) return; r[pi] = res.newPct; } else r[bi] = res.newBid;
      rows.push(ex ? r.concat(ex(ri)) : r);
    });
    return { header, rows };
  }

  // A small synthetic workbook (made-up numbers) for "Try with sample data" and the smoke test.
  function sampleSheets() {
    const mk = (cols, objs) => [cols].concat(objs.map(o => cols.map(c => (c in o ? o[c] : ''))));
    const T = (product, entity, o) => Object.assign({ Product: product, Entity: entity }, o);
    const spc = ['Product', 'Entity', 'Operation', 'Campaign ID', 'Ad Group ID', 'Keyword ID', 'Product Targeting ID', 'Campaign Name (Informational only)', 'Start Date', 'State', 'Campaign State (Informational only)', 'Ad Group State (Informational only)', 'Ad Group Default Bid', 'Bid', 'Keyword Text', 'Match Type', 'Bidding Strategy', 'Product Targeting Expression', 'Impressions', 'Clicks', 'Spend', 'Sales', 'Orders', 'ACOS', 'CPC', 'ROAS', 'Placement', 'Percentage'];
    const SP = 'Sponsored Products', k = (id, text, bid, m, o) => T(SP, 'Keyword', Object.assign({ 'Campaign ID': 'c1', 'Ad Group ID': 'g1', 'Keyword ID': id, 'Campaign Name (Informational only)': 'SP-Exact-Sample-Widgets', State: 'enabled', 'Campaign State (Informational only)': 'enabled', 'Ad Group State (Informational only)': 'enabled', Bid: bid, 'Keyword Text': text, 'Match Type': 'Exact', Impressions: m[0], Clicks: m[1], Spend: m[2], Sales: m[3], Orders: m[4] }, o || {}));
    const sp = mk(spc, [
      T(SP, 'Campaign', { 'Campaign ID': 'c1', 'Campaign Name (Informational only)': 'SP-Exact-Sample-Widgets', 'Start Date': '20260105', State: 'enabled', 'Bidding Strategy': 'Dynamic bids - down only', Impressions: 40000, Clicks: 300, Spend: 210, Sales: 700, Orders: 30 }),
      T(SP, 'Campaign', { 'Campaign ID': 'c2', 'Campaign Name (Informational only)': 'SP-Exact-Sample-Rank', 'Start Date': '20260210', State: 'enabled', 'Bidding Strategy': 'Fixed bid', Impressions: 3000, Clicks: 40, Spend: 50, Sales: 0, Orders: 0 }),
      T(SP, 'Bidding Adjustment', { 'Campaign ID': 'c1', 'Campaign State (Informational only)': 'enabled', Placement: 'Placement Top', Percentage: '50.0' }), T(SP, 'Bidding Adjustment', { 'Campaign ID': 'c1', 'Campaign State (Informational only)': 'enabled', Placement: 'Placement Rest Of Search', Percentage: '0.0' }),
      T(SP, 'Bidding Adjustment', { 'Campaign ID': 'c1', 'Campaign State (Informational only)': 'enabled', Placement: 'Placement Product Page', Percentage: '20.0', Impressions: 5000, Clicks: 40, Spend: 60, Sales: 0, Orders: 0 }), T(SP, 'Bidding Adjustment', { 'Campaign ID': 'c1', 'Campaign State (Informational only)': 'enabled', Placement: 'Placement Amazon Business', Percentage: '0.0' }),
      T(SP, 'Ad Group', { 'Campaign ID': 'c1', 'Ad Group ID': 'g1', State: 'enabled', 'Campaign State (Informational only)': 'enabled', 'Ad Group Default Bid': 0.5, Impressions: 40000, Clicks: 300, Spend: 210, Sales: 700, Orders: 30 }),
      T(SP, 'Ad Group', { 'Campaign ID': 'c2', 'Ad Group ID': 'g2', State: 'enabled', 'Campaign State (Informational only)': 'enabled', 'Ad Group Default Bid': 0.5, Impressions: 3000, Clicks: 40, Spend: 50, Sales: 0, Orders: 0 }),
      k('k1', 'blue widget', 1.2, [9000, 80, 96, 90, 3]), k('k2', 'widget set', 0.9, [8000, 70, 40, 280, 9]), k('k3', 'cheap widget', 0.8, [6000, 50, 45, 120, 4]),
      k('k4', 'widget organizer', 1.0, [5000, 45, 35, 0, 0]), k('k5', 'widget box', 0.6, [2500, 20, 12, 0, 0]), k('k6', 'red widget', 0.7, [300, 1, 0.5, 0, 0]),
      k('k7', 'widget stand', 0.5, [90, 0, 0, 0, 0]), k('k8', 'old widget', 0.9, [400, 5, 3, 0, 0], { State: 'paused' }),
      T(SP, 'Product Targeting', { 'Campaign ID': 'c1', 'Ad Group ID': 'g1', 'Product Targeting ID': 'p1', 'Campaign Name (Informational only)': 'SP-Exact-Sample-Widgets', State: 'enabled', 'Campaign State (Informational only)': 'enabled', 'Ad Group State (Informational only)': 'enabled', Bid: 0.45, 'Product Targeting Expression': 'close-match', Impressions: 7000, Clicks: 60, Spend: 24, Sales: 130, Orders: 5 }),
      k('k9', 'rank widget', 1.5, [3000, 40, 50, 0, 0], { 'Campaign ID': 'c2', 'Ad Group ID': 'g2', 'Campaign Name (Informational only)': 'SP-Exact-Sample-Rank' })]);
    const sbc = ['Product', 'Entity', 'Operation', 'Campaign ID', 'Ad Group ID', 'Keyword ID', 'Campaign Name (Informational only)', 'Start Date', 'State', 'Campaign State (Informational only)', 'Bid Optimization', 'Bid', 'Keyword Text', 'Match Type', 'Impressions', 'Clicks', 'Spend', 'Sales', 'Orders'], SB = 'Sponsored Brands';
    const sb = mk(sbc, [T(SB, 'Campaign', { 'Campaign ID': 's1', 'Campaign Name (Informational only)': 'SB-Headline-Sample', 'Start Date': '20250918', State: 'enabled', 'Bid Optimization': 'Manual' }),
      T(SB, 'Ad Group (Read Only)', { 'Campaign ID': 's1', 'Ad Group ID': 'sg1', 'Campaign State (Informational only)': 'enabled' }),
      T(SB, 'Keyword', { 'Campaign ID': 's1', 'Ad Group ID': 'sg1', 'Keyword ID': 'sk1', 'Campaign Name (Informational only)': 'SB-Headline-Sample', State: 'enabled', 'Campaign State (Informational only)': 'enabled', Bid: 1.4, 'Keyword Text': 'widget brand', 'Match Type': 'Phrase', Impressions: 4000, Clicks: 35, Spend: 49, Sales: 60, Orders: 2 })]);
    const sdc = ['Product', 'Entity', 'Operation', 'Campaign ID', 'Ad Group ID', 'Targeting ID', 'Campaign Name (Informational only)', 'Start Date', 'State', 'Campaign State (Informational only)', 'Ad Group State (Informational only)', 'Ad Group Default Bid', 'Bid', 'Bid Optimization', 'Cost Type', 'Targeting Expression', 'Impressions', 'Clicks', 'Spend', 'Sales', 'Orders'], SD = 'Sponsored Display';
    const sd = mk(sdc, [T(SD, 'Campaign', { 'Campaign ID': 'd1', 'Campaign Name (Informational only)': 'SD-Sample-Category', 'Start Date': '20240117', State: 'enabled', 'Cost Type': 'cpc' }),
      T(SD, 'Ad Group', { 'Campaign ID': 'd1', 'Ad Group ID': 'dg1', State: 'enabled', 'Bid Optimization': 'Optimize for conversions', 'Ad Group Default Bid': 0.2 }),
      T(SD, 'Contextual Targeting', { 'Campaign ID': 'd1', 'Ad Group ID': 'dg1', 'Targeting ID': 'dt1', 'Campaign Name (Informational only)': 'SD-Sample-Category', State: 'enabled', 'Campaign State (Informational only)': 'enabled', 'Ad Group State (Informational only)': 'enabled', Bid: 1.0, 'Targeting Expression': 'category="123"', Impressions: 1200, Clicks: 22, Spend: 18, Sales: 0, Orders: 0 })]);
    return { 'Sponsored Products Campaigns': sp, 'Sponsored Brands Campaigns': sb, 'Sponsored Display Campaigns': sd };
  }

  const api = { isProductPages, ppConfig, ppAnalysis, ppPlan, KINDS, excludeReason, campaignCounts, setRpcBasis, benchmarks, benchFor, rpcStatus, statusText, sanitizeRules, rpcCheck, rpcStats, placementKey, sampleSheets, PRODUCTS, ORDER, EXTRA, EXTRA_REVIEW, buildModel, sheetOutput, defaultRules, convertMetric, rulesFor, decide, optimize, uploadOutput, metrics, num, r2, METRIC_LABEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OPT = api;
})(typeof window !== 'undefined' ? window : globalThis);

// ====================================================================== UI (browser only)
if (typeof document !== 'undefined') (function () {
  'use strict';
  const O = window.OPT, $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = v => (v === '' || v == null ? '–' : '$' + Number(v).toFixed(2));
  const st = { ppOnly: false, upExtras: true, ppAn: null, ppAll: false, profile: '', model: null, name: '', rules: null, edit: 'shared', res: null, sel: new Set(), opts: null, view: { product: '', rule: '', show: 'changes', page: 0 } };
  const PAGE = 100, PROFILES = 'ppcb_optimizer_profiles', LAST = 'ppcb_optimizer_profile_last';

  // ---- file
  const fileIn = $('opFile');
  makeDropTarget($('opZone'), fileIn);
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0]; if (!f) return;
    $('opName').textContent = f.name + ' — reading…'; await new Promise(r => setTimeout(r, 30));
    try { load(readWorkbook(await readBuf(f)), f.name); $('opName').textContent = f.name; }
    catch (e) { $('opName').textContent = ''; toast(esc(e.message), 'error'); }
  });
  const readBuf = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(f); });
  function readWorkbook(buf) {
    const u8 = new Uint8Array(buf), names = XLSX.read(u8, { type: 'array', bookSheets: true }).SheetNames;
    const want = names.filter(n => O.ORDER.some(k => O.PRODUCTS[k].sheet.test(n.trim())));
    if (!want.length) throw new Error('No Sponsored Products, Sponsored Brands, SB Multi Ad Group or Sponsored Display campaign sheet found. Download the unified bulk workbook from Campaign Manager.');
    const wb = XLSX.read(u8, { type: 'array', sheets: want }), out = {};
    want.forEach(n => {
      const ws = wb.Sheets[n]; let r = 0, c = 0;
      // Amazon declares these sheets one row tall (A1) although the cells are there: widen the range to the real used range
      for (const k in ws) { if (k.charCodeAt(0) === 33) continue; const a = XLSX.utils.decode_cell(k); if (a.r > r) r = a.r; if (a.c > c) c = a.c; }
      ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r, c } });
      out[n] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    });
    return out;
  }
  window.opSample = function () { fileIn.value = ''; load(O.sampleSheets(), 'sample-workbook.xlsx'); $('opName').textContent = 'Synthetic sample data (not real numbers)'; toast('Loaded synthetic sample data.', 'success'); };

  function load(sheets, name) {
    const m = O.buildModel(sheets);
    if (!m.order.length) throw new Error('Those sheets have no rows I can read (the Entity and Campaign ID columns are needed).');
    st.model = m; st.name = name.replace(/\.xlsx?$/i, ''); st.rules = { mode: 'shared', shared: O.defaultRules() }; st.edit = 'shared'; st.res = null; st.sel = new Set();
    $('opWork').classList.remove('hidden'); $('opOut').innerHTML = '';
    renderSummary(); renderOptions(); renderPP(); renderRules(); autoProfile(); lucide.createIcons();
  }

  // ---- what was found
  function renderSummary() {
    const rows = st.model.order.map(k => {
      const p = st.model.products[k], act = p.targets.filter(t => t.active), campAct = p.rows.filter((r, i) => p.kinds[i] === 'campaign' && p.active[i]).length, camps = p.rows.filter((r, i) => p.kinds[i] === 'campaign').length;
      return '<tr class="border-t border-slate-100"><th scope="row" class="px-3 py-2 text-left font-semibold text-slate-800 whitespace-nowrap">' + esc(p.label) + '</th><td class="px-3 py-2 text-right tabular-nums">' + campAct + ' / ' + camps + '</td><td class="px-3 py-2 text-right tabular-nums">' + act.length + ' / ' + p.targets.length + '</td>'
        + '<td class="px-3 py-2 text-right tabular-nums">' + act.filter(t => t.bid === null).length + '</td><td class="px-3 py-2 text-right tabular-nums">' + act.filter(t => t.managed).length + '</td>' + ['rank', 'catchall', 'lowbid'].map(k => '<td class="px-3 py-2 text-right tabular-nums">' + act.filter(t => O.KINDS[k].rx.test(t.campName)).length + '</td>').join('') + '</tr>';
    }).join('');
    $('opSummary').innerHTML = '<table class="w-full text-xs"><thead><tr class="bg-slate-50 text-slate-500 text-[10px] font-bold uppercase tracking-wider"><th scope="col" class="px-3 py-2 text-left">Ad type</th><th scope="col" class="px-3 py-2 text-right">Active campaigns</th><th scope="col" class="px-3 py-2 text-right" title="Targets whose campaign, ad group and own state are all enabled">Active targets</th><th scope="col" class="px-3 py-2 text-right" title="No bid on the row: the ad group default bid is used">No bid</th><th scope="col" class="px-3 py-2 text-right" title="Amazon already adjusts bids in these campaigns">Amazon-managed</th><th scope="col" class="px-3 py-2 text-right" title="Active targets in campaigns with Rank in the name">Ranking</th><th scope="col" class="px-3 py-2 text-right" title="Active targets in campaigns with Catch All in the name">Catch-all</th><th scope="col" class="px-3 py-2 text-right" title="Active targets in campaigns with Low Bid in the name">Low bid</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // ---- options
  // ---- RPC status settings (in Options) and the account benchmark they use
  const numIn = (id, label, val, tip, ph) => '<div><label for="' + id + '" class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5" title="' + esc(tip) + '">' + label + '</label><input id="' + id + '" type="number" min="0" step="any" ' + (val !== '' ? 'value="' + val + '" ' : '') + (ph ? 'placeholder="' + ph + '" ' : '') + 'class="border border-slate-300 bg-white p-2 rounded-lg text-sm w-28 outline-none focus:ring-1 focus:ring-blue-500"></div>';
  const statusBlock = () => '<details open class="mt-5 pt-4 border-t border-slate-100"><summary class="cursor-pointer text-xs font-bold text-slate-700 select-none">RPC status: <span class="text-emerald-700">green</span>, <span class="text-amber-700">yellow</span>, <span class="text-rose-700">red</span> and grey, against this account\'s own performance</summary><div class="mt-3 flex flex-wrap gap-3 items-end">'
    + numIn('opTargetAcos', 'Target ACOS %', '', 'Your target ACOS. Blank = the account\'s own ACOS', 'auto')
    + '<div><label for="opScope" class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5" title="Compare each target with its own ad type, or with the whole account">Benchmark</label><select id="opScope" class="border border-slate-300 bg-white p-2 rounded-lg text-sm font-medium outline-none focus:ring-1 focus:ring-blue-500"><option value="product">Per ad type</option><option value="account">Whole account</option></select></div>'
    + numIn('opMinClicks', 'Min. clicks to judge', '10', 'Fewer clicks than this is grey: not enough data') + numIn('opBleed', 'Bleeding: spend from $', '', 'No orders and at least this much spend = bleeding. Blank = the average spend per target', 'auto')
    + numIn('opGreenAt', 'Green from % of benchmark', '100', 'RPC as a % of the benchmark RPC') + numIn('opYellowAt', 'Yellow from % of benchmark', '70', 'Below this share of the benchmark RPC it is red') + numIn('opSlack', 'Red above % of target ACOS', '125', 'ACOS above this share of the target ACOS is red')
    + '</div><div id="opBench" class="text-xs text-slate-600 mt-3 leading-relaxed" aria-live="polite"></div>'
    + '<p class="text-[11px] text-slate-500 mt-2 leading-relaxed"><b class="text-emerald-700">Green</b>: RPC at or above the benchmark and ACOS within the target. <b class="text-amber-700">Yellow</b>: RPC a little below the benchmark, or ACOS a little above the target. <b class="text-rose-700">Red</b>: RPC well below, ACOS far above the target, or <b>bleeding</b> (no orders and spend at or above the bleed level). <b>Grey</b>: too few clicks to judge. The benchmark is the account\'s total sales / total clicks over its active targets.</p></details>';
  const readStatus = () => {
    const n = (id, d, min) => { const v = parseFloat($(id).value); return isFinite(v) && v >= (min || 0) ? v : d; }, ta = parseFloat($('opTargetAcos').value), bl = parseFloat($('opBleed').value);
    return { targetAcos: ta > 0 ? ta : null, scope: $('opScope').value === 'account' ? 'account' : 'product', minClicks: n('opMinClicks', 10), bleed: bl > 0 ? bl : null, greenAt: n('opGreenAt', 100, 1), yellowAt: n('opYellowAt', 70), slack: n('opSlack', 125, 1) };
  };
  function renderBench() {
    const el = $('opBench'); if (!el || !st.model) return;
    const o = readOpts(), bm = O.benchmarks(st.model, o.products), c = o.rpcStatus, f = v => (v == null ? '–' : '$' + v.toFixed(2)), pc = v => (v == null ? '–' : (v * 100).toFixed(1) + '%');
    const line = (name, b) => '<span class="whitespace-nowrap">' + (name ? '<b>' + esc(name) + '</b> ' : '') + 'RPC ' + f(b.rpc) + ' · ACOS ' + pc(b.acos) + ' · avg spend ' + f(b.spend) + '</span>';
    el.innerHTML = 'Benchmark (' + (c.scope === 'account' ? 'whole account' : 'per ad type') + '): ' + (c.scope === 'account' ? line('', bm.account) : o.products.filter(k => bm.product[k]).map(k => line(O.PRODUCTS[k].short, bm.product[k])).join(' &nbsp;|&nbsp; '))
      + '. Target ACOS: <b>' + (c.targetAcos ? c.targetAcos + '% (yours)' : 'auto, the account\'s own ACOS') + '</b>.';
  }
  $('opOptions').addEventListener('change', renderBench);

  function renderOptions() {
    const prods = st.model.order.map(k => { const p = st.model.products[k]; return '<label class="flex items-center gap-2 text-sm text-slate-700 cursor-pointer"><input type="checkbox" data-prod="' + k + '" checked class="rounded border-slate-300">' + esc(p.label) + '</label>'; }).join('');
    const floors = st.model.order.map(k => { const p = st.model.products[k]; return '<div><label for="opFloor_' + k + '" class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Min. bid, ' + esc(p.short) + '</label><input id="opFloor_' + k + '" type="number" min="0" step="0.01" value="' + p.floor + '" class="border border-slate-300 bg-white p-2 rounded-lg text-sm w-24 outline-none focus:ring-1 focus:ring-blue-500"></div>'; }).join('');
    const chk = (id, on, text, tip) => '<label class="flex items-start gap-2 text-sm text-slate-700 cursor-pointer" title="' + esc(tip || '') + '"><input type="checkbox" id="' + id + '" ' + (on ? 'checked ' : '') + 'class="rounded border-slate-300 mt-0.5"><span>' + text + '</span></label>';
    // Campaigns to leave out: only the kinds that really are in this file are offered, with how many
    const cc = O.campaignCounts(st.model), plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    const exclHtml = [['rank', 'opSkipRank', 'ranking', true, 'Ranking campaigns bid high on purpose'], ['catchall', 'opSkipCatchAll', 'catch-all', false, 'Campaigns with "Catch All" in the name'], ['lowbid', 'opSkipLowBid', 'low-bid', false, 'Campaigns with "Low Bid" in the name']]
      .filter(([k]) => cc[k].campaigns > 0).map(([k, id, label, on, tip]) => chk(id, on, 'Exclude ' + label + ' campaigns <span class="text-slate-500">(' + plural(cc[k].campaigns, 'campaign') + ', ' + plural(cc[k].targets, 'active target') + ')</span>', tip + '. They are left out of the sorted and review files and are not optimized.')).join('');
    $('opOptions').innerHTML = '<div class="grid grid-cols-1 lg:grid-cols-3 gap-5">'
      + '<div><p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Ad types</p><div class="space-y-1.5">' + prods + '</div></div>'
      + '<div class="space-y-2"><p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Rows</p>'
      + exclHtml
      + chk('opSkipManaged', false, 'Optimize: skip campaigns where Amazon adjusts bids', 'Sponsored Brands "Auto", SB Multi Ad Group optimization on, Sponsored Display "Optimize for…"') + '</div>'
      + '<div><p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Limits</p><div class="flex flex-wrap gap-3">' + floors
      + '<div><label for="opMax" class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Max. bid (optional)</label><input id="opMax" type="number" min="0" step="0.01" placeholder="none" class="border border-slate-300 bg-white p-2 rounded-lg text-sm w-24 outline-none focus:ring-1 focus:ring-blue-500"></div>' + '<div><label for="opRpcHi" class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5" title="Bid as a share of what an average click earns (RPC)">RPC check: too high above %</label><input id="opRpcHi" type="number" min="1" step="1" value="50" class="border border-slate-300 bg-white p-2 rounded-lg text-sm w-24 outline-none focus:ring-1 focus:ring-blue-500"></div><div><label for="opRpcLo" class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5" title="Bid as a share of what an average click earns (RPC)">RPC check: too low below %</label><input id="opRpcLo" type="number" min="0" step="1" value="10" class="border border-slate-300 bg-white p-2 rounded-lg text-sm w-24 outline-none focus:ring-1 focus:ring-blue-500"></div></div>'
      + '<div class="mt-3"><label for="opWords" class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Skip campaigns with these words (comma separated)</label><input id="opWords" type="text" placeholder="e.g. defense, brand" class="border border-slate-300 bg-white p-2 rounded-lg text-sm w-full outline-none focus:ring-1 focus:ring-blue-500"></div></div></div>';
    $('opOptions').insertAdjacentHTML('beforeend', statusBlock()); renderBench();
  }
  function readOpts() {
    const floors = {}, products = [], ck = id => { const e = $(id); return !!(e && e.checked); };
    st.model.order.forEach(k => { const el = document.querySelector('[data-prod="' + k + '"]'); if (el && el.checked) products.push(k); const v = parseFloat($('opFloor_' + k).value); if (isFinite(v) && v >= 0) floors[k] = v; });
    const mx = parseFloat($('opMax').value);
    return { products, skipRank: ck('opSkipRank'), skipCatchAll: ck('opSkipCatchAll'), skipLowBid: ck('opSkipLowBid'), skipManaged: $('opSkipManaged').checked, skipWords: $('opWords').value.split(',').map(s => s.trim()).filter(Boolean), floors, maxBid: isFinite(mx) && mx > 0 ? mx : null,
      rpcCheck: { high: parseFloat($('opRpcHi').value) > 0 ? parseFloat($('opRpcHi').value) : 50, low: parseFloat($('opRpcLo').value) >= 0 ? parseFloat($('opRpcLo').value) : 10 }, rpcStatus: readStatus(), pp: readPP() };
  }

  // ---- Product Pages placements: find the campaigns that bleed there, and (optionally) fix them inside Optimize
  const PPDEF = { minClicks: 10, bleedSpend: null, acosLimit: null, action: 'none', placeMode: 'rec', cut: 50, placeManual: null, bidMode: 'rec', margin: 10, bidManual: null, spare: true };
  function renderPP() {
    const has = st.model.order.some(k => st.model.products[k].pp.size > 0), card = $('opPPCard'); card.classList.toggle('hidden', !has); st.ppAn = null;
    if (!has) { $('opPP').innerHTML = ''; return; }
    const radio = (v, label, tip) => '<label class="flex items-start gap-2 text-sm text-slate-700 cursor-pointer" title="' + esc(tip) + '"><input type="radio" name="opPPAction" value="' + v + '" ' + (v === 'none' ? 'checked ' : '') + 'class="mt-0.5"><span>' + label + '</span></label>';
    const sel = (id, a, b) => '<select id="' + id + '" class="border border-slate-300 bg-white p-2 rounded-lg text-sm font-medium outline-none focus:ring-1 focus:ring-blue-500"><option value="rec">' + a + '</option><option value="manual">' + b + '</option></select>';
    $('opPP').innerHTML = '<p class="text-xs text-slate-600 mb-4 leading-relaxed">The file has the clicks, spend and sales of each campaign\'s <b>Product Pages</b> placement. A campaign <b>bleeds</b> there when it spends with no sales, or when the placement\'s ACOS is above the limit (and always above 100%).</p>'
      + '<div class="grid grid-cols-1 lg:grid-cols-3 gap-5"><div><p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Bleeding when</p><div class="flex flex-wrap gap-3">'
      + numIn('opPPMinClicks', 'Min. clicks to judge an ACOS', '10', 'Fewer Product Pages clicks than this: the ACOS is not judged (no sales with a big spend still counts)')
      + numIn('opPPBleed', 'No sales: spend from $', '', 'Product Pages spend with no sales from this amount. Blank = the average Product Pages spend per campaign', 'auto')
      + numIn('opPPAcos', 'ACOS above %', '', 'Blank = your target ACOS (or the account ACOS) times the slack set under RPC status', 'auto') + '</div></div>'
      + '<div><p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">What to do about it</p><div class="space-y-1.5">'
      + radio('none', 'Only identify them', 'Nothing is changed') + radio('placement', 'Lower the Product Pages adjustment', 'Lowers the placement bid adjustment %') + radio('bids', 'Lower the target bids under the Product Pages CPC', 'Sets the targets\' bids below what a Product Pages click costs')
      + radio('both', 'Both', 'The adjustment and the bids') + '</div></div>'
      + '<div class="space-y-3"><div><p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Product Pages adjustment</p><div class="flex flex-wrap items-end gap-3">' + sel('opPPPlaceMode', 'Recommendation', 'My own value') + numIn('opPPCut', 'Remove % of it', '50', 'Recommendation: this share of the current adjustment is removed (80% with 50 becomes 40%)') + numIn('opPPPlaceManual', 'New adjustment %', '', 'My own value: the adjustment to set (0 to 900)') + '</div></div>'
      + '<div><p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Target bid</p><div class="flex flex-wrap items-end gap-3">' + sel('opPPBidMode', 'Recommendation', 'My own bid') + numIn('opPPMargin', '% under the CPC', '10', 'Recommendation: the bid is this much under the Product Pages CPC') + numIn('opPPBidManual', 'Desired bid $', '', 'My own bid, applied to the targets above it') + '</div></div>'
      + '<label class="flex items-start gap-2 text-sm text-slate-700 cursor-pointer"><input type="checkbox" id="opPPSpare" checked class="rounded border-slate-300 mt-0.5"><span>Leave targets with a green RPC status alone</span></label></div></div>'
      + '<p class="text-[11px] text-slate-500 mt-3 leading-relaxed">Lowering target bids lowers them on every placement of the campaign, not only Product Pages, and only ever lowers (a bid already under the new one is left as it is). When you choose an action, these changes are added when you click <b>Optimize</b>, or run alone with <b>Run Product Pages only</b>. You can untick any of them in the preview. They go in their own <b>Product Pages upload file</b> (the placement change as the original Bidding Adjustment row with the new Percentage), never in the main one.</p>'
      + '<div class="flex flex-wrap items-center gap-2 mt-4"><button type="button" onclick="opPPFind()" class="border border-slate-300 hover:bg-slate-50 text-slate-800 font-bold px-4 py-2 rounded-xl text-sm">Find bleeding Product Pages</button><button type="button" onclick="opPPRun()" class="btn-ink bg-slate-800 hover:bg-slate-700 text-white font-bold px-4 py-2 rounded-xl shadow-sm text-sm" title="Applies only the Product Pages action above: no rules">Run Product Pages only</button></div><div id="opPPOut" class="mt-4"></div>';
  }
  const readPP = () => {
    if (!$('opPPMinClicks')) return Object.assign({}, PPDEF);
    const n = id => { const v = parseFloat($(id).value); return isFinite(v) && v >= 0 ? v : null; }, act = document.querySelector('input[name="opPPAction"]:checked');
    return { minClicks: n('opPPMinClicks') === null ? 10 : n('opPPMinClicks'), bleedSpend: n('opPPBleed') > 0 ? n('opPPBleed') : null, acosLimit: n('opPPAcos') > 0 ? n('opPPAcos') : null, action: act ? act.value : 'none',
      placeMode: $('opPPPlaceMode').value === 'manual' ? 'manual' : 'rec', cut: n('opPPCut') === null ? 50 : Math.min(100, n('opPPCut')), placeManual: n('opPPPlaceManual') === null ? null : Math.min(900, n('opPPPlaceManual')),
      bidMode: $('opPPBidMode').value === 'manual' ? 'manual' : 'rec', margin: n('opPPMargin') === null ? 10 : Math.min(100, n('opPPMargin')), bidManual: n('opPPBidManual') > 0 ? n('opPPBidManual') : null, spare: $('opPPSpare').checked };
  };
  function applyPP(p) {
    if (!$('opPPMinClicks')) return; p = Object.assign({}, PPDEF, p);
    const set = (id, v) => { $(id).value = v == null ? '' : v; };
    set('opPPMinClicks', p.minClicks); set('opPPBleed', p.bleedSpend); set('opPPAcos', p.acosLimit); set('opPPCut', p.cut); set('opPPPlaceManual', p.placeManual); set('opPPMargin', p.margin); set('opPPBidManual', p.bidManual);
    $('opPPPlaceMode').value = p.placeMode === 'manual' ? 'manual' : 'rec'; $('opPPBidMode').value = p.bidMode === 'manual' ? 'manual' : 'rec'; $('opPPSpare').checked = p.spare !== false;
    const r = document.querySelector('input[name="opPPAction"][value="' + (['placement', 'bids', 'both'].includes(p.action) ? p.action : 'none') + '"]'); if (r) r.checked = true;
  }
  function cleanPP(x) {
    x = x && typeof x === 'object' ? x : {}; const pos = v => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : null);
    return { minClicks: pos(x.minClicks) !== null ? x.minClicks : 10, bleedSpend: pos(x.bleedSpend) > 0 ? x.bleedSpend : null, acosLimit: pos(x.acosLimit) > 0 ? x.acosLimit : null, action: ['none', 'placement', 'bids', 'both'].includes(x.action) ? x.action : 'none',
      placeMode: x.placeMode === 'manual' ? 'manual' : 'rec', cut: pos(x.cut) !== null ? Math.min(100, x.cut) : 50, placeManual: pos(x.placeManual) !== null ? Math.min(900, x.placeManual) : null, bidMode: x.bidMode === 'manual' ? 'manual' : 'rec',
      margin: pos(x.margin) !== null ? Math.min(100, x.margin) : 10, bidManual: pos(x.bidManual) > 0 ? x.bidManual : null, spare: x.spare !== false };
  }
  // what the settings would do to one bleeding campaign
  function ppPlanText(f, cfg, o) {
    if (cfg.action === 'none') return '<span class="text-slate-400">Identify only</span>';
    const p = st.model.products[f.p], floor = typeof o.floors[f.p] === 'number' ? o.floors[f.p] : p.floor, pl = O.ppPlan(f, cfg, floor), bits = [];
    if (pl.placement !== null) bits.push('Adjustment ' + f.pct + '% → <b>' + pl.placement + '%</b>');
    if (pl.bid !== null) { const n = p.targets.filter(t => t.active && t.campId === f.cid && t.bid !== null && t.bid > pl.bid).length; bits.push('Target bids to <b>' + money(pl.bid) + '</b> (' + n + ' target' + (n === 1 ? '' : 's') + ' above it)'); }
    pl.notes.forEach(x => bits.push('<span class="text-slate-500">' + esc(x) + '</span>'));
    return bits.join('<br>') || '–';
  }
  function ppRows() {
    const o = readOpts(), bench = O.benchmarks(st.model, o.products), cfg = O.ppConfig(o.pp, o.rpcStatus), on = { rank: o.skipRank, catchall: o.skipCatchAll, lowbid: o.skipLowBid }, words = o.skipWords.map(s => s.toLowerCase());
    const an = O.ppAnalysis(st.model, cfg, bench, o.products); an.rows = an.rows.filter(f => !O.excludeReason(f.name, on, words)); return { an, cfg, o };
  }
  window.opPPFind = function () { if (!st.model) return; st.ppAn = ppRows(); st.ppAll = false; renderPPOut(); };
  window.opPPAll = on => { st.ppAll = on; renderPPOut(); };
  function renderPPOut() {
    const { an, cfg, o } = st.ppAn, out = $('opPPOut'), bleeding = an.rows.filter(f => f.bleeding), list = st.ppAll ? an.rows : bleeding, spend = bleeding.reduce((a, f) => a + f.spend, 0), pc = v => (v == null ? '–' : Math.round(v * 100) + '%');
    if (!an.rows.length) { out.innerHTML = '<p class="text-xs text-slate-600">No active campaign has Product Pages data.</p>'; return; }
    const body = list.map(f => '<tr class="border-t border-slate-100 align-top"><td class="px-3 py-2 text-slate-500 whitespace-nowrap">' + esc(O.PRODUCTS[f.p].short) + '</td><td class="px-3 py-2 max-w-[16rem] break-words text-slate-800 font-semibold">' + esc(f.name) + '</td>'
      + '<td class="px-3 py-2 text-right tabular-nums">' + money(f.spend) + '</td><td class="px-3 py-2 text-right tabular-nums">' + f.clicks + '</td><td class="px-3 py-2 text-right tabular-nums">' + (f.clicks ? money(f.cpc) : '–') + '</td><td class="px-3 py-2 text-right tabular-nums">' + money(f.sales) + '</td><td class="px-3 py-2 text-right tabular-nums">' + pc(f.acos) + '</td><td class="px-3 py-2 text-right tabular-nums">' + f.pct + '%</td>'
      + '<td class="px-3 py-2">' + (f.bleeding ? '<span class="inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase bg-rose-50 text-rose-800">Bleeding</span> <span class="text-slate-600">' + esc(f.reason) + '</span>' : '<span class="inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase bg-slate-100 text-slate-700">OK</span>') + '</td>'
      + '<td class="px-3 py-2 text-slate-700">' + (f.bleeding ? ppPlanText(f, cfg, o) : '') + '</td></tr>').join('');
    out.innerHTML = '<div class="flex flex-wrap items-baseline gap-x-6 gap-y-2 mb-2"><p class="text-sm font-extrabold text-slate-800">' + bleeding.length + ' of ' + an.rows.length + ' campaigns bleed on Product Pages <span class="font-medium text-slate-600">(' + money(spend) + ' spent there)</span></p>'
      + '<label class="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer ml-auto"><input type="checkbox" onchange="opPPAll(this.checked)" ' + (st.ppAll ? 'checked ' : '') + 'class="rounded border-slate-300"> Show the other campaigns too</label><button type="button" onclick="opPPDownload()" class="border border-slate-300 hover:bg-slate-50 text-slate-800 text-xs font-bold px-3 py-2 rounded-lg">Download list (.xlsx)</button></div>'
      + '<p class="text-[11px] text-slate-500 mb-2">Bleeding level: no sales and spend from ' + money(an.bleedSpend) + (an.acosLimit != null ? ' · ACOS above ' + Math.round(an.acosLimit) + '%' : '') + ' (and any ACOS above 100%), judged from ' + cfg.minClicks + '+ clicks.</p>'
      + (list.length ? '<div class="overflow-x-auto"><table class="w-full text-xs"><thead><tr class="bg-slate-50 text-slate-500 text-[10px] font-bold uppercase tracking-wider"><th scope="col" class="px-3 py-2 text-left">Type</th><th scope="col" class="px-3 py-2 text-left">Campaign</th><th scope="col" class="px-3 py-2 text-right">PP spend</th><th scope="col" class="px-3 py-2 text-right">PP clicks</th><th scope="col" class="px-3 py-2 text-right">PP CPC</th><th scope="col" class="px-3 py-2 text-right">PP sales</th><th scope="col" class="px-3 py-2 text-right">PP ACOS</th><th scope="col" class="px-3 py-2 text-right">Adjustment</th><th scope="col" class="px-3 py-2 text-left">Verdict</th><th scope="col" class="px-3 py-2 text-left">Plan</th></tr></thead><tbody>' + body + '</tbody></table></div>' : '<p class="text-xs text-slate-600">No campaign bleeds on Product Pages with these settings.</p>');
  }
  window.opPPDownload = function () {
    if (!st.ppAn) return; const { an, cfg, o } = st.ppAn, wb = XLSX.utils.book_new(), plan = f => { if (cfg.action === 'none' || !f.bleeding) return ['', '']; const p = O.ppPlan(f, cfg, st.model.products[f.p].floor); return [p.placement === null ? '' : p.placement, p.bid === null ? '' : p.bid]; };
    const aoa = [['Ad type', 'Campaign', 'Product Pages spend', 'Clicks', 'Orders', 'Sales', 'CPC', 'ACOS', 'Adjustment %', 'Bleeding', 'Why', 'Planned adjustment %', 'Planned target bid']].concat(an.rows.map(f => [O.PRODUCTS[f.p].label, f.name, f.spend, f.clicks, f.orders, f.sales, f.clicks ? f.cpc : '', f.acos === null ? '' : f.acos, f.pct, f.bleeding ? 'Yes' : 'No', f.reason].concat(plan(f))));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Product Pages'); XLSX.writeFile(wb, fileName('product-pages')); toast('Downloaded.', 'success');
  };

  // ---- download helpers
  const baseName = () => (st.name || 'bulk').slice(-60);
  // A downloaded file is named after the saved profile (or the bulk file when there is none), the date and what it is: Kezef_2026-11-10_Bulkupload.xlsx (the file to upload), _sorted, _review
  const safeName = s => String(s || '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-');
  const today = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); };
  const fileName = kind => (safeName(st.profile) || safeName(baseName()) || 'bulk') + '_' + today() + '_' + kind + '.xlsx';
  function addSheet(wb, name, header, rows) {
    const ws = XLSX.utils.aoa_to_sheet([header].concat(rows));
    if (rows.length) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }) };
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }

  // ---- Sort & Filter
  window.opSortFilter = function () {
    if (!st.model) return; const o = readOpts(), wb = XLSX.utils.book_new(), bench = O.benchmarks(st.model, o.products); let n = 0, t = 0;
    st.model.order.forEach(k => { if (!o.products.includes(k)) return; const p = st.model.products[k], out = O.sheetOutput(p, Object.assign({}, o, { bench })); n += out.rows.length; t += out.targets; addSheet(wb, p.sheet, out.header, out.rows); });
    if (!n) { toast('Nothing to export: tick an ad type with active rows.'); return; }
    XLSX.writeFile(wb, fileName('sorted')); toast('Downloaded ' + n.toLocaleString('en-US') + ' rows (' + t.toLocaleString('en-US') + ' active targets), sorted by impressions, spend and ACOS.', 'success');
  };

  // ---- rules editor
  const cur = () => (st.rules.mode === 'separate' && st.edit !== 'shared' ? st.rules[st.edit] : st.rules.shared);
  const inp = (path, v, cls) => '<input type="number" min="0" step="any" data-path="' + path + '" value="' + (v == null ? '' : v) + '" aria-label="' + esc(path) + '" class="' + (cls || 'w-20') + ' border border-slate-300 bg-white rounded p-1.5 text-sm text-center font-bold tabular-nums outline-none focus:ring-1 focus:ring-blue-500">';
  const dec = '<span class="w-24 text-center text-xs font-semibold rounded px-2 py-1.5 bg-rose-50 text-rose-800">Decrease by</span>', incr = '<span class="w-24 text-center text-xs font-semibold rounded px-2 py-1.5 bg-emerald-50 text-emerald-800">Increase by</span>';
  const IF = '<span class="w-6 text-slate-400 text-xs">IF</span>';
  function renderRules() {
    const R = cur(), M = R.metric, ML = O.METRIC_LABEL[M], lowOp = M === 'acos' ? '&gt;=' : '&lt;=', perfOp = M === 'acos' ? '&lt;=' : '&gt;=', unit = M === 'acos' ? '%' : M === 'rpc' ? '$' : '';
    const benchMode = M === 'rpc' && R.rpcBasis === 'bench', atU = benchMode ? '<span class="text-xs text-slate-500">%</span>' : '';
    const sepTabs = st.rules.mode === 'separate' ? '<div class="flex flex-wrap items-center gap-2 mb-4" role="tablist" aria-label="Rule set">' + st.model.order.map(k => '<button type="button" role="tab" aria-selected="' + (st.edit === k) + '" onclick="opEdit(\'' + k + '\')" class="px-3 py-1.5 text-xs font-bold rounded-lg border ' + (st.edit === k ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-300 text-slate-700 hover:bg-slate-50') + '">' + esc(O.PRODUCTS[k].label) + '</button>').join('') + '<button type="button" onclick="opCopyShared()" class="text-xs font-semibold text-blue-700 hover:underline ml-3">Copy the shared rules here</button></div>' : '';
    const head = '<div class="flex flex-wrap items-center gap-3 mb-4"><div class="flex items-center gap-1.5" role="group" aria-label="Rule sets"><button type="button" onclick="opMode(\'shared\')" aria-pressed="' + (st.rules.mode === 'shared') + '" class="px-3 py-1.5 text-xs font-bold rounded-lg border ' + (st.rules.mode === 'shared' ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-300 text-slate-700 hover:bg-slate-50') + '">Same rules for all ad types</button><button type="button" onclick="opMode(\'separate\')" aria-pressed="' + (st.rules.mode === 'separate') + '" class="px-3 py-1.5 text-xs font-bold rounded-lg border ' + (st.rules.mode === 'separate' ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-300 text-slate-700 hover:bg-slate-50') + '">Separate rules per ad type</button></div><button type="button" onclick="opReset()" class="text-xs font-semibold text-slate-500 hover:text-slate-800 ml-auto">Reset to defaults</button></div>';
    const basisSel = M === 'rpc' ? '<label for="opBasis" class="text-xs font-bold text-slate-700 ml-3 mr-2">Thresholds in</label><select id="opBasis" data-op="basis" class="border border-slate-300 bg-white p-1.5 rounded-lg text-sm font-bold outline-none"><option value="abs"' + (R.rpcBasis !== 'bench' ? ' selected' : '') + '>Dollars</option><option value="bench"' + (R.rpcBasis === 'bench' ? ' selected' : '') + '>% of account benchmark</option></select>' : '';
    const metricSel = '<label for="opMetric" class="text-xs font-bold text-slate-700 mr-2">Optimize on</label><select id="opMetric" data-op="metric" class="border border-slate-300 bg-white p-1.5 rounded-lg text-sm font-bold outline-none"><option value="roas"' + (M === 'roas' ? ' selected' : '') + '>ROAS</option><option value="acos"' + (M === 'acos' ? ' selected' : '') + '>ACOS (%)</option><option value="rpc"' + (M === 'rpc' ? ' selected' : '') + '>RPC (sales per click, $)</option></select>' + basisSel + '<span class="text-[11px] text-slate-500 ml-3">Switching converts ROAS and ACOS thresholds. RPC thresholds start empty.</span>';
    // RPC (sales per click): show how the file's RPC is spread and warn about thresholds that cannot match anything
    const rpcHint = (() => {
      if (M !== 'rpc') return '';
      if (R.rpcBasis === 'bench') {
        const bm = O.benchmarks(st.model, readOpts().products), fm = v => (v == null ? '–' : '$' + v.toFixed(2));
        return '<p class="text-xs text-slate-600 mt-2">Thresholds are a % of the account benchmark RPC (100% = the benchmark): ' + st.model.order.filter(k => bm.product[k]).map(k => esc(O.PRODUCTS[k].short) + ' ' + fm(bm.product[k].rpc)).join(' · ') + ' · whole account ' + fm(bm.account.rpc) + '. Which one is used follows the Benchmark setting in Options.</p>';
      }
      const s = O.rpcStats(st.model); if (!s) return '<p class="text-xs text-slate-600 mt-2">No active target has orders yet, so an RPC rule has nothing to act on.</p>';
      const f = v => '$' + v.toFixed(2), warn = [];
      [['low', 'Low performing', '<='], ['perf', 'Performing', '>=']].forEach(([k, name, op]) => R[k].forEach((t, i) => {
        if (!(typeof t.at === 'number')) return;
        if (t.at > s.max) warn.push(name + ' row ' + (i + 1) + ': ' + f(t.at) + ' is above the highest RPC in this file (' + f(s.max) + '), so ' + (op === '<=' ? 'it would catch every target with orders' : 'no target can match') + '. Typo?');
        else if (t.at < s.min) warn.push(name + ' row ' + (i + 1) + ': ' + f(t.at) + ' is below the lowest RPC in this file (' + f(s.min) + '), so ' + (op === '<=' ? 'no target can match' : 'it would catch every target with orders') + '.');
      }));
      return '<p class="text-xs text-slate-600 mt-2">RPC across ' + s.n + ' active targets with orders: median <b>' + f(s.median) + '</b>, middle half ' + f(s.p25) + ' to ' + f(s.p75) + ', range ' + f(s.min) + ' to ' + f(s.max) + '.</p>'
        + (warn.length ? '<ul class="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-2.5 mt-2 space-y-0.5" role="status">' + warn.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul>' : '');
    })();
    const row = (cells, extra) => '<div class="flex flex-wrap items-center gap-2 py-1">' + cells + (extra || '') + '</div>';
    const lowRows = R.low.map((t, i) => row(IF + '<span class="w-14 text-xs font-bold text-slate-700">' + ML + '</span><span class="w-6 text-center text-xs text-slate-500">' + lowOp + '</span>' + inp('low.' + i + '.at', t.at) + atU + dec + inp('low.' + i + '.pct', t.pct, 'w-16') + '<span class="text-xs text-slate-500">%</span>')).join('');
    const capCell = (path, v) => '<span class="w-6 text-slate-400 text-xs ml-3">IF</span><span class="w-10 text-xs font-bold text-slate-700">Bid</span><span class="w-6 text-center text-xs text-slate-500">&lt;=</span>' + inp(path, v, 'w-16');
    const perfRows = R.perf.map((t, i) => row(IF + '<span class="w-14 text-xs font-bold text-slate-700">' + ML + '</span><span class="w-6 text-center text-xs text-slate-500">' + perfOp + '</span>' + inp('perf.' + i + '.at', t.at) + atU + incr + inp('perf.' + i + '.pct', t.pct, 'w-16') + '<span class="text-xs text-slate-500">%</span>' + capCell('perf.' + i + '.cap', t.cap))).join('');
    const by = R.zero.by, zeroRows = R.zero.tiers.map((t, i) => row(IF + '<span class="w-16 text-xs font-bold text-slate-700">' + (by === 'spend' ? 'Spend' : 'Clicks') + '</span><span class="w-6 text-center text-xs text-slate-500">&gt;=</span>' + inp('zero.tiers.' + i + '.at', t.at) + dec + inp('zero.tiers.' + i + '.pct', t.pct, 'w-16') + '<span class="text-xs text-slate-500">%</span>')).join('');
    const lowTraffic = R.zeroLow.map((t, i) => row(IF + '<span class="w-24 text-xs font-bold text-slate-700">Impressions</span><span class="w-6 text-center text-xs text-slate-500">&lt;=</span>' + inp('zeroLow.' + i + '.at', t.at) + incr + inp('zeroLow.' + i + '.pct', t.pct, 'w-16') + '<span class="text-xs text-slate-500">%</span>' + capCell('zeroLow.' + i + '.cap', t.cap))).join('');
    const block = (title, tint, body) => '<section class="border border-slate-200 rounded-xl p-4"><h3 class="text-sm font-extrabold ' + tint + ' mb-2">' + title + '</h3>' + body + '</section>';
    $('opRules').innerHTML = head + sepTabs + '<div class="mb-4">' + metricSel + rpcHint + '</div><div class="grid grid-cols-1 gap-4">'
      + block('Low performing targets (with orders)', 'text-rose-800', lowRows + '<p class="text-[11px] text-slate-500 mt-2">If several rows match, the tightest one is used. ' + (benchMode ? 'Thresholds are % of the account benchmark RPC.' : unit ? 'Thresholds in ' + (unit === '%' ? '%' : 'dollars') + '.' : '') + '</p>')
      + block('Performing targets (with orders)', 'text-emerald-800', perfRows + '<div class="flex flex-wrap items-center gap-2 pt-2 text-xs text-slate-600">Only raise targets with at least ' + inp('perfMinClicks', R.perfMinClicks, 'w-16') + ' clicks (0 = no minimum). A raise may end slightly above the Bid cap.</div>')
      + block('0 orders and high clicks or spend', 'text-rose-800', '<div class="flex items-center gap-2 mb-1"><label for="opBy" class="text-xs font-bold text-slate-700">Measure by</label><select id="opBy" data-op="by" class="border border-slate-300 bg-white p-1.5 rounded-lg text-sm font-bold outline-none"><option value="clicks"' + (by === 'clicks' ? ' selected' : '') + '>Clicks</option><option value="spend"' + (by === 'spend' ? ' selected' : '') + '>Spend ($)</option></select></div>' + zeroRows
        + '<div class="flex flex-wrap items-center gap-2 pt-2 text-xs text-slate-600"><span class="font-bold text-slate-700">Low clicks</span> &lt;= ' + inp('zero.lowClicks', R.zero.lowClicks, 'w-16') + '<span>clicks: those targets use the next block instead.</span></div>')
      + block('0 orders and low clicks: not enough traffic', 'text-emerald-800', lowTraffic) + '</div>';
  }
  $('opRules').addEventListener('change', e => {
    const t = e.target, R = cur();
    if (t.dataset.op === 'metric') { const next = O.convertMetric(R, t.value); Object.keys(next).forEach(k => { R[k] = next[k]; }); renderRules(); return; }
    if (t.dataset.op === 'basis') { const next = O.setRpcBasis(R, t.value); Object.keys(next).forEach(k => { R[k] = next[k]; }); renderRules(); return; }
    if (t.dataset.op === 'by') { R.zero.by = t.value === 'spend' ? 'spend' : 'clicks'; R.zero.tiers.forEach(x => { x.at = null; }); renderRules(); return; }
    if (!t.dataset.path) return;
    const parts = t.dataset.path.split('.'), last = parts.pop(); let o = R; parts.forEach(p => { o = o[p]; });
    const v = parseFloat(t.value); o[last] = isFinite(v) && v >= 0 ? v : (last === 'lowClicks' || last === 'perfMinClicks' ? 0 : null);
    if (last === 'pct' && o[last] > 100) { o[last] = 100; t.value = 100; }
    if (R.metric === 'rpc') renderRules();   // the RPC thresholds are checked against the file
  });
  window.opMode = function (m) {
    st.rules.mode = m;
    if (m === 'separate') st.model.order.forEach(k => { if (!st.rules[k]) st.rules[k] = JSON.parse(JSON.stringify(st.rules.shared)); });
    st.edit = m === 'separate' ? st.model.order[0] : 'shared'; renderRules();
  };
  window.opEdit = k => { st.edit = k; renderRules(); };
  window.opCopyShared = () => { st.rules[st.edit] = JSON.parse(JSON.stringify(st.rules.shared)); renderRules(); toast('Copied the shared rules.', 'success'); };
  window.opReset = () => { const d = O.defaultRules(); if (st.rules.mode === 'separate' && st.edit !== 'shared') st.rules[st.edit] = d; else st.rules.shared = d; renderRules(); };
  // ---- profiles: all the settings for one account or brand, saved in this browser (and exportable as a file)
  const profStore = () => { try { const o = JSON.parse(localStorage.getItem(PROFILES) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; } };
  const profWrite = o => { try { localStorage.setItem(PROFILES, JSON.stringify(o)); return true; } catch (e) { toast('Could not save in this browser (storage is blocked or full).', 'error'); return false; } };
  const lastGet = () => { try { return localStorage.getItem(LAST) || ''; } catch (e) { return ''; } };
  const lastSet = n => { try { if (n) localStorage.setItem(LAST, n); else localStorage.removeItem(LAST); } catch (e) { /* ignore */ } };
  const snapshot = () => ({ v: 1, savedAt: new Date().toISOString(), rules: JSON.parse(JSON.stringify(st.rules)), options: readOpts() });
  // A profile from storage or from a file -> a safe, complete one (or null). Nothing in it is trusted.
  function cleanProfile(p) {
    if (!p || typeof p !== 'object' || !p.rules || typeof p.rules !== 'object') return null;
    const rules = { mode: p.rules.mode === 'separate' ? 'separate' : 'shared', shared: O.sanitizeRules(p.rules.shared) };
    O.ORDER.forEach(k => { if (p.rules[k]) rules[k] = O.sanitizeRules(p.rules[k]); });
    const o = p.options && typeof p.options === 'object' ? p.options : {}, floors = {}, pos = v => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : null), rc = o.rpcCheck && typeof o.rpcCheck === 'object' ? o.rpcCheck : {}, rsx = o.rpcStatus && typeof o.rpcStatus === 'object' ? o.rpcStatus : {};
    O.ORDER.forEach(k => { if (o.floors && pos(o.floors[k]) !== null) floors[k] = o.floors[k]; });
    return { v: 1, rules, options: { products: Array.isArray(o.products) ? o.products.filter(k => O.ORDER.includes(k)) : null, skipRank: o.skipRank !== false, skipCatchAll: o.skipCatchAll === true, skipLowBid: o.skipLowBid === true, skipManaged: o.skipManaged === true,
      skipWords: Array.isArray(o.skipWords) ? o.skipWords.map(x => String(x).slice(0, 40)).filter(Boolean).slice(0, 20) : [], floors, maxBid: pos(o.maxBid) > 0 ? o.maxBid : null, rpcCheck: { high: pos(rc.high) > 0 ? rc.high : 50, low: pos(rc.low) !== null ? rc.low : 10 },
      rpcStatus: { targetAcos: pos(rsx.targetAcos) > 0 ? rsx.targetAcos : null, scope: rsx.scope === 'account' ? 'account' : 'product', minClicks: pos(rsx.minClicks) !== null ? rsx.minClicks : 10, bleed: pos(rsx.bleed) > 0 ? rsx.bleed : null, greenAt: pos(rsx.greenAt) > 0 ? rsx.greenAt : 100, yellowAt: pos(rsx.yellowAt) !== null ? rsx.yellowAt : 70, slack: pos(rsx.slack) > 0 ? rsx.slack : 125 },
      pp: cleanPP(o.pp) } };
  }
  function applyOptions(o) {
    st.model.order.forEach(k => { const el = document.querySelector('[data-prod="' + k + '"]'); if (el) el.checked = Array.isArray(o.products) && o.products.some(x => st.model.order.includes(x)) ? o.products.includes(k) : true; $('opFloor_' + k).value = o.floors && typeof o.floors[k] === 'number' ? o.floors[k] : st.model.products[k].floor; });
    $('opSkipManaged').checked = o.skipManaged === true;
    [['opSkipRank', o.skipRank !== false], ['opSkipCatchAll', o.skipCatchAll === true], ['opSkipLowBid', o.skipLowBid === true]].forEach(([id, v]) => { if ($(id)) $(id).checked = v; });
    $('opMax').value = typeof o.maxBid === 'number' && o.maxBid > 0 ? o.maxBid : ''; $('opWords').value = Array.isArray(o.skipWords) ? o.skipWords.join(', ') : '';
    if (o.rpcCheck) { $('opRpcHi').value = o.rpcCheck.high; $('opRpcLo').value = o.rpcCheck.low; }
    const rs = o.rpcStatus || {}; $('opTargetAcos').value = rs.targetAcos > 0 ? rs.targetAcos : ''; $('opScope').value = rs.scope === 'account' ? 'account' : 'product'; $('opMinClicks').value = typeof rs.minClicks === 'number' ? rs.minClicks : 10;
    $('opBleed').value = rs.bleed > 0 ? rs.bleed : ''; $('opGreenAt').value = rs.greenAt > 0 ? rs.greenAt : 100; $('opYellowAt').value = typeof rs.yellowAt === 'number' ? rs.yellowAt : 70; $('opSlack').value = rs.slack > 0 ? rs.slack : 125; renderBench(); applyPP(o.pp);
  }
  function applyProfile(prof, name) {
    st.rules = JSON.parse(JSON.stringify(prof.rules));
    if (st.rules.mode === 'separate') st.model.order.forEach(k => { if (!st.rules[k]) st.rules[k] = JSON.parse(JSON.stringify(st.rules.shared)); });
    st.edit = st.rules.mode === 'separate' ? st.model.order[0] : 'shared'; st.res = null; $('opOut').innerHTML = '';
    applyOptions(prof.options); st.profile = name; lastSet(name); renderRules(); renderProfile();
  }
  function renderProfile() {
    const names = Object.keys(profStore()).sort(), btn = 'border border-slate-300 hover:bg-slate-50 text-slate-800 text-xs font-bold px-3 py-2 rounded-lg transition-colors';
    $('opProfile').innerHTML = '<div class="flex flex-wrap items-end gap-3"><div><label for="opProfSel" class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Profile (account or brand)</label><select id="opProfSel" onchange="opProfilePick()" class="border border-slate-300 bg-white p-2 rounded-lg text-sm font-medium outline-none focus:ring-1 focus:ring-blue-500 w-64"><option value="">No profile (defaults)</option>'
      + names.map(n => '<option value="' + esc(n) + '"' + (n === st.profile ? ' selected' : '') + '>' + esc(n) + '</option>').join('') + '</select></div>'
      + '<button type="button" onclick="opProfileSave()" class="' + btn + '">Save</button><button type="button" onclick="opProfileSaveAs()" class="' + btn + '">Save as…</button><button type="button" onclick="opProfileDelete()" class="text-xs font-semibold text-slate-500 hover:text-rose-700 px-1">Delete</button>'
      + '<span class="ml-auto flex items-center gap-2"><button type="button" onclick="opProfileExport()" class="' + btn + '">Export</button><button type="button" onclick="document.getElementById(\'opProfFile\').click()" class="' + btn + '">Import</button></span></div>'
      + '<p class="text-[11px] text-slate-500 mt-2">A profile keeps the rules (shared and per ad type), the options and limits for one account or brand. It is saved in this browser only and comes back by itself next time. Export it to move it to another browser or share it.</p>'
      + '<input type="file" id="opProfFile" accept=".json,application/json" class="hidden" aria-label="Import a profile">';
    $('opProfFile').addEventListener('change', importProfile);
  }
  window.opProfilePick = function () {
    const n = $('opProfSel').value;
    if (!n) { st.profile = ''; lastSet(''); st.rules = { mode: 'shared', shared: O.defaultRules() }; st.edit = 'shared'; st.res = null; $('opOut').innerHTML = ''; renderOptions(); renderPP(); renderRules(); renderProfile(); toast('Back to the default settings.'); return; }
    const prof = cleanProfile(profStore()[n]); if (!prof) { toast('That profile could not be read.', 'error'); return; }
    applyProfile(prof, n); toast('Applied "' + esc(n) + '".', 'success');
  };
  async function saveNamed(name) {
    const all = profStore();
    if (all[name] && name !== st.profile && !(await confirmModal('Replace the saved profile "' + name + '"?', { confirmText: 'Replace', danger: false }))) return;
    all[name] = snapshot(); if (!profWrite(all)) return; st.profile = name; lastSet(name); renderProfile(); toast('Saved "' + esc(name) + '".', 'success');
  }
  window.opProfileSave = function () { if (st.profile) saveNamed(st.profile); else opProfileSaveAs(); };
  window.opProfileSaveAs = function () {
    const name = (window.prompt('Name this profile (an account or brand):', st.profile || '') || '').trim().slice(0, 40); if (name) saveNamed(name);
  };
  window.opProfileDelete = async function () {
    const n = st.profile; if (!n) { toast('Pick a saved profile first.'); return; }
    if (!(await confirmModal('Delete the saved profile "' + n + '"?', { confirmText: 'Delete' }))) return;
    const all = profStore(); delete all[n]; if (!profWrite(all)) return; st.profile = ''; lastSet(''); renderProfile(); toast('Deleted.', 'success');
  };
  window.opProfileExport = function () {
    const name = st.profile || 'optimizer-profile', blob = new Blob([JSON.stringify(Object.assign({ name }, snapshot()), null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.optimizer-profile.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  async function importProfile(e) {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      if (f.size > 200 * 1024) throw new Error('That file is too large to be a profile.');
      const j = JSON.parse(await f.text()), prof = cleanProfile(j); if (!prof) throw new Error('That file is not an optimizer profile.');
      const name = String(j.name || f.name.replace(/\.optimizer-profile\.json$|\.json$/i, '')).trim().slice(0, 40) || 'Imported profile', all = profStore(); all[name] = prof;
      if (!profWrite(all)) return; applyProfile(prof, name); toast('Imported "' + esc(name) + '".', 'success');
    } catch (err) { toast(esc(err instanceof SyntaxError ? 'That file is not valid JSON.' : err.message), 'error'); }
  }
  function autoProfile() {   // the profile used last comes back by itself
    st.profile = ''; const n = lastGet(), prof = n ? cleanProfile(profStore()[n]) : null;
    if (prof) { applyProfile(prof, n); toast('Applied your profile "' + esc(n) + '".', 'success'); } else renderProfile();
  }

  // ---- Optimize + preview
  // Optimize runs the rules (and the Product Pages action when one is chosen); "Run Product Pages only" runs just the Product Pages action.
  function runOptimize(only) {
    if (!st.model) return; const o = readOpts();
    if (!o.products.length) { toast('Tick at least one ad type.'); return; }
    if (only && o.pp.action === 'none') { toast('Choose what to do about Product Pages first: lower the adjustment, lower the target bids, or both.'); return; }
    const bench = O.benchmarks(st.model, o.products); st.bench = bench; st.opts = o; st.ppOnly = !!only; st.res = O.optimize(st.model, st.rules, Object.assign({}, o, { bench, onlyPP: !!only }));
    st.res.results.forEach(r => { if (r.kind === 'placement') return; r.stat = O.rpcStatus(r.t, O.benchFor(bench, r.p, o.rpcStatus.scope), o.rpcStatus); });
    st.sel = new Set(st.res.results.filter(r => r.status === 'change').map(r => r.p + ':' + r.ri)); st.view = { product: '', rule: '', tone: '', part: '', show: 'changes', page: 0 }; renderResults();
    $('opOut').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  window.opOptimize = () => runOptimize(false);
  window.opPPRun = () => runOptimize(true);
  const key = r => r.p + ':' + r.ri;
  function visible() {
    const v = st.view; return st.res.results.filter(r => (v.show === 'all' || r.status === 'change') && (!v.product || r.p === v.product) && (!v.rule || (v.rule === '__same' ? r.status !== 'change' : r.rule === v.rule)) && (!v.tone || (r.stat && r.stat.tone === v.tone)) && (!v.part || (v.part === 'pp') === O.isProductPages(r)));
  }
  const TONE = { green: ['Ideal', 'bg-emerald-100 text-emerald-800'], yellow: ['Below ideal', 'bg-amber-100 text-amber-800'], red: ['Bad / bleeding', 'bg-rose-50 text-rose-800'], grey: ['Not enough data', 'bg-slate-100 text-slate-700'] };
  const statusCell = r => {
    const s = r.stat; if (!s) return '<td class="px-3 py-2 text-slate-400">–</td>';
    return '<td class="px-3 py-2 whitespace-nowrap"><span class="inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ' + TONE[s.tone][1] + '" title="RPC as a % of the account benchmark">' + esc(s.label) + (s.pct == null ? '' : ' ' + Math.round(s.pct) + '%') + '</span>'
      + (r.t.rpc !== null ? '<div class="text-[11px] text-slate-500 mt-0.5 tabular-nums">RPC ' + money(r.t.rpc) + '</div>' : '') + '</td>';
  };
  const placementRow = (r, k) => {   // a Product Pages placement change in the preview
    const t = r.t;
    return '<tr class="border-t border-slate-100 align-top"><td class="px-3 py-2"><input type="checkbox" data-sel="' + k + '" ' + (st.sel.has(k) ? 'checked ' : '') + 'aria-label="Apply this change" class="rounded border-slate-300"></td>'
      + '<td class="px-3 py-2 whitespace-nowrap text-slate-500">' + esc(O.PRODUCTS[r.p].short) + '</td><td class="px-3 py-2 max-w-[16rem] truncate text-slate-600" title="' + esc(t.campName) + '">' + esc(t.campName) + '</td>'
      + '<td class="px-3 py-2 font-semibold text-slate-800">Product Pages placement <span class="text-[10px] font-bold uppercase rounded px-1.5 py-0.5 bg-rose-50 text-rose-800">Adjustment</span></td>'
      + '<td class="px-3 py-2 text-right tabular-nums whitespace-nowrap">' + r.oldPct + '% → <b>' + r.newPct + '%</b></td><td class="px-3 py-2 text-right tabular-nums font-bold text-rose-700">' + r.pct.toFixed(1) + '%</td><td class="px-3 py-2 text-slate-400">–</td>'
      + '<td class="px-3 py-2 text-slate-700 max-w-sm">' + esc(r.rule) + '<div class="text-[11px] text-slate-500 mt-0.5">' + esc(r.why) + ' · ' + money(t.spend) + ' spend · ' + t.clicks + ' clicks · ' + t.orders + ' orders' + (t.cpc !== null ? ' · CPC ' + money(t.cpc) : '') + '</div></td></tr>';
  };
  const rpcChip = r => {   // a changed bid that ends up too high or too low for what a click earns
    if (r.status !== 'change' || !(r.t.orders > 0) || r.t.rpc === null) return '';
    const c = O.rpcCheck(r.newBid, r.t.rpc, st.opts.rpcCheck.high, st.opts.rpcCheck.low); if (!c || c.startsWith('OK')) return '';
    return '<div class="text-[10px] font-bold uppercase rounded px-1.5 py-0.5 mt-1 inline-block ' + (c.startsWith('Too high') ? 'bg-rose-50 text-rose-800' : 'bg-amber-100 text-amber-800') + '" title="The new bid as a share of what an average click earns (RPC ' + money(r.t.rpc) + ')">RPC: ' + esc(c) + '</div>';
  };
  // Rules | Product Pages tabs above the preview (only when this run has Product Pages changes)
  function partTabs() {
    const ch = st.res.results.filter(r => r.status === 'change'), pp = ch.filter(r => O.isProductPages(r)).length; if (!pp || st.ppOnly) return '';
    const t = (v, label, n) => '<button type="button" role="tab" aria-selected="' + (st.view.part === v) + '" onclick="opPart(\'' + v + '\')" class="px-3 py-1.5 text-xs font-bold rounded-lg border ' + (st.view.part === v ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-300 text-slate-700 hover:bg-slate-50') + '">' + label + ' (' + n + ')</button>';
    return '<div class="flex flex-wrap items-center gap-2 mb-3" role="tablist" aria-label="Which changes">' + t('', 'All changes', ch.length) + t('main', 'Rules', ch.length - pp) + t('pp', 'Product Pages', pp) + '<span class="text-[11px] text-slate-500">Rules and Product Pages go in separate upload files.</span></div>';
  }
  window.opPart = v => { st.view.part = v; st.view.page = 0; renderResults(); };
  function renderResults() {
    const res = st.res, s = res.summary, v = st.view, list = visible(), pages = Math.max(1, Math.ceil(list.length / PAGE)); if (v.page >= pages) v.page = pages - 1;
    const ruleOpts = '<option value="">All rules</option>' + Object.keys(s.byRule).sort().map(r => '<option' + (v.rule === r ? ' selected' : '') + ' value="' + esc(r) + '">' + esc(r) + ' (' + s.byRule[r] + ')</option>').join('');
    const prodOpts = '<option value="">All ad types</option>' + st.model.order.filter(k => s.byProduct[k]).map(k => '<option value="' + k + '"' + (v.product === k ? ' selected' : '') + '>' + esc(O.PRODUCTS[k].label) + ' (' + s.byProduct[k].changed + ' / ' + s.byProduct[k].total + ')</option>').join('');
    const ticked = res.results.filter(r => r.status === 'change' && st.sel.has(key(r))), parts = { pp: ticked.filter(r => O.isProductPages(r)).length, main: ticked.filter(r => !O.isProductPages(r)).length };
    const tones = { green: 0, yellow: 0, red: 0, grey: 0 }; res.results.forEach(r => { if (r.stat) tones[r.stat.tone]++; });
    const toneOpts = '<option value="">All RPC statuses</option>' + Object.keys(TONE).map(k => '<option value="' + k + '"' + (v.tone === k ? ' selected' : '') + '>' + TONE[k][0] + ' (' + tones[k] + ')</option>').join('');
    const unch = Object.keys(s.unchanged).sort((a, b) => s.unchanged[b] - s.unchanged[a]).map(w => '<li class="flex justify-between gap-4"><span>' + esc(w) + '</span><b class="tabular-nums">' + s.unchanged[w] + '</b></li>').join('');
    const body = list.slice(v.page * PAGE, (v.page + 1) * PAGE).map(r => {
      if (r.kind === 'placement') return placementRow(r, key(r));
      const t = r.t, ch = r.status === 'change', k = key(r), why = [];
      if (t.roas != null) why.push('ROAS ' + t.roas.toFixed(2)); if (t.acos !== null && t.acos !== Infinity && t.orders > 0) why.push('ACOS ' + (t.acos * 100).toFixed(0) + '%'); why.push(t.clicks + ' clicks', t.orders + ' orders', t.imp.toLocaleString('en-US') + ' impr.', '$' + t.spend.toFixed(2) + ' spend'); if (t.cpc !== null) why.push('CPC $' + t.cpc.toFixed(2));
      return '<tr class="border-t border-slate-100 align-top"><td class="px-3 py-2">' + (ch ? '<input type="checkbox" data-sel="' + k + '" ' + (st.sel.has(k) ? 'checked ' : '') + 'aria-label="Apply this change" class="rounded border-slate-300">' : '') + '</td>'
        + '<td class="px-3 py-2 whitespace-nowrap text-slate-500">' + esc(O.PRODUCTS[r.p].short) + '</td><td class="px-3 py-2 max-w-[16rem] truncate text-slate-600" title="' + esc(t.campName) + '">' + esc(t.campName) + '</td>'
        + '<td class="px-3 py-2 font-semibold text-slate-800 max-w-[16rem] break-words">' + esc(t.text) + (t.match ? ' <span class="text-[10px] font-bold uppercase text-slate-500">' + esc(t.match) + '</span>' : '') + (t.managed ? ' <span class="text-[10px] font-bold uppercase rounded px-1.5 py-0.5 bg-amber-100 text-amber-800" title="Amazon already adjusts bids in this campaign">Amazon-managed</span>' : '') + '</td>'
        + '<td class="px-3 py-2 text-right tabular-nums whitespace-nowrap">' + money(r.oldBid) + (t.bidFromGroup ? '<span class="text-slate-400" title="Ad group default bid"> *</span>' : '') + (ch ? ' → <b>' + money(r.newBid) + '</b>' : '') + rpcChip(r) + '</td>'
        + '<td class="px-3 py-2 text-right tabular-nums font-bold ' + (ch ? (r.pct > 0 ? 'text-emerald-700' : 'text-rose-700') : 'text-slate-400') + '">' + (ch ? (r.pct > 0 ? '+' : '') + r.pct.toFixed(1) + '%' : '–') + '</td>'
        + statusCell(r) + '<td class="px-3 py-2 text-slate-700 max-w-sm">' + esc(ch ? r.rule : r.why) + '<div class="text-[11px] text-slate-500 mt-0.5">' + esc(why.join(' · ')) + '</div></td></tr>';
    }).join('');
    $('opOut').innerHTML = '<div class="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 mb-4">'
      + '<div class="flex flex-wrap items-baseline gap-x-6 gap-y-2 mb-3"><h2 class="text-base font-extrabold text-slate-800">' + (st.ppOnly ? 'Product Pages only: ' + (s.changed + s.placements).toLocaleString('en-US') + ' change' + (s.changed + s.placements === 1 ? '' : 's') + ' (' + s.placements + ' placement' + (s.placements === 1 ? '' : 's') + ', ' + s.changed + ' target bid' + (s.changed === 1 ? '' : 's') + ')' : s.changed.toLocaleString('en-US') + ' of ' + s.total.toLocaleString('en-US') + ' active targets would change') + '</h2><span class="text-xs text-slate-600"><b class="text-emerald-700">' + s.up + ' up</b> · <b class="text-rose-700">' + s.down + ' down</b> · ' + (s.total - s.changed).toLocaleString('en-US') + ' unchanged' + (s.placements ? ' · <b class="text-rose-700">' + s.placements + ' Product Pages placement change' + (s.placements === 1 ? '' : 's') + '</b>' : '') + '</span></div>'
      + '<p class="text-xs text-slate-600 mb-3">RPC status of these targets: ' + Object.keys(TONE).map(k => '<span class="inline-block rounded px-1.5 py-0.5 font-bold ' + TONE[k][1] + '">' + TONE[k][0] + ' ' + tones[k] + '</span>').join(' ') + '</p>'
      + partTabs()
      + (unch && !st.ppOnly ? '<details class="mb-3"><summary class="cursor-pointer text-xs font-bold text-slate-700 select-none">Why the others did not change</summary><ul class="mt-2 text-xs text-slate-600 space-y-1 max-w-md">' + unch + '</ul></details>' : '')
      + '<div class="flex flex-wrap items-center gap-2 mb-3"><label for="opFProd" class="sr-only">Ad type</label><select id="opFProd" onchange="opFilter()" class="border border-slate-300 bg-white p-1.5 rounded-lg text-xs outline-none">' + prodOpts + '</select><label for="opFRule" class="sr-only">Rule</label><select id="opFRule" onchange="opFilter()" class="border border-slate-300 bg-white p-1.5 rounded-lg text-xs outline-none max-w-[16rem]">' + ruleOpts + '</select><label for="opFTone" class="sr-only">RPC status</label><select id="opFTone" onchange="opFilter()" class="border border-slate-300 bg-white p-1.5 rounded-lg text-xs outline-none">' + toneOpts + '</select>'
      + '<label class="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer"><input type="checkbox" id="opFAll" onchange="opFilter()" ' + (v.show === 'all' ? 'checked ' : '') + 'class="rounded border-slate-300"> Show unchanged too</label>'
      + '<span id="opSelN" class="text-xs text-slate-600 ml-auto"></span><button type="button" onclick="opSelAll(true)" class="text-xs font-semibold text-blue-700 hover:underline">Select all</button><button type="button" onclick="opSelAll(false)" class="text-xs font-semibold text-blue-700 hover:underline">None</button></div>'
      + '<div class="overflow-x-auto"><table class="w-full text-xs"><thead><tr class="bg-slate-50 text-slate-500 text-[10px] font-bold uppercase tracking-wider"><th scope="col" class="px-3 py-2"></th><th scope="col" class="px-3 py-2 text-left">Type</th><th scope="col" class="px-3 py-2 text-left">Campaign</th><th scope="col" class="px-3 py-2 text-left">Target</th><th scope="col" class="px-3 py-2 text-right">Bid</th><th scope="col" class="px-3 py-2 text-right">Change</th><th scope="col" class="px-3 py-2 text-left">RPC status</th><th scope="col" class="px-3 py-2 text-left">Rule and numbers</th></tr></thead><tbody>' + (body || '<tr><td colspan="8" class="px-3 py-6 text-center text-slate-500">Nothing to show with these filters.</td></tr>') + '</tbody></table></div>'
      + '<div class="flex flex-wrap items-center gap-3 mt-3 text-xs text-slate-600"><span>' + list.length.toLocaleString('en-US') + ' row' + (list.length === 1 ? '' : 's') + ' · page ' + (v.page + 1) + ' of ' + pages + '</span><button type="button" onclick="opPage(-1)" ' + (v.page ? '' : 'disabled ') + 'class="border border-slate-300 rounded-lg px-2.5 py-1 font-bold disabled:opacity-50">Prev</button><button type="button" onclick="opPage(1)" ' + (v.page < pages - 1 ? '' : 'disabled ') + 'class="border border-slate-300 rounded-lg px-2.5 py-1 font-bold disabled:opacity-50">Next</button>'
      + '<span class="text-slate-400">* = ad group default bid (the row had no bid)</span></div>'
      + '<label class="flex items-center gap-2 text-xs text-slate-700 mt-4 pt-4 border-t border-slate-100 cursor-pointer"><input type="checkbox" onchange="opUpExtras(this.checked)" ' + (st.upExtras ? 'checked ' : '') + 'class="rounded border-slate-300"> Add the reference columns (New Bid, Old Bid, RPC, placements and the rest) at the end of the upload file</label>'
      + '<div class="flex flex-wrap gap-2 mt-3">' + (st.ppOnly ? '' : '<button type="button" onclick="opDownloadUpload()" class="btn-ink bg-slate-800 hover:bg-slate-700 text-white font-bold px-5 py-2.5 rounded-xl shadow-sm text-sm">Download upload file (' + parts.main + ')</button>')
      + (parts.pp || st.ppOnly ? '<button type="button" onclick="opDownloadUploadPP()" class="' + (st.ppOnly ? 'btn-ink bg-slate-800 hover:bg-slate-700 text-white' : 'border border-slate-800 text-slate-800 hover:bg-slate-50') + ' font-bold px-5 py-2.5 rounded-xl shadow-sm text-sm">Download Product Pages upload file (' + parts.pp + ')</button>' : '')
      + '<button type="button" onclick="opDownloadReview()" class="border border-slate-300 hover:bg-slate-50 text-slate-800 font-bold px-5 py-2.5 rounded-xl text-sm">Download review file (.xlsx)</button></div>'
      + '<p class="text-[11px] text-slate-500 mt-2 leading-relaxed">The upload file has only the ticked changes: each is the original row with Operation = Update and the new Bid (for a Product Pages placement, the new Percentage). The Product Pages changes are in their own file, so no target or placement is in both files and you can upload them in any order. The review file has the sorted rows with New Bid filled in and the rule behind each change. Try a few rows first the first time you upload.</p></div>';
    selCount(); lucide.createIcons();
  }
  const selCount = () => { const el = $('opSelN'); if (el) el.textContent = st.sel.size.toLocaleString('en-US') + ' of ' + (st.res.summary.changed + st.res.summary.placements).toLocaleString('en-US') + ' changes ticked'; };
  window.opFilter = function () { st.view.product = $('opFProd').value; st.view.rule = $('opFRule').value; st.view.tone = $('opFTone').value; st.view.show = $('opFAll').checked ? 'all' : 'changes'; st.view.page = 0; renderResults(); };
  window.opPage = d => { st.view.page += d; renderResults(); };
  window.opSelAll = on => { visible().forEach(r => { if (r.status === 'change') on ? st.sel.add(key(r)) : st.sel.delete(key(r)); }); renderResults(); };
  $('opOut').addEventListener('change', e => { const k = e.target.dataset && e.target.dataset.sel; if (!k) return; e.target.checked ? st.sel.add(k) : st.sel.delete(k); selCount(); });

  function chosenPlan(k) {   // the plan with the changes the user unticked turned back into "left out"
    const out = new Map(); st.res.plan[k].forEach((r, ri) => out.set(ri, r.status === 'change' && !st.sel.has(key(r)) ? Object.assign({}, r, { status: 'same', why: 'Left out by you' }) : r)); return out;
  }
  // The two upload files: the rule-based changes, and the Product Pages ones (placement rows and the target bids Product Pages lowered). No change is in both.
  function downloadUpload(part, kind, what) {
    if (!st.res) return; const wb = XLSX.utils.book_new(); let n = 0;
    st.model.order.forEach(k => { if (!st.res.plan[k]) return; const p = st.model.products[k], out = O.uploadOutput(p, st.res.plan[k], r => st.sel.has(key(r)), Object.assign({}, st.opts, { bench: st.bench, withExtras: st.upExtras, part })); if (out.rows.length) { n += out.rows.length; addSheet(wb, p.sheet, out.header, out.rows); } });
    if (!n) { toast('No ' + what + ' changes are ticked.'); return; }
    XLSX.writeFile(wb, fileName(kind)); toast('Downloaded ' + n.toLocaleString('en-US') + ' ' + what + ' update' + (n === 1 ? '' : 's') + '.', 'success');
  }
  window.opDownloadUpload = () => downloadUpload('main', 'Bulkupload', 'bid');
  window.opDownloadUploadPP = () => downloadUpload('pp', 'Bulkupload-ProductPages', 'Product Pages');
  window.opUpExtras = on => { st.upExtras = !!on; };
  window.opDownloadReview = function () {
    if (!st.res) return; const wb = XLSX.utils.book_new(), s = st.res.summary;
    const sum = [['Bulk Optimizer review'], ['Active targets', s.total], ['Changes ticked', st.sel.size], ['Raised', s.up], ['Lowered', s.down], [], ['Benchmark scope', st.opts.rpcStatus.scope === 'account' ? 'Whole account' : 'Per ad type'], ['Target ACOS', st.opts.rpcStatus.targetAcos ? st.opts.rpcStatus.targetAcos + '%' : 'auto (the account ACOS)']].concat(O.ORDER.filter(k => st.bench.product[k]).map(k => ['Benchmark RPC, ' + O.PRODUCTS[k].short, st.bench.product[k].rpc == null ? '' : +st.bench.product[k].rpc.toFixed(2)]), [['Benchmark RPC, whole account', st.bench.account.rpc == null ? '' : +st.bench.account.rpc.toFixed(2)], [], ['Rule', 'Targets']], Object.keys(s.byRule).sort().map(r => [r, s.byRule[r]])).concat([[], ['Not changed because', 'Targets']], Object.keys(s.unchanged).sort().map(w => [w, s.unchanged[w]]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), 'Summary');
    st.model.order.forEach(k => { if (!st.res.plan[k]) return; const p = st.model.products[k], out = O.sheetOutput(p, Object.assign({}, st.opts, { bench: st.bench }), chosenPlan(k)); addSheet(wb, p.sheet, out.header, out.rows); });
    const pa = O.ppAnalysis(st.model, O.ppConfig(st.opts.pp, st.opts.rpcStatus), st.bench, st.opts.products).rows;
    if (pa.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Ad type', 'Campaign', 'Product Pages spend', 'Clicks', 'Orders', 'Sales', 'CPC', 'ACOS', 'Adjustment %', 'Bleeding', 'Why']].concat(pa.map(f => [O.PRODUCTS[f.p].label, f.name, f.spend, f.clicks, f.orders, f.sales, f.clicks ? f.cpc : '', f.acos === null ? '' : f.acos, f.pct, f.bleeding ? 'Yes' : 'No', f.reason]))), 'Product Pages');
    XLSX.writeFile(wb, fileName('review')); toast('Downloaded the review file.', 'success');
  };
})();
