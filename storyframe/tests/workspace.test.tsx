// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sceneFingerprint } from "../shared/scene-fingerprint";
import type { GenerationProposalRecord } from "../shared/child-contract";
import type { MediaRecord } from "../shared/media-contract";
import type {
  ProjectDocumentV2,
  ProjectRecord,
  ProjectRevisionSummary,
  ProjectSummary,
} from "../shared/project-contract";
import { Workspace } from "../src/workspace/Workspace";
import { briefFixture, documentFixture, sceneFixture } from "./project-fixture";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-24T12:00:00.000Z";

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => payload,
  } as unknown as Response;
}

interface FakeBackend {
  projects: Map<string, ProjectRecord>;
  revisions: Map<string, ProjectRevisionSummary[]>;
  media: Map<string, MediaRecord[]>;
  references: Map<string, { id: string; refKind: "scene"; refId: string }[]>;
  saveFailures: number;
  uploads: { url: string; headers: Record<string, string> }[];
  requests: { method: string; path: string; body: unknown }[];
  /** Planning stub: no provider is contacted; the second attempt replays. */
  planningKeys: (string | null)[];
  planningAttempts: number;
  planningProposal: GenerationProposalRecord | null;
}

function makeBackend(project?: ProjectRecord): FakeBackend {
  const backend: FakeBackend = {
    projects: new Map(project ? [[project.id, project]] : []),
    revisions: new Map(project ? [[project.id, [{ revision: 1, title: project.title, schemaVersion: 2, createdAt: NOW }]]] : []),
    media: new Map(project ? [[project.id, []]] : []),
    references: new Map(),
    saveFailures: 0,
    uploads: [],
    requests: [],
    planningKeys: [],
    planningAttempts: 0,
    planningProposal: null,
  };
  return backend;
}

function summarize(project: ProjectRecord): ProjectSummary {
  const { document: _document, ...summary } = project;
  return summary;
}

