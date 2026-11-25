import type { AiUsageRecord } from "../shared/ai-contract";

const TABLE = "ai_usage";
const COLUMNS = [
  "id",
  "model_id",
  "configured_model",
  "returned_model",
  "prompt_eval_count",
  "eval_count",
  "latency_ms",
  "status",
  "error_code",
  "upstream_status",
  "created_at",
].join(",");
// PostgREST returns only the selected columns, so every field the reservation
// mapper reads must be listed here.
const RESERVATION_COLUMNS = [
  "id",
  "created_at",
  "status",
  "idempotency_key",
  "request_hash",
  "response_body",
  "response_status",
].join(",");
// The readiness probe must also prove all three ai_usage migrations exist.
// `project_id` belongs to the planning preflight migration, not to the
// reservation shape, so keep it out of ordinary reservation lookups.
const READINESS_COLUMNS = `${RESERVATION_COLUMNS},project_id`;

export class UsageLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageLedgerError";
  }
}

export type StoredUsageStatus = "pending" | "success" | "error";

export interface UsageReservation {
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  modelId: string;
  configuredModel: string;
  /** Set only for project-scoped planning attempts. */
  projectId?: string | null;
}

export interface PendingProjectAttempt {
  id: string;
  createdAt: string;
  idempotencyKey: string | null;
}

export interface ExistingUsage {
  id: string;
  createdAt: string;
  requestHash: string | null;
  status: StoredUsageStatus;
  responseStatus: number | null;
  responseBody: unknown;
}

export type ReservationResult =
  | { state: "reserved"; id: string }
  | { state: "existing"; usage: ExistingUsage }
  /** A different key already holds this project's single pending attempt. */
  | { state: "project_busy" };

export interface UsageCompletion {
  status: "success" | "error";
  returnedModel: string | null;
  promptEvalCount: number | null;
  evalCount: number | null;
  latencyMs: number;
  errorCode?: string | null;
  upstreamStatus?: number | null;
  responseStatus: number;
  responseBody: unknown;
}

export interface AbandonRequest {
  id: string;
  userId: string;
  /** Reservations created before this instant can no longer be running. */
  startedBefore: string;
  completion: UsageCompletion;
}

export interface UsageLedger {
  check(): Promise<void>;
  reserve(entry: UsageReservation): Promise<ReservationResult>;
  lookup(userId: string, idempotencyKey: string): Promise<ExistingUsage | null>;
  findPendingProjectAttempt(userId: string, projectId: string): Promise<PendingProjectAttempt | null>;
  /** Conditionally settles a stale pending reservation. False means it lost a race. */
  abandon(request: AbandonRequest): Promise<boolean>;
  /**
   * Settles a pending reservation owned by `userId`. False means no pending row
   * owned by that user matched, so it is unconfirmed.
   */
  complete(userId: string, id: string, completion: UsageCompletion): Promise<boolean>;
  listForUser(userId: string, limit: number): Promise<AiUsageRecord[]>;
}

interface SupabaseUsageLedgerOptions {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toExisting(row: Record<string, unknown>): ExistingUsage {
  const id = row.id;
  const createdAt = row.created_at;
  const status = row.status;
  const requestHash = row.request_hash;
  const responseStatus = row.response_status;
  const responseBody = row.response_body;

  if (typeof id !== "string" || id.length === 0) {
    throw new UsageLedgerError("The usage ledger returned a reservation without an id.");
  }
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) {
    throw new UsageLedgerError("The usage ledger returned a reservation without a usable timestamp.");
  }
  if (status !== "pending" && status !== "success" && status !== "error") {
    throw new UsageLedgerError("The usage ledger returned an invalid reservation state.");
  }
  if (requestHash !== null && typeof requestHash !== "string") {
    throw new UsageLedgerError("The usage ledger returned a malformed reservation.");
  }
  if (
    responseStatus !== null &&
    (typeof responseStatus !== "number" ||
      !Number.isInteger(responseStatus) ||
      responseStatus < 100 ||
      responseStatus > 599)
  ) {
    throw new UsageLedgerError("The usage ledger returned a malformed reservation status.");
  }

  // A completed reservation normally carries its stored response. Whether that
  // response is replayable is an HTTP concern, decided once by the route.
  return { id, createdAt, requestHash, status, responseStatus, responseBody };
}

function completionFields(completion: UsageCompletion): Record<string, unknown> {
  return {
    returned_model: completion.returnedModel,
    prompt_eval_count: completion.promptEvalCount,
    eval_count: completion.evalCount,
    latency_ms: completion.latencyMs,
    status: completion.status,
    error_code: completion.errorCode ?? null,
    upstream_status: completion.upstreamStatus ?? null,
    response_status: completion.responseStatus,
    response_body: completion.responseBody,
  };
}

