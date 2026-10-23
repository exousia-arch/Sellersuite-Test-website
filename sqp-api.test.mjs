// node sqp-api.test.mjs — checks for /api/sqp/* and /api/auth/renew (saved SQP history). Supabase is a fake fetch.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
import sqp from './api/sqp/[op].js';
import renew from './api/auth/renew.js';
import { signSession, b64url, SITE } from './api/_auth.js';

const REF = 'abcdefghij0123456789';
process.env.SUPABASE_URL = `https://${REF}.supabase.co`; process.env.SUPABASE_ANON_KEY = 'anon-key-for-tests-only-0000';
process.env.AUTH_SECRET = 'test-secret-that-is-long-enough'; process.env.PPCBENCH_USERS = 'legacyuser:pw';
const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
const jwt = sub => `${enc({ alg: 'none' })}.${enc({ sub })}.sig`;
let calls = [], reply = () => new Response('{"ok":1}', { status: 200 }), tokenReply = null;
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
  if (String(url).includes('/auth/v1/token')) return tokenReply ? new Response(JSON.stringify(tokenReply), { status: 200 }) : new Response('{}', { status: 400 });
  if (String(url).includes('/auth/v1/logout')) return new Response(null, { status: 204 });
  return reply();
};
const sess = async (tier, extra = {}) => 'ppcb_session=' + encodeURIComponent(await signSession({ user: 'jo@example.com', uid: 'u-1', src: 'sb', tier, exp: Date.now() + 1e5, ...extra }, process.env.AUTH_SECRET));
const post = (op, body, cookie, { origin = SITE, method = 'POST' } = {}) => sqp(new Request(`${SITE}/api/sqp/${op}`, { method, headers: { cookie, origin, 'content-type': 'application/json' }, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined }));
const AT = `; ppcb_at=${jwt('u-1')}`, PRO = (await sess('pro')) + AT;
const ID = '11111111-1111-4111-8111-111111111111';
const err = async r => (await r.json()).error;

// ---- who may call
assert.equal((await post('state', {}, '')).status, 401);                                         // anonymous: asked to renew
assert.equal(await err(await post('state', {}, await sess('core') + AT)), 'plan');               // core / free: refused before the database
assert.equal((await post('state', {}, await sess('free') + AT)).status, 403);
assert.equal((await post('state', {}, await sess(undefined) + AT)).status, 403);
const legacy = 'ppcb_session=' + encodeURIComponent(await signSession({ user: 'legacyuser', exp: Date.now() + 1e5 }, process.env.AUTH_SECRET));
assert.equal((await post('state', {}, legacy + AT)).status, 403, 'password users have no database account, so no saved history');
assert.equal((await post('state', {}, PRO, { origin: 'https://evil.example' })).status, 403);   // cross-site
assert.equal((await post('state', {}, PRO, { origin: '' })).status, 403);
assert.equal((await post('state', {}, PRO, { method: 'GET' })).status, 405);
assert.equal((await post('state', {}, await sess('pro'))).status, 401, 'no access token cookie: renew');
assert.equal((await post('state', {}, (await sess('pro')) + `; ppcb_at=${jwt('someone-else')}`)).status, 401, 'token of another user is never used');
assert.equal((await post('state', {}, (await sess('pro')) + '; ppcb_at=garbage')).status, 401);
assert.equal(calls.length, 0, 'nothing above reached the database');

// ---- the happy path forwards the USER token (never a service key) to exactly one database function
let r = await post('state', {}, PRO);
assert.equal(r.status, 200); assert.deepEqual(await r.json(), { data: { ok: 1 } });
assert.equal(calls.length, 1); assert.equal(calls[0].url, `https://${REF}.supabase.co/rest/v1/rpc/sqp_state`);
assert.equal(calls[0].headers.Authorization, 'Bearer ' + jwt('u-1')); assert.equal(calls[0].headers.apikey, process.env.SUPABASE_ANON_KEY);
assert.equal(r.headers.get('cache-control'), 'private, no-store');

