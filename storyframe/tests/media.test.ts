import { describe, expect, it } from "vitest";
import type { MediaRecord, MediaReferenceRecord } from "../shared/media-contract";
import { USER_A, USER_B } from "./fake-supabase";
import { documentFixture } from "./project-fixture";
import { apiRequest, startTestServer } from "./server-helpers";

// MOCKED: Supabase and the S3 endpoint are local fakes served over HTTP. The
// SigV4 signing itself is checked separately by `npm run verify:r2-live`.

const DOCUMENT = documentFixture();

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 1)]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(200, 0)]);
const MP4 = Buffer.alloc(64);
MP4.writeUInt32BE(24, 0);
MP4.write("ftyp", 4, "latin1");
MP4.write("isom", 8, "latin1");

interface MediaInitiateResponse {
  ok: true;
  media: MediaRecord;
  upload: { url: string; method: "PUT"; headers: Record<string, string>; expiresAt: string };
}

async function createProject(appUrl: string, token: string = USER_A.token): Promise<string> {
  const response = await apiRequest(
    appUrl,
    "/api/projects",
    {
      method: "POST",
      body: JSON.stringify({ projectType: "story", title: "The Late Letter", document: DOCUMENT }),
    },
    token,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { project: { id: string } }).project.id;
}

async function initiateUpload(
  appUrl: string,
  projectId: string,
  body: Record<string, unknown>,
  token: string = USER_A.token,
): Promise<MediaInitiateResponse> {
  const response = await apiRequest(
    appUrl,
    `/api/projects/${projectId}/media`,
    { method: "POST", body: JSON.stringify(body) },
    token,
  );
  expect(response.status).toBe(201);
  return (await response.json()) as MediaInitiateResponse;
}

/** Uploads directly to the bucket through the presigned URL, as a browser would. */
async function putObject(ticket: MediaInitiateResponse, bytes: Buffer): Promise<void> {
  const response = await fetch(ticket.upload.url, {
    method: "PUT",
    headers: ticket.upload.headers,
    body: new Uint8Array(bytes),
  });
  expect(response.status).toBe(200);
}

