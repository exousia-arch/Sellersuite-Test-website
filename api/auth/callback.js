// GET /api/auth/callback?code=… ← Supabase redirects here after Google. This is the ONE address in
// Supabase's redirect list. The code is exchanged server side using the PKCE verifier from the cookie
// set by /api/auth/google, so a callback that did not start in this browser fails.
import { config_, getCookie, clearCookie, approved, sbToken, sbRevoke, mintCookies, go } from '../_auth.js';
export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const c = config_();
  const clearPkce = clearCookie('ppcb_pkce', '/api/auth');
  if (!c.ok) return go('unavailable', [clearPkce]);

  const q = new URL(request.url).searchParams, code = q.get('code') || '', verifier = getCookie(request, 'ppcb_pkce');
  if (q.get('error') || !code || code.length > 512 || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) return go('denied', [clearPkce]);

  const t = await sbToken(c, 'pkce', { auth_code: code, code_verifier: verifier });
  if (!t) return go('denied', [clearPkce]);

  if (!approved(t.user)) {                       // signed in with Google, but not invited/approved: no session
    await sbRevoke(c, t.access_token);
    return go('notapproved', [clearPkce]);
  }
  return go('app', [clearPkce, ...await mintCookies(t, c)]);
}
