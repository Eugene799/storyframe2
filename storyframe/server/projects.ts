import { ApiError } from "./api-error";
import { defaultBriefFor } from "../shared/project-defaults";
import { sceneFingerprint } from "../shared/scene-fingerprint";
import {
  PROJECT_SCHEMA_VERSION,
  type BriefMode,
  type ProjectBrief,
  type ProjectDocumentV2,
  type ProjectRecord,
  type ProjectRevisionSummary,
  type ProjectScene,
  type ProjectSummary,
  type ProjectType,
  type SceneLocks,
  type VoicePreference,
} from "../shared/project-contract";

const PROJECTS_TABLE = "projects";

export const PROJECT_LIST_LIMIT = 50;

/** Upper bounds for one project write. Larger requests are refused, never truncated. */
export const PROJECT_LIMITS = {
  bodyBytes: 128 * 1024,
  titleChars: 200,
  summaryChars: 2000,
  scenes: 50,
  sceneIdChars: 64,
  sceneHeadingChars: 200,
  sceneBodyChars: 20000,
  sceneVisualChars: 4000,
  sceneOnScreenChars: 500,
  sceneDurationMax: 3600,
  sceneAssets: 20,
  assetIdChars: 64,
  briefTopicChars: 300,
  briefAudienceChars: 300,
  briefGoalChars: 500,
  briefToneChars: 80,
  briefPresetChars: 80,
  targetDurationMin: 5,
  targetDurationMax: 3600,
  planningBudgetMaxUsd: 10_000,
} as const;

const SCENE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BRIEF_MODES: readonly BriefMode[] = ["factual", "fiction"];
const VOICE_PREFERENCES: readonly VoicePreference[] = ["warm", "energetic", "neutral", "none"];

const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isProjectId(value: string): boolean {
  return PROJECT_ID_PATTERN.test(value);
}

/** One message for "missing" and "not yours", so a foreign id discloses nothing. */
export const PROJECT_NOT_FOUND_MESSAGE = "No project with that id is owned by this account.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ApiError(400, "UNEXPECTED_FIELD", `${label} may only contain ${allowed.join(", ")}.`);
    }
  }
}

function readBoundedText(value: unknown, label: string, maxChars: number, allowEmpty = false): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_PROJECT", `${label} must be a string.`);
  }
  const text = value.trim();
  if (!allowEmpty && text.length === 0) {
    throw new ApiError(400, "INVALID_PROJECT", `${label} must not be empty.`);
  }
  if (text.length > maxChars) {
    throw new ApiError(400, "INVALID_PROJECT", `${label} must be at most ${maxChars} characters.`);
  }
  return text;
}

function readBoundedNumber(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new ApiError(400, "INVALID_PROJECT", `${label} must be a number between ${min} and ${max}.`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new ApiError(400, "INVALID_PROJECT", `${label} must be a whole number.`);
  }
  return value;
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ApiError(400, "INVALID_PROJECT", `${label} must be a boolean.`);
  }
  return value;
}

function parseLocks(value: unknown, label: string): SceneLocks {
  if (!isRecord(value)) {
    throw new ApiError(400, "INVALID_PROJECT", `${label} must be an object.`);
  }
  requireExactKeys(value, ["narration", "visualDirection", "onScreenText", "duration"], label);
  return {
    narration: readBoolean(value.narration, `${label}.narration`),
    visualDirection: readBoolean(value.visualDirection, `${label}.visualDirection`),
    onScreenText: readBoolean(value.onScreenText, `${label}.onScreenText`),
    duration: readBoolean(value.duration, `${label}.duration`),
  };
}

