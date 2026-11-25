// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ImageModelView,
} from "../shared/image-generation-contract";
import type { MediaRecord } from "../shared/media-contract";
import type { ProjectScene } from "../shared/project-contract";
import { GeneratePanel } from "../src/workspace/GeneratePanel";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_GENERATION_ID = "88888888-8888-4888-8888-888888888888";
const MEDIA_ID = "99999999-9999-4999-8999-999999999999";
const GENERATION_ID = "77777777-7777-4777-8777-777777777777";
const REFERENCE_ID = "55555555-5555-4555-8555-555555555555";
const SCENE_ID = "s1";
const NOW = "2026-11-25T12:00:00.000Z";

const SCENES: ProjectScene[] = [
  {
    id: SCENE_ID,
    heading: "Opening",
    body: "The light sweeps the water.",
    visualDirection: "Stormy coast",
    assetIds: [],
    onScreenText: "",
    durationSeconds: 10,
    approved: false,
    approvedFingerprint: null,
    locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
  },
];

const MODELS: ImageModelView[] = [
  {
    key: "cloudflare:flux-1-schnell",
    provider: "cloudflare",
    label: "Cloudflare FLUX.1 schnell",
    width: 1024,
    height: 1024,
    steps: 4,
    maxPromptChars: 2048,
    configured: true,
    billing: {
      kind: "neurons",
      usdPerThousandNeurons: 0.011,
      neuralRates: { perTile: 4.8, perStep: 9.6 },
      note: "10,000 free neurons per day at the account level.",
      sourceUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
      verifiedOn: "2026-11-25",
    },
  },
  {
    key: "leonardo:phoenix-1.0",
    provider: "leonardo",
    label: "Leonardo Phoenix 1.0",
    width: 1024,
    height: 1024,
    steps: null,
    maxPromptChars: 2000,
    configured: false,
    billing: {
      kind: "api-credit",
      note: "Priced in API credit; no per-image USD rate is published.",
      sourceUrl: "https://docs.leonardo.ai/docs/api-pricing",
      verifiedOn: "2026-11-25",
    },
  },
];

const MEDIA: MediaRecord = {
  id: MEDIA_ID,
  kind: "image",
  status: "ready",
  sceneKey: null,
  contentType: "image/jpeg",
  byteSize: 698607,
  uploadExpiresAt: null,
  readyAt: NOW,
  deletedAt: null,
  createdAt: NOW,
  referenceCount: 0,
  provenance: null,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => payload,
  } as unknown as Response;
}

interface BackendOptions {
  generationStatus?: "succeeded" | "pending";
  generationError?: { code: string; message: string };
  blockedBy?: { projectId: string; generationId: string; jobId: string };
  /** Reports the blocking job from the usage call made when the panel opens. */
  pendingOnOpen?: boolean;
}

