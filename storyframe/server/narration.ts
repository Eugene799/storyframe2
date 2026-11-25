import { createHash } from "node:crypto";
import { parseBuffer } from "music-metadata";
import type { ProjectDocumentV2 } from "../shared/project-contract";
import type {
  AudioSettingsInput,
  NarrationKind,
  NarrationScriptState,
  NarrationSource,
  NarrationStatus,
  NarrationTrack,
  NarrationVoice,
} from "../shared/narration-contract";
import { NARRATION_MAX_CHARS } from "../shared/narration-contract";
import { ApiError } from "./api-error";
import { isMediaId } from "./media";

/**
 * Phase 8: narration belongs to the approved script, not to a moving draft.
 *
 * The fingerprint covers the ordered scene ids, script text, and approval
 * fingerprints. A later script edit therefore makes the existing audio stale
 * without regenerating it or pretending the old audio matches new words.
 */

export const NARRATION_VOICES: readonly NarrationVoice[] = [
  {
    model: "aura-2-thalia-en",
    name: "Thalia",
    gender: "feminine",
    accent: "American English",
    characteristics: "Clear, confident, energetic",
  },
  {
    model: "aura-2-andromeda-en",
    name: "Andromeda",
    gender: "feminine",
    accent: "American English",
    characteristics: "Casual, expressive, comfortable",
  },
  {
    model: "aura-2-helena-en",
    name: "Helena",
    gender: "feminine",
    accent: "American English",
    characteristics: "Caring, natural, friendly",
  },
  {
    model: "aura-2-apollo-en",
    name: "Apollo",
    gender: "masculine",
    accent: "American English",
    characteristics: "Confident, comfortable, casual",
  },
  {
    model: "aura-2-arcas-en",
    name: "Arcas",
    gender: "masculine",
    accent: "American English",
    characteristics: "Natural, smooth, clear",
  },
  {
    model: "aura-2-orpheus-en",
    name: "Orpheus",
    gender: "masculine",
    accent: "American English",
    characteristics: "Professional, clear, trustworthy",
  },
];

export function findNarrationVoice(model: string): NarrationVoice | null {
  return NARRATION_VOICES.find((voice) => voice.model === model) ?? null;
}

export interface BuiltScript extends NarrationScriptState {
  text: string;
}

/** The exact text and fingerprint a generation request would use. */
export function buildNarrationScript(document: ProjectDocumentV2): BuiltScript {
  const scenes = document.scenes;
  if (scenes.length === 0) {
    throw new ApiError(422, "NARRATION_EMPTY_SCRIPT", "Add at least one scene before generating narration.");
  }
  const unapproved = scenes.filter((scene) => !scene.approved || scene.approvedFingerprint === null);
  if (unapproved.length > 0) {
    throw new ApiError(
      409,
      "SCRIPT_NOT_APPROVED",
      "Generate narration only after every scene is approved, so the audio has a fixed script to belong to.",
    );
  }

  const text = scenes
    .map((scene) => scene.body.trim())
    .filter((body) => body.length > 0)
    .join("\n\n");
  if (text.length === 0) {
    throw new ApiError(422, "NARRATION_EMPTY_SCRIPT", "The approved script has no spoken lines.");
  }
  const characters = Array.from(text).length;
  if (characters > NARRATION_MAX_CHARS) {
    throw new ApiError(
      422,
      "NARRATION_SCRIPT_TOO_LONG",
      `Deepgram accepts at most ${NARRATION_MAX_CHARS} characters per request; this script has ${characters}.`,
    );
  }

  const fingerprint = createHash("sha256")
    .update(
      scenes
        .map((scene) => `${scene.id}\n${scene.body}\n${scene.approvedFingerprint ?? ""}`)
        .join("\n---\n"),
    )
    .digest("hex");
  const targetSeconds = Number(
    scenes.reduce((total, scene) => total + (Number.isFinite(scene.durationSeconds) ? scene.durationSeconds : 0), 0).toFixed(3),
  );

  return {
    text,
    fingerprint,
    characters,
    sceneCount: scenes.length,
    approved: true,
    targetSeconds,
  };
}

/** GET state reports why a script cannot be narrated instead of failing the read. */
export function readNarrationScript(document: ProjectDocumentV2): {
  script: NarrationScriptState | null;
  blocked: string | null;
} {
  try {
    const { text: _text, ...script } = buildNarrationScript(document);
    return { script, blocked: null };
  } catch (error) {
    if (error instanceof ApiError) return { script: null, blocked: error.message };
    throw error;
  }
}

export function parseNarrationGenerateInput(input: unknown): { voiceModel: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "INVALID_NARRATION_REQUEST", "Request body must be a JSON object.");
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "voiceModel") {
      throw new ApiError(400, "UNEXPECTED_FIELD", "Request body may only contain voiceModel.");
    }
  }
  if (typeof record.voiceModel !== "string" || !findNarrationVoice(record.voiceModel)) {
    throw new ApiError(400, "INVALID_VOICE", "Choose one of the listed Deepgram Aura-2 voices.");
  }
  return { voiceModel: record.voiceModel };
}

