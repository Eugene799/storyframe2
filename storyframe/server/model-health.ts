import { ApiError } from "./api-error";

/**
 * Per-model planning health. The registry's "last successful check" is read
 * from here, so it reports what actually happened rather than a claim made
 * when the model was configured. Rows are global and service-role only.
 *
 * Counters are read-then-write, so two simultaneous calls can lose one
 * increment. That is acceptable for health reporting; the timestamps are what
 * the registry exposes.
 */

export interface ModelHealthRecord {
  modelId: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: string | null;
  successCount: number;
  failureCount: number;
}

export interface ModelHealthStore {
  list(): Promise<ModelHealthRecord[]>;
  recordSuccess(modelId: string, at: string): Promise<void>;
  recordFailure(modelId: string, at: string, errorCode: string): Promise<void>;
}

interface SupabaseModelHealthOptions {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRecord(row: Record<string, unknown>): ModelHealthRecord {
  return {
    modelId: String(row.model_id),
    lastSuccessAt: typeof row.last_success_at === "string" ? row.last_success_at : null,
    lastFailureAt: typeof row.last_failure_at === "string" ? row.last_failure_at : null,
    lastErrorCode: typeof row.last_error_code === "string" ? row.last_error_code : null,
    successCount: typeof row.success_count === "number" ? row.success_count : 0,
    failureCount: typeof row.failure_count === "number" ? row.failure_count : 0,
  };
}

export function createSupabaseModelHealthStore(options: SupabaseModelHealthOptions): ModelHealthStore {
  const base = `${options.url.replace(/\/+$/, "")}/rest/v1/model_health`;
  const authHeaders = {
    apikey: options.serviceRoleKey,
    Authorization: `Bearer ${options.serviceRoleKey}`,
  };
  const readHeaders = { ...authHeaders, Accept: "application/json" };
  const jsonHeaders = { ...authHeaders, "Content-Type": "application/json", Accept: "application/json" };
  const writeHeaders = { ...jsonHeaders, Prefer: "return=representation" };

  async function send(target: string, init: RequestInit, action: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(target, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch {
      throw new ApiError(503, "MODEL_HEALTH_UNAVAILABLE", "The model registry is unreachable.");
    }
    if (!response.ok) {
      throw new ApiError(
        503,
        "MODEL_HEALTH_UNAVAILABLE",
        `The model registry rejected ${action} (HTTP ${response.status}).`,
      );
    }
    return response;
  }

  async function find(modelId: string): Promise<ModelHealthRecord | null> {
    const response = await send(
      `${base}?select=*&model_id=eq.${encodeURIComponent(modelId)}&limit=1`,
      { headers: readHeaders },
      "the model health read",
    );
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!Array.isArray(payload)) return null;
    const row = payload.find((entry) => isRecord(entry) && entry.model_id === modelId);
    return row && isRecord(row) ? toRecord(row) : null;
  }

  async function patch(modelId: string, fields: Record<string, unknown>, action: string): Promise<number> {
    const response = await send(
      `${base}?model_id=eq.${encodeURIComponent(modelId)}`,
      { method: "PATCH", headers: writeHeaders, body: JSON.stringify(fields) },
      action,
    );
    const payload = (await response.json().catch(() => null)) as unknown;
    return Array.isArray(payload) ? payload.length : 0;
  }

  async function insert(modelId: string, fields: Record<string, unknown>, action: string): Promise<boolean> {
    try {
      await send(
        base,
        { method: "POST", headers: jsonHeaders, body: JSON.stringify({ model_id: modelId, ...fields }) },
        action,
      );
      return true;
    } catch {
      return false;
    }
  }

  async function merge(modelId: string, fields: Record<string, unknown>, action: string): Promise<void> {
    if ((await patch(modelId, fields, action)) > 0) return;
    if (await insert(modelId, fields, action)) return;
    // A concurrent first call may have inserted the row between our read and
    // this insert; the primary key rejected ours, so apply it as an update.
    if ((await patch(modelId, fields, action)) > 0) return;
    throw new ApiError(503, "MODEL_HEALTH_UNAVAILABLE", "The model registry could not record the outcome.");
  }

  return {
    async list() {
      const response = await send(`${base}?select=*`, { headers: readHeaders }, "the model health list");
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!Array.isArray(payload)) {
        throw new ApiError(503, "MODEL_HEALTH_UNAVAILABLE", "The model registry returned an unreadable response.");
      }
      return payload.filter(isRecord).map(toRecord);
    },

    async recordSuccess(modelId, at) {
      const existing = await find(modelId);
      await merge(
        modelId,
        {
          last_success_at: at,
          success_count: (existing?.successCount ?? 0) + 1,
          updated_at: at,
        },
        "the success record",
      );
    },

    async recordFailure(modelId, at, errorCode) {
      const existing = await find(modelId);
      await merge(
        modelId,
        {
          last_failure_at: at,
          last_error_code: errorCode.slice(0, 80),
          failure_count: (existing?.failureCount ?? 0) + 1,
          updated_at: at,
        },
        "the failure record",
      );
    },
  };
}
