import { randomUUID } from "node:crypto";
import type {
  MediaKind,
  MediaProvenance,
  MediaRecord,
  MediaRefKind,
  MediaReferenceRecord,
  MediaStatus,
} from "../shared/media-contract";
import { ApiError } from "./api-error";
import type { R2Client } from "./r2";

/**
 * Phase 3: private media.
 *
 * A media row is created before an upload starts, so the object key is a stable
 * server-generated address (`media/<owner-id>/<media-id>`). Ownership is never
 * derived from the key; every query carries the verified owner id. The browser
 * uploads and plays back through short-lived presigned URLs, so the R2 secret
 * never leaves this process.
 *
 * A presigned URL is a capability for one object for a few minutes. It is not a
 * media id: callers store the media id and request a fresh URL when it expires,
 * which also keeps a URL usable through a queued render only as long as its TTL.
 */

export const MEDIA_KINDS: readonly MediaKind[] = ["image", "audio", "video"];
export const MEDIA_REF_KINDS: readonly MediaRefKind[] = ["scene", "render", "document", "other"];
/** One message for "missing" and "not yours" alike, so the two do not differ. */
export const MEDIA_NOT_FOUND_MESSAGE = "No media with that id is owned by this account.";

/** Content types accepted for each kind. The declared type is only a claim. */
const ALLOWED_CONTENT_TYPES: Record<MediaKind, readonly string[]> = {
  image: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  audio: ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/mp4", "audio/aac"],
  video: ["video/mp4", "video/webm", "video/quicktime"],
};

