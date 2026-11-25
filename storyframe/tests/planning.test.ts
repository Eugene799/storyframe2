import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AiStatusResponse } from "../shared/ai-contract";
import type { GenerationProposalRecord } from "../shared/child-contract";
import type { PlanningPayload } from "../shared/planning-contract";
import type { ProjectDocumentV2, ProjectRecord } from "../shared/project-contract";
import { USER_A, USER_B, pendingUsageRow } from "./fake-supabase";
import { documentFixture, sceneFixture } from "./project-fixture";
import { apiRequest, startTestServer, type TestApp } from "./server-helpers";

// MOCKED: the provider is a local stub. Supabase is the local fake. The SQL
// migration behind the new columns is verified separately by `verify:sql`.

interface ProviderCall {
  model: string;
  prompt: string;
  numPredict: number;
}

/** Returns queued replies; the last reply repeats if the server asks again. */
function stubProvider(replies: string[]) {
  const calls: ProviderCall[] = [];
  let index = 0;
  const impl = vi.fn<typeof fetch>(async (input, init) => {
    if (!String(input).endsWith("/api/chat")) return new Response("not found", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      model?: string;
      messages?: { content?: string }[];
      options?: { num_predict?: number };
    };
    calls.push({
      model: body.model ?? "",
      prompt: body.messages?.[0]?.content ?? "",
      numPredict: body.options?.num_predict ?? 0,
    });
    const reply = replies[Math.min(index, replies.length - 1)] ?? "";
    index += 1;
    return new Response(
      JSON.stringify({ model: body.model ?? "gemma4:31b", message: { content: reply }, done: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  return { impl, calls };
}

async function createProject(
  appUrl: string,
  document: ProjectDocumentV2 = documentFixture(),
  projectType: "story" | "product-ad" | "repurpose" = "story",
  token: string = USER_A.token,
): Promise<string> {
  const response = await apiRequest(
    appUrl,
    "/api/projects",
    {
      method: "POST",
      body: JSON.stringify({ projectType, title: "Planning subject", document }),
    },
    token,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { project: { id: string } }).project.id;
}

function generate(
  appUrl: string,
  projectId: string,
  body: { route: string; instruction?: string; baseVersion: number },
  token: string = USER_A.token,
  idempotencyKey: string = randomUUID(),
) {
  return apiRequest(
    appUrl,
    `/api/projects/${projectId}/planning`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    },
    token,
  );
}

function planningStatus(appUrl: string, projectId: string, token: string = USER_A.token) {
  return apiRequest(appUrl, `/api/projects/${projectId}/planning/status`, {}, token);
}

function accept(appUrl: string, projectId: string, proposalId: string, token: string = USER_A.token) {
  return apiRequest(
    appUrl,
    `/api/projects/${projectId}/proposals/${proposalId}/accept`,
    { method: "POST", body: "{}" },
    token,
  );
}

function scriptReply(narration: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: "The courier opens the letter.",
    notes: ["Kept the letter as the through-line."],
    angles: [],
    clips: [],
    claims: [],
    scenes: [
      {
        heading: "INT. TRAIN CAR - NIGHT",
        narration,
        visualDirection: "Close on the envelope.",
        onScreenText: "",
        durationSeconds: 8,
      },
    ],
    ...extra,
  });
}

function twoSceneDocument(): ProjectDocumentV2 {
  return documentFixture({
    scenes: [
      sceneFixture({ id: "scene-1", heading: "INT. TRAIN CAR - NIGHT", body: "The letter waits." }),
      sceneFixture({ id: "scene-2", heading: "EXT. PLATFORM - DAWN", body: "She runs for the train." }),
    ],
  });
}

describe("Phase 5 planning", () => {
  it("generates validated JSON, records health, and applies it only on acceptance", async () => {
    const provider = stubProvider([scriptReply("The letter is opened at last.")]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const projectId = await createProject(app.url);
      const response = await generate(app.url, projectId, { route: "script", baseVersion: 1 });
      expect(response.status).toBe(201);
      const { proposal } = (await response.json()) as { proposal: GenerationProposalRecord };
      const payload = proposal.proposal as unknown as PlanningPayload;

      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].model).toBe("gemma4:31b");
      expect(provider.calls[0].numPredict).toBeGreaterThan(120);
      expect(provider.calls[0].prompt).toContain("A letter that arrives too late");
      expect(proposal).toMatchObject({ route: "script", baseVersion: 1, status: "proposed", modelId: "gemma" });
      expect(payload).toMatchObject({ route: "script", repairAttempted: false, insufficientEvidence: false });
      expect(payload.scenes).toHaveLength(1);

      // A generated proposal is not accepted content.
      const before = await apiRequest(app.url, `/api/projects/${projectId}`);
      expect(((await before.json()) as { project: ProjectRecord }).project.version).toBe(1);

      const accepted = await accept(app.url, projectId, proposal.id);
      expect(accepted.status).toBe(200);
      const acceptedBody = (await accepted.json()) as {
        proposal: GenerationProposalRecord;
        project: ProjectRecord;
        claimsRecorded: boolean;
      };
      expect(acceptedBody.claimsRecorded).toBe(true);
      expect(acceptedBody.proposal.status).toBe("accepted");
      expect(acceptedBody.project.version).toBe(2);
      expect(acceptedBody.project.document.scenes[0].body).toBe("The letter is opened at last.");

      const reopened = await apiRequest(app.url, `/api/projects/${projectId}`);
      const stored = ((await reopened.json()) as { project: ProjectRecord }).project;
      expect(stored.version).toBe(2);
      expect(stored.document.scenes[0].body).toBe("The letter is opened at last.");

      const second = await accept(app.url, projectId, proposal.id);
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ ok: false, error: { code: "PROPOSAL_NOT_PENDING" } });

      // Registry health is evidence, not a name-based claim.
      const status = (await (await fetch(`${app.url}/api/ai/status`)).json()) as AiStatusResponse;
      const gemma = status.planning.registry.find((entry) => entry.modelId === "gemma");
      expect(gemma?.lastSuccessAt).not.toBeNull();
      expect(status.planning.routes.find((route) => route.route === "script")).toMatchObject({
        modelId: "gemma",
        available: true,
      });
    } finally {
      await app.close();
    }
  });

  it("deletes pending proposals but never an accepted proposal", async () => {
    const provider = stubProvider([scriptReply("First draft."), scriptReply("Second draft.")]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const projectId = await createProject(app.url);
      const first = (await (
        await generate(app.url, projectId, { route: "script", baseVersion: 1 })
      ).json()) as { proposal: GenerationProposalRecord };

      const deleted = await apiRequest(
        app.url,
        `/api/projects/${projectId}/proposals/${first.proposal.id}`,
        { method: "DELETE" },
      );
      expect(deleted.status).toBe(200);
      const afterDelete = await apiRequest(app.url, `/api/projects/${projectId}/proposals`);
      expect(((await afterDelete.json()) as { proposals: unknown[] }).proposals).toHaveLength(0);

      const second = (await (
        await generate(app.url, projectId, { route: "script", baseVersion: 1 })
      ).json()) as { proposal: GenerationProposalRecord };
      expect((await accept(app.url, projectId, second.proposal.id)).status).toBe(200);

      const refused = await apiRequest(
        app.url,
        `/api/projects/${projectId}/proposals/${second.proposal.id}`,
        { method: "DELETE" },
      );
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ ok: false, error: { code: "PROPOSAL_ACCEPTED" } });
      const afterRefusal = await apiRequest(app.url, `/api/projects/${projectId}/proposals`);
      expect(((await afterRefusal.json()) as { proposals: unknown[] }).proposals).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("repairs invalid JSON once, then accepts the repaired reply", async () => {
    const provider = stubProvider(["Sure! Here is your plan.", scriptReply("Repaired wording.")]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const projectId = await createProject(app.url);
      const response = await generate(app.url, projectId, { route: "script", baseVersion: 1 });
      expect(response.status).toBe(201);
      const { proposal } = (await response.json()) as { proposal: GenerationProposalRecord };
      const payload = proposal.proposal as unknown as PlanningPayload;

      expect(provider.calls).toHaveLength(2);
      expect(provider.calls[1].prompt).toContain("rejected by validation");
      expect(payload.repairAttempted).toBe(true);
      expect(payload.scenes[0].narration).toBe("Repaired wording.");
    } finally {
      await app.close();
    }
  });

  it("refuses a reply that stays invalid after one repair, storing nothing", async () => {
    const invalid = JSON.stringify({
      summary: "S",
      notes: [],
      angles: [],
      clips: [],
      claims: [],
      scenes: [
        {
          heading: "H",
          narration: "N",
          visualDirection: "",
          onScreenText: "",
          durationSeconds: 0,
        },
      ],
    });
    const provider = stubProvider(["not json at all", invalid]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const projectId = await createProject(app.url);
      const response = await generate(app.url, projectId, { route: "script", baseVersion: 1 });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "PLANNING_INVALID_JSON" } });
      expect(provider.calls).toHaveLength(2);
      expect(app.supabase.proposals).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("rejects fields outside the contract, including invented media ids", async () => {
    const withAsset = scriptReply("Word.", {
      scenes: [
        {
          heading: "INT. TRAIN CAR - NIGHT",
          narration: "Word.",
          visualDirection: "",
          onScreenText: "",
          durationSeconds: 8,
          assetIds: ["11111111-1111-4111-8111-111111111111"],
        },
      ],
    });
    const provider = stubProvider([withAsset, withAsset]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const projectId = await createProject(app.url);
      const response = await generate(app.url, projectId, { route: "script", baseVersion: 1 });
      expect(response.status).toBe(422);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain("unexpected field");
      expect(app.supabase.proposals).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("keeps storyboard wording and order word for word", async () => {
    const document = twoSceneDocument();
    const storyboard = JSON.stringify({
      summary: "Two beats from the existing script.",
      notes: [],
      angles: [],
      clips: [],
      claims: [],
      scenes: document.scenes.map((scene, index) => ({
        heading: scene.heading,
        narration: scene.body,
        visualDirection: `Board ${index + 1}`,
        onScreenText: index === 0 ? "ONE LAST TRAIN" : "",
        durationSeconds: 10 + index,
      })),
    });
    const provider = stubProvider([storyboard]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const projectId = await createProject(app.url, document);
      const response = await generate(app.url, projectId, { route: "storyboard", baseVersion: 1 });
      expect(response.status).toBe(201);
      const { proposal } = (await response.json()) as { proposal: GenerationProposalRecord };
      const accepted = await accept(app.url, projectId, proposal.id);
      expect(accepted.status).toBe(200);
      const body = (await accepted.json()) as { project: ProjectRecord };

      expect(body.project.document.scenes.map((scene) => scene.body)).toEqual([
        "The letter waits.",
        "She runs for the train.",
      ]);
      expect(body.project.document.scenes.map((scene) => scene.visualDirection)).toEqual(["Board 1", "Board 2"]);
      expect(body.project.document.scenes.map((scene) => scene.durationSeconds)).toEqual([10, 11]);
      expect(body.project.document.scenes.map((scene) => scene.id)).toEqual(["scene-1", "scene-2"]);
    } finally {
      await app.close();
    }
  });

  it("refuses a storyboard that rewrites the script", async () => {
    const document = twoSceneDocument();
    const rewritten = JSON.stringify({
      summary: "Better wording, allegedly.",
      notes: [],
      angles: [],
      clips: [],
      claims: [],
      scenes: document.scenes.map((scene, index) => ({
        heading: scene.heading,
        narration: index === 0 ? "A reworded line." : scene.body,
        visualDirection: "Board",
        onScreenText: "",
        durationSeconds: 10,
      })),
    });
    const provider = stubProvider([rewritten, rewritten]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const projectId = await createProject(app.url, document);
      const response = await generate(app.url, projectId, { route: "storyboard", baseVersion: 1 });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "PLANNING_INVALID_JSON" } });
      expect(provider.calls).toHaveLength(2);
      expect(app.supabase.proposals).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("never replaces a locked component when a proposal is accepted", async () => {
    const document = documentFixture({
      scenes: [
        sceneFixture({
          id: "scene-1",
          body: "Locked line.",
          locks: { narration: true, visualDirection: false, onScreenText: false, duration: false },
        }),
      ],
    });
    const reply = JSON.stringify({
      summary: "Two beats.",
      notes: [],
      angles: [],
      clips: [],
      claims: [],
      scenes: [
        {
          heading: "INT. TRAIN CAR - NIGHT",
          narration: "The model rewrote the locked line.",
          visualDirection: "New visual.",
          onScreenText: "",
          durationSeconds: 9,
        },
        {
          heading: "EXT. PLATFORM - DAWN",
          narration: "A second beat.",
          visualDirection: "Platform.",
          onScreenText: "",
          durationSeconds: 6,
        },
      ],
    });
    const provider = stubProvider([reply]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const projectId = await createProject(app.url, document);
      const response = await generate(app.url, projectId, { route: "script", baseVersion: 1 });
      const { proposal } = (await response.json()) as { proposal: GenerationProposalRecord };
      const accepted = await accept(app.url, projectId, proposal.id);
      expect(accepted.status).toBe(200);
      const body = (await accepted.json()) as { project: ProjectRecord };

      expect(body.project.document.scenes[0].body).toBe("Locked line.");
      expect(body.project.document.scenes[0].visualDirection).toBe("New visual.");
      expect(body.project.document.scenes).toHaveLength(2);
      expect(body.project.document.scenes[1].body).toBe("A second beat.");
      expect(body.project.document.scenes[1].locks.narration).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("returns planning notes instead of a sourced script when factual evidence is missing", async () => {
    const provider = stubProvider([scriptReply("Should never be requested.")]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const document = documentFixture({ brief: { ...documentFixture().brief, mode: "factual" } });
      const projectId = await createProject(app.url, document);
      const response = await generate(app.url, projectId, { route: "script", baseVersion: 1 });
      expect(response.status).toBe(201);
      const { proposal } = (await response.json()) as { proposal: GenerationProposalRecord };
      const payload = proposal.proposal as unknown as PlanningPayload;

      expect(provider.calls).toHaveLength(0);
      expect(payload.insufficientEvidence).toBe(true);
      expect(payload.scenes).toHaveLength(0);
      expect(payload.notes.length).toBeGreaterThan(0);
      expect(proposal.prompt).toContain("No provider call");

      const accepted = await accept(app.url, projectId, proposal.id);
      expect(accepted.status).toBe(200);
      const body = (await accepted.json()) as { project: ProjectRecord };
      expect(body.project.version).toBe(1);
      expect(body.project.document.scenes[0].body).toBe("The letter waits under a seat, addressed to nobody.");
    } finally {
      await app.close();
    }
  });

  it("maps claims to source ids and verbatim excerpts, flagging unquoted claims", async () => {
    // The source id only exists after it is created, so the reply is built from
    // the source line the server put in the prompt.
    const impl = vi.fn<typeof fetch>(async (input, init) => {
      if (!String(input).endsWith("/api/chat")) return new Response("not found", { status: 404 });
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        model?: string;
        messages?: { content?: string }[];
      };
      const prompt = body.messages?.[0]?.content ?? "";
      const sourceId = /\[source ([0-9a-f-]{36})\]/.exec(prompt)?.[1] ?? "";
      const reply = scriptReply("The city moved more people.", {
        claims: [
          { sourceId, statement: "Ridership rose 12 percent.", quote: "ridership rose 12 percent" },
          { sourceId, statement: "The agency plans to expand service.", quote: "" },
        ],
      });
      return new Response(
        JSON.stringify({ model: "gemma4:31b", message: { content: reply }, done: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const app = await startTestServer({ fetchImpl: impl });
    try {
      const document = documentFixture({ brief: { ...documentFixture().brief, mode: "factual" } });
      const projectId = await createProject(app.url, document);
      const sourceResponse = await apiRequest(app.url, `/api/projects/${projectId}/sources`, {
        method: "POST",
        body: JSON.stringify({
          kind: "web",
          title: "Ridership report",
          url: "https://example.com/report",
          excerpt: "City ridership rose 12 percent in 2025.",
        }),
      });
      expect(sourceResponse.status).toBe(201);
      const source = ((await sourceResponse.json()) as { source: { id: string } }).source;

      const generated = await generate(app.url, projectId, { route: "script", baseVersion: 1 });
      expect(generated.status).toBe(201);
      const { proposal } = (await generated.json()) as { proposal: GenerationProposalRecord };
      const payload = proposal.proposal as unknown as PlanningPayload;
      expect(payload.claims).toHaveLength(2);
      expect(payload.claims[0]).toMatchObject({
        sourceId: source.id,
        supported: true,
        quote: "ridership rose 12 percent",
      });
      expect(payload.claims[1]).toMatchObject({ sourceId: source.id, supported: false, quote: "" });

      const accepted = await accept(app.url, projectId, proposal.id);
      expect(accepted.status).toBe(200);
      const body = (await accepted.json()) as { claimsRecorded: boolean };
      expect(body.claimsRecorded).toBe(true);
      expect(app.supabase.claims).toHaveLength(2);
      expect(app.supabase.claims[0]).toMatchObject({
        source_id: source.id,
        status: "supported",
        supporting_quote: "ridership rose 12 percent",
      });
      expect(app.supabase.claims[1]).toMatchObject({ status: "unverified", supporting_quote: null });

      // A claim is only evidence while its source exists: deleting the source
      // removes the claims that cite it instead of leaving supported orphans.
      const deleted = await apiRequest(app.url, `/api/projects/${projectId}/sources/${source.id}`, {
        method: "DELETE",
      });
      expect(deleted.status).toBe(200);
      expect(app.supabase.claims).toHaveLength(0);
      expect(app.supabase.sources).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("rejects a stale proposal after the project changes", async () => {
    const provider = stubProvider([scriptReply("First attempt wording.")]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const projectId = await createProject(app.url);
      const generated = await generate(app.url, projectId, { route: "script", baseVersion: 1 });
      const { proposal } = (await generated.json()) as { proposal: GenerationProposalRecord };

      const saved = await apiRequest(app.url, `/api/projects/${projectId}`, {
        method: "PUT",
        body: JSON.stringify({
          title: "Planning subject (renamed)",
          document: documentFixture(),
          version: 1,
        }),
      });
      expect(saved.status).toBe(200);

      const response = await accept(app.url, projectId, proposal.id);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "PROPOSAL_STALE" } });

      const after = await apiRequest(app.url, `/api/projects/${projectId}`);
      const stored = ((await after.json()) as { project: ProjectRecord }).project;
      expect(stored.version).toBe(2);
      expect(stored.document.scenes[0].body).toBe("The letter waits under a seat, addressed to nobody.");
    } finally {
      await app.close();
    }
  });

  it("reports an unavailable route instead of guessing a model", async () => {
    const provider = stubProvider([scriptReply("unused")]);
    const app = await startTestServer({
      fetchImpl: provider.impl,
      env: { AI_ROUTE_SCRIPT: "not-a-registered-model" },
    });
    try {
      const projectId = await createProject(app.url);
      const response = await generate(app.url, projectId, { route: "script", baseVersion: 1 });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "PLANNING_ROUTE_UNAVAILABLE" } });
      expect(provider.calls).toHaveLength(0);

      const status = (await (await fetch(`${app.url}/api/ai/status`)).json()) as AiStatusResponse;
      const script = status.planning.routes.find((route) => route.route === "script");
      expect(script?.available).toBe(false);
      expect(script?.reason).toMatch(/without planning metadata/);
    } finally {
      await app.close();
    }
  });

  it("turns transcript clips into scene drafts with the quoted words", async () => {
    const transcript = "We rebuilt the whole engine in a weekend. It shipped on Monday.";
    const reply = JSON.stringify({
      summary: "One usable clip.",
      notes: [],
      angles: [],
      scenes: [],
      claims: [],
      clips: [
        {
          startSeconds: 2,
          endSeconds: 12,
          quote: "We rebuilt the whole engine in a weekend.",
          heading: "Engine rebuild",
          rationale: "Concrete and specific.",
        },
      ],
    });
    const provider = stubProvider([reply]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const document = documentFixture({ scenes: [] });
      const projectId = await createProject(app.url, document, "repurpose");
      const created = await apiRequest(app.url, `/api/projects/${projectId}/sources`, {
        method: "POST",
        body: JSON.stringify({ kind: "interview", title: "Founder interview", excerpt: transcript }),
      });
      expect(created.status).toBe(201);

      const generated = await generate(app.url, projectId, { route: "transcript-analysis", baseVersion: 1 });
      expect(generated.status).toBe(201);
      const { proposal } = (await generated.json()) as { proposal: GenerationProposalRecord };
      const accepted = await accept(app.url, projectId, proposal.id);
      expect(accepted.status).toBe(200);
      const body = (await accepted.json()) as { project: ProjectRecord };

      expect(body.project.document.scenes).toHaveLength(1);
      expect(body.project.document.scenes[0]).toMatchObject({
        heading: "Engine rebuild",
        body: "We rebuilt the whole engine in a weekend.",
        durationSeconds: 10,
        onScreenText: "",
        assetIds: [],
      });
    } finally {
      await app.close();
    }
  });

  it("refuses a clip that is not quoted from the supplied transcript", async () => {
    const reply = JSON.stringify({
      summary: "Invented quote.",
      notes: [],
      angles: [],
      scenes: [],
      claims: [],
      clips: [
        {
          startSeconds: 0,
          endSeconds: 8,
          quote: "We rebuilt it in a day.",
          heading: "Invented",
          rationale: "Not in the transcript.",
        },
      ],
    });
    const provider = stubProvider([reply, reply]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const projectId = await createProject(app.url, documentFixture({ scenes: [] }), "repurpose");
      await apiRequest(app.url, `/api/projects/${projectId}/sources`, {
        method: "POST",
        body: JSON.stringify({ kind: "interview", title: "Founder interview", excerpt: "We rebuilt it in a weekend." }),
      });
      const response = await generate(app.url, projectId, { route: "transcript-analysis", baseVersion: 1 });
      expect(response.status).toBe(422);
      expect(app.supabase.proposals).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("preflights an owner-scoped in-flight attempt and blocks another key", async () => {
    const provider = stubProvider([scriptReply("Should not run.")]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const projectId = await createProject(app.url);
      const pendingKey = "other-device-key-12345678";
      app.supabase.usage.push(
        pendingUsageRow({
          userId: USER_A.id,
          projectId,
          idempotencyKey: pendingKey,
          requestHash: "pending-request-hash",
          createdAt: new Date().toISOString(),
        }),
      );

      const status = await planningStatus(app.url, projectId);
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({
        ok: true,
        inFlight: true,
        idempotencyKey: pendingKey,
        abandonAfterMs: 90_000,
      });

      const foreignStatus = await planningStatus(app.url, projectId, USER_B.token);
      expect(foreignStatus.status).toBe(404);

      const blocked = await generate(
        app.url,
        projectId,
        { route: "script", baseVersion: 1 },
        USER_A.token,
        "new-device-key-12345678",
      );
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({
        ok: false,
        error: { code: "PLANNING_ATTEMPT_IN_FLIGHT" },
      });
      expect(provider.calls).toHaveLength(0);
      expect(app.supabase.usage).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("maps a preflight-bypassing reservation race to the in-flight 409", async () => {
    const provider = stubProvider([scriptReply("Should not run.")]);
    const app = await startTestServer({
      fetchImpl: provider.impl,
      supabase: { hideNextPendingProjectAttempt: true },
    });
    try {
      const projectId = await createProject(app.url);
      app.supabase.usage.push(
        pendingUsageRow({
          userId: USER_A.id,
          projectId,
          idempotencyKey: "race-winner-key-12345678",
          requestHash: "race-winner-hash",
          createdAt: new Date().toISOString(),
        }),
      );

      // The first pending read (the preflight) is hidden, so only the unique
      // index rejects this second key; the route must still map it to the 409.
      const blocked = await generate(
        app.url,
        projectId,
        { route: "script", baseVersion: 1 },
        USER_A.token,
        "race-loser-key-12345678",
      );
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({
        ok: false,
        error: { code: "PLANNING_ATTEMPT_IN_FLIGHT" },
      });
      expect(provider.calls).toHaveLength(0);
      expect(app.supabase.usage).toHaveLength(1);
      expect(app.supabase.usage[0].idempotency_key).toBe("race-winner-key-12345678");
    } finally {
      await app.close();
    }
  });

  it("does not abandon a pending attempt while a repair could still be running", async () => {
    const provider = stubProvider([scriptReply("Should not run.")]);
    const app = await startTestServer({
      fetchImpl: provider.impl,
      env: {
        AI_TIMEOUT_MS: "60000",
        AUTH_TIMEOUT_MS: "5000",
        AI_ABANDON_AFTER_MS: "90000",
      },
    });
    try {
      const projectId = await createProject(app.url);
      const pendingKey = "repair-window-key-12345678";
      app.supabase.usage.push(
        pendingUsageRow({
          userId: USER_A.id,
          projectId,
          idempotencyKey: pendingKey,
          requestHash: "repair-window-hash",
          // Older than one provider call plus overhead, younger than two calls.
          createdAt: new Date(Date.now() - 100_000).toISOString(),
        }),
      );

      const status = await planningStatus(app.url, projectId);
      expect(await status.json()).toMatchObject({
        ok: true,
        inFlight: true,
        idempotencyKey: pendingKey,
        abandonAfterMs: 135_000,
      });

      const blocked = await generate(
        app.url,
        projectId,
        { route: "script", baseVersion: 1 },
        USER_A.token,
        "repair-window-new-key-12345678",
      );
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({
        ok: false,
        error: { code: "PLANNING_ATTEMPT_IN_FLIGHT" },
      });
      expect(provider.calls).toHaveLength(0);
      expect(app.supabase.usage[0]).toMatchObject({ status: "pending", error_code: null });
    } finally {
      await app.close();
    }
  });

  it("keeps a same-key retry in progress while a repair could still be running", async () => {
    const provider = stubProvider([scriptReply("First reply.")]);
    const app = await startTestServer({
      fetchImpl: provider.impl,
      env: {
        AI_TIMEOUT_MS: "60000",
        AUTH_TIMEOUT_MS: "5000",
        AI_ABANDON_AFTER_MS: "90000",
      },
    });
    try {
      const projectId = await createProject(app.url);
      const idempotencyKey = "repair-window-same-key-12345678";
      const first = await generate(
        app.url,
        projectId,
        { route: "script", baseVersion: 1 },
        USER_A.token,
        idempotencyKey,
      );
      expect(first.status).toBe(201);
      expect(provider.calls).toHaveLength(1);

      // Make the stored attempt look 100 seconds old: past the single-call
      // window, still inside the two-call planning window.
      const row = app.supabase.usage[0];
      row.status = "pending";
      row.created_at = new Date(Date.now() - 100_000).toISOString();
      row.response_body = null;
      row.response_status = null;

      const replay = await generate(
        app.url,
        projectId,
        { route: "script", baseVersion: 1 },
        USER_A.token,
        idempotencyKey,
      );
      expect(replay.status).toBe(409);
      expect(await replay.json()).toMatchObject({
        ok: false,
        error: { code: "IDEMPOTENCY_IN_PROGRESS" },
      });
      expect(provider.calls).toHaveLength(1);
      expect(app.supabase.usage[0]).toMatchObject({ status: "pending", error_code: null });
    } finally {
      await app.close();
    }
  });

  it("settles a stale project attempt before reserving a new key", async () => {
    const provider = stubProvider([scriptReply("After the stale attempt.")]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const projectId = await createProject(app.url);
      const staleKey = "stale-device-key-12345678";
      app.supabase.usage.push(
        pendingUsageRow({
          userId: USER_A.id,
          projectId,
          idempotencyKey: staleKey,
          requestHash: "stale-request-hash",
          createdAt: new Date(Date.now() - 120_000).toISOString(),
        }),
      );

      const status = await planningStatus(app.url, projectId);
      expect(await status.json()).toMatchObject({ inFlight: false, idempotencyKey: null });

      const response = await generate(
        app.url,
        projectId,
        { route: "script", baseVersion: 1 },
        USER_A.token,
        "fresh-device-key-12345678",
      );
      expect(response.status).toBe(201);
      expect(provider.calls).toHaveLength(1);

      const stale = app.supabase.usage.find((row) => row.idempotency_key === staleKey);
      expect(stale).toMatchObject({ status: "error", error_code: "REQUEST_ABANDONED" });
      const fresh = app.supabase.usage.find((row) => row.idempotency_key === "fresh-device-key-12345678");
      expect(fresh).toMatchObject({ status: "success", project_id: projectId });
    } finally {
      await app.close();
    }
  });

  it("scopes an idempotency key to its project", async () => {
    const provider = stubProvider([scriptReply("Project-scoped.")]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      // Identical documents and requests: only the project differs.
      const projectA = await createProject(app.url);
      const projectB = await createProject(app.url);
      const key = randomUUID();

      const first = await generate(app.url, projectA, { route: "script", baseVersion: 1 }, USER_A.token, key);
      expect(first.status).toBe(201);

      const second = await generate(app.url, projectB, { route: "script", baseVersion: 1 }, USER_A.token, key);
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_KEY_REUSED" } });
      expect(provider.calls).toHaveLength(1);
      expect(app.supabase.proposals).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("requires an Idempotency-Key before contacting the provider", async () => {
    const provider = stubProvider([scriptReply("Unused.")]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const projectId = await createProject(app.url);
      const response = await apiRequest(app.url, `/api/projects/${projectId}/planning`, {
        method: "POST",
        body: JSON.stringify({ route: "script", baseVersion: 1 }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
      expect(provider.calls).toHaveLength(0);
      expect(app.supabase.usage).toHaveLength(0);
      expect(app.supabase.proposals).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("records the attempt in the ledger and replays it for the same key", async () => {
    const provider = stubProvider([scriptReply("Metered wording.")]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const projectId = await createProject(app.url);
      const key = randomUUID();
      const first = await generate(app.url, projectId, { route: "script", baseVersion: 1 }, USER_A.token, key);
      expect(first.status).toBe(201);
      const firstProposal = ((await first.json()) as { proposal: GenerationProposalRecord }).proposal;

      const replay = await generate(app.url, projectId, { route: "script", baseVersion: 1 }, USER_A.token, key);
      expect(replay.status).toBe(201);
      const replayed = ((await replay.json()) as { proposal: GenerationProposalRecord }).proposal;

      expect(replayed.id).toBe(firstProposal.id);
      expect(provider.calls).toHaveLength(1);
      expect(app.supabase.proposals).toHaveLength(1);
      expect(app.supabase.usage).toHaveLength(1);
      expect(app.supabase.usage[0]).toMatchObject({
        model_id: "gemma",
        configured_model: "gemma4:31b",
        status: "success",
        response_status: 201,
        idempotency_key: key,
      });
      expect((app.supabase.usage[0].response_body as { proposal: { id: string } }).proposal.id).toBe(
        firstProposal.id,
      );
    } finally {
      await app.close();
    }
  });

  it("refuses to reuse a key for a different request", async () => {
    const provider = stubProvider([scriptReply("First request.")]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const projectId = await createProject(app.url);
      const key = randomUUID();
      const first = await generate(
        app.url,
        projectId,
        { route: "script", instruction: "First instruction", baseVersion: 1 },
        USER_A.token,
        key,
      );
      expect(first.status).toBe(201);

      const reused = await generate(
        app.url,
        projectId,
        { route: "script", instruction: "A different instruction", baseVersion: 1 },
        USER_A.token,
        key,
      );
      expect(reused.status).toBe(409);
      expect(await reused.json()).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_KEY_REUSED" } });
      expect(provider.calls).toHaveLength(1);
      expect(app.supabase.proposals).toHaveLength(1);
      expect(app.supabase.usage).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("records a refused reply and replays the refusal without calling again", async () => {
    const invalid = JSON.stringify({ summary: "Still not a planning payload." });
    const provider = stubProvider([invalid, invalid]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const projectId = await createProject(app.url);
      const key = randomUUID();
      const first = await generate(app.url, projectId, { route: "script", baseVersion: 1 }, USER_A.token, key);
      expect(first.status).toBe(422);
      expect(provider.calls).toHaveLength(2);
      expect(app.supabase.usage).toHaveLength(1);
      expect(app.supabase.usage[0]).toMatchObject({
        status: "error",
        error_code: "PLANNING_INVALID_JSON",
        response_status: 422,
      });

      const replay = await generate(app.url, projectId, { route: "script", baseVersion: 1 }, USER_A.token, key);
      expect(replay.status).toBe(422);
      expect(await replay.json()).toMatchObject({ ok: false, error: { code: "PLANNING_INVALID_JSON" } });
      expect(provider.calls).toHaveLength(2);
      expect(app.supabase.proposals).toHaveLength(0);
      expect(app.supabase.usage).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("scopes a key to its verified account", async () => {
    const provider = stubProvider([scriptReply("Account-scoped.")]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const key = randomUUID();
      const projectA = await createProject(app.url);
      const projectB = await createProject(app.url, documentFixture(), "story", USER_B.token);

      const aFirst = await generate(app.url, projectA, { route: "script", baseVersion: 1 }, USER_A.token, key);
      expect(aFirst.status).toBe(201);
      const proposalA = ((await aFirst.json()) as { proposal: GenerationProposalRecord }).proposal;

      // The same key is a different attempt for another account.
      const bFirst = await generate(app.url, projectB, { route: "script", baseVersion: 1 }, USER_B.token, key);
      expect(bFirst.status).toBe(201);
      const proposalB = ((await bFirst.json()) as { proposal: GenerationProposalRecord }).proposal;
      expect(proposalB.id).not.toBe(proposalA.id);
      expect(provider.calls).toHaveLength(2);
      expect(app.supabase.usage).toHaveLength(2);

      const bReplay = await generate(app.url, projectB, { route: "script", baseVersion: 1 }, USER_B.token, key);
      expect(bReplay.status).toBe(201);
      expect(((await bReplay.json()) as { proposal: GenerationProposalRecord }).proposal.id).toBe(proposalB.id);

      const aReplay = await generate(app.url, projectA, { route: "script", baseVersion: 1 }, USER_A.token, key);
      expect(aReplay.status).toBe(201);
      expect(((await aReplay.json()) as { proposal: GenerationProposalRecord }).proposal.id).toBe(proposalA.id);
      expect(provider.calls).toHaveLength(2);
      expect(app.supabase.proposals).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("keeps planning private and refuses a hand-recorded proposal", async () => {
    const provider = stubProvider([scriptReply("Scoped.")]);
    const app = await startTestServer({ fetchImpl: provider.impl });
    try {
      const projectId = await createProject(app.url);
      const foreign = await generate(app.url, projectId, { route: "script", baseVersion: 1 }, USER_B.token);
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toMatchObject({ ok: false, error: { code: "PROJECT_NOT_FOUND" } });
      expect(provider.calls).toHaveLength(0);

      const generated = await generate(app.url, projectId, { route: "script", baseVersion: 1 });
      const { proposal } = (await generated.json()) as { proposal: GenerationProposalRecord };
      const foreignAccept = await accept(app.url, projectId, proposal.id, USER_B.token);
      expect(foreignAccept.status).toBe(404);

      const manual = await apiRequest(app.url, `/api/projects/${projectId}/proposals`, {
        method: "POST",
        body: JSON.stringify({ modelId: "gemma", prompt: "Hand recorded", proposal: { scenes: [] } }),
      });
      expect(manual.status).toBe(201);
      const manualProposal = ((await manual.json()) as { proposal: GenerationProposalRecord }).proposal;
      expect(manualProposal.route).toBe("legacy");
      const manualAccept = await accept(app.url, projectId, manualProposal.id);
      expect(manualAccept.status).toBe(409);
      expect(await manualAccept.json()).toMatchObject({ ok: false, error: { code: "PROPOSAL_NOT_APPLICABLE" } });
    } finally {
      await app.close();
    }
  });
});
