import type { MediaRecord } from "./media-contract";
import type { NarrationTrack } from "./narration-contract";
import type { ProjectAspectRatio, ProjectDocumentV2, ProjectType, SceneDraft } from "./project-contract";

export type RenderJobStatus =
  | "queued"
  | "submitted"
  | "rendering"
  | "downloading"
  | "ready"
  | "failed";

export interface Json2VideoElement {
  type: "image" | "video" | "text" | "audio";
  src?: string;
  text?: string;
  start?: number;
  duration: number;
  trimStart?: number;
  trimEnd?: number;
  width?: number;
  height?: number;
  fit?: "cover" | "contain";
  volume?: number;
  style?: Record<string, string | number>;
}

export interface Json2VideoScenePayload {
  id: string;
  comment: string;
  duration: number;
  transition?: {
    style: "fade" | "wipeleft" | "slideleft" | "none";
    duration: number;
  };
  elements: Json2VideoElement[];
}

export interface Json2VideoMoviePayload {
  resolution: "custom";
  width: number;
  height: number;
  fps: 30;
  quality: "high";
  comment: string;
  scenes: Json2VideoScenePayload[];
  elements: Json2VideoElement[];
}

export interface RenderCompositionValidationIssue {
  code:
    | "EMPTY_SCENES"
    | "SCENE_ZERO_DURATION"
    | "MISSING_VISUAL_ASSET"
    | "ASSET_NOT_READY"
    | "UNSUPPORTED_MEDIA_FORMAT"
    | "DURATION_EXCEEDS_MAX"
    | "NARRATION_DURATION_MISMATCH"
    | "UNRESOLVED_FACTUAL_CLAIMS";
  severity: "error" | "warning";
  sceneId: string | null;
  message: string;
}

export interface CompiledRenderSnapshot {
  projectId: string;
  projectVersion: number;
  projectType: ProjectType;
  title: string;
  aspectRatio: ProjectAspectRatio;
  width: number;
  height: number;
  totalDurationSeconds: number;
  measuredNarrationSeconds: number;
  estimatedCostUsd: number;
  fingerprint: string;
  issues: RenderCompositionValidationIssue[];
  canSubmit: boolean;
  movie: Json2VideoMoviePayload;
  sceneTimings: {
    sceneId: string;
    heading: string;
    startSeconds: number;
    durationSeconds: number;
    visualMediaId: string | null;
    narrationTrackId: string | null;
  }[];
  compiledAt: string;
}

export interface RenderJobRecord {
  id: string;
  projectId: string;
  projectVersion: number;
  status: RenderJobStatus;
  aspectRatio: ProjectAspectRatio;
  providerJobId: string | null;
  idempotencyKey: string | null;
  snapshotFingerprint: string;
  snapshot: CompiledRenderSnapshot;
  outputMediaId: string | null;
  durationSeconds: number;
  byteSize: number | null;
  estimatedCostUsd: number;
  settledCostUsd: number | null;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface RenderCompileRequest {
  aspectRatio?: ProjectAspectRatio;
  allowUnresolvedClaims?: boolean;
}

export interface RenderSubmitRequest {
  aspectRatio?: ProjectAspectRatio;
  allowUnresolvedClaims?: boolean;
}

export interface RenderCompileResponse {
  ok: true;
  snapshot: CompiledRenderSnapshot;
}

export interface RenderJobResponse {
  ok: true;
  job: RenderJobRecord;
  replayed?: boolean;
}

export interface RenderJobListResponse {
  ok: true;
  jobs: RenderJobRecord[];
}

export interface RenderInputContext {
  projectId: string;
  projectVersion: number;
  projectType: ProjectType;
  title: string;
  document: ProjectDocumentV2;
  aspectRatio?: ProjectAspectRatio;
  mediaById: ReadonlyMap<string, MediaRecord>;
  signedUrlsByMediaId: ReadonlyMap<string, string>;
  narrationTracks: readonly NarrationTrack[];
  unresolvedClaimCount?: number;
  allowUnresolvedClaims?: boolean;
  maxDurationSeconds?: number;
  ratePerMinuteUsd?: number;
  compiledAt?: string;
}

export function dimensionsForAspectRatio(aspectRatio: ProjectAspectRatio): {
  width: number;
  height: number;
} {
  switch (aspectRatio) {
    case "1:1":
      return { width: 1080, height: 1080 };
    case "16:9":
      return { width: 1920, height: 1080 };
    case "9:16":
    default:
      return { width: 1080, height: 1920 };
  }
}

export function effectiveSceneDuration(
  scene: SceneDraft,
  narrationTrack: NarrationTrack | undefined,
): number {
  const planned = Number.isFinite(scene.durationSeconds) && scene.durationSeconds > 0
    ? scene.durationSeconds
    : 0;
  const measured =
    narrationTrack && narrationTrack.durationSeconds && narrationTrack.durationSeconds > 0
      ? Math.ceil(narrationTrack.durationSeconds)
      : 0;
  if (planned > 0 && measured > 0) {
    return Math.max(planned, measured);
  }
  return planned > 0 ? planned : measured;
}
