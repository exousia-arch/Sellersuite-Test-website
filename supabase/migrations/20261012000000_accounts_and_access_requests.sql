-- PPCBench v1 database: accounts + access requests ONLY.
-- Never store Amazon report data here (bulk files, search terms, campaigns, ASINs, spend, sales).
-- Default deny: RLS is on for every table; anything not granted below is blocked.
-- Run in the Supabase SQL editor (or `supabase db push`), once per environment.

-- ---------------------------------------------------------------- profiles
-- One row per signed-in user. Identity and credentials live in Supabase Auth (auth.users);
-- PPCBench stores no passwords.
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null check (length(email) <= 254),
  name       text check (length(name) <= 120),
  role       text not null default 'member' check (role in ('member', 'admin')),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
alter table public.profiles force row level security;

-- A user can read their own profile. Nothing else: no client insert/update/delete.
-- Roles are changed only by the service role (server side), so nobody can promote themselves.
create policy "own profile: read" on public.profiles
  for select to authenticated using (id = (select auth.uid()));

-- Create the profile automatically on sign-up. Runs as the table owner; search_path is pinned
-- so it cannot be hijacked by a same-named object in another schema.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, left(coalesce(new.raw_user_meta_data ->> 'name', ''), 120));
  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- access_requests
-- Rows are written by the /api/request-access function using the service role (server only),
-- which also does the validation, honeypot and rate limiting. No client can read or write them.
create table public.access_requests (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(name) between 1 and 120),
  email      text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 160),
  role       text check (length(role) <= 80),
  spend      text check (length(spend) <= 40),
  usecase    text check (length(usecase) <= 1000),
  status     text not null default 'new' check (status in ('new', 'approved', 'declined')),
  created_at timestamptz not null default now()
);
alter table public.access_requests enable row level security;
alter table public.access_requests force row level security;
-- (intentionally no policies: anon and authenticated get nothing)

-- ---------------------------------------------------------------- least privilege
-- Supabase grants broad default privileges to anon/authenticated; strip them, then grant back
-- only what is needed. RLS is the second lock; these grants are the first.
revoke all on public.profiles, public.access_requests from anon, authenticated;
grant select on public.profiles to authenticated;