export interface MediaLimits {
  /** JSON body bound for upload/reference requests. */
  bodyBytes: number;
  imageBytes: number;
  audioBytes: number;
  videoBytes: number;
  /** Total pending + ready bytes one account may hold. */
  ownerStorageBytes: number;
  uploadUrlSeconds: number;
  downloadUrlSeconds: number;
  /** How long an initiated upload may stay uncompleted. */
  uploadTtlMs: number;
  /** How long a deleted or expired row is kept before its object is removed. */
  deletedRetentionMs: number;
  /** How long an unreferenced ready asset may stay before cleanup. */
  unreferencedRetentionMs: number;
  sniffBytes: number;
  sweepBatch: number;
  sweepIntervalMs: number;
  listLimit: number;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function loadMediaLimits(env: NodeJS.ProcessEnv): MediaLimits {
  const imageBytes = intEnv(env, "MEDIA_IMAGE_MAX_BYTES", 10 * 1024 * 1024, 1024, 100 * 1024 * 1024);
  return {
    bodyBytes: 8 * 1024,
    imageBytes,
    audioBytes: intEnv(env, "MEDIA_AUDIO_MAX_BYTES", 25 * 1024 * 1024, 1024, 200 * 1024 * 1024),
    videoBytes: intEnv(env, "MEDIA_VIDEO_MAX_BYTES", 200 * 1024 * 1024, 1024, 2 * 1024 * 1024 * 1024),
    ownerStorageBytes: intEnv(
      env,
      "MEDIA_OWNER_STORAGE_BYTES",
      2 * 1024 * 1024 * 1024,
      1024,
      50 * 1024 * 1024 * 1024,
    ),
    uploadUrlSeconds: intEnv(env, "MEDIA_UPLOAD_URL_SECONDS", 900, 60, 3600),
    downloadUrlSeconds: intEnv(env, "MEDIA_DOWNLOAD_URL_SECONDS", 300, 30, 3600),
    uploadTtlMs: intEnv(env, "MEDIA_UPLOAD_TTL_MS", 15 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
    deletedRetentionMs: intEnv(env, "MEDIA_DELETED_RETENTION_MS", 24 * 60 * 60 * 1000, 0, 30 * 24 * 60 * 60 * 1000),
    unreferencedRetentionMs: intEnv(
      env,
      "MEDIA_UNREFERENCED_RETENTION_MS",
      7 * 24 * 60 * 60 * 1000,
      0,
      90 * 24 * 60 * 60 * 1000,
    ),
    sniffBytes: 512,
    sweepBatch: 25,
    sweepIntervalMs: intEnv(env, "MEDIA_SWEEP_INTERVAL_MS", 60_000, 0, 60 * 60 * 1000),
    listLimit: 100,
  };
}

export function limitForKind(limits: MediaLimits, kind: MediaKind): number {
  if (kind === "image") return limits.imageBytes;
  if (kind === "audio") return limits.audioBytes;
  return limits.videoBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBody(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new ApiError(400, "INVALID_MEDIA_REQUEST", "Request body must be a JSON object.");
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new ApiError(400, "UNEXPECTED_FIELD", `Request body may only contain ${allowed.join(", ")}.`);
    }
  }
  return input;
}

export interface MediaInitiate {
  kind: MediaKind;
  contentType: string;
  byteSize: number;
  sceneKey: string | null;
}

export function parseMediaInitiate(input: unknown, limits: MediaLimits): MediaInitiate {
  const record = readBody(input, ["kind", "contentType", "byteSize", "sceneKey"]);
  if (typeof record.kind !== "string" || !MEDIA_KINDS.includes(record.kind as MediaKind)) {
    throw new ApiError(400, "INVALID_MEDIA", `kind must be one of ${MEDIA_KINDS.join(", ")}.`);
  }
  const kind = record.kind as MediaKind;

  if (typeof record.contentType !== "string") {
    throw new ApiError(400, "INVALID_MEDIA", "contentType must be a string.");
  }
  const contentType = record.contentType.trim().toLowerCase().split(";")[0].trim();
  if (!ALLOWED_CONTENT_TYPES[kind].includes(contentType)) {
    throw new ApiError(
      400,
      "INVALID_MEDIA",
      `contentType for ${kind} must be one of ${ALLOWED_CONTENT_TYPES[kind].join(", ")}.`,
    );
  }

  const byteSize = record.byteSize;
  if (typeof byteSize !== "number" || !Number.isInteger(byteSize) || byteSize <= 0) {
    throw new ApiError(400, "INVALID_MEDIA", "byteSize must be a positive integer.");
  }
  const limit = limitForKind(limits, kind);
  if (byteSize > limit) {
    throw new ApiError(413, "MEDIA_TOO_LARGE", `${kind} uploads are limited to ${limit} bytes.`);
  }

  let sceneKey: string | null = null;
  if (record.sceneKey !== undefined && record.sceneKey !== null) {
    if (typeof record.sceneKey !== "string") {
      throw new ApiError(400, "INVALID_MEDIA", "sceneKey must be a string.");
    }
    sceneKey = record.sceneKey.trim();
    if (sceneKey.length === 0 || sceneKey.length > 64) {
      throw new ApiError(400, "INVALID_MEDIA", "sceneKey must be 1-64 characters.");
    }
  }

  return { kind, contentType, byteSize, sceneKey };
}

export interface MediaReferenceWrite {
  refKind: MediaRefKind;
  refId: string;
}

export function parseMediaReferenceWrite(input: unknown): MediaReferenceWrite {
  const record = readBody(input, ["refKind", "refId"]);
  if (typeof record.refKind !== "string" || !MEDIA_REF_KINDS.includes(record.refKind as MediaRefKind)) {
    throw new ApiError(400, "INVALID_MEDIA_REFERENCE", `refKind must be one of ${MEDIA_REF_KINDS.join(", ")}.`);
  }
  if (typeof record.refId !== "string") {
    throw new ApiError(400, "INVALID_MEDIA_REFERENCE", "refId must be a string.");
  }
  const refId = record.refId.trim();
  if (refId.length === 0 || refId.length > 128) {
    throw new ApiError(400, "INVALID_MEDIA_REFERENCE", "refId must be 1-128 characters.");
  }
  return { refKind: record.refKind as MediaRefKind, refId };
}

// ---- Actual type detection --------------------------------------------------

/**
 * Reads the leading bytes and reports the media type the file really is. This is
 * what makes the declared Content-Type a claim rather than a fact.
 */
export function detectMediaType(bytes: Buffer): { kind: MediaKind; contentType: string } | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: "image", contentType: "image/jpeg" };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: "image", contentType: "image/png" };
  }
  if (bytes.length >= 6) {
    const header = bytes.subarray(0, 6).toString("latin1");
    if (header === "GIF87a" || header === "GIF89a") return { kind: "image", contentType: "image/gif" };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF") {
    const format = bytes.subarray(8, 12).toString("latin1");
    if (format === "WEBP") return { kind: "image", contentType: "image/webp" };
    if (format === "WAVE") return { kind: "audio", contentType: "audio/wav" };
  }
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString("latin1") === "ID3") {
    return { kind: "audio", contentType: "audio/mpeg" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    // MPEG audio frame sync, or ADTS AAC when the layer bits are zero.
    return (bytes[1] & 0x06) === 0
      ? { kind: "audio", contentType: "audio/aac" }
      : { kind: "audio", contentType: "audio/mpeg" };
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("latin1") === "OggS") {
    return { kind: "audio", contentType: "audio/ogg" };
  }
  if (bytes.length >= 8 && bytes.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("latin1").trim();
    if (brand === "qt") return { kind: "video", contentType: "video/quicktime" };
    if (brand.startsWith("M4A") || brand.startsWith("M4B")) return { kind: "audio", contentType: "audio/mp4" };
    return { kind: "video", contentType: "video/mp4" };
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return { kind: "video", contentType: "video/webm" };
  }
  return null;
}

