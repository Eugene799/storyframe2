import { ApiError } from "./api-error";
import { findImageModel, type ImageModelDefinition } from "./image-providers";
import type {
  ImageEstimate,
  ImageGenerationInput,
  ImageGenerationRecord,
  ImageGenerationStatus,
} from "../shared/image-generation-contract";

/**
 * Phase 7: estimate math, request parsing, and the persisted generation store.
 * Provider calls and R2 writes live in the route handler; this module never
 * touches credentials.
 */

export function validateImagePrompt(model: ImageModelDefinition, raw: string): string {
  const prompt = raw.trim();
  if (!prompt) {
    throw new ApiError(400, "IMAGE_PROMPT_REQUIRED", "An image prompt is required.");
  }
  if (prompt.length > model.maxPromptChars) {
    throw new ApiError(
      400,
      "IMAGE_PROMPT_TOO_LONG",
      `${model.label} prompts are limited to ${model.maxPromptChars} characters.`,
    );
  }
  return prompt;
}

export function parseImageGenerationInput(input: unknown): ImageGenerationInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "INVALID_IMAGE_GENERATION", "Request body must be a JSON object.");
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set(["modelKey", "prompt", "width", "height", "steps"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNEXPECTED_FIELD", `Request body may only contain ${[...allowed].join(", ")}.`);
    }
  }
  if (typeof record.modelKey !== "string" || record.modelKey.length === 0) {
    throw new ApiError(400, "INVALID_IMAGE_GENERATION", "modelKey is required.");
  }
  if (typeof record.prompt !== "string") {
    throw new ApiError(400, "INVALID_IMAGE_GENERATION", "prompt must be a string.");
  }
  for (const field of ["width", "height", "steps"] as const) {
    const value = record[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value))) {
      throw new ApiError(400, "INVALID_IMAGE_GENERATION", `${field} must be an integer.`);
    }
  }
  return {
    modelKey: record.modelKey,
    prompt: record.prompt,
    ...(record.width === undefined ? {} : { width: record.width as number }),
    ...(record.height === undefined ? {} : { height: record.height as number }),
    ...(record.steps === undefined ? {} : { steps: record.steps as number }),
  };
}

export interface ResolvedImageRequest {
  model: ImageModelDefinition;
  prompt: string;
  width: number;
  height: number;
  steps: number | null;
}

/** Applies one provider's verified parameter rules; the other's are never assumed. */
export function resolveImageRequest(input: ImageGenerationInput): ResolvedImageRequest {
  const model = findImageModel(input.modelKey);
  if (!model) {
    throw new ApiError(400, "IMAGE_MODEL_UNKNOWN", "That image model is not in the verified catalog.");
  }
  const prompt = validateImagePrompt(model, input.prompt);
  const width = input.width ?? model.width;
  const height = input.height ?? model.height;
  if (width !== model.width || height !== model.height) {
    if (model.provider === "cloudflare") {
      throw new ApiError(400, "IMAGE_SIZE_INVALID", `${model.label} returns a fixed ${model.width}x${model.height} image.`);
    }
    for (const size of [width, height]) {
      if (size < 32 || size > 2048 || size % 8 !== 0) {
        throw new ApiError(400, "IMAGE_SIZE_INVALID", "Leonardo sizes must be 32-2048 in multiples of 8.");
      }
    }
  }
  const steps = input.steps ?? model.steps;
  if (steps !== null) {
    const max = model.provider === "cloudflare" ? 8 : model.steps ?? 8;
    if (!Number.isInteger(steps) || steps < 1 || steps > max) {
      throw new ApiError(400, "IMAGE_STEPS_INVALID", `${model.label} supports 1 to ${max} steps.`);
    }
  }
  return { model, prompt, width, height, steps };
}

