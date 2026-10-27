// POST /api/login  { username, password }  → validates against the PPCBENCH_USERS
// env allowlist and sets a signed, http-only session cookie (HMAC-SHA256 / AUTH_SECRET).
// PPCBENCH_USERS format: "user1:pass1,user2:pass2" (usernames are case-insensitive).
import { signSession, setCookie, accessCookie, sbToken, approved, config_ } from './_auth.js';
export const config = { runtime: 'edge' };

// PPCBENCH_SHARED_DB = {"username": {"email": "...", "password": "..."}}: which Supabase account backs a shared username.
function sharedAccount(raw, username) {
  try { const m = JSON.parse(raw || '{}'), e = Object.prototype.hasOwnProperty.call(m, username) ? m[username] : null; return e && typeof e.email === 'string' && typeof e.password === 'string' ? e : null; } catch (e) { return null; }
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
  const cookies = [];
  // Shared tester accounts with saved SQP history: the username maps to ONE Supabase account (PPCBENCH_SHARED_DB),
  // signed in here with its password, so everyone using the username reads and writes the same saved data through
  // row security. If Supabase is unreachable the person still gets in; only saved history is unavailable.
  const shared = sharedAccount(process.env.PPCBENCH_SHARED_DB, username), c = config_();
  let uid = null;
  if (shared && c.ok) {
    const t = await sbToken(c, 'password', { email: shared.email, password: shared.password });
    if (t && approved(t.user)) {
      uid = t.user.id;
      cookies.push(setCookie('ppcb_rt', t.refresh_token, { maxAge: MAX_AGE, path: '/api/auth' }), accessCookie(t.access_token));
    }
  }
  const token = await signSession(Object.assign({ user: username, exp }, uid ? { db: 1, uid } : {}), secret);
  cookies.unshift(setCookie('ppcb_session', token, { maxAge: MAX_AGE }));
  const h = new Headers({ 'Content-Type': 'application/json' });
  cookies.forEach(x => h.append('Set-Cookie', x));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
}
