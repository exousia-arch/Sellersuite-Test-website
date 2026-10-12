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
- [ ] **Site URL and redirect URLs:** list only exact URLs (`https://ppcbench.com/...` for prod, your preview URL for dev). No wildcards. This is the open-redirect guard.
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

## What the schema guarantees (tested)

| Promise | Checked by |
|---|---|
| A signed-in user sees only their own profile | `rls_check.sql` |
| Nobody can promote themselves to admin, or edit or delete profiles from the client | `rls_check.sql` |
| `access_requests` is unreadable and unwritable by browsers (anon or signed-in) | `rls_check.sql` |
| Bad data (empty name, invalid email, unknown role) is rejected by the table itself | `rls_check.sql` |
| New tables and functions are not silently open to the public | Default-deny RLS plus revoked default grants |
