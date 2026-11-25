import type { GenerationProposalRecord } from "./child-contract";
import type { ProjectRecord } from "./project-contract";

/** The five planning jobs Phase 5 routes to one model each. */
export const PLANNING_ROUTES = [
  "angles",
  "script",
  "storyboard",
  "ad-concept",
  "transcript-analysis",
] as const;

export type PlanningRoute = (typeof PLANNING_ROUTES)[number];

export const PLANNING_ROUTE_LABELS: Record<PlanningRoute, string> = {
  angles: "Angles",
  script: "Script",
  storyboard: "Storyboard",
  "ad-concept": "Ad concept",
  "transcript-analysis": "Transcript analysis",
};

export const PLANNING_ROUTE_HINTS: Record<PlanningRoute, string> = {
  angles: "Three distinct directions for the brief. Nothing is written to the document.",
  script: "Scene narration and headings for the brief. Locked narration is never replaced.",
  storyboard: "Visual direction, on-screen text, and durations for the current script, in order, without changing its wording.",
  "ad-concept": "A hook, beats, and call to action for a product ad.",
  "transcript-analysis": "Clip windows quoted from the supplied transcript, as scene drafts.",
};

export interface PlanningAngle {
  title: string;
  hook: string;
  rationale: string;
}

/** One scene draft. Media ids are deliberately absent: a model may not invent them. */
export interface PlanningSceneDraft {
  heading: string;
  narration: string;
  visualDirection: string;
  onScreenText: string;
  durationSeconds: number;
}

export interface PlanningClip {
  startSeconds: number;
  endSeconds: number;
  quote: string;
  heading: string;
  rationale: string;
}

/**
 * A factual claim as the proposal reports it. `supported` is decided by the
 * server after checking that `quote` is an exact excerpt of that source; the
 * model cannot mark its own claim as supported.
 */
export interface PlanningClaim {
  sourceId: string;
  statement: string;
  quote: string;
  supported: boolean;
}

/** The validated JSON body stored in `generation_proposals.proposal`. */
export interface PlanningPayload {
  route: PlanningRoute;
  summary: string;
  notes: string[];
  insufficientEvidence: boolean;
  repairAttempted: boolean;
  angles: PlanningAngle[];
  scenes: PlanningSceneDraft[];
  clips: PlanningClip[];
  claims: PlanningClaim[];
}

export interface PlanningStartRequest {
  route: PlanningRoute;
  instruction: string;
  /** The project version the caller reviewed; a mismatch means the request is stale. */
  baseVersion: number;
}

export interface PlanningRouteInfo {
  route: PlanningRoute;
  modelId: string | null;
  requestId: string | null;
  available: boolean;
  reason: string | null;
  capabilities: PlanningRoute[];
}

/** Registry entry: configuration plus the last real check recorded in `model_health`. */
export interface PlanningRegistryEntry {
  modelId: string;
  family: string;
  requestId: string | null;
  available: boolean;
  capabilities: PlanningRoute[];
  inputLimitChars: number;
  outputTokenLimit: number;
  costRateVersion: string;
  catalogCheckedOn: string;
  lastSuccessAt: string | null;
}

export interface PlanningStatus {
  routes: PlanningRouteInfo[];
  registry: PlanningRegistryEntry[];
}

export interface PlanningAttemptStatusResponse {
  ok: true;
  inFlight: boolean;
  /** The owner's pending key, or null when no attempt is live. */
  idempotencyKey: string | null;
  startedAt: string | null;
  /** The server's authoritative abandon window for client lease sizing. */
  abandonAfterMs: number;
}

export interface PlanningProposalResponse {
  ok: true;
  proposal: GenerationProposalRecord;
}

export interface PlanningAcceptedResponse {
  ok: true;
  proposal: GenerationProposalRecord;
  project: ProjectRecord;
  claimsRecorded: boolean;
}
