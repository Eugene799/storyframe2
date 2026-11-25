import type { MediaKind } from "../shared/media-contract";
import { ApiError } from "./api-error";
import { detectMediaType } from "./media";

/**
 * Phase 7 scaffold: image generation adapters.
 *
 * The adapters are deliberately not routed yet. They are disabled unless the
 * provider's credentials are present, and every model carries the verified
 * billing metadata and the date/URL it was verified from, because the two
 * providers do not share models, units, or prices.
 *
 * No live generation is attempted by the tests; they use fake fetch.
 */

export const IMAGE_PROVIDERS = ["cloudflare", "leonardo"] as const;
export type ImageProviderId = (typeof IMAGE_PROVIDERS)[number];

export interface NeuronsBilling {
  kind: "neurons";
  /** 512x512 tiles are billed per image area. */
  neuronsPerTile: number;
  neuronsPerStep: number;
  /** Dollars per 1,000 neurons. */
  usdPerThousandNeurons: number;
  freeDailyNeurons: number;
  sourceUrl: string;
  verifiedOn: string;
}

export interface ApiCreditBilling {
  kind: "api-credit";
  /** Null until a per-image rate is published or measured; never guess. */
  usdPerImage: null;
  note: string;
  sourceUrl: string;
  verifiedOn: string;
}

export interface ImageModelDefinition {
  /** Stable local key, used in records instead of the provider's id. */
  key: string;
  provider: ImageProviderId;
  /** The exact identifier sent to the provider. */
  providerModel: string;
  label: string;
  width: number;
  height: number;
  /** Fixed request step count, or null when the provider chooses. */
  steps: number | null;
  maxPromptChars: number;
  billing: NeuronsBilling | ApiCreditBilling;
  /** Bumped whenever the model or rate is re-verified. */
  rateVersion: string;
}

/**
 * Cloudflare: FLUX.1 [schnell] returns a 1024x1024 image; steps default to 4
 * and may not exceed 8. Billing is neurons per 512x512 tile plus steps.
 * Rate limits: 720 text-to-image requests/minute, 10,000 free neurons/day.
 *
 * Leonardo: Phoenix 1.0 accepts 32-2048px (multiples of 8) with a 2000-char
 * prompt. The generation endpoints are v1 (documented request and response),
 * model IDs from the common API values table. API credit pricing is calculated
 * per model and parameter set in Leonardo's pricing calculator, so no USD rate
 * is published here; the $3/1000 images figure remains unverified.
 */
export const IMAGE_MODELS: readonly ImageModelDefinition[] = [
  {
    key: "cloudflare:flux-1-schnell",
    provider: "cloudflare",
    providerModel: "@cf/black-forest-labs/flux-1-schnell",
    label: "FLUX.1 [schnell]",
    width: 1024,
    height: 1024,
    steps: 4,
    maxPromptChars: 2048,
    billing: {
      kind: "neurons",
      neuronsPerTile: 4.8,
      neuronsPerStep: 9.6,
      usdPerThousandNeurons: 0.011,
      freeDailyNeurons: 10_000,
      sourceUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing",
      verifiedOn: "2026-11-25",
    },
    rateVersion: "cloudflare-flux-schnell-2026-11-25",
  },
  {
    key: "leonardo:phoenix-1.0",
    provider: "leonardo",
    providerModel: "de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3",
    label: "Leonardo Phoenix 1.0",
    width: 1024,
    height: 1024,
    steps: null,
    maxPromptChars: 2000,
    billing: {
      kind: "api-credit",
      usdPerImage: null,
      note: "Billed in API credit per model and parameters; the exact cost is shown in Leonardo's API pricing calculator. No per-image USD rate is published, and $3/1000 images is unverified.",
      sourceUrl: "https://docs.leonardo.ai/docs/pricing-and-plans-faq",
      verifiedOn: "2026-11-25",
    },
    rateVersion: "leonardo-phoenix-1.0-2026-11-25",
  },
];

export interface ImageProviderSettings {
  cloudflare: { accountId: string; apiToken: string } | null;
  leonardo: { apiKey: string } | null;
}

