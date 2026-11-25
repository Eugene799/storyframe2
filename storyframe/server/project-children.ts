import type {
  ClaimRecord,
  ClaimStatus,
  GenerationProposalRecord,
  JobStatus,
  ProposalStatus,
  ProviderJobRecord,
  RenderSnapshotRecord,
  RenderStatus,
  SceneRecord,
  SourceKind,
  SourceRecord,
} from "../shared/child-contract";
import { ApiError } from "./api-error";

/** Upper bounds for one child-table write. Larger requests are refused, never truncated. */
export const CHILD_LIMITS = {
  bodyBytes: 64 * 1024,
  listLimit: 100,
  scenes: 50,
  sceneKeyChars: 64,
  sceneHeadingChars: 200,
  sceneBodyChars: 20000,
  sourceTitleChars: 300,
  urlChars: 2048,
  claimStatementChars: 2000,
  modelIdChars: 120,
  promptChars: 4000,
  excerptChars: 4000,
  proposalBytes: 16 * 1024,
  providerChars: 64,
  externalIdChars: 200,
  outputKeyChars: 512,
} as const;

const SOURCE_KINDS: readonly SourceKind[] = ["web", "document", "interview", "other"];
const CLAIM_STATUSES: readonly ClaimStatus[] = ["unverified", "supported", "contradicted"];
const PROPOSAL_STATUSES: readonly ProposalStatus[] = ["proposed", "accepted", "rejected"];
const PROPOSAL_ROUTES = ["angles", "script", "storyboard", "ad-concept", "transcript-analysis", "legacy"] as const;
const JOB_STATUSES: readonly JobStatus[] = ["queued", "running", "succeeded", "failed"];
const RENDER_STATUSES: readonly RenderStatus[] = ["pending", "ready", "failed"];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isChildId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** One message per entity, for "missing" and "not yours" alike. */
export const CHILD_NOT_FOUND_MESSAGES = {
  source: "No source with that id is owned by this account.",
  claim: "No claim with that id is owned by this account.",
  proposal: "No generation proposal with that id is owned by this account.",
  job: "No provider job with that id is owned by this account.",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBody(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new ApiError(400, "INVALID_BODY", "Request body must be a JSON object.");
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new ApiError(400, "UNEXPECTED_FIELD", `Request body may only contain ${allowed.join(", ")}.`);
    }
  }
  return input;
}

function readText(value: unknown, label: string, maxChars: number, allowEmpty = false): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_CHILD_RECORD", `${label} must be a string.`);
  }
  const text = value.trim();
  if (!allowEmpty && text.length === 0) {
    throw new ApiError(400, "INVALID_CHILD_RECORD", `${label} must not be empty.`);
  }
  if (text.length > maxChars) {
    throw new ApiError(400, "INVALID_CHILD_RECORD", `${label} must be at most ${maxChars} characters.`);
  }
  return text;
}

function readOptionalText(value: unknown, label: string, maxChars: number): string | null {
  if (value === undefined || value === null) return null;
  return readText(value, label, maxChars);
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ApiError(400, "INVALID_CHILD_RECORD", `${label} must be one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

function readUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !isChildId(value)) {
    throw new ApiError(400, "INVALID_CHILD_RECORD", `${label} must be a UUID.`);
  }
  return value;
}

function readTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ApiError(400, "INVALID_CHILD_RECORD", `${label} must be an ISO timestamp.`);
  }
  return new Date(value).toISOString();
}

function readJsonObject(value: unknown, label: string, maxBytes: number): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ApiError(400, "INVALID_CHILD_RECORD", `${label} must be a JSON object.`);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) {
    throw new ApiError(400, "INVALID_CHILD_RECORD", `${label} must serialize to at most ${maxBytes} bytes.`);
  }
  return value;
}

// ---- Scenes -----------------------------------------------------------------

export interface SceneInput {
  key: string;
  heading: string;
  body: string;
}

function parseScene(value: unknown, index: number): SceneInput {
  const label = `scenes[${index}]`;
  if (!isRecord(value)) {
    throw new ApiError(400, "INVALID_CHILD_RECORD", `${label} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!["key", "heading", "body"].includes(key)) {
      throw new ApiError(400, "UNEXPECTED_FIELD", `${label} may only contain key, heading, body.`);
    }
  }
  const body = value.body ?? "";
  if (typeof body !== "string" || body.length > CHILD_LIMITS.sceneBodyChars) {
    throw new ApiError(
      400,
      "INVALID_CHILD_RECORD",
      `${label}.body must be a string of at most ${CHILD_LIMITS.sceneBodyChars} characters.`,
    );
  }
  return {
    key: readText(value.key, `${label}.key`, CHILD_LIMITS.sceneKeyChars),
    heading: readText(value.heading, `${label}.heading`, CHILD_LIMITS.sceneHeadingChars),
    body,
  };
}

