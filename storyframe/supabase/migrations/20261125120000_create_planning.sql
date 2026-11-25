-- Phase 5: planning evidence and model health.
--
-- Planning runs on the same owner-scoped child tables Phase 2 created. This
-- migration adds only what the planning contract needs:
--   * the supplied source excerpt a factual claim must quote verbatim,
--   * the verbatim supporting quote stored with a claim,
--   * which planning route and project version produced a proposal,
--   * a global, service-role-only health row per model so the registry can
--     report a real "last successful check" instead of a claim from its name.

alter table public.sources
  add column if not exists excerpt text
  check (excerpt is null or char_length(excerpt) <= 4000);

alter table public.claims
  add column if not exists supporting_quote text
  check (supporting_quote is null or char_length(supporting_quote) <= 4000);

alter table public.generation_proposals
  add column if not exists route text not null default 'legacy'
  check (route in ('angles', 'script', 'storyboard', 'ad-concept', 'transcript-analysis', 'legacy'));

alter table public.generation_proposals
  add column if not exists base_version integer not null default 1
  check (base_version >= 1);

create table if not exists public.model_health (
  model_id text primary key check (char_length(model_id) between 1 and 120),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 80),
  success_count integer not null default 0 check (success_count >= 0),
  failure_count integer not null default 0 check (failure_count >= 0),
  updated_at timestamptz not null default now()
);

-- Registry health is global server state, not tenant data: no authenticated
-- policy and no browser grant. The status route reads it with the service role.
alter table public.model_health enable row level security;
revoke all on public.model_health from anon, authenticated;
grant select, insert, update, delete on public.model_health to service_role;
