-- Proves the promises of 20261023000000_sqp_tracker.sql. Run on a database that has all migrations applied
-- (local engine, or the real project: everything runs inside one transaction that is rolled back, so nothing is kept).
-- Any failed check raises an exception and aborts; "sqp_check: all passed" at the end means it is safe.
-- Simulates Supabase's JWT: the role (authenticated / anon) and request.jwt.claims (sub + app_metadata.tier).

begin;
set local client_min_messages = warning;

-- ---------------------------------------------------------------- test helpers (dropped by the rollback)
create function public._t_as(uid uuid, tier text default null, claim_role text default 'authenticated', user_tier text default null) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', claim_role,
    'app_metadata', case when tier is null then '{}'::jsonb else jsonb_build_object('tier', tier) end,
    'user_metadata', case when user_tier is null then '{}'::jsonb else jsonb_build_object('tier', user_tier) end)::text, true);
  execute format('set local role %I', claim_role);
end $$;
create function public._t_ok(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FAIL: %', msg; end if; end $$;
create function public._t_err(q text, want text) returns void language plpgsql as $$
begin
  begin execute q;
  exception when others then
    if sqlerrm like want or sqlstate = want then return; end if;
    raise exception 'FAIL: wrong error for [%]: % (%), wanted %', left(q, 90), sqlerrm, sqlstate, want;
  end;
  raise exception 'FAIL: expected an error but got none for [%]', left(q, 90);
end $$;
-- a valid save payload
create function public._t_pl(d date, q text default 'blue widget', brand text default 'Acme', asin text default 'B0TESTASIN', cadence text default 'weekly', clicks numeric default 118) returns jsonb language sql as $$
  select jsonb_build_object('brand', brand, 'asin', asin, 'cadence', cadence, 'from', d, 'to', d + case when cadence = 'weekly' then 6 else 29 end, 'pulled', '2026-10-23T13:57:00Z',
    'keywords', jsonb_build_array(jsonb_build_object('query', q, 'display', initcap(q), 'ranking', jsonb_build_array(jsonb_build_object('id', '123', 'name', 'SP-Rank')),
      'data', jsonb_build_object('volume', 1200, 'price', jsonb_build_object('market', 24.99, 'asin', 27.99), 'share', jsonb_build_object('imp', 5, 'click', 3, 'purchase', 2),
        'market', jsonb_build_object('imp', 52000, 'clicks', 780, 'orders', 30), 'asin', jsonb_build_object('imp', 2400, 'clicks', 18, 'orders', 1),
        'cm', jsonb_build_object('imp', 8900, 'clicks', clicks, 'orders', 6, 'spend', 88, 'sales', 300), 'term', jsonb_build_object('imp', 8000, 'clicks', 100, 'orders', 5, 'spend', 80, 'sales', 250),
        'allppc', jsonb_build_object('imp', 9000, 'clicks', 130, 'orders', 7, 'spend', 100, 'sales', 340),
        'pl', jsonb_build_object('top', jsonb_build_object('imp', 6000, 'clicks', 90, 'orders', 5, 'spend', 70), 'other', jsonb_build_object('imp', 100, 'clicks', 4, 'orders', 0, 'spend', 3))))))
$$;
grant execute on function public._t_as(uuid, text, text, text), public._t_ok(boolean, text), public._t_err(text, text), public._t_pl(date, text, text, text, text, numeric) to authenticated, anon;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@example.com'), ('00000000-0000-0000-0000-0000000000b2', 'b@example.com'), ('00000000-0000-0000-0000-0000000000c3', 'c@example.com');
select public._t_as('00000000-0000-0000-0000-0000000000a1', 'pro');

-- ---------------------------------------------------------------- 1. consent comes first, then saving works
select public._t_err(format('select public.sqp_save_period(%L::jsonb)', public._t_pl('2026-10-04')), 'sqp:consent_required');
select public.sqp_consent(1);
do $$ declare r jsonb; s jsonb; begin
  r := public.sqp_save_period(public._t_pl('2026-10-04'));
  perform public._t_ok((r ->> 'replaced')::boolean = false and (r ->> 'saved_keywords')::int = 1 and (r ->> 'kept')::boolean, 'first save: new period kept');
  s := public.sqp_state();
  perform public._t_ok((s ->> 'consent')::int = 1 and jsonb_array_length(s -> 'brands') = 1, 'state shows the brand and consent');
  perform public._t_ok(s #>> '{brands,0,asins,0,asin}' = 'B0TESTASIN' and jsonb_array_length(s #> '{brands,0,asins,0,keywords}') = 1 and jsonb_array_length(s #> '{brands,0,asins,0,periods}') = 1, 'state shows asin, keyword, period');
  -- re-saving the same period replaces it (no duplicates), keeps the keyword row
  r := public.sqp_save_period(public._t_pl('2026-10-04', clicks => 140));
  perform public._t_ok((r ->> 'replaced')::boolean, 'same period is replaced');
  perform public._t_ok((select count(*) from public.sqp_metrics) = 1 and (select count(*) from public.sqp_periods) = 1 and (select count(*) from public.sqp_keywords) = 1, 'no duplicates after re-save');
  perform public._t_ok((select (data #>> '{cm,clicks}')::numeric from public.sqp_metrics) = 140, 're-save updated the numbers');
  -- a second keyword in the same period
  perform public.sqp_save_period(public._t_pl('2026-10-04', 'red widget'));
  perform public._t_ok((select count(*) from public.sqp_keywords) = 2 and (select count(*) from public.sqp_metrics) = 1, 're-saving a period replaces its keyword set (the last save wins)');
end $$;

-- ---------------------------------------------------------------- 2. history, weekly and monthly are separate series
do $$ declare h jsonb; r jsonb; asin_id uuid; begin
  select id into asin_id from public.sqp_asins;
  perform public.sqp_save_period(public._t_pl('2026-10-11'));
  h := public.sqp_history(asin_id, 'weekly');
  perform public._t_ok(jsonb_array_length(h -> 'periods') = 2 and jsonb_array_length(h -> 'rows') = 2 and jsonb_array_length(h -> 'keywords') = 2, 'weekly history: 2 periods, 2 rows, 2 keywords known');
  r := public.sqp_save_period(public._t_pl('2026-09-01', cadence => 'monthly'));
  perform public._t_ok(jsonb_array_length(public.sqp_history(asin_id, 'monthly') -> 'periods') = 1 and jsonb_array_length(public.sqp_history(asin_id, 'weekly') -> 'periods') = 2, 'monthly is a separate series');
  perform public._t_ok(jsonb_array_length(public.sqp_history(asin_id, 'quarterly') -> 'periods') = 0, 'unknown cadence returns nothing');
end $$;

-- ---------------------------------------------------------------- 3. retention: newest 13 periods per ASIN and cadence
do $$ declare r jsonb; d date; i int; asin_id uuid; begin
  select id into asin_id from public.sqp_asins;
  for i in 1..14 loop
    d := date '2026-06-07' + i * 7;                     -- 14 more weeks, on top of the 2 already saved
    r := public.sqp_save_period(public._t_pl(d));
  end loop;
  perform public._t_ok((select count(*) from public.sqp_periods where cadence = 'weekly') = 13, 'weekly keeps 13 periods');
  perform public._t_ok((select max(period_from) from public.sqp_periods where cadence = 'weekly') = date '2026-10-11', 'newest week kept');
  perform public._t_ok((select count(*) from public.sqp_metrics m join public.sqp_periods p on p.id = m.period_id where p.cadence = 'weekly') = 13, 'metrics of pruned periods are gone');
  -- back-filling a week older than the 13 newest is accepted but not kept, and says so
  r := public.sqp_save_period(public._t_pl('2025-01-05'));
  perform public._t_ok((r ->> 'kept')::boolean = false and (select count(*) from public.sqp_periods where cadence = 'weekly') = 13, 'a too-old week is not kept and the response says so');
  perform public._t_ok((select count(*) from public.sqp_periods where cadence = 'monthly') = 1, 'monthly untouched by weekly pruning');
end $$;

-- ---------------------------------------------------------------- 4. limits hold even for direct table inserts
do $$ declare i int; begin
  for i in 1..9 loop insert into public.sqp_brands (name) values ('Brand ' || i); end loop;     -- 10 brands now
end $$;
select public._t_err($$insert into public.sqp_brands (name) values ('One too many')$$, 'sqp:limit_sqp_brands');
select public._t_err(format('select public.sqp_save_period(%L::jsonb)', jsonb_set(public._t_pl('2026-10-04', brand => 'An eleventh brand', asin => 'B0OTHER001'), '{brand}', '"An eleventh brand"')), 'sqp:limit_sqp_brands');
do $$ declare pl jsonb; ks jsonb := '[]'::jsonb; i int; begin
  pl := public._t_pl('2026-10-04', brand => 'Brand 1', asin => 'B0MANYKEYS');
  for i in 1..51 loop ks := ks || (pl -> 'keywords' -> 0 || jsonb_build_object('query', 'kw ' || i)); end loop;
  perform public._t_err(format('select public.sqp_save_period(%L::jsonb)', jsonb_set(pl, '{keywords}', ks)), 'sqp:invalid');   -- 51 keywords in one save
end $$;

-- ---------------------------------------------------------------- 5. bad data is rejected by the database itself
select public._t_err(format('select public.sqp_save_period(%L::jsonb)', jsonb_set(public._t_pl('2026-10-18', brand => 'Brand 1'), '{keywords,0,data,cm,clicks}', '-5')), '23514');            -- negative
select public._t_err(format('select public.sqp_save_period(%L::jsonb)', jsonb_set(public._t_pl('2026-10-18', brand => 'Brand 1'), '{keywords,0,data,cm,clicks}', '1e15')), '23514');          -- absurd
select public._t_err(format('select public.sqp_save_period(%L::jsonb)', jsonb_set(public._t_pl('2026-10-18', brand => 'Brand 1'), '{keywords,0,data,cm,clicks}', '"lots"')), '23514');         -- text where a number belongs
select public._t_err(format('select public.sqp_save_period(%L::jsonb)', jsonb_set(public._t_pl('2026-10-18', brand => 'Brand 1'), '{keywords,0,data,secret}', '1')), '23514');                 -- unknown key
select public._t_err(format('select public.sqp_save_period(%L::jsonb)', jsonb_set(public._t_pl('2026-10-18', brand => 'Brand 1'), '{keywords,0,data,cm,evil}', '1')), '23514');             -- unknown leaf key
select public._t_err(format('select public.sqp_save_period(%L::jsonb)', jsonb_set(public._t_pl('2026-10-18', brand => 'Brand 1'), '{keywords,0,data,pl,top,deep}', '{"a":1}')), '23514');       -- too deep / wrong shape
select public._t_err(format('select public.sqp_save_period(%L::jsonb)', jsonb_set(public._t_pl('2026-10-18', brand => 'Brand 1'), '{keywords,0,data,note}', to_jsonb(repeat('x', 7000)))), '23514'); -- oversize
select public._t_err(format('select public.sqp_save_period(%L::jsonb)', jsonb_set(public._t_pl('2026-10-18', brand => 'Brand 1'), '{asin}', '"short"')), 'sqp:invalid');
select public._t_err(format('select public.sqp_save_period(%L::jsonb)', jsonb_set(public._t_pl('2026-10-18', brand => 'Brand 1'), '{cadence}', '"daily"')), '23514');
select public._t_err(format('select public.sqp_save_period(%L::jsonb)', jsonb_set(public._t_pl('2026-10-18', brand => 'Brand 1'), '{to}', '"2026-01-01"')), '23514');                          -- ends before it starts
select public._t_err(format('select public.sqp_save_period(%L::jsonb)', jsonb_set(public._t_pl('2026-10-18', brand => 'Brand 1'), '{brand}', '""')), 'sqp:invalid');
select public._t_err(format('select public.sqp_save_period(%L::jsonb)', jsonb_set(public._t_pl('2026-10-18', brand => 'Brand 1'), '{brand_id}', to_jsonb('00000000-0000-0000-0000-000000000099'::text))), 'sqp:brand_not_found');
do $$ begin perform public._t_ok((select count(*) from public.sqp_periods where period_from = date '2026-10-18') = 0, 'a rejected save left no partial period behind'); end $$;

-- ---------------------------------------------------------------- 6. another user sees and changes nothing of A's
select public._t_as('00000000-0000-0000-0000-0000000000b2', 'pro');
do $$ declare s jsonb; a uuid; begin
  perform public.sqp_consent(1);
  s := public.sqp_state();
  perform public._t_ok(jsonb_array_length(s -> 'brands') = 0, 'B sees no brands');
  perform public._t_ok((select count(*) from public.sqp_brands) = 0 and (select count(*) from public.sqp_asins) = 0 and (select count(*) from public.sqp_keywords) = 0 and (select count(*) from public.sqp_periods) = 0 and (select count(*) from public.sqp_metrics) = 0, 'B reads no rows of A, in any table');
  perform public._t_ok(public.sqp_delete('brand', (select id from public.sqp_brands limit 1)) = 0, 'sanity: nothing to delete for B');
end $$;
select public._t_as('00000000-0000-0000-0000-0000000000a1', 'pro');
reset role;
create table public._t_ids as select (select id from public.sqp_brands where name = 'Acme') as brand, (select id from public.sqp_asins limit 1) as asin, (select id from public.sqp_periods limit 1) as period, (select id from public.sqp_keywords limit 1) as kw;
grant select on public._t_ids to authenticated;
select public._t_as('00000000-0000-0000-0000-0000000000a1', 'pro');
select public._t_as('00000000-0000-0000-0000-0000000000b2', 'pro');
do $$ declare i record; begin
  select * into i from public._t_ids;
  perform public._t_ok(public.sqp_delete('brand', i.brand) = 0 and public.sqp_delete('asin', i.asin) = 0 and public.sqp_delete('period', i.period) = 0 and public.sqp_delete('keyword', i.kw) = 0, 'B cannot delete rows of A even knowing their ids');
  perform public._t_ok(jsonb_array_length(public.sqp_history(i.asin, 'weekly') -> 'periods') = 0, 'B cannot read history of A by id');
end $$;
select public._t_err(format($$insert into public.sqp_asins (brand_id, asin) values (%L, 'B0STOLEN01')$$, (select brand from public._t_ids)), '23503');                        -- attach to A's brand: composite FK refuses
select public._t_err(format($$insert into public.sqp_periods (asin_id, cadence, period_from, period_to) values (%L, 'weekly', '2026-01-04', '2026-01-10')$$, (select asin from public._t_ids)), '23503');
select public._t_err($$insert into public.sqp_brands (user_id, name) values ('00000000-0000-0000-0000-0000000000a1', 'Planted')$$, '42501');           -- writing a row as someone else
do $$ begin update public.sqp_brands set name = 'Hijacked'; perform public._t_ok(not exists (select 1 from public.sqp_brands where name = 'Hijacked'), 'B update touches nothing'); end $$;

-- ---------------------------------------------------------------- 7. the plan is read from the token's app_metadata, only
select public._t_as('00000000-0000-0000-0000-0000000000a1', 'core');                         -- A, downgraded to core
do $$ begin
  perform public._t_ok((select count(*) from public.sqp_brands) = 0 and jsonb_array_length(public.sqp_state() -> 'brands') = 0, 'a core token reads nothing, even its own saved data');
end $$;
select public._t_err($$insert into public.sqp_brands (name) values ('Core attempt')$$, '42501');
select public._t_err(format('select public.sqp_save_period(%L::jsonb)', public._t_pl('2026-10-04', brand => 'Core attempt')), 'sqp:consent_required');   -- no visible consent row, so nothing is saved
select public._t_as('00000000-0000-0000-0000-0000000000a1', null);                           -- no tier at all
do $$ begin perform public._t_ok((select count(*) from public.sqp_brands) = 0, 'a token with no tier reads nothing'); end $$;
select public._t_as('00000000-0000-0000-0000-0000000000a1', null, 'authenticated', 'pro');   -- user-editable metadata says pro: ignored
do $$ begin perform public._t_ok((select count(*) from public.sqp_brands) = 0, 'user_metadata.tier is ignored'); end $$;
select public._t_err($$insert into public.sqp_brands (name) values ('Metadata attempt')$$, '42501');
select public._t_as('00000000-0000-0000-0000-0000000000a1', 'PRO');                          -- wrong case is not pro
do $$ begin perform public._t_ok((select count(*) from public.sqp_brands) = 0, 'upper-case PRO is not pro'); end $$;
select public._t_as('00000000-0000-0000-0000-0000000000c3', 'free');
select public._t_err($$insert into public.sqp_settings (consent_version) values (1)$$, '42501');
-- anonymous: no table and no function
select public._t_as('00000000-0000-0000-0000-0000000000a1', 'pro', 'anon');
select public._t_err('select count(*) from public.sqp_brands', '42501');
select public._t_err('select public.sqp_state()', '42501');
select public._t_err('select public.sqp_save_period(''{}''::jsonb)', '42501');
select public._t_err('select public.is_pro()', '42501');

-- ---------------------------------------------------------------- 8. export, deletes cascade, delete-all wipes everything
select public._t_as('00000000-0000-0000-0000-0000000000a1', 'pro');
do $$ declare e jsonb; i record; n int; begin
  select * into i from public._t_ids;
  e := public.sqp_export();
  perform public._t_ok(jsonb_array_length(e -> 'metrics') = 14 and jsonb_array_length(e #> '{state,brands}') = 10, 'export has every metric row (13 weekly + 1 monthly) and brand');
  perform public._t_ok(public.sqp_delete('period', i.period) = 1, 'delete one period');
  perform public._t_ok(public.sqp_delete('asin', i.asin) = 1, 'delete an ASIN');
  perform public._t_ok((select count(*) from public.sqp_periods) = 0 and (select count(*) from public.sqp_metrics) = 0 and (select count(*) from public.sqp_keywords) = 0, 'deleting the ASIN cascaded to periods, keywords and metrics');
end $$;
select public._t_err($$select public.sqp_delete('everything', gen_random_uuid())$$, 'sqp:invalid');
do $$ declare n int; begin
  perform public.sqp_save_period(public._t_pl('2026-10-04', brand => 'Brand 1', asin => 'B0AGAIN001'));
  n := public.sqp_delete_all();
  perform public._t_ok((select count(*) from public.sqp_brands) = 0 and (select count(*) from public.sqp_settings) = 0, 'delete-all removed brands and consent');
  perform public._t_err(format('select public.sqp_save_period(%L::jsonb)', public._t_pl('2026-10-04')), 'sqp:consent_required');
end $$;
-- B's data was never touched by A's delete-all
select public._t_as('00000000-0000-0000-0000-0000000000b2', 'pro');
do $$ begin perform public._t_ok((select count(*) from public.sqp_settings) = 1, 'delete-all of A did not touch B'); end $$;

reset role;
select 'sqp_check: all passed' as result;
rollback;