/** Replaces the whole scene list, so the document and its addressable form agree. */
export function parseSceneList(body: unknown): SceneInput[] {
  const record = readBody(body, ["scenes"]);
  const scenes = record.scenes;
  if (!Array.isArray(scenes)) {
    throw new ApiError(400, "INVALID_CHILD_RECORD", "scenes must be an array.");
  }
  if (scenes.length > CHILD_LIMITS.scenes) {
    throw new ApiError(400, "INVALID_CHILD_RECORD", `scenes must hold at most ${CHILD_LIMITS.scenes} scenes.`);
  }
  const parsed = scenes.map(parseScene);
  const seen = new Set<string>();
  for (const scene of parsed) {
    if (seen.has(scene.key)) {
      throw new ApiError(400, "DUPLICATE_SCENE_KEY", `Scene key "${scene.key}" appears more than once.`);
    }
    seen.add(scene.key);
  }
  return parsed;
}

// ---- Sources ----------------------------------------------------------------

export interface SourceWrite {
  kind: SourceKind;
  title: string;
  url: string | null;
  /** The exact passage planning may quote; optional because not every source has one. */
  excerpt: string | null;
  retrievedAt: string | null;
}

export function parseSourceWrite(body: unknown): SourceWrite {
  const record = readBody(body, ["kind", "title", "url", "excerpt", "retrievedAt"]);
  const url = readOptionalText(record.url, "url", CHILD_LIMITS.urlChars);
  if (url !== null && !/^https?:\/\//i.test(url)) {
    throw new ApiError(400, "INVALID_CHILD_RECORD", "url must start with http:// or https://.");
  }
  return {
    kind: readEnum(record.kind, SOURCE_KINDS, "kind"),
    title: readText(record.title, "title", CHILD_LIMITS.sourceTitleChars),
    url,
    excerpt: readOptionalText(record.excerpt, "excerpt", CHILD_LIMITS.excerptChars),
    retrievedAt: readTimestamp(record.retrievedAt, "retrievedAt"),
  };
}

// ---- Claims -----------------------------------------------------------------

export interface ClaimWrite {
  statement: string;
  sourceId: string | null;
  sceneKey: string | null;
  /** A verbatim supporting passage; the server, not the client, decides status. */
  quote: string | null;
}

export function parseClaimWrite(body: unknown): ClaimWrite {
  const record = readBody(body, ["statement", "sourceId", "sceneKey", "quote"]);
  return {
    statement: readText(record.statement, "statement", CHILD_LIMITS.claimStatementChars),
    sourceId: record.sourceId === undefined || record.sourceId === null ? null : readUuid(record.sourceId, "sourceId"),
    sceneKey: readOptionalText(record.sceneKey, "sceneKey", CHILD_LIMITS.sceneKeyChars),
    quote: readOptionalText(record.quote, "quote", CHILD_LIMITS.excerptChars),
  };
}

export function parseClaimUpdate(body: unknown): { status: ClaimStatus } {
  const record = readBody(body, ["status"]);
  return { status: readEnum(record.status, CLAIM_STATUSES, "status") };
}

// ---- Generation proposals ---------------------------------------------------

export interface ProposalWrite {
  modelId: string;
  prompt: string;
  sceneKey: string | null;
  route: string;
  baseVersion: number;
  proposal: Record<string, unknown>;
}