function toRecord(row: Record<string, unknown>): AiUsageRecord {
  const id = row.id;
  const modelId = row.model_id;
  const configuredModel = row.configured_model;
  const latencyMs = row.latency_ms;
  const status = row.status;
  const createdAt = row.created_at;

  if (
    typeof id !== "string" ||
    typeof modelId !== "string" ||
    typeof configuredModel !== "string" ||
    typeof latencyMs !== "number" ||
    (status !== "success" && status !== "error") ||
    typeof createdAt !== "string"
  ) {
    throw new UsageLedgerError("The usage ledger returned a malformed row.");
  }

  return {
    id,
    modelId,
    configuredModel,
    returnedModel: nullableString(row.returned_model),
    promptEvalCount: nullableNumber(row.prompt_eval_count),
    evalCount: nullableNumber(row.eval_count),
    latencyMs,
    status,
    errorCode: nullableString(row.error_code),
    upstreamStatus: nullableNumber(row.upstream_status),
    createdAt,
  };
}

/**
 * Durable usage ledger backed by the Supabase PostgREST endpoint. Writes use the
 * server-only service role; every row carries the user id verified from the
 * caller's session, never a client-supplied owner id.
 */
export function createSupabaseUsageLedger(options: SupabaseUsageLedgerOptions): UsageLedger {
  const base = options.url.replace(/\/+$/, "");
  const endpoint = `${base}/rest/v1/${TABLE}`;
  const authHeaders = {
    apikey: options.serviceRoleKey,
    Authorization: `Bearer ${options.serviceRoleKey}`,
  };

  async function findPendingProjectAttempt(
    userId: string,
    projectId: string,
  ): Promise<PendingProjectAttempt | null> {
    const query = new URLSearchParams({
      select: "id,created_at,idempotency_key",
      user_id: `eq.${userId}`,
      project_id: `eq.${projectId}`,
      status: "eq.pending",
      order: "created_at.desc",
      limit: "1",
    });

    let response: Response;
    try {
      response = await fetch(`${endpoint}?${query}`, {
        headers: { ...authHeaders, Accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      throw new UsageLedgerError("The usage ledger is unreachable.");
    }
    if (!response.ok) {
      throw new UsageLedgerError(`The usage ledger rejected the project lookup (HTTP ${response.status}).`);
    }

    const payload: unknown = await response.json().catch(() => null);
    if (!Array.isArray(payload)) {
      throw new UsageLedgerError("The usage ledger returned an unreadable project attempt.");
    }
    const row = payload[0];
    if (!row || typeof row !== "object") return null;
    const record = row as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.created_at !== "string" ||
      !Number.isFinite(Date.parse(record.created_at)) ||
      (record.idempotency_key !== null && typeof record.idempotency_key !== "string")
    ) {
      throw new UsageLedgerError("The usage ledger returned a malformed project attempt.");
    }
    return {
      id: record.id,
      createdAt: record.created_at,
      idempotencyKey: record.idempotency_key,
    };
  }

  async function findReservation(userId: string, idempotencyKey: string): Promise<ExistingUsage | null> {
    const query = new URLSearchParams({
      select: RESERVATION_COLUMNS,
      user_id: `eq.${userId}`,
      idempotency_key: `eq.${idempotencyKey}`,
      limit: "1",
    });

    let response: Response;
    try {
      response = await fetch(`${endpoint}?${query}`, {
        headers: { ...authHeaders, Accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      throw new UsageLedgerError("The usage ledger is unreachable.");
    }
    if (!response.ok) {
      throw new UsageLedgerError(`The usage ledger rejected the lookup (HTTP ${response.status}).`);
    }

    const payload: unknown = await response.json().catch(() => null);
    if (!Array.isArray(payload)) {
      throw new UsageLedgerError("The usage ledger returned an unreadable reservation.");
    }
    const row = payload[0];
    return row && typeof row === "object" ? toExisting(row as Record<string, unknown>) : null;
  }

  return {
    async check(): Promise<void> {
      const query = new URLSearchParams({ select: READINESS_COLUMNS, limit: "0" });
      let response: Response;
      try {
        response = await fetch(`${endpoint}?${query}`, {
          headers: { ...authHeaders, Accept: "application/json" },
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch {
        throw new UsageLedgerError("The usage ledger is unreachable.");
      }
      if (!response.ok) {
        throw new UsageLedgerError(`The usage ledger is unavailable (HTTP ${response.status}).`);
      }
    },

    async reserve(entry: UsageReservation): Promise<ReservationResult> {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            ...authHeaders,
            "Content-Type": "application/json",
            Accept: "application/json",
            Prefer: "return=representation",
          },
          body: JSON.stringify({
            user_id: entry.userId,
            idempotency_key: entry.idempotencyKey,
            request_hash: entry.requestHash,
            model_id: entry.modelId,
            configured_model: entry.configuredModel,
            project_id: entry.projectId ?? null,
            latency_ms: 0,
            status: "pending",
          }),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch {
        throw new UsageLedgerError("The usage ledger is unreachable.");
      }

      if (response.status === 409) {
        const existing = await findReservation(entry.userId, entry.idempotencyKey);
        if (existing) return { state: "existing", usage: existing };
        if (entry.projectId && (await findPendingProjectAttempt(entry.userId, entry.projectId))) {
          return { state: "project_busy" };
        }
        throw new UsageLedgerError("The usage ledger rejected a duplicate reservation.");
      }
      if (!response.ok) {
        throw new UsageLedgerError(`The usage ledger rejected the reservation (HTTP ${response.status}).`);
      }

      const payload: unknown = await response.json().catch(() => null);
      const row = Array.isArray(payload) ? payload[0] : null;
      const id = row && typeof row === "object" ? (row as Record<string, unknown>).id : null;
      if (typeof id !== "string") {
        throw new UsageLedgerError("The usage ledger did not confirm the reservation.");
      }
      return { state: "reserved", id };
    },

    lookup(userId: string, idempotencyKey: string): Promise<ExistingUsage | null> {
      return findReservation(userId, idempotencyKey);
    },

    findPendingProjectAttempt,

    async abandon(request: AbandonRequest): Promise<boolean> {
      // Conditional on `pending`, on the owner, and on age: exactly one caller
      // can settle the reservation, and a live request is never overridden.
      const query = new URLSearchParams({
        id: `eq.${request.id}`,
        user_id: `eq.${request.userId}`,
        status: "eq.pending",
        created_at: `lt.${request.startedBefore}`,
      });
      let response: Response;
      try {
        response = await fetch(`${endpoint}?${query}`, {
          method: "PATCH",
          headers: {
            ...authHeaders,
            "Content-Type": "application/json",
            Accept: "application/json",
            Prefer: "return=representation",
          },
          body: JSON.stringify(completionFields(request.completion)),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch {
        throw new UsageLedgerError("The usage ledger is unreachable.");
      }
      if (!response.ok) {
        throw new UsageLedgerError(`The usage ledger rejected the recovery (HTTP ${response.status}).`);
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!Array.isArray(payload)) {
        throw new UsageLedgerError("The usage ledger returned an unreadable recovery result.");
      }
      return payload.length > 0;
    },

    async complete(userId: string, id: string, completion: UsageCompletion): Promise<boolean> {
      // The owner is part of the update predicate, not just an after-the-fact
      // check: a mixed-up reservation id can never settle another account's row.
      const query = new URLSearchParams({
        id: `eq.${id}`,
        user_id: `eq.${userId}`,
        status: "eq.pending",
      });
      let response: Response;
      try {
        response = await fetch(`${endpoint}?${query}`, {
          method: "PATCH",
          headers: {
            ...authHeaders,
            "Content-Type": "application/json",
            // The returned rows prove the conditional update matched. A 204
            // cannot distinguish a write from a reservation already settled.
            Prefer: "return=representation",
          },
          body: JSON.stringify(completionFields(completion)),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch {
        throw new UsageLedgerError("The usage ledger is unreachable.");
      }
      if (!response.ok) {
        throw new UsageLedgerError(`The usage ledger rejected the completion (HTTP ${response.status}).`);
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!Array.isArray(payload)) {
        throw new UsageLedgerError("The usage ledger returned an unreadable completion result.");
      }
      return payload.length > 0;
    },

    async listForUser(userId: string, limit: number): Promise<AiUsageRecord[]> {
      const query = new URLSearchParams({
        select: COLUMNS,
        user_id: `eq.${userId}`,
        status: "in.(success,error)",
        order: "created_at.desc",
        limit: String(limit),
      });

      let response: Response;
      try {
        response = await fetch(`${endpoint}?${query}`, {
          headers: { ...authHeaders, Accept: "application/json" },
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch {
        throw new UsageLedgerError("The usage ledger is unreachable.");
      }

      if (!response.ok) {
        throw new UsageLedgerError(`The usage ledger rejected the read (HTTP ${response.status}).`);
      }

      const payload: unknown = await response.json().catch(() => null);
      if (!Array.isArray(payload)) {
        throw new UsageLedgerError("The usage ledger returned an unreadable response.");
      }

      return payload.map((row) =>
        toRecord(row && typeof row === "object" ? (row as Record<string, unknown>) : {}),
      );
    },
  };
}
