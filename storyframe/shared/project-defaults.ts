import type { ProjectBrief, ProjectDocumentV2, ProjectType } from "./project-contract";

/** Starting brief values for a new project. Every field remains editable. */
export function defaultBriefFor(projectType: ProjectType): ProjectBrief {
  if (projectType === "product-ad") {
    return {
      topic: "",
      audience: "",
      goal: "",
      mode: "factual",
      targetDurationSeconds: 30,
      tone: "Upbeat",
      preset: "Product spot",
      voicePreference: "energetic",
      planningBudgetUsd: 0,
    };
  }
  if (projectType === "repurpose") {
    return {
      topic: "",
      audience: "",
      goal: "",
      mode: "factual",
      targetDurationSeconds: 45,
      tone: "Neutral",
      preset: "Footage excerpt",
      voicePreference: "neutral",
      planningBudgetUsd: 0,
    };
  }
  return {
    topic: "",
    audience: "",
    goal: "",
    mode: "fiction",
    targetDurationSeconds: 60,
    tone: "Warm",
    preset: "Story short",
    voicePreference: "warm",
    planningBudgetUsd: 0,
  };
}

export function emptyDocument(projectType: ProjectType): ProjectDocumentV2 {
  return {
    schemaVersion: 2,
    summary: "",
    brief: defaultBriefFor(projectType),
    scenes: [],
  };
}