function value(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/** Missing credentials mean the provider stays disabled, not an error. */
export function loadImageProviderSettings(env: NodeJS.ProcessEnv): ImageProviderSettings {
  const accountId = value(env, "CLOUDFLARE_ACCOUNT_ID");
  // CF_API_TOKEN is the project-settings name for the same Workers AI token.
  const apiToken = value(env, "CLOUDFLARE_AI_API_TOKEN") ?? value(env, "CF_API_TOKEN");
  const leonardoKey = value(env, "LEONARDO_API_KEY");
  return {
    cloudflare: accountId && apiToken ? { accountId, apiToken } : null,
    leonardo: leonardoKey ? { apiKey: leonardoKey } : null,
  };
}

export function isImageProviderConfigured(
  settings: ImageProviderSettings,
  provider: ImageProviderId,
): boolean {
  return settings[provider] !== null;
}

export function findImageModel(key: string): ImageModelDefinition | null {
  return IMAGE_MODELS.find((model) => model.key === key) ?? null;
}

function requireModel(key: string, provider: ImageProviderId): ImageModelDefinition {
  const model = findImageModel(key);
  if (!model || model.provider !== provider) {
    throw new ApiError(400, "IMAGE_MODEL_UNKNOWN", "That image model is not in the verified catalog.");
  }
  return model;
}

function requirePrompt(prompt: string, model: ImageModelDefinition): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new ApiError(400, "IMAGE_PROMPT_REQUIRED", "An image prompt is required.");
  }
  if (trimmed.length > model.maxPromptChars) {
    throw new ApiError(
      400,
      "IMAGE_PROMPT_TOO_LONG",
      `${model.label} prompts are limited to ${model.maxPromptChars} characters.`,
    );
  }
  return trimmed;
}

function disabled(provider: ImageProviderId): never {
  throw new ApiError(
    503,
    "IMAGE_PROVIDER_DISABLED",
    `${provider === "cloudflare" ? "Cloudflare Workers AI" : "Leonardo"} is not configured on this server.`,
  );
}

export interface ImageAdapterDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface CloudflareImageResult {
  provider: "cloudflare";
  modelKey: string;
  contentType: string;
  kind: MediaKind;
  bytes: Buffer;
  width: number;
  height: number;
  steps: number;
  /** Workers AI's reported usage, which carries the billed neuron count. */
  usage: Record<string, unknown> | null;
  neurons: number | null;
}

/**
 * Calls Workers AI's REST run endpoint. The response carries a base64 image in
 * `result.image`; the bytes are validated as an image before being returned.
 */
export async function generateWithCloudflare(
  settings: ImageProviderSettings,
  request: { modelKey: string; prompt: string; steps?: number },
  deps: ImageAdapterDeps = {},
): Promise<CloudflareImageResult> {
  const cloudflare = settings.cloudflare;
  if (!cloudflare) disabled("cloudflare");
  const model = requireModel(request.modelKey, "cloudflare");
  const prompt = requirePrompt(request.prompt, model);
  const steps = request.steps ?? model.steps ?? 4;
  if (!Number.isInteger(steps) || steps < 1 || steps > 8) {
    throw new ApiError(400, "IMAGE_STEPS_INVALID", "FLUX.1 [schnell] supports 1 to 8 steps.");
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cloudflare.accountId)}/ai/run/${model.providerModel}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cloudflare.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt, steps }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? 45_000),
      },
    );
  } catch {
    throw new ApiError(503, "IMAGE_PROVIDER_UNAVAILABLE", "Cloudflare Workers AI is unreachable.");
  }
  if (!response.ok) {
    throw new ApiError(
      502,
      "IMAGE_PROVIDER_FAILED",
      `Cloudflare Workers AI rejected the generation (HTTP ${response.status}).`,
    );
  }
  const body = (await response.json().catch(() => null)) as
    | { result?: { image?: unknown; usage?: unknown } }
    | null;
  const rawUsage = body?.result?.usage;
  const usage =
    rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage)
      ? (rawUsage as Record<string, unknown>)
      : null;
  const neurons =
    typeof usage?.neurons === "number" && Number.isFinite(usage.neurons) && usage.neurons >= 0
      ? usage.neurons
      : null;
  const base64 = body?.result?.image;
  if (typeof base64 !== "string" || base64.length === 0) {
    throw new ApiError(502, "IMAGE_PROVIDER_FAILED", "Cloudflare Workers AI returned no image.");
  }
  const bytes = Buffer.from(base64, "base64");
  const detected = detectMediaType(bytes);
  if (!detected || detected.kind !== "image") {
    throw new ApiError(502, "IMAGE_PROVIDER_FAILED", "Cloudflare Workers AI returned a non-image payload.");
  }
  return {
    provider: "cloudflare",
    modelKey: model.key,
    contentType: detected.contentType,
    kind: detected.kind,
    bytes,
    width: model.width,
    height: model.height,
    steps,
    usage,
    neurons,
  };
}

export interface LeonardoGenerationStart {
  provider: "leonardo";
  modelKey: string;
  jobId: string;
  /** Credits reported at submit time, when the provider includes them. */
  apiCreditCost: number | null;
}

