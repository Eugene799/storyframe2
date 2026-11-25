-- Phase 5: one live planning attempt per project, across tabs and devices.
--
-- `project_id` is null for connection tests and historical usage rows. The
-- partial unique index is the server-side backstop: even if two devices pass
-- the preflight at the same instant, only one pending planning reservation can
-- exist for a project. The owner still reads their usage through the existing
-- row-level policy.

alter table public.ai_usage
  add column if not exists project_id uuid references public.projects (id) on delete set null;

create unique index if not exists ai_usage_one_pending_project_idx
  on public.ai_usage (project_id)
  where project_id is not null and status = 'pending';
