import { createHash, randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type {
  AiErrorResponse,
  AiStatusResponse,
  AiTestSuccess,
  AiUsageListResponse,
  AiUsageRecord,
} from "../shared/ai-contract";
import { loadConfig, type AppConfig } from "./config";
import { CATALOG_CHECKED_ON, findModel } from "./models";
import { OLLAMA_BASE_URL, ProviderError, requestChat } from "./ollama";
import {
  SupabaseAuthError,
  createSupabaseAuth,
  type AuthenticatedUser,
  type SupabaseAuth,
} from "./supabase-auth";
import {
  UsageLedgerError,
  createSupabaseUsageLedger,
  type ExistingUsage,
  type ReservationResult,
  type UsageCompletion,
  type UsageLedger,
} from "./usage-ledger";
import {
  PROJECT_LIMITS,
  PROJECT_LIST_LIMIT,
  PROJECT_NOT_FOUND_MESSAGE,
  createSupabaseProjectStore,
  assertSceneLocks,
  isProjectId,
  parseProjectExportInput,
  parseProjectUpdate,
  parseProjectWrite,
  type ProjectStore,
} from "./projects";
import { ApiError } from "./api-error";
import type { MediaRecord } from "../shared/media-contract";
import { buildProjectExport } from "../shared/project-export";
import type {
  ImageBillingView,
  ImageEstimate,
  ImageGenerationRecord,
  ImagePendingJob,
} from "../shared/image-generation-contract";
import {
  IMAGE_MODELS,
  fetchLeonardoGeneration,
  generateWithCloudflare,
  isImageProviderConfigured,
  loadImageProviderSettings,
  startLeonardoGeneration,
  type LeonardoGenerationStatus,
} from "./image-providers";
import {
  createSupabaseImageGenerationStore,
  estimateImageGeneration,
  parseImageGenerationInput,
  resolveImageRequest,
  type ImageGenerationStore,
  type ResolvedImageRequest,
} from "./image-generations";
import {
  MEDIA_NOT_FOUND_MESSAGE,
  createSupabaseMediaStore,
  detectMediaType,
  isMediaId,
  limitForKind,
  mediaObjectKey,
  mediaTypeMatches,
  newMediaId,
  parseMediaInitiate,
  parseMediaReferenceWrite,
  sweepMedia,
  type MediaStore,
} from "./media";
import { R2Error, createR2Client, type R2Client } from "./r2";
import { DEEPGRAM_PREVIEW_TEXT, loadDeepgramSettings, synthesizeSpeech } from "./deepgram";
import {
  createSupabaseNarrationUsageStore,
  type NarrationUsageStore,
  type NarrationUsageTotals,
} from "./narration-usage";
import {
  NARRATION_VOICES,
  buildNarrationScript,
  createSupabaseNarrationStore,
  findNarrationVoice,
  measureAudioDuration,
  parseAudioAttachInput,
  parseAudioSettings,
  parseNarrationGenerateInput,
  readNarrationScript,
  type NarrationStore,
} from "./narration";
import {
  DEEPGRAM_AURA2_USD_PER_1K_CHARS,
  DEEPGRAM_RATE_VERSION,
  NARRATION_MAX_CHARS,
  type NarrationKind,
  type NarrationStateResponse,
  type NarrationUsageSummary,
  type NarrationTiming,
  type NarrationTrack,
} from "../shared/narration-contract";
import { startMediaSweeper } from "./media-scheduler";
import { createSupabaseModelHealthStore, type ModelHealthStore } from "./model-health";
import {
  PLANNING_LIMITS,
  PLANNING_MODELS,
  applyPlanningProposal,
  buildPlanningPrompt,
  findPlanningRoute,
  generatePlanningPayload,
  insufficientEvidencePayload,
  PlanningInvalidError,
  planningRegistryWithModels,
  type ResolvedPlanningRoute,
} from "./planning";
import {
  PLANNING_ROUTES,
  type PlanningAttemptStatusResponse,
  type PlanningPayload,
  type PlanningRoute,
  type PlanningStartRequest,
  type PlanningStatus,
} from "../shared/planning-contract";
import {
  PROFILE_LIMITS,
  createSupabaseProfileStore,
  parseProfileUpdate,
  type ProfileStore,
} from "./profiles";
import {
  buildStockProvenance,
  createStockSearch,
  createSupabaseStockCache,
  downloadStockAsset,
  parseStockImport,
  parseStockSearchInput,
  type HostLookup,
  type StockCacheStore,
} from "./stock";
import {
  CHILD_LIMITS,
  createSupabaseChildStore,
  isChildId,
  parseClaimUpdate,
  parseClaimWrite,
  parseJobUpdate,
  parseJobWrite,
  parseProposalUpdate,
  parseProposalWrite,
  parseRenderWrite,
  parseSceneList,
  parseSourceWrite,
  type ChildStore,
} from "./project-children";
import {
  buildSimulatedMp4Bytes,
  compileRenderComposition,
  pollJson2VideoMovie,
  submitMovieToJson2Video,
} from "./json2video";
import type { ProjectAspectRatio } from "../shared/project-contract";
import type { RenderJobRecord } from "../shared/render-contract";
import { StudioWorkflowEngine } from "./studio-engine";
import type { ScopedEditRequest } from "../shared/workflows-contract";
import type { BillingWebhookEventRequest, CostProviderName, SubscriptionPlanId, BillingInterval } from "../shared/billing-contract";
import type { ApiKeyScope, DisasterScenarioId, PublishingPlatform, WorkspaceRole, ProjectBackupBundle } from "../shared/studio-ops-contract";
import type { IdeaFeedbackReason, IdeaFormatTrack } from "../shared/discovery-contract";

const MAX_CONCURRENT_PER_USER = 1;
const RATE_LIMIT_WINDOW_MS = 60_000;
const LEDGER_READY_TTL_MS = 30_000;
const CHILD_RESOURCES = new Set(["scenes", "sources", "claims", "proposals", "jobs", "renders"]);
const PROJECT_REVISIONS_LIMIT = 20;
const USAGE_PAGE_SIZE = 20;
const PLANNING_BODY_BYTES = 8 * 1024;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const ABANDONED_MESSAGE =
  "This attempt did not finish, so its outcome is unknown and it was not retried. Ollama may have charged for it. Use a new Idempotency-Key only if you accept a possible duplicate charge.";

export interface ServerOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: { error(message: string): void };
  /** DNS resolver for stock import checks; tests inject a deterministic one. */
  hostLookup?: HostLookup;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  /** Structured recovery data carried to the client, when a code has one. */
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function readBearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function readIdempotencyKey(request: IncomingMessage): string {
  const header = request.headers["idempotency-key"];
  if (typeof header !== "string" || header.trim().length === 0) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "An Idempotency-Key header is required.");
  }
  const key = header.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new HttpError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be 8-128 characters from A-Z, a-z, 0-9, dot, underscore, colon, or hyphen.",
    );
  }
  return key;
}

function hashRequest(modelId: string, prompt: string): string {
  return createHash("sha256").update(modelId).update("\n").update(prompt).digest("hex");
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function buildStatus(config: AppConfig, ledgerReady: boolean, planning: PlanningStatus): AiStatusResponse {
  const authConfigured = config.supabaseUrl !== null && config.supabasePublishableKey !== null;
  const ledgerConfigured = config.supabaseUrl !== null && config.supabaseServiceRoleKey !== null;

  return {
    service: "storyframe-ai",
    mode: "development",
    keyConfigured: config.apiKey !== null,
    configured: config.apiKey !== null && authConfigured && ledgerConfigured && ledgerReady,
    auth: {
      mode: "supabase",
      configured: authConfigured,
      publishableKeyConfigured: config.supabasePublishableKey !== null,
    },
    ledger: {
      configured: ledgerConfigured,
      ready: ledgerReady,
      serviceRoleConfigured: config.supabaseServiceRoleKey !== null,
      table: "ai_usage",
    },
    provider: { name: "ollama-cloud", baseUrl: OLLAMA_BASE_URL },
    catalog: { source: "ollama.com/api/tags", checkedOn: CATALOG_CHECKED_ON },
    limits: {
      promptMaxChars: config.promptMaxChars,
      bodyMaxBytes: config.bodyMaxBytes,
      providerTimeoutMs: config.providerTimeoutMs,
      maxOutputTokens: config.maxOutputTokens,
      maxConcurrentRequests: MAX_CONCURRENT_PER_USER,
      requestsPerMinute: config.requestsPerMinute,
      abandonAfterMs: config.abandonAfterMs,
    },
    models: config.models,
    planning,
  };
}

function failure(
  code: string,
  message: string,
  upstreamStatus?: number,
  details?: unknown,
): AiErrorResponse {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
      ...(details !== undefined ? { details } : {}),
    },
  };
}

function requireMediaBucket<T>(action: () => Promise<T>): Promise<T> {
  return action().catch((error: unknown) => {
    if (error instanceof R2Error) {
      throw new HttpError(503, "MEDIA_STORAGE_UNAVAILABLE", "The private media bucket is temporarily unavailable.");
    }
    throw error;
  });
}

function toErrorResponse(error: unknown): { status: number; body: AiErrorResponse } {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: failure(error.code, error.message, undefined, error.details),
    };
  }
  // Provider errors are already sanitized; route them through the same path.
  if (error instanceof ProviderError) {
    return { status: error.status, body: failure(error.code, error.message, error.upstreamStatus) };
  }
  if (error instanceof ApiError) {
    return { status: error.status, body: failure(error.code, error.message) };
  }
  return { status: 500, body: failure("INTERNAL_ERROR", "Unexpected server error.") };
}

function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  }

  const declaredLength = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, "BODY_TOO_LARGE", `Request body must be at most ${maxBytes} bytes.`);
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        settled = true;
        reject(new HttpError(413, "BODY_TOO_LARGE", `Request body must be at most ${maxBytes} bytes.`));
        request.resume();
        return;
      }
      chunks.push(buffer);
    });

    // A client can disappear after sending headers and part of a body. Without
    // settling here, the body promise never resolves and the per-user in-flight
    // slot is held until the process exits.
    request.on("aborted", () => {
      if (settled) return;
      settled = true;
      reject(new HttpError(400, "INVALID_BODY", "The request body was interrupted."));
    });

    request.on("close", () => {
      if (settled) return;
      settled = true;
      reject(new HttpError(400, "INVALID_BODY", "The request body was interrupted."));
    });

    request.on("end", () => {
      if (settled) return;
      settled = true;
      if (total === 0) {
        reject(new HttpError(400, "INVALID_BODY", "A JSON request body is required."));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "INVALID_JSON", "Request body must be valid JSON."));
      }
    });

    request.on("error", () => {
      if (settled) return;
      settled = true;
      reject(new HttpError(400, "INVALID_BODY", "Could not read the request body."));
    });
  });
}

function parsePlanningStart(body: unknown, currentVersion: number): PlanningStartRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_PLANNING_REQUEST", "Request body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "route" && key !== "instruction" && key !== "baseVersion") {
      throw new HttpError(400, "UNEXPECTED_FIELD", "Request body may only contain route, instruction, and baseVersion.");
    }
  }
  if (typeof record.route !== "string" || !PLANNING_ROUTES.includes(record.route as PlanningRoute)) {
    throw new HttpError(400, "INVALID_PLANNING_ROUTE", `route must be one of ${PLANNING_ROUTES.join(", ")}.`);
  }
  let instruction = "";
  if (record.instruction !== undefined && record.instruction !== null) {
    if (typeof record.instruction !== "string") {
      throw new HttpError(400, "INVALID_PLANNING_REQUEST", "instruction must be a string.");
    }
    instruction = record.instruction.trim();
    if (instruction.length > PLANNING_LIMITS.instructionChars) {
      throw new HttpError(
        400,
        "INVALID_PLANNING_REQUEST",
        `instruction must be at most ${PLANNING_LIMITS.instructionChars} characters.`,
      );
    }
  }
  const baseVersion = record.baseVersion;
  if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 1) {
    throw new HttpError(400, "INVALID_PLANNING_REQUEST", "baseVersion must be a positive integer.");
  }
  if (baseVersion !== currentVersion) {
    // The caller reviewed a different document; refusing here keeps a stale
    // plan from being generated against wording the user can no longer see.
    throw new HttpError(
      409,
      "STALE_PLANNING_REQUEST",
      `This project is at version ${currentVersion}, not ${baseVersion}. Reload it before planning.`,
    );
  }
  return { route: record.route as PlanningRoute, instruction, baseVersion };
}

function validateTestBody(body: unknown, config: AppConfig): { modelId: string; prompt: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_BODY", "Request body must be a JSON object.");
  }

  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "model" && key !== "prompt") {
      throw new HttpError(400, "UNEXPECTED_FIELD", "Request body may only contain 'model' and 'prompt'.");
    }
  }

  const model = record.model;
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new HttpError(400, "INVALID_MODEL", "A model selection is required.");
  }

  const promptValue = record.prompt;
  if (typeof promptValue !== "string") {
    throw new HttpError(400, "INVALID_PROMPT", "A prompt string is required.");
  }

  const prompt = promptValue.trim();
  if (prompt.length === 0) {
    throw new HttpError(400, "INVALID_PROMPT", "Prompt must not be empty.");
  }
  if (prompt.length > config.promptMaxChars) {
    throw new HttpError(400, "PROMPT_TOO_LONG", `Prompt must be at most ${config.promptMaxChars} characters.`);
  }

  return { modelId: model.trim(), prompt };
}