export function parseProposalWrite(body: unknown): ProposalWrite {
  const record = readBody(body, ["modelId", "prompt", "sceneKey", "route", "baseVersion", "proposal"]);
  // Hand-recorded proposals keep working: they default to the legacy route at
  // version 1, and only the planning endpoint sets a real route.
  const route = record.route === undefined ? "legacy" : readEnum(record.route, PROPOSAL_ROUTES, "route");
  const baseVersion = record.baseVersion === undefined ? 1 : record.baseVersion;
  if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 1) {
    throw new ApiError(400, "INVALID_CHILD_RECORD", "baseVersion must be a positive integer.");
  }
  return {
    modelId: readText(record.modelId, "modelId", CHILD_LIMITS.modelIdChars),
    prompt: readText(record.prompt, "prompt", CHILD_LIMITS.promptChars),
    sceneKey: readOptionalText(record.sceneKey, "sceneKey", CHILD_LIMITS.sceneKeyChars),
    route,
    baseVersion,
    proposal: readJsonObject(record.proposal, "proposal", CHILD_LIMITS.proposalBytes),
  };
}

export function parseProposalUpdate(body: unknown): { status: ProposalStatus } {
  const record = readBody(body, ["status"]);
  return { status: readEnum(record.status, PROPOSAL_STATUSES, "status") };
}

// ---- Provider jobs ----------------------------------------------------------

export interface JobWrite {
  provider: string;
  externalId: string | null;
  request: Record<string, unknown> | null;
}

export function parseJobWrite(body: unknown): JobWrite {
  const record = readBody(body, ["provider", "externalId", "request"]);
  return {
    provider: readText(record.provider, "provider", CHILD_LIMITS.providerChars),
    externalId: readOptionalText(record.externalId, "externalId", CHILD_LIMITS.externalIdChars),
    request:
      record.request === undefined || record.request === null
        ? null
        : readJsonObject(record.request, "request", CHILD_LIMITS.proposalBytes),
  };
}

export interface JobUpdate {
  status: JobStatus;
  externalId: string | null | undefined;
  result: Record<string, unknown> | null | undefined;
}

export function parseJobUpdate(body: unknown): JobUpdate {
  const record = readBody(body, ["status", "externalId", "result"]);
  return {
    status: readEnum(record.status, JOB_STATUSES, "status"),
    externalId:
      record.externalId === undefined
        ? undefined
        : readOptionalText(record.externalId, "externalId", CHILD_LIMITS.externalIdChars),
    result:
      record.result === undefined
        ? undefined
        : record.result === null
          ? null
          : readJsonObject(record.result, "result", CHILD_LIMITS.proposalBytes),
  };
}

// ---- Render snapshots -------------------------------------------------------

export interface RenderWrite {
  projectRevision: number;
  outputKey: string | null;
  status: RenderStatus;
}

export function parseRenderWrite(body: unknown): RenderWrite {
  const record = readBody(body, ["projectRevision", "outputKey", "status"]);
  const projectRevision = record.projectRevision;
  if (typeof projectRevision !== "number" || !Number.isInteger(projectRevision) || projectRevision < 1) {
    throw new ApiError(400, "INVALID_CHILD_RECORD", "projectRevision must be a positive integer revision.");
  }
  return {
    projectRevision,
    outputKey: readOptionalText(record.outputKey, "outputKey", CHILD_LIMITS.outputKeyChars),
    status: record.status === undefined ? "pending" : readEnum(record.status, RENDER_STATUSES, "status"),
  };
}

// ---- Row mapping ------------------------------------------------------------

function corrupt(table: string): never {
  throw new ApiError(503, "CHILD_STORE_CORRUPT", `The ${table} store returned a malformed row.`);
}

function rowText(row: Record<string, unknown>, key: string, table: string): string {
  const value = row[key];
  return typeof value === "string" ? value : corrupt(table);
}

function rowNullableText(row: Record<string, unknown>, key: string, table: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : corrupt(table);
}

function rowEnum<T extends string>(value: unknown, allowed: readonly T[], table: string): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : corrupt(table);
}

