// POST /api/logout → clears the session cookie (http-only, so JS can't do it).
export const config = { runtime: 'edge' };

export default async function handler() {
  const cookie = 'ppcb_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie } });
}