/** Polls a condition a background pass is expected to satisfy. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the scheduled media sweep.");
}

async function complete(appUrl: string, projectId: string, mediaId: string, token: string = USER_A.token) {
  return apiRequest(
    appUrl,
    `/api/projects/${projectId}/media/${mediaId}/complete`,
    { method: "POST" },
    token,
  );
}

describe("private media storage", () => {
  it("uploads, validates, and plays back an image through short-lived URLs", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
        sceneKey: "scene-1",
      });

      expect(ticket.media).toMatchObject({ kind: "image", status: "pending", byteSize: PNG.length });
      expect(ticket.upload.method).toBe("PUT");
      expect(ticket.upload.url).toContain(`/storyframe-test-media/media/${USER_A.id}/${ticket.media.id}?`);
      expect(ticket.upload.url).toContain("X-Amz-Signature=");
      // The secret never appears in the ticket.
      expect(ticket.upload.url).not.toContain("test-secret-access-key");

      await putObject(ticket, PNG);
      const completed = await complete(app.url, projectId, ticket.media.id);
      expect(completed.status).toBe(200);
      const completedBody = (await completed.json()) as { media: MediaRecord };
      expect(completedBody.media).toMatchObject({
        status: "ready",
        contentType: "image/png",
        byteSize: PNG.length,
        sceneKey: "scene-1",
      });

      const playbackResponse = await apiRequest(
        app.url,
        `/api/projects/${projectId}/media/${ticket.media.id}/url`,
      );
      expect(playbackResponse.status).toBe(200);
      const playback = (await playbackResponse.json()) as { url: string; contentType: string; byteSize: number };
      expect(playback.contentType).toBe("image/png");
      expect(playback.byteSize).toBe(PNG.length);

      const downloaded = Buffer.from(await (await fetch(playback.url)).arrayBuffer());
      expect(downloaded.equals(PNG)).toBe(true);

      const list = await apiRequest(app.url, `/api/projects/${projectId}/media`);
      const listBody = (await list.json()) as { media: MediaRecord[] };
      expect(listBody.media).toHaveLength(1);
      expect(listBody.media[0].status).toBe("ready");
      expect(app.r2.puts).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("accepts audio and video only when the bytes match the declared kind", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);

      for (const candidate of [
        { kind: "audio", contentType: "audio/mpeg", bytes: MP3, detected: "audio/mpeg" },
        { kind: "video", contentType: "video/mp4", bytes: MP4, detected: "video/mp4" },
      ] as const) {
        const ticket = await initiateUpload(app.url, projectId, {
          kind: candidate.kind,
          contentType: candidate.contentType,
          byteSize: candidate.bytes.length,
        });
        await putObject(ticket, candidate.bytes);
        const completed = await complete(app.url, projectId, ticket.media.id);
        expect(completed.status).toBe(200);
        const body = (await completed.json()) as { media: MediaRecord };
        expect(body.media).toMatchObject({ kind: candidate.kind, status: "ready", contentType: candidate.detected });
      }
    } finally {
      await app.close();
    }
  });

  it("rejects a file whose real type does not match and discards the object", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: MP4.length,
      });
      await putObject(ticket, MP4);

      const response = await complete(app.url, projectId, ticket.media.id);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "MEDIA_TYPE_MISMATCH" } });
      expect(app.r2.objects.size).toBe(0);
      expect(app.supabase.media[0].status).toBe("deleted");
    } finally {
      await app.close();
    }
  });

  it("refuses an oversized declaration and an account over its storage limit", async () => {
    const app = await startTestServer({ env: { MEDIA_OWNER_STORAGE_BYTES: "1024" } });
    try {
      const projectId = await createProject(app.url);

      const tooLarge = await apiRequest(app.url, `/api/projects/${projectId}/media`, {
        method: "POST",
        body: JSON.stringify({ kind: "image", contentType: "image/png", byteSize: 11 * 1024 * 1024 }),
      });
      expect(tooLarge.status).toBe(413);
      expect(await tooLarge.json()).toMatchObject({ ok: false, error: { code: "MEDIA_TOO_LARGE" } });

      const first = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });
      expect(first.media.status).toBe("pending");

      const overQuota = await apiRequest(app.url, `/api/projects/${projectId}/media`, {
        method: "POST",
        body: JSON.stringify({ kind: "image", contentType: "image/png", byteSize: 2048 }),
      });
      expect(overQuota.status).toBe(413);
      expect(await overQuota.json()).toMatchObject({ ok: false, error: { code: "MEDIA_STORAGE_LIMIT" } });
    } finally {
      await app.close();
    }
  });

  it("never exposes one account's media to another account", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });
      await putObject(ticket, PNG);
      expect((await complete(app.url, projectId, ticket.media.id)).status).toBe(200);

      const otherPlayback = await apiRequest(
        app.url,
        `/api/projects/${projectId}/media/${ticket.media.id}/url`,
        {},
        USER_B.token,
      );
      expect(otherPlayback.status).toBe(404);
      expect(await otherPlayback.json()).toMatchObject({ ok: false, error: { code: "PROJECT_NOT_FOUND" } });

      const otherComplete = await complete(app.url, projectId, ticket.media.id, USER_B.token);
      expect(otherComplete.status).toBe(404);

      const otherDelete = await apiRequest(
        app.url,
        `/api/projects/${projectId}/media/${ticket.media.id}`,
        { method: "DELETE" },
        USER_B.token,
      );
      expect(otherDelete.status).toBe(404);
      expect(app.r2.objects.size).toBe(1);
      expect(app.supabase.media[0].status).toBe("ready");
    } finally {
      await app.close();
    }
  });

  it("keeps a shared asset valid until its last reference is released", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "audio",
        contentType: "audio/mpeg",
        byteSize: MP3.length,
      });
      await putObject(ticket, MP3);
      expect((await complete(app.url, projectId, ticket.media.id)).status).toBe(200);

      const base = `/api/projects/${projectId}/media/${ticket.media.id}`;
      const first = await apiRequest(app.url, `${base}/references`, {
        method: "POST",
        body: JSON.stringify({ refKind: "scene", refId: "scene-1" }),
      });
      expect(first.status).toBe(201);
      const firstRef = ((await first.json()) as { reference: MediaReferenceRecord }).reference;

      const duplicate = await apiRequest(app.url, `${base}/references`, {
        method: "POST",
        body: JSON.stringify({ refKind: "scene", refId: "scene-1" }),
      });
      expect(duplicate.status).toBe(201);
      expect(((await duplicate.json()) as { reference: MediaReferenceRecord }).reference.id).toBe(firstRef.id);

      const second = await apiRequest(app.url, `${base}/references`, {
        method: "POST",
        body: JSON.stringify({ refKind: "render", refId: "render-42" }),
      });
      expect(second.status).toBe(201);

      const blocked = await apiRequest(app.url, base, { method: "DELETE" });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ ok: false, error: { code: "MEDIA_IN_USE" } });
      expect(app.r2.objects.size).toBe(1);

      expect((await apiRequest(app.url, `${base}/references/${firstRef.id}`, { method: "DELETE" })).status).toBe(200);
      const stillPlayable = await apiRequest(app.url, `${base}/url`);
      expect(stillPlayable.status).toBe(200);
      expect(app.r2.objects.size).toBe(1);

      const references = await apiRequest(app.url, `${base}/references`);
      expect(((await references.json()) as { references: MediaReferenceRecord[] }).references).toHaveLength(1);

      expect(
        (await apiRequest(app.url, `${base}/references/${firstRef.id}`, { method: "DELETE" })).status,
      ).toBe(404);

      const { references: remaining } = (await (await apiRequest(app.url, `${base}/references`)).json()) as {
        references: MediaReferenceRecord[];
      };
      expect((await apiRequest(app.url, `${base}/references/${remaining[0].id}`, { method: "DELETE" })).status).toBe(
        200,
      );

      const deleted = await apiRequest(app.url, base, { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect(app.r2.objects.size).toBe(0);
      expect(app.supabase.media[0].status).toBe("deleted");
    } finally {
      await app.close();
    }
  });

  it("refuses saved scene asset ids that are not ready media in this project", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      const valid = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });
      await putObject(valid, PNG);
      expect((await complete(app.url, projectId, valid.media.id)).status).toBe(200);

      const read = await apiRequest(app.url, `/api/projects/${projectId}`);
      const project = ((await read.json()) as {
        project: {
          title: string;
          version: number;
          document: { scenes: Record<string, unknown>[] };
        };
      }).project;
      const scene = project.document.scenes[0];
      const save = (assetIds: string[], version: number) =>
        apiRequest(app.url, `/api/projects/${projectId}`, {
          method: "PUT",
          body: JSON.stringify({
            title: project.title,
            document: { ...project.document, scenes: [{ ...scene, assetIds }] },
            version,
          }),
        });

      const accepted = await save([valid.media.id], project.version);
      expect(accepted.status).toBe(200);
      const savedVersion = project.version + 1;

      const unknown = await save(["11111111-1111-4111-8111-111111111111"], savedVersion);
      expect(unknown.status).toBe(422);
      expect(await unknown.json()).toMatchObject({ ok: false, error: { code: "MEDIA_ASSET_INVALID" } });

      const pending = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });
      const pendingSave = await save([pending.media.id], savedVersion);
      expect(pendingSave.status).toBe(422);
      expect(await pendingSave.json()).toMatchObject({ ok: false, error: { code: "MEDIA_ASSET_INVALID" } });

      const otherProject = await createProject(app.url);
      const foreign = await initiateUpload(app.url, otherProject, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });
      await putObject(foreign, PNG);
      expect((await complete(app.url, otherProject, foreign.media.id)).status).toBe(200);
      const foreignSave = await save([foreign.media.id], savedVersion);
      expect(foreignSave.status).toBe(422);
      expect(await foreignSave.json()).toMatchObject({ ok: false, error: { code: "MEDIA_ASSET_INVALID" } });

      const deleted = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });
      await putObject(deleted, PNG);
      expect((await complete(app.url, projectId, deleted.media.id)).status).toBe(200);
      expect(
        (await apiRequest(app.url, `/api/projects/${projectId}/media/${deleted.media.id}`, { method: "DELETE" })).status,
      ).toBe(200);
      const deletedSave = await save([deleted.media.id], savedVersion);
      expect(deletedSave.status).toBe(422);
      expect(await deletedSave.json()).toMatchObject({ ok: false, error: { code: "MEDIA_ASSET_INVALID" } });

      const createWithAsset = await apiRequest(app.url, "/api/projects", {
        method: "POST",
        body: JSON.stringify({
          projectType: "story",
          title: "Dangling on create",
          document: { ...DOCUMENT, scenes: [{ ...DOCUMENT.scenes[0], assetIds: [valid.media.id] }] },
        }),
      });
      expect(createWithAsset.status).toBe(422);
      expect(await createWithAsset.json()).toMatchObject({ ok: false, error: { code: "MEDIA_ASSET_INVALID" } });

      const after = await apiRequest(app.url, `/api/projects/${projectId}`);
      const reread = ((await after.json()) as { project: { version: number; document: { scenes: { assetIds: string[] }[] } } })
        .project;
      expect(reread.version).toBe(savedVersion);
      expect(reread.document.scenes[0].assetIds).toEqual([valid.media.id]);
    } finally {
      await app.close();
    }
  });

  it("checks ready asset ids past the first 100-id chunk", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      const assetIds = Array.from(
        { length: 101 },
        (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      );
      for (const id of assetIds) {
        app.supabase.media.push({ id, owner_id: USER_A.id, project_id: projectId, status: "ready" });
      }

      const read = await apiRequest(app.url, `/api/projects/${projectId}`);
      const project = ((await read.json()) as {
        project: { title: string; version: number; document: { scenes: Record<string, unknown>[] } };
      }).project;
      const scene = project.document.scenes[0];
      const documentWith = (ids: string[]) => ({
        ...project.document,
        scenes: Array.from({ length: 6 }, (_, index) => ({
          ...scene,
          id: `scene-${index + 1}`,
          assetIds: ids.slice(index * 20, index * 20 + 20),
        })),
      });
      const save = (ids: string[], version: number) =>
        apiRequest(app.url, `/api/projects/${projectId}`, {
          method: "PUT",
          body: JSON.stringify({ title: project.title, document: documentWith(ids), version }),
        });

      // 100 ids fill the first request and the 101st needs the second chunk.
      const accepted = await save(assetIds, project.version);
      expect(accepted.status).toBe(200);

      const broken = [...assetIds.slice(0, 100), "11111111-1111-4111-8111-999999999999"];
      const rejected = await save(broken, project.version + 1);
      expect(rejected.status).toBe(422);
      expect(await rejected.json()).toMatchObject({ ok: false, error: { code: "MEDIA_ASSET_INVALID" } });

      const after = await apiRequest(app.url, `/api/projects/${projectId}`);
      const reread = ((await after.json()) as {
        project: { version: number; document: { scenes: { assetIds: string[] }[] } };
      }).project;
      expect(reread.version).toBe(project.version + 1);
      expect(reread.document.scenes.flatMap((item) => item.assetIds)).toEqual(assetIds);
    } finally {
      await app.close();
    }
  });

  it("refuses a malformed scene asset id before any media lookup", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      const read = await apiRequest(app.url, `/api/projects/${projectId}`);
      const project = ((await read.json()) as {
        project: { title: string; version: number; document: { scenes: Record<string, unknown>[] } };
      }).project;
      const save = (assetId: string) =>
        apiRequest(app.url, `/api/projects/${projectId}`, {
          method: "PUT",
          body: JSON.stringify({
            title: project.title,
            document: {
              ...project.document,
              scenes: [{ ...project.document.scenes[0], assetIds: [assetId] }],
            },
            version: project.version,
          }),
        });

      const rejected = await save("not-a-uuid");
      expect(rejected.status).toBe(422);
      expect(await rejected.json()).toMatchObject({ ok: false, error: { code: "MEDIA_ASSET_INVALID" } });

      const after = await apiRequest(app.url, `/api/projects/${projectId}`);
      const reread = ((await after.json()) as {
        project: { version: number; document: { scenes: { assetIds: string[] }[] } };
      }).project;
      expect(reread.version).toBe(project.version);
      expect(reread.document.scenes[0].assetIds).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("refuses to delete an asset that the saved project document still lists", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });
      await putObject(ticket, PNG);
      expect((await complete(app.url, projectId, ticket.media.id)).status).toBe(200);

      // No reference exists, but the saved scene still lists the asset: the state
      // a released reference and a failed project save leaves behind.
      const projectRow = app.supabase.projects.find((row) => row.id === projectId);
      expect(projectRow).toBeDefined();
      const document = projectRow?.document as { scenes: { assetIds: string[] }[] };
      document.scenes[0].assetIds.push(ticket.media.id);

      const base = `/api/projects/${projectId}/media/${ticket.media.id}`;
      const blocked = await apiRequest(app.url, base, { method: "DELETE" });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ ok: false, error: { code: "MEDIA_ASSET_IN_DOCUMENT" } });
      expect(app.r2.objects.size).toBe(1);
      expect(app.supabase.media[0].status).toBe("ready");

      // Removing the id from the document lets the same delete through.
      document.scenes[0].assetIds = [];
      const deleted = await apiRequest(app.url, base, { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect(app.r2.objects.size).toBe(0);
      expect(app.supabase.media[0].status).toBe("deleted");
    } finally {
      await app.close();
    }
  });

  it("reports a missing object and a pending asset clearly", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });

      const playback = await apiRequest(app.url, `/api/projects/${projectId}/media/${ticket.media.id}/url`);
      expect(playback.status).toBe(409);
      expect(await playback.json()).toMatchObject({ ok: false, error: { code: "MEDIA_NOT_READY" } });

      const missing = await complete(app.url, projectId, ticket.media.id);
      expect(missing.status).toBe(409);
      expect(await missing.json()).toMatchObject({ ok: false, error: { code: "MEDIA_OBJECT_MISSING" } });
    } finally {
      await app.close();
    }
  });

  it("cleans up an interrupted upload after its window and expired deletions later", async () => {
    let clock = Date.now();
    const app = await startTestServer({
      now: () => clock,
      env: { MEDIA_UPLOAD_TTL_MS: "0", MEDIA_DELETED_RETENTION_MS: "0" },
    });
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });
      await putObject(ticket, PNG);

      clock += 1000;
      const afterSweep = await apiRequest(app.url, `/api/projects/${projectId}/media`);
      const list = (await afterSweep.json()) as { media: MediaRecord[] };
      expect(list.media).toHaveLength(0);
      expect(app.supabase.media).toHaveLength(0);
      expect(app.r2.objects.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("cleans an expired upload on the scheduled sweep without a media request", async () => {
    const app = await startTestServer({
      env: { MEDIA_SWEEP_INTERVAL_MS: "40", MEDIA_UPLOAD_TTL_MS: "0" },
    });
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });
      await putObject(ticket, PNG);
      expect(app.supabase.media).toHaveLength(1);

      // No media route is called after the upload, so only the timer can clean
      // this interrupted upload and its object.
      await waitFor(() => app.supabase.media.length === 0 && app.r2.objects.size === 0);
      expect(app.supabase.media).toHaveLength(0);
      expect(app.r2.objects.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("purges an unreferenced ready asset after its retention window", async () => {
    let clock = Date.now();
    const app = await startTestServer({ now: () => clock, env: { MEDIA_UNREFERENCED_RETENTION_MS: "0" } });
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });
      await putObject(ticket, PNG);
      expect((await complete(app.url, projectId, ticket.media.id)).status).toBe(200);
      expect(app.r2.objects.size).toBe(1);

      clock += 1000;
      const afterSweep = await apiRequest(app.url, `/api/projects/${projectId}/media`);
      expect(((await afterSweep.json()) as { media: MediaRecord[] }).media).toHaveLength(0);
      expect(app.r2.objects.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("keeps a document-listed asset through retention until the document drops it", async () => {
    let clock = Date.now();
    const app = await startTestServer({ now: () => clock, env: { MEDIA_UNREFERENCED_RETENTION_MS: "0" } });
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });
      await putObject(ticket, PNG);
      expect((await complete(app.url, projectId, ticket.media.id)).status).toBe(200);

      const projectRow = app.supabase.projects.find((row) => row.id === projectId);
      const document = projectRow?.document as { scenes: { assetIds: string[] }[] };
      document.scenes[0].assetIds.push(ticket.media.id);

      // The asset has no reference and is past retention, but the saved scene
      // still lists it, so two sweeps must leave it alone.
      clock += 1000;
      const first = await apiRequest(app.url, `/api/projects/${projectId}/media`);
      expect(((await first.json()) as { media: MediaRecord[] }).media).toHaveLength(1);
      clock += 1000;
      const second = await apiRequest(app.url, `/api/projects/${projectId}/media`);
      expect(((await second.json()) as { media: MediaRecord[] }).media).toHaveLength(1);
      expect(app.r2.objects.size).toBe(1);

      document.scenes[0].assetIds = [];
      clock += 1000;
      const third = await apiRequest(app.url, `/api/projects/${projectId}/media`);
      expect(((await third.json()) as { media: MediaRecord[] }).media).toHaveLength(0);
      expect(app.r2.objects.size).toBe(0);
      expect(app.supabase.media).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("pages past more protected rows than one sweep batch", async () => {
    let clock = Date.now();
    const app = await startTestServer({ now: () => clock, env: { MEDIA_UNREFERENCED_RETENTION_MS: "0" } });
    try {
      const projectId = await createProject(app.url);
      const projectRow = app.supabase.projects.find((row) => row.id === projectId);
      const document = projectRow?.document as { scenes: { id: string; assetIds: string[] }[] };
      const protectedIds = Array.from({ length: 30 }, (_, index) => `guard-${String(index).padStart(3, "0")}`);
      const staleId = "stale-999";
      const createdAt = new Date(clock - 60_000).toISOString();

      const seed = (id: string) => {
        const objectKey = `media/${USER_A.id}/${id}`;
        app.supabase.media.push({
          id,
          owner_id: USER_A.id,
          project_id: projectId,
          object_key: objectKey,
          scene_key: null,
          kind: "image",
          status: "ready",
          content_type: "image/png",
          byte_size: PNG.length,
          upload_expires_at: null,
          ready_at: createdAt,
          deleted_at: null,
          created_at: createdAt,
        });
        app.r2.objects.set(objectKey, { body: PNG, contentType: "image/png" });
      };
      for (const id of [...protectedIds, staleId]) seed(id);

      // Two scenes hold 30 saved ids; the stale id sorts after all of them, so
      // it is only reachable after paging past a full protected batch.
      const scene = document.scenes[0];
      document.scenes = [
        { ...scene, id: "scene-1", assetIds: protectedIds.slice(0, 15) },
        { ...scene, id: "scene-2", assetIds: protectedIds.slice(15) },
      ];

      clock += 1000;
      const listed = await apiRequest(app.url, `/api/projects/${projectId}/media`);
      const media = ((await listed.json()) as { media: MediaRecord[] }).media;

      expect(media).toHaveLength(30);
      expect(media.some((row) => row.id === staleId)).toBe(false);
      expect(app.r2.objects.size).toBe(30);
      expect(app.r2.objects.has(`media/${USER_A.id}/${staleId}`)).toBe(false);
      for (const id of protectedIds) {
        expect(app.r2.objects.has(`media/${USER_A.id}/${id}`)).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  it("removes every uploaded object across more than one store page", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      // 205 rows exceed the 200-row page the store reads at a time.
      for (let index = 0; index < 205; index += 1) {
        const id = `seeded-${String(index).padStart(3, "0")}`;
        const objectKey = `media/${USER_A.id}/${id}`;
        app.supabase.media.push({
          id,
          owner_id: USER_A.id,
          project_id: projectId,
          object_key: objectKey,
        });
        app.r2.objects.set(objectKey, { body: PNG, contentType: "image/png" });
      }
      expect(app.r2.objects.size).toBe(205);

      const deleted = await apiRequest(app.url, `/api/projects/${projectId}`, { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect(app.r2.objects.size).toBe(0);
      expect(app.supabase.media).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("removes a project's uploaded objects when the project is deleted", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });
      await putObject(ticket, PNG);
      expect((await complete(app.url, projectId, ticket.media.id)).status).toBe(200);

      const objectKey = `media/${USER_A.id}/${ticket.media.id}`;
      expect(app.r2.objects.has(objectKey)).toBe(true);

      const deleted = await apiRequest(app.url, `/api/projects/${projectId}`, { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect(app.r2.objects.has(objectKey)).toBe(false);
      expect(app.supabase.media).toHaveLength(0);

      const gone = await apiRequest(app.url, `/api/projects/${projectId}`);
      expect(gone.status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("rejects media requests when the bucket is not configured", async () => {
    const app = await startTestServer({ env: { R2_ENDPOINT: "", R2_BUCKET_NAME: "" } });
    try {
      const projectId = await createProject(app.url);
      const response = await apiRequest(app.url, `/api/projects/${projectId}/media`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "MEDIA_NOT_CONFIGURED" } });
    } finally {
      await app.close();
    }
  });
});
