import { ApiError } from "./api-error";

/**
 * Phase 8 spending ledger for Deepgram.
 *
 * Deepgram bills text-to-speech by input characters, not by returned seconds,
 * and it does not return a per-request price. Every preview and generation is
 * therefore recorded before the billable call at the catalog's verified
 * per-character rate. A failed call remains a failed row and still counts,
 * because the provider may have processed the request before failing.
 */

export type NarrationUsageKind = "preview" | "generation";
export type NarrationUsageStatus = "pending" | "succeeded" | "failed";

export interface NarrationUsageTotals {
  previews: number;
  generations: number;
  characters: number;
  spentUsd: number;
  oldestAt: string | null;
}

export interface NarrationReservation {
  usageId: string | null;
  allowed: boolean;
  charactersUsed: number;
  spentUsd: number;
  oldestAt: string | null;
}

export interface NarrationUsageLimits {
  characters: number;
  usd: number;
  windowSeconds: number;
}

export interface NarrationUsageStore {
  /** Atomically checks the rolling total and reserves the attempt in one database transaction. */
  reserve(
    ownerId: string,
    projectId: string,
    write: {
      kind: NarrationUsageKind;
      characters: number;
      costUsd: number;
      rateVersion: string;
    },
    limits: NarrationUsageLimits,
  ): Promise<NarrationReservation>;
  settle(ownerId: string, id: string, status: Exclude<NarrationUsageStatus, "pending">): Promise<void>;
  totalsSince(ownerId: string, sinceIso: string): Promise<NarrationUsageTotals>;
}

interface SupabaseNarrationUsageOptions {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
}

const COLUMNS = "kind,characters,cost_usd,created_at";

export function createSupabaseNarrationUsageStore(
  options: SupabaseNarrationUsageOptions,
): NarrationUsageStore {
  const base = `${options.url.replace(/\/+$/, "")}/rest/v1`;
  const authHeaders = {
    apikey: options.serviceRoleKey,
    Authorization: `Bearer ${options.serviceRoleKey}`,
  };
  const readHeaders = { ...authHeaders, Accept: "application/json" };
  const writeHeaders = {
    ...authHeaders,
    "Content-Type": "application/json",
    Accept: "application/json",
    Prefer: "return=representation",
  };

  async function request(target: string, init: RequestInit, action: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(target, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch {
      throw new ApiError(503, "NARRATION_USAGE_UNAVAILABLE", "The narration usage ledger is unreachable.");
    }
    if (!response.ok) {
      throw new ApiError(
        503,
        "NARRATION_USAGE_UNAVAILABLE",
        `The narration usage ledger rejected ${action} (HTTP ${response.status}).`,
      );
    }
    return response.json().catch(() => null);
  }

  function rows(payload: unknown): Record<string, unknown>[] {
    if (!Array.isArray(payload)) {
      throw new ApiError(
        503,
        "NARRATION_USAGE_UNAVAILABLE",
        "The narration usage ledger returned an unreadable response.",
      );
    }
    return payload.map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>) : {}));
  }

  return {
    async reserve(ownerId, projectId, write, limits) {
      const payload = await request(
        `${base}/rpc/reserve_narration_usage`,
        {
          method: "POST",
          headers: writeHeaders,
          body: JSON.stringify({
            p_owner_id: ownerId,
            p_project_id: projectId,
            p_kind: write.kind,
            p_characters: write.characters,
            p_cost_usd: write.costUsd,
            p_rate_version: write.rateVersion,
            p_character_limit: limits.characters,
            p_usd_limit: limits.usd,
            p_window_seconds: limits.windowSeconds,
          }),
        },
        "the narration usage reservation",
      );
      const row = rows(payload)[0];
      if (!row || typeof row.allowed !== "boolean") {
        throw new ApiError(
          503,
          "NARRATION_USAGE_UNAVAILABLE",
          "The narration usage ledger did not confirm the reservation.",
        );
      }
      const usageId = row.usage_id;
      if (row.allowed && typeof usageId !== "string") {
        throw new ApiError(
          503,
          "NARRATION_USAGE_UNAVAILABLE",
          "The narration usage ledger did not return the reserved row.",
        );
      }
      return {
        usageId: typeof usageId === "string" ? usageId : null,
        allowed: row.allowed,
        charactersUsed: typeof row.characters_used === "number" ? row.characters_used : 0,
        spentUsd: typeof row.spent_usd === "number" ? row.spent_usd : Number(row.spent_usd ?? 0),
        oldestAt: typeof row.oldest_at === "string" ? row.oldest_at : null,
      };
    },

    async settle(ownerId, id, status) {
      await request(
        `${base}/narration_usage?${new URLSearchParams({
          id: `eq.${id}`,
          owner_id: `eq.${ownerId}`,
        })}`,
        {
          method: "PATCH",
          headers: writeHeaders,
          body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
        },
        "the narration usage completion",
      );
    },

    async totalsSince(ownerId, sinceIso) {
      const found = rows(
        await request(
          `${base}/narration_usage?${new URLSearchParams({
            select: COLUMNS,
            owner_id: `eq.${ownerId}`,
            created_at: `gte.${sinceIso}`,
            order: "created_at.asc",
            limit: "5000",
          })}`,
          { headers: readHeaders },
          "the narration usage total",
        ),
      );
      let previews = 0;
      let generations = 0;
      let characters = 0;
      let spentUsd = 0;
      let oldestAt: string | null = null;
      for (const row of found) {
        if (row.kind === "preview") previews += 1;
        else if (row.kind === "generation") generations += 1;
        if (typeof row.characters === "number" && Number.isFinite(row.characters)) {
          characters += row.characters;
        }
        if (typeof row.cost_usd === "number" && Number.isFinite(row.cost_usd)) {
          spentUsd += row.cost_usd;
        }
        if (oldestAt === null && typeof row.created_at === "string") oldestAt = row.created_at;
      }
      return {
        previews,
        generations,
        characters,
        spentUsd: Number(spentUsd.toFixed(6)),
        oldestAt,
      };
    },
  };
}
