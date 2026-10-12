-- Proves the isolation promises of the migration. Run on a THROWAWAY database after the migration
-- (local Postgres or a scratch Supabase project, never production). Any failed check raises an
-- exception and the whole script aborts; "rls_check: all passed" at the end means it is safe.
-- Simulates Supabase's roles: anon / authenticated, with the JWT subject set per request.

begin;
set local client_min_messages = warning;

-- two fake users (the trigger creates their profiles)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@example.com');
insert into public.access_requests (name, email) values ('Req One', 'req@example.com');

do $$ declare n int; begin
  select count(*) into n from public.profiles;
  assert n = 2, 'trigger should have created 2 profiles, got ' || n;
end $$;

-- ---- as Alice
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);

do $$ declare n int; begin
  select count(*) into n from public.profiles;
  assert n = 1, 'Alice must see exactly her own profile, saw ' || n;
  select count(*) into n from public.profiles where email = 'bob@example.com';
  assert n = 0, 'Alice must NOT see Bob''s profile';
end $$;

do $$ begin
  begin update public.profiles set role = 'admin' where id = auth.uid();
        raise exception 'FAIL: user could update own profile (self-promotion)';
  exception when insufficient_privilege then null; end;
  begin insert into public.profiles (id, email) values (gen_random_uuid(), 'x@example.com');
        raise exception 'FAIL: user could insert a profile';
  exception when insufficient_privilege then null; end;
  begin delete from public.profiles;
        raise exception 'FAIL: user could delete profiles';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.access_requests limit 1;
        raise exception 'FAIL: user could read access_requests';
  exception when insufficient_privilege then null; end;
end $$;

-- ---- as an anonymous visitor
reset role; set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$ begin
  begin perform 1 from public.profiles limit 1;
        raise exception 'FAIL: anon could read profiles';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.access_requests limit 1;
        raise exception 'FAIL: anon could read access_requests';
  exception when insufficient_privilege then null; end;
  begin insert into public.access_requests (name, email) values ('Bot', 'bot@example.com');
        raise exception 'FAIL: anon could write access_requests directly';
  exception when insufficient_privilege then null; end;
end $$;

-- ---- bad data is rejected by the table itself (as the owner)
reset role;
do $$ begin
  begin insert into public.access_requests (name, email) values ('', 'a@b.co');
        raise exception 'FAIL: empty name accepted';
  exception when check_violation then null; end;
  begin insert into public.access_requests (name, email) values ('X', 'not-an-email');
        raise exception 'FAIL: bad email accepted';
  exception when check_violation then null; end;
  begin update public.profiles set role = 'owner' where email = 'alice@example.com';
        raise exception 'FAIL: unknown role accepted';
  exception when check_violation then null; end;
end $$;

select 'rls_check: all passed' as result;
rollback;
