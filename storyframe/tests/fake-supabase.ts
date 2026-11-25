import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Fake values only. These are not real credentials. */
export const PUBLISHABLE_KEY = "test-publishable-key";
export const SERVICE_ROLE_KEY = "test-service-role-key";

interface FakeUser {
  token: string;
  id: string;
}

export const USER_A: FakeUser = {
  token: "test-session-user-a",
  id: "11111111-1111-4111-8111-111111111111",
};

export const USER_B: FakeUser = {
  token: "test-session-user-b",
  id: "22222222-2222-4222-8222-222222222222",
};

export const EXPIRED_TOKEN = "test-session-expired";

export interface FakeUsageRow {
  id: string;
  user_id: string;
  project_id: string | null;
  model_id: string;
  configured_model: string;
  returned_model: string | null;
  prompt_eval_count: number | null;
  eval_count: number | null;
  latency_ms: number;
  status: string;
  error_code: string | null;
  upstream_status: number | null;
  created_at: string;
  idempotency_key: string | null;
  request_hash: string | null;
  response_body: unknown;
  response_status: number | null;
}

export interface FakeProjectRow {
  id: string;
  owner_id: string;
  project_type: string;
  title: string;
  schema_version: number;
  document: unknown;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface FakeRevisionRow {
  id: string;
  project_id: string;
  owner_id: string;
  revision: number;
  schema_version: number;
  title: string;
  document: unknown;
  created_at: string;
}

export interface FakeProfileRow {
  owner_id: string;
  display_name: string | null;
  workspace_name: string;
  settings: unknown;
  created_at: string;
  updated_at: string;
}

export interface FakeSupabase {
  url: string;
  usage: FakeUsageRow[];
  projects: FakeProjectRow[];
  revisions: FakeRevisionRow[];
  profiles: FakeProfileRow[];
  /** Child tables, kept as plain rows so tests can inspect them directly. */
  scenes: Record<string, unknown>[];
  sources: Record<string, unknown>[];
  claims: Record<string, unknown>[];
  proposals: Record<string, unknown>[];
  jobs: Record<string, unknown>[];
  renders: Record<string, unknown>[];
  media: Record<string, unknown>[];
  mediaReferences: Record<string, unknown>[];
  modelHealth: Record<string, unknown>[];
  stockSearchCache: Record<string, unknown>[];
  imageGenerations: Record<string, unknown>[];
  narrationTracks: Record<string, unknown>[];
  narrationUsage: Record<string, unknown>[];
  close: () => Promise<void>;
}

export interface FakeSupabaseOptions {
  /** Fail one dependency while leaving the rest of the fake healthy. */
  failure?: "auth" | "reads" | "complete" | "stockCache";
  /** Fail the first N ledger writes with 500, to exercise completion retries. */
  failWrites?: number;
  /** Make conditional updates match no rows, to exercise a lost takeover race. */
  loseConditionalUpdate?: boolean;
  /** Simulate the schema before the planning preflight migration. */
  missingProjectIdColumn?: boolean;
  /** Answer the next project-pending read as empty, to simulate a preflight/insert race. */
  hideNextPendingProjectAttempt?: boolean;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function eqFilter(value: string | null): string | null {
  return value?.startsWith("eq.") ? value.slice(3) : null;
}

function ltFilter(value: string | null): string | null {
  return value?.startsWith("lt.") ? value.slice(3) : null;
}

/**
 * Local stand-in for Supabase Auth and the PostgREST usage table. Tests exercise
 * real HTTP auth, reservation, completion, and replay calls against it; no
 * external service is contacted.
 */
export async function startFakeSupabase(
  options: FakeSupabaseOptions = {},
): Promise<FakeSupabase> {
  const usage: FakeUsageRow[] = [];
  let hideNextPendingRead = options.hideNextPendingProjectAttempt === true;
  const projects: FakeProjectRow[] = [];
  const revisions: FakeRevisionRow[] = [];
  const profiles: FakeProfileRow[] = [];
  const scenes: Record<string, unknown>[] = [];
  const sources: Record<string, unknown>[] = [];
  const claims: Record<string, unknown>[] = [];
  const proposals: Record<string, unknown>[] = [];
  const jobs: Record<string, unknown>[] = [];
  const renders: Record<string, unknown>[] = [];
  const media: Record<string, unknown>[] = [];
  const mediaReferences: Record<string, unknown>[] = [];
  const modelHealth: Record<string, unknown>[] = [];
  const stockSearchCache: Record<string, unknown>[] = [];
  const imageGenerations: Record<string, unknown>[] = [];
  const narrationTracks: Record<string, unknown>[] = [];
  const narrationUsage: Record<string, unknown>[] = [];
  const childTables: Record<string, Record<string, unknown>[]> = {
    scenes,
    sources,
    claims,
    generation_proposals: proposals,
    provider_jobs: jobs,
    render_snapshots: renders,
    media_metadata: media,
    media_references: mediaReferences,
    model_health: modelHealth,
    stock_search_cache: stockSearchCache,
    image_generations: imageGenerations,
    narration_tracks: narrationTracks,
    narration_usage: narrationUsage,
  };
  let failWritesRemaining = options.failWrites ?? 0;

  /** Mirrors the projects_record_revision trigger: one revision per accepted write. */
  function recordRevision(project: FakeProjectRow): void {
    revisions.push({
      id: randomUUID(),
      project_id: project.id,
      owner_id: project.owner_id,
      revision: project.version,
      schema_version: project.schema_version,
      title: project.title,
      document: project.document,
      created_at: project.updated_at,
    });
  }
  const users = new Map([
    [USER_A.token, USER_A],
    [USER_B.token, USER_B],
  ]);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/auth/v1/user") {
        if (options.failure === "auth") {
          sendJson(response, 503, { message: "simulated auth outage" });
          return;
        }
        if (request.headers.apikey !== PUBLISHABLE_KEY) {
          sendJson(response, 401, { message: "invalid apikey" });
          return;
        }
        const token = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (token === EXPIRED_TOKEN) {
          sendJson(response, 401, { message: "JWT expired" });
          return;
        }
        const user = users.get(token);
        if (!user) {
          sendJson(response, 401, { message: "invalid JWT" });
          return;
        }
        sendJson(response, 200, { id: user.id });
        return;
      }