export function createStoryframeServer(options: ServerOptions = {}): Server {
  const config = loadConfig(options.env ?? process.env);
  const log = options.logger ?? console;
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl;
  const recentRequestsByUser = new Map<string, number[]>();
  const inFlightByUser = new Map<string, number>();
  // One image generation per account at a time, so a double submit cannot
  // spend provider credit twice before the usage check sees the first row.
  const imageInFlight = new Set<string>();
  let lastRateLimitSweep = 0;
  let ledgerReadiness: { value: boolean; checkedAt: number } | null = null;

  const auth: SupabaseAuth | null =
    config.supabaseUrl && config.supabasePublishableKey
      ? createSupabaseAuth({
          url: config.supabaseUrl,
          publishableKey: config.supabasePublishableKey,
          timeoutMs: config.authTimeoutMs,
        })
      : null;

  const ledger: UsageLedger | null =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createSupabaseUsageLedger({
          url: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
          timeoutMs: config.authTimeoutMs,
        })
      : null;

  const projectStore: ProjectStore | null =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createSupabaseProjectStore({
          url: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
          timeoutMs: config.authTimeoutMs,
        })
      : null;

  const profileStore: ProfileStore | null =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createSupabaseProfileStore({
          url: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
          timeoutMs: config.authTimeoutMs,
        })
      : null;

  const childStore: ChildStore | null =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createSupabaseChildStore({
          url: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
          timeoutMs: config.authTimeoutMs,
        })
      : null;

  const mediaStore: MediaStore | null =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createSupabaseMediaStore({
          url: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
          timeoutMs: config.authTimeoutMs,
        })
      : null;

  const modelHealth: ModelHealthStore | null =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createSupabaseModelHealthStore({
          url: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
          timeoutMs: config.authTimeoutMs,
        })
      : null;

  const mediaObjects: R2Client | null = config.r2 ? createR2Client(config.r2, { fetchImpl, now }) : null;

  const imageStore: ImageGenerationStore | null =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createSupabaseImageGenerationStore({
          url: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
          timeoutMs: config.authTimeoutMs,
        })
      : null;
  // Credentials stay in this process; the store records only the model and job.
  const imageSettings = loadImageProviderSettings(options.env ?? process.env);

  const narrationStore: NarrationStore | null =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createSupabaseNarrationStore({
          url: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
          timeoutMs: config.authTimeoutMs,
        })
      : null;
  const narrationUsageStore: NarrationUsageStore | null =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createSupabaseNarrationUsageStore({
          url: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
          timeoutMs: config.authTimeoutMs,
        })
      : null;
  const narrationSettings = loadDeepgramSettings(options.env ?? process.env);
  // One billable narration/preview at a time per account, so two tabs and two
  // projects cannot race the usage read and spend twice.
  const narrationInFlight = new Set<string>();
  const studioEngine = new StudioWorkflowEngine();
  const runtimeEnv = options.env ?? process.env;

  const stockCache: StockCacheStore | null =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createSupabaseStockCache({
          url: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
          timeoutMs: config.authTimeoutMs,
        })
      : null;
  const searchStock = createStockSearch({
    limits: config.stock,
    cache: stockCache,
    fetchImpl,
    now,
    logger: log,
  });

  let lastMediaSweep = 0;
  let mediaSweep: Promise<void> | null = null;

  /**
   * One bounded sweep pass, shared by the timer and opportunistic media
   * requests so two passes never run over the same rows at once. Cleanup never
   * fails the request that triggered it.
   */
  function runMediaSweep(): Promise<void> {
    const store = mediaStore;
    const objects = mediaObjects;
    if (!store || !objects) return Promise.resolve();
    if (mediaSweep) return mediaSweep;
    lastMediaSweep = now();
    mediaSweep = (async () => {
      try {
        await sweepMedia({
          store,
          objects,
          projects: requireProjects(),
          limits: config.media,
          now,
          logger: log,
        });
      } catch {
        log.error("[media] MEDIA_SWEEP_FAILED");
      } finally {
        mediaSweep = null;
      }
    })();
    return mediaSweep;
  }

  let imageSweep: Promise<void> | null = null;

  /** Settles pending rows whose provider can no longer be waited on. */
  function runImageSweep(): Promise<void> {
    const store = imageStore;
    if (!store) return Promise.resolve();
    if (imageSweep) return imageSweep;
    imageSweep = (async () => {
      try {
        const cutoff = new Date(now() - config.image.pendingAbandonAfterMs).toISOString();
        await store.abandonStale(cutoff);
      } catch {
        log.error("[image] IMAGE_SWEEP_FAILED");
      } finally {
        imageSweep = null;
      }
    })();
    return imageSweep;
  }

  const server = createHttpServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      const { status, body } = toErrorResponse(error);
      if (status >= 500) log.error(`[ai] ${body.error.code} status=${status}`);
      if (!response.headersSent) sendJson(response, status, body);
      else response.end();
    });
  });

  // An idle server still expires interrupted uploads and retention rows. With a
  // zero interval the timer is off and media requests keep triggering a pass.
  const mediaSweeper = startMediaSweeper({
    intervalMs: config.media.sweepIntervalMs,
    sweep: runMediaSweep,
    logger: log,
  });
  if (mediaSweeper) server.on("close", () => mediaSweeper.stop());

  // Pending image jobs expire even if no request ever asks about them again.
  const imageSweeper =
    config.image.pendingSweepIntervalMs > 0
      ? setInterval(() => {
          void runImageSweep();
        }, config.image.pendingSweepIntervalMs)
      : null;
  imageSweeper?.unref?.();
  if (imageSweeper) server.on("close", () => clearInterval(imageSweeper));

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const path = requestUrl.pathname;

    if (path === "/api/ai/status") {
      if (method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET for this endpoint.");
      const ledgerReady = await readLedgerReadiness();
      sendJson(response, 200, buildStatus(config, ledgerReady, await readPlanningStatus()));
      return;
    }

    if (path === "/api/ai/usage") {
      if (method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET for this endpoint.");
      await handleUsage(request, response);
      return;
    }

    if (path === "/api/ai/test") {
      if (method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST for this endpoint.");
      await handleTest(request, response);
      return;
    }

    if (path === "/api/profile") {
      await handleProfile(request, response);
      return;
    }

    // Phase 6 canonical route; the contract's unprefixed path is accepted too.
    if (path === "/api/stock/search" || path === "/stock/search") {
      if (method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET for stock search.");
      await handleStockSearch(request, response, requestUrl);
      return;
    }

    if (path === "/api/image-usage") {
      if (method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET for image usage.");
      await handleImageUsage(request, response);
      return;
    }

    if (path === "/api/image-models") {
      if (method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET for the image models.");
      await handleImageModels(request, response);
      return;
    }

    if (path === "/api/narration/voices") {
      if (method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET for the narration voices.");
      await handleNarrationVoices(request, response);
      return;
    }

    if (path === "/api/projects" || path.startsWith("/api/projects/")) {
      await handleProjects(request, response, path);
      return;
    }

    if (path.startsWith("/api/discovery/") || path.startsWith("/api/studio/")) {
      await handleStudioGlobalRoutes(request, response, path, requestUrl);
      return;
    }

    throw new HttpError(404, "NOT_FOUND", "Unknown endpoint.");
  }

  function checkOrigin(request: IncomingMessage): void {
    const origin = request.headers.origin;
    if (config.allowedOrigin && origin && origin !== config.allowedOrigin) {
      throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "This origin may not call this endpoint.");
    }
  }

  async function authenticate(request: IncomingMessage): Promise<AuthenticatedUser> {
    if (!auth) {
      throw new HttpError(
        503,
        "AUTH_NOT_CONFIGURED",
        "Supabase authentication is not configured on the server. Set SUPABASE_URL and a publishable key.",
      );
    }

    const token = readBearer(request);
    if (!token) throw new HttpError(401, "UNAUTHORIZED", "A valid Supabase access token is required.");

    try {
      return await auth.verify(token);
    } catch (error) {
      if (error instanceof SupabaseAuthError) {
        throw new HttpError(error.status, error.code, error.message);
      }
      throw error;
    }
  }

  async function readPlanningStatus(): Promise<PlanningStatus> {
    const lastSuccessByModel = new Map<string, string | null>();
    if (modelHealth) {
      try {
        for (const row of await modelHealth.list()) lastSuccessByModel.set(row.modelId, row.lastSuccessAt);
      } catch {
        // The registry itself is still reportable; only health is unknown.
        log.error("[planning] MODEL_HEALTH_READ_FAILED");
      }
    }
    return {
      routes: config.planning.routes.map((route) => ({
        route: route.route,
        modelId: route.modelId,
        requestId: route.requestId,
        available: route.available,
        reason: route.reason,
        capabilities: route.capabilities,
      })),
      registry: planningRegistryWithModels(config.planning.routes, PLANNING_MODELS, lastSuccessByModel),
    };
  }

  /** Records a planning outcome for the registry; health is not worth failing a request over. */
  async function recordModelOutcome(modelId: string, outcome: "success" | "failure", code?: string): Promise<void> {
    if (!modelHealth) return;
    const at = new Date(now()).toISOString();
    try {
      if (outcome === "success") await modelHealth.recordSuccess(modelId, at);
      else await modelHealth.recordFailure(modelId, at, code ?? "UNKNOWN");
    } catch {
      log.error("[planning] MODEL_HEALTH_WRITE_FAILED");
    }
  }

  async function readLedgerReadiness(): Promise<boolean> {
    if (!ledger) return false;
    if (ledgerReadiness && now() - ledgerReadiness.checkedAt < LEDGER_READY_TTL_MS) {
      return ledgerReadiness.value;
    }
    const value = await ledger.check().then(() => true).catch(() => false);
    ledgerReadiness = { value, checkedAt: now() };
    return value;
  }

  function requireLedger(): UsageLedger {
    if (!ledger) {
      throw new HttpError(
        503,
        "LEDGER_NOT_CONFIGURED",
        "The usage ledger is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return ledger;
  }

  function requireProjects(): ProjectStore {
    if (!projectStore) {
      throw new HttpError(
        503,
        "PROJECTS_NOT_CONFIGURED",
        "The project store is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return projectStore;
  }

  function requireChildren(): ChildStore {
    if (!childStore) {
      throw new HttpError(
        503,
        "PROJECTS_NOT_CONFIGURED",
        "The project store is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return childStore;
  }

  function requireMediaStore(): MediaStore {
    if (!mediaStore) {
      throw new HttpError(
        503,
        "MEDIA_NOT_CONFIGURED",
        "Media storage is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return mediaStore;
  }

  function requireNarrationUsageStore(): NarrationUsageStore {
    if (!narrationUsageStore) {
      throw new HttpError(
        503,
        "NARRATION_USAGE_UNAVAILABLE",
        "The narration usage ledger is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return narrationUsageStore;
  }

  function requireNarrationStore(): NarrationStore {
    if (!narrationStore) {
      throw new HttpError(
        503,
        "NARRATION_STORE_UNAVAILABLE",
        "The narration store is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return narrationStore;
  }

  function requireImageStore(): ImageGenerationStore {
    if (!imageStore) {
      throw new HttpError(
        503,
        "IMAGE_STORE_UNAVAILABLE",
        "The image generation store is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return imageStore;
  }

  function requireMediaObjects(): R2Client {
    if (!mediaObjects) {
      throw new HttpError(
        503,
        "MEDIA_NOT_CONFIGURED",
        "Private media storage is not configured on the server. Set the R2 endpoint, bucket, access key, and secret.",
      );
    }
    return mediaObjects;
  }

  async function maybeSweepMedia(): Promise<void> {
    if (!mediaStore || !mediaObjects) return;
    if (now() - lastMediaSweep < config.media.sweepIntervalMs) return;
    await runMediaSweep();
  }

  function requireProfile(): ProfileStore {
    if (!profileStore) {
      throw new HttpError(
        503,
        "PROFILE_NOT_CONFIGURED",
        "The profile store is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return profileStore;
  }

  async function handleUsage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    checkOrigin(request);
    const user = await authenticate(request);
    const usageLedger = requireLedger();

    let usage: AiUsageRecord[];
    try {
      usage = await usageLedger.listForUser(user.id, USAGE_PAGE_SIZE);
    } catch (error) {
      if (error instanceof UsageLedgerError) {
        throw new HttpError(503, "LEDGER_UNAVAILABLE", "The usage ledger is temporarily unavailable.");
      }
      throw error;
    }

    const body: AiUsageListResponse = { ok: true, usage };
    sendJson(response, 200, body);
  }

  async function handleStockSearch(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    checkOrigin(request);
    await authenticate(request);
    const input = parseStockSearchInput(requestUrl.searchParams, config.stock);
    if (!stockCache) log.error("[stock] STOCK_CACHE_NOT_CONFIGURED");
    sendJson(response, 200, await searchStock(input));
  }

  function imageBillingView(model: (typeof IMAGE_MODELS)[number]): ImageBillingView {
    const billing = model.billing;
    if (billing.kind === "neurons") {
      return {
        kind: "neurons",
        usdPerThousandNeurons: billing.usdPerThousandNeurons,
        neuralRates: { perTile: billing.neuronsPerTile, perStep: billing.neuronsPerStep },
        note: `${billing.freeDailyNeurons.toLocaleString("en-US")} free neurons per day at the account level.`,
        sourceUrl: billing.sourceUrl,
        verifiedOn: billing.verifiedOn,
      };
    }
    return {
      kind: "api-credit",
      note: billing.note,
      sourceUrl: billing.sourceUrl,
      verifiedOn: billing.verifiedOn,
    };
  }

  async function handleImageModels(request: IncomingMessage, response: ServerResponse): Promise<void> {
    checkOrigin(request);
    await authenticate(request);
    sendJson(response, 200, {
      ok: true,
      models: IMAGE_MODELS.map((model) => ({
        key: model.key,
        provider: model.provider,
        label: model.label,
        width: model.width,
        height: model.height,
        steps: model.steps,
        maxPromptChars: model.maxPromptChars,
        // Always listed; a missing credential disables generation, not discovery.
        configured: isImageProviderConfigured(imageSettings, model.provider),
        billing: imageBillingView(model),
      })),
    });
  }

  async function handleImageUsage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    checkOrigin(request);
    const user = await authenticate(request);
    const store = requireImageStore();
    const pending = await currentPending(store, user.id);
    const spend = await store.usageSince(
      user.id,
      new Date(now() - config.image.spendWindowMs).toISOString(),
    );
    const oldest = spend.oldestAt === null ? null : Date.parse(spend.oldestAt);
    sendJson(response, 200, {
      ok: true,
      usage: {
        windowHours: config.image.spendWindowMs / (60 * 60 * 1000),
        attempts: spend.attempts,
        // The ledger charges actual cost when the provider settled it.
        spentUsd: spend.spentUsd,
        actualUsd: spend.actualUsd,
        estimatedUsd: spend.estimatedUsd,
        limits: {
          images: config.image.dailyImageLimit > 0 ? config.image.dailyImageLimit : null,
          usd: config.image.dailyUsdLimit > 0 ? config.image.dailyUsdLimit : null,
        },
        resetAt:
          oldest !== null && Number.isFinite(oldest)
            ? new Date(oldest + config.image.spendWindowMs).toISOString()
            : null,
      },
      pending: pending ? pendingJobView(pending) : null,
    });
  }

  async function handleImageEstimate(
    request: IncomingMessage,
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<void> {
    await requireProjects().get(user.id, projectId);
    const input = parseImageGenerationInput(await readJsonBody(request, PROJECT_LIMITS.bodyBytes));
    const estimate = estimateImageGeneration(resolveImageRequest(input));
    sendJson(response, 200, { ok: true, estimate });
  }

  /**
   * Polls Leonardo until its job leaves PENDING or the configured deadline
   * passes. A still-pending job is returned so the caller can refresh later;
   * no provider call is retried and the record keeps its job id.
   */
  async function waitForLeonardo(jobId: string): Promise<LeonardoGenerationStatus> {
    const deadline = now() + config.image.pollTimeoutMs;
    for (;;) {
      const status = await fetchLeonardoGeneration(imageSettings, jobId, {
        fetchImpl,
        timeoutMs: Math.min(30_000, config.image.pollTimeoutMs),
      });
      if (status.status !== "pending" || now() >= deadline) return status;
      await new Promise((resolve) => setTimeout(resolve, config.image.pollIntervalMs));
    }
  }

  /** Only the documented Leonardo asset host; redirects are not followed. */
  async function downloadGeneratedImage(target: string): Promise<{ bytes: Buffer; contentType: string }> {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new HttpError(502, "IMAGE_ASSET_INVALID", "The provider returned an unreadable image URL.");
    }
    if (url.protocol !== "https:" || url.hostname !== "cdn.leonardo.ai") {
      throw new HttpError(502, "IMAGE_ASSET_HOST_REFUSED", "The generated image is not on the allowed asset host.");
    }
    let downloaded: Response;
    try {
      downloaded = await (fetchImpl ?? fetch)(url, {
        redirect: "error",
        signal: AbortSignal.timeout(config.image.downloadTimeoutMs),
      });
    } catch {
      throw new HttpError(502, "IMAGE_ASSET_UNAVAILABLE", "The generated image could not be downloaded.");
    }
    if (!downloaded.ok) {
      throw new HttpError(502, "IMAGE_ASSET_UNAVAILABLE", `The generated image returned HTTP ${downloaded.status}.`);
    }
    const declared = Number(downloaded.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > config.media.imageBytes) {
      throw new HttpError(413, "MEDIA_TOO_LARGE", "The generated image exceeds the image size limit.");
    }
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    if (bytes.length > config.media.imageBytes) {
      throw new HttpError(413, "MEDIA_TOO_LARGE", "The generated image exceeds the image size limit.");
    }
    const detected = detectMediaType(bytes);
    if (!detected || detected.kind !== "image") {
      throw new HttpError(502, "IMAGE_ASSET_INVALID", "The generated file is not an image.");
    }
    return { bytes, contentType: detected.contentType };
  }

  /**
   * Writes generated bytes through the same private-media path as an upload:
   * pending row, presigned PUT, HEAD check, then markReady. A failure discards
   * both the object and the row.
   */
  /** Credits and provider cost objects are stored raw; only a dollar amount is spendable. */
  function leonardoCost(
    startCredits: number | null,
    pollCredits: number | null,
    rawCost: Record<string, unknown> | null,
    existing: Record<string, unknown> | null,
  ): {
    providerCost: Record<string, unknown> | null;
    actualUsd: number | null;
    actualNeurons: number | null;
    costSource: "provider" | "rate" | "credits" | null;
  } {
    const existingCost =
      existing?.cost && typeof existing.cost === "object" && !Array.isArray(existing.cost)
        ? (existing.cost as Record<string, unknown>)
        : null;
    const costObject = rawCost ?? existingCost;
    const existingCredits = existing?.apiCreditCost;
    const credits =
      pollCredits ??
      startCredits ??
      (typeof existingCredits === "number" && Number.isInteger(existingCredits) ? existingCredits : null);
    const merged = {
      ...(existing ?? {}),
      ...(credits === null ? {} : { apiCreditCost: credits }),
      ...(costObject === null ? {} : { cost: costObject }),
    };
    const amount = costObject?.amount;
    const unit = typeof costObject?.unit === "string" ? costObject.unit.toLowerCase() : "";
    const actualUsd =
      typeof amount === "number" && Number.isFinite(amount) && ["usd", "dollar", "dollars"].includes(unit)
        ? Number(amount.toFixed(6))
        : null;
    return {
      providerCost: Object.keys(merged).length === 0 ? null : { provider: "leonardo", ...merged },
      actualUsd,
      actualNeurons: null,
      costSource: actualUsd !== null ? "provider" : credits !== null || costObject !== null ? "credits" : null,
    };
  }

  async function persistGeneratedImage(
    ownerId: string,
    projectId: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<MediaRecord> {
    const store = requireMediaStore();
    const objects = requireMediaObjects();
    if (bytes.length > config.media.imageBytes) {
      throw new HttpError(413, "MEDIA_TOO_LARGE", "The generated image exceeds the image size limit.");
    }
    const mediaId = newMediaId();
    const objectKey = mediaObjectKey(ownerId, mediaId);
    const upload = objects.presignPut(objectKey, config.media.uploadUrlSeconds);
    const uploadExpiresAt = new Date(
      now() + Math.min(config.media.uploadTtlMs, config.media.uploadUrlSeconds * 1000),
    ).toISOString();
    await store.createPending(ownerId, projectId, {
      id: mediaId,
      kind: "image",
      contentType,
      byteSize: bytes.length,
      sceneKey: null,
      objectKey,
      uploadExpiresAt,
      provenance: null,
    });
    try {
      const put = await (fetchImpl ?? fetch)(upload.url, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(config.image.downloadTimeoutMs),
      });
      if (!put.ok) {
        throw new HttpError(502, "MEDIA_STORAGE_UNAVAILABLE", "Private storage rejected the generated image.");
      }
      const head = await requireMediaBucket(() => objects.head(objectKey));
      if (head === null) {
        throw new HttpError(502, "MEDIA_STORAGE_UNAVAILABLE", "The generated image was not stored.");
      }
      const media = await store.markReady(ownerId, projectId, mediaId, { contentType, byteSize: head.byteSize });
      if (!media) {
        throw new HttpError(409, "IMAGE_MEDIA_STATE_CHANGED", "The generated asset changed while it was stored.");
      }
      return media;
    } catch (error) {
      await discardMedia(store, objects, ownerId, projectId, mediaId, objectKey);
      throw error;
    }
  }

  async function handleImageGenerationList(
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<void> {
    await requireProjects().get(user.id, projectId);
    const generations = await requireImageStore().list(user.id, projectId, 50);
    sendJson(response, 200, { ok: true, generations });
  }

  async function handleImageGenerate(
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
    request: IncomingMessage,
  ): Promise<void> {
    const store = requireImageStore();
    await requireProjects().get(user.id, projectId);
    const input = parseImageGenerationInput(await readJsonBody(request, PROJECT_LIMITS.bodyBytes));
    const resolved = resolveImageRequest(input);
    if (!isImageProviderConfigured(imageSettings, resolved.model.provider)) {
      throw new HttpError(
        503,
        "IMAGE_PROVIDER_DISABLED",
        `${resolved.model.label} is disabled because its provider credentials are not configured.`,
      );
    }
    const estimate = estimateImageGeneration(resolved);
    const release = acquireImageSlot(user.id);
    try {
      await enforceImageSpend(store, user.id, estimate);
      await runImageGeneration(response, user, projectId, resolved, estimate);
    } finally {
      release();
    }
  }

  /** The in-process slot closes the race between the usage read and the new row. */
  function acquireImageSlot(ownerId: string): () => void {
    if (imageInFlight.has(ownerId)) {
      throw new HttpError(
        429,
        "IMAGE_GENERATION_IN_FLIGHT",
        "An image generation is already running for this account. Wait for it to finish before starting another.",
      );
    }
    imageInFlight.add(ownerId);
    return () => {
      imageInFlight.delete(ownerId);
    };
  }

  /** Rolling 24-hour cap per account; either dimension can be disabled with 0. */
  async function enforceImageSpend(
    store: ImageGenerationStore,
    ownerId: string,
    estimate: ImageEstimate,
  ): Promise<void> {
    const pending = await currentPending(store, ownerId);
    if (pending) {
      throw new HttpError(
        429,
        "IMAGE_GENERATION_IN_FLIGHT",
        `A generation is still pending in project ${pending.projectId}${pending.jobId ? ` (job ${pending.jobId})` : ""}. Refresh or settle it, or wait for it to expire.`,
        { pending: pendingJobView(pending) },
      );
    }

    const since = new Date(now() - config.image.spendWindowMs).toISOString();
    const spend = await store.usageSince(ownerId, since);

    const imageLimit = config.image.dailyImageLimit;
    if (imageLimit > 0 && spend.attempts >= imageLimit) {
      throw new HttpError(
        429,
        "IMAGE_SPEND_LIMIT",
        `This account has ${spend.attempts} image generation${spend.attempts === 1 ? "" : "s"} recorded in the last 24 hours; the limit is ${imageLimit}. Wait for the window to pass or raise the limit.`,
      );
    }

    const usdLimit = config.image.dailyUsdLimit;
    if (
      usdLimit > 0 &&
      estimate.estimatedUsd !== null &&
      spend.spentUsd + estimate.estimatedUsd > usdLimit + 1e-9
    ) {
      throw new HttpError(
        429,
        "IMAGE_SPEND_LIMIT",
        `Image spend for the last 24 hours is $${spend.spentUsd.toFixed(4)} of $${usdLimit.toFixed(2)}; this image would exceed the limit.`,
      );
    }
  }

  function pendingJobView(pending: ImageGenerationRecord): ImagePendingJob {
    return {
      generationId: pending.id,
      projectId: pending.projectId,
      jobId: pending.jobId,
      provider: pending.provider,
      modelKey: pending.modelKey,
      createdAt: pending.createdAt,
    };
  }

  /**
   * A pending job blocks the account only until its deadline. An expired job is
   * settled here so a crashed provider poll cannot lock image generation.
   */
  async function currentPending(
    store: ImageGenerationStore,
    ownerId: string,
  ): Promise<ImageGenerationRecord | null> {
    const pending = await store.findPending(ownerId);
    if (!pending) return null;
    const age = now() - Date.parse(pending.createdAt);
    if (!Number.isFinite(age) || age < config.image.pendingAbandonAfterMs) return pending;
    const settled = await store.settlePending(
      ownerId,
      pending.projectId,
      pending.id,
      "IMAGE_GENERATION_ABANDONED",
    );
    // The stale row is released; a second legacy pending row still blocks.
    if (settled) return store.findPending(ownerId);
    // Another request settled it first; only refuse if a newer pending row exists.
    return store.findPending(ownerId);
  }

  async function runImageGeneration(
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
    resolved: ResolvedImageRequest,
    estimate: ImageEstimate,
  ): Promise<void> {
    const store = requireImageStore();
    const generation = await store.create(user.id, {
      id: randomUUID(),
      projectId,
      provider: resolved.model.provider,
      modelKey: resolved.model.key,
      prompt: resolved.prompt,
      settings: { width: resolved.width, height: resolved.height, steps: resolved.steps },
      estimatedUsd: estimate.estimatedUsd,
      estimatedNeurons: estimate.estimatedNeurons,
      rateVersion: estimate.rateVersion,
    });

    const fail = async (error: unknown): Promise<never> => {
      const code =
        error instanceof HttpError || error instanceof ApiError ? error.code : "IMAGE_GENERATION_FAILED";
      await store
        .update(user.id, projectId, generation.id, { status: "failed", errorCode: code })
        .catch(() => undefined);
      throw error;
    };

    try {
      let bytes: Buffer;
      let contentType: string;
      let jobId: string | null = null;
      let cost: {
        providerCost: Record<string, unknown> | null;
        actualUsd: number | null;
        actualNeurons: number | null;
        costSource: "provider" | "rate" | "credits" | null;
      } = { providerCost: null, actualUsd: null, actualNeurons: null, costSource: null };

      if (resolved.model.provider === "cloudflare") {
        const result = await generateWithCloudflare(
          imageSettings,
          {
            modelKey: resolved.model.key,
            prompt: resolved.prompt,
            ...(resolved.steps === null ? {} : { steps: resolved.steps }),
          },
          { fetchImpl, timeoutMs: config.image.pollTimeoutMs },
        );
        bytes = result.bytes;
        contentType = result.contentType;
        const usdPerThousand =
          estimate.billing.kind === "neurons" ? estimate.billing.usdPerThousandNeurons ?? null : null;
        cost = {
          providerCost: result.usage ? { provider: "cloudflare", usage: result.usage } : null,
          actualNeurons: result.neurons,
          actualUsd:
            result.neurons !== null && usdPerThousand !== null
              ? Number((((result.neurons / 1000) * usdPerThousand)).toFixed(6))
              : null,
          costSource: result.neurons !== null && usdPerThousand !== null ? "rate" : null,
        };
      } else {
        const started = await startLeonardoGeneration(
          imageSettings,
          {
            modelKey: resolved.model.key,
            prompt: resolved.prompt,
            width: resolved.width,
            height: resolved.height,
          },
          { fetchImpl, timeoutMs: Math.min(30_000, config.image.pollTimeoutMs) },
        );
        jobId = started.jobId;
        await store.update(user.id, projectId, generation.id, {
          jobId,
          ...(started.apiCreditCost === null
            ? {}
            : { providerCost: { provider: "leonardo", apiCreditCost: started.apiCreditCost } }),
        });
        const polled = await waitForLeonardo(jobId);
        if (polled.status === "pending") {
          const pending = await store.get(user.id, projectId, generation.id);
          sendJson(response, 202, { ok: true, generation: pending ?? generation, media: null });
          return;
        }
        if (polled.status !== "succeeded" || polled.imageUrls.length === 0) {
          throw new HttpError(502, "IMAGE_PROVIDER_FAILED", "The provider reported no completed image.");
        }
        const download = await downloadGeneratedImage(polled.imageUrls[0]);
        bytes = download.bytes;
        contentType = download.contentType;
        cost = leonardoCost(started.apiCreditCost, polled.apiCreditCost, polled.cost, null);
      }

      const media = await persistGeneratedImage(user.id, projectId, bytes, contentType);
      const updated = await store.update(user.id, projectId, generation.id, {
        status: "succeeded",
        mediaId: media.id,
        jobId,
        ...cost,
      });
      if (!updated) {
        throw new HttpError(503, "IMAGE_STORE_UNAVAILABLE", "The image store did not confirm the generation.");
      }
      sendJson(response, 201, { ok: true, generation: updated, media });
    } catch (error) {
      return fail(error);
    }
  }

  /** Explicitly releases a pending job the caller no longer wants to wait for. */
  async function handleImageSettle(
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
    generationId: string,
  ): Promise<void> {
    const store = requireImageStore();
    await requireProjects().get(user.id, projectId);
    const generation = await store.get(user.id, projectId, generationId);
    if (!generation) {
      throw new HttpError(404, "IMAGE_GENERATION_NOT_FOUND", "No generation with that id is in this project.");
    }
    if (generation.status !== "pending") {
      // Already settled: settling again is harmless and reports the real state.
      sendJson(response, 200, { ok: true, generation, media: null });
      return;
    }
    const settled = await store.settlePending(
      user.id,
      projectId,
      generationId,
      "IMAGE_GENERATION_ABANDONED",
    );
    const final = settled ?? (await store.get(user.id, projectId, generationId)) ?? generation;
    sendJson(response, 200, { ok: true, generation: final, media: null });
  }

  async function handleImageRefresh(
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
    generationId: string,
  ): Promise<void> {
    const store = requireImageStore();
    await requireProjects().get(user.id, projectId);
    const generation = await store.get(user.id, projectId, generationId);
    if (!generation) {
      throw new HttpError(404, "IMAGE_GENERATION_NOT_FOUND", "No generation with that id is in this project.");
    }
    if (generation.status !== "pending" || !generation.jobId) {
      throw new HttpError(409, "IMAGE_GENERATION_NOT_PENDING", "Only a pending generation can be refreshed.");
    }
    const polled = await waitForLeonardo(generation.jobId);
    if (polled.status === "pending") {
      sendJson(response, 202, { ok: true, generation, media: null });
      return;
    }
    if (polled.status !== "succeeded" || polled.imageUrls.length === 0) {
      const failed = await store.update(user.id, projectId, generation.id, {
        status: "failed",
        errorCode: "IMAGE_PROVIDER_FAILED",
      });
      sendJson(response, 200, { ok: true, generation: failed ?? generation, media: null });
      return;
    }
    try {
      const download = await downloadGeneratedImage(polled.imageUrls[0]);
      const media = await persistGeneratedImage(user.id, projectId, download.bytes, download.contentType);
      const updated = await store.update(user.id, projectId, generation.id, {
        status: "succeeded",
        mediaId: media.id,
        ...leonardoCost(null, polled.apiCreditCost, polled.cost, generation.providerCost),
      });
      sendJson(response, 200, { ok: true, generation: updated ?? generation, media });
    } catch (error) {
      const code =
        error instanceof HttpError || error instanceof ApiError ? error.code : "IMAGE_GENERATION_FAILED";
      await store
        .update(user.id, projectId, generation.id, { status: "failed", errorCode: code })
        .catch(() => undefined);
      throw error;
    }
  }

  async function handleStockImport(
    request: IncomingMessage,
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<void> {
    const store = requireMediaStore();
    const objects = requireMediaObjects();
    // Ownership is proven before a byte is downloaded for this project.
    await requireProjects().get(user.id, projectId);

    const write = parseStockImport(await readJsonBody(request, config.media.bodyBytes));

    // One provider asset and rendition is one media row per project: a repeat
    // import returns the stored asset instead of downloading and storing it again.
    const existing = await store.findImported(user.id, projectId, {
      provider: write.provider,
      providerId: write.providerId,
      rendition: write.rendition,
    });
    if (existing?.media.provenance) {
      sendJson(response, 200, {
        ok: true,
        media: existing.media,
        provenance: existing.media.provenance,
        reused: true,
      });
      return;
    }

    const bytes = await downloadStockAsset(
      { provider: write.provider, type: write.type, url: write.url },
      { limits: config.stock, fetchImpl, hostLookup: options.hostLookup },
    );
    if (bytes.length === 0) {
      throw new HttpError(422, "STOCK_IMPORT_EMPTY", "The downloaded asset was empty.");
    }
    const detected = detectMediaType(bytes);
    if (!detected || !mediaTypeMatches(write.type, detected)) {
      throw new HttpError(
        422,
        "STOCK_IMPORT_TYPE_MISMATCH",
        "The downloaded file is not a supported image or video of the selected type.",
      );
    }

    const used = await store.usedBytes(user.id);
    if (used + bytes.length > config.media.ownerStorageBytes) {
      throw new HttpError(
        413,
        "MEDIA_STORAGE_LIMIT",
        `This account's media storage limit is ${config.media.ownerStorageBytes} bytes.`,
      );
    }

    const provenance = buildStockProvenance(write, bytes.length, new Date(now()).toISOString());
    const mediaId = newMediaId();
    const objectKey = mediaObjectKey(user.id, mediaId);
    const upload = objects.presignPut(objectKey, config.media.uploadUrlSeconds);
    const uploadExpiresAt = new Date(
      now() + Math.min(config.media.uploadTtlMs, config.media.uploadUrlSeconds * 1000),
    ).toISOString();

    await store.createPending(user.id, projectId, {
      id: mediaId,
      kind: write.type,
      contentType: detected.contentType,
      byteSize: bytes.length,
      sceneKey: null,
      objectKey,
      uploadExpiresAt,
      provenance,
    });

    try {
      // The server, not the browser, moves the validated bytes into private
      // storage through a presigned URL it just created itself.
      const put = await (fetchImpl ?? fetch)(upload.url, {
        method: "PUT",
        headers: { "Content-Type": detected.contentType },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(config.stock.importTimeoutMs),
      });
      if (!put.ok) {
        throw new HttpError(502, "MEDIA_STORAGE_UNAVAILABLE", "The private media bucket rejected the imported asset.");
      }
      const head = await requireMediaBucket(() => objects.head(objectKey));
      if (head === null) {
        throw new HttpError(502, "MEDIA_STORAGE_UNAVAILABLE", "The imported asset was not found in the bucket.");
      }
      let media: MediaRecord;
      try {
        const marked = await store.markReady(user.id, projectId, mediaId, {
          contentType: detected.contentType,
          byteSize: head.byteSize,
        });
        if (!marked) {
          throw new HttpError(409, "MEDIA_STATE_CHANGED", "The imported asset changed while it was being stored.");
        }
        media = marked;
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "MEDIA_STORE_CONFLICT") throw error;
        // A parallel import completed first; its ready row is the canonical
        // asset. Drop this request's reservation and object, then reuse it.
        const winner = await store.findImported(user.id, projectId, {
          provider: write.provider,
          providerId: write.providerId,
          rendition: write.rendition,
        });
        if (!winner?.media.provenance) throw error;
        await discardMedia(store, objects, user.id, projectId, mediaId, objectKey);
        sendJson(response, 200, {
          ok: true,
          media: winner.media,
          provenance: winner.media.provenance,
          reused: true,
        });
        return;
      }
      sendJson(response, 201, { ok: true, media, provenance, reused: false });
    } catch (error) {
      await discardMedia(store, objects, user.id, projectId, mediaId, objectKey);
      throw error;
    }
  }

  async function handleProfile(request: IncomingMessage, response: ServerResponse): Promise<void> {
    checkOrigin(request);
    const user = await authenticate(request);
    const store = requireProfile();
    const method = request.method ?? "GET";

    if (method === "GET") {
      sendJson(response, 200, { ok: true, profile: await store.get(user.id) });
      return;
    }
    if (method === "PUT") {
      const body = await readJsonBody(request, PROFILE_LIMITS.bodyBytes);
      sendJson(response, 200, { ok: true, profile: await store.save(user.id, parseProfileUpdate(body)) });
      return;
    }
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or PUT for this endpoint.");
  }

  async function handleProjects(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    checkOrigin(request);
    const user = await authenticate(request);
    const store = requireProjects();
    const method = request.method ?? "GET";

    if (path === "/api/projects") {
      if (method === "GET") {
        const projects = await store.list(user.id, PROJECT_LIST_LIMIT);
        sendJson(response, 200, { ok: true, projects });
        return;
      }
      if (method === "POST") {
        const body = await readJsonBody(request, PROJECT_LIMITS.bodyBytes);
        const write = parseProjectWrite(body);
        // Media is scoped to an existing project, so a new project cannot
        // legitimately list any asset ids yet.
        if (write.document.scenes.some((scene) => scene.assetIds.length > 0)) {
          throw new HttpError(
            422,
            "MEDIA_ASSET_INVALID",
            "A new project cannot list scene asset ids. Create the project, upload the media, then save it.",
          );
        }
        const project = await store.create(user.id, write);
        sendJson(response, 201, { ok: true, project });
        return;
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for this endpoint.");
    }

    const segments = path.slice("/api/projects/".length).split("/");
    const projectId = segments[0];
    if (!isProjectId(projectId)) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_MESSAGE);
    }

    if (segments.length === 2 && segments[1] === "revisions") {
      if (method !== "GET") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET for this endpoint.");
      }
      // get() proves ownership before the revision table is queried at all.
      await store.get(user.id, projectId);
      const revisions = await store.listRevisions(user.id, projectId, PROJECT_REVISIONS_LIMIT);
      sendJson(response, 200, { ok: true, revisions });
      return;
    }

    if (segments.length === 2 && segments[1] === "export") {
      if (method !== "POST") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST to export the document you are editing.");
      }
      // Ownership first, then the draft the editor holds; attribution comes from
      // the stored media rows, never from the request body.
      await store.get(user.id, projectId);
      const write = parseProjectExportInput(await readJsonBody(request, PROJECT_LIMITS.bodyBytes));
      const media = await requireMediaStore().list(user.id, projectId, config.media.listLimit);
      sendJson(response, 200, {
        ok: true,
        export: buildProjectExport(write.title, write.document, media),
      });
      return;
    }

    if (segments.length === 3 && segments[1] === "planning" && segments[2] === "status") {
      if (method !== "GET") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET for the planning attempt status.");
      }
      await handlePlanningStatus(response, user, projectId);
      return;
    }

    if (segments.length === 2 && segments[1] === "planning") {
      if (method !== "POST") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST to generate a planning proposal.");
      }
      await handlePlanning(request, response, user, projectId);
      return;
    }

    if (segments.length === 3 && segments[1] === "stock" && segments[2] === "import") {
      if (method !== "POST") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST to import a stock asset.");
      }
      await handleStockImport(request, response, user, projectId);
      return;
    }

    if (segments.length === 4 && segments[1] === "proposals" && segments[3] === "accept") {
      if (method !== "POST") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST to accept a planning proposal.");
      }
      await handleProposalAccept(response, user, projectId, segments[2]);
      return;
    }

    if (segments.length === 2 && segments[1] === "image-generations") {
      if (method === "GET") {
        await handleImageGenerationList(response, user, projectId);
        return;
      }
      if (method === "POST") {
        await handleImageGenerate(response, user, projectId, request);
        return;
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for image generations.");
    }

    if (segments.length === 3 && segments[1] === "image-generations" && segments[2] === "estimate") {
      if (method !== "POST") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST to estimate an image generation.");
      }
      await handleImageEstimate(request, response, user, projectId);
      return;
    }

    if (segments.length === 4 && segments[1] === "image-generations" && segments[3] === "refresh") {
      if (method !== "POST") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST to refresh a pending generation.");
      }
      await handleImageRefresh(response, user, projectId, segments[2]);
      return;
    }

    if (segments.length === 4 && segments[1] === "image-generations" && segments[3] === "settle") {
      if (method !== "POST") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST to settle a pending generation.");
      }
      await handleImageSettle(response, user, projectId, segments[2]);
      return;
    }

    if (segments.length === 3 && segments[1] === "narration" && segments[2] === "preview") {
      if (method !== "POST") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST to preview a narration voice.");
      }
      await handleNarrationPreview(request, response, user, projectId);
      return;
    }

    if (segments.length === 3 && (segments[2] === "upload" || segments[2] === "attach")) {
      if (segments[1] !== "narration" && segments[1] !== "music") {
        throw new HttpError(404, "NOT_FOUND", "Unknown endpoint.");
      }
      if (method !== "POST") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST to attach an uploaded audio file.");
      }
      await handleAudioAttach(
        request,
        response,
        user,
        projectId,
        segments[1] === "music" ? "music" : "narration",
      );
      return;
    }

    if (segments.length === 2 && segments[1] === "narration") {
      if (method === "GET") {
        await handleNarrationState(response, user, projectId);
        return;
      }
      if (method === "POST") {
        await handleNarrationGenerate(request, response, user, projectId);
        return;
      }
      if (method === "PATCH") {
        await handleAudioSettings(request, response, user, projectId, "narration");
        return;
      }
      if (method === "DELETE") {
        await handleAudioRemove(response, user, projectId, "narration");
        return;
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET, POST, PATCH, or DELETE for narration.");
    }

    if (segments.length === 2 && segments[1] === "music") {
      if (method === "POST") {
        await handleAudioAttach(request, response, user, projectId, "music");
        return;
      }
      if (method === "PATCH") {
        await handleAudioSettings(request, response, user, projectId, "music");
        return;
      }
      if (method === "DELETE") {
        await handleAudioRemove(response, user, projectId, "music");
        return;
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST, PATCH, or DELETE for music.");
    }

    if (segments.length > 1 && segments[1] === "media") {
      await handleMedia(request, response, user, projectId, segments.slice(2));
      return;
    }

    if (segments.length > 1 && (segments[1] === "renders-v2" || segments[1] === "workflow" || segments[1] === "studio")) {
      await handleProjectWorkflowRoutes(request, response, user, projectId, segments.slice(1));
      return;
    }

    if (segments.length > 1) {
      const [, resource, childId, ...rest] = segments;
      if (rest.length > 0 || !CHILD_RESOURCES.has(resource)) {
        throw new HttpError(404, "NOT_FOUND", "Unknown endpoint.");
      }
      await handleChild(request, response, user, projectId, resource, childId);
      return;
    }

    if (method === "GET") {
      sendJson(response, 200, { ok: true, project: await store.get(user.id, projectId) });
      return;
    }
    if (method === "PUT") {
      const body = await readJsonBody(request, PROJECT_LIMITS.bodyBytes);
      const update = parseProjectUpdate(body);
      // Locked components are compared against the stored document, not the
      // client's version number, so no save path can overwrite them.
      const current = await store.get(user.id, projectId);
      assertSceneLocks(current.document, update.document);
      // The document's scene asset ids are the other half of the media link.
      // Refuse a save that would store an id with no ready media behind it, so
      // an API write cannot create a dangling reference.
      const assetIds = [...new Set(update.document.scenes.flatMap((scene) => scene.assetIds))];
      const malformed = assetIds.find((assetId) => !isMediaId(assetId));
      if (malformed) {
        throw new HttpError(422, "MEDIA_ASSET_INVALID", `Scene asset id ${malformed} is not a valid media id.`);
      }
      if (assetIds.length > 0) {
        const ready = await requireMediaStore().readyAssetIds(user.id, projectId, assetIds);
        const unknown = assetIds.find((assetId) => !ready.has(assetId));
        if (unknown) {
          throw new HttpError(
            422,
            "MEDIA_ASSET_INVALID",
            `Scene asset id ${unknown} is not ready media in this project.`,
          );
        }
      }
      const project = await store.update(user.id, projectId, update);
      sendJson(response, 200, { ok: true, project });
      return;
    }
    if (method === "DELETE") {
      // The rows cascade with the project, so their object keys are read first.
      // Cleanup is best effort after the delete: the alternative is a project
      // the caller cannot remove because the bucket is briefly unavailable.
      const objectKeys = mediaStore ? await mediaStore.listObjectKeys(user.id, projectId) : [];
      await store.remove(user.id, projectId);
      if (objectKeys.length > 0 && !mediaObjects) {
        log.error("[media] PROJECT_MEDIA_OBJECTS_SKIPPED");
      }
      if (mediaObjects) {
        for (const objectKey of objectKeys) {
          try {
            await mediaObjects.delete(objectKey);
          } catch {
            log.error("[media] R2_DELETE_FAILED");
          }
        }
      }
      sendJson(response, 200, { ok: true, deletedId: projectId });
      return;
    }
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET, PUT, or DELETE for this endpoint.");
  }

  function sendAudio(response: ServerResponse, bytes: Buffer, contentType: string): void {
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": String(bytes.length),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(bytes);
  }

  /** Generated audio goes through the same private-media path as an upload. */
  async function persistGeneratedAudio(
    ownerId: string,
    projectId: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<MediaRecord> {
    const store = requireMediaStore();
    const objects = requireMediaObjects();
    if (bytes.length > config.media.audioBytes) {
      throw new HttpError(413, "MEDIA_TOO_LARGE", "The narration audio exceeds the audio size limit.");
    }
    const mediaId = newMediaId();
    const objectKey = mediaObjectKey(ownerId, mediaId);
    const upload = objects.presignPut(objectKey, config.media.uploadUrlSeconds);
    const uploadExpiresAt = new Date(
      now() + Math.min(config.media.uploadTtlMs, config.media.uploadUrlSeconds * 1000),
    ).toISOString();
    await store.createPending(ownerId, projectId, {
      id: mediaId,
      kind: "audio",
      contentType,
      byteSize: bytes.length,
      sceneKey: null,
      objectKey,
      uploadExpiresAt,
      provenance: null,
    });
    try {
      const put = await (fetchImpl ?? fetch)(upload.url, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(config.narration.timeoutMs),
      });
      if (!put.ok) {
        throw new HttpError(502, "MEDIA_STORAGE_UNAVAILABLE", "Private storage rejected the narration audio.");
      }
      const head = await requireMediaBucket(() => objects.head(objectKey));
      if (head === null) {
        throw new HttpError(502, "MEDIA_STORAGE_UNAVAILABLE", "The narration audio was not stored.");
      }
      const media = await store.markReady(ownerId, projectId, mediaId, { contentType, byteSize: head.byteSize });
      if (!media) {
        throw new HttpError(409, "MEDIA_STATE_CHANGED", "The narration asset changed while it was stored.");
      }
      return media;
    } catch (error) {
      await discardMedia(store, objects, ownerId, projectId, mediaId, objectKey);
      throw error;
    }
  }

  async function protectAudio(ownerId: string, projectId: string, mediaId: string, trackId: string): Promise<void> {
    await requireMediaStore().addReference(ownerId, projectId, mediaId, {
      refKind: "document",
      refId: trackId,
    });
  }

  /** Replaced/removed audio stops protecting its file from retention. */
  async function releaseAudioReference(
    ownerId: string,
    projectId: string,
    track: NarrationTrack,
  ): Promise<void> {
    if (!track.mediaId) return;
    try {
      const references = await requireMediaStore().listReferences(ownerId, projectId, track.mediaId);
      const reference = references.find((item) => item.refKind === "document" && item.refId === track.id);
      if (reference) {
        await requireMediaStore().removeReference(ownerId, projectId, track.mediaId, reference.id);
      }
    } catch {
      log.error("[narration] AUDIO_REFERENCE_RELEASE_FAILED");
    }
  }

  function narrationTiming(track: NarrationTrack | null, targetSeconds: number): NarrationTiming | null {
    if (!track || track.durationSeconds === null || targetSeconds <= 0) return null;
    const differenceSeconds = Number((track.durationSeconds - targetSeconds).toFixed(3));
    return {
      narrationSeconds: track.durationSeconds,
      targetSeconds,
      differenceSeconds,
      mismatch: Math.abs(differenceSeconds) > Math.max(1.5, targetSeconds * 0.1),
    };
  }

  function narrationCost(characters: number): number {
    return Number(((characters / 1000) * DEEPGRAM_AURA2_USD_PER_1K_CHARS).toFixed(6));
  }

  function narrationUsageView(totals: NarrationUsageTotals): NarrationUsageSummary {
    const oldest = totals.oldestAt === null ? null : Date.parse(totals.oldestAt);
    return {
      windowHours: config.narration.usageWindowMs / (60 * 60 * 1000),
      previews: totals.previews,
      generations: totals.generations,
      characters: totals.characters,
      spentUsd: totals.spentUsd,
      limits: {
        characters: config.narration.dailyCharLimit > 0 ? config.narration.dailyCharLimit : null,
        usd: config.narration.dailyUsdLimit > 0 ? config.narration.dailyUsdLimit : null,
      },
      resetAt:
        oldest !== null && Number.isFinite(oldest)
          ? new Date(oldest + config.narration.usageWindowMs).toISOString()
          : null,
    };
  }

  function acquireNarrationSlot(ownerId: string): () => void {
    if (narrationInFlight.has(ownerId)) {
      throw new HttpError(
        429,
        "NARRATION_IN_FLIGHT",
        "A narration request is already running for this account. Wait for it to finish.",
      );
    }
    narrationInFlight.add(ownerId);
    return () => {
      narrationInFlight.delete(ownerId);
    };
  }

  /** Refuses before the provider call, then records the attempt before spending. */
  async function beginNarrationUsage(
    ownerId: string,
    projectId: string,
    kind: "preview" | "generation",
    characters: number,
  ): Promise<string> {
    if (!narrationSettings.apiKey) {
      throw new HttpError(
        503,
        "NARRATION_PROVIDER_DISABLED",
        "Deepgram narration is disabled because DEEPGRAM_API_KEY is not configured.",
      );
    }
    const store = requireNarrationUsageStore();
    const charactersLimit = config.narration.dailyCharLimit;
    const cost = narrationCost(characters);
    const usdLimit = config.narration.dailyUsdLimit;
    const reservation = await store.reserve(
      ownerId,
      projectId,
      {
        kind,
        characters,
        costUsd: cost,
        rateVersion: DEEPGRAM_RATE_VERSION,
      },
      {
        characters: charactersLimit,
        usd: usdLimit,
        windowSeconds: Math.floor(config.narration.usageWindowMs / 1000),
      },
    );
    if (!reservation.allowed) {
      const characterBlocked =
        charactersLimit > 0 && reservation.charactersUsed + characters > charactersLimit;
      throw new HttpError(
        429,
        "NARRATION_SPEND_LIMIT",
        characterBlocked
          ? `This account has ${reservation.charactersUsed} narration characters in the last 24 hours of ${charactersLimit}; this request needs ${characters} more.`
          : `Narration spend for the last 24 hours is $${reservation.spentUsd.toFixed(4)} of $${usdLimit.toFixed(2)}; this request would exceed the limit.`,
      );
    }
    if (!reservation.usageId) {
      throw new HttpError(
        503,
        "NARRATION_USAGE_UNAVAILABLE",
        "The narration usage ledger did not return the reserved row.",
      );
    }
    return reservation.usageId;
  }

  async function settleNarrationUsage(
    ownerId: string,
    usageId: string,
    status: "succeeded" | "failed",
  ): Promise<void> {
    // A ledger write must not throw away audio the provider already produced.
    await requireNarrationUsageStore()
      .settle(ownerId, usageId, status)
      .catch(() => log.error("[narration] NARRATION_USAGE_SETTLE_FAILED"));
  }

  async function handleNarrationVoices(request: IncomingMessage, response: ServerResponse): Promise<void> {
    checkOrigin(request);
    await authenticate(request);
    sendJson(response, 200, {
      ok: true,
      configured: narrationSettings.apiKey !== null,
      provider: "deepgram",
      modelFamily: "aura-2",
      maxChars: NARRATION_MAX_CHARS,
      usdPer1kChars: DEEPGRAM_AURA2_USD_PER_1K_CHARS,
      rateVersion: DEEPGRAM_RATE_VERSION,
      wordTimestamps: false,
      voices: NARRATION_VOICES,
    });
  }

  async function handleNarrationState(
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<void> {
    const project = await requireProjects().get(user.id, projectId);
    const active = await requireNarrationStore().active(user.id, projectId);
    const totals = await requireNarrationUsageStore().totalsSince(
      user.id,
      new Date(now() - config.narration.usageWindowMs).toISOString(),
    );
    const { script, blocked } = readNarrationScript(project.document);
    const stale =
      active.narration !== null &&
      script !== null &&
      active.narration.scriptFingerprint !== null &&
      active.narration.scriptFingerprint !== script.fingerprint;
    const body: NarrationStateResponse = {
      ok: true,
      narration: active.narration,
      music: active.music,
      script,
      scriptBlocked: blocked,
      stale,
      timing: script ? narrationTiming(active.narration, script.targetSeconds) : null,
      limits: {
        maxChars: NARRATION_MAX_CHARS,
        usdPer1kChars: DEEPGRAM_AURA2_USD_PER_1K_CHARS,
        rateVersion: DEEPGRAM_RATE_VERSION,
      },
      usage: narrationUsageView(totals),
    };
    sendJson(response, 200, body);
  }

  async function handleNarrationPreview(
    request: IncomingMessage,
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<void> {
    await requireProjects().get(user.id, projectId);
    const input = parseNarrationGenerateInput(await readJsonBody(request, PROJECT_LIMITS.bodyBytes));
    const characters = Array.from(DEEPGRAM_PREVIEW_TEXT).length;
    const release = acquireNarrationSlot(user.id);
    let usageId: string | null = null;
    let providerSucceeded = false;
    try {
      usageId = await beginNarrationUsage(user.id, projectId, "preview", characters);
      const speech = await synthesizeSpeech({
        settings: narrationSettings,
        voiceModel: input.voiceModel,
        text: DEEPGRAM_PREVIEW_TEXT,
        fetchImpl,
        timeoutMs: config.narration.timeoutMs,
        maxBytes: Math.min(config.narration.maxAudioBytes, config.media.audioBytes),
      });
      providerSucceeded = true;
      await settleNarrationUsage(user.id, usageId, "succeeded");
      sendAudio(response, speech.bytes, speech.contentType);
    } catch (error) {
      if (usageId && !providerSucceeded) await settleNarrationUsage(user.id, usageId, "failed");
      throw error;
    } finally {
      release();
    }
  }

  async function handleNarrationGenerate(
    request: IncomingMessage,
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<void> {
    const input = parseNarrationGenerateInput(await readJsonBody(request, PROJECT_LIMITS.bodyBytes));
    const project = await requireProjects().get(user.id, projectId);
    const script = buildNarrationScript(project.document);
    const voice = findNarrationVoice(input.voiceModel);
    if (!voice) throw new HttpError(400, "INVALID_VOICE", "Choose one of the listed Deepgram Aura-2 voices.");
    const release = acquireNarrationSlot(user.id);
    let usageId: string | null = null;
    let providerSucceeded = false;
    try {
      usageId = await beginNarrationUsage(user.id, projectId, "generation", script.characters);
      const speech = await synthesizeSpeech({
        settings: narrationSettings,
        voiceModel: voice.model,
        text: script.text,
        fetchImpl,
        timeoutMs: config.narration.timeoutMs,
        maxBytes: Math.min(config.narration.maxAudioBytes, config.media.audioBytes),
      });
      providerSucceeded = true;
      await settleNarrationUsage(user.id, usageId, "succeeded");
      const durationSeconds = await measureAudioDuration(speech.bytes, speech.contentType);
      if (durationSeconds === null) {
        throw new HttpError(
          422,
          "NARRATION_AUDIO_UNMEASURABLE",
          "The provider audio duration could not be measured, so this narration was not saved.",
        );
      }
      const media = await persistGeneratedAudio(user.id, projectId, speech.bytes, speech.contentType);
      const trackId = randomUUID();
      try {
        await protectAudio(user.id, projectId, media.id, trackId);
        const created = await requireNarrationStore().create(user.id, projectId, {
          id: trackId,
          kind: "narration",
          source: "deepgram",
          mediaId: media.id,
          voiceModel: voice.model,
          voiceName: voice.name,
          scriptFingerprint: script.fingerprint,
          scriptCharacters: script.characters,
          durationSeconds,
          costUsd: speech.costUsd,
          costRateVersion: speech.rateVersion,
        });
        for (const replaced of created.replaced) {
          await releaseAudioReference(user.id, projectId, replaced);
        }
        sendJson(response, 201, { ok: true, track: created.track, media });
        return;
      } catch (error) {
        await releaseAudioReference(user.id, projectId, {
          id: trackId,
          mediaId: media.id,
        } as NarrationTrack);
        await discardMedia(
          requireMediaStore(),
          requireMediaObjects(),
          user.id,
          projectId,
          media.id,
          mediaObjectKey(user.id, media.id),
        );
        throw error;
      }
    } catch (error) {
      if (usageId && !providerSucceeded) await settleNarrationUsage(user.id, usageId, "failed");
      throw error;
    } finally {
      release();
    }
  }

  async function handleAudioAttach(
    request: IncomingMessage,
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
    kind: NarrationKind,
  ): Promise<void> {
    const input = parseAudioAttachInput(await readJsonBody(request, PROJECT_LIMITS.bodyBytes));
    const project = await requireProjects().get(user.id, projectId);
    const script = kind === "narration" ? buildNarrationScript(project.document) : null;
    const store = requireMediaStore();
    const stored = await store.get(user.id, projectId, input.mediaId);
    if (!stored || stored.media.status !== "ready" || stored.media.kind !== "audio") {
      throw new HttpError(
        422,
        "AUDIO_ASSET_INVALID",
        "Choose a ready audio file from this project for narration or music.",
      );
    }
    if (stored.media.byteSize > config.media.audioBytes) {
      throw new HttpError(413, "MEDIA_TOO_LARGE", "The selected audio exceeds the audio size limit.");
    }
    const bytes = await requireMediaBucket(() => requireMediaObjects().get(stored.objectKey));
    if (!bytes) throw new HttpError(503, "MEDIA_STORAGE_UNAVAILABLE", "The selected audio could not be read.");
    const durationSeconds = await measureAudioDuration(bytes, stored.media.contentType);
    if (durationSeconds === null) {
      throw new HttpError(422, "NARRATION_AUDIO_UNMEASURABLE", "The selected audio duration could not be measured.");
    }

    const trackId = randomUUID();
    try {
      await protectAudio(user.id, projectId, input.mediaId, trackId);
      const created = await requireNarrationStore().create(user.id, projectId, {
        id: trackId,
        kind,
        source: "upload",
        mediaId: input.mediaId,
        voiceModel: null,
        voiceName: null,
        scriptFingerprint: script?.fingerprint ?? null,
        scriptCharacters: script?.characters ?? null,
        durationSeconds,
        costUsd: null,
        costRateVersion: null,
      });
      for (const replaced of created.replaced) {
        await releaseAudioReference(user.id, projectId, replaced);
      }
      sendJson(response, 201, { ok: true, track: created.track, media: stored.media });
    } catch (error) {
      await releaseAudioReference(user.id, projectId, { id: trackId, mediaId: input.mediaId } as NarrationTrack);
      throw error;
    }
  }

  async function handleAudioSettings(
    request: IncomingMessage,
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
    kind: NarrationKind,
  ): Promise<void> {
    await requireProjects().get(user.id, projectId);
    const patch = parseAudioSettings(await readJsonBody(request, PROJECT_LIMITS.bodyBytes));
    const track = await requireNarrationStore().updateActive(user.id, projectId, kind, patch);
    if (!track) throw new HttpError(404, "AUDIO_TRACK_NOT_FOUND", `This project has no active ${kind} track.`);
    sendJson(response, 200, { ok: true, track });
  }

  async function handleAudioRemove(
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
    kind: NarrationKind,
  ): Promise<void> {
    await requireProjects().get(user.id, projectId);
    const track = await requireNarrationStore().removeActive(user.id, projectId, kind);
    if (!track) throw new HttpError(404, "AUDIO_TRACK_NOT_FOUND", `This project has no active ${kind} track.`);
    await releaseAudioReference(user.id, projectId, track);
    sendJson(response, 200, { ok: true, track });
  }

  async function handleMedia(
    request: IncomingMessage,
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
    rest: string[],
  ): Promise<void> {
    const store = requireMediaStore();
    const objects = requireMediaObjects();
    const method = request.method ?? "GET";

    // Same ownership rule as every other project route: a foreign project id is
    // answered exactly like a missing one, before any media row is read.
    const project = await requireProjects().get(user.id, projectId);
    await maybeSweepMedia();

    if (rest.length === 0) {
      if (method === "GET") {
        const media = await store.list(user.id, projectId, config.media.listLimit);
        sendJson(response, 200, { ok: true, media });
        return;
      }
      if (method === "POST") {
        const write = parseMediaInitiate(await readJsonBody(request, config.media.bodyBytes), config.media);

        const used = await store.usedBytes(user.id);
        if (used + write.byteSize > config.media.ownerStorageBytes) {
          throw new HttpError(
            413,
            "MEDIA_STORAGE_LIMIT",
            `This account's media storage limit is ${config.media.ownerStorageBytes} bytes.`,
          );
        }

        const mediaId = newMediaId();
        const objectKey = mediaObjectKey(user.id, mediaId);
        const upload = objects.presignPut(objectKey, config.media.uploadUrlSeconds);
        // The upload window can be shorter than the signed URL's lifetime; both bounds apply.
        const uploadExpiresAt = new Date(
          now() + Math.min(config.media.uploadTtlMs, config.media.uploadUrlSeconds * 1000),
        ).toISOString();

        const media = await store.createPending(user.id, projectId, {
          id: mediaId,
          kind: write.kind,
          contentType: write.contentType,
          byteSize: write.byteSize,
          sceneKey: write.sceneKey,
          objectKey,
          uploadExpiresAt,
        });

        sendJson(response, 201, {
          ok: true,
          media,
          upload: {
            url: upload.url,
            method: "PUT",
            headers: { "Content-Type": write.contentType },
            expiresAt: upload.expiresAt,
          },
        });
        return;
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for the media of a project.");
    }

    const [mediaId, action, referenceId, ...extra] = rest;
    if (!isChildId(mediaId) || extra.length > 0) {
      throw new HttpError(404, "MEDIA_NOT_FOUND", MEDIA_NOT_FOUND_MESSAGE);
    }

    const stored = await store.get(user.id, projectId, mediaId);
    if (!stored) {
      throw new HttpError(404, "MEDIA_NOT_FOUND", MEDIA_NOT_FOUND_MESSAGE);
    }
    const row = stored.media;
    const objectKey = stored.objectKey;

    if (action === undefined) {
      if (method === "GET") {
        sendJson(response, 200, {
          ok: true,
          media: row,
          references: await store.listReferences(user.id, projectId, mediaId),
        });
        return;
      }
      if (method === "DELETE") {
        if (row.status === "deleted") {
          sendJson(response, 200, { ok: true, deletedId: mediaId });
          return;
        }
        // References and document asset ids are separate links. A saved scene
        // can still list the asset after its reference is gone (for example a
        // release followed by a failed project save), so refuse to strand it.
        if (project.document.scenes.some((scene) => scene.assetIds.includes(mediaId))) {
          throw new HttpError(
            409,
            "MEDIA_ASSET_IN_DOCUMENT",
            "This asset is still listed in the saved project document. Detach it and save the project before deleting it.",
          );
        }
        // A shared asset is removed only after its last reference is released.
        const references = row.referenceCount + (row.sceneKey === null ? 0 : 1);
        if (references > 0) {
          throw new HttpError(
            409,
            "MEDIA_IN_USE",
            `This media is still referenced ${references} time(s). Remove those references before deleting it.`,
          );
        }
        if (!(await store.markDeleted(user.id, projectId, mediaId))) {
          throw new HttpError(409, "MEDIA_STATE_CHANGED", "This media changed while it was being deleted.");
        }
        // The row is already deleted, so a bucket failure cannot expose a ready
        // row without its object; retention retries the object removal.
        try {
          await objects.delete(objectKey);
        } catch {
          log.error("[media] R2_DELETE_FAILED");
        }
        sendJson(response, 200, { ok: true, deletedId: mediaId });
        return;
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or DELETE for one media record.");
    }

    if (action === "complete") {
      if (method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST to complete an upload.");

      if (row.status === "deleted") {
        throw new HttpError(409, "MEDIA_DELETED", "This media was deleted; start a new upload.");
      }
      if (row.status === "ready") {
        sendJson(response, 200, { ok: true, media: row });
        return;
      }
      if (row.uploadExpiresAt !== null && Date.parse(row.uploadExpiresAt) <= now()) {
        await discardMedia(store, objects, user.id, projectId, row.id, objectKey);
        throw new HttpError(409, "MEDIA_UPLOAD_EXPIRED", "This upload window has expired; start a new upload.");
      }

      const head = await requireMediaBucket(() => objects.head(objectKey));
      if (head === null) {
        throw new HttpError(409, "MEDIA_OBJECT_MISSING", "The uploaded object was not found in the bucket.");
      }
      if (head.byteSize === 0) {
        await discardMedia(store, objects, user.id, projectId, row.id, objectKey);
        throw new HttpError(422, "MEDIA_EMPTY", "The uploaded object is empty.");
      }
      if (head.byteSize > row.byteSize) {
        await discardMedia(store, objects, user.id, projectId, row.id, objectKey);
        throw new HttpError(409, "MEDIA_SIZE_MISMATCH", "The uploaded object is larger than the declared size.");
      }
      const declaredLimit = limitForKind(config.media, row.kind);
      if (head.byteSize > declaredLimit) {
        await discardMedia(store, objects, user.id, projectId, row.id, objectKey);
        throw new HttpError(413, "MEDIA_TOO_LARGE", `This upload exceeds the ${declaredLimit}-byte limit.`);
      }

      const leading = await requireMediaBucket(() => objects.readRange(objectKey, config.media.sniffBytes));
      if (leading === null) {
        throw new HttpError(409, "MEDIA_OBJECT_MISSING", "The uploaded object was not found in the bucket.");
      }
      const detected = detectMediaType(leading);
      if (!detected || !mediaTypeMatches(row.kind, detected)) {
        await discardMedia(store, objects, user.id, projectId, row.id, objectKey);
        throw new HttpError(
          422,
          "MEDIA_TYPE_MISMATCH",
          "The uploaded file is not a supported image, audio, or video of the declared kind.",
        );
      }

      const media = await store.markReady(user.id, projectId, mediaId, {
        contentType: detected.contentType,
        byteSize: head.byteSize,
      });
      if (!media) {
        throw new HttpError(409, "MEDIA_STATE_CHANGED", "This upload changed while it was being completed.");
      }
      sendJson(response, 200, { ok: true, media });
      return;
    }

    if (action === "url") {
      if (method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET for a playback URL.");
      if (row.status !== "ready") {
        throw new HttpError(409, "MEDIA_NOT_READY", "This media is not ready for playback yet.");
      }
      const head = await requireMediaBucket(() => objects.head(objectKey));
      if (head === null) {
        throw new HttpError(409, "MEDIA_OBJECT_MISSING", "The stored object is missing from the bucket.");
      }
      const playback = objects.presignGet(objectKey, config.media.downloadUrlSeconds);
      sendJson(response, 200, {
        ok: true,
        url: playback.url,
        expiresAt: playback.expiresAt,
        contentType: row.contentType,
        byteSize: head.byteSize,
      });
      return;
    }

    if (action === "references") {
      if (referenceId === undefined) {
        if (method === "GET") {
          sendJson(response, 200, {
            ok: true,
            references: await store.listReferences(user.id, projectId, mediaId),
          });
          return;
        }
        if (method === "POST") {
          if (row.status !== "ready") {
            throw new HttpError(409, "MEDIA_NOT_READY", "Only ready media can be referenced.");
          }
          const write = parseMediaReferenceWrite(await readJsonBody(request, config.media.bodyBytes));
          const reference = await store.addReference(user.id, projectId, mediaId, write);
          sendJson(response, 201, { ok: true, reference });
          return;
        }
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for media references.");
      }

      if (method !== "DELETE") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use DELETE for one media reference.");
      if (!isChildId(referenceId)) {
        throw new HttpError(404, "MEDIA_REFERENCE_NOT_FOUND", "No reference with that id belongs to this media.");
      }
      if (!(await store.removeReference(user.id, projectId, mediaId, referenceId))) {
        throw new HttpError(404, "MEDIA_REFERENCE_NOT_FOUND", "No reference with that id belongs to this media.");
      }
      sendJson(response, 200, { ok: true, deletedId: referenceId });
      return;
    }

    throw new HttpError(404, "NOT_FOUND", "Unknown endpoint.");
  }

  function planningAttemptIsStale(createdAt: string): boolean {
    const startedAtMs = Date.parse(createdAt);
    return !Number.isFinite(startedAtMs) || now() - startedAtMs >= config.planningAbandonAfterMs;
  }

  /** Preflight result for this project; the project lookup proves ownership first. */
  async function handlePlanningStatus(
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<void> {
    await requireProjects().get(user.id, projectId);
    let pending;
    try {
      pending = await requireLedger().findPendingProjectAttempt(user.id, projectId);
    } catch (error) {
      if (error instanceof UsageLedgerError) {
        throw new HttpError(503, "LEDGER_UNAVAILABLE", "The usage ledger is temporarily unavailable.");
      }
      throw error;
    }
    const live = pending && !planningAttemptIsStale(pending.createdAt) ? pending : null;
    const body: PlanningAttemptStatusResponse = {
      ok: true,
      inFlight: live !== null,
      idempotencyKey: live?.idempotencyKey ?? null,
      startedAt: live?.createdAt ?? null,
      abandonAfterMs: config.planningAbandonAfterMs,
    };
    sendJson(response, 200, body);
  }

  /**
   * Blocks a different key while this project has a live pending attempt. A
   * stale row is settled first so the partial unique index cannot deadlock a
   * project after a crashed process. The unique index still decides any race.
   */
  async function assertNoOtherProjectAttempt(
    ledger: UsageLedger,
    userId: string,
    projectId: string,
    idempotencyKey: string,
  ): Promise<void> {
    let pending;
    try {
      pending = await ledger.findPendingProjectAttempt(userId, projectId);
    } catch (error) {
      if (error instanceof UsageLedgerError) {
        throw new HttpError(503, "LEDGER_UNAVAILABLE", "The usage ledger is temporarily unavailable.");
      }
      throw error;
    }
    if (!pending || pending.idempotencyKey === idempotencyKey) return;
    if (!planningAttemptIsStale(pending.createdAt)) {
      throw new HttpError(
        409,
        "PLANNING_ATTEMPT_IN_FLIGHT",
        "Another planning attempt for this project is already in progress. Wait for it to finish or for its lease to expire.",
      );
    }

    const body = failure("REQUEST_ABANDONED", ABANDONED_MESSAGE);
    try {
      await ledger.abandon({
        id: pending.id,
        userId,
        startedBefore: new Date(now() - config.planningAbandonAfterMs).toISOString(),
        completion: {
          status: "error",
          returnedModel: null,
          promptEvalCount: null,
          evalCount: null,
          latencyMs: 0,
          errorCode: "REQUEST_ABANDONED",
          upstreamStatus: null,
          responseStatus: 409,
          responseBody: body,
        },
      });
    } catch (error) {
      if (error instanceof UsageLedgerError) {
        throw new HttpError(503, "LEDGER_UNAVAILABLE", "The usage ledger is temporarily unavailable.");
      }
      throw error;
    }

    let reread;
    try {
      reread = await ledger.findPendingProjectAttempt(userId, projectId);
    } catch (error) {
      if (error instanceof UsageLedgerError) {
        throw new HttpError(503, "LEDGER_UNAVAILABLE", "The usage ledger is temporarily unavailable.");
      }
      throw error;
    }
    if (reread && reread.idempotencyKey !== idempotencyKey && !planningAttemptIsStale(reread.createdAt)) {
      throw new HttpError(
        409,
        "PLANNING_ATTEMPT_IN_FLIGHT",
        "Another planning attempt for this project is already in progress. Wait for it to finish or for its lease to expire.",
      );
    }
  }

  async function handlePlanning(
    request: IncomingMessage,
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<void> {
    const project = await requireProjects().get(user.id, projectId);
    const usageLedger = requireLedger();
    const idempotencyKey = readIdempotencyKey(request);
    const children = requireChildren();
    const start = parsePlanningStart(await readJsonBody(request, PLANNING_BODY_BYTES), project.version);
    const route = findPlanningRoute(config.planning.routes, start.route);
    if (!route || !route.available || !route.requestId) {
      throw new HttpError(
        503,
        "PLANNING_ROUTE_UNAVAILABLE",
        route?.reason ?? `No model is configured for the ${start.route} route.`,
      );
    }

    const supplied = (await children.listSources(user.id, projectId))
      .filter((source) => source.excerpt !== null && source.excerpt.trim().length > 0)
      .slice(0, PLANNING_LIMITS.sourcesProvided);

    // Factual mode and transcript analysis cannot be honest without evidence:
    // return planning notes instead of asking a model to invent a sourced script.
    const needsEvidence = project.document.brief.mode === "factual" || start.route === "transcript-analysis";
    if (needsEvidence && supplied.length === 0) {
      const payload = insufficientEvidencePayload(start.route);
      const proposal = await children.createProposal(user.id, projectId, {
        modelId: route.modelId ?? "none",
        prompt: "No provider call: no source excerpt was supplied.",
        sceneKey: null,
        route: start.route,
        baseVersion: project.version,
        proposal: payload as unknown as Record<string, unknown>,
      });
      sendJson(response, 201, { ok: true, proposal });
      return;
    }

    if (!config.apiKey) {
      throw new HttpError(
        503,
        "PROVIDER_NOT_CONFIGURED",
        "OLLAMA_API_KEY is not configured on the server. Add it to the server environment and restart.",
      );
    }

    const prompt = buildPlanningPrompt({
      route: start.route,
      instruction: start.instruction,
      projectType: project.projectType,
      document: project.document,
      sources: supplied,
      inputLimitChars: route.inputLimitChars,
    });

    // Planning is billable, so one Idempotency-Key owns one attempt. The key is
    // reserved before the provider is contacted; a retry replays the stored
    // proposal or refusal instead of paying for a second answer.
    // The project is part of the key scope: two projects can hold identical
    // documents, and a replayed proposal must never cross that boundary.
    const requestHash = hashRequest(`${start.route}:${route.requestId}:${projectId}`, prompt);

    await assertNoOtherProjectAttempt(usageLedger, user.id, projectId, idempotencyKey);

    beginProviderRequest(user.id);
    try {
      let reservation: ReservationResult;
      try {
        reservation = await usageLedger.reserve({
          userId: user.id,
          idempotencyKey,
          requestHash,
          modelId: route.modelId ?? "unknown",
          configuredModel: route.requestId,
          projectId,
        });
      } catch (error) {
        if (error instanceof UsageLedgerError) {
          throw new HttpError(
            503,
            "LEDGER_UNAVAILABLE",
            "The usage ledger is not ready. Apply the ai_usage migrations and check SUPABASE_SERVICE_ROLE_KEY.",
          );
        }
        throw error;
      }

      if (reservation.state === "existing") {
        try {
          await replayReservation(usageLedger, user, idempotencyKey, requestHash, response, reservation.usage);
        } catch (error) {
          if (error instanceof UsageLedgerError) {
            throw new HttpError(503, "LEDGER_UNAVAILABLE", "The usage ledger is temporarily unavailable.");
          }
          throw error;
        }
        return;
      }
      if (reservation.state === "project_busy") {
        throw new HttpError(
          409,
          "PLANNING_ATTEMPT_IN_FLIGHT",
          "Another planning attempt for this project is already in progress. Wait for it to finish or for its lease to expire.",
        );
      }

      const startedAt = now();
      let generation;
      try {
        generation = await generatePlanningPayload({
          route: start.route,
          requestId: route.requestId,
          apiKey: config.apiKey,
          prompt,
          timeoutMs: config.providerTimeoutMs,
          maxOutputTokens: route.outputTokenLimit,
          fetchImpl,
          context: {
            route: start.route,
            projectType: project.projectType,
            document: project.document,
            sources: supplied,
          },
        });
        await recordModelOutcome(route.modelId ?? "unknown", "success");
      } catch (error) {
        const providerError = error instanceof ProviderError ? error : null;
        const planningError = error instanceof PlanningInvalidError ? error : null;
        const code = providerError?.code ?? (error instanceof ApiError ? error.code : "INTERNAL_ERROR");
        const message = error instanceof Error ? error.message : "Unexpected server error.";
        const status = providerError?.status ?? (error instanceof ApiError ? error.status : 500);
        await recordModelOutcome(route.modelId ?? "unknown", "failure", code);
        await recordOutcome(usageLedger, user.id, reservation.id, {
          status: "error",
          returnedModel: planningError?.returnedModel ?? null,
          promptEvalCount: planningError?.usage?.promptEvalCount ?? null,
          evalCount: planningError?.usage?.evalCount ?? null,
          latencyMs: planningError?.latencyMs ?? Math.max(0, now() - startedAt),
          errorCode: code,
          upstreamStatus: providerError?.upstreamStatus ?? null,
          responseStatus: status,
          responseBody: failure(code, message, providerError?.upstreamStatus),
        });
        throw error;
      }

      let proposal;
      try {
        proposal = await children.createProposal(user.id, projectId, {
          modelId: route.modelId ?? "unknown",
          prompt,
          sceneKey: null,
          route: start.route,
          baseVersion: project.version,
          proposal: generation.payload as unknown as Record<string, unknown>,
        });
      } catch (error) {
        await recordOutcome(usageLedger, user.id, reservation.id, {
          status: "error",
          returnedModel: generation.returnedModel,
          promptEvalCount: generation.usage.promptEvalCount,
          evalCount: generation.usage.evalCount,
          latencyMs: generation.latencyMs,
          errorCode: "PROPOSAL_WRITE_FAILED",
          responseStatus: 500,
          responseBody: failure(
            "PROPOSAL_WRITE_FAILED",
            error instanceof Error ? error.message : "The proposal could not be stored.",
          ),
        });
        throw error;
      }

      const successBody = { ok: true, proposal };
      const recorded = await recordOutcome(usageLedger, user.id, reservation.id, {
        status: "success",
        returnedModel: generation.returnedModel,
        promptEvalCount: generation.usage.promptEvalCount,
        evalCount: generation.usage.evalCount,
        latencyMs: generation.latencyMs,
        responseStatus: 201,
        responseBody: successBody,
      });
      sendJson(
        response,
        201,
        successBody,
        recorded ? undefined : { "X-Storyframe-Usage": "unrecorded" },
      );
    } finally {
      endProviderRequest(user.id);
    }
  }

  /**
   * Replays a stored planning reservation with the same rules as the connection
   * test: the same request only, a live attempt is not overridden, a stale
   * attempt is settled without calling the provider, and a completed attempt
   * returns its stored body and status.
   */
  async function replayReservation(
    target: UsageLedger,
    user: AuthenticatedUser,
    idempotencyKey: string,
    requestHash: string,
    response: ServerResponse,
    initial: ExistingUsage,
  ): Promise<void> {
    if (initial.requestHash !== requestHash) {
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "This idempotency key was already used for a different request.",
      );
    }

    let existing = initial;
    if (existing.status === "pending") {
      if (!planningAttemptIsStale(existing.createdAt)) {
        throw new HttpError(
          409,
          "IDEMPOTENCY_IN_PROGRESS",
          "A request with this idempotency key is still in progress.",
        );
      }

      const body = failure("REQUEST_ABANDONED", ABANDONED_MESSAGE);
      const settled = await target.abandon({
        id: existing.id,
        userId: user.id,
        startedBefore: new Date(now() - config.planningAbandonAfterMs).toISOString(),
        completion: {
          status: "error",
          returnedModel: null,
          promptEvalCount: null,
          evalCount: null,
          latencyMs: 0,
          errorCode: "REQUEST_ABANDONED",
          upstreamStatus: null,
          responseStatus: 409,
          responseBody: body,
        },
      });
      if (settled) {
        sendJson(response, 409, body);
        return;
      }

      const reread = await target.lookup(user.id, idempotencyKey);
      if (!reread) {
        throw new HttpError(503, "LEDGER_UNAVAILABLE", "The usage ledger is temporarily unavailable.");
      }
      existing = reread;
      if (existing.status === "pending") {
        throw new HttpError(
          409,
          "IDEMPOTENCY_IN_PROGRESS",
          "A request with this idempotency key is still in progress.",
        );
      }
    }

    if (!existing.responseBody || typeof existing.responseBody !== "object") {
      throw new HttpError(
        503,
        "IDEMPOTENCY_REPLAY_UNAVAILABLE",
        "The original response for this idempotency key is unavailable.",
      );
    }
    sendJson(
      response,
      existing.responseStatus ?? (existing.status === "success" ? 200 : 502),
      existing.responseBody,
    );
  }

  async function handleProposalAccept(
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
    proposalId: string,
  ): Promise<void> {
    if (!isChildId(proposalId)) {
      throw new HttpError(404, "CHILD_RECORD_NOT_FOUND", "No generation proposal with that id is owned by this account.");
    }
    const projects = requireProjects();
    const children = requireChildren();
    const project = await projects.get(user.id, projectId);
    const proposal = await children.getProposal(user.id, projectId, proposalId);

    if (proposal.status !== "proposed") {
      throw new HttpError(409, "PROPOSAL_NOT_PENDING", "This proposal was already accepted or rejected.");
    }
    if (proposal.baseVersion !== project.version) {
      throw new HttpError(
        409,
        "PROPOSAL_STALE",
        `This proposal was generated from version ${proposal.baseVersion}; the project is now at version ${project.version}. Generate a new proposal.`,
      );
    }
    const payload = proposal.proposal as unknown as PlanningPayload;
    if (
      proposal.route === "legacy" ||
      payload.route !== proposal.route ||
      !Array.isArray(payload.scenes) ||
      !Array.isArray(payload.angles) ||
      !Array.isArray(payload.clips) ||
      !Array.isArray(payload.claims) ||
      typeof payload.insufficientEvidence !== "boolean"
    ) {
      throw new HttpError(
        409,
        "PROPOSAL_NOT_APPLICABLE",
        "This proposal has no applying planning payload. Mark it accepted or rejected with PATCH instead.",
      );
    }

    const applied = applyPlanningProposal(project.document, payload);
    let updatedProject = project;
    if (applied.document !== project.document) {
      assertSceneLocks(project.document, applied.document);
      updatedProject = await projects.update(user.id, projectId, {
        title: project.title,
        document: applied.document,
        version: project.version,
      });
    }

    const accepted = await children.updateProposal(user.id, projectId, proposalId, { status: "accepted" });

    let claimsRecorded = true;
    for (const claim of payload.claims) {
      try {
        await children.createClaim(
          user.id,
          projectId,
          {
            statement: claim.statement,
            sourceId: claim.sourceId,
            sceneKey: null,
            quote: claim.quote.length > 0 ? claim.quote : null,
          },
          claim.supported ? "supported" : "unverified",
        );
      } catch {
        claimsRecorded = false;
      }
    }
    if (!claimsRecorded) log.error("[planning] CLAIMS_WRITE_FAILED");

    sendJson(response, 200, {
      ok: true,
      proposal: accepted,
      project: updatedProject,
      claimsRecorded,
    });
  }

  /** Removes an object that failed validation, then settles its row as deleted. */
  async function discardMedia(
    store: MediaStore,
    objects: R2Client,
    ownerId: string,
    projectId: string,
    mediaId: string,
    objectKey: string,
  ): Promise<void> {
    try {
      await objects.delete(objectKey);
    } catch {
      log.error("[media] R2_DELETE_FAILED");
    }
    await store.markDeleted(ownerId, projectId, mediaId).catch(() => undefined);
  }

  async function handleChild(
    request: IncomingMessage,
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
    resource: string,
    childId: string | undefined,
  ): Promise<void> {
    const children = requireChildren();
    const method = request.method ?? "GET";

    // Explicit ownership check before any child query: a foreign project id is
    // answered exactly like a missing one, and no child row is read from it.
    await requireProjects().get(user.id, projectId);

    if (childId !== undefined && !isChildId(childId)) {
      throw new HttpError(404, "CHILD_RECORD_NOT_FOUND", "No record with that id is owned by this account.");
    }

    if (resource === "scenes") {
      if (childId !== undefined) throw new HttpError(404, "NOT_FOUND", "Unknown endpoint.");
      if (method === "GET") {
        sendJson(response, 200, { ok: true, scenes: await children.listScenes(user.id, projectId) });
        return;
      }
      if (method === "PUT") {
        const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
        const scenes = await children.replaceScenes(user.id, projectId, parseSceneList(body));
        sendJson(response, 200, { ok: true, scenes });
        return;
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or PUT for the scenes of a project.");
    }

    if (resource === "sources") {
      if (childId === undefined) {
        if (method === "GET") {
          sendJson(response, 200, { ok: true, sources: await children.listSources(user.id, projectId) });
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
          const source = await children.createSource(user.id, projectId, parseSourceWrite(body));
          sendJson(response, 201, { ok: true, source });
          return;
        }
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for the sources of a project.");
      }
      if (method === "DELETE") {
        await children.removeSource(user.id, projectId, childId);
        sendJson(response, 200, { ok: true, deletedId: childId });
        return;
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use DELETE for one source.");
    }

    if (resource === "claims") {
      if (childId === undefined) {
        if (method === "GET") {
          sendJson(response, 200, { ok: true, claims: await children.listClaims(user.id, projectId) });
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
          const claim = await children.createClaim(user.id, projectId, parseClaimWrite(body));
          sendJson(response, 201, { ok: true, claim });
          return;
        }
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for the claims of a project.");
      }
      if (method === "PATCH") {
        const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
        const claim = await children.updateClaim(user.id, projectId, childId, parseClaimUpdate(body));
        sendJson(response, 200, { ok: true, claim });
        return;
      }
      if (method === "DELETE") {
        await children.removeClaim(user.id, projectId, childId);
        sendJson(response, 200, { ok: true, deletedId: childId });
        return;
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use PATCH or DELETE for one claim.");
    }

    if (resource === "proposals") {
      if (childId === undefined) {
        if (method === "GET") {
          sendJson(response, 200, { ok: true, proposals: await children.listProposals(user.id, projectId) });
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
          const proposal = await children.createProposal(user.id, projectId, parseProposalWrite(body));
          sendJson(response, 201, { ok: true, proposal });
          return;
        }
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for the proposals of a project.");
      }
      if (method === "PATCH") {
        const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
        const proposal = await children.updateProposal(user.id, projectId, childId, parseProposalUpdate(body));
        sendJson(response, 200, { ok: true, proposal });
        return;
      }
      if (method === "DELETE") {
        const proposal = await children.getProposal(user.id, projectId, childId);
        // An accepted proposal is the record behind a saved project version;
        // deleting it would remove the provenance of applied content.
        if (proposal.status === "accepted") {
          throw new HttpError(
            409,
            "PROPOSAL_ACCEPTED",
            "An accepted proposal cannot be deleted; reject a pending proposal instead.",
          );
        }
        await children.removeProposal(user.id, projectId, childId);
        sendJson(response, 200, { ok: true, deletedId: childId });
        return;
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use PATCH or DELETE for one generation proposal.");
    }

    if (resource === "jobs") {
      if (childId === undefined) {
        if (method === "GET") {
          sendJson(response, 200, { ok: true, jobs: await children.listJobs(user.id, projectId) });
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
          const job = await children.createJob(user.id, projectId, parseJobWrite(body));
          sendJson(response, 201, { ok: true, job });
          return;
        }
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for the provider jobs of a project.");
      }
      if (method === "PATCH") {
        const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
        const job = await children.updateJob(user.id, projectId, childId, parseJobUpdate(body));
        sendJson(response, 200, { ok: true, job });
        return;
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use PATCH for one provider job.");
    }

    // Renders are created, listed, and never rewritten: a snapshot records an output.
    if (childId !== undefined) throw new HttpError(404, "NOT_FOUND", "Unknown endpoint.");
    if (method === "GET") {
      sendJson(response, 200, { ok: true, renders: await children.listRenders(user.id, projectId) });
      return;
    }
    if (method === "POST") {
      const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
      const render = await children.createRender(user.id, projectId, parseRenderWrite(body));
      sendJson(response, 201, { ok: true, render });
      return;
    }
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for the render snapshots of a project.");
  }

  /**
   * One billable call per account at a time, six per minute. Shared by the
   * connection test and planning, so one account cannot consume every slot
   * and deny the other routes.
   */
  function beginProviderRequest(userId: string): void {
    const nowMs = now();
    const cutoff = nowMs - RATE_LIMIT_WINDOW_MS;

    if (nowMs - lastRateLimitSweep >= RATE_LIMIT_WINDOW_MS) {
      lastRateLimitSweep = nowMs;
      for (const [id, times] of recentRequestsByUser) {
        if (times.every((at) => at <= cutoff)) recentRequestsByUser.delete(id);
      }
    }

    const recent = (recentRequestsByUser.get(userId) ?? []).filter((at) => at > cutoff);
    if (recent.length >= config.requestsPerMinute) {
      recentRequestsByUser.set(userId, recent);
      throw new HttpError(
        429,
        "TOO_MANY_REQUESTS",
        "This account reached its development request limit. Wait a minute before retrying.",
      );
    }
    const active = inFlightByUser.get(userId) ?? 0;
    if (active >= MAX_CONCURRENT_PER_USER) {
      throw new HttpError(
        429,
        "REQUEST_IN_PROGRESS",
        "A request for this account is already running. Wait for it to finish.",
      );
    }

    recent.push(nowMs);
    recentRequestsByUser.set(userId, recent);
    inFlightByUser.set(userId, active + 1);
  }

  function endProviderRequest(userId: string): void {
    const remaining = (inFlightByUser.get(userId) ?? 1) - 1;
    if (remaining > 0) inFlightByUser.set(userId, remaining);
    else inFlightByUser.delete(userId);
  }

  async function handleTest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    checkOrigin(request);
    const user = await authenticate(request);
    const usageLedger = requireLedger();
    const idempotencyKey = readIdempotencyKey(request);

    beginProviderRequest(user.id);

    try {
      const body = await readJsonBody(request, config.bodyMaxBytes);
      const { modelId, prompt } = validateTestBody(body, config);
      const model = findModel(config.models, modelId);
      if (!model) throw new HttpError(400, "UNKNOWN_MODEL", "Unknown model selection.");
      if (!model.available || !model.requestId) {
        throw new HttpError(400, "MODEL_UNAVAILABLE", model.reason ?? "This model is not available.");
      }
      if (!config.apiKey) {
        throw new HttpError(
          503,
          "PROVIDER_NOT_CONFIGURED",
          "OLLAMA_API_KEY is not configured on the server. Add it to the server environment and restart.",
        );
      }

      const requestHash = hashRequest(model.id, prompt);
      let reservation: ReservationResult;
      try {
        reservation = await usageLedger.reserve({
          userId: user.id,
          idempotencyKey,
          requestHash,
          modelId: model.id,
          configuredModel: model.requestId,
        });
      } catch (error) {
        if (error instanceof UsageLedgerError) {
          throw new HttpError(
            503,
            "LEDGER_UNAVAILABLE",
            "The usage ledger is not ready. Apply the ai_usage migrations and check SUPABASE_SERVICE_ROLE_KEY.",
          );
        }
        throw error;
      }

      if (reservation.state === "existing") {
        try {
          await respondForExisting(reservation.usage);
        } catch (error) {
          if (error instanceof UsageLedgerError) {
            throw new HttpError(503, "LEDGER_UNAVAILABLE", "The usage ledger is temporarily unavailable.");
          }
          throw error;
        }
        return;
      }
      if (reservation.state === "project_busy") {
        // Connection tests carry no project, so this state is unreachable here.
        throw new HttpError(409, "PLANNING_ATTEMPT_IN_FLIGHT", "A project attempt already holds the ledger.");
      }

      async function respondForExisting(initial: ExistingUsage): Promise<void> {
        if (initial.requestHash !== requestHash) {
          throw new HttpError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "This idempotency key was already used for a different request.",
          );
        }

        let existing = initial;
        if (existing.status === "pending") {
          const startedAtMs = Date.parse(existing.createdAt);
          const isStale =
            Number.isFinite(startedAtMs) && now() - startedAtMs >= config.abandonAfterMs;
          if (!isStale) {
            throw new HttpError(
              409,
              "IDEMPOTENCY_IN_PROGRESS",
              "A request with this idempotency key is still in progress.",
            );
          }

          // Older than any request could still be running. Settle the reservation
          // without contacting the provider, so recovery can never bill twice.
          const body = failure("REQUEST_ABANDONED", ABANDONED_MESSAGE);
          const settled = await usageLedger.abandon({
            id: existing.id,
            userId: user.id,
            startedBefore: new Date(now() - config.abandonAfterMs).toISOString(),
            completion: {
              status: "error",
              returnedModel: null,
              promptEvalCount: null,
              evalCount: null,
              latencyMs: 0,
              errorCode: "REQUEST_ABANDONED",
              upstreamStatus: null,
              responseStatus: 409,
              responseBody: body,
            },
          });
          if (settled) {
            sendJson(response, 409, body);
            return;
          }

          // Another request settled it first; its write is committed by now.
          const reread = await usageLedger.lookup(user.id, idempotencyKey);
          if (!reread) {
            throw new HttpError(503, "LEDGER_UNAVAILABLE", "The usage ledger is temporarily unavailable.");
          }
          existing = reread;
          if (existing.status === "pending") {
            throw new HttpError(
              409,
              "IDEMPOTENCY_IN_PROGRESS",
              "A request with this idempotency key is still in progress.",
            );
          }
        }

        if (!existing.responseBody || typeof existing.responseBody !== "object") {
          throw new HttpError(
            503,
            "IDEMPOTENCY_REPLAY_UNAVAILABLE",
            "The original response for this idempotency key is unavailable.",
          );
        }
        sendJson(
          response,
          existing.responseStatus ?? (existing.status === "success" ? 200 : 502),
          existing.responseBody,
        );
      }

      const startedAt = now();
      let output;
      try {
        output = await requestChat({
          requestId: model.requestId,
          prompt,
          apiKey: config.apiKey,
          timeoutMs: config.providerTimeoutMs,
          maxOutputTokens: config.maxOutputTokens,
          fetchImpl,
        });
      } catch (error) {
        const providerError = error instanceof ProviderError ? error : null;
        await recordOutcome(usageLedger, user.id, reservation.id, {
          status: "error",
            returnedModel: null,
            promptEvalCount: null,
            evalCount: null,
            latencyMs: Math.max(0, now() - startedAt),
            errorCode: providerError?.code ?? "INTERNAL_ERROR",
            upstreamStatus: providerError?.upstreamStatus ?? null,
          responseStatus: providerError?.status ?? 500,
          responseBody: failure(
            providerError?.code ?? "INTERNAL_ERROR",
            providerError?.message ?? "Unexpected server error.",
            providerError?.upstreamStatus,
          ),
        });
        throw error;
      }

      const latencyMs = Math.max(0, now() - startedAt);
      const successBody: AiTestSuccess = {
        ok: true,
        modelId: model.id,
        configuredModel: model.requestId,
        returnedModel: output.returnedModel,
        reply: output.reply,
        latencyMs,
        usage: output.usage,
        doneReason: output.doneReason,
      };
      const recorded = await recordOutcome(usageLedger, user.id, reservation.id, {
        status: "success",
        returnedModel: output.returnedModel,
        promptEvalCount: output.usage.promptEvalCount,
        evalCount: output.usage.evalCount,
        latencyMs,
        responseStatus: 200,
        responseBody: successBody,
      });
      // The provider already answered and charged for this call, so the reply is
      // returned even when it could not be recorded.
      sendJson(
        response,
        200,
        successBody,
        recorded ? undefined : { "X-Storyframe-Usage": "unrecorded" },
      );
    } finally {
      endProviderRequest(user.id);
    }
  }

  /**
   * Records a finished attempt. The write is conditional on the reservation still
   * being `pending`, so one immediate retry is safe and absorbs a transient ledger
   * blip, which should not discard an answer the provider has already charged for.
   * A write that matches no pending row lost to a concurrent abandonment; retrying
   * cannot record it, and the caller must be told the reply is unrecorded.
   */
  async function recordOutcome(
    target: UsageLedger,
    userId: string,
    id: string,
    completion: UsageCompletion,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (await target.complete(userId, id, completion)) return true;
        break;
      } catch {
        // Retry once; the second failure reports an unrecorded outcome below.
      }
    }
    log.error(`[ai] LEDGER_WRITE_FAILED status=${completion.status}`);
    return false;
  }

  async function buildRenderContextForProject(
    user: AuthenticatedUser,
    projectId: string,
    options?: { aspectRatio?: ProjectAspectRatio; allowUnresolvedClaims?: boolean },
  ) {
    const project = await requireProjects().get(user.id, projectId);
    const mediaList = mediaStore
      ? await mediaStore.list(user.id, projectId, config.media.listLimit)
      : [];
    const mediaById = new Map<string, MediaRecord>(mediaList.map((m) => [m.id, m]));
    const signedUrlsByMediaId = new Map<string, string>();
    if (mediaObjects && mediaStore) {
      for (const m of mediaList) {
        if (m.status === "ready") {
          const objectKey = mediaObjectKey(user.id, m.id);
          // Presign for at least 3600s so JSON2Video input URLs stay valid for the full job lifecycle
          const presigned = mediaObjects.presignGet(
            objectKey,
            Math.max(3600, config.media.downloadUrlSeconds),
          );
          signedUrlsByMediaId.set(m.id, presigned.url);
        }
      }
    }
    const activeNarration = narrationStore
      ? await narrationStore.active(user.id, projectId)
      : { narration: null, music: null };
    const narrationTracks: NarrationTrack[] = [
      ...(activeNarration.narration ? [activeNarration.narration] : []),
      ...(activeNarration.music ? [activeNarration.music] : []),
    ];
    const claims = childStore ? await childStore.listClaims(user.id, projectId) : [];
    const unresolvedClaimCount = claims.filter((c) => c.status !== "supported").length;

    return {
      project,
      mediaList,
      narrationTracks,
      claims,
      snapshot: compileRenderComposition({
        projectId: project.id,
        projectVersion: project.version,
        projectType: project.projectType,
        title: project.title,
        document: project.document,
        aspectRatio: options?.aspectRatio ?? "9:16",
        mediaById,
        signedUrlsByMediaId,
        narrationTracks,
        unresolvedClaimCount,
        allowUnresolvedClaims: options?.allowUnresolvedClaims ?? false,
      }),
    };
  }

  async function persistRenderedMp4(
    ownerId: string,
    projectId: string,
    bytes: Uint8Array,
  ): Promise<MediaRecord | null> {
    if (!mediaStore || !mediaObjects) return null;
    const mediaId = newMediaId();
    const objectKey = mediaObjectKey(ownerId, mediaId);
    const upload = mediaObjects.presignPut(objectKey, config.media.uploadUrlSeconds);
    const uploadExpiresAt = new Date(
      now() + Math.min(config.media.uploadTtlMs, config.media.uploadUrlSeconds * 1000),
    ).toISOString();
    await mediaStore.createPending(ownerId, projectId, {
      id: mediaId,
      kind: "video",
      contentType: "video/mp4",
      byteSize: bytes.byteLength,
      sceneKey: null,
      objectKey,
      uploadExpiresAt,
      provenance: null,
    });
    const put = await (fetchImpl ?? fetch)(upload.url, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      body: new Uint8Array(bytes),
    });
    if (!put.ok) return null;
    const ready = await mediaStore.markReady(ownerId, projectId, mediaId, {
      contentType: "video/mp4",
      byteSize: bytes.byteLength,
    });
    return ready;
  }

  async function handleProjectWorkflowRoutes(
    request: IncomingMessage,
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
    subpath: string[],
  ): Promise<void> {
    const method = request.method ?? "GET";
    const [group, section, action, extra] = subpath;

    // ==========================================
    // Phase 9: JSON2Video Rendering Routes (/api/projects/:id/renders-v2/*)
    // ==========================================
    if (group === "renders-v2") {
      if (!section && method === "GET") {
        await requireProjects().get(user.id, projectId);
        sendJson(response, 200, {
          ok: true,
          jobs: studioEngine.listProjectRenderJobs(user.id, projectId),
        });
        return;
      }

      if (section === "compile" && method === "POST") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          aspectRatio?: ProjectAspectRatio;
          allowUnresolvedClaims?: boolean;
        };
        const { snapshot } = await buildRenderContextForProject(user, projectId, body);
        sendJson(response, 200, { ok: true, snapshot });
        return;
      }

      if (section === "submit" && method === "POST") {
        const rawKey = request.headers["idempotency-key"];
        const idempotencyKey =
          typeof rawKey === "string" && rawKey.trim().length > 0 ? rawKey.trim() : null;
        if (idempotencyKey) {
          const existing = studioEngine.findRenderJobByIdempotencyKey(
            user.id,
            projectId,
            idempotencyKey,
          );
          if (existing) {
            sendJson(response, 200, { ok: true, job: existing, replayed: true });
            return;
          }
        }

        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          aspectRatio?: ProjectAspectRatio;
          allowUnresolvedClaims?: boolean;
        };
        const { project, snapshot } = await buildRenderContextForProject(user, projectId, body);
        if (!snapshot.canSubmit) {
          throw new HttpError(
            422,
            "RENDER_COMPOSITION_INVALID",
            snapshot.issues.map((i) => i.message).join(" ") ||
              "Composition failed pre-render validation.",
            { issues: snapshot.issues },
          );
        }

        const submitted = await submitMovieToJson2Video(snapshot.movie, {
          apiKey: runtimeEnv.JSON2VIDEO_API_KEY?.trim() ?? "",
        });
        const createdAt = new Date(now()).toISOString();
        const job: RenderJobRecord = {
          id: `rnd-${randomUUID().slice(0, 10)}`,
          projectId: project.id,
          projectVersion: project.version,
          status: submitted.status,
          aspectRatio: snapshot.aspectRatio,
          providerJobId: submitted.providerJobId,
          idempotencyKey,
          snapshotFingerprint: snapshot.fingerprint,
          snapshot,
          outputMediaId: null,
          durationSeconds: snapshot.totalDurationSeconds,
          byteSize: null,
          estimatedCostUsd: snapshot.estimatedCostUsd,
          settledCostUsd: null,
          attempts: 1,
          errorCode: null,
          errorMessage: null,
          createdAt,
          updatedAt: createdAt,
          completedAt: null,
        };
        studioEngine.saveRenderJob(user.id, job);

        if (childStore) {
          await childStore
            .createJob(user.id, project.id, {
              provider: "json2video",
              externalId: submitted.providerJobId,
              request: {
                renderJobId: job.id,
                fingerprint: snapshot.fingerprint,
                costEstimateUsd: snapshot.estimatedCostUsd,
              },
            })
            .catch(() => undefined);
        }

        sendJson(response, 201, { ok: true, job, replayed: false });
        return;
      }

      if (section && action === "poll" && method === "POST") {
        await requireProjects().get(user.id, projectId);
        const job = studioEngine.getRenderJob(user.id, projectId, section);
        if (job.status === "ready") {
          sendJson(response, 200, { ok: true, job });
          return;
        }
        const polled = await pollJson2VideoMovie(
          job.providerJobId ?? `j2v-sim-${job.id}`,
          job.durationSeconds,
          { apiKey: runtimeEnv.JSON2VIDEO_API_KEY?.trim() ?? "" },
        );
        job.attempts += 1;
        job.updatedAt = new Date(now()).toISOString();
        if (polled.status === "failed") {
          job.status = "failed";
          job.errorCode = "RENDER_PROVIDER_FAILED";
          job.errorMessage = polled.errorMessage;
        } else if (polled.status === "ready") {
          const mp4Bytes = buildSimulatedMp4Bytes(job);
          const storedMedia = await persistRenderedMp4(user.id, projectId, mp4Bytes).catch(
            () => null,
          );
          job.status = "ready";
          job.outputMediaId = storedMedia?.id ?? null;
          job.byteSize = storedMedia?.byteSize ?? mp4Bytes.byteLength;
          job.settledCostUsd = job.estimatedCostUsd;
          job.completedAt = new Date(now()).toISOString();

          studioEngine.recordCostEntry({
            userId: user.id,
            projectId,
            provider: "json2video",
            modelOrTier: "v2-hd-30fps",
            operation: `json2video-render:${job.aspectRatio}`,
            units: Number(Math.max(0.25, job.durationSeconds / 60).toFixed(4)),
            reportedCostUsd: job.settledCostUsd,
            providerJobId: job.providerJobId,
          });

          if (childStore) {
            await childStore
              .createRender(user.id, projectId, {
                projectRevision: job.projectVersion,
                status: "ready",
                outputKey: job.outputMediaId,
              })
              .catch(() => undefined);
          }
        }
        sendJson(response, 200, { ok: true, job });
        return;
      }
    }

    // ==========================================
    // Phases 10–13: Mode A, Mode B, Mode C, Scoped AI Edit (/api/projects/:id/workflow/*)
    // ==========================================
    if (group === "workflow") {
      const { project, mediaList, narrationTracks, claims } =
        await buildRenderContextForProject(user, projectId);

      // Phase 10: Mode A Readiness & Continuity
      if (section === "mode-a" && !action && method === "GET") {
        const checklist = studioEngine.evaluateModeAReadiness({
          userId: user.id,
          project,
          media: mediaList,
          narrationTracks,
          claims,
        });
        sendJson(response, 200, { ok: true, checklist });
        return;
      }

      if (section === "mode-a" && action === "continuity" && method === "PUT") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          characters?: string;
          setting?: string;
          continuityRules?: string;
        };
        const continuity = studioEngine.saveContinuityNotes(user.id, projectId, {
          characters: body.characters ?? "",
          setting: body.setting ?? "",
          continuityRules: body.continuityRules ?? "",
        });
        sendJson(response, 200, { ok: true, continuity });
        return;
      }

      // Phase 11: Mode B Product Ads
      if (section === "mode-b" && !action && method === "GET") {
        sendJson(response, 200, {
          ok: true,
          product: studioEngine.getProductCatalog(user.id, projectId),
          campaign: studioEngine.getAdCampaign(user.id, projectId),
          concepts: studioEngine.getAdConcepts(user.id, projectId),
          variants: studioEngine.getAdVariants(user.id, projectId),
        });
        return;
      }

      if (section === "mode-b" && action === "product" && method === "PUT") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as Record<
          string,
          unknown
        >;
        const product = studioEngine.saveProductCatalog(user.id, projectId, body);
        sendJson(response, 200, { ok: true, product });
        return;
      }

      if (section === "mode-b" && action === "campaign" && method === "PUT") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as Record<
          string,
          unknown
        >;
        const campaign = studioEngine.saveAdCampaign(user.id, projectId, body);
        sendJson(response, 200, { ok: true, campaign });
        return;
      }

      if (section === "mode-b" && action === "concepts" && method === "POST") {
        const concepts = studioEngine.generateAdConcepts(user.id, projectId);
        sendJson(response, 201, { ok: true, concepts });
        return;
      }

      if (section === "mode-b" && action === "variants" && method === "POST") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          conceptId?: string;
          label: string;
          hookText: string;
          ctaText: string;
          layoutStyle: "product-hero" | "split-comparison" | "floating-card";
          aspectRatio?: ProjectAspectRatio;
        };
        const variant = studioEngine.createControlledAdVariant(user.id, projectId, body);
        sendJson(response, 201, { ok: true, variant });
        return;
      }

      if (section === "mode-b" && action === "manifest" && method === "GET") {
        const manifest = studioEngine.exportAdVariantManifest(user.id, projectId);
        sendJson(response, 200, { ok: true, manifest });
        return;
      }

      // Phase 12: Mode C Footage Repurposing
      if (section === "mode-c" && !action && method === "GET") {
        sendJson(response, 200, {
          ok: true,
          ingests: studioEngine.getRepurposeIngests(user.id, projectId),
          transcripts: studioEngine.getRepurposeTranscripts(user.id, projectId),
          clips: studioEngine.getRepurposeClips(user.id, projectId),
        });
        return;
      }

      if (section === "mode-c" && action === "ingest" && method === "POST") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          sourceMediaId: string;
          fileName: string;
          contentType: string;
          byteSize: number;
          durationSeconds: number;
          width?: number;
          height?: number;
        };
        const ingest = studioEngine.ingestRepurposeSource(user.id, projectId, body);
        sendJson(response, 201, { ok: true, ingest });
        return;
      }

      if (section === "mode-c" && action === "transcribe" && method === "POST") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          ingestId: string;
        };
        const transcript = studioEngine.transcribeRepurposeIngest(
          user.id,
          projectId,
          body.ingestId,
        );
        sendJson(response, 201, { ok: true, transcript });
        return;
      }

      if (section === "mode-c" && action === "transcript-segment" && method === "PATCH") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          transcriptId: string;
          segmentId: string;
          correctedText: string;
        };
        const transcript = studioEngine.updateTranscriptSegmentText(
          user.id,
          projectId,
          body.transcriptId,
          body.segmentId,
          body.correctedText,
        );
        sendJson(response, 200, { ok: true, transcript });
        return;
      }

      if (section === "mode-c" && action === "propose-clips" && method === "POST") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          transcriptId: string;
        };
        const clips = studioEngine.proposeRepurposeClips(
          user.id,
          projectId,
          body.transcriptId,
        );
        sendJson(response, 201, { ok: true, clips });
        return;
      }

      if (section === "mode-c" && action === "clips" && extra && method === "PATCH") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as Record<
          string,
          unknown
        >;
        const clip = studioEngine.updateRepurposeClip(user.id, projectId, extra, body);
        sendJson(response, 200, { ok: true, clip });
        return;
      }

      if (section === "mode-c" && action === "batch-export" && method === "POST") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          clipIds?: string[];
          simulateFailureForClipId?: string;
        };
        const manifest = studioEngine.executeRepurposeBatchExport(
          user.id,
          projectId,
          body.clipIds,
          body.simulateFailureForClipId,
        );
        sendJson(response, 200, { ok: true, manifest });
        return;
      }

      // Phase 13: Scoped AI Editing & Recovery
      if (section === "scoped-edits" && !action && method === "GET") {
        sendJson(response, 200, {
          ok: true,
          plans: studioEngine.getScopedEditPlans(user.id, projectId),
        });
        return;
      }

      if (section === "scoped-edits" && action === "plan" && method === "POST") {
        const body = (await readJsonBody(
          request,
          PROJECT_LIMITS.bodyBytes,
        )) as ScopedEditRequest;
        const plan = studioEngine.createScopedEditPlan(user.id, project, body);
        sendJson(response, 201, { ok: true, plan });
        return;
      }

      if (section === "scoped-edits" && action && extra === "apply" && method === "POST") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          confirm?: boolean;
        };
        const { plan, updatedDocument } = studioEngine.verifyAndApplyScopedEditPlan(
          user.id,
          project,
          action,
          Boolean(body.confirm),
        );
        const savedProject = await requireProjects().update(user.id, projectId, {
          title: project.title,
          document: updatedDocument,
          version: project.version,
        });
        sendJson(response, 200, { ok: true, plan, project: savedProject });
        return;
      }

      if (section === "scoped-edits" && action && extra === "restore" && method === "POST") {
        const { plan, restoredDocument } = studioEngine.restoreScopedEditPlan(
          user.id,
          projectId,
          action,
        );
        const savedProject = await requireProjects().update(user.id, projectId, {
          title: project.title,
          document: restoredDocument,
          version: project.version,
        });
        sendJson(response, 200, { ok: true, plan, project: savedProject });
        return;
      }
    }

    // ==========================================
    // Phases 14, 16, 18, 19, 20, 21: Project-Scoped Studio Ops (/api/projects/:id/studio/*)
    // ==========================================
    if (group === "studio") {
      const { project, mediaList } = await buildRenderContextForProject(user, projectId);
      const userState = studioEngine.getUserState(user.id);

      if (section === "overview" && method === "GET") {
        sendJson(response, 200, {
          ok: true,
          costSummary: studioEngine.getCostSummary(user.id, projectId),
          formats: studioEngine.getOrCreateFormatLayouts(user.id, project),
          comments: userState.commentsByProject.get(projectId) ?? [],
          approvals: userState.approvalsByProject.get(projectId) ?? [],
          chapters: userState.chaptersByProject.get(projectId) ?? [],
          localizations: userState.localizationsByProject.get(projectId) ?? [],
          publishingJobs: userState.publishingJobsByProject.get(projectId) ?? [],
        });
        return;
      }

      if (section === "backup" && method === "GET") {
        const bundle = studioEngine.exportProjectBackupBundle(project, mediaList);
        sendJson(response, 200, { ok: true, bundle });
        return;
      }

      if (section === "formats" && method === "PUT") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          aspectRatio: ProjectAspectRatio;
          reviewed: boolean;
        };
        const format = studioEngine.updateFormatLayout(
          user.id,
          project,
          body.aspectRatio,
          body.reviewed,
        );
        sendJson(response, 200, { ok: true, format });
        return;
      }

      if (section === "comments" && method === "POST") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          sceneId?: string | null;
          body: string;
        };
        const comment = studioEngine.addProjectComment(user.id, projectId, {
          sceneId: body.sceneId ?? null,
          authorEmail: `user-${user.id.slice(0, 8)}@storyframe.studio`,
          body: body.body,
        });
        sendJson(response, 201, { ok: true, comment });
        return;
      }

      if (section === "approvals" && method === "POST") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          sceneId?: string | null;
          role?: WorkspaceRole;
          status: "approved" | "changes_requested";
          note?: string;
        };
        const approval = studioEngine.recordFingerprintApproval(user.id, project, {
          sceneId: body.sceneId ?? null,
          approverEmail: `reviewer-${user.id.slice(0, 8)}@storyframe.studio`,
          role: body.role ?? "reviewer",
          status: body.status,
          note: body.note ?? "",
        });
        sendJson(response, 201, { ok: true, approval });
        return;
      }

      if (section === "chapters" && !action && method === "POST") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          targetTotalSeconds?: number;
        };
        const chapters = studioEngine.generateLongFormChapters(
          user.id,
          project,
          body.targetTotalSeconds ?? 240,
        );
        sendJson(response, 201, { ok: true, chapters });
        return;
      }

      if (section === "chapters" && action && extra === "approve" && method === "POST") {
        const chapter = studioEngine.approveAndGenerateChapter(user.id, project, action);
        sendJson(response, 200, { ok: true, chapter });
        return;
      }

      if (section === "localizations" && method === "POST") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          languageCode: string;
          languageLabel: string;
        };
        const localization = studioEngine.createMultilingualLocalization(
          user.id,
          project,
          body,
        );
        sendJson(response, 201, { ok: true, localization });
        return;
      }

      if (section === "publish" && method === "POST") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          renderJobId: string;
          platform: PublishingPlatform;
          accountHandle: string;
          title: string;
          description: string;
          tags?: string[];
          visibility: "private" | "unlisted" | "public";
          scheduledFor?: string | null;
          humanConfirmed: boolean;
        };
        const job = studioEngine.scheduleOrPublishRelease(user.id, projectId, {
          ...body,
          tags: body.tags ?? [],
          scheduledFor: body.scheduledFor ?? null,
        });
        sendJson(response, 201, { ok: true, publishingJob: job });
        return;
      }

      if (section === "save-template" && method === "POST") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          name: string;
          description: string;
        };
        const template = studioEngine.saveProjectAsTemplate(
          user.id,
          project,
          body.name,
          body.description,
        );
        sendJson(response, 201, { ok: true, template });
        return;
      }
    }

    throw new HttpError(404, "NOT_FOUND", "Unknown project workflow endpoint.");
  }

  async function handleStudioGlobalRoutes(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    requestUrl: URL,
  ): Promise<void> {
    checkOrigin(request);
    const user = await authenticate(request);
    const method = request.method ?? "GET";
    const userState = studioEngine.getUserState(user.id);

    // ==========================================
    // Phases D1–D6: Discover Ideas Routes (/api/discovery/*)
    // ==========================================
    if (path === "/api/discovery/state" && method === "GET") {
      const evidenceResult = await studioEngine.ingestTrendEvidence(user.id, {
        forceRefresh: false,
        youtubeApiKey: runtimeEnv.YOUTUBE_API_KEY?.trim() ?? "",
      });
      sendJson(response, 200, {
        ok: true,
        preferences: studioEngine.getDiscoveryPreferences(user.id),
        evidenceResult,
        ideas: userState.discoveryIdeas,
        events: userState.discoveryEvents.slice(0, 30),
      });
      return;
    }

    if (path === "/api/discovery/preferences" && method === "PUT") {
      const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as Record<
        string,
        unknown
      >;
      const preferences = studioEngine.saveDiscoveryPreferences(user.id, body);
      sendJson(response, 200, { ok: true, preferences });
      return;
    }

    if (path === "/api/discovery/generate" && method === "POST") {
      const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
        formatTrack: IdeaFormatTrack;
        refreshExternalEvidence?: boolean;
      };
      const result = await studioEngine.generateDiscoveryBatch(user.id, {
        formatTrack: body.formatTrack ?? "short-form",
        refreshExternalEvidence: Boolean(body.refreshExternalEvidence),
        youtubeApiKey: runtimeEnv.YOUTUBE_API_KEY?.trim() ?? "",
      });
      sendJson(response, 201, {
        ok: true,
        batchId: result.batchId,
        evidenceResult: result.evidenceResult,
        ideas: userState.discoveryIdeas,
      });
      return;
    }

    const ideaActionMatch = path.match(/^\/api\/discovery\/ideas\/([^/]+)\/(feedback|create-project)$/);
    if (ideaActionMatch && method === "POST") {
      const [, ideaId, action] = ideaActionMatch;
      if (action === "feedback") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          action: "save" | "dismiss" | "replace" | "feedback" | "edit-prompt";
          reason?: IdeaFeedbackReason;
          customPromptNote?: string;
        };
        const result = studioEngine.recordIdeaFeedbackAndReplace(user.id, ideaId, body);
        sendJson(response, 200, {
          ok: true,
          ...result,
          ideas: userState.discoveryIdeas,
        });
        return;
      }

      if (action === "create-project") {
        const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
          previewOnly?: boolean;
          title?: string;
          projectType?: "story" | "product-ad" | "repurpose";
          mode?: "factual" | "fiction";
          targetDurationSeconds?: number;
          aspectRatio?: ProjectAspectRatio;
        };
        const draft = studioEngine.buildProjectDraftFromIdea(user.id, ideaId, body);
        if (body.previewOnly) {
          sendJson(response, 200, { ok: true, draft });
          return;
        }
        const createdProject = await requireProjects().create(user.id, {
          projectType: draft.projectType,
          title: draft.title,
          document: draft.document,
        });
        const idea = studioEngine.markIdeaUsedForProject(
          user.id,
          ideaId,
          createdProject.id,
        );
        sendJson(response, 201, {
          ok: true,
          project: createdProject,
          idea,
          draft,
        });
        return;
      }
    }

    // ==========================================
    // Phases 14–22: Global Studio Operations Routes (/api/studio/*)
    // ==========================================
    if (path === "/api/studio/state" && method === "GET") {
      const projectId = requestUrl.searchParams.get("projectId");
      sendJson(response, 200, {
        ok: true,
        rateCard: studioEngine.getRateCard(),
        plans: studioEngine.getSubscriptionPlans(),
        entitlement: studioEngine.getEntitlement(user.id),
        costSummary: studioEngine.getCostSummary(user.id, projectId),
        members: userState.workspaceMembers,
        brandRecipes: userState.brandRecipes,
        apiCredentials: userState.apiCredentials,
        templates: userState.projectTemplates,
        drDrills: userState.drDrills,
        lastLoadTest: userState.lastLoadTest,
        launchAudit: studioEngine.buildLaunchAuditReport(user.id, {
          ollamaConfigured: Boolean(config.apiKey),
          supabaseConfigured: Boolean(config.supabaseUrl && config.supabaseServiceRoleKey),
          r2Configured: Boolean(config.r2),
          deepgramConfigured: Boolean(narrationSettings.apiKey),
          json2videoConfigured: Boolean(runtimeEnv.JSON2VIDEO_API_KEY?.trim()),
          youtubeConfigured: Boolean(runtimeEnv.YOUTUBE_API_KEY?.trim()),
        }),
      });
      return;
    }

    if (path === "/api/studio/billing/plan" && method === "PUT") {
      const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
        planId: SubscriptionPlanId;
        billingInterval: BillingInterval;
        autoTopUpEnabled?: boolean;
        spendingCeilingUsd?: number | null;
      };
      const entitlement = studioEngine.updateSubscriptionPlan(user.id, body);
      sendJson(response, 200, { ok: true, entitlement });
      return;
    }

    if (path === "/api/studio/billing/quote" && method === "POST") {
      const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
        operation: string;
        provider: CostProviderName;
        modelOrTier: string;
        units: number;
      };
      const quote = studioEngine.quotePreWorkCharge(user.id, body);
      sendJson(response, 200, { ok: true, quote });
      return;
    }

    if (path === "/api/studio/billing/webhook" && method === "POST") {
      const body = (await readJsonBody(
        request,
        PROJECT_LIMITS.bodyBytes,
      )) as BillingWebhookEventRequest;
      const result = studioEngine.processBillingWebhook(
        user.id,
        body,
        runtimeEnv.BILLING_WEBHOOK_SECRET?.trim() ?? "storyframe-dev-webhook-secret",
      );
      sendJson(response, 200, { ok: true, ...result });
      return;
    }

    if (path === "/api/studio/backup/import" && method === "POST") {
      const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
        bundle: ProjectBackupBundle;
      };
      const validated = studioEngine.validateAndPrepareBackupImport(body.bundle);
      const restoredProject = await requireProjects().create(user.id, {
        projectType: validated.projectType,
        title: validated.title,
        document: validated.document,
      });
      sendJson(response, 201, { ok: true, project: restoredProject });
      return;
    }

    if (path === "/api/studio/team/invite" && method === "POST") {
      const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
        email: string;
        role: WorkspaceRole;
      };
      const member = studioEngine.inviteWorkspaceMember(user.id, body.email, body.role);
      sendJson(response, 201, { ok: true, member });
      return;
    }

    const revokeMemberMatch = path.match(/^\/api\/studio\/team\/([^/]+)\/revoke$/);
    if (revokeMemberMatch && method === "POST") {
      const member = studioEngine.revokeWorkspaceMember(user.id, revokeMemberMatch[1]);
      sendJson(response, 200, { ok: true, member });
      return;
    }

    if (path === "/api/studio/brands" && method === "POST") {
      const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as Parameters<
        typeof studioEngine.createBrandRecipe
      >[1];
      const brandRecipe = studioEngine.createBrandRecipe(user.id, body);
      sendJson(response, 201, { ok: true, brandRecipe });
      return;
    }

    if (path === "/api/studio/api-keys" && method === "POST") {
      const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
        label: string;
        scopes: ApiKeyScope[];
        webhookUrl?: string | null;
      };
      const result = studioEngine.issueApiCredential(user.id, body);
      sendJson(response, 201, { ok: true, ...result });
      return;
    }

    const revokeKeyMatch = path.match(/^\/api\/studio\/api-keys\/([^/]+)\/revoke$/);
    if (revokeKeyMatch && method === "POST") {
      const credential = studioEngine.revokeApiCredential(user.id, revokeKeyMatch[1]);
      sendJson(response, 200, { ok: true, credential });
      return;
    }

    if (path === "/api/studio/launch-audit/approve" && method === "POST") {
      const launchAudit = studioEngine.approveLaunchRelease(
        user.id,
        `release-manager-${user.id.slice(0, 8)}@storyframe.studio`,
      );
      sendJson(response, 200, { ok: true, launchAudit });
      return;
    }

    if (path === "/api/studio/dr/drill" && method === "POST") {
      const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
        scenario: DisasterScenarioId;
      };
      const drill = studioEngine.runDisasterRecoveryDrill(user.id, body.scenario);
      sendJson(response, 201, { ok: true, drill });
      return;
    }

    if (path === "/api/studio/dr/load-test" && method === "POST") {
      const body = (await readJsonBody(request, PROJECT_LIMITS.bodyBytes)) as {
        concurrentUsers?: number;
      };
      const loadTest = studioEngine.runLoadTestSimulation(
        user.id,
        body.concurrentUsers ?? 25,
      );
      sendJson(response, 200, { ok: true, loadTest });
      return;
    }

    throw new HttpError(404, "NOT_FOUND", "Unknown studio endpoint.");
  }

  return server;
}
