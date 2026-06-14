# Switching PPCBench to the server-side (Vercel) access gate

This guide replaces the current **client-side** gate (`auth.js` + the in-page guard)
with a **server-side** gate using Vercel Edge Middleware + an Edge Function.

**Why switch?** The codes never appear in the page source, the session cookie is
HMAC-signed and `http-only` (can't be forged or read by page JS), and `/app` is
never served to unapproved visitors. Use this when you move from "keep the public
out" to "protect paid/sensitive access".

**Trade-off:** needs two environment variables and a redeploy whenever you change
the code list (the optional Edge Config step at the end removes the redeploy).

---

## Step 1 — Add the dependency

```bash
npm install @vercel/functions
```

## Step 2 — Create the login function: `api/login.js`

```js
// POST /api/login { code } -> validates against PPCBENCH_CODES, sets a signed cookie.
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
function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, extra || {}) });
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
```

## Step 3 — Create the gate: `middleware.js` (project root)

```js
import { next } from '@vercel/functions';

export const config = { matcher: ['/app', '/app/:path*', '/app.html'] };

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
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function isValid(token, secret, allow) {
  if (!token) return false;
  const i = token.lastIndexOf('.'); if (i < 1) return false;
  const payload = token.slice(0, i), sig = token.slice(i + 1);
  if (!safeEqual(sig, await hmac(payload, secret))) return false;
  let data;
  try { data = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))); } catch (e) { return false; }
  if (!data || typeof data.exp !== 'number' || Date.now() > data.exp) return false;
  if (allow.length && data.code && !allow.includes(data.code)) return false; // revocation-aware
  return true;
}

export default async function middleware(request) {
  const secret = process.env.AUTH_SECRET || '';
  const allow = (process.env.PPCBENCH_CODES || '').split(',').map(s => s.trim()).filter(Boolean);
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)ppcb_session=([^;]+)/);
  const token = m ? decodeURIComponent(m[1]) : '';
  if (secret && await isValid(token, secret, allow)) return next();
  return Response.redirect(new URL('/login', request.url), 307);
}
```

## Step 4 — (Optional) sign-out function: `api/logout.js`

An `http-only` cookie can't be cleared by page JS, so use a tiny endpoint:

```js
export const config = { runtime: 'edge' };
export default async function handler() {
  const cookie = 'ppcb_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie } });
}
```

## Step 5 — Remove the client-side gate (so the two don't conflict)

1. **`app.html`** — delete the two guard lines near the top of `<head>`:
   ```html
   <script src="/auth.js"></script>
   <script>if (!window.ppcbIsAuthed || !window.ppcbIsAuthed()) { location.replace('/login'); }</script>
   ```
2. **`app.html`** — point the Sign out button at the logout endpoint:
   ```html
   <button onclick="fetch('/api/logout',{method:'POST'}).finally(()=>location.replace('/login'))" title="Sign out" class="...">
     <i data-lucide="log-out" class="w-3.5 h-3.5"></i>
   </button>
   ```
3. **`login.html`** — replace the `ppcbVerify` call with a POST to the function, and
   remove the `<script src="/auth.js"></script>` tag:
   ```js
   async function submitCode(e) {
     e.preventDefault();
     const code = document.getElementById('code').value.trim();
     const msg = document.getElementById('msg'); const btn = document.getElementById('btn');
     msg.classList.add('hidden'); if (!code) return false;
     btn.disabled = true; btn.textContent = 'Checking…';
     try {
       const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
       if (r.ok) { window.location.href = '/app'; return false; }
       const d = await r.json().catch(() => ({}));
       msg.textContent = d.error || 'That code wasn’t recognized.'; msg.classList.remove('hidden');
     } catch (err) { msg.textContent = 'Network error — please try again.'; msg.classList.remove('hidden'); }
     btn.disabled = false; btn.textContent = 'Sign in'; return false;
   }
   ```
4. You can delete `auth.js` (no longer used).

## Step 6 — Set the environment variables in Vercel

Vercel dashboard → your project → **Settings → Environment Variables**. Add two,
scoped to **Production** (and **Preview** if you want gated preview deploys):

| Name | Value |
|------|-------|
| `AUTH_SECRET` | a long random string (signing key) |
| `PPCBENCH_CODES` | comma-separated codes, e.g. `alice-7h3k2,bob-9m2p8` |

Generate a strong `AUTH_SECRET`:

```bash
openssl rand -hex 32
```

## Step 7 — Deploy

Commit and push (Vercel auto-deploys), or click **Redeploy** in the dashboard.
**Environment variable changes only take effect on a new deployment.**

## Step 8 — Verify on the live site

1. Visit `https://ppcbench.com/app` → it should redirect to `/login`.
2. Enter a code from `PPCBENCH_CODES` → you land in the tool; refresh keeps you in.
3. Enter a wrong code → "That code wasn’t recognized."
4. Click Sign out → `/app` redirects to `/login` again.

> Note: middleware/functions only run on Vercel — they can't be tested with the
> local `serve.mjs`. Use a Vercel **Preview deployment** to test before production.

---

## Approve / revoke testers

- **Approve:** add the code to `PPCBENCH_CODES` → redeploy → hand the tester the code.
- **Revoke:** remove the code from `PPCBENCH_CODES` → redeploy. Existing sessions are
  also invalidated because the middleware re-checks the cookie's code against the
  live list.

---

## Optional upgrade — no-redeploy approvals with Edge Config

Storing the allowlist in **Vercel Edge Config** lets you add/remove codes in the
dashboard **instantly, without a redeploy**.

1. Vercel dashboard → **Storage → Edge Config → Create**. Connect it to the project
   (this adds an `EDGE_CONFIG` connection string env var automatically).
2. Add an item, e.g. key `codes` with a value like `"alice-7h3k2,bob-9m2p8"`.
3. Install the reader: `npm install @vercel/edge-config`.
4. In `middleware.js`, read the list from Edge Config instead of `process.env`:
   ```js
   import { get } from '@vercel/edge-config';
   // ...inside middleware():
   const allow = String((await get('codes')) || '').split(',').map(s => s.trim()).filter(Boolean);
   ```
   (`api/login.js` can read it the same way.)
5. Now you approve/revoke by editing the `codes` value in the Edge Config UI — changes
   apply within seconds, no redeploy.

`AUTH_SECRET` stays an environment variable.
