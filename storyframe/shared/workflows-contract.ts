import type { AiModelId } from "./ai-contract";
import type {
  ProjectAspectRatio,
  ProjectDocumentV2,
  SceneDraft,
  SceneLocks,
} from "./project-contract";

// ==========================================
// Phase 10: Complete Mode A — Stories & Explainers
// ==========================================

export interface ModeAContinuityNotes {
  characters: string;
  setting: string;
  continuityRules: string;
  updatedAt: string;
}

export interface ModeAFactualClaimCheck {
  claimId: string;
  statement: string;
  sceneKey: string | null;
  sourceId: string | null;
  status: "proposed" | "accepted" | "rejected";
  verifiedByHuman: boolean;
  note: string;
}

export interface ModeAReadinessChecklist {
  projectId: string;
  projectVersion: number;
  mode: "factual" | "fiction";
  readyToRender: boolean;
  totalDurationSeconds: number;
  measuredNarrationSeconds: number;
  estimatedRenderCostUsd: number;
  missingAssets: {
    sceneId: string;
    heading: string;
    missingVisual: boolean;
    missingNarration: boolean;
  }[];
  unresolvedClaims: {
    claimId: string;
    statement: string;
    status: string;
  }[];
  unapprovedScenes: {
    sceneId: string;
    heading: string;
  }[];
  lockedScenesCount: number;
  continuityNotes: ModeAContinuityNotes | null;
  factCheckDisclosure: string;
}

// ==========================================
// Phase 11: Complete Mode B — Product Ads
// ==========================================

export interface ApprovedProductClaim {
  id: string;
  statement: string;
  evidenceNote: string;
  substantiated: boolean;
}