export function parseAudioAttachInput(input: unknown): { mediaId: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "INVALID_NARRATION_REQUEST", "Request body must be a JSON object.");
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "mediaId") {
      throw new ApiError(400, "UNEXPECTED_FIELD", "Request body may only contain mediaId.");
    }
  }
  if (typeof record.mediaId !== "string" || !isMediaId(record.mediaId)) {
    throw new ApiError(400, "INVALID_MEDIA", "mediaId must be a media UUID from this project.");
  }
  return { mediaId: record.mediaId };
}

export function parseAudioSettings(input: unknown): AudioSettingsInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "INVALID_AUDIO_SETTINGS", "Request body must be a JSON object.");
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "volume" && key !== "muted") {
      throw new ApiError(400, "UNEXPECTED_FIELD", "Request body may only contain volume and muted.");
    }
  }
  const patch: AudioSettingsInput = {};
  if (record.volume !== undefined) {
    if (typeof record.volume !== "number" || !Number.isFinite(record.volume) || record.volume < 0 || record.volume > 1) {
      throw new ApiError(400, "INVALID_AUDIO_SETTINGS", "volume must be a number from 0 to 1.");
    }
    patch.volume = record.volume;
  }
  if (record.muted !== undefined) {
    if (typeof record.muted !== "boolean") {
      throw new ApiError(400, "INVALID_AUDIO_SETTINGS", "muted must be a boolean.");
    }
    patch.muted = record.muted;
  }
  if (patch.volume === undefined && patch.muted === undefined) {
    throw new ApiError(400, "INVALID_AUDIO_SETTINGS", "Provide volume, muted, or both.");
  }
  return patch;
}

/** Real container duration; null when the bytes cannot be measured. */
export async function measureAudioDuration(bytes: Buffer, contentType: string): Promise<number | null> {
  try {
    const metadata = await parseBuffer(bytes, { mimeType: contentType, size: bytes.length }, { duration: true });
    const duration = metadata.format.duration;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return null;
    return Number(duration.toFixed(3));
  } catch {
    return null;
  }
}

// ---- Store ------------------------------------------------------------------

export interface NarrationTrackWrite {
  id: string;
  kind: NarrationKind;
  source: NarrationSource;
  mediaId: string;
  voiceModel: string | null;
  voiceName: string | null;
  scriptFingerprint: string | null;
  scriptCharacters: number | null;
  durationSeconds: number;
  costUsd: number | null;
  costRateVersion: string | null;
}

export interface NarrationCreateResult {
  track: NarrationTrack;
  /** Active tracks of the same kind that this write replaced. */
  replaced: NarrationTrack[];
}

export interface NarrationStore {
  active(ownerId: string, projectId: string): Promise<{ narration: NarrationTrack | null; music: NarrationTrack | null }>;
  create(ownerId: string, projectId: string, write: NarrationTrackWrite): Promise<NarrationCreateResult>;
  updateActive(
    ownerId: string,
    projectId: string,
    kind: NarrationKind,
    patch: AudioSettingsInput,
  ): Promise<NarrationTrack | null>;
  removeActive(ownerId: string, projectId: string, kind: NarrationKind): Promise<NarrationTrack | null>;
}

const NARRATION_COLUMNS =
  "id,kind,source,status,media_id,voice_model,voice_name,script_fingerprint,script_characters,duration_seconds,volume,muted,cost_usd,cost_rate_version,created_at";

const KINDS: readonly NarrationKind[] = ["narration", "music"];
const SOURCES: readonly NarrationSource[] = ["deepgram", "upload"];
const STATUSES: readonly NarrationStatus[] = ["active", "replaced", "removed"];

function corrupt(field: string): never {
  throw new ApiError(503, "NARRATION_STORE_CORRUPT", `The narration store returned a malformed row (${field}).`);
}

function text(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  return typeof value === "string" ? value : corrupt(name);
}

function nullableText(row: Record<string, unknown>, name: string): string | null {
  const value = row[name];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : corrupt(name);
}

function nullableNumber(row: Record<string, unknown>, name: string): number | null {
  const value = row[name];
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : corrupt(name);
}

function toTrack(row: Record<string, unknown>): NarrationTrack {
  const kind = row.kind;
  const source = row.source;
  const status = row.status;
  if (!KINDS.includes(kind as NarrationKind)) corrupt("kind");
  if (!SOURCES.includes(source as NarrationSource)) corrupt("source");
  if (!STATUSES.includes(status as NarrationStatus)) corrupt("status");
  const volume = nullableNumber(row, "volume");
  if (volume === null || volume < 0 || volume > 1) corrupt("volume");
  const muted = row.muted;
  if (typeof muted !== "boolean") corrupt("muted");
  return {
    id: text(row, "id"),
    kind: kind as NarrationKind,
    source: source as NarrationSource,
    status: status as NarrationStatus,
    mediaId: nullableText(row, "media_id"),
    voiceModel: nullableText(row, "voice_model"),
    voiceName: nullableText(row, "voice_name"),
    scriptFingerprint: nullableText(row, "script_fingerprint"),
    scriptCharacters: nullableNumber(row, "script_characters"),
    durationSeconds: nullableNumber(row, "duration_seconds"),
    volume,
    muted,
    costUsd: nullableNumber(row, "cost_usd"),
    costRateVersion: nullableText(row, "cost_rate_version"),
    createdAt: text(row, "created_at"),
  };
}

