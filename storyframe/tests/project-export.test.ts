import { describe, expect, it } from "vitest";
import type { MediaRecord } from "../shared/media-contract";
import type { ProjectDocumentV2 } from "../shared/project-contract";
import { buildProjectExport, buildScriptText } from "../shared/project-export";

function documentWith(assetIds: string[]): ProjectDocumentV2 {
  return {
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
        assetIds,
        onScreenText: "Rain",
        durationSeconds: 10,
        approved: false,
        approvedFingerprint: null,
        locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
      },
      {
        id: "scene-2",
        heading: "Closing",
        body: "The street empties.",
        visualDirection: "",
        assetIds,
        onScreenText: "",
        durationSeconds: 10,
        approved: false,
        approvedFingerprint: null,
        locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
      },
    ],
  };
}

function stockMedia(id: string, overrides: Partial<MediaRecord> = {}): MediaRecord {
  return {
    id,
    kind: "image",
    status: "ready",
    sceneKey: null,
    contentType: "image/jpeg",
    byteSize: 604,
    uploadExpiresAt: null,
    readyAt: "2026-11-25T12:00:00.000Z",
    deletedAt: null,
    createdAt: "2026-11-25T12:00:00.000Z",
    referenceCount: 2,
    provenance: {
      source: "stock",
      provider: "pexels",
      providerId: "101",
      type: "image",
      rendition: "original",
      renditionUrl: "https://images.pexels.com/photos/101/original.jpg",
      sourcePage: "https://www.pexels.com/photo/101/",
      creator: "Ada",
      attribution: "Photo by Ada on Pexels",
      license: "Pexels License",
      downloadedAt: "2026-11-25T12:00:00.000Z",
      byteSize: 604,
    },
    ...overrides,
  };
}

describe("project export", () => {
  it("credits each stock asset once with every scene that uses it", () => {
    const payload = buildProjectExport("Rain", documentWith(["asset-1", "asset-1"]), [
      stockMedia("asset-1"),
      // An upload with no provenance is not a stock asset and is not credited.
      stockMedia("asset-2", { provenance: null }),
      // Deleted or pending stock rows never reach an export.
      stockMedia("asset-3", { status: "deleted" }),
    ]);

    expect(payload.credits).toHaveLength(1);
    expect(payload.credits[0]).toMatchObject({
      mediaId: "asset-1",
      sceneIds: ["scene-1", "scene-2"],
      creator: "Ada",
      provider: "pexels",
      providerId: "101",
      sourcePage: "https://www.pexels.com/photo/101/",
      license: "Pexels License",
      rendition: "original",
    });
    expect(payload.renderPayload.scenes[0].assets).toHaveLength(1);
    expect(payload.renderPayload.scenes[1].assets[0].mediaId).toBe("asset-1");
    expect(payload.document).toEqual(documentWith(["asset-1", "asset-1"]));
  });

  it("only credits media the document actually references", () => {
    const payload = buildProjectExport("Rain", documentWith(["asset-1"]), [
      stockMedia("asset-1"),
      stockMedia("asset-9"),
    ]);
    expect(payload.credits.map((credit) => credit.mediaId)).toEqual(["asset-1"]);
  });

  it("appends a credit block to the script only when stock media is used", () => {
    const withCredit = buildScriptText(buildProjectExport("Rain", documentWith(["asset-1"]), [stockMedia("asset-1")]));
    expect(withCredit).toContain("SCENE 1 — Opening");
    expect(withCredit).toContain("CREDITS");
    expect(withCredit).toContain("Photo by Ada on Pexels — Pexels License — https://www.pexels.com/photo/101/");

    const withoutCredit = buildScriptText(buildProjectExport("Rain", documentWith([]), []));
    expect(withoutCredit).not.toContain("CREDITS");
  });
});
