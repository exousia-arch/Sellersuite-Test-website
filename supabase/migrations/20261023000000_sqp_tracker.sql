-- SQP Tracker phase 2: saved history for tracked keywords. Pro plan only.
--
-- WHAT IS STORED (data minimisation): per tracked keyword per period, about 30 summary numbers (market, ASIN and ad
-- counts, placements). NOT stored: the uploaded files, any other query, other ASINs' campaigns, bids, budgets.
-- Keeps the newest 13 periods per ASIN and cadence. A user can export and delete everything.
--
-- HOW IT IS PROTECTED
--  * RLS on every table: a row is visible only to its owner AND only while the session's JWT says app_metadata.tier = 'pro'
--    (the tier is server-set; a downgrade locks the data within one token lifetime).
--  * Composite foreign keys (id, user_id) so a row can never point at another user's parent row.
--  * Size/shape checks on the metrics JSON, and per-parent row caps (triggers), so limits hold even for a caller
--    that bypasses our API.
--  * Functions run as the caller (SECURITY INVOKER): they can never see or change more than RLS allows.
--  * No direct access for anon; execute rights only for signed-in users.

-- ---------------------------------------------------------------- helpers
create function public.is_pro() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'tier') = 'pro', false)
$$;

-- shape check for one keyword-period record: known keys only, numbers only, 0 <= n <= 1e12, small
create function public.sqp_valid(d jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb; k2 text; v2 jsonb; k3 text; v3 jsonb;
begin
  if jsonb_typeof(d) is distinct from 'object' or pg_column_size(d) > 6000 then return false; end if;
  for k, v in select * from jsonb_each(d) loop
    if k not in ('volume', 'price', 'share', 'market', 'asin', 'cm', 'term', 'allppc', 'pl') then return false; end if;
    if jsonb_typeof(v) = 'number' then
      if (v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 1e12 then return false; end if;
    elsif jsonb_typeof(v) = 'object' then
      for k2, v2 in select * from jsonb_each(v) loop
        if jsonb_typeof(v2) = 'number' then
          if k2 not in ('imp', 'clicks', 'orders', 'spend', 'sales', 'click', 'purchase', 'market', 'asin') then return false; end if;
          if (v2 #>> '{}')::numeric < 0 or (v2 #>> '{}')::numeric > 1e12 then return false; end if;
        elsif jsonb_typeof(v2) = 'object' then
          if k <> 'pl' or k2 not in ('top', 'rest', 'product', 'business', 'other') then return false; end if;
          for k3, v3 in select * from jsonb_each(v2) loop
            if k3 not in ('imp', 'clicks', 'orders', 'spend') or jsonb_typeof(v3) <> 'number' then return false; end if;
            if (v3 #>> '{}')::numeric < 0 or (v3 #>> '{}')::numeric > 1e12 then return false; end if;
          end loop;
        elsif jsonb_typeof(v2) <> 'null' then return false;
        end if;
      end loop;
    elsif jsonb_typeof(v) <> 'null' then return false;
    end if;
  end loop;
  return true;
end $$;

-- row cap per parent: sqp_cap(<parent column>, <max rows>). Only fires on real inserts (the functions below never upsert blindly).
create function public.sqp_cap() returns trigger
language plpgsql set search_path = '' as $$
declare n int;
begin
  execute format('select count(*) from public.%I where %I = $1', tg_table_name, tg_argv[0]) into n using (to_jsonb(new) ->> tg_argv[0])::uuid;
  if n >= tg_argv[1]::int then raise exception 'sqp:limit_%', tg_table_name using errcode = 'P0001'; end if;
  return new;
end $$;

-- ---------------------------------------------------------------- tables
create table public.sqp_settings (
  user_id         uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  consent_version int not null check (consent_version >= 1),
  consented_at    timestamptz not null default now()
);

create table public.sqp_brands (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (user_id, name), unique (id, user_id)
);
create table public.sqp_asins (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  brand_id   uuid not null,
  asin       text not null check (asin ~ '^[A-Z0-9]{10}$'),
  label      text check (length(label) <= 80),
  created_at timestamptz not null default now(),
  unique (brand_id, asin), unique (id, user_id),
  foreign key (brand_id, user_id) references public.sqp_brands (id, user_id) on delete cascade
);
create table public.sqp_keywords (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  asin_id    uuid not null,
  query      text not null check (length(query) between 1 and 200 and query = lower(btrim(query))),
  display    text check (length(display) <= 200),
  ranking    jsonb not null default '[]' check (jsonb_typeof(ranking) = 'array' and jsonb_array_length(ranking) <= 10 and pg_column_size(ranking) <= 2000),
  created_at timestamptz not null default now(),
  unique (asin_id, query), unique (id, user_id),
  foreign key (asin_id, user_id) references public.sqp_asins (id, user_id) on delete cascade
);
create table public.sqp_periods (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  asin_id     uuid not null,
  cadence     text not null check (cadence in ('weekly', 'monthly')),
  period_from date not null,
  period_to   date not null check (period_to >= period_from and period_to - period_from < 32),
  pulled_at   timestamptz,
  saved_at    timestamptz not null default now(),
  unique (asin_id, cadence, period_from), unique (id, user_id),
  foreign key (asin_id, user_id) references public.sqp_asins (id, user_id) on delete cascade
);
create table public.sqp_metrics (
  period_id  uuid not null,
  keyword_id uuid not null,
  user_id    uuid not null default auth.uid(),
  data       jsonb not null check (public.sqp_valid(data)),
  primary key (period_id, keyword_id),
  foreign key (period_id, user_id) references public.sqp_periods (id, user_id) on delete cascade,
  foreign key (keyword_id, user_id) references public.sqp_keywords (id, user_id) on delete cascade
);

create trigger cap before insert on public.sqp_brands   for each row execute function public.sqp_cap('user_id', '10');
create trigger cap before insert on public.sqp_asins    for each row execute function public.sqp_cap('brand_id', '30');
create trigger cap before insert on public.sqp_keywords for each row execute function public.sqp_cap('asin_id', '50');
create trigger cap before insert on public.sqp_periods  for each row execute function public.sqp_cap('asin_id', '40');
create trigger cap before insert on public.sqp_metrics  for each row execute function public.sqp_cap('period_id', '50');

-- ---------------------------------------------------------------- RLS: owner AND pro plan
do $$
declare t text;
begin
  foreach t in array array['sqp_settings', 'sqp_brands', 'sqp_asins', 'sqp_keywords', 'sqp_periods', 'sqp_metrics'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
    execute format('create policy "own rows, pro plan" on public.%I for all to authenticated using (user_id = (select auth.uid()) and public.is_pro()) with check (user_id = (select auth.uid()) and public.is_pro())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- functions (SECURITY INVOKER: RLS applies)
create function public.sqp_consent(p_version int) returns void
language plpgsql set search_path = '' as $$
begin
  insert into public.sqp_settings (consent_version) values (p_version)
  on conflict (user_id) do update set consent_version = excluded.consent_version, consented_at = now();
end $$;

create function public.sqp_state() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'consent', (select max(consent_version) from public.sqp_settings),
    'brands', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'asins', coalesce((
        select jsonb_agg(jsonb_build_object('id', a.id, 'asin', a.asin, 'label', a.label,
          'keywords', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'query', k.query, 'display', k.display, 'ranking', k.ranking) order by k.query) from public.sqp_keywords k where k.asin_id = a.id), '[]'::jsonb),
          'periods', coalesce((select jsonb_agg(jsonb_build_object('cadence', p.cadence, 'from', p.period_from, 'to', p.period_to, 'pulled', p.pulled_at) order by p.period_from) from public.sqp_periods p where p.asin_id = a.id), '[]'::jsonb))
          order by a.asin) from public.sqp_asins a where a.brand_id = b.id), '[]'::jsonb)) order by b.name) from public.sqp_brands b), '[]'::jsonb))
