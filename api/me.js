// GET /api/me → { authed, user?, via?, tier?, tools? } based on the signed session cookie.
export const config = { runtime: 'edge' };

import { getSession } from './_auth.js';
import { normTier, toolsFor } from './_tiers.js';

// Says who is signed in (the caller's own session only): email for Google, username for the legacy login.
export default async function handler(request) {
  const s = await getSession(request, process.env.AUTH_SECRET || '', process.env.PPCBENCH_USERS || '');
  const tier = s ? normTier(s.tier) : null;
  const body = s ? { authed: true, user: String(s.user), via: s.src === 'sb' ? 'google' : 'password', tier, tools: toolsFor(tier) } : { authed: false };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