      if (url.pathname === "/rest/v1/ai_usage") {
        if (
          request.headers.apikey !== SERVICE_ROLE_KEY ||
          request.headers.authorization !== `Bearer ${SERVICE_ROLE_KEY}`
        ) {
          sendJson(response, 401, { message: "unauthorized" });
          return;
        }

        if (request.method === "POST") {
          const body = (await readJson(request)) as Record<string, unknown>;
          const userId = String(body.user_id);
          const idempotencyKey =
            typeof body.idempotency_key === "string" ? body.idempotency_key : null;

          if (
            idempotencyKey &&
            usage.some((row) => row.user_id === userId && row.idempotency_key === idempotencyKey)
          ) {
            sendJson(response, 409, { code: "23505", message: "duplicate idempotency key" });
            return;
          }
          const projectId = typeof body.project_id === "string" ? body.project_id : null;
          if (
            projectId &&
            body.status === "pending" &&
            usage.some((row) => row.project_id === projectId && row.status === "pending")
          ) {
            sendJson(response, 409, { code: "23505", message: "one pending attempt per project" });
            return;
          }

          const row: FakeUsageRow = {
            id: randomUUID(),
            user_id: userId,
            project_id: projectId,
            model_id: String(body.model_id),
            configured_model: String(body.configured_model),
            returned_model: null,
            prompt_eval_count: null,
            eval_count: null,
            latency_ms: Number(body.latency_ms ?? 0),
            status: String(body.status ?? "pending"),
            error_code: null,
            upstream_status: null,
            created_at: new Date().toISOString(),
            idempotency_key: idempotencyKey,
            request_hash: typeof body.request_hash === "string" ? body.request_hash : null,
            response_body: null,
            response_status: null,
          };
          usage.push(row);
          sendJson(response, 201, [row]);
          return;
        }

        if (request.method === "PATCH") {
          if (failWritesRemaining > 0) {
            failWritesRemaining -= 1;
            sendJson(response, 500, { message: "simulated ledger write failure" });
            return;
          }
          if (options.failure === "complete") {
            sendJson(response, 500, { message: "simulated ledger completion failure" });
            return;
          }
          const id = eqFilter(url.searchParams.get("id")) ?? "";
          const statusFilter = eqFilter(url.searchParams.get("status"));
          const userId = eqFilter(url.searchParams.get("user_id"));
          const createdBefore = ltFilter(url.searchParams.get("created_at"));
          const returnsRow = String(request.headers.prefer ?? "").includes("return=representation");
          const row = usage.find((candidate) => candidate.id === id);

          // PostgREST filters the update itself: a non-matching condition
          // updates zero rows rather than returning an error.
          const conditionsMatch =
            row !== undefined &&
            options.loseConditionalUpdate !== true &&
            (statusFilter === null || row.status === statusFilter) &&
            (userId === null || row.user_id === userId) &&
            (createdBefore === null || Date.parse(row.created_at) < Date.parse(createdBefore));

          if (!row || !conditionsMatch) {
            if (returnsRow) sendJson(response, 200, []);
            else {
              response.writeHead(204);
              response.end();
            }
            return;
          }

          const body = (await readJson(request)) as Record<string, unknown>;
          row.returned_model = typeof body.returned_model === "string" ? body.returned_model : null;
          row.prompt_eval_count = typeof body.prompt_eval_count === "number" ? body.prompt_eval_count : null;
          row.eval_count = typeof body.eval_count === "number" ? body.eval_count : null;
          row.latency_ms = Number(body.latency_ms ?? 0);
          row.status = String(body.status);
          row.error_code = typeof body.error_code === "string" ? body.error_code : null;
          row.upstream_status = typeof body.upstream_status === "number" ? body.upstream_status : null;
          row.response_status = typeof body.response_status === "number" ? body.response_status : null;
          row.response_body = body.response_body ?? null;
          if (returnsRow) sendJson(response, 200, [row]);
          else {
            response.writeHead(204);
            response.end();
          }
          return;
        }

        if (request.method === "GET") {
          if (options.failure === "reads") {
            sendJson(response, 500, { message: "simulated ledger read failure" });
            return;
          }
          if (
            options.missingProjectIdColumn &&
            url.searchParams.get("select")?.split(",").map((column) => column.trim()).includes("project_id")
          ) {
            sendJson(response, 400, {
              code: "42703",
              message: "column ai_usage.project_id does not exist",
            });
            return;
          }
          let rows = usage;

          const userId = eqFilter(url.searchParams.get("user_id"));
          if (userId) rows = rows.filter((row) => row.user_id === userId);

          const idempotencyKey = eqFilter(url.searchParams.get("idempotency_key"));
          if (idempotencyKey) {
            rows = rows.filter((row) => row.idempotency_key === idempotencyKey);
          }

          const projectId = eqFilter(url.searchParams.get("project_id"));
          if (projectId) rows = rows.filter((row) => row.project_id === projectId);

          const statusFilter = url.searchParams.get("status");
          if (hideNextPendingRead && projectId && statusFilter === "eq.pending") {
            hideNextPendingRead = false;
            sendJson(response, 200, []);
            return;
          }
          if (statusFilter?.startsWith("eq.")) {
            const status = statusFilter.slice(3);
            rows = rows.filter((row) => row.status === status);
          } else if (statusFilter?.startsWith("in.(") && statusFilter.endsWith(")")) {
            const allowed = statusFilter.slice(4, -1).split(",");
            rows = rows.filter((row) => allowed.includes(row.status));
          }

          const rawLimit = Number(url.searchParams.get("limit") ?? "20");
          const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.min(100, Math.floor(rawLimit))) : 20;
          if (url.searchParams.get("order") === "created_at.desc") rows = rows.slice().reverse();

          // PostgREST returns only the selected columns. Without this, a missing
          // column in a select list would pass tests that live would fail.
          const select = url.searchParams.get("select");
          const columns = select ? select.split(",").map((column) => column.trim()).filter(Boolean) : null;
          const page = rows.slice(0, limit).map((row) => {
            if (!columns || columns.includes("*")) return row;
            return Object.fromEntries(
              columns.map((column) => [column, (row as unknown as Record<string, unknown>)[column]]),
            );
          });
          sendJson(response, 200, page);
          return;
        }
      }

