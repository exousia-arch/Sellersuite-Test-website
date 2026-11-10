// Browser test for the Bulk Optimizer (Pro). The page is served locally; files are built in the page (synthetic sample) and, when it exists,
// the real unified workbook in "Bulk Optimization/" (account data: git-ignored) is uploaded through the file input.
//   node scripts/optimizer-ui.mjs
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), PORT = 4100 + Math.floor(Math.random() * 40), BASE = `http://localhost:${PORT}`;
const server = spawn(process.execPath, ['serve.mjs'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let browser, failures = 0;
const ok = (c, msg) => { try { assert.ok(c, msg); } catch (e) { failures++; console.log('  FAIL', msg); } };

try {
  await sleep(1200);
  browser = await puppeteer.launch();
  const page = await browser.newPage(), errs = [];
  await page.setViewport({ width: 1360, height: 900 });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.goto(`${BASE}/app?tier=pro`, { waitUntil: 'networkidle2' });
  // every file the page "downloads" is kept, and can be read back with the page's own XLSX
  await page.evaluate(() => { window.__dls = []; const o = URL.createObjectURL; URL.createObjectURL = b => { window.__dls.push(b); return o.call(URL, b); }; });
  const lastBook = () => page.evaluate(async () => {
    const b = window.__dls[window.__dls.length - 1], wb = XLSX.read(new Uint8Array(await b.arrayBuffer()), { type: 'array' }), out = {};
    wb.SheetNames.forEach(n => { out[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' }); }); return out;
  });
  const T = sel => page.$eval(sel, e => e.innerText).catch(() => '');
  const click = sel => page.evaluate(s => document.querySelector(s).click(), sel);

  await page.evaluate(() => switchView('view-optimizer')); await sleep(300);
  ok(!(await page.$eval('#view-optimizer', e => e.classList.contains('hidden'))) && (await page.$eval('#opWork', e => e.classList.contains('hidden'))), 'the Bulk Optimizer opens, empty until a file is chosen');
  await page.evaluate(() => opSample()); await sleep(500);
  const sum = await T('#opSummary');
  ok(sum.includes('Sponsored Products') && sum.includes('Sponsored Brands') && sum.includes('Sponsored Display') && !sum.includes('SB Multi Ad Group'), 'the summary lists the ad types in the file');
  ok((await page.$$eval('#opOptions [data-prod]', e => e.length)) === 3 && (await page.$eval('#opSkipRank', e => e.checked)) && (await page.$eval('#opStruct', e => e.checked)), 'options: one box per ad type, ranking campaigns skipped and structure kept by default');
  ok((await page.$$eval('#opRules [data-path]', e => e.length)) >= 25, 'the rule editor shows the four blocks');

  // ---- Sort & Filter
  await page.evaluate(() => opSortFilter()); await sleep(500);
  let book = await lastBook(); const sp = book['Sponsored Products Campaigns'], H = sp[0], ci = n => H.indexOf(n);
  ok(H.slice(ci('Entity') + 1, ci('Entity') + 14).join() === 'New Bid,Old Bid,Minimum Bid,Maximum Bid,RPC,RPC Check,RPC Status,Bidding Strategy,Start Date,TOS %,ROS %,PP %,ABP %', 'Sort & Filter: the added columns come right after Entity');
  ok(sp.slice(1).every(r => r[ci('Operation')] === 'Update'), 'Operation = Update on every row');
  ok(sp.slice(1).every(r => r[ci('New Bid')] === ''), 'New Bid is blank in Sort & Filter');
  const imps = sp.slice(1).map(r => +r[ci('Impressions')]); ok(imps.every((v, i) => !i || imps[i - 1] >= v), 'sorted by impressions, high to low');
  ok(!sp.slice(1).some(r => r[ci('Keyword Text')] === 'old widget'), 'the paused keyword is not in the file');
  const k1 = sp.find(r => r[ci('Keyword Text')] === 'blue widget'); ok(k1 && k1[ci('Old Bid')] === 1.2 && k1[ci('Minimum Bid')] === 1.2 && k1[ci('Maximum Bid')] === 1.2 && k1[ci('Bidding Strategy')] === 'Dynamic bids - down only' && k1[ci('Start Date')] === '2026-01-05', 'a keyword row: old bid, CPC against bid, strategy and start date (' + JSON.stringify(k1 && k1.slice(2, 14)) + ')');
  ok(k1[ci('RPC')] === 1.13 && k1[ci('RPC Check')] === 'Too high (107%)', 'RPC (sales per click) and the check of the bid against it');
  const ws2 = sp.find(r => r[ci('Keyword Text')] === 'widget set');
  ok(k1[ci('RPC Status')] === '🔴 Bad (66%)' && ws2[ci('RPC Status')] === '🟢 Ideal (236%)', 'RPC status against the account benchmark: ' + [k1, ws2].map(r => r[ci('RPC Status')]).join(' | '));
  // excluding campaigns: only the kinds present in the file are offered; ranking is excluded by default
  ok((await page.$('#opSkipRank')) && !(await page.$('#opSkipCatchAll')) && !(await page.$('#opSkipLowBid')), 'only the kinds of campaign that are in the file can be excluded (here: ranking)');
  ok(!sp.slice(1).some(r => r[ci('Keyword Text')] === 'rank widget' || /rank/i.test(r[ci('Campaign Name (Informational only)')])), 'the ranking campaign is left out of the sorted file');
  await page.evaluate(() => { document.getElementById('opSkipRank').checked = false; }); await page.evaluate(() => opSortFilter()); await sleep(400);
  const withRank = (await lastBook())['Sponsored Products Campaigns'], rk9 = withRank.find(r => r[ci('Keyword Text')] === 'rank widget');
  ok(rk9 && rk9[ci('RPC Status')] === '🔴 Bleeding', 'unticked, the ranking campaign is in the file again (' + (rk9 && rk9[ci('RPC Status')]) + ')');
  await page.evaluate(() => { document.getElementById('opSkipRank').checked = true; });
  ok([ci('TOS %'), ci('ROS %'), ci('PP %'), ci('ABP %')].map(i => k1[i]).join() === '50,0,20,0', 'the campaign\'s placement adjustments: TOS, ROS, PP, ABP');
  ok(book['Sponsored Brands Campaigns'] && book['Sponsored Display Campaigns'], 'one sheet per ad type, named as in the source');
  // without campaign and ad group rows
  await page.evaluate(() => { document.getElementById('opStruct').checked = false; }); await page.evaluate(() => opSortFilter()); await sleep(400);
  book = await lastBook(); ok(book['Sponsored Products Campaigns'].slice(1).every(r => !['Campaign', 'Ad Group'].includes(r[book['Sponsored Products Campaigns'][0].indexOf('Entity')])), 'target rows only when the box is unticked');
  await page.evaluate(() => { document.getElementById('opStruct').checked = true; });

  // ---- Optimize
  await page.evaluate(() => opOptimize()); await sleep(600);
  const head = await T('#opOut h2'); ok(/\d+ of \d+ active targets would change/.test(head), 'Optimize shows how many targets would change: ' + head);
  const tbl = await T('#opOut tbody'); ok(tbl.includes('blue widget') && tbl.includes('Low performing') && !tbl.includes('rank widget'), 'the preview lists the changes; the ranking campaign is skipped');
  const nChanged = +head.match(/^(\d+)/)[1];
  await page.evaluate(() => { document.querySelector('#opOut [data-sel]').click(); }); await sleep(200);
  ok((await T('#opSelN')).startsWith(String(nChanged - 1) + ' of '), 'unticking a change lowers the count');
  await page.evaluate(() => opDownloadUpload()); await sleep(500);
  book = await lastBook(); const upr = book['Sponsored Products Campaigns'], UH = upr[0];
  const total = Object.values(book).reduce((n, rows) => n + rows.length - 1, 0); ok(total === nChanged - 1, 'the upload file has only the ticked changes (' + total + ' of ' + (nChanged - 1) + ')');
  ok(upr.slice(1).every(r => r[UH.indexOf('Operation')] === 'Update' && typeof r[UH.indexOf('Bid')] === 'number' && r[UH.indexOf('Bid')] > 0) && UH.join() !== H.join(), 'upload rows: Operation = Update, a new Bid, the original columns');
  await page.evaluate(() => opDownloadReview()); await sleep(500);
  book = await lastBook(); const rv = book['Sponsored Products Campaigns'], RH = rv[0];
  ok(book.Summary && RH.includes('Rule applied') && RH.includes('Change %') && rv.slice(1).some(r => typeof r[RH.indexOf('New Bid')] === 'number'), 'the review file: summary sheet, New Bid filled for the changes, the rule and the change %');
  // ---- Product Pages placements
  ok(!(await page.$eval('#opPPCard', e => e.classList.contains('hidden'))), 'the Product Pages card is shown when the file has Product Pages rows');
  await page.evaluate(() => opPPFind()); await sleep(400);
  ok((await T('#opPPOut')).includes('1 of 1 campaigns bleed on Product Pages') && (await T('#opPPOut')).includes('Identify only') && (await T('#opPPOut')).toLowerCase().includes('no sales on product pages'), 'a bleeding Product Pages placement is identified (identify only: nothing is changed) ' + (await T('#opPPOut')).slice(0, 80).replace(/\s+/g, ' '));
  await page.evaluate(() => { document.querySelector('input[name="opPPAction"][value="both"]').click(); opPPFind(); }); await sleep(400);
  ok(/Adjustment 20% → 10%/.test(await T('#opPPOut')) && (await T('#opPPOut')).includes('Target bids to $1.35'), 'recommendation: half the adjustment, bids 10% under the Product Pages CPC');
  await page.evaluate(() => { document.getElementById('opPPPlaceMode').value = 'manual'; document.getElementById('opPPPlaceManual').value = '5'; document.getElementById('opPPBidMode').value = 'manual'; document.getElementById('opPPBidManual').value = '0.5'; opPPFind(); }); await sleep(400);
  ok(/Adjustment 20% → 5%/.test(await T('#opPPOut')) && (await T('#opPPOut')).includes('Target bids to $0.50'), 'or my own adjustment and bid');
  await page.evaluate(() => opOptimize()); await sleep(600);
  ok((await T('#opOut')).includes('Product Pages placement change') && (await T('#opOut tbody')).includes('20% → 5%') && (await T('#opOut tbody')).includes('bid set to $0.50'), 'Optimize includes the Product Pages changes, the placement change as its own row');
  await page.evaluate(() => opDownloadUpload()); await sleep(500);
  book = await lastBook(); const pu = book['Sponsored Products Campaigns'], PH = pu[0], pj = n => PH.indexOf(n), prow = pu.slice(1).find(r => r[pj('Entity')] === 'Bidding Adjustment');
  ok(prow && prow[pj('Percentage')] === 5 && prow[pj('Operation')] === 'Update' && prow[pj('Placement')] === 'Placement Product Page', 'the upload file carries the placement change as the original Bidding Adjustment row with the new Percentage');
  ok(PH.slice(-13).join() === 'New Bid,Old Bid,Minimum Bid,Maximum Bid,RPC,RPC Check,RPC Status,Bidding Strategy,Start Date,TOS %,ROS %,PP %,ABP %' && pu.slice(1).every(r => r.length === PH.length), 'the reference columns are at the end of the upload file');
  ok(pu.slice(1).filter(r => r[pj('Keyword Text')]).every(r => r[pj('New Bid')] === r[pj('Bid')] && typeof r[pj('Old Bid')] === 'number'), 'on a target row New Bid is the Bid being uploaded, next to the Old Bid');
  await page.evaluate(() => { document.querySelector('#opOut input[onchange^="opUpExtras"]').click(); }); await page.evaluate(() => opDownloadUpload()); await sleep(500);
  book = await lastBook(); ok(book['Sponsored Products Campaigns'][0].length === PH.length - 13 && book['Sponsored Products Campaigns'][0].join() === pu[0].slice(0, PH.length - 13).join(), 'without the option the upload file has the original columns only');
  await page.evaluate(() => { opUpExtras(true); document.querySelector('input[name="opPPAction"][value="none"]').click(); document.getElementById('opPPPlaceMode').value = 'rec'; document.getElementById('opPPBidMode').value = 'rec'; document.getElementById('opPPPlaceManual').value = ''; document.getElementById('opPPBidManual').value = ''; });

  // ---- rules: switching the metric converts, separate rule sets, presets
  await page.select('#opMetric', 'acos'); await sleep(300);
  ok((await page.$eval('[data-path="low.0.at"]', e => e.value)) === '100' && (await page.$eval('[data-path="perf.0.at"]', e => e.value)) === '25', 'switching to ACOS converts the thresholds (ROAS 1 = 100%, ROAS 4 = 25%)');
  await page.evaluate(() => opOptimize()); await sleep(500);
  ok(/\d+ of \d+ active targets/.test(await T('#opOut h2')) && (await T('#opOut tbody')).includes('ACOS'), 'Optimize runs on ACOS');
  await page.select('#opMetric', 'roas'); await sleep(300);
  await page.evaluate(() => opMode('separate')); await sleep(300);
  ok((await page.$$eval('#opRules [role="tab"]', e => e.map(x => x.innerText))).join() === 'Sponsored Products,Sponsored Brands,Sponsored Display', 'separate rules: one tab per ad type in the file');
  await page.$eval('[data-path="low.0.pct"]', e => { e.value = '40'; e.dispatchEvent(new Event('change', { bubbles: true })); });   // SP only
  await page.evaluate(() => opOptimize()); await sleep(500);
  const before = await T('#opOut tbody');
  ok(/\$1\.20 .*\$0\.72|\$0\.72/.test(before.replace(/\n/g, ' ')) || before.includes('-40.0%'), 'the SP rule set changed (-40%) without touching the others');
  await page.evaluate(() => opMode('shared')); await sleep(200);
  // RPC: the file's RPC spread, and thresholds that cannot match anything are flagged
  await page.select('#opMetric', 'rpc'); await sleep(300);
  ok((await T('#opRules')).includes('RPC across') && (await page.$eval('[data-path="low.0.at"]', e => e.value)) === '', 'RPC: the file\'s RPC spread is shown and the thresholds start empty');
  await page.$eval('[data-path="low.0.at"]', e => { e.value = '999'; e.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(300);
  ok((await T('#opRules')).includes('above the highest RPC'), 'a threshold above every RPC in the file is flagged');
  const setRule = async (path, v) => { await page.$eval('[data-path="' + path + '"]', (e, x) => { e.value = x; e.dispatchEvent(new Event('change', { bubbles: true })); }, v); await sleep(150); };
  await setRule('low.0.at', '1'); await setRule('low.0.pct', '20'); await setRule('perf.0.at', '2'); await setRule('perf.0.pct', '10'); await setRule('perf.0.cap', '5');
  await page.evaluate(() => { document.getElementById('opRpcHi').value = '20'; }); await page.evaluate(() => opOptimize()); await sleep(600);
  ok((await T('#opOut')).toLowerCase().includes('rpc: too high'), 'in the preview a new bid that is still too high for the RPC is flagged');
  ok((await T('#opOut')).includes('RPC status of these targets') && (await T('#opOut')).toLowerCase().includes('bad / bleeding') && (await T('#opOut tbody')).toLowerCase().includes('ideal'), 'the preview shows the RPC status of every target in color, with a count per color');
  await page.select('#opFTone', 'red'); await sleep(300);
  ok((await page.$$eval('#opOut tbody tr', e => e.length)) >= 2 && !(await T('#opOut tbody')).toLowerCase().includes('ideal'), 'the preview can be filtered by RPC status');
  await page.select('#opFTone', ''); await sleep(200);
  await page.select('#opBasis', 'bench'); await sleep(300);
  ok((await page.$eval('[data-path="low.0.at"]', e => e.value)) === '50' && (await page.$eval('[data-path="perf.1.at"]', e => e.value)) === '150' && (await T('#opRules')).includes('account benchmark RPC'), 'RPC thresholds can be a % of the account benchmark (starting tiers 50/70/85 and 120/150)');
  await page.evaluate(() => opOptimize()); await sleep(600);
  ok((await T('#opOut tbody')).includes('of benchmark'), 'Optimize on the benchmark: the rules read "% of benchmark"');
  await page.select('#opMetric', 'roas'); await sleep(300); await page.evaluate(() => { document.getElementById('opRpcHi').value = '50'; });
  // profiles: save, come back by themselves, defaults, export, import (sanitized), delete
  const dialogOk = async () => { await sleep(250); await page.evaluate(() => document.querySelector('[role="dialog"] [data-ok]').click()); await sleep(400); };
  await page.$eval('[data-path="low.0.pct"]', e => { e.value = '33'; e.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.evaluate(() => { document.getElementById('opSkipRank').checked = false; document.getElementById('opWords').value = 'defense, brand'; document.getElementById('opFloor_sp').value = '0.05'; document.getElementById('opTargetAcos').value = '35'; document.getElementById('opScope').value = 'account'; document.querySelector('input[name="opPPAction"][value="placement"]').click(); document.getElementById('opPPCut').value = '30'; });
  await page.evaluate(() => { window.prompt = () => "Kezef"; opProfileSaveAs(); }); await sleep(500);
  ok((await page.$$eval('#opProfSel option', e => e.map(x => x.textContent))).includes('Kezef') && (await page.$eval('#opProfSel', e => e.value)) === 'Kezef', 'a profile is saved under a name and selected');
  await page.evaluate(() => opSample()); await sleep(600);
  ok((await page.$eval('#opProfSel', e => e.value)) === 'Kezef' && (await page.$eval('[data-path="low.0.pct"]', e => e.value)) === '33' && !(await page.$eval('#opSkipRank', e => e.checked)) && (await page.$eval('#opWords', e => e.value)) === 'defense, brand' && (await page.$eval('#opFloor_sp', e => e.value)) === '0.05', 'the profile used last comes back by itself with a new file: rules and options');
  ok((await page.$eval('#opTargetAcos', e => e.value)) === '35' && (await page.$eval('#opScope', e => e.value)) === 'account' && (await T('#opBench')).includes('whole account') && (await T('#opBench')).includes('35% (yours)'), 'target ACOS and the benchmark scope come back with the profile');
  ok((await page.$eval('input[name="opPPAction"]:checked', e => e.value)) === 'placement' && (await page.$eval('#opPPCut', e => e.value)) === '30', 'the Product Pages settings come back with the profile');
  await page.select('#opProfSel', ''); await sleep(500);
  ok((await page.$eval('[data-path="low.0.pct"]', e => e.value)) === '20' && (await page.$eval('#opSkipRank', e => e.checked)) && (await page.$eval('#opTargetAcos', e => e.value)) === '' && (await page.$eval('#opScope', e => e.value)) === 'product' && (await page.$eval('input[name="opPPAction"]:checked', e => e.value)) === 'none' && (await page.$eval('#opPPCut', e => e.value)) === '50', '"No profile" goes back to the defaults');
  await page.select('#opProfSel', 'Kezef'); await sleep(400); await page.evaluate(() => opProfileExport()); await sleep(300);
  const exported = JSON.parse(await page.evaluate(async () => window.__dls[window.__dls.length - 1].text()));
  ok(exported.name === 'Kezef' && exported.rules.shared.low[0].pct === 33 && exported.options.skipRank === false && exported.options.skipCatchAll === false && exported.options.skipLowBid === false && exported.options.skipWords.join() === 'defense,brand', 'a profile can be exported as a file');
  const tmp = mkdtempSync(join(tmpdir(), 'opt-')), hostile = join(tmp, 'acme.optimizer-profile.json');
  writeFileSync(hostile, JSON.stringify({ name: 'Acme', v: 1, rules: { mode: 'shared', shared: { metric: 'bogus', low: [{ at: -3, pct: 500 }], extra: '<img src=x onerror=alert(1)>' } }, options: { skipWords: ['<b>x</b>'], floors: { sp: 'abc' }, rpcStatus: { targetAcos: -5, scope: '<x>', minClicks: 'a' }, pp: { action: 'evil', cut: -5, placeManual: 5000 } } }));
  await (await page.$('#opProfFile')).uploadFile(hostile); await sleep(700);
  ok((await page.$eval('#opProfSel', e => e.value)) === 'Acme' && (await page.$eval('[data-path="low.0.pct"]', e => e.value)) === '100' && (await page.$eval('#opMetric', e => e.value)) === 'roas' && (await page.$eval('[data-path="low.0.at"]', e => e.value)) === '' && (await page.$eval('#opFloor_sp', e => e.value)) === '0.02' && (await page.$eval('#opTargetAcos', e => e.value)) === '' && (await page.$eval('#opScope', e => e.value)) === 'product' && (await page.$eval('#opMinClicks', e => e.value)) === '10' && (await page.$eval('input[name="opPPAction"]:checked', e => e.value)) === 'none' && (await page.$eval('#opPPCut', e => e.value)) === '50', 'an imported profile is checked: bad numbers and metrics fall back, nothing odd gets in');
  await page.evaluate(() => { opProfileDelete(); }); await dialogOk();
  ok(!(await page.$$eval('#opProfSel option', e => e.map(x => x.textContent))).includes('Acme'), 'a profile can be deleted');
  await page.select('#opProfSel', 'Kezef'); await sleep(300); await page.evaluate(() => { opProfileDelete(); }); await dialogOk();
  ok((await page.$$eval('#opProfSel option', e => e.length)) === 1 && !(await page.evaluate(() => localStorage.getItem('ppcb_optimizer_profile_last'))), 'all profiles gone, and nothing is auto-applied any more');
  await page.evaluate(() => opSample()); await sleep(500);

  // ---- the real workbook, when it is there (account data, not in the repo)
  const dir = join(ROOT, 'Bulk Optimization'), real = existsSync(dir) ? readdirSync(dir).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~$'))[0] : null;
  if (real) {
    const t0 = Date.now(); await (await page.$('#opFile')).uploadFile(join(dir, real));
    await page.waitForFunction(() => /Sponsored Products/.test(document.getElementById('opSummary').innerText) && /SB Multi Ad Group/.test(document.getElementById('opSummary').innerText), { timeout: 120000 }); await sleep(500);
    const s2 = await T('#opSummary'), norm = s2.replace(/\s+/g, ' ');
    ok(/Sponsored Products 513 \/ 513 2,?946 \/ 2,?947/.test(norm.replace(/,/g, '')) || /Sponsored Products\s+513 \/ 513\s+2946 \/ 2947/.test(norm.replace(/,/g, '')), 'real file: Sponsored Products 513 active campaigns, 2,946 of 2,947 targets active (' + norm.slice(0, 200) + ')');
    ok(/Sponsored Brands 15 \/ 15 89 \/ 425/.test(norm) && /SB Multi Ad Group 14 \/ 14 80 \/ 171/.test(norm) && /Sponsored Display 6 \/ 6 94 \/ 103/.test(norm), 'real file: SB 89, SB Multi Ad Group 80 and SD 94 active targets');
    console.log('  (real file read in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
    const optTxt = await T('#opOptions');
    ok(/Exclude ranking campaigns\s*\(25 campaigns/.test(optTxt) && /Exclude catch-all campaigns\s*\(10 campaigns/.test(optTxt) && /Exclude low-bid campaigns\s*\(33 campaigns/.test(optTxt), 'real file: ranking (25), catch-all (10) and low-bid (33) campaigns are offered with their counts');
    ok((await page.$eval('#opSkipRank', e => e.checked)) && !(await page.$eval('#opSkipCatchAll', e => e.checked)) && !(await page.$eval('#opSkipLowBid', e => e.checked)), 'real file: ranking is excluded by default, the others are not');
    await page.evaluate(() => { document.getElementById('opSkipRank').checked = false; });   // the counts below are for the whole file
    await page.evaluate(() => opSortFilter()); await sleep(2500);
    book = await lastBook(); const r = book['Sponsored Products Campaigns'], RH2 = r[0], ix = n => RH2.indexOf(n);
    ok(r.length - 1 === 2946 + 513 + 513, 'real file: Sort & Filter keeps 2,946 targets + 513 campaigns + 513 ad groups (' + (r.length - 1) + ')');
    const im = r.slice(1).map(x => +x[ix('Impressions')]); ok(im.every((v, i) => !i || im[i - 1] >= v), 'real file: sorted by impressions');
    ok(r.slice(1).every(x => ['Campaign', 'Ad Group', 'Keyword', 'Product Targeting'].includes(x[ix('Entity')])) && r.slice(1).filter(x => x[ix('Start Date')]).length > 3000, 'real file: only campaigns, ad groups and targets, with start dates');
    const stc = r.slice(1).map(x => String(x[ix('RPC Status')])); ok(stc.some(v => v.startsWith('🟢')) && stc.some(v => v.startsWith('🔴')) && stc.some(v => v.startsWith('⚪')) && stc.includes('🔴 Bleeding'), 'real file: RPC status in all four colors (' + [...new Set(stc.map(v => v.split(' ')[0]))].join(' ') + ')');
    ok(r.slice(1).every(x => x[ix('Operation')] === 'Update') && r.slice(1).filter(x => typeof x[ix('TOS %')] === 'number').length > 3900 && r.slice(1).filter(x => typeof x[ix('ABP %')] === 'number').length > 3000 && r.slice(1).filter(x => typeof x[ix('RPC')] === 'number').length > 1000 && r.slice(1).some(x => /^(Too high|Too low|OK) \(\d+%\)$/.test(x[ix('RPC Check')])), 'real file: Operation = Update, placement adjustments (TOS, ROS, PP, ABP), RPC and the RPC check are filled');
    ok(book['Sponsored Brands Campaigns'].length - 1 === 89 + 15 + 15 && book['SB Multi Ad Group Campaigns'].length - 1 === 80 + 14 + 14 && book['Sponsored Display Campaigns'].length - 1 === 94 + 6 + 6, 'real file: the other ad types are filtered the same way');
    await page.evaluate(() => opOptimize()); await sleep(3000);
    const h2 = await T('#opOut h2'), m2 = h2.match(/^([\d,]+) of ([\d,]+) active targets/); ok(m2 && +m2[2].replace(/,/g, '') === 2946 + 89 + 80 + 94, 'real file: every active target is considered (' + h2 + ')');
    await page.evaluate(() => opDownloadUpload()); await sleep(1500);
    book = await lastBook(); const rows = Object.values(book).reduce((n, x) => n + x.length - 1, 0); ok(m2 && rows === +m2[1].replace(/,/g, ''), 'real file: the upload file has exactly the changed rows (' + rows + ')');
    ok(Object.values(book).every(sh => { const h = sh[0], o = h.indexOf('Operation'), b = h.indexOf('Bid'); return sh.slice(1).every(x => x[o] === 'Update' && x[b] > 0); }), 'real file: all upload rows are Update with a positive bid');
    // all three excluded: gone from the sorted file and from the upload file
    const BAD = /(^|[^a-z])rank(ing|s)?(?![a-z])|catch[\s_-]*all|(^|[^a-z])low[\s_-]*bids?(?![a-z])/i;
    await page.evaluate(() => { ['opSkipRank', 'opSkipCatchAll', 'opSkipLowBid'].forEach(id => { document.getElementById(id).checked = true; }); });
    await page.evaluate(() => opSortFilter()); await sleep(2500);
    book = await lastBook(); const sp2 = book['Sponsored Products Campaigns'], nm = sp2[0].indexOf('Campaign Name (Informational only)');
    ok(sp2.length - 1 > 1500 && sp2.length - 1 < r.length - 1 && !sp2.slice(1).some(x => BAD.test(String(x[nm]))), 'real file: with all three excluded no ranking, catch-all or low-bid campaign is left in the sorted file (' + (sp2.length - 1) + ' of ' + (r.length - 1) + ' rows)');
    await page.evaluate(() => opOptimize()); await sleep(3000); await page.evaluate(() => opDownloadUpload()); await sleep(1500);
    book = await lastBook(); const up2 = book['Sponsored Products Campaigns'], nm2 = up2[0].indexOf('Campaign Name (Informational only)');
    ok(up2.length > 100 && !up2.slice(1).some(x => BAD.test(String(x[nm2]))), 'real file: and none of them is in the upload file');
    // bleeding Product Pages placements in the real file
    await page.evaluate(() => { ['opSkipRank', 'opSkipCatchAll', 'opSkipLowBid'].forEach(id => { document.getElementById(id).checked = false; }); document.querySelector('input[name="opPPAction"][value="both"]').click(); opPPFind(); }); await sleep(1500);
    const ppt = await T('#opPPOut'), mm = ppt.match(/^(\d+) of (\d+) campaigns bleed on Product Pages/);
    ok(mm && +mm[2] > 400 && +mm[1] > 0 && +mm[1] < +mm[2], 'real file: ' + (mm ? mm[1] + ' of ' + mm[2] : ppt.slice(0, 60)) + ' campaigns bleed on Product Pages');
    ok(ppt.includes('Adjustment is already 0%'), 'real file: a bleeding campaign whose Product Pages adjustment is already 0% is told so (its bids are the lever)');
    await page.evaluate(() => opOptimize()); await sleep(4000);
    ok((await page.$$eval('#opFRule option', o => o.map(x => x.textContent))).some(x => x.startsWith('Bleeding Product Pages: bid under the Product Pages CPC')), 'real file: Optimize lowers target bids under the Product Pages CPC in the bleeding campaigns');
    await page.evaluate(() => opDownloadUpload()); await sleep(2000);
    book = await lastBook(); const rp = book['Sponsored Products Campaigns'], RPH = rp[0];
    ok(rp.length > 100 && rp.slice(1).every(x => x.length === RPH.length && x[RPH.indexOf('Operation')] === 'Update'), 'real file: the upload file keeps its shape with the Product Pages bid cuts in it');
  } else console.log('  (no real workbook in "Bulk Optimization/": that part was skipped)');
  ok(errs.length === 0, `no script errors (${errs.join(' | ')})`);
} catch (e) { failures++; console.log('  ERROR', e && e.stack || e); }
finally { if (browser) await browser.close(); server.kill(); }
console.log(failures ? `optimizer-ui: ${failures} FAILED` : 'optimizer-ui: all checks pass');
process.exit(failures ? 1 : 0);