$$;

-- p = { brand | brand_id, asin, label?, cadence, from, to, pulled?, keywords: [{ query, display?, ranking?, data }] }
create function public.sqp_save_period(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_brand uuid; v_asin uuid; v_period uuid; v_kw uuid; k jsonb; v_query text;
  v_cadence text := p ->> 'cadence'; v_from date := (p ->> 'from')::date; v_to date := (p ->> 'to')::date;
  v_replaced boolean := false; v_pruned int := 0; v_n int := 0; v_kept boolean;
begin
  if not exists (select 1 from public.sqp_settings where consent_version >= 1) then raise exception 'sqp:consent_required' using errcode = 'P0001'; end if;
  if jsonb_typeof(p -> 'keywords') is distinct from 'array' or jsonb_array_length(p -> 'keywords') > 50 then raise exception 'sqp:invalid' using errcode = 'P0001'; end if;
  if v_cadence is null or v_from is null or v_to is null or (p ->> 'asin') is null or (p ->> 'asin') !~ '^[A-Za-z0-9]{10}$' then raise exception 'sqp:invalid' using errcode = 'P0001'; end if;

  if p ->> 'brand_id' is not null then
    select id into v_brand from public.sqp_brands where id = (p ->> 'brand_id')::uuid;
    if v_brand is null then raise exception 'sqp:brand_not_found' using errcode = 'P0001'; end if;
  else
    if btrim(coalesce(p ->> 'brand', '')) = '' then raise exception 'sqp:invalid' using errcode = 'P0001'; end if;
    select id into v_brand from public.sqp_brands where name = btrim(p ->> 'brand');
    if v_brand is null then insert into public.sqp_brands (name) values (btrim(p ->> 'brand')) returning id into v_brand; end if;
  end if;

  select id into v_asin from public.sqp_asins where brand_id = v_brand and asin = upper(p ->> 'asin');
  if v_asin is null then insert into public.sqp_asins (brand_id, asin, label) values (v_brand, upper(p ->> 'asin'), left(p ->> 'label', 80)) returning id into v_asin; end if;

  select id into v_period from public.sqp_periods where asin_id = v_asin and cadence = v_cadence and period_from = v_from;
  if v_period is null then
    insert into public.sqp_periods (asin_id, cadence, period_from, period_to, pulled_at) values (v_asin, v_cadence, v_from, v_to, (p ->> 'pulled')::timestamptz) returning id into v_period;
  else
    v_replaced := true;
    update public.sqp_periods set period_to = v_to, pulled_at = (p ->> 'pulled')::timestamptz, saved_at = now() where id = v_period;
    delete from public.sqp_metrics where period_id = v_period;
  end if;

  for k in select * from jsonb_array_elements(p -> 'keywords') loop
    v_query := lower(btrim(k ->> 'query'));
    select id into v_kw from public.sqp_keywords where asin_id = v_asin and query = v_query;
    if v_kw is null then
      insert into public.sqp_keywords (asin_id, query, display, ranking) values (v_asin, v_query, left(coalesce(k ->> 'display', v_query), 200), coalesce(k -> 'ranking', '[]'::jsonb)) returning id into v_kw;
    else
      update public.sqp_keywords set display = left(coalesce(k ->> 'display', v_query), 200), ranking = coalesce(k -> 'ranking', '[]'::jsonb) where id = v_kw;
    end if;
    insert into public.sqp_metrics (period_id, keyword_id, data) values (v_period, v_kw, k -> 'data');
    v_n := v_n + 1;
  end loop;

  -- retention: keep the newest 13 periods per ASIN and cadence
  with doomed as (select id from public.sqp_periods where asin_id = v_asin and cadence = v_cadence order by period_from desc offset 13)
  delete from public.sqp_periods where id in (select id from doomed);
  get diagnostics v_pruned = row_count;
  v_kept := exists (select 1 from public.sqp_periods where id = v_period);
  return jsonb_build_object('brand_id', v_brand, 'asin_id', v_asin, 'period_id', v_period, 'replaced', v_replaced, 'saved_keywords', v_n, 'pruned', v_pruned, 'kept', v_kept);
end $$;

create function public.sqp_history(p_asin uuid, p_cadence text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'periods', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'from', period_from, 'to', period_to, 'pulled', pulled_at) order by period_from) from public.sqp_periods where asin_id = p_asin and cadence = p_cadence), '[]'::jsonb),
    'keywords', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'query', query, 'display', display, 'ranking', ranking) order by query) from public.sqp_keywords where asin_id = p_asin), '[]'::jsonb),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('p', m.period_id, 'k', m.keyword_id, 'd', m.data)) from public.sqp_metrics m join public.sqp_periods pe on pe.id = m.period_id where pe.asin_id = p_asin and pe.cadence = p_cadence), '[]'::jsonb))
