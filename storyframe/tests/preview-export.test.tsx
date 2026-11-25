// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProjectDocumentV2 } from "../shared/project-contract";
import type { ProjectExportPayload } from "../shared/project-export";
import { PreviewPanel } from "../src/workspace/PreviewPanel";

const DOCUMENT: ProjectDocumentV2 = {
  schemaVersion: 2,
  summary: "A story",
  brief: {
    topic: "Rain",
    audience: "Viewers",
    goal: "Explain the rain",
    mode: "factual",
    targetDurationSeconds: 30,
    tone: "Warm",
    preset: "documentary",
    voicePreference: "warm",
    planningBudgetUsd: 0,
  },
  scenes: [
    {
      id: "scene-1",
      heading: "Opening",
      body: "It starts to rain.",
      visualDirection: "Storm clouds",
      assetIds: ["asset-1"],
      onScreenText: "Rain",
      durationSeconds: 10,
      approved: false,
      approvedFingerprint: null,
      locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
    },
  ],
};

const PAYLOAD: ProjectExportPayload = {
  title: "Rain",
  document: DOCUMENT,
  credits: [
    {
      mediaId: "asset-1",
      kind: "image",
      provider: "pexels",
      providerId: "101",
      rendition: "original",
      creator: "Ada",
      attribution: "Photo by Ada on Pexels",
      sourcePage: "https://www.pexels.com/photo/101/",
      license: "Pexels License",
      sceneIds: ["scene-1"],
    },
  ],
  renderPayload: {
    scenes: [
      {
        sceneId: "scene-1",
        heading: "Opening",
        durationSeconds: 10,
        assets: [
          {
            mediaId: "asset-1",
            kind: "image",
            provider: "pexels",
            providerId: "101",
            rendition: "original",
            creator: "Ada",
            attribution: "Photo by Ada on Pexels",
            sourcePage: "https://www.pexels.com/photo/101/",
            license: "Pexels License",
          },
        ],
      },
    ],
  },
};

let downloads: Blob[] = [];
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
  downloads = [];
  URL.createObjectURL = vi.fn((blob: Blob) => {
    downloads.push(blob);
    return "blob:test";
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, export: PAYLOAD }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

function renderPanel() {
  render(
    <PreviewPanel
      title="Rain"
      projectDocument={DOCUMENT}
      projectId="project-1"
      getAccessToken={async () => "token"}
    />,
  );
}

describe("preview export", () => {
  it("downloads JSON with the stock credit and render payload", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Download project JSON" }));

    await waitFor(() => expect(downloads).toHaveLength(1));
    const text = await downloads[0].text();
    const body = JSON.parse(text) as ProjectExportPayload;
    expect(body.credits).toHaveLength(1);
    expect(body.credits[0]).toMatchObject({
      creator: "Ada",
      provider: "pexels",
      sourcePage: "https://www.pexels.com/photo/101/",
      license: "Pexels License",
    });
    expect(body.renderPayload.scenes[0].assets[0].mediaId).toBe("asset-1");
    expect(body.document).toEqual(DOCUMENT);
  });

  it("downloads a script whose credit block names the creator and license", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Download script text" }));

    await waitFor(() => expect(downloads).toHaveLength(1));
    const text = await downloads[0].text();
    expect(text).toContain("SCENE 1 — Opening");
    expect(text).toContain("CREDITS");
    expect(text).toContain("Photo by Ada on Pexels — Pexels License — https://www.pexels.com/photo/101/");
  });
});
