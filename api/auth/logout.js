// POST /api/auth/logout → clears every auth cookie and revokes the Supabase session (best effort).
import { config_, getCookie, sbToken, sbRevoke, CLEAR_ALL } from '../_auth.js';
export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const c = config_(), rt = getCookie(request, 'ppcb_rt');
  if (c.ok && rt) { const t = await sbToken(c, 'refresh_token', { refresh_token: rt }); if (t) await sbRevoke(c, t.access_token); }
  const h = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  CLEAR_ALL.forEach(x => h.append('Set-Cookie', x));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
}
