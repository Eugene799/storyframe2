import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

/**
 * Applies every migration to a real PostgreSQL engine (PGlite: PostgreSQL
 * compiled to WebAssembly) and asserts the ownership behaviour the server and
 * its tests rely on: the revision trigger, row-level security, write grants,
 * optimistic-concurrency filters, and the cascades.
 *
 * No Supabase project, network, or credentials are involved. This proves the
 * SQL itself; PostgREST behaviour is covered separately by the test fakes.
 */
const MIGRATIONS = [
  "20261124090000_create_ai_usage.sql",
  "20261124100000_add_ai_usage_idempotency.sql",
  "20261124120000_create_projects.sql",
  "20261124140000_create_project_children.sql",
  "20261124150000_create_profiles.sql",
  "20261124160000_create_media_storage.sql",
  "20261125120000_create_planning.sql",
  "20261125140000_add_planning_attempt_preflight.sql",
  "20261125160000_add_stock_media.sql",
  "20261125180000_enforce_stock_import_uniqueness.sql",
  "20261125200000_create_image_generations.sql",
  "20261125210000_add_image_generation_cost_capture.sql",
  "20261125220000_one_pending_image_generation.sql",
  "20261125230000_create_narration_tracks.sql",
  "20261125240000_create_narration_usage.sql",
  "20261125250000_atomic_narration_usage_reservation.sql",
  "20261125260000_preserve_narration_usage_on_project_delete.sql",
  "20261126000000_create_renders_and_studio_workflows.sql",
];
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const PROJECT_A = "44444444-4444-4444-8444-444444444444";
const PROJECT_B = "55555555-5555-4555-8555-555555555555";
const PROJECT_C = "66666666-6666-4666-8666-666666666666";

const DOCUMENT = {
  schemaVersion: 1,
  summary: "A courier finds a letter that was never meant to arrive.",
  scenes: [{ id: "scene-1", heading: "INT. TRAIN CAR - NIGHT", body: "The letter waits under a seat." }],
};
const REVISED_DOCUMENT = { ...DOCUMENT, summary: "The letter was meant for the courier." };

/** One row per child table, keyed to a project. `key` keeps object names unique. */
const CHILD_ROWS = [
  {
    table: "scenes",
    sql: `insert into public.scenes (project_id, owner_id, scene_key, position, heading)
          values ($1, $2, 'scene-1', 0, 'INT. TRAIN CAR - NIGHT')`,
    params: (_key: string) => [],
  },
  {
    table: "media_metadata",
    sql: `insert into public.media_metadata (project_id, owner_id, kind, object_key, content_type, byte_size)
          values ($1, $2, 'image', $3, 'image/png', 1024)`,
    params: (key: string) => [key],
  },
  {
    table: "sources",
    sql: `insert into public.sources (project_id, owner_id, kind, title, url)
          values ($1, $2, 'web', 'A source', 'https://example.com/source')`,
    params: (_key: string) => [],
  },
  {
    table: "claims",
    sql: `insert into public.claims (project_id, owner_id, statement)
          values ($1, $2, 'A claim worth checking')`,
    params: (_key: string) => [],
  },
  {
    table: "generation_proposals",
    sql: `insert into public.generation_proposals (project_id, owner_id, model_id, prompt, proposal)
          values ($1, $2, 'gemma4:31b', 'Write the opening scene', '{"scenes":[]}'::jsonb)`,
    params: (_key: string) => [],
  },
  {
    table: "provider_jobs",
    sql: `insert into public.provider_jobs (project_id, owner_id, provider)
          values ($1, $2, 'json2video')`,
    params: (_key: string) => [],
  },
  {
    table: "render_snapshots",
    sql: `insert into public.render_snapshots (project_id, owner_id, project_revision, output_key)
          values ($1, $2, 1, $3)`,
    params: (key: string) => [key],
  },
];

const results: { name: string; ok: boolean }[] = [];

function check(name: string, condition: unknown, detail = ""): void {
  const ok = Boolean(condition);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        ${detail}`}`);
}