function installBackend(options: BackendOptions = {}) {
  const { generationStatus = "succeeded", generationError, blockedBy, pendingOnOpen = false } = options;
  const requests: { method: string; path: string; body: any }[] = [];
  let polled = false;

  const generationRecord = (status: "pending" | "succeeded", mediaId: string | null) => ({
    id: GENERATION_ID,
    projectId: PROJECT_ID,
    provider: "cloudflare",
    modelKey: "cloudflare:flux-1-schnell",
    prompt: "a lighthouse on a stormy coast",
    settings: { width: 1024, height: 1024, steps: 4 },
    status,
    jobId: status === "pending" ? "job-1" : null,
    mediaId,
    estimatedUsd: 0.001901,
    estimatedNeurons: 172.8,
    rateVersion: "cloudflare-flux-schnell-2026-11-25",
    providerCost: null,
    errorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as any) : null;
      requests.push({ method, path: url.pathname, body });

      if (url.pathname === "/api/image-models" && method === "GET") {
        return jsonResponse({ ok: true, models: MODELS });
      }
      if (url.pathname === "/api/image-usage" && method === "GET") {
        return jsonResponse({
          ok: true,
          usage: {
            windowHours: 24,
            attempts: 1,
            spentUsd: 0.000634,
            actualUsd: 0.000634,
            estimatedUsd: 0.001901,
            limits: { images: 20, usd: 1 },
            resetAt: null,
          },
          pending:
            pendingOnOpen && blockedBy
              ? {
                  generationId: blockedBy.generationId,
                  projectId: blockedBy.projectId,
                  jobId: blockedBy.jobId,
                  provider: "leonardo",
                  modelKey: "leonardo:phoenix-1.0",
                  createdAt: NOW,
                }
              : null,
        });
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/image-generations/estimate` && method === "POST") {
        return jsonResponse({
          ok: true,
          estimate: {
            modelKey: body.modelKey,
            provider: "cloudflare",
            width: 1024,
            height: 1024,
            steps: 4,
            estimatedNeurons: 172.8,
            estimatedUsd: 0.001901,
            rateVersion: "cloudflare-flux-schnell-2026-11-25",
            billing: MODELS[0].billing,
          },
        });
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/image-generations` && method === "POST") {
        if (blockedBy) {
          return jsonResponse(
            {
              ok: false,
              error: {
                code: "IMAGE_GENERATION_IN_FLIGHT",
                message: `A generation is still pending in project ${blockedBy.projectId} (job ${blockedBy.jobId}).`,
                details: {
                  pending: {
                    generationId: blockedBy.generationId,
                    projectId: blockedBy.projectId,
                    jobId: blockedBy.jobId,
                    provider: "leonardo",
                    modelKey: "leonardo:phoenix-1.0",
                    createdAt: NOW,
                  },
                },
              },
            },
            429,
          );
        }
        if (generationError) {
          return jsonResponse({ ok: false, error: generationError }, 502);
        }
        return jsonResponse(
          {
            ok: true,
            generation: generationRecord(generationStatus, generationStatus === "succeeded" ? MEDIA_ID : null),
            media: generationStatus === "succeeded" ? MEDIA : null,
          },
          generationStatus === "succeeded" ? 201 : 202,
        );
      }
      if (
        url.pathname === `/api/projects/${PROJECT_ID}/image-generations/${GENERATION_ID}/refresh` &&
        method === "POST"
      ) {
        polled = true;
        return jsonResponse({
          ok: true,
          generation: generationRecord("succeeded", MEDIA_ID),
          media: MEDIA,
        });
      }
      if (
        blockedBy &&
        url.pathname ===
          `/api/projects/${blockedBy.projectId}/image-generations/${blockedBy.generationId}/settle` &&
        method === "POST"
      ) {
        return jsonResponse({
          ok: true,
          generation: {
            ...generationRecord("pending", null),
            id: blockedBy.generationId,
            projectId: blockedBy.projectId,
            provider: "leonardo",
            modelKey: "leonardo:phoenix-1.0",
            status: "failed",
            errorCode: "IMAGE_GENERATION_ABANDONED",
          },
          media: null,
        });
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/media/${MEDIA_ID}/url` && method === "GET") {
        return jsonResponse({
          ok: true,
          url: "https://media.example/private/generated.jpg",
          expiresAt: "2026-11-25T12:05:00.000Z",
        });
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/media/${MEDIA_ID}/references` && method === "POST") {
        return jsonResponse(
          {
            ok: true,
            reference: {
              id: REFERENCE_ID,
              mediaId: MEDIA_ID,
              refKind: "scene",
              refId: body.refId,
              createdAt: NOW,
            },
          },
          201,
        );
      }
      return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: url.pathname } }, 404);
    }),
  );

  return { requests, polled: () => polled };
}

