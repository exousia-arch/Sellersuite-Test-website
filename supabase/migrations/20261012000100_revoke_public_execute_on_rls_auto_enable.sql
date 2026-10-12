-- Supabase's own "ensure_rls" event trigger calls public.rls_auto_enable() to turn on row level
-- security for every new table. It never needs to be callable from the public API
-- (/rest/v1/rpc/rls_auto_enable), so remove that exposure (Supabase security advisor 0028/0029).
-- Event triggers run it regardless of these grants. No-op where the function does not exist.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
