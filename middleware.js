// The page gate. Two jobs:
//  1. /app  : needs a valid session; serves the version of the app built for the user's plan
//             (gated/app.<tier>.htm: a tool that is not on the plan is not in the page at all).
//  2. /gated/*: the tier versions and the tool scripts. Each needs its own plan; anything else is refused.
// Sessions come from /api/login (legacy password, treated as Pro) or /api/auth/* (Google via Supabase,
// tier from app_metadata). Both are signed with AUTH_SECRET. See api/_tiers.js for the plan table.
import { next, rewrite } from '@vercel/functions';
import { getSession, go } from './api/_auth.js';
import { TIERS, TOOL_TIER, tierRank } from './api/_tiers.js';

export const config = { matcher: ['/app', '/app/:path*', '/app.html', '/gated/:path*'] };

const PRIVATE = { 'Cache-Control': 'private, no-store' };   // never let a shared cache serve one plan's page to another
const deny = (status, msg) => new Response(msg, { status, headers: Object.assign({ 'Content-Type': 'text/plain' }, PRIVATE) });

// The plan a /gated/ path needs, or null when the path is not one we serve.
export function requiredTier(pathname) {
  let m = pathname.match(/^\/gated\/app\.([a-z]+)\.htm$/);
  if (m) return TIERS.includes(m[1]) ? m[1] : null;
  m = pathname.match(/^\/gated\/tools\/([a-z]+)\.js$/);
  if (m && Object.prototype.hasOwnProperty.call(TOOL_TIER, m[1])) return TOOL_TIER[m[1]];
  return null;
}

export default async function middleware(request) {
  const url = new URL(request.url), gated = url.pathname.startsWith('/gated/');
  const s = await getSession(request, process.env.AUTH_SECRET || '', process.env.PPCBENCH_USERS || '');

  // No usable session, or a Google session from before plans existed (it has no tier: renew it once).
  if (!s || s.tier == null) {
    if (gated) return deny(401, 'Sign in required');
    // Expired or pre-plan session: renew once from the refresh token. ?r=1 marks "already tried" (no redirect loop).
    if (request.method === 'GET' && !url.searchParams.has('r')) return go('refresh');
    return go('login');
  }

  if (gated) {
    const need = requiredTier(url.pathname);
    if (need == null) return deny(404, 'Not found');
    if (tierRank(s.tier) < tierRank(need)) return deny(403, 'Not included in your plan');
    return next({ headers: PRIVATE });
  }

  // /app: the version built for this plan. Targets are constants; nothing from the request picks the file.
  return rewrite(new URL('/gated/app.' + s.tier + '.htm', request.url), { headers: PRIVATE });
}
