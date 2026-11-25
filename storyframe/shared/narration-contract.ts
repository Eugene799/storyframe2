import type { MediaRecord } from "./media-contract";

/** Phase 8: narration and music attached to a project's approved script. */
export const NARRATION_MAX_CHARS = 2000;
export const DEEPGRAM_AURA2_USD_PER_1K_CHARS = 0.03;
export const DEEPGRAM_RATE_VERSION = "deepgram-aura-2-2026-11-25";

export type NarrationKind = "narration" | "music";
export type NarrationSource = "deepgram" | "upload";
export type NarrationStatus = "active" | "replaced" | "removed";

export interface NarrationVoice {
  /** Exact Deepgram model id, e.g. aura-2-thalia-en. */
  model: string;
  name: string;
  gender: string;
  accent: string;
  characteristics: string;
}

export interface NarrationVoiceCatalogResponse {
  ok: true;
  configured: boolean;
  provider: "deepgram";
  modelFamily: "aura-2";
  maxChars: number;
  usdPer1kChars: number;
  rateVersion: string;
  /** No word timestamps are requested or promised by this phase. */
  wordTimestamps: false;
  voices: NarrationVoice[];
}

export interface NarrationTrack {
  id: string;
  kind: NarrationKind;
  source: NarrationSource;
  status: NarrationStatus;
  mediaId: string | null;
  voiceModel: string | null;
  voiceName: string | null;
  /** Fingerprint of the approved script this audio was made from. */
  scriptFingerprint: string | null;
  scriptCharacters: number | null;
  /** Measured from the stored file, never estimated from words. */
  durationSeconds: number | null;
  volume: number;
  muted: boolean;
  costUsd: number | null;
  costRateVersion: string | null;
  createdAt: string;
}

export interface NarrationScriptState {
  fingerprint: string;
  characters: number;
  sceneCount: number;
  approved: boolean;
  targetSeconds: number;
}

export interface NarrationUsageSummary {
  windowHours: number;
  previews: number;
  generations: number;
  characters: number;
  spentUsd: number;
  limits: { characters: number | null; usd: number | null };
  resetAt: string | null;
}

export interface NarrationTiming {
  narrationSeconds: number;
  targetSeconds: number;
  differenceSeconds: number;
  mismatch: boolean;
}

export interface NarrationStateResponse {
  ok: true;
  narration: NarrationTrack | null;
  music: NarrationTrack | null;
  script: NarrationScriptState | null;
  /** Why no script state is available, when the document is not approved yet. */
  scriptBlocked: string | null;
  stale: boolean;
  timing: NarrationTiming | null;
  limits: { maxChars: number; usdPer1kChars: number; rateVersion: string };
  usage: NarrationUsageSummary;
}

export interface NarrationTrackResponse {
  ok: true;
  track: NarrationTrack;
  media: MediaRecord | null;
}

export interface NarrationGenerateInput {
  voiceModel: string;
}

export interface AudioAttachInput {
  mediaId: string;
}

export interface AudioSettingsInput {
  volume?: number;
  muted?: boolean;
}