export interface ProductCatalogRecord {
  id: string;
  projectId: string;
  productName: string;
  variantName: string;
  productAssetMediaIds: string[];
  logoMediaId: string | null;
  brandPrimaryColor: string;
  brandSecondaryColor: string;
  brandFontFamily: string;
  approvedClaims: ApprovedProductClaim[];
  prohibitedWording: string[];
  preserveOriginalProductAsset: boolean;
  backgroundLayerPrompt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdCampaignRecord {
  id: string;
  projectId: string;
  productId: string;
  audience: string;
  offerSummary: string;
  priceAmount: string;
  priceCurrency: string;
  promoStartAt: string | null;
  promoEndAt: string | null;
  promoTimezone: string;
  ctaText: string;
  destinationUrl: string;
  targetDurationSeconds: number;
  aspectRatio: ProjectAspectRatio;
  disclaimerText: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdConceptProposal {
  id: string;
  angleTitle: string;
  hook: string;
  bodyCopy: string;
  ctaText: string;
  linkedClaimIds: string[];
  visualLayout: "product-hero" | "split-comparison" | "floating-card";
  backgroundDirection: string;
  complianceStatus: "clean" | "flagged";
  complianceFlags: string[];
}

export interface AdVariantRecord {
  id: string;
  projectId: string;
  campaignId: string;
  conceptId: string;
  label: string;
  hookText: string;
  ctaText: string;
  layoutStyle: "product-hero" | "split-comparison" | "floating-card";
  aspectRatio: ProjectAspectRatio;
  linkedClaimIds: string[];
  productAssetMediaIds: string[];
  disclaimerText: string;
  approved: boolean;
  fingerprint: string;
  createdAt: string;
}

export interface AdVariantExportManifest {
  projectId: string;
  campaignId: string;
  productName: string;
  exportedAt: string;
  variants: {
    variantId: string;
    label: string;
    hookText: string;
    ctaText: string;
    layoutStyle: string;
    aspectRatio: ProjectAspectRatio;
    linkedClaims: { id: string; statement: string; evidenceNote: string }[];
    productAssetMediaIds: string[];
    disclaimerText: string;
    fingerprint: string;
  }[];
}

// ==========================================
// Phase 12: Complete Mode C — Footage Repurposing
// ==========================================

export interface TranscriptWord {
  word: string;
  startSeconds: number;
  endSeconds: number;
  confidence: number;
  speaker: number | null;
}

export interface TranscriptSegment {
  id: string;
  speaker: string;
  startSeconds: number;
  endSeconds: number;
  originalText: string;
  correctedText: string;
}

export interface RepurposeIngestRecord {
  id: string;
  projectId: string;
  sourceMediaId: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  durationSeconds: number;
  width: number;
  height: number;
  sourceFingerprint: string;
  seekVerified: boolean;
  immutableOriginal: true;
  createdAt: string;
}

export interface RepurposeTranscriptRecord {
  id: string;
  projectId: string;
  ingestId: string;
  sourceMediaId: string;
  sourceFingerprint: string;
  model: string;
  durationSeconds: number;
  costUsd: number;
  segments: TranscriptSegment[];
  createdAt: string;
  updatedAt: string;
}

export interface RepurposeClipRecord {
  id: string;
  projectId: string;
  ingestId: string;
  transcriptId: string;
  title: string;
  rationale: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  quoteExcerpt: string;
  contextWarning: string | null;
  aspectRatio: ProjectAspectRatio;
  framingMode: "center-crop" | "fit-blur" | "speaker-track";
  captionsEnabled: boolean;
  approved: boolean;
  status: "proposed" | "reviewed" | "rendering" | "ready" | "failed";
  renderJobId: string | null;
  outputMediaId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClipRelativeCaptionCue {
  index: number;
  clipStartSeconds: number;
  clipEndSeconds: number;
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  speaker: string;
  text: string;
}

export interface RepurposeBatchExportManifest {
  batchId: string;
  projectId: string;
  ingestId: string;
  sourceMediaId: string;
  sourceFingerprint: string;
  maxConcurrency: number;
  createdAt: string;
  clips: {
    clipId: string;
    title: string;
    sourceStartSeconds: number;
    sourceEndSeconds: number;
    durationSeconds: number;
    status: RepurposeClipRecord["status"];
    renderJobId: string | null;
    outputMediaId: string | null;
    srt: string;
    vtt: string;
  }[];
}

// ==========================================
// Phase 13: Scoped AI Editing and Recovery
// ==========================================

export type ScopedEditCommandType =
  | "replace-scene-image"
  | "rewrite-hook"
  | "change-narration-keep-visuals"
  | "adjust-variant-cta"
  | "expand-clip-range";

export interface ScopedEditRequest {
  command: ScopedEditCommandType;
  targetSceneId?: string;
  targetVariantIds?: string[];
  targetClipId?: string;
  instruction: string;
  replacementValue?: string;
  newMediaId?: string;
  newStartSeconds?: number;
  newEndSeconds?: number;
  overrideLocks?: boolean;
  modelId?: AiModelId;
}

export interface ScopedEditLockConflict {
  sceneId: string;
  heading: string;
  lockedField: keyof SceneLocks;
  message: string;
}

export interface ScopedEditPlanRecord {
  id: string;
  projectId: string;
  baseVersion: number;
  inputFingerprint: string;
  command: ScopedEditCommandType;
  instruction: string;
  affectedComponents: string[];
  preservedComponents: string[];
  lockConflicts: ScopedEditLockConflict[];
  timingDeltaSeconds: number;
  requiredProviderJobs: ("ollama" | "deepgram-tts" | "image-gen" | "none")[];
  estimatedCostUsd: number;
  requiresConfirmation: boolean;
  status: "planned" | "applied" | "cancelled" | "restored";
  proposedDocument: ProjectDocumentV2;
  previousDocumentSnapshot: ProjectDocumentV2;
  createdAt: string;
  appliedAt: string | null;
}

export function formatSrtTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalMs = Math.round(clamped * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function formatVttTimestamp(seconds: number): string {
  return formatSrtTimestamp(seconds).replace(",", ".");
}

export function buildClipRelativeCues(
  segments: readonly TranscriptSegment[],
  clipStartSeconds: number,
  clipEndSeconds: number,
): ClipRelativeCaptionCue[] {
  const cues: ClipRelativeCaptionCue[] = [];
  for (const segment of segments) {
    if (segment.endSeconds <= clipStartSeconds || segment.startSeconds >= clipEndSeconds) {
      continue;
    }
    const overlapStart = Math.max(clipStartSeconds, segment.startSeconds);
    const overlapEnd = Math.min(clipEndSeconds, segment.endSeconds);
    if (overlapEnd <= overlapStart) continue;
    const text = (segment.correctedText || segment.originalText).trim();
    if (!text) continue;
    cues.push({
      index: cues.length + 1,
      clipStartSeconds: Number((overlapStart - clipStartSeconds).toFixed(3)),
      clipEndSeconds: Number((overlapEnd - clipStartSeconds).toFixed(3)),
      sourceStartSeconds: overlapStart,
      sourceEndSeconds: overlapEnd,
      speaker: segment.speaker,
      text,
    });
  }
  return cues;
}

export function renderCuesToSrt(cues: readonly ClipRelativeCaptionCue[]): string {
  return cues
    .map(
      (cue) =>
        `${cue.index}\n${formatSrtTimestamp(cue.clipStartSeconds)} --> ${formatSrtTimestamp(cue.clipEndSeconds)}\n${cue.text}`,
    )
    .join("\n\n");
}

export function renderCuesToVtt(cues: readonly ClipRelativeCaptionCue[]): string {
  const body = cues
    .map(
      (cue) =>
        `${formatVttTimestamp(cue.clipStartSeconds)} --> ${formatVttTimestamp(cue.clipEndSeconds)}\n${cue.text}`,
    )
    .join("\n\n");
  return body ? `WEBVTT\n\n${body}` : "WEBVTT\n";
}

export function findProhibitedWordingHits(
  text: string,
  prohibitedList: readonly string[],
): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  const defaultBanned = [
    "guaranteed results",
    "100% cure",
    "clinically proven miracle",
    "act now only 2 left",
    "fake review",
  ];
  for (const term of [...prohibitedList, ...defaultBanned]) {
    const clean = term.trim().toLowerCase();
    if (clean && lower.includes(clean) && !hits.includes(term.trim())) {
      hits.push(term.trim());
    }
  }
  return hits;
}

export function projectContentFingerprint(scenes: readonly SceneDraft[]): string {
  return scenes
    .map(
      (s) =>
        `${s.id}:${s.heading}:${s.body}:${s.visualDirection}:${s.onScreenText}:${s.durationSeconds}:${s.assetIds.join(",")}`,
    )
    .join("|");
}
