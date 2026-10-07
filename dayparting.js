// PPCBench Dayparting Planner — engine (pure, testable in node) + UI (browser only, see bottom).
// Input: Amazon Sponsored Products *hourly campaign* report rows.
// Method: rank each hour/day by a score (revenue per click, or sales ÷ spend), pull thin buckets toward the
// account average ("pseudo-clicks"), turn the gap into a bid move, merge hours into schedulable windows, and
// check whether each call repeats in both halves of the date range.
(function (root) {
  'use strict';
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  // header → field. Orders/Sales accept any attribution window ("7 Day", "14 Day", "30 Day").
  const COLS = {
    date: /^start\s*date$|^date$/, hour: /^start\s*time$|^hour$|^time$/, portfolio: /^portfolio/, campaign: /^campaign(\s*name)?$/,
    currency: /^currency/, imp: /^impressions$/, clicks: /^clicks$/, spend: /^(spend|cost)$/,
    orders: /^(\d+\s*day\s*)?total\s*orders/, sales: /^(\d+\s*day\s*)?total\s*sales/
  };
  const REQUIRED = ['date', 'hour', 'clicks', 'spend', 'orders', 'sales'];
  const TIER = 0.15;   // a window needs the hour's gap to be at least ±15% to be worth a bid change
  const MIN_WIN = 2;   // …and to last at least 2 hours
  const hh = h => String(h).padStart(2, '0');

  const norm = h => String(h).replace(/﻿/g, '').trim().toLowerCase().replace(/\s+/g, ' ');

  // "$1,234.50", "1.234,50 €", 12, "" → number
  function num(v) {
    if (typeof v === 'number') return v;
    let s = String(v == null ? '' : v).replace(/[^0-9.,\-]/g, '');
    if (!s) return 0;
    const c = s.lastIndexOf(','), d = s.lastIndexOf('.');
    s = c > d ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  function parseHour(v) {
    if (typeof v === 'number') return v < 1 ? Math.floor(v * 24 + 1e-6) : (v >= 0 && v < 24 ? Math.floor(v) : -1);
    const m = String(v).trim().match(/^(\d{1,2})(?::\d{2}(?::\d{2})?)?\s*([ap]m)?$/i);
    if (!m) return -1;
    let h = +m[1];
    if (m[2]) { h = h % 12 + (m[2].toLowerCase() === 'pm' ? 12 : 0); }
    return h < 24 ? h : -1;
  }

  // → { dow: Monday=0 … Sunday=6, day: days since 1970 } or null. `order` = 'dmy' | 'mdy' resolves 03/04/2026.
  function dateInfo(v, order, ssf) {
    let y, mo, d, m;
    if (typeof v === 'number' && v > 59 && ssf) { const p = ssf.parse_date_code(v); y = p.y; mo = p.m - 1; d = p.d; }
    else {
      const s = String(v).trim();
      if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) { y = +m[1]; mo = m[2] - 1; d = +m[3]; }
      else if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/))) {
        const a = +m[1], b = +m[2]; y = +m[3]; if (y < 100) y += 2000;
        if (order === 'dmy') { d = a; mo = b - 1; } else { mo = a - 1; d = b; }
      } else if ((m = s.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/))) { mo = MONTHS[m[1].toLowerCase()]; d = +m[2]; y = +m[3]; }
      else if ((m = s.match(/(\d{1,2})\.?\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/))) { mo = MONTHS[m[2].toLowerCase()]; d = +m[1]; y = +m[3]; }
      else return null;
    }
    if (mo == null || isNaN(mo) || !(d >= 1 && d <= 31)) return null;
    const ms = Date.UTC(y, mo, d);
    return { dow: (new Date(ms).getUTCDay() + 6) % 7, day: Math.round(ms / 864e5) };
  }
  const dowOf = (v, order, ssf) => { const i = dateInfo(v, order, ssf); return i ? i.dow : -1; };

  // raw sheet rows (objects keyed by header) → { records, skipped, currency }. Throws on missing columns.
  function parseRows(raw, ssf) {
    if (!raw.length) throw new Error('The file has no data rows.');
    const map = {};
    Object.keys(raw[0]).forEach(h => { const n = norm(h); for (const k in COLS) if (!map[k] && COLS[k].test(n)) map[k] = h; });
    const missing = REQUIRED.filter(k => !map[k]);
    if (missing.length) throw new Error('Missing column(s): ' + missing.join(', ') + '. Use an hourly Campaign report.');
    // numeric dates: day-first if any first part > 12, else month-first
    let order = 'mdy';
    for (let i = 0; i < Math.min(raw.length, 500); i++) {
      const m = String(raw[i][map.date]).match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.]\d{2,4}/);
      if (m && +m[1] > 12) { order = 'dmy'; break; }
    }
    const records = [], cur = {}; let skipped = 0;
    for (const r of raw) {
      const di = dateInfo(r[map.date], order, ssf), hour = parseHour(r[map.hour]);
      if (!di || hour < 0) { skipped++; continue; }
      const c = map.currency ? String(r[map.currency]).trim() : ''; if (c) cur[c] = (cur[c] || 0) + 1;
      records.push({
        dow: di.dow, day: di.day, hour, portfolio: map.portfolio ? String(r[map.portfolio]).trim() : '', campaign: map.campaign ? String(r[map.campaign]).trim() : '',
        imp: map.imp ? num(r[map.imp]) : 0, clicks: num(r[map.clicks]), spend: num(r[map.spend]), orders: num(r[map.orders]), sales: num(r[map.sales])
      });
    }
    if (!records.length) throw new Error('No rows had a readable date and hour.');
    const currency = Object.keys(cur).sort((a, b) => cur[b] - cur[a])[0] || 'USD';
    return { records, skipped, currency };
  }

  // ---------------------------------------------------------------- buckets
  const blank = () => ({ imp: 0, clicks: 0, spend: 0, orders: 0, sales: 0 });
  const add = (b, r) => { b.imp += r.imp; b.clicks += r.clicks; b.spend += r.spend; b.orders += r.orders; b.sales += r.sales; };
  function derive(b) {
    b.ctr = b.imp ? b.clicks / b.imp : 0; b.cvr = b.clicks ? b.orders / b.clicks : 0;
    b.cpc = b.clicks ? b.spend / b.clicks : 0; b.rpc = b.clicks ? b.sales / b.clicks : 0;
    b.acos = b.sales ? b.spend / b.sales : 0; b.roas = b.spend ? b.sales / b.spend : 0;
    return b;
  }
  const merged = list => derive(list.reduce((a, b) => { add(a, b); return a; }, blank()));

  // records → day / hour / 168-cell / weekday-profile / weekend-profile aggregates + the trust threshold k
  function aggregate(records, conf) {
    const dow = DAYS.map(blank), hour = Array.from({ length: 24 }, blank), grid = DAYS.map(() => Array.from({ length: 24 }, blank));
    const wd = Array.from({ length: 24 }, blank), we = Array.from({ length: 24 }, blank), total = blank();
    for (const r of records) { add(dow[r.dow], r); add(hour[r.hour], r); add(grid[r.dow][r.hour], r); add(r.dow < 5 ? wd[r.hour] : we[r.hour], r); add(total, r); }
    [dow, hour, wd, we].forEach(l => l.forEach(derive)); grid.forEach(g => g.forEach(derive)); derive(total);
    total.actc = total.orders ? total.clicks / total.orders : 0; // average clicks to convert
    const k = Math.ceil((conf || 5) * total.actc);
    return { dow, hour, grid, wd, we, total, k, minClicks: k, rows: records.length };
  }

  // spread of a metric across buckets (population stdev / mean): how much dayparting could matter
  function cv(list, key) {
    const v = list.map(b => b[key]), m = v.reduce((a, x) => a + x, 0) / v.length;
    return m ? Math.sqrt(v.reduce((a, x) => a + (x - m) * (x - m), 0) / v.length) / m : 0;
  }

  // ---------------------------------------------------------------- scoring
  const round5 = x => Math.round(x * 20) / 20 || 0; // nearest 5%, never -0
  const sc = (b, basis) => basis === 'roas' ? b.roas : b.rpc;
  // Pull a thin bucket toward the account average: k pseudo-clicks that earn (and cost) exactly the average.
  function shrunk(b, T, k, basis) {
    if (basis === 'roas') { const ps = k * T.cpc; return (b.sales + ps * T.roas) / ((b.spend + ps) || 1); }
    return (b.sales + k * T.rpc) / ((b.clicks + k) || 1);
  }
  const ratio = (b, T, k, basis) => { const o = sc(T, basis); return o ? shrunk(b, T, k, basis) / o : 1; };
  const rawAdj = (b, T, basis) => { const o = sc(T, basis || 'rpc'); return o ? Math.max(-1, round5(sc(b, basis || 'rpc') / o - 1)) : 0; };
  const adjOf = (b, T, k, basis) => Math.max(-1, round5(ratio(b, T, k, basis) - 1));
  const trustOf = (b, k) => (b.clicks + k) ? b.clicks / (b.clicks + k) : 0;
  const profitPerClick = (b, margin) => margin == null ? null : b.rpc * margin - b.cpc;

  // Does this bucket sit on the same side of its half's average in BOTH halves of the date range?
  function side(b, T, k, basis) { if (b.clicks < k / 2) return null; const o = sc(T, basis); return o ? sc(b, basis) / o - 1 : null; }
  function stabCmp(bA, bB, TA, TB, k, basis, dir) {
    if (!dir) return 'hold';
    const a = side(bA, TA, k, basis), b = side(bB, TB, k, basis);
    if (a == null || b == null) return 'thin';
    return (dir > 0 ? (a >= 0.05 && b >= 0.05) : (a <= -0.05 && b <= -0.05)) ? 'repeats' : 'mixed';
  }
  // first half = days before the median day, second half = the rest. null when under 4 distinct days.
  function split(records) {
    const days = Array.from(new Set(records.map(r => r.day))).sort((x, y) => x - y);
    if (days.length < 4) return null;
    const mid = days[Math.floor(days.length / 2)];
    return { a: records.filter(r => r.day < mid), b: records.filter(r => r.day >= mid), days: days.length, from: days[0], to: days[days.length - 1], mid };
  }

  // contiguous hours with the same call (boost / cut) ≥ MIN_WIN long → schedulable windows
  function windows(prof, T, k, basis, stabFn) {
    const tier = prof.map(b => { const r = ratio(b, T, k, basis) - 1; return r >= TIER ? 1 : r <= -TIER ? -1 : 0; });
    const out = []; let s = 0;
    for (let h = 1; h <= 24; h++) {
      if (h === 24 || tier[h] !== tier[s]) {
        if (tier[s] !== 0 && h - s >= MIN_WIN) {
          const b = merged(prof.slice(s, h)), adj = adjOf(b, T, k, basis);
          out.push({ from: s, to: h, label: hh(s) + ':00–' + hh(h) + ':00', tier: tier[s], b, adj, trust: trustOf(b, k), stab: stabFn(s, h, tier[s]) });
        }
        s = h;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- full analysis
  // o = { conf (× aCTC, default 5), basis ('rpc' | 'roas'), goal (target ACOS, fraction), margin (fraction) }
  function analyze(records, o) {
    o = o || {};
    const basis = o.basis === 'roas' ? 'roas' : 'rpc', conf = o.conf || 5, goal = o.goal > 0 ? o.goal : null, margin = o.margin > 0 ? o.margin : null;
    const a = aggregate(records, conf), T = a.total, k = a.k, sp = split(records);
    const A = sp ? aggregate(sp.a, conf) : null, B = sp ? aggregate(sp.b, conf) : null;
    const stabOfBuckets = (pick, dir) => A ? stabCmp(pick(A), pick(B), A.total, B.total, k, basis, dir) : 'n/a';

    const toGoal = b => { // how far the hour's real CPC would have to move to land exactly on the goal ACOS
      if (goal == null || !b.clicks || !b.spend) return null;
      return b.sales ? Math.max(-1, round5(goal * b.rpc / b.cpc - 1)) : -1;
    };
    const mk = (label, pick) => {
      const b = pick(a), adj = adjOf(b, T, k, basis);
      return { label, b, adj, raw: rawAdj(b, T, basis), trust: trustOf(b, k), toGoal: toGoal(b), stab: stabOfBuckets(pick, Math.sign(adj)) };
    };
    const blocks = size => { const out = []; for (let s = 0; s < 24; s += size) out.push(mk(hh(s) + ':00–' + hh(s + size) + ':00', g => merged(g.hour.slice(s, s + size)))); return out; };
    const groups = {
      'Days': DAYS.map((d, i) => mk(d, g => g.dow[i])),
      'Weekdays vs weekends': [mk('Weekdays (Mon–Fri)', g => merged(g.dow.slice(0, 5))), mk('Weekends (Sat–Sun)', g => merged(g.dow.slice(5)))],
      '8-hour blocks': blocks(8), '4-hour blocks': blocks(4),
      'Hours': a.hour.map((_, h) => mk(hh(h) + ':00', g => g.hour[h]))
    };

    const win = {
      weekdays: windows(a.wd, T, k, basis, (s, e, dir) => stabOfBuckets(g => merged(g.wd.slice(s, e)), dir)),
      weekends: windows(a.we, T, k, basis, (s, e, dir) => stabOfBuckets(g => merged(g.we.slice(s, e)), dir))
    };
    const all = win.weekdays.concat(win.weekends), sum = t => all.filter(w => w.tier === t).reduce((x, w) => ({ spend: x.spend + w.b.spend, sales: x.sales + w.b.sales }), { spend: 0, sales: 0 });
    const cutS = sum(-1), boostS = sum(1);
    const winSum = {
      cutSpend: cutS.spend, cutSpendShare: T.spend ? cutS.spend / T.spend : 0, cutSalesShare: T.sales ? cutS.sales / T.sales : 0,
      boostSpend: boostS.spend, boostSpendShare: T.spend ? boostS.spend / T.spend : 0, boostSalesShare: T.sales ? boostS.sales / T.sales : 0
    };

    // excess spend: what each hour spent beyond what its sales justify at the benchmark ACOS
    const kind = goal != null ? 'goal' : margin != null ? 'breakeven' : 'average', bench = goal != null ? goal : margin != null ? margin : T.acos;
    const ex = b => Math.max(0, b.spend - b.sales * bench), byHour = a.hour.map(ex);
    const waste = {
      kind, bench, total: byHour.reduce((x, y) => x + y, 0), byHour,
      top: a.hour.map((b, h) => ({ label: hh(h) + ':00', b, excess: byHour[h] })).filter(x => x.excess > 0).sort((x, y) => y.excess - x.excess).slice(0, 5)
    };
    waste.share = T.spend ? waste.total / T.spend : 0;

    // pattern stability across the clear hour-of-day calls (|move| ≥ 10%)
    let stability = null;
    if (A) {
      const calls = groups.Hours.filter(r => Math.abs(r.adj) >= 0.1), by = s => calls.filter(r => r.stab === s);
      const decided = calls.filter(r => r.stab === 'repeats' || r.stab === 'mixed'), dsp = decided.reduce((x, r) => x + r.b.spend, 0);
      stability = {
        calls: calls.length, repeats: by('repeats').length, mixed: by('mixed').length, thin: by('thin').length,
        pct: dsp ? decided.filter(r => r.stab === 'repeats').reduce((x, r) => x + r.b.spend, 0) / dsp : null
      };
    }
    return {
      a, A, B, k, basis, goal, margin, groups, win, winSum, waste, stability,
      range: sp ? { days: sp.days, from: sp.from, to: sp.to, mid: sp.mid } : null,
      profit: margin != null ? T.sales * margin - T.spend : null
    };
  }

  // Which campaigns are worth dayparting? Each campaign gets its own hour profile; "spend in red hours" is the
  // spend sitting in hours it can show are ≥15% worse than its own average, and stability says whether they repeat.
  function rankCampaigns(records, o) {
    o = o || {};
    const basis = o.basis === 'roas' ? 'roas' : 'rpc', conf = o.conf || 5, k = aggregate(records, conf).k, by = new Map();
    for (const r of records) { if (!by.has(r.campaign)) by.set(r.campaign, { campaign: r.campaign, portfolio: r.portfolio, recs: [] }); by.get(r.campaign).recs.push(r); }
    const rows = [];
    by.forEach(c => {
      const ag = aggregate(c.recs, conf), T = ag.total, sp = split(c.recs);
      const A = sp ? aggregate(sp.a, conf) : null, B = sp ? aggregate(sp.b, conf) : null;
      const row = { campaign: c.campaign || '(no name)', portfolio: c.portfolio, b: T, atStake: 0, atStakeShare: 0, stability: null, verdict: 'Needs data', score: 0 };
      if (T.clicks >= 2 * k && T.orders > 0) {
        const red = []; ag.hour.forEach((b, h) => { if (ratio(b, T, k, basis) - 1 <= -TIER) red.push(h); });
        row.atStake = red.reduce((x, h) => x + ag.hour[h].spend, 0); row.atStakeShare = T.spend ? row.atStake / T.spend : 0;
        if (A && red.length) {
          const st = red.map(h => stabCmp(A.hour[h], B.hour[h], A.total, B.total, k, basis, -1));
          const sp0 = red.reduce((x, h) => x + ag.hour[h].spend, 0) || 1;
          row.stability = red.reduce((x, h, i) => x + (st[i] === 'repeats' ? ag.hour[h].spend : 0), 0) / sp0;
        }
        row.score = row.atStake * (row.stability || 0);
        row.verdict = row.atStakeShare >= 0.15 && (row.stability || 0) >= 0.6 ? 'Start here' : row.atStakeShare >= 0.10 ? 'Test' : 'Flat';
      }
      rows.push(row);
    });
    const rank = { 'Start here': 0, 'Test': 1, 'Flat': 2, 'Needs data': 3 };
    return rows.sort((x, y) => rank[x.verdict] - rank[y.verdict] || y.score - x.score || y.b.spend - x.b.spend);
  }

  // Heatmap helper: which direction is "better" for each metric.
  const HEAT = { cvr: true, rpc: true, cpc: false, acos: false, ppc: true };

  const api = { DAYS, cv, num, parseHour, dowOf, dateInfo, parseRows, aggregate, split, analyze, rankCampaigns, rawAdj, adjOf, trustOf, profitPerClick, merged, HEAT, TIER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DP = api;
})(typeof window !== 'undefined' ? window : globalThis);

// ============================== UI (browser only) ==============================
if (typeof document !== 'undefined') (function () {
  'use strict';
  const DP = window.DP, $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const SYM = { USD: '$', CAD: 'CA$', MXN: 'MX$', AUD: 'A$', GBP: '£', EUR: '€', JPY: '¥', INR: '₹', BRL: 'R$', SEK: 'kr ', PLN: 'zł ', TRY: '₺', AED: 'AED ', SAR: 'SAR ', SGD: 'S$' };
  const st = { files: [], recs: [], currency: 'USD', r: null, tab: 'waste', metric: 'rpc', filtered: [], pf: [], rank: null };
  const sym = () => (SYM[st.currency] != null ? SYM[st.currency] : st.currency + ' ');
  const money = n => (n < 0 ? '−' : '') + sym() + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const int = n => Math.round(n || 0).toLocaleString('en-US');
  const pct = (n, d) => ((n || 0) * 100).toFixed(d == null ? 1 : d) + '%';
  const hh = h => String(h).padStart(2, '0');
  const dstr = d => new Date(d * 864e5).toISOString().slice(0, 10);
  const adjTxt = x => x == null ? '–' : x === 0 ? '0%' : (x > 0 ? '+' : '−') + Math.abs(Math.round(x * 100)) + '%';
  const adjCls = x => x > 0 ? 'text-emerald-700' : x < 0 ? 'text-rose-700' : 'text-slate-700';
  const scoreName = () => st.r.basis === 'roas' ? 'ROAS' : 'RPC';
  const scoreVal = b => st.r.basis === 'roas' ? b.roas.toFixed(2) : money(b.rpc);
  const TH = 'px-3 py-2 text-right whitespace-nowrap', THL = 'px-3 py-2 text-left whitespace-nowrap';
  const HEAD = 'bg-slate-50 text-slate-500 text-[10px] font-bold uppercase tracking-wider';
  const BADGES = {
    repeats: ['Repeats', 'text-emerald-700 bg-emerald-100', 'Same direction in both halves of your date range'],
    mixed: ['Mixed', 'text-amber-700 bg-amber-100', 'Flat or flipped in one half: treat as unproven'],
    thin: ['Thin', 'text-slate-600 bg-slate-100', 'Not enough clicks in one half to judge']
  };
  const badge = s => BADGES[s] ? '<span class="text-[9px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 ' + BADGES[s][1] + '" title="' + BADGES[s][2] + '">' + BADGES[s][0] + '</span>' : '<span class="text-slate-400">–</span>';
  const VERDICT = { 'Start here': 'text-emerald-700 bg-emerald-100', 'Test': 'text-amber-700 bg-amber-100', 'Flat': 'text-slate-600 bg-slate-100', 'Needs data': 'text-slate-600 bg-slate-100' };

  // ---- upload ----
  const input = $('dpFile');
  makeDropTarget($('dpDropZone'), input);
  input.addEventListener('change', () => { st.files = Array.from(input.files); showName(); });
  function showName() {
    const el = $('dpFileName'); el.classList.toggle('hidden', !st.files.length);
    el.textContent = st.files.length === 1 ? st.files[0].name : st.files.length + ' files: ' + st.files.map(f => f.name).join(', ');
  }
  const readFile = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(f); });
  function rowsOf(buf, name) {
    if (/\.csv$/i.test(name)) return Papa.parse(new TextDecoder('utf-8').decode(buf), { header: true, skipEmptyLines: true }).data;
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
    let first = null;
    for (const sn of wb.SheetNames) { // first sheet that looks like an hourly report
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: '', raw: true });
      try { DP.parseRows(rows, XLSX.SSF); return rows; } catch (e) { first = first || rows; }
    }
    return first || [];
  }

  window.dpRun = async function () {
    if (!st.files.length) { toast('Upload an hourly Campaign report (.csv or .xlsx) first.'); return; }
    const btn = $('dpRunBtn'); btn.disabled = true;
    btn.innerHTML = '<span class="ppc-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span> Analyzing…';
    await new Promise(r => setTimeout(r, 30));
    try {
      const recs = [], curs = new Set(); let skipped = 0;
      for (const f of st.files) {
        try {
          const p = DP.parseRows(rowsOf(await readFile(f), f.name), XLSX.SSF);
          p.records.forEach(r => recs.push(r)); skipped += p.skipped; curs.add(p.currency);
        } catch (e) { throw new Error(f.name + ': ' + e.message); }
      }
      st.recs = recs; st.currency = Array.from(curs)[0];
      if (curs.size > 1) toast('These files use different currencies (' + Array.from(curs).join(', ') + '). Spend and sales are added together as-is.', 'warning');
      if (skipped) toast(skipped.toLocaleString() + ' row(s) had no readable date or hour and were skipped.', 'warning');
      show();
    } catch (e) { toast(esc(e.message), 'error'); }
    btn.disabled = false; btn.textContent = 'Run Analysis'; lucide.createIcons();
  };

  function show() {
    fillFilters(); $('dpResults').classList.remove('hidden'); recompute();
    $('dpResults').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- filters + inputs ----
  const uniq = (list, k) => Array.from(new Set(list.map(r => r[k]).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const opts = (sel, all, vals, keep) => { sel.innerHTML = '<option value="">' + all + '</option>' + vals.map(v => '<option>' + esc(v) + '</option>').join(''); if (keep && vals.includes(keep)) sel.value = keep; };
  function fillFilters() { opts($('dpPortfolio'), 'All portfolios', uniq(st.recs, 'portfolio')); fillCampaigns(); }
  function fillCampaigns(keep) { const p = $('dpPortfolio').value; opts($('dpCampaign'), 'All campaigns', uniq(p ? st.recs.filter(r => r.portfolio === p) : st.recs, 'campaign'), keep); }
  window.dpFilterChanged = function (portfolioChanged) { if (portfolioChanged) fillCampaigns(); else fillCampaigns($('dpCampaign').value); recompute(); };
  const frac = id => { const v = parseFloat($(id).value); return v > 0 ? v / 100 : null; };

  function recompute() {
    const p = $('dpPortfolio').value, c = $('dpCampaign').value;
    st.pf = st.recs.filter(r => !p || r.portfolio === p);
    st.filtered = st.pf.filter(r => !c || r.campaign === c);
    st.o = { conf: Math.max(1, parseFloat($('dpConf').value) || 5), basis: $('dpBasis').value, goal: frac('dpGoal'), margin: frac('dpMargin') };
    st.r = DP.analyze(st.filtered, st.o); st.rank = null;
    if (!st.r.margin && st.metric === 'ppc') st.metric = 'rpc';
    renderKpis(); dpTab(st.tab);
  }

  function renderKpis() {
    const r = st.r, T = r.a.total, tile = (l, v, hint) => '<div class="bg-slate-50 border border-slate-200 rounded-lg p-3"' + (hint ? ' title="' + hint + '"' : '') + '><p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">' + l + '</p><p class="text-base font-black text-slate-800 tabular-nums mt-0.5">' + v + '</p></div>';
    $('dpKpis').innerHTML = tile('Rows', int(r.a.rows)) + tile('Impressions', int(T.imp)) + tile('Clicks', int(T.clicks)) + tile('Spend', money(T.spend)) + tile('Sales', money(T.sales))
      + tile('CVR · aCTC', pct(T.cvr) + ' · ' + (T.actc ? T.actc.toFixed(1) : '–'), 'aCTC = average clicks to convert (clicks ÷ orders)')
      + tile('CPC · RPC', money(T.cpc) + ' · ' + money(T.rpc), 'RPC = revenue per click (sales ÷ clicks)')
      + tile('ACOS · ROAS', (T.sales ? pct(T.acos) : '–') + ' · ' + T.roas.toFixed(2))
      + (r.profit != null ? tile('Profit after ads', money(r.profit), 'Sales × margin − ad spend') : '');
    $('dpNote').textContent = (r.range ? r.range.days + ' days of data (' + dstr(r.range.from) + ' to ' + dstr(r.range.to) + '). ' : 'Under 4 days of data: the repeat check is off. ')
      + (T.orders ? 'Trust threshold: ' + r.k + ' clicks (' + st.o.conf + ' × aCTC ' + T.actc.toFixed(1) + ').' : 'No orders in this selection, so there is nothing to compare against.');
  }

  // ---- tabs ----
  window.dpTab = function (tab) {
    st.tab = tab;
    document.querySelectorAll('.dp-tab').forEach(b => b.setAttribute('aria-selected', b.dataset.dpTab === tab ? 'true' : 'false'));
    if (!st.r) return;
    if (!st.r.a.total.clicks) { $('dpPanel').innerHTML = '<p class="text-sm text-slate-600">No clicks in this selection.</p>'; return; }
    $('dpPanel').innerHTML = tab === 'waste' ? wastePanel() : tab === 'rhythm' ? rhythmPanel() : tab === 'schedule' ? schedulePanel() : campaignsPanel();
    lucide.createIcons();
    if (tab === 'waste') drawWaste(); if (tab === 'rhythm') drawRhythm();
  };
  window.dpMetric = function (m) { st.metric = m; dpTab('rhythm'); };

  const card = (label, value, sub) => '<div class="border border-slate-200 rounded-xl p-4"><p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">' + label + '</p><p class="text-2xl font-black text-slate-800 tabular-nums mt-1">' + value + '</p><p class="text-xs text-slate-600 mt-1 leading-snug">' + sub + '</p></div>';
  const chartBox = (id, title, hint) => '<div class="border border-slate-200 rounded-xl p-4"><h3 class="text-xs font-bold text-slate-600 mb-2">' + title + (hint ? ' <span class="font-medium text-slate-500">— ' + hint + '</span>' : '') + '</h3><div class="relative h-[240px]"><canvas id="' + id + '" role="img" aria-label="' + esc(title) + '"></canvas></div></div>';

  // ---- WASTE ----
  function wastePanel() {
    const r = st.r, w = r.waste, ws = r.winSum, S = r.stability;
    const benchTxt = w.kind === 'goal' ? 'your target ACOS of ' + pct(w.bench, 0) : w.kind === 'breakeven' ? 'break-even ACOS (your ' + pct(w.bench, 0) + ' margin)' : 'your account-average ACOS of ' + pct(w.bench, 0);
    const head = '<p class="text-sm text-slate-700 leading-relaxed mb-4"><b class="text-rose-700">' + money(w.total) + '</b> (' + pct(w.share) + ' of spend) was spent beyond what each hour\'s sales justify at ' + benchTxt + '. ' + (w.kind === 'average' ? 'Add a target ACOS or margin above to measure against your goal instead of your average.' : '') + '</p>';
    const hasCut = r.win.weekdays.concat(r.win.weekends).some(x => x.tier < 0);
    const cards = '<div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">'
      + card('Spend in cut windows', hasCut ? pct(ws.cutSpendShare) : '–', hasCut ? 'earns ' + pct(ws.cutSalesShare) + ' of sales (' + money(ws.cutSpend) + ' of spend)' : 'No window is clearly worse than average, so there is nothing to cut.')
      + card('Do the patterns repeat?', S && S.pct != null ? pct(S.pct, 0) : '–', S ? (S.pct != null ? 'of spend behind clear hourly calls moves the same way in both halves of your data (' + S.thin + ' of ' + S.calls + ' calls too thin to judge)' : 'No hourly call has enough clicks in both halves to judge.') : 'Needs at least 4 days of data.')
      + (r.profit != null ? card('Profit after ads', money(r.profit), pct(r.a.total.sales ? r.profit / r.a.total.sales : 0) + ' of sales at a ' + pct(r.margin, 0) + ' margin') : card('Spend in boost windows', hasCut || r.winSum.boostSpend ? pct(ws.boostSpendShare) : '–', r.winSum.boostSpend ? 'brings back ' + pct(ws.boostSalesShare) + ' of sales' : 'No window clearly beats average.'))
      + '</div>';
    const top = w.top.length ? '<h3 class="text-sm font-extrabold text-slate-800 mt-5 mb-2">Costliest hours</h3><div class="overflow-x-auto border border-slate-200 rounded-xl"><table class="w-full text-xs"><thead><tr class="' + HEAD + '"><th scope="col" class="' + THL + '">Hour</th><th scope="col" class="' + TH + '">Spend</th><th scope="col" class="' + TH + '">Sales</th><th scope="col" class="' + TH + '">ACOS</th><th scope="col" class="' + TH + '">Excess spend</th></tr></thead><tbody>'
      + w.top.map(x => '<tr class="border-t border-slate-100"><th scope="row" class="' + THL + ' font-semibold text-slate-700">' + x.label + '</th><td class="' + TH + ' tabular-nums">' + money(x.b.spend) + '</td><td class="' + TH + ' tabular-nums">' + money(x.b.sales) + '</td><td class="' + TH + ' tabular-nums">' + (x.b.sales ? pct(x.b.acos) : 'no sales') + '</td><td class="' + TH + ' tabular-nums font-bold text-rose-700">' + money(x.excess) + '</td></tr>').join('') + '</tbody></table></div>' : '';
    return head + cards + '<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">' + chartBox('dpShareHour', 'Where the money goes vs where it comes back', 'by hour. Spend bar above the sales bar = leak') + chartBox('dpShareDay', 'Same view by day of week') + '</div>' + top;
  }
  function drawWaste() {
    const a = st.r.a, T = a.total, share = (b, k) => T[k] ? +(b[k] / T[k] * 100).toFixed(2) : 0;
    shareChart('dpShareHour', a.hour.map((_, h) => hh(h)), a.hour);
    shareChart('dpShareDay', DP.DAYS.map(d => d.slice(0, 3)), a.dow);
    function shareChart(id, labels, rows) {
      if (typeof Chart === 'undefined') return; _ppcChartTheme(); _chartDestroy(id);
      _dashCharts[id] = new Chart($(id), { type: 'bar', data: { labels, datasets: [
        { label: 'Share of spend', data: rows.map(b => share(b, 'spend')), backgroundColor: '#94a3b8', borderRadius: 4, maxBarThickness: 18 },
        { label: 'Share of sales', data: rows.map(b => share(b, 'sales')), backgroundColor: '#10b981', borderRadius: 4, maxBarThickness: 18 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: _dashAnim, plugins: { legend: { position: 'bottom' }, tooltip: { displayColors: true, callbacks: { label: c => c.dataset.label + ': ' + c.raw + '%' } } }, scales: _chartBarScales(false, v => v + '%') } });
    }
  }

  // ---- RHYTHM ----
  const METRICS = {
    rpc: { l: 'Revenue per click', f: b => b.rpc, fmt: v => money(v) },
    cvr: { l: 'Conversion rate', f: b => b.cvr, fmt: v => pct(v) },
    cpc: { l: 'Cost per click', f: b => b.cpc, fmt: v => money(v) },
    acos: { l: 'ACOS', f: b => b.acos, fmt: v => pct(v, 0) },
    ppc: { l: 'Profit per click', f: b => DP.profitPerClick(b, st.r.margin), fmt: v => money(v) }
  };
  function rhythmPanel() {
    const r = st.r, a = r.a, T = a.total, M = METRICS[st.metric], k2 = r.k / 2;
    const sel = '<label for="dpMetricSel" class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mr-2">Metric</label><select id="dpMetricSel" onchange="dpMetric(this.value)" class="border border-slate-300 bg-white p-1.5 rounded-lg text-xs font-medium outline-none focus:ring-1 focus:ring-teal-500">'
      + Object.keys(METRICS).filter(m => m !== 'ppc' || r.margin).map(m => '<option value="' + m + '"' + (m === st.metric ? ' selected' : '') + '>' + METRICS[m].l + '</option>').join('') + '</select>';
    const base = st.metric === 'acos' ? (r.goal != null ? r.goal : r.margin != null ? r.margin : T.acos) : st.metric === 'ppc' ? 0 : T[st.metric];
    const maxAbs = st.metric === 'ppc' ? Math.max(0.01, ...a.grid.flat().filter(b => b.clicks).map(b => Math.abs(M.f(b)))) : 1;
    const head = '<tr><th class="dp-rowh" scope="col"></th>' + Array.from({ length: 24 }, (_, h) => '<th scope="col">' + hh(h) + '</th>').join('') + '</tr>';
    const rows = DP.DAYS.map((d, di) => '<tr><th scope="row" class="dp-rowh">' + d.slice(0, 3) + '</th>' + a.grid[di].map((b, h) => {
      if (!b.clicks) return '<td style="opacity:.35">–</td>';
      const noSales = st.metric === 'acos' && !b.sales, v = M.f(b);
      const dev = noSales ? 1 : st.metric === 'ppc' ? v / maxAbs : base ? (v - base) / base : 0;
      const good = noSales ? false : st.metric === 'ppc' ? v > 0 : DP.HEAT[st.metric] ? dev > 0 : dev < 0;
      const alpha = Math.min(0.7, 0.1 + Math.min(1, Math.abs(dev)) * 0.6), col = good ? '16,185,129' : '244,63,94';
      const tip = d + ' ' + hh(h) + ':00 — ' + int(b.clicks) + ' clicks, ' + int(b.orders) + ' orders, ' + money(b.spend) + ' spend, ' + money(b.sales) + ' sales';
      return '<td style="background:rgba(' + col + ',' + alpha.toFixed(2) + ');' + (b.clicks < k2 ? 'opacity:.5' : '') + '" title="' + esc(tip) + '">' + (noSales ? '∞' : M.fmt(v).replace(sym(), '')) + '</td>';
    }).join('') + '</tr>').join('');
    const note = st.metric === 'acos' ? ' ACOS is compared with ' + (r.goal != null ? 'your target' : r.margin != null ? 'break-even' : 'your average') + '; ∞ = clicks but no sales.' : st.metric === 'ppc' ? ' Green = earning after ad spend, red = losing money.' : '';
    const num = (title, first, labels, list) => '<details class="mt-3 border border-slate-200 rounded-xl"><summary class="cursor-pointer px-4 py-2.5 text-sm font-bold text-slate-800 select-none">' + title + '</summary><p class="px-4 pb-2 text-[11px] text-slate-500"><b class="text-emerald-700">Green</b> / <b class="text-rose-700">red</b> = better / worse than your ' + (st.r.waste.kind === 'average' ? 'average' : 'average (ACOS: your ' + (st.r.waste.kind === 'goal' ? 'target' : 'break-even') + ')') + ' for CTR, CVR, CPC, ACOS and RPC. Grey shading = volume (darker = more). Faded rows have under ' + Math.ceil(st.r.k / 2) + ' clicks.</p><div class="overflow-x-auto px-2 pb-3">' + numTable(first, labels, list) + '</div></details>';
    return '<h2 class="text-base font-extrabold text-slate-800 mb-1">Weekday vs weekend rhythm</h2><p class="text-xs text-slate-600 mb-3">The shape of an average weekday and an average weekend, hour by hour.</p>'
      + '<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">' + chartBox('dpRhyScore', scoreName() + ' by hour', 'higher = a click is worth more') + chartBox('dpRhySpend', 'Where spend sits by hour', 'share of each profile\'s spend') + '</div>'
      + '<div class="flex flex-wrap items-center justify-between gap-2 mb-2"><h2 class="text-base font-extrabold text-slate-800">The week, hour by hour</h2><div>' + sel + '</div></div>'
      + '<p class="text-xs text-slate-600 mb-2">Each cell is one weekday × hour. <b class="text-emerald-700">Green</b> = better than ' + (st.metric === 'ppc' ? 'break-even' : 'your average') + ', <b class="text-rose-700">red</b> = worse. Faded = under ' + Math.ceil(k2) + ' clicks.' + note + '</p>'
      + '<div class="overflow-x-auto"><table class="dp-heat">' + head + rows + '</table></div>'
      + num('Numbers by day of week', 'Day', DP.DAYS, a.dow) + num('Numbers by hour of day', 'Hour', a.hour.map((_, h) => hh(h) + ':00'), a.hour);
  }
  function numTable(first, labels, rows) {
    const T = st.r.a.total, cols = [['imp', 'Impr.', int], ['clicks', 'Clicks', int], ['orders', 'Orders', int], ['spend', 'Spend', money], ['pctSpend', '% Spend'], ['sales', 'Sales', money], ['ctr', 'CTR', v => pct(v, 2)], ['cvr', 'CVR', pct], ['cpc', 'CPC', money], ['acos', 'ACOS', pct], ['rpc', 'RPC', money]];
    const cell = (c, b) => c[0] === 'pctSpend' ? pct(T.spend ? b.spend / T.spend : 0) : (c[0] === 'acos' && !b.sales) ? '–' : c[2](b[c[0]]);
    // colour: efficiency columns green/red vs your average (ACOS vs your goal/break-even/average); volume columns grey intensity
    const bench = st.r.waste.bench, k2 = st.r.k / 2, EFF = { ctr: true, cvr: true, rpc: true, cpc: false, acos: false };
    const vmax = {}; cols.forEach(c => { if (!(c[0] in EFF)) vmax[c[0]] = Math.max(...rows.map(b => c[0] === 'pctSpend' ? b.spend : b[c[0]]), 1e-9); });
    const shade = (c, b, isTotal) => {
      const key = c[0];
      if (isTotal || !b.clicks) return '';
      if (key in EFF) {
        const noSales = key === 'acos' && !b.sales, base = key === 'acos' ? bench : T[key];
        if (!noSales && !base) return '';
        const dev = noSales ? 1 : (b[key] - base) / base, good = noSales ? false : EFF[key] ? dev > 0 : dev < 0;
        return ' style="background:rgba(' + (good ? '16,185,129' : '244,63,94') + ',' + Math.min(0.45, 0.08 + Math.min(1, Math.abs(dev)) * 0.4).toFixed(2) + ');' + (b.clicks < k2 ? 'opacity:.6' : '') + '"';
      }
      return ' style="background:rgba(148,163,184,' + (0.05 + 0.25 * (key === 'pctSpend' ? b.spend : b[key]) / vmax[key]).toFixed(2) + ')"';
    };
    const td = (c, b, t) => '<td class="' + TH + ' tabular-nums"' + shade(c, b, t) + '>' + cell(c, b) + '</td>';
    return '<table class="w-full text-xs"><thead><tr class="' + HEAD + '"><th scope="col" class="' + THL + '">' + first + '</th>' + cols.map(c => '<th scope="col" class="' + TH + '">' + c[1] + '</th>').join('') + '</tr></thead><tbody>'
      + rows.map((b, i) => '<tr class="border-t border-slate-100"><th scope="row" class="' + THL + ' font-semibold text-slate-700">' + labels[i] + '</th>' + cols.map(c => td(c, b)).join('') + '</tr>').join('')
      + '<tr class="border-t-2 border-slate-300 font-bold bg-slate-50"><th scope="row" class="' + THL + '">Total</th>' + cols.map(c => td(c, T, true)).join('') + '</tr>'
      + '<tr class="border-t border-slate-200 text-slate-500" title="Spread across the rows (stdev ÷ mean). Higher = more variation to exploit."><th scope="row" class="' + THL + ' font-semibold">Variation</th>' + cols.map(c => '<td class="' + TH + ' tabular-nums">' + DP.cv(rows, c[0] === 'pctSpend' ? 'spend' : c[0]).toFixed(2) + '</td>').join('') + '</tr></tbody></table>';
  }
  function drawRhythm() {
    if (typeof Chart === 'undefined') return; _ppcChartTheme(); const a = st.r.a, labels = a.hour.map((_, h) => hh(h)), basis = st.r.basis;
    const sw = a.wd.reduce((x, b) => x + b.spend, 0) || 1, se = a.we.reduce((x, b) => x + b.spend, 0) || 1;
    const line = (id, ds, fmt, tickFmt) => { _chartDestroy(id); _dashCharts[id] = new Chart($(id), { type: 'line', data: { labels, datasets: ds.map(d => Object.assign({ borderWidth: 2, pointRadius: 2, tension: 0.3, spanGaps: true }, d)) },
      options: { responsive: true, maintainAspectRatio: false, animation: _dashAnim, plugins: { legend: { position: 'bottom' }, tooltip: { displayColors: true, callbacks: { label: c => c.dataset.label + ': ' + fmt(c.raw) } } }, scales: { x: { grid: { display: false }, border: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0 } }, y: { grid: { color: 'rgba(148,163,184,0.12)' }, border: { display: false }, ticks: { font: { size: 10 }, callback: tickFmt, maxTicksLimit: 5 } } } } }); };
    const v = b => b.clicks ? (basis === 'roas' ? +b.roas.toFixed(2) : +b.rpc.toFixed(2)) : null;
    line('dpRhyScore', [{ label: 'Weekdays', data: a.wd.map(v), borderColor: '#334155', backgroundColor: '#334155' }, { label: 'Weekends', data: a.we.map(v), borderColor: '#c2410c', backgroundColor: '#c2410c' }], x => basis === 'roas' ? x : money(x), x => basis === 'roas' ? x : sym().trim() + x);
    line('dpRhySpend', [{ label: 'Weekdays', data: a.wd.map(b => +(b.spend / sw * 100).toFixed(2)), borderColor: '#334155', backgroundColor: '#334155' }, { label: 'Weekends', data: a.we.map(b => +(b.spend / se * 100).toFixed(2)), borderColor: '#c2410c', backgroundColor: '#c2410c' }], x => x + '%', x => x + '%');
  }

  // ---- SCHEDULE ----
  function winTable(title, list) {
    const r = st.r, goalCol = r.goal != null;
    if (!list.length) return '<div class="border border-slate-200 rounded-xl p-4"><h2 class="text-sm font-extrabold text-slate-800 mb-1">' + title + '</h2><p class="text-xs text-slate-600">No window clears ±' + Math.round(DP.TIER * 100) + '% with enough support. Keep a flat bid.</p></div>';
    return '<div class="border border-slate-200 rounded-xl overflow-hidden"><h2 class="text-sm font-extrabold text-slate-800 px-4 py-2.5 bg-slate-50 border-b border-slate-200">' + title + '</h2><div class="overflow-x-auto"><table class="w-full text-xs"><thead><tr class="text-slate-500 text-[10px] font-bold uppercase tracking-wider"><th scope="col" class="' + THL + '">Window</th><th scope="col" class="' + TH + '">Bid move</th><th scope="col" class="' + TH + '">Spend (share)</th><th scope="col" class="' + TH + '">Clicks</th><th scope="col" class="' + TH + '">Trust</th><th scope="col" class="' + TH + '">Repeats?</th></tr></thead><tbody>'
      + list.map(w => '<tr class="border-t border-slate-100"><th scope="row" class="' + THL + ' font-semibold text-slate-700">' + w.label + '</th><td class="' + TH + ' tabular-nums font-bold ' + adjCls(w.adj) + '">' + adjTxt(w.adj) + '</td><td class="' + TH + ' tabular-nums">' + money(w.b.spend) + ' (' + pct(r.a.total.spend ? w.b.spend / r.a.total.spend : 0, 0) + ')</td><td class="' + TH + ' tabular-nums">' + int(w.b.clicks) + '</td><td class="' + TH + ' tabular-nums">' + pct(w.trust, 0) + '</td><td class="' + TH + '">' + badge(w.stab) + '</td></tr>').join('') + '</tbody></table></div></div>';
  }
  function bidTable(title, rows) {
    const r = st.r, goal = r.goal != null;
    return '<details class="border border-slate-200 rounded-xl overflow-hidden"><summary class="cursor-pointer px-4 py-2.5 text-sm font-extrabold text-slate-800 bg-slate-50 select-none">' + title + '</summary><div class="overflow-x-auto"><table class="w-full text-xs"><thead><tr class="text-slate-500 text-[10px] font-bold uppercase tracking-wider"><th scope="col" class="' + THL + '">Segment</th><th scope="col" class="' + TH + '">Clicks</th><th scope="col" class="' + TH + '">' + scoreName() + '</th><th scope="col" class="' + TH + '" title="clicks ÷ (clicks + trust threshold)">Trust</th><th scope="col" class="' + TH + '">Bid move</th><th scope="col" class="' + TH + '" title="Raw gap with no damping">Undamped</th><th scope="col" class="' + TH + '">Repeats?</th>' + (goal ? '<th scope="col" class="' + TH + '" title="How far the real CPC would move to land on your target ACOS">To hit target</th>' : '') + '</tr></thead><tbody>'
      + rows.map(x => '<tr class="border-t border-slate-100"><th scope="row" class="' + THL + ' font-semibold text-slate-700">' + x.label + '</th><td class="' + TH + ' tabular-nums">' + int(x.b.clicks) + '</td><td class="' + TH + ' tabular-nums">' + scoreVal(x.b) + '</td><td class="' + TH + ' tabular-nums">' + pct(x.trust, 0) + '</td><td class="' + TH + ' tabular-nums font-bold ' + adjCls(x.adj) + '">' + adjTxt(x.adj) + '</td><td class="' + TH + ' tabular-nums text-slate-500">' + adjTxt(x.raw) + '</td><td class="' + TH + '">' + badge(x.stab) + '</td>' + (goal ? '<td class="' + TH + ' tabular-nums">' + adjTxt(x.toGoal) + '</td>' : '') + '</tr>').join('') + '</tbody></table></div></details>';
  }
  function schedulePanel() {
    const r = st.r, T = r.a.total;
    const how = '<div class="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-4 text-xs text-slate-600 leading-relaxed"><p><b class="text-slate-800">How the move is worked out.</b> Each bucket is scored by ' + (r.basis === 'roas' ? 'ROAS (sales ÷ spend)' : 'revenue per click (sales ÷ clicks)') + '. A bucket with few clicks is pulled toward your average by adding <b>' + r.k + '</b> pseudo-clicks that earn exactly the average (trust = clicks ÷ (clicks + ' + r.k + ')). Bid move = damped score ÷ overall score − 1, to the nearest 5%. Overall ' + scoreName() + ' is ' + scoreVal(T) + '. A window is 2+ hours in a row that are at least ' + Math.round(DP.TIER * 100) + '% above or below average.</p>'
      + '<p class="mt-1"><b class="text-slate-800">Repeats?</b> ' + (r.range ? 'Your data is split in two (before and from ' + dstr(r.range.mid) + '). A call <b>repeats</b> when both halves agree it is above (or below) average by 5%+; <b>mixed</b> means one half disagrees; <b>thin</b> means a half had under ' + Math.ceil(r.k / 2) + ' clicks. Act on windows that repeat first.' : 'Needs 4+ days of data.') + '</p></div>';
    return how + '<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">' + winTable('Weekdays (Mon–Fri) windows', r.win.weekdays) + winTable('Weekends (Sat–Sun) windows', r.win.weekends) + '</div>'
      + '<h2 class="text-sm font-extrabold text-slate-800 mb-2">Bid moves by segment</h2><div class="grid gap-2">' + Object.keys(r.groups).map(g => bidTable(g, r.groups[g])).join('') + '</div>';
  }

  // ---- CAMPAIGNS ----
  function campaignsPanel() {
    if (!st.rank) st.rank = DP.rankCampaigns(st.pf, st.o);
    const all = st.rank.map((c, i) => Object.assign({ i }, c)), live = all.filter(c => c.b.clicks > 0);
    const judged = live.filter(c => c.verdict !== 'Needs data'), thin = live.filter(c => c.verdict === 'Needs data'), idle = all.length - live.length;
    const row = c => '<tr class="border-t border-slate-100"><th scope="row" class="px-3 py-2 text-left font-semibold text-slate-700 max-w-[320px]"><span class="block truncate" title="' + esc(c.campaign) + '">' + esc(c.campaign) + '</span>' + (c.portfolio ? '<span class="block text-[10px] font-medium text-slate-500 truncate">' + esc(c.portfolio) + '</span>' : '') + '</th><td class="' + TH + ' tabular-nums">' + money(c.b.spend) + '</td><td class="' + TH + ' tabular-nums">' + int(c.b.clicks) + '</td><td class="' + TH + ' tabular-nums">' + (c.b.sales ? pct(c.b.acos, 0) : '–') + '</td><td class="' + TH + ' tabular-nums">' + (c.verdict === 'Needs data' ? '–' : money(c.atStake) + ' (' + pct(c.atStakeShare, 0) + ')') + '</td><td class="' + TH + ' tabular-nums">' + (c.stability == null ? '–' : pct(c.stability, 0)) + '</td><td class="' + TH + '"><span class="text-[9px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 ' + VERDICT[c.verdict] + '">' + c.verdict + '</span></td><td class="' + TH + '"><button onclick="dpFocus(' + c.i + ')" class="text-teal-700 font-bold hover:underline">Plan &rarr;</button></td></tr>';
    const table = list => '<div class="overflow-x-auto border border-slate-200 rounded-xl"><table class="w-full text-xs"><thead><tr class="' + HEAD + '"><th scope="col" class="' + THL + '">Campaign</th><th scope="col" class="' + TH + '">Spend</th><th scope="col" class="' + TH + '">Clicks</th><th scope="col" class="' + TH + '">ACOS</th><th scope="col" class="' + TH + '">In red hours</th><th scope="col" class="' + TH + '">Repeats</th><th scope="col" class="' + TH + '">Verdict</th><th scope="col" class="' + TH + '"></th></tr></thead><tbody>' + list.map(row).join('') + '</tbody></table></div>';
    const minC = 2 * st.r.k;
    return '<h2 class="text-base font-extrabold text-slate-800 mb-1">Which campaigns are worth dayparting?</h2><p class="text-xs text-slate-600 mb-3 leading-relaxed"><b>In red hours</b> is the spend a campaign puts into hours at least ' + Math.round(DP.TIER * 100) + '% worse than its own average (damped for thin data). <b>Repeats</b> is the share of that spend whose hours are also red in both halves of your data. <b>Start here</b> = 15%+ of spend in red hours and 60%+ repeating; <b>Test</b> = 10%+. A campaign needs ' + minC + '+ clicks (2× the trust threshold) to be judged. Uses your portfolio filter, not the campaign filter.</p>'
      + (judged.length ? table(judged) : '<p class="text-sm text-slate-700 border border-slate-200 rounded-xl p-4">No campaign has ' + minC + '+ clicks in this data yet. Try a longer date range, or run the whole account together on the Schedule tab.</p>')
      + (thin.length ? '<details class="mt-3 border border-slate-200 rounded-xl"><summary class="cursor-pointer px-4 py-2.5 text-sm font-bold text-slate-800 select-none">' + thin.length + ' more campaign' + (thin.length === 1 ? '' : 's') + ' need more data (under ' + minC + ' clicks)</summary><div class="px-2 pb-3">' + table(thin) + '</div></details>' : '')
      + (idle ? '<p class="text-[11px] text-slate-500 mt-2">' + idle + ' campaign' + (idle === 1 ? ' has' : 's have') + ' no clicks in this range and ' + (idle === 1 ? 'is' : 'are') + ' not listed.</p>' : '');
  }
  window.dpFocus = function (i) {
    const c = st.rank[i]; if (!c) return;
    $('dpPortfolio').value = c.portfolio || ''; fillCampaigns(); $('dpCampaign').value = c.campaign;
    st.tab = 'schedule'; recompute(); $('dpResults').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // ---- download: styled workbook with live colour scales and embedded charts (ExcelJS) ----
  const XC = { dark: 'FF0F172A', line: 'FFE2E8F0', white: 'FFFFFFFF', rose: 'FFFDA4AF', roseL: 'FFFFE4E6', roseT: 'FFBE123C', em: 'FF6EE7B7', emL: 'FFD1FAE5', emT: 'FF047857', ambL: 'FFFEF3C7', ambT: 'FFB45309', slL: 'FFF1F5F9', slT: 'FF475569', slM: 'FFCBD5E1' };
  const solid = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

  // Render a Chart.js config to a PNG data URL on a detached canvas (white background, no animation).
  function chartPng(type, labels, datasets, o) {
    o = o || {};
    const c = document.createElement('canvas'); c.width = o.w || 760; c.height = o.h || 320;
    const ch = new Chart(c, { type, data: { labels, datasets }, plugins: [{ id: 'bg', beforeDraw(x) { const g = x.ctx; g.save(); g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#ffffff'; g.fillRect(0, 0, x.width, x.height); g.restore(); } }],
      options: { responsive: false, animation: false, devicePixelRatio: 2, maintainAspectRatio: false, indexAxis: o.horizontal ? 'y' : 'x',
        plugins: { title: { display: true, text: o.title, align: 'start', color: '#0f172a', font: { size: 13, weight: '700' }, padding: { bottom: 10 } }, legend: { display: datasets.length > 1, position: 'bottom' } },
        scales: o.scales || _chartBarScales(!!o.horizontal, o.fmt) } });
    const url = c.toDataURL('image/png'); ch.destroy(); return url;
  }

  window.dpDownload = async function () {
    if (typeof ExcelJS === 'undefined') { toast('The Excel library is still loading. Try again in a moment.', 'warning'); return; }
    toast('Building your plan…');
    await new Promise(r => setTimeout(r, 30));
    _ppcChartTheme();
    const r = st.r, a = r.a, T = a.total, bench = r.waste.bench, wb = new ExcelJS.Workbook(); wb.creator = 'PPCBench';
    const cur = sym().trim(), F = { int: '#,##0', money: '"' + cur + '"#,##0.00', pct: '0.0%', pct0: '0%', pct2: '0.00%', n2: '0.00', move: '+0%;-0%;0%' };
    const sc = b => r.basis === 'roas' ? b.roas : b.rpc, scFmt = r.basis === 'roas' ? F.n2 : F.money;
    const hl = a.hour.map((_, h) => hh(h) + ':00'), hs = a.hour.map((_, h) => hh(h));

    const sheet = (name, widths) => { const ws = wb.addWorksheet(name, { views: [{ showGridLines: false }] }); ws.columns = widths.map(w => ({ width: w })); return ws; };
    const title = (ws, row, text, size) => { const c = ws.getRow(row).getCell(1); c.value = text; c.font = { bold: true, size: size || 14, color: { argb: XC.dark } }; };
    const note = (ws, row, text) => { const c = ws.getRow(row).getCell(1); c.value = text; c.font = { italic: true, size: 9, color: { argb: XC.slT } }; };
    const head = (ws, row, vals) => { vals.forEach((v, i) => { const c = ws.getRow(row).getCell(i + 1); c.value = v; c.font = { bold: true, size: 10, color: { argb: XC.white } }; c.fill = solid(XC.dark); c.alignment = { horizontal: i ? 'right' : 'left', vertical: 'middle', wrapText: true }; }); };
    const put = (ws, row, vals, fmts, bold) => vals.forEach((v, i) => { const c = ws.getRow(row).getCell(i + 1); c.value = v == null ? null : v; if (fmts && fmts[i]) c.numFmt = fmts[i]; c.border = { bottom: { style: 'thin', color: { argb: XC.line } } }; c.font = { size: 10, bold: !!bold }; if (i) c.alignment = { horizontal: 'right' }; });
    const fill = (ws, row, col, argb, fontArgb, bold) => { const c = ws.getRow(row).getCell(col); c.fill = solid(argb); c.font = { size: 10, bold: bold !== false, color: { argb: fontArgb } }; };
    // live Excel colour scale: bad → white (at the benchmark) → good
    const cscale = (ws, ref, vals, base, goodHigh) => {
      const v = vals.filter(x => x != null && isFinite(x)); if (v.length < 2) return;
      const mn = Math.min(...v), mx = Math.max(...v); if (mn === mx) return;
      const lo = goodHigh ? XC.rose : XC.em, hi = goodHigh ? XC.em : XC.rose, midV = base != null && base > mn && base < mx ? { type: 'num', value: base } : { type: 'percentile', value: 50 };
      ws.addConditionalFormatting({ ref, rules: [{ type: 'colorScale', priority: 1, cfvo: [{ type: 'min' }, midV, { type: 'max' }], color: [{ argb: lo }, { argb: XC.white }, { argb: hi }] }] });
    };
    const volScale = (ws, ref) => ws.addConditionalFormatting({ ref, rules: [{ type: 'colorScale', priority: 1, cfvo: [{ type: 'min' }, { type: 'max' }], color: [{ argb: XC.white }, { argb: XC.slM }] }] });
    const moveFill = (ws, row, col, x) => { if (x == null || x === 0) return; const big = Math.abs(x) >= 0.3; fill(ws, row, col, x > 0 ? (big ? XC.em : XC.emL) : (big ? XC.rose : XC.roseL), x > 0 ? XC.emT : XC.roseT); };
    const stabFill = (ws, row, col, s) => { const m = { repeats: [XC.emL, XC.emT], mixed: [XC.ambL, XC.ambT], thin: [XC.slL, XC.slT] }[s]; if (m) fill(ws, row, col, m[0], m[1]); };
    const label = s => ({ repeats: 'Repeats', mixed: 'Mixed', thin: 'Thin' }[s] || '–');
    const img = (ws, url, row, w, h) => { const id = wb.addImage({ base64: url.split(',')[1], extension: 'png' }); ws.addImage(id, { tl: { col: 0, row }, ext: { width: w || 760, height: h || 320 } }); return row + Math.ceil((h || 320) / 20) + 1; };
    const share = (b, k) => T[k] ? +(b[k] / T[k] * 100).toFixed(2) : 0, pctTick = v => v + '%';

    // ---- Summary ----
    let ws = sheet('Summary', [34, 18, 4, 4]);
    title(ws, 1, 'PPCBench Dayparting Planner', 16);
    note(ws, 2, 'Generated ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' · ' + st.currency + ' · ' + (r.range ? dstr(r.range.from) + ' to ' + dstr(r.range.to) + ' (' + r.range.days + ' days)' : 'under 4 days of data') + ' · ' + a.rows.toLocaleString() + ' rows · ' + new Set(st.filtered.map(x => x.campaign)).size + ' campaigns');
    head(ws, 4, ['Metric', 'Value']);
    const kp = [['Impressions', T.imp, F.int], ['Clicks', T.clicks, F.int], ['Orders', T.orders, F.int], ['Spend', T.spend, F.money], ['Sales', T.sales, F.money], ['CTR', T.ctr, F.pct2], ['CVR', T.cvr, F.pct], ['CPC', T.cpc, F.money], ['RPC (revenue per click)', T.rpc, F.money], ['ACOS', T.sales ? T.acos : null, F.pct], ['ROAS', T.roas, F.n2]];
    if (r.profit != null) kp.push(['Profit after ads (' + pct(r.margin, 0) + ' margin)', r.profit, F.money]);
    kp.forEach((k, i) => put(ws, 5 + i, [k[0], k[1]], [null, k[2]]));
    let row = 5 + kp.length + 1;
    title(ws, row, 'Findings', 12); row++;
    const benchTxt = r.waste.kind === 'goal' ? 'target ACOS ' + pct(bench, 0) : r.waste.kind === 'breakeven' ? 'break-even ACOS ' + pct(bench, 0) : 'average ACOS ' + pct(bench, 0);
    const finds = [['Excess spend vs ' + benchTxt, r.waste.total, F.money, XC.roseT], ['… as a share of spend', r.waste.share, F.pct, XC.roseT], ['Spend in cut windows (share of spend)', r.winSum.cutSpendShare, F.pct, XC.roseT], ['… share of sales those windows earn', r.winSum.cutSalesShare, F.pct, XC.slT],
      ['Spend in boost windows (share of spend)', r.winSum.boostSpendShare, F.pct, XC.emT], ['… share of sales those windows earn', r.winSum.boostSalesShare, F.pct, XC.slT]];
    if (r.stability && r.stability.pct != null) finds.push(['Spend behind calls that repeat in both halves', r.stability.pct, F.pct, XC.emT]);
    finds.forEach((f, i) => { put(ws, row + i, [f[0], f[1]], [null, f[2]]); ws.getRow(row + i).getCell(2).font = { size: 10, bold: true, color: { argb: f[3] } }; });
    row += finds.length + 1;
    row = img(ws, chartPng('bar', hs, [{ label: 'Share of spend', data: a.hour.map(b => share(b, 'spend')), backgroundColor: '#94a3b8', borderRadius: 3 }, { label: 'Share of sales', data: a.hour.map(b => share(b, 'sales')), backgroundColor: '#10b981', borderRadius: 3 }], { title: 'Where the money goes vs where it comes back, by hour', fmt: pctTick }), row);
    img(ws, chartPng('bar', DP.DAYS.map(d => d.slice(0, 3)), [{ label: 'Share of spend', data: a.dow.map(b => share(b, 'spend')), backgroundColor: '#94a3b8', borderRadius: 3 }, { label: 'Share of sales', data: a.dow.map(b => share(b, 'sales')), backgroundColor: '#10b981', borderRadius: 3 }], { title: 'Same view, by day of week', fmt: pctTick }), row);

    // ---- Schedule ----
    ws = sheet('Schedule', [24, 12, 16, 14, 10, 10, 12]);
    title(ws, 1, 'Bid schedule (windows)', 14);
    note(ws, 2, 'Windows are 2+ hours in a row at least ' + Math.round(DP.TIER * 100) + '% above or below average. Green = raise bids, red = lower. Repeats = same direction in both halves of the date range.');
    row = 4;
    [['Weekdays (Mon–Fri)', r.win.weekdays], ['Weekends (Sat–Sun)', r.win.weekends]].forEach(([t, list]) => {
      title(ws, row, t, 11); row++;
      if (!list.length) { note(ws, row, 'No window clears the threshold with enough support. Keep a flat bid.'); row += 2; return; }
      head(ws, row, ['Window', 'Bid move', 'Spend', 'Share of spend', 'Clicks', 'Trust', 'Repeats?']); row++;
      list.forEach(w => { put(ws, row, [w.label, w.adj, w.b.spend, T.spend ? w.b.spend / T.spend : 0, w.b.clicks, w.trust, label(w.stab)], [null, F.move, F.money, F.pct0, F.int, F.pct0, null]); moveFill(ws, row, 2, w.adj); stabFill(ws, row, 7, w.stab); row++; });
      row++;
    });
    img(ws, chartPng('bar', hs, [{ label: 'Bid move', data: r.groups.Hours.map(x => Math.round(x.adj * 100)), backgroundColor: r.groups.Hours.map(x => x.adj > 0 ? '#10b981' : x.adj < 0 ? '#f43f5e' : '#cbd5e1'), borderRadius: 3 }], { title: 'Suggested bid move by hour of day (%, damped)', fmt: pctTick }), row);

    // ---- Bids by segment ----
    ws = sheet('Bids by segment', [26, 10, 12, 10, 12, 12, 12, 14]);
    title(ws, 1, 'Bid moves by segment', 14);
    note(ws, 2, 'Bid move is damped for thin data (trust = clicks ÷ (clicks + ' + r.k + ')). Undamped is the raw gap with no damping.');
    row = 4;
    Object.keys(r.groups).forEach(g => {
      title(ws, row, g, 11); row++;
      head(ws, row, ['Segment', 'Clicks', scoreName(), 'Trust', 'Bid move', 'Undamped', 'Repeats?'].concat(r.goal != null ? ['To hit target'] : [])); row++;
      r.groups[g].forEach(x => { put(ws, row, [x.label, x.b.clicks, sc(x.b), x.trust, x.adj, x.raw, label(x.stab)].concat(r.goal != null ? [x.toGoal] : []), [null, F.int, scFmt, F.pct0, F.move, F.move, null, F.move]); moveFill(ws, row, 5, x.adj); moveFill(ws, row, 6, x.raw); stabFill(ws, row, 7, x.stab); row++; });
      row++;
    });

    // ---- Rhythm ----
    ws = sheet('Rhythm', [12, 16, 16, 16, 16, 16, 16]);
    title(ws, 1, 'Weekday vs weekend rhythm', 14);
    head(ws, 3, ['Hour', 'Weekday ' + scoreName(), 'Weekend ' + scoreName(), 'Weekday spend', 'Weekend spend', 'Weekday % of spend', 'Weekend % of spend']);
    const sw = a.wd.reduce((x, b) => x + b.spend, 0) || 1, se = a.we.reduce((x, b) => x + b.spend, 0) || 1;
    a.hour.forEach((_, h) => put(ws, 4 + h, [hl[h], a.wd[h].clicks ? sc(a.wd[h]) : null, a.we[h].clicks ? sc(a.we[h]) : null, a.wd[h].spend, a.we[h].spend, a.wd[h].spend / sw, a.we[h].spend / se], [null, scFmt, scFmt, F.money, F.money, F.pct, F.pct]));
    cscale(ws, 'B4:B27', a.wd.map(b => b.clicks ? sc(b) : null), sc(T), true); cscale(ws, 'C4:C27', a.we.map(b => b.clicks ? sc(b) : null), sc(T), true);
    volScale(ws, 'D4:D27'); volScale(ws, 'E4:E27'); volScale(ws, 'F4:F27'); volScale(ws, 'G4:G27');
    const lineDs = (l1, d1, l2, d2) => [{ label: l1, data: d1, borderColor: '#334155', backgroundColor: '#334155', borderWidth: 2, pointRadius: 2, tension: 0.3, spanGaps: true }, { label: l2, data: d2, borderColor: '#c2410c', backgroundColor: '#c2410c', borderWidth: 2, pointRadius: 2, tension: 0.3, spanGaps: true }];
    const lineScales = fmt => ({ x: { grid: { display: false }, border: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0 } }, y: { grid: { color: 'rgba(148,163,184,0.18)' }, border: { display: false }, ticks: { font: { size: 10 }, callback: fmt, maxTicksLimit: 6 } } });
    const rv = b => b.clicks ? +sc(b).toFixed(2) : null;
    row = img(ws, chartPng('line', hs, lineDs('Weekdays', a.wd.map(rv), 'Weekends', a.we.map(rv)), { title: scoreName() + ' by hour: weekdays vs weekends', scales: lineScales(v => r.basis === 'roas' ? v : cur + v) }), 29);
    img(ws, chartPng('line', hs, lineDs('Weekdays', a.wd.map(b => +(b.spend / sw * 100).toFixed(2)), 'Weekends', a.we.map(b => +(b.spend / se * 100).toFixed(2))), { title: 'Where spend sits by hour (% of each profile)', scales: lineScales(pctTick) }), row);

    // ---- Week grids ----
    ws = sheet('Week grids', [14].concat(Array(24).fill(8)));
    title(ws, 1, 'The week, hour by hour', 14);
    note(ws, 2, 'Green = better than average, red = worse (ACOS vs ' + benchTxt + '; profit vs break-even). Blank = no clicks. ∞ = clicks but no sales.');
    row = 4;
    const gridMetrics = [['Revenue per click', b => b.rpc, T.rpc, true, F.money], ['Conversion rate', b => b.cvr, T.cvr, true, F.pct], ['Cost per click', b => b.cpc, T.cpc, false, F.money], ['ACOS', b => b.acos, bench, false, F.pct0]];
    if (r.margin != null) gridMetrics.push(['Profit per click', b => DP.profitPerClick(b, r.margin), 0, true, F.money]);
    gridMetrics.forEach(([name, f, base, goodHigh, fmt]) => {
      title(ws, row, name, 11); row++; head(ws, row, ['Day \\ Hour'].concat(hs)); row++;
      const first = row, vals = [];
      DP.DAYS.forEach((d, di) => {
        const cells = a.grid[di].map(b => { if (!b.clicks) return null; if (name === 'ACOS' && !b.sales) return '∞'; const v = f(b); vals.push(v); return v; });
        put(ws, row, [d.slice(0, 3)].concat(cells), [null].concat(Array(24).fill(fmt))); ws.getRow(row).eachCell((c, i) => { if (i > 1) c.alignment = { horizontal: 'center' }; }); row++;
      });
      cscale(ws, 'B' + first + ':Y' + (row - 1), vals, base, goodHigh); row++;
    });

    // ---- By day / By hour (numbers) ----
    const numSheet = (name, first, labels, list, chartLabels) => {
      const cols = [['Impressions', 'imp', F.int], ['Clicks', 'clicks', F.int], ['Orders', 'orders', F.int], ['Spend', 'spend', F.money], ['% Spend', 'pctSpend', F.pct], ['Sales', 'sales', F.money], ['CTR', 'ctr', F.pct2], ['CVR', 'cvr', F.pct], ['CPC', 'cpc', F.money], ['ACOS', 'acos', F.pct], ['RPC', 'rpc', F.money]];
      const w = sheet(name, [16].concat(cols.map(() => 13)));
      title(w, 1, 'Numbers by ' + first.toLowerCase(), 14);
      note(w, 2, 'Green/red = better/worse than average (ACOS vs ' + benchTxt + '). Grey shading = volume (darker = more).');
      head(w, 4, [first].concat(cols.map(c => c[0])));
      list.forEach((b, i) => put(w, 5 + i, [labels[i]].concat(cols.map(c => c[1] === 'pctSpend' ? (T.spend ? b.spend / T.spend : 0) : (c[1] === 'acos' && !b.sales) ? null : b[c[1]])), [null].concat(cols.map(c => c[2]))));
      const last = 4 + list.length, col = i => String.fromCharCode(66 + i);
      put(w, last + 1, ['Total'].concat(cols.map(c => c[1] === 'pctSpend' ? 1 : (c[1] === 'acos' && !T.sales) ? null : T[c[1]])), [null].concat(cols.map(c => c[2])), true);
      cols.forEach((c, i) => {
        const ref = col(i) + '5:' + col(i) + last, vals = list.map(b => c[1] === 'pctSpend' ? b.spend : (c[1] === 'acos' && !b.sales) ? null : b[c[1]]);
        if (['ctr', 'cvr', 'rpc'].includes(c[1])) cscale(w, ref, vals, T[c[1]], true); else if (c[1] === 'cpc') cscale(w, ref, vals, T.cpc, false); else if (c[1] === 'acos') cscale(w, ref, vals, bench, false); else volScale(w, ref);
      });
      img(w, chartPng('bar', chartLabels, [{ label: 'CPC', data: list.map(b => +b.cpc.toFixed(2)), backgroundColor: '#94a3b8', borderRadius: 3 }, { label: 'RPC', data: list.map(b => +b.rpc.toFixed(2)), backgroundColor: '#10b981', borderRadius: 3 }], { title: 'CPC vs RPC: a click earns more than it costs when RPC is above CPC', fmt: v => cur + v }), last + 3);
    };
    numSheet('By day', 'Day', DP.DAYS, a.dow, DP.DAYS.map(d => d.slice(0, 3)));
    numSheet('By hour', 'Hour', hl, a.hour, hs);

    // ---- Campaigns ----
    if (!st.rank) st.rank = DP.rankCampaigns(st.pf, st.o);
    ws = sheet('Campaigns', [46, 24, 12, 10, 10, 16, 12, 10, 14]);
    title(ws, 1, 'Which campaigns are worth dayparting?', 14);
    note(ws, 2, 'Start here = 15%+ of spend in red hours and 60%+ repeating. Test = 10%+. Needs data = under ' + 2 * r.k + ' clicks.');
    head(ws, 4, ['Campaign', 'Portfolio', 'Spend', 'Clicks', 'ACOS', 'Spend in red hours', 'Share of spend', 'Repeats', 'Verdict']);
    const rank = st.rank.filter(c => c.b.clicks > 0);
    rank.forEach((c, i) => { put(ws, 5 + i, [c.campaign, c.portfolio, c.b.spend, c.b.clicks, c.b.sales ? c.b.acos : null, c.atStake, c.atStakeShare, c.stability, c.verdict], [null, null, F.money, F.int, F.pct0, F.money, F.pct0, F.pct0, null]);
      const m = { 'Start here': [XC.emL, XC.emT], 'Test': [XC.ambL, XC.ambT] }[c.verdict] || [XC.slL, XC.slT]; fill(ws, 5 + i, 9, m[0], m[1]); });
    if (rank.length) volScale(ws, 'F5:F' + (4 + rank.length));
    const topRed = rank.filter(c => c.atStake > 0).sort((x, y) => y.atStake - x.atStake).slice(0, 10);
    if (topRed.length) img(ws, chartPng('bar', topRed.map(c => c.campaign.length > 34 ? c.campaign.slice(0, 33) + '…' : c.campaign), [{ label: 'Spend in red hours', data: topRed.map(c => +c.atStake.toFixed(2)), backgroundColor: '#f43f5e', borderRadius: 3, maxBarThickness: 26 }], { title: 'Top campaigns by spend in red hours', horizontal: true, h: Math.max(170, 90 + 34 * topRed.length), fmt: v => cur + v }), 7 + rank.length);

    // ---- Method ----
    ws = sheet('Method', [24, 110]);
    title(ws, 1, 'How this was calculated', 14);
    [['Score', r.basis === 'roas' ? 'ROAS = sales / spend' : 'RPC = sales / clicks'], ['Trust threshold (k)', r.k + ' clicks = ' + st.o.conf + ' x average clicks per order'],
      ['Damping', 'damped score = (sales + k x average RPC) / (clicks + k); for ROAS, k pseudo-clicks at the average CPC'], ['Bid move', 'damped score / overall score - 1, nearest 5%'],
      ['Window', '2+ consecutive hours at least ' + Math.round(DP.TIER * 100) + '% above or below average (weekday and weekend profiles)'],
      ['Repeats?', 'Same side of the half-range average by 5%+ in both halves of the date range. Thin = a half had under ' + Math.ceil(r.k / 2) + ' clicks.'],
      ['Excess spend', 'sum over hours of max(0, spend - sales x benchmark ACOS); benchmark = ' + benchTxt]].forEach((m, i) => { put(ws, 3 + i, m); ws.getRow(3 + i).getCell(1).font = { bold: true, size: 10 }; ws.getRow(3 + i).getCell(2).alignment = { horizontal: 'left', wrapText: true }; });

    const buf = await wb.xlsx.writeBuffer(), a$ = document.createElement('a');
    a$.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); a$.download = 'PPCBench_Dayparting_Plan.xlsx';
    document.body.appendChild(a$); a$.click(); a$.remove(); setTimeout(() => URL.revokeObjectURL(a$.href), 2000);
    toast('Plan downloaded.', 'success');
  };

  // ---- sample data: synthetic + deterministic (no real account data) ----
  window.dpLoadSample = function () {
    let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const camps = [['Hand and Body Lotion', 'SP-AUTO-Body Lotion', 1], ['Hand and Body Lotion', 'SP-EXACT-Body Lotion', 1.4], ['Face Care', 'SP-PHRASE-Night Cream', 0.8], ['Face Care', 'SP-AUTO-Night Cream', 0.6]];
    const traffic = h => 0.25 + 0.75 * Math.exp(-Math.pow((h - 19.5) / 4.2, 2)) + 0.35 * Math.exp(-Math.pow((h - 13) / 3, 2));
    const cvrAt = h => [0.05, 0.05, 0.04, 0.04, 0.12, 0.06, 0.08, 0.14, 0.07, 0.06, 0.1, 0.05, 0.07, 0.17, 0.15, 0.07, 0.1, 0.1, 0.12, 0.12, 0.06, 0.07, 0.08, 0.16][h];
    const dayCvr = [0.9, 1.3, 1.15, 0.85, 0.95, 0.95, 0.75], rows = [];
    for (let d = 14; d < 28; d++) {
      const dow = (new Date(Date.UTC(2026, 8, d)).getUTCDay() + 6) % 7;
      camps.forEach(([pf, name, w]) => {
        for (let h = 0; h < 24; h++) {
          const imp = Math.round(60 * w * traffic(h) * (0.7 + rnd() * 0.6)), clicks = Math.round(imp * 0.0045 * (0.6 + rnd() * 0.9) * 6), cpc = 0.9 + w * 0.5 + rnd() * 0.4;
          let orders = 0; for (let i = 0; i < clicks; i++) if (rnd() < cvrAt(h) * dayCvr[dow]) orders++;
          rows.push({ 'Start Date': 'Sep ' + d + ', 2026', 'Start Time': hh(h) + ':00', 'Portfolio name': pf, 'Campaign Name': name, Currency: 'USD', Impressions: imp, Clicks: clicks, Spend: '$' + (clicks * cpc).toFixed(2), '7 Day Total Orders (#)': orders, '7 Day Total Sales ': '$' + (orders * (14 + rnd() * 10)).toFixed(2) });
        }
      });
    }
    const p = DP.parseRows(rows, XLSX.SSF);
    st.recs = p.records; st.currency = p.currency; st.files = []; input.value = ''; showName();
    show(); toast('Loaded synthetic sample data (14 days, 4 campaigns).', 'success');
  };
})();