function parseBrief(value: unknown): ProjectBrief {
  if (!isRecord(value)) {
    throw new ApiError(400, "INVALID_PROJECT", "document.brief must be an object.");
  }
  requireExactKeys(
    value,
    [
      "topic",
      "audience",
      "goal",
      "mode",
      "targetDurationSeconds",
      "tone",
      "preset",
      "voicePreference",
      "planningBudgetUsd",
    ],
    "document.brief",
  );

  const mode = value.mode;
  if (typeof mode !== "string" || !BRIEF_MODES.includes(mode as BriefMode)) {
    throw new ApiError(400, "INVALID_PROJECT", "document.brief.mode must be factual or fiction.");
  }
  const voice = value.voicePreference;
  if (typeof voice !== "string" || !VOICE_PREFERENCES.includes(voice as VoicePreference)) {
    throw new ApiError(
      400,
      "INVALID_PROJECT",
      `document.brief.voicePreference must be one of ${VOICE_PREFERENCES.join(", ")}.`,
    );
  }

  return {
    topic: readBoundedText(value.topic, "document.brief.topic", PROJECT_LIMITS.briefTopicChars, true),
    audience: readBoundedText(value.audience, "document.brief.audience", PROJECT_LIMITS.briefAudienceChars, true),
    goal: readBoundedText(value.goal, "document.brief.goal", PROJECT_LIMITS.briefGoalChars, true),
    mode: mode as BriefMode,
    targetDurationSeconds: readBoundedNumber(
      value.targetDurationSeconds,
      "document.brief.targetDurationSeconds",
      PROJECT_LIMITS.targetDurationMin,
      PROJECT_LIMITS.targetDurationMax,
      true,
    ),
    tone: readBoundedText(value.tone, "document.brief.tone", PROJECT_LIMITS.briefToneChars, true),
    preset: readBoundedText(value.preset, "document.brief.preset", PROJECT_LIMITS.briefPresetChars, true),
    voicePreference: voice as VoicePreference,
    planningBudgetUsd: readBoundedNumber(
      value.planningBudgetUsd,
      "document.brief.planningBudgetUsd",
      0,
      PROJECT_LIMITS.planningBudgetMaxUsd,
    ),
  };
}

const SCENE_KEYS = [
  "id",
  "heading",
  "body",
  "visualDirection",
  "assetIds",
  "onScreenText",
  "durationSeconds",
  "approved",
  "approvedFingerprint",
  "locks",
] as const;

function parseScene(value: unknown, index: number): ProjectScene {
  const label = `document.scenes[${index}]`;
  if (!isRecord(value)) {
    throw new ApiError(400, "INVALID_PROJECT", `${label} must be an object.`);
  }
  requireExactKeys(value, SCENE_KEYS, label);

  const id = readBoundedText(value.id, `${label}.id`, PROJECT_LIMITS.sceneIdChars);
  if (!SCENE_ID_PATTERN.test(id)) {
    throw new ApiError(400, "INVALID_PROJECT", `${label}.id must use letters, numbers, dashes, or underscores.`);
  }

  const heading = readBoundedText(value.heading, `${label}.heading`, PROJECT_LIMITS.sceneHeadingChars);
  const body = value.body;
  if (typeof body !== "string" || body.length > PROJECT_LIMITS.sceneBodyChars) {
    throw new ApiError(
      400,
      "INVALID_PROJECT",
      `${label}.body must be a string of at most ${PROJECT_LIMITS.sceneBodyChars} characters.`,
    );
  }
  const visualDirection = readBoundedText(
    value.visualDirection,
    `${label}.visualDirection`,
    PROJECT_LIMITS.sceneVisualChars,
    true,
  );
  const onScreenText = readBoundedText(
    value.onScreenText,
    `${label}.onScreenText`,
    PROJECT_LIMITS.sceneOnScreenChars,
    true,
  );

  const rawAssets = value.assetIds;
  if (!Array.isArray(rawAssets)) {
    throw new ApiError(400, "INVALID_PROJECT", `${label}.assetIds must be an array.`);
  }
  if (rawAssets.length > PROJECT_LIMITS.sceneAssets) {
    throw new ApiError(400, "INVALID_PROJECT", `${label}.assetIds must hold at most ${PROJECT_LIMITS.sceneAssets} ids.`);
  }
  const assetIds = rawAssets.map((asset, assetIndex) => {
    if (typeof asset !== "string") {
      throw new ApiError(400, "INVALID_PROJECT", `${label}.assetIds[${assetIndex}] must be a string.`);
    }
    const assetId = asset.trim();
    if (assetId.length === 0 || assetId.length > PROJECT_LIMITS.assetIdChars) {
      throw new ApiError(400, "INVALID_PROJECT", `${label}.assetIds[${assetIndex}] must be 1-64 characters.`);
    }
    return assetId;
  });
  if (new Set(assetIds).size !== assetIds.length) {
    throw new ApiError(400, "INVALID_PROJECT", `${label}.assetIds must not repeat an id.`);
  }

  const fingerprint = value.approvedFingerprint;
  if (fingerprint !== null && (typeof fingerprint !== "string" || fingerprint.length > 64)) {
    throw new ApiError(400, "INVALID_PROJECT", `${label}.approvedFingerprint must be a string or null.`);
  }

  return {
    id,
    heading,
    body,
    visualDirection,
    assetIds,
    onScreenText,
    durationSeconds: readBoundedNumber(
      value.durationSeconds,
      `${label}.durationSeconds`,
      0,
      PROJECT_LIMITS.sceneDurationMax,
      true,
    ),
    approved: readBoolean(value.approved, `${label}.approved`),
    approvedFingerprint: fingerprint as string | null,
    locks: parseLocks(value.locks, `${label}.locks`),
  };
}

