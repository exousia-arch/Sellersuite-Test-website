# PPCBench database security process

Follow this **before and while** PPCBench gets its first database. It turns the 15 security videos in `Security Videos/` into gates you can check off, adapted to this stack: static site on Vercel, Edge Functions in `api/`, a signed-cookie gate in `middleware.js`, and a **public** GitHub repo.

How to use it: work through the phases in order. A phase is done only when every box in its gate is ticked. Phase 1 must be finished before any database credential exists.

---

## 0. Ground rules (do not trade these away)

1. **The Amazon files never reach the database.** PPCBench's promise is that bulk files, hourly reports and search-term reports are processed in the browser and never leave the tab. The database must never hold report rows, search terms, campaign or portfolio names, ASINs, spend or sales. If "saved plans" or "saved reports" are ever wanted, that is a product decision: write it down, update the privacy policy first, and store the least possible (see section 1).
2. **The repo is public. Every commit is published.** Nothing secret goes in Git, ever, not even briefly. Anything that touches a commit is treated as leaked and rotated.
3. **Default deny.** New tables, roles, buckets, endpoints and ports start closed and are opened one at a time with a reason.
4. **One breach = one service.** Separate environments (dev, preview, production) and separate credentials, so a leak in one cannot reach another.

## 1. What the database may hold

| Allowed | Not allowed |
|---|---|
| Account: email, name, role, created and last-login time | Uploaded files or any parsed rows from them |
| Access requests (name, email, role, spend band, use case) | Search terms, campaign, portfolio, ASIN, SKU data |
| Newsletter subscribers and contact messages | Passwords in plain text (hash only, or none if using Google or another managed login) |
| Session records (hashed token id, expiry, revoked flag) | Raw tokens, API keys, webhook secrets |
| Per-user settings that are not account data (theme, language) | Anything copied from a customer's Amazon account |

Today, access requests, newsletter and contact go to webhooks (`REQUEST_WEBHOOK`, `NEWSLETTER_WEBHOOK`, `CONTACT_WEBHOOK`), so a database starts as a new place that personal data lives. That triggers Phase 0.

---

## Phase 0: before choosing a database

- [ ] Write one paragraph per data item above: why it is stored, how long, who can read it. This becomes the privacy policy's "what we collect".
- [ ] Draft and legally review the three documents *before* real user data: **privacy policy**, **terms of service**, and a **data processing agreement** if any third party processes user data. Base them on the real data flows, not a template. (`privacy.html` exists; re-read it against this table.)
- [ ] Pick a **managed** database with: encryption at rest and in transit, automated backups, point-in-time restore, audit logging, per-environment projects, and a data region that matches where your users are. Do not self-host.
- [ ] Decide the deletion path: a user can ask for their data to be exported and deleted, and you can do it in one script.
- [ ] Set up a **compliance calendar**: a quarterly 2-hour review (privacy laws, cookie rules, data residency, subprocessors). Put the first date in the calendar now.

Gate: data table agreed, documents drafted, provider chosen.

## Phase 1: repo and secrets (before any database credential exists)

- [ ] `.gitignore` covers `.env`, `.env.*`, `*.pem`, `*.key`, `.vercel/`. **Do this first**: a file Git has already tracked is not un-leaked by ignoring it later.
- [ ] All secrets live in **Vercel environment variables**, set per environment (Production / Preview / Development), never in code or `vercel.json`. Preview deployments use a **different** database and different keys from production.
- [ ] Turn on GitHub **secret scanning and push protection** for the repo (free on public repos; confirm they are enabled).
- [ ] Add a **pre-commit secret scan** (gitleaks or trufflehog) so a key is stopped before it reaches the repo. CI runs the same scan.
- [ ] Everyone with repo or Vercel access has read the leak steps below and the incident runbook in Phase 6.
- [ ] `AUTH_SECRET` and every future secret: long random value, unique per environment, rotated on a schedule (every 90 days) and immediately on any exposure.

**If a secret is ever committed:** (1) rotate it at the provider *first*; (2) purge it from history with `git filter-repo` or BFG and force-push; (3) assume it was already copied, so check the provider's logs for use; (4) record what happened.

Gate: a test commit containing a fake key is blocked locally and by GitHub.

## Phase 2: provisioning the database and storage

- [ ] Separate databases/projects for dev, preview and production, with separate credentials.
- [ ] **No public access.** Restrict connections by network allow-list or private networking where the provider offers it; TLS required; no default or shared passwords; randomized resource names that do not contain "ppcbench", "prod", or "backup".
- [ ] **Least-privilege roles.** The app connects with a role that can read and write its own tables only. It cannot create or drop tables, and it cannot read other roles' data. Migrations run with a separate role used only in deploy. Anything reporting-only gets a read-only role.
- [ ] **Row Level Security (if Postgres/Supabase-style):** turn it on for every table that holds user data, with a default-deny policy and explicit per-user policies, so isolation is enforced by the database and not only by the app. Test it: a user must be unable to read another user's row even if the application code has a bug.
- [ ] **Storage buckets (only if uploads are ever added):** one bucket for public assets, a different private bucket for everything else, private files served by **short-lived signed URLs**, **server access logging on**, alerts for unusual downloads. Database backups and exports are never stored in a public bucket.
- [ ] **Backups:** encrypted, private, restore tested once before launch and then quarterly.
- [ ] **Audit and access logging on**, with alerts (see Phase 6).
- [ ] **Pin versions and isolate the provider.** All database calls go through one small module (`api/_db.js` or similar) so the provider is a config choice, not a rewrite. Pin the client library and any runtime versions; review upgrades on a schedule. Watch the provider's security advisories and licence changes (the Redis to Valkey fork is the cautionary tale).

