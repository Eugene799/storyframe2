-- Phase 8: persisted narration and music tracks.
--
-- One row per generated or uploaded audio track. A partial unique index keeps
-- one active narration and one active music track per project; replaced and
-- removed rows remain as bounded history until the project is deleted.
-- Media is private R2 storage; this table records only its media id and the
-- settings/fingerprint needed to explain what the audio belongs to.

create table if not exists public.narration_tracks (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null check (kind in ('narration', 'music')),
  source text not null check (source in ('deepgram', 'upload')),
  status text not null default 'active' check (status in ('active', 'replaced', 'removed')),
  media_id uuid references public.media_metadata(id) on delete set null,
  voice_model text,
  voice_name text,
  script_fingerprint text,
  script_characters integer check (script_characters is null or script_characters >= 0),
  duration_seconds numeric(10, 3) check (duration_seconds is null or duration_seconds > 0),
  volume numeric(4, 3) not null default 1 check (volume between 0 and 1),
  muted boolean not null default false,
  cost_usd numeric(12, 6) check (cost_usd is null or cost_usd >= 0),
  cost_rate_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists narration_tracks_one_active_kind_idx
  on public.narration_tracks (owner_id, project_id, kind)
  where status = 'active';

create index if not exists narration_tracks_project_idx
  on public.narration_tracks (owner_id, project_id, created_at desc);

do $$
begin
  alter table public.narration_tracks enable row level security;
  revoke all on public.narration_tracks from anon, authenticated;
  grant select, insert, update, delete on public.narration_tracks to service_role;
end $$;
