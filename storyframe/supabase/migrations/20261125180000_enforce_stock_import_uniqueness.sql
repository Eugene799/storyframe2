-- Phase 6 follow-up: one ready copy per imported stock rendition per project.
--
-- The import route checks for an existing rendition before downloading, but two
-- parallel requests can both pass that check. This partial unique index makes
-- the store the arbiter: the first completion wins, and the loser's completion
-- raises 23505, which the route turns into "reuse the existing media".
--
-- Pending rows are outside the index so concurrent reservations are allowed,
-- and deleted rows are outside it so an asset can be imported again after it
-- was deleted. Existing data is expected to be clean: the route has returned
-- ready-media reuse since 1228054, and the hosted project was checked for
-- duplicate ready groups before this migration was applied.

create unique index if not exists media_metadata_ready_stock_import_key
  on public.media_metadata (
    owner_id,
    project_id,
    (provenance->>'provider'),
    (provenance->>'providerId'),
    (provenance->>'rendition')
  )
  where status = 'ready' and provenance is not null;
