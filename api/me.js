// GET /api/me → { authed: boolean } based on the signed session cookie.
export const config = { runtime: 'edge' };

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4; if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
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
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function isValid(token, secret, allow) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 1) return false;
  const payload = token.slice(0, i), sig = token.slice(i + 1);
  if (!safeEqual(sig, await hmac(payload, secret))) return false;
  let data;
  try { data = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))); } catch (e) { return false; }
  if (!data || typeof data.exp !== 'number' || Date.now() > data.exp) return false;
  if (!data.user || !allow.includes(data.user)) return false;
  return true;
}

export default async function handler(request) {
  const secret = process.env.AUTH_SECRET || '';
  const allow = (process.env.PPCBENCH_USERS || '').split(',').map(p => {
    const i = p.indexOf(':'); return i > 0 ? p.slice(0, i).trim().toLowerCase() : '';
  }).filter(Boolean);
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)ppcb_session=([^;]+)/);
  const token = m ? decodeURIComponent(m[1]) : '';
  const authed = !!(secret && await isValid(token, secret, allow));
  return new Response(JSON.stringify({ authed }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
