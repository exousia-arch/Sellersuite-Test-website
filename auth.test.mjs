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
const passes = res => !!res.headers.get('x-middleware-rewrite');   // /app is served by rewriting to the plan's page
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
const meJson = async cookie => (await me(req('/api/me', { cookie }))).json();
const meOf = async cookie => (await meJson(cookie)).authed;
assert.equal(await meOf(goodCookie), true); assert.equal(await meOf(''), false); assert.equal(await meOf(forged), false);
// who is signed in: shown to the owner of the session only, nothing else leaks (no uid, no tokens, no exp)
assert.deepEqual(await meJson(goodCookie), { authed: true, user: 'jo@example.com', via: 'google', tier: 'free', tools: ['ngram'] });   // no tier set = Free
assert.deepEqual(await meJson(''), { authed: false });                 // anonymous learns nothing
assert.deepEqual(await meJson(forged), { authed: false });             // forged cookie learns nothing
assert.deepEqual(await meJson(tampered), { authed: false });
const legacyCookie = 'ppcb_session=' + encodeURIComponent(await signSession({ user: 'legacyuser', exp: Date.now() + 1e5 }, process.env.AUTH_SECRET));
assert.deepEqual(await meJson(legacyCookie), { authed: true, user: 'legacyuser', via: 'password', tier: 'pro', tools: ['ngram', 'harvester', 'negator', 'builder', 'dayparting', 'sqp'] });
assert.equal((await me(req('/api/me', { cookie: goodCookie }))).headers.get('cache-control'), 'no-store');
calls = []; tokenReply = tokens(user(true));
r = await logout(req('/api/auth/logout', { method: 'POST', cookie: 'ppcb_rt=rt-OLD' }));
assert.equal(r.status, 200); assert.ok(setCookies(r).length === 4 && setCookies(r).every(x => /Max-Age=0/.test(x)));
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

// ===== 9. plans (free < core < pro): the tier comes only from the server-set app_metadata and picks the page
const withTier = tier => tokens({ ...user(true), app_metadata: { approved: true, provider: 'google', tier } });
const cookieFor = async tr => { tokenReply = tr; const x = await callbackWith('?code=abc'); return 'ppcb_session=' + encodeURIComponent(cookieVal(x, 'ppcb_session')); };
const target = res => (res.headers.get('x-middleware-rewrite') || '').replace(SITE, '');
const kind = res => res.headers.get('x-middleware-next') === '1' ? 'next' : res.headers.get('x-middleware-rewrite') ? 'rewrite' : res.status;
const C = {};
for (const t of ['free', 'core', 'pro']) C[t] = await cookieFor(withTier(t));
C.none = await cookieFor(tokens(user(true)));                                                                // approved, no tier set
C.junk = await cookieFor(withTier('admin'));
C.upper = await cookieFor(withTier('PRO'));
C.proto = await cookieFor(withTier('__proto__'));
C.userMeta = await cookieFor(tokens({ ...user(true), user_metadata: { tier: 'pro' } }));                  // user-editable: ignored
C.legacy = 'ppcb_session=' + encodeURIComponent(await signSession({ user: 'legacyuser', exp: Date.now() + 1e5 }, process.env.AUTH_SECRET));