/** Cost preview. Unknown USD stays null rather than being guessed. */
export function estimateImageGeneration(request: ResolvedImageRequest): ImageEstimate {
  const { model, width, height, steps } = request;
  const billing = model.billing;
  if (billing.kind === "neurons") {
    const effectiveSteps = steps ?? 4;
    const tiles = Math.ceil(width / 512) * Math.ceil(height / 512);
    const neurons = Number(
      (tiles * (billing.neuronsPerTile + billing.neuronsPerStep * effectiveSteps)).toFixed(2),
    );
    return {
      modelKey: model.key,
      provider: model.provider,
      width,
      height,
      steps,
      estimatedNeurons: neurons,
      estimatedUsd: Number(((neurons / 1000) * billing.usdPerThousandNeurons).toFixed(6)),
      rateVersion: model.rateVersion,
      billing: {
        kind: "neurons",
        usdPerThousandNeurons: billing.usdPerThousandNeurons,
        neuralRates: { perTile: billing.neuronsPerTile, perStep: billing.neuronsPerStep },
        note: `Includes ${billing.freeDailyNeurons.toLocaleString("en-US")} free neurons per day at the account level.`,
        sourceUrl: billing.sourceUrl,
        verifiedOn: billing.verifiedOn,
      },
    };
  }
  return {
    modelKey: model.key,
    provider: model.provider,
    width,
    height,
    steps,
    estimatedNeurons: null,
    estimatedUsd: null,
    rateVersion: model.rateVersion,
    billing: {
      kind: "api-credit",
      note: billing.note,
      sourceUrl: billing.sourceUrl,
      verifiedOn: billing.verifiedOn,
    },
  };
}

// ---- Store ------------------------------------------------------------------

const COLUMNS =
  "id,project_id,provider,model_key,prompt,settings,status,job_id,media_id,estimated_usd,estimated_neurons,actual_usd,actual_neurons,cost_source,rate_version,provider_cost,error_code,created_at,updated_at";

