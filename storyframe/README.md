# StoryFrame — Phase 4: dashboard, brief, script, and storyboard

This repository state keeps the Phase 2 pieces — a **server-verified Supabase session boundary**, a **durable,
idempotent usage ledger**, and the **project data model** with owner-scoped access — and the Phase 3 **private media
storage in Cloudflare R2**. It adds Phase 4: a signed-in **workspace** with a dashboard, brief, script, storyboard,
media panel, honest preview, and editable project/script export. Phase 5 adds configurable one-model-per-task planning:
validated JSON proposals for angles, scripts, storyboards, ad concepts, and transcript analysis, kept separate from
accepted content. Phase 6 adds protected Pexels and Pixabay stock search with normalized previews, a durable shared
cache, credited attribution, and server-mediated imports into project media.

The connection-test screen still uses real Supabase email/password sign-in and remains a development harness only.
Video rendering, billing, discovery, and deployment are **not** started here.

## Architecture

```
Browser (Vite + React) → Supabase Auth      (email/password, refresh, sign-out)
      └─ /api/ai/test       (current Supabase access token)
      ↓ Vite dev proxy (development only)
Node server (127.0.0.1:8787)
      ├─ Supabase Auth  GET /auth/v1/user  → verified user id
      ├─ Supabase REST  POST /rest/v1/ai_usage → pending reservation
      ├─ Ollama Cloud   POST /api/chat         → final reply
      └─ Supabase REST  PATCH /rest/v1/ai_usage → stored outcome
```

- The browser never receives the Ollama key or the Supabase service-role key.
- User identity always comes from the verified Supabase session; a client-supplied owner id is rejected.
- A billable call is refused unless Supabase auth, the usage ledger, and the Ollama key are all configured.
- `POST /api/ai/test` remains bounded: 4 KB body, 500-character prompt, 120 output tokens, 30 s provider timeout, one
  concurrent request per account, six requests per minute per account, no automatic retries.
- Every test request requires an `Idempotency-Key`. A unique `(user_id, idempotency_key)` reservation is written before
  the provider call, so a retry cannot bill twice.
- A reservation left `pending` by a dead request is settled as `REQUEST_ABANDONED` on a later retry, without calling the
  provider (see `POST /api/ai/test`).
- `GET /api/ai/usage` returns the caller’s own recent completed ledger rows.
- `/api/projects` reads and writes only the caller’s own projects: every query filters on the verified owner id, and
  revision history is written by a database trigger.

Row-level security is enabled on the ledger: authenticated users may only `select` their own rows; writes are made
with the server-only service role. Server-side isolation is also enforced explicitly by filtering reads on the
verified user id.

**This is still a development arrangement, not a production hosting solution.** The Node process is loopback-only and
reached through the Vite dev proxy. Production hosting, durable cross-instance quotas, and broader account flows (sign-up, password reset, MFA, OAuth)
remain future work.

## Run locally

```bash
cd storyframe
npm install
cp .env.example .env
# fill in Ollama + server Supabase values, plus the two VITE_ browser auth values
npm run dev
```

`npm run dev` starts:

- API: `http://127.0.0.1:8787`
- Web: `http://localhost:3000` (Vite proxies `/api` to the API)

Before using the ledger or any project route, apply the migrations in order. See
[Applying the migrations](#applying-the-migrations) for the compatibility check that must pass
first and the current state of the configured project.

Other commands:

```bash
npm run check             # TypeScript type-check (app, server, scripts, tests)
npm test                  # Vitest (mocked provider + fake Supabase)
npm run build             # type-check + production frontend build
npm run smoke:live        # opt-in: five real requests + ledger check (see Tests)
npm run verify:live-routes # provider-free two-user live route + ledger checks
npm run verify:media-live # opt-in: two disposable accounts, real upload + playback through the routes
npm run verify:stock-live # opt-in: real Pexels/Pixabay image and video searches through the adapters
npm run verify:stock-routes-live # opt-in: hosted stock cache + media import/playback/delete through the routes
npm run verify:r2-live    # opt-in: real R2 presign/upload/read/delete check (no bucket is created)
npm run verify:sql        # apply every migration to in-memory PostgreSQL and assert RLS, triggers, cascades
npm run audit:media       # read-only bucket-vs-database orphan audit (needs hosted Supabase + R2 values)
npm run start:server      # server without watch
```

`verify:stock-routes-live` also needs `R2_BUCKET_NAME` alongside the Supabase and provider values; the configured
bucket is `story-frame`. Without R2 it still checks search, the durable cache, and the media list, and skips the
import, playback, and delete checks.

For an external preview hostname, allow it explicitly instead of using a blanket allowlist:

```bash
__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=<preview-hostname> npm run dev
```

## Applying the migrations

`npm run verify:sql` proves the migration files against a real PostgreSQL engine before they touch a
hosted project. They are written for a project whose `public` schema does not already contain
these tables. Apply them in filename order:

1. `20261124090000_create_ai_usage.sql`
2. `20261124100000_add_ai_usage_idempotency.sql`
3. `20261124120000_create_projects.sql`
4. `20261124140000_create_project_children.sql`
5. `20261124150000_create_profiles.sql`
6. `20261124160000_create_media_storage.sql` (Phase 3: upload timestamps, `media_references`)
7. `20261125120000_create_planning.sql` (Phase 5: source excerpts, claim quotes, proposal route/base version, `model_health`)
8. `20261125140000_add_planning_attempt_preflight.sql` (Phase 5: `ai_usage.project_id` and one pending attempt per project)
9. `20261125160000_add_stock_media.sql` (Phase 6: `media_metadata.provenance` and the durable `stock_search_cache` table)
10. `20261125180000_enforce_stock_import_uniqueness.sql` (Phase 6: one ready copy per imported stock rendition per project)
11. `20261125200000_create_image_generations.sql` (Phase 7: persisted image-generation jobs)
12. `20261125210000_add_image_generation_cost_capture.sql` (Phase 7: provider-reported cost)
13. `20261125220000_one_pending_image_generation.sql` (Phase 7: one pending image per account)
14. `20261125230000_create_narration_tracks.sql` (Phase 8: narration/music rows, one active track per kind)
15. `20261125240000_create_narration_usage.sql` (Phase 8: Deepgram preview/generation spending ledger)
16. `20261125250000_atomic_narration_usage_reservation.sql` (Phase 8: atomic per-account reservation function)
17. `20261125260000_preserve_narration_usage_on_project_delete.sql` (Phase 8: keep the Deepgram ledger when a project is deleted)

Run the compatibility check first. It must return no rows:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'ai_usage', 'projects', 'project_revisions', 'scenes', 'media_metadata',
    'media_references', 'sources', 'claims', 'generation_proposals',
    'provider_jobs', 'render_snapshots', 'profiles', 'model_health', 'stock_search_cache'
  );
```

Then apply the files with the CLI, or paste each one into the Supabase SQL editor in the same
order:

```bash
supabase link --project-ref <project-ref>
supabase db push          # applies supabase/migrations in filename order
```

Afterwards, check the running server rather than assuming the schema is ready:

1. `GET /api/ai/status` must report `auth.configured: true` and `ledger.ready: true`.
2. With a real session token, read and write `GET/PUT /api/profile`, create one project, and
   list one child table. A `503` with `PROJECTS_UNAVAILABLE`, `PROFILE_UNAVAILABLE`, or
   `CHILD_STORE_UNAVAILABLE` means the hosted columns still do not match these files.
3. Set `SMOKE_SUPABASE_ACCESS_TOKEN` to a session token and run `npm run smoke:live` (five
   billable calls, described under Tests).

**All seventeen migrations through Phase 8 are applied to the configured project (`myrohtkfsuppcabedwmn`): the sixth on
2026-11-24, the seventh and eighth (Phase 5) on 2026-11-25, and the ninth through seventeenth (Phases 6–8) on 2026-11-25.** The Phase 6 catalog was
checked directly after applying it: `media_metadata.provenance` and its object constraint exist,
`media_metadata_ready_stock_import_key` is a partial unique index on the owner, project, provider, asset id, and
rendition where `status = 'ready'`, and `stock_search_cache` exists with RLS enabled, no `authenticated` grants, and
service-role access only. After applying the eighth, a PostgREST probe selecting
`ai_usage.project_id` returned `200`, `pg_indexes` reported `ai_usage_one_pending_project_idx` as a partial unique
index on `(project_id)` where `status = 'pending'`, `GET /api/ai/status` reported `ledger.ready: true`, and
`verify:live-routes` passed **51/51** checks including the owner-scoped planning-status route. After applying the seventh,
direct REST probes for `sources.excerpt`,
`generation_proposals.route`/`base_version`, `claims.supporting_quote`, and `model_health.model_id` all returned
`200`. After
applying it, the hosted catalog was checked directly: `media_metadata` has the four added columns, `media_references`
exists with RLS enabled, one `select` policy for `authenticated`, and only `select` granted to `authenticated`. The
obsolete `public` schema in
`myrohtkfsuppcabedwmn` (16 tables from an earlier project, plus `public.handle_new_user()` attached
to `auth.users`) was exported first — six `model_registry` rows and a catalog snapshot — and then
replaced with the first five migrations (the sixth followed on 2026-11-24). The hosted schema now has
the 12 tables the first six migrations define, RLS and one select-own policy on each, and the `projects_record_revision`
trigger; the old `auth.users` trigger is gone. `GET /api/ai/status` reports `ledger.ready: true`. Live profile, project, child, and
two-user isolation routes were then exercised with disposable users; those users and their rows were
deleted afterwards. `npm run smoke:live` was run twice: the first five-call run exposed a missing
`status` column in the reservation lookup, and after the fix the second five-call run exited 0 with
5/5 families and an identical stored replay. The project is empty again. Keep the compatibility
check above for any other project.

## Environment

### Browser-visible Supabase Auth

These values are compiled into the Vite client and are public configuration. Use only the publishable (or legacy
anon) key; never the service-role key.

| Name | Purpose |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL used by the browser auth client. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Publishable key used by the browser auth client. `VITE_SUPABASE_ANON_KEY` is accepted as a fallback. |

### Server-only

| Name | Purpose |
| --- | --- |
| `OLLAMA_API_KEY` | Ollama Cloud bearer key. Read only in the Node process. |
| `OLLAMA_BASE_URL` | Must be `https://ollama.com`; other values are refused. |
| `SUPABASE_URL` | Supabase project URL used for Auth and the ledger. |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key sent as `apikey` to Auth. `SUPABASE_ANON_KEY` is accepted as a fallback. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only key for ledger reads/writes. Never expose it to the browser. |
| `AUTH_TIMEOUT_MS` | Supabase Auth/ledger timeout (default 5000). |
| `OLLAMA_MODEL_*` | Optional exact-request-id overrides for the six families. |
| `AI_ROUTE_ANGLES`, `AI_ROUTE_SCRIPT`, `AI_ROUTE_STORYBOARD`, `AI_ROUTE_AD_CONCEPT`, `AI_ROUTE_TRANSCRIPT_ANALYSIS` | Planning route override, naming a family key from the allowlist (`gemma`, `deepseek`, `glm`, `gpt-oss`, `minimax`). The default for every route is `gemma`; a value that is unknown, disabled, or lacks the capability disables that route instead of falling back. |
| `AI_TIMEOUT_MS`, `AI_MAX_PROMPT_CHARS`, `AI_MAX_OUTPUT_TOKENS`, `AI_MAX_REQUESTS_PER_MINUTE` | Optional bounds. |
| `AI_ABANDON_AFTER_MS` | Age at which a pending reservation may be settled as abandoned instead of retried (default 90000, floored at the provider timeout plus three auth timeouts). Planning uses a wider floor of two provider timeouts plus three auth timeouts, covering its initial call and one repair. |
| `APP_ORIGIN` | Optional additional origin restriction for API calls. |
| `SMOKE_SUPABASE_ACCESS_TOKEN` | Only for `npm run smoke:live`; a valid session token. Never commit it. |
| `R2_ENDPOINT` | R2 S3 endpoint (`https://<account-id>.r2.cloudflarestorage.com`). `CLOUDFLARE_S3_ENDPOINT_URL` is accepted as a fallback. |
| `R2_BUCKET_NAME` | Private media bucket. `CLOUDFLARE_R2_BUCKET_NAME` is accepted as a fallback. |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 S3 credentials. Read only in the Node process; never sent to the browser. `CLOUDFLARE_ACCESS_ID` / `CLOUDFLARE_SECRET_ACCESS_KEY` are accepted as fallbacks. |
| `MEDIA_IMAGE_MAX_BYTES`, `MEDIA_AUDIO_MAX_BYTES`, `MEDIA_VIDEO_MAX_BYTES` | Per-file bounds (defaults 10 MiB, 25 MiB, 200 MiB). |
| `MEDIA_OWNER_STORAGE_BYTES` | Total pending + ready bytes per account (default 2 GiB). |
| `MEDIA_UPLOAD_URL_SECONDS`, `MEDIA_DOWNLOAD_URL_SECONDS`, `MEDIA_UPLOAD_TTL_MS` | Presigned URL and upload-window lifetimes. |
| `MEDIA_DELETED_RETENTION_MS`, `MEDIA_UNREFERENCED_RETENTION_MS` | Retention windows for deleted rows and unreferenced ready assets. |
| `MEDIA_SWEEP_INTERVAL_MS` | Background sweep cadence and the minimum gap between opportunistic request-triggered passes (default 60000). `0` turns the background timer off. |
| `PEXELS_API_KEY`, `PIXABAY_API_KEY` | Stock provider keys. Read only in the Node process; a Pixabay key is sent as a query parameter and is redacted from logs and errors. |
| `STOCK_PROVIDER_TIMEOUT_MS`, `STOCK_PAGE_SIZE`, `STOCK_MAX_PAGE`, `STOCK_QUERY_MAX_CHARS` | Provider timeout and search bounds (defaults 8000 ms, 20 results per provider, page 50, 80 characters). |
| `STOCK_PEXELS_CACHE_SECONDS`, `STOCK_PIXABAY_CACHE_SECONDS` | Durable page-cache windows (defaults 3600 and 86400). Pixabay is never below 86400, the provider's caching requirement. |
| `STOCK_CACHE_PAYLOAD_BYTES`, `STOCK_CACHE_LEASE_MS`, `STOCK_CACHE_WAIT_MS` | Maximum cached page size, claim-lease length, and how long a concurrent request waits for the claim holder. |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_API_TOKEN` | Cloudflare Workers AI credentials for image generation. `CF_API_TOKEN` is accepted as the same AI token. Read only in the Node process. |
| `LEONARDO_API_KEY` | Leonardo API key. Read only in the Node process and never stored in a generation row. |
| `IMAGE_POLL_INTERVAL_MS`, `IMAGE_GENERATION_TIMEOUT_MS`, `IMAGE_DOWNLOAD_TIMEOUT_MS` | Leonardo poll cadence, the poll deadline before a `202` is returned, and the provider image download timeout (defaults 1500, 60000, and 30000 ms). |
| `IMAGE_DAILY_IMAGES_PER_USER`, `IMAGE_DAILY_USD_PER_USER` | Per-account spending guard over a rolling 24 hours: recorded attempts and their estimated USD (defaults 20 images and $1.00). Either value set to `0` disables that dimension. Leonardo attempts count toward images but not USD because its rate is unpublished. |
| `IMAGE_PENDING_ABANDON_AFTER_MS`, `IMAGE_PENDING_SWEEP_INTERVAL_MS` | A pending generation older than the abandon window (default 15 minutes, minimum 1 minute) is settled as `IMAGE_GENERATION_ABANDONED` instead of blocking new images. The background sweep runs on the interval (default 60 seconds; `0` disables it, while generation requests still settle stale rows opportunistically). |
| `STOCK_IMPORT_TIMEOUT_MS`, `STOCK_IMPORT_REDIRECTS` | Import download timeout and redirect bound (defaults 30000 ms, 3 hops). |
| `DEEPGRAM_API_KEY` | Deepgram Aura-2 text-to-speech key. Read only in the Node process, sent as `Authorization: Token`, and never stored in a narration row or returned to the browser. |
| `NARRATION_TIMEOUT_MS`, `NARRATION_MAX_AUDIO_BYTES` | Deepgram request timeout and generated-audio size bound (defaults 60000 ms and 25 MiB). Deepgram accepts at most 2,000 characters per Aura-2 request. |
| `NARRATION_DAILY_CHARS_PER_USER`, `NARRATION_DAILY_USD_PER_USER` | Per-account Deepgram spending guard over a rolling 24 hours. Every preview and generation attempt, including a failed provider call, is recorded before it is billed; the next request is refused with `429 NARRATION_SPEND_LIMIT` when it would exceed either limit (defaults 100,000 characters and $3.00). `0` disables that dimension. |

`.env` is git-ignored; `.env.example` contains placeholders only. Only public Supabase auth configuration uses a
`VITE_` name; no secret is prefixed with `VITE_`, returned by the API, logged, or placed in a URL. The Supabase client
persists session tokens in browser `localStorage` and sends them only to the Node server in the `Authorization` header.

## Authentication

The browser creates a Supabase client with `persistSession` and `autoRefreshToken` enabled. The sign-in screen posts an
email and password to Supabase Auth; an existing session is restored on load. The server still verifies the resulting
access token on every AI and data route. Before a request, the app reads the current session with `getSession()` and
sends the token it returns; the Supabase client refreshes inside its own 90-second pre-expiry margin and single-flights
concurrent refreshes, so the app never starts a second refresh of its own. `onAuthStateChange` updates the screen on
sign-in, token refresh, and sign-out. Sign-out uses `scope: "local"`: it clears this browser's stored session and leaves
the account's other sessions active. Sign-out is paused while a billable request is in flight so its reply is not lost.

There is no sign-up, password-reset, MFA, or OAuth flow yet. The test screen remains a development harness, not a
production account-management UI.

## API

### `GET /api/ai/status`

Safe configuration data: provider key presence, Supabase auth presence, ledger configuration and **readiness**, fixed
upstream, catalog check date, bounds, and the allowlisted models. Readiness probes the columns added by all three
`ai_usage` migrations, including `project_id`, so a configured but unmigrated project reports `ledger.ready: false`.
`tests/status.test.ts` simulates the schema before the planning-preflight migration and asserts that readiness is
false. No keys or session tokens are returned.

### `POST /api/ai/test`

Headers:

- `Authorization: Bearer <Supabase access token>`
- `Content-Type: application/json`
- `Idempotency-Key: <8-128 chars: A-Z a-z 0-9 . _ : ->`

```json
{
  "model": "gemma",
  "prompt": "Write one short welcome sentence for StoryFrame."
}
```

The server verifies the session, validates the key, and inserts a `pending` reservation before contacting Ollama. The
unique `(user_id, idempotency_key)` index means only one request can own an attempt, including across processes. The
server then calls `https://ollama.com/api/chat` with `stream: false`, `think: false` and `options.num_predict`, stores
the exact success or sanitized error response, and returns only the final `message.content` plus the returned model,
measured latency, and the usage counts Ollama supplied.

