import { describe, expect, it } from "vitest";
import type {
  ProjectDeletedResponse,
  ProjectDocumentV2,
  ProjectListResponse,
  ProjectRecord,
  ProjectResponse,
} from "../shared/project-contract";
import { USER_A, USER_B } from "./fake-supabase";
import { documentFixture } from "./project-fixture";
import { apiRequest, startTestServer, type TestApp } from "./server-helpers";

// MOCKED: Supabase is a local fake serving Auth and PostgREST over real HTTP.

const DOCUMENT: ProjectDocumentV2 = documentFixture();

async function createProject(
  app: TestApp,
  token: string = USER_A.token,
  overrides: Record<string, unknown> = {},
): Promise<ProjectRecord> {
  const response = await apiRequest(
    app.url,
    "/api/projects",
    {
      method: "POST",
      body: JSON.stringify({
        projectType: "story",
        title: "The Late Letter",
        document: DOCUMENT,
        ...overrides,
      }),
    },
    token,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as ProjectResponse).project;
}

describe("project data model", () => {
  it("creates a project owned by the verified user and records revision 1", async () => {
    const app = await startTestServer();

    try {
      const project = await createProject(app);

      expect(project).toMatchObject({
        projectType: "story",
        title: "The Late Letter",
        schemaVersion: 2,
        version: 1,
        document: DOCUMENT,
      });
      expect(app.supabase.projects).toHaveLength(1);
      expect(app.supabase.projects[0].owner_id).toBe(USER_A.id);
      expect(app.supabase.revisions).toHaveLength(1);
      expect(app.supabase.revisions[0]).toMatchObject({
        project_id: project.id,
        owner_id: USER_A.id,
        revision: 1,
        schema_version: 2,
        title: "The Late Letter",
        document: DOCUMENT,
      });
    } finally {
      await app.close();
    }
  });

  it("does not let another account read, update, or delete a project", async () => {
    const app = await startTestServer();

    try {
      const project = await createProject(app);

      const read = await apiRequest(app.url, `/api/projects/${project.id}`, {}, USER_B.token);
      expect(read.status).toBe(404);
      expect(await read.json()).toMatchObject({ ok: false, error: { code: "PROJECT_NOT_FOUND" } });

      const update = await apiRequest(
        app.url,
        `/api/projects/${project.id}`,
        {
          method: "PUT",
          body: JSON.stringify({ title: "Hijacked", document: DOCUMENT, version: 1 }),
        },
        USER_B.token,
      );
      expect(update.status).toBe(404);

      const remove = await apiRequest(app.url, `/api/projects/${project.id}`, { method: "DELETE" }, USER_B.token);
      expect(remove.status).toBe(404);

      // The owner's row and its single revision are untouched.
      expect(app.supabase.projects[0]).toMatchObject({
        id: project.id,
        owner_id: USER_A.id,
        title: "The Late Letter",
        version: 1,
      });
      expect(app.supabase.revisions).toHaveLength(1);
      expect((await apiRequest(app.url, `/api/projects/${project.id}`)).status).toBe(200);

      // A malformed id is answered before the store is touched, not with a 503.
      expect((await apiRequest(app.url, "/api/projects/not-a-uuid")).status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("lists only the caller's own projects", async () => {
    const app = await startTestServer();

    try {
      const mine = await createProject(app);
      const theirs = await createProject(app, USER_B.token, { title: "Someone Else's Story" });

      const a = (await (await apiRequest(app.url, "/api/projects")).json()) as ProjectListResponse;
      const b = (await (await apiRequest(app.url, "/api/projects", {}, USER_B.token)).json()) as ProjectListResponse;

      expect(a.projects.map((project) => project.id)).toEqual([mine.id]);
      expect(b.projects.map((project) => project.id)).toEqual([theirs.id]);
      expect(a.projects[0]).not.toHaveProperty("document");
    } finally {
      await app.close();
    }
  });

  it("saves an update, increments the version, and appends a revision", async () => {
    const app = await startTestServer();

    try {
      const project = await createProject(app);
      const revised: ProjectDocumentV2 = { ...DOCUMENT, summary: "The letter was meant for the courier." };

      const response = await apiRequest(app.url, `/api/projects/${project.id}`, {
        method: "PUT",
        body: JSON.stringify({ title: "The Late Letter (revised)", document: revised, version: 1 }),
      });
      expect(response.status).toBe(200);

      const updated = ((await response.json()) as ProjectResponse).project;
      expect(updated).toMatchObject({
        id: project.id,
        title: "The Late Letter (revised)",
        version: 2,
        document: revised,
      });

      expect(app.supabase.revisions.map((revision) => revision.revision)).toEqual([1, 2]);
      expect(app.supabase.revisions[1]).toMatchObject({
        revision: 2,
        title: "The Late Letter (revised)",
        document: revised,
      });

      // The stored document keeps the revision that produced it.
      expect(app.supabase.revisions[0].document).toMatchObject({ summary: DOCUMENT.summary });
    } finally {
      await app.close();
    }
  });

  it("refuses a stale version without writing anything", async () => {
    const app = await startTestServer();

    try {
      const project = await createProject(app);
      await apiRequest(app.url, `/api/projects/${project.id}`, {
        method: "PUT",
        body: JSON.stringify({ title: "Second write", document: DOCUMENT, version: 1 }),
      });

      const stale = await apiRequest(app.url, `/api/projects/${project.id}`, {
        method: "PUT",
        body: JSON.stringify({ title: "Stale write", document: DOCUMENT, version: 1 }),
      });

      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        ok: false,
        error: { code: "PROJECT_VERSION_CONFLICT" },
      });
      expect(app.supabase.projects[0]).toMatchObject({ title: "Second write", version: 2 });
      expect(app.supabase.revisions).toHaveLength(2);

      const reread = (await (await apiRequest(app.url, `/api/projects/${project.id}`)).json()) as ProjectResponse;
      expect(reread.project).toMatchObject({ title: "Second write", version: 2 });
    } finally {
      await app.close();
    }
  });

  it("deletes only the caller's project, cascading its revisions", async () => {
    const app = await startTestServer();

    try {
      const mine = await createProject(app);
      const theirs = await createProject(app, USER_B.token);

      const removed = await apiRequest(app.url, `/api/projects/${mine.id}`, { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect((await removed.json()) as ProjectDeletedResponse).toMatchObject({
        ok: true,
        deletedId: mine.id,
      });

      expect(app.supabase.projects.map((project) => project.id)).toEqual([theirs.id]);
      expect(app.supabase.revisions).toHaveLength(1);
      expect(app.supabase.revisions[0].project_id).toBe(theirs.id);
      expect((await apiRequest(app.url, `/api/projects/${mine.id}`)).status).toBe(404);
      expect((await apiRequest(app.url, `/api/projects/${theirs.id}`, {}, USER_B.token)).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("rejects malformed project payloads and client-supplied ownership", async () => {
    const app = await startTestServer();

    try {
      const cases: { body: unknown; code: string }[] = [
        { body: { projectType: "novel", title: "x", document: DOCUMENT }, code: "INVALID_PROJECT_TYPE" },
        { body: { projectType: "story", title: "   ", document: DOCUMENT }, code: "INVALID_PROJECT" },
        {
          body: { projectType: "story", title: "x", document: { ...DOCUMENT, schemaVersion: 3 } },
          code: "UNSUPPORTED_PROJECT_SCHEMA",
        },
        {
          body: { projectType: "story", title: "x", document: { ...DOCUMENT, extra: true } },
          code: "UNEXPECTED_FIELD",
        },
        {
          body: { projectType: "story", title: "x", document: DOCUMENT, owner_id: USER_B.id },
          code: "UNEXPECTED_FIELD",
        },
      ];

      for (const testCase of cases) {
        const response = await apiRequest(app.url, "/api/projects", {
          method: "POST",
          body: JSON.stringify(testCase.body),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ ok: false, error: { code: testCase.code } });
      }

      expect(app.supabase.projects).toHaveLength(0);
      expect(app.supabase.revisions).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("refuses a stored document from a schema it cannot read", async () => {
    const app = await startTestServer();

    try {
      const now = new Date().toISOString();
      app.supabase.projects.push({
        id: "33333333-3333-4333-8333-333333333333",
        owner_id: USER_A.id,
        project_type: "story",
        title: "Written By A Newer Server",
        schema_version: 3,
        document: { schemaVersion: 3, summary: "", scenes: [] },
        version: 1,
        created_at: now,
        updated_at: now,
      });

      const response = await apiRequest(app.url, "/api/projects/33333333-3333-4333-8333-333333333333");
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "UNSUPPORTED_PROJECT_SCHEMA" },
      });
    } finally {
      await app.close();
    }
  });

  it("requires a session for every project route", async () => {
    const app = await startTestServer();

    try {
      const attempts = [
        apiRequest(app.url, "/api/projects", {}, null),
        apiRequest(
          app.url,
          "/api/projects",
          { method: "POST", body: JSON.stringify({ projectType: "story", title: "x", document: DOCUMENT }) },
          null,
        ),
        apiRequest(app.url, "/api/projects/33333333-3333-4333-8333-333333333333", {}, null),
        apiRequest(app.url, "/api/projects/33333333-3333-4333-8333-333333333333", { method: "DELETE" }, null),
      ];

      for (const response of await Promise.all(attempts)) {
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
      }

      expect(app.supabase.projects).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("refuses project calls when the store is not configured", async () => {
    const app = await startTestServer({ env: { SUPABASE_SERVICE_ROLE_KEY: "" } });

    try {
      const response = await apiRequest(app.url, "/api/projects");
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