async function eventuallyRequests(
  backend: { requests: { method: string; path: string }[] },
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const posts = backend.requests.filter(
      (request) =>
        request.method === "POST" && request.path === `/api/projects/${PROJECT_ID}/image-generations`,
    );
    if (posts.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("generation request was not sent");
}

function renderPanel(
  options: { onAttachAsset?: (sceneId: string, mediaId: string) => Promise<boolean> } = {},
) {
  const attach = vi.fn(options.onAttachAsset ?? (async () => true));
  render(
    <GeneratePanel
      projectId={PROJECT_ID}
      scenes={SCENES}
      getAccessToken={async () => "token"}
      onAttachAsset={attach}
    />,
  );
  return { attach };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GeneratePanel", () => {
  it("shows the verified estimate and waits for an explicit Generate", async () => {
    const backend = installBackend();
    renderPanel();

    const spend = await screen.findByLabelText("Daily image spend");
    expect(spend.textContent).toContain("$0.0006");
    expect(spend.textContent).toContain("20 image limit");

    const model = await screen.findByLabelText("Model");
    expect(within(model).getByRole("option", { name: "Cloudflare FLUX.1 schnell" })).toBeTruthy();
    const disabled = within(model).getByRole("option", { name: /Leonardo Phoenix 1.0 — credentials missing/ });
    expect((disabled as HTMLOptionElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Generate image" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Use scene direction" }));
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe(
      "Opening. Stormy coast",
    );

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "a lighthouse on a stormy coast" },
    });

    const cost = await screen.findByLabelText("Estimated cost");
    expect(await within(cost).findByText("$0.001901")).toBeTruthy();
    expect(within(cost).getByText(/172\.8 neurons/)).toBeTruthy();
    expect(within(cost).getByText(/rates verified 2026-11-25/)).toBeTruthy();
    expect(within(cost).getByRole("link", { name: "Pricing source" }).getAttribute("href")).toBe(
      "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    );
    expect(
      backend.requests.find((request) => request.path.endsWith("/estimate"))?.body,
    ).toEqual({ modelKey: "cloudflare:flux-1-schnell", prompt: "a lighthouse on a stormy coast" });
    expect(
      backend.requests.some((request) => request.path === `/api/projects/${PROJECT_ID}/image-generations`),
    ).toBe(false);
  });

  it("generates explicitly, previews the private asset, and attaches it to a scene", async () => {
    const backend = installBackend();
    const { attach } = renderPanel();

    fireEvent.change(await screen.findByLabelText("Prompt"), {
      target: { value: "a lighthouse on a stormy coast" },
    });
    await screen.findByText("$0.001901");
    expect(
      backend.requests.some((request) => request.method === "POST" && request.path.endsWith("/image-generations")),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Generate image" }));

    const preview = await screen.findByRole("img", { name: /Generated image: a lighthouse on a stormy coast/ });
    expect(preview.getAttribute("src")).toBe("https://media.example/private/generated.jpg");
    const generationRequest = backend.requests.find(
      (request) => request.path === `/api/projects/${PROJECT_ID}/image-generations` && request.method === "POST",
    );
    expect(generationRequest?.body).toEqual({
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "a lighthouse on a stormy coast",
    });
    expect(await screen.findByText(/682 KiB/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await eventuallyRequests(backend, 2);

    fireEvent.click(await screen.findByRole("button", { name: "Attach image to scene" }));

    await waitFor(() => expect(attach).toHaveBeenCalledWith(SCENE_ID, MEDIA_ID));
    const reference = backend.requests.find(
      (request) => request.path === `/api/projects/${PROJECT_ID}/media/${MEDIA_ID}/references`,
    );
    expect(reference?.body).toEqual({ refKind: "scene", refId: SCENE_ID });
    expect(await screen.findByText('Attached to "Opening" and saved.')).toBeTruthy();
  });

  it("keeps a pending job explicit and completes it through Refresh job", async () => {
    const backend = installBackend({ generationStatus: "pending" });
    renderPanel();

    fireEvent.change(await screen.findByLabelText("Prompt"), { target: { value: "a lighthouse" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate image" }));

    expect(await screen.findByText(/Generation queued \(job job-1\)/)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh job" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Refresh job" }));

    expect(await screen.findByRole("img", { name: /Generated image: a lighthouse/ })).toBeTruthy();
    expect(backend.polled()).toBe(true);
    expect(screen.queryByRole("button", { name: "Refresh job" })).toBeNull();
  });

  it("surfaces an existing pending job as soon as the panel opens", async () => {
    const backend = installBackend({
      blockedBy: { projectId: OTHER_PROJECT_ID, generationId: OTHER_GENERATION_ID, jobId: "job-other" },
      pendingOnOpen: true,
    });
    renderPanel();

    const alert = await screen.findByRole("alert", { name: "Pending image job" });
    expect(within(alert).getByText(/project 22222222/)).toBeTruthy();
    expect(
      backend.requests.some(
        (request) => request.method === "POST" && request.path.endsWith("/image-generations"),
      ),
    ).toBe(false);

    fireEvent.click(within(alert).getByRole("button", { name: "Settle and unblock" }));
    expect(
      await screen.findByText("The pending job was settled; you can generate here now."),
    ).toBeTruthy();
  });

  it("names a pending job in another project and settles it to unblock", async () => {
    const backend = installBackend({
      blockedBy: { projectId: OTHER_PROJECT_ID, generationId: OTHER_GENERATION_ID, jobId: "job-other" },
    });
    renderPanel();

    fireEvent.change(await screen.findByLabelText("Prompt"), { target: { value: "a lighthouse" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate image" }));

    const alert = await screen.findByRole("alert", { name: "Pending image job" });
    expect(within(alert).getByText("IMAGE_GENERATION_IN_FLIGHT")).toBeTruthy();
    expect(within(alert).getByText(/project 22222222/)).toBeTruthy();
    expect(within(alert).getByText(/job job-othe/)).toBeTruthy();
    expect(within(alert).getByText(/leonardo · leonardo:phoenix-1\.0/)).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Refresh pending job" })).toBeTruthy();

    fireEvent.click(within(alert).getByRole("button", { name: "Settle and unblock" }));

    expect(
      await screen.findByText("The pending job was settled; you can generate here now."),
    ).toBeTruthy();
    expect(screen.queryByRole("alert", { name: "Pending image job" })).toBeNull();
    expect(
      backend.requests.find(
        (request) =>
          request.path ===
          `/api/projects/${OTHER_PROJECT_ID}/image-generations/${OTHER_GENERATION_ID}/settle`,
      )?.method,
    ).toBe("POST");
  });

  it("surfaces a sanitized provider failure without a preview", async () => {
    installBackend({
      generationError: {
        code: "IMAGE_PROVIDER_FAILED",
        message: "The provider reported no completed image.",
      },
    });
    renderPanel();

    fireEvent.change(await screen.findByLabelText("Prompt"), { target: { value: "a lighthouse" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate image" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("IMAGE_PROVIDER_FAILED")).toBeTruthy();
    expect(within(alert).getByText("The provider reported no completed image.")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh job" })).toBeNull();
  });
});