Reusing the same key with the same model and prompt returns the stored response without calling Ollama. Reusing it for a
different request returns `409 IDEMPOTENCY_KEY_REUSED`. If the original is still pending, the server returns
`409 IDEMPOTENCY_IN_PROGRESS`. A completed reservation with no stored response (for example a partially written row)
returns `503 IDEMPOTENCY_REPLAY_UNAVAILABLE` instead of re-billing the provider. A key is scoped to the verified user,
so two accounts may use the same key and each attempt is billed once. Use a new key only for a genuinely new attempt.

If the original is still `pending` but older than `AI_ABANDON_AFTER_MS` (default 90 s, never below the provider timeout
plus three auth timeouts), the server assumes that attempt died. It settles the row as a terminal `error` with
`REQUEST_ABANDONED` (HTTP 409, no token counts, zero latency) and returns that response **without contacting Ollama**,
because the original attempt may already have been billed. That key then replays `REQUEST_ABANDONED` for good: only a
new key starts a new paid attempt. The settlement is conditional on the row still being `pending`, still owned by the
caller, and still older than the threshold, so a concurrent completion wins the race and is replayed instead. The
completion write is likewise filtered by the verified caller's user id, so a mismatched reservation id cannot settle
another account's row.

A completion write that fails after Ollama answered is retried once. If it still cannot be recorded, the reply is
returned anyway (HTTP 200) with `X-Storyframe-Usage: unrecorded`, because the provider was already paid for it, and no
second provider call is made. The same header is sent when the conditional completion matches no `pending` row: the
reservation was settled elsewhere, usually as `REQUEST_ABANDONED` by a concurrent retry. A response lost after a
committed write also produces this warning, so it means "not confirmed" rather than proof the row is absent. In the
write-failure case the key stays `pending`, so a later retry can only settle it as `REQUEST_ABANDONED`: the reply was
delivered but the ledger never learned it. The development screen shows that header as a warning beside the reply
instead of an ordinary success.

The development screen keeps one key per attempt while the outcome is unknown (a network failure or an in-progress
request) and starts a fresh key after a recorded outcome — success, a provider error, or `REQUEST_ABANDONED` — so a
recorded failure can be retried without replaying the cached error.

### `GET /api/ai/usage`

Returns the caller’s 20 most recent ledger rows:

```json
{
  "ok": true,
  "usage": [
    {
      "id": "…",
      "modelId": "gemma",
      "configuredModel": "gemma4:31b",
      "returnedModel": "gemma4:31b",
      "promptEvalCount": 22,
      "evalCount": 13,
      "latencyMs": 777,
      "status": "success",
      "errorCode": null,
      "upstreamStatus": null,
      "createdAt": "2026-11-24T…"
    }
  ]
}
```

### `GET /api/profile` and `PUT /api/profile`

Both routes use the verified session only; the owner id never comes from the request body.

- `GET` returns the caller's own workspace record, or `404 PROFILE_NOT_FOUND` when the account has none yet. It does not
  invent a default row.
- `PUT` upserts it (`200`) from
  `{ "displayName": "Ada", "workspaceName": "Ada's studio", "settings": { "theme": "dark" } }`. `displayName` is
  optional and may be null; `workspaceName` is required; `settings` defaults to `{}` and is bounded to 4 KB. Unknown
  fields, including `owner_id`, are rejected with `400 UNEXPECTED_FIELD`.

A workspace is one row per account: `owner_id` is the primary key of `profiles`, so a second account's write cannot land
on the first account's row.

## Projects

`projects` and `project_revisions` are the first slice of Phase 2 application persistence, extended by Phase 4. Each
project belongs to the verified Supabase user, carries one of three kinds (`story`, `product-ad`, `repurpose`), and
stores a **versioned** `document`. Two numbers matter and they are not the same: `schema_version` is the shape of the
document, while `version` is the optimistic concurrency token for the row.

Document **schema 2** carries the brief (`topic`, `audience`, `goal`, factual/fiction, target duration, tone, preset,
voice preference, planning budget) and scenes with a stable id, order, narration, visual direction, asset ids,
on-screen text, duration, approval, approval fingerprint, and per-component locks. Stored schema 1 rows are upgraded
on read and written back as schema 2 on the next save; the migration adds empty visual/on-screen fields, zero
durations, unlocked components, and a default brief rather than guessing content.

Every accepted write appends an immutable revision in the same transaction: the `projects_record_revision` trigger
copies the new row into `project_revisions`, numbered by `projects.version`. History cannot drift from the row, and a
rejected request cannot append a revision.

| Route | Purpose |
| --- | --- |
| `POST /api/projects` | Create from `{ projectType, title, document }`. Returns `201` with `version: 1`; a new project cannot list scene asset ids (`422 MEDIA_ASSET_INVALID`). |
| `GET /api/projects` | The caller's 50 most recently updated projects, without documents. |
| `GET /api/projects/:id` | One owned project, including its document. |
| `PUT /api/projects/:id` | Replace `{ title, document }`, sending the `version` last read. Scene asset ids must be UUID-shaped ready media in the same project (`422 MEDIA_ASSET_INVALID` otherwise). |
| `DELETE /api/projects/:id` | Delete an owned project; its revisions cascade. |
| `GET /api/projects/:id/revisions` | The owner's 20 newest revision summaries (no document payloads). |
| `POST /api/projects/:id/export` | Export the `{ title, document }` the editor is showing. Returns the document, one unique stock credit per referenced asset (creator, provider, source page, license, scene ids), and a render payload with per-scene credited assets. Attribution is read from stored media rows, never the request. |

Ownership is enforced explicitly on every query: the server filters on the id verified from the session, never on a
client-supplied owner. Another account's project id reports `404 PROJECT_NOT_FOUND` for read, update, and delete, so it
does not disclose that the project exists, and the row is left untouched. A save that loses the version race returns
`409 PROJECT_VERSION_CONFLICT` and writes nothing. Request bodies are bounded (128 KB, 200-character title,
2000-character summary, 50 scenes, 20 000 characters per scene), and only known fields are accepted at every level.

Row-level security is enabled on both tables. Authenticated users may only `select` their own rows; projects and
revisions are written exclusively by the server with the service role, so document validation and the owner check
cannot be bypassed by calling PostgREST with a browser token.

### Project child tables

The remaining Phase 2 tables follow the same ownership pattern and are created by
`20261124140000_create_project_children.sql`:

| Table | Holds |
| --- | --- |
| `scenes` | The addressable form of each scene (`scene_key`, `position`), linked to a project. |
| `media_metadata` | Uploaded or generated media: kind, private object key, content type, size, status. Ownership lives in `owner_id`, never in the object key. |
| `sources` | Where material came from: kind, title, URL, retrieval time. |
| `claims` | Statements checked against a source, with an `unverified`/`supported`/`contradicted` status. |
| `generation_proposals` | A proposed generation (route, base project version, model, prompt, validated proposal JSON) and whether it was accepted. |
| `provider_jobs` | Asynchronous provider work such as JSON2Video: provider, status, external id, request/result. |
| `render_snapshots` | Outputs pinned to a project revision that must exist, enforced by a composite foreign key. |

Every table carries `owner_id`, cascades from both `projects` and `auth.users`, has RLS enabled with a
`select ... using (auth.uid() = owner_id)` policy, and grants writes only to `service_role`. One `DO` block creates all
of those policies, so no table can drift from the pattern. Six of them are reachable through owner-scoped routes:

| Route | Purpose |
| --- | --- |
| `GET`/`PUT /api/projects/:id/scenes` | Read or replace the addressable scene list (`key`, `heading`, `body`), ordered by array position. |
| `GET`/`POST /api/projects/:id/sources` | List sources, or add one. |
| `DELETE /api/projects/:id/sources/:sourceId` | Remove one owned source and every claim that cites it, so no evidence-free claim survives. |
| `GET`/`POST /api/projects/:id/claims` | List claims, or add one, optionally linked to a source of the same project. |
| `PATCH /api/projects/:id/claims/:claimId` | Set `unverified`, `supported`, or `contradicted`. |
| `GET`/`POST /api/projects/:id/proposals` | List generation proposals, or record a frozen proposal. |
| `PATCH /api/projects/:id/proposals/:proposalId` | Accept or reject a hand-recorded proposal. |
| `DELETE /api/projects/:id/proposals/:proposalId` | Delete a pending or rejected proposal (`200`); an accepted proposal is immutable (`409 PROPOSAL_ACCEPTED`). |
| `GET /api/projects/:id/planning/status` | Owner-scoped preflight: the project's live pending attempt key and start time, plus `abandonAfterMs` for sizing the browser lease. |
| `POST /api/projects/:id/planning` | Ask one configured model for a validated planning proposal (`201`); requires `Idempotency-Key`, one ledger row per attempt, and a retry with the same key replays the stored response; a different key while this project has a live attempt is `409 PLANNING_ATTEMPT_IN_FLIGHT`; stored against the given base version and never applied. |
| `POST /api/projects/:id/proposals/:proposalId/accept` | Apply a pending planning proposal, respecting locks, and save one new project version (`200`); stale proposals are `409`. |
| `GET`/`POST /api/projects/:id/jobs` | List provider jobs, or queue one. |
| `PATCH /api/projects/:id/jobs/:jobId` | Move a job's status and record its result. |
| `GET`/`POST /api/projects/:id/renders` | List render snapshots, or create one pinned to an existing revision. |

