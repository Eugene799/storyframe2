import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { MediaProvenance } from "../shared/media-contract";
import {
  STOCK_PROVIDERS,
  STOCK_TYPES,
  type StockImportRequest,
  type StockProvider,
  type StockProviderStatus,
  type StockResult,
  type StockRendition,
  type StockSearchResponse,
  type StockType,
} from "../shared/stock-contract";
import { ApiError } from "./api-error";

/**
 * Phase 6: Pexels and Pixabay stock search.
 *
 * This module owns three things that must not leak into route code:
 * - normalization, so both providers produce one result shape with real
 *   rendition dimensions and a credit line,
 * - a durable shared page cache with a short claim lease, so a burst of
 *   identical searches makes one provider call (and Pixabay's 24-hour caching
 *   requirement is met across instances),
 * - a controlled download for imports: https only, provider-owned hosts, every
 *   redirect re-checked, private and internal addresses refused, and a hard
 *   byte bound.
 *
 * Provider API keys and URLs that contain them are never logged or returned.
 */

// ---- Configuration ---------------------------------------------------------

export interface StockLimits {
  pexelsKey: string | null;
  pixabayKey: string | null;
  timeoutMs: number;
  pageSize: number;
  maxPage: number;
  queryChars: number;
  pexelsCacheSeconds: number;
  /** Pixabay requires results to be cached for 24 hours; never configured lower. */
  pixabayCacheSeconds: number;
  cachePayloadBytes: number;
  cacheLeaseMs: number;
  cacheWaitMs: number;
  importImageBytes: number;
  importVideoBytes: number;
  importTimeoutMs: number;
  importRedirects: number;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function stringEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

export function loadStockLimits(
  env: NodeJS.ProcessEnv,
  media: { imageBytes: number; videoBytes: number },
): StockLimits {
  return {
    pexelsKey: stringEnv(env, "PEXELS_API_KEY"),
    pixabayKey: stringEnv(env, "PIXABAY_API_KEY"),
    timeoutMs: intEnv(env, "STOCK_PROVIDER_TIMEOUT_MS", 8000, 1000, 30000),
    pageSize: intEnv(env, "STOCK_PAGE_SIZE", 20, 3, 50),
    maxPage: intEnv(env, "STOCK_MAX_PAGE", 50, 1, 100),
    queryChars: intEnv(env, "STOCK_QUERY_MAX_CHARS", 80, 1, 200),
    pexelsCacheSeconds: intEnv(env, "STOCK_PEXELS_CACHE_SECONDS", 3600, 60, 24 * 60 * 60),
    pixabayCacheSeconds: Math.max(86_400, intEnv(env, "STOCK_PIXABAY_CACHE_SECONDS", 86_400, 86_400, 7 * 86_400)),
    cachePayloadBytes: intEnv(env, "STOCK_CACHE_PAYLOAD_BYTES", 256 * 1024, 1024, 2 * 1024 * 1024),
    cacheLeaseMs: intEnv(env, "STOCK_CACHE_LEASE_MS", 15000, 1000, 120000),
    cacheWaitMs: intEnv(env, "STOCK_CACHE_WAIT_MS", 2500, 0, 10000),
    importImageBytes: media.imageBytes,
    importVideoBytes: media.videoBytes,
    importTimeoutMs: intEnv(env, "STOCK_IMPORT_TIMEOUT_MS", 30000, 1000, 120000),
    importRedirects: intEnv(env, "STOCK_IMPORT_REDIRECTS", 3, 0, 5),
  };
}

// ---- Provider catalog ------------------------------------------------------

const PEXELS_BASE = "https://api.pexels.com";
const PIXABAY_BASE = "https://pixabay.com/api";

/** Only provider-owned asset hosts may be downloaded from. */
const PROVIDER_ASSET_HOSTS: Record<StockProvider, readonly string[]> = {
  pexels: ["images.pexels.com", "videos.pexels.com"],
  // Pixabay serves previews and videos from its CDN but web-format and original
  // images from the site host itself.
  pixabay: ["cdn.pixabay.com", "pixabay.com", "www.pixabay.com"],
};

/** Only provider-owned pages may be credited as the source page. */
const PROVIDER_SITE_HOSTS: Record<StockProvider, readonly string[]> = {
  pexels: ["www.pexels.com", "pexels.com"],
  pixabay: ["pixabay.com", "www.pixabay.com"],
};

const PROVIDER_NAMES: Record<StockProvider, string> = { pexels: "Pexels", pixabay: "Pixabay" };
const PROVIDER_LICENSES: Record<StockProvider, { license: string; url: string }> = {
  pexels: { license: "Pexels License", url: "https://www.pexels.com/license/" },
  pixabay: { license: "Pixabay Content License", url: "https://pixabay.com/service/license-summary/" },
};

const PLAYLIST_CONTENT_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "application/mpegurl",
  "application/dash+xml",
  "video/mp2t",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveDimension(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? Math.round(number) : null;
}

function text(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxChars);
}

/** http(s) URL or null; nothing else is ever rendered or fetched. */
function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
}

/**
 * A video file link that is really a playlist or segment stream: permissive MIME
 * metadata can label one `video/mp4`, so the URL is checked too.
 */
export function isPlaylistAsset(url: string, contentType: string | null = null): boolean {
  const type = contentType?.split(";")[0].trim().toLowerCase();
  if (type && PLAYLIST_CONTENT_TYPES.has(type)) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  const path = parsed.pathname.toLowerCase();
  if (/\.(m3u8|mpd|ts)$/.test(path)) return true;
  if (path.includes("/playlist")) return true;
  return false;
}

