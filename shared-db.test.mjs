// node shared-db.test.mjs — a shared tester username (password login) backed by ONE Supabase account, so everyone using it
// sees the same saved SQP history. Supabase is a fake fetch.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
import login from './api/login.js';
import logout from './api/logout.js';
import renew from './api/auth/renew.js';
import sqp from './api/sqp/[op].js';
import me from './api/me.js';
import { signSession, readSession, b64url, SITE } from './api/_auth.js';

process.env.SUPABASE_URL = 'https://abcdefghij0123456789.supabase.co'; process.env.SUPABASE_ANON_KEY = 'anon-key-for-tests-only-0000';
process.env.AUTH_SECRET = 'test-secret-that-is-long-enough';
process.env.PPCBENCH_USERS = 'phicoventures:team-pass,plain:other-pass';
process.env.PPCBENCH_SHARED_DB = JSON.stringify({ phicoventures: { email: 'shared@example.com', password: 'db-pass-123' } });
const SHARED_UID = '55555555-5555-4555-8555-555555555555';
const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
const jwt = sub => `${enc({ alg: 'none' })}.${enc({ sub })}.sig`;
let calls = [], sbReply;
const ok = (uid = SHARED_UID, extra = {}) => ({ access_token: jwt(uid), refresh_token: 'rt-1', user: { id: uid, email: 'shared@example.com', app_metadata: { approved: true, tier: 'pro', ...extra } } });
globalThis.fetch = async (url, init = {}) => {
  url = String(url); calls.push({ url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers || {} });
  if (url.includes('/auth/v1/token')) return sbReply ? new Response(JSON.stringify(sbReply), { status: 200 }) : new Response('{}', { status: 400 });
  if (url.includes('/rest/v1/rpc/')) return new Response('{"ok":1}', { status: 200 });
  return new Response(null, { status: 204 });
};
const sc = res => res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.get('set-cookie') || '').split(/,\s(?=[A-Za-z_]+=)/).filter(Boolean);
const val = (res, n) => { const c = sc(res).find(x => x.startsWith(n + '=')); return c ? decodeURIComponent(c.split(';')[0].slice(n.length + 1)) : null; };
const doLogin = (u, p) => login(new Request(SITE + '/api/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) }));
const jar = res => sc(res).map(c => c.split(';')[0]).join('; ');

// ---- login for the shared username: same password check as before, plus the database account
sbReply = ok(); calls = [];
let r = await doLogin('PhicoVentures', 'team-pass');
assert.equal(r.status, 200);
const tokenCall = calls.find(c => c.url.includes('grant_type=password'));
assert.deepEqual(tokenCall.body, { email: 'shared@example.com', password: 'db-pass-123' });
const payload = await readSession(val(r, 'ppcb_session'), process.env.AUTH_SECRET);
assert.deepEqual([payload.user, payload.db, payload.uid], ['phicoventures', 1, SHARED_UID]);
assert.ok(!JSON.stringify(payload).includes('db-pass') && !val(r, 'ppcb_session').includes('rt-1'), 'no password or token inside the session cookie');
const at = sc(r).find(x => x.startsWith('ppcb_at=')), rtc = sc(r).find(x => x.startsWith('ppcb_rt='));
assert.ok(/HttpOnly/.test(at) && /Path=\/api\/sqp/.test(at) && /HttpOnly/.test(rtc) && /Path=\/api\/auth/.test(rtc));
assert.ok(!JSON.stringify(await r.json()).includes('db-pass'), 'the response body never contains the database password');
const JAR = jar(r);

// ---- wrong password: nothing is sent to Supabase
calls = []; r = await doLogin('phicoventures', 'wrong'); assert.equal(r.status, 401); assert.equal(calls.length, 0); assert.equal(sc(r).length, 0);
// ---- a username that is not shared: plain legacy session, Supabase not called
calls = []; r = await doLogin('plain', 'other-pass'); assert.equal(r.status, 200); assert.equal(calls.length, 0);
const plain = await readSession(val(r, 'ppcb_session'), process.env.AUTH_SECRET); assert.equal(plain.db, undefined); assert.equal(plain.uid, undefined);
// ---- database down or account not approved: they still get in, just without history
sbReply = null; r = await doLogin('phicoventures', 'team-pass'); assert.equal(r.status, 200); assert.equal(sc(r).length, 1);
sbReply = { ...ok(), user: { id: SHARED_UID, email: 'shared@example.com', app_metadata: { tier: 'pro' } } }; r = await doLogin('phicoventures', 'team-pass'); assert.equal(sc(r).length, 1, 'unapproved database account: no database cookies');
// ---- bad JSON in the env var does not break login
const keep = process.env.PPCBENCH_SHARED_DB; process.env.PPCBENCH_SHARED_DB = '{not json'; sbReply = ok(); assert.equal((await doLogin('phicoventures', 'team-pass')).status, 200); process.env.PPCBENCH_SHARED_DB = keep;

// ---- saved history works for the shared login, and only for it
const post = (op, cookie, body = {}) => sqp(new Request(`${SITE}/api/sqp/${op}`, { method: 'POST', headers: { cookie, origin: SITE }, body: JSON.stringify(body) }));
calls = []; r = await post('state', JAR); assert.equal(r.status, 200);
const rpc = calls.find(c => c.url.includes('/rpc/sqp_state')); assert.equal(rpc.headers.Authorization, 'Bearer ' + jwt(SHARED_UID));
const noAt = JAR.split('; ').filter(x => !x.startsWith('ppcb_at=')).join('; ');
assert.equal((await post('state', noAt)).status, 401, 'no access token: asked to renew');
const plainJar = 'ppcb_session=' + encodeURIComponent(await signSession({ user: 'plain', exp: Date.now() + 1e5 }, process.env.AUTH_SECRET)) + `; ppcb_at=${jwt(SHARED_UID)}`;
assert.equal((await post('state', plainJar)).status, 403, 'a password login without a database account is still refused');
const forged = 'ppcb_session=' + encodeURIComponent(await signSession({ user: 'phicoventures', db: 1, uid: SHARED_UID, exp: Date.now() + 1e5 }, 'another-secret-value-here')) + `; ppcb_at=${jwt(SHARED_UID)}`;
assert.equal((await post('state', forged)).status, 401, 'db flag signed with another secret is rejected');
const otherTok = JAR.replace(/ppcb_at=[^;]+/, 'ppcb_at=' + encodeURIComponent(jwt('66666666-6666-4666-8666-666666666666')));
assert.equal((await post('state', otherTok)).status, 401, 'a token of another user is never used with this session');
// removing the username from PPCBENCH_USERS cuts everything, history included
const users = process.env.PPCBENCH_USERS; process.env.PPCBENCH_USERS = 'plain:other-pass'; assert.equal((await post('state', JAR)).status, 401); process.env.PPCBENCH_USERS = users;
// the page still sees a normal Pro password session
const who = await (await me(new Request(SITE + '/api/me', { headers: { cookie: JAR } }))).json(); assert.deepEqual([who.user, who.via, who.tier], ['phicoventures', 'password', 'pro']);

// ---- renew keeps the identity, rotates tokens, and never turns into a Google-style session
const rn = c => renew(new Request(SITE + '/api/auth/renew', { method: 'POST', headers: { cookie: c, origin: SITE } }));
sbReply = { ...ok(), refresh_token: 'rt-2' }; r = await rn(JAR);
assert.equal(r.status, 204); assert.deepEqual(sc(r).map(c => c.split('=')[0]).sort(), ['ppcb_at', 'ppcb_rt']); assert.equal(val(r, 'ppcb_rt'), 'rt-2');
sbReply = ok('77777777-7777-4777-8777-777777777777'); r = await rn(JAR); assert.equal(r.status, 401); assert.ok(sc(r).every(c => /Max-Age=0/.test(c)), 'refresh token of another account clears everything');
// ---- logout clears the database cookies too
r = await logout(); assert.deepEqual(sc(r).map(c => c.split('=')[0]).sort(), ['ppcb_at', 'ppcb_pkce', 'ppcb_rt', 'ppcb_session']); assert.ok(sc(r).every(c => /Max-Age=0/.test(c)));
console.log('shared-db: all checks pass');
