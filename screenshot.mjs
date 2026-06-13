// Screenshot a URL with Puppeteer.
// Usage: node screenshot.mjs <url> [label]
//   node screenshot.mjs http://localhost:3000
//   node screenshot.mjs http://localhost:3000 home
// Saves to ./temporary screenshots/screenshot-N[-label].png (auto-incremented, never overwritten).
import puppeteer from 'puppeteer';
import { mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || 'http://localhost:3000';
const label = process.argv[3] ? `-${process.argv[3].replace(/[^a-zA-Z0-9_-]/g, '')}` : '';

const outDir = join(__dirname, 'temporary screenshots');
await mkdir(outDir, { recursive: true });

// Auto-increment: find the highest existing screenshot-N and add 1.
let next = 1;
try {
  const files = await readdir(outDir);
  const nums = files
    .map(f => /^screenshot-(\d+)/.exec(f))
    .filter(Boolean)
    .map(m => parseInt(m[1], 10));
  if (nums.length) next = Math.max(...nums) + 1;
} catch {}

const outPath = join(outDir, `screenshot-${next}${label}.png`);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.screenshot({ path: outPath, fullPage: true });
  console.log(`Saved: ${outPath}`);
} finally {
  await browser.close();
}