function toScene(row: Record<string, unknown>): SceneRecord {
  const position = row.position;
  if (typeof position !== "number") corrupt("scene");
  return {
    id: rowText(row, "id", "scene"),
    sceneKey: rowText(row, "scene_key", "scene"),
    position,
    heading: rowText(row, "heading", "scene"),
    body: rowText(row, "body", "scene"),
    createdAt: rowText(row, "created_at", "scene"),
    updatedAt: rowText(row, "updated_at", "scene"),
  };
}

function toSource(row: Record<string, unknown>): SourceRecord {
  return {
    id: rowText(row, "id", "source"),
    kind: rowEnum(row.kind, SOURCE_KINDS, "source"),
    title: rowText(row, "title", "source"),
    url: rowNullableText(row, "url", "source"),
    excerpt: rowNullableText(row, "excerpt", "source"),
    retrievedAt: rowNullableText(row, "retrieved_at", "source"),
    createdAt: rowText(row, "created_at", "source"),
  };
}

function toClaim(row: Record<string, unknown>): ClaimRecord {
  return {
    id: rowText(row, "id", "claim"),
    sourceId: rowNullableText(row, "source_id", "claim"),
    sceneKey: rowNullableText(row, "scene_key", "claim"),
    statement: rowText(row, "statement", "claim"),
    quote: rowNullableText(row, "supporting_quote", "claim"),
    status: rowEnum(row.status, CLAIM_STATUSES, "claim"),
    createdAt: rowText(row, "created_at", "claim"),
  };
}

function toProposal(row: Record<string, unknown>): GenerationProposalRecord {
  const proposal = row.proposal;
  if (!isRecord(proposal)) corrupt("generation proposal");
  return {
    id: rowText(row, "id", "generation proposal"),
    sceneKey: rowNullableText(row, "scene_key", "generation proposal"),
    modelId: rowText(row, "model_id", "generation proposal"),
    prompt: rowText(row, "prompt", "generation proposal"),
    status: rowEnum(row.status, PROPOSAL_STATUSES, "generation proposal"),
    route: rowNullableText(row, "route", "generation proposal") ?? "legacy",
    baseVersion: typeof row.base_version === "number" ? row.base_version : 1,
    proposal,
    createdAt: rowText(row, "created_at", "generation proposal"),
  };
}

function toJob(row: Record<string, unknown>): ProviderJobRecord {
  return {
    id: rowText(row, "id", "provider job"),
    provider: rowText(row, "provider", "provider job"),
    status: rowEnum(row.status, JOB_STATUSES, "provider job"),
    externalId: rowNullableText(row, "external_id", "provider job"),
    request: row.request ?? null,
    result: row.result ?? null,
    createdAt: rowText(row, "created_at", "provider job"),
    updatedAt: rowText(row, "updated_at", "provider job"),
  };
}

function toRender(row: Record<string, unknown>): RenderSnapshotRecord {
  const projectRevision = row.project_revision;
  if (typeof projectRevision !== "number") corrupt("render snapshot");
  return {
    id: rowText(row, "id", "render snapshot"),
    projectRevision,
    status: rowEnum(row.status, RENDER_STATUSES, "render snapshot"),
    outputKey: rowNullableText(row, "output_key", "render snapshot"),
    createdAt: rowText(row, "created_at", "render snapshot"),
  };
}

// ---- Store ------------------------------------------------------------------

export interface ChildStore {
  listScenes(ownerId: string, projectId: string): Promise<SceneRecord[]>;
  replaceScenes(ownerId: string, projectId: string, scenes: SceneInput[]): Promise<SceneRecord[]>;

  listSources(ownerId: string, projectId: string): Promise<SourceRecord[]>;
  createSource(ownerId: string, projectId: string, write: SourceWrite): Promise<SourceRecord>;
  removeSource(ownerId: string, projectId: string, sourceId: string): Promise<void>;

  listClaims(ownerId: string, projectId: string): Promise<ClaimRecord[]>;
  createClaim(
    ownerId: string,
    projectId: string,
    write: ClaimWrite,
    status?: ClaimStatus,
  ): Promise<ClaimRecord>;
  updateClaim(
    ownerId: string,
    projectId: string,
    claimId: string,
    update: { status: ClaimStatus },
  ): Promise<ClaimRecord>;
  removeClaim(ownerId: string, projectId: string, claimId: string): Promise<void>;