Every child route first resolves the project with the verified owner id, so another account's project id is
`404 PROJECT_NOT_FOUND` and no child row is read at all. Child writes filter on `owner_id` and `project_id` as well, so
a guessed child id cannot reach a row, and such a write is `404 CHILD_RECORD_NOT_FOUND`. A render for a revision the
project does not have is refused with `409 PROJECT_REVISION_NOT_FOUND`; the composite foreign key enforces the same
rule in the database. Replacing scenes upserts first and prunes afterwards, so a failed save cannot lose the current
list, and a key that already exists keeps its row id and `created_at`.

`media_metadata` and the Phase 3 `media_references` table are exposed through the private media routes below. They use
the same policies and grants as the other child tables.

`profiles` (`20261124150000_create_profiles.sql`) is the per-user workspace record: `owner_id` is its primary key, so
each account has exactly one, and deleting the account cascades it. It uses the same policy and grant shape.

## Private media (Phase 3)

Files live in a **private** R2 bucket. The Node server holds the S3 credentials and signs every request; the browser
receives a short-lived URL for one object and never sees a credential. Ownership always comes from the verified
Supabase session and lives in `media_metadata.owner_id`. The object key (`media/<owner-id>/<media-id>`) is only an
address: every route first resolves the project with the verified owner id, so a guessed key or id reaches nothing.

A presigned URL is a capability with an expiry, not a media id. Clients store the media id and request a fresh URL when
they need it. Phase 9 will use the same rule for JSON2Video inputs: an input URL is requested with a TTL that covers
queueing, retries, and rendering, and is refreshed for a retry rather than persisted as durable media metadata.

### Routes

| Route | Purpose |
| --- | --- |
| `GET /api/projects/:id/media` | List the project's media with status and reference count. |
| `POST /api/projects/:id/media` | Reserve an upload from `{ kind, contentType, byteSize, sceneKey? }`. Returns the media row and a presigned `PUT` ticket. |
| `POST /api/projects/:id/media/:mediaId/complete` | Verify the stored object and mark the media `ready`. |
| `GET /api/projects/:id/media/:mediaId/url` | Presigned playback URL for ready media. |
| `GET /api/projects/:id/media/:mediaId` | One media row plus its references. |
| `DELETE /api/projects/:id/media/:mediaId` | Delete an asset with no references and no saved scene asset id (`409 MEDIA_IN_USE` / `409 MEDIA_ASSET_IN_DOCUMENT` otherwise). |
| `GET`/`POST /api/projects/:id/media/:mediaId/references` | List or attach a reference (`scene`, `render`, `document`, `other`). Attaching is idempotent. |
| `DELETE /api/projects/:id/media/:mediaId/references/:referenceId` | Release one reference. |

### Upload and validation

The upload is direct: `POST` reserves a `pending` row and returns a presigned `PUT` (15 minutes by default). The client
uploads bytes straight to R2, then calls `complete`. Completion does not trust the declared type or size:

- `HEAD` gives the real byte size; an object larger than the declared size or the kind's bound is discarded.
- A signed `Range` read of the first 512 bytes identifies the actual format (JPEG, PNG, GIF, WebP, MP3, WAV, OGG,
  AAC, M4A, MP4, WebM, QuickTime). A file that is not of the declared kind is discarded with `422 MEDIA_TYPE_MISMATCH`.
- The stored `content_type` is the detected type, not the client's claim.
- A missing object is `409 MEDIA_OBJECT_MISSING`; an upload window that closed is `409 MEDIA_UPLOAD_EXPIRED`.

Media ids are server-generated UUIDs. A per-account quota (`MEDIA_OWNER_STORAGE_BYTES`) is checked before a reservation
is written. All media routes need the verified session and an owned project; another account's project answers exactly
like a missing one (`404`).

Browser uploads and playback are cross-origin requests to the bucket, so the bucket needs an exact-origin CORS rule.
[`cors.json`](cors.json) holds the narrow rule applied to `story-frame` on 2026-11-24: `GET`/`PUT`/`HEAD`, the
`Content-Type` request header, and `ETag`/`Content-Length` exposed, for `http://localhost:3000` and the current cloud
preview origin. Apply or replace it with:

```bash
npx wrangler r2 bucket cors set <bucket> --file cors.json
npx wrangler r2 bucket cors list <bucket>
```

The preview hostname in `cors.json` is per-chat; replace it when the preview origin changes or before a deployment.
Probed against the real bucket: an allowed-origin preflight returned `204` with that exact origin, a disallowed origin
returned `403` with no allow-origin header, and a presigned `GET` carried the allow-origin and exposed headers.
Every live check that uploads (`verify:r2-live`, `verify:media-live`, `verify:narration-live`) now preflights a real
presigned upload from the origin in `cors.json`, so a bucket rule left on an old hostname fails the run instead of only
surfacing as a 403 in the browser. Measured with a stale origin: `403`, no allow-origin, and the suites dropped to
`7/8`, `37/38`, and `34/35`.

### Deletion, references, and retention

Deleting an asset first counts its references: explicit rows in `media_references` plus its `scene_key`. While any
reference remains the object and row stay untouched (`409 MEDIA_IN_USE`); removing one reference leaves the others
valid. Once the last reference is released, `DELETE` marks the row `deleted` and then removes the object, so a bucket
failure cannot leave a ready row without its file; retention retries that removal.

Deleting a **project** also removes the objects uploaded for it. The object keys are read before the media rows
cascade with the project, then each object is deleted after the project row is gone. That cleanup is best effort: a
bucket failure at that moment leaves an object without a record and is logged, rather than refusing a project delete
the caller asked for.

Cleanup is scheduled and bounded. A background sweeper runs one batch every `MEDIA_SWEEP_INTERVAL_MS` (default 60 s),
so an idle server still expires interrupted uploads and retention rows; media requests may also trigger a pass, but
never sooner than the same interval, and a pass that is still running is never overlapped. A failed pass is logged and
retried on the next tick. Setting the interval to `0` turns the timer off and leaves only the request-triggered pass:

- pending uploads past their window are removed (interrupted uploads);
- deleted rows past `MEDIA_DELETED_RETENTION_MS` are removed;
- ready assets with no `scene_key` and no explicit reference, older than `MEDIA_UNREFERENCED_RETENTION_MS`, are removed.

A database row is removed only after its object removal is attempted, so a bucket hiccup leaves the row for the next
pass instead of orphaning an object. Signed URL query strings are never logged.

### Bucket-vs-database audit

```bash
R2_BUCKET_NAME=<bucket> npm run audit:media
```

The ordered removals above normally leave no drift, but a bucket failure during a project deletion is logged and
cannot be retried from the deleted rows, and a crash between the two steps can leave one side behind. This command is
the safety net: it lists every object under `media/` and every `media_metadata` row, both fully paged, and reports

- **orphan objects**: bucket objects that no row owns (a cleanup that never reached the bucket);
- **ready rows without an object**: playback would fail with `409 MEDIA_OBJECT_MISSING`.

A pending upload without an object is the normal in-flight state, and a deleted row whose object is already gone is
just waiting for retention, so neither is drift. The command is **read-only** and prints at most 100 entries per side
while counting all of them. Exit codes: `0` clean, `1` drift found (or the audit could not complete, so drift is
unknown), `2` missing configuration. It needs
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the R2 endpoint, bucket, and credentials; it never prints a key or a
signed URL. Run on 2026-11-25 against the configured project and the `story-frame` bucket: 0 rows, 0 objects, no
drift.

## Phase 4: dashboard, brief, script, and storyboard (2026-11-24)

The signed-in screen is now a workspace. `src/workspace/Workspace.tsx` lists the caller's projects and creates one of
the three kinds; `ProjectEditor.tsx` owns one open project and its tabs: **Brief, Script, Storyboard, Media, Preview,
Settings**. Saves are explicit (one save is one revision), the header always shows unsaved/saved state, and a version
conflict keeps the draft while offering **Load latest version**. The Phase 1–2 connection test remains mounted below
the workspace in a developer harness.

**Single-source wording and stable ids.** Narration lives only in `document.scenes[].body`. The Script, Storyboard,
Preview, and script export all read that same field. Scene ids are stable through reordering, duplication creates a
fresh id, and the server rejects duplicate ids.

**Locks.** Each scene has independent locks for narration, visual direction, on-screen text, and duration. The server
compares the submitted document with the stored one: a component that is locked in both cannot change (`409
SCENE_FIELD_LOCKED`), and a scene with any lock cannot be deleted (`409 SCENE_LOCKED`). Unlocking in the same write is
the user's explicit decision and therefore permits the edit. The UI disables locked fields and scene deletion as well.

**Approvals and staleness.** Approving a scene stores a 64-bit content fingerprint over its heading, narration,
visual direction, on-screen text, duration, and ordered asset ids. The UI derives staleness by comparing the stored
fingerprint with the current draft, so an edit shows **Approval out of date** immediately. A save that carries an
approval for different content clears it rather than silently approving the new wording; re-approval stores the new
fingerprint. This is intentionally exact content, not a revision-counter heuristic.

**Media from the UI.** The Media tab exercises the committed private-storage API end to end: initiate, direct
presigned `PUT` from the browser, complete, attach a scene reference, append the media id to `scene.assetIds`, and
save the document. Playback requests a fresh short-lived presigned URL and renders an image/audio/video element; a
referenced asset is refused deletion by the media store. Each attached scene is listed with a **Detach** action that
releases that reference, removes the id from the saved document, and leaves the asset deletable. Credentials and
object keys never reach the browser.

**Preview and export are honest.** Preview is labelled a storyboard preview, not a rendered movie, and shows exactly
the stored script, visual direction, on-screen text, media count, timing, and approval state. Export offers the
editable project JSON and the script as plain text; video export is not offered and is documented as Phase 9. Both
downloads use the export route, so imported stock media carries its stored creator, provider, source page, and
license: the JSON includes a deduplicated credit list and the per-scene render payload, and the script ends with a
`CREDITS` block.

### Phase 4 verification (2026-11-24)

| Criterion | Status | Evidence |
| --- | --- | --- |
| Dashboard create/open/delete and complete editable storyboard reopen | **PASS** | `tests/workspace.test.tsx`: create, edit brief, save, back, reopen, saved script returned |
| Scene add/edit/duplicate/delete/reorder with stable ids | **PASS** | Same UI test plus server reorder test; duplicate gets a new id, remaining ids survive reorder, duplicate ids rejected |
| Independent component locks enforced in mutations and server updates | **PASS** | `tests/projects-v2.test.ts`: locked narration edit refused, unlock+edit allowed, locked deletion refused; UI disables locked fields |
| Exact content fingerprints for approval staleness | **PASS** | Server keeps an approval only when its fingerprint matches; UI shows **Approval out of date** after a narration edit and server clears it on save |
| Duration totals and target comparison | **PASS** | Script/storyboard totals update through duplicate, delete, and retime; asserted `0:30` → `0:50` → `0:35` against a `1:00` target |
| Optimistic conflicts keep the draft and allow reload | **PASS** | Server `409 PROJECT_VERSION_CONFLICT`; UI test asserts the draft survives and **Load latest version** restores the stored brief |
| Bounded history | **PASS** | `GET /api/projects/:id/revisions` returns the 20 newest summaries, owner-scoped; Settings lists them |
| Media upload/playback exercised from the UI | **PASS** | UI test covers initiate → direct PUT → complete → scene reference → asset id save → presigned playback; the automated media E2E is 38/38 against hosted Supabase and the real bucket |
| Document v1 rows remain readable | **PASS** | Migration test reads a stored v1 row, returns v2 with defaults, and saves it back as v2 |
| Typecheck, unit/UI tests, SQL, and live route suites | **PASS** | `npm run check`; `npm test` 261/261; `verify:sql` 89/89; `verify:stock-live` 8/8; `verify:stock-routes-live` 23/23; `verify:live-routes` 51/51; `verify:r2-live` 8/8; `verify:media-live` 38/38 |
| Locks enforced on a direct API write, not just disabled fields | **PASS** | In the real browser, a locked narration edit sent straight to `PUT /api/projects/:id` returned `409 SCENE_FIELD_LOCKED` and left the stored document at the same version and wording |
| Stale approval cleared by the server on save | **PASS** | Editing approved narration showed **Approval out of date** immediately; saving returned `approved: false` and a null fingerprint at version 6 |
| Responsive layouts visually reviewed | **PASS** | Real browser at 320, 360, 390, 768, and 1280 px on all six editor tabs: no horizontal overflow. The review found and fixed a 320 px overflow caused by the editor's implicit grid column and the storyboard's fixed 290 px minimum |
| Real browser sign-in and upload against hosted Supabase/R2 | **PASS** | Disposable hosted user signed in through the browser; a 7.7 KiB PNG went initiate `201` → direct presigned `PUT 200` to the `story-frame` bucket → complete `200` → scene reference `201` → saved asset id → presigned playback `GET 200`, with the image decoding at 64 px and a one-reference count |
| JSON/script download clicked in a browser | **PASS** | Both export buttons downloaded through the browser; the JSON parsed as a schema 2 document with the saved brief, scene ids, durations, asset id, and approvals, and the script text matched the stored narration and visual direction |
| Hosted browser test cleanup | **PASS** | Reference release then media delete returned `200`, project delete returned the dashboard to 0 projects, the disposable user and every project/media/profile row were deleted, and the R2 object answered `The specified key does not exist` |
| Project deletion removes uploaded objects | **PASS** | `tests/media.test.ts`: a completed upload exists in the fake bucket, project `DELETE` returns `200`, the object and media rows are gone, and the project reads `404`; a second case seeds 205 objects across two store pages and asserts all are removed. `verify:media-live` also checks this against hosted Supabase and the real bucket |
| Detach from a scene, then delete the asset | **PASS** | `tests/workspace.test.tsx`: Detach releases the reference, clears `scene.assetIds`, saves, and Delete asset then succeeds; a retry after a failed save releases the already-missing reference and completes the save instead of dead-ending |
| A document-listed asset cannot be deleted | **PASS** | `tests/media.test.ts`: with no reference but the saved scene still listing the asset id, `DELETE` returns `409 MEDIA_ASSET_IN_DOCUMENT` and keeps the object and row; removing the id lets the same delete return `200`. `verify:media-live` checks the same guard against hosted Supabase and real R2 |
| Retention spares a document-listed asset | **PASS** | `tests/media.test.ts`: an unreferenced ready asset past retention survives two sweeps while a saved scene lists it, then is removed once the id is gone; 30 protected rows (more than one 25-row batch) do not stop a later expired asset from being cleaned |
| Saved scene asset ids must be ready media | **PASS** | `tests/media.test.ts`: a ready asset in the project saves; a malformed id is refused before the media lookup, as are an unknown id, a pending upload, an asset from another project, and a deleted asset (`422 MEDIA_ASSET_INVALID`), and the stored document keeps its previous ids; creating a project with any asset id is also refused; 101 UUID-shaped ids spanning two lookup chunks save, while a missing id in the second chunk is refused |
| Expired media is cleaned without waiting for a media request | **PASS** | `tests/media.test.ts`: with a 40 ms interval and a zero upload window, an interrupted upload and its object are removed by the timer while no media route is called. `tests/media-scheduler.test.ts`: one pass per interval, no overlap while a pass runs, a failing pass is logged and the next tick still runs, and interval `0` disables the timer |
| Bucket and database drift is detectable | **PASS** | `tests/media-audit.test.ts`: a matching pair reports no drift (a pending upload without an object is not drift); a bucket object with no row and a ready row with no object are each reported; the scan pages past 205 rows and 205 objects with page size 25; the audit leaves both sides untouched. `npm run audit:media` ran clean on 2026-11-25 against hosted Supabase and the real bucket (0 rows, 0 objects), and `verify:r2-live` proves the signed list it pages |

