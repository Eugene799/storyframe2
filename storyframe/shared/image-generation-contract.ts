import type { MediaRecord } from "./media-contract";

/** Phase 7: explicit, cost-estimated image generation. */
export type ImageProviderId = "cloudflare" | "leonardo";
export type ImageGenerationStatus = "pending" | "succeeded" | "failed";

export interface ImageBillingView {
  kind: "neurons" | "api-credit";
  /** Dollars per 1,000 neurons (Cloudflare), or null when not published. */
  usdPerThousandNeurons?: number;
  neuralRates?: { perTile: number; perStep: number };
  note?: string;
  sourceUrl: string;
  verifiedOn: string;
}

export interface ImageModelView {
  key: string;
  provider: ImageProviderId;
  label: string;
  width: number;
  height: number;
  steps: number | null;
  maxPromptChars: number;
  configured: boolean;
  billing: ImageBillingView;
}

export interface ImageModelsResponse {
  ok: true;
  models: ImageModelView[];
}

export interface ImageGenerationInput {
  modelKey: string;
  prompt: string;
  width?: number;
  height?: number;
  steps?: number;
}

export interface ImageEstimate {
  modelKey: string;
  provider: ImageProviderId;
  width: number;
  height: number;
  steps: number | null;
  estimatedNeurons: number | null;
  estimatedUsd: number | null;
  rateVersion: string;
  billing: ImageBillingView;
}

export interface ImageEstimateResponse {
  ok: true;
  estimate: ImageEstimate;
}

export type ImageCostSource = "provider" | "rate" | "credits";

export interface ImageGenerationRecord {
  id: string;
  projectId: string;
  provider: ImageProviderId;
  modelKey: string;
  prompt: string;
  settings: { width: number; height: number; steps: number | null };
  status: ImageGenerationStatus;
  jobId: string | null;
  mediaId: string | null;
  estimatedUsd: number | null;
  estimatedNeurons: number | null;
  /** Billed or provider-reported cost; null until the provider settles. */
  actualUsd: number | null;
  actualNeurons: number | null;
  costSource: ImageCostSource | null;
  rateVersion: string;
  providerCost: Record<string, unknown> | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImageGenerationResponse {
  ok: true;
  generation: ImageGenerationRecord;
  /** The persisted asset, only once the bytes are in private R2. */
  media: MediaRecord | null;
}

export interface ImageGenerationListResponse {
  ok: true;
  generations: ImageGenerationRecord[];
}

/** The caller's image cost ledger over the guard's rolling window. */
export interface ImageUsageSummary {
  windowHours: number;
  attempts: number;
  spentUsd: number;
  actualUsd: number;
  estimatedUsd: number;
  limits: { images: number | null; usd: number | null };
  resetAt: string | null;
}

export interface ImageUsageResponse {
  ok: true;
  usage: ImageUsageSummary;
  /** The job that would block a new generation, if one exists right now. */
  pending: ImagePendingJob | null;
}

/** The job blocking a new generation, wherever its project lives. */
export interface ImagePendingJob {
  generationId: string;
  projectId: string;
  jobId: string | null;
  provider: ImageProviderId;
  modelKey: string;
  createdAt: string;
}

export interface ImageGenerationInFlightDetails {
  pending: ImagePendingJob;
}