// /app serves the page built for the plan; no tier, junk or a user-edited tier means Free
for (const [k, want] of Object.entries({ free: 'free', core: 'core', pro: 'pro', none: 'free', junk: 'free', upper: 'free', proto: 'free', userMeta: 'free', legacy: 'pro' })) {
  const res = await gate(C[k]); assert.equal(target(res), `/gated/app.${want}.htm`, `${k} -> ${want}`);
  assert.equal(res.headers.get('cache-control'), 'private, no-store', 'never cached across users');
}
// an unapproved user gets no session whatever tier is on the record
tokenReply = tokens({ ...user(false), app_metadata: { provider: 'google', tier: 'pro' } });
r = await callbackWith('?code=abc'); noSession(r); assert.equal(loc(r), SITE + '/login?e=notapproved');
// the tier is signed: editing the cookie (free -> pro) or signing it with another secret gets nothing
const [pl] = decodeURIComponent(C.free.split('=')[1]).split('.'), forgedPayload = Buffer.from(pl.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString().replace('"tier":"free"', '"tier":"pro"');
assert.ok(forgedPayload.includes('"tier":"pro"'), 'sanity: payload edited');
const editedCookie = 'ppcb_session=' + encodeURIComponent(b64url(new TextEncoder().encode(forgedPayload)) + '.' + decodeURIComponent(C.free.split('=')[1]).split('.')[1]);
assert.equal(loc(await gate(editedCookie, '/app?r=1')), SITE + '/login', 'edited tier is rejected');
const otherSecret = 'ppcb_session=' + encodeURIComponent(await signSession({ user: 'x@y.z', src: 'sb', tier: 'pro', exp: Date.now() + 1e5 }, 'another-secret-value-here'));
assert.equal(loc(await gate(otherSecret, '/app?r=1')), SITE + '/login', 'wrong-secret tier is rejected');
// a Google session from before plans existed has no tier: renewed once, never granted anything
const preTier = 'ppcb_session=' + encodeURIComponent(await signSession({ user: 'jo@example.com', src: 'sb', exp: Date.now() + 1e5 }, process.env.AUTH_SECRET));
assert.equal(loc(await gate(preTier)), SITE + '/api/auth/refresh'); assert.equal(loc(await gate(preTier, '/app?r=1')), SITE + '/login');
assert.equal((await gate(preTier, '/gated/tools/sqp.js')).status, 401);

// /gated/*: each file needs its own plan
const at = (cookie, path) => gate(cookie, path);
assert.equal(kind(await at(C.core, '/gated/app.core.htm')), 'next'); assert.equal(kind(await at(C.core, '/gated/app.free.htm')), 'next');
assert.equal(kind(await at(C.core, '/gated/app.pro.htm')), 403); assert.equal(kind(await at(C.free, '/gated/app.core.htm')), 403);
assert.equal(kind(await at(C.pro, '/gated/app.pro.htm')), 'next');
assert.equal(kind(await at(C.core, '/gated/tools/sqp.js')), 403); assert.equal(kind(await at(C.core, '/gated/tools/dayparting.js')), 403);
assert.equal(kind(await at(C.free, '/gated/tools/sqp.js')), 403); assert.equal(kind(await at(C.pro, '/gated/tools/sqp.js')), 'next');
assert.equal(kind(await at(C.legacy, '/gated/tools/dayparting.js')), 'next');
assert.equal(kind(await at('', '/gated/tools/sqp.js')), 401); assert.equal(kind(await at('', '/gated/app.free.htm')), 401);   // anonymous: refused, not redirected
assert.equal(kind(await at(C.pro, '/gated/tools/nothing.js')), 404); assert.equal(kind(await at(C.pro, '/gated/app.root.htm')), 404);
assert.equal(kind(await at(C.pro, '/gated/app.pro.htm/')), 404); assert.equal(kind(await at(C.pro, '/gated/secret.txt')), 404);
assert.equal(kind(await at(C.pro, '/gated/tools/sqp.js.map')), 404);
// path tricks resolve to a real file (and its plan) or to nothing, never around the check
assert.equal(kind(await at(C.core, '/gated/tools/../app.pro.htm')), 403);
assert.equal(kind(await at(C.core, '/gated/tools/%2e%2e/app.pro.htm')), 403);
assert.equal(kind(await at(C.core, '/gated/tools/sqp.js%00.js')), 404);
assert.equal(kind(await at(C.core, '/gated//tools/sqp.js')), 404);
assert.equal(kind(await at(C.core, '/gated/TOOLS/sqp.js')), 404);
// nothing in the request can pick the page: a Core user asking for ?tier=pro, a header or a referer still gets Core
for (const q of ['/app?tier=pro', '/app?r=1&tier=pro&plan=pro', '/app.html?tier=pro', '/app/x?tier=pro']) assert.equal(target(await gate(C.core, q)), '/gated/app.core.htm', q);
assert.equal(target(await middleware(new Request(SITE + '/app', { headers: { cookie: C.core, 'x-tier': 'pro', 'x-forwarded-tier': 'pro', referer: SITE + '/gated/app.pro.htm' } }))), '/gated/app.core.htm');
// a tool name we do not have is not served (no plan is "undefined = free")
assert.equal(kind(await at(C.free, '/gated/tools/hax.js')), 404); assert.equal(kind(await at(C.pro, '/gated/tools/constructor.js')), 404); assert.equal(kind(await at(C.pro, '/gated/tools/__proto__.js')), 404);
// non-GET to /app never bounces through refresh
assert.equal(loc(await middleware(new Request(SITE + '/app', { method: 'POST' }))), SITE + '/login');
// the page tells the browser its plan: /api/me
assert.deepEqual(await meJson(C.core), { authed: true, user: 'jo@example.com', via: 'google', tier: 'core', tools: ['ngram', 'harvester', 'negator'] });
assert.equal((await meJson(C.pro)).tools.length, 6); assert.deepEqual((await meJson(C.free)).tools, ['ngram']); assert.equal((await meJson(C.legacy)).tier, 'pro');
assert.deepEqual(await meJson(''), { authed: false });
// a refresh picks up a plan change within the renewal window (promotion and demotion)
tokenReply = withTier('pro'); r = await refresh(req('/api/auth/refresh', { cookie: 'ppcb_rt=rt-OLD' }));
assert.equal(target(await gate('ppcb_session=' + encodeURIComponent(cookieVal(r, 'ppcb_session')))), '/gated/app.pro.htm');
tokenReply = withTier('free'); r = await refresh(req('/api/auth/refresh', { cookie: 'ppcb_rt=rt-OLD' }));
assert.equal(target(await gate('ppcb_session=' + encodeURIComponent(cookieVal(r, 'ppcb_session')))), '/gated/app.free.htm');

console.log('auth: all checks pass');