function parseDocumentValue(value: unknown): ProjectDocumentV2 {
  if (!isRecord(value)) {
    throw new ApiError(400, "INVALID_PROJECT", "document must be an object.");
  }
  requireExactKeys(value, ["schemaVersion", "summary", "brief", "scenes"], "document");

  if (value.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new ApiError(
      400,
      "UNSUPPORTED_PROJECT_SCHEMA",
      `document.schemaVersion must be ${PROJECT_SCHEMA_VERSION}.`,
    );
  }

  const summary = readBoundedText(value.summary, "document.summary", PROJECT_LIMITS.summaryChars, true);
  const scenes = value.scenes;
  if (!Array.isArray(scenes)) {
    throw new ApiError(400, "INVALID_PROJECT", "document.scenes must be an array.");
  }
  if (scenes.length > PROJECT_LIMITS.scenes) {
    throw new ApiError(
      400,
      "INVALID_PROJECT",
      `document.scenes must hold at most ${PROJECT_LIMITS.scenes} scenes.`,
    );
  }

  const parsed = scenes.map(parseScene);
  const ids = new Set<string>();
  for (const scene of parsed) {
    if (ids.has(scene.id)) {
      throw new ApiError(400, "DUPLICATE_SCENE_ID", `Scene id "${scene.id}" appears more than once.`);
    }
    ids.add(scene.id);
  }

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    summary,
    brief: parseBrief(value.brief),
    scenes: parsed,
  };
}

/**
 * An approval counts only for the exact content it was given. A write that
 * carries an approval from different content clears it instead of silently
 * approving the new wording.
 */
function normalizeApprovals(document: ProjectDocumentV2): ProjectDocumentV2 {
  return {
    ...document,
    scenes: document.scenes.map((scene) => {
      if (!scene.approved) return scene;
      const fingerprint = sceneFingerprint(scene);
      if (scene.approvedFingerprint === fingerprint) return scene;
      return { ...scene, approved: false, approvedFingerprint: null };
    }),
  };
}

/** Validates a document write. Stored rows are read through `migrateDocument`. */
export function parseDocument(value: unknown): ProjectDocumentV2 {
  return normalizeApprovals(parseDocumentValue(value));
}

function migrateV1(value: unknown, projectType: ProjectType): ProjectDocumentV2 {
  if (!isRecord(value)) {
    throw new ApiError(400, "INVALID_PROJECT", "document must be an object.");
  }
  requireExactKeys(value, ["schemaVersion", "summary", "scenes"], "document");
  if (value.schemaVersion !== 1) {
    throw new ApiError(400, "UNSUPPORTED_PROJECT_SCHEMA", "document.schemaVersion must be 1 for migration.");
  }

  const summary = readBoundedText(value.summary, "document.summary", PROJECT_LIMITS.summaryChars, true);
  const rawScenes = value.scenes;
  if (!Array.isArray(rawScenes) || rawScenes.length > PROJECT_LIMITS.scenes) {
    throw new ApiError(400, "INVALID_PROJECT", `document.scenes must be an array of at most ${PROJECT_LIMITS.scenes}.`);
  }

  const scenes = rawScenes.map((scene, index): ProjectScene => {
    const label = `document.scenes[${index}]`;
    if (!isRecord(scene)) {
      throw new ApiError(400, "INVALID_PROJECT", `${label} must be an object.`);
    }
    requireExactKeys(scene, ["id", "heading", "body"], label);
    const body = scene.body;
    if (typeof body !== "string" || body.length > PROJECT_LIMITS.sceneBodyChars) {
      throw new ApiError(400, "INVALID_PROJECT", `${label}.body is invalid.`);
    }
    return {
      id: readBoundedText(scene.id, `${label}.id`, PROJECT_LIMITS.sceneIdChars),
      heading: readBoundedText(scene.heading, `${label}.heading`, PROJECT_LIMITS.sceneHeadingChars),
      body,
      visualDirection: "",
      assetIds: [],
      onScreenText: "",
      durationSeconds: 0,
      approved: false,
      approvedFingerprint: null,
      locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
    };
  });

  return { schemaVersion: 2, summary, brief: defaultBriefFor(projectType), scenes };
}

