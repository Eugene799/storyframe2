import { describe, expect, it, vi } from "vitest";
import { synthesizeSpeech, type DeepgramSettings } from "../server/deepgram";
import { ApiError } from "../server/api-error";

function wavBytes(): Buffer {
  const sampleRate = 8000;
  const dataSize = sampleRate * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(dataSize, 40);
  return bytes;
}

const SETTINGS: DeepgramSettings = { apiKey: "dg-secret" };

describe("Deepgram TTS adapter", () => {
  it("posts only text to /v1/speak with the verified model and Token auth", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(new Uint8Array(wavBytes()), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      }),
    ) as unknown as typeof fetch;

    const speech = await synthesizeSpeech({
      settings: SETTINGS,
      voiceModel: "aura-2-thalia-en",
      text: "A short script.",
      fetchImpl,
      timeoutMs: 1000,
      maxBytes: 1024 * 1024,
    });

    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(String(url)).toBe(
      "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3",
    );
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Token dg-secret");
    expect(JSON.parse(init.body)).toEqual({ text: "A short script." });
    expect(speech).toMatchObject({
      contentType: "audio/wav",
      characters: 15,
      costUsd: 0.00045,
      voiceModel: "aura-2-thalia-en",
      rateVersion: "deepgram-aura-2-2026-11-25",
    });
    expect(speech.bytes.length).toBe(wavBytes().length);
  });

  it("refuses without a key and never calls the provider", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      synthesizeSpeech({
        settings: { apiKey: null },
        voiceModel: "aura-2-thalia-en",
        text: "Hello",
        fetchImpl,
        timeoutMs: 1000,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "NARRATION_PROVIDER_DISABLED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sanitizes provider failures and rejects non-audio bytes", async () => {
    const failure = (async () =>
      new Response(JSON.stringify({ err_msg: "bad dg-secret" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const error = await synthesizeSpeech({
      settings: SETTINGS,
      voiceModel: "aura-2-thalia-en",
      text: "Hello",
      fetchImpl: failure,
      timeoutMs: 1000,
      maxBytes: 1024,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("NARRATION_PROVIDER_FAILED");
    expect((error as ApiError).message).not.toContain("dg-secret");

    const notAudio = (async () =>
      new Response("not audio", {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      })) as unknown as typeof fetch;
    await expect(
      synthesizeSpeech({
        settings: SETTINGS,
        voiceModel: "aura-2-thalia-en",
        text: "Hello",
        fetchImpl: notAudio,
        timeoutMs: 1000,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "NARRATION_AUDIO_INVALID" });
  });

  it("enforces the verified 2,000-character request bound", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      synthesizeSpeech({
        settings: SETTINGS,
        voiceModel: "aura-2-thalia-en",
        text: "a".repeat(2001),
        fetchImpl,
        timeoutMs: 1000,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "NARRATION_SCRIPT_TOO_LONG" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
