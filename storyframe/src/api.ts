import type { AiErrorResponse, AiStatusResponse, AiTestSuccess } from "../shared/ai-contract";
import type {
  MediaPlayback,
  MediaRecord,
  MediaReferenceRecord,
  MediaUploadTicket,
} from "../shared/media-contract";
import type {
  GenerationProposalRecord,
  SourceKind,
  SourceRecord,
  SourceResponse,
  SourcesResponse,
} from "../shared/child-contract";
import type {
  PlanningAcceptedResponse,
  PlanningAttemptStatusResponse,
  PlanningStartRequest,
} from "../shared/planning-contract";
import type { ProjectExportPayload } from "../shared/project-export";
import type {
  StockImportRequest,
  StockImportResponse,
  StockProvider,
  StockSearchResponse,
  StockType,
} from "../shared/stock-contract";
import type {
  AudioSettingsInput,
  NarrationKind,
  NarrationStateResponse,
  NarrationTrackResponse,
  NarrationVoiceCatalogResponse,
} from "../shared/narration-contract";
import type {
  ImageEstimate,
  ImageEstimateResponse,
  ImageGenerationInput,
  ImageGenerationListResponse,
  ImageGenerationRecord,
  ImageGenerationResponse,
  ImageModelView,
  ImageModelsResponse,
  ImageUsageResponse,
  ImageUsageSummary,
} from "../shared/image-generation-contract";
import type {
  ProjectDeletedResponse,
  ProjectDocumentV2,
  ProjectListResponse,
  ProjectRecord,
  ProjectResponse,
  ProjectRevisionListResponse,
  ProjectRevisionSummary,
  ProjectSummary,
  ProjectType,
} from "../shared/project-contract";

export class AiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly upstreamStatus?: number;
  /** Structured recovery data, such as the job blocking a new generation. */
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    status: number,
    upstreamStatus?: number,
    details?: unknown,
  ) {
    super(message);
    this.name = "AiRequestError";
    this.code = code;
    this.status = status;
    this.upstreamStatus = upstreamStatus;
    this.details = details;
  }
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ body: T; headers: Headers }> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new AiRequestError("NETWORK_ERROR", "The StoryFrame development server could not be reached.", 0);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const parsed = body as AiErrorResponse | null;
    throw new AiRequestError(
      parsed?.error?.code ?? "HTTP_ERROR",
      parsed?.error?.message ?? `The server returned HTTP ${response.status}.`,
      response.status,
      parsed?.error?.upstreamStatus,
      parsed?.error?.details,
    );
  }

  return { body: body as T, headers: response.headers };
}

export function fetchStatus(): Promise<AiStatusResponse> {
  return requestJson<AiStatusResponse>("/api/ai/status").then(({ body }) => body);
}

async function authorizedJson<T>(
  path: string,
  accessToken: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: { Authorization: `Bearer ${accessToken}`, ...options.headers },
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  if (options.signal) init.signal = options.signal;
  return (await requestJson<T>(path, init)).body;
}

export async function listProjects(accessToken: string): Promise<ProjectSummary[]> {
  return (await authorizedJson<ProjectListResponse>("/api/projects", accessToken)).projects;
}

export async function createProject(
  accessToken: string,
  projectType: ProjectType,
  title: string,
  document: ProjectDocumentV2,
): Promise<ProjectRecord> {
  const body = await authorizedJson<ProjectResponse>("/api/projects", accessToken, {
    method: "POST",
    body: { projectType, title, document },
  });
  return body.project;
}

export async function getProject(accessToken: string, projectId: string): Promise<ProjectRecord> {
  return (await authorizedJson<ProjectResponse>(`/api/projects/${projectId}`, accessToken)).project;
}

export async function updateProject(
  accessToken: string,
  projectId: string,
  update: { title: string; document: ProjectDocumentV2; version: number },
): Promise<ProjectRecord> {
  const body = await authorizedJson<ProjectResponse>(`/api/projects/${projectId}`, accessToken, {
    method: "PUT",
    body: update,
  });
  return body.project;
}

export async function deleteProject(accessToken: string, projectId: string): Promise<string> {
  const body = await authorizedJson<ProjectDeletedResponse>(`/api/projects/${projectId}`, accessToken, {
    method: "DELETE",
  });
  return body.deletedId;
}

export async function listProjectRevisions(
  accessToken: string,
  projectId: string,
): Promise<ProjectRevisionSummary[]> {
  return (
    await authorizedJson<ProjectRevisionListResponse>(`/api/projects/${projectId}/revisions`, accessToken)
  ).revisions;
}

export async function listProjectMedia(accessToken: string, projectId: string): Promise<MediaRecord[]> {
  return (await authorizedJson<{ ok: true; media: MediaRecord[] }>(`/api/projects/${projectId}/media`, accessToken))
    .media;
}

export interface MediaInitiation {
  media: MediaRecord;
  upload: MediaUploadTicket;
}

export async function listNarrationVoices(accessToken: string): Promise<NarrationVoiceCatalogResponse> {
  return authorizedJson<NarrationVoiceCatalogResponse>("/api/narration/voices", accessToken);
}