/** `jsonb` reorders keys, so compare documents by content, not by key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const db = new PGlite();

async function as<T extends Record<string, unknown>>(
  role: string,
  sub: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await db.exec(`set role ${role}`);
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [sub ?? ""]);
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

async function count(
  table: string,
  where: string,
  params: unknown[],
  role = "service_role",
  sub: string | null = null,
): Promise<number> {
  const rows = await as<{ n: number }>(role, sub, `select count(*)::int as n from public.${table} where ${where}`, params);
  return rows[0].n;
}

async function errorCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return "NO_ERROR";
  } catch (error) {
    return String((error as { code?: string }).code ?? (error as Error).message);
  }
}

console.log((await db.query<{ version: string }>("select version()")).rows[0].version);

// A Supabase-shaped environment: roles, auth schema, auth.users, auth.uid().
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  insert into auth.users (id) values ('${USER_A}'), ('${USER_B}');
`);

for (const name of MIGRATIONS) {
  await db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  console.log(`applied ${name}`);
}

// 1. Inserting a project writes revision 1 through the trigger.
await as("service_role", null,
  `insert into public.projects (id, owner_id, project_type, title, schema_version, document, version)
   values ($1, $2, 'story', 'The Late Letter', 1, $3::jsonb, 1)`,
  [PROJECT_A, USER_A, JSON.stringify(DOCUMENT)]);
let revisions = await as<Record<string, unknown>>("service_role", null,
  `select owner_id, revision, schema_version, title, document
     from public.project_revisions where project_id = $1`,
  [PROJECT_A]);
check("trigger wrote exactly one revision on insert", revisions.length === 1, JSON.stringify(revisions));
check("revision 1 carries the owner, version and document of the row",
  revisions[0]?.revision === 1 &&
    revisions[0]?.owner_id === USER_A &&
    revisions[0]?.schema_version === 1 &&
    revisions[0]?.title === "The Late Letter" &&
    canonical(revisions[0]?.document) === canonical(DOCUMENT),
  JSON.stringify(revisions[0]));

// 2. RLS: each account reads only its own rows.
check("owner reads their own project row",
  (await as("authenticated", USER_A, "select id from public.projects")).length === 1);
check("another account reads no projects",
  (await as("authenticated", USER_B, "select id from public.projects")).length === 0);
check("another account reads no revisions",
  (await as("authenticated", USER_B, "select id from public.project_revisions")).length === 0);

// 3. RLS plus grants: browsers cannot write, even their own rows.
check("authenticated insert is refused (42501)",
  (await errorCode(() => as("authenticated", USER_A,
    `insert into public.projects (owner_id, project_type, title, schema_version, document)
     values ($1, 'story', 'x', 1, '{}'::jsonb)`, [USER_A]))) === "42501");
check("authenticated update is refused (42501)",
  (await errorCode(() => as("authenticated", USER_A,
    "update public.projects set title = 'hijacked' where id = $1", [PROJECT_A]))) === "42501");
check("authenticated delete is refused (42501)",
  (await errorCode(() => as("authenticated", USER_A,
    "delete from public.projects where id = $1", [PROJECT_A]))) === "42501");
check("anon select is refused (42501)",
  (await errorCode(() => as("anon", "", "select count(*) from public.projects"))) === "42501");

// 4. Conditional update appends revision 2 and leaves revision 1 alone.
const updated = await as<{ version: number }>("service_role", null,
  `update public.projects set title = $2, document = $3::jsonb, schema_version = 1, version = version + 1
   where id = $1 and owner_id = $4 and version = 1 returning version`,
  [PROJECT_A, "The Late Letter (revised)", JSON.stringify(REVISED_DOCUMENT), USER_A]);
check("conditional update matched the row and bumped the version",
  updated.length === 1 && updated[0].version === 2, JSON.stringify(updated));
revisions = await as<Record<string, unknown>>("service_role", null,
  `select revision, title, document from public.project_revisions where project_id = $1 order by revision`,
  [PROJECT_A]);
check("update appended revision 2", revisions.length === 2 && revisions[1]?.revision === 2, JSON.stringify(revisions));
check("revision 1 keeps the original document",
  canonical(revisions[0]?.document) === canonical(DOCUMENT), JSON.stringify(revisions[0]));
check("revision 2 holds the revised document",
  revisions[1]?.title === "The Late Letter (revised)" &&
    canonical(revisions[1]?.document) === canonical(REVISED_DOCUMENT), JSON.stringify(revisions[1]));

// 5. A stale version writes nothing (the store's conflict path).
const stale = await as("service_role", null,
  `update public.projects set title = 'stale', version = version + 1
   where id = $1 and owner_id = $2 and version = 1 returning id`, [PROJECT_A, USER_A]);
check("stale version updates zero rows", stale.length === 0);
check("stale version appended no revision",
  (await count("project_revisions", "project_id = $1", [PROJECT_A])) === 2);

// 6. Owner filters protect rows the caller does not own.
const foreignDelete = await as("service_role", null,
  "delete from public.projects where id = $1 and owner_id = $2 returning id", [PROJECT_A, USER_B]);
check("delete filtered by the wrong owner removes nothing", foreignDelete.length === 0);

// 7. Constraints.
check("unknown project_type is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `insert into public.projects (owner_id, project_type, title, schema_version, document)
     values ($1, 'novel', 'x', 1, '{}'::jsonb)`, [USER_A]))) === "23514");
check("non-object document is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `insert into public.projects (owner_id, project_type, title, schema_version, document)
     values ($1, 'story', 'x', 1, '"scalar"'::jsonb)`, [USER_A]))) === "23514");
check("duplicate (project_id, revision) is rejected (23505)",
  (await errorCode(() => as("service_role", null,
    `insert into public.project_revisions (project_id, owner_id, revision, schema_version, title, document)
     values ($1, $2, 1, 1, 'dup', '{}'::jsonb)`, [PROJECT_A, USER_A]))) === "23505");

// 8. Every child table follows the same ownership pattern.
for (const child of CHILD_ROWS) {
  const key = `objects/${PROJECT_A}/${child.table}`;
  const params = [PROJECT_A, USER_A, ...child.params(key)];
  await as("service_role", null, child.sql, params);

  check(`${child.table}: owner reads their row`,
    (await count(child.table, "project_id = $1", [PROJECT_A], "authenticated", USER_A)) === 1);
  check(`${child.table}: another account reads nothing`,
    (await count(child.table, "project_id = $1", [PROJECT_A], "authenticated", USER_B)) === 0);
  check(`${child.table}: authenticated write is refused (42501)`,
    (await errorCode(() => as("authenticated", USER_A, child.sql,
      [PROJECT_A, USER_A, ...child.params(`${key}-denied`)]))) === "42501");
}

// 8b. Phase 3: media references follow the same pattern and cascade.
const mediaRows = await as<{ id: string }>("service_role", null,
  "select id from public.media_metadata where project_id = $1 limit 1", [PROJECT_A]);
await as("service_role", null,
  `insert into public.media_references (media_id, project_id, owner_id, ref_kind, ref_id)
   values ($1, $2, $3, 'scene', 'scene-1')`, [mediaRows[0].id, PROJECT_A, USER_A]);
check("media_references: owner reads their reference",
  (await count("media_references", "project_id = $1", [PROJECT_A], "authenticated", USER_A)) === 1);
check("media_references: another account reads nothing",
  (await count("media_references", "project_id = $1", [PROJECT_A], "authenticated", USER_B)) === 0);
check("media_references: authenticated write is refused (42501)",
  (await errorCode(() => as("authenticated", USER_A,
    `insert into public.media_references (media_id, project_id, owner_id, ref_kind, ref_id)
     values ($1, $2, $3, 'scene', 'scene-2')`, [mediaRows[0].id, PROJECT_A, USER_A]))) === "42501");
check("media_references: duplicate reference is rejected (23505)",
  (await errorCode(() => as("service_role", null,
    `insert into public.media_references (media_id, project_id, owner_id, ref_kind, ref_id)
     values ($1, $2, $3, 'scene', 'scene-1')`, [mediaRows[0].id, PROJECT_A, USER_A]))) === "23505");
check("media_metadata: upload timestamps default to null",
  (await as<{ ok: boolean }>("service_role", null,
    `select (upload_expires_at is null and ready_at is null and deleted_at is null) as ok
       from public.media_metadata where project_id = $1`, [PROJECT_A]))[0].ok === true);

// 8c. Phase 5: planning evidence columns, proposal routing metadata, model health.
check("sources: an excerpt is optional and bounded",
  (await as<{ ok: boolean }>("service_role", null,
    `select (excerpt is null) as ok from public.sources where project_id = $1`, [PROJECT_A]))[0].ok === true);
check("claims: a supporting quote is optional",
  (await as<{ ok: boolean }>("service_role", null,
    `select (supporting_quote is null) as ok from public.claims where project_id = $1`, [PROJECT_A]))[0].ok === true);
check("generation_proposals: existing rows default to the legacy route and version 1",
  (await as<{ route: string; base_version: number }>("service_role", null,
    `select route, base_version from public.generation_proposals where project_id = $1`, [PROJECT_A]))
    .every((row) => row.route === "legacy" && row.base_version === 1));
check("generation_proposals: an unknown route is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `insert into public.generation_proposals (project_id, owner_id, model_id, prompt, proposal, route)
     values ($1, $2, 'gemma4:31b', 'x', '{}'::jsonb, 'ranking')`, [PROJECT_A, USER_A]))) === "23514");
check("generation_proposals: a base version below 1 is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `insert into public.generation_proposals (project_id, owner_id, model_id, prompt, proposal, base_version)
     values ($1, $2, 'gemma4:31b', 'x', '{}'::jsonb, 0)`, [PROJECT_A, USER_A]))) === "23514");

// 8d. Phase 5: a project can have at most one pending planning reservation.
await as("service_role", null,
  `insert into public.projects (id, owner_id, project_type, title, schema_version, document)
   values ($1, $2, 'story', 'Second Project', 1, $3::jsonb)`,
  [PROJECT_C, USER_B, JSON.stringify(DOCUMENT)]);
const pendingAttempt = await as<{ id: string }>("service_role", null,
  `insert into public.ai_usage
     (user_id, model_id, configured_model, latency_ms, status, project_id)
   values ($1, 'gemma', 'gemma4:31b', 0, 'pending', $2)
   returning id`, [USER_A, PROJECT_A]);
check("ai_usage: a pending planning attempt records its project",
  (await as<{ project_id: string }>("service_role", null,
    `select project_id from public.ai_usage where id = $1`, [pendingAttempt[0].id]))[0].project_id === PROJECT_A);
check("ai_usage: a second pending attempt for the same project is rejected (23505)",
  (await errorCode(() => as("service_role", null,
    `insert into public.ai_usage
       (user_id, model_id, configured_model, latency_ms, status, project_id)
     values ($1, 'gemma', 'gemma4:31b', 0, 'pending', $2)`, [USER_A, PROJECT_A]))) === "23505");
await as("service_role", null,
  `insert into public.ai_usage
     (user_id, model_id, configured_model, latency_ms, status, project_id)
   values ($1, 'gemma', 'gemma4:31b', 0, 'pending', $2)`, [USER_B, PROJECT_C]);
check("ai_usage: another project may hold its own pending attempt",
  (await count("ai_usage", "project_id = $1 and status = 'pending'", [PROJECT_C])) === 1);
await as("service_role", null,
  `update public.ai_usage set status = 'success' where id = $1`, [pendingAttempt[0].id]);
await as("service_role", null,
  `insert into public.ai_usage
     (user_id, model_id, configured_model, latency_ms, status, project_id)
   values ($1, 'gemma', 'gemma4:31b', 0, 'pending', $2)`, [USER_A, PROJECT_A]);
check("ai_usage: settling the pending attempt frees the project",
  (await count("ai_usage", "project_id = $1 and status = 'pending'", [PROJECT_A])) === 1);

await as("service_role", null,
  `insert into public.model_health (model_id, last_success_at, success_count)
   values ('gemma', now(), 1)`);
check("model_health: the service role reads the registry",
  (await count("model_health", "model_id = 'gemma'", [])) === 1);
check("model_health: an authenticated read is refused (42501)",
  (await errorCode(() => as("authenticated", USER_A, "select count(*) from public.model_health"))) === "42501");
check("model_health: a duplicate model id is rejected (23505)",
  (await errorCode(() => as("service_role", null,
    `insert into public.model_health (model_id) values ('gemma')`))) === "23505");

// 8e. Phase 6: imported stock provenance and the durable shared cache.
const PROVENANCE = {
  source: "stock",
  provider: "pexels",
  providerId: "101",
  type: "image",
  rendition: "original",
  renditionUrl: "https://images.pexels.com/photos/101/original.jpg",
  sourcePage: "https://www.pexels.com/photo/101/",
  creator: "Ada",
  attribution: "Photo by Ada on Pexels",
  license: "Pexels License",
  downloadedAt: "2026-11-25T12:00:00.000Z",
  byteSize: 512,
};
const imported = await as<{ id: string; provider: string | null; credit: string | null }>("service_role", null,
  `insert into public.media_metadata
     (project_id, owner_id, kind, object_key, content_type, byte_size, status, provenance)
   values ($1, $2, 'image', $3, 'image/jpeg', 512, 'ready', $4::jsonb)
   returning id, provenance->>'provider' as provider, provenance->>'attribution' as credit`,
  [PROJECT_A, USER_A, `objects/${PROJECT_A}/imported`, JSON.stringify(PROVENANCE)]);
check("media_metadata: imported provenance round-trips as JSONB",
  imported[0]?.provider === "pexels" && imported[0]?.credit === "Photo by Ada on Pexels",
  JSON.stringify(imported));
check("media_metadata: a duplicate ready stock import is rejected (23505)",
  (await errorCode(() => as("service_role", null,
    `insert into public.media_metadata
       (project_id, owner_id, kind, object_key, content_type, byte_size, status, provenance)
     values ($1, $2, 'image', $3, 'image/jpeg', 512, 'ready', $4::jsonb)`,
    [PROJECT_A, USER_A, `objects/${PROJECT_A}/imported-copy`, JSON.stringify(PROVENANCE)]))) === "23505");
check("media_metadata: a deleted duplicate stock import is allowed",
  (await errorCode(() => as("service_role", null,
    `insert into public.media_metadata
       (project_id, owner_id, kind, object_key, content_type, byte_size, status, provenance)
     values ($1, $2, 'image', $3, 'image/jpeg', 512, 'deleted', $4::jsonb)`,
    [PROJECT_A, USER_A, `objects/${PROJECT_A}/imported-deleted`, JSON.stringify(PROVENANCE)]))) === "NO_ERROR");
check("media_metadata: a non-object provenance is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `insert into public.media_metadata (project_id, owner_id, kind, object_key, content_type, byte_size, provenance)
     values ($1, $2, 'image', $3, 'image/jpeg', 1, '[]'::jsonb)`,
    [PROJECT_A, USER_A, `objects/${PROJECT_A}/bad-provenance`]))) === "23514");

await as("service_role", null,
  `insert into public.stock_search_cache
     (cache_key, provider, query_text, media_type, page, status, payload, payload_bytes, expires_at)
   values ('cache-1', 'pexels', 'rain', 'image', 1, 'ready', '{"results":[]}'::jsonb, 15, now() + interval '1 hour')`);
check("stock_search_cache: the service role reads a cached page",
  (await count("stock_search_cache", "cache_key = 'cache-1'", [])) === 1);
check("stock_search_cache: authenticated reads are refused (42501)",
  (await errorCode(() => as("authenticated", USER_A, "select count(*) from public.stock_search_cache"))) === "42501");
check("stock_search_cache: a duplicate cache key is rejected (23505)",
  (await errorCode(() => as("service_role", null,
    `insert into public.stock_search_cache
       (cache_key, provider, query_text, media_type, page, expires_at)
     values ('cache-1', 'pexels', 'rain', 'image', 1, now() + interval '1 hour')`))) === "23505");
check("stock_search_cache: an unknown provider is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `insert into public.stock_search_cache
       (cache_key, provider, query_text, media_type, page, expires_at)
     values ('cache-2', 'getty', 'rain', 'image', 1, now() + interval '1 hour')`))) === "23514");

await as("service_role", null,
  `insert into public.image_generations
     (id, owner_id, project_id, provider, model_key, prompt, settings, status, rate_version)
   values (gen_random_uuid(), $1, $2, 'cloudflare', 'cloudflare:flux-1-schnell', 'rain',
           '{"width":1024,"height":1024,"steps":4}'::jsonb, 'pending', 'rate-v1')`,
  [USER_A, PROJECT_A]);
check("image_generations: the service role stores a generation",
  (await count("image_generations", "model_key = 'cloudflare:flux-1-schnell'", [])) === 1);
check("image_generations: authenticated reads are refused (42501)",
  (await errorCode(() => as("authenticated", USER_A, "select count(*) from public.image_generations"))) === "42501");
await as("service_role", null,
  `update public.image_generations
      set actual_neurons = 57.6, actual_usd = 0.000634, cost_source = 'rate'
    where model_key = 'cloudflare:flux-1-schnell'`);
check("image_generations: actual cost is stored with its source",
  (await count("image_generations", "actual_usd = 0.000634 and cost_source = 'rate'", [])) === 1);
check("image_generations: an unknown cost source is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `update public.image_generations set cost_source = 'imaginary'
      where model_key = 'cloudflare:flux-1-schnell'`))) === "23514");
check("image_generations: a second pending row for the owner is rejected (23505)",
  (await errorCode(() => as("service_role", null,
    `insert into public.image_generations
       (id, owner_id, project_id, provider, model_key, prompt, settings, status, rate_version)
     values (gen_random_uuid(), $1, $2, 'cloudflare', 'cloudflare:flux-1-schnell', 'second', '{"width":1024,"height":1024,"steps":4}'::jsonb, 'pending', 'rate-v1')`,
    [USER_A, PROJECT_A]))) === "23505");
await as("service_role", null,
  `update public.image_generations set status = 'succeeded'
    where owner_id = $1 and status = 'pending'`,
  [USER_A]);
const pendingFollowup = await errorCode(() => as("service_role", null,
  `insert into public.image_generations
     (id, owner_id, project_id, provider, model_key, prompt, settings, status, rate_version)
   values (gen_random_uuid(), $1, $2, 'cloudflare', 'cloudflare:flux-1-schnell', 'next', '{"width":1024,"height":1024,"steps":4}'::jsonb, 'pending', 'rate-v1')`,
  [USER_A, PROJECT_A]));
check("image_generations: a pending row is allowed after the first settles",
  pendingFollowup === "NO_ERROR", String(pendingFollowup));

check("image_generations: an unknown provider is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `insert into public.image_generations
       (id, owner_id, project_id, provider, model_key, prompt, settings, rate_version)
     values (gen_random_uuid(), $1, $2, 'getty', 'x', 'rain', '{}'::jsonb, 'rate-v1')`,
    [USER_A, PROJECT_A]))) === "23514");

await as("service_role", null,
  `insert into public.narration_tracks
     (id, owner_id, project_id, kind, source, status, script_fingerprint, script_characters,
      duration_seconds, volume, cost_usd, cost_rate_version)
   values (gen_random_uuid(), $1, $2, 'narration', 'deepgram', 'active', 'fingerprint', 64,
           1.0, 1, 0.00192, 'deepgram-aura-2-2026-11-25')`,
  [USER_A, PROJECT_A]);
check("narration_tracks: the service role stores measured audio",
  (await count("narration_tracks", "script_characters = 64 and duration_seconds = 1.0", [])) === 1);
check("narration_tracks: authenticated reads are refused (42501)",
  (await errorCode(() => as("authenticated", USER_A, "select count(*) from public.narration_tracks"))) === "42501");
check("narration_tracks: a second active track of the same kind is rejected (23505)",
  (await errorCode(() => as("service_role", null,
    `insert into public.narration_tracks
       (id, owner_id, project_id, kind, source, media_id, duration_seconds)
     values (gen_random_uuid(), $1, $2, 'narration', 'upload', null, 2)`,
    [USER_A, PROJECT_A]))) === "23505");
await as("service_role", null,
  `update public.narration_tracks set status = 'replaced'
    where owner_id = $1 and kind = 'narration'`,
  [USER_A]);
check("narration_tracks: a replacement is allowed after the prior track is retired",
  (await errorCode(() => as("service_role", null,
    `insert into public.narration_tracks
       (id, owner_id, project_id, kind, source, duration_seconds)
     values (gen_random_uuid(), $1, $2, 'music', 'upload', 2)`,
    [USER_A, PROJECT_A]))) === "NO_ERROR");
check("narration_tracks: an unknown kind is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `insert into public.narration_tracks
       (id, owner_id, project_id, kind, source, duration_seconds)
     values (gen_random_uuid(), $1, $2, 'voiceover', 'upload', 2)`,
    [USER_A, PROJECT_A]))) === "23514");
check("narration_tracks: volume outside 0..1 is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `insert into public.narration_tracks
       (id, owner_id, project_id, kind, source, duration_seconds, volume)
     values (gen_random_uuid(), $1, $2, 'music', 'upload', 2, 1.5)`,
    [USER_A, PROJECT_A]))) === "23514");

await as("service_role", null,
  `insert into public.narration_usage
     (owner_id, project_id, kind, status, characters, cost_usd, rate_version)
   values ($1, $2, 'preview', 'succeeded', 82, 0.00246, 'deepgram-aura-2-2026-11-25')`,
  [USER_A, PROJECT_A]);
check("narration_usage: the service role records a settled preview",
  (await count("narration_usage", "kind = 'preview' and characters = 82 and cost_usd = 0.00246", [])) === 1);
check("narration_usage: authenticated reads are refused (42501)",
  (await errorCode(() => as("authenticated", USER_A, "select count(*) from public.narration_usage"))) === "42501");
check("narration_usage: an unknown kind is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `insert into public.narration_usage
       (owner_id, project_id, kind, characters, cost_usd, rate_version)
     values ($1, $2, 'transcription', 10, 0.0003, 'rate-v1')`,
    [USER_A, PROJECT_A]))) === "23514");
check("narration_usage: a negative charge is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `insert into public.narration_usage
       (owner_id, project_id, kind, characters, cost_usd, rate_version)
     values ($1, $2, 'generation', 10, -0.1, 'rate-v1')`,
    [USER_A, PROJECT_A]))) === "23514");

const deniedReservation = await as<{ allowed: boolean; characters_used: number }>(
  "service_role",
  null,
  `select * from public.reserve_narration_usage($1, $2, 'generation', 64, 0.00192,
     'deepgram-aura-2-2026-11-25', 100, 3, 86400)`,
  [USER_A, PROJECT_A],
);
check("narration_usage: an atomic reservation refuses over-budget characters without inserting",
  deniedReservation[0]?.allowed === false && deniedReservation[0]?.characters_used === 82);
check("narration_usage: a refused reservation did not add a row",
  (await count("narration_usage", "owner_id = $1", [USER_A])) === 1);

const grantedReservation = await as<{ usage_id: string; allowed: boolean }>(
  "service_role",
  null,
  `select * from public.reserve_narration_usage($1, $2, 'generation', 64, 0.00192,
     'deepgram-aura-2-2026-11-25', 1000, 3, 86400)`,
  [USER_A, PROJECT_A],
);
check("narration_usage: an allowed reservation inserts a pending row",
  grantedReservation[0]?.allowed === true &&
    typeof grantedReservation[0]?.usage_id === "string" &&
    (await count("narration_usage", "status = 'pending'", [])) === 1);
check("narration_usage: authenticated execute is refused (42501)",
  (await errorCode(() => as("authenticated", USER_A,
    `select * from public.reserve_narration_usage($1, $2, 'preview', 10, 0.0003,
       'rate-v1', 1000, 3, 86400)`, [USER_A, PROJECT_A]))) === "42501");

check("render_snapshots rejects a revision that does not exist (23503)",
  (await errorCode(() => as("service_role", null,
    `insert into public.render_snapshots (project_id, owner_id, project_revision)
     values ($1, $2, 99)`, [PROJECT_A, USER_A]))) === "23503");

// 9. Profiles are one workspace per user, with the same owner pattern.
await as("service_role", null,
  `insert into public.profiles (owner_id, display_name, workspace_name)
   values ($1, 'User A', 'A workspace')`, [USER_A]);
check("owner reads their own profile",
  (await count("profiles", "owner_id = $1", [USER_A], "authenticated", USER_A)) === 1);
check("another account reads no profile",
  (await count("profiles", "owner_id = $1", [USER_A], "authenticated", USER_B)) === 0);
check("authenticated write to profiles is refused (42501)",
  (await errorCode(() => as("authenticated", USER_A,
    `insert into public.profiles (owner_id, workspace_name) values ($1, 'hijacked')`, [USER_B]))) === "42501");
check("a second profile for the same user is rejected (23505)",
  (await errorCode(() => as("service_role", null,
    `insert into public.profiles (owner_id, workspace_name) values ($1, 'second')`, [USER_A]))) === "23505");

// 9b. Phase 9–22: render_jobs and workflow_artifacts follow RLS and check constraints.
await as("service_role", null,
  `insert into public.render_jobs
     (owner_id, project_id, project_version, snapshot_fingerprint, idempotency_key,
      aspect_ratio, duration_seconds, estimated_cost_usd, status, snapshot)
   values ($1, $2, 1, 'comp-fp-1', 'idem-render-1', '16:9', 15, 0.0375, 'queued', '{"scenes":[]}'::jsonb)`,
  [USER_A, PROJECT_A]);
check("render_jobs: service role stores a render job",
  (await count("render_jobs", "project_id = $1", [PROJECT_A])) === 1);
check("render_jobs: authenticated reads are refused (42501)",
  (await errorCode(() => as("authenticated", USER_A, "select count(*) from public.render_jobs"))) === "42501");
check("render_jobs: duplicate idempotency key per owner is rejected (23505)",
  (await errorCode(() => as("service_role", null,
    `insert into public.render_jobs
       (owner_id, project_id, project_version, snapshot_fingerprint, idempotency_key,
        aspect_ratio, duration_seconds, estimated_cost_usd, status, snapshot)
     values ($1, $2, 1, 'comp-fp-2', 'idem-render-1', '16:9', 15, 0.0375, 'queued', '{"scenes":[]}'::jsonb)`,
    [USER_A, PROJECT_A]))) === "23505");
check("render_jobs: invalid aspect ratio is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `insert into public.render_jobs
       (owner_id, project_id, project_version, snapshot_fingerprint, idempotency_key,
        aspect_ratio, duration_seconds, estimated_cost_usd, status, snapshot)
     values ($1, $2, 1, 'comp-fp-3', 'idem-render-2', '4:3', 15, 0.0375, 'queued', '{"scenes":[]}'::jsonb)`,
    [USER_A, PROJECT_A]))) === "23514");

await as("service_role", null,
  `insert into public.workflow_artifacts
     (owner_id, project_id, artifact_kind, fingerprint, payload)
   values ($1, $2, 'continuity_notes', 'checklist-v1', '{"readyForRender":true}'::jsonb)`,
  [USER_A, PROJECT_A]);
check("workflow_artifacts: service role stores a workflow artifact",
  (await count("workflow_artifacts", "project_id = $1 and artifact_kind = 'continuity_notes'", [PROJECT_A])) === 1);
check("workflow_artifacts: authenticated reads are refused (42501)",
  (await errorCode(() => as("authenticated", USER_A, "select count(*) from public.workflow_artifacts"))) === "42501");
check("workflow_artifacts: invalid artifact_kind is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `insert into public.workflow_artifacts (owner_id, project_id, artifact_kind, fingerprint, payload)
     values ($1, $2, 'unknown_domain', 'k1', '{}'::jsonb)`,
    [USER_A, PROJECT_A]))) === "23514");

// 10. Deleting a project cascades revisions and child rows, but preserves the
// Deepgram ledger so deleting a project cannot reset the spending guard.
await as("service_role", null, "delete from public.projects where id = $1 and owner_id = $2", [PROJECT_A, USER_A]);
check("deleting the project removed its narration tracks",
  (await count("narration_tracks", "project_id = $1", [PROJECT_A])) === 0);
check("deleting the project preserved its narration usage rows and cleared the project reference",
  (await count("narration_usage", "owner_id = $1", [USER_A])) === 2 &&
    (await count("narration_usage", "owner_id = $1 and project_id is null", [USER_A])) === 2);
check("deleting the project removed its revisions",
  (await count("project_revisions", "project_id = $1", [PROJECT_A])) === 0);
for (const child of CHILD_ROWS) {
  check(`deleting the project removed its ${child.table} rows`,
    (await count(child.table, "project_id = $1", [PROJECT_A])) === 0);
}
check("deleting the project removed its media references",
  (await count("media_references", "project_id = $1", [PROJECT_A])) === 0);

// 11. Deleting the auth user cascades projects, revisions, child rows and the profile.
await as("service_role", null,
  `insert into public.projects (id, owner_id, project_type, title, schema_version, document)
   values ($1, $2, 'repurpose', 'Owned By B', 1, $3::jsonb)`,
  [PROJECT_B, USER_B, JSON.stringify(DOCUMENT)]);
for (const child of CHILD_ROWS) {
  const key = `objects/${PROJECT_B}/${child.table}`;
  await as("service_role", null, child.sql, [PROJECT_B, USER_B, ...child.params(key)]);
}
await as("service_role", null,
  `insert into public.profiles (owner_id, workspace_name) values ($1, 'B workspace')`, [USER_B]);
await as("service_role", null,
  `insert into public.narration_usage
     (owner_id, project_id, kind, status, characters, cost_usd, rate_version)
   values ($1, $2, 'preview', 'succeeded', 10, 0.0003, 'rate-v1')`,
  [USER_B, PROJECT_B]);
await db.exec(`delete from auth.users where id = '${USER_B}'`);
check("deleting the auth user removed their projects",
  (await count("projects", "owner_id = $1", [USER_B])) === 0);
check("deleting the auth user removed their revisions",
  (await count("project_revisions", "owner_id = $1", [USER_B])) === 0);
for (const child of CHILD_ROWS) {
  check(`deleting the auth user removed their ${child.table} rows`,
    (await count(child.table, "owner_id = $1", [USER_B])) === 0);
}
check("deleting the auth user removed their narration usage rows",
  (await count("narration_usage", "owner_id = $1", [USER_B])) === 0);
check("deleting the auth user removed their profile",
  (await count("profiles", "owner_id = $1", [USER_B])) === 0);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
