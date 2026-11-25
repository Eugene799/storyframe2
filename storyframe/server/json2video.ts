import { createHash, randomUUID } from "node:crypto";
import type { MediaRecord } from "../shared/media-contract";
import type { NarrationTrack } from "../shared/narration-contract";
import type { ProjectAspectRatio } from "../shared/project-contract";
import {
  dimensionsForAspectRatio,
  effectiveSceneDuration,
  type CompiledRenderSnapshot,
  type Json2VideoElement,
  type Json2VideoMoviePayload,
  type Json2VideoScenePayload,
  type RenderCompositionValidationIssue,
  type RenderInputContext,
  type RenderJobRecord,
} from "../shared/render-contract";
import { ApiError } from "./api-error";

export const JSON2VIDEO_DEFAULT_BASE_URL = "https://api.json2video.com/v2/movies";
export const JSON2VIDEO_RATE_PER_MINUTE_USD = 0.12;
export const JSON2VIDEO_MAX_DURATION_SECONDS = 360;

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const SUPPORTED_VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

export function compileRenderComposition(input: RenderInputContext): CompiledRenderSnapshot {
  const aspectRatio: ProjectAspectRatio = input.aspectRatio ?? "9:16";
  const { width, height } = dimensionsForAspectRatio(aspectRatio);
  const maxDurationSeconds = input.maxDurationSeconds ?? JSON2VIDEO_MAX_DURATION_SECONDS;
  const ratePerMinuteUsd = input.ratePerMinuteUsd ?? JSON2VIDEO_RATE_PER_MINUTE_USD;
  const compiledAt = input.compiledAt ?? new Date().toISOString();

  const issues: RenderCompositionValidationIssue[] = [];
  const scenes = input.document.scenes;

  if (scenes.length === 0) {
    issues.push({
      code: "EMPTY_SCENES",
      severity: "error",
      sceneId: null,
      message: "Project has no scenes to compile into a render composition.",
    });
  }

  if (
    input.document.brief.mode === "factual" &&
    (input.unresolvedClaimCount ?? 0) > 0 &&
    !input.allowUnresolvedClaims
  ) {
    issues.push({
      code: "UNRESOLVED_FACTUAL_CLAIMS",
      severity: "error",
      sceneId: null,
      message: `${input.unresolvedClaimCount} factual claim(s) remain unreviewed. Review or explicitly acknowledge unresolved claims before rendering.`,
    });
  } else if (
    input.document.brief.mode === "factual" &&
    (input.unresolvedClaimCount ?? 0) > 0
  ) {
    issues.push({
      code: "UNRESOLVED_FACTUAL_CLAIMS",
      severity: "warning",
      sceneId: null,
      message: `${input.unresolvedClaimCount} factual claim(s) are unverified by human review.`,
    });
  }

  let globalVoiceoverTrack: NarrationTrack | undefined;
  let globalMusicTrack: NarrationTrack | undefined;

  for (const track of input.narrationTracks) {
    if (track.status !== "active") continue;
    if (track.kind === "music" && !globalMusicTrack) {
      globalMusicTrack = track;
    } else if (track.kind === "narration" && !globalVoiceoverTrack) {
      globalVoiceoverTrack = track;
    }
  }

  const j2vScenes: Json2VideoScenePayload[] = [];
  const sceneTimings: CompiledRenderSnapshot["sceneTimings"] = [];
  let runningSeconds = 0;

  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index];
    const duration = effectiveSceneDuration(scene, undefined);

    if (duration <= 0) {
      issues.push({
        code: "SCENE_ZERO_DURATION",
        severity: "error",
        sceneId: scene.id,
        message: `Scene ${index + 1} ("${scene.heading}") has zero duration.`,
      });
    }

    const elements: Json2VideoElement[] = [];
    let visualMedia: MediaRecord | undefined;
    for (const assetId of scene.assetIds) {
      const candidate = input.mediaById.get(assetId);
      if (candidate && (candidate.kind === "image" || candidate.kind === "video")) {
        visualMedia = candidate;
        break;
      }
    }

    if (!visualMedia) {
      issues.push({
        code: "MISSING_VISUAL_ASSET",
        severity: "error",
        sceneId: scene.id,
        message: `Scene ${index + 1} ("${scene.heading}") has no visual image or video clip attached.`,
      });
    } else if (visualMedia.status !== "ready" || visualMedia.deletedAt !== null) {
      issues.push({
        code: "ASSET_NOT_READY",
        severity: "error",
        sceneId: scene.id,
        message: `Scene ${index + 1} visual asset ${visualMedia.id} is not ready in private R2 storage.`,
      });
    } else {
      const allowedSet = visualMedia.kind === "image" ? SUPPORTED_IMAGE_TYPES : SUPPORTED_VIDEO_TYPES;
      if (!allowedSet.has(visualMedia.contentType)) {
        issues.push({
          code: "UNSUPPORTED_MEDIA_FORMAT",
          severity: "error",
          sceneId: scene.id,
          message: `Scene ${index + 1} asset content type "${visualMedia.contentType}" is unsupported by JSON2Video.`,
        });
      }
      const signedUrl =
        input.signedUrlsByMediaId.get(visualMedia.id) ??
        `https://r2.storyframe.internal/media/${visualMedia.id}`;
      elements.push({
        type: visualMedia.kind,
        src: signedUrl,
        start: 0,
        duration: Math.max(1, duration),
        width,
        height,
        fit: "cover",
      });
    }

    if (scene.onScreenText.trim()) {
      elements.push({
        type: "text",
        text: scene.onScreenText.trim(),
        start: 0,
        duration: Math.max(1, duration),
        style: {
          fontFamily: "Inter",
          fontSize: aspectRatio === "9:16" ? 54 : 44,
          color: "#ffffff",
          backgroundColor: "rgba(11, 15, 22, 0.72)",
          textAlign: "center",
          position: "bottom-safe",
        },
      });
    }

    j2vScenes.push({
      id: scene.id,
      comment: scene.heading || `Scene ${index + 1}`,
      duration: Math.max(1, duration),
      transition:
        index > 0
          ? {
              style: "fade",
              duration: 0.4,
            }
          : undefined,
      elements,
    });

    sceneTimings.push({
      sceneId: scene.id,
      heading: scene.heading,
      startSeconds: runningSeconds,
      durationSeconds: duration,
      visualMediaId: visualMedia?.id ?? null,
      narrationTrackId: globalVoiceoverTrack?.id ?? null,
    });

    runningSeconds += duration;
  }

  const measuredNarrationSeconds =
    globalVoiceoverTrack && globalVoiceoverTrack.durationSeconds
      ? Math.ceil(globalVoiceoverTrack.durationSeconds)
      : 0;

  if (measuredNarrationSeconds > runningSeconds && runningSeconds > 0) {
    issues.push({
      code: "NARRATION_DURATION_MISMATCH",
      severity: "warning",
      sceneId: null,
      message: `Measured narration (${measuredNarrationSeconds}s) exceeds total scene duration (${runningSeconds}s).`,
    });
  }

  const globalElements: Json2VideoElement[] = [];
  if (globalVoiceoverTrack && globalVoiceoverTrack.mediaId && !globalVoiceoverTrack.muted) {
    const voUrl =
      input.signedUrlsByMediaId.get(globalVoiceoverTrack.mediaId) ??
      `https://r2.storyframe.internal/media/${globalVoiceoverTrack.mediaId}`;
    globalElements.push({
      type: "audio",
      src: voUrl,
      start: 0,
      duration: Math.max(1, measuredNarrationSeconds || runningSeconds),
      volume: globalVoiceoverTrack.volume,
    });
  }
  if (globalMusicTrack && globalMusicTrack.mediaId && !globalMusicTrack.muted) {
    const musicUrl =
      input.signedUrlsByMediaId.get(globalMusicTrack.mediaId) ??
      `https://r2.storyframe.internal/media/${globalMusicTrack.mediaId}`;
    globalElements.push({
      type: "audio",
      src: musicUrl,
      start: 0,
      duration: Math.max(1, runningSeconds),
      volume: globalMusicTrack.volume,
    });
  }

  if (runningSeconds > maxDurationSeconds) {
    issues.push({
      code: "DURATION_EXCEEDS_MAX",
      severity: "error",
      sceneId: null,
      message: `Total composition duration (${runningSeconds}s) exceeds maximum allowed (${maxDurationSeconds}s).`,
    });
  }

  const movie: Json2VideoMoviePayload = {
    resolution: "custom",
    width,
    height,
    fps: 30,
    quality: "high",
    comment: `${input.title} (v${input.projectVersion})`,
    scenes: j2vScenes,
    elements: globalElements,
  };

  const canonical = JSON.stringify({
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    aspectRatio,
    sceneTimings,
    scenes: scenes.map((s) => ({
      id: s.id,
      heading: s.heading,
      body: s.body,
      onScreenText: s.onScreenText,
      durationSeconds: s.durationSeconds,
      assetIds: s.assetIds,
    })),
  });
  const fingerprint = createHash("sha256").update(canonical).digest("hex").slice(0, 24);

  const billableMinutes = Math.max(0.25, runningSeconds / 60);
  const estimatedCostUsd = Number((billableMinutes * ratePerMinuteUsd).toFixed(4));
  const hasBlockingError = issues.some((issue) => issue.severity === "error");

  return {
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    projectType: input.projectType,
    title: input.title,
    aspectRatio,
    width,
    height,
    totalDurationSeconds: runningSeconds,
    measuredNarrationSeconds,
    estimatedCostUsd,
    fingerprint,
    issues,
    canSubmit: !hasBlockingError && scenes.length > 0 && runningSeconds > 0,
    movie,
    sceneTimings,
    compiledAt,
  };
}

