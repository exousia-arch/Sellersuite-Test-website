-- SQP Tracker: edit a saved period afterwards. Add, change or clear the manual Campaign Manager numbers (clicks, orders)
-- of one keyword or campaign in one saved week or month, without uploading the files again.
--  * a saved row: the manual numbers are set inside its data (everything else stays);
--  * a week where that keyword or campaign has no saved row: a manual-only row is created (data = {"manual": {...}});
--  * both numbers null: the manual numbers are removed, and a row left with nothing else is removed too.
-- SECURITY INVOKER like the other functions: row security (own rows, Pro plan) decides what is visible, so another
-- user's or a non-Pro caller's period and keyword simply are not found. The data check (sqp_valid) and the row cap
-- per period still apply to the write.
create function public.sqp_set_manual(p_period uuid, p_keyword uuid, p_clicks numeric, p_orders numeric) returns jsonb
language plpgsql set search_path = '' as $$
declare v_pa uuid; v_ka uuid; v_data jsonb;
begin
  select asin_id into v_pa from public.sqp_periods where id = p_period;
  select asin_id into v_ka from public.sqp_keywords where id = p_keyword;
  if v_pa is null or v_ka is null or v_pa <> v_ka then raise exception 'sqp:not_found' using errcode = 'P0001'; end if;
  if (p_clicks is null) <> (p_orders is null) then raise exception 'sqp:invalid' using errcode = 'P0001'; end if;
  select data into v_data from public.sqp_metrics where period_id = p_period and keyword_id = p_keyword;

  if p_clicks is null then                                   -- clear
    if v_data is null then return jsonb_build_object('changed', false); end if;
    v_data := v_data - 'manual';
    if v_data = '{}'::jsonb then delete from public.sqp_metrics where period_id = p_period and keyword_id = p_keyword;
    else update public.sqp_metrics set data = v_data where period_id = p_period and keyword_id = p_keyword;
    end if;
    return jsonb_build_object('changed', true);
  end if;

  v_data := coalesce(v_data, '{}'::jsonb) || jsonb_build_object('manual', jsonb_build_object('clicks', p_clicks, 'orders', p_orders));
  if exists (select 1 from public.sqp_metrics where period_id = p_period and keyword_id = p_keyword) then
    update public.sqp_metrics set data = v_data where period_id = p_period and keyword_id = p_keyword;
  else
    insert into public.sqp_metrics (period_id, keyword_id, data) values (p_period, p_keyword, v_data);
  end if;
  return jsonb_build_object('changed', true);
end $$;

revoke all on function public.sqp_set_manual(uuid, uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.sqp_set_manual(uuid, uuid, numeric, numeric) to authenticated;
