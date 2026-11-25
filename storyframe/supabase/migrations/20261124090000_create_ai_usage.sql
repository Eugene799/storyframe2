-- Phase 2: durable AI usage ledger.
--
-- Apply with the Supabase SQL editor or your normal migration pipeline.
-- The application writes with the service role and stores the user id from the
-- verified access token. Authenticated users may only read their own rows.

create table if not exists public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  model_id text not null,
  configured_model text not null,
  returned_model text,
  prompt_eval_count integer check (prompt_eval_count is null or prompt_eval_count >= 0),
  eval_count integer check (eval_count is null or eval_count >= 0),
  latency_ms integer not null check (latency_ms >= 0),
  status text not null check (status in ('success', 'error')),
  error_code text,
  upstream_status integer,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_user_created_idx
  on public.ai_usage (user_id, created_at desc);

alter table public.ai_usage enable row level security;

drop policy if exists "ai_usage_select_own" on public.ai_usage;
create policy "ai_usage_select_own"
  on public.ai_usage
  for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.ai_usage from anon, authenticated;
grant select on public.ai_usage to authenticated;
grant select, insert on public.ai_usage to service_role;
