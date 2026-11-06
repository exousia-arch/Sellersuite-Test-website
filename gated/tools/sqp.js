// PPCBench SQP Tracker. Comparing is browser only (files are never uploaded); on the Pro plan a small numeric extract
// of the ticked keywords can be saved to the user's own history through /api/sqp/*.
// Compares one search query three ways for the same ASIN and the same dates:
//   market (Brand Analytics Search Query Performance)  vs  your ASIN (same report)  vs  your PPC (bulk file)
// Engine below is pure (runs in node for tests); the UI is at the bottom (browser only).
//
// Facts this relies on (checked against real downloads):
//  - SQP "Click Rate %" / "Purchase Rate %" are per SEARCH, not per click. We compute our own
//    CVR = purchases / clicks and CTR = clicks / impressions from the counts.
//  - A query missing from the report is "below Amazon's threshold", never zero.
//  - Bulk file: Campaign rows + labelled placement rows match Campaign Manager; keyword and search-term
//    rows can carry more clicks (and one unlabelled placement row exists). Both views are offered.
(function (root) {
  'use strict';
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const LOW_CLICKS = 30; // CVR on fewer clicks than this is flagged "low sample"

  const num = v => {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const s = String(v == null ? '' : v).replace(/[^0-9.\-]/g, '');
    const n = parseFloat(s); return isNaN(n) ? 0 : n;
  };
  const div = (a, b) => (b ? a / b : null);
  // Query / keyword key: lowercase, no + " quotes, single spaces.
  const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[+"“”]/g, ' ').replace(/\s+/g, ' ').trim();
  const hnorm = s => String(s == null ? '' : s).replace(/﻿/g, '').trim().toLowerCase();
  const iso = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

  function rates(m) {
    m.ctr = div(m.clicks, m.imp); m.cvr = div(m.orders, m.clicks); m.cpc = div(m.spend || 0, m.clicks); m.acos = div(m.spend || 0, m.sales || 0);
    return m;
  }
  const blank = () => ({ imp: 0, clicks: 0, orders: 0, spend: 0, sales: 0 });
  const addTo = (a, b) => { a.imp += b.imp; a.clicks += b.clicks; a.orders += b.orders; a.spend += b.spend; a.sales += b.sales; return a; };
  const sum = list => rates(list.reduce(addTo, blank()));
  const fromRow = r => ({ imp: num(r.Impressions), clicks: num(r.Clicks), orders: num(r.Orders), spend: num(r.Spend), sales: num(r.Sales) });

  // ------------------------------------------------------------------ SQP report
  // rows = array of arrays (CSV). Row 0 is Amazon's metadata line, row 1 the header.
  const SQP_REQ = { query: 'search query', volume: 'search query volume', mImp: 'impressions: total count', aImp: 'impressions: asin count', mClk: 'clicks: total count', aClk: 'clicks: asin count', mPur: 'purchases: total count', aPur: 'purchases: asin count' };
  const SQP_OPT = { aImpShare: 'impressions: asin share %', aClkShare: 'clicks: asin share %', aPurShare: 'purchases: asin share %', mPrice: 'clicks: price (median)', aPrice: 'clicks: asin price (median)', mCart: 'cart adds: total count', aCart: 'cart adds: asin count' };

  function parseSqp(rows) {
    if (!rows || rows.length < 3) throw new Error('This file has no data rows. Use the ASIN view CSV from Brand Analytics, Search Query Performance.');
    const meta = rows[0].join(',');
    const am = meta.match(/(?:^|[,﻿])\s*ASIN(?:\s+or\s+Product)?\s*=\s*\[?\s*"?([A-Za-z0-9]{10})/i);   // Amazon writes "ASIN=" or "ASIN or Product="
    if (!am) throw new Error('The first line should name the ASIN ("ASIN=…" or "ASIN or Product=…"). Use the ASIN view report, not the Brand view.');
    const rangeM = meta.match(/Reporting Range\s*=\s*\[?\s*"?([A-Za-z]+)/i);
    const range = rangeM ? rangeM[1].toLowerCase() : '';
    let from, to;
    if (range === 'weekly') {
      const w = meta.match(/(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/);
      if (!w) throw new Error('Could not read the week from the first line of the report.');
      from = w[1]; to = w[2];
    } else if (range === 'monthly') {
      const y = meta.match(/Select year\s*=\s*\[?\s*"?(\d{4})/i), mo = meta.match(/Select month\s*=\s*\[?\s*"?([A-Za-z]+)/i);
      const mi = mo ? MONTHS.indexOf(mo[1].toLowerCase()) : -1;
      if (!y || mi < 0) throw new Error('Could not read the month from the first line of the report.');
      from = iso(+y[1], mi, 1); to = iso(+y[1], mi + 1, 0);
    } else throw new Error('Only Weekly and Monthly reports are supported (this one says "' + (range || 'unknown') + '").');

    const header = rows[1].map(hnorm), col = {};
    for (const k in SQP_REQ) { col[k] = header.indexOf(SQP_REQ[k]); }
    const missing = Object.keys(SQP_REQ).filter(k => col[k] < 0).map(k => SQP_REQ[k]);
    if (missing.length) throw new Error('Missing column(s): ' + missing.join(', ') + '. Only English-language SQP reports are supported for now.');
    for (const k in SQP_OPT) col[k] = header.indexOf(SQP_OPT[k]);
    const g = (r, k) => (col[k] >= 0 ? num(r[col[k]]) : null);

    const queries = new Map(), list = []; let blank_ = 0, dup = 0;
    for (let i = 2; i < rows.length; i++) {
      const r = rows[i], q = String(r[col.query] == null ? '' : r[col.query]).trim(), key = norm(q);
      if (!key) { blank_++; continue; }
      if (queries.has(key)) { dup++; continue; }
      const rec = {
        query: q, key, volume: g(r, 'volume'),
        market: rates({ imp: g(r, 'mImp'), clicks: g(r, 'mClk'), orders: g(r, 'mPur'), spend: 0, sales: 0 }),
        asin: rates({ imp: g(r, 'aImp'), clicks: g(r, 'aClk'), orders: g(r, 'aPur'), spend: 0, sales: 0 }),
        share: { imp: g(r, 'aImpShare'), click: g(r, 'aClkShare'), purchase: g(r, 'aPurShare') },
        price: { market: col.mPrice >= 0 && r[col.mPrice] !== '' ? g(r, 'mPrice') : null, asin: col.aPrice >= 0 && r[col.aPrice] !== '' ? g(r, 'aPrice') : null }
      };
      queries.set(key, rec); list.push(rec);
    }
    if (!list.length) throw new Error('No search queries found in this report.');
    return { asin: am[1].toUpperCase(), range, from, to, queries, list, skippedBlank: blank_, duplicates: dup };
  }

  // ------------------------------------------------------------------ bulk file
  // campRows / termRows = arrays of header-keyed objects (SheetJS sheet_to_json).
  const BULK_REQ = ['Entity', 'Campaign ID', 'Impressions', 'Clicks', 'Orders', 'Spend', 'Sales'];
  const bucket = p => { const s = String(p || '').toLowerCase(); return !s ? 'other' : s.includes('top') ? 'top' : s.includes('rest') ? 'rest' : s.includes('product') ? 'product' : s.includes('business') ? 'business' : 'other'; };
  const PLACEMENTS = ['top', 'rest', 'product', 'business', 'other'];
  const cname = r => String(r['Campaign Name (Informational only)'] || r['Campaign Name'] || '');

  function datesFromName(name) {
    const m = String(name || '').match(/(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})/);
    return m ? { from: `${m[1]}-${m[2]}-${m[3]}`, to: `${m[4]}-${m[5]}-${m[6]}` } : null;
  }

  function buildBulk(campRows, termRows, fileName) {
    if (!campRows || !campRows.length) throw new Error('The "Sponsored Products Campaigns" sheet is empty or missing.');
    const have = Object.keys(campRows[0]);
    const lack = BULK_REQ.filter(c => !have.includes(c));
    if (lack.length) throw new Error('Missing column(s) in the bulk file: ' + lack.join(', ') + '. Tick Sponsored Products data and Performance data when downloading.');
    const camps = new Map(), get = id => { if (!camps.has(id)) camps.set(id, { id, name: '', asins: new Set(), row: null, placements: {}, keywords: [] }); return camps.get(id); };
    let currency = '', hasPlacementRows = false;
    for (const r of campRows) {
      const id = String(r['Campaign ID'] || ''); if (!id) continue;
      const c = get(id), ent = String(r.Entity || '').trim().toLowerCase();
      if (!c.name && cname(r)) c.name = cname(r);
      if (!currency) currency = String(r.Currency || r['Currency Code'] || '').trim();
      if (ent === 'campaign') c.row = rates(fromRow(r));
      else if (ent === 'bidding adjustment') { hasPlacementRows = true; const b = bucket(r.Placement); c.placements[b] = addTo(c.placements[b] || blank(), fromRow(r)); }
      else if (ent === 'keyword') c.keywords.push({ text: norm(r['Keyword Text']), match: String(r['Match Type'] || '').toLowerCase(), m: rates(fromRow(r)) });
      else if (ent === 'product ad') { const a = String(r['ASIN (Informational only)'] || r.ASIN || '').trim().toUpperCase(); if (a) c.asins.add(a); }
    }
    const terms = [];
    for (const r of termRows || []) {
      const id = String(r['Campaign ID'] || ''), t = norm(r['Customer Search Term']); if (!id || !t) continue;
      terms.push({ id, term: t, m: fromRow(r) });
    }
    return { camps, terms, currency: currency || '', hasPlacementRows, hasTerms: !!(termRows && termRows.length), fileName: fileName || '', dates: datesFromName(fileName) };
  }

  // Campaigns that advertise this ASIN (via their product ads; falls back to the ASIN in the name).
  function asinCampaigns(bulk, asin) {
    const out = [], any = Array.from(bulk.camps.values()).some(c => c.asins.size);
    for (const c of bulk.camps.values()) if (any ? c.asins.has(asin) : c.name.toUpperCase().includes(asin)) out.push(c.id);
    return out;
  }
  // Suggested ranking campaigns for a query: this ASIN's campaigns with "rank" in the name that target that keyword.
  // loose = the keyword is one the user nominated as a ranking keyword: if no "rank" campaign matches, any campaign of this
  // ASIN that targets exactly that keyword is suggested instead (the name does not have to say "rank").
  function suggestRanking(bulk, asin, key, loose) {
    const ids = asinCampaigns(bulk, asin), targets = c => c.keywords.some(k => k.text === key);
    const strict = ids.filter(id => {
      const c = bulk.camps.get(id); if (!/rank/i.test(c.name)) return false;
      // the campaign must target exactly this keyword; with no keyword rows, the exact quoted phrase in its name counts
      return c.keywords.length ? targets(c) : c.name.toLowerCase().includes('"' + key + '"');
    });
    return strict.length || !loose ? strict : ids.filter(id => targets(bulk.camps.get(id)));
  }

  // The SQP week/month and the bulk download must cover the same dates.
  function periodCheck(sqp, bulk) {
    const d = bulk && bulk.dates;
    if (!d) return { status: 'unknown', note: 'The bulk file name carries no dates, so I cannot check it. Make sure it covers ' + sqp.from + ' to ' + sqp.to + ' exactly.' };
    if (d.from === sqp.from && d.to === sqp.to) return { status: 'match', note: 'Bulk file dates match the SQP report (' + sqp.from + ' to ' + sqp.to + ').' };
    return { status: 'mismatch', note: 'Dates differ. SQP covers ' + sqp.from + ' to ' + sqp.to + ' but the bulk file name says ' + d.from + ' to ' + d.to + '. Comparing different periods will mislead.' };
  }

  // ------------------------------------------------------------------ Helium 10 Cerebro (optional organic rank)
  // A Cerebro rank is a SNAPSHOT of the day the report was run, not an average over the SQP period. "-" (not found in the
  // first ~300 results) is stored as 0 = not ranked; a keyword that is not in the file is unknown (null), never 0.
  function parseCerebro(rows, fileName) {
    if (!rows || !rows.length) throw new Error('This Cerebro report has no rows.');
    const heads = Object.keys(rows[0]), col = re => heads.find(h => re.test(hnorm(h)));
    const kc = col(/^keyword phrase$/), oc = col(/^organic rank$/), sc = col(/^sponsored rank$/), vc = col(/^search volume$/);
    if (!kc || !oc) throw new Error('Missing column "Keyword Phrase" or "Organic Rank". Export the keywords from Cerebro as CSV with the rank columns.');
    const rank = v => { const n = num(v); return n >= 1 ? Math.round(n) : 0; };
    const ranks = new Map();
    rows.forEach(r => { const k = norm(r[kc]); if (k) ranks.set(k, { organic: rank(r[oc]), sponsored: sc ? rank(r[sc]) : null, volume: vc ? num(r[vc]) : null }); });
    if (!ranks.size) throw new Error('This Cerebro report has no keywords.');
    const m = String(fileName || '').match(/cerebro_([A-Z0-9]{10})_(\d{4}-\d{2}-\d{2})/i);   // US_AMAZON_cerebro_<ASIN>_<date>.csv
    return { ranks, asin: m ? m[1].toUpperCase() : null, date: m ? m[2] : null, fileName: fileName || '' };
  }
  // Is this Cerebro report usable with this SQP report? A report for another ASIN is ignored (its ranks would be wrong).
  function cerebroCheck(sqp, cer) {
    if (!cer) return null;
    if (cer.asin && cer.asin !== sqp.asin) return { status: 'asin', note: 'This Cerebro report is for ' + cer.asin + ' but the SQP report is for ' + sqp.asin + ', so the ranks are not used.' };
    if (!cer.date) return { status: 'unknown', note: 'The Cerebro file name carries no date, so I cannot say when these ranks were taken.' };
    const days = (Date.parse(cer.date) - Date.parse(sqp.to)) / 864e5;
    if (Date.parse(cer.date) < Date.parse(sqp.from)) return { status: 'early', note: 'The Cerebro ranks were taken on ' + cer.date + ', before this period began (' + sqp.from + '). They show where you ranked on that day only.' };
    if (days > 7) return { status: 'late', note: 'The Cerebro ranks were taken on ' + cer.date + ', ' + Math.round(days) + ' days after this period ended. They show where you rank on that day, not during the period.' };
    return { status: 'ok', note: 'Cerebro ranks taken on ' + cer.date + '.' };
  }
  const dnum = s => +String(s).replace(/-/g, ''), dstr = n => { const s = String(n); return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); };

  const manualRates = m => (m && m.clicks != null && m.orders != null ? rates({ imp: null, clicks: m.clicks, orders: m.orders, spend: 0, sales: 0 }) : null);

  // ------------------------------------------------------------------ comparison
  // opts: { basis: 'cm' (campaign + placement rows) | 'term' (exact search-term rows), overlay: bool, rankIds: [] }
  function compare(sqp, bulk, query, opts) {
    opts = opts || {};
    const key = norm(query), rec = sqp.queries.get(key) || null, basis = opts.basis === 'term' ? 'term' : 'cm';
    const rankIds = (opts.rankIds || []).filter(id => bulk.camps.has(id)), rankSet = new Set(rankIds);
    const asinSet = new Set(asinCampaigns(bulk, sqp.asin));
    const rowsOf = (set) => bulk.terms.filter(t => set.has(t.id) && t.term === key).map(t => t.m);

    const cm = rankIds.length ? sum(rankIds.map(id => bulk.camps.get(id).row).filter(Boolean)) : null;
    const term = rankIds.length ? sum(rowsOf(rankSet)) : null;
    const kw = rankIds.length ? sum([].concat(...rankIds.map(id => bulk.camps.get(id).keywords.filter(k => k.text === key).map(k => k.m)))) : null;
    const ranking = rankIds.length ? (basis === 'cm' ? cm : term) : null;
    const allppc = opts.overlay ? sum(rowsOf(asinSet)) : null;

    const pl = {};
    PLACEMENTS.forEach(p => { pl[p] = sum(rankIds.map(id => bulk.camps.get(id).placements[p]).filter(Boolean)); });
    const labelled = sum(['top', 'rest', 'product', 'business'].map(p => pl[p]));
    const placements = rankIds.length ? { rows: pl, labelled, total: sum(PLACEMENTS.map(p => pl[p])) } : null;

    const market = rec ? rec.market : null, asin = rec ? rec.asin : null;
    // manual = clicks and orders the user read from Campaign Manager for the ranking campaign(s): kept apart from the bulk file to show the gap
    const mn = manualRates(opts.manual);
    // the campaign the typed numbers are for (picked in the manual check); without one they are compared with the ranking campaigns above
    const mc = mn && opts.manual.camp ? bulk.camps.get(opts.manual.camp) : null;
    const manualBulk = mc ? { id: mc.id, name: mc.name, cm: sum(mc.row ? [mc.row] : []), term: sum(bulk.terms.filter(t => t.id === mc.id).map(t => t.m)) } : null;
    const cr = opts.cerebro && opts.cerebro.ranks.get(key), rank = cr ? { organic: cr.organic, sponsored: cr.sponsored, volume: cr.volume, date: opts.cerebro.date } : null;
    const idx = (m) => (m && market && m.cvr != null && market.cvr ? m.cvr / market.cvr : null);
    const flags = [];
    if (!rec) flags.push('missingSqp');
    if (ranking && ranking.clicks < LOW_CLICKS) flags.push('lowSample');
    if (mn && mn.orders > mn.clicks) flags.push('manualOdd');
    if (rec && [ranking, allppc].some(m => m && asin && m.clicks > asin.clicks)) flags.push('ppcExceedsAsin');
    if (rankIds.some(id => bulk.camps.get(id).keywords.length > 1)) flags.push('multiKeyword');
    if (rankIds.some(id => bulk.camps.get(id).keywords.some(k => k.text === key && k.match !== 'exact'))) flags.push('variants');
    return {
      query: rec ? rec.query : String(query), key, volume: rec ? rec.volume : null, share: rec ? rec.share : null, price: rec ? rec.price : null,
      market, asin, ranking, allppc, rankIds, placements, basis, rank, manual: mn, manualBulk,
      recon: rankIds.length ? { cm, term, kw } : null,
      index: { asin: idx(asin), ranking: idx(ranking), allppc: idx(allppc), manual: idx(mn) }, flags
    };
  }

  // ------------------------------------------------------------------ campaign level
  // A tracked campaign instead of a keyword: its campaign row and labelled placement rows (the Campaign Manager view) and the sum
  // of its search-term rows. No market or ASIN line: SQP is per search query, not per campaign.
  const campKey = id => 'campaign:' + String(id).toLowerCase();   // stored in place of a keyword; the id survives a rename
  function compareCampaign(bulk, id, opts) {
    opts = opts || {};
    const camp = bulk.camps.get(id); if (!camp) return null;
    const basis = opts.basis === 'term' ? 'term' : 'cm';
    const cm = sum(camp.row ? [camp.row] : []), term = sum(bulk.terms.filter(t => t.id === id).map(t => t.m)), kw = sum(camp.keywords.map(k => k.m));
    const pl = {}; PLACEMENTS.forEach(p => { pl[p] = sum([camp.placements[p]].filter(Boolean)); });
    const placements = { rows: pl, labelled: sum(['top', 'rest', 'product', 'business'].map(p => pl[p])), total: sum(PLACEMENTS.map(p => pl[p])) };
    const mn = manualRates(opts.manual), ranking = basis === 'cm' ? cm : term, flags = [];
    if (ranking.clicks < LOW_CLICKS) flags.push('lowSample');
    if (mn && mn.orders > mn.clicks) flags.push('manualOdd');
    return { query: camp.name, key: campKey(id), campaign: true, id, volume: null, share: null, price: null, market: null, asin: null, ranking, allppc: null, rankIds: [id], placements, basis, rank: null, manual: mn, manualBulk: { id, name: camp.name, cm, term },
      recon: { cm, term, kw }, index: { asin: null, ranking: null, allppc: null, manual: null }, flags };
  }

  // ------------------------------------------------------------------ synthetic sample (no real data)
  function sample() {
    const A = 'B0SAMPLE01';
    // [query, volume, marketImpressions, marketClicks, marketPurchases, asinImpressions, asinClicks, asinPurchases]
    const q = [['blue widget set', 1200, 52000, 780, 30, 2400, 18, 1], ['blue widget', 3000, 90000, 1500, 52, 4000, 60, 2],
      ['widget organizer', 800, 30000, 500, 18, 1200, 15, 0], ['red widget', 600, 20000, 220, 4, 900, 14, 0],
      ['widget storage box', 400, 15000, 180, 5, 700, 9, 0], ['cheap widgets', 900, 25000, 260, 7, 1100, 16, 1]];
    const sqpRows = [['ASIN or Product=["' + A + '"]', 'Reporting Range=["Weekly"]', 'Select week=["Week 41 | 2026-10-04 - 2026-10-10 2026"]'],
      ['Search Query', 'Search Query Score', 'Search Query Volume', 'Impressions: Total Count', 'Impressions: ASIN Count', 'Impressions: ASIN Share %', 'Clicks: Total Count', 'Clicks: Click Rate %', 'Clicks: ASIN Count', 'Clicks: ASIN Share %', 'Clicks: Price (Median)', 'Clicks: ASIN Price (Median)', 'Purchases: Total Count', 'Purchases: Purchase Rate %', 'Purchases: ASIN Count', 'Purchases: ASIN Share %']];
    q.forEach(([s, vol, mi, mc, mp, ai, ac, ap]) => sqpRows.push([s, '50', String(vol), String(mi), String(ai), '5.0', String(mc), '40', String(ac), '3', '24.99', '27.99', String(mp), '1.5', String(ap), '2']));
    sqpRows.push(['', '60', '999999', '5000000', '900', '0', '100000', '10', '8', '0', '9', '30', '4000', '0.3', '0', '0']);
    const E = (id, name) => ({ Entity: 'Campaign', 'Campaign ID': id, 'Campaign Name (Informational only)': name });
    const row = (o, m) => Object.assign({}, o, { Impressions: m[0], Clicks: m[1], Orders: m[2], Spend: m[3], Sales: m[4] });
    const camp = [];
    const add = (id, name, asins, kws, cm, pls, extra) => {
      camp.push(row(E(id, name), cm));
      asins.forEach(a => camp.push({ Entity: 'Product Ad', 'Campaign ID': id, 'ASIN (Informational only)': a, 'Campaign Name (Informational only)': name }));
      kws.forEach(([t, mt, m]) => camp.push(row({ Entity: 'Keyword', 'Campaign ID': id, 'Keyword Text': t, 'Match Type': mt, 'Campaign Name (Informational only)': name }, m)));
      Object.keys(pls).forEach(p => camp.push(row({ Entity: 'Bidding Adjustment', 'Campaign ID': id, Placement: p, 'Campaign Name (Informational only)': name }, pls[p])));
      if (extra) camp.push(row({ Entity: 'Bidding Adjustment', 'Campaign ID': id, Placement: '', 'Campaign Name (Informational only)': name }, extra));
    };
    add('c1', 'SP-Exact-' + A + '-"blue widget set"-Rank', [A], [['blue widget set', 'Exact', [9000, 120, 6, 90, 300]]], [8900, 118, 6, 88, 300],
      { 'Placement Top': [6000, 90, 5, 70, 250], 'Placement Rest Of Search': [2500, 25, 1, 17, 50], 'Placement Product Page': [400, 3, 0, 1, 0], 'Placement Amazon Business': [0, 0, 0, 0, 0] });
    add('c2', 'SP_' + A + '_KW_PHRASE_RANK_ "blue widget"', [A], [['blue widget', 'Phrase', [20000, 300, 9, 250, 450]]], [14000, 200, 9, 160, 450],
      { 'Placement Top': [9000, 150, 7, 120, 350], 'Placement Rest Of Search': [4000, 40, 2, 38, 100], 'Placement Product Page': [900, 8, 0, 2, 0] }, [5000, 100, 0, 90, 0]);
    add('c3', 'SP-AUTO-' + A + '-Catch', [A], [], [30000, 400, 12, 300, 600], {});
    add('c4', 'SP-Exact-B0OTHERASN-"blue widget set"-Rank', ['B0OTHERASN'], [['blue widget set', 'Exact', [100, 5, 0, 5, 0]]], [100, 5, 0, 5, 0], {});
    const T = (id, term, m) => row({ 'Campaign ID': id, 'Customer Search Term': term }, m);
    const terms = [T('c1', 'blue widget set', [9000, 120, 6, 90, 300]), T('c2', 'blue widget', [12000, 180, 8, 140, 400]), T('c2', 'blue widget cheap', [8000, 120, 1, 110, 50]),
      T('c3', 'blue widget set', [3000, 40, 2, 30, 90]), T('c3', 'blue widget', [4000, 60, 3, 45, 120]), T('c4', 'blue widget set', [100, 5, 0, 5, 0])];
    return { sqpRows, campRows: camp, termRows: terms, fileName: 'bulk-sample-20261004-20261010-1.xlsx', asin: A };
  }

  // ------------------------------------------------------------------ saved history (phase 2)
  // Only this small numeric extract of the TRACKED keywords is ever sent for saving: counts, spend, sales, shares,
  // prices and the names of the ranking campaigns. The shape matches what the database accepts (sqp_valid).
  const MAX_KEYWORDS = 50, MAX_RANK = 10, YOUNG_DAYS = 14;   // PPC orders keep arriving for up to 14 days (attribution window)
  const r4 = v => Math.round(v * 1e4) / 1e4;
  function pick(m, keys) {
    if (!m) return undefined;
    const o = {}; keys.forEach(k => { if (m[k] != null && isFinite(m[k])) o[k] = r4(m[k]); });
    return o;
  }
  const compact = o => { Object.keys(o).forEach(k => { if (o[k] === undefined) delete o[k]; }); return o; };
  const COUNTS = ['imp', 'clicks', 'orders'], MONEY = ['imp', 'clicks', 'orders', 'spend', 'sales'], PLK = ['imp', 'clicks', 'orders', 'spend'];

  // One tracked keyword -> the record stored for the period. Both ranking bases and the all-PPC line are kept
  // whatever the on-screen switches say, so the History tab can show either later.
  function snapshot(sqp, bulk, key, rankIds, cerebro, manual) {
    const ids = (rankIds || []).filter(id => bulk.camps.has(id)).slice(0, MAX_RANK);
    const c = compare(sqp, bulk, sqp.queries.has(key) ? sqp.queries.get(key).query : key, { basis: 'cm', overlay: true, rankIds: ids, cerebro, manual });
    const pl = {};
    if (c.placements) PLACEMENTS.forEach(k => { const m = c.placements.rows[k]; if (m && (m.imp || m.clicks)) pl[k] = pick(m, PLK); });
    const data = compact({
      volume: c.volume == null ? undefined : r4(c.volume),
      price: c.price ? { market: c.price.market, asin: c.price.asin } : undefined,
      share: c.share ? { imp: c.share.imp, click: c.share.click, purchase: c.share.purchase } : undefined,
      market: pick(c.market, COUNTS), asin: pick(c.asin, COUNTS),
      cm: c.recon ? pick(c.recon.cm, MONEY) : undefined, term: c.recon ? pick(c.recon.term, MONEY) : undefined,
      allppc: pick(c.allppc, MONEY), pl: Object.keys(pl).length ? pl : undefined,
      rank: c.rank ? compact({ organic: c.rank.organic, sponsored: c.rank.sponsored == null ? undefined : c.rank.sponsored, volume: c.rank.volume == null || !isFinite(c.rank.volume) ? undefined : r4(c.rank.volume), date: c.rank.date ? dnum(c.rank.date) : undefined }) : undefined,
      manual: c.manual ? { clicks: c.manual.clicks, orders: c.manual.orders } : undefined
    });
    // the ranking campaigns; the one the typed manual numbers are for is flagged (added, flagged notRank, when it is not a ranking campaign)
    const entries = ids.map(id => ({ id: String(id).slice(0, 40), name: String(bulk.camps.get(id).name).slice(0, 80) }));
    if (c.manualBulk) { const mid = String(c.manualBulk.id).slice(0, 40), e = entries.find(x => x.id === mid); if (e) e.manual = 1; else if (entries.length < MAX_RANK) entries.push({ id: mid, name: String(c.manualBulk.name).slice(0, 80), manual: 1, notRank: 1 }); }
    return { query: c.key, display: String(c.query).slice(0, 200), ranking: entries, data };
  }

  // The campaigns saved together with the keywords: the ones ticked, plus (when asked) every ranking campaign of a tracked keyword,
  // so each related campaign can be viewed on its own in Saved history. No duplicates, only campaigns that are in the bulk file.
  function saveCampaignIds(bulk, tracked, rank, camps, split) {
    const all = (camps || []).concat(split ? tracked.slice(0, MAX_KEYWORDS).flatMap(k => rank[k] || []) : []);
    return all.filter((id, i) => bulk.camps.has(id) && all.indexOf(id) === i);
  }

  // One tracked campaign -> the record stored for the period (a keyword row whose query is campaign:<id>, no SQP numbers).
  function snapshotCampaign(bulk, id, manual) {
    const c = compareCampaign(bulk, id, { manual }), pl = {};
    PLACEMENTS.forEach(k => { const m = c.placements.rows[k]; if (m && (m.imp || m.clicks)) pl[k] = pick(m, PLK); });
    return { query: c.key, display: String(c.query).slice(0, 200), ranking: [{ id: String(id).slice(0, 40), name: String(c.query).slice(0, 80) }],
      data: compact({ cm: pick(c.recon.cm, MONEY), term: pick(c.recon.term, MONEY), pl: Object.keys(pl).length ? pl : undefined, manual: c.manual ? { clicks: c.manual.clicks, orders: c.manual.orders } : undefined }) };
  }

  // The bulk file name ends with the download time in ms: bulk-<id>-YYYYMMDD-YYYYMMDD-<ms>.xlsx
  function pulledFromName(name) {
    const m = String(name || '').match(/-(\d{13})\.xlsx$/i), t = m ? +m[1] : 0;
    return t > 1e12 && t < 4e12 ? new Date(t).toISOString() : null;
  }
  // Everything the save endpoint takes for one SQP + bulk pair.
  function savePayload(sqp, bulk, tracked, rank, brand, bulkName, cerebro, manual, camps, split) {
    return {
      brand: String(brand).trim(), asin: sqp.asin, cadence: sqp.range === 'monthly' ? 'monthly' : 'weekly', from: sqp.from, to: sqp.to,
      pulled: pulledFromName(bulkName), keywords: tracked.slice(0, MAX_KEYWORDS).map(k => snapshot(sqp, bulk, k, rank[k] || [], cerebro, manual && manual[k]))
        .concat(saveCampaignIds(bulk, tracked, rank, camps, split).map(id => snapshotCampaign(bulk, id, manual && manual[campKey(id)]))).slice(0, MAX_KEYWORDS)
    };
  }

  // Stored record -> the same shape compare() gives, with rates recomputed from the counts.
  const restore = m => (m ? rates({ imp: m.imp || 0, clicks: m.clicks || 0, orders: m.orders || 0, spend: m.spend || 0, sales: m.sales || 0 }) : null);
  // history = response of sqp_history; one point per saved period (oldest first). A period where the keyword was not
  // saved is a gap (missing), never a zero. young = PPC numbers pulled less than 14 days after the period ended.
  function series(history, keywordId, basis) {
    const byPeriod = new Map();
    (history.rows || []).forEach(r => { if (r.k === keywordId) byPeriod.set(r.p, r.d); });
    return (history.periods || []).map(p => {
      const d = byPeriod.get(p.id), young = !!(p.pulled && Date.parse(p.pulled) - Date.parse(p.to + 'T23:59:59Z') < YOUNG_DAYS * 864e5);
      if (!d) return { id: p.id, from: p.from, to: p.to, missing: true, young };
      const pl = {}; PLACEMENTS.forEach(k => { if (d.pl && d.pl[k]) pl[k] = restore(d.pl[k]); });
      const rk = d.rank ? { organic: d.rank.organic == null ? null : d.rank.organic, sponsored: d.rank.sponsored == null ? null : d.rank.sponsored, volume: d.rank.volume == null ? null : d.rank.volume, date: d.rank.date ? dstr(d.rank.date) : null } : null;
      return { id: p.id, from: p.from, to: p.to, missing: false, young, rank: rk, manual: d.manual ? restore({ clicks: d.manual.clicks, orders: d.manual.orders }) : null, volume: d.volume == null ? null : d.volume, price: d.price || null, share: d.share || null,
        market: restore(d.market), asin: restore(d.asin), ranking: restore(basis === 'term' ? d.term : d.cm), allppc: restore(d.allppc), pl };
    });
  }
  // A keyword's series with ONE related campaign in its "ranking" line: market, ASIN, volume and rank stay the keyword's, ranking and manual
  // are the campaign's own. Both series come from the same periods, so they line up by position.
  function mergeCampaign(kwPts, campPts) {
    return kwPts.map((k, i) => {
      const c = campPts[i];
      if (!c || c.missing) return Object.assign({}, k, { ranking: null, manual: null });
      return Object.assign({}, k, { missing: false, young: c.young, ranking: c.ranking, manual: c.manual });
    });
  }
  // The next period that should be uploaded after the newest saved one (weekly: +7 days; monthly: next calendar month), for the back-fill hint.
  function nextPeriod(periods, cadence) {
    if (!periods.length) return null;
    const last = periods[periods.length - 1].from, t = Date.parse(last + 'T00:00:00Z');
    if (cadence === 'weekly') return new Date(t + 7 * 864e5).toISOString().slice(0, 10);
    const d = new Date(t); return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }

  const api = { norm, num, parseSqp, buildBulk, asinCampaigns, suggestRanking, periodCheck, parseCerebro, cerebroCheck, compare, compareCampaign, campKey, sample, datesFromName, sum, PLACEMENTS, LOW_CLICKS, snapshot, savePayload, saveCampaignIds, mergeCampaign, pulledFromName, series, nextPeriod, MAX_KEYWORDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SQP = api;
})(typeof window !== 'undefined' ? window : globalThis);

// ============================== UI (browser only) ==============================
if (typeof document !== 'undefined') (function () {
  'use strict';
  const S = window.SQP, $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  const st = { isSample: false, sqp: null, bulk: null, sqpName: '', bulkName: '', tracked: [], rank: {}, basis: 'cm', overlay: false, cerebro: null, cerebroRaw: null, manual: {}, camps: [], campIds: [], files: { sqp: null, bulk: null, cerebro: null } };
  const cur = () => (st.bulk && st.bulk.currency ? ({ USD: '$', GBP: '£', EUR: '€', CAD: 'CA$', AUD: 'A$', MXN: 'MX$', JPY: '¥', INR: '₹' }[st.bulk.currency] || st.bulk.currency + ' ') : '$');
  const money = v => (v == null ? '–' : cur() + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const int = v => (v == null ? '–' : Math.round(v).toLocaleString('en-US'));
  const pct = (v, d) => (v == null ? '–' : (v * 100).toFixed(d == null ? 1 : d) + '%');
  const TH = 'px-3 py-2 text-right whitespace-nowrap', THL = 'px-3 py-2 text-left whitespace-nowrap', HEAD = 'bg-slate-50 text-slate-500 text-[10px] font-bold uppercase tracking-wider';
  const C = { market: '#94a3b8', asin: '#c2410c', ranking: '#2563eb', allppc: '#7dd3fc', manual: '#475569' };
  const FLAGS = {
    missingSqp: ['Not in SQP top list', 'bg-slate-100 text-slate-700', 'This query is not in the report (Amazon lists only the top queries). It is missing, not zero.'],
    lowSample: ['Low sample', 'bg-amber-100 text-amber-800', 'Fewer than ' + S.LOW_CLICKS + ' ad clicks: the conversion rate can swing a lot on a few orders.'],
    ppcExceedsAsin: ['Counts differ', 'bg-slate-100 text-slate-700', 'Ad clicks are higher than your ASIN\'s clicks in SQP. The two reports do not count the same way, so compare the rates, not the volumes.'],
    multiKeyword: ['Campaign has several keywords', 'bg-slate-100 text-slate-700', 'Campaign-level numbers and placements include every keyword in the campaign.'],
    manualOdd: ['Manual: orders above clicks', 'bg-slate-100 text-slate-700', 'The orders you typed are higher than the clicks. Check the numbers (orders can exceed clicks only when one click leads to several orders).'],
    variants: ['Phrase/broad match', 'bg-slate-100 text-slate-700', 'The campaign can match variants of the keyword. The search-term view isolates the exact query.']
  };
  const jsq = s => esc(String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));   // for a string inside an inline onclick="f('...')"
  const chip = k => '<span class="text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 ' + FLAGS[k][1] + '" title="' + esc(FLAGS[k][2]) + '">' + FLAGS[k][0] + '</span>';

  // ---- enlarge a chart: its card fills the window (the Enlarge button toggles it, Esc closes it)
  let zoomed = null;
  function zoom(card, on) {
    if (on && zoomed && zoomed !== card) zoom(zoomed, false);
    const btn = card.querySelector('[data-zoom]'), cv = card.querySelector('canvas'), ch = _dashCharts[cv.id], title = card.querySelector('h3').textContent;
    card.classList.toggle('sq-zoom', on); card.classList.toggle('bg-white', on);   // bg-white follows the dark theme
    btn.textContent = on ? 'Close' : 'Enlarge'; btn.setAttribute('aria-expanded', on ? 'true' : 'false'); btn.setAttribute('aria-label', (on ? 'Close the enlarged ' : 'Enlarge the ') + title + ' chart');
    if (ch) { ['x', 'y'].forEach(a => { const t = ch.options.scales[a].ticks; t.font = Object.assign({}, t.font, { size: on ? 12 : 10 }); }); ch.options.plugins.legend.labels = { font: { size: on ? 13 : 12 } }; ch.data.datasets.forEach(d => { if (d.maxBarThickness) d.maxBarThickness = on ? 44 : 26; }); ch.resize(); ch.update('none'); }
    zoomed = on ? card : null; if (on) btn.focus();
  }
  const closeZoom = () => { if (zoomed) zoom(zoomed, false); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && zoomed) { const b = zoomed.querySelector('[data-zoom]'); zoom(zoomed, false); b.focus(); } });
  document.querySelectorAll('canvas[id^="sqChart"], canvas[id^="sqHChart"]').forEach(cv => {
    const card = cv.parentElement.parentElement, h = card.querySelector('h3'), row = document.createElement('div'), b = document.createElement('button');
    row.className = 'flex items-center justify-between gap-2 mb-2'; h.classList.remove('mb-2');
    b.type = 'button'; b.setAttribute('data-zoom', ''); b.className = 'text-[11px] font-semibold text-slate-500 hover:text-slate-800 shrink-0'; b.textContent = 'Enlarge'; b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-label', 'Enlarge the ' + h.textContent + ' chart');
    b.onclick = () => zoom(card, !card.classList.contains('sq-zoom'));
    h.before(row); row.append(h, b);
  });

  // ---- files
  const sqIn = $('sqSqpFile'), buIn = $('sqBulkFile');
  const ceIn = $('sqCerebroFile');
  makeDropTarget($('sqSqpZone'), sqIn); makeDropTarget($('sqBulkZone'), buIn); makeDropTarget($('sqCerebroZone'), ceIn);
  sqIn.addEventListener('change', () => { st.files.sqp = sqIn.files[0] || null; names(); });
  buIn.addEventListener('change', () => { st.files.bulk = buIn.files[0] || null; names(); });
  ceIn.addEventListener('change', () => { st.files.cerebro = ceIn.files[0] || null; names(); });
  function names() { $('sqSqpName').textContent = st.files.sqp ? st.files.sqp.name : ''; $('sqBulkName').textContent = st.files.bulk ? st.files.bulk.name : ''; $('sqCerebroName').textContent = st.files.cerebro ? st.files.cerebro.name : ''; matchNote(); }
  // As soon as both files are chosen, say whether they cover the same dates (SQP dates from inside the report, bulk dates from its file name).
  let matchSeq = 0;
  async function matchNote() {
    const box = $('sqMatch'), seq = ++matchSeq; box.innerHTML = '';
    if (!st.files.sqp || !st.files.bulk) return;
    let sqp; try { sqp = S.parseSqp(Papa.parse((await readText(st.files.sqp)).replace(/^﻿/, ''), { skipEmptyLines: true }).data); } catch (e) { return; }   // a bad file is reported by Compare
    if (seq !== matchSeq) return;
    const pc = S.periodCheck(sqp, { dates: S.datesFromName(st.files.bulk.name) }), bad = pc.status === 'mismatch', ok = pc.status === 'match';
    box.innerHTML = '<div class="flex gap-2 items-start rounded-xl border p-3 text-xs leading-relaxed ' + (bad ? 'bg-rose-50 border-rose-200 text-rose-900' : ok ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-amber-50 border-amber-200 text-amber-900') + '" role="' + (ok ? 'status' : 'alert') + '"><i data-lucide="' + (ok ? 'check-circle-2' : 'alert-triangle') + '" class="w-4 h-4 shrink-0 mt-0.5"></i><span>' + (ok ? '<b>Dates match.</b> ' : bad ? '<b>Dates do not match.</b> ' : '<b>Cannot confirm the dates.</b> ') + esc(pc.note) + '</span></div>';
    lucide.createIcons();
  }
  const readText = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(f); });
  const readBuf = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(f); });

  function readBulk(buf) {
    const u8 = new Uint8Array(buf), names = XLSX.read(u8, { type: 'array', bookSheets: true }).SheetNames;
    const campName = names.find(n => /^sponsored products campaigns$/i.test(n.trim())), termName = names.find(n => /^sp search term report$/i.test(n.trim()));
    if (!campName) throw new Error('No "Sponsored Products Campaigns" sheet. Download the bulk file with Sponsored Products data ticked.');
    const wb = XLSX.read(u8, { type: 'array', sheets: [campName].concat(termName ? [termName] : []) });
    // Amazon declares these sheets as one row tall (A1:BB1) although the cells are there; widen the range to the real used range.
    const rows = n => {
      const ws = wb.Sheets[n]; let r = 0, c = 0;
      for (const k in ws) { if (k.charCodeAt(0) === 33) continue; const a = XLSX.utils.decode_cell(k); if (a.r > r) r = a.r; if (a.c > c) c = a.c; }
      ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r, c } });
      return XLSX.utils.sheet_to_json(ws, { defval: '' });
    };
    return { camp: rows(campName), term: termName ? rows(termName) : [] };
  }

  window.sqRun = async function () {
    if (!st.files.sqp || !st.files.bulk) { toast('Add both files: the SQP report (.csv) and the bulk file (.xlsx).'); return; }
    const btn = $('sqRunBtn'); btn.disabled = true; btn.innerHTML = '<span class="ppc-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span> Reading…';
    await new Promise(r => setTimeout(r, 30));
    try {
      let sqp, bulk;
      try { sqp = S.parseSqp(Papa.parse((await readText(st.files.sqp)).replace(/^﻿/, ''), { skipEmptyLines: true }).data); } catch (e) { throw new Error('SQP report: ' + e.message); }
      try { const b = readBulk(await readBuf(st.files.bulk)); bulk = S.buildBulk(b.camp, b.term, st.files.bulk.name); } catch (e) { throw new Error('Bulk file: ' + e.message); }
      let cer = null;   // optional Helium 10 Cerebro report: organic rank per keyword
      if (st.files.cerebro) { try { cer = S.parseCerebro(Papa.parse((await readText(st.files.cerebro)).replace(/^\uFEFF/, ''), { header: true, skipEmptyLines: true }).data, st.files.cerebro.name); } catch (e) { throw new Error('Cerebro report: ' + e.message); } }
      st.isSample = false; load(sqp, bulk, st.files.sqp.name, st.files.bulk.name, cer);
    } catch (e) { toast(esc(e.message), 'error'); }
    btn.disabled = false; btn.textContent = 'Compare'; lucide.createIcons();
  };

  window.sqSample = function () {
    const d = S.sample(); st.files = { sqp: null, bulk: null, cerebro: null }; sqIn.value = ''; buIn.value = ''; ceIn.value = ''; names();
    st.isSample = true; load(S.parseSqp(d.sqpRows), S.buildBulk(d.campRows, d.termRows, d.fileName), 'sample SQP report', d.fileName, null);
    toast('Loaded synthetic sample data (not real numbers).', 'success');
  };

  function load(sqp, bulk, sqpName, bulkName, cer) {
    st.cerebroRaw = cer || null; st.cerebro = cer && S.cerebroCheck(sqp, cer).status !== 'asin' ? cer : null;   // a report for another ASIN is not used
    st.sqp = sqp; st.bulk = bulk; st.sqpName = sqpName; st.bulkName = bulkName; st.rank = {}; st.basis = 'cm'; st.overlay = false; st.nom = []; st.nomEdited = false; st.manual = {}; st.camps = []; st.campEdited = false;
    $('sqBasis').value = 'cm'; $('sqOverlay').checked = false; $('sqNom').value = '';
    // default tracked keywords: the queries that have a suggested ranking campaign
    st.tracked = []; sqp.list.forEach(r => { const ids = S.suggestRanking(bulk, sqp.asin, r.key); if (ids.length) { st.rank[r.key] = ids; st.tracked.push(r.key); } });
    $('sqResults').classList.remove('hidden'); render(); if (!st.isSample) window.sqLoadState();
    $('sqResults').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- controls
  window.sqSetup = function () { st.basis = $('sqBasis').value; st.overlay = $('sqOverlay').checked; render(); };
  window.sqToggleKw = function (key, on) { const i = st.tracked.indexOf(key); if (on && i < 0) { st.tracked.push(key); if (!st.rank[key]) st.rank[key] = S.suggestRanking(st.bulk, st.sqp.asin, key); } if (!on && i >= 0) st.tracked.splice(i, 1); render(true); };
  // Ranking keywords the user nominates (one per line): tracked first, with their campaigns matched even when the name has no "rank".
  function setNominated(keys) {
    const old = st.nom; st.nom = keys;
    old.filter(k => !keys.includes(k)).forEach(k => { const i = st.tracked.indexOf(k); if (i >= 0) st.tracked.splice(i, 1); });
    keys.forEach(k => { if (!st.tracked.includes(k)) st.tracked.push(k); if (!(st.rank[k] || []).length) st.rank[k] = S.suggestRanking(st.bulk, st.sqp.asin, k, true); });
    const miss = keys.filter(k => !st.sqp.queries.has(k));
    $('sqNomNote').textContent = keys.length ? keys.length + ' nominated' + (miss.length ? '. Not in this SQP report: ' + miss.join(', ') + ' (shown as missing, not zero).' : '.') : '';
    render(true);
  }
  window.sqNominate = function () {
    st.nomEdited = true;
    const keys = []; $('sqNom').value.split(/\r?\n/).forEach(l => { const k = S.norm(l); if (k && !keys.includes(k)) keys.push(k); });
    setNominated(keys.slice(0, S.MAX_KEYWORDS));
  };
  // Keywords already saved for this ASIN are its ranking keywords: fill the box from them (once, unless the user typed first).
  // Saved entries of this ASIN: the keywords fill the nominated box, the tracked campaigns (campaign:<id>) tick their boxes again.
  function prefillNominated() {
    if (!st.sqp) return;
    const hit = findAsin(st.sqp.asin), saved = hit ? hit.asin.keywords : [], kws = saved.filter(k => !k.query.startsWith('campaign:'));
    if (kws.length && !st.nomEdited && !st.nom.length) { $('sqNom').value = kws.map(k => k.display || k.query).join('\n'); setNominated(kws.map(k => k.query)); }
    const keys = new Set(saved.filter(k => k.query.startsWith('campaign:')).map(k => k.query)), ids = st.campIds.filter(id => keys.has(S.campKey(id)));
    if (ids.length && !st.campEdited && !st.camps.length) { st.camps = ids; render(true); }
  }
  window.sqManual = function (i, which, val) {
    const c = st.rows && st.rows[i]; if (!c) return;
    const m = st.manual[c.key] || (st.manual[c.key] = {}), v = String(val).trim();
    if (which === 'camp') m.camp = st.bulk.camps.has(v) ? v : '';
    else m[which] = v === '' || isNaN(+v) ? null : Math.max(0, Math.min(1e9, Math.round(+v)));
    if (m.clicks == null && m.orders == null && !m.camp) delete st.manual[c.key];
    setTimeout(() => { const id = document.activeElement && document.activeElement.id; render(true); if (/^mn\d/.test(id || '') && $(id)) $(id).focus(); }, 0);   // let a Tab move focus first, then put it back
  };
  window.sqToggleCampaign = function (j, on) { const id = st.campIds[j], i = st.camps.indexOf(id); if (id == null) return; st.campEdited = true; if (on && i < 0) st.camps.push(id); if (!on && i >= 0) st.camps.splice(i, 1); render(true); };
  window.sqToggleCamp = function (key, id, on) { const l = st.rank[key] || (st.rank[key] = []), i = l.indexOf(id); if (on && i < 0) l.push(id); if (!on && i >= 0) l.splice(i, 1); render(true); };
  window.sqFilter = function () {
    const q = S.norm($('sqKwFilter').value);
    document.querySelectorAll('#sqKwList [data-q]').forEach(el => { el.style.display = !q || el.dataset.q.includes(q) ? '' : 'none'; });   // inline style: the .flex class would beat .hidden
  };

  // ---- render
  function render(keepPanel) {
    if (!st.sqp) return;
    const sqp = st.sqp, bulk = st.bulk, pc = S.periodCheck(sqp, bulk), ac = S.asinCampaigns(bulk, sqp.asin);
    $('sqSummary').innerHTML = '<div class="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm"><span><span class="text-[10px] font-bold uppercase tracking-wider text-slate-500 mr-1.5">ASIN</span><b class="ff-mono">' + esc(sqp.asin) + '</b></span>'
      + '<span><span class="text-[10px] font-bold uppercase tracking-wider text-slate-500 mr-1.5">Period</span><b>' + esc(sqp.range) + ' · ' + sqp.from + ' to ' + sqp.to + '</b></span>'
      + '<span><span class="text-[10px] font-bold uppercase tracking-wider text-slate-500 mr-1.5">Queries in report</span><b>' + sqp.list.length + '</b></span>'
      + '<span><span class="text-[10px] font-bold uppercase tracking-wider text-slate-500 mr-1.5">Campaigns for this ASIN</span><b>' + ac.length + '</b></span></div>';
    const warn = [];
    if (pc.status !== 'match') warn.push('<div class="flex gap-2 items-start rounded-xl border p-3 text-xs leading-relaxed ' + (pc.status === 'mismatch' ? 'bg-rose-50 border-rose-200 text-rose-900' : 'bg-amber-50 border-amber-200 text-amber-900') + '" role="alert"><i data-lucide="alert-triangle" class="w-4 h-4 shrink-0 mt-0.5"></i><span>' + esc(pc.note) + '</span></div>');
    else warn.push('<p class="text-[11px] text-slate-500 flex items-center gap-1.5"><i data-lucide="check-circle-2" class="w-3.5 h-3.5 text-emerald-600"></i>' + esc(pc.note) + '</p>');
    if (st.cerebroRaw) { const cc = S.cerebroCheck(sqp, st.cerebroRaw); warn.push(cc.status === 'ok' ? '<p class="text-[11px] text-slate-500 flex items-center gap-1.5"><i data-lucide="check-circle-2" class="w-3.5 h-3.5 text-emerald-600"></i>' + esc(cc.note) + '</p>' : '<div class="flex gap-2 items-start rounded-xl border p-3 text-xs leading-relaxed ' + (cc.status === 'asin' ? 'bg-rose-50 border-rose-200 text-rose-900' : 'bg-amber-50 border-amber-200 text-amber-900') + '" role="alert"><i data-lucide="alert-triangle" class="w-4 h-4 shrink-0 mt-0.5"></i><span>' + esc(cc.note) + '</span></div>'); }
    if (!bulk.hasTerms) warn.push('<div class="flex gap-2 items-start rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"><i data-lucide="alert-triangle" class="w-4 h-4 shrink-0 mt-0.5"></i><span>This bulk file has no <b>SP Search Term Report</b> sheet, so the search-term view and the all-PPC option have no data. Tick <b>Search term data</b> when downloading.</span></div>');
    if (!bulk.hasPlacementRows) warn.push('<div class="flex gap-2 items-start rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"><i data-lucide="alert-triangle" class="w-4 h-4 shrink-0 mt-0.5"></i><span>No placement rows found. Tick <b>Placement data for campaigns</b> when downloading.</span></div>');
    $('sqWarn').innerHTML = warn.join('');

    // keyword picker
    const hasRank = new Set(sqp.list.filter(r => S.suggestRanking(bulk, sqp.asin, r.key).length).map(r => r.key));
    const filter = $('sqKwFilter').value;
    $('sqKwCount').textContent = st.tracked.length + ' selected';
    $('sqKwList').innerHTML = sqp.list.map(r => '<label data-q="' + esc(r.key) + '" class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer text-xs"><input type="checkbox" class="rounded border-slate-300" ' + (st.tracked.includes(r.key) ? 'checked ' : '') + 'onchange="sqToggleKw(\'' + jsq(r.key) + '\',this.checked)"><span class="flex-1 min-w-0 truncate" title="' + esc(r.query) + '">' + esc(r.query) + '</span>' + (st.nom.includes(r.key) || hasRank.has(r.key) ? '<span class="text-[9px] font-bold uppercase tracking-wide text-blue-700 bg-blue-50 rounded px-1 py-0.5">' + (st.nom.includes(r.key) ? 'ranking keyword' : 'ranking campaign') + '</span>' : '') + '<span class="ff-mono text-slate-600 tabular-nums">' + int(r.volume) + '</span></label>').join('');
    if (filter) sqFilter();

    const opts = k => ({ basis: st.basis, overlay: st.overlay, rankIds: st.rank[k] || [], cerebro: st.cerebro, manual: st.manual[k] });
    const order = st.nom.filter(k => st.tracked.includes(k)).concat(st.tracked.filter(k => !st.nom.includes(k)));   // nominated keywords first
    const cids = S.asinCampaigns(bulk, sqp.asin); st.campIds = cids;   // campaigns to track (campaign-level cards after the keywords)
    $('sqCampCount').textContent = st.camps.length + ' selected';
    $('sqCampList').innerHTML = cids.length ? cids.map((id, j) => { const cp = bulk.camps.get(id), m = cp.row; return '<label class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer text-xs"><input type="checkbox" class="rounded border-slate-300" ' + (st.camps.includes(id) ? 'checked ' : '') + 'onchange="sqToggleCampaign(' + j + ',this.checked)"><span class="flex-1 min-w-0 truncate" title="' + esc(cp.name) + '">' + esc(cp.name) + '</span>' + (/rank/i.test(cp.name) ? '<span class="text-[9px] font-bold uppercase tracking-wide text-blue-700 bg-blue-50 rounded px-1 py-0.5">ranking</span>' : '') + '<span class="ff-mono text-slate-600 tabular-nums">' + int(m ? m.clicks : 0) + ' clicks</span></label>'; }).join('') : '<p class="text-xs text-slate-500 p-2">No campaigns found for this ASIN in the bulk file.</p>';
    const rows = order.map(k => S.compare(sqp, bulk, sqp.queries.has(k) ? sqp.queries.get(k).query : k, opts(k)))
      .concat(st.camps.filter(id => bulk.camps.has(id)).map(id => S.compareCampaign(bulk, id, { basis: st.basis, manual: st.manual[S.campKey(id)] })));
    $('sqEmpty').classList.toggle('hidden', rows.length > 0);
    $('sqCards').innerHTML = rows.map((c, i) => card(c, i)).join('');
    $('sqChartsBox').classList.toggle('hidden', rows.length === 0);
    lucide.createIcons();
    if (rows.length) charts(rows);
    st.rows = rows; renderSave();
  }

  function srcRow(label, m, sub, color, idx) {
    if (!m) return '';
    const noData = m.clicks === 0;
    return '<tr class="border-t border-slate-100"><th scope="row" class="' + THL + ' font-semibold text-slate-700"><span class="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-middle" style="background:' + color + '"></span>' + label + (sub ? '<span class="block text-[10px] font-medium text-slate-500 ml-[18px]">' + sub + '</span>' : '') + '</th>'
      + '<td class="' + TH + ' tabular-nums">' + int(m.imp) + '</td><td class="' + TH + ' tabular-nums">' + int(m.clicks) + '</td><td class="' + TH + ' tabular-nums">' + int(m.orders) + '</td>'
      + '<td class="' + TH + ' tabular-nums">' + pct(m.ctr, 2) + '</td><td class="' + TH + ' tabular-nums font-bold">' + (noData ? 'no clicks' : pct(m.cvr)) + '</td>'
      + '<td class="' + TH + ' tabular-nums text-slate-500" title="Conversion rate compared with the whole market on this query (1.00× = same)">' + (idx == null ? '–' : idx.toFixed(2) + '×') + '</td>'
      + '<td class="' + TH + ' tabular-nums">' + (m.spend ? money(m.cpc) : '–') + '</td><td class="' + TH + ' tabular-nums">' + (m.spend ? money(m.spend) : '–') + '</td><td class="' + TH + ' tabular-nums">' + (m.sales ? money(m.sales) : '–') + '</td><td class="' + TH + ' tabular-nums">' + (m.spend && m.sales ? pct(m.acos, 0) : '–') + '</td></tr>';
  }

  // typed Campaign Manager numbers against the bulk file's two views of the same campaigns
  function manualNote(c) {
    const m = c.manual; if (!m) return '';
    const bk = c.manualBulk || c.recon;
    if (!bk) return '<p class="text-xs text-slate-600 mt-2">Choose a campaign above to compare these numbers with the bulk file.</p>';
    const sgn = b => (m.clicks ? ((b - m.clicks) / m.clicks > 0 ? '+' : '') + (((b - m.clicks) / m.clicks) * 100).toFixed(1) + '%' : '–');
    const one = (label, b) => label + ': <b>' + int(b.clicks) + '</b> clicks (' + sgn(b.clicks) + '), <b>' + int(b.orders) + '</b> orders, CVR ' + pct(b.cvr);
    return '<p class="text-xs text-slate-700 mt-2 leading-relaxed">You typed <b>' + int(m.clicks) + '</b> clicks, <b>' + int(m.orders) + '</b> orders, CVR ' + pct(m.cvr) + '. Bulk file' + (c.manualBulk && !c.campaign ? ' for <b>' + esc(c.manualBulk.name) + '</b>' : '') + ', ' + one('campaign rows', bk.cm) + ' · ' + one('exact search-term rows', bk.term) + '.</p>';
  }
  // organic rank text: unknown (keyword not in the Cerebro file) is never shown as not ranked
  function rankLine(r) {
    if (!r) return 'Organic rank <b>not in the Cerebro report</b> (unknown, not zero)';
    return 'Organic rank ' + (r.organic ? '<b>#' + r.organic + '</b>' : '<b>not ranked</b> (outside the first ~300 results)') + (r.sponsored ? ' · sponsored rank <b>#' + r.sponsored + '</b>' : '') + (r.date ? ' · Cerebro, ' + esc(r.date) : '');
  }
  function card(c, i) {
    const ids = st.bulk ? S.asinCampaigns(st.bulk, st.sqp.asin) : [], sel = c.rankIds;
    const campList = ids.map(id => { const cp = st.bulk.camps.get(id), m = cp.row; return '<label class="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-50 cursor-pointer text-xs"><input type="checkbox" class="rounded border-slate-300" ' + (sel.includes(id) ? 'checked ' : '') + 'onchange="sqToggleCamp(\'' + jsq(c.key) + '\',\'' + jsq(id) + '\',this.checked)"><span class="flex-1 min-w-0 truncate" title="' + esc(cp.name) + '">' + esc(cp.name) + '</span><span class="ff-mono text-slate-500 tabular-nums">' + int(m ? m.clicks : 0) + ' clicks</span></label>'; }).join('');
    const bl = st.basis === 'cm' ? 'campaign row' : 'exact search term';
    let h = '<section class="border border-slate-200 rounded-2xl p-5 mb-4 bg-white"><div class="flex flex-wrap items-baseline justify-between gap-2 mb-3"><h3 class="text-base font-extrabold text-slate-800">' + esc(c.query) + (c.campaign ? '<span class="ml-2 text-[10px] font-bold uppercase tracking-wide text-blue-700 bg-blue-50 rounded px-1.5 py-0.5 align-middle">Campaign</span>' : '') + '</h3><div class="flex flex-wrap gap-1.5 items-center">' + c.flags.map(chip).join('') + '</div></div>';
    if (c.market) {
      h += '<p class="text-[11px] text-slate-600 mb-3">Search volume <b class="tabular-nums">' + int(c.volume) + '</b> (SQP)' + (c.rank && c.rank.volume != null ? ', <b class="tabular-nums">' + int(c.rank.volume) + '</b> (Helium 10)' : '')
        + (c.share && c.share.imp != null ? ' · your shares: impressions <b>' + c.share.imp.toFixed(1) + '%</b>, clicks <b>' + (c.share.click || 0).toFixed(1) + '%</b>, purchases <b>' + (c.share.purchase || 0).toFixed(1) + '%</b>' : '')
        + (c.price && c.price.market != null ? ' · median price market <b>' + money(c.price.market) + '</b>' + (c.price.asin != null ? ', yours <b>' + money(c.price.asin) + '</b>' : '') : '') + '</p>';
    }
    if (st.cerebro && !c.campaign) h += '<p class="text-[11px] text-slate-600 mb-3">' + rankLine(c.rank) + '</p>';
    h += '<div class="overflow-x-auto border border-slate-200 rounded-xl"><table class="w-full text-xs"><thead><tr class="' + HEAD + '"><th scope="col" class="' + THL + '">Source</th><th scope="col" class="' + TH + '">Impr.</th><th scope="col" class="' + TH + '">Clicks</th><th scope="col" class="' + TH + '">Orders</th><th scope="col" class="' + TH + '">CTR</th><th scope="col" class="' + TH + '">CVR</th><th scope="col" class="' + TH + '">vs market</th><th scope="col" class="' + TH + '">CPC</th><th scope="col" class="' + TH + '">Spend</th><th scope="col" class="' + TH + '">Sales</th><th scope="col" class="' + TH + '">ACOS</th></tr></thead><tbody>'
      + srcRow('Market', c.market, 'all sellers (SQP)', C.market, null)
      + srcRow('Your ASIN', c.asin, 'ads + organic (SQP)', C.asin, c.index.asin)
      + srcRow(c.campaign ? 'Campaign' : 'Ranking campaign' + (sel.length > 1 ? 's' : ''), c.ranking, c.campaign ? bl : sel.length + ' campaign' + (sel.length === 1 ? '' : 's') + ' · ' + bl, C.ranking, c.index.ranking)
      + srcRow('Manual (Campaign Manager)', c.manual, c.manualBulk && !c.campaign ? 'for ' + esc(c.manualBulk.name) : 'typed in by you', C.manual, c.index.manual)
      + srcRow('All PPC on this term', c.allppc, 'every campaign for this ASIN · exact term', C.allppc, c.index.allppc)
      + '</tbody></table></div>';
    if (!c.market && !c.campaign) h += '<p class="text-xs text-slate-600 mt-2">This query is not in the SQP report, so there is no market or ASIN line. It is missing, not zero.</p>';
    if (!sel.length && !c.campaign) h += '<p class="text-xs text-slate-600 mt-2">No ranking campaign selected for this keyword. Pick one below.</p>';
    if (!c.campaign) h += '<details class="mt-3"><summary class="cursor-pointer text-xs font-bold text-blue-700 select-none">Ranking campaigns for this keyword (' + sel.length + ' of ' + ids.length + ')</summary><div class="mt-2 max-h-48 overflow-auto border border-slate-200 rounded-xl p-1">' + (campList || '<p class="text-xs text-slate-500 p-2">No campaigns found for this ASIN in the bulk file.</p>') + '</div></details>';
    const mv = st.manual[c.key] || {};
    // which campaign are the typed numbers for? suggested: the ranking campaigns of this keyword, then the other campaigns of the ASIN
    const nm = id => st.bulk.camps.get(id).name, curC = mv.camp || '', oh = (v, label) => '<option value="' + esc(v) + '"' + (curC === v ? ' selected' : '') + '>' + esc(label) + '</option>';
    const others = ids.filter(id => !sel.includes(id));
    const dd = oh('', sel.length > 1 ? 'All selected ranking campaigns together (' + sel.length + ')' : sel.length === 1 ? nm(sel[0]) + ' (ranking campaign)' : 'Choose a campaign…')
      + (sel.length > 1 ? '<optgroup label="Suggested: ranking campaigns for this keyword">' + sel.map(id => oh(id, nm(id))).join('') + '</optgroup>' : '')
      + (others.length ? '<optgroup label="' + (sel.length ? 'Other campaigns for this ASIN' : 'Campaigns for this ASIN') + '">' + others.map(id => oh(id, nm(id))).join('') + '</optgroup>' : '');
    h += '<details class="mt-3"' + (mv.clicks != null || mv.orders != null || mv.camp ? ' open' : '') + '><summary class="cursor-pointer text-xs font-bold text-blue-700 select-none">Manual check: type in clicks and orders from Campaign Manager</summary><div class="mt-2"><p class="text-[11px] text-slate-500 mb-2">' + (c.campaign ? 'For this campaign' : 'For the campaign you pick here (by default the ranking campaign' + (sel.length > 1 ? 's' : '') + ' above)') + ', same dates. Shows how far the bulk file is from what you see in Campaign Manager, and is saved with the keyword if you save to history.</p><div class="flex flex-wrap items-end gap-3">'
      + [['clicks', 'Clicks'], ['orders', 'Orders']].map(f => '<div><label for="mn' + i + f[0][0] + '" class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">' + f[1] + '</label><input id="mn' + i + f[0][0] + '" type="number" min="0" step="1" inputmode="numeric" value="' + (mv[f[0]] == null ? '' : mv[f[0]]) + '" onchange="sqManual(' + i + ',\'' + f[0] + '\',this.value)" class="border border-slate-300 bg-white p-2 rounded-lg text-sm w-28 outline-none focus:ring-1 focus:ring-blue-500"></div>').join('')
      + (c.campaign ? '' : '<div class="min-w-0"><label for="mn' + i + 'k" class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">For campaign</label><select id="mn' + i + 'k" onchange="sqManual(' + i + ',\'camp\',this.value)" class="border border-slate-300 bg-white p-2 rounded-lg text-sm max-w-xs outline-none focus:ring-1 focus:ring-blue-500">' + dd + '</select></div>') + '</div>' + manualNote(c) + '</div></details>';
    if (c.placements) {
      const P = c.placements, lab = { top: 'Top of search', rest: 'Rest of search', product: 'Product pages', business: 'Amazon Business', other: 'Other / unlabelled' }, tot = P.total.clicks || 0;
      h += '<h4 class="text-xs font-extrabold text-slate-800 mt-4 mb-1.5">Conversion by placement <span class="font-medium text-slate-500">(campaign level)</span></h4><div class="overflow-x-auto border border-slate-200 rounded-xl"><table class="w-full text-xs"><thead><tr class="' + HEAD + '"><th scope="col" class="' + THL + '">Placement</th><th scope="col" class="' + TH + '">Impr.</th><th scope="col" class="' + TH + '">Clicks</th><th scope="col" class="' + TH + '">Orders</th><th scope="col" class="' + TH + '">CTR</th><th scope="col" class="' + TH + '">CVR</th><th scope="col" class="' + TH + '">CPC</th><th scope="col" class="' + TH + '">Share of clicks</th></tr></thead><tbody>'
        + S.PLACEMENTS.map(k => { const m = P.rows[k]; if (!m.imp && !m.clicks) return ''; return '<tr class="border-t border-slate-100"><th scope="row" class="' + THL + ' font-semibold text-slate-700">' + lab[k] + '</th><td class="' + TH + ' tabular-nums">' + int(m.imp) + '</td><td class="' + TH + ' tabular-nums">' + int(m.clicks) + '</td><td class="' + TH + ' tabular-nums">' + int(m.orders) + '</td><td class="' + TH + ' tabular-nums">' + pct(m.ctr, 2) + '</td><td class="' + TH + ' tabular-nums font-bold">' + (m.clicks >= 10 ? pct(m.cvr) : (m.clicks ? 'few clicks' : '–')) + '</td><td class="' + TH + ' tabular-nums">' + (m.spend ? money(m.cpc) : '–') + '</td><td class="' + TH + ' tabular-nums">' + (tot ? pct(m.clicks / tot, 0) : '–') + '</td></tr>'; }).join('')
        + '<tr class="border-t-2 border-slate-300 font-bold bg-slate-50"><th scope="row" class="' + THL + '">All placements</th><td class="' + TH + ' tabular-nums">' + int(P.total.imp) + '</td><td class="' + TH + ' tabular-nums">' + int(P.total.clicks) + '</td><td class="' + TH + ' tabular-nums">' + int(P.total.orders) + '</td><td class="' + TH + ' tabular-nums">' + pct(P.total.ctr, 2) + '</td><td class="' + TH + ' tabular-nums">' + pct(P.total.cvr) + '</td><td class="' + TH + ' tabular-nums">' + (P.total.spend ? money(P.total.cpc) : '–') + '</td><td class="' + TH + ' tabular-nums">100%</td></tr></tbody></table></div>';
      const r = c.recon;
      h += '<p class="text-[11px] text-slate-500 mt-2 leading-relaxed">The same campaigns, three Amazon views: campaign rows <b>' + int(r.cm.clicks) + '</b> clicks (matches Campaign Manager\'s placement view) · exact search-term rows <b>' + int(r.term.clicks) + '</b> · keyword rows <b>' + int(r.kw.clicks) + '</b>. Placement rows total <b>' + int(P.total.clicks) + '</b>. Amazon\'s views do not always agree; use the switch above to choose the basis.</p>';
    }
    return h + '</section>';
  }

  // ---- charts: one bar per source, grouped by keyword
  function charts(rows) {
    if (typeof Chart === 'undefined') return; _ppcChartTheme();
    const R = rows.slice(0, 12), labels = R.map(r => r.query.length > 24 ? r.query.slice(0, 23) + '…' : r.query);
    $('sqChartNote').textContent = rows.length > 12 ? 'Showing the first 12 of ' + rows.length + ' keywords.' : '';
    const series = (get, withMarket) => [
      withMarket ? { label: 'Market', data: R.map(r => get(r.market)), backgroundColor: C.market } : null,
      withMarket ? { label: 'Your ASIN', data: R.map(r => get(r.asin)), backgroundColor: C.asin } : null,
      { label: 'Ranking campaign', data: R.map(r => get(r.ranking)), backgroundColor: C.ranking },
      st.overlay ? { label: 'All PPC on term', data: R.map(r => get(r.allppc)), backgroundColor: C.allppc } : null
    ].filter(Boolean).map(d => Object.assign({ borderRadius: 4, maxBarThickness: 26 }, d));
    const draw = (id, ds, fmt, tick) => { _chartDestroy(id); _dashCharts[id] = new Chart($(id), { type: 'bar', data: { labels, datasets: ds },
      options: { responsive: true, maintainAspectRatio: false, animation: _dashAnim, plugins: { legend: { position: 'bottom' }, tooltip: { displayColors: true, callbacks: { label: c => c.dataset.label + ': ' + (c.raw == null ? 'no data' : fmt(c.raw)) } } }, scales: _chartBarScales(false, tick) } }); };
    const p = v => (v == null || v.cvr == null ? null : +(v.cvr * 100).toFixed(2)), t = v => (v == null || v.ctr == null ? null : +(v.ctr * 100).toFixed(3)), cp = v => (v == null || !v.spend || v.cpc == null ? null : +v.cpc.toFixed(2));
    draw('sqChartCvr', series(p, true).concat(R.some(r => r.manual) ? [{ label: 'Manual (Campaign Manager)', data: R.map(r => p(r.manual)), backgroundColor: C.manual, borderRadius: 4, maxBarThickness: 26 }] : []), v => v + '%', v => v + '%');
    draw('sqChartCtr', series(t, true), v => v + '%', v => v + '%');
    draw('sqChartCpc', series(cp, false), v => money(v), v => cur().trim() + v);
  }

  // ---- download
  window.sqDownload = function () {
    if (!st.rows || !st.rows.length) { toast('Select at least one keyword first.'); return; }
    const wb = XLSX.utils.book_new(), add = (n, aoa) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), n);
    const line = (c, label, m) => m ? [c.query, label, m.imp, m.clicks, m.orders, m.ctr, m.cvr, m.spend ? m.cpc : null, m.spend || null, m.sales || null, m.spend && m.sales ? m.acos : null] : null;
    const cmp = [['Keyword', 'Source', 'Impressions', 'Clicks', 'Orders', 'CTR', 'CVR', 'CPC', 'Spend', 'Sales', 'ACOS']];
    st.rows.forEach(c => [line(c, 'Market (SQP)', c.market), line(c, 'Your ASIN (SQP)', c.asin), line(c, 'Ranking campaign (' + (st.basis === 'cm' ? 'campaign rows' : 'exact search term') + ')', c.ranking), line(c, 'All PPC on this term', c.allppc), line(c, 'Manual (Campaign Manager)', c.manual)].forEach(x => x && cmp.push(x)));
    add('Comparison', cmp);
    const pl = [['Keyword', 'Placement', 'Impressions', 'Clicks', 'Orders', 'CTR', 'CVR', 'CPC', 'Spend']], lab = { top: 'Top of search', rest: 'Rest of search', product: 'Product pages', business: 'Amazon Business', other: 'Other / unlabelled' };
    st.rows.forEach(c => c.placements && S.PLACEMENTS.forEach(k => { const m = c.placements.rows[k]; if (m.imp || m.clicks) pl.push([c.query, lab[k], m.imp, m.clicks, m.orders, m.ctr, m.cvr, m.spend ? m.cpc : null, m.spend]); }));
    add('Placements', pl);
    if (st.cerebro) add('Organic rank', [['Keyword', 'Organic rank', 'Sponsored rank', 'Rank date (Cerebro)']].concat(st.rows.map(c => [c.query, c.rank ? (c.rank.organic || 'not ranked') : 'not in Cerebro report', c.rank && c.rank.sponsored ? c.rank.sponsored : null, c.rank ? c.rank.date : null])));
    add('Info', [['PPCBench SQP Tracker export'], ['ASIN', st.sqp.asin], ['Period', st.sqp.range + ' ' + st.sqp.from + ' to ' + st.sqp.to], ['SQP file', st.sqpName], ['Bulk file', st.bulkName], ['Cerebro file', st.cerebro ? st.cerebro.fileName : 'none'], ['Ranking basis', st.basis === 'cm' ? 'Campaign rows (matches Campaign Manager)' : 'Exact search-term rows'],
      [], ['Notes'], ['CVR = orders (purchases) / clicks. CTR = clicks / impressions. Computed from the counts, not from Amazon\'s per-search rates.'], ['SQP covers ads + organic for all clicks on the query; PPC uses Amazon\'s attribution window. Compare rates, not volumes.'], ['A query missing from SQP is below Amazon\'s threshold, not zero.']]);
    XLSX.writeFile(wb, 'SQP_Tracker_' + st.sqp.asin + '_' + st.sqp.from + '_' + st.sqp.to + '.xlsx');
    toast('Comparison downloaded.', 'success');
  };

  // ============================== saved history (Pro) ==============================
  const MSG = {
    'sqp:consent_required': 'Please agree to saving first.', 'sqp:limit_sqp_brands': 'You have reached the limit of 10 brands. Delete one first.', 'sqp:limit_sqp_asins': 'You have reached the limit of 30 ASINs in this brand.',
    'sqp:limit_sqp_keywords': 'You have reached the limit of 50 saved keywords for this ASIN. Delete some first.', 'sqp:limit_sqp_periods': 'You have reached the limit of saved periods for this ASIN.',
    'sqp:invalid': 'Those files could not be saved (unexpected values).', plan: 'Saved history is part of the Pro plan.', renew: 'Your session ended. Sign in again.', origin: 'Could not verify the request. Reload the page.',
    too_large: 'Too much data in one save. Track fewer keywords.', 'sqp:not_found': 'That period or keyword no longer exists. Reload the page.', 'sqp:limit_sqp_metrics': 'That period already holds the maximum number of keywords.', unavailable: 'The service is not reachable right now. Try again in a minute.'
  };
  const errText = e => MSG[e && e.code] || 'Something went wrong. Nothing was changed. Try again.';
  async function api(op, body, retried) {
    let r;
    try { r = await fetch('/api/sqp/' + op, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); }
    catch (e) { const x = new Error('network'); x.code = 'unavailable'; throw x; }
    if (r.status === 401 && !retried) {                      // access window ended: renew once through the refresh cookie, then retry
      let n = null; try { n = await fetch('/api/auth/renew', { method: 'POST', credentials: 'same-origin' }); } catch (e) { /* offline */ }
      if (n && n.status === 204) return api(op, body, true);
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const x = new Error(j.error || 'failed'); x.code = j.error || 'failed'; throw x; }
    return j.data;
  }
  const isCamp = k => String(k.query).startsWith('campaign:');   // a tracked campaign is stored like a keyword
  const sv = { state: null, err: null, hist: {}, sel: { brand: '', asin: '', cad: 'weekly', kw: '', basis: 'cm', camp: '' }, consentOpen: false, busy: false, last: null, brand: '', edit: null, target: null, split: false };
  const ymd = d => d;                                       // dates are already YYYY-MM-DD
  const plain = (v, d) => (v == null ? '–' : v.toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }));

  async function loadState(force) {
    if (sv.state && !force) return sv.state;
    try { sv.state = await api('state'); sv.err = null; } catch (e) { sv.err = errText(e); sv.state = null; }
    return sv.state;
  }
  const findAsin = (asin) => { const s = sv.state; if (!s) return null; for (const b of s.brands) for (const a of b.asins) if (a.asin === asin) return { brand: b, asin: a }; return null; };

  // ---- Compare tab: the save bar
  function renderSave() {
    const el = $('sqSave'); if (!el || !st.sqp) return;
    if (st.isSample) { el.innerHTML = '<p class="text-xs text-slate-500">Sample data is not saved. Use your own files to track history.</p>'; return; }
    if (sv.err) { el.innerHTML = '<p class="text-xs text-rose-700" role="alert">' + esc(sv.err) + '</p>'; return; }
    if (!sv.state) { el.innerHTML = '<p class="text-xs text-slate-500">Checking your saved history…</p>'; return; }
    const sqp = st.sqp, pc = S.periodCheck(sqp, st.bulk), hit = findAsin(sqp.asin), cad = sqp.range === 'monthly' ? 'monthly' : 'weekly';
    const exists = hit && hit.asin.periods.some(p => p.cadence === cad && p.from === sqp.from);
    if (!sv.brand) sv.brand = hit ? hit.brand.name : (sv.state.brands.length === 1 ? sv.state.brands[0].name : '');
    const nk = st.tracked.length, nc = S.saveCampaignIds(st.bulk, st.tracked, st.rank, st.camps, sv.split).length, n = nk + nc, blocked = pc.status === 'mismatch' || !n;
    let h = '<div class="flex flex-wrap items-end gap-3"><div><label for="sqBrand" class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Brand (for this ASIN)</label>'
      + '<input id="sqBrand" list="sqBrandList" maxlength="80" value="' + esc(sv.brand) + '" oninput="sqBrandInput(this.value)" autocomplete="off" placeholder="e.g. your brand name" class="border border-slate-300 bg-white p-2 rounded-lg text-sm w-56 outline-none focus:ring-1 focus:ring-blue-500"><datalist id="sqBrandList">' + sv.state.brands.map(b => '<option value="' + esc(b.name) + '">').join('') + '</datalist></div>'
      + '<button id="sqSaveBtn" type="button" onclick="sqSave()" ' + (blocked || sv.busy ? 'disabled ' : '') + 'class="bg-blue-700 hover:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold px-4 py-2 rounded-lg shadow-sm transition-colors">' + (sv.busy ? 'Saving…' : exists ? 'Replace this period in history' : 'Save to history') + '</button></div>';
    h += '<p class="text-[11px] text-slate-500 mt-2 leading-relaxed">Saves ' + nk + ' ticked keyword' + (nk === 1 ? '' : 's') + (nc ? ' and ' + nc + ' campaign' + (nc === 1 ? '' : 's') : '') + ' for ' + esc(sqp.from) + ' to ' + esc(sqp.to) + ' (' + cad + '). '
      + (exists ? 'This period is already saved: saving replaces it with what is ticked now. ' : '')
      + (pc.status === 'mismatch' ? '<b class="text-rose-800">The bulk file dates do not match the SQP report, so saving is off.</b> ' : '')
      + (n > S.MAX_KEYWORDS ? '<b class="text-rose-800">Only the first ' + S.MAX_KEYWORDS + ' are saved.</b> ' : '') + (!n ? 'Tick at least one keyword or campaign. ' : '') + (st.cerebro ? 'The organic and sponsored rank from your Cerebro report is included. ' : '') + (st.tracked.some(k => st.manual[k]) || st.camps.some(id => st.manual[S.campKey(id)]) ? 'The Campaign Manager clicks and orders you typed are included. ' : '') + 'Only counts, spend, sales, prices and ranks are saved, not the files.</p>';
    if (st.tracked.some(k => (st.rank[k] || []).length)) h += '<label class="flex items-start gap-2 mt-3 text-xs text-slate-700 cursor-pointer"><input type="checkbox" class="mt-0.5 rounded border-slate-300" ' + (sv.split ? 'checked ' : '') + 'onchange="sqSplit(this.checked)"><span><b>Also save each ranking campaign separately</b><span class="block text-slate-500">Lets you view each related campaign on its own in Saved history. It uses one saved slot per campaign (' + S.MAX_KEYWORDS + ' per ASIN in total).</span></span></label>';
    if (sv.consentOpen) h += '<div class="mt-3 rounded-xl border border-slate-300 bg-slate-50 p-4 text-xs text-slate-700 leading-relaxed" role="dialog" aria-label="Saving to history"><b class="text-slate-900">Before the first save</b><p class="mt-1">For the keywords and campaigns you tick, PPCBench stores in your account: the keyword or campaign name, your brand name and ASIN, the names of the ranking campaigns, and these numbers per week or month: search volume, impressions, clicks and orders (market and your ASIN), and impressions, clicks, orders, spend and sales for your ranking campaigns and placements. If you add a Cerebro report: your organic and sponsored rank for those keywords and the date it was taken. If you type in Campaign Manager numbers: those clicks and orders. <b>Not saved:</b> your files, other keywords, search-term reports, or other campaigns.</p><p class="mt-1">Only you can see it. The newest 13 weeks (or months) are kept per ASIN. You can export or delete everything in <b>Saved history</b> at any time.</p><div class="flex gap-2 mt-3"><button type="button" onclick="sqConsent()" class="bg-blue-700 hover:bg-blue-800 text-white text-xs font-bold px-3 py-2 rounded-lg">I agree, save</button><button type="button" onclick="sqConsentNo()" class="border border-slate-300 text-slate-700 text-xs font-bold px-3 py-2 rounded-lg hover:bg-white">Cancel</button></div></div>';
    if (sv.last) h += '<div class="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900" role="status">' + sv.last + '</div>';
    el.innerHTML = h;
  }
  window.sqBrandInput = v => { sv.brand = v; };
  window.sqSplit = on => { sv.split = on; renderSave(); };
  window.sqConsentNo = () => { sv.consentOpen = false; renderSave(); };
  window.sqConsent = async function () {
    try { await api('consent', { version: 1 }); sv.state.consent = 1; sv.consentOpen = false; await window.sqSave(); }
    catch (e) { toast(esc(errText(e)), 'error'); }
  };
  window.sqSave = async function () {
    if (!st.sqp || sv.busy) return;
    const brand = (sv.brand || '').trim();
    if (!brand || brand.length > 80) { toast('Name the brand for this ASIN (up to 80 characters).'); const i = $('sqBrand'); if (i) i.focus(); return; }
    if (!sv.state.consent) { sv.consentOpen = true; renderSave(); return; }
    sv.busy = true; sv.last = null; renderSave();
    try {
      const pay = S.savePayload(st.sqp, st.bulk, st.tracked, st.rank, brand, st.bulkName, st.cerebro, st.manual, st.camps, sv.split);
      const r = await api('save', { payload: pay });
      await loadState(true); sv.hist = {};
      const next = S.nextPeriod([{ from: pay.from }], pay.cadence);
      sv.last = (r.replaced ? 'Replaced ' : 'Saved ') + esc(pay.from) + ' to ' + esc(pay.to) + ' (' + r.saved_keywords + ' keyword' + (r.saved_keywords === 1 ? '' : 's') + ').'
        + (r.kept ? '' : ' This period is older than the 13 newest, so it was not kept.') + (r.pruned ? ' ' + r.pruned + ' older period' + (r.pruned === 1 ? ' was' : 's were') + ' removed (13 are kept).' : '')
        + ' <button type="button" onclick="sqNextPair()" class="font-bold underline ml-1">Add another period</button> <button type="button" onclick="sqTab(\'hist\')" class="font-bold underline ml-1">Open saved history</button>'
        + '<span class="block mt-1 text-emerald-800">Back-filling: upload the SQP report and bulk file of an earlier ' + (pay.cadence === 'weekly' ? 'week' : 'month') + ' next; the order does not matter. (' + esc(next) + ' would follow this one.)</span>';
    } catch (e) { toast(esc(errText(e)), 'error'); }
    sv.busy = false; renderSave();
  };
  window.sqNextPair = function () {
    closeZoom(); st.files = { sqp: null, bulk: null, cerebro: null }; sqIn.value = ''; buIn.value = ''; ceIn.value = ''; names(); sv.last = null;
    st.sqp = null; st.bulk = null; $('sqResults').classList.add('hidden'); $('sqUp').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // ---- tabs
  window.sqTab = async function (which) {
    closeZoom(); sv.edit = null; const hist = which === 'hist';
    $('sqUp').classList.toggle('hidden', hist); $('sqPaneHist').classList.toggle('hidden', !hist);
    $('sqResults').classList.toggle('hidden', hist || !st.sqp);
    [['sqTabCompare', !hist], ['sqTabHist', hist]].forEach(([id, on]) => { const b = $(id); b.setAttribute('aria-selected', on ? 'true' : 'false'); b.classList.toggle('border-slate-800', on); b.classList.toggle('text-slate-800', on); b.classList.toggle('border-transparent', !on); b.classList.toggle('text-slate-500', !on); });
    if (hist) { $('sqHistMsg').classList.remove('hidden'); $('sqHistMsg').textContent = 'Loading your saved history…'; $('sqHistBody').classList.add('hidden'); await loadState(true); await histRender(); }
  };

  // ---- History tab
  const selBrand = () => (sv.state ? sv.state.brands.find(b => b.id === sv.sel.brand) : null);
  const selAsin = () => { const b = selBrand(); return b ? b.asins.find(a => a.id === sv.sel.asin) : null; };
  const opts = (sel, list, cur) => { sel.innerHTML = list.map(o => '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join(''); };
  async function histRender() {
    const msg = $('sqHistMsg'), body = $('sqHistBody');
    if (sv.err || !sv.state) { msg.textContent = sv.err || 'Could not load your saved history.'; msg.classList.remove('hidden'); body.classList.add('hidden'); return; }
    const brands = sv.state.brands.filter(b => b.asins.length);
    if (!brands.length) { msg.textContent = 'Nothing saved yet. On the Compare tab, load an SQP report and its bulk file, name the brand and click Save to history.'; msg.classList.remove('hidden'); body.classList.add('hidden'); return; }
    if (!brands.some(b => b.id === sv.sel.brand)) sv.sel.brand = brands[0].id;
    const b = brands.find(x => x.id === sv.sel.brand); if (!b.asins.some(a => a.id === sv.sel.asin)) sv.sel.asin = b.asins[0].id;
    opts($('sqHBrand'), brands.map(x => [x.id, x.name]), sv.sel.brand); opts($('sqHAsin'), b.asins.map(a => [a.id, a.asin + (a.label ? ' · ' + a.label : '')]), sv.sel.asin);
    $('sqHCad').value = sv.sel.cad; $('sqHBasis').value = sv.sel.basis;
    const a = b.asins.find(x => x.id === sv.sel.asin), key = a.id + '|' + sv.sel.cad;
    if (!sv.hist[key]) { try { sv.hist[key] = await api('history', { asin_id: a.id, cadence: sv.sel.cad }); } catch (e) { msg.textContent = errText(e); msg.classList.remove('hidden'); body.classList.add('hidden'); return; } }
    const h = sv.hist[key], inUse = new Set(h.rows.map(r => r.k)), kws = h.keywords.slice().sort((a, b) => isCamp(a) - isCamp(b));   // keywords first, then campaigns
    msg.classList.add('hidden'); body.classList.remove('hidden');
    if (!kws.length) { opts($('sqHKw'), [['', '(none)']], ''); $('sqHTitle').textContent = 'No ' + sv.sel.cad + ' periods saved for this ASIN yet'; $('sqHTable').innerHTML = ''; $('sqHNote').textContent = ''; ['sqHChartCvr', 'sqHChartCtr', 'sqHChartCpc', 'sqHChartRank'].forEach(_chartDestroy); return; }
    if (!kws.some(k => k.id === sv.sel.kw)) sv.sel.kw = kws[0].id;
    opts($('sqHKw'), kws.map(k => [k.id, (isCamp(k) ? 'Campaign: ' : '') + (k.display || k.query) + (inUse.has(k.id) ? '' : ' (no data yet)')]), sv.sel.kw);
    const kw = kws.find(k => k.id === sv.sel.kw);
    // related campaigns = this keyword's stored ranking campaigns; one can be shown on its own once it was saved as a campaign series
    const rel = isCamp(kw) ? [] : (kw.ranking || []).filter(r => !r.notRank).map(r => ({ q: 'campaign:' + String(r.id).toLowerCase(), name: r.name }));
    if (!rel.some(r => r.q === sv.sel.camp)) sv.sel.camp = '';
    $('sqHCampBox').classList.toggle('hidden', !rel.length);
    opts($('sqHCamp'), [['', 'All ranking campaigns (combined)']].concat(rel.map(r => [r.q, r.name])), sv.sel.camp);
    const centry = sv.sel.camp ? kws.find(k => k.query === sv.sel.camp) : null, cname = sv.sel.camp ? (rel.find(r => r.q === sv.sel.camp) || {}).name : '';
    const kpts = S.series(h, kw.id, sv.sel.basis), pts = centry ? S.mergeCampaign(kpts, S.series(h, centry.id, sv.sel.basis)) : kpts;
    sv.target = centry ? centry.id : kw.id;
    const campNote = centry ? 'Showing <b>' + esc(cname) + '</b> on its own, next to this keyword\'s market and ASIN numbers. ' : sv.sel.camp ? '<b class="text-amber-800">' + esc(cname) + ' is not saved as its own series yet.</b> On the Compare tab tick <b>Also save each ranking campaign separately</b> (or tick the campaign under Campaigns to track) and save the week again; saving a week again replaces it. Showing the combined numbers meanwhile. ' : '';
    $('sqHTitle').textContent = (isCamp(kw) ? 'Campaign: ' : '') + (kw.display || kw.query) + (centry ? ' · ' + cname : '') + ' · ' + sv.sel.cad + ' · ' + (pts.length) + ' period' + (pts.length === 1 ? '' : 's');
    $('sqHNote').innerHTML = campNote + (isCamp(kw) ? 'Campaign-level tracking: no market or ASIN line, because SQP is per search query. ' : kw.ranking && kw.ranking.length ? 'Ranking campaign' + (kw.ranking.length > 1 ? 's' : '') + ': ' + kw.ranking.filter(r => !r.notRank).map(r => esc(r.name)).join(' · ') + '. ' : '') + (kw.ranking && kw.ranking.some(r => r.manual) ? 'Manual numbers are for: ' + esc(kw.ranking.find(r => r.manual).name) + '. ' : '')
      + (pts.length < 2 ? '<b class="text-slate-700">A trend needs at least two saved periods.</b> Upload earlier ones on the Compare tab to back-fill. ' : '')
      + 'Next period to add: ' + esc(S.nextPeriod(h.periods, sv.sel.cad) || '–') + '.';
    histTable(pts, kw, centry); histCharts(pts); lucide.createIcons();
  }
  // ---- edit a saved period: add, change or remove the manual numbers of the selected keyword or campaign in that week
  window.sqEditPeriod = function (pid) { sv.edit = pid; histRender().then(() => { const e = $('sqEdC'); if (e) e.focus(); }); };
  window.sqEditCancel = function () { sv.edit = null; histRender(); };
  async function editWrite(clicks, orders) {
    if (!sv.edit || !sv.sel.kw) return;
    try { await api('set_manual', { period_id: sv.edit, keyword_id: sv.target || sv.sel.kw, clicks, orders }); sv.edit = null; sv.hist = {}; await histRender(); toast(clicks === null ? 'Manual numbers removed.' : 'Manual numbers saved.', 'success'); }
    catch (e) { toast(esc(errText(e)), 'error'); }
  }
  window.sqEditSave = function () {
    const rd = id => { const v = $(id).value.trim(); return /^\d+$/.test(v) && +v <= 1e9 ? +v : null; };
    const c = rd('sqEdC'), o = rd('sqEdO');
    if (c === null || o === null) { toast('Type both clicks and orders as whole numbers (0 or more).'); return; }
    return editWrite(c, o);
  };
  window.sqEditClear = () => editWrite(null, null);
  window.sqHistPick = function (which) {
    const v = { brand: 'sqHBrand', asin: 'sqHAsin', cad: 'sqHCad', kw: 'sqHKw', basis: 'sqHBasis', camp: 'sqHCamp' }[which];
    sv.edit = null; sv.sel[which] = $(v).value; if (which === 'brand') sv.sel.asin = ''; if (which === 'asin' || which === 'cad') sv.sel.kw = '';
    if (which !== 'camp' && which !== 'basis') sv.sel.camp = '';   // the related campaign belongs to one keyword
    histRender();
  };
  function histTable(pts, kw, centry) {
    const camp = isCamp(kw), tgt = centry || kw, tcamp = isCamp(tgt);   // tgt = the entry the editor writes to
    // inline editor under a period: the manual clicks and orders of the selected keyword or campaign for that week
    const editor = p => {
      const ref = !tcamp && kw.ranking && kw.ranking.find(r => r.manual), who = tcamp ? (tgt.display || '') : ref ? ref.name : '';
      const inp = (id, label, v) => '<div><label for="' + id + '" class="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">' + label + '</label><input id="' + id + '" type="number" min="0" step="1" inputmode="numeric" value="' + (v == null ? '' : v) + '" onkeydown="if(event.key===\'Enter\')sqEditSave()" class="border border-slate-300 bg-white p-2 rounded-lg text-sm w-28 outline-none focus:ring-1 focus:ring-blue-500"></div>';
      const bulk = p.ranking ? ' The saved bulk file shows <b>' + plain(p.ranking.clicks) + '</b> clicks and <b>' + plain(p.ranking.orders) + '</b> orders (' + (sv.sel.basis === 'cm' ? 'campaign rows' : 'exact search-term rows') + ').' : '';
      return '<tr class="bg-slate-50 border-t border-slate-100"><td colspan="14" class="px-3 py-3"><div role="group" aria-label="Manual numbers for ' + esc(p.from) + ' to ' + esc(p.to) + '"><p class="text-xs font-bold text-slate-800 mb-1">Manual numbers for ' + esc(tgt.display || tgt.query) + ', ' + esc(p.from) + ' to ' + esc(p.to) + '</p>'
        + '<p class="text-[11px] text-slate-500 mb-2">The clicks and orders you see in Campaign Manager for ' + (who ? '<b>' + esc(who) + '</b>' : 'the ranking campaign') + ' on those dates.' + bulk + '</p>'
        + '<div class="flex flex-wrap items-end gap-3">' + inp('sqEdC', 'Clicks', p.manual && p.manual.clicks) + inp('sqEdO', 'Orders', p.manual && p.manual.orders)
        + '<button type="button" onclick="sqEditSave()" class="bg-blue-700 hover:bg-blue-800 text-white text-xs font-bold px-3 py-2.5 rounded-lg">Save</button>'
        + (p.manual ? '<button type="button" id="sqEdClear" onclick="sqEditClear()" class="border border-slate-300 text-slate-700 text-xs font-bold px-3 py-2.5 rounded-lg hover:bg-white">Remove manual numbers</button>' : '')
        + '<button type="button" onclick="sqEditCancel()" class="text-xs font-semibold text-slate-500 hover:text-slate-800 px-2 py-2.5">Cancel</button></div></div></td></tr>';
    };
    const th = 'px-3 py-2 text-right whitespace-nowrap', thl = 'px-3 py-2 text-left whitespace-nowrap';
    const rows = pts.slice().reverse().map(p => {
      const flag = p.missing ? '<span class="text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 bg-slate-100 text-slate-700" title="This keyword was not saved for this period. It is a gap, not zero.">Not saved</span>'
        : p.manual && !p.ranking && !p.market && !p.asin ? '<span class="text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 bg-slate-100 text-slate-700" title="Only the manual numbers you typed are saved for this period: no bulk or SQP numbers.">Manual only</span>'
        : p.young ? '<span class="text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 bg-amber-100 text-amber-800" title="Pulled less than 14 days after the period ended: ad orders were still arriving, so the ad conversion rate may rise.">Maturing</span>'
        : p.ranking && p.ranking.clicks < S.LOW_CLICKS ? '<span class="text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 bg-amber-100 text-amber-800" title="Fewer than ' + S.LOW_CLICKS + ' ad clicks.">Low sample</span>' : '';
      const c = (m, f) => (p.missing || !m ? '–' : f(m));
      return '<tr class="border-t border-slate-100"><th scope="row" class="' + thl + ' font-semibold text-slate-700">' + esc(p.from) + ' to ' + esc(p.to) + '</th>'
        + (camp ? '' : '<td class="' + th + ' tabular-nums">' + (p.missing ? '–' : plain(p.volume)) + '</td><td class="' + th + ' tabular-nums">' + (p.missing || !p.rank || p.rank.volume == null ? '–' : plain(p.rank.volume)) + '</td><td class="' + th + ' tabular-nums font-bold" title="' + (p.rank && p.rank.date ? 'Cerebro snapshot ' + esc(p.rank.date) : 'No Cerebro report was added for this period') + '">' + (p.missing || !p.rank ? '–' : p.rank.organic ? '#' + p.rank.organic : 'not ranked') + '</td>'
        + '<td class="' + th + ' tabular-nums">' + c(p.market, m => pct(m.cvr)) + '</td><td class="' + th + ' tabular-nums">' + c(p.asin, m => pct(m.cvr)) + '</td>') + '<td class="' + th + ' tabular-nums font-bold">' + c(p.ranking, m => (m.clicks ? pct(m.cvr) : 'no clicks')) + '</td><td class="' + th + ' tabular-nums"' + (p.manual ? ' title="Typed in: ' + p.manual.clicks + ' clicks, ' + p.manual.orders + ' orders"' : '') + '>' + c(p.manual, m => (m.clicks ? pct(m.cvr) : 'no clicks')) + '</td>'
        + '<td class="' + th + ' tabular-nums">' + c(p.ranking, m => plain(m.clicks)) + '</td><td class="' + th + ' tabular-nums">' + c(p.ranking, m => (m.spend ? plain(m.cpc, 2) : '–')) + '</td><td class="' + th + ' tabular-nums">' + c(p.ranking, m => (m.spend ? plain(m.spend, 2) : '–')) + '</td><td class="' + th + ' tabular-nums">' + c(p.ranking, m => (m.spend && m.sales ? pct(m.acos, 0) : '–')) + '</td>'
        + '<td class="' + thl + '">' + flag + '</td><td class="' + th + '"><button type="button" onclick="sqEditPeriod(\'' + esc(p.id) + '\')" class="text-[11px] font-semibold text-blue-700 hover:underline mr-3" aria-label="Edit manual numbers for the period ' + esc(p.from) + '">' + (p.manual ? 'Edit' : 'Add manual') + '</button><button type="button" onclick="sqDelPeriod(\'' + esc(p.id) + '\')" class="text-[11px] font-semibold text-slate-500 hover:text-rose-700" aria-label="Delete the period ' + esc(p.from) + '">Delete</button></td></tr>' + (sv.edit === p.id ? editor(p) : '');
    }).join('');
    $('sqHTable').innerHTML = '<table class="w-full text-xs"><thead><tr class="' + HEAD + '"><th scope="col" class="' + THL + '">Period</th>' + (camp ? '' : '<th scope="col" class="' + TH + '" title="Search volume from the SQP report">Volume (SQP)</th><th scope="col" class="' + TH + '" title="Search volume from the Helium 10 Cerebro report">Volume (H10)</th><th scope="col" class="' + TH + '">Organic rank</th><th scope="col" class="' + TH + '">Market CVR</th><th scope="col" class="' + TH + '">ASIN CVR</th>') + '<th scope="col" class="' + TH + '">Ranking CVR</th><th scope="col" class="' + TH + '" title="Typed in from Campaign Manager">Manual CVR</th><th scope="col" class="' + TH + '">Ranking clicks</th><th scope="col" class="' + TH + '">CPC</th><th scope="col" class="' + TH + '">Spend</th><th scope="col" class="' + TH + '">ACOS</th><th scope="col" class="' + THL + '"></th><th scope="col" class="' + TH + '"></th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
  function histCharts(pts) {
    if (typeof Chart === 'undefined') return; _ppcChartTheme();
    const labels = pts.map(p => p.from.slice(5));
    const line = (label, color, get) => {
      const d = pts.map(p => (p.missing ? null : get(p)));
      return { label, data: d, borderColor: color, backgroundColor: color, borderWidth: 2, tension: 0, spanGaps: false, pointRadius: 4, pointBorderColor: color, pointBorderWidth: 2, pointBackgroundColor: pts.map(p => (p.young ? '#ffffff' : color)) };
    };
    const cvr = m => (m && m.cvr != null ? +(m.cvr * 100).toFixed(2) : null), ctr = m => (m && m.ctr != null ? +(m.ctr * 100).toFixed(3) : null), cpc = m => (m && m.spend && m.cpc != null ? +m.cpc.toFixed(2) : null);
    const draw = (id, ds, fmt) => { _chartDestroy(id); _dashCharts[id] = new Chart($(id), { type: 'line', data: { labels, datasets: ds },
      options: { responsive: true, maintainAspectRatio: false, animation: _dashAnim, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { title: it => { const p = pts[it[0].dataIndex]; return p.from + ' to ' + p.to + (p.young ? ' (maturing)' : ''); }, label: c => c.dataset.label + ': ' + (c.raw == null ? 'no data' : fmt(c.raw)) } } }, scales: _chartBarScales(false, v => fmt(v)) } }); };
    const set = (f, withMarket) => [withMarket ? line('Market', C.market, p => f(p.market)) : null, withMarket ? line('Your ASIN', C.asin, p => f(p.asin)) : null, line('Ranking campaign', C.ranking, p => f(p.ranking)), line('All PPC on term', C.allppc, p => f(p.allppc))].filter(Boolean)
      .filter(d => d.data.some(v => v != null));   // a line with no data at all (campaign tracking has no market or ASIN) is left out
    const hasRank = pts.some(p => p.rank && p.rank.organic > 0);   // rank 1 is the top: the axis runs upside down
    $('sqHRankBox').classList.toggle('hidden', !hasRank); _chartDestroy('sqHChartRank');
    if (hasRank) {
      draw('sqHChartRank', [line('Organic rank', C.asin, p => (p.rank && p.rank.organic > 0 ? p.rank.organic : null)), line('Sponsored rank', C.ranking, p => (p.rank && p.rank.sponsored > 0 ? p.rank.sponsored : null))].filter(d => d.data.some(v => v != null)), v => '#' + v);
      const y = _dashCharts.sqHChartRank.options.scales.y; y.reverse = true; y.min = 1; y.ticks.precision = 0; _dashCharts.sqHChartRank.update();
    }
    const hasVol = pts.some(p => !p.missing && (p.volume != null || (p.rank && p.rank.volume != null)));
    $('sqHVolBox').classList.toggle('hidden', !hasVol); _chartDestroy('sqHChartVol');
    if (hasVol) draw('sqHChartVol', [line('SQP', C.asin, p => (p.volume == null ? null : p.volume)), line('Helium 10', C.ranking, p => (p.rank && p.rank.volume != null ? p.rank.volume : null))].filter(d => d.data.some(v => v != null)), v => plain(v));
    draw('sqHChartCvr', set(cvr, true).concat(pts.some(p => p.manual) ? [Object.assign(line('Manual (Campaign Manager)', C.manual, p => cvr(p.manual)), { borderDash: [6, 4], pointStyle: 'rectRot' })] : []), v => v + '%'); draw('sqHChartCtr', set(ctr, true), v => v + '%'); draw('sqHChartCpc', set(cpc, false), v => plain(v, 2));
  }
  window.sqHistDownload = function () {
    const a = selAsin(), h = a && sv.hist[a.id + '|' + sv.sel.cad], kw = h && h.keywords.find(k => k.id === sv.sel.kw);
    if (!kw) { toast('Nothing to download yet.'); return; }
    const pts = S.series(h, kw.id, sv.sel.basis), L = (m, f) => (m ? m[f] : null);
    const aoa = [['From', 'To', 'Status', 'Search volume (SQP)', 'Search volume (Helium 10)', 'Organic rank (0 = not ranked)', 'Sponsored rank', 'Rank date (Cerebro)', 'Market impressions', 'Market clicks', 'Market orders', 'Market CVR', 'ASIN clicks', 'ASIN orders', 'ASIN CVR', 'Ranking impressions', 'Ranking clicks', 'Ranking orders', 'Ranking CVR', 'Ranking CTR', 'Ranking CPC', 'Ranking spend', 'Ranking sales', 'Ranking ACOS', 'Manual clicks', 'Manual orders', 'Manual CVR', 'All PPC clicks', 'All PPC orders']];
    pts.forEach(p => aoa.push([p.from, p.to, p.missing ? 'not saved' : p.young ? 'maturing' : 'complete', p.volume, L(p.rank, 'volume'), L(p.rank, 'organic'), L(p.rank, 'sponsored'), L(p.rank, 'date'), L(p.market, 'imp'), L(p.market, 'clicks'), L(p.market, 'orders'), L(p.market, 'cvr'), L(p.asin, 'clicks'), L(p.asin, 'orders'), L(p.asin, 'cvr'),
      L(p.ranking, 'imp'), L(p.ranking, 'clicks'), L(p.ranking, 'orders'), L(p.ranking, 'cvr'), L(p.ranking, 'ctr'), p.ranking && p.ranking.spend ? p.ranking.cpc : null, L(p.ranking, 'spend'), L(p.ranking, 'sales'), p.ranking && p.ranking.spend && p.ranking.sales ? p.ranking.acos : null, L(p.manual, 'clicks'), L(p.manual, 'orders'), L(p.manual, 'cvr'), L(p.allppc, 'clicks'), L(p.allppc, 'orders')]));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'History');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['PPCBench SQP Tracker history'], ['Keyword', kw.display || kw.query], ['ASIN', a.asin], ['Report', sv.sel.cad], ['Ranking basis', sv.sel.basis === 'cm' ? 'Campaign rows (matches Campaign Manager)' : 'Exact search-term rows'], [], ['Maturing = the bulk file was pulled less than 14 days after the period ended, so ad orders may still be arriving.'], ['A period marked not saved is a gap, not zero.'], ['Amounts are in your Amazon account currency.']]), 'Info');
    XLSX.writeFile(wb, 'SQP_History_' + a.asin + '_' + (kw.query || 'keyword').replace(/[^a-z0-9]+/gi, '-').slice(0, 40) + '.xlsx'); toast('History downloaded.', 'success');
  };
  window.sqExportAll = async function () {
    try {
      const d = await api('export'), url = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })), a = document.createElement('a');
      a.href = url; a.download = 'ppcbench-sqp-saved-data-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('Your saved data was downloaded.', 'success');
    } catch (e) { toast(esc(errText(e)), 'error'); }
  };
  async function del(kind, id, text) {
    if (!(await confirmModal(text))) return;
    try { await api(kind === 'all' ? 'delete_all' : 'delete', kind === 'all' ? {} : { kind, id }); sv.hist = {}; await loadState(true); toast('Deleted.', 'success'); if (kind === 'all') sv.last = null; await histRender(); renderSave(); }
    catch (e) { toast(esc(errText(e)), 'error'); }
  }
  window.sqAddKeyword = async function () {
    const a = selAsin(), inp = $('sqAddKw'), q = S.norm(inp.value);
    if (!a) { toast('Pick a brand and ASIN first.'); return; }
    if (!q) { toast('Type the keyword to track.'); return; }
    try { const r = await api('add_keyword', { asin_id: a.id, query: q }); inp.value = ''; sv.hist = {}; await loadState(true); sv.sel.kw = r.id; await histRender(); renderSave(); toast('Now tracking "' + esc(q) + '". Its numbers appear when you save a period that includes it.', 'success'); }
    catch (e) { toast(esc(errText(e)), 'error'); }
  };
  window.sqDelPeriod = id => del('period', id, 'Delete this saved period (all its keywords)? This cannot be undone.');
  window.sqDelete = function (kind) {
    const b = selBrand(), a = selAsin();
    if (kind === 'all') return del('all', null, 'Delete everything you have saved in the SQP Tracker, and your saving consent? This cannot be undone.');
    if (kind === 'brand' && b) return del('brand', b.id, 'Delete the brand "' + b.name + '" with all its ASINs, keywords and history? This cannot be undone.');
    if (kind === 'asin' && a) return del('asin', a.id, 'Delete ASIN ' + a.asin + ' with all its keywords and history? This cannot be undone.');
    if (kind === 'keyword' && sv.sel.kw) return del('keyword', sv.sel.kw, 'Delete this keyword and its history for this ASIN? This cannot be undone.');
    toast('Nothing selected.');
  };
  window.sqLoadState = () => loadState().then(() => { renderSave(); prefillNominated(); });   // called after a comparison is loaded
})();
