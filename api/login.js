// POST /api/login  { code }  → validates against PPCBENCH_CODES env allowlist,
// sets a signed, http-only session cookie (HMAC-SHA256 with AUTH_SECRET).
export const config = { runtime: 'edge' };

function bytesToB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmac(msg, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return bytesToB64url(new Uint8Array(sig));
}
function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}) });
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const secret = process.env.AUTH_SECRET || '';
  if (!secret) return json({ error: 'Access is not configured yet.' }, 500);
  const allow = (process.env.PPCBENCH_CODES || '').split(',').map(s => s.trim()).filter(Boolean);

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const code = (body && body.code ? String(body.code) : '').trim();

  if (!code || !allow.includes(code)) return json({ error: 'That code wasn’t recognized.' }, 401);

  const MAX_AGE = 30 * 24 * 60 * 60; // 30 days
  const exp = Date.now() + MAX_AGE * 1000;
  const payload = bytesToB64url(new TextEncoder().encode(JSON.stringify({ code, exp })));
  const sig = await hmac(payload, secret);
  const token = `${payload}.${sig}`;
  const cookie = `ppcb_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`;

  return json({ ok: true }, 200, { 'Set-Cookie': cookie });
}
