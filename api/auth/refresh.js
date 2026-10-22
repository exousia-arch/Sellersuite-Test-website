// GET /api/auth/refresh ← the page gate sends expired sessions here. Uses the HttpOnly refresh token to
// get a new access window (Supabase rotates the token on every use and revokes the whole chain if an
// old one is replayed). Re-checks approval every time, so removing approval cuts access within 15 min.
import { config_, getCookie, approved, sbToken, sbRevoke, mintCookies, go, CLEAR_ALL } from '../_auth.js';
export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const c = config_(), rt = getCookie(request, 'ppcb_rt');
  if (!c.ok || !rt) return go('login');

  const t = await sbToken(c, 'refresh_token', { refresh_token: rt });
  if (!t) return go('login', CLEAR_ALL);
  if (!approved(t.user)) { await sbRevoke(c, t.access_token); return go('login', CLEAR_ALL); }
  return go('appRefreshed', await mintCookies(t, c));
}
