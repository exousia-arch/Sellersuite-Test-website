// POST /api/auth/renew ← the page calls this (no redirect) when a saved-history request says the access window ended.
// Same rules as /refresh: rotates the HttpOnly refresh token, re-checks approval, re-mints the cookies.
import { config_, getCookie, approved, sbToken, sbRevoke, mintCookies, CLEAR_ALL, SITE } from '../_auth.js';
export const config = { runtime: 'edge' };

const out = (status, cookies = []) => {
  const h = new Headers({ 'Cache-Control': 'no-store' });
  cookies.forEach(c => h.append('Set-Cookie', c));
  return new Response(null, { status, headers: h });
};

export default async function handler(request) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (request.headers.get('origin') !== SITE) return out(403);                 // browsers always send Origin on POST
  const c = config_(), rt = getCookie(request, 'ppcb_rt');
  if (!c.ok || !rt) return out(401);
  const t = await sbToken(c, 'refresh_token', { refresh_token: rt });
  if (!t) return out(401, CLEAR_ALL);
  if (!approved(t.user)) { await sbRevoke(c, t.access_token); return out(401, CLEAR_ALL); }
  return out(204, await mintCookies(t, c));
}
