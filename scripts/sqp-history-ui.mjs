// Browser test for the SQP Tracker's saved history (Pro). The backend is faked inside this script: it answers
// /api/sqp/* and /api/auth/renew from memory, so nothing touches a database.
//   node scripts/sqp-history-ui.mjs
// Covers: first save asks for consent, save, replace, back-fill (older week), History tab (charts, table, gaps, maturing),
// export, deletes, a session that ended mid-way (401 -> renew -> retry), mismatched dates cannot be saved, sample data cannot be saved.
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), PORT = 4000 + Math.floor(Math.random() * 40), BASE = `http://localhost:${PORT}`;
const server = spawn(process.execPath, ['serve.mjs'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let browser, failures = 0;
const ok = (c, msg) => { try { assert.ok(c, msg); } catch (e) { failures++; console.log('  FAIL', msg); } };

// ---- fake backend (just enough of the database functions' behaviour)
const db = { consent: null, brands: [], periods: [], metrics: [] }, log = [];
let n = 0, expireOnce = false;
const id = () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0');
function backend(op, b) {
  const asinOf = i => db.brands.flatMap(x => x.asins).find(a => a.id === i);
  if (op === 'state') return { consent: db.consent, brands: db.brands.map(x => ({ id: x.id, name: x.name, asins: x.asins.map(a => ({ id: a.id, asin: a.asin, label: null, keywords: a.keywords, periods: db.periods.filter(p => p.asin === a.id).map(p => ({ cadence: p.cadence, from: p.from, to: p.to, pulled: p.pulled })) })) })) };
  if (op === 'consent') { db.consent = 1; return null; }
  if (op === 'save') {
    const p = b.payload; if (!db.consent) throw 'sqp:consent_required';
    let br = db.brands.find(x => x.name === p.brand); if (!br) db.brands.push(br = { id: id(), name: p.brand, asins: [] });
    let a = br.asins.find(x => x.asin === p.asin); if (!a) br.asins.push(a = { id: id(), asin: p.asin, keywords: [] });
    let per = db.periods.find(x => x.asin === a.id && x.cadence === p.cadence && x.from === p.from), replaced = !!per;
    if (per) db.metrics = db.metrics.filter(m => m.p !== per.id); else db.periods.push(per = { id: id(), asin: a.id, cadence: p.cadence, from: p.from, to: p.to, pulled: p.pulled });
    for (const k of p.keywords) { let kw = a.keywords.find(x => x.query === k.query); if (!kw) a.keywords.push(kw = { id: id(), query: k.query, display: k.display, ranking: k.ranking }); else { kw.display = k.display; kw.ranking = k.ranking; } db.metrics.push({ p: per.id, k: kw.id, d: k.data }); }
    return { brand_id: br.id, asin_id: a.id, period_id: per.id, replaced, saved_keywords: p.keywords.length, pruned: 0, kept: true };
  }
  if (op === 'history') {
    const a = asinOf(b.asin_id), ps = db.periods.filter(p => p.asin === b.asin_id && p.cadence === b.cadence).sort((x, y) => (x.from < y.from ? -1 : 1));
    return { periods: ps.map(p => ({ id: p.id, from: p.from, to: p.to, pulled: p.pulled })), keywords: a.keywords, rows: db.metrics.filter(m => ps.some(p => p.id === m.p)).map(m => ({ p: m.p, k: m.k, d: m.d })) };
  }
  if (op === 'delete') {
    if (b.kind === 'period') { db.periods = db.periods.filter(p => p.id !== b.id); db.metrics = db.metrics.filter(m => m.p !== b.id); }
    if (b.kind === 'keyword') { db.brands.forEach(x => x.asins.forEach(a => { a.keywords = a.keywords.filter(k => k.id !== b.id); })); db.metrics = db.metrics.filter(m => m.k !== b.id); }
    if (b.kind === 'asin') { db.brands.forEach(x => { x.asins = x.asins.filter(a => a.id !== b.id); }); db.periods = db.periods.filter(p => p.asin !== b.id); }
    if (b.kind === 'brand') { const br = db.brands.find(x => x.id === b.id); if (br) { const ids = br.asins.map(a => a.id); db.periods = db.periods.filter(p => !ids.includes(p.asin)); db.brands = db.brands.filter(x => x !== br); } }
    return 1;
  }
  if (op === 'set_manual') {
    const per = db.periods.find(x => x.id === b.period_id), hit = db.brands.flatMap(x => x.asins).flatMap(a => a.keywords.map(k => [a, k])).find(([, k]) => k.id === b.keyword_id);
    if (!per || !hit || hit[0].id !== per.asin) throw 'sqp:not_found';
    if ((b.clicks === null) !== (b.orders === null)) throw 'sqp:invalid';
    const row = db.metrics.find(m => m.p === per.id && m.k === b.keyword_id);
    if (b.clicks === null) { if (row) { delete row.d.manual; if (!Object.keys(row.d).length) db.metrics = db.metrics.filter(m => m !== row); } return { changed: !!row }; }
    if (row) row.d.manual = { clicks: b.clicks, orders: b.orders }; else db.metrics.push({ p: per.id, k: b.keyword_id, d: { manual: { clicks: b.clicks, orders: b.orders } } });
    return { changed: true };
  }
  if (op === 'add_keyword') {
    const a = asinOf(b.asin_id); if (!a) throw 'sqp:not_found';
    const q = String(b.query).toLowerCase().replace(/[+"\s]+/g, ' ').trim(); if (!q || q.startsWith('campaign:')) throw 'sqp:invalid';
    let kw = a.keywords.find(x => x.query === q); if (!kw) a.keywords.push(kw = { id: id(), query: q, display: q, ranking: [] });
    return { id: kw.id, query: q };
  }
  if (op === 'delete_all') { db.brands = []; db.periods = []; db.metrics = []; db.consent = null; return 0; }
  if (op === 'export') return { exported_at: 'now', state: backend('state', {}), metrics: db.metrics };
  throw 'sqp:invalid';
}

// A real SQP CSV + bulk xlsx for a given week, built inside the page from the engine's synthetic sample (changing the dates only).
const PAIR = `(async (from, to, bulkName, clicksScale, cerName, cerRows) => {
  const d = SQP.sample(), rows = JSON.parse(JSON.stringify(d.sqpRows));
  rows[0][2] = 'Select week=["Week 1 | ' + from + ' - ' + to + ' 2026"]';
  const csv = Papa.unparse(rows), sqpFile = new File([csv], 'Search_Query_Performance_' + from + '.csv', { type: 'text/csv' });
  const camp = d.campRows.map(r => Object.assign({}, r, r.Clicks ? { Clicks: Math.round(r.Clicks * clicksScale) } : {}));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(camp), 'Sponsored Products Campaigns');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.termRows), 'SP Search Term Report');
  const bulkFile = new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], bulkName, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const put = (el, f) => { const dt = new DataTransfer(); dt.items.add(f); el.files = dt.files; el.dispatchEvent(new Event('change', { bubbles: true })); };
  put(document.getElementById('sqSqpFile'), sqpFile); put(document.getElementById('sqBulkFile'), bulkFile);
  if (cerName) put(document.getElementById('sqCerebroFile'), new File(['\uFEFF' + Papa.unparse([['Keyword Phrase', 'Search Volume', 'Organic Rank', 'Sponsored Rank']].concat(cerRows))], cerName, { type: 'text/csv' }));
  await sqRun();
})`;

try {
  await new Promise(r => setTimeout(r, 1200));
  browser = await puppeteer.launch();
  const page = await browser.newPage(), errs = [];
  await page.setViewport({ width: 1360, height: 900 });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = new URL(req.url());
    if (u.pathname === '/api/auth/renew') { log.push('renew'); return req.respond({ status: 204, headers: { 'access-control-allow-origin': '*' } }); }
    if (!u.pathname.startsWith('/api/sqp/')) return req.continue();
    const op = u.pathname.split('/').pop();
    if (expireOnce) { expireOnce = false; log.push('401 ' + op); return req.respond({ status: 401, contentType: 'application/json', body: '{"error":"renew"}' }); }
    let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) { /* none */ }
    log.push(op);
    try { req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: backend(op, body) }) }); }
    catch (e) { req.respond({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: String(e) }) }); }
  });
  await page.goto(`${BASE}/app?tier=pro`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => switchView('view-sqp')); await sleep(200);
  const T = sel => page.$eval(sel, e => e.innerText).catch(() => '');
  const click = sel => page.evaluate(s => document.querySelector(s).click(), sel);
  const pair = (from, to, name, scale, cer, rows) => page.evaluate(`${PAIR}(${JSON.stringify(from)}, ${JSON.stringify(to)}, ${JSON.stringify(name)}, ${scale}, ${JSON.stringify(cer || '')}, ${JSON.stringify(rows || [])})`).then(() => sleep(900));
  const dialogOk = async () => { await sleep(250); await page.evaluate(() => document.querySelector('[role="dialog"] [data-ok]').click()); await sleep(400); };

  // sample data can be looked at but never saved
  await page.evaluate(() => sqSample()); await sleep(700);
  ok((await T('#sqSave')).includes('Sample data is not saved'), 'sample data: no save controls');
  ok(!log.includes('state'), 'sample data: the database is not even asked');
  // nominating ranking keywords: tracked first, unknown ones flagged as missing, removing one untracks it
  await page.evaluate(() => { document.getElementById('sqNom').value = 'Red Widget\nno such query'; sqNominate(); });
  // type the Campaign Manager numbers of card i (clicks, then orders); each change re-renders the cards
  const manual = async (i, c, o) => { for (const [f, v] of [['c', c], ['o', o]]) { await page.evaluate((id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); }, 'mn' + i + f, String(v)); await sleep(150); } };
  // enlarge a chart: the card fills the window, the chart gets taller, Escape puts it back
  const zoomCheck = async (box, canvas, what) => {
    const sel = `#${canvas}`, card = `document.querySelector('${sel}').parentElement.parentElement`;
    ok(await page.evaluate(b => document.querySelectorAll(b + ' [data-zoom]').length, box) >= 3, `${what}: every chart has an Enlarge button`);
    const small = await page.$eval(sel, c => c.clientHeight);
    await page.evaluate(c => document.querySelector(`#${c}`).parentElement.parentElement.querySelector('[data-zoom]').click(), canvas); await sleep(500);
    const z = await page.evaluate(c => { const card = document.querySelector(`#${c}`).parentElement.parentElement, b = card.querySelector('[data-zoom]'), r = card.getBoundingClientRect(); return { on: card.classList.contains('sq-zoom'), exp: b.getAttribute('aria-expanded'), txt: b.textContent, w: r.width, h: r.height, focus: document.activeElement === b, big: document.getElementById(c).clientHeight, font: _dashCharts[c].options.scales.y.ticks.font.size }; }, canvas);
    ok(z.on && z.exp === 'true' && z.txt === 'Close' && z.focus, `${what}: Enlarge opens, the button says Close and has focus`);
    ok(z.w > 700 && z.w < 1000 && z.h < 650 && z.big > small * 1.5 && z.font === 12, `${what}: a panel, not the whole screen (${Math.round(z.w)}x${Math.round(z.h)}), chart ${small}px to ${z.big}px with larger labels`);
    await page.keyboard.press('Escape'); await sleep(400);
    const back = await page.evaluate(c => { const card = document.querySelector(`#${c}`).parentElement.parentElement, b = card.querySelector('[data-zoom]'); return { on: card.classList.contains('sq-zoom'), exp: b.getAttribute('aria-expanded'), txt: b.textContent, h: document.getElementById(c).clientHeight, font: _dashCharts[c].options.scales.y.ticks.font.size, focus: document.activeElement === b }; }, canvas);
    ok(!back.on && back.exp === 'false' && back.txt === 'Enlarge' && back.focus && Math.abs(back.h - small) < 4 && back.font === 10, `${what}: Escape closes it, focus returns to the button, size restored`);
  };
  const h3s = () => page.evaluate(() => Array.from(document.querySelectorAll('#sqCards h3')).map(h => h.textContent.toLowerCase()));
  ok((await h3s())[0] === 'red widget' && (await h3s()).includes('no such query'), 'nominated keywords are tracked, first');
  ok((await T('#sqNomNote')).includes('no such query'), 'nominated keyword missing from the report is named');
  await page.evaluate(() => { document.getElementById('sqNom').value = 'Red Widget'; sqNominate(); });
  ok(!(await h3s()).includes('no such query'), 'removing a nomination untracks it');
  await page.evaluate(() => sqNextPair());

  // week 1 (dates inside the name, pulled long after the week ended -> complete)
  await pair('2026-09-06', '2026-09-12', 'bulk-1-20260906-20260912-1792000000000.xlsx', 1);
  ok(await page.$('#sqSaveBtn') !== null, 'save bar appears for real files');
  ok((await T('#sqMatch')).includes('Dates match'), 'choosing the two files confirms the dates match');
  ok((await T('#sqSave')).includes('Save to history'), 'button says Save to history');
  await click('#sqSaveBtn'); await sleep(300);
  ok((await T('#sqSave')).includes('Name the brand') === false && (await page.evaluate(() => document.activeElement && document.activeElement.id)) === 'sqBrand', 'brand is required: focus goes to the brand field');
  await page.type('#sqBrand', 'Acme'); await click('#sqSaveBtn'); await sleep(300);
  ok((await T('#sqSave')).includes('Before the first save') && (await T('#sqSave')).includes('Not saved:'), 'first save shows the consent text');
  ok(!log.includes('save') && !log.includes('consent'), 'nothing is saved before agreeing');
  await click('[onclick="sqConsentNo()"]'); await sleep(200);
  ok(!(await T('#sqSave')).includes('Before the first save') && !log.includes('consent'), 'cancel closes consent without saving');
  await click('#sqSaveBtn'); await sleep(300); await click('[onclick="sqConsent()"]'); await sleep(900);
  ok(log.includes('consent') && log.includes('save'), 'agreeing consents and saves');
  ok((await T('#sqSave')).includes('Saved 2026-09-06 to 2026-09-12') && (await T('#sqSave')).includes('keyword'), 'confirmation names the period');
  ok(db.metrics.length >= 1 && db.metrics.every(m => !JSON.stringify(m).includes('Customer')), 'what reached the backend has no search-term rows');

  // back-fill: later and earlier weeks, and a repeat of the first (replace)
  await page.evaluate(() => sqNextPair()); await pair('2026-09-13', '2026-09-19', 'bulk-1-20260913-20260919-1792000000000.xlsx', 1.5, 'US_AMAZON_cerebro_B0SAMPLE01_2026-09-19.csv', [['blue widget set', 1200, 0, 22], ['blue widget', 3000, 14, 0]]);
  ok((await T('#sqCards')).includes('Organic rank #14') && (await T('#sqCards')).includes('not ranked') && (await T('#sqCards')).includes('sponsored rank #22'), 'Cerebro: organic rank shown per keyword, 0 as not ranked');
  ok((await T('#sqSave')).includes('Cerebro report is included'), 'the save bar says ranks are included');
  await manual(0, 170, 6); await manual(1, 90, 3);
  ok((await T('#sqCards')).includes('You typed 170 clicks, 6 orders') && (await T('#sqCards')).includes('campaign rows') && (await T('#sqCards')).includes('exact search-term rows'), 'manual numbers are compared with both bulk views');
  ok(await page.evaluate(() => _dashCharts.sqChartCvr.data.datasets.some(d => d.label === 'Manual (Campaign Manager)' && d.data.every(v => v != null))), 'the compare chart has the manual series');
  // the manual check can be for a chosen campaign: suggested first, the rest grouped; the default is the ranking campaign
  ok((await page.$eval('#mn0k option', o => o.textContent)).includes('(ranking campaign)') && (await page.$$eval('#mn0k optgroup', g => g.map(x => x.label))).some(l => l.startsWith('Other campaigns')), 'manual check: campaign dropdown, ranking campaign suggested, others grouped');
  ok(!(await T('#sqCards')).includes('Bulk file for'), 'no campaign picked: no campaign named in the comparison');
  await page.evaluate(() => { const s = document.getElementById('mn0k'); s.value = 'c2'; s.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(300);
  ok((await T('#sqCards')).includes('Bulk file for') && (await page.$eval('#mn0k', s => s.value)) === 'c2', 'picking a campaign compares the typed numbers with that campaign');
  ok((await T('#sqCards')).includes('You typed 170 clicks, 6 orders'), 'the typed numbers survive picking a campaign');
  ok((await T('#sqSave')).includes('Campaign Manager clicks and orders you typed are included'), 'the save bar says the typed numbers are included');
  await page.evaluate(() => document.querySelector('#sqCampList input').click()); await sleep(400);
  ok((await T('#sqCampCount')).includes('1 selected') && (await h3s()).length === 3 && (await T('#sqCards')).includes('CAMPAIGN'), 'ticking a campaign adds a campaign card after the keywords');
  ok((await T('#sqSave')).includes('and 1 campaign'), 'the save bar counts the campaign');
  await page.evaluate(() => document.querySelector('#sqSave input[onchange^="sqSplit"]').click()); await sleep(300);
  ok((await T('#sqSave')).includes('and 2 campaigns') && (await T('#sqSave')).includes('Also save each ranking campaign separately'), 'the save bar offers to save each ranking campaign separately, and counts them');
  await zoomCheck('#sqChartsBox', 'sqChartCvr', 'compare CVR chart'); await zoomCheck('#sqChartsBox', 'sqChartCpc', 'compare CPC chart');
  await click('#sqSaveBtn'); await sleep(900);
  ok(db.metrics.some(m => m.d.rank && m.d.rank.organic === 14 && m.d.rank.date === 20260919), 'the rank reached the backend as numbers');
  ok(db.brands[0].asins[0].keywords.some(k => /^campaign:c\d+$/.test(k.query)) && db.metrics.some(m => !m.d.market && m.d.cm && m.d.cm.clicks > 0 && !m.d.volume), 'the campaign reached the backend as numbers, without market data');
  ok(db.metrics.some(m => m.d.manual && m.d.manual.clicks === 170 && m.d.manual.orders === 6) && db.metrics.every(m => !m.d.manual || Object.keys(m.d.manual).sort().join() === 'clicks,orders'), 'the typed numbers reached the backend as clicks and orders only');
  ok(db.brands[0].asins[0].keywords.some(k => k.ranking.some(r => r.manual === 1 && r.notRank === 1 && r.id === 'c2')), 'the campaign the numbers are for is stored in the keyword ranking list, flagged');
  ok((await T('#sqSave')).includes('Saved 2026-09-13'), 'second week saved without asking for consent again');
  await page.evaluate(() => sqNextPair()); await pair('2026-09-06', '2026-09-12', 'bulk-1-20260906-20260912-1792000000000.xlsx', 2);
  ok((await T('#sqSaveBtn')).includes('Replace this period'), 'an already saved period offers Replace');
  ok((await T('#sqSave')).includes('already saved'), 'and says so');
  await click('#sqSaveBtn'); await sleep(900);
  ok((await T('#sqSave')).includes('Replaced 2026-09-06'), 'replace works');
  ok(db.periods.length === 2, 'replace did not create a duplicate period');
  // a fresh week pulled right after it ended is still maturing
  await page.evaluate(() => sqNextPair()); await pair('2026-09-20', '2026-09-26', 'bulk-1-20260920-20260926-1790500000000.xlsx', 1, 'US_AMAZON_cerebro_B0SAMPLE01_2026-09-26.csv', [['blue widget set', 1200, 31, 0], ['blue widget', 3000, 9, 0]]);
  await manual(0, 100, 5); await manual(1, 60, 2);
  await page.evaluate(() => { const s = document.getElementById('mn0k'); s.value = 'c2'; s.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(300);
  await sleep(300);
  ok((await T('#sqCampCount')).includes('2 selected') && !(await page.$eval('#sqNom', e => e.value)).includes('campaign:') && !(await T('#sqKwList')).includes('campaign:'), 'a campaign saved for this ASIN is ticked again, and never lands in the keyword box');
  await page.evaluate(() => document.querySelector('#sqCampList input').click()); await sleep(300);   // untick it: this week is saved without that campaign
  await page.evaluate(() => document.querySelector('#sqSave input[onchange^="sqSplit"]').click()); await sleep(300);   // and without the split
  await click('#sqSaveBtn'); await sleep(900);
  // dates that do not match cannot be saved
  await page.evaluate(() => sqNextPair()); await pair('2026-09-27', '2026-10-03', 'bulk-1-20260101-20260107-1792000000000.xlsx', 1, 'US_AMAZON_cerebro_B0OTHER001_2026-10-03.csv', [['blue widget set', 1200, 3, 0]]);
  ok((await T('#sqWarn')).includes('is for B0OTHER001') && !(await T('#sqCards')).includes('Organic rank'), 'Cerebro for another ASIN: warned and not used');
  ok(await page.$eval('#sqSaveBtn', b => b.disabled), 'mismatched bulk dates: saving is off');
  ok((await T('#sqMatch')).includes('Dates do not match') && (await T('#sqMatch')).includes('2026-09-27'), 'choosing files with different dates says so right away');
  ok((await T('#sqSave')).includes('do not match'), 'and the reason is shown');
  await page.evaluate(() => sqNextPair());

  // a ranking campaign of 'blue widget' that was never saved as its own series
  db.brands[0].asins[0].keywords.find(k => k.query === 'blue widget').ranking.push({ id: 'c3', name: 'SP-Other-Rank' });
  // history tab
  await page.evaluate(() => sqTab('hist')); await sleep(900);
  ok(!(await page.$eval('#sqHistBody', e => e.classList.contains('hidden'))), 'history body shows');
  ok((await T('#sqHTable')).includes('2026-09-13 to 2026-09-19') && (await T('#sqHTable')).includes('2026-09-06 to 2026-09-12'), 'table lists the saved periods');
  ok((await T('#sqHTable')).toLowerCase().includes('maturing'), 'the week pulled early is marked Maturing');
  const hasChart = await page.evaluate(() => ['sqHChartCvr', 'sqHChartCtr', 'sqHChartCpc'].every(i => !!_dashCharts[i] && _dashCharts[i].data.datasets.length >= 1 && _dashCharts[i].data.labels.length === 3));
  ok(hasChart, 'three trend charts, one point per saved period');
  ok(await page.evaluate(() => { const d = _dashCharts.sqHChartCvr.data.datasets.find(x => x.label === 'Ranking campaign'); return d.pointBackgroundColor.filter(c => c === '#ffffff').length === 1; }), 'exactly the maturing period is drawn as an open dot');
  ok(!(await page.$eval('#sqHRankBox', e => e.classList.contains('hidden'))) && await page.evaluate(() => { const c = _dashCharts.sqHChartRank; return !!c && c.options.scales.y.reverse === true && c.data.datasets[0].data.join() === ',,31'; }), 'organic rank chart: top is rank 1, not ranked and a week without Cerebro are gaps');
  ok(await page.evaluate(() => { const d = _dashCharts.sqHChartCvr.data.datasets.find(x => x.label === 'Manual (Campaign Manager)'); return !!d && d.data.length === 3 && d.data[0] === null && d.data[1] > 0 && d.data[2] > 0 && d.borderDash.length === 2; }), 'the CVR chart has the manual series (dashed), a gap for the week without it');
  ok((await T('#sqHTable')).toLowerCase().includes('manual cvr'), 'history table has a Manual CVR column');
  ok(!(await page.$eval('#sqHVolBox', e => e.classList.contains('hidden'))) && await page.evaluate(() => { const c = _dashCharts.sqHChartVol, l = c.data.datasets.map(d => d.label); return l.join() === 'SQP,Helium 10' && c.data.datasets[0].data.some(v => v > 0) && c.data.datasets[1].data.join() === ',1200,1200'; }), 'search volume chart: the SQP line and the Helium 10 line (a gap in the week with no Cerebro report)');
  ok((await T('#sqHTable')).toLowerCase().includes('volume (h10)'), 'the table has a Helium 10 volume column');
  await zoomCheck('#sqHCharts', 'sqHChartCtr', 'history CTR chart'); await zoomCheck('#sqHCharts', 'sqHChartRank', 'history rank chart');
  await page.evaluate(() => document.getElementById('sqHChartCvr').parentElement.parentElement.querySelector('[data-zoom]').click()); await sleep(300); await page.evaluate(() => sqTab('compare')); await sleep(300);
  ok(!(await page.evaluate(() => !!document.querySelector('.sq-zoom'))), 'switching tab closes an enlarged chart'); await page.evaluate(() => sqTab('hist')); await sleep(900);
  ok((await T('#sqHTable')).toLowerCase().includes('organic rank') && (await T('#sqHTable')).includes('#31') && (await T('#sqHTable')).includes('not ranked'), 'history table shows the organic rank');
  ok(errs.length === 0, `no script errors (${errs.join(' | ')})`);
  // basis switch changes the ranking numbers
  const cm = await page.evaluate(() => _dashCharts.sqHChartCvr.data.datasets.find(x => x.label === 'Ranking campaign').data.join());
  await page.select('#sqHBasis', 'term'); await sleep(500);
  const term = await page.evaluate(() => _dashCharts.sqHChartCvr.data.datasets.find(x => x.label === 'Ranking campaign').data.join());
  ok(cm !== term, 'switching the ranking basis changes the series');
  // a tracked campaign is listed after the keywords and has no market or ASIN line
  const opt = await page.$$eval('#sqHKw option', o => o.map(x => [x.value, x.textContent]));
  const campOpt = opt.find(x => x[1].startsWith('Campaign: '));
  ok(!!campOpt && opt.findIndex(x => x[1].startsWith('Campaign: ')) > opt.map(x => x[1].startsWith('Campaign: ')).lastIndexOf(false), 'tracked campaigns are listed after the keywords');
  await page.select('#sqHKw', campOpt[0]); await sleep(500);
  ok(await page.evaluate(() => { const l = _dashCharts.sqHChartCvr.data.datasets.map(d => d.label); return l.includes('Ranking campaign') && !l.includes('Market') && !l.includes('Your ASIN'); }), 'campaign history: no market or ASIN line');
  ok(!(await T('#sqHTable')).toLowerCase().includes('market cvr') && (await T('#sqHTable')).toLowerCase().includes('ranking cvr'), 'campaign history table has no market or ASIN columns');
  ok((await T('#sqHNote')).includes('Campaign-level tracking'), 'and says why');
  await page.select('#sqHKw', opt[0][0]); await sleep(500);
  ok((await T('#sqHNote')).includes('Manual numbers are for:'), 'history names the campaign the manual numbers are for');
  await page.select('#sqHKw', opt[0][0]); await sleep(500);
  // edit a saved period: add manual numbers to a week afterwards, change them, remove them
  const editBtn = from => `button[aria-label="Edit manual numbers for the period ${from}"]`;
  const manualSeries = () => page.evaluate(() => { const d = _dashCharts.sqHChartCvr.data.datasets.find(x => x.label === 'Manual (Campaign Manager)'); return d ? d.data : null; });
  const fillEdit = async (c, o) => { await page.$eval('#sqEdC', (e, v) => { e.value = v; }, String(c)); await page.$eval('#sqEdO', (e, v) => { e.value = v; }, String(o)); };
  let setCalls = () => log.filter(x => x === 'set_manual').length;
  ok((await T('#sqHTable')).includes('Add manual') && (await T('#sqHTable')).includes('Edit'), 'every period row offers Add manual or Edit');
  await click(editBtn('2026-09-06')); await sleep(500);
  ok(await page.$('#sqEdC') !== null && (await page.evaluate(() => document.activeElement && document.activeElement.id)) === 'sqEdC', 'Add manual opens an editor under that week, focus in Clicks');
  ok((await T('#sqHTable')).includes('The saved bulk file shows'), 'the editor shows what the saved bulk file says for that week');
  const before = setCalls(); await fillEdit('', ''); await click('[onclick="sqEditSave()"]'); await sleep(300);
  ok(setCalls() === before && await page.$('#sqEdC') !== null, 'empty numbers are refused in the page (nothing sent)');
  await fillEdit(77, 3); await click('[onclick="sqEditSave()"]'); await sleep(700);
  ok(db.metrics.some(m => m.d.manual && m.d.manual.clicks === 77 && m.d.manual.orders === 3 && Object.keys(m.d.manual).sort().join() === 'clicks,orders'), 'saving sends clicks and orders for that week and keyword');
  ok(await page.$('#sqEdC') === null && (await manualSeries())[0] > 0, 'the editor closes and the chart now has a manual point in that week');
  await click(editBtn('2026-09-06')); await sleep(400);
  ok(await page.$eval('#sqEdC', e => e.value) === '77' && await page.$eval('#sqEdO', e => e.value) === '3', 'Edit opens with the saved numbers');
  await fillEdit(83, 4); await click('[onclick="sqEditSave()"]'); await sleep(600);
  ok(db.metrics.filter(m => m.d.manual && m.d.manual.clicks === 83).length === 1 && !db.metrics.some(m => m.d.manual && m.d.manual.clicks === 77), 'changing replaces the numbers (no second row)');
  await click(editBtn('2026-09-06')); await sleep(400); await click('#sqEdClear'); await sleep(600);
  ok(!db.metrics.some(m => m.d.manual && m.d.manual.clicks === 83) && (await manualSeries())[0] === null, 'Remove manual numbers takes them out again');
  await click(editBtn('2026-09-06')); await sleep(300); await click('[onclick="sqEditCancel()"]'); await sleep(200);
  ok(await page.$('#sqEdC') === null, 'Cancel closes the editor');
  // a tracked campaign has no saved row in the last week: adding manual numbers there creates a manual-only row
  const opt2 = await page.$$eval('#sqHKw option', o => o.map(x => [x.value, x.textContent])), cOpt = opt2.find(x => x[1].startsWith('Campaign: '));
  await page.select('#sqHKw', cOpt[0]); await sleep(500);
  const rows0 = db.metrics.length;
  await click(editBtn('2026-09-20')); await sleep(400); await fillEdit(40, 2); await click('[onclick="sqEditSave()"]'); await sleep(700);
  ok(db.metrics.length === rows0 + 1 && (await T('#sqHTable')).toLowerCase().includes('manual only') && (await manualSeries())[2] > 0, 'a week with no saved numbers gets a manual-only row, marked as such, and charted');
  await click(editBtn('2026-09-20')); await sleep(400); await click('#sqEdClear'); await sleep(600);
  ok(db.metrics.length === rows0 && !(await T('#sqHTable')).toLowerCase().includes('manual only'), 'removing it takes the manual-only row away again (the week is a gap again)');
  await page.select('#sqHKw', opt2[0][0]); await sleep(500);
  // related campaign dropdown: one ranking campaign on its own, next to the keyword's market and ASIN
  const rel = () => page.$$eval('#sqHCamp option', o => o.map(x => [x.value, x.textContent]));
  ok(!(await page.$eval('#sqHCampBox', e => e.classList.contains('hidden'))) && (await rel())[0][1] === 'All ranking campaigns (combined)' && (await rel()).length === 2 && (await rel())[1][0] === 'campaign:c1', 'a keyword with a ranking campaign offers it in the Related campaign dropdown');
  const comb = await page.evaluate(() => _dashCharts.sqHChartCvr.data.datasets.find(d => d.label === 'Ranking campaign').data.join());
  await page.select('#sqHCamp', 'campaign:c1'); await sleep(600);
  ok(await page.evaluate(() => { const l = _dashCharts.sqHChartCvr.data.datasets.map(d => d.label); return l.includes('Market') && l.includes('Your ASIN') && l.includes('Ranking campaign'); }), 'the related campaign is charted next to the keyword market and ASIN lines');
  const own = await page.evaluate(() => _dashCharts.sqHChartCvr.data.datasets.find(d => d.label === 'Ranking campaign').data);
  ok(own.length === 3 && own[2] === null && own[1] > 0 && own.join() !== comb, 'its own numbers (a gap in the week it was not saved), not the combined ones');
  ok((await T('#sqHNote')).includes('on its own') && (await T('#sqHTitle')).includes('-Rank'), 'the title and note say which campaign is shown');
  ok((await T('#sqHTable')).toLowerCase().includes('market cvr'), 'the table keeps the keyword columns');
  // editing manual numbers in this view writes to the campaign
  await click(editBtn('2026-09-13')); await sleep(400); await fillEdit(55, 2); await click('[onclick="sqEditSave()"]'); await sleep(700);
  const c1id = db.brands[0].asins[0].keywords.find(k => k.query === 'campaign:c1').id;
  ok(db.metrics.some(m => m.k === c1id && m.d.manual && m.d.manual.clicks === 55) && !db.metrics.some(m => m.k !== c1id && m.d.manual && m.d.manual.clicks === 55), 'Add manual / Edit in this view is saved for the campaign, not the keyword');
  await click(editBtn('2026-09-13')); await sleep(400); await click('#sqEdClear'); await sleep(600);
  await page.select('#sqHCamp', ''); await sleep(500);
  ok((await page.evaluate(() => _dashCharts.sqHChartCvr.data.datasets.find(d => d.label === 'Ranking campaign').data.join())) === comb, 'All ranking campaigns (combined) goes back to the combined numbers');
  // a ranking campaign without its own saved series says so and keeps showing the combined numbers
  const kwOpts = await page.$$eval('#sqHKw option', o => o.map(x => [x.value, x.textContent])); await page.select('#sqHKw', kwOpts.find(x => x[1] === 'blue widget')[0]); await sleep(500);
  ok((await rel()).some(x => x[0] === 'campaign:c3'), 'every stored ranking campaign is offered');
  await page.select('#sqHCamp', 'campaign:c3'); await sleep(500);
  ok((await T('#sqHNote')).includes('is not saved as its own series yet') && (await page.evaluate(() => _dashCharts.sqHChartCvr.data.datasets.find(d => d.label === 'Ranking campaign').data.some(v => v != null))), 'not saved as its own series: told how to, combined numbers still shown');
  await page.select('#sqHKw', opt[0][0]); await sleep(500);
  ok((await page.$eval('#sqHCamp', e => e.value)) === '', 'changing the keyword resets the related campaign');
  // keyword missing in a period shows as a gap
  const kwid = await page.$$eval('#sqHKw option', o => o.map(x => x.value));
  ok(kwid.length >= 2, 'history lists the tracked keywords');
  // export
  await page.evaluate(() => { window.__dl = null; const o = URL.createObjectURL; URL.createObjectURL = b => { window.__dl = b; return o.call(URL, b); }; });
  await click('[onclick="sqExportAll()"]'); await sleep(500);
  ok(await page.evaluate(() => window.__dl && window.__dl.size > 100), 'export produces a file');
  ok(log.includes('export'), 'export asks the backend');
  // deletes
  await click('#sqHTable button[aria-label^="Delete the period"]'); await dialogOk();
  ok(db.periods.length === 2, 'a period can be deleted (3 saved, 1 removed)');
  // add a keyword to track without uploading anything
  const kwCount = db.brands[0].asins[0].keywords.length;
  await page.type('#sqAddKw', '  "Gold  Chain" '); await click('form button[type=submit]'); await sleep(700);
  ok(db.brands[0].asins[0].keywords.length === kwCount + 1 && db.brands[0].asins[0].keywords.some(k => k.query === 'gold chain'), 'a keyword can be added to the tracking (normalised)');
  ok((await page.$$eval('#sqHKw option', o => o.map(x => x.textContent))).includes('gold chain (no data yet)') && (await page.$eval('#sqHKw', e => e.options[e.selectedIndex].textContent)) === 'gold chain (no data yet)', 'the new keyword is in the list and selected');
  await page.type('#sqAddKw', 'gold chain'); await click('form button[type=submit]'); await sleep(600);
  ok(db.brands[0].asins[0].keywords.length === kwCount + 1, 'adding the same keyword again does not duplicate it');
  await click('[onclick="sqDelete(\'keyword\')"]'); await dialogOk();
  ok(db.brands[0].asins[0].keywords.length === kwCount, 'a keyword can be deleted (the one just added is removed)');
  // a session that ended: the first call gets 401, the page renews and retries, the user notices nothing
  expireOnce = true; log.length = 0;
  await click('[onclick="sqExportAll()"]'); await sleep(700);
  ok(log.includes('renew'), 'ended session: renew was called once');
  ok(log.join() === '401 export,renew,export', 'and the request was retried once (' + log.join() + ')');
  await click('[onclick="sqDelete(\'all\')"]'); await dialogOk();
  ok(db.brands.length === 0 && db.consent === null, 'delete everything also removes the consent');
  ok(!(await page.$eval('#sqHistMsg', e => e.classList.contains('hidden'))) && (await T('#sqHistMsg')).includes('Nothing saved yet'), 'then the tab says nothing is saved');
  // harvest ideas tab: 4 weekly reports + a bulk file -> search terms not targeted yet
  await page.evaluate(() => sqTab('harv')); await sleep(300);
  ok(!(await page.$eval('#sqPaneHarv', e => e.classList.contains('hidden'))) && (await page.$eval('#sqUp', e => e.classList.contains('hidden'))), 'the Harvest ideas tab opens');
  await page.evaluate(async () => {
    const d = SQP.sample(), put = (el, fs) => { const dt = new DataTransfer(); fs.forEach(f => dt.items.add(f)); el.files = dt.files; el.dispatchEvent(new Event('change', { bubbles: true })); };
    const buys = { 'widget organizer': [1, 2, 1, 1], 'cheap widgets': [1, 1, 1, 0] };
    const files = [0, 1, 2, 3].map(k => {
      const rows = JSON.parse(JSON.stringify(d.sqpRows)), t = new Date(Date.UTC(2026, 9, 4 + 7 * (k - 3))), e = new Date(t.getTime() + 6 * 864e5), f = x => x.toISOString().slice(0, 10);
      rows[0][2] = 'Select week=["Week ' + (38 + k) + ' | ' + f(t) + ' - ' + f(e) + ' 2026"]';
      rows.forEach((r, i) => { if (i > 1) r[14] = String(buys[r[0]] ? buys[r[0]][k] : 0); });
      return new File([Papa.unparse(rows)], 'sqp-week-' + k + '.csv', { type: 'text/csv' });
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.campRows.map(r => (r.Entity === 'Product Ad' ? Object.assign({}, r, { SKU: 'SKU-1' }) : r))), 'Sponsored Products Campaigns');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.termRows), 'SP Search Term Report');
    put(document.getElementById('sqHvFiles'), files);
    put(document.getElementById('sqHvBulk'), [new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], 'bulk-1-20261004-20261010-1.xlsx')]);
  });
  ok((await T('#sqHvNames')).includes('4 reports'), 'the four chosen reports are listed');
  await click('#sqHvBtn'); await sleep(1200);
  const hvOut = await T('#sqHvOut');
  ok(hvOut.includes('widget organizer') && hvOut.includes('cheap widgets') && !hvOut.includes('blue widget set\n') && hvOut.includes('2 search terms not targeted yet'), 'the table lists the two untargeted terms (' + hvOut.slice(0, 160).replace(/\s+/g, ' ') + ')');
  ok(hvOut.includes('already keyword targets') || hvOut.includes('4-week window'), 'it says which windows were used');
  // send to the Campaign Creator: untick one term, send the rest
  ok((await T('#sqHvPush')).includes('Send 2 to Campaign Creator'), 'the send button counts the ticked terms');
  await page.evaluate(() => { const c = [...document.querySelectorAll('#sqHvOut input[data-hv]')].find(x => x.closest('label').innerText.includes('cheap widgets')); c.click(); });
  ok((await T('#sqHvPush')).includes('Send 1 to Campaign Creator'), 'unticking a term lowers the count');
  await click('#sqHvPush'); await sleep(600);
  const row = await page.evaluate(() => { const tr = document.querySelector('#tableBody tr'); return tr && { asin: tr.querySelector('.asin').value, sku: tr.querySelector('.sku').value, match: tr.querySelector('.match').value, targets: tr.querySelector('.target').value, bid: tr.querySelector('.bid').value, rows: document.querySelectorAll('#tableBody tr').length, shown: !document.getElementById('view-builder').classList.contains('hidden') }; });
  ok(row && row.shown && row.asin === 'B0SAMPLE01' && row.sku === 'SKU-1' && row.match === 'Exact' && row.targets === 'widget organizer' && row.rows === 1 && +row.bid === 0.75, 'the Campaign Creator opens with one Exact campaign for the ASIN, the ticked term, its SKU and the default bid (' + JSON.stringify(row) + ')');
  await page.evaluate(() => { switchView('view-sqp'); sqTab('harv'); }); await sleep(300);
  // ranking keyword ideas from the same files (the sample's price gap needs a looser price bar)
  await click('#sqRkBtn'); await sleep(1200);
  ok((await T('#sqRkOut')).includes('Watch') && (await T('#sqRkOut')).includes('widget organizer'), 'default criteria: the price gap in the sample makes the candidates "Watch" (' + (await T('#sqRkOut')).slice(0, 120).replace(/\s+/g, ' ') + ')');
  await page.evaluate(() => { document.getElementById('sqRk_maxPrice').value = '1.2'; }); await click('#sqRkBtn'); await sleep(1200);
  const rko = await T('#sqRkOut');
  ok(rko.includes('2 potential ranking keywords') && rko.includes('widget organizer') && rko.includes('cheap widgets') && !rko.includes('blue widget') && rko.includes('Strong'), 'two ranking ideas; keywords that already have a Rank campaign are left out (' + rko.slice(0, 160).replace(/\s+/g, ' ') + ')');
  ok((await T('#sqRkPush')).includes('Nominate 2 as ranking keywords'), 'the nominate button counts the ticked keywords');
  await click('#sqRkPush'); await sleep(800);
  // no comparison is loaded for that ASIN yet: the keywords wait, and are nominated when it is loaded
  await pair('2026-10-04', '2026-10-10', 'bulk-1-20261004-20261010-1792000000000.xlsx', 1);
  ok((await page.$eval('#sqNom', e => e.value)).includes('widget organizer') && (await page.$eval('#sqNom', e => e.value)).includes('cheap widgets') && (await T('#sqNomNote')).includes('2 nominated'), 'the ideas are nominated as ranking keywords when that ASIN comparison is loaded');
  await page.evaluate(() => sqTab('harv')); await sleep(300);
  // ideas from saved history: pick a brand and ASIN
  { const bid = id(), aid = id(), k1 = id(), k2 = id(), fmt = x => x.toISOString().slice(0, 10);
    db.brands.push({ id: bid, name: 'Seed Brand', asins: [{ id: aid, asin: 'B0SEED0001', keywords: [{ id: k1, query: 'seed grow', display: 'seed grow', ranking: [] }, { id: k2, query: 'seed ranked', display: 'seed ranked', ranking: [{ id: 'c1', name: 'SP-Rank' }] }] }] });
    [0, 1, 2, 3].forEach(i => { const pid = id(), f = new Date(Date.UTC(2026, 8, 6 + 7 * i));
      db.periods.push({ id: pid, asin: aid, cadence: 'weekly', from: fmt(f), to: fmt(new Date(f.getTime() + 6 * 864e5)), pulled: null });
      [k1, k2].forEach(k => db.metrics.push({ p: pid, k, d: Object.assign({ volume: 1000, price: { market: 24.99, asin: 24.99 }, market: { imp: 50000, clicks: 800, orders: 40 }, asin: { imp: 1000, clicks: 25, orders: 4 } }, k === k1 && i === 3 ? { rank: { organic: 20, sponsored: 0, date: 20261001 } } : {}) })); }); }
  await page.evaluate(() => sqIdSrc('hist')); await sleep(700);
  ok(!(await page.$eval('#sqIdHist', e => e.classList.contains('hidden'))) && (await page.$eval('#sqIdFiles', e => e.classList.contains('hidden'))), 'the Saved history source swaps the upload for Brand and ASIN');
  ok((await page.$$eval('#sqIdBrand option', o => o.map(x => x.textContent))).includes('Seed Brand') && (await page.$$eval('#sqIdAsin option', o => o.map(x => x.textContent.trim()))).includes('B0SEED0001'), 'the saved brand and ASIN are offered');
  await click('#sqRkBtn'); await sleep(1000);
  const ho = await T('#sqRkOut');
  ok(ho.includes('seed grow') && !ho.includes('seed ranked') && ho.includes('saved history') && ho.includes('Strong') && ho.includes('#20'), 'ranking ideas from saved history: the keyword without a ranking campaign, with its saved organic rank (' + ho.slice(0, 140).replace(/\s+/g, ' ') + ')');
  await page.evaluate(() => sqIdSrc('files')); await sleep(300);
  ok(!(await page.$eval('#sqIdFiles', e => e.classList.contains('hidden'))) && (await page.$eval('#sqIdHist', e => e.classList.contains('hidden'))), 'switching back shows the upload again');
  await page.evaluate(() => { document.getElementById('sqHvMin4').value = '9'; }); await click('#sqHvBtn'); await sleep(1000);
  ok((await T('#sqHvOut')).includes('No search term qualifies'), 'raising the thresholds empties the list with a clear message');
  // one monthly report is enough (the minimums go back to automatic)
  await page.evaluate(async () => {
    document.getElementById('sqHvMin4').value = '';
    const d = SQP.sample(), rows = JSON.parse(JSON.stringify(d.sqpRows)); rows[0][1] = 'Reporting Range=["Monthly"]'; rows[0][2] = 'Select year=["2026"]'; rows[0].push('Select month=["September"]');
    rows.forEach((r, i) => { if (i > 1) r[14] = r[0] === 'widget organizer' ? '6' : '0'; });
    const dt = new DataTransfer(); dt.items.add(new File([Papa.unparse(rows)], 'sqp-month-09.csv', { type: 'text/csv' })); const el = document.getElementById('sqHvFiles'); el.files = dt.files; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(500);
  ok((await T('#sqHvDetect')).includes('Detected: 1 monthly report') && (await T('#sqHvDetect')).includes('last month'), 'the chosen file is recognised as a monthly report: ' + (await T('#sqHvDetect')).slice(0, 120));
  await click('#sqHvBtn'); await sleep(1000);
  const mo = await T('#sqHvOut');
  ok(mo.includes('1 monthly report') && mo.includes('widget organizer') && mo.toLowerCase().includes('last month') && mo.includes('1 search term'), 'one monthly report is enough for harvest ideas (' + mo.slice(0, 150).replace(/\s+/g, ' ') + ')');
  await page.evaluate(() => sqTab('compare')); await sleep(200);
  ok(await page.$eval('#sqPaneHarv', e => e.classList.contains('hidden')), 'leaving the tab hides it');
  ok(errs.length === 0, `no script errors at the end (${errs.join(' | ')})`);
} catch (e) { failures++; console.log('  ERROR', e && e.stack || e); }
finally { if (browser) await browser.close(); server.kill(); }
console.log(failures ? `sqp-history-ui: ${failures} FAILED` : 'sqp-history-ui: all checks pass');
process.exit(failures ? 1 : 0);
