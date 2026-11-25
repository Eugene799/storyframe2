import { resolveModels, type ResolvedModel } from "./models";
import { loadMediaLimits, type MediaLimits } from "./media";
import { loadStockLimits, type StockLimits } from "./stock";
import { OLLAMA_BASE_URL } from "./ollama";
import {
  MAX_PLANNING_PROVIDER_CALLS,
  resolvePlanningRoutes,
  type ResolvedPlanningRoute,
} from "./planning";
import type { R2Config } from "./r2";

export interface AppConfig {
  apiKey: string | null;
  supabaseUrl: string | null;
  supabasePublishableKey: string | null;
  supabaseServiceRoleKey: string | null;
  authTimeoutMs: number;
  allowedOrigin: string | null;
  promptMaxChars: number;
  bodyMaxBytes: number;
  providerTimeoutMs: number;
  maxOutputTokens: number;
  requestsPerMinute: number;
  abandonAfterMs: number;
  /** Covers the initial planning call plus its one repair. */
  planningAbandonAfterMs: number;
  models: ResolvedModel[];
  r2: R2Config | null;
  media: MediaLimits;
  /** Phase 6 provider keys, cache windows, and import bounds. */
  stock: StockLimits;
  /** Phase 7 generation bounds, polling, and the per-user spending guard. */
  image: {
    pollIntervalMs: number;
    pollTimeoutMs: number;
    downloadTimeoutMs: number;
    dailyImageLimit: number;
    dailyUsdLimit: number;
    spendWindowMs: number;
    pendingAbandonAfterMs: number;
    pendingSweepIntervalMs: number;
  };
  /** Phase 8 narration bounds. Credentials are loaded separately. */
  narration: {
    timeoutMs: number;
    maxAudioBytes: number;
    dailyCharLimit: number;
    dailyUsdLimit: number;
    usageWindowMs: number;
  };
  /** One configured model per planning route; see Phase 5 in the README. */
  planning: { routes: ResolvedPlanningRoute[] };
}

function intEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function usdEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function stringEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function supabaseUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = stringEnv(env, "SUPABASE_URL");
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("SUPABASE_URL must be a valid URL.");
  }

  const localHost = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localHost)) {
    throw new Error("SUPABASE_URL must use https outside local development.");
  }

  return raw.replace(/\/+$/, "");
}

function r2Config(env: NodeJS.ProcessEnv): R2Config | null {
  const endpoint = stringEnv(env, "R2_ENDPOINT") ?? stringEnv(env, "CLOUDFLARE_S3_ENDPOINT_URL");
  const bucket = stringEnv(env, "R2_BUCKET_NAME") ?? stringEnv(env, "CLOUDFLARE_R2_BUCKET_NAME");
  const accessKeyId = stringEnv(env, "R2_ACCESS_KEY_ID") ?? stringEnv(env, "CLOUDFLARE_ACCESS_ID");
  const secretAccessKey = stringEnv(env, "R2_SECRET_ACCESS_KEY") ?? stringEnv(env, "CLOUDFLARE_SECRET_ACCESS_KEY");
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("R2_ENDPOINT must be a valid URL.");
  }
  const localHost = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localHost)) {
    throw new Error("R2_ENDPOINT must use https outside local development.");
  }

  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket,
    accessKeyId,
    secretAccessKey,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const configuredBase = env.OLLAMA_BASE_URL?.trim();
  if (configuredBase && configuredBase.replace(/\/+$/, "") !== OLLAMA_BASE_URL) {
    throw new Error(`OLLAMA_BASE_URL must be ${OLLAMA_BASE_URL}`);
  }

  const providerTimeoutMs = intEnv(env, "AI_TIMEOUT_MS", 30000, 1000, 120000);
  const authTimeoutMs = intEnv(env, "AUTH_TIMEOUT_MS", 5000, 1000, 15000);
  // A reservation must never be abandoned while its request could still be
  // running: session check + reservation + provider call + completion.
  const abandonAfterMs = Math.max(
    intEnv(env, "AI_ABANDON_AFTER_MS", 90000, 30000, 3600000),
    providerTimeoutMs + 3 * authTimeoutMs,
  );
  const planningAbandonAfterMs = Math.max(
    abandonAfterMs,
    MAX_PLANNING_PROVIDER_CALLS * providerTimeoutMs + 3 * authTimeoutMs,
  );

  const media = loadMediaLimits(env);

  return {
    apiKey: stringEnv(env, "OLLAMA_API_KEY"),
    supabaseUrl: supabaseUrl(env),
    supabasePublishableKey:
      stringEnv(env, "SUPABASE_PUBLISHABLE_KEY") ?? stringEnv(env, "SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: stringEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
    authTimeoutMs,
    allowedOrigin: stringEnv(env, "APP_ORIGIN"),
    promptMaxChars: intEnv(env, "AI_MAX_PROMPT_CHARS", 500, 1, 2000),
    bodyMaxBytes: intEnv(env, "AI_MAX_BODY_BYTES", 4096, 256, 65536),
    providerTimeoutMs,
    maxOutputTokens: intEnv(env, "AI_MAX_OUTPUT_TOKENS", 120, 16, 512),
    requestsPerMinute: intEnv(env, "AI_MAX_REQUESTS_PER_MINUTE", 6, 1, 60),
    abandonAfterMs,
    planningAbandonAfterMs,
    models: resolveModels(env),
    r2: r2Config(env),
    media,
    stock: loadStockLimits(env, media),
    image: {
      pollIntervalMs: intEnv(env, "IMAGE_POLL_INTERVAL_MS", 1500, 100, 10000),
      pollTimeoutMs: intEnv(env, "IMAGE_GENERATION_TIMEOUT_MS", 60000, 1000, 300000),
      downloadTimeoutMs: intEnv(env, "IMAGE_DOWNLOAD_TIMEOUT_MS", 30000, 1000, 120000),
      // A rolling 24-hour cap per account. Zero disables that dimension.
      dailyImageLimit: intEnv(env, "IMAGE_DAILY_IMAGES_PER_USER", 20, 0, 1000),
      dailyUsdLimit: usdEnv(env, "IMAGE_DAILY_USD_PER_USER", 1, 0, 1000),
      spendWindowMs: 24 * 60 * 60 * 1000,
      // A job whose provider no longer reports back is settled so it cannot
      // block the account forever.
      pendingAbandonAfterMs: intEnv(env, "IMAGE_PENDING_ABANDON_AFTER_MS", 15 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
      pendingSweepIntervalMs: intEnv(env, "IMAGE_PENDING_SWEEP_INTERVAL_MS", 60_000, 0, 60 * 60 * 1000),
    },
    narration: {
      timeoutMs: intEnv(env, "NARRATION_TIMEOUT_MS", 60_000, 1_000, 180_000),
      maxAudioBytes: intEnv(env, "NARRATION_MAX_AUDIO_BYTES", 25 * 1024 * 1024, 1024, 100 * 1024 * 1024),
      // Rolling 24-hour guard. Zero disables that dimension. Previews count too.
      dailyCharLimit: intEnv(env, "NARRATION_DAILY_CHARS_PER_USER", 100_000, 0, 10_000_000),
      dailyUsdLimit: usdEnv(env, "NARRATION_DAILY_USD_PER_USER", 3, 0, 1000),
      usageWindowMs: 24 * 60 * 60 * 1000,
    },
    planning: { routes: planningRoutes(env) },
  };
}

function planningRoutes(env: NodeJS.ProcessEnv): ResolvedPlanningRoute[] {
  return resolvePlanningRoutes(env, resolveModels(env));
}
