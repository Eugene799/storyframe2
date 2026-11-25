import type { PlanningStatus } from "./planning-contract";

/**
 * Types shared by the browser and the server. These carry no credentials.
 */

export type AiModelId = string;

export interface AiModelInfo {
  /** Stable family key used by the client. */
  id: string;
  label: string;
  family: string;
  /** Exact direct-request identifier, or null when the model is disabled. */
  requestId: string | null;
  available: boolean;
  reason: string | null;
  catalogStatus: "listed" | "not-listed";
}

export interface AiStatusResponse {
  service: "storyframe-ai";
  mode: "development";
  configured: boolean;
  keyConfigured: boolean;
  auth: {
    mode: "supabase";
    configured: boolean;
    publishableKeyConfigured: boolean;
  };
  ledger: {
    configured: boolean;
    ready: boolean;
    serviceRoleConfigured: boolean;
    table: "ai_usage";
  };
  provider: {
    name: "ollama-cloud";
    baseUrl: string;
  };
  catalog: {
    source: "ollama.com/api/tags";
    checkedOn: string;
  };
  limits: {
    promptMaxChars: number;
    bodyMaxBytes: number;
    providerTimeoutMs: number;
    maxOutputTokens: number;
    maxConcurrentRequests: number;
    requestsPerMinute: number;
    /** Age at which a pending reservation may be settled instead of retried. */
    abandonAfterMs: number;
  };
  models: AiModelInfo[];
  /** Configured route per planning task, plus registry health. */
  planning: PlanningStatus;
}

export interface AiUsage {
  promptEvalCount: number | null;
  evalCount: number | null;
}

export interface AiTestSuccess {
  ok: true;
  modelId: string;
  configuredModel: string;
  returnedModel: string | null;
  reply: string;
  latencyMs: number;
  usage: AiUsage;
  doneReason: string | null;
}

export type AiUsageStatus = "success" | "error";

export interface AiUsageRecord {
  id: string;
  modelId: string;
  configuredModel: string;
  returnedModel: string | null;
  promptEvalCount: number | null;
  evalCount: number | null;
  latencyMs: number;
  status: AiUsageStatus;
  errorCode: string | null;
  upstreamStatus: number | null;
  createdAt: string;
}

export interface AiUsageListResponse {
  ok: true;
  usage: AiUsageRecord[];
}

export interface AiErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
    upstreamStatus?: number;
    /** Structured recovery data for codes that have one, such as a pending job. */
    details?: unknown;
  };
}