function corrupt(field: string): never {
  throw new ApiError(503, "IMAGE_STORE_CORRUPT", `The image store returned a malformed row (${field}).`);
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

function toRecord(row: Record<string, unknown>): ImageGenerationRecord {
  const provider = row.provider;
  if (provider !== "cloudflare" && provider !== "leonardo") corrupt("provider");
  const status = row.status;
  if (status !== "pending" && status !== "succeeded" && status !== "failed") corrupt("status");
  if (!row.settings || typeof row.settings !== "object" || Array.isArray(row.settings)) corrupt("settings");
  const settings = row.settings as Record<string, unknown>;
  if (typeof settings.width !== "number" || typeof settings.height !== "number") corrupt("settings");
  const numeric = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : corrupt("numeric");
  };
  const usd = numeric(row.estimated_usd);
  const neurons = numeric(row.estimated_neurons);
  const costSource = row.cost_source;
  if (costSource !== null && costSource !== undefined && costSource !== "provider" && costSource !== "rate" && costSource !== "credits") {
    corrupt("cost_source");
  }
  return {
    id: text(row, "id"),
    projectId: text(row, "project_id"),
    provider,
    modelKey: text(row, "model_key"),
    prompt: text(row, "prompt"),
    settings: {
      width: settings.width,
      height: settings.height,
      steps: typeof settings.steps === "number" ? settings.steps : null,
    },
    status,
    jobId: nullableText(row, "job_id"),
    mediaId: nullableText(row, "media_id"),
    estimatedUsd: usd,
    estimatedNeurons: neurons,
    actualUsd: numeric(row.actual_usd),
    actualNeurons: numeric(row.actual_neurons),
    costSource: (costSource ?? null) as ImageGenerationRecord["costSource"],
    rateVersion: text(row, "rate_version"),
    providerCost:
      row.provider_cost && typeof row.provider_cost === "object" && !Array.isArray(row.provider_cost)
        ? (row.provider_cost as Record<string, unknown>)
        : null,
    errorCode: nullableText(row, "error_code"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

export interface ImageGenerationCreate {
  id: string;
  projectId: string;
  provider: "cloudflare" | "leonardo";
  modelKey: string;
  prompt: string;
  settings: { width: number; height: number; steps: number | null };
  estimatedUsd: number | null;
  estimatedNeurons: number | null;
  rateVersion: string;
}

export interface ImageGenerationPatch {
  status?: ImageGenerationStatus;
  jobId?: string | null;
  mediaId?: string | null;
  providerCost?: Record<string, unknown> | null;
  actualUsd?: number | null;
  actualNeurons?: number | null;
  costSource?: "provider" | "rate" | "credits" | null;
  errorCode?: string | null;
}

export interface ImageSpendSnapshot {
  attempts: number;
  /** What the guard charges: actual cost when settled, otherwise the estimate. */
  spentUsd: number;
  actualUsd: number;
  estimatedUsd: number;
  /** Oldest counted attempt, which decides when the window frees up. */
  oldestAt: string | null;
}

export interface ImageGenerationStore {
  create(ownerId: string, generation: ImageGenerationCreate): Promise<ImageGenerationRecord>;
  /** The oldest generation still pending for this owner, across projects. */
  findPending(ownerId: string): Promise<ImageGenerationRecord | null>;
  /** Settles only a row that is still pending; null means it already settled. */
  settlePending(
    ownerId: string,
    projectId: string,
    generationId: string,
    errorCode: string,
  ): Promise<ImageGenerationRecord | null>;
  /** Settles every pending row older than the cutoff, across owners. */
  abandonStale(beforeIso: string): Promise<number>;
  /** Every recorded attempt in the window, whatever its final status, since a
   *  failed attempt may still have been billed by the provider. */
  usageSince(ownerId: string, sinceIso: string): Promise<ImageSpendSnapshot>;
  update(
    ownerId: string,
    projectId: string,
    generationId: string,
    patch: ImageGenerationPatch,
  ): Promise<ImageGenerationRecord | null>;
  get(ownerId: string, projectId: string, generationId: string): Promise<ImageGenerationRecord | null>;
  list(ownerId: string, projectId: string, limit: number): Promise<ImageGenerationRecord[]>;
}

export interface SupabaseImageGenerationStoreOptions {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
}

export function createSupabaseImageGenerationStore(
  options: SupabaseImageGenerationStoreOptions,
): ImageGenerationStore {
  const base = `${options.url.replace(/\/+$/, "")}/rest/v1`;
  const headers = {
    apikey: options.serviceRoleKey,
    Authorization: `Bearer ${options.serviceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    Prefer: "return=representation",
  };

    async function request(target: string, init: RequestInit, action: string): Promise<unknown> {
    let response: Response;

    try {
      response = await fetch(target, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch {
      throw new ApiError(503, "IMAGE_STORE_UNAVAILABLE", "The image store is unreachable.");
    }
    if (response.status === 409) {
      // The partial unique index on pending generations is the race backstop.
      throw new ApiError(
        429,
        "IMAGE_GENERATION_IN_FLIGHT",
        "An image generation is already pending for this account. Refresh or settle it before starting another.",
      );
    }
    if (!response.ok) {
      throw new ApiError(
        503,
        "IMAGE_STORE_UNAVAILABLE",
        `The image store rejected ${action} (HTTP ${response.status}).`,
      );
    }
    return response.json().catch(() => null);
  }

  function rows(payload: unknown): Record<string, unknown>[] {
    if (!Array.isArray(payload)) {
      throw new ApiError(503, "IMAGE_STORE_UNAVAILABLE", "The image store returned an unreadable response.");
    }
    return payload.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  }

  function tableUrl(query: Record<string, string> = {}): string {
    return `${base}/image_generations?${new URLSearchParams(query)}`;
  }

  return {
    async create(ownerId, generation) {
      const created = rows(
        await request(
          tableUrl(),
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              id: generation.id,
              owner_id: ownerId,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              project_id: generation.projectId,
              provider: generation.provider,
              model_key: generation.modelKey,
              prompt: generation.prompt,
              settings: generation.settings,
              status: "pending",
              estimated_usd: generation.estimatedUsd,
              estimated_neurons: generation.estimatedNeurons,
              rate_version: generation.rateVersion,
            }),
          },
          "the generation save",
        ),
      );
      if (created.length === 0) {
        throw new ApiError(503, "IMAGE_STORE_UNAVAILABLE", "The image store did not confirm the generation.");
      }
      return toRecord(created[0]);
    },

    async findPending(ownerId) {
      const found = rows(
        await request(
          tableUrl({
            select: COLUMNS,
            owner_id: `eq.${ownerId}`,
            status: "eq.pending",
            order: "created_at.asc",
            limit: "1",
          }),
          { headers },
          "the pending generation read",
        ),
      );
      return found.length === 0 ? null : toRecord(found[0]);
    },

    async settlePending(ownerId, projectId, generationId, errorCode) {
      const settled = rows(
        await request(
          tableUrl({
            id: `eq.${generationId}`,
            project_id: `eq.${projectId}`,
            owner_id: `eq.${ownerId}`,
            status: "eq.pending",
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              status: "failed",
              error_code: errorCode,
              updated_at: new Date().toISOString(),
            }),
          },
          "the pending generation settle",
        ),
      );
      return settled.length === 0 ? null : toRecord(settled[0]);
    },

    async abandonStale(beforeIso) {
      const settled = rows(
        await request(
          tableUrl({ status: "eq.pending", created_at: `lt.${beforeIso}` }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              status: "failed",
              error_code: "IMAGE_GENERATION_ABANDONED",
              updated_at: new Date().toISOString(),
            }),
          },
          "the abandoned generation sweep",
        ),
      );
      return settled.length;
    },

    async usageSince(ownerId, sinceIso) {
      const found = rows(
        await request(
          tableUrl({
            select: "created_at,estimated_usd,actual_usd",
            owner_id: `eq.${ownerId}`,
            created_at: `gte.${sinceIso}`,
            order: "created_at.asc",
            limit: "1000",
          }),
          { headers },
          "the image usage read",
        ),
      );
      const amount = (value: unknown): number => {
        if (value === null || value === undefined) return 0;
        const parsed = typeof value === "number" ? value : Number(value);
        return Number.isFinite(parsed) ? parsed : corrupt("cost");
      };
      let estimatedUsd = 0;
      let actualUsd = 0;
      let spentUsd = 0;
      for (const row of found) {
        const estimated = amount(row.estimated_usd);
        const hasActual = row.actual_usd !== null && row.actual_usd !== undefined;
        const actual = amount(row.actual_usd);
        estimatedUsd += estimated;
        actualUsd += actual;
        spentUsd += hasActual ? actual : estimated;
      }
      const oldest = found[0]?.created_at;
      return {
        attempts: found.length,
        spentUsd: Number(spentUsd.toFixed(6)),
        actualUsd: Number(actualUsd.toFixed(6)),
        estimatedUsd: Number(estimatedUsd.toFixed(6)),
        oldestAt: typeof oldest === "string" ? oldest : null,
      };
    },

    async update(ownerId, projectId, generationId, patch) {
      const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.status !== undefined) body.status = patch.status;
      if (patch.jobId !== undefined) body.job_id = patch.jobId;
      if (patch.mediaId !== undefined) body.media_id = patch.mediaId;
      if (patch.providerCost !== undefined) body.provider_cost = patch.providerCost;
      if (patch.actualUsd !== undefined) body.actual_usd = patch.actualUsd;
      if (patch.actualNeurons !== undefined) body.actual_neurons = patch.actualNeurons;
      if (patch.costSource !== undefined) body.cost_source = patch.costSource;
      if (patch.errorCode !== undefined) body.error_code = patch.errorCode;
      const updated = rows(
        await request(
          tableUrl({
            id: `eq.${generationId}`,
            project_id: `eq.${projectId}`,
            owner_id: `eq.${ownerId}`,
          }),
          { method: "PATCH", headers, body: JSON.stringify(body) },
          "the generation update",
        ),
      );
      return updated.length === 0 ? null : toRecord(updated[0]);
    },

    async get(ownerId, projectId, generationId) {
      const found = rows(
        await request(
          tableUrl({
            select: COLUMNS,
            id: `eq.${generationId}`,
            project_id: `eq.${projectId}`,
            owner_id: `eq.${ownerId}`,
            limit: "1",
          }),
          { headers },
          "the generation read",
        ),
      );
      return found.length === 0 ? null : toRecord(found[0]);
    },

    async list(ownerId, projectId, limit) {
      const found = rows(
        await request(
          tableUrl({
            select: COLUMNS,
            project_id: `eq.${projectId}`,
            owner_id: `eq.${ownerId}`,
            order: "created_at.desc",
            limit: String(limit),
          }),
          { headers },
          "the generation list",
        ),
      );
      return found.map(toRecord);
    },
  };
}
