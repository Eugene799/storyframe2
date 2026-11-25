-- Phase 8: spending ledger for Deepgram previews and generations.
--
-- Rows are written before the billable provider call and settled afterwards.
-- Failed attempts remain rows because Deepgram may have processed them; the
-- guard therefore counts every recorded attempt in its rolling window.

create table if not exists public.narration_usage (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null check (kind in ('preview', 'generation')),
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  characters integer not null check (characters >= 0),
  cost_usd numeric(12, 6) not null check (cost_usd >= 0),
  rate_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists narration_usage_owner_created_idx
  on public.narration_usage (owner_id, created_at desc);

do $$
begin
  alter table public.narration_usage enable row level security;
  revoke all on public.narration_usage from anon, authenticated;
  grant select, insert, update, delete on public.narration_usage to service_role;
end $$;
