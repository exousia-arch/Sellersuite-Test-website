// Shared helpers for Google sign-in via Supabase Auth (server side). Underscore = not a route.
//
// Security rules baked in here:
//  - every redirect target is a constant from GO below. Nothing from the URL, a header or a cookie
//    ever reaches a Location header (no open redirects).
//  - the redirect_to we send to Supabase is the one exact CALLBACK address registered in Supabase.
//  - PKCE (S256) is used on every request: the verifier lives only in an HttpOnly cookie, so a
//    callback that did not start in this browser is rejected. Supabase adds its own one-time `state`
//    for the Google leg.
//  - only users the SERVER marked approved (app_metadata.approved === true, settable only with the
//    service role / SQL, never by the user) can get a session, even if sign-ups are open.
//  - no Google tokens are stored; we keep our own short-lived signed session + Supabase refresh token.

export const SITE = 'https://www.ppcbench.com';
export const CALLBACK = SITE + '/api/auth/callback';
export const SESSION_MS = 15 * 60 * 1000;            // access window; the refresh token renews it
export const REFRESH_S = 7 * 24 * 60 * 60;           // refresh token cookie lifetime
const GO = { app: '/app', appRefreshed: '/app?r=1', login: '/login', unavailable: '/login?e=unavailable', denied: '/login?e=denied', notapproved: '/login?e=notapproved', refresh: '/api/auth/refresh' };
const enc = new TextEncoder();

export function b64url(bytes) {
  let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); if (s.length % 4) s += '='.repeat(4 - (s.length % 4));
  const b = atob(s), out = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i); return out;
}
export async function sha256(str) { return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(str))); }
export async function hmac(msg, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg))));
}
export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}

// Signed session cookie: base64url(json).hmac. { user, src:'sb' (Supabase) | undefined (legacy password), exp }
export async function signSession(data, secret) {
  const p = b64url(enc.encode(JSON.stringify(data))); return p + '.' + await hmac(p, secret);
}
export async function readSession(token, secret) {
  if (!token || !secret) return null;
  const i = token.lastIndexOf('.'); if (i < 1) return null;
  const p = token.slice(0, i);
  if (!safeEqual(token.slice(i + 1), await hmac(p, secret))) return null;
  let d; try { d = JSON.parse(new TextDecoder().decode(fromB64url(p))); } catch (e) { return null; }
  return d && typeof d.exp === 'number' && Date.now() <= d.exp ? d : null;
}
// Legacy password users (PPCBENCH_USERS="user:pass,...") stay valid only while still on that list.
export const legacyAllow = raw => (raw || '').split(',').map(p => { const i = p.indexOf(':'); return i > 0 ? p.slice(0, i).trim().toLowerCase() : ''; }).filter(Boolean);
export async function isAuthed(request, secret, legacyUsers) {
  const d = await readSession(getCookie(request, 'ppcb_session'), secret);
  if (!d) return false;
  if (d.src === 'sb') return true;                     // minted by /api/auth/callback or /refresh only
  return !!d.user && legacyAllow(legacyUsers).includes(d.user);
}

export function getCookie(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch (e) { return ''; }
}
export const setCookie = (name, value, { maxAge, path = '/' }) => `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=${maxAge}`;
export const clearCookie = (name, path = '/') => `${name}=; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=0`;
export const sessionCookie = token => setCookie('ppcb_session', token, { maxAge: SESSION_MS / 1000 });
export const refreshCookie = rt => setCookie('ppcb_rt', rt, { maxAge: REFRESH_S, path: '/api/auth' });
export const CLEAR_ALL = [clearCookie('ppcb_session'), clearCookie('ppcb_rt', '/api/auth'), clearCookie('ppcb_pkce', '/api/auth')];

// The ONLY way to redirect: a key into GO. Unknown key throws rather than guessing.
export function go(key, cookies = []) {
  if (!(key in GO)) throw new Error('unknown redirect target');
  const h = new Headers({ Location: SITE + GO[key], 'Cache-Control': 'no-store' });
  cookies.forEach(c => h.append('Set-Cookie', c));
  return new Response(null, { status: 302, headers: h });
}

export function config_() {
  const url = process.env.SUPABASE_URL || '', key = process.env.SUPABASE_ANON_KEY || '', secret = process.env.AUTH_SECRET || '';
  const ok = /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url) && key.length > 20 && secret.length >= 16;
  return { ok, url, key, secret };
}

// Server-approved only. app_metadata can't be edited by the signed-in user (user_metadata can).
export const approved = u => !!u && typeof u.email === 'string' && u.email.length > 0 && !!u.app_metadata && u.app_metadata.approved === true;

export async function sbToken(c, grant, body) {
  try {
    const r = await fetch(`${c.url}/auth/v1/token?grant_type=${grant}`, { method: 'POST', headers: { apikey: c.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return null;
    const t = await r.json();
    return t && t.access_token && t.refresh_token && t.user ? t : null;
  } catch (e) { return null; }
}
export async function sbRevoke(c, accessToken) {   // best effort: kill this session at Supabase
  try { await fetch(`${c.url}/auth/v1/logout?scope=local`, { method: 'POST', headers: { apikey: c.key, Authorization: 'Bearer ' + accessToken } }); } catch (e) { /* ignore */ }
}
export async function mintCookies(t, c) {          // Supabase token response -> our two cookies
  const session = await signSession({ user: t.user.email.toLowerCase(), uid: t.user.id, src: 'sb', exp: Date.now() + SESSION_MS }, c.secret);
  return [sessionCookie(session), refreshCookie(t.refresh_token)];
}