export async function getNarrationState(
  accessToken: string,
  projectId: string,
): Promise<NarrationStateResponse> {
  return authorizedJson<NarrationStateResponse>(`/api/projects/${projectId}/narration`, accessToken);
}

export async function generateNarration(
  accessToken: string,
  projectId: string,
  voiceModel: string,
): Promise<NarrationTrackResponse> {
  return authorizedJson<NarrationTrackResponse>(`/api/projects/${projectId}/narration`, accessToken, {
    method: "POST",
    body: { voiceModel },
  });
}

export async function attachAudioTrack(
  accessToken: string,
  projectId: string,
  kind: NarrationKind,
  mediaId: string,
): Promise<NarrationTrackResponse> {
  const path =
    kind === "music"
      ? `/api/projects/${projectId}/music`
      : `/api/projects/${projectId}/narration/upload`;
  return authorizedJson<NarrationTrackResponse>(path, accessToken, {
    method: "POST",
    body: { mediaId },
  });
}

export async function updateAudioSettings(
  accessToken: string,
  projectId: string,
  kind: NarrationKind,
  patch: AudioSettingsInput,
): Promise<NarrationTrackResponse> {
  return authorizedJson<NarrationTrackResponse>(`/api/projects/${projectId}/${kind}`, accessToken, {
    method: "PATCH",
    body: patch,
  });
}

export async function removeAudioTrack(
  accessToken: string,
  projectId: string,
  kind: NarrationKind,
): Promise<{ ok: true; track: NarrationTrackResponse["track"] }> {
  return authorizedJson(`/api/projects/${projectId}/${kind}`, accessToken, { method: "DELETE" });
}

