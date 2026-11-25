import { ApiError } from "./api-error";
import { detectMediaType } from "./media";
import {
  DEEPGRAM_AURA2_USD_PER_1K_CHARS,
  DEEPGRAM_RATE_VERSION,
  NARRATION_MAX_CHARS,
} from "../shared/narration-contract";

/**
 * Phase 8: Deepgram Aura-2 text to speech.
 *
 * The current REST endpoint is POST /v1/speak with the model on the query
 * string and only `text` in the JSON body. Authentication is the `Token`
 * scheme. A 2xx response is binary audio; errors are JSON. MP3 is the default
 * REST encoding, so no container/encoding conversion is requested.
 */
export const DEEPGRAM_SPEAK_URL = "https://api.deepgram.com/v1/speak";
export const DEEPGRAM_PREVIEW_TEXT =
  "StoryFrame narration preview. This is the selected voice reading a short sample.";

export interface DeepgramSettings {
  apiKey: string | null;
}

export function loadDeepgramSettings(env: NodeJS.ProcessEnv): DeepgramSettings {
  const key = env.DEEPGRAM_API_KEY?.trim();
  return { apiKey: key && key.length > 0 ? key : null };
}

export interface DeepgramSpeech {
  bytes: Buffer;
  contentType: string;
  characters: number;
  costUsd: number;
  voiceModel: string;
  rateVersion: string;
}

export interface SynthesizeOptions {
  settings: DeepgramSettings;
  voiceModel: string;
  text: string;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
  maxBytes: number;
}

export async function synthesizeSpeech(options: SynthesizeOptions): Promise<DeepgramSpeech> {
  if (!options.settings.apiKey) {
    throw new ApiError(
      503,
      "NARRATION_PROVIDER_DISABLED",
      "Deepgram narration is disabled because DEEPGRAM_API_KEY is not configured.",
    );
  }

  const text = options.text.trim();
  if (text.length === 0) {
    throw new ApiError(422, "NARRATION_EMPTY_SCRIPT", "There is no approved script text to narrate.");
  }
  if (text.length > NARRATION_MAX_CHARS) {
    throw new ApiError(
      422,
      "NARRATION_SCRIPT_TOO_LONG",
      `Deepgram accepts at most ${NARRATION_MAX_CHARS} characters per request; this script has ${text.length}.`,
    );
  }

  const url = new URL(DEEPGRAM_SPEAK_URL);
  url.searchParams.set("model", options.voiceModel);
  url.searchParams.set("encoding", "mp3");

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${options.settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    throw new ApiError(502, "NARRATION_PROVIDER_FAILED", "Deepgram could not be reached.");
  }

  if (!response.ok) {
    // The body can name the key or request details; never surface it.
    await response.arrayBuffer().catch(() => undefined);
    throw new ApiError(
      502,
      "NARRATION_PROVIDER_FAILED",
      `Deepgram rejected the narration request (HTTP ${response.status}).`,
    );
  }

  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.length === 0) {
    throw new ApiError(502, "NARRATION_AUDIO_INVALID", "Deepgram returned no audio bytes.");
  }
  if (raw.length > options.maxBytes) {
    throw new ApiError(502, "NARRATION_AUDIO_INVALID", "Deepgram returned more audio than this phase accepts.");
  }

  const detected = detectMediaType(raw);
  if (!detected || detected.kind !== "audio") {
    throw new ApiError(502, "NARRATION_AUDIO_INVALID", "Deepgram's response was not recognized as audio.");
  }

  const characters = Array.from(text).length;
  return {
    bytes: raw,
    contentType: detected.contentType,
    characters,
    costUsd: Number(((characters / 1000) * DEEPGRAM_AURA2_USD_PER_1K_CHARS).toFixed(6)),
    voiceModel: options.voiceModel,
    rateVersion: DEEPGRAM_RATE_VERSION,
  };
}