Gate: from outside your network, the database is unreachable; the app role cannot drop a table; RLS test passes; a restore from backup works.

## Phase 3: accounts, sessions and access

Today: `api/login.js` compares a username and password from the `PPCBENCH_USERS` environment variable and issues a 30-day signed cookie. That is fine for a handful of invited users and should be retired when the database arrives.

- [ ] **Prefer managed login** (Google sign-in or a managed auth provider) so PPCBench stores **no passwords**. If passwords are kept, hash them with argon2id or bcrypt, never reversible, never logged.
- [ ] **Short-lived access plus rotating refresh.** Access token about 15 minutes. Refresh token in an **HttpOnly, Secure, SameSite** cookie, about 7 days, **rotated on every use**. If a used refresh token appears again, treat it as stolen and **revoke that whole session family**. Never issue a token without an expiry.
- [ ] **Server-side session records** so you can revoke one session or all of a user's sessions immediately (the current cookie can only be revoked by removing the user from the environment variable).
- [ ] **Check the role against the database on every privileged request.** Never trust a role stored inside a token. A demoted admin loses access on the next request.
- [ ] **Multi-factor authentication** on every owner/admin account, and on the Vercel, GitHub, database-provider and Google accounts that can reach production. No shared logins.
- [ ] **Rate-limit and lock out** the login and request-access endpoints (per IP and per account). The current `/api/login` has no limit.
- [ ] **Redirects:** after login and after logout, redirect only to an allow-listed internal path. Parse the URL and reject absolute URLs, `//host`, backslashes and encoded variants. (Today `login.html` redirects to a hard-coded `/app`; keep it that way, or validate strictly if a `return` parameter is ever added. Check logout too.)
- [ ] **CORS:** the API is same-origin and sets no CORS headers; keep it that way. If a cross-origin need appears, use an explicit allow-list, never `*`, never `*` with credentials, and never echo the `Origin` header back unchecked.
- [ ] **No exposed admin surfaces.** Any internal page, dashboard or admin tool requires authentication regardless of where it runs, and is never reachable without it. Provider dashboards (Vercel, database) sit behind MFA and, where offered, SSO and IP restriction.

Gate: tokens expire; a replayed refresh token kills the session; a changed role takes effect immediately; login is rate-limited; redirect tests pass.

## Phase 4: application and API layer

- [ ] **Parameterized queries or an ORM only.** No string-built SQL. Every query for user data is scoped to the signed-in user.
- [ ] **Validate and clip all input** at the edge (the existing `clip()` and email checks are the model). Reject unknown fields; cap sizes; keep the honeypot on public forms.
- [ ] **Security headers** in `vercel.json`. Present today: `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options: SAMEORIGIN`, `Permissions-Policy`, HSTS. **Add** a `Content-Security-Policy` that includes `frame-ancestors 'self'` (keep `X-Frame-Options` too for old browsers) and restrict `script-src` to the CDNs you actually use.
- [ ] **Firewall and rate limits at the edge.** On Vercel use the project Firewall (managed rules, custom rules, rate limiting, IP blocking). That is the managed equivalent of a web application firewall plus fail2ban. Turn on the available managed rules and rate limits for `/api/*`; verify what your plan includes.
- [ ] **Inbound webhooks (for example Stripe, if billing is added):** verify the provider's **signature** before acting, reject old timestamps, **store processed event IDs and ignore duplicates**, and make handlers idempotent. Audit every inbound webhook the same way. (Today's endpoints only *send* webhooks, so this applies once something *receives* them.)
- [ ] **Errors and logs:** never log passwords, tokens, full emails in bulk, or request bodies. Send errors to a monitoring service that has alerting.

Gate: header scan shows CSP and frame protection; a forged webhook is rejected; a duplicate event is ignored; an injection test returns nothing.

## Phase 5: release gate (copy into every pull request that touches data or auth)

- [ ] No secrets, keys, tokens or `.env` in the diff; the secret scan passed.
- [ ] No Amazon report data is read, stored or logged server-side.
- [ ] New tables have RLS (or equivalent) and least-privilege grants.
- [ ] Every new endpoint checks authentication and the user's role against the database.
- [ ] Inputs validated; queries parameterized; user scope enforced.
- [ ] Redirects allow-listed; no wildcard CORS; headers unchanged or stricter.
- [ ] Tokens expire; sessions are revocable.
- [ ] Privacy policy still matches what is collected.

## Phase 6: operating it