/**
 * Reads a stored document at any version this server knows. Rows keep their own
 * version; v1 is upgraded on read and written back as v2 on the next save.
 */
export function migrateDocument(
  schemaVersion: number,
  document: unknown,
  projectType: ProjectType,
): ProjectDocumentV2 {
  if (schemaVersion === PROJECT_SCHEMA_VERSION) return parseDocumentValue(document);
  if (schemaVersion === 1) return migrateV1(document, projectType);

  throw new ApiError(
    409,
    "UNSUPPORTED_PROJECT_SCHEMA",
    `This project stores document schema ${schemaVersion}, which this server cannot read.`,
  );
}

const LOCKED_COMPONENTS = [
  { lock: "narration", label: "Narration", read: (scene: ProjectScene) => scene.body },
  { lock: "visualDirection", label: "Visual direction", read: (scene: ProjectScene) => scene.visualDirection },
  { lock: "onScreenText", label: "On-screen text", read: (scene: ProjectScene) => scene.onScreenText },
  { lock: "duration", label: "Duration", read: (scene: ProjectScene) => scene.durationSeconds },
] as const;

/**
 * Locks belong to the user, so unlocking in the same write permits the edit.
 * A scene with any locked component cannot be deleted until it is unlocked.
 */
export function assertSceneLocks(current: ProjectDocumentV2, next: ProjectDocumentV2): void {
  const proposed = new Map(next.scenes.map((scene) => [scene.id, scene]));
  for (const scene of current.scenes) {
    const updated = proposed.get(scene.id);
    if (!updated) {
      if (Object.values(scene.locks).some(Boolean)) {
        throw new ApiError(409, "SCENE_LOCKED", `Unlock "${scene.heading}" before deleting it.`);
      }
      continue;
    }
    for (const component of LOCKED_COMPONENTS) {
      if (!scene.locks[component.lock] || !updated.locks[component.lock]) continue;
      if (JSON.stringify(component.read(scene)) !== JSON.stringify(component.read(updated))) {
        throw new ApiError(
          409,
          "SCENE_FIELD_LOCKED",
          `Unlock "${component.label}" for scene "${scene.heading}" before changing it.`,
        );
      }
    }
  }
}

export interface ProjectWrite {
  projectType: ProjectType;
  title: string;
  document: ProjectDocumentV2;
}

export interface ProjectUpdate {
  title: string;
  document: ProjectDocumentV2;
  version: number;
}

const PROJECT_TYPES: readonly ProjectType[] = ["story", "product-ad", "repurpose"];

function readBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new ApiError(400, "INVALID_BODY", "Request body must be a JSON object.");
  }
  requireExactKeys(body, allowed, "Request body");
  return body;
}

export function parseProjectWrite(input: unknown): ProjectWrite {
  const body = readBody(input, ["projectType", "title", "document"]);

  const projectType = body.projectType;
  if (typeof projectType !== "string" || !PROJECT_TYPES.includes(projectType as ProjectType)) {
    throw new ApiError(400, "INVALID_PROJECT_TYPE", "projectType must be story, product-ad, or repurpose.");
  }

  return {
    projectType: projectType as ProjectType,
    title: readBoundedText(body.title, "title", PROJECT_LIMITS.titleChars),
    document: parseDocument(body.document),
  };
}

/** The draft the editor is showing, for an export. Ownership is checked by the route. */
export function parseProjectExportInput(input: unknown): { title: string; document: ProjectDocumentV2 } {
  const body = readBody(input, ["title", "document"]);
  return {
    title: readBoundedText(body.title, "title", PROJECT_LIMITS.titleChars),
    document: parseDocument(body.document),
  };
}

