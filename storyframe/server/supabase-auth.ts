const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SupabaseAuthErrorCode = "SESSION_INVALID" | "AUTH_UNAVAILABLE";

export class SupabaseAuthError extends Error {
  readonly status: number;
  readonly code: SupabaseAuthErrorCode;

  constructor(code: SupabaseAuthErrorCode, status: number, message: string) {
    super(message);
    this.name = "SupabaseAuthError";
    this.code = code;
    this.status = status;
  }
}

export interface AuthenticatedUser {
  id: string;
}

export interface SupabaseAuth {
  verify(accessToken: string): Promise<AuthenticatedUser>;
}

interface SupabaseAuthOptions {
  url: string;
  publishableKey: string;
  timeoutMs: number;
}

/**
 * Verifies an access token with Supabase Auth. This checks the session with the
 * project rather than trusting claims supplied by the browser, so expired and
 * revoked sessions are rejected. The user id always comes from Supabase.
 */
export function createSupabaseAuth(options: SupabaseAuthOptions): SupabaseAuth {
  const endpoint = `${options.url.replace(/\/+$/, "")}/auth/v1/user`;

  return {
    async verify(accessToken: string): Promise<AuthenticatedUser> {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: options.publishableKey,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch {
        throw new SupabaseAuthError(
          "AUTH_UNAVAILABLE",
          503,
          "Supabase authentication is temporarily unavailable.",
        );
      }

      if (response.status === 401 || response.status === 403) {
        throw new SupabaseAuthError("SESSION_INVALID", 401, "The session is invalid or has expired. Sign in again.");
      }
      if (!response.ok) {
        throw new SupabaseAuthError(
          "AUTH_UNAVAILABLE",
          503,
          "Supabase authentication is temporarily unavailable.",
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new SupabaseAuthError("AUTH_UNAVAILABLE", 503, "Supabase returned an unreadable identity response.");
      }

      const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
      const id = record?.id;
      if (typeof id !== "string" || !USER_ID_PATTERN.test(id)) {
        throw new SupabaseAuthError("AUTH_UNAVAILABLE", 503, "Supabase returned an invalid user identity.");
      }

      return { id };
    },
  };
}
