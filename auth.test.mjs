// node auth.test.mjs — security checks for Google sign-in (api/auth/*, middleware.js, api/me.js).
// Supabase is replaced by a fake fetch; nothing here touches the network or a real account.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;                      // Vercel's edge runtime has this global; Node 18 may not
import google from './api/auth/google.js';
import callback from './api/auth/callback.js';
import refresh from './api/auth/refresh.js';
import logout from './api/auth/logout.js';
import me from './api/me.js';
import middleware from './middleware.js';
import { signSession, sha256, b64url, SITE, CALLBACK } from './api/_auth.js';

const REF = 'abcdefghij0123456789';                    // 20 chars, same shape as a real project ref
process.env.SUPABASE_URL = `https://${REF}.supabase.co`;
process.env.SUPABASE_ANON_KEY = 'anon-key-for-tests-only-0000';
process.env.AUTH_SECRET = 'test-secret-that-is-long-enough';
process.env.PPCBENCH_USERS = 'legacyuser:pw';

// ---- fake Supabase
let calls = [], tokenReply = null;
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null, auth: (init.headers || {}).Authorization });
  if (String(url).includes('/auth/v1/token')) return tokenReply ? new Response(JSON.stringify(tokenReply), { status: 200 }) : new Response('{"error":"bad"}', { status: 400 });
  return new Response('{}', { status: 204 });
};
const user = (approved, email = 'Jo@Example.com') => ({ id: 'u-1', email, app_metadata: approved ? { approved: true, provider: 'google' } : { provider: 'google' }, user_metadata: { approved: true } });
const tokens = u => ({ access_token: 'at-1', refresh_token: 'rt-NEW', user: u });
const req = (path, { method = 'GET', cookie = '' } = {}) => new Request(SITE + path, { method, headers: cookie ? { cookie } : {} });
const setCookies = res => res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.get('set-cookie') || '').split(/,\s(?=[A-Za-z_]+=)/).filter(Boolean);   // old Node: no getSetCookie; our cookie values contain no commas
const cookieVal = (res, name) => { const c = setCookies(res).find(x => x.startsWith(name + '=')); return c ? decodeURIComponent(c.split(';')[0].slice(name.length + 1)) : null; };
const loc = res => res.headers.get('location');
const VERIFIER = b64url(new Uint8Array(48).fill(7));  // 64 chars, valid shape

// ===== 1. start: PKCE, exact redirect, no Google API scopes, verifier only in an HttpOnly cookie
let r = await google(req('/api/auth/google'));
let u = new URL(loc(r));
assert.equal(r.status, 302);
assert.equal(u.origin + u.pathname, `https://${REF}.supabase.co/auth/v1/authorize`);
assert.equal(u.searchParams.get('provider'), 'google');
assert.equal(u.searchParams.get('redirect_to'), CALLBACK);                     // exact registered address
assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
assert.equal(u.searchParams.has('scopes'), false);                              // Supabase default = email + profile only
const v = cookieVal(r, 'ppcb_pkce');
assert.equal(u.searchParams.get('code_challenge'), b64url(await sha256(v)));   // challenge matches the cookie's verifier
assert.match(v, /^[A-Za-z0-9_-]{64}$/);
assert.ok(!loc(r).includes(v), 'verifier must never appear in a URL');
const pk = setCookies(r).find(x => x.startsWith('ppcb_pkce='));
assert.ok(/HttpOnly/.test(pk) && /Secure/.test(pk) && /SameSite=Lax/.test(pk) && /Path=\/api\/auth/.test(pk) && /Max-Age=600/.test(pk));
assert.equal((await google(req('/api/auth/google', { method: 'POST' }))).status, 405);
// each start gets a fresh verifier
assert.notEqual(cookieVal(await google(req('/api/auth/google')), 'ppcb_pkce'), v);

// ===== 2. callback: every way to be wrong ends at a fixed /login address, with no session
const denied = SITE + '/login?e=denied';
const callbackWith = (qs, cookie = `ppcb_pkce=${VERIFIER}`) => callback(req('/api/auth/callback' + qs, { cookie }));
const noSession = res => assert.ok(!setCookies(res).some(c => c.startsWith('ppcb_session=') && !/Max-Age=0/.test(c)), 'must not set a session');

