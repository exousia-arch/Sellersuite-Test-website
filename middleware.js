// Gates /app behind a valid PPCBench session cookie. No valid cookie → try a refresh, else /login.
// Cookies come from /api/login (legacy password, needs PPCBENCH_USERS) or /api/auth/* (Google via
// Supabase). Both are signed with AUTH_SECRET.
import { next } from '@vercel/functions';
import { isAuthed, go } from './api/_auth.js';

export const config = { matcher: ['/app', '/app/:path*', '/app.html'] };

export default async function middleware(request) {
  if (await isAuthed(request, process.env.AUTH_SECRET || '', process.env.PPCBENCH_USERS || '')) return next();
  // Expired Google session: renew once from the refresh token. ?r=1 marks "already tried", which
  // stops a redirect loop if cookies are blocked. Targets are constants, never from the request.
  if (request.method === 'GET' && !new URL(request.url).searchParams.has('r')) return go('refresh');
  return go('login');
}
