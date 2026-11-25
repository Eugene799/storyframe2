import type {
  ProjectAspectRatio,
  ProjectDocumentV2,
  ProjectPreset,
  ProjectType,
  VoicePreference,
} from "./project-contract";

// ==========================================
// Phase D1: Niche Profile & Discovery Interface
// ==========================================

export type DiscoveryContentGoal =
  | "audience-growth"
  | "authority-education"
  | "product-conversion"
  | "community-engagement";

export type DiscoveryPlatform =
  | "youtube-shorts"
  | "youtube-long"
  | "tiktok"
  | "instagram-reels"
  | "linkedin";

export interface DiscoveryPreferencesRecord {
  userId: string;
  primaryNiche: string;
  subniches: string[];
  targetAudience: string;
  regionCode: string;
  languageCode: string;
  platforms: DiscoveryPlatform[];
  contentGoal: DiscoveryContentGoal;
  tone: string;
  preferredShortDurationSeconds: 15 | 30 | 45 | 60;
  preferredLongDurationSeconds: 180 | 240 | 300;
  topicsToAvoid: string[];
  updatedAt: string;
}

// ==========================================
// Phase D2: Real Trend-Evidence Ingestion
// ==========================================

export type TrendSignalBasis = "popularity" | "measured-growth" | "demo-sample";

export interface NormalizedTrendEvidence {
  id: string;
  sourceProvider: "youtube-data-api-v3" | "demo-fallback";
  externalVideoId: string;
  title: string;
  channelTitle: string;
  publishedAt: string;
  regionCode: string;
  queryTopic: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  ageHours: number;
  viewsPerHour: number;
  signalBasis: TrendSignalBasis;
  signalExplanation: string;
  fetchedAt: string;
}

export interface TrendEvidenceIngestionResult {
  sourceStatus: "live-youtube" | "cached-youtube" | "unconfigured-fallback";
  youtubeConfigured: boolean;
  cacheKey: string;
  fetchedAt: string;
  expiresAt: string;
  disclosure: string;
  evidence: NormalizedTrendEvidence[];
}

// ==========================================
// Phase D3 & D4: Ollama Idea Synthesis, Deduplication, Personalization
// ==========================================

export type IdeaFormatTrack = "short-form" | "long-form";

export type IdeaFeedbackReason =
  | "more-like-this"
  | "not-relevant"
  | "already-covered"
  | "too-similar"
  | "avoid-topic";

export interface DiscoveryIdeaRecord {
  id: string;
  batchId: string;
  userId: string;
  formatTrack: IdeaFormatTrack;
  isDemoSample: boolean;
  title: string;
  hook: string;
  angleSummary: string;
  whyNow: string;
  recommendedProjectType: ProjectType;
  recommendedMode: "factual" | "fiction";
  recommendedPreset: ProjectPreset;
  recommendedDurationSeconds: number;
  recommendedAspectRatio: ProjectAspectRatio;
  outlineBeats: string[];
  evidenceIds: string[];
  signalBasis: TrendSignalBasis;
  matchScore: number;
  matchExplanation: string[];
  status: "active" | "saved" | "dismissed" | "used";
  feedbackReason: IdeaFeedbackReason | null;
  customPromptNote: string | null;
  createdProjectId: string | null;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
}

// ==========================================
// Phase D5: Turn an Idea into a Video Project
// ==========================================

export interface IdeaProjectDraftPreview {
  ideaId: string;
  formatTrack: IdeaFormatTrack;
  title: string;
  projectType: ProjectType;
  mode: "factual" | "fiction";
  preset: ProjectPreset;
  voicePreference: VoicePreference;
  targetDurationSeconds: number;
  aspectRatio: ProjectAspectRatio;
  longFormCapabilityDisclosure: string | null;
  noAutoPaidGenerationDisclosure: string;
  provenance: {
    ideaId: string;
    batchId: string;
    evidenceIds: string[];
    signalBasis: TrendSignalBasis;
    isDemoSample: boolean;
  };
  document: ProjectDocumentV2;
}

// ==========================================
// Phase D6: Production Controls & Event Tracking
// ==========================================

export type DiscoveryEventType =
  | "viewed"
  | "saved"
  | "dismissed"
  | "used"
  | "completed";

export interface DiscoveryEventRecord {
  id: string;
  userId: string;
  ideaId: string;
  eventType: DiscoveryEventType;
  metadata: Record<string, string | number | boolean>;
  createdAt: string;
}

export const DEFAULT_DISCOVERY_PREFERENCES: Omit<DiscoveryPreferencesRecord, "userId" | "updatedAt"> = {
  primaryNiche: "Technology & Creator Economy",
  subniches: ["AI Workflows", "Indie SaaS", "Productivity Systems"],
  targetAudience: "Creators, founders, and solo operators",
  regionCode: "US",
  languageCode: "en",
  platforms: ["youtube-shorts", "youtube-long", "tiktok"],
  contentGoal: "authority-education",
  tone: "Clear, analytical, and story-driven",
  preferredShortDurationSeconds: 45,
  preferredLongDurationSeconds: 240,
  topicsToAvoid: ["Crypto hype", "Get rich quick"],
};

export function computeIdeaSimilarity(a: { title: string; hook: string }, b: { title: string; hook: string }): number {
  const tokenize = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((token) => token.length > 2),
    );
  const tokensA = tokenize(`${a.title} ${a.hook}`);
  const tokensB = tokenize(`${b.title} ${b.hook}`);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let overlap = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) overlap += 1;
  }
  return overlap / Math.min(tokensA.size, tokensB.size);
}
