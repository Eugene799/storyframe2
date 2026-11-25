-- Phase 7: one pending image generation per account, across server instances.
--
-- The in-process slot already stops a double submit on one Node process. This
-- partial unique index is the durable backstop: if two instances pass the
-- preflight at the same instant, only one pending row can exist for the owner.
-- A generation that is pending because Leonardo is still working must be
-- refreshed or settled before another one starts, which also bounds spend.

create unique index if not exists image_generations_one_pending_owner_idx
  on public.image_generations (owner_id)
  where status = 'pending';