      if (url.pathname === "/rest/v1/profiles") {
        if (
          request.headers.apikey !== SERVICE_ROLE_KEY ||
          request.headers.authorization !== `Bearer ${SERVICE_ROLE_KEY}`
        ) {
          sendJson(response, 401, { message: "unauthorized" });
          return;
        }

        if (request.method === "GET") {
          const ownerId = eqFilter(url.searchParams.get("owner_id"));
          const rows = profiles.filter((row) => ownerId === null || row.owner_id === ownerId);
          const rawLimit = Number(url.searchParams.get("limit") ?? "1");
          const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.min(100, Math.floor(rawLimit))) : 1;
          sendJson(response, 200, rows.slice(0, limit));
          return;
        }

        if (request.method === "POST") {
          const body = (await readJson(request)) as Record<string, unknown>;
          const ownerId = String(body.owner_id);
          const now = new Date().toISOString();
          const displayName = typeof body.display_name === "string" ? body.display_name : null;
          const updatedAt = typeof body.updated_at === "string" ? body.updated_at : now;
          const existing = profiles.find((row) => row.owner_id === ownerId);

          // Mirrors `Prefer: resolution=merge-duplicates`: the primary key decides.
          if (existing) {
            existing.display_name = displayName;
            existing.workspace_name = String(body.workspace_name);
            existing.settings = body.settings ?? {};
            existing.updated_at = updatedAt;
            sendJson(response, 201, [existing]);
            return;
          }

          const row: FakeProfileRow = {
            owner_id: ownerId,
            display_name: displayName,
            workspace_name: String(body.workspace_name),
            settings: body.settings ?? {},
            created_at: now,
            updated_at: updatedAt,
          };
          profiles.push(row);
          sendJson(response, 201, [row]);
          return;
        }
      }

      if (url.pathname === "/rest/v1/projects" || url.pathname === "/rest/v1/project_revisions") {
        if (
          request.headers.apikey !== SERVICE_ROLE_KEY ||
          request.headers.authorization !== `Bearer ${SERVICE_ROLE_KEY}`
        ) {
          sendJson(response, 401, { message: "unauthorized" });
          return;
        }

        const isProjects = url.pathname === "/rest/v1/projects";
        const representation = String(request.headers.prefer ?? "").includes("return=representation");
        const reply = (status: number, payload: unknown) => {
          if (representation) sendJson(response, status, payload);
          else {
            response.writeHead(204);
            response.end();
          }
        };

        if (request.method === "POST" && isProjects) {
          const body = (await readJson(request)) as Record<string, unknown>;
          const now = new Date().toISOString();
          const row: FakeProjectRow = {
            id: randomUUID(),
            owner_id: String(body.owner_id),
            project_type: String(body.project_type),
            title: String(body.title),
            schema_version: Number(body.schema_version),
            document: body.document ?? null,
            version: Number(body.version ?? 1),
            created_at: now,
            updated_at: now,
          };
          projects.push(row);
          recordRevision(row);
          reply(201, [row]);
          return;
        }

        if (request.method === "PATCH" && isProjects) {
          const id = eqFilter(url.searchParams.get("id")) ?? "";
          const ownerId = eqFilter(url.searchParams.get("owner_id"));
          const version = eqFilter(url.searchParams.get("version"));
          const row = projects.find((candidate) => candidate.id === id);

          // PostgREST applies the filters to the update itself: a non-matching
          // condition updates zero rows instead of returning an error.
          const matches =
            row !== undefined &&
            (ownerId === null || row.owner_id === ownerId) &&
            (version === null || String(row.version) === version);
          if (!row || !matches) {
            reply(200, []);
            return;
          }

          const body = (await readJson(request)) as Record<string, unknown>;
          row.title = String(body.title);
          row.document = body.document ?? null;
          row.schema_version = Number(body.schema_version);
          row.version = Number(body.version);
          row.updated_at = typeof body.updated_at === "string" ? body.updated_at : new Date().toISOString();
          recordRevision(row);
          reply(200, [row]);
          return;
        }

        if (request.method === "DELETE" && isProjects) {
          const id = eqFilter(url.searchParams.get("id")) ?? "";
          const ownerId = eqFilter(url.searchParams.get("owner_id"));
          const index = projects.findIndex(
            (row) => row.id === id && (ownerId === null || row.owner_id === ownerId),
          );
          if (index === -1) {
            reply(200, []);
            return;
          }

          const [removed] = projects.splice(index, 1);
          for (let position = revisions.length - 1; position >= 0; position -= 1) {
            if (revisions[position].project_id === removed.id) revisions.splice(position, 1);
          }
          // Mirrors the child-table cascades. Narration usage is the exception:
          // its project reference is cleared so the spending window survives.
          for (const [table, data] of Object.entries(childTables)) {
            for (let position = data.length - 1; position >= 0; position -= 1) {
              if (data[position].project_id !== removed.id) continue;
              if (table === "narration_usage") data[position].project_id = null;
              else data.splice(position, 1);
            }
          }
          reply(200, [removed]);
          return;
        }

        if (request.method === "GET") {
          const table = (isProjects ? projects : revisions) as unknown as Record<string, unknown>[];
          const id = eqFilter(url.searchParams.get("id"));
          const ownerId = eqFilter(url.searchParams.get("owner_id"));
          const projectId = eqFilter(url.searchParams.get("project_id"));
          let rows = table.filter(
            (row) =>
              (id === null || row.id === id) &&
              (ownerId === null || row.owner_id === ownerId) &&
              (projectId === null || row.project_id === projectId),
          );

          const order = url.searchParams.get("order");
          if (order === "updated_at.desc") {
            rows = rows.slice().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
          } else if (order === "revision.desc") {
            rows = rows.slice().sort((a, b) => Number(b.revision) - Number(a.revision));
          }

          const rawLimit = Number(url.searchParams.get("limit") ?? "50");
          const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.min(100, Math.floor(rawLimit))) : 50;
          sendJson(response, 200, rows.slice(0, limit));
          return;
        }
      }

      if (
        request.method === "POST" &&
        url.pathname === "/rest/v1/rpc/reserve_narration_usage"
      ) {
        if (
          request.headers.apikey !== SERVICE_ROLE_KEY ||
          request.headers.authorization !== `Bearer ${SERVICE_ROLE_KEY}`
        ) {
          sendJson(response, 401, { message: "unauthorized" });
          return;
        }
        const body = (await readJson(request)) as Record<string, unknown>;
        const ownerId = String(body.p_owner_id);
        const characters = Number(body.p_characters);
        const costUsd = Number(body.p_cost_usd);
        const characterLimit = Number(body.p_character_limit);
        const usdLimit = Number(body.p_usd_limit);
        const windowSeconds = Number(body.p_window_seconds);
        const cutoff = Date.now() - Math.max(0, windowSeconds) * 1000;
        const relevant = narrationUsage.filter(
          (row) =>
            row.owner_id === ownerId &&
            typeof row.created_at === "string" &&
            Date.parse(row.created_at) >= cutoff,
        );
        const usedCharacters = relevant.reduce((sum, row) => sum + Number(row.characters ?? 0), 0);
        const spentUsd = relevant.reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0);
        const oldestAt = relevant
          .map((row) => String(row.created_at))
          .sort((left, right) => left.localeCompare(right))[0] ?? null;
        const allowed =
          (characterLimit <= 0 || usedCharacters + characters <= characterLimit) &&
          (usdLimit <= 0 || spentUsd + costUsd <= usdLimit + 1e-9);
        if (!allowed) {
          sendJson(response, 200, [
            {
              usage_id: null,
              allowed: false,
              characters_used: usedCharacters,
              spent_usd: Number(spentUsd.toFixed(6)),
              oldest_at: oldestAt,
            },
          ]);
          return;
        }
        const now = new Date().toISOString();
        const row = {
          id: randomUUID(),
          owner_id: ownerId,
          project_id: String(body.p_project_id),
          kind: String(body.p_kind),
          status: "pending",
          characters,
          cost_usd: Number(costUsd.toFixed(6)),
          rate_version: String(body.p_rate_version),
          created_at: now,
          updated_at: now,
        };
        narrationUsage.push(row);
        sendJson(response, 200, [
          {
            usage_id: row.id,
            allowed: true,
            characters_used: usedCharacters + characters,
            spent_usd: Number((spentUsd + costUsd).toFixed(6)),
            oldest_at: oldestAt ?? now,
          },
        ]);
        return;
      }

      if (url.pathname.startsWith("/rest/v1/")) {
        const table = url.pathname.slice("/rest/v1/".length);
        const data = childTables[table];
        if (data) {
          if (
            request.headers.apikey !== SERVICE_ROLE_KEY ||
            request.headers.authorization !== `Bearer ${SERVICE_ROLE_KEY}`
          ) {
            sendJson(response, 401, { message: "unauthorized" });
            return;
          }

          if (table === "stock_search_cache" && options.failure === "stockCache") {
            sendJson(response, 500, { message: "simulated stock cache outage" });
            return;
          }

          const representation = String(request.headers.prefer ?? "").includes("return=representation");
          const reply = (status: number, payload: unknown) => {
            if (representation) sendJson(response, status, payload);
            else {
              response.writeHead(204);
              response.end();
            }
          };

          // PostgREST filters every update/read itself. These are the operator
          // shapes the server uses: eq, lt, neq, in, and is.null.
          const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict"]);
          const matches = (row: Record<string, unknown>) => {
            for (const [name, raw] of url.searchParams) {
              if (RESERVED.has(name)) continue;
              // PostgREST JSON path filter, used by the imported-media lookup.
              if (name.startsWith("provenance->>")) {
                const field = name.slice("provenance->>".length);
                const provenance = row.provenance;
                const value =
                  provenance && typeof provenance === "object"
                    ? (provenance as Record<string, unknown>)[field]
                    : undefined;
                if (!raw.startsWith("eq.") || String(value ?? "") !== raw.slice(3)) return false;
                continue;
              }
              const value = row[name];
              if (raw.startsWith("eq.")) {
                if (String(value ?? "") !== raw.slice(3)) return false;
              } else if (raw.startsWith("lt.")) {
                if (value === null || value === undefined || String(value) >= raw.slice(3)) return false;
              } else if (raw.startsWith("gt.")) {
                if (value === null || value === undefined || String(value) <= raw.slice(3)) return false;
              } else if (raw.startsWith("gte.")) {
                if (value === null || value === undefined || String(value) < raw.slice(4)) return false;
              } else if (raw.startsWith("neq.")) {
                if (String(value ?? "") === raw.slice(4)) return false;
              } else if (raw.startsWith("in.(") && raw.endsWith(")")) {
                if (!raw.slice(4, -1).split(",").includes(String(value ?? ""))) return false;
              } else if (raw === "is.null") {
                if (value !== null && value !== undefined) return false;
              } else {
                return false;
              }
            }
            return true;
          };

          if (request.method === "POST") {
            // PostgREST accepts one object or an array of rows in the same call.
            const payload = await readJson(request);
            const bodies = (Array.isArray(payload) ? payload : [payload]) as Record<string, unknown>[];
            const now = new Date().toISOString();
            const created: Record<string, unknown>[] = [];

            for (const body of bodies) {
              // Mirrors the partial unique index: one pending image generation
              // per owner, across instances.
              if (
                table === "image_generations" &&
                body.status === "pending" &&
                data.some((row) => row.owner_id === body.owner_id && row.status === "pending")
              ) {
                sendJson(response, 409, { code: "23505", message: "duplicate pending generation" });
                return;
              }

              // Uniqueness the server relies on for idempotent media writes.
              if (
                table === "media_metadata" &&
                data.some((row) => row.object_key === body.object_key)
              ) {
                sendJson(response, 409, { code: "23505", message: "duplicate object key" });
                return;
              }
              if (
                table === "media_references" &&
                data.some(
                  (row) =>
                    row.media_id === body.media_id &&
                    row.ref_kind === body.ref_kind &&
                    row.ref_id === body.ref_id,
                )
              ) {
                sendJson(response, 409, { code: "23505", message: "duplicate media reference" });
                return;
              }

              // The render table's composite foreign key: a revision must exist.
              if (table === "render_snapshots") {
                const revisionExists = revisions.some(
                  (revision) =>
                    revision.project_id === body.project_id &&
                    revision.revision === Number(body.project_revision),
                );
                if (!revisionExists) {
                  sendJson(response, 409, { code: "23503", message: "revision does not exist" });
                  return;
                }
              }

              // Mirrors `Prefer: resolution=merge-duplicates` on (project_id, scene_key).
              if (table === "scenes" && url.searchParams.get("on_conflict") === "project_id,scene_key") {
                const existing = data.find(
                  (row) => row.project_id === body.project_id && row.scene_key === body.scene_key,
                );
                if (existing) {
                  existing.position = body.position;
                  existing.heading = body.heading;
                  existing.body = body.body;
                  existing.updated_at = body.updated_at ?? now;
                  created.push(existing);
                  continue;
                }
              }

              // The durable stock cache is keyed by cache_key and relies on
              // `Prefer: resolution=ignore-duplicates` for its atomic claim.
              if (table === "stock_search_cache") {
                const conflict = data.some((row) => row.cache_key === body.cache_key);
                if (conflict) {
                  if (String(request.headers.prefer ?? "").includes("ignore-duplicates")) {
                    reply(201, []);
                    return;
                  }
                  sendJson(response, 409, { code: "23505", message: "duplicate cache key" });
                  return;
                }
                const row: Record<string, unknown> = { ...body, created_at: now, updated_at: now };
                data.push(row);
                created.push(row);
                continue;
              }

              const row: Record<string, unknown> = {
                ...body,
                id: typeof body.id === "string" ? body.id : randomUUID(),
                created_at: now,
              };
              switch (table) {
                case "scenes":
                  row.created_at = now;
                  row.updated_at = now;
                  row.body = body.body ?? "";
                  break;
                case "claims":
                  row.status = body.status ?? "unverified";
                  break;
                case "generation_proposals":
                  row.status = body.status ?? "proposed";
                  break;
                case "provider_jobs":
                  row.status = body.status ?? "queued";
                  row.updated_at = now;
                  row.request = body.request ?? null;
                  row.result = null;
                  break;
                case "render_snapshots":
                  row.status = body.status ?? "pending";
                  break;
                case "media_metadata":
                  row.status = body.status ?? "pending";
                  row.ready_at = null;
                  row.deleted_at = null;
                  row.upload_expires_at = body.upload_expires_at ?? null;
                  row.updated_at = now;
                  break;
              }
              data.push(row);
              created.push(row);
            }

            reply(201, created);
            return;
          }

          if (request.method === "PATCH") {
            const body = (await readJson(request)) as Record<string, unknown>;
            const matched = data.filter(matches);
            // Mirrors media_metadata_ready_stock_import_key: one ready copy of a
            // stock rendition per project, reported as PostgreSQL's 23505.
            if (table === "media_metadata" && body.status === "ready") {
              const identity = (row: Record<string, unknown>): string | null => {
                const provenance = row.provenance;
                if (!provenance || typeof provenance !== "object") return null;
                const value = provenance as Record<string, unknown>;
                return `${value.provider}|${value.providerId}|${value.rendition}`;
              };
              for (const row of matched) {
                const key = identity(row);
                const conflict = data.some(
                  (other) =>
                    other !== row &&
                    other.status === "ready" &&
                    other.owner_id === row.owner_id &&
                    other.project_id === row.project_id &&
                    key !== null &&
                    identity(other) === key,
                );
                if (conflict) {
                  sendJson(response, 409, {
                    code: "23505",
                    message:
                      'duplicate key value violates unique constraint "media_metadata_ready_stock_import_key"',
                  });
                  return;
                }
              }
            }
            for (const row of matched) {
              for (const [key, value] of Object.entries(body)) {
                if (key === "id" || key === "project_id" || key === "owner_id") continue;
                row[key] = value;
              }
            }
            reply(200, matched);
            return;
          }

          if (request.method === "DELETE") {
            const removed: Record<string, unknown>[] = [];
            for (let position = data.length - 1; position >= 0; position -= 1) {
              if (matches(data[position])) removed.push(...data.splice(position, 1));
            }
            reply(200, removed);
            return;
          }

          if (request.method === "GET") {
            let rows = data.filter(matches);
            const order = url.searchParams.get("order");
            if (order === "position.asc") {
              rows = rows.slice().sort((a, b) => Number(a.position) - Number(b.position));
            } else if (order === "id.asc") {
              // Match the lexicographic order used by the gt. cursor, not locale collation.
              rows = rows.slice().sort((a, b) => {
                const left = String(a.id);
                const right = String(b.id);
                return left < right ? -1 : left > right ? 1 : 0;
              });
            }
            const rawLimit = Number(url.searchParams.get("limit") ?? "100");
            const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.min(200, Math.floor(rawLimit))) : 100;
            const rawOffset = Number(url.searchParams.get("offset") ?? "0");
            const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;

            // PostgREST returns only the selected columns. A select list that
            // omits a column the server reads must fail here, not only live.
            const select = url.searchParams.get("select");
            const columns = select ? select.split(",").map((column) => column.trim()).filter(Boolean) : null;
            const page = rows.slice(offset, offset + limit).map((row) => {
              if (!columns || columns.includes("*")) return row;
              return Object.fromEntries(columns.map((column) => [column, row[column]]));
            });
            sendJson(response, 200, page);
            return;
          }
        }
      }

      sendJson(response, 404, { message: "not found" });
    } catch {
      sendJson(response, 500, { message: "fake Supabase error" });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    usage,
    projects,
    revisions,
    profiles,
    scenes,
    sources,
    claims,
    proposals,
    jobs,
    renders,
    media,
    mediaReferences,
    modelHealth,
    stockSearchCache,
    imageGenerations,
    narrationTracks,
    narrationUsage,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** A reservation exactly as the server writes it before calling the provider. */
export function pendingUsageRow(input: {
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  createdAt: string;
  modelId?: string;
  configuredModel?: string;
  projectId?: string | null;
}): FakeUsageRow {
  return {
    id: randomUUID(),
    user_id: input.userId,
    project_id: input.projectId ?? null,
    model_id: input.modelId ?? "gemma",
    configured_model: input.configuredModel ?? "gemma4:31b",
    returned_model: null,
    prompt_eval_count: null,
    eval_count: null,
    latency_ms: 0,
    status: "pending",
    error_code: null,
    upstream_status: null,
    created_at: input.createdAt,
    idempotency_key: input.idempotencyKey,
    request_hash: input.requestHash,
    response_body: null,
    response_status: null,
  };
}