export function mediaTypeMatches(kind: MediaKind, detected: { kind: MediaKind; contentType: string } | null): boolean {
  if (!detected || detected.kind !== kind) return false;
  return ALLOWED_CONTENT_TYPES[kind].includes(detected.contentType);
}

/** Every media object lives under this prefix, which is also what the audit lists. */
export const MEDIA_OBJECT_PREFIX = "media/";

/** The object key is generated here: stable, private, and never an authorization token. */
export function mediaObjectKey(ownerId: string, mediaId: string): string {
  return `${MEDIA_OBJECT_PREFIX}${ownerId}/${mediaId}`;
}

const MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Media ids are UUIDs; rejecting other shapes avoids a pointless store query. */
export function isMediaId(value: string): boolean {
  return MEDIA_ID_PATTERN.test(value);
}

export function newMediaId(): string {
  return randomUUID();
}

// ---- Store ------------------------------------------------------------------

export interface StoredObjectRow {
  id: string;
  ownerId: string;
  projectId: string;
  objectKey: string;
  sceneKey: string | null;
}

/** A row as the bucket audit sees it: the address plus its lifecycle status. */
export interface MediaAuditRow extends StoredObjectRow {
  status: MediaStatus;
}

/** The saved-document lookup the retention sweep needs before deleting an asset. */
export interface ProjectDocumentLookup {
  get(ownerId: string, projectId: string): Promise<{ document: { scenes: { assetIds: string[] }[] } }>;
}

export interface StoredMedia {
  /** Public shape: the private object key is deliberately not part of it. */
  media: MediaRecord;
  objectKey: string;
}

export interface MediaStore {
  createPending(
    ownerId: string,
    projectId: string,
    write: {
      id: string;
      kind: MediaKind;
      contentType: string;
      byteSize: number;
      sceneKey: string | null;
      objectKey: string;
      uploadExpiresAt: string;
      /** Present for assets imported from a stock provider. */
      provenance?: MediaProvenance | null;
    },
  ): Promise<MediaRecord>;
  get(ownerId: string, projectId: string, mediaId: string): Promise<StoredMedia | null>;
  /** Ready media in this project imported from the same provider, asset, and rendition. */
  findImported(
    ownerId: string,
    projectId: string,
    match: Pick<MediaProvenance, "provider" | "providerId" | "rendition">,
  ): Promise<StoredMedia | null>;
  list(ownerId: string, projectId: string, limit: number): Promise<MediaRecord[]>;
  /** Object keys for a project, read before its rows cascade away. */
  listObjectKeys(ownerId: string, projectId: string): Promise<string[]>;
  markReady(
    ownerId: string,
    projectId: string,
    mediaId: string,
    update: { contentType: string; byteSize: number },
  ): Promise<MediaRecord | null>;
  markDeleted(ownerId: string, projectId: string, mediaId: string): Promise<boolean>;
  removeRow(id: string): Promise<void>;
  /** Ids among mediaIds that are ready in this owner's project. */
  readyAssetIds(ownerId: string, projectId: string, mediaIds: string[]): Promise<Set<string>>;

  listReferences(ownerId: string, projectId: string, mediaId: string): Promise<MediaReferenceRecord[]>;
  addReference(
    ownerId: string,
    projectId: string,
    mediaId: string,
    write: MediaReferenceWrite,
  ): Promise<MediaReferenceRecord>;
  removeReference(ownerId: string, projectId: string, mediaId: string, referenceId: string): Promise<boolean>;
  referenceCounts(ownerId: string, mediaIds: string[]): Promise<Map<string, number>>;

  usedBytes(ownerId: string): Promise<number>;
  stalePending(nowIso: string, limit: number): Promise<StoredObjectRow[]>;
  expiredDeleted(cutoffIso: string, limit: number): Promise<StoredObjectRow[]>;
  /** Ready assets older than the cutoff, ordered by id; afterId pages the scan. */
  unreferencedReady(cutoffIso: string, limit: number, afterId?: string): Promise<StoredObjectRow[]>;
  /** Every row, ordered by id; afterId pages the bucket audit. */
  listStoredObjects(limit: number, afterId?: string): Promise<MediaAuditRow[]>;
}

