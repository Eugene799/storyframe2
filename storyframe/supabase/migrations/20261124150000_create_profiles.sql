-- Phase 2: per-user profiles (workspace records).
--
-- One profile per verified user, written by the server with the service role.
-- Projects stay owned by auth.users directly: a workspace is 1:1 with its user
-- in Phase 2, so there is no shared workspace to authorise.

create table if not exists public.profiles (
  -- The owner is the key: one workspace row per user, cascading with the account.
  owner_id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) between 1 and 120),
  workspace_name text not null default 'My workspace' check (char_length(workspace_name) between 1 and 120),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = owner_id);

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.profiles to service_role;
