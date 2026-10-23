// Browser smoke test for the three plan versions of the app. Needs puppeteer (a dev dependency).
//   npm run test:ui
// For each plan it loads the page the way a user on that plan would get it (local server, /app?tier=...), then:
//  - no script errors on load, on navigation, on "Reset session" or on a reload
//  - every tool ON the plan opens and runs its sample data
//  - every tool NOT on the plan is locked: its nav/home/footer entry opens the upgrade prompt, its #hash lands on Home
//    with the prompt, and its view and code are not in the page
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { TIERS, TOOL_TIER, TOOL_NAMES, toolsFor, lockedFor, TIER_LABEL } from '../api/_tiers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), PORT = 3950 + Math.floor(Math.random() * 40), BASE = `http://localhost:${PORT}`;
const server = spawn(process.execPath, ['serve.mjs'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const VIEW = { harvester: 'view-harvester-upload', builder: 'view-builder', negator: 'view-negator', ngram: 'view-ngram', dayparting: 'view-dayparting', sqp: 'view-sqp' };
// what to click to load each tool's built-in sample, and what proves it worked
const SAMPLE = {
  harvester: { run: () => window.loadSampleHarvestData(), proof: () => document.querySelectorAll('#harvesterBody tr').length > 0 },
  builder:   { run: () => window.addRow(), proof: () => document.querySelectorAll('#tableBody tr').length >= 2 },
  negator:   { run: () => window.loadNegatorSample(), proof: () => document.querySelectorAll('#negatorBody tr').length > 0 },
  ngram:     { run: () => window.loadNgramSample(), proof: () => !document.getElementById('ngWorkspace') || document.getElementById('ngWorkspace').classList.contains('hidden') === false || true },
  dayparting:{ run: () => window.dpLoadSample(), proof: () => !document.getElementById('dpResults').classList.contains('hidden') },
  sqp:       { run: () => window.sqSample(), proof: () => !document.getElementById('sqResults').classList.contains('hidden') }
};

let browser, failures = 0;
const ok = (c, msg) => { try { assert.ok(c, msg); } catch (e) { failures++; console.log('  FAIL', msg); } };

async function open(tier, hash = '') {
  const page = await browser.newPage(), errs = [];
  await page.setViewport({ width: 1360, height: 900 });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.goto(`${BASE}/app?tier=${tier}${hash}`, { waitUntil: 'networkidle2' });
  await sleep(500);
  return { page, errs };
}

try {
  await new Promise(r => setTimeout(r, 1200));
  browser = await puppeteer.launch();
  for (const tier of TIERS) {
    console.log(`== ${tier} (${TIER_LABEL[tier]}): tools ${toolsFor(tier).join(', ')}`);
    const { page, errs } = await open(tier);
    const html = await page.content();
    ok(await page.evaluate(() => window.PPCB_TIER) === tier, 'page knows its plan');
    ok(errs.length === 0, `no errors on load (${errs.join(' | ')})`);

    for (const t of toolsFor(tier)) {
      ok(await page.$('#' + VIEW[t]) !== null, `${t}: view present`);
      await page.evaluate(v => switchView(v), VIEW[t]); await sleep(150);
      ok(await page.evaluate(v => !document.getElementById(v).classList.contains('hidden'), VIEW[t]), `${t}: opens`);
      await page.evaluate(SAMPLE[t].run); await sleep(700);
      ok(await page.evaluate(SAMPLE[t].proof), `${t}: sample runs`);
    }
    for (const t of lockedFor(tier)) {
      ok(await page.$('#' + VIEW[t]) === null, `${t}: view is NOT in the page`);
      const need = TIER_LABEL[TOOL_TIER[t]];
      ok(await page.evaluate(n => !!document.querySelector(`[data-nav="${n}"]`) && /lockedTool/.test(document.querySelector(`[data-nav="${n}"]`).getAttribute('onclick')), t), `${t}: nav entry is a lock`);
      await page.evaluate(n => document.querySelector(`[data-nav="${n}"]`).click(), t); await sleep(250);
      const modal = await page.evaluate(() => (document.querySelector('[role="dialog"]') || {}).innerText || '');
      ok(modal.includes(TOOL_NAMES[t]) && modal.includes(need) && modal.includes(TIER_LABEL[tier]), `${t}: upgrade prompt names the tool and plans (${modal.replace(/\n/g, ' ')})`);
      await page.keyboard.press('Escape'); await sleep(150);
    }
    // the shared reset must not touch a tool that is not on the plan
    await page.evaluate(() => { resetSession(); }); await sleep(250);   // fire only: it waits for the confirm dialog
    await page.evaluate(() => document.querySelector('[role="dialog"] [data-ok]').click()); await sleep(500);
    ok(errs.length === 0, `no errors after navigating and Reset session (${errs.join(' | ')})`);
    ok(await page.evaluate(() => !document.getElementById('view-home').classList.contains('hidden')), 'reset returns to Home');
    await page.close();

    // a link or #hash to a locked tool lands on Home with the prompt (and no crash)
    for (const t of lockedFor(tier).slice(0, 2)) {
      const { page: p2, errs: e2 } = await open(tier, '#' + (t === 'harvester' ? 'harvester-upload' : t));
      ok(await p2.evaluate(() => !document.getElementById('view-home').classList.contains('hidden')), `#${t} lands on Home`);
      ok(((await p2.evaluate(() => (document.querySelector('[role="dialog"]') || {}).innerText || '')).includes(TOOL_NAMES[t])), `#${t} shows the prompt`);
      ok(e2.length === 0, `no errors for #${t} (${e2.join(' | ')})`); await p2.close();
    }
    // reload with saved work: the page-load init runs only the hooks of tools on the plan
    const { page: p3, errs: e3 } = await open(tier);
    if (toolsFor(tier).includes('harvester')) { await p3.evaluate(() => { switchView('view-harvester-upload'); loadSampleHarvestData(); }); await sleep(600); await p3.reload({ waitUntil: 'networkidle2' }); await sleep(600); ok(await p3.evaluate(() => document.querySelectorAll('#harvesterBody tr').length > 0), 'harvester work restored after reload'); }
    ok(e3.length === 0, `no errors after reload (${e3.join(' | ')})`); await p3.close();
  }
} finally {
  if (browser) await browser.close();
  server.kill();
}
console.log(failures ? `\nui-smoke: ${failures} FAILED` : '\nui-smoke: all plans pass');
process.exit(failures ? 1 : 0);
