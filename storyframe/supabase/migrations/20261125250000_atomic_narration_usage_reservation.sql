-- Phase 8 follow-up: make the Deepgram guard atomic across server instances.
--
-- The previous guard read the rolling total and then inserted a row. Two
-- processes could both pass that read before either inserted, overspending the
-- account's budget. This function performs the check and insertion in one
-- transaction under a per-owner advisory lock. PostgREST runs an RPC in a
-- transaction, so the lock covers exactly the check-plus-insert and is released
-- before the provider call.

create or replace function public.reserve_narration_usage(
  p_owner_id uuid,
  p_project_id uuid,
  p_kind text,
  p_characters integer,
  p_cost_usd numeric,
  p_rate_version text,
  p_character_limit integer,
  p_usd_limit numeric,
  p_window_seconds integer
) returns table (
  usage_id uuid,
  allowed boolean,
  characters_used integer,
  spent_usd numeric,
  oldest_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_characters integer;
  v_spent numeric;
  v_oldest timestamptz;
  v_id uuid;
begin
  if p_kind not in ('preview', 'generation') then
    raise exception 'unknown narration usage kind: %', p_kind using errcode = '23514';
  end if;
  if p_characters < 0 or p_cost_usd < 0 then
    raise exception 'narration usage values must be non-negative' using errcode = '23514';
  end if;

  -- One lock per account. Concurrent reservations for the same owner wait
  -- here, then see the prior row in their total.
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 0));

  select coalesce(sum(characters), 0)::integer,
         coalesce(sum(cost_usd), 0),
         min(created_at)
    into v_characters, v_spent, v_oldest
    from public.narration_usage
   where owner_id = p_owner_id
     and created_at >= now() - make_interval(secs => greatest(0, p_window_seconds));

  if p_character_limit > 0 and v_characters + p_characters > p_character_limit then
    return query select null::uuid, false, v_characters, v_spent, v_oldest;
    return;
  end if;
  if p_usd_limit > 0 and v_spent + p_cost_usd > p_usd_limit then
    return query select null::uuid, false, v_characters, v_spent, v_oldest;
    return;
  end if;

  insert into public.narration_usage
    (owner_id, project_id, kind, status, characters, cost_usd, rate_version)
  values
    (p_owner_id, p_project_id, p_kind, 'pending', p_characters, p_cost_usd, p_rate_version)
  returning id into v_id;

  return query
    select v_id, true, v_characters + p_characters, v_spent + p_cost_usd,
           coalesce(v_oldest, now());
end;
$$;

revoke all on function public.reserve_narration_usage(
  uuid, uuid, text, integer, numeric, text, integer, numeric, integer
) from public, anon, authenticated;
grant execute on function public.reserve_narration_usage(
  uuid, uuid, text, integer, numeric, text, integer, numeric, integer
) to service_role;