// ---- Search input ----------------------------------------------------------

export interface StockSearchInput {
  query: string;
  type: StockType;
  sources: StockProvider[];
  page: number;
}

/**
 * Sources are a list, so duplicates are collapsed and an empty or unknown list
 * is refused instead of silently searching nothing or everything.
 */
export function parseStockSearchInput(params: URLSearchParams, limits: StockLimits): StockSearchInput {
  const query = (params.get("q") ?? "").trim();
  if (query.length === 0) {
    throw new ApiError(400, "STOCK_QUERY_REQUIRED", "A search query is required.");
  }
  if (query.length > limits.queryChars) {
    throw new ApiError(400, "STOCK_QUERY_TOO_LONG", `The search query must be at most ${limits.queryChars} characters.`);
  }

  const type = params.get("type")?.trim() ?? "";
  if (!STOCK_TYPES.includes(type as StockType)) {
    throw new ApiError(400, "STOCK_TYPE_REQUIRED", `type must be one of ${STOCK_TYPES.join(", ")}.`);
  }

  const requested = params
    .getAll("sources")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  if (requested.length === 0) {
    throw new ApiError(400, "STOCK_SOURCES_REQUIRED", `sources must name at least one of ${STOCK_PROVIDERS.join(", ")}.`);
  }
  const unsupported = requested.find((value) => !STOCK_PROVIDERS.includes(value as StockProvider));
  if (unsupported !== undefined) {
    throw new ApiError(
      400,
      "STOCK_SOURCE_UNSUPPORTED",
      `Unsupported stock source "${unsupported.slice(0, 32)}". Use ${STOCK_PROVIDERS.join(" or ")}.`,
    );
  }
  const sources = [...new Set(requested)] as StockProvider[];

  const rawPage = params.get("page");
  let page = 1;
  if (rawPage !== null && rawPage.trim().length > 0) {
    const parsed = Number(rawPage);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > limits.maxPage) {
      throw new ApiError(400, "STOCK_PAGE_INVALID", `page must be an integer from 1 to ${limits.maxPage}.`);
    }
    page = parsed;
  }

  return { query, type: type as StockType, sources, page };
}

// ---- Normalization ---------------------------------------------------------

/**
 * Picks one video rendition by both dimensions and aspect ratio.
 *
 * A portrait file or a square crop is a different shot, so renditions whose
 * aspect drifts more than 2% from the source video are skipped. Among the rest,
 * the largest that fits the 1920×1080 box wins; if every file is larger, the
 * smallest is used rather than returning nothing.
 */
export function chooseVideoRendition(
  renditions: StockRendition[],
  sourceAspect: number | null,
  maxWidth = 1920,
  maxHeight = 1080,
): StockRendition | null {
  const usable = renditions.filter(
    (rendition) => rendition.width > 0 && rendition.height > 0 && !isPlaylistAsset(rendition.url, rendition.contentType),
  );
  if (usable.length === 0) return null;

  const aspect = sourceAspect !== null && Number.isFinite(sourceAspect) && sourceAspect > 0 ? sourceAspect : null;
  const sameAspect = aspect === null
    ? usable
    : usable.filter((rendition) => Math.abs(rendition.width / rendition.height - aspect) <= aspect * 0.02);
  const aspectPool = sameAspect.length > 0 ? sameAspect : usable;

  const fitting = aspectPool.filter(
    (rendition) => rendition.width <= maxWidth && rendition.height <= maxHeight,
  );
  const pool = fitting.length > 0 ? fitting : aspectPool;
  const byArea = pool.slice().sort((left, right) => left.width * left.height - right.width * right.height);
  return fitting.length > 0 ? (byArea[byArea.length - 1] ?? null) : (byArea[0] ?? null);
}

function rendition(
  label: string,
  url: unknown,
  width: unknown,
  height: unknown,
  contentType: string,
  byteSize: unknown = null,
  fps: unknown = null,
): StockRendition | null {
  const safeUrl = httpUrl(url);
  const parsedWidth = positiveDimension(width);
  const parsedHeight = positiveDimension(height);
  if (!safeUrl || parsedWidth === null || parsedHeight === null) return null;
  return {
    label: label.slice(0, 40),
    url: safeUrl,
    width: parsedWidth,
    height: parsedHeight,
    contentType,
    byteSize: finiteNumber(byteSize),
    fps: finiteNumber(fps),
  };
}

export function normalizePexelsPhoto(raw: unknown): StockResult | null {
  if (!isRecord(raw)) return null;
  const id = finiteNumber(raw.id);
  if (id === null) return null;
  const providerId = String(Math.trunc(id));
  const src = isRecord(raw.src) ? raw.src : {};
  const width = positiveDimension(raw.width);
  const height = positiveDimension(raw.height);

  const original = rendition("original", src.original, width, height, "image/jpeg");
  const renditions = original ? [original] : [];
  if (renditions.length === 0) return null;
  const selected = renditions[0];

  const creator = text(raw.photographer, 160) ?? "Unknown creator";
  const sourcePage = httpUrl(raw.url) ?? `https://www.pexels.com/photo/${providerId}/`;
  const previewUrl =
    httpUrl(src.large) ?? httpUrl(src.medium) ?? httpUrl(src.large2x) ?? httpUrl(src.original) ?? selected.url;
  const license = PROVIDER_LICENSES.pexels;

  return {
    provider: "pexels",
    providerName: PROVIDER_NAMES.pexels,
    providerId,
    type: "image",
    title: text(raw.alt, 200) ?? `Pexels photo ${providerId}`,
    previewUrl,
    renditions,
    selectedRendition: selected.label,
    sourcePage,
    creator,
    creatorUrl: httpUrl(raw.photographer_url),
    attribution: `Photo by ${creator} on Pexels`,
    license: license.license,
    licenseUrl: license.url,
    width: selected.width,
    height: selected.height,
    durationSeconds: null,
  };
}