export function parseProjectUpdate(input: unknown): ProjectUpdate {
  const body = readBody(input, ["title", "document", "version"]);

  const version = body.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new ApiError(400, "INVALID_PROJECT_VERSION", "version must be the integer version you last read.");
  }

  return {
    title: readBoundedText(body.title, "title", PROJECT_LIMITS.titleChars),
    document: parseDocument(body.document),
    version,
  };
}

export interface ProjectStore {
  list(ownerId: string, limit: number): Promise<ProjectSummary[]>;
  get(ownerId: string, projectId: string): Promise<ProjectRecord>;
  create(ownerId: string, write: ProjectWrite): Promise<ProjectRecord>;
  update(ownerId: string, projectId: string, update: ProjectUpdate): Promise<ProjectRecord>;
  listRevisions(ownerId: string, projectId: string, limit: number): Promise<ProjectRevisionSummary[]>;
  remove(ownerId: string, projectId: string): Promise<void>;
}

interface SupabaseProjectStoreOptions {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
}

const SUMMARY_COLUMNS = [
  "id",
  "project_type",
  "title",
  "schema_version",
  "version",
  "created_at",
  "updated_at",
].join(",");
const PROJECT_COLUMNS = `${SUMMARY_COLUMNS},document`;

function toSummary(row: Record<string, unknown>): ProjectSummary {
  const id = row.id;
  const projectType = row.project_type;
  const title = row.title;
  const schemaVersion = row.schema_version;
  const version = row.version;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;

  if (
    typeof id !== "string" ||
    (projectType !== "story" && projectType !== "product-ad" && projectType !== "repurpose") ||
    typeof title !== "string" ||
    typeof schemaVersion !== "number" ||
    typeof version !== "number" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    throw new ApiError(503, "PROJECT_STORE_CORRUPT", "The project store returned a malformed row.");
  }

  return { id, projectType, title, schemaVersion, version, createdAt, updatedAt };
}

function toRevision(row: Record<string, unknown>): ProjectRevisionSummary {
  const revision = row.revision;
  const schemaVersion = row.schema_version;
  if (
    typeof revision !== "number" ||
    typeof schemaVersion !== "number" ||
    typeof row.title !== "string" ||
    typeof row.created_at !== "string"
  ) {
    throw new ApiError(503, "PROJECT_STORE_CORRUPT", "The project store returned a malformed revision.");
  }
  return { revision, title: row.title, schemaVersion, createdAt: row.created_at };
}

function toProject(row: Record<string, unknown>): ProjectRecord {
  const summary = toSummary(row);
  try {
    return {
      ...summary,
      document: migrateDocument(summary.schemaVersion, row.document, summary.projectType),
    };
  } catch (error) {
    if (error instanceof ApiError && error.code === "UNSUPPORTED_PROJECT_SCHEMA") throw error;
    throw new ApiError(503, "PROJECT_STORE_CORRUPT", "A stored project document could not be read.");
  }
}

/**
 * Durable project store backed by the Supabase PostgREST endpoint. Every query
 * carries the verified owner id, so the service role can never reach another
 * account's row. Revision history is written by the database trigger, in the
 * same transaction as the project row.
 */
