-- Phases 9 through 22 and Discover Ideas (Phases D1-D6) schema extensions.
-- All tables enforce strict Row Level Security and service_role access.

create table if not exists public.render_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_version integer not null check (project_version >= 1),
  status text not null check (status in ('queued', 'submitted', 'rendering', 'downloading', 'ready', 'failed')),
  aspect_ratio text not null default '9:16' check (aspect_ratio in ('9:16', '1:1', '16:9')),
  provider_job_id text,
  idempotency_key text,
  snapshot_fingerprint text not null,
  snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(snapshot) = 'object'),
  output_media_id uuid references public.media_metadata(id) on delete set null,
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  byte_size bigint check (byte_size is null or byte_size >= 0),
  estimated_cost_usd numeric(10, 4) not null default 0 check (estimated_cost_usd >= 0),
  settled_cost_usd numeric(10, 4) check (settled_cost_usd is null or settled_cost_usd >= 0),
  attempts integer not null default 1 check (attempts >= 1),
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index if not exists render_jobs_owner_idempotency_idx
  on public.render_jobs(owner_id, idempotency_key)
  where idempotency_key is not null;

create table if not exists public.workflow_artifacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  artifact_kind text not null check (
    artifact_kind in (
      'continuity_notes',
      'product_catalog',
      'ad_campaign',
      'ad_variant',
      'repurpose_ingest',
      'repurpose_transcript',
      'repurpose_clip',
      'scoped_edit_plan',
      'cost_ledger_entry',
      'user_entitlement',
      'workspace_member',
      'project_comment',
      'fingerprint_approval',
      'brand_recipe',
      'format_layout',
      'project_chapter',
      'project_localization',
      'publishing_job',
      'api_credential',
      'project_template',
      'dr_drill',
      'discovery_preferences',
      'trend_evidence_cache',
      'discovery_idea',
      'discovery_event'
    )
  ),
  status text not null default 'active',
  fingerprint text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workflow_artifacts_owner_kind_idx
  on public.workflow_artifacts(owner_id, artifact_kind);

create index if not exists workflow_artifacts_project_kind_idx
  on public.workflow_artifacts(project_id, artifact_kind);

alter table public.render_jobs enable row level security;
alter table public.workflow_artifacts enable row level security;

revoke all on public.render_jobs from anon, authenticated;
revoke all on public.workflow_artifacts from anon, authenticated;

grant all on public.render_jobs to service_role;
grant all on public.workflow_artifacts to service_role;
