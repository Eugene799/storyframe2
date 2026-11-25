import { describe, expect, it, vi } from "vitest";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { getAccessToken } from "../src/auth";

function makeSession(accessToken: string, expiresAt: number): Session {
  return {
    access_token: accessToken,
    refresh_token: "refresh-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    user: {
      id: "user-1",
      email: "ada@example.com",
      app_metadata: {},
      user_metadata: {},
      aud: "authenticated",
      created_at: "2026-11-24T00:00:00.000Z",
    },
  } as Session;
}

type SessionResult = {
  data: { session: Session | null };
  error: { message: string } | null;
};

function clientFor(loadSession: () => Promise<SessionResult>) {
  const getSession = vi.fn(loadSession);
  const refreshSession = vi.fn();
  const client = { auth: { getSession, refreshSession } } as unknown as SupabaseClient;
  return { client, getSession, refreshSession };
}

/** Seconds since the epoch, `offsetMs` away from now. */
function expiresIn(offsetMs: number): number {
  return Math.floor((Date.now() + offsetMs) / 1000);
}

describe("getAccessToken", () => {
  it("returns the current access token", async () => {
    const session = makeSession("valid-token", expiresIn(3_600_000));
    const { client } = clientFor(async () => ({ data: { session }, error: null }));

    await expect(getAccessToken(client)).resolves.toBe("valid-token");
  });

  it("uses the token the Supabase client refreshed to instead of rotating it again", async () => {
    // The client refreshes inside its own 90-second margin and single-flights
    // concurrent refreshes. A second, app-driven refresh would race that timer
    // and rotate the refresh token again, so it must never happen here.
    const refreshed = makeSession("sdk-refreshed-token", expiresIn(3_600_000));
    const { client, refreshSession } = clientFor(async () => ({ data: { session: refreshed }, error: null }));

    await expect(getAccessToken(client)).resolves.toBe("sdk-refreshed-token");
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("refuses to send a request when there is no session", async () => {
    const { client } = clientFor(async () => ({ data: { session: null }, error: null }));

    await expect(getAccessToken(client)).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
  });

  it("reports an expired session the client could not replace", async () => {
    const session = makeSession("expired-token", expiresIn(-60_000));
    const { client } = clientFor(async () => ({ data: { session }, error: null }));

    await expect(getAccessToken(client)).rejects.toMatchObject({ code: "SESSION_EXPIRED", status: 401 });
  });

  it("reports a session the client could not refresh", async () => {
    const { client } = clientFor(async () => ({
      data: { session: null },
      error: { message: "Invalid Refresh Token" },
    }));

    await expect(getAccessToken(client)).rejects.toMatchObject({ code: "SESSION_EXPIRED", status: 401 });
  });

  it("reports a session that could not be read", async () => {
    const { client } = clientFor(async () => {
      throw new Error("storage unavailable");
    });

    await expect(getAccessToken(client)).rejects.toMatchObject({
      code: "AUTH_SESSION_UNAVAILABLE",
      status: 503,
    });
  });
});