export function normalizePexelsVideo(raw: unknown): StockResult | null {
  if (!isRecord(raw)) return null;
  const id = finiteNumber(raw.id);
  if (id === null) return null;
  const providerId = String(Math.trunc(id));
  const files = Array.isArray(raw.video_files) ? raw.video_files : [];
  const renditions: StockRendition[] = [];
  for (const file of files) {
    if (!isRecord(file)) continue;
    const contentType = text(file.file_type, 80) ?? "video/mp4";
    if (!contentType.toLowerCase().startsWith("video/")) continue;
    const link = httpUrl(file.link);
    if (!link || isPlaylistAsset(link, contentType)) continue;
    const entry = rendition(
      text(file.quality, 20) ?? text(file.id, 20) ?? `${positiveDimension(file.width) ?? 0}p`,
      link,
      file.width,
      file.height,
      contentType,
      file.size,
      file.fps,
    );
    if (entry) renditions.push(entry);
  }
  if (renditions.length === 0) return null;

  const sourceWidth = positiveDimension(raw.width);
  const sourceHeight = positiveDimension(raw.height);
  const sourceAspect = sourceWidth !== null && sourceHeight !== null ? sourceWidth / sourceHeight : null;
  const selected = chooseVideoRendition(renditions, sourceAspect);
  if (!selected) return null;

  const user = isRecord(raw.user) ? raw.user : {};
  const creator = text(user.name, 160) ?? "Unknown creator";
  const sourcePage = httpUrl(raw.url) ?? `https://www.pexels.com/video/${providerId}/`;
  const previewUrl = httpUrl(raw.image) ?? selected.url;
  const license = PROVIDER_LICENSES.pexels;

  return {
    provider: "pexels",
    providerName: PROVIDER_NAMES.pexels,
    providerId,
    type: "video",
    title: `Pexels video ${providerId}`,
    previewUrl,
    renditions,
    selectedRendition: selected.label,
    sourcePage,
    creator,
    creatorUrl: httpUrl(user.url),
    attribution: `Video by ${creator} on Pexels`,
    license: license.license,
    licenseUrl: license.url,
    width: selected.width,
    height: selected.height,
    durationSeconds: finiteNumber(raw.duration),
  };
}

export function normalizePixabayImage(raw: unknown): StockResult | null {
  if (!isRecord(raw)) return null;
  const id = finiteNumber(raw.id);
  if (id === null) return null;
  const providerId = String(Math.trunc(id));

  const renditions: StockRendition[] = [];
  const preview = rendition("preview", raw.previewURL, raw.previewWidth, raw.previewHeight, "image/jpeg");
  if (preview) renditions.push(preview);
  const webformat = rendition("webformat", raw.webformatURL, raw.webformatWidth, raw.webformatHeight, "image/jpeg");
  if (webformat) renditions.push(webformat);
  const original = rendition("original", raw.largeImageURL, raw.imageWidth, raw.imageHeight, "image/jpeg");
  if (original) renditions.push(original);
  const selected = original ?? webformat ?? preview;
  if (!selected) return null;

  // The largest known rendition keeps the most quality; the import route still
  // enforces the byte limit, so an oversized original is refused at download.
  const creator = text(raw.user, 160) ?? "Unknown creator";
  const sourcePage = httpUrl(raw.pageURL) ?? `https://pixabay.com/images/id-${providerId}/`;
  const license = PROVIDER_LICENSES.pixabay;

  return {
    provider: "pixabay",
    providerName: PROVIDER_NAMES.pixabay,
    providerId,
    type: "image",
    title: text(raw.tags, 200) ?? `Pixabay image ${providerId}`,
    previewUrl: httpUrl(raw.previewURL) ?? httpUrl(raw.webformatURL) ?? selected.url,
    renditions,
    selectedRendition: selected.label,
    sourcePage,
    creator,
    creatorUrl: null,
    attribution: `Image by ${creator} on Pixabay`,
    license: license.license,
    licenseUrl: license.url,
    width: selected.width,
    height: selected.height,
    durationSeconds: null,
  };
}

