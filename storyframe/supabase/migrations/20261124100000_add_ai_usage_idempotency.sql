-- Phase 2: idempotent AI test requests.
--
-- A reservation row is inserted before the provider call. The unique key makes
-- a retry return the stored outcome instead of billing the provider again.

alter table public.ai_usage
  add column if not exists idempotency_key text,
  add column if not exists request_hash text,
  add column if not exists response_body jsonb,
  add column if not exists response_status integer;

alter table public.ai_usage drop constraint if exists ai_usage_status_check;
alter table public.ai_usage
  add constraint ai_usage_status_check check (status in ('success', 'error', 'pending'));

create unique index if not exists ai_usage_user_idempotency_key_idx
  on public.ai_usage (user_id, idempotency_key)
  where idempotency_key is not null;

grant update on public.ai_usage to service_role;
