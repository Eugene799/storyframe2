import { describe, expect, it } from "vitest";
import type {
  ClaimResponse,
  ClaimsResponse,
  JobResponse,
  JobsResponse,
  ProposalResponse,
  ProposalsResponse,
  RenderResponse,
  RendersResponse,
  ScenesResponse,
  SourceResponse,
  SourcesResponse,
} from "../shared/child-contract";
import type { ProjectRecord } from "../shared/project-contract";
import { USER_A, USER_B } from "./fake-supabase";
import { documentFixture } from "./project-fixture";
import { apiRequest, startTestServer, type TestApp } from "./server-helpers";

// MOCKED: Supabase is a local fake serving Auth and PostgREST over real HTTP.

async function createProject(app: TestApp, token: string = USER_A.token): Promise<ProjectRecord> {
  const response = await apiRequest(
    app.url,
    "/api/projects",
    {
      method: "POST",
      body: JSON.stringify({
        projectType: "story",
        title: "The Late Letter",
        document: { ...documentFixture(), scenes: [] },
      }),
    },
    token,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { project: ProjectRecord }).project;
}

function scenesPath(projectId: string): string {
  return `/api/projects/${projectId}/scenes`;
}

describe("project child data", () => {
  it("replaces scenes, keeps their stable keys, and prunes the ones removed", async () => {
    const app = await startTestServer();

    try {
      const project = await createProject(app);

      const first = await apiRequest(app.url, scenesPath(project.id), {
        method: "PUT",
        body: JSON.stringify({
          scenes: [
            { key: "scene-1", heading: "INT. TRAIN — NIGHT", body: "The letter waits." },
            { key: "scene-2", heading: "EXT. PLATFORM — DAWN", body: "Nobody claims it." },
          ],
        }),
      });
      expect(first.status).toBe(200);
      const created = (await first.json()) as ScenesResponse;
      expect(created.scenes.map((scene) => [scene.sceneKey, scene.position])).toEqual([
        ["scene-1", 0],
        ["scene-2", 1],
      ]);
      expect(created.scenes[0].heading).toBe("INT. TRAIN — NIGHT");
      expect(app.supabase.scenes).toHaveLength(2);
      expect(app.supabase.scenes[0].owner_id).toBe(USER_A.id);

      // Editing an existing key updates it in place instead of adding a row.
      const second = await apiRequest(app.url, scenesPath(project.id), {
        method: "PUT",
        body: JSON.stringify({
          scenes: [{ key: "scene-2", heading: "EXT. PLATFORM — DAWN", body: "It is claimed at last." }],
        }),
      });
      const replaced = (await second.json()) as ScenesResponse;
      expect(replaced.scenes).toHaveLength(1);
      expect(replaced.scenes[0]).toMatchObject({ sceneKey: "scene-2", position: 0, body: "It is claimed at last." });
      expect(app.supabase.scenes).toHaveLength(1);

      const listed = (await (await apiRequest(app.url, scenesPath(project.id))).json()) as ScenesResponse;
      expect(listed.scenes.map((scene) => scene.sceneKey)).toEqual(["scene-2"]);
    } finally {
      await app.close();
    }
  });

  it("keeps every child route scoped to the project's owner", async () => {
    const app = await startTestServer();

    try {
      const project = await createProject(app);
      await apiRequest(app.url, scenesPath(project.id), {
        method: "PUT",
        body: JSON.stringify({ scenes: [{ key: "scene-1", heading: "INT. TRAIN", body: "" }] }),
      });
      await apiRequest(app.url, `/api/projects/${project.id}/sources`, {
        method: "POST",
        body: JSON.stringify({ kind: "web", title: "A source only A can see" }),
      });

      for (const path of [
        scenesPath(project.id),
        `/api/projects/${project.id}/sources`,
        `/api/projects/${project.id}/claims`,
        `/api/projects/${project.id}/proposals`,
        `/api/projects/${project.id}/jobs`,
        `/api/projects/${project.id}/renders`,
      ]) {
        const response = await apiRequest(app.url, path, {}, USER_B.token);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ ok: false, error: { code: "PROJECT_NOT_FOUND" } });
      }

      // A foreign write is refused before any row is touched.
      const write = await apiRequest(
        app.url,
        scenesPath(project.id),
        { method: "PUT", body: JSON.stringify({ scenes: [] }) },
        USER_B.token,
      );
      expect(write.status).toBe(404);
      expect(app.supabase.scenes).toHaveLength(1);
      expect(app.supabase.sources).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("creates, lists, and deletes a source without touching another account's row", async () => {
    const app = await startTestServer();

    try {
      const project = await createProject(app);
      const created = await apiRequest(app.url, `/api/projects/${project.id}/sources`, {
        method: "POST",
        body: JSON.stringify({
          kind: "web",
          title: "Train timetable, 1912",
          url: "https://example.com/timetable",
          retrievedAt: "2026-11-20T10:00:00.000Z",
        }),
      });
      expect(created.status).toBe(201);
      const { source } = (await created.json()) as SourceResponse;
      expect(source).toMatchObject({
        kind: "web",
        title: "Train timetable, 1912",
        url: "https://example.com/timetable",
        retrievedAt: "2026-11-20T10:00:00.000Z",
      });

      const listed = (await (await apiRequest(app.url, `/api/projects/${project.id}/sources`)).json()) as SourcesResponse;
      expect(listed.sources.map((row) => row.id)).toEqual([source.id]);

      const foreign = await apiRequest(
        app.url,
        `/api/projects/${project.id}/sources/${source.id}`,
        { method: "DELETE" },
        USER_B.token,
      );
      expect(foreign.status).toBe(404);
      expect(app.supabase.sources).toHaveLength(1);

      const removed = await apiRequest(app.url, `/api/projects/${project.id}/sources/${source.id}`, {
        method: "DELETE",
      });
      expect(removed.status).toBe(200);
      expect(app.supabase.sources).toHaveLength(0);
      expect((await apiRequest(app.url, `/api/projects/${project.id}/sources/${source.id}`, { method: "DELETE" })).status).toBe(
        404,
      );
    } finally {
      await app.close();
    }
  });

  it("links a claim to a source of the same project and records its status change", async () => {
    const app = await startTestServer();

    try {
      const project = await createProject(app);
      const source = (await (
        await apiRequest(app.url, `/api/projects/${project.id}/sources`, {
          method: "POST",
          body: JSON.stringify({ kind: "interview", title: "Conductor interview" }),
        })
      ).json()) as SourceResponse;

      const created = await apiRequest(app.url, `/api/projects/${project.id}/claims`, {
        method: "POST",
        body: JSON.stringify({
          statement: "The night train ran without a conductor.",
          sourceId: source.source.id,
          sceneKey: "scene-1",
        }),
      });
      expect(created.status).toBe(201);
      const { claim } = (await created.json()) as ClaimResponse;
      expect(claim).toMatchObject({
        sourceId: source.source.id,
        sceneKey: "scene-1",
        status: "unverified",
      });

      const verified = await apiRequest(app.url, `/api/projects/${project.id}/claims/${claim.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "contradicted" }),
      });
      expect(verified.status).toBe(200);
      expect(((await verified.json()) as ClaimResponse).claim.status).toBe("contradicted");

      const listed = (await (await apiRequest(app.url, `/api/projects/${project.id}/claims`)).json()) as ClaimsResponse;
      expect(listed.claims.map((row) => row.id)).toEqual([claim.id]);

      // Another account cannot read or change the claim through its own session.
      const foreign = await apiRequest(
        app.url,
        `/api/projects/${project.id}/claims/${claim.id}`,
        { method: "PATCH", body: JSON.stringify({ status: "supported" }) },
        USER_B.token,
      );
      expect(foreign.status).toBe(404);
      expect(app.supabase.claims[0].status).toBe("contradicted");
    } finally {
      await app.close();
    }
  });

  it("refuses a claim that points at a source from another project", async () => {
    const app = await startTestServer();

    try {
      const mine = await createProject(app);
      const theirs = await createProject(app, USER_B.token);
      const foreignSource = (await (
        await apiRequest(
          app.url,
          `/api/projects/${theirs.id}/sources`,
          { method: "POST", body: JSON.stringify({ kind: "document", title: "Their document" }) },
          USER_B.token,
        )
      ).json()) as SourceResponse;

      const response = await apiRequest(app.url, `/api/projects/${mine.id}/claims`, {
        method: "POST",
        body: JSON.stringify({ statement: "Borrowed evidence", sourceId: foreignSource.source.id }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "SOURCE_NOT_FOUND" } });
      expect(app.supabase.claims).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("records a generation proposal and later accepts it", async () => {
    const app = await startTestServer();

    try {
      const project = await createProject(app);
      const created = await apiRequest(app.url, `/api/projects/${project.id}/proposals`, {
        method: "POST",
        body: JSON.stringify({
          modelId: "gemma",
          prompt: "Draft scene two.",
          sceneKey: "scene-2",
          proposal: { heading: "EXT. PLATFORM", body: "The claim is made." },
        }),
      });
      expect(created.status).toBe(201);
      const { proposal } = (await created.json()) as ProposalResponse;
      expect(proposal).toMatchObject({
        modelId: "gemma",
        sceneKey: "scene-2",
        status: "proposed",
        proposal: { heading: "EXT. PLATFORM" },
      });

      const accepted = await apiRequest(app.url, `/api/projects/${project.id}/proposals/${proposal.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "accepted" }),
      });
      expect(accepted.status).toBe(200);
      expect(((await accepted.json()) as ProposalResponse).proposal.status).toBe("accepted");

      const listed = (await (
        await apiRequest(app.url, `/api/projects/${project.id}/proposals`)
      ).json()) as ProposalsResponse;
      expect(listed.proposals.map((row) => row.id)).toEqual([proposal.id]);

      const foreign = await apiRequest(
        app.url,
        `/api/projects/${project.id}/proposals/${proposal.id}`,
        { method: "PATCH", body: JSON.stringify({ status: "rejected" }) },
        USER_B.token,
      );
      expect(foreign.status).toBe(404);
      expect(app.supabase.proposals[0].status).toBe("accepted");
    } finally {
      await app.close();
    }
  });

  it("records a provider job and its finished result", async () => {
    const app = await startTestServer();

    try {
      const project = await createProject(app);
      const created = await apiRequest(app.url, `/api/projects/${project.id}/jobs`, {
        method: "POST",
        body: JSON.stringify({
          provider: "json2video",
          externalId: "job_123",
          request: { movie: "storyframe", width: 1080, height: 1920 },
        }),
      });
      expect(created.status).toBe(201);
      const { job } = (await created.json()) as JobResponse;
      expect(job).toMatchObject({ provider: "json2video", status: "queued", externalId: "job_123" });

      const finished = await apiRequest(app.url, `/api/projects/${project.id}/jobs/${job.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "succeeded", result: { url: "https://example.com/render.mp4" } }),
      });
      expect(finished.status).toBe(200);
      const updated = ((await finished.json()) as JobResponse).job;
      expect(updated.status).toBe("succeeded");
      expect(updated.result).toMatchObject({ url: "https://example.com/render.mp4" });
      expect(updated.updatedAt >= updated.createdAt).toBe(true);

      const listed = (await (await apiRequest(app.url, `/api/projects/${project.id}/jobs`)).json()) as JobsResponse;
      expect(listed.jobs.map((row) => row.id)).toEqual([job.id]);
    } finally {
      await app.close();
    }
  });

  it("pins a render snapshot to a revision that exists", async () => {
    const app = await startTestServer();

    try {
      const project = await createProject(app);

      const created = await apiRequest(app.url, `/api/projects/${project.id}/renders`, {
        method: "POST",
        body: JSON.stringify({ projectRevision: 1, outputKey: "renders/project-1-v1.mp4" }),
      });
      expect(created.status).toBe(201);
      const { render } = (await created.json()) as RenderResponse;
      expect(render).toMatchObject({
        projectRevision: 1,
        status: "pending",
        outputKey: "renders/project-1-v1.mp4",
      });

      const unknownRevision = await apiRequest(app.url, `/api/projects/${project.id}/renders`, {
        method: "POST",
        body: JSON.stringify({ projectRevision: 9 }),
      });
      expect(unknownRevision.status).toBe(409);
      expect(await unknownRevision.json()).toMatchObject({
        ok: false,
        error: { code: "PROJECT_REVISION_NOT_FOUND" },
      });

      const listed = (await (await apiRequest(app.url, `/api/projects/${project.id}/renders`)).json()) as RendersResponse;
      expect(listed.renders.map((row) => row.id)).toEqual([render.id]);
      expect(app.supabase.renders).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("rejects malformed child payloads and client-supplied ownership", async () => {
    const app = await startTestServer();

    try {
      const project = await createProject(app);
      const cases: { path: string; method: string; body: unknown; code: string }[] = [
        {
          path: scenesPath(project.id),
          method: "PUT",
          body: { scenes: [{ key: "a", heading: "x" }, { key: "a", heading: "y" }] },
          code: "DUPLICATE_SCENE_KEY",
        },
        {
          path: scenesPath(project.id),
          method: "PUT",
          body: { scenes: [{ key: "a", heading: "x", owner_id: USER_B.id }] },
          code: "UNEXPECTED_FIELD",
        },
        {
          path: `/api/projects/${project.id}/sources`,
          method: "POST",
          body: { kind: "web", title: "x", url: "javascript:alert(1)" },
          code: "INVALID_CHILD_RECORD",
        },
        {
          path: `/api/projects/${project.id}/sources`,
          method: "POST",
          body: { kind: "book", title: "x" },
          code: "INVALID_CHILD_RECORD",
        },
        {
          path: `/api/projects/${project.id}/claims`,
          method: "POST",
          body: { statement: "x", status: "supported", owner_id: USER_B.id },
          code: "UNEXPECTED_FIELD",
        },
        {
          path: `/api/projects/${project.id}/proposals`,
          method: "POST",
          body: { modelId: "gemma", prompt: "x", proposal: "not an object" },
          code: "INVALID_CHILD_RECORD",
        },
        {
          path: `/api/projects/${project.id}/jobs`,
          method: "POST",
          body: { provider: " " },
          code: "INVALID_CHILD_RECORD",
        },
        {
          path: `/api/projects/${project.id}/renders`,
          method: "POST",
          body: { projectRevision: 0 },
          code: "INVALID_CHILD_RECORD",
        },
      ];

      for (const testCase of cases) {
        const response = await apiRequest(app.url, testCase.path, {
          method: testCase.method,
          body: JSON.stringify(testCase.body),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ ok: false, error: { code: testCase.code } });
      }

      expect(app.supabase.scenes).toHaveLength(0);
      expect(app.supabase.sources).toHaveLength(0);
      expect(app.supabase.claims).toHaveLength(0);
      expect(app.supabase.proposals).toHaveLength(0);
      expect(app.supabase.jobs).toHaveLength(0);
      expect(app.supabase.renders).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("rejects an unknown child record id without querying the table", async () => {
    const app = await startTestServer();

    try {
      const project = await createProject(app);
      const response = await apiRequest(app.url, `/api/projects/${project.id}/sources/not-a-uuid`, {
        method: "DELETE",
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "CHILD_RECORD_NOT_FOUND" } });

      const unknownResource = await apiRequest(app.url, `/api/projects/${project.id}/unknown`);
      expect(unknownResource.status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("cascades child rows when their project is deleted", async () => {
    const app = await startTestServer();

    try {
      const project = await createProject(app);
      await apiRequest(app.url, scenesPath(project.id), {
        method: "PUT",
        body: JSON.stringify({ scenes: [{ key: "scene-1", heading: "INT. TRAIN", body: "" }] }),
      });
      await apiRequest(app.url, `/api/projects/${project.id}/sources`, {
        method: "POST",
        body: JSON.stringify({ kind: "other", title: "Notes" }),
      });
      await apiRequest(app.url, `/api/projects/${project.id}/renders`, {
        method: "POST",
        body: JSON.stringify({ projectRevision: 1 }),
      });
      expect(app.supabase.scenes).toHaveLength(1);
      expect(app.supabase.sources).toHaveLength(1);
      expect(app.supabase.renders).toHaveLength(1);

      expect((await apiRequest(app.url, `/api/projects/${project.id}`, { method: "DELETE" })).status).toBe(200);
      expect(app.supabase.scenes).toHaveLength(0);
      expect(app.supabase.sources).toHaveLength(0);
      expect(app.supabase.renders).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("requires a session for every child route", async () => {
    const app = await startTestServer();

    try {
      const project = await createProject(app);
      const attempts = [
        apiRequest(app.url, scenesPath(project.id), {}, null),
        apiRequest(app.url, scenesPath(project.id), { method: "PUT", body: JSON.stringify({ scenes: [] }) }, null),
        apiRequest(app.url, `/api/projects/${project.id}/sources`, {}, null),
        apiRequest(app.url, `/api/projects/${project.id}/claims`, {}, null),
        apiRequest(app.url, `/api/projects/${project.id}/proposals`, {}, null),
        apiRequest(app.url, `/api/projects/${project.id}/jobs`, {}, null),
        apiRequest(app.url, `/api/projects/${project.id}/renders`, {}, null),
      ];

      for (const response of await Promise.all(attempts)) {
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
      }
    } finally {
      await app.close();
    }
  });

  it("refuses child calls when the project store is not configured", async () => {
    const app = await startTestServer({ env: { SUPABASE_SERVICE_ROLE_KEY: "" } });

    try {
      const response = await apiRequest(
        app.url,
        "/api/projects/33333333-3333-4333-8333-333333333333/scenes",
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "PROJECTS_NOT_CONFIGURED" },
      });
    } finally {
      await app.close();
    }
  });
});