// ---- bodies are narrowed to the exact arguments of each function
const args = async (op, body) => { calls = []; const res = await post(op, body, PRO); return [res.status, calls[0] && calls[0].body, calls[0] && calls[0].url.split('/').pop()]; };
assert.deepEqual(await args('consent', { version: 1 }), [200, { p_version: 1 }, 'sqp_consent']);
assert.deepEqual(await args('history', { asin_id: ID, cadence: 'weekly', extra: 'x' }), [200, { p_asin: ID, p_cadence: 'weekly' }, 'sqp_history']);
assert.deepEqual(await args('delete', { kind: 'period', id: ID, user_id: 'x' }), [200, { p_kind: 'period', p_id: ID }, 'sqp_delete']);
assert.deepEqual(await args('save', { payload: { brand: 'A' }, user_id: 'x' }), [200, { p: { brand: 'A' } }, 'sqp_save_period']);
assert.deepEqual(await args('export', { junk: 1 }), [200, {}, 'sqp_export']);
assert.deepEqual(await args('delete_all', {}), [200, {}, 'sqp_delete_all']);
for (const [op, body] of [['consent', { version: 2 }], ['consent', {}], ['history', { asin_id: 'x', cadence: 'weekly' }], ['history', { asin_id: ID, cadence: 'daily' }], ['delete', { kind: 'everything', id: ID }], ['delete', { kind: 'brand', id: "1' or 1=1" }], ['save', { payload: [] }], ['save', { payload: 'x' }], ['save', {}]]) {
  calls = []; assert.equal((await post(op, body, PRO)).status, 400, op + JSON.stringify(body)); assert.equal(calls.length, 0);
}
calls = []; assert.equal((await post('save', '{not json', PRO)).status, 400); assert.equal((await post('save', '[1]', PRO)).status, 400);
assert.equal((await post('save', JSON.stringify({ payload: { x: 'y'.repeat(210 * 1024) } }), PRO)).status, 413);
assert.equal((await post('rpc/sqp_state', {}, PRO)).status, 404); assert.equal((await post('constructor', {}, PRO)).status, 404); assert.equal((await post('__proto__', {}, PRO)).status, 404);
assert.equal(calls.length, 0);

// ---- database answers: only our own codes are passed on, nothing else leaks
reply = () => new Response('{"message":"sqp:consent_required"}', { status: 400 });
r = await post('save', { payload: {} }, PRO); assert.equal(r.status, 400); assert.equal(await err(r), 'sqp:consent_required');
reply = () => new Response('{"message":"duplicate key value violates unique constraint secret_table_idx"}', { status: 409 });
r = await post('save', { payload: {} }, PRO); { const t = await r.text(); assert.equal(JSON.parse(t).error, 'failed'); assert.ok(!t.includes('secret_table')); }
reply = () => new Response('{"message":"permission denied"}', { status: 403 }); r = await post('state', {}, PRO); assert.equal(r.status, 403);
reply = () => new Response('{"message":"JWT expired"}', { status: 401 }); r = await post('state', {}, PRO); assert.equal(r.status, 401); assert.equal(await err(r), 'renew');
reply = () => { throw new Error('network'); }; assert.equal((await post('state', {}, PRO)).status, 502);
reply = () => new Response(null, { status: 204 }); r = await post('consent', { version: 1 }, PRO); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { data: null });
reply = () => new Response('{"ok":1}', { status: 200 });
// without configuration it refuses rather than guessing
const keep = process.env.SUPABASE_URL; process.env.SUPABASE_URL = ''; assert.equal((await post('state', {}, PRO)).status, 503); process.env.SUPABASE_URL = keep;

// ---- /api/auth/renew: re-mints the cookies (including the access token) and re-checks approval and plan
const rq = (cookie = 'ppcb_rt=rt-OLD', { origin = SITE, method = 'POST' } = {}) => renew(new Request(SITE + '/api/auth/renew', { method, headers: { cookie, origin } }));
const sc = res => res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.get('set-cookie') || '').split(/,\s(?=[A-Za-z_]+=)/).filter(Boolean);
const u = (tier, approved = true) => ({ access_token: jwt('u-1'), refresh_token: 'rt-NEW', user: { id: 'u-1', email: 'jo@example.com', app_metadata: { approved, tier } } });
assert.equal((await rq(undefined, { method: 'GET' })).status, 405); assert.equal((await rq(undefined, { origin: 'https://evil.example' })).status, 403); assert.equal((await rq('')).status, 401);
tokenReply = u('pro'); r = await rq();
assert.equal(r.status, 204); const cs = sc(r);
assert.deepEqual(cs.map(c => c.split('=')[0]).sort(), ['ppcb_at', 'ppcb_rt', 'ppcb_session']);
const atc = cs.find(c => c.startsWith('ppcb_at='));
assert.ok(/HttpOnly/.test(atc) && /Secure/.test(atc) && /Path=\/api\/sqp/.test(atc) && /Max-Age=900/.test(atc), 'access token cookie is HttpOnly, secure, scoped to /api/sqp');
assert.ok(!/ppcb_session=[^;]*at-/.test(cs.join()), 'the session cookie carries no token');
tokenReply = u('pro', false); r = await rq(); assert.equal(r.status, 401); assert.equal(sc(r).length, 4); assert.ok(sc(r).every(c => /Max-Age=0/.test(c)), 'unapproved: everything cleared');
tokenReply = null; r = await rq(); assert.equal(r.status, 401);
console.log('sqp-api: all checks pass');
