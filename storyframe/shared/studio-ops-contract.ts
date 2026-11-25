import type {
  ProjectAspectRatio,
  ProjectDocumentV2,
  ProjectPreset,
  ProjectRecord,
  ProjectType,
  VoicePreference,
} from "./project-contract";

// ==========================================
// Phase 16A: Backups
// ==========================================

export interface ProjectBackupMediaManifestItem {
  mediaId: string;
  kind: "image" | "video" | "audio";
  contentType: string;
  byteSize: number;
  sha256: string;
  relativePath: string;
}

export interface ProjectBackupBundle {
  bundleFormat: "storyframe-backup-v1";
  exportedAt: string;
  bundleChecksum: string;
  project: {
    originalId: string;
    projectType: ProjectType;
    title: string;
    schemaVersion: 2;
    version: number;
    document: ProjectDocumentV2;
  };
  mediaManifest: ProjectBackupMediaManifestItem[];
}

// ==========================================
// Phase 16B: Teams, Roles, Comments & Approvals
// ==========================================

export type WorkspaceRole = "owner" | "admin" | "editor" | "reviewer" | "viewer";

export interface WorkspaceMemberRecord {
  id: string;
  workspaceOwnerId: string;
  memberEmail: string;
  memberUserId: string | null;
  role: WorkspaceRole;
  status: "invited" | "active" | "revoked";
  inviteTokenHash: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface ProjectCommentRecord {
  id: string;
  projectId: string;
  sceneId: string | null;
  authorEmail: string;
  body: string;
  resolved: boolean;
  createdAt: string;
}

export interface FingerprintApprovalRecord {
  id: string;
  projectId: string;
  projectVersion: number;
  sceneId: string | null;
  contentFingerprint: string;
  approverEmail: string;
  role: WorkspaceRole;
  status: "approved" | "changes_requested" | "stale";
  note: string;
  createdAt: string;
}

// ==========================================
// Phase 16C: Brand Recipes
// ==========================================

export interface BrandRecipeRecord {
  id: string;
  ownerId: string;
  name: string;
  headingFont: string;
  bodyFont: string;
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  captionStyle: "minimal-lower" | "bold-center" | "boxed-highlight";
  voicePreference: VoicePreference;
  defaultPreset: ProjectPreset;
  pacingBeatsPerMinute: number;
  introText: string;
  outroText: string;
  approvedReferenceNotes: string;
  createdAt: string;
  updatedAt: string;
}

// ==========================================
// Phase 16D: Multi-Format Layouts (9:16, 1:1, 16:9)
// ==========================================

export interface FormatReframeSceneSetting {
  sceneId: string;
  heading: string;
  focalXPercent: number;
  focalYPercent: number;
  safeTextPosition: "top-safe" | "center-safe" | "bottom-safe";
  textVisibleVerified: boolean;
  productVisibleVerified: boolean;
  warning: string | null;
}

export interface ProjectFormatLayoutRecord {
  id: string;
  projectId: string;
  aspectRatio: ProjectAspectRatio;
  width: number;
  height: number;
  reviewed: boolean;
  allScenesValid: boolean;
  sceneSettings: FormatReframeSceneSetting[];
  updatedAt: string;
}

// ==========================================
// Phase 17: Launch Audit & Approved Release Gate
// ==========================================

export type AuditGateStatus = "PASS" | "FAIL" | "UNVERIFIED";

export interface LaunchAuditCheckItem {
  id: string;
  phase: string;
  category: "security" | "providers" | "database" | "storage" | "workflows" | "billing" | "recovery";
  title: string;
  status: AuditGateStatus;
  evidence: string;
  blocker: boolean;
}

export interface LaunchAuditReport {
  buildId: string;
  generatedAt: string;
  overallStatus: AuditGateStatus;
  releaseApproved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  deploymentTarget: string;
  rollbackProcedure: string[];
  operatingChecklist: string[];
  knownLimitations: string[];
  unresolvedCostAssumptions: string[];
  checks: LaunchAuditCheckItem[];
}

// ==========================================
// Phase 18: Long-Form Videos (3–5 minutes)
// ==========================================

export interface ProjectChapterRecord {
  id: string;
  projectId: string;
  chapterIndex: number;
  title: string;
  summary: string;
  targetDurationSeconds: number;
  continuityCarryover: string;
  outlineApproved: boolean;
  status: "outline" | "approved" | "generating" | "completed" | "failed";
  sceneIds: string[];
  updatedAt: string;
}

// ==========================================
// Phase 19: Multilingual Versions
// ==========================================

export interface LocalizationGlossaryTerm {
  sourceTerm: string;
  targetTerm: string;
  doNotTranslate: boolean;
}

export interface ProjectLocalizationRecord {
  id: string;
  projectId: string;
  baseVersion: number;
  languageCode: string;
  languageLabel: string;
  preserveOriginalClaims: true;
  glossary: LocalizationGlossaryTerm[];
  translatedScenes: {
    sceneId: string;
    originalBody: string;
    translatedBody: string;
    translatedOnScreenText: string;
    originalDurationSeconds: number;
    measuredTranslationDurationSeconds: number;
    proposedDurationAdjustmentSeconds: number;
  }[];
  status: "draft" | "reviewed" | "narration_ready";
  createdAt: string;
  updatedAt: string;
}

// ==========================================
// Phase 20: Publishing & Analytics
// ==========================================

export type PublishingPlatform = "youtube" | "tiktok" | "instagram" | "linkedin";

export interface PublishingJobRecord {
  id: string;
  projectId: string;
  renderJobId: string;
  platform: PublishingPlatform;
  accountHandle: string;
  title: string;
  description: string;
  tags: string[];
  visibility: "private" | "unlisted" | "public";
  scheduledFor: string | null;
  humanConfirmed: boolean;
  status: "awaiting_confirmation" | "scheduled" | "published" | "failed";
  externalPostUrl: string | null;
  analytics: {
    views: number;
    likes: number;
    comments: number;
    watchTimeMinutes: number;
    lastSyncedAt: string;
  } | null;
  createdAt: string;
}

// ==========================================
// Phase 21: Public API & Reusable Templates
// ==========================================

export type ApiKeyScope = "projects:read" | "projects:write" | "renders:write" | "webhooks:manage";

export interface ApiCredentialRecord {
  id: string;
  ownerId: string;
  label: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  rateLimitPerMinute: number;
  webhookUrl: string | null;
  webhookSigningSecretPrefix: string | null;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ProjectTemplateRecord {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  projectType: ProjectType;
  aspectRatio: ProjectAspectRatio;
  sanitizedPrivateAssets: true;
  templateDocument: ProjectDocumentV2;
  createdAt: string;
}

// ==========================================
// Phase 22: Load Testing & Disaster Recovery
// ==========================================

export type DisasterScenarioId =
  | "provider-outage"
  | "stuck-render-job"
  | "quota-exhaustion"
  | "billing-webhook-failure"
  | "storage-object-loss"
  | "secret-rotation"
  | "failed-migration-rollback";

export interface DisasterRecoveryDrillResult {
  id: string;
  scenario: DisasterScenarioId;
  title: string;
  simulatedFault: string;
  automatedMitigation: string;
  operatorRunbookSteps: string[];
  rtoTargetMinutes: number;
  rpoTargetMinutes: number;
  verified: boolean;
  executedAt: string;
}

export interface LoadTestSummaryResult {
  concurrentUsers: number;
  totalRequests: number;
  acceptedWithinBounds: number;
  throttledGracefully: number;
  p95LatencyMs: number;
  maxConcurrencyEnforced: boolean;
  idempotencyCollisionsPrevented: number;
  executedAt: string;
}

export function createSanitizedTemplateFromProject(
  project: ProjectRecord,
  name: string,
  description: string,
): Omit<ProjectTemplateRecord, "id" | "ownerId" | "createdAt"> {
  const sanitizedScenes = project.document.scenes.map((scene, index) => ({
    ...scene,
    id: `template-scene-${index + 1}`,
    assetIds: [],
    approved: false,
    approvedFingerprint: null,
  }));
  return {
    name: name.trim() || `${project.title} Template`,
    description: description.trim() || `Reusable ${project.projectType} template`,
    projectType: project.projectType,
    aspectRatio: "9:16",
    sanitizedPrivateAssets: true,
    templateDocument: {
      ...project.document,
      scenes: sanitizedScenes,
    },
  };
}