calls = []; r = await callbackWith('?code=abc', '');                            // no PKCE cookie = flow did not start in this browser
assert.equal(loc(r), denied); noSession(r); assert.equal(calls.length, 0, 'must not even call Supabase');
r = await callbackWith('?code=abc', 'ppcb_pkce=short'); assert.equal(loc(r), denied); noSession(r);       // malformed verifier
r = await callbackWith('');                                                     assert.equal(loc(r), denied);   // no code
r = await callbackWith('?error=access_denied&code=abc');                        assert.equal(loc(r), denied);   // provider/Supabase error
r = await callbackWith('?code=' + 'a'.repeat(600));                             assert.equal(loc(r), denied);   // absurd code
tokenReply = null; r = await callbackWith('?code=abc');                         assert.equal(loc(r), denied); noSession(r);  // exchange fails (wrong/replayed code or verifier)

// open redirects: nothing in the request can change where we send the user
tokenReply = tokens(user(true));
r = await callbackWith('?code=abc&next=https://evil.example&redirect_to=//evil.example&return_to=/\\evil.example');
assert.equal(loc(r), SITE + '/app');
for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
  r = await callbackWith('?code=abc&next=' + encodeURIComponent(bad) + '&redirect=' + encodeURIComponent(bad));
  assert.equal(new URL(loc(r)).origin, SITE);
}

// ===== 3. approval: Google sign-in alone is not enough
calls = []; tokenReply = tokens(user(false));                                   // signed in with Google but not approved (e.g. self sign-up)
r = await callbackWith('?code=abc');
assert.equal(loc(r), SITE + '/login?e=notapproved'); noSession(r);
assert.ok(calls.some(c => c.url.includes('/auth/v1/logout') && c.auth === 'Bearer at-1'), 'unapproved session must be revoked at Supabase');
tokenReply = tokens({ ...user(true), app_metadata: { approved: 'true' } });     // truthy string is not "approved"
assert.equal(loc(await callbackWith('?code=abc')), SITE + '/login?e=notapproved');
tokenReply = tokens({ ...user(false), user_metadata: { approved: true } });     // user_metadata is user-editable: must be ignored
assert.equal(loc(await callbackWith('?code=abc')), SITE + '/login?e=notapproved');

// ===== 4. happy path: exchange uses the cookie's verifier; cookies are HttpOnly; refresh token is path-scoped
calls = []; tokenReply = tokens(user(true));
r = await callbackWith('?code=the-code');
assert.equal(loc(r), SITE + '/app');
const ex = calls.find(c => c.url.includes('grant_type=pkce'));
assert.deepEqual(ex.body, { auth_code: 'the-code', code_verifier: VERIFIER });
const sess = setCookies(r).find(x => x.startsWith('ppcb_session=')), rt = setCookies(r).find(x => x.startsWith('ppcb_rt='));
assert.ok(/HttpOnly/.test(sess) && /Secure/.test(sess) && /SameSite=Lax/.test(sess) && /Max-Age=900/.test(sess));
assert.ok(/HttpOnly/.test(rt) && /Path=\/api\/auth/.test(rt) && /Max-Age=604800/.test(rt));
assert.equal(cookieVal(r, 'ppcb_rt'), 'rt-NEW');
assert.ok(setCookies(r).some(x => x.startsWith('ppcb_pkce=') && /Max-Age=0/.test(x)), 'verifier is single-use');
assert.ok(!sess.includes('at-1') && !JSON.stringify(setCookies(r)).includes('google'), 'no tokens or Google data in cookies');
const goodCookie = 'ppcb_session=' + encodeURIComponent(cookieVal(r, 'ppcb_session'));

