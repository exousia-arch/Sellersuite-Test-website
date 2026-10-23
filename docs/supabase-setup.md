# Supabase setup runbook (accounts + access requests only)

Companion to [database-security-process.md](database-security-process.md). The repo side is done (migration, tests, secret scanning). These are the steps only you can do in the Supabase and Vercel dashboards, in order. Tick each box; the Phase 2 and 3 gates in the process doc are the pass/fail.

Settings names below are from memory of the Supabase dashboard and may be worded differently or sit on a different plan tier. Where a step says "if available", check your plan rather than assuming.

## 1. Before creating anything (5 minutes)

- [ ] Turn on **two-factor sign-in** for your Supabase, Vercel and GitHub accounts. These three can reach production.
- [ ] Run once in the repo: `npm run hooks` (enables the pre-commit secret scan; install gitleaks first: `winget install gitleaks.gitleaks`).
- [ ] Confirm GitHub **secret scanning and push protection** are on (repo Settings, Code security).

## 2. Create two projects (never share keys between them)

- [ ] **ppcbench-prod** and **ppcbench-dev**. Pick the region closest to your users. Use a long random database password from a password manager (it is used rarely; the app uses API keys, not this password).
- [ ] Do not put "ppcbench" or "prod" in any storage bucket name (none are needed yet).

## 3. Apply the schema and prove it

- [ ] In **dev**: SQL editor, run `supabase/migrations/20261012000000_accounts_and_access_requests.sql`.
- [ ] Still in **dev**: run `supabase/tests/rls_check.sql`. It must end with `rls_check: all passed`. (It needs a throwaway database: dev is fine; it rolls itself back and writes nothing.)
- [ ] Run Supabase's **Security Advisor** (Database, Advisors) and fix or note anything it flags.
- [ ] Only then run the migration in **prod**. Do not run the test file in prod.

## 3a. If the GitHub repo is connected to Supabase

Supabase's GitHub integration applies `supabase/migrations/*.sql` (files must be named `<14-digit timestamp>_name.sql`) to the connected project when you push to the connected branch, and reads `supabase/config.toml`.

- [ ] **Connect the repo to the dev project first.** Do not point the production project at `main` until the schema has passed the tests in dev. A push to the connected branch changes that database.
- [ ] `config.toml` pins the safe auth settings (sign-ups off, 15-minute tokens, refresh rotation on, MFA on, exact redirect URL). If the integration syncs it, those settings win over the dashboard. Check Authentication settings after the first deploy to see what actually applied.
- [ ] After the first deploy, confirm in Table editor that `profiles` and `access_requests` exist and show "RLS enabled", then run `supabase/tests/rls_check.sql`.
- [ ] New migrations are new files with a later timestamp. Never edit a migration that has already been applied.

## 4. Lock down sign-in (Authentication settings, per project)

