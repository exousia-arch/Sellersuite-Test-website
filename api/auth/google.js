// GET /api/auth/google → starts Google sign-in through Supabase Auth with PKCE (S256).
// Scopes are Supabase's Google default (email + profile): the minimum to know who signed in. No other
// Google API is requested and no Google token is kept.
import { CALLBACK, b64url, sha256, config_, setCookie, go } from '../_auth.js';
export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const c = config_();
  if (!c.ok) return go('unavailable');

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));          // 64 chars, never leaves this browser except to our callback
  const u = new URL(c.url + '/auth/v1/authorize');
  u.searchParams.set('provider', 'google');
  u.searchParams.set('redirect_to', CALLBACK);                                  // exact registered address, constant
  u.searchParams.set('code_challenge', b64url(await sha256(verifier)));
  u.searchParams.set('code_challenge_method', 'S256');

  return new Response(null, { status: 302, headers: new Headers([
    ['Location', u.toString()],
    ['Cache-Control', 'no-store'],
    ['Set-Cookie', setCookie('ppcb_pkce', verifier, { maxAge: 600, path: '/api/auth' })]
  ]) });
}
