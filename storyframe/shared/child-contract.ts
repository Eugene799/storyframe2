/** Addressable scene row: the stable `sceneKey` is what media and generation attach to. */
export interface SceneRecord {
  id: string;
  sceneKey: string;
  position: number;
  heading: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export type SourceKind = "web" | "document" | "interview" | "other";

export interface SourceRecord {
  id: string;
  kind: SourceKind;
  title: string;
  url: string | null;
  /** The supplied passage planning may quote verbatim. */
  excerpt: string | null;
  retrievedAt: string | null;
  createdAt: string;
}

export type ClaimStatus = "unverified" | "supported" | "contradicted";

export interface ClaimRecord {
  id: string;
  sourceId: string | null;
  sceneKey: string | null;
  statement: string;
  /** The verbatim source passage behind a supported claim. */
  quote: string | null;
  status: ClaimStatus;
  createdAt: string;
}

export type ProposalStatus = "proposed" | "accepted" | "rejected";

export interface GenerationProposalRecord {
  id: string;
  sceneKey: string | null;
  modelId: string;
  prompt: string;
  status: ProposalStatus;
  /** Which planning route produced it, or `legacy` for a hand-recorded proposal. */
  route: string;
  /** The project version the proposal was generated against. */
  baseVersion: number;
  proposal: Record<string, unknown>;
  createdAt: string;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface ProviderJobRecord {
  id: string;
  provider: string;
  status: JobStatus;
  externalId: string | null;
  request: unknown;
  result: unknown;
  createdAt: string;
  updatedAt: string;
}

export type RenderStatus = "pending" | "ready" | "failed";

/** A render is pinned to a project revision that must already exist. */
export interface RenderSnapshotRecord {
  id: string;
  projectRevision: number;
  status: RenderStatus;
  outputKey: string | null;
  createdAt: string;
}

export interface ScenesResponse {
  ok: true;
  scenes: SceneRecord[];
}

export interface SourcesResponse {
  ok: true;
  sources: SourceRecord[];
}

export interface SourceResponse {
  ok: true;
  source: SourceRecord;
}

export interface ClaimsResponse {
  ok: true;
  claims: ClaimRecord[];
}

export interface ClaimResponse {
  ok: true;
  claim: ClaimRecord;
}

export interface ProposalsResponse {
  ok: true;
  proposals: GenerationProposalRecord[];
}

export interface ProposalResponse {
  ok: true;
  proposal: GenerationProposalRecord;
}

export interface JobsResponse {
  ok: true;
  jobs: ProviderJobRecord[];
}

export interface JobResponse {
  ok: true;
  job: ProviderJobRecord;
}

export interface RendersResponse {
  ok: true;
  renders: RenderSnapshotRecord[];
}

export interface RenderResponse {
  ok: true;
  render: RenderSnapshotRecord;
}

export interface ChildDeletedResponse {
  ok: true;
  deletedId: string;
}
