-- Phase 3: private R2 media storage.
--
-- media_metadata already holds the private object key, content type, byte size,
-- and ownership. This migration adds the upload/completion timestamps and the
-- reference table that makes deletion safe: an object is removed only after its
-- last reference is released.
--
-- The bucket itself stays private. No policy grants direct bucket access; the
-- server issues short-lived presigned URLs after verifying the session.

alter table public.media_metadata
  add column if not exists upload_expires_at timestamptz,
  add column if not exists ready_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists media_metadata_owner_status_idx
  on public.media_metadata (owner_id, status);

create index if not exists media_metadata_pending_idx
  on public.media_metadata (status, upload_expires_at);

create table if not exists public.media_references (
  id uuid primary key default gen_random_uuid(),
  media_id uuid not null references public.media_metadata (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- Polymorphic reference: a scene key, a render snapshot id, the project
  -- document, or another consumer. The unique key makes attaching idempotent.
  ref_kind text not null check (ref_kind in ('scene', 'render', 'document', 'other')),
  ref_id text not null check (char_length(ref_id) between 1 and 128),
  created_at timestamptz not null default now(),
  unique (media_id, ref_kind, ref_id)
);

create index if not exists media_references_media_idx
  on public.media_references (media_id);

-- Same ownership shape as the other child tables: reads are owner-scoped, and
-- every write goes through the server's service role.
do $$
begin
  alter table public.media_references enable row level security;
  drop policy if exists media_references_select_own on public.media_references;
  create policy media_references_select_own
    on public.media_references
    for select
    to authenticated
    using (auth.uid() = owner_id);
  revoke all on public.media_references from anon, authenticated;
  grant select on public.media_references to authenticated;
  grant select, insert, update, delete on public.media_references to service_role;
end $$;