export interface Json2VideoProviderConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface Json2VideoSubmitResult {
  providerJobId: string;
  status: "submitted" | "rendering" | "ready";
  remoteVideoUrl?: string;
}

export interface Json2VideoPollResult {
  providerJobId: string;
  status: "rendering" | "ready" | "failed";
  remoteVideoUrl: string | null;
  durationSeconds: number | null;
  byteSize: number | null;
  errorMessage: string | null;
}

export async function submitMovieToJson2Video(
  movie: Json2VideoMoviePayload,
  config: Json2VideoProviderConfig,
): Promise<Json2VideoSubmitResult> {
  if (!config.apiKey) {
    // Deterministic simulated provider job when JSON2VIDEO_API_KEY is not set in local dev/test
    return {
      providerJobId: `j2v-sim-${randomUUID().slice(0, 12)}`,
      status: "submitted",
    };
  }

  const baseUrl = config.baseUrl || JSON2VIDEO_DEFAULT_BASE_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 25_000);
  try {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
      },
      body: JSON.stringify(movie),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ApiError(
        502,
        "RENDER_PROVIDER_FAILED",
        `JSON2Video rejected render submission with status ${response.status}.`,
      );
    }
    const payload = (await response.json()) as {
      project?: string;
      id?: string;
      status?: string;
      movie?: { url?: string };
    };
    const providerJobId = payload.project || payload.id || `j2v-${randomUUID().slice(0, 12)}`;
    return {
      providerJobId,
      status: payload.status === "done" ? "ready" : "submitted",
      remoteVideoUrl: payload.movie?.url,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function pollJson2VideoMovie(
  providerJobId: string,
  expectedDurationSeconds: number,
  config: Json2VideoProviderConfig,
): Promise<Json2VideoPollResult> {
  if (!config.apiKey || providerJobId.startsWith("j2v-sim-")) {
    return {
      providerJobId,
      status: "ready",
      remoteVideoUrl: null,
      durationSeconds: expectedDurationSeconds,
      byteSize: Math.max(32_768, expectedDurationSeconds * 48_000),
      errorMessage: null,
    };
  }

  const baseUrl = config.baseUrl || JSON2VIDEO_DEFAULT_BASE_URL;
  const pollUrl = `${baseUrl}?project=${encodeURIComponent(providerJobId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 20_000);
  try {
    const response = await fetch(pollUrl, {
      method: "GET",
      headers: {
        "x-api-key": config.apiKey,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ApiError(
        502,
        "RENDER_POLL_FAILED",
        `JSON2Video status check failed (${response.status}).`,
      );
    }
    const payload = (await response.json()) as {
      movie?: {
        status?: string;
        url?: string;
        duration?: number;
        size?: number;
        message?: string;
      };
    };
    const movie = payload.movie ?? {};
    if (movie.status === "error" || movie.status === "failed") {
      return {
        providerJobId,
        status: "failed",
        remoteVideoUrl: null,
        durationSeconds: null,
        byteSize: null,
        errorMessage: movie.message || "JSON2Video reported a render failure.",
      };
    }
    if (movie.status === "done" || movie.status === "ready") {
      return {
        providerJobId,
        status: "ready",
        remoteVideoUrl: movie.url ?? null,
        durationSeconds: movie.duration ?? expectedDurationSeconds,
        byteSize: movie.size ?? Math.max(32_768, expectedDurationSeconds * 48_000),
        errorMessage: null,
      };
    }
    return {
      providerJobId,
      status: "rendering",
      remoteVideoUrl: null,
      durationSeconds: null,
      byteSize: null,
      errorMessage: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function buildSimulatedMp4Bytes(job: Pick<RenderJobRecord, "id" | "projectId" | "durationSeconds">): Uint8Array {
  // Valid ISO BMFF / MP4 ftyp header followed by deterministic metadata box
  const header = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);
  const meta = Buffer.from(
    JSON.stringify({
      box: "storyframe-mp4",
      jobId: job.id,
      projectId: job.projectId,
      durationSeconds: job.durationSeconds,
    }),
    "utf8",
  );
  return new Uint8Array(Buffer.concat([header, meta]));
}
