// GET /api/me → { authed: boolean } based on the signed session cookie.
export const config = { runtime: 'edge' };

import { isAuthed } from './_auth.js';

export default async function handler(request) {
  const authed = await isAuthed(request, process.env.AUTH_SECRET || '', process.env.PPCBENCH_USERS || '');
  return new Response(JSON.stringify({ authed }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