$$;

create function public.sqp_delete(p_kind text, p_id uuid) returns int
language plpgsql set search_path = '' as $$
declare n int;
begin
  if p_kind = 'brand' then delete from public.sqp_brands where id = p_id;
  elsif p_kind = 'asin' then delete from public.sqp_asins where id = p_id;
  elsif p_kind = 'keyword' then delete from public.sqp_keywords where id = p_id;
  elsif p_kind = 'period' then delete from public.sqp_periods where id = p_id;
  else raise exception 'sqp:invalid' using errcode = 'P0001';
  end if;
  get diagnostics n = row_count; return n;
end $$;

create function public.sqp_delete_all() returns int
language plpgsql set search_path = '' as $$
declare n int;
begin
  delete from public.sqp_brands; get diagnostics n = row_count;   -- cascades to asins, keywords, periods, metrics
  delete from public.sqp_settings;
  return n;
end $$;

create function public.sqp_export() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('exported_at', now(), 'state', public.sqp_state(),
    'metrics', coalesce((select jsonb_agg(jsonb_build_object('asin_id', pe.asin_id, 'cadence', pe.cadence, 'from', pe.period_from, 'to', pe.period_to, 'pulled', pe.pulled_at, 'keyword_id', m.keyword_id, 'data', m.data) order by pe.asin_id, pe.cadence, pe.period_from)
      from public.sqp_metrics m join public.sqp_periods pe on pe.id = m.period_id), '[]'::jsonb))
$$;

-- ---------------------------------------------------------------- execute rights: signed-in users only
revoke all on function public.sqp_cap() from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['public.is_pro()', 'public.sqp_valid(jsonb)', 'public.sqp_consent(int)', 'public.sqp_state()', 'public.sqp_save_period(jsonb)', 'public.sqp_history(uuid,text)', 'public.sqp_delete(text,uuid)', 'public.sqp_delete_all()', 'public.sqp_export()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
