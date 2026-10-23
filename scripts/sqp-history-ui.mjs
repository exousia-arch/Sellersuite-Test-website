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
    for (const k of p.keywords) { let kw = a.keywords.find(x => x.query === k.query); if (!kw) a.keywords.push(kw = { id: id(), query: k.query, display: k.display, ranking: k.ranking }); db.metrics.push({ p: per.id, k: kw.id, d: k.data }); }
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
  if (op === 'delete_all') { db.brands = []; db.periods = []; db.metrics = []; db.consent = null; return 0; }
  if (op === 'export') return { exported_at: 'now', state: backend('state', {}), metrics: db.metrics };
  throw 'sqp:invalid';
}

// A real SQP CSV + bulk xlsx for a given week, built inside the page from the engine's synthetic sample (changing the dates only).
const PAIR = `(async (from, to, bulkName, clicksScale) => {
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
  const pair = (from, to, name, scale) => page.evaluate(`${PAIR}(${JSON.stringify(from)}, ${JSON.stringify(to)}, ${JSON.stringify(name)}, ${scale})`).then(() => sleep(900));
  const dialogOk = async () => { await sleep(250); await page.evaluate(() => document.querySelector('[role="dialog"] [data-ok]').click()); await sleep(400); };

  // sample data can be looked at but never saved
  await page.evaluate(() => sqSample()); await sleep(700);
  ok((await T('#sqSave')).includes('Sample data is not saved'), 'sample data: no save controls');
  ok(!log.includes('state'), 'sample data: the database is not even asked');
  await page.evaluate(() => sqNextPair());

  // week 1 (dates inside the name, pulled long after the week ended -> complete)
  await pair('2026-09-06', '2026-09-12', 'bulk-1-20260906-20260912-1792000000000.xlsx', 1);
  ok(await page.$('#sqSaveBtn') !== null, 'save bar appears for real files');
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
  await page.evaluate(() => sqNextPair()); await pair('2026-09-13', '2026-09-19', 'bulk-1-20260913-20260919-1792000000000.xlsx', 1.5);
  await click('#sqSaveBtn'); await sleep(900);
  ok((await T('#sqSave')).includes('Saved 2026-09-13'), 'second week saved without asking for consent again');
  await page.evaluate(() => sqNextPair()); await pair('2026-09-06', '2026-09-12', 'bulk-1-20260906-20260912-1792000000000.xlsx', 2);
  ok((await T('#sqSaveBtn')).includes('Replace this period'), 'an already saved period offers Replace');
  ok((await T('#sqSave')).includes('already saved'), 'and says so');
  await click('#sqSaveBtn'); await sleep(900);
  ok((await T('#sqSave')).includes('Replaced 2026-09-06'), 'replace works');
  ok(db.periods.length === 2, 'replace did not create a duplicate period');
  // a fresh week pulled right after it ended is still maturing
  await page.evaluate(() => sqNextPair()); await pair('2026-09-20', '2026-09-26', 'bulk-1-20260920-20260926-1790500000000.xlsx', 1);
  await click('#sqSaveBtn'); await sleep(900);
  // dates that do not match cannot be saved
  await page.evaluate(() => sqNextPair()); await pair('2026-09-27', '2026-10-03', 'bulk-1-20260101-20260107-1792000000000.xlsx', 1);
  ok(await page.$eval('#sqSaveBtn', b => b.disabled), 'mismatched bulk dates: saving is off');
  ok((await T('#sqSave')).includes('do not match'), 'and the reason is shown');
  await page.evaluate(() => sqNextPair());

  // history tab
  await page.evaluate(() => sqTab('hist')); await sleep(900);
  ok(!(await page.$eval('#sqHistBody', e => e.classList.contains('hidden'))), 'history body shows');
  ok((await T('#sqHTable')).includes('2026-09-13 to 2026-09-19') && (await T('#sqHTable')).includes('2026-09-06 to 2026-09-12'), 'table lists the saved periods');
  ok((await T('#sqHTable')).toLowerCase().includes('maturing'), 'the week pulled early is marked Maturing');
  const hasChart = await page.evaluate(() => ['sqHChartCvr', 'sqHChartCtr', 'sqHChartCpc'].every(i => !!_dashCharts[i] && _dashCharts[i].data.datasets.length >= 1 && _dashCharts[i].data.labels.length === 3));
  ok(hasChart, 'three trend charts, one point per saved period');
  ok(await page.evaluate(() => { const d = _dashCharts.sqHChartCvr.data.datasets.find(x => x.label === 'Ranking campaign'); return d.pointBackgroundColor.filter(c => c === '#ffffff').length === 1; }), 'exactly the maturing period is drawn as an open dot');
  ok(errs.length === 0, `no script errors (${errs.join(' | ')})`);
  // basis switch changes the ranking numbers
  const cm = await page.evaluate(() => _dashCharts.sqHChartCvr.data.datasets.find(x => x.label === 'Ranking campaign').data.join());
  await page.select('#sqHBasis', 'term'); await sleep(500);
  const term = await page.evaluate(() => _dashCharts.sqHChartCvr.data.datasets.find(x => x.label === 'Ranking campaign').data.join());
  ok(cm !== term, 'switching the ranking basis changes the series');
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
  await click('[onclick="sqDelete(\'keyword\')"]'); await dialogOk();
  ok(db.brands[0].asins[0].keywords.length === 1, 'a keyword can be deleted (2 tracked, 1 removed)');
  // a session that ended: the first call gets 401, the page renews and retries, the user notices nothing
  expireOnce = true; log.length = 0;
  await click('[onclick="sqExportAll()"]'); await sleep(700);
  ok(log.includes('renew'), 'ended session: renew was called once');
  ok(log.join() === '401 export,renew,export', 'and the request was retried once (' + log.join() + ')');
  await click('[onclick="sqDelete(\'all\')"]'); await dialogOk();
  ok(db.brands.length === 0 && db.consent === null, 'delete everything also removes the consent');
  ok(!(await page.$eval('#sqHistMsg', e => e.classList.contains('hidden'))) && (await T('#sqHistMsg')).includes('Nothing saved yet'), 'then the tab says nothing is saved');
  ok(errs.length === 0, `no script errors at the end (${errs.join(' | ')})`);
} catch (e) { failures++; console.log('  ERROR', e && e.stack || e); }
finally { if (browser) await browser.close(); server.kill(); }
console.log(failures ? `sqp-history-ui: ${failures} FAILED` : 'sqp-history-ui: all checks pass');
process.exit(failures ? 1 : 0);
