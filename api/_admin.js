// Admin-only helpers. This is the ONLY file that reads SUPABASE_SERVICE_ROLE_KEY (a test fails if any other file does).
// The service-role key bypasses row security, so every path to it goes through requireAdmin():
//  - a valid signed Google session (not the legacy password login),
//  - the signed-in email is in ADMIN_EMAILS (an env var only you can edit),
//  - the request is a same-origin POST.
import { config_, getSession, SITE } from './_auth.js';

export const adminEmails = () => (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// -> { ok:true, admin:{ email, uid }, c } or { ok:false, status }
export async function requireAdmin(request) {
  if (request.method !== 'POST') return { ok: false, status: 405 };
  if (request.headers.get('origin') !== SITE) return { ok: false, status: 403 };
  const c = config_(), key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!c.ok || key.length < 20) return { ok: false, status: 503 };
  const s = await getSession(request, c.secret, '');           // no legacy users here
  if (!s) return { ok: false, status: 401 };
  if (s.src !== 'sb' || !adminEmails().includes(String(s.user).toLowerCase())) return { ok: false, status: 403 };
  return { ok: true, admin: { email: String(s.user).toLowerCase(), uid: s.uid }, c };
}

// Supabase Auth admin API with the service-role key. Returns { status, body }.
export async function adminFetch(c, path, init = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  try {
    const r = await fetch(c.url + '/auth/v1/admin/' + path, Object.assign({}, init, { headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' } }));
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) { return { status: 502, body: null }; }
}
