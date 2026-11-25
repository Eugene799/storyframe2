import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auditMedia, hasMediaAuditDrift, MEDIA_OBJECT_PREFIX } from "../server/media-audit";
import { createSupabaseMediaStore } from "../server/media";
import { createR2Client } from "../server/r2";
import { SERVICE_ROLE_KEY, USER_A } from "./fake-supabase";
import { documentFixture } from "./project-fixture";
import { apiRequest, startTestServer, type TestApp } from "./server-helpers";

// MOCKED: the store and the S3 endpoint are the local fakes. The audit parses a
// real ListObjectsV2 document and pages it, so the paging path is exercised.

const DOCUMENT = documentFixture();
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 1)]);

function auditClients(app: TestApp) {
  return {
    store: createSupabaseMediaStore({
      url: app.supabase.url,
      serviceRoleKey: SERVICE_ROLE_KEY,
      timeoutMs: 3000,
    }),
    objects: createR2Client({
      endpoint: app.r2.url,
      bucket: app.r2.bucket,
      accessKeyId: "test-access-key-id",
      secretAccessKey: "test-secret-access-key",
    }),
  };
}

async function createProject(appUrl: string): Promise<string> {
  const response = await apiRequest(appUrl, "/api/projects", {
    method: "POST",
    body: JSON.stringify({ projectType: "story", title: "Audit subject", document: DOCUMENT }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { project: { id: string } }).project.id;
}

/** Runs the real initiate -> presigned PUT -> complete path and returns the id. */
async function uploadReadyImage(appUrl: string, projectId: string): Promise<string> {
  const initiated = await apiRequest(appUrl, `/api/projects/${projectId}/media`, {
    method: "POST",
    body: JSON.stringify({ kind: "image", contentType: "image/png", byteSize: PNG.length }),
  });
  expect(initiated.status).toBe(201);
  const ticket = (await initiated.json()) as {
    media: { id: string };
    upload: { url: string; headers: Record<string, string> };
  };
  const put = await fetch(ticket.upload.url, {
    method: "PUT",
    headers: ticket.upload.headers,
    body: new Uint8Array(PNG),
  });
  expect(put.status).toBe(200);
  const completed = await apiRequest(
    appUrl,
    `/api/projects/${projectId}/media/${ticket.media.id}/complete`,
    { method: "POST" },
  );
  expect(completed.status).toBe(200);
  return ticket.media.id;
}

describe("media bucket audit", () => {
  it("reports no drift when rows and objects agree", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      await uploadReadyImage(app.url, projectId);
      // A pending upload has no object until the browser PUTs it; that is the
      // normal in-flight state, not drift.
      const pendingId = randomUUID();
      app.supabase.media.push({
        id: pendingId,
        owner_id: USER_A.id,
        project_id: projectId,
        object_key: `${MEDIA_OBJECT_PREFIX}${USER_A.id}/${pendingId}`,
        status: "pending",
      });

      const report = await auditMedia(auditClients(app));

      expect(report.rows).toBe(2);
      expect(report.objects).toBe(1);
      expect(report.objectBytes).toBe(PNG.length);
      expect(report.statuses).toEqual({ pending: 1, ready: 1, deleted: 0 });
      expect(report.orphanObjectCount).toBe(0);
      expect(report.missingObjectCount).toBe(0);
      expect(hasMediaAuditDrift(report)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("finds a bucket object with no row and a ready row with no object", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      await uploadReadyImage(app.url, projectId);
      const orphanId = await uploadReadyImage(app.url, projectId);

      // The row is gone but the object stayed, exactly what a failed cleanup
      // after a project deletion leaves behind.
      const orphanIndex = app.supabase.media.findIndex((row) => row.id === orphanId);
      expect(orphanIndex).toBeGreaterThanOrEqual(0);
      app.supabase.media.splice(orphanIndex, 1);

      // A ready row whose object was lost: its playback link would 409.
      const missingId = randomUUID();
      const missingKey = `${MEDIA_OBJECT_PREFIX}${USER_A.id}/${missingId}`;
      app.supabase.media.push({
        id: missingId,
        owner_id: USER_A.id,
        project_id: projectId,
        object_key: missingKey,
        status: "ready",
      });

      const before = { rows: app.supabase.media.length, objects: app.r2.objects.size };
      const report = await auditMedia(auditClients(app));

      expect(report.orphanObjectCount).toBe(1);
      expect(report.orphanObjects).toEqual([
        { key: `${MEDIA_OBJECT_PREFIX}${USER_A.id}/${orphanId}`, byteSize: PNG.length },
      ]);
      expect(report.missingObjectCount).toBe(1);
      expect(report.missingObjects[0]).toMatchObject({
        id: missingId,
        ownerId: USER_A.id,
        projectId,
        objectKey: missingKey,
        status: "ready",
      });
      expect(hasMediaAuditDrift(report)).toBe(true);

      // The audit is read-only: nothing was removed or rewritten.
      expect(app.supabase.media).toHaveLength(before.rows);
      expect(app.r2.objects.size).toBe(before.objects);
    } finally {
      await app.close();
    }
  });

  it("pages past one page of both rows and objects", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      for (let index = 0; index < 205; index += 1) {
        const id = randomUUID();
        const objectKey = `${MEDIA_OBJECT_PREFIX}${USER_A.id}/${id}`;
        app.supabase.media.push({
          id,
          owner_id: USER_A.id,
          project_id: projectId,
          object_key: objectKey,
          status: "ready",
        });
        app.r2.objects.set(objectKey, { body: PNG, contentType: "image/png" });
      }

      // One orphan beyond the pages of matched pairs, and one dangling ready row.
      const orphanKey = `${MEDIA_OBJECT_PREFIX}${USER_A.id}/${randomUUID()}`;
      app.r2.objects.set(orphanKey, { body: PNG, contentType: "image/png" });
      const strayId = randomUUID();
      app.supabase.media.push({
        id: strayId,
        owner_id: USER_A.id,
        project_id: projectId,
        object_key: `${MEDIA_OBJECT_PREFIX}${USER_A.id}/${strayId}`,
        status: "ready",
      });

      const report = await auditMedia({ ...auditClients(app), rowPageSize: 25, objectPageSize: 25 });

      expect(report.rows).toBe(206);
      expect(report.objects).toBe(206);
      expect(report.orphanObjectCount).toBe(1);
      expect(report.orphanObjects[0].key).toBe(orphanKey);
      expect(report.missingObjectCount).toBe(1);
      expect(report.missingObjects[0].id).toBe(strayId);
    } finally {
      await app.close();
    }
  });
});
