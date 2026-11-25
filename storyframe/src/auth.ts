import type { SupabaseClient } from "@supabase/supabase-js";

export class AuthSessionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AuthSessionError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Return the current Supabase access token.
 *
 * The Supabase client already refreshes the access token itself: with
 * `autoRefreshToken` it refreshes inside a 90-second pre-expiry margin, and
 * `_callRefreshToken` single-flights concurrent refreshes. Calling
 * `refreshSession()` here as well would rotate the token a second time on every
 * request and race that timer, so this function only reads the session and
 * lets the client decide when to refresh.
 */
export async function getAccessToken(client: SupabaseClient): Promise<string> {
  let sessionResult: Awaited<ReturnType<SupabaseClient["auth"]["getSession"]>>;
  try {
    sessionResult = await client.auth.getSession();
  } catch {
    throw new AuthSessionError(
      "AUTH_SESSION_UNAVAILABLE",
      "Could not read the Supabase session. Try signing in again.",
      503,
    );
  }

  if (sessionResult.error) {
    // getSession reports an error only when the stored session could not be
    // refreshed and is no longer usable, so the user has to sign in again.
    throw new AuthSessionError("SESSION_EXPIRED", "Your Supabase session expired. Sign in again.", 401);
  }

  const session = sessionResult.data.session;
  if (!session) {
    throw new AuthSessionError("AUTH_REQUIRED", "Sign in to StoryFrame before sending a request.", 401);
  }

  if (typeof session.expires_at === "number" && session.expires_at * 1000 <= Date.now()) {
    throw new AuthSessionError("SESSION_EXPIRED", "Your Supabase session expired. Sign in again.", 401);
  }

  return session.access_token;
}