The browser run on 2026-11-24 also exposed a double-counted media reference: the Media tab sent `sceneKey` at initiate
and then attached the same scene as an explicit reference, so the store counted two references while the list showed
one and deletion could not be resolved from the UI. The upload now registers the scene link once, as the explicit
reference; the row and the delete guard agree.

**FAIL: none in the Phase 4 scope.** Restoring an old revision from Settings is not implemented; history is read-only
in Phase 4.

## Phase 5: six-model routing and AI planning (2026-11-25)

Planning is the first billable generation step. One configured model answers one JSON request per task, and the reply is
validated here, never trusted. A validated reply is stored as a **proposal**; accepting it is a separate, explicit
action that writes a new project version.

**Registry and routing.** `server/planning.ts` holds the registry metadata: family, capabilities, input/output limits,
cost-rate version (`unpriced` until Phase 14), catalog check date, and `testedOn` (null until a route is really
evaluated). `GET /api/ai/status.planning` reports every route, its configured model, availability and reason, plus each
model's last successful call read from the `model_health` table. Routing is configuration, not a quality claim:

| Route | Environment variable | Default |
| --- | --- | --- |
| `angles` | `AI_ROUTE_ANGLES` | `gemma` |
| `script` | `AI_ROUTE_SCRIPT` | `gemma` |
| `storyboard` | `AI_ROUTE_STORYBOARD` | `gemma` |
| `ad-concept` | `AI_ROUTE_AD_CONCEPT` | `gemma` |
| `transcript-analysis` | `AI_ROUTE_TRANSCRIPT_ANALYSIS` | `gemma` |

A value that is unknown, disabled, or missing the capability disables the route (`503
PLANNING_ROUTE_UNAVAILABLE`) instead of silently falling back. One request uses one model; there is no fan-out across
the six families.

**Validated JSON, one disclosed repair.** The prompt asks for JSON; the server parses and validates every field itself,
because Ollama Cloud does not enforce a schema. Exactly one repair request is made after a validation failure, and the
stored proposal carries `repairAttempted: true`. A second failure is `422 PLANNING_INVALID_JSON` and nothing is stored.
Unknown fields (including any attempt to supply media ids), provider-set flags, scene durations outside 1–600, rewritten
storyboard wording, and citations that are not verbatim excerpts all fail validation. Each route's built-in instruction
names the exact root keys, counts, and field names that validator accepts, and forbids every other key, because an extra
key or a wrong count costs a repair call. `claims` is invited only by `script`, `ad-concept`, and `transcript-analysis`,
and only for a factual brief with supplied excerpts; `angles` and `storyboard` never invite it.

**Proposals are not accepted content.** `POST /api/projects/:id/planning` stores a proposal against the reviewed
project version. `POST /api/projects/:id/proposals/:proposalId/accept` re-checks that it is still pending and that its
base version still matches the project (`409 PROPOSAL_STALE` otherwise; a hand-recorded Phase 2 proposal is `409
PROPOSAL_NOT_APPLICABLE`). Accepting applies the payload, respects every lock, clears approvals for changed content,
writes one new revision, and marks the proposal accepted. Angles record the decision without changing the document;
transcript clips become appended scene drafts with new ids and no media links.

**Evidence in the editor.** The **Sources** tab writes the project's source rows: kind, title, optional URL, and the exact
excerpt planning may quote. An excerpt is what makes factual planning possible; a source without one is stored but never
treated as evidence. Source text is delimited as `<<<SOURCE ... SOURCE>>>` in the prompt and explicitly labelled
untrusted data, so instructions inside a source cannot redirect the reply.

**Factual mode and storyboards.** Claims carry a source id and a quote. The server marks a claim supported only when the
quote is a verbatim excerpt of that supplied source; an empty quote is stored as `unverified`. Factual planning (and
transcript analysis) with no supplied excerpt never calls a model: it stores planning notes with
`insufficientEvidence: true`. A storyboard must return one draft per stored scene, in order, with heading and narration
copied word for word. Claims are written only on acceptance, and the response says whether that write succeeded.

**Billable safety.** `POST /api/projects/:id/planning` requires an `Idempotency-Key` (8–128 characters, same pattern as
`/api/ai/test`). Before the provider is contacted, the server reserves a row in the existing `ai_usage` ledger with the
verified user id, the key, a hash of the route, configured model, and exact prompt, and the configured model id. A
completed attempt stores its `{ ok, proposal }` body, so a retry with the same key returns the same proposal without a
second provider call or a duplicate proposal row; a refused reply is stored and replayed too. Reusing the key for a
different route, instruction, or document returns `409 IDEMPOTENCY_KEY_REUSED`; a still-running attempt returns `409
IDEMPOTENCY_IN_PROGRESS`; an attempt older than the planning window is settled as `REQUEST_ABANDONED` without calling
the provider. The planning window is the larger of `AI_ABANDON_AFTER_MS` and two provider timeouts plus three auth
timeouts, so the initial call and its one repair both fit. The key is scoped to the verified account and the project: the same key from another account, or in
another project with an identical document, is a separate attempt and can never read the first attempt's response.
The ledger row records `project_id`, and a partial unique index allows only one `pending` attempt per project, so two
near-simultaneous reservations cannot both start a paid call.