/** Fetches preview audio bytes; a provider error is still JSON and becomes AiRequestError. */
export async function previewNarrationVoice(
  accessToken: string,
  projectId: string,
  voiceModel: string,
): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(`/api/projects/${projectId}/narration/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ voiceModel }),
    });
  } catch {
    throw new AiRequestError("NETWORK_ERROR", "The StoryFrame development server could not be reached.", 0);
  }
  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as AiErrorResponse | null;
    throw new AiRequestError(
      parsed?.error?.code ?? "HTTP_ERROR",
      parsed?.error?.message ?? `The server returned HTTP ${response.status}.`,
      response.status,
    );
  }
  return response.blob();
}

export async function initiateMediaUpload(
  accessToken: string,
  projectId: string,
  write: { kind: MediaRecord["kind"]; contentType: string; byteSize: number; sceneKey?: string },
): Promise<MediaInitiation> {
  const body = await authorizedJson<{ ok: true; media: MediaRecord; upload: MediaUploadTicket }>(
    `/api/projects/${projectId}/media`,
    accessToken,
    { method: "POST", body: write },
  );
  return { media: body.media, upload: body.upload };
}

export async function uploadMediaObject(ticket: MediaUploadTicket, file: File): Promise<void> {
  let response: Response;
  try {
    response = await fetch(ticket.url, {
      method: ticket.method,
      headers: ticket.headers,
      body: file,
    });
  } catch {
    throw new AiRequestError("NETWORK_ERROR", "The private upload endpoint could not be reached.", 0);
  }
  if (!response.ok) {
    throw new AiRequestError(
      "UPLOAD_FAILED",
      `The private upload failed with HTTP ${response.status}.`,
      response.status,
    );
  }
}

export async function completeMediaUpload(
  accessToken: string,
  projectId: string,
  mediaId: string,
): Promise<MediaRecord> {
  return (
    await authorizedJson<{ ok: true; media: MediaRecord }>(
      `/api/projects/${projectId}/media/${mediaId}/complete`,
      accessToken,
      { method: "POST", body: {} },
    )
  ).media;
}

export async function getMediaPlaybackUrl(
  accessToken: string,
  projectId: string,
  mediaId: string,
): Promise<MediaPlayback> {
  return authorizedJson<MediaPlayback & { ok: true }>(
    `/api/projects/${projectId}/media/${mediaId}/url`,
    accessToken,
  );
}

export async function attachMediaReference(
  accessToken: string,
  projectId: string,
  mediaId: string,
  reference: { refKind: "scene"; refId: string },
): Promise<MediaReferenceRecord> {
  return (
    await authorizedJson<{ ok: true; reference: MediaReferenceRecord }>(
      `/api/projects/${projectId}/media/${mediaId}/references`,
      accessToken,
      { method: "POST", body: reference },
    )
  ).reference;
}

export async function listMediaReferences(
  accessToken: string,
  projectId: string,
  mediaId: string,
): Promise<MediaReferenceRecord[]> {
  return (
    await authorizedJson<{ ok: true; references: MediaReferenceRecord[] }>(
      `/api/projects/${projectId}/media/${mediaId}/references`,
      accessToken,
    )
  ).references;
}

export async function deleteMediaReference(
  accessToken: string,
  projectId: string,
  mediaId: string,
  referenceId: string,
): Promise<string> {
  const body = await authorizedJson<{ ok: true; deletedId: string }>(
    `/api/projects/${projectId}/media/${mediaId}/references/${referenceId}`,
    accessToken,
    { method: "DELETE" },
  );
  return body.deletedId;
}

export async function deleteMediaRecord(
  accessToken: string,
  projectId: string,
  mediaId: string,
): Promise<string> {
  const body = await authorizedJson<{ ok: true; deletedId: string }>(
    `/api/projects/${projectId}/media/${mediaId}`,
    accessToken,
    { method: "DELETE" },
  );
  return body.deletedId;
}

export async function listImageModels(accessToken: string): Promise<ImageModelView[]> {
  return (await authorizedJson<ImageModelsResponse>("/api/image-models", accessToken)).models;
}

export async function getImageUsage(accessToken: string): Promise<ImageUsageResponse> {
  return authorizedJson<ImageUsageResponse>("/api/image-usage", accessToken);
}

export async function estimateImageGeneration(
  accessToken: string,
  projectId: string,
  input: ImageGenerationInput,
): Promise<ImageEstimate> {
  return (
    await authorizedJson<ImageEstimateResponse>(
      `/api/projects/${projectId}/image-generations/estimate`,
      accessToken,
      { method: "POST", body: input },
    )
  ).estimate;
}

export async function createImageGeneration(
  accessToken: string,
  projectId: string,
  input: ImageGenerationInput,
): Promise<ImageGenerationResponse> {
  return authorizedJson<ImageGenerationResponse>(`/api/projects/${projectId}/image-generations`, accessToken, {
    method: "POST",
    body: input,
  });
}

export async function settleImageGeneration(
  accessToken: string,
  projectId: string,
  generationId: string,
): Promise<ImageGenerationResponse> {
  return authorizedJson<ImageGenerationResponse>(
    `/api/projects/${projectId}/image-generations/${generationId}/settle`,
    accessToken,
    { method: "POST", body: {} },
  );
}

export async function refreshImageGeneration(
  accessToken: string,
  projectId: string,
  generationId: string,
): Promise<ImageGenerationResponse> {
  return authorizedJson<ImageGenerationResponse>(
    `/api/projects/${projectId}/image-generations/${generationId}/refresh`,
    accessToken,
    { method: "POST", body: {} },
  );
}

export async function listImageGenerations(
  accessToken: string,
  projectId: string,
): Promise<ImageGenerationRecord[]> {
  return (
    await authorizedJson<ImageGenerationListResponse>(
      `/api/projects/${projectId}/image-generations`,
      accessToken,
    )
  ).generations;
}

export interface StockSearchQuery {
  query: string;
  type: StockType;
  sources: StockProvider[];
  page?: number;
}

export async function searchStock(
  accessToken: string,
  query: StockSearchQuery,
): Promise<StockSearchResponse> {
  const params = new URLSearchParams({
    q: query.query,
    type: query.type,
    sources: query.sources.join(","),
  });
  if (query.page !== undefined && query.page > 1) params.set("page", String(query.page));
  return authorizedJson<StockSearchResponse>(`/api/stock/search?${params.toString()}`, accessToken);
}

export async function importStockAsset(
  accessToken: string,
  projectId: string,
  request: StockImportRequest,
): Promise<StockImportResponse> {
  return authorizedJson<StockImportResponse>(`/api/projects/${projectId}/stock/import`, accessToken, {
    method: "POST",
    body: request,
  });
}

export async function exportProject(
  accessToken: string,
  projectId: string,
  title: string,
  document: ProjectDocumentV2,
): Promise<ProjectExportPayload> {
  const body = await authorizedJson<{ ok: true; export: ProjectExportPayload }>(
    `/api/projects/${projectId}/export`,
    accessToken,
    { method: "POST", body: { title, document } },
  );
  return body.export;
}

export async function listProjectSources(
  accessToken: string,
  projectId: string,
): Promise<SourceRecord[]> {
  return (
    await authorizedJson<SourcesResponse>(`/api/projects/${projectId}/sources`, accessToken)
  ).sources;
}

export async function createProjectSource(
  accessToken: string,
  projectId: string,
  write: { kind: SourceKind; title: string; url: string | null; excerpt: string | null },
): Promise<SourceRecord> {
  return (
    await authorizedJson<SourceResponse>(`/api/projects/${projectId}/sources`, accessToken, {
      method: "POST",
      body: write,
    })
  ).source;
}

export async function deleteProjectSource(
  accessToken: string,
  projectId: string,
  sourceId: string,
): Promise<string> {
  return (
    await authorizedJson<{ ok: true; deletedId: string }>(
      `/api/projects/${projectId}/sources/${sourceId}`,
      accessToken,
      { method: "DELETE" },
    )
  ).deletedId;
}

export async function listProjectProposals(
  accessToken: string,
  projectId: string,
): Promise<GenerationProposalRecord[]> {
  return (
    await authorizedJson<{ ok: true; proposals: GenerationProposalRecord[] }>(
      `/api/projects/${projectId}/proposals`,
      accessToken,
    )
  ).proposals;
}

export async function getPlanningAttemptStatus(
  accessToken: string,
  projectId: string,
): Promise<PlanningAttemptStatusResponse> {
  return authorizedJson<PlanningAttemptStatusResponse>(
    `/api/projects/${projectId}/planning/status`,
    accessToken,
  );
}

export async function generatePlanningProposal(
  accessToken: string,
  projectId: string,
  request: PlanningStartRequest,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<GenerationProposalRecord> {
  return (
    await authorizedJson<{ ok: true; proposal: GenerationProposalRecord }>(
      `/api/projects/${projectId}/planning`,
      accessToken,
      { method: "POST", body: request, headers: { "Idempotency-Key": idempotencyKey }, signal },
    )
  ).proposal;
}

export async function deletePlanningProposal(
  accessToken: string,
  projectId: string,
  proposalId: string,
): Promise<string> {
  return (
    await authorizedJson<{ ok: true; deletedId: string }>(
      `/api/projects/${projectId}/proposals/${proposalId}`,
      accessToken,
      { method: "DELETE" },
    )
  ).deletedId;
}

export async function acceptPlanningProposal(
  accessToken: string,
  projectId: string,
  proposalId: string,
): Promise<PlanningAcceptedResponse> {
  return authorizedJson<PlanningAcceptedResponse>(
    `/api/projects/${projectId}/proposals/${proposalId}/accept`,
    accessToken,
    { method: "POST", body: {} },
  );
}

export async function rejectPlanningProposal(
  accessToken: string,
  projectId: string,
  proposalId: string,
): Promise<GenerationProposalRecord> {
  return (
    await authorizedJson<{ ok: true; proposal: GenerationProposalRecord }>(
      `/api/projects/${projectId}/proposals/${proposalId}`,
      accessToken,
      { method: "PATCH", body: { status: "rejected" } },
    )
  ).proposal;
}

export interface AiTestOutcome {
  result: AiTestSuccess;
  /** False when the server returned the reply but could not record its usage. */
  usageRecorded: boolean;
}

export async function runModelTest(
  accessToken: string,
  model: string,
  prompt: string,
  idempotencyKey: string,
): Promise<AiTestOutcome> {
  const { body, headers } = await requestJson<AiTestSuccess>("/api/ai/test", {
    method: "POST",
    headers: {
      ...(accessToken.trim() ? { Authorization: `Bearer ${accessToken.trim()}` } : {}),
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ model, prompt }),
  });

  return { result: body, usageRecorded: headers.get("X-Storyframe-Usage") !== "unrecorded" };
}

// ==========================================
// Phases 9–22 & Discover Ideas (D1–D6) Client API
// ==========================================

import type {
  CompiledRenderSnapshot,
  RenderJobRecord,
} from "../shared/render-contract";
import type {
  AdCampaignRecord,
  AdConceptProposal,
  AdVariantExportManifest,
  AdVariantRecord,
  ModeAContinuityNotes,
  ModeAReadinessChecklist,
  ProductCatalogRecord,
  RepurposeBatchExportManifest,
  RepurposeClipRecord,
  RepurposeIngestRecord,
  RepurposeTranscriptRecord,
  ScopedEditPlanRecord,
  ScopedEditRequest,
} from "../shared/workflows-contract";
import type {
  BillingInterval,
  CostProviderName,
  PreWorkChargeQuote,
  ProjectCostSummary,
  ProviderRateCardEntry,
  SubscriptionPlanDefinition,
  SubscriptionPlanId,
  UserEntitlementRecord,
} from "../shared/billing-contract";
import type {
  DiscoveryEventRecord,
  DiscoveryIdeaRecord,
  DiscoveryPreferencesRecord,
  IdeaFeedbackReason,
  IdeaFormatTrack,
  IdeaProjectDraftPreview,
  TrendEvidenceIngestionResult,
} from "../shared/discovery-contract";
import type {
  ApiCredentialRecord,
  ApiKeyScope,
  BrandRecipeRecord,
  DisasterRecoveryDrillResult,
  DisasterScenarioId,
  FingerprintApprovalRecord,
  LaunchAuditReport,
  LoadTestSummaryResult,
  ProjectBackupBundle,
  ProjectChapterRecord,
  ProjectCommentRecord,
  ProjectFormatLayoutRecord,
  ProjectLocalizationRecord,
  ProjectTemplateRecord,
  PublishingJobRecord,
  PublishingPlatform,
  WorkspaceMemberRecord,
  WorkspaceRole,
} from "../shared/studio-ops-contract";
import type { ProjectAspectRatio } from "../shared/project-contract";

export async function listRenderJobs(
  accessToken: string,
  projectId: string,
): Promise<RenderJobRecord[]> {
  const res = await authorizedJson<{ ok: true; jobs: RenderJobRecord[] }>(
    `/api/projects/${projectId}/renders-v2`,
    accessToken,
  );
  return res.jobs;
}

export async function compileProjectRender(
  accessToken: string,
  projectId: string,
  options: { aspectRatio?: ProjectAspectRatio; allowUnresolvedClaims?: boolean } = {},
): Promise<CompiledRenderSnapshot> {
  const res = await authorizedJson<{ ok: true; snapshot: CompiledRenderSnapshot }>(
    `/api/projects/${projectId}/renders-v2/compile`,
    accessToken,
    { method: "POST", body: options },
  );
  return res.snapshot;
}

export async function submitProjectRender(
  accessToken: string,
  projectId: string,
  options: { aspectRatio?: ProjectAspectRatio; allowUnresolvedClaims?: boolean },
  idempotencyKey: string,
): Promise<{ job: RenderJobRecord; replayed: boolean }> {
  const res = await authorizedJson<{ ok: true; job: RenderJobRecord; replayed?: boolean }>(
    `/api/projects/${projectId}/renders-v2/submit`,
    accessToken,
    {
      method: "POST",
      body: options,
      headers: { "Idempotency-Key": idempotencyKey },
    },
  );
  return { job: res.job, replayed: Boolean(res.replayed) };
}

export async function pollProjectRenderJob(
  accessToken: string,
  projectId: string,
  jobId: string,
): Promise<RenderJobRecord> {
  const res = await authorizedJson<{ ok: true; job: RenderJobRecord }>(
    `/api/projects/${projectId}/renders-v2/${jobId}/poll`,
    accessToken,
    { method: "POST", body: {} },
  );
  return res.job;
}

export async function getModeAReadiness(
  accessToken: string,
  projectId: string,
): Promise<ModeAReadinessChecklist> {
  const res = await authorizedJson<{ ok: true; checklist: ModeAReadinessChecklist }>(
    `/api/projects/${projectId}/workflow/mode-a`,
    accessToken,
  );
  return res.checklist;
}

export async function saveModeAContinuity(
  accessToken: string,
  projectId: string,
  notes: { characters: string; setting: string; continuityRules: string },
): Promise<ModeAContinuityNotes> {
  const res = await authorizedJson<{ ok: true; continuity: ModeAContinuityNotes }>(
    `/api/projects/${projectId}/workflow/mode-a/continuity`,
    accessToken,
    { method: "PUT", body: notes },
  );
  return res.continuity;
}

export async function getModeBState(
  accessToken: string,
  projectId: string,
): Promise<{
  product: ProductCatalogRecord;
  campaign: AdCampaignRecord;
  concepts: AdConceptProposal[];
  variants: AdVariantRecord[];
}> {
  return authorizedJson(
    `/api/projects/${projectId}/workflow/mode-b`,
    accessToken,
  );
}

export async function saveModeBProduct(
  accessToken: string,
  projectId: string,
  patch: Partial<ProductCatalogRecord>,
): Promise<ProductCatalogRecord> {
  const res = await authorizedJson<{ ok: true; product: ProductCatalogRecord }>(
    `/api/projects/${projectId}/workflow/mode-b/product`,
    accessToken,
    { method: "PUT", body: patch },
  );
  return res.product;
}

export async function saveModeBCampaign(
  accessToken: string,
  projectId: string,
  patch: Partial<AdCampaignRecord>,
): Promise<AdCampaignRecord> {
  const res = await authorizedJson<{ ok: true; campaign: AdCampaignRecord }>(
    `/api/projects/${projectId}/workflow/mode-b/campaign`,
    accessToken,
    { method: "PUT", body: patch },
  );
  return res.campaign;
}

export async function generateModeBConcepts(
  accessToken: string,
  projectId: string,
): Promise<AdConceptProposal[]> {
  const res = await authorizedJson<{ ok: true; concepts: AdConceptProposal[] }>(
    `/api/projects/${projectId}/workflow/mode-b/concepts`,
    accessToken,
    { method: "POST", body: {} },
  );
  return res.concepts;
}

export async function createModeBVariant(
  accessToken: string,
  projectId: string,
  input: {
    conceptId?: string;
    label: string;
    hookText: string;
    ctaText: string;
    layoutStyle: "product-hero" | "split-comparison" | "floating-card";
    aspectRatio?: ProjectAspectRatio;
  },
): Promise<AdVariantRecord> {
  const res = await authorizedJson<{ ok: true; variant: AdVariantRecord }>(
    `/api/projects/${projectId}/workflow/mode-b/variants`,
    accessToken,
    { method: "POST", body: input },
  );
  return res.variant;
}

export async function exportModeBManifest(
  accessToken: string,
  projectId: string,
): Promise<AdVariantExportManifest> {
  const res = await authorizedJson<{ ok: true; manifest: AdVariantExportManifest }>(
    `/api/projects/${projectId}/workflow/mode-b/manifest`,
    accessToken,
  );
  return res.manifest;
}

export async function getModeCState(
  accessToken: string,
  projectId: string,
): Promise<{
  ingests: RepurposeIngestRecord[];
  transcripts: RepurposeTranscriptRecord[];
  clips: RepurposeClipRecord[];
}> {
  return authorizedJson(
    `/api/projects/${projectId}/workflow/mode-c`,
    accessToken,
  );
}

export async function createModeCIngest(
  accessToken: string,
  projectId: string,
  input: {
    sourceMediaId: string;
    fileName: string;
    contentType: string;
    byteSize: number;
    durationSeconds: number;
  },
): Promise<RepurposeIngestRecord> {
  const res = await authorizedJson<{ ok: true; ingest: RepurposeIngestRecord }>(
    `/api/projects/${projectId}/workflow/mode-c/ingest`,
    accessToken,
    { method: "POST", body: input },
  );
  return res.ingest;
}

export async function transcribeModeCIngest(
  accessToken: string,
  projectId: string,
  ingestId: string,
): Promise<RepurposeTranscriptRecord> {
  const res = await authorizedJson<{ ok: true; transcript: RepurposeTranscriptRecord }>(
    `/api/projects/${projectId}/workflow/mode-c/transcribe`,
    accessToken,
    { method: "POST", body: { ingestId } },
  );
  return res.transcript;
}

export async function updateModeCTranscriptSegment(
  accessToken: string,
  projectId: string,
  input: { transcriptId: string; segmentId: string; correctedText: string },
): Promise<RepurposeTranscriptRecord> {
  const res = await authorizedJson<{ ok: true; transcript: RepurposeTranscriptRecord }>(
    `/api/projects/${projectId}/workflow/mode-c/transcript-segment`,
    accessToken,
    { method: "PATCH", body: input },
  );
  return res.transcript;
}

export async function proposeModeCClips(
  accessToken: string,
  projectId: string,
  transcriptId: string,
): Promise<RepurposeClipRecord[]> {
  const res = await authorizedJson<{ ok: true; clips: RepurposeClipRecord[] }>(
    `/api/projects/${projectId}/workflow/mode-c/propose-clips`,
    accessToken,
    { method: "POST", body: { transcriptId } },
  );
  return res.clips;
}

export async function updateModeCClip(
  accessToken: string,
  projectId: string,
  clipId: string,
  patch: Partial<RepurposeClipRecord>,
): Promise<RepurposeClipRecord> {
  const res = await authorizedJson<{ ok: true; clip: RepurposeClipRecord }>(
    `/api/projects/${projectId}/workflow/mode-c/clips/${clipId}`,
    accessToken,
    { method: "PATCH", body: patch },
  );
  return res.clip;
}

export async function runModeCBatchExport(
  accessToken: string,
  projectId: string,
  clipIds?: string[],
): Promise<RepurposeBatchExportManifest> {
  const res = await authorizedJson<{ ok: true; manifest: RepurposeBatchExportManifest }>(
    `/api/projects/${projectId}/workflow/mode-c/batch-export`,
    accessToken,
    { method: "POST", body: { clipIds } },
  );
  return res.manifest;
}

export async function listScopedEditPlans(
  accessToken: string,
  projectId: string,
): Promise<ScopedEditPlanRecord[]> {
  const res = await authorizedJson<{ ok: true; plans: ScopedEditPlanRecord[] }>(
    `/api/projects/${projectId}/workflow/scoped-edits`,
    accessToken,
  );
  return res.plans;
}

export async function createScopedEditPlan(
  accessToken: string,
  projectId: string,
  request: ScopedEditRequest,
): Promise<ScopedEditPlanRecord> {
  const res = await authorizedJson<{ ok: true; plan: ScopedEditPlanRecord }>(
    `/api/projects/${projectId}/workflow/scoped-edits/plan`,
    accessToken,
    { method: "POST", body: request },
  );
  return res.plan;
}

export async function applyScopedEditPlan(
  accessToken: string,
  projectId: string,
  planId: string,
  confirm = true,
): Promise<{ plan: ScopedEditPlanRecord; project: ProjectRecord }> {
  return authorizedJson(
    `/api/projects/${projectId}/workflow/scoped-edits/${planId}/apply`,
    accessToken,
    { method: "POST", body: { confirm } },
  );
}

export async function restoreScopedEditPlan(
  accessToken: string,
  projectId: string,
  planId: string,
): Promise<{ plan: ScopedEditPlanRecord; project: ProjectRecord }> {
  return authorizedJson(
    `/api/projects/${projectId}/workflow/scoped-edits/${planId}/restore`,
    accessToken,
    { method: "POST", body: {} },
  );
}

export async function getProjectStudioOverview(
  accessToken: string,
  projectId: string,
): Promise<{
  costSummary: ProjectCostSummary;
  formats: ProjectFormatLayoutRecord[];
  comments: ProjectCommentRecord[];
  approvals: FingerprintApprovalRecord[];
  chapters: ProjectChapterRecord[];
  localizations: ProjectLocalizationRecord[];
  publishingJobs: PublishingJobRecord[];
}> {
  return authorizedJson(
    `/api/projects/${projectId}/studio/overview`,
    accessToken,
  );
}

export async function exportProjectBackup(
  accessToken: string,
  projectId: string,
): Promise<ProjectBackupBundle> {
  const res = await authorizedJson<{ ok: true; bundle: ProjectBackupBundle }>(
    `/api/projects/${projectId}/studio/backup`,
    accessToken,
  );
  return res.bundle;
}

export async function updateProjectFormatReview(
  accessToken: string,
  projectId: string,
  aspectRatio: ProjectAspectRatio,
  reviewed: boolean,
): Promise<ProjectFormatLayoutRecord> {
  const res = await authorizedJson<{ ok: true; format: ProjectFormatLayoutRecord }>(
    `/api/projects/${projectId}/studio/formats`,
    accessToken,
    { method: "PUT", body: { aspectRatio, reviewed } },
  );
  return res.format;
}

export async function addProjectComment(
  accessToken: string,
  projectId: string,
  input: { sceneId?: string | null; body: string },
): Promise<ProjectCommentRecord> {
  const res = await authorizedJson<{ ok: true; comment: ProjectCommentRecord }>(
    `/api/projects/${projectId}/studio/comments`,
    accessToken,
    { method: "POST", body: input },
  );
  return res.comment;
}

export async function addProjectApproval(
  accessToken: string,
  projectId: string,
  input: {
    sceneId?: string | null;
    role?: WorkspaceRole;
    status: "approved" | "changes_requested";
    note: string;
  },
): Promise<FingerprintApprovalRecord> {
  const res = await authorizedJson<{ ok: true; approval: FingerprintApprovalRecord }>(
    `/api/projects/${projectId}/studio/approvals`,
    accessToken,
    { method: "POST", body: input },
  );
  return res.approval;
}

export async function generateProjectChapters(
  accessToken: string,
  projectId: string,
  targetTotalSeconds = 240,
): Promise<ProjectChapterRecord[]> {
  const res = await authorizedJson<{ ok: true; chapters: ProjectChapterRecord[] }>(
    `/api/projects/${projectId}/studio/chapters`,
    accessToken,
    { method: "POST", body: { targetTotalSeconds } },
  );
  return res.chapters;
}

export async function approveProjectChapter(
  accessToken: string,
  projectId: string,
  chapterId: string,
): Promise<ProjectChapterRecord> {
  const res = await authorizedJson<{ ok: true; chapter: ProjectChapterRecord }>(
    `/api/projects/${projectId}/studio/chapters/${chapterId}/approve`,
    accessToken,
    { method: "POST", body: {} },
  );
  return res.chapter;
}

export async function createProjectLocalization(
  accessToken: string,
  projectId: string,
  input: { languageCode: string; languageLabel: string },
): Promise<ProjectLocalizationRecord> {
  const res = await authorizedJson<{ ok: true; localization: ProjectLocalizationRecord }>(
    `/api/projects/${projectId}/studio/localizations`,
    accessToken,
    { method: "POST", body: input },
  );
  return res.localization;
}

export async function publishProjectRender(
  accessToken: string,
  projectId: string,
  input: {
    renderJobId: string;
    platform: PublishingPlatform;
    accountHandle: string;
    title: string;
    description: string;
    tags: string[];
    visibility: "private" | "unlisted" | "public";
    scheduledFor: string | null;
    humanConfirmed: boolean;
  },
): Promise<PublishingJobRecord> {
  const res = await authorizedJson<{ ok: true; publishingJob: PublishingJobRecord }>(
    `/api/projects/${projectId}/studio/publish`,
    accessToken,
    { method: "POST", body: input },
  );
  return res.publishingJob;
}

export async function saveProjectTemplate(
  accessToken: string,
  projectId: string,
  input: { name: string; description: string },
): Promise<ProjectTemplateRecord> {
  const res = await authorizedJson<{ ok: true; template: ProjectTemplateRecord }>(
    `/api/projects/${projectId}/studio/save-template`,
    accessToken,
    { method: "POST", body: input },
  );
  return res.template;
}

export async function getDiscoveryState(
  accessToken: string,
): Promise<{
  preferences: DiscoveryPreferencesRecord;
  evidenceResult: TrendEvidenceIngestionResult;
  ideas: DiscoveryIdeaRecord[];
  events: DiscoveryEventRecord[];
}> {
  return authorizedJson("/api/discovery/state", accessToken);
}

export async function saveDiscoveryPreferences(
  accessToken: string,
  patch: Partial<DiscoveryPreferencesRecord>,
): Promise<DiscoveryPreferencesRecord> {
  const res = await authorizedJson<{ ok: true; preferences: DiscoveryPreferencesRecord }>(
    "/api/discovery/preferences",
    accessToken,
    { method: "PUT", body: patch },
  );
  return res.preferences;
}

export async function generateDiscoveryIdeas(
  accessToken: string,
  input: { formatTrack: IdeaFormatTrack; refreshExternalEvidence?: boolean },
): Promise<{
  batchId: string;
  evidenceResult: TrendEvidenceIngestionResult;
  ideas: DiscoveryIdeaRecord[];
}> {
  return authorizedJson("/api/discovery/generate", accessToken, {
    method: "POST",
    body: input,
  });
}

export async function sendDiscoveryIdeaFeedback(
  accessToken: string,
  ideaId: string,
  input: {
    action: "save" | "dismiss" | "replace" | "feedback" | "edit-prompt";
    reason?: IdeaFeedbackReason;
    customPromptNote?: string;
  },
): Promise<{
  updatedIdea: DiscoveryIdeaRecord;
  replacementIdea: DiscoveryIdeaRecord | null;
  ideas: DiscoveryIdeaRecord[];
}> {
  return authorizedJson(`/api/discovery/ideas/${ideaId}/feedback`, accessToken, {
    method: "POST",
    body: input,
  });
}

export async function createProjectFromDiscoveryIdea(
  accessToken: string,
  ideaId: string,
  input: {
    previewOnly?: boolean;
    title?: string;
    projectType?: "story" | "product-ad" | "repurpose";
    mode?: "factual" | "fiction";
    targetDurationSeconds?: number;
    aspectRatio?: ProjectAspectRatio;
  },
): Promise<{
  project?: ProjectRecord;
  idea?: DiscoveryIdeaRecord;
  draft: IdeaProjectDraftPreview;
}> {
  return authorizedJson(`/api/discovery/ideas/${ideaId}/create-project`, accessToken, {
    method: "POST",
    body: input,
  });
}

export async function getGlobalStudioState(
  accessToken: string,
  projectId?: string,
): Promise<{
  rateCard: ProviderRateCardEntry[];
  plans: SubscriptionPlanDefinition[];
  entitlement: UserEntitlementRecord;
  costSummary: ProjectCostSummary;
  members: WorkspaceMemberRecord[];
  brandRecipes: BrandRecipeRecord[];
  apiCredentials: ApiCredentialRecord[];
  templates: ProjectTemplateRecord[];
  drDrills: DisasterRecoveryDrillResult[];
  lastLoadTest: LoadTestSummaryResult | null;
  launchAudit: LaunchAuditReport;
}> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return authorizedJson(`/api/studio/state${query}`, accessToken);
}

export async function updateStudioBillingPlan(
  accessToken: string,
  input: {
    planId: SubscriptionPlanId;
    billingInterval: BillingInterval;
    autoTopUpEnabled?: boolean;
    spendingCeilingUsd?: number | null;
  },
): Promise<UserEntitlementRecord> {
  const res = await authorizedJson<{ ok: true; entitlement: UserEntitlementRecord }>(
    "/api/studio/billing/plan",
    accessToken,
    { method: "PUT", body: input },
  );
  return res.entitlement;
}

export async function quoteStudioCharge(
  accessToken: string,
  input: {
    operation: string;
    provider: CostProviderName;
    modelOrTier: string;
    units: number;
  },
): Promise<PreWorkChargeQuote> {
  const res = await authorizedJson<{ ok: true; quote: PreWorkChargeQuote }>(
    "/api/studio/billing/quote",
    accessToken,
    { method: "POST", body: input },
  );
  return res.quote;
}

export async function importProjectBackupBundle(
  accessToken: string,
  bundle: ProjectBackupBundle,
): Promise<ProjectRecord> {
  const res = await authorizedJson<{ ok: true; project: ProjectRecord }>(
    "/api/studio/backup/import",
    accessToken,
    { method: "POST", body: { bundle } },
  );
  return res.project;
}

export async function inviteStudioMember(
  accessToken: string,
  input: { email: string; role: WorkspaceRole },
): Promise<WorkspaceMemberRecord> {
  const res = await authorizedJson<{ ok: true; member: WorkspaceMemberRecord }>(
    "/api/studio/team/invite",
    accessToken,
    { method: "POST", body: input },
  );
  return res.member;
}

export async function revokeStudioMember(
  accessToken: string,
  memberId: string,
): Promise<WorkspaceMemberRecord> {
  const res = await authorizedJson<{ ok: true; member: WorkspaceMemberRecord }>(
    `/api/studio/team/${memberId}/revoke`,
    accessToken,
    { method: "POST", body: {} },
  );
  return res.member;
}

export async function createStudioBrandRecipe(
  accessToken: string,
  input: Omit<BrandRecipeRecord, "id" | "ownerId" | "createdAt" | "updatedAt">,
): Promise<BrandRecipeRecord> {
  const res = await authorizedJson<{ ok: true; brandRecipe: BrandRecipeRecord }>(
    "/api/studio/brands",
    accessToken,
    { method: "POST", body: input },
  );
  return res.brandRecipe;
}

export async function issueStudioApiKey(
  accessToken: string,
  input: { label: string; scopes: ApiKeyScope[]; webhookUrl?: string | null },
): Promise<{ credential: ApiCredentialRecord; plainTextKeyOnce: string }> {
  return authorizedJson("/api/studio/api-keys", accessToken, {
    method: "POST",
    body: input,
  });
}

export async function revokeStudioApiKey(
  accessToken: string,
  credentialId: string,
): Promise<ApiCredentialRecord> {
  const res = await authorizedJson<{ ok: true; credential: ApiCredentialRecord }>(
    `/api/studio/api-keys/${credentialId}/revoke`,
    accessToken,
    { method: "POST", body: {} },
  );
  return res.credential;
}

export async function approveStudioLaunchAudit(
  accessToken: string,
): Promise<LaunchAuditReport> {
  const res = await authorizedJson<{ ok: true; launchAudit: LaunchAuditReport }>(
    "/api/studio/launch-audit/approve",
    accessToken,
    { method: "POST", body: {} },
  );
  return res.launchAudit;
}

export async function runStudioDrDrill(
  accessToken: string,
  scenario: DisasterScenarioId,
): Promise<DisasterRecoveryDrillResult> {
  const res = await authorizedJson<{ ok: true; drill: DisasterRecoveryDrillResult }>(
    "/api/studio/dr/drill",
    accessToken,
    { method: "POST", body: { scenario } },
  );
  return res.drill;
}

export async function runStudioLoadTest(
  accessToken: string,
  concurrentUsers = 25,
): Promise<LoadTestSummaryResult> {
  const res = await authorizedJson<{ ok: true; loadTest: LoadTestSummaryResult }>(
    "/api/studio/dr/load-test",
    accessToken,
    { method: "POST", body: { concurrentUsers } },
  );
  return res.loadTest;
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}


