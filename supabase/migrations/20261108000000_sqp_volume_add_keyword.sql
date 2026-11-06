-- SQP Tracker, two additions:
--  1. the Helium 10 search volume next to the SQP one: stored inside the existing "rank" object as "volume" (a number, like the
--     other rank leaves). Only sqp_valid changes (same shape check, plus this one known leaf).
--  2. sqp_add_keyword: start tracking a keyword for an ASIN without uploading anything. It creates the keyword row (no history yet);
--     later saves and the manual numbers fill it. An existing keyword is returned as it is. SECURITY INVOKER like the other functions:
--     row security (own rows, Pro plan) decides which ASIN is visible, and the cap of 50 keywords per ASIN still applies.
create or replace function public.sqp_valid(d jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb; k2 text; v2 jsonb; k3 text; v3 jsonb;
begin
  if jsonb_typeof(d) is distinct from 'object' or pg_column_size(d) > 6000 then return false; end if;
  for k, v in select * from jsonb_each(d) loop
    if k not in ('volume', 'price', 'share', 'market', 'asin', 'cm', 'term', 'allppc', 'pl', 'rank', 'manual') then return false; end if;
    if jsonb_typeof(v) = 'number' then
      if (v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 1e12 then return false; end if;
    elsif jsonb_typeof(v) = 'object' then
      for k2, v2 in select * from jsonb_each(v) loop
        if jsonb_typeof(v2) = 'number' then
          if k = 'rank' then
            if k2 not in ('organic', 'sponsored', 'date', 'volume') then return false; end if;
          elsif k = 'manual' then
            if k2 not in ('clicks', 'orders') then return false; end if;
          elsif k2 not in ('imp', 'clicks', 'orders', 'spend', 'sales', 'click', 'purchase', 'market', 'asin') then return false;
          end if;
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

create function public.sqp_add_keyword(p_asin uuid, p_query text) returns jsonb
language plpgsql set search_path = '' as $$
declare v_q text := btrim(regexp_replace(lower(coalesce(p_query, '')), '[+"“”\s]+', ' ', 'g')); v_id uuid;
begin
  if v_q = '' or length(v_q) > 200 or v_q like 'campaign:%' then raise exception 'sqp:invalid' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.sqp_asins where id = p_asin) then raise exception 'sqp:not_found' using errcode = 'P0001'; end if;
  select id into v_id from public.sqp_keywords where asin_id = p_asin and query = v_q;
  if v_id is null then insert into public.sqp_keywords (asin_id, query, display, ranking) values (p_asin, v_q, v_q, '[]'::jsonb) returning id into v_id; end if;
  return jsonb_build_object('id', v_id, 'query', v_q);
end $$;

revoke all on function public.sqp_add_keyword(uuid, text) from public, anon, authenticated;
grant execute on function public.sqp_add_keyword(uuid, text) to authenticated;
