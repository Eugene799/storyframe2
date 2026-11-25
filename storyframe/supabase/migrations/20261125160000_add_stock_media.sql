-- Phase 6: stock search cache and imported-asset provenance.
--
-- stock_search_cache is a durable, shared cache of normalized provider pages.
-- It is server-only: results are shared across accounts, and the provider API
-- keys are held by the server. Pixabay requires results to be cached for 24
-- hours, so the store's TTL is enforced in the server and bounded here.
--
-- media_metadata.provenance records the provider, creator, source page, and
-- license of an imported stock asset. It is validated JSONB (an object, never a
-- scalar or array) so a credit cannot be stored as unreadable data.

alter table public.media_metadata
  add column if not exists provenance jsonb;

do $$
begin
  alter table public.media_metadata
    add constraint media_metadata_provenance_object
    check (provenance is null or jsonb_typeof(provenance) = 'object');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.stock_search_cache (
  cache_key text primary key,
  provider text not null check (provider in ('pexels', 'pixabay')),
  query_text text not null check (char_length(query_text) between 1 and 200),
  media_type text not null check (media_type in ('image', 'video')),
  page integer not null check (page between 1 and 50),
  status text not null default 'pending' check (status in ('pending', 'ready')),
  payload jsonb,
  payload_bytes integer not null default 0 check (payload_bytes >= 0),
  -- A pending row holds a short lease so exactly one request fetches the page.
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists stock_search_cache_expiry_idx
  on public.stock_search_cache (expires_at);

-- The cache is shared across accounts and written only by the service role.
-- No policy grants authenticated or anon access.
do $$
begin
  alter table public.stock_search_cache enable row level security;
  revoke all on public.stock_search_cache from anon, authenticated;
  grant select, insert, update, delete on public.stock_search_cache to service_role;
end $$;
