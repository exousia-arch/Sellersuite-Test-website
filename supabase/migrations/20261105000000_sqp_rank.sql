-- SQP Tracker: an optional organic / sponsored rank per keyword and period (from a Helium 10 Cerebro report).
-- Stored inside the existing sqp_metrics.data as  "rank": {"organic": n, "sponsored": n, "date": yyyymmdd}
-- (organic 0 = not ranked in the first ~300 results; no "rank" key = no Cerebro report for that period).
-- Only sqp_valid changes: it is replaced with the same shape check plus this one known key. Grants and the check
-- constraint on sqp_metrics.data keep working because the function keeps its identity.
create or replace function public.sqp_valid(d jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb; k2 text; v2 jsonb; k3 text; v3 jsonb;
begin
  if jsonb_typeof(d) is distinct from 'object' or pg_column_size(d) > 6000 then return false; end if;
  for k, v in select * from jsonb_each(d) loop
    if k not in ('volume', 'price', 'share', 'market', 'asin', 'cm', 'term', 'allppc', 'pl', 'rank') then return false; end if;
    if jsonb_typeof(v) = 'number' then
      if (v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 1e12 then return false; end if;
    elsif jsonb_typeof(v) = 'object' then
      for k2, v2 in select * from jsonb_each(v) loop
        if jsonb_typeof(v2) = 'number' then
          if k = 'rank' then
            if k2 not in ('organic', 'sponsored', 'date') then return false; end if;
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