// object_key stays server-side: it is selected for storage operations but omitted
// from the public MediaRecord shape.
const MEDIA_COLUMNS =
  "id,kind,status,scene_key,content_type,byte_size,object_key,upload_expires_at,ready_at,deleted_at,created_at,provenance";
const REFERENCE_COLUMNS = "id,media_id,ref_kind,ref_id,created_at";
const STORED_OBJECT_COLUMNS = "id,owner_id,project_id,object_key,scene_key";

function corrupt(field: string): never {
  throw new ApiError(503, "MEDIA_STORE_CORRUPT", `The media store returned a malformed row (${field}).`);
}

function rowText(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  return typeof value === "string" ? value : corrupt(name);
}

function rowNullableText(row: Record<string, unknown>, name: string): string | null {
  const value = row[name];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : corrupt(name);
}

/** A missing or malformed provenance is surfaced, never silently dropped. */
function toProvenance(row: Record<string, unknown>): MediaProvenance | null {
  const value = row.provenance;
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) corrupt("provenance");
  const provider = value.provider;
  const type = value.type;
  if (value.source !== "stock") corrupt("provenance.source");
  if (provider !== "pexels" && provider !== "pixabay") corrupt("provenance.provider");
  if (type !== "image" && type !== "video") corrupt("provenance.type");
  for (const field of ["providerId", "rendition", "renditionUrl", "sourcePage", "creator", "attribution", "license", "downloadedAt"] as const) {
    if (typeof value[field] !== "string") corrupt(`provenance.${field}`);
  }
  if (typeof value.byteSize !== "number" || !Number.isFinite(value.byteSize)) corrupt("provenance.byteSize");
  return value as unknown as MediaProvenance;
}

function toMedia(row: Record<string, unknown>, referenceCount: number): MediaRecord {
  const kind = row.kind;
  const status = row.status;
  const byteSize = row.byte_size;
  if (!MEDIA_KINDS.includes(kind as MediaKind)) corrupt("kind");
  if (!["pending", "ready", "deleted"].includes(String(status))) corrupt("status");
  if (typeof byteSize !== "number" || !Number.isFinite(byteSize)) corrupt("byte_size");
  return {
    id: rowText(row, "id"),
    kind: kind as MediaKind,
    status: status as MediaStatus,
    sceneKey: rowNullableText(row, "scene_key"),
    contentType: rowText(row, "content_type"),
    byteSize,
    uploadExpiresAt: rowNullableText(row, "upload_expires_at"),
    readyAt: rowNullableText(row, "ready_at"),
    deletedAt: rowNullableText(row, "deleted_at"),
    createdAt: rowText(row, "created_at"),
    referenceCount,
    provenance: toProvenance(row),
  };
}

function toStoredObjectRow(row: Record<string, unknown>): StoredObjectRow {
  return {
    id: rowText(row, "id"),
    ownerId: rowText(row, "owner_id"),
    projectId: rowText(row, "project_id"),
    objectKey: rowText(row, "object_key"),
    sceneKey: rowNullableText(row, "scene_key"),
  };
}

function toAuditRow(row: Record<string, unknown>): MediaAuditRow {
  const status = row.status;
  if (!["pending", "ready", "deleted"].includes(String(status))) corrupt("status");
  return { ...toStoredObjectRow(row), status: status as MediaStatus };
}

function toReference(row: Record<string, unknown>): MediaReferenceRecord {
  const refKind = row.ref_kind;
  if (!MEDIA_REF_KINDS.includes(refKind as MediaRefKind)) corrupt("ref_kind");
  return {
    id: rowText(row, "id"),
    refKind: refKind as MediaRefKind,
    refId: rowText(row, "ref_id"),
    createdAt: rowText(row, "created_at"),
  };
}

interface SupabaseMediaStoreOptions {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
}