interface SupabaseNarrationStoreOptions {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
}

export function createSupabaseNarrationStore(options: SupabaseNarrationStoreOptions): NarrationStore {
  const base = `${options.url.replace(/\/+$/, "")}/rest/v1`;
  const authHeaders = {
    apikey: options.serviceRoleKey,
    Authorization: `Bearer ${options.serviceRoleKey}`,
  };
  const readHeaders = { ...authHeaders, Accept: "application/json" };
  const writeHeaders = {
    ...authHeaders,
    "Content-Type": "application/json",
    Accept: "application/json",
    Prefer: "return=representation",
  };

  async function request(target: string, init: RequestInit, action: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(target, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch {
      throw new ApiError(503, "NARRATION_STORE_UNAVAILABLE", "The narration store is unreachable.");
    }
    if (!response.ok) {
      throw new ApiError(
        503,
        "NARRATION_STORE_UNAVAILABLE",
        `The narration store rejected ${action} (HTTP ${response.status}).`,
      );
    }
    return response.json().catch(() => null);
  }

  function rows(payload: unknown): Record<string, unknown>[] {
    if (!Array.isArray(payload)) {
      throw new ApiError(503, "NARRATION_STORE_UNAVAILABLE", "The narration store returned an unreadable response.");
    }
    return payload.map((row) => (isRecord(row) ? row : {}));
  }

  function tableUrl(query: Record<string, string> = {}): string {
    return `${base}/narration_tracks?${new URLSearchParams(query)}`;
  }

  return {
    async active(ownerId, projectId) {
      const found = rows(
        await request(
          tableUrl({
            select: NARRATION_COLUMNS,
            owner_id: `eq.${ownerId}`,
            project_id: `eq.${projectId}`,
            status: "eq.active",
          }),
          { headers: readHeaders },
          "the active audio read",
        ),
      );
      const tracks = found.map(toTrack);
      return {
        narration: tracks.find((track) => track.kind === "narration") ?? null,
        music: tracks.find((track) => track.kind === "music") ?? null,
      };
    },

    async create(ownerId, projectId, write) {
      // The partial unique index allows one active row per kind, so the old
      // track is retired first. It stays as history with its own metadata.
      const replacedRows = rows(
        await request(
          tableUrl({
            owner_id: `eq.${ownerId}`,
            project_id: `eq.${projectId}`,
            kind: `eq.${write.kind}`,
            status: "eq.active",
          }),
          {
            method: "PATCH",
            headers: writeHeaders,
            body: JSON.stringify({ status: "replaced", updated_at: new Date().toISOString() }),
          },
          "the prior audio replacement",
        ),
      );
      const replaced = replacedRows.map(toTrack);
      const created = rows(
        await request(
          tableUrl(),
          {
            method: "POST",
            headers: writeHeaders,
            body: JSON.stringify({
              id: write.id,
              owner_id: ownerId,
              project_id: projectId,
              kind: write.kind,
              source: write.source,
              status: "active",
              media_id: write.mediaId,
              voice_model: write.voiceModel,
              voice_name: write.voiceName,
              script_fingerprint: write.scriptFingerprint,
              script_characters: write.scriptCharacters,
              duration_seconds: write.durationSeconds,
              volume: 1,
              muted: false,
              cost_usd: write.costUsd,
              cost_rate_version: write.costRateVersion,
            }),
          },
          "the new audio track",
        ),
      );
      if (created.length === 0) {
        throw new ApiError(503, "NARRATION_STORE_UNAVAILABLE", "The narration store did not confirm the track.");
      }
      return { track: toTrack(created[0]), replaced };
    },

    async updateActive(ownerId, projectId, kind, patch) {
      const updated = rows(
        await request(
          tableUrl({
            owner_id: `eq.${ownerId}`,
            project_id: `eq.${projectId}`,
            kind: `eq.${kind}`,
            status: "eq.active",
          }),
          {
            method: "PATCH",
            headers: writeHeaders,
            body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
          },
          "the audio settings",
        ),
      );
      return updated.length === 0 ? null : toTrack(updated[0]);
    },

    async removeActive(ownerId, projectId, kind) {
      const removed = rows(
        await request(
          tableUrl({
            owner_id: `eq.${ownerId}`,
            project_id: `eq.${projectId}`,
            kind: `eq.${kind}`,
            status: "eq.active",
          }),
          {
            method: "PATCH",
            headers: writeHeaders,
            body: JSON.stringify({ status: "removed", updated_at: new Date().toISOString() }),
          },
          "the audio removal",
        ),
      );
      return removed.length === 0 ? null : toTrack(removed[0]);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
