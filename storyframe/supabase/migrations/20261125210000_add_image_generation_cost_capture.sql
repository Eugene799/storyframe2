-- Phase 7: record what a generation actually cost, not only its estimate.
--
-- Cloudflare reports neurons in result.usage; the USD value is derived at the
-- catalog's verified rate (`rate`). A provider that reports a dollar cost
-- directly uses `provider`; API credits that cannot be converted use `credits`.
-- The image spending guard prefers actual_usd over estimated_usd.

alter table public.image_generations
  add column if not exists actual_neurons numeric(12, 4),
  add column if not exists actual_usd numeric(12, 6),
  add column if not exists cost_source text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'image_generations_cost_source_check'
  ) then
    alter table public.image_generations
      add constraint image_generations_cost_source_check
      check (cost_source is null or cost_source in ('provider', 'rate', 'credits'));
  end if;
end $$;
