import type { ProfileRecord } from "../shared/profile-contract";
import { ApiError } from "./api-error";

const PROFILES_TABLE = "profiles";
const COLUMNS = ["display_name", "workspace_name", "settings", "created_at", "updated_at"].join(",");

/** Upper bounds for one profile write. Larger requests are refused, never truncated. */
export const PROFILE_LIMITS = {
  bodyBytes: 16 * 1024,
  displayNameChars: 120,
  workspaceNameChars: 120,
  settingsBytes: 4096,
} as const;

export interface ProfileUpdate {
  displayName: string | null;
  workspaceName: string;
  settings: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readName(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_PROFILE", `${label} must be a string.`);
  }
  const text = value.trim();
  if (text.length === 0) {
    throw new ApiError(400, "INVALID_PROFILE", `${label} must not be empty.`);
  }
  if (text.length > maxChars) {
    throw new ApiError(400, "INVALID_PROFILE", `${label} must be at most ${maxChars} characters.`);
  }
  return text;
}

export function parseProfileUpdate(body: unknown): ProfileUpdate {
  if (!isRecord(body)) {
    throw new ApiError(400, "INVALID_BODY", "Request body must be a JSON object.");
  }
  for (const key of Object.keys(body)) {
    if (!["displayName", "workspaceName", "settings"].includes(key)) {
      throw new ApiError(
        400,
        "UNEXPECTED_FIELD",
        "Request body may only contain displayName, workspaceName, and settings.",
      );
    }
  }

  const workspaceName = readName(body.workspaceName, "workspaceName", PROFILE_LIMITS.workspaceNameChars);

  // An omitted or blank display name clears it; it is optional by design.
  const rawDisplayName = body.displayName;
  const displayName =
    rawDisplayName === undefined ||
    rawDisplayName === null ||
    (typeof rawDisplayName === "string" && rawDisplayName.trim().length === 0)
      ? null
      : readName(rawDisplayName, "displayName", PROFILE_LIMITS.displayNameChars);

  const settings = body.settings ?? {};
  if (!isRecord(settings)) {
    throw new ApiError(400, "INVALID_PROFILE", "settings must be a JSON object.");
  }
  if (Buffer.byteLength(JSON.stringify(settings)) > PROFILE_LIMITS.settingsBytes) {
    throw new ApiError(
      400,
      "INVALID_PROFILE",
      `settings must serialize to at most ${PROFILE_LIMITS.settingsBytes} bytes.`,
    );
  }

  return { displayName, workspaceName, settings };
}

function toProfile(row: Record<string, unknown>): ProfileRecord {
  const displayName = row.display_name;
  const workspaceName = row.workspace_name;
  const settings = row.settings;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;

  if (
    (displayName !== null && typeof displayName !== "string") ||
    typeof workspaceName !== "string" ||
    !isRecord(settings) ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    throw new ApiError(503, "PROFILE_STORE_CORRUPT", "The profile store returned a malformed row.");
  }

  return { displayName, workspaceName, settings, createdAt, updatedAt };
}

export interface ProfileStore {
  get(ownerId: string): Promise<ProfileRecord>;
  save(ownerId: string, update: ProfileUpdate): Promise<ProfileRecord>;
}

interface SupabaseProfileStoreOptions {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
}

/**
 * One workspace row per verified user. The owner id always comes from the
 * session, so a client cannot read or write another account's profile.
 */
export function createSupabaseProfileStore(options: SupabaseProfileStoreOptions): ProfileStore {
  const endpoint = `${options.url.replace(/\/+$/, "")}/rest/v1/${PROFILES_TABLE}`;
  const authHeaders = {
    apikey: options.serviceRoleKey,
    Authorization: `Bearer ${options.serviceRoleKey}`,
  };

  async function request(target: string, init: RequestInit, action: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(target, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch {
      throw new ApiError(503, "PROFILE_UNAVAILABLE", "The profile store is unreachable.");
    }
    if (!response.ok) {
      throw new ApiError(
        503,
        "PROFILE_UNAVAILABLE",
        `The profile store rejected ${action} (HTTP ${response.status}).`,
      );
    }
    return response.json().catch(() => null);
  }

  return {
    async get(ownerId: string): Promise<ProfileRecord> {
      const query = new URLSearchParams({ select: COLUMNS, owner_id: `eq.${ownerId}`, limit: "1" });
      const payload = await request(
        `${endpoint}?${query}`,
        { headers: { ...authHeaders, Accept: "application/json" } },
        "the read",
      );
      const row = Array.isArray(payload) ? payload[0] : null;
      if (!row || typeof row !== "object") {
        throw new ApiError(404, "PROFILE_NOT_FOUND", "This account has no profile yet.");
      }
      return toProfile(row as Record<string, unknown>);
    },

    async save(ownerId: string, update: ProfileUpdate): Promise<ProfileRecord> {
      const payload = await request(
        endpoint,
        {
          method: "POST",
          headers: {
            ...authHeaders,
            "Content-Type": "application/json",
            Accept: "application/json",
            // Upsert on the primary key, which is the verified owner id.
            Prefer: "resolution=merge-duplicates,return=representation",
          },
          body: JSON.stringify({
            owner_id: ownerId,
            display_name: update.displayName,
            workspace_name: update.workspaceName,
            settings: update.settings,
            updated_at: new Date().toISOString(),
          }),
        },
        "the save",
      );
      const row = Array.isArray(payload) ? payload[0] : null;
      if (!row || typeof row !== "object") {
        throw new ApiError(503, "PROFILE_UNAVAILABLE", "The profile store did not confirm the save.");
      }
      return toProfile(row as Record<string, unknown>);
    },
  };
}
