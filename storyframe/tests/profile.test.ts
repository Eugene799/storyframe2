import { describe, expect, it } from "vitest";
import type { ProfileResponse } from "../shared/profile-contract";
import { USER_A, USER_B } from "./fake-supabase";
import { apiRequest, startTestServer } from "./server-helpers";

// MOCKED: Supabase is a local fake serving Auth and PostgREST over real HTTP.

const PROFILE = {
  displayName: "Ada",
  workspaceName: "Ada's studio",
  settings: { theme: "dark", autosave: true },
};

describe("profile", () => {
  it("reports a missing profile instead of inventing one", async () => {
    const app = await startTestServer();

    try {
      const response = await apiRequest(app.url, "/api/profile");
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "PROFILE_NOT_FOUND" } });
      expect(app.supabase.profiles).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("creates the caller's profile and reads it back", async () => {
    const app = await startTestServer();

    try {
      const saved = await apiRequest(app.url, "/api/profile", {
        method: "PUT",
        body: JSON.stringify(PROFILE),
      });
      expect(saved.status).toBe(200);

      const profile = ((await saved.json()) as ProfileResponse).profile;
      expect(profile).toMatchObject(PROFILE);
      expect(profile.createdAt).toEqual(expect.any(String));

      expect(app.supabase.profiles).toHaveLength(1);
      expect(app.supabase.profiles[0].owner_id).toBe(USER_A.id);

      const read = await apiRequest(app.url, "/api/profile");
      expect(read.status).toBe(200);
      expect((await read.json()) as ProfileResponse).toMatchObject({
        profile: { ...PROFILE, createdAt: profile.createdAt },
      });
    } finally {
      await app.close();
    }
  });

  it("updates the existing row instead of adding a second one", async () => {
    const app = await startTestServer();

    try {
      const first = (await (
        await apiRequest(app.url, "/api/profile", { method: "PUT", body: JSON.stringify(PROFILE) })
      ).json()) as ProfileResponse;

      const saved = await apiRequest(app.url, "/api/profile", {
        method: "PUT",
        body: JSON.stringify({ workspaceName: "Renamed studio", settings: {} }),
      });
      expect(saved.status).toBe(200);

      const updated = ((await saved.json()) as ProfileResponse).profile;
      expect(updated).toMatchObject({ displayName: null, workspaceName: "Renamed studio", settings: {} });
      expect(updated.createdAt).toBe(first.profile.createdAt);
      expect(app.supabase.profiles).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("isolates profiles between two accounts", async () => {
    const app = await startTestServer();

    try {
      await apiRequest(app.url, "/api/profile", { method: "PUT", body: JSON.stringify(PROFILE) });

      // The second account has no profile of its own, and none of A's.
      const otherRead = await apiRequest(app.url, "/api/profile", {}, USER_B.token);
      expect(otherRead.status).toBe(404);

      const otherSave = await apiRequest(
        app.url,
        "/api/profile",
        { method: "PUT", body: JSON.stringify({ workspaceName: "B workspace" }) },
        USER_B.token,
      );
      expect(otherSave.status).toBe(200);
      expect(((await otherSave.json()) as ProfileResponse).profile).toMatchObject({
        workspaceName: "B workspace",
        displayName: null,
      });

      expect(app.supabase.profiles.map((row) => row.owner_id).sort()).toEqual(
        [USER_A.id, USER_B.id].sort(),
      );

      // B's write could not touch A's row.
      const mine = (await (await apiRequest(app.url, "/api/profile")).json()) as ProfileResponse;
      expect(mine.profile).toMatchObject({
        displayName: PROFILE.displayName,
        workspaceName: PROFILE.workspaceName,
      });

      const theirs = (await (
        await apiRequest(app.url, "/api/profile", {}, USER_B.token)
      ).json()) as ProfileResponse;
      expect(theirs.profile).toMatchObject({ workspaceName: "B workspace" });
    } finally {
      await app.close();
    }
  });

  it("rejects malformed payloads and client-supplied ownership", async () => {
    const app = await startTestServer();

    try {
      const cases: { body: unknown; code: string }[] = [
        { body: { workspaceName: "" }, code: "INVALID_PROFILE" },
        { body: { workspaceName: "x", displayName: "a".repeat(121) }, code: "INVALID_PROFILE" },
        { body: { workspaceName: "x", settings: [] }, code: "INVALID_PROFILE" },
        { body: { workspaceName: "x", settings: { blob: "a".repeat(5000) } }, code: "INVALID_PROFILE" },
        { body: { workspaceName: "x", owner_id: USER_B.id }, code: "UNEXPECTED_FIELD" },
      ];

      for (const testCase of cases) {
        const response = await apiRequest(app.url, "/api/profile", {
          method: "PUT",
          body: JSON.stringify(testCase.body),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ ok: false, error: { code: testCase.code } });
      }

      expect(app.supabase.profiles).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("requires a session for both methods", async () => {
    const app = await startTestServer();

    try {
      const responses = await Promise.all([
        apiRequest(app.url, "/api/profile", {}, null),
        apiRequest(app.url, "/api/profile", { method: "PUT", body: JSON.stringify(PROFILE) }, null),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
      }
      expect(app.supabase.profiles).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("refuses profile calls when the store is not configured", async () => {
    const app = await startTestServer({ env: { SUPABASE_SERVICE_ROLE_KEY: "" } });

    try {
      const response = await apiRequest(app.url, "/api/profile");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "PROFILE_NOT_CONFIGURED" },
      });
    } finally {
      await app.close();
    }
  });
});
