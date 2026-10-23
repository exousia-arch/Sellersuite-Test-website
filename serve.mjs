// Minimal static file server for the project root.
// Usage: node serve.mjs   ->   serves ./ at http://localhost:3000
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { isTier, toolsFor } from './api/_tiers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// Local dev has no login: /app serves the page built for a plan, chosen with /app?tier=free|core|pro (default pro,
// or DEV_TIER) and remembered for the stub /api/me. Production does this in middleware.js from the signed session.
let devTier = isTier(process.env.DEV_TIER) ? process.env.DEV_TIER : 'pro';

const server = createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    let urlPath = decodeURIComponent(reqUrl.pathname);
    if (urlPath === '/') urlPath = '/index.html';
    if (urlPath === '/api/me') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ authed: true, user: 'dev@local', via: 'password', tier: devTier, tools: toolsFor(devTier) })); return; }
    if (urlPath === '/app' || urlPath === '/app.html') { if (isTier(reqUrl.searchParams.get('tier'))) devTier = reqUrl.searchParams.get('tier'); urlPath = `/gated/app.${devTier}.htm`; }
    // Prevent path traversal: resolve within project root only.
    let filePath = normalize(join(__dirname, urlPath));
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let data;
    try {
      data = await readFile(filePath);
    } catch {
      // Mirror Vercel cleanUrls: extensionless path -> try the .html file
      if (!extname(filePath)) { filePath += '.html'; data = await readFile(filePath); }
      else throw new Error('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

server.listen(PORT, () => console.log(`Serving ${__dirname} at http://localhost:${PORT}`));