export function createSupabaseMediaStore(options: SupabaseMediaStoreOptions): MediaStore {
  const base = `${options.url.replace(/\/+$/, "")}/rest/v1`;
  const authHeaders = {
    apikey: options.serviceRoleKey,
    Authorization: `Bearer ${options.serviceRoleKey}`,
  };
  const readHeaders = { ...authHeaders, Accept: "application/json" };
  const jsonHeaders = { ...authHeaders, "Content-Type": "application/json", Accept: "application/json" };
  const writeHeaders = { ...jsonHeaders, Prefer: "return=representation" };

  async function request(target: string, init: RequestInit, action: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(target, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch {
      throw new ApiError(503, "MEDIA_STORE_UNAVAILABLE", "The media store is unreachable.");
    }
    if (response.status === 409) {
      // PostgREST reports a unique violation as 409 with PostgreSQL's code. The
      // import route uses this to reuse the row that won the race.
      const detail = await response.json().catch(() => null);
      const code = isRecord(detail) && typeof detail.code === "string" ? detail.code : null;
      if (code === "23505") {
        throw new ApiError(409, "MEDIA_STORE_CONFLICT", `The media store rejected ${action} as a duplicate.`);
      }
    }
    if (!response.ok) {
      throw new ApiError(
        503,
        "MEDIA_STORE_UNAVAILABLE",
        `The media store rejected ${action} (HTTP ${response.status}).`,
      );
    }
    return response.json().catch(() => null);
  }

  function rows(payload: unknown): Record<string, unknown>[] {
    if (!Array.isArray(payload)) {
      throw new ApiError(503, "MEDIA_STORE_UNAVAILABLE", "The media store returned an unreadable response.");
    }
    return payload.map((row) => (isRecord(row) ? row : {}));
  }

  function tableUrl(table: string, query: Record<string, string> = {}): string {
    return `${base}/${table}?${new URLSearchParams(query)}`;
  }

  async function referenceCounts(ownerId: string, mediaIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (mediaIds.length === 0) return counts;
    const found = rows(
      await request(
        tableUrl("media_references", {
          select: "media_id",
          owner_id: `eq.${ownerId}`,
          media_id: `in.(${mediaIds.join(",")})`,
          limit: "1000",
        }),
        { headers: readHeaders },
        "the reference count",
      ),
    );
    for (const row of found) {
      const id = rowText(row, "media_id");
      if (!mediaIds.includes(id)) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }

  async function get(ownerId: string, projectId: string, mediaId: string): Promise<StoredMedia | null> {
    const found = rows(
      await request(
        tableUrl("media_metadata", {
          select: MEDIA_COLUMNS,
          id: `eq.${mediaId}`,
          project_id: `eq.${projectId}`,
          owner_id: `eq.${ownerId}`,
          limit: "1",
        }),
        { headers: readHeaders },
        "the media read",
      ),
    );
    if (found.length === 0) return null;
    const counts = await referenceCounts(ownerId, [mediaId]);
    return { media: toMedia(found[0], counts.get(mediaId) ?? 0), objectKey: rowText(found[0], "object_key") };
  }

  /**
   * Exact-match lookup for an already imported stock rendition. Only ready rows
   * count: a pending interrupted import, or a deleted one, must not be reused.
   */
  async function findImported(
    ownerId: string,
    projectId: string,
    match: Pick<MediaProvenance, "provider" | "providerId" | "rendition">,
  ): Promise<StoredMedia | null> {
    const found = rows(
      await request(
        tableUrl("media_metadata", {
          select: MEDIA_COLUMNS,
          owner_id: `eq.${ownerId}`,
          project_id: `eq.${projectId}`,
          status: "eq.ready",
          "provenance->>provider": `eq.${match.provider}`,
          "provenance->>providerId": `eq.${match.providerId}`,
          "provenance->>rendition": `eq.${match.rendition}`,
          order: "created_at.asc",
          limit: "1",
        }),
        { headers: readHeaders },
        "the imported media lookup",
      ),
    );
    const row = found[0];
    if (!row) return null;
    const id = rowText(row, "id");
    const counts = await referenceCounts(ownerId, [id]);
    return { media: toMedia(row, counts.get(id) ?? 0), objectKey: rowText(row, "object_key") };
  }

  async function listReferences(
    ownerId: string,
    projectId: string,
    mediaId: string,
  ): Promise<MediaReferenceRecord[]> {
    const found = rows(
      await request(
        tableUrl("media_references", {
          select: REFERENCE_COLUMNS,
          media_id: `eq.${mediaId}`,
          project_id: `eq.${projectId}`,
          owner_id: `eq.${ownerId}`,
          order: "created_at.asc",
          limit: "100",
        }),
        { headers: readHeaders },
        "the media reference list",
      ),
    );
    return found.map(toReference);
  }

  async function findReference(
    ownerId: string,
    projectId: string,
    mediaId: string,
    write: MediaReferenceWrite,
  ): Promise<MediaReferenceRecord | null> {
    const found = rows(
      await request(
        tableUrl("media_references", {
          select: REFERENCE_COLUMNS,
          media_id: `eq.${mediaId}`,
          project_id: `eq.${projectId}`,
          owner_id: `eq.${ownerId}`,
          ref_kind: `eq.${write.refKind}`,
          ref_id: `eq.${write.refId}`,
          limit: "1",
        }),
        { headers: readHeaders },
        "the media reference read",
      ),
    );
    return found.length === 0 ? null : toReference(found[0]);
  }

  return {
    async createPending(ownerId, projectId, write) {
      const created = rows(
        await request(
          tableUrl("media_metadata"),
          {
            method: "POST",
            headers: writeHeaders,
            body: JSON.stringify({
              id: write.id,
              owner_id: ownerId,
              project_id: projectId,
              scene_key: write.sceneKey,
              kind: write.kind,
              object_key: write.objectKey,
              content_type: write.contentType,
              byte_size: write.byteSize,
              status: "pending",
              upload_expires_at: write.uploadExpiresAt,
              provenance: write.provenance ?? null,
            }),
          },
          "the media reservation",
        ),
      );
      if (created.length === 0) {
        throw new ApiError(503, "MEDIA_STORE_UNAVAILABLE", "The media store did not confirm the upload.");
      }
      return toMedia(created[0], 0);
    },

    get,
    findImported,
    listReferences,
    referenceCounts,

    async list(ownerId, projectId, limit) {
      const found = rows(
        await request(
          tableUrl("media_metadata", {
            select: MEDIA_COLUMNS,
            owner_id: `eq.${ownerId}`,
            project_id: `eq.${projectId}`,
            order: "created_at.desc",
            limit: String(limit),
          }),
          { headers: readHeaders },
          "the media list",
        ),
      );
      const counts = await referenceCounts(
        ownerId,
        found.map((row) => rowText(row, "id")),
      );
      return found.map((row) => toMedia(row, counts.get(rowText(row, "id")) ?? 0));
    },

    async readyAssetIds(ownerId, projectId, mediaIds) {
      const ready = new Set<string>();
      const unique = [...new Set(mediaIds)];
      // Keep each filter URL bounded; a document can hold up to 1000 ids.
      for (let index = 0; index < unique.length; index += 100) {
        const chunk = unique.slice(index, index + 100);
        const found = rows(
          await request(
            tableUrl("media_metadata", {
              select: "id",
              id: `in.(${chunk.join(",")})`,
              project_id: `eq.${projectId}`,
              owner_id: `eq.${ownerId}`,
              status: "eq.ready",
              limit: String(chunk.length),
            }),
            { headers: readHeaders },
            "the ready asset list",
          ),
        );
        for (const row of found) ready.add(rowText(row, "id"));
      }
      return ready;
    },

    async listObjectKeys(ownerId, projectId) {
      // PostgREST caps a page, so a single read would silently leave every
      // object past the cap behind when the project rows cascade. Page through
      // by primary key until a short page proves the list is complete.
      const pageSize = 200;
      const keys: string[] = [];
      for (let offset = 0; offset < 100_000; offset += pageSize) {
        const found = rows(
          await request(
            tableUrl("media_metadata", {
              select: "object_key",
              owner_id: `eq.${ownerId}`,
              project_id: `eq.${projectId}`,
              order: "id.asc",
              limit: String(pageSize),
              offset: String(offset),
            }),
            { headers: readHeaders },
            "the project object list",
          ),
        );
        for (const row of found) keys.push(rowText(row, "object_key"));
        if (found.length < pageSize) break;
      }
      return keys;
    },

    async markReady(ownerId, projectId, mediaId, update) {
      const updated = rows(
        await request(
          tableUrl("media_metadata", {
            id: `eq.${mediaId}`,
            project_id: `eq.${projectId}`,
            owner_id: `eq.${ownerId}`,
            status: "eq.pending",
          }),
          {
            method: "PATCH",
            headers: writeHeaders,
            body: JSON.stringify({
              status: "ready",
              content_type: update.contentType,
              byte_size: update.byteSize,
              ready_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
          },
          "the media completion",
        ),
      );
      if (updated.length === 0) return null;
      const counts = await referenceCounts(ownerId, [mediaId]);
      return toMedia(updated[0], counts.get(mediaId) ?? 0);
    },

    async markDeleted(ownerId, projectId, mediaId) {
      const updated = rows(
        await request(
          tableUrl("media_metadata", {
            id: `eq.${mediaId}`,
            project_id: `eq.${projectId}`,
            owner_id: `eq.${ownerId}`,
            status: "in.(pending,ready)",
          }),
          {
            method: "PATCH",
            headers: writeHeaders,
            body: JSON.stringify({
              status: "deleted",
              deleted_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
          },
          "the media removal",
        ),
      );
      return updated.length > 0;
    },

    async removeRow(id) {
      await request(tableUrl("media_metadata", { id: `eq.${id}` }), { method: "DELETE", headers: readHeaders }, "the media row removal");
    },

    async addReference(ownerId, projectId, mediaId, write) {
      const existing = await findReference(ownerId, projectId, mediaId, write);
      if (existing) return existing;

      const created = rows(
        await request(
          tableUrl("media_references"),
          {
            method: "POST",
            headers: writeHeaders,
            body: JSON.stringify({
              owner_id: ownerId,
              project_id: projectId,
              media_id: mediaId,
              ref_kind: write.refKind,
              ref_id: write.refId,
            }),
          },
          "the media reference save",
        ),
      );
      if (created.length > 0) return toReference(created[0]);

      // A concurrent attach won the unique (media_id, ref_kind, ref_id) race.
      const raced = await findReference(ownerId, projectId, mediaId, write);
      if (raced) return raced;
      throw new ApiError(503, "MEDIA_STORE_UNAVAILABLE", "The media store did not confirm the reference.");
    },

    async removeReference(ownerId, projectId, mediaId, referenceId) {
      const removed = rows(
        await request(
          tableUrl("media_references", {
            id: `eq.${referenceId}`,
            media_id: `eq.${mediaId}`,
            project_id: `eq.${projectId}`,
            owner_id: `eq.${ownerId}`,
          }),
          { method: "DELETE", headers: { ...readHeaders, Prefer: "return=representation" } },
          "the media reference removal",
        ),
      );
      return removed.length > 0;
    },

    async usedBytes(ownerId) {
      const found = rows(
        await request(
          tableUrl("media_metadata", {
            select: "byte_size",
            owner_id: `eq.${ownerId}`,
            status: "in.(pending,ready)",
            limit: "2000",
          }),
          { headers: readHeaders },
          "the storage total",
        ),
      );
      let total = 0;
      for (const row of found) {
        const size = row.byte_size;
        if (typeof size === "number" && Number.isFinite(size)) total += size;
      }
      return total;
    },

    async stalePending(nowIso, limit) {
      const found = rows(
        await request(
          tableUrl("media_metadata", {
            select: STORED_OBJECT_COLUMNS,
            status: "eq.pending",
            upload_expires_at: `lt.${nowIso}`,
            limit: String(limit),
          }),
          { headers: readHeaders },
          "the expired upload list",
        ),
      );
      return found.map(toStoredObjectRow);
    },

    async expiredDeleted(cutoffIso, limit) {
      const found = rows(
        await request(
          tableUrl("media_metadata", {
            select: STORED_OBJECT_COLUMNS,
            status: "eq.deleted",
            deleted_at: `lt.${cutoffIso}`,
            limit: String(limit),
          }),
          { headers: readHeaders },
          "the deleted media list",
        ),
      );
      return found.map(toStoredObjectRow);
    },

    async listStoredObjects(limit, afterId) {
      const query: Record<string, string> = {
        select: `${STORED_OBJECT_COLUMNS},status`,
        order: "id.asc",
        limit: String(limit),
      };
      if (afterId !== undefined) query.id = `gt.${afterId}`;
      const found = rows(
        await request(tableUrl("media_metadata", query), { headers: readHeaders }, "the media audit list"),
      );
      return found.map(toAuditRow);
    },

    async unreferencedReady(cutoffIso, limit, afterId) {
      const query: Record<string, string> = {
        select: STORED_OBJECT_COLUMNS,
        status: "eq.ready",
        created_at: `lt.${cutoffIso}`,
        order: "id.asc",
        limit: String(limit),
      };
      // Keyset paging: protected rows stay in the table, so an offset would
      // shift and either skip or repeat candidates between pages.
      if (afterId !== undefined) query.id = `gt.${afterId}`;
      const found = rows(
        await request(tableUrl("media_metadata", query), { headers: readHeaders }, "the unreferenced media list"),
      );
      return found.map(toStoredObjectRow);
    },
  };
}

// ---- Retention --------------------------------------------------------------

export interface SweepOptions {
  store: MediaStore;
  objects: R2Client;
  /** Saved documents are checked so an asset they list is never retained away. */
  projects: ProjectDocumentLookup;
  limits: MediaLimits;
  now?: () => number;
  logger?: { error(message: string): void };
}

/**
 * Bounded, best-effort cleanup. Each pass removes at most one batch:
 * - pending uploads past their window (interrupted uploads),
 * - deleted rows past the retention window,
 * - ready assets nobody references past the unreferenced window.
 * The database row is removed only after the object removal is attempted, so a
 * bucket hiccup leaves the row for the next pass instead of orphaning the object.
 */
export async function sweepMedia(options: SweepOptions): Promise<void> {
  const now = options.now ?? (() => Date.now());
  const log = options.logger ?? console;

  async function removeObject(key: string): Promise<boolean> {
    try {
      await options.objects.delete(key);
      return true;
    } catch {
      log.error("[media] R2_DELETE_FAILED");
      return false;
    }
  }

  const pending = await options.store.stalePending(new Date(now()).toISOString(), options.limits.sweepBatch);
  for (const row of pending) {
    if (!(await removeObject(row.objectKey))) continue;
    await options.store.removeRow(row.id).catch(() => log.error("[media] MEDIA_ROW_DELETE_FAILED"));
  }

  const deletedCutoff = new Date(now() - options.limits.deletedRetentionMs).toISOString();
  const deleted = await options.store.expiredDeleted(deletedCutoff, options.limits.sweepBatch);
  for (const row of deleted) {
    if (!(await removeObject(row.objectKey))) continue;
    await options.store.removeRow(row.id).catch(() => log.error("[media] MEDIA_ROW_DELETE_FAILED"));
  }

  const unreferencedCutoff = new Date(now() - options.limits.unreferencedRetentionMs).toISOString();

  // A saved scene asset id is a link like a reference, even when no reference
  // row exists. Cache one document read per project for the pass; null means
  // the read failed, so that project's assets are skipped until the next pass.
  const documentIds = new Map<string, Set<string> | null>();
  async function savedAssetIds(row: StoredObjectRow): Promise<Set<string> | null> {
    const key = `${row.ownerId}\n${row.projectId}`;
    if (documentIds.has(key)) return documentIds.get(key) ?? null;
    try {
      const project = await options.projects.get(row.ownerId, row.projectId);
      const ids = new Set<string>();
      for (const scene of project.document.scenes) {
        for (const assetId of scene.assetIds) ids.add(assetId);
      }
      documentIds.set(key, ids);
      return ids;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // The project is already gone, so no saved document can still list it.
        const empty = new Set<string>();
        documentIds.set(key, empty);
        return empty;
      }
      log.error("[media] MEDIA_DOCUMENT_CHECK_FAILED");
      documentIds.set(key, null);
      return null;
    }
  }

  // Scan past protected rows instead of stopping at one page: a project can
  // have more document-listed assets than a batch, and those must not starve
  // other expired assets. Each page advances by id, and the pass stops after
  // one batch of removals or once the candidate list is exhausted.
  let afterId: string | null = null;
  let removed = 0;
  while (removed < options.limits.sweepBatch) {
    const page = await options.store.unreferencedReady(
      unreferencedCutoff,
      options.limits.sweepBatch,
      afterId ?? undefined,
    );
    if (page.length === 0) break;

    // Reference counts are owner-scoped, so group each page by owner.
    const byOwner = new Map<string, StoredObjectRow[]>();
    for (const row of page) {
      afterId = row.id;
      const group = byOwner.get(row.ownerId) ?? [];
      group.push(row);
      byOwner.set(row.ownerId, group);
    }

    for (const [ownerId, rows] of byOwner) {
      const counts = await options.store.referenceCounts(
        ownerId,
        rows.map((row) => row.id),
      );
      for (const row of rows) {
        if (removed >= options.limits.sweepBatch) break;
        if (row.sceneKey !== null) continue;
        if ((counts.get(row.id) ?? 0) > 0) continue;
        const listed = await savedAssetIds(row);
        if (listed === null || listed.has(row.id)) continue;
        if (!(await removeObject(row.objectKey))) continue;
        await options.store.removeRow(row.id).catch(() => log.error("[media] MEDIA_ROW_DELETE_FAILED"));
        removed += 1;
      }
    }

    if (page.length < options.limits.sweepBatch) break;
  }
}
