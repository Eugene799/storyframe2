-- Phase 2: versioned projects and their revision history.
--
-- Apply with the Supabase SQL editor or your normal migration pipeline.
-- The application writes with the service role and derives owner_id from the
-- verified access token. Authenticated users may only read their own rows.

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  project_type text not null check (project_type in ('story', 'product-ad', 'repurpose')),
  title text not null check (char_length(title) between 1 and 200),
  -- Version of the JSON document shape, not of the row.
  schema_version integer not null check (schema_version between 1 and 1000),
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  -- Optimistic concurrency token: every accepted write increments it.
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_owner_updated_idx
  on public.projects (owner_id, updated_at desc);

create table if not exists public.project_revisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  revision integer not null check (revision >= 1),
  schema_version integer not null check (schema_version between 1 and 1000),
  title text not null,
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  created_at timestamptz not null default now(),
  unique (project_id, revision)
);

create index if not exists project_revisions_project_idx
  on public.project_revisions (project_id, revision desc);

-- History is written by the database, in the same transaction as the project
-- row: a saved project can never be left without its revision, and a rejected
-- request cannot append one.
create or replace function public.record_project_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.project_revisions (
    project_id, owner_id, revision, schema_version, title, document, created_at
  )
  values (
    new.id, new.owner_id, new.version, new.schema_version, new.title, new.document, new.updated_at
  );
  return new;
end;
$$;

drop trigger if exists projects_record_revision on public.projects;
create trigger projects_record_revision
  after insert or update of document, title, schema_version on public.projects
  for each row execute function public.record_project_revision();

alter table public.projects enable row level security;
alter table public.project_revisions enable row level security;

drop policy if exists "projects_select_own" on public.projects;
create policy "projects_select_own"
  on public.projects
  for select
  to authenticated
  using (auth.uid() = owner_id);

drop policy if exists "project_revisions_select_own" on public.project_revisions;
create policy "project_revisions_select_own"
  on public.project_revisions
  for select
  to authenticated
  using (auth.uid() = owner_id);

-- Writes stay server-side: the browser cannot bypass document validation or the
-- explicit owner check by calling PostgREST with its own token.
revoke all on public.projects from anon, authenticated;
revoke all on public.project_revisions from anon, authenticated;
grant select on public.projects to authenticated;
grant select on public.project_revisions to authenticated;
grant select, insert, update, delete on public.projects to service_role;
grant select, insert on public.project_revisions to service_role;