**One attempt per project, across devices.** Before a new paid call, `GET /api/projects/:id/planning/status` reports the
project's live pending attempt for the verified owner. A live attempt with a different key blocks generation with `409
PLANNING_ATTEMPT_IN_FLIGHT`; the same key is allowed so Retry can replay its own attempt. An attempt older than the
planning abandon window is settled as `REQUEST_ABANDONED` first, exactly like same-key recovery. The browser also
calls this preflight before acquiring its local lease, so a stale tab on another device, or a browser without
BroadcastChannel, is blocked by the server instead of only by `localStorage`. The response's `abandonAfterMs` sizes
the new local lease, matching the server window (90 seconds by default).

The browser keeps an unsettled key in `sessionStorage` for at most 24 hours, and a per-project `localStorage` lease
stops a second tab from starting a duplicate attempt while the first is waiting. The lease is released when an attempt
settles (success or a recorded refusal) and retained until the server's abandon window ends when the outcome is unknown:
Stop waiting, unmount, a network failure, or `IDEMPOTENCY_IN_PROGRESS`/`LEDGER_UNAVAILABLE`. The tab id lives in
`sessionStorage`, so a reload recognizes its own retained lease instead of locking itself out, and the pending route and
instruction are restored so Retry rebuilds the same request and reuses the key. Because a duplicated tab copies
`sessionStorage`, a mounted panel probes a BroadcastChannel for a live page using the same tab id; if one answers, the
duplicate mints a fresh id and leaves the inherited lease with the original tab. An expired lease no longer blocks
generation. If the outcome cannot be recorded after the provider answered, the proposal is still returned with
`X-Storyframe-Usage: unrecorded`. The no-evidence short-circuit makes no provider call,
so it writes no ledger row and does not consume the key.

### Phase 5 verification (2026-11-25)

| Criterion | Status | Evidence |
| --- | --- | --- |
| Registry is configurable and exposes real health | **PASS** | `tests/planning.test.ts`: an override naming an unregistered model disables the route (`503`, status reports `available: false`), and a successful call records `lastSuccessAt` reported by `/api/ai/status.planning` |
| One model per task, no fan-out | **PASS** | The script generation test asserts exactly one provider call, with the route's request id and a planning output bound |
| JSON is independently validated with one repair | **PASS** | Invalid reply then valid reply → stored with `repairAttempted: true`, two calls; invalid twice → `422 PLANNING_INVALID_JSON`, two calls, no proposal row; unknown field (media id) → refused |
| Proposals stay separate from accepted content | **PASS** | Generating leaves the project at version 1; accepting writes version 2 and the reopened project carries the script; accepting twice is `409 PROPOSAL_NOT_PENDING` |
| Stale results are refused | **PASS** | A save after generation makes acceptance `409 PROPOSAL_STALE` and leaves the stored document untouched |
| Locks win over a proposal | **PASS** | Script proposal with a rewritten locked narration: acceptance keeps the locked line, writes the unlocked visual, and appends the new scene |
| Storyboard preserves wording, order, and valid durations | **PASS** | Two-scene document: headings/narration/ids unchanged, visual direction and durations applied; a rewritten narration is refused after repair |
| Factual evidence maps to sources and exact quotes | **PASS** | Quoted claim is `supported` with its verbatim quote; unquoted claim is `unverified`; acceptance stores both with the quote; no excerpts → planning notes and zero provider calls |
| Transcript analysis quotes real transcript text | **PASS** | Clip becomes a scene with the quoted words and computed duration; an invented quote is refused and stores nothing |
| Planning is owner-scoped | **PASS** | Another account gets `404` on generate and on accept, and the provider is not called |
| Planning calls are metered and replayable | **PASS** | Generating stores one `ai_usage` row (`model_id: gemma`, `configured_model: gemma4:31b`, `response_status: 201`) and a retry with the same key returns the same proposal id after exactly one provider call and one proposal row |
| Key reuse and account scoping | **PASS** | The same key with a different instruction is `409 IDEMPOTENCY_KEY_REUSED` with no second call; the same key from another account is a separate attempt, and each account replays only its own proposal |
| One live attempt per project, across devices | **PASS** | `tests/planning.test.ts`: the status preflight reports another device's pending key and start time, another account gets `404`, a new key is `409 PLANNING_ATTEMPT_IN_FLIGHT` with zero provider calls, and a stale pending row is settled before the new key is reserved. Repair-window tests age a pending attempt past the old single-call window: the status route still reports it live, a second key is refused without a provider call or abandonment, and a same-key retry returns `IDEMPOTENCY_IN_PROGRESS` instead of settling the row. A race test hides the preflight's pending read so the unique index rejects the second reservation, then asserts the route still returns the in-flight `409`. `tests/usage.test.ts` reserves two keys for one project directly against the ledger and gets `project_busy` for the second. `verify:sql` proves the partial unique index rejects a second pending row for the project while another project can reserve one |
| Browser lease matches the server abandon window | **PASS** | `tests/planning-panel.test.tsx`: a server `abandonAfterMs` of 120 seconds produces a lease about 120 seconds out, a remote pending attempt disables Generate and makes no `/planning` call, and the same key reported by preflight is allowed so Retry can replay |
| A late preflight cannot cross projects | **PASS** | `tests/planning-panel.test.tsx`: a deferred planning-status response resolved after switching to project B leaves neither project leased, shows no remote notice, keeps Generate enabled, and makes no `/planning` call; resolving after unmount acquires no lease and starts no call |
| Refused replies are recorded and replayed | **PASS** | Invalid twice stores an `ai_usage` error row (`PLANNING_INVALID_JSON`, `422`), and a retry with that key replays the `422` without another provider call |
| Planning without a key is refused | **PASS** | A request with no `Idempotency-Key` is `400 IDEMPOTENCY_KEY_REQUIRED` before the provider or the ledger is touched |
| Evidence can be supplied in-app | **PASS** | `tests/sources-panel.test.tsx`: add a source with kind, title, URL, and excerpt, see it listed, flag an excerpt-less source as unusable evidence, require a title, and delete; the Sources tab is wired into the editor and reads the existing owner-scoped routes |
| Source text is treated as data | **PASS** | `tests/planning-prompt.test.ts` places an excerpt inside `<<<SOURCE ... SOURCE>>>` and asserts the prompt calls it untrusted data that must not be followed as instructions |
| Route instructions match the validator | **PASS** | `tests/planning-prompt.test.ts` (6 tests) asserts every route names its exact root keys, counts, scene/clip fields, and duration bounds under "only these keys", keeps factual claims available to script/ad-concept/transcript-analysis, and withholds them from angles/storyboard; the tightened `angles` instruction then passed a live call with no repair |
| Hosted schema and live routes | **PASS** | Migrations 7 and 8 are applied to the hosted project (2026-11-25); probes for every new column, `model_health`, and `ai_usage.project_id` return `200`, and the partial unique pending-attempt index is present. `verify:live-routes` passes 51/51, including `ledger.ready: true` and the owner-scoped planning-status route reporting a seeded pending attempt then clearing after settlement |
| One real hosted planning call | **PASS** | 2026-11-25, first call before tightening: `angles` → `gemma4:31b`, `201`, 3 angles, but `repairAttempted=true` (ledger tokens 715/514, latency 2311 ms). After tightening, a second call with no caller instruction: `201` in 1932 ms, `repairAttempted=false`, 3 angles; ledger `success`/`201`, tokens 301/266, latency 1144 ms, stored proposal id; same-key replay `201` in 493 ms with the same proposal and still one ledger row; proposal, project, ledger row, profile, and user deleted, cleanup read back zero rows |
| Plan tab behavior | **PASS (DOM)** | `tests/planning-panel.test.tsx`: list, generate, review, and accept through the panel, with nothing applied before acceptance and both actions disabled while the draft is dirty; Stop waiting aborts the browser request while keeping the key and recording a `stopped` attempt; expired keys are replaced; a second tab's lease disables generation, while an expired lease and a duplicated tab that inherits the lease are handled; a reload restores the pending route and instruction and replays the same key. `tests/workspace.test.tsx` drives the real Workspace from the Plan tab through generate, a full remount that replays the `sessionStorage` key, and accept; the provider is stubbed, so it spends nothing. Not exercised in a real browser in this environment |
| Pending proposals have a lifecycle | **PASS** | `tests/planning.test.ts`: a pending proposal deletes `200` and disappears from the list; an accepted proposal refuses deletion with `409 PROPOSAL_ACCEPTED` and stays stored. `tests/planning-panel.test.tsx`: Delete proposal → Confirm delete removes it without changing the project |
| Deleting a source cannot leave supported orphans | **PASS** | `tests/planning.test.ts`: after two accepted claims cite a source, deleting that source removes both claims and the source row, so no `supported` claim outlives its evidence |
| Unknown outcomes keep the tab lease | **PASS** | `tests/planning-panel.test.tsx`: Stop waiting, unmount, a network failure, and both `IDEMPOTENCY_IN_PROGRESS` and `LEDGER_UNAVAILABLE` leave the per-project lease in `localStorage`; a successful replay clears it. A reload reuses the same `sessionStorage` tab id and can retry its own lease |
| A cloned tab cannot inherit the lease | **PASS** | `tests/planning-panel.test.tsx` stubs a live BroadcastChannel peer for the inherited tab id: the panel mints a fresh id, keeps the original lease in place, disables generation, and never calls `/planning`. A silent peer times out instead, after the probe is observed, and the reloaded tab reuses its stored key. A second PlanningPanel mounted with Node's real BroadcastChannel is blocked while the first holds the lease through an in-flight attempt, and the lease keeps the original tab id |
| Expired leases stop blocking | **PASS** | `tests/planning-panel.test.tsx`: a lease expired one second ago leaves Generate enabled; one call succeeds and the new lease is cleared |
| Pending request identity survives reload | **PASS** | `tests/planning-panel.test.tsx`: a stored `script` route and instruction are restored into the form, and Retry sends the stored Idempotency-Key instead of minting a new one |
| Attempt history is visible and local | **PASS** | `tests/planning-panel.test.tsx`: a successful attempt appears as `Succeeded`, survives an unmount/remount, and a cancelled attempt is recorded as `stopped`; history is capped and stored in `localStorage`, never in the project |

### Phase 6: stock search (2026-11-25) — complete

`GET /api/stock/search?q=...&type=image|video&sources=pexels,pixabay` requires a verified Supabase session. The
unprefixed `/stock/search` from the phase contract is accepted as an alias; `/api/stock/search` is canonical because it
travels through the existing dev proxy and origin check. `sources` may repeat or be comma-separated: duplicates are
collapsed, and an empty or unknown selection is `400` rather than a silent search of everything.

Both providers are normalized into one result: `provider`, `providerId`, `type`, `title`, `previewUrl`, `renditions`,
`selectedRendition`, `sourcePage`, `creator`, `attribution`, `license`, the selected rendition's real `width`/`height`,
`durationSeconds`, and provider status (count, page, `hasMore`, cache hit, remaining rate limit, sanitized error code).
Video renditions are chosen by both dimensions and aspect ratio: a portrait or square crop of a 16:9 source is never
selected, a file labelled `video/mp4` but pointing at an `.m3u8`/`.mpd`/`.ts` playlist is excluded, and video previews
use the thumbnail the provider supplied. Pexels photo results report the original's actual dimensions; Pixabay reports
preview, web-format, and original dimensions. Pagination is **per provider**: `page=N` is sent to each selected
provider, then the normalized pages are merged, so `hasMore` is reported per provider. The Media tab's **Load more**
requests page N+1 from the search that produced the current results, merges the new pages, skips assets already shown,
and disappears once no provider reports `hasMore`.

**Durable shared cache.** Normalized pages are stored in `public.stock_search_cache` (service-role only, keyed by a hash
of provider, type, page, and normalized query). A search reads the row, and a miss inserts a short lease claim with
`Prefer: resolution=ignore-duplicates`; exactly one request fetches the provider, while concurrent requests poll for
that page. A dead claim is taken over after its lease expires, a failed provider call releases it, and expired rows are
pruned. Pixabay pages live for at least 24 hours, as its terms require; Pexels pages default to one hour. Cached
payloads are byte-bounded and oversized pages are not stored. If the cache table is unavailable, search still works but
reports `STOCK_CACHE_*` logs and calls the provider uncached.

**Import.** `POST /api/projects/:id/stock/import` takes the selected result's provider, id, type, rendition, URL, source
page, creator, attribution, and license. The server proves project ownership, then downloads only from
`https://images.pexels.com`, `https://videos.pexels.com`, or `https://cdn.pixabay.com`, re-validating every redirect hop,
refusing credentials, custom ports, non-https URLs, and hosts that resolve to loopback, private, link-local, shared, or
reserved addresses. The body is capped while streaming (image and video limits from the media settings), a playlist MIME
type is refused, and magic bytes must match the selected type. Accepted bytes are written to private R2 through a
server-created presigned URL, the media row becomes `ready`, and the validated provenance is stored as JSONB on the row
and returned by the media routes. Importing the same provider, asset id, and rendition again into the same project
returns that ready asset (`200`, `reused: true`) without downloading or storing a second copy; another project or
rendition is a separate asset. The pre-check is a fast path, not the guarantee: a partial unique index on the ready row
(`media_metadata_ready_stock_import_key`) settles simultaneous imports, and the losing request reuses the winner's
media while its own reservation and object are discarded. Nothing is attached to a scene unless the UI does it
explicitly.

**UI.** The Media tab has a stock search form (query, image/video, per-provider checkboxes) and a separate preview grid.
Each preview shows the provider, dimensions, selected rendition, creator, source link, and license link, and imports only
when **Import to project** is pressed. Imported assets appear in Project media with their provenance and can use the
existing attach/detach/delete flow. **Export** carries that provenance: the Preview tab's JSON export includes the
document, unique stock credits, and a render payload with per-scene credited assets, and the script text ends with a
`CREDITS` block. Provider failures are listed per provider; one failure does not hide the other's results.

**Status.** Every Phase 6 contract item is implemented and exercised: one protected search endpoint with normalized
results, per-provider pagination surfaced in the UI, the durable shared cache with Pixabay's 24-hour window, a
controlled import with provenance, credited exports, and live acceptance runs for real image/video search and import.
Phase 7 (Cloudflare Workers AI and Leonardo image generation) is implemented with a Generate tab, persisted cost capture,
and recoverable pending jobs. Phase 8 (Deepgram narration and uploaded audio) is implemented with a Narration tab,
persisted private audio, script-staleness fingerprints, measured duration warnings, and uploaded narration/music controls.

### Phase 6 verification (2026-11-25)

| Criterion | Status | Evidence |
| --- | --- | --- |
| Per-provider pages merge through Load more | **PASS** | `tests/stock-panel.test.tsx`: the first page renders one Pexels preview with a failed Pixabay provider; **Load more (page 2)** sends `page=2` with the original query, appends the second page's preview, keeps the first, and removes the control when no provider has more |
| Protected search with normalized fields | **PASS** | `tests/stock.test.ts`: anonymous `401`; one image search returns Pexels and Pixabay results with provider, id, title, preview, renditions, source page, creator, attribution, license, real dimensions, and duration; a video search reports the selected 1920×1080 rendition |
| Hardened provider handling | **PASS** | Same file: duplicate/unknown/empty sources `400`; portrait crops are never selected for a 16:9 source; a `video/mp4` link ending in `.m3u8` is excluded; video previews come from provider thumbnails; a provider failure yields a sanitized code and the response never contains the provider key or URL |
| Durable shared cache and stampedes | **PASS** | Two identical searches make one provider call each, the second reports `cached: true`, and `stock_search_cache` holds two ready rows with a Pixabay TTL of at least 24 hours; two concurrent searches still make one call per provider; a simulated cache outage leaves search working |
| Repeated imports reuse one asset | **PASS** | `tests/stock.test.ts`: importing the same provider, asset id, and rendition twice makes one R2 write and one ready media row, returns the first media id with `reused: true` at `200`, and does not fetch the asset again; two simultaneous imports held at the asset fetch produce one `201` and one `200`, the same media id, exactly one ready row and one settled reservation; the same asset in another project is a separate `201` asset. `verify:sql`: a second ready row for the same rendition is rejected `23505`, while a deleted duplicate is allowed. `tests/stock-panel.test.tsx`: a reused import reports it and leaves one media item |
| Credits travel with exports and render payloads | **PASS** | `POST /api/projects/:id/export` returns the draft document, one unique credit per referenced stock asset carrying creator, provider, source page, license, and every scene id, plus a render payload with per-scene credited assets; missing, not-ready, and non-stock asset ids are ignored. `tests/preview-export.test.tsx` downloads the JSON and script from the UI and asserts the credit fields and the `CREDITS` block |
| Controlled import with provenance | **PASS** | Imported image bytes are in R2 under `media/<owner>/<id>`, the row is `ready`, JSONB provenance is stored and returned; video import is detected as `video/mp4`; foreign hosts, internal names, a redirect to another host, `http://`, oversized bodies, `text/html`, and playlists are refused; a foreign project is `404`; a type mismatch is `422` |
| Previews stay separate from project assets | **PASS (DOM)** | `tests/stock-panel.test.tsx`: searching writes nothing to `/media`, the credit link and license link render with their URLs, the failed provider is reported, and only **Import to project** posts the import body and adds a `ready` asset; the media item then shows the stored provider, creator, source link, and license |
| Real provider searches | **PASS** | `npm run verify:stock-live` on 2026-11-25: image "rainy city street" merged 40 results (Pexels 20 + Pixabay 20) and video "ocean waves" merged 40, all with credit, source page, selected rendition, and no playlist renditions; 8/8 checks |
| Import into a hosted project | **PASS** | `npm run verify:stock-routes-live` on 2026-11-25 against hosted Supabase and the real `story-frame` bucket: a selected image imported `201` with `ready` media and provenance, a repeat import returned the same media (`200`, `reused: true`) without a second object, it appeared in the media list with that provenance, a draft referencing it exported with the stored creator, provider, source page, and license in `credits` and the per-scene render payload, it returned a presigned playback URL, deleted `200` with its object, and the deleted row stopped being ready; 23/23 checks, including cache rows and cleanup |
| Hosted schema | **PASS** | `20261125160000_add_stock_media.sql` applied through the Supabase management API on 2026-11-25; the catalog reports `media_metadata.provenance` plus its object constraint, `stock_search_cache` with RLS on, `service_role` grants, and zero `authenticated` grants; `media_metadata_ready_stock_import_key` was applied on 2026-11-25 after confirming the hosted data had no duplicate ready groups; `verify:stock-routes-live` then wrote and read both through the routes |

### Phase 7: image generation route (2026-11-25)

`server/image-providers.ts` contains separate Cloudflare Workers AI and Leonardo adapters with a small verified model
catalog. Generation is never automatic: a caller reads the models, asks for an estimate, then explicitly posts a
generation. The server resolves and validates the prompt and settings before creating one `image_generations` row, calls
exactly the selected provider, and stores the returned bytes in R2 through the same private-media path as an upload. If
the provider is not configured the route refuses with `503 IMAGE_PROVIDER_DISABLED`; there is no fallback provider.

| Route | Method | Behavior |
| --- | --- | --- |
| `/api/image-models` | GET | Signed-in catalog with prompt/step/size limits, per-provider `configured`, and the verified billing view. Listing works while a provider is disabled. |
| `/api/projects/:id/image-generations/estimate` | POST | Validates the input, returns dimensions, steps, estimated neurons, estimated USD (or `null` for Leonardo), the rate version, and the billing note. No provider call, no row. |
| `/api/projects/:id/image-generations` | POST | Re-checks credentials, creates a `pending` row (prompt, provider, model, settings, estimate, rate version), generates, persists the image as `image`, and returns `201` with the settled record and media. A Leonardo job still pending at the poll deadline returns `202` with its job id. |
| `/api/projects/:id/image-generations/:generationId/refresh` | POST | Polls the stored Leonardo job id; `202` while pending, then stores the image and settles the row. |
| `/api/projects/:id/image-generations/:generationId/settle` | POST | Settles a pending job as `failed` with `IMAGE_GENERATION_ABANDONED`, releasing the account; settling an already settled job returns its current state. |
| `/api/projects/:id/image-generations` | GET | Most recent 50 generations for the project. |
| `/api/image-usage` | GET | The caller's image cost ledger for the guard window: attempts, actual/estimated/charged USD, limits, and reset time. |