**Alert on:** a spike in login failures or blocked requests, many downloads or exports from one account, a new IP or region on an admin account, any use of a revoked or rotated credential, database role or permission changes, and backup failures.

| Cadence | Task |
|---|---|
| Every release | Release gate (Phase 5) |
| Monthly | Review dependency and provider advisories; apply pinned-version updates deliberately |
| Quarterly | Restore a backup; review who has access to what; compliance review (2 hours); rotate secrets due for rotation |
| After any incident | Post-incident note and a gate or check added so it cannot recur |

**Incident runbook (a suspected leak or breach):**
1. Contain: rotate the exposed secrets, revoke all sessions, close the exposed access.
2. Scope: check provider and access logs for what was reached and for how long.
3. Preserve: keep the logs. Do not delete anything.
4. Notify: if personal data was exposed, regulators and users may need to be told within legal deadlines (for example 72 hours under GDPR); involve counsel.
5. Fix the root cause, then add the missing gate.

---

## Findings in the current repo (do these first)

Checked against the repo on 2026-10-07.

| # | Finding | Why it matters | Fix |
|---|---|---|---|
| 1 | `.gitignore` has no `.env*` rule | The repo is public; an accidental `.env` commit would publish secrets | Add `.env`, `.env.*`, `*.pem`, `*.key` |
| 2 | `Security Videos/` (about 250 MB) is untracked and not ignored | An accidental `git add .` would commit it | Add it to `.gitignore` |
| 3 | `PPCBENCH_USERS` holds usernames and passwords in plain text; `api/login.js` compares them directly | Passwords readable by anyone with Vercel access; no hashing | Retire at database time (Phase 3); until then use long, random, unique passwords |
| 4 | No rate limit or lockout on `/api/login` | Password guessing is unthrottled | Vercel Firewall rate-limit rule now; app-level lockout with the database |
| 5 | Session cookie lasts 30 days and is not rotated; revocation means editing an environment variable | A stolen cookie works for 30 days | Short access plus rotating refresh with server-side sessions (Phase 3) |
| 6 | No `Content-Security-Policy` (`X-Frame-Options: SAMEORIGIN` is present) | Clickjacking protection is only the legacy header; no script allow-list | Add CSP with `frame-ancestors 'self'` (Phase 4) |

**Already good:** no secrets, key files or Amazon data files were ever committed (checked the full Git history); `*.xlsx` and `*.csv` are ignored; the session cookie is HttpOnly, Secure and SameSite; the post-login redirect is hard-coded; forwarders keep destinations server-side; public forms have honeypots and input clipping; HSTS and `nosniff` are on.

---

## Appendix: what each video contributed

| # | Video topic | Applies | Where it lands |
|---|---|---|---|
| 1 | Public cloud storage bucket leaks the user database | At DB time, if storage is used | Phase 2 (private buckets, signed URLs, random names, access logging) |
| 2 | Stripe key committed to a public repo | Now | Phase 1 (env vars, `.gitignore` first, rotate, purge history, secret scan) |
| 3 | Localhost tools reachable via DNS rebinding | If local or internal tools exist | Phase 3 (no unauthenticated internal tools); Host-header check and loopback binding for any dev server |
| 4 | Flat network, services trust each other | At DB time | Phase 2 (separate environments, least-privilege roles, one breach = one service) |
| 5 | JWTs that never expire; role inside the token | At DB time | Phase 3 (15-minute access, rotating refresh, role checked in the database) |
| 6 | CORS wildcard and reflected origin | Now (keep same-origin) | Phase 3 (CORS rule) |
| 7 | Server admin panel open to the internet (CloudPanel) | Not our stack; principle applies | Phase 3 (no exposed admin surfaces, MFA) |
| 8 | Microsoft 365 conditional access | Not our stack; principle applies | Phase 3 (MFA, tiered access for admin) |
| 9 | Unverified Stripe webhooks and replays | When something receives webhooks | Phase 4 (signature, timestamp, event-ID dedupe) |
| 10 | Nginx without a web application firewall | Mapped to Vercel | Phase 4 (Vercel Firewall, rate limits, alerting) |
| 11 | Testimonial: multi-tenant healthcare app built with AI | Mostly motivational | Phase 2 (database-level row security), Phase 3 (MFA), Phase 6 (error monitoring) |
| 12 | Redis licence change and fork (Valkey) | At DB time | Phase 2 (adapter module, pinned versions, advisory watch) |
| 13 | Solo-founder compliance (GDPR, CCPA) | Before real user data | Phase 0 (policy, terms, DPA, compliance calendar) |
| 14 | Clickjacking via invisible iframes | Now | Phase 4 (`X-Frame-Options` plus CSP `frame-ancestors`) |
| 15 | Open redirect after login and logout | Now, when `return` is added | Phase 3 (redirect allow-list; audit logout) |

Notes on sources: the videos are short tips, so where they are silent (for example password hashing, RLS testing, backup restores, the incident runbook) this document adds standard practice and says so by being in the phase list rather than the appendix. Check what your Vercel plan and chosen database provider actually include before relying on a named feature.
