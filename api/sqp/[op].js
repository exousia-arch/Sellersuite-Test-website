// POST /api/sqp/<op> ← saved SQP history (Pro plan). A thin pass-through to the database's own functions, called
// with the SIGNED-IN USER's Supabase token (cookie ppcb_at), never a service key. The database enforces who the
// user is, that they are on Pro (JWT app_metadata.tier) and every limit; this layer only refuses early and
// keeps the body to the one shape each function expects.
import { config_, getSession, getCookie, SITE } from '../_auth.js';
import { canUse } from '../_tiers.js';
export const config = { runtime: 'edge' };

const MAX_BODY = 200 * 1024;                                       // 50 keywords x a few hundred bytes is far below this
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// op -> [database function, builds the function's arguments from the request body or returns null for a bad body]
const OPS = {
  state:      ['sqp_state', () => ({})],
  consent:    ['sqp_consent', b => (b.version === 1 ? { p_version: 1 } : null)],
  save:       ['sqp_save_period', b => (b.payload && typeof b.payload === 'object' && !Array.isArray(b.payload) ? { p: b.payload } : null)],
  history:    ['sqp_history', b => (UUID.test(b.asin_id) && ['weekly', 'monthly'].includes(b.cadence) ? { p_asin: b.asin_id, p_cadence: b.cadence } : null)],
  delete:     ['sqp_delete', b => (['brand', 'asin', 'keyword', 'period'].includes(b.kind) && UUID.test(b.id) ? { p_kind: b.kind, p_id: b.id } : null)],
  delete_all: ['sqp_delete_all', () => ({})],
  export:     ['sqp_export', () => ({})]
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
const jwtSub = t => { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch (e) { return null; } };

export default async function handler(request) {
  if (request.method !== 'POST') return json(405, { error: 'method' });
  if (request.headers.get('origin') !== SITE) return json(403, { error: 'origin' });
  const name = new URL(request.url).pathname.split('/').pop(), op = Object.hasOwn(OPS, name) ? OPS[name] : null;   // own keys only: not constructor, __proto__ …
  if (!op) return json(404, { error: 'unknown' });
  const c = config_();
  if (!c.ok) return json(503, { error: 'unavailable' });

  const s = await getSession(request, c.secret, process.env.PPCBENCH_USERS);
  if (!s) return json(401, { error: 'renew' });                     // session window ended: the page renews, then retries
  if (s.src !== 'sb' || !canUse(s.tier, 'sqp')) return json(403, { error: 'plan' });
  const at = getCookie(request, 'ppcb_at');
  if (!at || jwtSub(at) !== s.uid) return json(401, { error: 'renew' });

  let body = {};
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { error: 'too_large' });
  if (raw) { try { body = JSON.parse(raw); } catch (e) { return json(400, { error: 'invalid' }); } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'invalid' });
  const args = op[1](body);
  if (!args) return json(400, { error: 'invalid' });

  let r;
  try { r = await fetch(`${c.url}/rest/v1/rpc/${op[0]}`, { method: 'POST', headers: { apikey: c.key, Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' }, body: JSON.stringify(args) }); }
  catch (e) { return json(502, { error: 'unavailable' }); }
  if (r.status === 401) return json(401, { error: 'renew' });        // Supabase said the token ended
  if (!r.ok) {
    let m = ''; try { m = String((await r.json()).message || ''); } catch (e) { /* ignore */ }
    const code = (m.match(/^sqp:[a-z_]+/) || [''])[0];              // our own codes only; never echo database text
    return json(r.status === 403 || r.status === 404 ? 403 : 400, { error: code || 'failed' });
  }
  const data = await r.json().catch(() => null);
  return json(200, { data });
}
