/** Version of the stored project document shape. Bump this when the shape changes. */
export const PROJECT_SCHEMA_VERSION = 2;

export type ProjectType = "story" | "product-ad" | "repurpose";
export type BriefMode = "factual" | "fiction";
export type VoicePreference = "warm" | "energetic" | "neutral" | "none";
export type ProjectAspectRatio = "9:16" | "1:1" | "16:9";
export type ProjectPreset = string;

/** The story brief. Empty draft values are allowed; the server bounds them. */
export interface ProjectBrief {
  topic: string;
  audience: string;
  goal: string;
  mode: BriefMode;
  targetDurationSeconds: number;
  tone: string;
  preset: string;
  voicePreference: VoicePreference;
  /** Planning allowance in US dollars; no purchase is made in Phase 4. */
  planningBudgetUsd: number;
}

/** Locks for the components that a later generation step must not overwrite. */
export interface SceneLocks {
  narration: boolean;
  visualDirection: boolean;
  onScreenText: boolean;
  duration: boolean;
}

export interface ProjectScene {
  id: string;
  heading: string;
  /** The script wording. The script and storyboard both read this one field. */
  body: string;
  visualDirection: string;
  assetIds: string[];
  onScreenText: string;
  durationSeconds: number;
  approved: boolean;
  /** Fingerprint of the exact content that was approved. Null when not approved. */
  approvedFingerprint: string | null;
  locks: SceneLocks;
}

export type SceneDraft = ProjectScene;

/** Document v2: Phase 4 brief, scenes, locks, and approvals. */
export interface ProjectDocumentV2 {
  schemaVersion: 2;
  summary: string;
  brief: ProjectBrief;
  scenes: ProjectScene[];
}

/** Document v1, kept so rows written before Phase 4 remain readable. */
export interface ProjectDocumentV1 {
  schemaVersion: 1;
  summary: string;
  scenes: { id: string; heading: string; body: string }[];
}

export type ProjectDocument = ProjectDocumentV2;

/** List view: everything except the document. */
export interface ProjectSummary {
  id: string;
  projectType: ProjectType;
  title: string;
  schemaVersion: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord extends ProjectSummary {
  document: ProjectDocumentV2;
}

export interface ProjectListResponse {
  ok: true;
  projects: ProjectSummary[];
}

export interface ProjectResponse {
  ok: true;
  project: ProjectRecord;
}

export interface ProjectDeletedResponse {
  ok: true;
  deletedId: string;
}

export interface ProjectRevisionSummary {
  revision: number;
  title: string;
  schemaVersion: number;
  createdAt: string;
}

export interface ProjectRevisionListResponse {
  ok: true;
  revisions: ProjectRevisionSummary[];
}