Every settled generation records what the provider actually charged, not only the preview estimate: Workers AI returns
`result.usage.neurons`, stored as `actual_neurons` and priced at the catalog's verified rate (`cost_source = 'rate'`).
Leonardo credits and its `cost` object are stored raw in `provider_cost`; a dollar amount becomes `actual_usd`
(`cost_source = 'provider'`) only when the provider reports one, and credits alone (`cost_source = 'credits'`) never
invent a dollar value. The spending guard charges `actual_usd` when it exists and falls back to the estimate otherwise.
`GET /api/image-usage` returns the caller's ledger totals over the guard window (attempts, actual, estimated, charged,
limits, and when the window frees up), and the Generate tab shows that line.

A partial unique index allows only one `pending` generation per owner, so the one-at-a-time rule holds across server
instances rather than only inside one Node process. Because that job may live in a project the caller is no longer
editing, the `429 IMAGE_GENERATION_IN_FLIGHT` error carries `details.pending` (generation id, project id, job id,
provider, model, start time). The Generate tab names that project and job and offers **Refresh pending job**, which
polls through the owning project, and **Settle and unblock**, which settles it immediately. A pending row older than
`IMAGE_PENDING_ABANDON_AFTER_MS` (default 15 minutes) is settled automatically before the next generation, and a
background pass (`IMAGE_PENDING_SWEEP_INTERVAL_MS`, default 60 s, `0` disables) settles stale rows even when no request
arrives.

The **Generate** workspace tab drives that flow. A model picker shows each model's dimensions, steps, and prompt
limit, marks a provider without credentials as disabled, and a prompt produces the server's verified cost estimate
(neurons and USD, or API credit with no invented rate). **Generate image** is explicit and calls only the selected
provider; a queued job shows **Refresh job** until it settles. The ready asset is previewed through a short-lived
private playback URL, and **Attach image to scene** writes the scene reference and saves the project in one action.
The prompt can be seeded from the selected scene's heading and visual direction, and **Regenerate** repeats the current
prompt and settings without retyping them.

Before any provider call the route applies a per-account spending guard over a rolling 24 hours. It counts every
recorded attempt for that owner — including failed ones, which may still have been billed — and the sum of their
estimated USD, then refuses with `429 IMAGE_SPEND_LIMIT` when the next request would exceed either limit. A second
generation while one is still running for the same account is refused with `429 IMAGE_GENERATION_IN_FLIGHT`; the
in-process slot closes the gap between the usage read and the new row, so a double submit cannot spend twice. The
limits are configuration, not client input: `IMAGE_DAILY_IMAGES_PER_USER` and `IMAGE_DAILY_USD_PER_USER` (0 disables
either check). Leonardo is capped by count only because its catalog rate is `null`.

Input is limited to a known `modelKey`, a non-empty prompt within the model's limit, and optional dimensions/steps
that the model accepts (Cloudflare fixes 1024×1024; Leonardo accepts 32–2048 px in multiples of 8). A failed provider
call, unreadable image, refused download host, or storage failure marks the row `failed` with a sanitized code; the
provider key is never returned. Leonardo downloads are restricted to `https://cdn.leonardo.ai` without redirects, and
the bytes are re-detected as an image before upload. Generated media has no stock provenance: the `image_generations`
row itself is the generation record.

| Route check | Evidence |
| --- | --- |
| Estimate is deterministic and free | `tests/image-generations.test.ts`: Flux at 1024²/4 steps reports 172.8 neurons and $0.001901 from the verified rate; no generation row and no provider/R2 write |
| Explicit generation stores everything | Cloudflare generation returns `201` with prompt, model, settings, job marker, rate version, estimate, and a `ready` image; exactly one R2 put, one `image_generations` row, and one listed media row |
| Leonardo job lifecycle | A polled job stores its job id, downloads from the CDN, and settles ready; a job still pending at the deadline returns `202` and a later refresh completes it |
| Disabled providers stay disabled | With no credentials both models report `configured: false`, estimates still work, and generation is `503 IMAGE_PROVIDER_DISABLED` with no row or write |
| Failures are sanitized and recorded | A provider `500` returns `502 IMAGE_PROVIDER_FAILED`, the record is `failed`, no media row exists, and the message does not contain the key |
| Another account's project is refused | User B gets `404` for User A's project and no row is created |

### Phase 7 verification (2026-11-25)

| Criterion | Status | Evidence |
| --- | --- | --- |
| Route, record, and R2 persistence on hosted services | **PASS** | `npm run verify:image-routes-live` against hosted Supabase and the real `story-frame` bucket, with only the provider call answered locally: the estimate reported neurons/USD, generation returned `201` with prompt/model/settings/rate version, the image was stored, listed, and served through a presigned playback URL, the record was listed, and project/user cleanup removed the row; 15/15 checks |
| Real Cloudflare generation | **PASS** | `npm run verify:image-live` on 2026-11-25, 15/15: the route estimated 172.8 neurons / $0.001901, generated one 1024×1024 flux image through Workers AI, stored it in R2, listed it, and served it from a presigned playback URL before cleanup. Credential diagnosis: `CLOUDFLARE_API_TOKEN` is a valid, active token but Workers AI rejects it with `401` code `10000` (no Workers AI permission); the project's `CF_API_TOKEN` is the Workers AI token and works. The adapter now accepts `CF_API_TOKEN` as the `CLOUDFLARE_AI_API_TOKEN` fallback |
| Real Leonardo generation | **BLOCKED** | `LEONARDO_API_KEY` is a 36-character UUID rather than a Leonardo API key (Leonardo keys are long JWTs), and Leonardo returns `401` for both `POST /generations` and `/me`. It cannot work until a real key is issued; the route correctly records the failure and stores no media |
| Hosted schema | **PASS** | `20261125200000_create_image_generations.sql` applied through the Supabase management API on 2026-11-25; `verify:sql` reports 96/96, including the service-role insert, `42501` for authenticated reads, and `23514` for an unknown provider |
| Actual provider cost | **PASS** | `tests/image-providers.test.ts` maps Workers AI usage and Leonardo credit/cost payloads; `tests/image-generations.test.ts` stores `actualNeurons: 57.6`, `actualUsd: 0.000634`, `costSource: 'rate'` for flux, a provider-reported `0.02 USD` cost for Leonardo, and no invented USD when only credits exist. `verify:sql` rejects an unknown `cost_source` (`23514`); the route-live suite checks the stored cost against the real database |
| Cost ledger and actual-first guard | **PASS** | `GET /api/image-usage` returns the caller's attempts, actual/estimated/charged totals, limits, and reset time and refuses anonymous reads; a seeded settled cost of $0.01 blocks the next image under a $0.005 limit even though the estimates alone would fit; the DOM shows the last-24-hours spend on the Generate tab |
| One pending generation across instances | **PASS** | `20261125220000_one_pending_image_generation.sql` adds a partial unique index; `verify:sql` rejects a second pending row for the owner (`23505`) and allows one after the first settles; the route returns `429 IMAGE_GENERATION_IN_FLIGHT` for a stored pending job without a provider call |
| A pending job is recoverable from another project | **PASS** | `tests/image-generations.test.ts`: a pending job in another project returns `429` with `details.pending` naming its generation, project, job, provider, and model; refreshing that job through its own project settles it and frees the account; `POST .../settle` marks it `failed IMAGE_GENERATION_ABANDONED`, is idempotent, and unblocks generation. `tests/generate-panel.test.tsx`: the Generate tab shows the blocking project/job with **Refresh pending job** and **Settle and unblock** |
| Abandoned pending jobs settle automatically | **PASS** | `tests/image-generations.test.ts`: a pending row older than `IMAGE_PENDING_ABANDON_AFTER_MS` is settled on the next generation, and a 50 ms sweep interval settles an old row with no request in flight |
| Per-user spending guard | **PASS** | `tests/image-generations.test.ts`: two recorded attempts with a limit of 2 return `429 IMAGE_SPEND_LIMIT` without a row or provider write; a prior $0.001901 estimate with a $0.0035 limit refuses the next priced image; a 25-hour-old attempt and two other-account attempts do not count; a provider with no USD rate is still capped by image count; two simultaneous requests yield one `201` and one `429 IMAGE_GENERATION_IN_FLIGHT`. `verify:image-routes-live` runs with a limit of 1 and gets `429 IMAGE_SPEND_LIMIT` for a second generation with no new row or media |
| Generation UI | **PASS (DOM)** | `tests/generate-panel.test.tsx`: the model picker marks a credential-less provider disabled; a prompt triggers the server estimate and shows $0.001901 / 172.8 neurons with its verified date and source; no generation request is made before **Generate image**; the result previews from a private playback URL and **Attach image to scene** writes the scene reference and saves the document; a `202` job shows **Refresh job** and only then completes; a provider failure shows the sanitized code without a preview; a pending job in another project names that project and job and settles from the panel |

| Provider | Verified model and request | Limits | Billing |
| --- | --- | --- | --- |
| Cloudflare Workers AI | `@cf/black-forest-labs/flux-1-schnell`, 1024×1024 output, 1–8 steps (default 4), prompt ≤ 2048 chars; base64 image in `result.image`, validated as a real image before use | Text-to-image 720 requests/min; 10,000 free neurons/day, then Workers Paid | 4.80 neurons per 512×512 tile plus 9.60 per step; $0.011 per 1,000 neurons. Free allowance is account-level and finite |
| Leonardo | Phoenix 1.0, model id `de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3`, v1 create/poll endpoints, prompt ≤ 2000 chars, 32–2048 px in multiples of 8, one image per request | Defaults: 10 concurrent image jobs, 100 create requests/min, 2,000 requests/min overall, 200 queued jobs | API credit priced per model and parameters in Leonardo's API pricing calculator; **no per-image USD rate is published**, so the catalog stores none and the $3/1000 images planning figure remains unverified |

Sources: Cloudflare's pricing and limits pages plus the `flux-1-schnell` model page, and Leonardo's common API values,
Phoenix guide, and limits reference, all read on 2026-11-25. Cloudflare's SDXL model was deliberately left out: its
model page marks a planned deprecation and the pricing table no longer lists it. The Leonardo adapter uses the v1
create/poll pair because those request and response shapes are documented; the v2 create endpoint documents only its
response, not the poll shape.

`tests/image-providers.test.ts` covers the catalog's exact ids/units/sources, both disabled paths (no network call),
Cloudflare's request shape and image-byte validation, unknown model/step/prompt refusals, Leonardo submission and
pending/complete/failed polling, and sanitized provider errors that never include the key.

### Phase 8: narration and uploaded audio (2026-11-25)

Deepgram Aura-2 is adapted behind the server: `POST https://api.deepgram.com/v1/speak` with `model` and
`encoding=mp3` on the query string, `Authorization: Token`, and only `{ text }` in the body. Aura-2 accepts up to 2,000
characters per REST request and bills $0.030 per 1,000 characters on pay-as-you-go; the catalog records
`deepgram-aura-2-2026-11-25`. The six featured English voices stored in the catalog are the ones documented by Deepgram
(Thalia, Andromeda, Helena, Apollo, Arcas, Orpheus). No voice cloning or word-level timestamp claim is made.

Narration is tied to the approved script. Every scene must be approved, and the SHA-256 fingerprint covers the ordered
scene ids, script text, and approval fingerprints. Changing the script marks the existing narration stale; it is never
regenerated silently. The real audio duration is read from the stored container with `music-metadata`, compared with the
sum of scene durations, and a mismatch is reported. Speech is never sped up or cut; the UI points to explicit script or
unlocked timing edits.

Every billable Deepgram call passes a per-account spending guard over a rolling 24 hours. The `narration_usage` row is
written before the provider request and settled `succeeded` or `failed` afterwards; failed attempts remain in the
window because Deepgram may have processed them. Previews use the same budget as generations, and the response also
refuses a second overlapping request for the account (`429 NARRATION_IN_FLIGHT`). `GET /api/projects/:id/narration`
returns the window totals, limits, and reset time, which the Narration tab displays.

The check-and-insert is one database transaction: `reserve_narration_usage(...)` takes an advisory lock keyed by the
owner, totals the rolling window, and only then inserts the pending row. Two server processes cannot both pass the
same read before either writes. The function is executable only by `service_role`; the browser never calls it.

The ledger belongs to the account, not the project. Deleting a project clears `narration_usage.project_id` instead of
deleting its rows, so the rolling spend window survives and a replacement project cannot reset the guard. Deleting the
owner still cascades the ledger with the account.

| Route | Method | Behavior |
| --- | --- | --- |
| `/api/narration/voices` | GET | Signed-in Aura-2 voice catalog, 2,000-character bound, verified rate, and whether Deepgram is configured. |
| `/api/projects/:id/narration` | GET | Active narration/music, current approved-script fingerprint, stale flag, measured timing warning, limits, and rolling usage. |
| `/api/projects/:id/narration` | POST | Generates from the approved script, measures the audio, stores it in R2, and replaces the active narration. |
| `/api/projects/:id/narration/preview` | POST | Returns a short real voice sample as audio bytes; it is not saved as project media. |
| `/api/projects/:id/narration/upload` | POST | Attaches a ready audio asset from the project as narration, measuring its real duration. |
| `/api/projects/:id/narration` | PATCH / DELETE | Updates volume/mute or removes the active narration. |
| `/api/projects/:id/music` | POST / PATCH / DELETE | Attaches, adjusts, or removes uploaded music. |

