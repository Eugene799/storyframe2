// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BroadcastChannel as NodeBroadcastChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationProposalRecord } from "../shared/child-contract";
import type { PlanningPayload } from "../shared/planning-contract";
import type { ProjectRecord } from "../shared/project-contract";
import { PlanningPanel } from "../src/workspace/PlanningPanel";
import { documentFixture, sceneFixture } from "./project-fixture";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_B_ID = "33333333-3333-4333-8333-333333333333";
const PROPOSAL_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-11-25T12:00:00.000Z";

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => payload,
  } as unknown as Response;
}

function projectFixture(version = 1): ProjectRecord {
  return {
    id: PROJECT_ID,
    projectType: "story",
    title: "Planning subject",
    schemaVersion: 2,
    document: documentFixture(),
    version,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function proposalFixture(status: GenerationProposalRecord["status"] = "proposed"): GenerationProposalRecord {
  const payload: PlanningPayload = {
    summary: "One beat from the saved script.",
    notes: ["Kept the letter as the through-line."],
    angles: [],
    scenes: [
      {
        heading: "INT. TRAIN CAR - NIGHT",
        narration: "The letter is opened.",
        visualDirection: "Close on the envelope.",
        onScreenText: "",
        durationSeconds: 8,
      },
    ],
    clips: [],
    claims: [],
    route: "script",
    insufficientEvidence: false,
    repairAttempted: false,
  };
  return {
    id: PROPOSAL_ID,
    sceneKey: null,
    route: "script",
    baseVersion: 1,
    modelId: "gemma",
    prompt: "planning prompt",
    proposal: payload as unknown as Record<string, unknown>,
    status,
    createdAt: NOW,
  };
}

function storedLease(projectId = PROJECT_ID): { tabId: string; expiresAt: number } | null {
  const raw = window.localStorage.getItem(`storyframe.planning.lock.${projectId}`);
  return raw ? (JSON.parse(raw) as { tabId: string; expiresAt: number }) : null;
}

/** A planning-status response held open until the test chooses to resolve it. */
function deferredPreflight() {
  let resolveStatus: ((response: Response) => void) | undefined;
  let requested = false;
  return {
    handle(): Promise<Response> {
      requested = true;
      return new Promise<Response>((resolve) => {
        resolveStatus = resolve;
      });
    },
    resolve(idempotencyKey: string): void {
      resolveStatus?.(
        jsonResponse({
          ok: true,
          inFlight: true,
          idempotencyKey,
          startedAt: new Date().toISOString(),
          abandonAfterMs: 60_000,
        }),
      );
    },
    get requested(): boolean {
      return requested;
    },
  };
}

function anglesProposalFixture(): GenerationProposalRecord {
  const base = proposalFixture();
  return {
    ...base,
    route: "angles",
    proposal: {
      ...base.proposal,
      route: "angles",
      angles: [
        { title: "The missed connection", hook: "A letter arrives too late.", rationale: "Immediate stakes." },
      ],
      scenes: [],
    },
  };
}

function installBackend() {
  const requests: { method: string; path: string; body: unknown; key: string | null }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    requests.push({ method, path, body, key: new Headers(init?.headers).get("Idempotency-Key") });

    if (path === `/api/projects/${PROJECT_ID}/proposals` && method === "GET") {
      return jsonResponse({ ok: true, proposals: [] });
    }
    if (path === `/api/projects/${PROJECT_ID}/planning/status` && method === "GET") {
      return jsonResponse({
        ok: true,
        inFlight: false,
        idempotencyKey: null,
        startedAt: null,
        abandonAfterMs: 90_000,
      });
    }
    if (path === `/api/projects/${PROJECT_ID}/planning` && method === "POST") {
      return jsonResponse({ ok: true, proposal: proposalFixture() }, 201);
    }
    if (path === `/api/projects/${PROJECT_ID}/proposals/${PROPOSAL_ID}` && method === "DELETE") {
      return jsonResponse({ ok: true, deletedId: PROPOSAL_ID });
    }
    if (path === `/api/projects/${PROJECT_ID}/proposals/${PROPOSAL_ID}/accept` && method === "POST") {
      const project = projectFixture(2);
      project.document.scenes[0].body = "The letter is opened.";
      return jsonResponse({
        ok: true,
        proposal: proposalFixture("accepted"),
        project,
        claimsRecorded: true,
      });
    }
    return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("PlanningPanel", () => {
  it("generates, reviews, and accepts a proposal without applying it first", async () => {
    const backend = installBackend();
    const onAccepted = vi.fn();
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={onAccepted}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "script" } });
    fireEvent.change(document.getElementById("planning-instruction") as HTMLTextAreaElement, {
      target: { value: "Keep it under ten seconds." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));

    expect(await screen.findByText("Accept and save")).toBeTruthy();
    expect(screen.getByText("One beat from the saved script.")).toBeTruthy();
    expect(screen.getByText("The letter is opened.")).toBeTruthy();
    expect(screen.getByText("Proposed · v1 · gemma")).toBeTruthy();

    const generate = backend.requests.find((request) => request.path.endsWith("/planning"));
    expect(generate?.body).toEqual({
      route: "script",
      instruction: "Keep it under ten seconds.",
      baseVersion: 1,
    });
    // Generating alone does not apply anything.
    expect(onAccepted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Accept and save" }));

    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(onAccepted.mock.calls[0][0].version).toBe(2);
    expect(await screen.findByText(/Accepted\. The project is now version 2\./)).toBeTruthy();
    expect(screen.getByText("Accepted")).toBeTruthy();
  });

  it.each([
    ["IDEMPOTENCY_IN_PROGRESS", 409],
    ["LEDGER_UNAVAILABLE", 503],
  ])("keeps the Idempotency-Key after %s so Retry can replay", async (code, status) => {
    const keys: (string | null)[] = [];
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        const headers = new Headers(init?.headers);
        if (path.endsWith("/proposals")) return jsonResponse({ ok: true, proposals: [] });
        if (path.endsWith("/planning")) {
          keys.push(headers.get("Idempotency-Key"));
          attempts += 1;
          if (attempts === 1) {
            return jsonResponse({ ok: false, error: { code, message: "The attempt is not settled yet." } }, status);
          }
          return jsonResponse({ ok: true, proposal: proposalFixture() }, 201);
        }
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText(code)).toBeTruthy();
    expect(keys[0]).toBeTruthy();
    // The outcome is unknown, so another tab must stay locked out.
    expect(storedLease()).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("Accept and save")).toBeTruthy();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(storedLease()).toBeNull();
  });

  it("persists the pending key across a reload so Retry still replays", async () => {
    const keys: (string | null)[] = [];
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path.endsWith("/proposals")) return jsonResponse({ ok: true, proposals: [] });
        if (path.endsWith("/planning")) {
          keys.push(new Headers(init?.headers).get("Idempotency-Key"));
          attempts += 1;
          if (attempts === 1) {
            return jsonResponse(
              { ok: false, error: { code: "IDEMPOTENCY_IN_PROGRESS", message: "Still running." } },
              409,
            );
          }
          return jsonResponse({ ok: true, proposal: proposalFixture() }, 201);
        }
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );

    const first = render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );
    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("IDEMPOTENCY_IN_PROGRESS")).toBeTruthy();
    expect(keys[0]).toBeTruthy();

    // A reload destroys component state; the stored key must survive it.
    first.unmount();
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );
    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    // The leased tab checks whether a live duplicate still owns its id first.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Generate proposal" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("Accept and save")).toBeTruthy();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(window.sessionStorage.getItem(`storyframe.planning.pendingKey.${PROJECT_ID}`)).toBeNull();
  });

  it("starts a fresh key after a recorded refusal", async () => {
    const keys: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path.endsWith("/proposals")) return jsonResponse({ ok: true, proposals: [] });
        if (path.endsWith("/planning")) {
          keys.push(new Headers(init?.headers).get("Idempotency-Key"));
          if (keys.length === 1) {
            return jsonResponse(
              { ok: false, error: { code: "PLANNING_INVALID_JSON", message: "Refused after one repair." } },
              422,
            );
          }
          return jsonResponse({ ok: true, proposal: proposalFixture() }, 201);
        }
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("PLANNING_INVALID_JSON")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("Accept and save")).toBeTruthy();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("starts a new key when the request changes after an unsettled attempt", async () => {
    const keys: (string | null)[] = [];
    const bodies: { instruction?: string }[] = [];
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path.endsWith("/proposals")) return jsonResponse({ ok: true, proposals: [] });
        if (path.endsWith("/planning")) {
          keys.push(new Headers(init?.headers).get("Idempotency-Key"));
          bodies.push(JSON.parse(String(init?.body ?? "{}")) as { instruction?: string });
          attempts += 1;
          if (attempts === 1) {
            return jsonResponse(
              { ok: false, error: { code: "IDEMPOTENCY_IN_PROGRESS", message: "Still running." } },
              409,
            );
          }
          return jsonResponse({ ok: true, proposal: proposalFixture() }, 201);
        }
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("IDEMPOTENCY_IN_PROGRESS")).toBeTruthy();

    fireEvent.change(document.getElementById("planning-instruction") as HTMLTextAreaElement, {
      target: { value: "A different request" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("Accept and save")).toBeTruthy();

    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect(bodies[1].instruction).toBe("A different request");
  });

  it("does not duplicate a proposal already listed after a reload", async () => {
    const proposal = proposalFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path.endsWith("/proposals")) return jsonResponse({ ok: true, proposals: [proposal] });
        if (path.endsWith("/planning")) return jsonResponse({ ok: true, proposal }, 201);
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("Proposed · v1 · gemma")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("Accept and save")).toBeTruthy();
    expect(screen.getAllByText("Proposed · v1 · gemma")).toHaveLength(1);
  });

  it("records attempt history and restores it after a reload", async () => {
    installBackend();
    const first = render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("Accept and save")).toBeTruthy();
    expect(screen.getByText(/Succeeded/)).toBeTruthy();

    // History is local to the browser, so it survives the panel unmounting.
    first.unmount();
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );
    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    expect(screen.getByText(/Succeeded/)).toBeTruthy();
  });

  it("stops waiting without losing the key or treating it as a failed attempt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path.endsWith("/proposals")) return jsonResponse({ ok: true, proposals: [] });
        if (path.endsWith("/planning")) {
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) {
              reject(new DOMException("Aborted", "AbortError"));
              return;
            }
            signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          });
        }
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop waiting" }));

    expect(await screen.findByText(/Stopped waiting/)).toBeTruthy();
    expect(window.sessionStorage.getItem(`storyframe.planning.pendingKey.${PROJECT_ID}`)).not.toBeNull();
    expect(screen.getAllByText(/Stopped/).length).toBeGreaterThanOrEqual(2);
    const lease = storedLease();
    expect(lease).not.toBeNull();
    expect(lease?.tabId).toBe(window.sessionStorage.getItem("storyframe.planning.tabId"));
    expect(lease?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("keeps the project lease on unmount while the outcome is unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path.endsWith("/proposals")) return jsonResponse({ ok: true, proposals: [] });
        if (path.endsWith("/planning")) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          });
        }
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );
    const view = render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    await screen.findByRole("button", { name: "Stop waiting" });
    view.unmount();

    await waitFor(() => expect(storedLease()).not.toBeNull());
    expect(storedLease()?.expiresAt).toBeGreaterThan(Date.now());

    // A remount reads the same tab id and unsettled key, so unmounting again
    // still must not free the lease before it expires.
    const second = render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );
    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    second.unmount();
    await waitFor(() => expect(storedLease()).not.toBeNull());
  });

  it("keeps the project lease after a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path.endsWith("/proposals")) return jsonResponse({ ok: true, proposals: [] });
        if (path.endsWith("/planning")) throw new TypeError("network down");
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("NETWORK_ERROR")).toBeTruthy();
    expect(storedLease()).not.toBeNull();
    expect(window.sessionStorage.getItem(`storyframe.planning.pendingKey.${PROJECT_ID}`)).not.toBeNull();
  });

  it("disables generation while another tab holds the project lease", async () => {
    window.localStorage.setItem(
      `storyframe.planning.lock.${PROJECT_ID}`,
      JSON.stringify({ tabId: "other-tab", expiresAt: Date.now() + 60_000 }),
    );
    installBackend();
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Generate proposal" }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect(screen.getByText(/Another tab is generating a proposal/)).toBeTruthy();
  });

  it("ignores a preflight that resolves after the project changes", async () => {
    const preflight = deferredPreflight();
    let planningCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === `/api/projects/${PROJECT_ID}/proposals` || path === `/api/projects/${PROJECT_B_ID}/proposals`) {
          return jsonResponse({ ok: true, proposals: [] });
        }
        if (path === `/api/projects/${PROJECT_ID}/planning/status`) return preflight.handle();
        if (path.endsWith("/planning") && init?.method === "POST") {
          planningCalls += 1;
          return jsonResponse({ ok: true, proposal: proposalFixture() }, 201);
        }
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );
    const panel = (projectId: string) => (
      <PlanningPanel
        projectId={projectId}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />
    );
    const view = render(panel(PROJECT_ID));

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    await waitFor(() => expect(preflight.requested).toBe(true));

    view.rerender(panel(PROJECT_B_ID));
    expect(await screen.findByText("No proposals yet.")).toBeTruthy();

    preflight.resolve("old-project-key-12345678");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(planningCalls).toBe(0);
    expect(storedLease(PROJECT_ID)).toBeNull();
    expect(storedLease(PROJECT_B_ID)).toBeNull();
    expect(screen.queryByText(/Another device is already generating/)).toBeNull();
    expect((screen.getByRole("button", { name: "Generate proposal" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("ignores a preflight that resolves after unmount", async () => {
    const preflight = deferredPreflight();
    let planningCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === `/api/projects/${PROJECT_ID}/proposals`) {
          return jsonResponse({ ok: true, proposals: [] });
        }
        if (path === `/api/projects/${PROJECT_ID}/planning/status`) return preflight.handle();
        if (path.endsWith("/planning") && init?.method === "POST") {
          planningCalls += 1;
          return jsonResponse({ ok: true, proposal: proposalFixture() }, 201);
        }
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );
    const view = render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    await waitFor(() => expect(preflight.requested).toBe(true));
    view.unmount();

    preflight.resolve("unmounted-key-12345678");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(planningCalls).toBe(0);
    expect(storedLease(PROJECT_ID)).toBeNull();
  });

  it("blocks generation when the server reports another device's live attempt", async () => {
    let planningCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path.endsWith("/proposals")) return jsonResponse({ ok: true, proposals: [] });
        if (path.endsWith("/planning/status")) {
          return jsonResponse({
            ok: true,
            inFlight: true,
            idempotencyKey: "other-device-key-12345678",
            startedAt: new Date().toISOString(),
            abandonAfterMs: 60_000,
          });
        }
        if (path.endsWith("/planning") && init?.method === "POST") {
          planningCalls += 1;
          return jsonResponse({ ok: true, proposal: proposalFixture() }, 201);
        }
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText(/Another device is already generating/)).toBeTruthy();
    expect(planningCalls).toBe(0);
    expect(storedLease()).toBeNull();
    expect((screen.getByRole("button", { name: "Generate proposal" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sizes a new lease from the server abandon window", async () => {
    const before = Date.now();
    let leaseAtRequest: ReturnType<typeof storedLease> = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path.endsWith("/proposals")) return jsonResponse({ ok: true, proposals: [] });
        if (path.endsWith("/planning/status")) {
          return jsonResponse({
            ok: true,
            inFlight: false,
            idempotencyKey: null,
            startedAt: null,
            abandonAfterMs: 120_000,
          });
        }
        if (path.endsWith("/planning") && init?.method !== "GET") {
          leaseAtRequest = storedLease();
          return jsonResponse({ ok: true, proposal: proposalFixture() }, 201);
        }
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("Accept and save")).toBeTruthy();
    expect(leaseAtRequest).not.toBeNull();
    expect(leaseAtRequest!.expiresAt - before).toBeGreaterThan(115_000);
    expect(leaseAtRequest!.expiresAt - before).toBeLessThan(125_000);
  });

  it("lets the same key reported by preflight retry its own attempt", async () => {
    const storedKey = "same-device-key-12345678";
    window.sessionStorage.setItem(
      `storyframe.planning.pendingKey.${PROJECT_ID}`,
      JSON.stringify({
        key: storedKey,
        route: "script",
        instruction: "Keep it tight.",
        baseVersion: 1,
        startedAt: Date.now(),
      }),
    );
    let sentKey: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path.endsWith("/proposals")) return jsonResponse({ ok: true, proposals: [] });
        if (path.endsWith("/planning/status")) {
          return jsonResponse({
            ok: true,
            inFlight: true,
            idempotencyKey: storedKey,
            startedAt: new Date().toISOString(),
            abandonAfterMs: 90_000,
          });
        }
        if (path.endsWith("/planning") && init?.method !== "GET") {
          sentKey = new Headers(init?.headers).get("Idempotency-Key");
          return jsonResponse({ ok: true, proposal: proposalFixture() }, 201);
        }
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Generate proposal" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("Accept and save")).toBeTruthy();
    expect(sentKey).toBe(storedKey);
  });

  it("does not let a duplicated tab inherit the lease", async () => {
    const sharedTabId = "cloned-tab-id-12345678";
    window.sessionStorage.setItem("storyframe.planning.tabId", sharedTabId);
    window.localStorage.setItem(
      `storyframe.planning.lock.${PROJECT_ID}`,
      JSON.stringify({ tabId: sharedTabId, expiresAt: Date.now() + 60_000 }),
    );
    class DuplicateTabChannel {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      constructor(_name: string) {}
      postMessage(_message: unknown) {
        queueMicrotask(() => {
          this.onmessage?.({
            data: { type: "planning-tab-alive", tabId: sharedTabId, instanceId: "original-page" },
          });
        });
      }
      close() {}
    }
    vi.stubGlobal("BroadcastChannel", DuplicateTabChannel);
    const backend = installBackend();
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText(/inherited another tab's planning lease/)).toBeTruthy();
    expect(window.sessionStorage.getItem("storyframe.planning.tabId")).not.toBe(sharedTabId);
    expect((screen.getByRole("button", { name: "Generate proposal" }) as HTMLButtonElement).disabled).toBe(true);
    expect(backend.requests.some((request) => request.path.endsWith("/planning"))).toBe(false);
  });

  it("blocks a second mounted panel using a real BroadcastChannel while the original holds the lease", async () => {
    vi.stubGlobal("BroadcastChannel", NodeBroadcastChannel);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path.endsWith("/proposals")) return jsonResponse({ ok: true, proposals: [] });
        if (path.endsWith("/planning")) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          });
        }
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );

    const panel = (
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />
    );
    render(panel);
    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByRole("button", { name: "Stop waiting" })).toBeTruthy();
    const originalTabId = window.sessionStorage.getItem("storyframe.planning.tabId");
    expect(originalTabId).toBeTruthy();
    expect(storedLease()?.tabId).toBe(originalTabId);

    // A duplicated tab shares sessionStorage, so this mount starts with the
    // original's tab id and lease while the original page is still live.
    render(panel);
    const notice = await screen.findByText(/inherited another tab's planning lease/);
    expect(window.sessionStorage.getItem("storyframe.planning.tabId")).not.toBe(originalTabId);
    expect(storedLease()?.tabId).toBe(originalTabId);
    expect(screen.getByRole("button", { name: "Stop waiting" })).toBeTruthy();
    const duplicatePanel = notice.closest("section");
    expect(duplicatePanel).not.toBeNull();
    expect(
      (within(duplicatePanel as HTMLElement).getByRole("button", { name: "Generate proposal" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("allows generation when the lease handshake times out with no live duplicate", async () => {
    const sharedTabId = "reloaded-tab-id-12345678";
    const storedKey = "timed-out-key-12345678";
    const probes: unknown[] = [];
    class SilentTabChannel {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      constructor(_name: string) {}
      postMessage(message: unknown) {
        probes.push(message);
      }
      close() {}
    }
    vi.stubGlobal("BroadcastChannel", SilentTabChannel);
    window.sessionStorage.setItem("storyframe.planning.tabId", sharedTabId);
    window.localStorage.setItem(
      `storyframe.planning.lock.${PROJECT_ID}`,
      JSON.stringify({ tabId: sharedTabId, expiresAt: Date.now() + 60_000 }),
    );
    window.sessionStorage.setItem(
      `storyframe.planning.pendingKey.${PROJECT_ID}`,
      JSON.stringify({
        key: storedKey,
        route: "script",
        instruction: "Keep it under ten seconds.",
        baseVersion: 1,
        startedAt: Date.now(),
      }),
    );
    const backend = installBackend();
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Generate proposal" }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(probes).toContainEqual({
      type: "planning-tab-probe",
      tabId: sharedTabId,
      instanceId: expect.any(String),
    });

    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("Accept and save")).toBeTruthy();
    const generate = backend.requests.find((request) => request.path.endsWith("/planning"));
    expect(generate?.key).toBe(storedKey);
  });

  it("stops blocking generation once another tab's lease has expired", async () => {
    window.localStorage.setItem(
      `storyframe.planning.lock.${PROJECT_ID}`,
      JSON.stringify({ tabId: "other-tab", expiresAt: Date.now() - 1000 }),
    );
    const backend = installBackend();
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Generate proposal" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("Accept and save")).toBeTruthy();
    expect(backend.requests.filter((request) => request.path.endsWith("/planning"))).toHaveLength(1);
    expect(storedLease()).toBeNull();
  });

  it("restores the pending route and instruction so Retry reuses the key", async () => {
    const storedKey = "restored-key-12345678";
    window.sessionStorage.setItem(
      `storyframe.planning.pendingKey.${PROJECT_ID}`,
      JSON.stringify({
        key: storedKey,
        route: "script",
        instruction: "Keep it under ten seconds.",
        baseVersion: 1,
        startedAt: Date.now(),
      }),
    );
    const backend = installBackend();
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    await waitFor(() => {
      expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("script");
      expect((document.getElementById("planning-instruction") as HTMLTextAreaElement).value).toBe(
        "Keep it under ten seconds.",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("Accept and save")).toBeTruthy();
    const generate = backend.requests.find((request) => request.path.endsWith("/planning"));
    expect(generate?.key).toBe(storedKey);
  });

  it("discards an expired pending key and mints a fresh one", async () => {
    const backend = installBackend();
    const staleKey = "stale-key-12345678";
    window.sessionStorage.setItem(
      `storyframe.planning.pendingKey.${PROJECT_ID}`,
      JSON.stringify({
        key: staleKey,
        route: "angles",
        instruction: "",
        baseVersion: 1,
        startedAt: Date.now() - 25 * 60 * 60 * 1000,
      }),
    );
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("Accept and save")).toBeTruthy();

    const generate = backend.requests.find((request) => request.path.endsWith("/planning"));
    expect(generate?.key).toBeTruthy();
    expect(generate?.key).not.toBe(staleKey);
    expect(window.sessionStorage.getItem(`storyframe.planning.pendingKey.${PROJECT_ID}`)).toBeNull();
  });

  it("deletes a pending proposal after confirmation", async () => {
    const proposal = proposalFixture();
    const requests: { method: string; path: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        requests.push({ method: init?.method ?? "GET", path });
        if (path.endsWith("/proposals")) return jsonResponse({ ok: true, proposals: [proposal] });
        if (path.endsWith(`/proposals/${PROPOSAL_ID}`) && init?.method === "DELETE") {
          return jsonResponse({ ok: true, deletedId: PROPOSAL_ID });
        }
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Delete proposal" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    expect(await screen.findByText(/Proposal deleted/)).toBeTruthy();
    expect(requests.some((request) => request.method === "DELETE")).toBe(true);
  });

  it("loads an angle into the script instruction", async () => {
    const proposal = anglesProposalFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path.endsWith("/proposals")) return jsonResponse({ ok: true, proposals: [proposal] });
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Use this angle" }));
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("script");
    expect((document.getElementById("planning-instruction") as HTMLTextAreaElement).value).toBe(
      "The missed connection: A letter arrives too late.",
    );
    expect(screen.getByText(/Angle loaded into the script instruction/)).toBeTruthy();
  });

  it("blocks generation and acceptance while the draft is dirty", async () => {
    installBackend();
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    const generate = screen.getByRole("button", { name: "Generate proposal" }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    expect(screen.getByText(/Save or discard the draft first/)).toBeTruthy();
  });
});