/** Submits an async v1 generation; the provider returns a job id to poll. */
export async function startLeonardoGeneration(
  settings: ImageProviderSettings,
  request: { modelKey: string; prompt: string; width?: number; height?: number },
  deps: ImageAdapterDeps = {},
): Promise<LeonardoGenerationStart> {
  const leonardo = settings.leonardo;
  if (!leonardo) disabled("leonardo");
  const model = requireModel(request.modelKey, "leonardo");
  const prompt = requirePrompt(request.prompt, model);
  const width = request.width ?? model.width;
  const height = request.height ?? model.height;
  for (const [label, size] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (!Number.isInteger(size) || size < 32 || size > 2048 || size % 8 !== 0) {
      throw new ApiError(400, "IMAGE_SIZE_INVALID", `Leonardo ${label} must be 32-2048 in multiples of 8.`);
    }
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl("https://cloud.leonardo.ai/api/rest/v1/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${leonardo.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        prompt,
        modelId: model.providerModel,
        width,
        height,
        num_images: 1,
      }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 45_000),
    });
  } catch {
    throw new ApiError(503, "IMAGE_PROVIDER_UNAVAILABLE", "Leonardo is unreachable.");
  }
  if (!response.ok) {
    throw new ApiError(
      502,
      "IMAGE_PROVIDER_FAILED",
      `Leonardo rejected the generation (HTTP ${response.status}).`,
    );
  }
  const body = (await response.json().catch(() => null)) as
    | { sdGenerationJob?: { generationId?: unknown; apiCreditCost?: unknown }; apiCreditCost?: unknown }
    | null;
  const jobId = body?.sdGenerationJob?.generationId;
  const rawCost = body?.sdGenerationJob?.apiCreditCost ?? body?.apiCreditCost;
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new ApiError(502, "IMAGE_PROVIDER_FAILED", "Leonardo returned no generation id.");
  }
  return {
    provider: "leonardo",
    modelKey: model.key,
    jobId,
    apiCreditCost:
      typeof rawCost === "number" && Number.isInteger(rawCost) && rawCost >= 0 ? rawCost : null,
  };
}

export interface LeonardoGenerationStatus {
  status: "pending" | "succeeded" | "failed";
  imageUrls: string[];
  /** Credits and the provider's cost object, when the poll response carries them. */
  apiCreditCost: number | null;
  cost: Record<string, unknown> | null;
}

/** Polls a v1 generation; COMPLETE carries the generated image URLs. */
export async function fetchLeonardoGeneration(
  settings: ImageProviderSettings,
  jobId: string,
  deps: ImageAdapterDeps = {},
): Promise<LeonardoGenerationStatus> {
  const leonardo = settings.leonardo;
  if (!leonardo) disabled("leonardo");
  if (!/^[A-Za-z0-9-]{1,64}$/.test(jobId)) {
    throw new ApiError(400, "IMAGE_JOB_INVALID", "That generation id is not valid.");
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      `https://cloud.leonardo.ai/api/rest/v1/generations/${encodeURIComponent(jobId)}`,
      {
        headers: { Authorization: `Bearer ${leonardo.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
      },
    );
  } catch {
    throw new ApiError(503, "IMAGE_PROVIDER_UNAVAILABLE", "Leonardo is unreachable.");
  }
  if (!response.ok) {
    throw new ApiError(
      502,
      "IMAGE_PROVIDER_FAILED",
      `Leonardo rejected the status read (HTTP ${response.status}).`,
    );
  }
  const body = (await response.json().catch(() => null)) as
    | {
        generations_by_pk?: {
          status?: unknown;
          generated_images?: { url?: unknown }[] | null;
          apiCreditCost?: unknown;
          cost?: unknown;
        } | null;
      }
    | null;
  const job = body?.generations_by_pk;
  if (!job) {
    throw new ApiError(502, "IMAGE_PROVIDER_FAILED", "Leonardo returned no generation.");
  }
  const raw = String(job.status ?? "").toUpperCase();
  const rawCredits = job.apiCreditCost;
  const apiCreditCost =
    typeof rawCredits === "number" && Number.isInteger(rawCredits) && rawCredits >= 0
      ? rawCredits
      : null;
  const cost =
    job.cost && typeof job.cost === "object" && !Array.isArray(job.cost)
      ? (job.cost as Record<string, unknown>)
      : null;
  if (raw === "PENDING") return { status: "pending", imageUrls: [], apiCreditCost, cost };
  if (raw !== "COMPLETE") return { status: "failed", imageUrls: [], apiCreditCost, cost };
  const imageUrls = (job.generated_images ?? [])
    .map((image) => image?.url)
    .filter((url): url is string => typeof url === "string" && /^https:\/\//.test(url));
  if (imageUrls.length === 0) return { status: "failed", imageUrls: [], apiCreditCost, cost };
  return { status: "succeeded", imageUrls, apiCreditCost, cost };
}
