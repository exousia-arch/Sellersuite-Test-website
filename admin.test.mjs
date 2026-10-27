// node admin.test.mjs — checks for the admin endpoints and the invitation email. Supabase and Resend are fake fetches.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
globalThis.crypto ??= webcrypto;
import admin from './api/admin/[op].js';
import { buildInvite } from './api/_invite.js';
import { signSession, SITE } from './api/_auth.js';

process.env.SUPABASE_URL = 'https://abcdefghij0123456789.supabase.co'; process.env.SUPABASE_ANON_KEY = 'anon-key-for-tests-only-0000';
process.env.AUTH_SECRET = 'test-secret-that-is-long-enough'; process.env.PPCBENCH_USERS = 'legacyuser:pw';
const SERVICE = 'service-role-key-for-tests-only-123456', RESEND = 're_test_key_123456';
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE; process.env.ADMIN_EMAILS = 'Boss@Example.com, other@example.com';
process.env.RESEND_API_KEY = RESEND; process.env.INVITE_FROM = 'PPCBench <hello@ppcbench.com>';

const ME = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222';
let users, calls = [], resendOk = true;
const fresh = () => { users = [{ id: ME, email: 'boss@example.com', created_at: '2026-01-01', app_metadata: { approved: true, tier: 'pro', provider: 'google' } }, { id: U2, email: 'jo@example.com', created_at: '2026-02-01', last_sign_in_at: '2026-03-01', app_metadata: { approved: true, tier: 'core', provider: 'google' } }]; calls = []; };
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const body = init.body ? JSON.parse(init.body) : null; calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body });
  if (url.startsWith('https://api.resend.com/')) return new Response(resendOk ? '{"id":"x"}' : '{}', { status: resendOk ? 200 : 422 });
  const m = url.match(/\/auth\/v1\/admin\/users(?:\/([^?]+))?/); if (!m) return new Response('{}', { status: 404 });
  if (!m[1] && (init.method || 'GET') === 'GET') return new Response(JSON.stringify({ users }), { status: 200 });
  if (!m[1] && init.method === 'POST') { const u = { id: '33333333-3333-4333-8333-333333333333', email: body.email, app_metadata: body.app_metadata }; users.push(u); return new Response(JSON.stringify(u), { status: 200 }); }
  const u = users.find(x => x.id === m[1]); if (!u) return new Response('{}', { status: 404 });
  if (init.method === 'PUT') { u.app_metadata = body.app_metadata; return new Response(JSON.stringify(u), { status: 200 }); }
  return new Response(JSON.stringify(u), { status: 200 });
};
const sess = async (user, extra = {}) => 'ppcb_session=' + encodeURIComponent(await signSession({ user, uid: ME, src: 'sb', tier: 'pro', exp: Date.now() + 1e5, ...extra }, process.env.AUTH_SECRET));
const call = (op, body, cookie, { origin = SITE, method = 'POST' } = {}) => admin(new Request(`${SITE}/api/admin/${op}`, { method, headers: { cookie, origin, 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined }));
const ADMIN = await sess('boss@example.com');
fresh();

// ---- only the admin gets in (nothing reaches Supabase otherwise)
assert.equal((await call('users', {}, '')).status, 401);
assert.equal((await call('users', {}, await sess('jo@example.com'))).status, 403, 'a signed-in non-admin');
assert.ok([401, 403].includes((await call('users', {}, 'ppcb_session=' + encodeURIComponent(await signSession({ user: 'boss@example.com', exp: Date.now() + 1e5 }, process.env.AUTH_SECRET)))).status), 'legacy password session is never an admin');
assert.equal((await call('users', {}, ADMIN, { origin: 'https://evil.example' })).status, 403);
assert.equal((await call('users', {}, ADMIN, { method: 'GET' })).status, 405);
assert.equal((await call('users', {}, 'ppcb_session=' + encodeURIComponent(await signSession({ user: 'boss@example.com', uid: ME, src: 'sb', tier: 'pro', exp: Date.now() - 1 }, process.env.AUTH_SECRET)))).status, 401, 'expired session');
process.env.ADMIN_EMAILS = ''; assert.equal((await call('users', {}, ADMIN)).status, 403, 'nobody is admin when ADMIN_EMAILS is empty'); process.env.ADMIN_EMAILS = 'Boss@Example.com, other@example.com';
process.env.SUPABASE_SERVICE_ROLE_KEY = ''; assert.equal((await call('users', {}, ADMIN)).status, 503); process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
assert.equal((await call('nothing', {}, ADMIN)).status, 404); assert.equal((await call('constructor', {}, ADMIN)).status, 404);
assert.equal(calls.length, 0, 'none of the refused requests touched Supabase');

// ---- list
let r = await call('users', {}, ADMIN), j = await r.json();
assert.equal(r.status, 200); assert.equal(j.me, 'boss@example.com'); assert.equal(j.users.length, 2);
assert.deepEqual(j.users.find(u => u.email === 'jo@example.com'), { id: U2, email: 'jo@example.com', approved: true, tier: 'core', last_sign_in: '2026-03-01', created: '2026-02-01' });
assert.ok(!JSON.stringify(j).includes(SERVICE) && !JSON.stringify(j).includes('provider'), 'no key and no raw metadata in responses');
assert.equal(calls[0].headers.Authorization, 'Bearer ' + SERVICE);

// ---- invitation email
const mail = buildInvite({ name: 'Jo <b>x</b>', email: 'jo@example.com', tier: 'core', note: 'Welcome!\n<script>alert(1)</script>' });
assert.equal(mail.subject, 'Your PPCBench access is ready');
assert.ok(mail.text.includes('Your plan: Core.') && mail.text.includes('https://www.ppcbench.com/login') && mail.text.includes('jo@example.com'));
assert.ok(mail.text.includes('Search Term Harvester') && !mail.text.includes('SQP Tracker'), 'lists the tools of the plan only');
assert.ok(!mail.html.includes('<script>') && !mail.html.includes('<b>x</b>') && mail.html.includes('&lt;script&gt;'), 'html is escaped');
assert.ok(!mail.text.includes('SQP Tracker you can choose') && buildInvite({ email: 'a@b.co', tier: 'pro' }).text.includes('SQP Tracker you can choose'), 'the saved-history sentence is Pro only');
assert.ok(!/\n\s*\n\s*\n/.test(buildInvite({ name: '', email: 'a@b.co', tier: 'free' }).text), 'no empty gaps without a note');
assert.throws(() => buildInvite({ email: 'a@b.co', tier: 'admin' }), /bad tier/);
assert.ok(buildInvite({ name: 'A\r\nBcc: x@y.z', email: 'a@b.co', tier: 'free' }).text.split('\n')[0] === 'Hi A Bcc: x@y.z,', 'a name cannot add lines');

// ---- preview sends nothing
fresh(); r = await call('preview', { email: 'new@example.com', name: 'New', tier: 'pro', note: 'Hi there' }, ADMIN); j = await r.json();
assert.equal(r.status, 200); assert.ok(j.text.includes('Hi there') && j.text.includes('Pro')); assert.equal(calls.length, 0);

// ---- invite: new person (account created approved, email sent)
fresh(); r = await call('invite', { email: ' New@Example.com ', name: 'New', tier: 'core', note: 'x', send: true }, ADMIN); j = await r.json();
assert.deepEqual(j, { created: true, tier: 'core', emailed: true, email_error: null });
const mk = calls.find(c => c.method === 'POST' && c.url.endsWith('/admin/users'));
assert.deepEqual(mk.body, { email: 'new@example.com', email_confirm: true, app_metadata: { approved: true, tier: 'core' } });
const em = calls.find(c => c.url.startsWith('https://api.resend.com/'));
assert.equal(em.headers.Authorization, 'Bearer ' + RESEND); assert.deepEqual(em.body.to, ['new@example.com']); assert.equal(em.body.from, 'PPCBench <hello@ppcbench.com>');
assert.ok(!JSON.stringify(em).includes(SERVICE), 'the service key never goes to the email provider');
// without sending, or when the email fails, the account is still approved and the reason is reported
fresh(); j = await (await call('invite', { email: 'n2@example.com', tier: 'free', send: false }, ADMIN)).json(); assert.equal(j.emailed, false); assert.ok(!calls.some(c => c.url.startsWith('https://api.resend.com/')));
fresh(); resendOk = false; j = await (await call('invite', { email: 'n3@example.com', tier: 'free', send: true }, ADMIN)).json(); assert.deepEqual([j.created, j.emailed, j.email_error], [true, false, 'email_rejected']); resendOk = true;
fresh(); const k = process.env.RESEND_API_KEY; process.env.RESEND_API_KEY = ''; j = await (await call('invite', { email: 'n4@example.com', tier: 'free', send: true }, ADMIN)).json(); assert.equal(j.email_error, 'email_not_configured'); process.env.RESEND_API_KEY = k;
// existing account: plan changes, other metadata is kept
fresh(); j = await (await call('invite', { email: 'JO@example.com', tier: 'pro', send: false }, ADMIN)).json();
assert.equal(j.created, false); assert.deepEqual(users[1].app_metadata, { approved: true, tier: 'pro', provider: 'google' });
// bad input
fresh();
for (const body of [{ email: 'nope', tier: 'pro' }, { email: 'a@b.co', tier: 'admin' }, { email: 'a@b.co' }, { email: 'a@b.co', tier: '__proto__' }, { email: 'a b@c.de', tier: 'core' }]) assert.equal((await call('invite', body, ADMIN)).status, 400, JSON.stringify(body));
assert.equal(calls.length, 0);

// ---- set: change plan / switch off, never yourself
fresh(); j = await (await call('set', { id: U2, tier: 'pro' }, ADMIN)).json(); assert.equal(j.user.tier, 'pro'); assert.equal(users[1].app_metadata.approved, true);
j = await (await call('set', { id: U2, approved: false }, ADMIN)).json(); assert.equal(j.user.approved, false); assert.equal(users[1].app_metadata.tier, 'pro'); assert.equal(users[1].app_metadata.provider, 'google');
fresh(); assert.equal((await call('set', { id: ME, approved: false }, ADMIN)).status, 400); assert.equal((await call('set', { id: ME, tier: 'free' }, ADMIN)).status, 400);
for (const body of [{ id: 'x', tier: 'pro' }, { id: U2 }, { id: U2, tier: 'root' }, { id: U2, approved: 'yes' }]) assert.equal((await call('set', body, ADMIN)).status, 400, JSON.stringify(body));
assert.equal((await call('set', { id: '44444444-4444-4444-8444-444444444444', tier: 'pro' }, ADMIN)).status, 404);
assert.equal((await call('invite', { email: 'a@b.co', tier: 'pro', note: 'x'.repeat(9000) }, ADMIN)).status, 413);

// ---- the service key is read in ONE file only
const walk = d => readdirSync(d).flatMap(f => (['node_modules', '.git', 'SQP Tracker', 'Security Videos'].includes(f) ? [] : statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const users_of_key = walk('.').filter(f => /\.(js|mjs|cjs|html|htm|json|md)$/.test(f) && !f.endsWith('admin.test.mjs') && !f.startsWith('docs') && readFileSync(f, 'utf8').includes('SERVICE_ROLE'));
assert.deepEqual(users_of_key.map(f => f.split('\\').join('/')), ['api/_admin.js'], 'only api/_admin.js reads the service-role key (found: ' + users_of_key + ')');
console.log('admin: all checks pass');