| Criterion | Status | Evidence |
| --- | --- | --- |
| Real Deepgram response becomes playable persisted narration | **PASS** | `npm run verify:narration-live` on 2026-11-25 against real Deepgram, hosted Supabase, and the `story-frame` R2 bucket: 35/35, including a real voice sample, a persisted measured track, the script fingerprint and voice settings, the verified per-character cost, a CORS preflight from the `cors.json` preview origin, MP3/WAV/M4A/OGG/AAC uploads and private playback byte-for-byte, and cleanup |
| Verified endpoint, auth, voice ids, output, billing, and limits | **PASS** | Deepgram docs read 2026-11-25: `/v1/speak`, `Token` auth, Aura-2 model ids, MP3 default, 2,000-character REST bound, $0.030/1k Aura-2 rate, 15 concurrent requests. `tests/deepgram.test.ts` asserts the request shape, `Token` header, audio validation, 2,000-character refusal, derived cost, and sanitized errors |
| Script fingerprint and staleness | **PASS** | `tests/narration.test.ts`: generation records a 64-character fingerprint and per-scene approval; changing an approved scene makes GET report stale while the track id and provider call count stay unchanged, proving no silent regeneration |
| Measured duration and explicit mismatch handling | **PASS** | The stored WAV/MP3 duration is parsed from the file; a 1-second track against 20 seconds of scene timing reports `TIMING_MISMATCH`, and the UI states that speech is not sped up or cut. `verify:narration-live` records a real Deepgram duration > 0 |
| Spending guard and usage record for previews and generations | **PASS** | Reservation is one database transaction under a per-owner advisory lock; `verify:sql` exercises refusals, allowed insertion, service-role-only execution, project-deletion preservation, and account-deletion cascade. `tests/narration.test.ts`: preview and generation rows are reserved before the provider call, previews consume the same rolling budget, a 100-character limit refuses the next generation without another provider call, USD and character limits refuse previews, a failed call remains a `failed` row that still counts, and deleting a project does not reset the window. `verify:narration-live` reads both rows back from hosted `narration_usage`, confirms an over-budget attempt is refused without a row, and confirms project deletion preserves the ledger with a null project reference |
| Uploaded narration, music, volume/mute, replace/remove | **PASS (live R2)** | `verify:narration-live` uploads real MP3 narration, MP3 music, and WAV, M4A, OGG, and AAC music files (`tests/fixtures/audio/`, 1-second tones) through initiation, presigned `PUT`, completion, and attachment; detects each container from its bytes, measures from R2; preflights a presigned upload from the preview origin named in `cors.json` and fails if the bucket no longer echoes that origin; exposes narration and music together; plays each back byte-for-byte from private R2; and confirms both active rows in hosted Supabase. `tests/narration-panel.test.tsx` covers missing/aliased browser MIME types, empty files, the approved-script upload gate, volume/mute, replace, and remove |
| Approved-script gate | **PASS** | An unapproved project is refused with `409 SCRIPT_NOT_APPROVED`, no provider call, and no track. The Narration tab disables generation and shows the reason |
| Hosted schema | **PASS** | `20261125230000_create_narration_tracks.sql`, `20261125240000_create_narration_usage.sql`, `20261125250000_atomic_narration_usage_reservation.sql`, and `20261125260000_preserve_narration_usage_on_project_delete.sql` applied through the Supabase management API on 2026-11-25; `verify:sql` reports 113/113, including service-role writes, `42501` for authenticated reads and function execution, one active track per kind (`23505`), volume/kind and non-negative charge constraints (`23514`), project-usage preservation, and account cascades |
| Narration UI | **PASS (live browser + DOM)** | A disposable hosted account was driven through the real UI on 2026-11-25: approve two scenes, generate a 7.61s Deepgram track, play it, upload M4A narration and OGG music, play both, remove both, and delete the project and account; the first upload preflight returned `403` until the bucket CORS rule in `cors.json` was pointed at that preview origin. `tests/narration-panel.test.tsx`: voice preview, approved-character estimate, Generate, measured duration/cost, rolling spend line, timing warning, stale warning, uploaded narration with missing MIME normalization and empty-file refusal, narration upload gated on script approval, mute, and remove |
| Word-level subtitle timings | **NOT PROVIDED** | This phase does not request or infer word timestamps; no estimated word timing is labelled as verified subtitles |
| Voice cloning | **NOT IN SCOPE** | Only the documented Aura-2 voices are offered |

The `<audio>` element only receives short-lived private R2 playback URLs. Generated and uploaded project audio is
referenced as `document` media, so retention cannot remove a track that is still active; replaced/removed tracks release
that reference. Deepgram transcription for Mode C is a separate capability and is not part of this phase.

### Phase 3 verification (2026-11-24)

| Criterion | Status | Evidence |
| --- | --- | --- |
| Authorized upload initiation with stable ids and private keys | **PASS** | `tests/media.test.ts` (mocked Supabase + local S3 endpoint), owner-scoped reservation |
| Bounded sizes and per-account storage limit | **PASS** | Per-kind and quota tests; `413` before any ticket |
| Actual type validation | **PASS** | Magic-byte detection test rejects an MP4 declared as PNG |
| Authorized playback and another account refused | **PASS** | Playback URL returns the exact bytes; cross-owner read/complete/delete are `404` |
| Safe deletion and shared references | **PASS** | Shared asset blocked while referenced, remains playable after one reference is released |
| Retention and interrupted-upload cleanup | **PASS** | Clock-driven sweep tests, including a document-listed asset surviving retention until its saved scene id is removed and keyset paging past a full batch of protected rows |
| Real R2 signing and bucket access | **PASS** | `npm run verify:r2-live`: presigned PUT/GET, signed HEAD/range/DELETE/list, 8/8 against the `story-frame` bucket, including a preflight from the `cors.json` preview origin |
| Migration applied to the hosted Supabase project | **PASS** | Applied through the Management API; catalog checked (columns, table, RLS, policy, grants) |
| Full upload through the app with a real signed-in session | **PASS** | `npm run verify:media-live`: two disposable hosted accounts, 38/38 checks, including a real bucket upload, playback, the upload-ticket CORS preflight, the document-delete guard, and project-deletion object cleanup |
| Two-account isolation on the hosted project | **PASS** | Same check: RLS reads, refused browser write, and `404` for foreign routes |
| Bucket CORS | **PASS** | Rule applied and probed (allowed preflight `204`, foreign origin `403`, presigned `GET` header); `verify:r2-live`, `verify:media-live`, and `verify:narration-live` now fail when the bucket does not echo the `cors.json` preview origin |
| Upload from the UI in a browser | **UNVERIFIED** | There is still no media UI; the flow is API-only until the workspace is built |
| JSON2Video temporary input access | **DEFERRED** | Phase 9; the presign TTL policy above is the design constraint |

## Model catalog (verified 2026-11-24)

Direct request identifiers come from `https://ollama.com/api/tags`, which the API documentation names as the source of
truth for `ollama.com/api/chat`.

| Family | Configured identifier | Public catalog |
| --- | --- | --- |
| deepseek-v4.1-flash | `deepseek-v4.1-flash` | listed |
| gemma4 | `gemma4:31b` | listed |
| glm-5.3-flash | `glm-5.3-flash` | listed |
| gpt-oss | `gpt-oss:20b` (also listed: `gpt-oss:120b`) | listed |
| minimax-m3.1-flash | `minimax-m3.1-flash` | listed |
| nemotron-3-nano | — | **not listed** |

`nemotron-3-nano` is disabled. Its library page advertises `nemotron-3-nano:30b-cloud` only through a signed-in local
Ollama server, and the direct-request catalog lists only `nemotron-3-super` and `nemotron-3-ultra`. No substitute is
configured.

## Live verification (Phase 1, 2026-11-24)

These requests were made through the application server before the Phase 2 auth boundary was added. They remain the
record of provider/model availability; latency and output counts vary between runs.

| Family | Request ID | Returned model | Result | Latency | Prompt tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- |
| Gemma 4 31B | `gemma4:31b` | `gemma4:31b` | success | 777 ms | 22 | 13 |
| DeepSeek V4.1 Flash | `deepseek-v4.1-flash` | `deepseek-v4.1-flash` | success | 948 ms | 13 | 14 |
| GLM 5.3 Flash | `glm-5.3-flash` | `glm-5.3-flash` | success | 920 ms | 21 | 29 |
| GPT-OSS 20B | `gpt-oss:20b` | `gpt-oss:20b` | success | 643 ms | 76 | 29 |
| MiniMax M3.1 Flash | `minimax-m3.1-flash` | `minimax-m3.1-flash` | success | 871 ms | 211 | 14 |
| Nemotron 3 Nano | — | — | unavailable | — | — | — |

- GLM 5.3 Flash initially returned an empty final message because its thinking trace consumed the output bound. The
  server sends `think: false`, and the retest succeeded.
- **Nemotron 3 Nano is unavailable for direct requests.** It is absent from `/api/tags`, so the server returns
  `MODEL_UNAVAILABLE` without contacting Ollama.