  listProposals(ownerId: string, projectId: string): Promise<GenerationProposalRecord[]>;
  getProposal(ownerId: string, projectId: string, proposalId: string): Promise<GenerationProposalRecord>;
  createProposal(ownerId: string, projectId: string, write: ProposalWrite): Promise<GenerationProposalRecord>;
  updateProposal(
    ownerId: string,
    projectId: string,
    proposalId: string,
    update: { status: ProposalStatus },
  ): Promise<GenerationProposalRecord>;
  removeProposal(ownerId: string, projectId: string, proposalId: string): Promise<void>;

  listJobs(ownerId: string, projectId: string): Promise<ProviderJobRecord[]>;
  createJob(ownerId: string, projectId: string, write: JobWrite): Promise<ProviderJobRecord>;
  updateJob(ownerId: string, projectId: string, jobId: string, update: JobUpdate): Promise<ProviderJobRecord>;

  listRenders(ownerId: string, projectId: string): Promise<RenderSnapshotRecord[]>;
  createRender(ownerId: string, projectId: string, write: RenderWrite): Promise<RenderSnapshotRecord>;
}

interface SupabaseChildStoreOptions {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
}

/**
 * Child rows for one project. Every statement carries the verified owner id and
 * the project id, so the service role can never reach another account's rows,
 * and a foreign project id is answered before any child query runs.
 */