export function createSupabaseProjectStore(options: SupabaseProjectStoreOptions): ProjectStore {
  const restBase = `${options.url.replace(/\/+$/, "")}/rest/v1`;
  const endpoint = `${restBase}/${PROJECTS_TABLE}`;
  const revisionsEndpoint = `${restBase}/project_revisions`;
  const authHeaders = {
    apikey: options.serviceRoleKey,
    Authorization: `Bearer ${options.serviceRoleKey}`,
  };

  async function request(target: string, init: RequestInit, action: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(target, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch {
      throw new ApiError(503, "PROJECTS_UNAVAILABLE", "The project store is unreachable.");
    }
    if (!response.ok) {
      throw new ApiError(
        503,
        "PROJECTS_UNAVAILABLE",
        `The project store rejected ${action} (HTTP ${response.status}).`,
      );
    }
    return response.json().catch(() => null);
  }

  function rows(payload: unknown): Record<string, unknown>[] {
    if (!Array.isArray(payload)) {
      throw new ApiError(503, "PROJECTS_UNAVAILABLE", "The project store returned an unreadable response.");
    }
    return payload.map((row) => (isRecord(row) ? row : {}));
  }

  async function get(ownerId: string, projectId: string): Promise<ProjectRecord> {
    const query = new URLSearchParams({
      select: PROJECT_COLUMNS,
      id: `eq.${projectId}`,
      owner_id: `eq.${ownerId}`,
      limit: "1",
    });
    const found = rows(
      await request(`${endpoint}?${query}`, { headers: { ...authHeaders, Accept: "application/json" } }, "the read"),
    );
    if (found.length === 0) throw new ApiError(404, "PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_MESSAGE);
    return toProject(found[0]);
  }

  return {
    async list(ownerId: string, limit: number): Promise<ProjectSummary[]> {
      const query = new URLSearchParams({
        select: SUMMARY_COLUMNS,
        owner_id: `eq.${ownerId}`,
        order: "updated_at.desc",
        limit: String(limit),
      });
      const found = rows(
        await request(`${endpoint}?${query}`, { headers: { ...authHeaders, Accept: "application/json" } }, "the list"),
      );
      return found.map(toSummary);
    },

    get,

    async create(ownerId: string, write: ProjectWrite): Promise<ProjectRecord> {
      const created = rows(
        await request(
          endpoint,
          {
            method: "POST",
            headers: {
              ...authHeaders,
              "Content-Type": "application/json",
              Accept: "application/json",
              Prefer: "return=representation",
            },
            body: JSON.stringify({
              // The owner always comes from the verified session, never from the request body.
              owner_id: ownerId,
              project_type: write.projectType,
              title: write.title,
              schema_version: write.document.schemaVersion,
              document: write.document,
              version: 1,
            }),
          },
          "the create",
        ),
      );
      if (created.length === 0) {
        throw new ApiError(503, "PROJECTS_UNAVAILABLE", "The project store did not confirm the new project.");
      }
      return toProject(created[0]);
    },

    async update(ownerId: string, projectId: string, update: ProjectUpdate): Promise<ProjectRecord> {
      const query = new URLSearchParams({
        id: `eq.${projectId}`,
        owner_id: `eq.${ownerId}`,
        version: `eq.${update.version}`,
      });
      const updated = rows(
        await request(
          `${endpoint}?${query}`,
          {
            method: "PATCH",
            headers: {
              ...authHeaders,
              "Content-Type": "application/json",
              Accept: "application/json",
              Prefer: "return=representation",
            },
            body: JSON.stringify({
              title: update.title,
              document: update.document,
              schema_version: update.document.schemaVersion,
              version: update.version + 1,
              updated_at: new Date().toISOString(),
            }),
          },
          "the update",
        ),
      );
      if (updated.length > 0) return toProject(updated[0]);

      // Nothing matched: either this account does not own the project, or the
      // version moved on. The read distinguishes the two without guessing.
      await get(ownerId, projectId);
      throw new ApiError(
        409,
        "PROJECT_VERSION_CONFLICT",
        "This project changed since you read it. Reload it before saving again.",
      );
    },

    async listRevisions(ownerId: string, projectId: string, limit: number): Promise<ProjectRevisionSummary[]> {
      const query = new URLSearchParams({
        select: "revision,title,schema_version,created_at",
        project_id: `eq.${projectId}`,
        owner_id: `eq.${ownerId}`,
        order: "revision.desc",
        limit: String(limit),
      });
      const found = rows(
        await request(
          `${revisionsEndpoint}?${query}`,
          { headers: { ...authHeaders, Accept: "application/json" } },
          "the revision list",
        ),
      );
      return found.map(toRevision);
    },

    async remove(ownerId: string, projectId: string): Promise<void> {
      const query = new URLSearchParams({ id: `eq.${projectId}`, owner_id: `eq.${ownerId}` });
      const deleted = rows(
        await request(
          `${endpoint}?${query}`,
          {
            method: "DELETE",
            headers: { ...authHeaders, Accept: "application/json", Prefer: "return=representation" },
          },
          "the delete",
        ),
      );
      if (deleted.length === 0) throw new ApiError(404, "PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_MESSAGE);
    },
  };
}
