-- Preserve the Deepgram spending ledger when a project is deleted.
--
-- A project row is disposable; the account's rolling spend is not. Cascading
-- the ledger away with the project would reset the guard for the rest of the
-- window. Keep the usage row, clear only its project reference, and let the
-- account deletion cascade remove it when the owner is actually deleted.

alter table public.narration_usage
  alter column project_id drop not null;

alter table public.narration_usage
  drop constraint if exists narration_usage_project_id_fkey;

alter table public.narration_usage
  add constraint narration_usage_project_id_fkey
  foreign key (project_id) references public.projects(id)
  on delete set null;