// ===== 5. the page gate
const gate = (cookie, path = '/app') => middleware(req(path, { cookie }));
const passes = res => res.headers.get('x-middleware-next') === '1';
assert.ok(passes(await gate(goodCookie)), 'valid Google session passes');
assert.ok(passes(await gate('ppcb_session=' + encodeURIComponent(await signSession({ user: 'legacyuser', exp: Date.now() + 1e5 }, process.env.AUTH_SECRET)))), 'legacy password session still passes');
assert.equal(loc(await gate('ppcb_session=' + encodeURIComponent(await signSession({ user: 'removed', exp: Date.now() + 1e5 }, process.env.AUTH_SECRET)))), SITE + '/api/auth/refresh', 'legacy user no longer on the list is rejected');
const expired = 'ppcb_session=' + encodeURIComponent(await signSession({ user: 'jo@example.com', src: 'sb', exp: Date.now() - 1 }, process.env.AUTH_SECRET));
assert.equal(loc(await gate(expired)), SITE + '/api/auth/refresh');             // try a renewal
assert.equal(loc(await gate(expired, '/app?r=1')), SITE + '/login');             // already tried: no loop
assert.equal(loc(await gate('')), SITE + '/api/auth/refresh');
const forged = 'ppcb_session=' + encodeURIComponent(await signSession({ user: 'admin', src: 'sb', exp: Date.now() + 1e6 }, 'some-other-secret-value'));
assert.equal(loc(await gate(forged, '/app?r=1')), SITE + '/login', 'cookie signed with another secret is rejected');
const tampered = goodCookie.replace(/.$/, c => (c === 'A' ? 'B' : 'A'));
assert.equal(loc(await gate(tampered, '/app?r=1')), SITE + '/login', 'tampered signature is rejected');
assert.equal(loc(await middleware(new Request(SITE + '/app', { method: 'POST' }))), SITE + '/login');   // non-GET never bounces through refresh

// ===== 6. refresh: rotates the token, re-checks approval
calls = []; tokenReply = tokens(user(true));
r = await refresh(req('/api/auth/refresh', { cookie: 'ppcb_rt=rt-OLD' }));
assert.equal(loc(r), SITE + '/app?r=1');
assert.deepEqual(calls.find(c => c.url.includes('refresh_token')).body, { refresh_token: 'rt-OLD' });
assert.equal(cookieVal(r, 'ppcb_rt'), 'rt-NEW');                                // rotated
assert.equal(loc(await refresh(req('/api/auth/refresh'))), SITE + '/login');    // no refresh token
tokenReply = null; r = await refresh(req('/api/auth/refresh', { cookie: 'ppcb_rt=stolen-old' }));   // replayed/revoked token
assert.equal(loc(r), SITE + '/login'); assert.ok(setCookies(r).every(x => /Max-Age=0/.test(x)), 'failed refresh clears everything');
calls = []; tokenReply = tokens(user(false));                                   // approval removed in Supabase -> locked out at next renewal
r = await refresh(req('/api/auth/refresh', { cookie: 'ppcb_rt=rt-OLD' }));
assert.equal(loc(r), SITE + '/login'); assert.ok(calls.some(c => c.url.includes('/auth/v1/logout')));

// ===== 7. /api/me and logout
const meOf = async cookie => (await (await me(req('/api/me', { cookie }))).json()).authed;
assert.equal(await meOf(goodCookie), true); assert.equal(await meOf(''), false); assert.equal(await meOf(forged), false);
calls = []; tokenReply = tokens(user(true));
r = await logout(req('/api/auth/logout', { method: 'POST', cookie: 'ppcb_rt=rt-OLD' }));
assert.equal(r.status, 200); assert.ok(setCookies(r).length === 3 && setCookies(r).every(x => /Max-Age=0/.test(x)));
assert.ok(calls.some(c => c.url.includes('/auth/v1/logout')), 'logout revokes at Supabase');
assert.equal((await logout(req('/api/auth/logout'))).status, 405);

// ===== 8. misconfiguration fails closed
const saved = process.env.SUPABASE_URL;
for (const bad of ['', 'http://abcdefghij0123456789.supabase.co', 'https://evil.example', `https://${REF}.supabase.co.evil.example`]) {
  process.env.SUPABASE_URL = bad;
  assert.equal(loc(await google(req('/api/auth/google'))), SITE + '/login?e=unavailable', 'bad SUPABASE_URL: ' + bad);
  assert.equal(loc(await callbackWith('?code=abc')), SITE + '/login?e=unavailable');
}
process.env.SUPABASE_URL = saved;

console.log('auth: all checks pass');