export function createSupabaseChildStore(options: SupabaseChildStoreOptions): ChildStore {
  const base = `${options.url.replace(/\/+$/, "")}/rest/v1`;
  const authHeaders = {
    apikey: options.serviceRoleKey,
    Authorization: `Bearer ${options.serviceRoleKey}`,
  };
  const readHeaders = { ...authHeaders, Accept: "application/json" };
  const jsonHeaders = { ...authHeaders, "Content-Type": "application/json", Accept: "application/json" };
  const writeHeaders = { ...jsonHeaders, Prefer: "return=representation" };

  async function request(
    target: string,
    init: RequestInit,
    action: string,
    mapError?: (status: number) => never,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(target, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch {
      throw new ApiError(503, "CHILD_STORE_UNAVAILABLE", "The project data store is unreachable.");
    }
    if (!response.ok) {
      if (mapError) mapError(response.status);
      throw new ApiError(
        503,
        "CHILD_STORE_UNAVAILABLE",
        `The project data store rejected ${action} (HTTP ${response.status}).`,
      );
    }
    return response.json().catch(() => null);
  }

  function rows(payload: unknown): Record<string, unknown>[] {
    if (!Array.isArray(payload)) {
      throw new ApiError(503, "CHILD_STORE_UNAVAILABLE", "The project data store returned an unreadable response.");
    }
    return payload.map((row) => (isRecord(row) ? row : {}));
  }

  function tableUrl(table: string, query: Record<string, string> = {}): string {
    return `${base}/${table}?${new URLSearchParams(query)}`;
  }

  async function listScenes(ownerId: string, projectId: string): Promise<SceneRecord[]> {
    const found = rows(
      await request(
        tableUrl("scenes", {
          select: "id,scene_key,position,heading,body,created_at,updated_at",
          owner_id: `eq.${ownerId}`,
          project_id: `eq.${projectId}`,
          order: "position.asc",
          limit: String(CHILD_LIMITS.listLimit),
        }),
        { headers: readHeaders },
        "the scene list",
      ),
    );
    return found.map(toScene);
  }

  async function listSources(ownerId: string, projectId: string): Promise<SourceRecord[]> {
    const found = rows(
      await request(
        tableUrl("sources", {
          select: "id,kind,title,url,excerpt,retrieved_at,created_at",
          owner_id: `eq.${ownerId}`,
          project_id: `eq.${projectId}`,
          order: "created_at.asc",
          limit: String(CHILD_LIMITS.listLimit),
        }),
        { headers: readHeaders },
        "the source list",
      ),
    );
    return found.map(toSource);
  }

  async function listClaims(ownerId: string, projectId: string): Promise<ClaimRecord[]> {
    const found = rows(
      await request(
        tableUrl("claims", {
          select: "id,source_id,scene_key,statement,supporting_quote,status,created_at",
          owner_id: `eq.${ownerId}`,
          project_id: `eq.${projectId}`,
          order: "created_at.asc",
          limit: String(CHILD_LIMITS.listLimit),
        }),
        { headers: readHeaders },
        "the claim list",
      ),
    );
    return found.map(toClaim);
  }

  async function listProposals(ownerId: string, projectId: string): Promise<GenerationProposalRecord[]> {
    const found = rows(
      await request(
        tableUrl("generation_proposals", {
          select: "id,scene_key,model_id,prompt,status,route,base_version,proposal,created_at",
          owner_id: `eq.${ownerId}`,
          project_id: `eq.${projectId}`,
          order: "created_at.asc",
          limit: String(CHILD_LIMITS.listLimit),
        }),
        { headers: readHeaders },
        "the proposal list",
      ),
    );
    return found.map(toProposal);
  }

  async function getProposal(
    ownerId: string,
    projectId: string,
    proposalId: string,
  ): Promise<GenerationProposalRecord> {
    const found = rows(
      await request(
        tableUrl("generation_proposals", {
          select: "id,scene_key,model_id,prompt,status,route,base_version,proposal,created_at",
          id: `eq.${proposalId}`,
          owner_id: `eq.${ownerId}`,
          project_id: `eq.${projectId}`,
          limit: "1",
        }),
        { headers: readHeaders },
        "the proposal read",
      ),
    );
    if (found.length === 0) {
      throw new ApiError(404, "CHILD_RECORD_NOT_FOUND", CHILD_NOT_FOUND_MESSAGES.proposal);
    }
    return toProposal(found[0]);
  }

  async function listJobs(ownerId: string, projectId: string): Promise<ProviderJobRecord[]> {
    const found = rows(
      await request(
        tableUrl("provider_jobs", {
          select: "id,provider,status,external_id,request,result,created_at,updated_at",
          owner_id: `eq.${ownerId}`,
          project_id: `eq.${projectId}`,
          order: "created_at.asc",
          limit: String(CHILD_LIMITS.listLimit),
        }),
        { headers: readHeaders },
        "the job list",
      ),
    );
    return found.map(toJob);
  }

  async function listRenders(ownerId: string, projectId: string): Promise<RenderSnapshotRecord[]> {
    const found = rows(
      await request(
        tableUrl("render_snapshots", {
          select: "id,project_revision,status,output_key,created_at",
          owner_id: `eq.${ownerId}`,
          project_id: `eq.${projectId}`,
          order: "created_at.asc",
          limit: String(CHILD_LIMITS.listLimit),
        }),
        { headers: readHeaders },
        "the render list",
      ),
    );
    return found.map(toRender);
  }

  /** A write addressed by id, project, and owner: exactly one owned row, or a 404. */
  async function removeOwned(
    table: string,
    ownerId: string,
    projectId: string,
    id: string,
    notFound: string,
  ): Promise<void> {
    const removed = rows(
      await request(
        tableUrl(table, { id: `eq.${id}`, project_id: `eq.${projectId}`, owner_id: `eq.${ownerId}` }),
        { method: "DELETE", headers: { ...readHeaders, Prefer: "return=representation" } },
        `the ${table} removal`,
      ),
    );
    if (removed.length === 0) throw new ApiError(404, "CHILD_RECORD_NOT_FOUND", notFound);
  }

  return {
    listScenes,

    async replaceScenes(ownerId, projectId, scenes) {
      const existing = await listScenes(ownerId, projectId);
      const now = new Date().toISOString();

      // Upsert first, then prune, so a failed write cannot lose the current list.
      if (scenes.length > 0) {
        await request(
          tableUrl("scenes", { on_conflict: "project_id,scene_key" }),
          {
            method: "POST",
            headers: { ...jsonHeaders, Prefer: "resolution=merge-duplicates,return=representation" },
            body: JSON.stringify(
              scenes.map((scene, position) => ({
                project_id: projectId,
                owner_id: ownerId,
                scene_key: scene.key,
                position,
                heading: scene.heading,
                body: scene.body,
                updated_at: now,
              })),
            ),
          },
          "the scene save",
        );
      }

      const keep = new Set(scenes.map((scene) => scene.key));
      for (const scene of existing) {
        if (keep.has(scene.sceneKey)) continue;
        await request(
          tableUrl("scenes", {
            project_id: `eq.${projectId}`,
            owner_id: `eq.${ownerId}`,
            scene_key: `eq.${scene.sceneKey}`,
          }),
          { method: "DELETE", headers: readHeaders },
          "the scene removal",
        );
      }

      return listScenes(ownerId, projectId);
    },

    listSources,

    async createSource(ownerId, projectId, write) {
      const created = rows(
        await request(
          tableUrl("sources"),
          {
            method: "POST",
            headers: writeHeaders,
            body: JSON.stringify({
              owner_id: ownerId,
              project_id: projectId,
              kind: write.kind,
              title: write.title,
              url: write.url,
              excerpt: write.excerpt,
              retrieved_at: write.retrievedAt,
            }),
          },
          "the source save",
        ),
      );
      if (created.length === 0) {
        throw new ApiError(503, "CHILD_STORE_UNAVAILABLE", "The project data store did not confirm the source.");
      }
      return toSource(created[0]);
    },

    async removeSource(ownerId, projectId, sourceId) {
      // Delete the claims that cite this source before the row, so no
      // "supported" claim can outlive its evidence. For an unknown source this
      // is a scoped no-op; removeOwned then reports the 404.
      await request(
        tableUrl("claims", {
          source_id: `eq.${sourceId}`,
          project_id: `eq.${projectId}`,
          owner_id: `eq.${ownerId}`,
        }),
        { method: "DELETE", headers: writeHeaders },
        "the linked claim cleanup",
      );
      await removeOwned("sources", ownerId, projectId, sourceId, CHILD_NOT_FOUND_MESSAGES.source);
    },

    listClaims,

    async createClaim(ownerId, projectId, write, status = "unverified") {
      if (write.sourceId !== null) {
        const linked = rows(
          await request(
            tableUrl("sources", {
              select: "id",
              id: `eq.${write.sourceId}`,
              project_id: `eq.${projectId}`,
              owner_id: `eq.${ownerId}`,
              limit: "1",
            }),
            { headers: readHeaders },
            "the source check",
          ),
        );
        if (linked.length === 0) {
          throw new ApiError(400, "SOURCE_NOT_FOUND", "sourceId must name a source of this project.");
        }
      }

      const created = rows(
        await request(
          tableUrl("claims"),
          {
            method: "POST",
            headers: writeHeaders,
            body: JSON.stringify({
              owner_id: ownerId,
              project_id: projectId,
              source_id: write.sourceId,
              scene_key: write.sceneKey,
              statement: write.statement,
              supporting_quote: write.quote,
              status,
            }),
          },
          "the claim save",
        ),
      );
      if (created.length === 0) {
        throw new ApiError(503, "CHILD_STORE_UNAVAILABLE", "The project data store did not confirm the claim.");
      }
      return toClaim(created[0]);
    },

    async updateClaim(ownerId, projectId, claimId, update) {
      const updated = rows(
        await request(
          tableUrl("claims", {
            id: `eq.${claimId}`,
            project_id: `eq.${projectId}`,
            owner_id: `eq.${ownerId}`,
          }),
          { method: "PATCH", headers: writeHeaders, body: JSON.stringify({ status: update.status }) },
          "the claim update",
        ),
      );
      if (updated.length === 0) {
        throw new ApiError(404, "CHILD_RECORD_NOT_FOUND", CHILD_NOT_FOUND_MESSAGES.claim);
      }
      return toClaim(updated[0]);
    },

    async removeClaim(ownerId, projectId, claimId) {
      await removeOwned("claims", ownerId, projectId, claimId, CHILD_NOT_FOUND_MESSAGES.claim);
    },

    listProposals,
    getProposal,

    async createProposal(ownerId, projectId, write) {
      const created = rows(
        await request(
          tableUrl("generation_proposals"),
          {
            method: "POST",
            headers: writeHeaders,
            body: JSON.stringify({
              owner_id: ownerId,
              project_id: projectId,
              scene_key: write.sceneKey,
              model_id: write.modelId,
              prompt: write.prompt,
              status: "proposed",
              route: write.route,
              base_version: write.baseVersion,
              proposal: write.proposal,
            }),
          },
          "the proposal save",
        ),
      );
      if (created.length === 0) {
        throw new ApiError(503, "CHILD_STORE_UNAVAILABLE", "The project data store did not confirm the proposal.");
      }
      return toProposal(created[0]);
    },

    async removeProposal(ownerId, projectId, proposalId) {
      await removeOwned(
        "generation_proposals",
        ownerId,
        projectId,
        proposalId,
        CHILD_NOT_FOUND_MESSAGES.proposal,
      );
    },

    async updateProposal(ownerId, projectId, proposalId, update) {
      const updated = rows(
        await request(
          tableUrl("generation_proposals", {
            id: `eq.${proposalId}`,
            project_id: `eq.${projectId}`,
            owner_id: `eq.${ownerId}`,
          }),
          { method: "PATCH", headers: writeHeaders, body: JSON.stringify({ status: update.status }) },
          "the proposal update",
        ),
      );
      if (updated.length === 0) {
        throw new ApiError(404, "CHILD_RECORD_NOT_FOUND", CHILD_NOT_FOUND_MESSAGES.proposal);
      }
      return toProposal(updated[0]);
    },

    listJobs,

    async createJob(ownerId, projectId, write) {
      const created = rows(
        await request(
          tableUrl("provider_jobs"),
          {
            method: "POST",
            headers: writeHeaders,
            body: JSON.stringify({
              owner_id: ownerId,
              project_id: projectId,
              provider: write.provider,
              status: "queued",
              external_id: write.externalId,
              request: write.request,
            }),
          },
          "the job save",
        ),
      );
      if (created.length === 0) {
        throw new ApiError(503, "CHILD_STORE_UNAVAILABLE", "The project data store did not confirm the job.");
      }
      return toJob(created[0]);
    },

    async updateJob(ownerId, projectId, jobId, update) {
      const body: Record<string, unknown> = {
        status: update.status,
        updated_at: new Date().toISOString(),
      };
      if (update.externalId !== undefined) body.external_id = update.externalId;
      if (update.result !== undefined) body.result = update.result;

      const updated = rows(
        await request(
          tableUrl("provider_jobs", {
            id: `eq.${jobId}`,
            project_id: `eq.${projectId}`,
            owner_id: `eq.${ownerId}`,
          }),
          { method: "PATCH", headers: writeHeaders, body: JSON.stringify(body) },
          "the job update",
        ),
      );
      if (updated.length === 0) {
        throw new ApiError(404, "CHILD_RECORD_NOT_FOUND", CHILD_NOT_FOUND_MESSAGES.job);
      }
      return toJob(updated[0]);
    },

    listRenders,

    async createRender(ownerId, projectId, write) {
      const created = rows(
        await request(
          tableUrl("render_snapshots"),
          {
            method: "POST",
            headers: writeHeaders,
            body: JSON.stringify({
              owner_id: ownerId,
              project_id: projectId,
              project_revision: write.projectRevision,
              status: write.status,
              output_key: write.outputKey,
            }),
          },
          "the render save",
          (status) => {
            // The composite foreign key refuses a revision that does not exist.
            if (status === 409 || status === 400) {
              throw new ApiError(
                409,
                "PROJECT_REVISION_NOT_FOUND",
                "projectRevision must name a revision this project already has.",
              );
            }
            throw new ApiError(
              503,
              "CHILD_STORE_UNAVAILABLE",
              `The project data store rejected the render save (HTTP ${status}).`,
            );
          },
        ),
      );
      if (created.length === 0) {
        throw new ApiError(503, "CHILD_STORE_UNAVAILABLE", "The project data store did not confirm the render.");
      }
      return toRender(created[0]);
    },
  };
}