function installBackend(backend: FakeBackend) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(input);
    const url = new URL(raw, "http://localhost");
    const method = init?.method ?? "GET";
    const path = url.pathname;
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body) as unknown;
    }
    backend.requests.push({ method, path, body });

    // Direct presigned upload to the fake private bucket.
    if (url.host === "r2.test" && path.startsWith("/upload/")) {
      backend.uploads.push({
        url: raw,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return jsonResponse({ ok: true });
    }
    if (url.host === "r2.test" && path.startsWith("/play/")) {
      return jsonResponse({ ok: true });
    }

    if (path === "/api/projects" && method === "GET") {
      return jsonResponse({ ok: true, projects: [...backend.projects.values()].map(summarize) });
    }

    if (path === "/api/projects" && method === "POST") {
      const write = body as { projectType: ProjectRecord["projectType"]; title: string; document: ProjectDocumentV2 };
      const project: ProjectRecord = {
        id: PROJECT_ID,
        projectType: write.projectType,
        title: write.title,
        schemaVersion: 2,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
        document: write.document,
      };
      backend.projects.set(project.id, project);
      backend.revisions.set(project.id, [
        { revision: 1, title: project.title, schemaVersion: 2, createdAt: NOW },
      ]);
      backend.media.set(project.id, []);
      return jsonResponse({ ok: true, project }, 201);
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch) {
      const project = backend.projects.get(projectMatch[1]);
      if (!project) return jsonResponse({ ok: false, error: { code: "PROJECT_NOT_FOUND", message: "missing" } }, 404);
      if (method === "GET") return jsonResponse({ ok: true, project });
      if (method === "PUT") {
        const update = body as { title: string; document: ProjectDocumentV2; version: number };
        if (backend.saveFailures > 0) {
          backend.saveFailures -= 1;
          return jsonResponse(
            { ok: false, error: { code: "PROJECTS_UNAVAILABLE", message: "The project store is unreachable." } },
            503,
          );
        }
        if (update.version !== project.version) {
          return jsonResponse(
            {
              ok: false,
              error: { code: "PROJECT_VERSION_CONFLICT", message: "This project changed after it was loaded." },
            },
            409,
          );
        }
        const document: ProjectDocumentV2 = {
          ...update.document,
          scenes: update.document.scenes.map((scene) => {
            if (!scene.approved) return scene;
            return scene.approvedFingerprint === sceneFingerprint(scene)
              ? scene
              : { ...scene, approved: false, approvedFingerprint: null };
          }),
        };
        const saved: ProjectRecord = {
          ...project,
          title: update.title,
          document,
          version: project.version + 1,
          updatedAt: new Date().toISOString(),
        };
        backend.projects.set(saved.id, saved);
        backend.revisions.set(saved.id, [
          { revision: saved.version, title: saved.title, schemaVersion: 2, createdAt: saved.updatedAt },
          ...(backend.revisions.get(saved.id) ?? []),
        ]);
        return jsonResponse({ ok: true, project: saved });
      }
      if (method === "DELETE") {
        backend.projects.delete(project.id);
        return jsonResponse({ ok: true, deletedId: project.id });
      }
    }

    const revisionsMatch = path.match(/^\/api\/projects\/([^/]+)\/revisions$/);
    if (revisionsMatch && method === "GET") {
      return jsonResponse({ ok: true, revisions: backend.revisions.get(revisionsMatch[1]) ?? [] });
    }

    const mediaListMatch = path.match(/^\/api\/projects\/([^/]+)\/media$/);
    if (mediaListMatch) {
      const projectId = mediaListMatch[1];
      const media = backend.media.get(projectId) ?? [];
      if (method === "GET") return jsonResponse({ ok: true, media });
      if (method === "POST") {
        const write = body as { kind: MediaRecord["kind"]; contentType: string; byteSize: number; sceneKey?: string };
        const mediaId = `media-${media.length + 1}`;
        const record: MediaRecord = {
          id: mediaId,
          kind: write.kind,
          status: "pending",
          sceneKey: write.sceneKey ?? null,
          contentType: write.contentType,
          byteSize: write.byteSize,
          uploadExpiresAt: new Date(Date.now() + 900_000).toISOString(),
          readyAt: null,
          deletedAt: null,
          createdAt: NOW,
          referenceCount: 0,
          provenance: null,
        };
        backend.media.set(projectId, [record, ...media]);
        return jsonResponse(
          {
            ok: true,
            media: record,
            upload: {
              url: `https://r2.test/upload/${mediaId}`,
              method: "PUT",
              headers: { "Content-Type": write.contentType },
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            },
          },
          201,
        );
      }
    }

    const mediaMatch = path.match(/^\/api\/projects\/([^/]+)\/media\/([^/]+)(?:\/(complete|url|references))?$/);
    if (mediaMatch) {
      const [, projectId, mediaId, action] = mediaMatch;
      const media = backend.media.get(projectId) ?? [];
      const index = media.findIndex((record) => record.id === mediaId);
      if (index === -1) return jsonResponse({ ok: false, error: { code: "MEDIA_NOT_FOUND", message: "missing" } }, 404);
      const record = media[index];

      if (action === "complete") {
        const ready: MediaRecord = {
          ...record,
          status: "ready",
          readyAt: new Date().toISOString(),
          uploadExpiresAt: null,
        };
        media[index] = ready;
        return jsonResponse({ ok: true, media: ready });
      }
      if (action === "url") {
        return jsonResponse({
          ok: true,
          url: `https://r2.test/play/${mediaId}`,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          contentType: record.contentType,
          byteSize: record.byteSize,
        });
      }
      if (action === "references" && method === "GET") {
        return jsonResponse({ ok: true, references: backend.references.get(mediaId) ?? [] });
      }
      if (action === "references" && method === "POST") {
        media[index] = { ...record, referenceCount: record.referenceCount + 1 };
        const reference = {
          id: `ref-${mediaId}-${record.referenceCount + 1}`,
          refKind: "scene" as const,
          refId: (body as { refId: string }).refId,
        };
        backend.references.set(mediaId, [...(backend.references.get(mediaId) ?? []), reference]);
        return jsonResponse(
          { ok: true, reference: { ...reference, createdAt: new Date().toISOString() } },
          201,
        );
      }
      if (!action && method === "DELETE") {
        if (record.referenceCount > 0) {
          return jsonResponse(
            {
              ok: false,
              error: {
                code: "MEDIA_IN_USE",
                message: "This media is referenced and cannot be deleted.",
              },
            },
            409,
          );
        }
        media.splice(index, 1);
        return jsonResponse({ ok: true, deletedId: mediaId });
      }
    }

    const referenceMatch = path.match(/^\/api\/projects\/([^/]+)\/media\/([^/]+)\/references\/([^/]+)$/);
    if (referenceMatch && method === "DELETE") {
      const [, projectId, mediaId, referenceId] = referenceMatch;
      const media = backend.media.get(projectId) ?? [];
      const index = media.findIndex((record) => record.id === mediaId);
      if (index !== -1) {
        media[index] = { ...media[index], referenceCount: Math.max(0, media[index].referenceCount - 1) };
      }
      const remaining = (backend.references.get(mediaId) ?? []).filter((item) => item.id !== referenceId);
      backend.references.set(mediaId, remaining);
      return jsonResponse({ ok: true, deletedId: referenceId });
    }

    const proposalsMatch = path.match(/^\/api\/projects\/([^/]+)\/proposals$/);
    if (proposalsMatch && method === "GET") {
      return jsonResponse({
        ok: true,
        proposals: backend.planningProposal ? [backend.planningProposal] : [],
      });
    }

    // Stubbed planning provider: the first attempt reports in-progress (so the
    // key must be kept), and the same key on the next attempt replays the reply.
    const planningMatch = path.match(/^\/api\/projects\/([^/]+)\/planning$/);
    if (planningMatch && method === "POST") {
      backend.planningKeys.push(new Headers(init?.headers).get("Idempotency-Key"));
      backend.planningAttempts += 1;
      if (backend.planningAttempts === 1) {
        return jsonResponse(
          { ok: false, error: { code: "IDEMPOTENCY_IN_PROGRESS", message: "The attempt is still running." } },
          409,
        );
      }
      backend.planningProposal ??= planningProposalFixture();
      return jsonResponse({ ok: true, proposal: backend.planningProposal }, 201);
    }

    const acceptMatch = path.match(/^\/api\/projects\/([^/]+)\/proposals\/([^/]+)\/accept$/);
    if (acceptMatch && method === "POST") {
      const project = backend.projects.get(acceptMatch[1]);
      if (!project || !backend.planningProposal) {
        return jsonResponse({ ok: false, error: { code: "PROPOSAL_NOT_FOUND", message: "missing" } }, 404);
      }
      const accepted: GenerationProposalRecord = { ...backend.planningProposal, status: "accepted" };
      backend.planningProposal = accepted;
      const updated: ProjectRecord = { ...project, version: project.version + 1, updatedAt: NOW };
      backend.projects.set(updated.id, updated);
      return jsonResponse({ ok: true, proposal: accepted, project: updated, claimsRecorded: true });
    }

    throw new Error(`Unexpected request: ${method} ${raw}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function projectFixture(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    projectType: "story",
    title: "The Late Letter",
    schemaVersion: 2,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    document: documentFixture(),
    ...overrides,
  };
}

function planningProposalFixture(): GenerationProposalRecord {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    sceneKey: null,
    modelId: "gemma",
    prompt: "planning prompt",
    status: "proposed",
    route: "angles",
    baseVersion: 1,
    createdAt: NOW,
    proposal: {
      route: "angles",
      summary: "Three angles for the late letter.",
      notes: ["Kept the letter as the through-line."],
      angles: [
        { title: "The missed connection", hook: "A letter arrives too late.", rationale: "Immediate stakes." },
        { title: "The wrong recipient", hook: "Someone else reads it.", rationale: "Adds a turn." },
        { title: "The return trip", hook: "The courier goes back.", rationale: "A hopeful ending." },
      ],
      scenes: [],
      clips: [],
      claims: [],
      insufficientEvidence: false,
      repairAttempted: false,
    },
  };
}

function renderWorkspace() {
  const getAccessToken = vi.fn(async () => "access-token");
  render(<Workspace getAccessToken={getAccessToken} />);
  return { getAccessToken };
}

async function openProject(backend: FakeBackend) {
  installBackend(backend);
  renderWorkspace();
  fireEvent.click(await screen.findByRole("button", { name: `Open ${backend.projects.get(PROJECT_ID)?.title}` }));
  await screen.findByLabelText("Project title");
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("workspace", () => {
  it("creates a project from the dashboard, edits the brief, and saves it", async () => {
    const backend = makeBackend();
    const fetchMock = installBackend(backend);
    renderWorkspace();

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(await screen.findByText(/No projects yet/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("New project"), { target: { value: "product-ad" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    const title = await screen.findByLabelText("Project title");
    expect(title).toHaveValue("Untitled product ad");

    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "A quieter launch" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Saved version 2/)).toBeInTheDocument();

    const saved = backend.projects.get(PROJECT_ID);
    expect(saved).toMatchObject({
      projectType: "product-ad",
      title: "Untitled product ad",
      version: 2,
    });
    expect(saved?.document.brief).toMatchObject({ topic: "A quieter launch", mode: "factual" });
    expect(saved?.document.scenes).toHaveLength(1);

    const put = backend.requests.find((request) => request.method === "PUT");
    expect((put?.body as { document: ProjectDocumentV2 }).document.brief.topic).toBe(
      "A quieter launch",
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to dashboard" }));
    expect(await screen.findByRole("button", { name: "Open Untitled product ad" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("reopens a saved project with its script, and keeps locked narration disabled", async () => {
    const project = projectFixture({
      document: documentFixture({
        scenes: [sceneFixture({ id: "scene-1", body: "The letter waits." })],
      }),
    });
    const backend = makeBackend(project);
    installBackend(backend);
    renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "Open The Late Letter" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Script" }));

    const narration = screen.getByLabelText("Scene 1 narration");
    expect(narration).toHaveValue("The letter waits.");

    fireEvent.change(narration, { target: { value: "The letter is opened." } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(/Saved version 2/);

    fireEvent.click(screen.getByLabelText("Lock narration for scene 1"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(/Saved version 3/);

    fireEvent.click(screen.getByRole("button", { name: "Back to dashboard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open The Late Letter" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Script" }));

    const reloaded = screen.getByLabelText("Scene 1 narration");
    expect(reloaded).toHaveValue("The letter is opened.");
    expect(reloaded).toBeDisabled();
    expect(backend.projects.get(PROJECT_ID)?.document.scenes[0].locks.narration).toBe(true);
  });

  it("duplicates, reorders, deletes, and retimes scenes with stable remaining ids", async () => {
    const project = projectFixture({
      document: documentFixture({
        brief: briefFixture({ targetDurationSeconds: 60 }),
        scenes: [
          sceneFixture({ id: "scene-a", heading: "Scene A", durationSeconds: 10 }),
          sceneFixture({ id: "scene-b", heading: "Scene B", durationSeconds: 20 }),
          sceneFixture({ id: "scene-c", heading: "Scene C", durationSeconds: 0 }),
        ],
      }),
    });
    const backend = makeBackend(project);
    installBackend(backend);
    renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "Open The Late Letter" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Script" }));
    expect(screen.getByText("0:30 / 1:00 planned")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Duplicate scene 2" }));
    expect(screen.getByText("0:50 / 1:00 planned")).toBeInTheDocument();
    expect(screen.getByLabelText("Scene 3 heading")).toHaveValue("Scene B (copy)");

    fireEvent.click(screen.getByRole("button", { name: "Move scene 3 up" }));
    expect(screen.getByLabelText("Scene 1 heading")).toHaveValue("Scene A");
    expect(screen.getByLabelText("Scene 2 heading")).toHaveValue("Scene B (copy)");
    expect(screen.getByLabelText("Scene 3 heading")).toHaveValue("Scene B");

    fireEvent.click(screen.getByRole("button", { name: "Delete scene 1" }));
    expect(screen.getByLabelText("Scene 1 heading")).toHaveValue("Scene B (copy)");
    expect(screen.getByLabelText("Scene 2 heading")).toHaveValue("Scene B");

    fireEvent.click(screen.getByRole("tab", { name: "Storyboard" }));
    fireEvent.change(screen.getByLabelText("Scene 1 duration"), { target: { value: "15" } });
    expect(screen.getByText("0:35 / 1:00 planned")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(/Saved version 2/);

    const saved = backend.projects.get(PROJECT_ID)?.document.scenes ?? [];
    expect(saved.map((scene) => scene.heading)).toEqual(["Scene B (copy)", "Scene B", "Scene C"]);
    expect(saved.map((scene) => scene.durationSeconds)).toEqual([15, 20, 0]);
    expect(saved[1].id).toBe("scene-b");
    expect(saved[2].id).toBe("scene-c");
    expect(saved[0].id).not.toBe("scene-a");
  });

  it("marks an approval stale when narration changes and clears it on save", async () => {
    const project = projectFixture();
    const backend = makeBackend(project);
    installBackend(backend);
    renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "Open The Late Letter" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Storyboard" }));

    expect(screen.getByTestId("approval-scene-1")).toHaveTextContent("Not approved");
    fireEvent.click(screen.getByRole("button", { name: "Approve current content for scene 1" }));
    expect(screen.getByTestId("approval-scene-1")).toHaveTextContent("Approved");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(/Saved version 2/);
    expect(backend.projects.get(PROJECT_ID)?.document.scenes[0].approved).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: "Script" }));
    fireEvent.change(screen.getByLabelText("Scene 1 narration"), {
      target: { value: "A different line changes the approved content." },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Storyboard" }));
    expect(screen.getByTestId("approval-scene-1")).toHaveTextContent("Approval out of date");

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(/Saved version 3/);
    const scene = backend.projects.get(PROJECT_ID)?.document.scenes[0];
    expect(scene).toMatchObject({ approved: false, approvedFingerprint: null });
    expect(screen.getByTestId("approval-scene-1")).toHaveTextContent("Not approved");
  });

  it("uploads media through initiate, direct PUT, complete, reference, attach, and playback", async () => {
    const project = projectFixture();
    const backend = makeBackend(project);
    installBackend(backend);
    renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "Open The Late Letter" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Media" }));
    await screen.findByText(/No media yet/i);

    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "frame.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByLabelText(/Media file/), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload media" }));

    expect(await screen.findByText(/attached to "INT\. TRAIN CAR - NIGHT"/i)).toBeInTheDocument();
    expect(backend.uploads).toHaveLength(1);
    expect(backend.uploads[0]).toMatchObject({
      url: "https://r2.test/upload/media-1",
      headers: { "Content-Type": "image/png" },
    });

    const initiate = backend.requests.find(
      (request) => request.method === "POST" && request.path === `/api/projects/${PROJECT_ID}/media`,
    );
    // One scene link only: the explicit reference below, never `sceneKey` too.
    expect(initiate?.body).toMatchObject({
      kind: "image",
      contentType: "image/png",
    });
    expect(initiate?.body).not.toHaveProperty("sceneKey");
    expect(
      backend.requests.some(
        (request) => request.path === `/api/projects/${PROJECT_ID}/media/media-1/complete`,
      ),
    ).toBe(true);
    expect(
      backend.requests.some(
        (request) => request.path === `/api/projects/${PROJECT_ID}/media/media-1/references`,
      ),
    ).toBe(true);

    const savedScene = backend.projects.get(PROJECT_ID)?.document.scenes[0];
    expect(savedScene?.assetIds).toEqual(["media-1"]);
    expect(backend.media.get(PROJECT_ID)?.[0]).toMatchObject({ status: "ready", referenceCount: 1 });
    expect(await screen.findByRole("img", { name: /Uploaded image/i })).toHaveAttribute(
      "src",
      "https://r2.test/play/media-1",
    );

    // The asset is referenced by the scene, so the media store refuses deletion.
    fireEvent.click(screen.getByRole("button", { name: "Delete asset" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(await screen.findByText(/referenced and cannot be deleted/i)).toBeInTheDocument();
    await waitFor(() => expect(backend.media.get(PROJECT_ID)).toHaveLength(1));
  });

  it("detaches media from its scene so the asset can then be deleted", async () => {
    const project = projectFixture();
    const backend = makeBackend(project);
    installBackend(backend);
    renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "Open The Late Letter" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Media" }));
    await screen.findByText(/No media yet/i);

    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "frame.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByLabelText(/Media file/), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload media" }));
    await screen.findByText(/attached to "INT\. TRAIN CAR - NIGHT"/i);

    fireEvent.click(screen.getByRole("button", { name: "Detach media from scene 1" }));
    expect(await screen.findByText(/Detached from scene 1 and saved/i)).toBeInTheDocument();
    expect(backend.projects.get(PROJECT_ID)?.document.scenes[0].assetIds).toEqual([]);
    expect(backend.media.get(PROJECT_ID)?.[0]).toMatchObject({ referenceCount: 0 });
    expect(backend.references.get("media-1")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Delete asset" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(backend.media.get(PROJECT_ID)).toHaveLength(0));
    expect(screen.queryByRole("button", { name: "Detach media from scene 1" })).not.toBeInTheDocument();
  });

  it("retries detach after the reference was released but the save failed", async () => {
    const project = projectFixture();
    const backend = makeBackend(project);
    installBackend(backend);
    renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "Open The Late Letter" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Media" }));
    await screen.findByText(/No media yet/i);

    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "frame.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByLabelText(/Media file/), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload media" }));
    await screen.findByText(/attached to "INT\. TRAIN CAR - NIGHT"/i);

    // The release succeeds, then the project save fails.
    backend.saveFailures = 1;
    fireEvent.click(screen.getByRole("button", { name: "Detach media from scene 1" }));
    expect(await screen.findByText(/reference was released, but the project save did not complete/i)).toBeInTheDocument();
    expect(backend.projects.get(PROJECT_ID)?.document.scenes[0].assetIds).toEqual(["media-1"]);
    expect(backend.references.get("media-1")).toEqual([]);
    expect(screen.getByRole("button", { name: "Delete asset" })).toBeDisabled();

    // The scene link is still shown, and the missing reference does not block the retry.
    const retry = await screen.findByRole("button", { name: "Detach media from scene 1" });
    fireEvent.click(retry);
    expect(await screen.findByText(/Detached from scene 1 and saved/i)).toBeInTheDocument();
    expect(backend.projects.get(PROJECT_ID)?.document.scenes[0].assetIds).toEqual([]);
    expect(backend.references.get("media-1")).toEqual([]);
    expect(screen.getByRole("button", { name: "Delete asset" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Delete asset" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(backend.media.get(PROJECT_ID)).toHaveLength(0));
  });

  it("generates from the Plan tab, replays a reload-persisted key, and accepts", async () => {
    const backend = makeBackend(projectFixture());
    await openProject(backend);
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    expect(await screen.findByText("No proposals yet.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("IDEMPOTENCY_IN_PROGRESS")).toBeInTheDocument();
    expect(backend.planningKeys).toHaveLength(1);
    const stored = window.sessionStorage.getItem(`storyframe.planning.pendingKey.${PROJECT_ID}`);
    expect(stored).toBeTruthy();

    // Reload the whole workspace: React state is gone, sessionStorage survives.
    cleanup();
    await openProject(backend);
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    expect(await screen.findByText("No proposals yet.")).toBeInTheDocument();
    // A reload checks that no live page still owns its retained lease first.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Generate proposal" }) as HTMLButtonElement).disabled).toBe(false),
    );

    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("Accept and save")).toBeInTheDocument();
    expect(backend.planningKeys).toHaveLength(2);
    expect(backend.planningKeys[1]).toBe(backend.planningKeys[0]);
    expect(JSON.parse(stored as string).key).toBe(backend.planningKeys[1]);

    fireEvent.click(screen.getByRole("button", { name: "Accept and save" }));
    expect(await screen.findByText(/Accepted\. The project is now version 2\./)).toBeInTheDocument();
    expect(screen.getByText("Accepted")).toBeInTheDocument();
    expect(backend.projects.get(PROJECT_ID)?.version).toBe(2);
    expect(window.sessionStorage.getItem(`storyframe.planning.pendingKey.${PROJECT_ID}`)).toBeNull();
  });

  it("keeps the draft and offers a reload when a save conflicts", async () => {
    const project = projectFixture();
    const backend = makeBackend(project);
    installBackend(backend);
    renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "Open The Late Letter" }));
    const topic = await screen.findByLabelText("Topic");

    // Another session saves first, so this draft's version is now stale.
    backend.projects.set(PROJECT_ID, { ...project, version: 2 });
    fireEvent.change(topic, { target: { value: "My unsaved draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("PROJECT_VERSION_CONFLICT")).toBeInTheDocument();
    expect(screen.getByLabelText("Topic")).toHaveValue("My unsaved draft");

    fireEvent.click(screen.getByRole("button", { name: "Load latest version" }));
    expect(await screen.findByText(/Loaded version 2/)).toBeInTheDocument();
    expect(screen.getByLabelText("Topic")).toHaveValue("A letter that arrives too late");
  });
});