- [ ] **Disable public sign-ups.** Users are invited by you after you approve an access request.
- [ ] Enable the **Google** provider (paste its client ID and secret into Supabase, not into the repo). Keep email/password off unless you need it; with Google only, PPCBench stores no passwords.
- [ ] **Site URL and redirect URLs:** list only exact URLs (`https://www.ppcbench.com/...` for prod (the site is served from www; the bare domain redirects there), your preview URL for dev). No wildcards. This is the open-redirect guard.
- [ ] **Access token lifetime:** 900 seconds (15 minutes). **Refresh token rotation:** on, with reuse detection. (The process doc's Phase 3 rule.)
- [ ] **Multi-factor authentication:** enable it and require it for any admin account.

## 5. Lock down the database and API

- [ ] **Enforce SSL** for database connections.
- [ ] **Network restrictions:** if your plan offers them, allow only the addresses that need direct database access. The app uses the HTTPS API, not direct connections.
- [ ] **Exposed schemas:** only `public`. Nothing else is exposed through the API.
- [ ] **Backups:** turn on daily backups, and point-in-time recovery if your plan offers it. Do one test restore into dev before launch.
- [ ] **Logs and alerts:** enable auth and database logs, and email alerts for spikes in failed sign-ins.

## 6. Keys and Vercel

- [ ] Copy **Project URL**, **anon (publishable) key**, **service-role key** from Settings, API.
- [ ] In Vercel, set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` using the names in `.env.example`. **Production** scope gets the prod project's keys, **Preview and Development** get dev's.
- [ ] The **service-role key bypasses row-level security**. It may only be used inside `api/*` functions, never sent to the browser, never logged, never committed. If it ever leaks: rotate it in Supabase immediately, then follow the leak steps in the process doc.
- [ ] Add each Supabase key to your password manager so you can rotate on schedule (every 90 days).

## 7. Tell me when done

Then I will wire the app: `/api/request-access` writes to `access_requests` with the service role (keeping validation, honeypot and adding a rate limit), and Google sign-in replaces the username/password check in `api/login.js` and `middleware.js`. Existing users keep working until you switch over.

## 8. Google sign-in go-live (production)

How it works: `/api/auth/google` starts sign-in with PKCE, Google returns to Supabase, Supabase returns to **`/api/auth/callback`** (the only redirect address), which exchanges the code server side and sets HttpOnly cookies. A Google user gets in only if the server has marked them **approved**; self sign-up alone is never enough.

Do these in order. The code is not live until it is pushed to `main`.

1. [ ] **Vercel, Production environment variables:** `SUPABASE_URL` (the project URL) and `SUPABASE_ANON_KEY` (the publishable anon key). `AUTH_SECRET` already exists. Do **not** add the service-role key; nothing here needs it.
2. [ ] **Supabase, Authentication, URL configuration:** Site URL `https://www.ppcbench.com`. Redirect URLs: **exactly one entry**, `https://www.ppcbench.com/api/auth/callback`. Delete the old `/app` entry and any wildcard.
3. [ ] **Supabase, Sign In / Providers:** turn **"Allow new users to sign up" off** again (it was found on after Google was enabled). The approval check protects you either way, but closed sign-ups also stop spam accounts.
4. [ ] **Google Cloud client:** JavaScript origin `https://www.ppcbench.com`; redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`; nothing else. Scopes: `openid`, email, profile only.
5. [ ] Push to `main`, then test with your own Google account (below).

### Approving a person (the only way in)

A person must exist in Supabase Auth, then be marked approved. Run in the Supabase SQL editor (or `npx supabase db query --linked --project-ref <prod-ref> "<sql>"`):

```sql
-- 1) Approve (the person must already exist: add them under Authentication > Users, or have them
--    try "Continue with Google" once; the first attempt is refused but creates the user)
update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"approved": true}'::jsonb
 where lower(email) = lower('person@example.com');

-- 2) Remove access (takes effect at their next 15-minute renewal at the latest)
update auth.users
   set raw_app_meta_data = raw_app_meta_data - 'approved'
 where lower(email) = lower('person@example.com');

-- 3) Who is approved right now?
select email, created_at, last_sign_in_at from auth.users where raw_app_meta_data @> '{"approved": true}';
```

Only the service role or SQL can change `raw_app_meta_data`. The user can edit `user_metadata`, which the server ignores.

### Live test after deploy

- [ ] Own Google account, **not yet approved** → lands on /login with "not been approved yet". No session.
- [ ] Approve it (SQL above), sign in again → lands on /app.
- [ ] Sign out → back on /login; /app redirects to /login.
- [ ] Open `/api/auth/callback?code=x` directly → /login (denied). Open `/api/auth/google` in one browser, copy the final callback URL into another browser → denied.
- [ ] Username/password login still works (kept as a fallback for now).

### Rotation and revocation

- A Google session lasts 15 minutes and renews from a 7-day HttpOnly refresh token, rotated on every use (Supabase revokes the chain if an old token is replayed). Removing approval or deleting the user ends access at the next renewal.
- To cut everyone off immediately: change `AUTH_SECRET` in Vercel (invalidates every session cookie).

## 9. Plans: free, core, pro (who sees which tool)

| Plan | Tools in their page |
|---|---|
| **free** (the default for anyone approved with no plan set) | Smart N-Gram Analyzer |
| **core** | + Search Term Harvester, Bulk Negator |
| **pro** | + Bulk Campaign Creator, Dayparting Planner, SQP Tracker |

How it is enforced: `middleware.js` reads the plan from the signed session and serves `/app` from `gated/app.<plan>.htm`. That page contains **only** the code of the tools on the plan; the others are shown as locked entries with an upgrade prompt. The Dayparting and SQP scripts are served from `/gated/tools/` only to plans that include them. A direct request for another plan's page or script is refused (403, or 401 when not signed in).

The plan lives in `app_metadata.tier`, which only SQL or the service role can write (a user cannot edit it). Missing or unknown means `free`. Changes take effect at the user's next renewal (within 15 minutes). Username/password testers are treated as `pro` until they move to Google.

```sql
-- Set a plan: 'free', 'core' or 'pro'. Keep the where line.
update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('tier', 'pro')
 where lower(email) = lower('person@example.com')
returning email, raw_app_meta_data->>'tier' as tier;

-- Who has which plan?
select email, coalesce(raw_app_meta_data->>'tier', '(none = free)') as tier,
       raw_app_meta_data->>'approved' as approved
  from auth.users order by created_at;
```

Approving someone (section 8) and giving them a plan are two separate fields: approve, then set the tier (or leave it at free).

**Changing the app:** edit `src/app.source.html`, run `npm run build:app`, commit the regenerated `gated/` files. `npm test` fails if they are stale and `npm run test:ui` checks every plan in a browser. A tool's code must sit inside a `//@tool name` region; the build refuses unlabelled code and any shared code that calls a tool's function without a guard.

**Note:** the GitHub repository is public, so anyone can read every tool's source there even though the site only serves a user the tools on their plan. Make the repository private if the code itself must stay confidential (GitHub's free secret scanning and push protection are public-repo features; the gitleaks hook and CI check keep working).

## What the schema guarantees (tested)

| Promise | Checked by |
|---|---|
| A signed-in user sees only their own profile | `rls_check.sql` |
| Nobody can promote themselves to admin, or edit or delete profiles from the client | `rls_check.sql` |
| `access_requests` is unreadable and unwritable by browsers (anon or signed-in) | `rls_check.sql` |
| Bad data (empty name, invalid email, unknown role) is rejected by the table itself | `rls_check.sql` |
| New tables and functions are not silently open to the public | Default-deny RLS plus revoked default grants |
