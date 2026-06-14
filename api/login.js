// POST /api/login  { username, password }  → validates against the PPCBENCH_USERS
// env allowlist and sets a signed, http-only session cookie (HMAC-SHA256 / AUTH_SECRET).
// PPCBENCH_USERS format: "user1:pass1,user2:pass2" (usernames are case-insensitive).
export const config = { runtime: 'edge' };

function bytesToB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmac(msg, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return bytesToB64url(new Uint8Array(sig));
}
function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}) });
}
function parseUsers(raw) {
  const map = new Map();
  (raw || '').split(',').forEach(pair => {
    const t = pair.trim();
    const i = t.indexOf(':');
    if (i < 1) return;
    map.set(t.slice(0, i).trim().toLowerCase(), t.slice(i + 1).trim());
  });
  return map;
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const secret = process.env.AUTH_SECRET || '';
  if (!secret) return json({ error: 'Access is not configured yet.' }, 500);
  const users = parseUsers(process.env.PPCBENCH_USERS);

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const username = (body && body.username ? String(body.username) : '').trim().toLowerCase();
  const password = (body && body.password ? String(body.password) : '');

  const expected = users.get(username);
  if (!username || expected === undefined || !safeEqual(password, expected)) {
    return json({ error: 'Invalid username or password.' }, 401);
  }

  const MAX_AGE = 30 * 24 * 60 * 60; // 30 days
  const exp = Date.now() + MAX_AGE * 1000;
  const payload = bytesToB64url(new TextEncoder().encode(JSON.stringify({ user: username, exp })));
  const sig = await hmac(payload, secret);
  const token = `${payload}.${sig}`;
  const cookie = `ppcb_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`;

  return json({ ok: true }, 200, { 'Set-Cookie': cookie });
}
