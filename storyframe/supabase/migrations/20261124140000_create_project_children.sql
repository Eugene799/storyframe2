-- Phase 2: project child data.
--
-- Scenes, media metadata, sources, claims, generation proposals, provider jobs,
-- and render snapshots. Same ownership pattern as projects: every table carries
-- owner_id from the verified session, the server writes with the service role,
-- and authenticated users may only select their own rows.
--
-- The project document keeps the editable scene text; these rows are the
-- addressable form (stable scene_key) that media and generation attach to.

create table if not exists public.scenes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- Scene id from the project document, so other rows can address a scene
  -- without rewriting the versioned document.
  scene_key text not null check (char_length(scene_key) between 1 and 64),
  position integer not null check (position >= 0),
  heading text not null check (char_length(heading) <= 200),
  body text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, scene_key)
);

create table if not exists public.media_metadata (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  scene_key text,
  kind text not null check (kind in ('image', 'audio', 'video')),
  -- Private object name in the media bucket. Ownership lives in owner_id, never
  -- in the key; the key is only a storage address.
  object_key text not null check (char_length(object_key) between 1 and 512),
  content_type text not null check (char_length(content_type) between 1 and 120),
  byte_size bigint not null check (byte_size >= 0),
  status text not null default 'pending' check (status in ('pending', 'ready', 'deleted')),
  created_at timestamptz not null default now(),
  unique (object_key)
);

create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('web', 'document', 'interview', 'other')),
  title text not null check (char_length(title) between 1 and 300),
  url text check (url is null or char_length(url) <= 2048),
  retrieved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.claims (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  source_id uuid references public.sources (id) on delete set null,
  scene_key text,
  statement text not null check (char_length(statement) between 1 and 2000),
  status text not null default 'unverified' check (status in ('unverified', 'supported', 'contradicted')),
  created_at timestamptz not null default now()
);

create table if not exists public.generation_proposals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  scene_key text,
  model_id text not null check (char_length(model_id) between 1 and 120),
  prompt text not null check (char_length(prompt) between 1 and 4000),
  status text not null default 'proposed' check (status in ('proposed', 'accepted', 'rejected')),
  proposal jsonb not null check (jsonb_typeof(proposal) = 'object'),
  created_at timestamptz not null default now()
);

create table if not exists public.provider_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 64),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  external_id text check (external_id is null or char_length(external_id) <= 200),
  request jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.render_snapshots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- A snapshot always points at a revision that really exists.
  project_revision integer not null check (project_revision >= 1),
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  output_key text check (output_key is null or char_length(output_key) <= 512),
  created_at timestamptz not null default now(),
  foreign key (project_id, project_revision)
    references public.project_revisions (project_id, revision) on delete cascade
);

create index if not exists scenes_project_idx on public.scenes (project_id, position);
create index if not exists media_metadata_project_idx on public.media_metadata (project_id);
create index if not exists sources_project_idx on public.sources (project_id);
create index if not exists claims_project_idx on public.claims (project_id);
create index if not exists claims_source_idx on public.claims (source_id);
create index if not exists generation_proposals_project_idx on public.generation_proposals (project_id);
create index if not exists provider_jobs_project_idx on public.provider_jobs (project_id);
create index if not exists render_snapshots_project_idx on public.render_snapshots (project_id);

-- One policy shape for every child table, so no table can drift from the
-- ownership pattern by accident.
do $$
declare
  target text;
begin
  foreach target in array array[
    'scenes',
    'media_metadata',
    'sources',
    'claims',
    'generation_proposals',
    'provider_jobs',
    'render_snapshots'
  ] loop
    execute format('alter table public.%I enable row level security', target);
    execute format('drop policy if exists %I on public.%I', target || '_select_own', target);
    execute format(
      'create policy %I on public.%I for select to authenticated using (auth.uid() = owner_id)',
      target || '_select_own',
      target
    );
    execute format('revoke all on public.%I from anon, authenticated', target);
    execute format('grant select on public.%I to authenticated', target);
    execute format('grant select, insert, update, delete on public.%I to service_role', target);
  end loop;
end $$;