Phase 2’s authenticated path was verified with a local fake Supabase (real HTTP auth + PostgREST calls) because no
user session token was available in this environment. On 2026-11-24 the configured `story-frame` project’s obsolete
`public` schema was exported and replaced with the migrations (six in total, the last added for Phase 3; see
[Applying the migrations](#applying-the-migrations)). The hosted catalog now matches this code: 12 tables, RLS and a
select-own policy on each, the revision trigger, no `auth.users` trigger, and `/api/ai/status` reporting
`ledger.ready: true`. Live routes were then exercised with two disposable users (38/38 checks,
including two-user isolation), and `smoke:live` exited 0 with 5/5 model families and an identical
stored replay. The test users and rows were deleted; the project is empty again.

`npm run verify:sql` applies all ten migrations to a real PostgreSQL engine (PGlite, PostgreSQL compiled to
WebAssembly) with Supabase-like `anon`, `authenticated`, and `service_role` roles plus an `auth.uid()` stub, then
asserts what the server relies on: the revision trigger, owner-only reads on every table, refused browser writes, the
conditional version update, constraint and foreign-key rejections, and the cascades from both `projects` and
`auth.users`. It runs offline, in memory, and exits non-zero on the first broken expectation. This validates the SQL
logic and the policies themselves, but not the live project’s role configuration.

## Tests

All automated provider tests use a local mock and are labelled `MOCKED`. Supabase is replaced by a local fake Auth and
PostgREST service, so tests exercise the real HTTP client code without external calls. CI (`.github/workflows/ci.yml`)
runs `check`, `test`, `build`, and `verify:sql` on every push and pull request; the live suites stay opt-in because they
need the hosted project and the real bucket.

Coverage includes:

- Missing, invalid, and **expired** sessions (rejected before any provider call or ledger write)
- Missing Supabase auth or ledger configuration (billable calls refused)
- A configured but unreachable ledger or missing `ai_usage` table (refused **before** the provider is called)
- **Two-user isolation**: each account reads only its own ledger rows, and a client-supplied owner id is rejected
- Ledger rows written from actual reported usage, plus error rows for provider failures
- A successful provider call whose ledger completion keeps failing still returns the reply, flagged
  `X-Storyframe-Usage: unrecorded`, after one paid call and with the row left `pending`
- A completion write that fails once is retried, and that key then replays the recorded reply
- A completion that loses to a concurrent abandonment is reported `unrecorded`, keeps the paid reply, and leaves the
  `REQUEST_ABANDONED` row untouched
- Missing, malformed, replayed, reused, and in-progress idempotency keys
- Successful and provider-error replays without a second provider call
- A pending reservation blocks a retry from billing again
- A stale pending reservation is settled as `REQUEST_ABANDONED` with no provider call, and that key replays the outcome
- A stale takeover that loses its race leaves the row pending and reports `IDEMPOTENCY_IN_PROGRESS`
- The abandon threshold never drops below the provider timeout plus three auth timeouts, so a live request is never
  settled, and a pending reservation inside that window is left untouched
- A key scoped to one account: two users may share a key and are each billed once
- A completed reservation with no stored response (503, no provider call)
- The fake PostgREST returns only the selected columns, so a reservation lookup that omits a column it reads fails the
  replay tests instead of passing against a fuller live row
- Project create/read/list/update/delete with owner-only access, revision history, and cascade delete
- Project isolation: another account's id is `404` for read, update, and delete, leaves the row intact, and never
  appears in that account's list
- Optimistic concurrency: a stale `version` returns `409 PROJECT_VERSION_CONFLICT` without writing a revision
- Project payload validation (kind, title, document schema, unknown fields at every level) and a stored document from
  a schema the server cannot read
- Document v2 migration, per-component lock enforcement, approval fingerprint invalidation, duplicate scene ids,
  stable ids through reorder, and owner-scoped revision summaries
- Workspace UI: dashboard create/open, explicit save, reopen persisted script, disabled locked narration, scene
  duplicate/reorder/delete/retime totals, approval staleness, media initiate/upload/complete/attach/playback, and
  conflict reload with the draft preserved
- The development screen reuses a key while an outcome is unknown and starts a new key after a recorded error
- Profile read/write for the caller, an upsert that never adds a duplicate row, and `404` before a profile exists
- Profile isolation: the second account's read is `404`, and its write creates its own row without touching the first
- Profile payload validation (blank workspace name, oversized display name or settings, client-supplied `owner_id`)
- Child records: scene replacement, in-place key updates, pruning, sources, claims and their status, proposals and
  their acceptance, provider jobs and their results, and a render pinned to a revision that exists
- Child isolation: another account's project is `404` on every child route and writes nothing; a foreign source, claim,
  or proposal id is `404`; child rows cascade when their project is deleted
- Child payload validation (duplicate scene key, unknown or client-supplied fields, non-http URL, unknown enum value,
  render revision below 1)
- Planning: one provider call per route with the route's model and output bound, JSON validated independently, one
  disclosed repair, and a second failure refused with no stored row
- Planning contract edges: unknown fields (including media ids), provider-owned flags, invalid durations, rewritten
  storyboard wording, invented clip quotes, and an unavailable route are all refused
- Proposals stay separate from accepted content: generation does not touch the project, acceptance applies locks and
  saves one new version, a second acceptance is `409`, and a stale base version is `409`
- Factual planning without a supplied excerpt makes zero provider calls and stores planning notes; claims are marked
  `supported` only for a verbatim source excerpt and `unverified` otherwise, and are written on acceptance
- Transcript clips become scene drafts with the quoted words, and planning routes are owner-scoped (`404` cross-account)
- Plan tab: generate/review/accept through the real panel component, nothing applied before acceptance, and both actions
  disabled while the workspace draft is dirty
- Workspace Plan journey: opening the Plan tab from a project, generating against a stubbed provider, reloading the whole
  Workspace and replays the `sessionStorage`-persisted key on the same attempt, then accepting and seeing the saved
  version and cleared key
- Planning idempotency: key required before any provider or ledger write; one `ai_usage` success row per attempt; replay
  returns the same proposal after one provider call; key reuse for a different request is `409`; a refused reply is
  stored and replayed; keys are scoped to the verified account
- Plan tab key handling: the key is kept after a lost response, `IDEMPOTENCY_IN_PROGRESS`, or `LEDGER_UNAVAILABLE`, and a
  recorded refusal starts a fresh key on the next attempt; an unsettled attempt is persisted in `sessionStorage` per
  project so a reload in the same tab still replays, carries its route, instruction, and base version so a changed
  request starts a new key instead of a guaranteed `409`, and is cleared once an outcome is recorded; a replayed proposal
  already present in the loaded list replaces its entry instead of being appended twice
- Media upload lifecycle for image, audio, and video: presigned ticket, direct upload, real-size and magic-byte
  validation, playback through a second presigned URL, and the stored detected content type
- Media type mismatch and empty/oversized uploads discarded; oversized declarations and the per-account quota refused
- Media isolation: another account's playback, completion, and deletion are refused without touching the object
- Shared media: deletion blocked while referenced, one released reference leaves the asset playable and the object in
  place, and the last release allows deletion
- Missing objects, pending playback, expired upload windows, interrupted-upload cleanup, deleted-row retention, and
  unreferenced-asset cleanup
- Media routes refused with `503 MEDIA_NOT_CONFIGURED` when the bucket is not configured
- Project deletion reads every page of the project's object keys before the rows cascade and removes each object from
  the bucket, leaving no orphaned upload behind even past one store page (205-row regression case)
- Workspace detach: releases the scene reference, removes the asset id, saves the document, and then deletes the now
  unreferenced asset
- Detach retry: when the reference release succeeds but the project save fails, the scene link stays visible and the
  next Detach skips the already-missing reference and saves the removal
- Retention: a ready asset past its unreferenced window is kept while a saved scene lists it, and removed on the next
  sweep after the id is removed; the sweep pages by id past protected rows, so a full batch cannot starve other assets
- Scheduled cleanup: the background sweeper runs one pass per interval, never overlaps a running pass, logs a failure
  and keeps scheduling, and stops with the server; an idle server removes an expired upload with no media request
- Bucket audit: an agreeing pair reports no drift, an object without a row and a ready row without its object are each
  reported (a pending upload without an object is not drift), both sides page past one page, and it changes nothing
- Save validation: scene asset ids are checked for UUID shape, then against ready media in the same project, so
  malformed, unknown, pending, foreign, and deleted ids are refused instead of being stored
- Missing key, unknown/disabled model, oversized prompt/body, provider auth failure, rate limiting, timeout,
  malformed/empty responses, success extraction, secret leakage, and duplicate submission
- UI reply rendering, error display, and duplicate-submission suppression
- Supabase Auth UI: initial session restore, email/password sign-in, local sign-out, sign-in errors, and
  expired/unreadable sessions. The refresh itself belongs to the Supabase client, and the session tests assert that the
  app does not start a second one.

- Stock search: duplicate, empty, unknown, and malformed source/type/page selections are refused; both provider payloads
  normalize to one shape with real dimensions, credit, and source page; video rendition choice respects aspect ratio and
  never selects a playlist URL; provider keys and URLs never appear in a response or an error
- Stock pagination and partial failure: one provider's `500` still returns the other provider's merged page, a failed
  page is not cached, and per-provider `hasMore` is reported
- Stock cache: two identical searches make one provider call, the second is served from the durable `cache_key` row,
  Pixabay's TTL is at least 24 hours, concurrent claims make one call, and a cache outage leaves search usable
- Stock import: owner-scoped; https and provider-host only; redirects are re-validated; private, loopback, link-local,
  shared, and reserved addresses are refused; byte limits and magic-byte type checks apply; playlists are refused; the
  stored row carries validated JSONB provenance and the object is in the private bucket
- Stock UI: previews show provider, creator, source, and license, importing is a separate explicit action, a failed
  provider is reported without hiding the other's results, and an imported asset appears as ready project media

### Repeatable live smoke check

```bash
SMOKE_SUPABASE_ACCESS_TOKEN=<valid session token> npm run smoke:live
```

This check is **opt-in** and makes **five real requests** (one per enabled family), which count against your Ollama
usage and write five ledger rows. It requires `OLLAMA_API_KEY` plus Supabase configuration in the environment or
`storyframe/.env`, and a valid session token. It starts an isolated API server on an ephemeral loopback port, runs the
five families sequentially, then reads `/api/ai/usage` to confirm the ledger is working. It then repeats one successful
request with its original `Idempotency-Key`: the replay must return the same stored values and leave the ledger row
count unchanged, which proves no second provider call was billed. Because `response_body` is JSONB, the comparison
ignores object key order. It exits non-zero on failure, performs no retries, and never prints the provider key or
session token. Nemotron is checked only for its disabled status and is
never called.

### Provider-free live route checks

```bash
npm run verify:live-routes
```

This check is **provider-free**: it never calls Ollama and spends no billable tokens. It requires `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_PUBLISHABLE_KEY` (or the legacy `SUPABASE_ANON_KEY`) in the environment
or `storyframe/.env`. It creates two disposable auth users, starts an isolated API server on an ephemeral loopback
port, and checks the hosted schema through the real routes: profile isolation, project IDOR refusals, optimistic
conflict, every child table, cross-owner source rejection, render revisions, ledger completion ownership, and usage
isolation. It seeds its own rows, then deletes both users and verifies their ledger, profile, and project rows are
gone. It exits non-zero on failure and never prints access tokens or keys. It does not require or use
`OLLAMA_API_KEY`, and must not be pointed at a project whose data it should not create temporary users in.

### Live R2 signing check

```bash
R2_BUCKET_NAME=<bucket> npm run verify:r2-live
```

This check is **opt-in** and touches real storage: it writes one tiny, clearly named test object under `media/`, reads
it back through a presigned URL and a signed range request, deletes it, and confirms it is gone. It never creates a
bucket or any other resource, never prints the access key, secret, or a signed URL, and exits non-zero on failure. It
uses `R2_ENDPOINT`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` or the `CLOUDFLARE_*` fallbacks. Run on 2026-11-24 against
the `story-frame` bucket on 2026-11-25: **8/8 checks passed**, including the signed `ListObjectsV2` list the audit pages
through and a preflight of the presigned upload from the `cors.json` preview origin.

### Live media route check

```bash
R2_BUCKET_NAME=<bucket> npm run verify:media-live
```

This is the automated API-level media E2E check. It is **opt-in** because it needs the hosted project and the real bucket, and
it creates two disposable Supabase users, then exercises the real routes: project creation, upload initiation, direct
presigned upload, completion, presigned playback with byte comparison, reference attach/release, blocked then allowed
deletion, RLS reads for both accounts, a refused browser write, cross-owner `404`s, refusing the delete of an asset a
saved scene lists (`409 MEDIA_ASSET_IN_DOCUMENT`), and project deletion removing the remaining object. It deletes the
users, projects, rows, and objects afterwards and checks that they are gone. It never prints keys, tokens, or signed
URLs. Cleanup covers the project even if the run fails midway. Run on 2026-11-25: **38/38 checks passed**, including the upload
ticket's CORS preflight from the `cors.json` preview origin, the document-delete guard, and project-deletion object cleanup.

## Security limitations

- Email/password sign-in only; there is no sign-up, password-reset, MFA, OAuth, or account-management UI. The
  Supabase client persists session tokens in browser `localStorage`; production needs an explicit session-storage and
  CSP review. Sign-out is local to this browser and does not revoke the account's other sessions.
- All ten migrations and RLS policies are applied to the configured Supabase project (Phase 6 on 2026-11-25,
  including the ready-import uniqueness index). The
  hosted catalog was checked (12 tables, RLS, policies, grants, revision trigger), and live profile/project/child
  routes, two-user isolation, ledger readiness, and the planning-status route passed 51/51 checks; the disposable users
  were deleted afterwards. Rerun these checks with `npm run verify:live-routes`. The Phase 6 live route check
  (`verify:stock-routes-live`, 23/23) also passed, including a real import, a deduplicated re-import, a credited export, and full cleanup.
  `smoke:live` exposed a live-only missing-column bug; after the fix a clean five-call run exited 0 with 5/5 families
  and an identical stored replay.
- Stock search is user-driven and bounded (20 results per provider per page), but it depends on the provider's own
  terms: Pixabay's cache window is enforced for pages the server fetched, and provider rate-limit headers are observed
  with a short local cooldown after an exhausted window. Someone with a valid session can still spend provider quota, and
  the cache is shared across accounts. Imports are limited to provider-owned https hosts and capped bytes, so this is not
  a general downloader; there is no per-account import quota beyond the existing media storage limit.
- Pending reservations are recovered lazily, when a retry with the same key arrives after the applicable abandon window
  or a preflight for the project sees a stale row. There is no background sweeper, so a project nobody retries stays
  `pending` until its next attempt or status check, and the original attempt's outcome is never learned: the row
  becomes a terminal `error` with `REQUEST_ABANDONED`, no token counts, and zero latency. Recovery never calls the
  provider, so it cannot bill twice, but it cannot tell you whether the original attempt was charged.
- A reply whose completion could not be recorded after the retry is delivered but not persisted: the ledger holds no
  usage row for it, and retrying that key later can only end as `REQUEST_ABANDONED`, because the reply exists nowhere
  the server can read.
- The threshold is a guard, not a lock: if a process were frozen for longer than it, that process's late completion can
  no longer overwrite the settled row (it stays `REQUEST_ABANDONED`), although the live caller still receives its real
  response.
- Rate limiting is in-memory and per-process; it is scoped to the verified account but is not a durable quota shared
  across processes or instances.
- The Vite proxy and loopback API are a development arrangement; production needs a deployed API, managed secrets,
  durable quotas, and a real auth flow.
- The workspace is single-user per project and has no conflict merging: a stale save is refused, the draft is kept,
  and the caller must load the latest version. Revision history is read-only; restoring an old version is future work.
- Scene generation and video rendering are not implemented. Phase 5 plans angles, scripts, storyboards, ad concepts, and
  transcript clips as proposals; the planning budget is recorded in the brief but nothing spends or enforces it, and
  Preview/Export remain storyboard and editable-document outputs.
- A planning attempt is one ledger row even when the disclosed repair makes two provider calls: token counts are summed
  and latency covers both, so per-call cost cannot be reconstructed from that row. A provider failure during the repair
  records the attempt with unknown token counts, and the no-evidence short-circuit writes no ledger row at all.
- Pending and rejected proposals can be deleted; accepted proposals are immutable because they are the provenance of a
  saved version. Client-side pending keys expire after 24 hours, but completed ledger rows and their stored responses
  are retained. Cancelling stops the browser waiting; it does not abort the server's provider call, so the attempt may
  still finish and charge, which is why Retry keeps the same key.
- The model-health counters are read-then-written in the API process, so two concurrent calls can lose one count; the
  timestamps and error codes are best-effort evidence, not an audit log. Cost rates stay `unpriced` until Phase 14.
- Sources can be added and deleted in the editor but not edited in place. Deleting a source now removes the claims that
  cite it before the source row; the UI says so, and no supported claim is left pointing at missing evidence.
- Cross-device protection is authoritative for normal attempts but not a distributed transaction: the preflight and
  the partial unique index refuse a second live attempt for a project, including when BroadcastChannel is unavailable
  or the stale tab is on another device. Two reservations that race can both pass the preflight, but only one inserts;
  the other receives `409 PLANNING_ATTEMPT_IN_FLIGHT` before calling the provider. The `localStorage` lease remains a
  browser-local fast path. An unknown outcome keeps the lease until the server window ends, so the original tab must
  wait (or retry safely with its stored key) rather than freeing it early. Clone detection needs BroadcastChannel and a
  live original page; without either, the stored id is inherited and the server preflight still guards the attempt.
  Attempt history is per-browser.
- Planning is verified against the local fake and `verify:sql`, and migration 7 is applied to the hosted project. Real
  hosted `angles` calls and same-key replays were verified on 2026-11-25; the call after tightening needed no repair
  (see Phase 5 verification). The Plan tab has not been exercised in a real browser in this environment.
- Media deletion is refused while an asset is referenced. The Media tab can detach an attached scene, which releases
  the reference and saves the asset id out of the document, so deletion is reachable from the UI. Saves also refuse
  scene asset ids that are not ready media in the same project, so a direct API write cannot create a dangling id.
- Project deletion removes its media objects best effort after the row cascade. A failure at that point is logged and
  cannot be retried from the deleted rows, so `npm run audit:media` is the safety net for that narrow window; the
  audit reports the orphan object and leaves the decision to the operator.
- The migrations are verified against a real PostgreSQL engine by `npm run verify:sql`, by the test fakes, and by
  live routes against the configured project. The project is empty again after test cleanup.
- A workspace is one profile per user, with no shared or multi-user workspace, which matches the isolation
  requirement. There is no workspace UI yet; the profile is reachable only through the API.
- Media storage is private but the presigned URL itself is a bearer capability for its lifetime: anyone who obtains
  it can read (or, for an upload ticket, write) that one object until it expires. URLs are therefore short-lived and
  never logged, but they are not revoked early.
- The per-account storage quota is checked from the declared size before a reservation and counts pending and ready
  rows; it is not a durable cross-instance lock, so two simultaneous reservations can briefly exceed it. A presigned
  PUT cannot pin the body size (browsers cannot set `Content-Length`), so an object larger than declared is rejected
  and removed at completion; until its upload window closes, that object is not counted against the quota. Cleanup runs
  on a background timer as well as opportunistically on media requests, but each pass is one bounded batch per process;
  a large backlog drains over several intervals, and two processes do not coordinate their passes.
- Media type detection covers the common container signatures listed above. A valid file in an unlisted format is
  refused rather than guessed at, and an empty or truncated file is treated as unusable.
- Child routes record what the server is told; they do not call a provider. Nothing yet writes a provider job or a
  render automatically, and generated render outputs are not yet written to `media_metadata`.