export function normalizePixabayVideo(raw: unknown): StockResult | null {
  if (!isRecord(raw)) return null;
  const id = finiteNumber(raw.id);
  if (id === null) return null;
  const providerId = String(Math.trunc(id));
  const videos = isRecord(raw.videos) ? raw.videos : {};

  const renditions: StockRendition[] = [];
  let previewUrl: string | null = null;
  for (const label of ["large", "medium", "small", "tiny"] as const) {
    const entry = videos[label];
    if (!isRecord(entry)) continue;
    // Pixabay supplies the video thumbnail; it is never constructed from an id.
    if (previewUrl === null) previewUrl = httpUrl(entry.thumbnail);
    const parsed = rendition(label, entry.url, entry.width, entry.height, "video/mp4", entry.size);
    if (parsed) renditions.push(parsed);
  }
  if (renditions.length === 0) return null;

  const largest = renditions.slice().sort((left, right) => right.width * right.height - left.width * left.height)[0];
  const selected = chooseVideoRendition(renditions, largest.width / largest.height);
  if (!selected) return null;

  const creator = text(raw.user, 160) ?? "Unknown creator";
  const sourcePage = httpUrl(raw.pageURL) ?? `https://pixabay.com/videos/id-${providerId}/`;
  const license = PROVIDER_LICENSES.pixabay;

  return {
    provider: "pixabay",
    providerName: PROVIDER_NAMES.pixabay,
    providerId,
    type: "video",
    title: text(raw.tags, 200) ?? `Pixabay video ${providerId}`,
    previewUrl: previewUrl ?? selected.url,
    renditions,
    selectedRendition: selected.label,
    sourcePage,
    creator,
    creatorUrl: null,
    attribution: `Video by ${creator} on Pixabay`,
    license: license.license,
    licenseUrl: license.url,
    width: selected.width,
    height: selected.height,
    durationSeconds: finiteNumber(raw.duration),
  };
}

// ---- Durable shared page cache --------------------------------------------

export interface StockCacheRow {
  status: "pending" | "ready";
  payload: unknown;
  leaseUntil: string | null;
  expiresAt: string;
}

export interface StockCacheStore {
  get(cacheKey: string): Promise<StockCacheRow | null>;
  /** Inserts a pending claim; false when another row already holds the key. */
  claim(input: {
    cacheKey: string;
    provider: StockProvider;
    query: string;
    type: StockType;
    page: number;
    expiresAt: string;
    leaseUntil: string;
  }): Promise<boolean>;
  /** Takes over a claim whose lease has expired; false when someone else won. */
  takeOver(cacheKey: string, leaseUntil: string): Promise<boolean>;
  save(cacheKey: string, leaseUntil: string, payload: unknown, expiresAt: string): Promise<boolean>;
  release(cacheKey: string): Promise<void>;
  /** Removes one expired row so the key can be claimed again. */
  purge(cacheKey: string): Promise<void>;
  prune(nowIso: string): Promise<void>;
}

interface SupabaseStockCacheOptions {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
}

export function createSupabaseStockCache(options: SupabaseStockCacheOptions): StockCacheStore {
  const base = `${options.url.replace(/\/+$/, "")}/rest/v1`;
  const authHeaders = {
    apikey: options.serviceRoleKey,
    Authorization: `Bearer ${options.serviceRoleKey}`,
  };
  const readHeaders = { ...authHeaders, Accept: "application/json" };
  const jsonHeaders = { ...authHeaders, "Content-Type": "application/json", Accept: "application/json" };
  const writeHeaders = { ...jsonHeaders, Prefer: "return=representation" };
  const ignoreDuplicatesHeaders = {
    ...jsonHeaders,
    Prefer: "resolution=ignore-duplicates,return=representation",
  };

  async function request(target: string, init: RequestInit, action: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(target, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch {
      throw new ApiError(503, "STOCK_CACHE_UNAVAILABLE", "The stock cache is unreachable.");
    }
    if (!response.ok) {
      throw new ApiError(503, "STOCK_CACHE_UNAVAILABLE", `The stock cache rejected ${action} (HTTP ${response.status}).`);
    }
    if (response.status === 204) return [];
    return response.json().catch(() => null);
  }

  function rows(payload: unknown): Record<string, unknown>[] {
    if (!Array.isArray(payload)) {
      throw new ApiError(503, "STOCK_CACHE_UNAVAILABLE", "The stock cache returned an unreadable response.");
    }
    return payload.filter(isRecord);
  }

  function tableUrl(query: Record<string, string> = {}): string {
    return `${base}/stock_search_cache?${new URLSearchParams(query)}`;
  }

  return {
    async get(cacheKey) {
      const found = rows(
        await request(
          tableUrl({
            select: "status,payload,lease_until,expires_at",
            cache_key: `eq.${cacheKey}`,
            limit: "1",
          }),
          { headers: readHeaders },
          "the cache read",
        ),
      );
      const row = found[0];
      if (!row) return null;
      const status = row.status === "ready" ? "ready" : "pending";
      return {
        status,
        payload: row.payload ?? null,
        leaseUntil: typeof row.lease_until === "string" ? row.lease_until : null,
        expiresAt: typeof row.expires_at === "string" ? row.expires_at : "",
      };
    },

    async claim(input) {
      const created = rows(
        await request(
          tableUrl(),
          {
            method: "POST",
            headers: ignoreDuplicatesHeaders,
            body: JSON.stringify({
              cache_key: input.cacheKey,
              provider: input.provider,
              query_text: input.query.slice(0, 200),
              media_type: input.type,
              page: input.page,
              status: "pending",
              payload: null,
              payload_bytes: 0,
              lease_until: input.leaseUntil,
              updated_at: new Date().toISOString(),
              expires_at: input.expiresAt,
            }),
          },
          "the cache claim",
        ),
      );
      return created.length > 0;
    },

    async takeOver(cacheKey, leaseUntil) {
      const taken = rows(
        await request(
          tableUrl({
            cache_key: `eq.${cacheKey}`,
            status: "eq.pending",
            lease_until: `lt.${new Date().toISOString()}`,
          }),
          {
            method: "PATCH",
            headers: writeHeaders,
            body: JSON.stringify({ lease_until: leaseUntil, updated_at: new Date().toISOString() }),
          },
          "the cache lease takeover",
        ),
      );
      return taken.length > 0;
    },

    async save(cacheKey, leaseUntil, payload, expiresAt) {
      const serialized = JSON.stringify(payload);
      const saved = rows(
        await request(
          tableUrl({ cache_key: `eq.${cacheKey}`, status: "eq.pending", lease_until: `eq.${leaseUntil}` }),
          {
            method: "PATCH",
            headers: writeHeaders,
            body: JSON.stringify({
              status: "ready",
              payload,
              payload_bytes: Buffer.byteLength(serialized, "utf8"),
              lease_until: null,
              updated_at: new Date().toISOString(),
              expires_at: expiresAt,
            }),
          },
          "the cache store",
        ),
      );
      return saved.length > 0;
    },

    async release(cacheKey) {
      await request(
        tableUrl({ cache_key: `eq.${cacheKey}`, status: "eq.pending" }),
        { method: "DELETE", headers: writeHeaders },
        "the cache release",
      ).catch(() => null);
    },

    async purge(cacheKey) {
      // Only the expired row is removed: a concurrent request may have replaced
      // it with a fresh page between this caller's read and its purge.
      await request(
        tableUrl({ cache_key: `eq.${cacheKey}`, expires_at: `lt.${new Date().toISOString()}` }),
        { method: "DELETE", headers: writeHeaders },
        "the cache purge",
      );
    },

    async prune(nowIso) {
      await request(
        tableUrl({ expires_at: `lt.${nowIso}` }),
        { method: "DELETE", headers: writeHeaders },
        "the cache prune",
      );
    },
  };
}

export function stockCacheKey(provider: StockProvider, type: StockType, query: string, page: number): string {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(`stock-v1\n${provider}\n${type}\n${page}\n${normalized}`).digest("hex");
}

// ---- Provider calls --------------------------------------------------------

interface ProviderPage {
  results: StockResult[];
  hasMore: boolean;
  rateLimitRemaining: number | null;
}

class StockProviderError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "StockProviderError";
    this.code = code;
  }
}

