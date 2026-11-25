import { defaultBriefFor } from "../shared/project-defaults";
import type { ProjectBrief, ProjectDocumentV2, ProjectScene } from "../shared/project-contract";

export function briefFixture(overrides: Partial<ProjectBrief> = {}): ProjectBrief {
  return {
    ...defaultBriefFor("story"),
    topic: "A letter that arrives too late",
    audience: "Festival audiences",
    goal: "Show the courier's choice",
    ...overrides,
  };
}

export function sceneFixture(overrides: Partial<ProjectScene> = {}): ProjectScene {
  return {
    id: "scene-1",
    heading: "INT. TRAIN CAR - NIGHT",
    body: "The letter waits under a seat, addressed to nobody.",
    visualDirection: "Close on the envelope as the train rocks.",
    assetIds: [],
    onScreenText: "",
    durationSeconds: 12,
    approved: false,
    approvedFingerprint: null,
    locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
    ...overrides,
  };
}

export function documentFixture(overrides: Partial<ProjectDocumentV2> = {}): ProjectDocumentV2 {
  return {
    schemaVersion: 2,
    summary: "A courier finds a letter that was never meant to arrive.",
    brief: briefFixture(),
    scenes: [sceneFixture()],
    ...overrides,
  };
}
