// POST /api/logout → clears the session cookie (http-only, so JS can't do it).
import { CLEAR_ALL } from './_auth.js';
export const config = { runtime: 'edge' };

export default async function handler() {
  const h = new Headers({ 'Content-Type': 'application/json' });
  CLEAR_ALL.forEach(x => h.append('Set-Cookie', x));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
}