function readRateLimitRemaining(headers: Headers): number | null {
  const raw = headers.get("x-ratelimit-remaining") ?? headers.get("x-rate-limit-remaining");
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

function providerRequestUrl(
  input: StockSearchInput & { provider: StockProvider },
  limits: StockLimits,
): { url: URL; headers: Record<string, string> } {
  const query = new URLSearchParams({
    per_page: String(limits.pageSize),
    page: String(input.page),
  });
  const headers = { Accept: "application/json" };
  if (input.provider === "pexels") {
    query.set("query", input.query);
    const path = input.type === "image" ? "/v1/search" : "/videos/search";
    return { url: new URL(`${PEXELS_BASE}${path}?${query}`), headers };
  }
  query.set("q", input.query);
  query.set("safesearch", "true");
  if (input.type === "image") {
    query.set("image_type", "photo");
    return { url: new URL(`${PIXABAY_BASE}/?${query}`), headers };
  }
  return { url: new URL(`${PIXABAY_BASE}/videos/?${query}`), headers };
}

async function fetchProviderPage(
  provider: StockProvider,
  apiKey: string,
  input: StockSearchInput,
  limits: StockLimits,
  fetchImpl: typeof fetch,
): Promise<ProviderPage> {
  // The provider URL carries the query and, for Pixabay, the key. It is built
  // here and never logged or put in an error.
  const request = providerRequestUrl({ ...input, provider }, limits);
  const headers: Record<string, string> = { ...request.headers };
  if (provider === "pexels") headers.Authorization = apiKey;
  else request.url.searchParams.set("key", apiKey);

  let response: Response;
  try {
    response = await fetchImpl(request.url.toString(), {
      headers,
      signal: AbortSignal.timeout(limits.timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new StockProviderError(name === "TimeoutError" || name === "AbortError" ? "STOCK_PROVIDER_TIMEOUT" : "STOCK_PROVIDER_UNAVAILABLE");
  }

  const rateLimitRemaining = readRateLimitRemaining(response.headers);
  if (response.status === 429) throw new StockProviderError("STOCK_PROVIDER_RATE_LIMITED");
  if (response.status === 401 || response.status === 403) throw new StockProviderError("STOCK_PROVIDER_REJECTED");
  if (!response.ok) throw new StockProviderError("STOCK_PROVIDER_UNAVAILABLE");

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new StockProviderError("STOCK_PROVIDER_UNREADABLE");
  }
  if (!isRecord(body)) throw new StockProviderError("STOCK_PROVIDER_UNREADABLE");

  const items = body[provider === "pexels" ? (input.type === "image" ? "photos" : "videos") : "hits"];
  if (!Array.isArray(items)) throw new StockProviderError("STOCK_PROVIDER_UNREADABLE");

  const normalize =
    provider === "pexels"
      ? input.type === "image"
        ? normalizePexelsPhoto
        : normalizePexelsVideo
      : input.type === "image"
        ? normalizePixabayImage
        : normalizePixabayVideo;
  const results: StockResult[] = [];
  for (const item of items) {
    const result = normalize(item);
    if (result) results.push(result);
  }

  let hasMore: boolean;
  if (provider === "pexels") {
    hasMore = body.next_page !== undefined && body.next_page !== null;
  } else {
    const total = finiteNumber(body.totalHits);
    hasMore = total !== null ? total > input.page * limits.pageSize : items.length >= limits.pageSize;
  }

  return { results, hasMore, rateLimitRemaining };
}

// ---- Search service --------------------------------------------------------

export interface StockSearchDeps {
  limits: StockLimits;
  cache: StockCacheStore | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: { error(message: string): void };
}

const CACHE_POLL_MS = 100;
const CACHE_PRUNE_INTERVAL_MS = 60_000;

export function createStockSearch(deps: StockSearchDeps) {
  const limits = deps.limits;
  const cache = deps.cache;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger ?? console;
  const cooldowns = new Map<StockProvider, number>();
  let lastPrune = 0;

  function logFailure(provider: StockProvider, code: string): void {
    logger.error(`[stock] ${provider.toUpperCase()}_${code}`);
  }

  async function readCache(cacheKey: string): Promise<StockCacheRow | null> {
    if (!cache) return null;
    try {
      return await cache.get(cacheKey);
    } catch {
      logger.error("[stock] STOCK_CACHE_READ_FAILED");
      return null;
    }
  }

  async function waitForReady(cacheKey: string, waitMs: number): Promise<{ payload: unknown; expiresAt: string } | null> {
    if (!cache || waitMs <= 0) return null;
    const deadline = now() + waitMs;
    while (now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, CACHE_POLL_MS));
      const row = await readCache(cacheKey);
      if (row?.status === "ready") return { payload: row.payload, expiresAt: row.expiresAt };
      if (!row) return null;
    }
    return null;
  }

  async function maybePrune(): Promise<void> {
    if (!cache || now() - lastPrune < CACHE_PRUNE_INTERVAL_MS) return;
    lastPrune = now();
    try {
      await cache.prune(new Date(now()).toISOString());
    } catch {
      logger.error("[stock] STOCK_CACHE_PRUNE_FAILED");
    }
  }

  function readCachedPage(payload: unknown): ProviderPage | null {
    if (!isRecord(payload) || !Array.isArray(payload.results)) return null;
    const results = payload.results.filter(
      (entry): entry is StockResult =>
        isRecord(entry) &&
        typeof entry.provider === "string" &&
        typeof entry.providerId === "string" &&
        typeof entry.type === "string" &&
        Array.isArray(entry.renditions),
    );
    return {
      results,
      hasMore: payload.hasMore === true,
      rateLimitRemaining: finiteNumber(payload.rateLimitRemaining),
    };
  }

  async function loadProviderPage(
    provider: StockProvider,
    apiKey: string,
    input: StockSearchInput,
  ): Promise<{ page: ProviderPage; cached: boolean }> {
    const cacheKey = stockCacheKey(provider, input.type, input.query, input.page);
    const ttlSeconds = provider === "pixabay" ? limits.pixabayCacheSeconds : limits.pexelsCacheSeconds;
    const expiresAt = new Date(now() + ttlSeconds * 1000).toISOString();
    const leaseUntil = new Date(now() + limits.cacheLeaseMs).toISOString();

    const cached = await readCache(cacheKey);
    if (cached?.status === "ready") {
      const fresh = cached.expiresAt.length > 0 && Date.parse(cached.expiresAt) > now();
      if (fresh) {
        const page = readCachedPage(cached.payload);
        if (page) return { page, cached: true };
      } else if (cache) {
        // An expired page must not be served, and its key must be claimable.
        try {
          await cache.purge(cacheKey);
        } catch {
          logger.error("[stock] STOCK_CACHE_PURGE_FAILED");
        }
      }
    }

    let ownsClaim = false;
    if (cache) {
      if (cached?.status === "pending") {
        const active = cached.leaseUntil !== null && Date.parse(cached.leaseUntil) > now();
        if (active) {
          const ready = await waitForReady(cacheKey, limits.cacheWaitMs);
          const page = ready ? readCachedPage(ready.payload) : null;
          if (page) return { page, cached: true };
        } else {
          try {
            ownsClaim = await cache.takeOver(cacheKey, leaseUntil);
          } catch {
            logger.error("[stock] STOCK_CACHE_CLAIM_FAILED");
          }
        }
      } else {
        try {
          ownsClaim = await cache.claim({
            cacheKey,
            provider,
            query: input.query,
            type: input.type,
            page: input.page,
            expiresAt,
            leaseUntil,
          });
        } catch {
          logger.error("[stock] STOCK_CACHE_CLAIM_FAILED");
        }
        if (!ownsClaim) {
          // Another request won the insert race; wait for its page briefly.
          const ready = await waitForReady(cacheKey, limits.cacheWaitMs);
          const page = ready ? readCachedPage(ready.payload) : null;
          if (page) return { page, cached: true };
        }
      }
      await maybePrune();
    }

    const cooldownUntil = cooldowns.get(provider) ?? 0;
    if (cooldownUntil > now()) {
      if (ownsClaim && cache) await cache.release(cacheKey).catch(() => undefined);
      throw new StockProviderError("STOCK_PROVIDER_RATE_LIMITED");
    }

    let page: ProviderPage;
    try {
      page = await fetchProviderPage(provider, apiKey, input, limits, fetchImpl);
    } catch (error) {
      if (ownsClaim && cache) await cache.release(cacheKey).catch(() => undefined);
      throw error;
    }

    if (page.rateLimitRemaining === 0) {
      // Providers report no remaining quota; stop calling until the window turns.
      cooldowns.set(provider, now() + 60_000);
      logFailure(provider, "STOCK_PROVIDER_RATE_LIMITED");
    }

    if (ownsClaim && cache) {
      const payload = {
        results: page.results,
        hasMore: page.hasMore,
        rateLimitRemaining: page.rateLimitRemaining,
      };
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized, "utf8") <= limits.cachePayloadBytes) {
        try {
          const saved = await cache.save(cacheKey, leaseUntil, payload, expiresAt);
          if (!saved) logger.error("[stock] STOCK_CACHE_LEASE_LOST");
        } catch {
          logger.error("[stock] STOCK_CACHE_WRITE_FAILED");
          await cache.release(cacheKey).catch(() => undefined);
        }
      } else {
        logger.error("[stock] STOCK_CACHE_PAYLOAD_TOO_LARGE");
        await cache.release(cacheKey).catch(() => undefined);
      }
    }

    return { page, cached: false };
  }

  return async function search(input: StockSearchInput): Promise<StockSearchResponse> {
    const statuses: StockProviderStatus[] = [];
    const merged: StockResult[] = [];
    const seen = new Set<string>();
    let anyOk = false;

    for (const provider of input.sources) {
      const status: StockProviderStatus = {
        provider,
        ok: false,
        count: 0,
        page: input.page,
        hasMore: false,
        cached: false,
        rateLimitRemaining: null,
        error: null,
      };
      const apiKey = provider === "pexels" ? limits.pexelsKey : limits.pixabayKey;
      if (!apiKey) {
        status.error = "STOCK_PROVIDER_NOT_CONFIGURED";
        statuses.push(status);
        continue;
      }
      try {
        const loaded = await loadProviderPage(provider, apiKey, input);
        anyOk = true;
        status.ok = true;
        status.count = loaded.page.results.length;
        status.hasMore = loaded.page.hasMore;
        status.cached = loaded.cached;
        status.rateLimitRemaining = loaded.page.rateLimitRemaining;
        for (const result of loaded.page.results) {
          const key = `${result.provider}:${result.providerId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(result);
        }
      } catch (error) {
        const code = error instanceof StockProviderError ? error.code : "STOCK_PROVIDER_UNAVAILABLE";
        status.error = code;
        logFailure(provider, code);
      }
      statuses.push(status);
    }

    if (!anyOk) {
      throw new ApiError(
        502,
        "STOCK_PROVIDERS_UNAVAILABLE",
        "No selected stock provider returned results. Try again shortly.",
      );
    }

    return {
      ok: true,
      query: input.query,
      type: input.type,
      sources: input.sources,
      page: input.page,
      resultsPerProvider: limits.pageSize,
      results: merged,
      providers: statuses,
      fetchedAt: new Date(now()).toISOString(),
    };
  };
}

// ---- Import ----------------------------------------------------------------

export interface HostAddress {
  address: string;
  family: number;
}

export type HostLookup = (hostname: string) => Promise<HostAddress[]>;

const defaultHostLookup: HostLookup = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => ({ address: entry.address, family: entry.family }));
};

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}

/** Loopback, private, link-local, shared, reserved, multicast, and doc ranges. */
export function isPrivateAddress(address: string): boolean {
  const lower = address.toLowerCase();

  if (isIP(lower) === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("ff")) return true;
    if (lower.startsWith("64:ff9b:") || lower.startsWith("2001:db8:")) return true;
    return false;
  }

  const octets = parseIpv4(lower);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51) return true;
  if (a === 203 && b === 0) return true;
  if (a >= 224) return true;
  return false;
}

export function parseStockImport(input: unknown): StockImportRequest {
  if (!isRecord(input)) {
    throw new ApiError(400, "INVALID_STOCK_IMPORT", "Request body must be a JSON object.");
  }
  const allowed = ["provider", "providerId", "type", "rendition", "url", "sourcePage", "creator", "attribution", "license"];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new ApiError(400, "UNEXPECTED_FIELD", `Request body may only contain ${allowed.join(", ")}.`);
    }
  }

  const provider = input.provider;
  if (typeof provider !== "string" || !STOCK_PROVIDERS.includes(provider as StockProvider)) {
    throw new ApiError(400, "INVALID_STOCK_IMPORT", `provider must be one of ${STOCK_PROVIDERS.join(", ")}.`);
  }
  const type = input.type;
  if (typeof type !== "string" || !STOCK_TYPES.includes(type as StockType)) {
    throw new ApiError(400, "INVALID_STOCK_IMPORT", `type must be one of ${STOCK_TYPES.join(", ")}.`);
  }

  const providerId = typeof input.providerId === "string" ? input.providerId.trim() : "";
  if (!/^\d{1,32}$/.test(providerId)) {
    throw new ApiError(400, "INVALID_STOCK_IMPORT", "providerId must be the provider's numeric asset id.");
  }

  const rendition = text(input.rendition, 40);
  if (!rendition) {
    throw new ApiError(400, "INVALID_STOCK_IMPORT", "rendition must name the selected rendition.");
  }

  const url = httpUrl(input.url);
  if (!url || url.length > 2048) {
    throw new ApiError(400, "INVALID_STOCK_IMPORT", "url must be an http(s) asset URL of at most 2048 characters.");
  }
  const sourcePage = httpUrl(input.sourcePage);
  if (!sourcePage || sourcePage.length > 2048) {
    throw new ApiError(
      400,
      "INVALID_STOCK_IMPORT",
      "sourcePage must be the provider's page URL of at most 2048 characters.",
    );
  }
  const siteHost = new URL(sourcePage).hostname.toLowerCase();
  if (!PROVIDER_SITE_HOSTS[provider as StockProvider].includes(siteHost)) {
    throw new ApiError(400, "INVALID_STOCK_IMPORT", "sourcePage must be a page on the selected provider's site.");
  }

  const creator = text(input.creator, 160);
  const attribution = text(input.attribution, 300);
  const license = text(input.license, 80);
  if (!creator || !attribution || !license) {
    throw new ApiError(400, "INVALID_STOCK_IMPORT", "creator, attribution, and license are required for provenance.");
  }

  return {
    provider: provider as StockProvider,
    providerId,
    type: type as StockType,
    rendition,
    url,
    sourcePage,
    creator,
    attribution,
    license,
  };
}

export function buildStockProvenance(
  request: StockImportRequest,
  byteSize: number,
  downloadedAt: string,
): MediaProvenance {
  if (!Number.isInteger(byteSize) || byteSize <= 0) {
    throw new ApiError(400, "INVALID_STOCK_IMPORT", "An imported asset must have a positive byte size.");
  }
  return {
    source: "stock",
    provider: request.provider,
    providerId: request.providerId,
    type: request.type,
    rendition: request.rendition,
    renditionUrl: request.url,
    sourcePage: request.sourcePage,
    creator: request.creator,
    attribution: request.attribution,
    license: request.license,
    downloadedAt,
    byteSize,
  };
}

export interface StockDownloadDeps {
  limits: StockLimits;
  fetchImpl?: typeof fetch;
  hostLookup?: HostLookup;
}

async function assertDownloadUrl(raw: string, provider: StockProvider, deps: StockDownloadDeps): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, "STOCK_IMPORT_URL_INVALID", "The asset URL is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new ApiError(400, "STOCK_IMPORT_URL_REFUSED", "Asset downloads must use https.");
  }
  if (url.username || url.password || url.port !== "") {
    throw new ApiError(400, "STOCK_IMPORT_URL_REFUSED", "Asset URLs may not carry credentials or a custom port.");
  }

  const host = url.hostname.toLowerCase();
  if (!PROVIDER_ASSET_HOSTS[provider].includes(host)) {
    throw new ApiError(400, "STOCK_IMPORT_HOST_REFUSED", "Only the selected provider's own asset hosts may be downloaded.");
  }
  if (isIP(host) !== 0) {
    throw new ApiError(400, "STOCK_IMPORT_URL_REFUSED", "Asset URLs must name a public hostname.");
  }

  const lookup = deps.hostLookup ?? defaultHostLookup;
  let addresses: HostAddress[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new ApiError(502, "STOCK_IMPORT_DNS_FAILED", "The asset host could not be resolved.");
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new ApiError(400, "STOCK_IMPORT_ADDRESS_REFUSED", "Asset hosts must resolve to a public address.");
  }
  return url;
}

async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiError(413, "STOCK_IMPORT_TOO_LARGE", `Imported assets are limited to ${maxBytes} bytes.`);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError(413, "STOCK_IMPORT_TOO_LARGE", `Imported assets are limited to ${maxBytes} bytes.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Downloads one selected rendition through the server. Every hop is checked:
 * a provider CDN redirect to another host, to a private address, or off https is
 * refused before its bytes are read, and the body is capped while streaming.
 */
export async function downloadStockAsset(
  input: { provider: StockProvider; type: StockType; url: string },
  deps: StockDownloadDeps,
): Promise<Buffer> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxBytes = input.type === "image" ? deps.limits.importImageBytes : deps.limits.importVideoBytes;
  let current = input.url;

  for (let hop = 0; hop <= deps.limits.importRedirects; hop += 1) {
    const safe = await assertDownloadUrl(current, input.provider, deps);
    let response: Response;
    try {
      response = await fetchImpl(safe.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { Accept: input.type === "image" ? "image/*" : "video/*", "User-Agent": "StoryFrame/0.1" },
        signal: AbortSignal.timeout(deps.limits.importTimeoutMs),
      });
    } catch {
      throw new ApiError(502, "STOCK_IMPORT_UNAVAILABLE", "The provider asset could not be downloaded.");
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new ApiError(502, "STOCK_IMPORT_REDIRECT_INVALID", "The provider redirect had no location.");
      }
      await response.body?.cancel().catch(() => undefined);
      current = new URL(location, safe).toString();
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ApiError(
        502,
        "STOCK_IMPORT_REJECTED",
        `The provider refused the asset download (HTTP ${response.status}).`,
      );
    }

    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (isPlaylistAsset(safe.toString(), contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ApiError(422, "STOCK_IMPORT_PLAYLIST", "Playlists and segmented streams cannot be imported as video.");
    }
    const expectedPrefix = input.type === "image" ? "image/" : "video/";
    if (!contentType.startsWith(expectedPrefix)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ApiError(422, "STOCK_IMPORT_TYPE_MISMATCH", `The selected asset is not an ${input.type}.`);
    }

    return readBounded(response, maxBytes);
  }

  throw new ApiError(
    502,
    "STOCK_IMPORT_REDIRECT_LIMIT",
    `Asset downloads may follow at most ${deps.limits.importRedirects} redirects.`,
  );
}
