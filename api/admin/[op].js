// POST /api/admin/<op> ← the admin page (/admin). Approves people, sets plans, sends the invitation email.
// Everything passes requireAdmin() first (signed-in admin from ADMIN_EMAILS, same-origin POST).
//   users   -> list of accounts
//   preview {name,email,tier,note}            -> the email exactly as it would be sent
//   invite  {email,name,tier,note,send}       -> create (or update) the account as approved on a plan; optionally email them
//   set     {id,tier?,approved?}              -> change a plan or switch someone off/on (never your own account)
import { requireAdmin, adminFetch } from '../_admin.js';
import { isTier } from '../_tiers.js';
import { buildInvite, sendInvite } from '../_invite.js';
export const config = { runtime: 'edge' };

const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,120}\.[^@\s]{2,24}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
const view = u => ({ id: u.id, email: u.email, approved: !!(u.app_metadata && u.app_metadata.approved === true), tier: isTier(u.app_metadata && u.app_metadata.tier) ? u.app_metadata.tier : 'free', last_sign_in: u.last_sign_in_at || null, created: u.created_at || null });
const OPS = ['users', 'preview', 'invite', 'set'];

async function listUsers(c) {
  const r = await adminFetch(c, 'users?per_page=200');
  return r.status === 200 && r.body && Array.isArray(r.body.users) ? r.body.users : null;
}

export default async function handler(request) {
  const op = new URL(request.url).pathname.split('/').pop();
  const a = await requireAdmin(request);
  if (!a.ok) return json(a.status, { error: a.status === 401 ? 'signin' : a.status === 403 ? 'forbidden' : a.status === 503 ? 'not_configured' : 'method' });
  if (!OPS.includes(op)) return json(404, { error: 'unknown' });
  const raw = await request.text();
  if (raw.length > 8000) return json(413, { error: 'too_large' });
  let b = {}; try { b = raw ? JSON.parse(raw) : {}; } catch (e) { return json(400, { error: 'invalid' }); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return json(400, { error: 'invalid' });
  const c = a.c;

  if (op === 'users') {
    const us = await listUsers(c); if (!us) return json(502, { error: 'unavailable' });
    return json(200, { me: a.admin.email, users: us.map(view).sort((x, y) => (x.created < y.created ? 1 : -1)) });
  }

  if (op === 'preview' || op === 'invite') {
    const email = String(b.email || '').trim().toLowerCase();
    if (!EMAIL.test(email) || !isTier(b.tier)) return json(400, { error: 'invalid' });
    const mail = buildInvite({ name: b.name, email, tier: b.tier, note: b.note });
    if (op === 'preview') return json(200, { subject: mail.subject, text: mail.text });

    const us = await listUsers(c); if (!us) return json(502, { error: 'unavailable' });
    const found = us.find(u => String(u.email).toLowerCase() === email);
    let created = false;
    if (found) {                                  // existing account: keep its other app_metadata, set approval and plan
      const r = await adminFetch(c, 'users/' + found.id, { method: 'PUT', body: JSON.stringify({ app_metadata: Object.assign({}, found.app_metadata, { approved: true, tier: b.tier }) }) });
      if (r.status !== 200) return json(502, { error: 'unavailable' });
    } else {                                      // no account yet: create it approved, so their first Google sign-in with this address just works
      const r = await adminFetch(c, 'users', { method: 'POST', body: JSON.stringify({ email, email_confirm: true, app_metadata: { approved: true, tier: b.tier } }) });
      if (r.status !== 200 && r.status !== 201) return json(502, { error: 'unavailable' });
      created = true;
    }
    const sent = b.send === true ? await sendInvite(email, mail) : null;
    return json(200, { created, tier: b.tier, emailed: !!(sent && sent.ok), email_error: sent && !sent.ok ? sent.error : null });
  }

  // op === 'set'
  if (!UUID.test(String(b.id || ''))) return json(400, { error: 'invalid' });
  if (b.id === a.admin.uid) return json(400, { error: 'not_yourself' });       // no locking yourself out
  if (b.tier !== undefined && !isTier(b.tier)) return json(400, { error: 'invalid' });
  if (b.approved !== undefined && typeof b.approved !== 'boolean') return json(400, { error: 'invalid' });
  if (b.tier === undefined && b.approved === undefined) return json(400, { error: 'invalid' });
  const cur = await adminFetch(c, 'users/' + b.id);
  if (cur.status !== 200 || !cur.body) return json(404, { error: 'not_found' });
  const meta = Object.assign({}, cur.body.app_metadata);
  if (b.tier !== undefined) meta.tier = b.tier;
  if (b.approved !== undefined) meta.approved = b.approved;
  const r = await adminFetch(c, 'users/' + b.id, { method: 'PUT', body: JSON.stringify({ app_metadata: meta }) });
  if (r.status !== 200) return json(502, { error: 'unavailable' });
  return json(200, { user: view(Object.assign({}, cur.body, { app_metadata: meta })) });
}
