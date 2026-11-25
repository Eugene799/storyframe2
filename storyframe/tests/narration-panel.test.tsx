// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NarrationTrack, NarrationVoiceCatalogResponse } from "../shared/narration-contract";
import type { MediaRecord } from "../shared/media-contract";
import { NarrationPanel } from "../src/workspace/NarrationPanel";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_ID = "99999999-9999-4999-8999-999999999999";
const UPLOAD_MEDIA_ID = "88888888-8888-4888-8888-888888888888";
const NOW = "2026-11-25T12:00:00.000Z";

const CATALOG: NarrationVoiceCatalogResponse = {
  ok: true,
  configured: true,
  provider: "deepgram",
  modelFamily: "aura-2",
  maxChars: 2000,
  usdPer1kChars: 0.03,
  rateVersion: "deepgram-aura-2-2026-11-25",
  wordTimestamps: false,
  voices: [
    {
      model: "aura-2-thalia-en",
      name: "Thalia",
      gender: "feminine",
      accent: "American English",
      characteristics: "Clear, confident, energetic",
    },
  ],
};

const MEDIA: MediaRecord = {
  id: MEDIA_ID,
  kind: "audio",
  status: "ready",
  sceneKey: null,
  contentType: "audio/mpeg",
  byteSize: 12000,
  uploadExpiresAt: null,
  readyAt: NOW,
  deletedAt: null,
  createdAt: NOW,
  referenceCount: 1,
  provenance: null,
};

function track(overrides: Partial<NarrationTrack> = {}): NarrationTrack {
  return {
    id: "track-1",
    kind: "narration",
    source: "deepgram",
    status: "active",
    mediaId: MEDIA_ID,
    voiceModel: "aura-2-thalia-en",
    voiceName: "Thalia",
    scriptFingerprint: "f".repeat(64),
    scriptCharacters: 64,
    durationSeconds: 1,
    volume: 1,
    muted: false,
    costUsd: 0.00192,
    costRateVersion: "deepgram-aura-2-2026-11-25",
    createdAt: NOW,
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => payload,
    blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" }),
  } as unknown as Response;
}

interface BackendOptions {
  initialNarration?: NarrationTrack | null;
  stale?: boolean;
  mismatch?: boolean;
}

function installBackend(options: BackendOptions = {}) {
  let narration = options.initialNarration ?? null;
  let music: NarrationTrack | null = null;
  const requests: { method: string; path: string; body: any }[] = [];

  const state = () => ({
    ok: true,
    narration,
    music,
    script: {
      fingerprint: "f".repeat(64),
      characters: 64,
      sceneCount: 2,
      approved: true,
      targetSeconds: 20,
    },
    scriptBlocked: null,
    stale: options.stale ?? false,
    timing: {
      narrationSeconds: 1,
      targetSeconds: 20,
      differenceSeconds: -19,
      mismatch: options.mismatch ?? false,
    },
    limits: {
      maxChars: 2000,
      usdPer1kChars: 0.03,
      rateVersion: "deepgram-aura-2-2026-11-25",
    },
    usage: {
      windowHours: 24,
      previews: 1,
      generations: narration ? 1 : 0,
      characters: narration ? 150 : 80,
      spentUsd: narration ? 0.0045 : 0.0024,
      limits: { characters: 100000, usd: 3 },
      resetAt: null,
    },
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as any) : null;
      requests.push({ method, path: url.pathname, body });

      if (url.hostname === "upload.example" && method === "PUT") return jsonResponse({});
      if (url.pathname === "/api/narration/voices" && method === "GET") return jsonResponse(CATALOG);
      if (url.pathname === `/api/projects/${PROJECT_ID}/narration/preview` && method === "POST") {
        return jsonResponse({}, 200, { "Content-Type": "audio/mpeg" });
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/narration` && method === "GET") {
        return jsonResponse(state());
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/narration` && method === "POST") {
        narration = track();
        return jsonResponse({ ok: true, track: narration, media: MEDIA }, 201);
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/narration` && method === "PATCH") {
        narration = { ...(narration ?? track()), ...body };
        return jsonResponse({ ok: true, track: narration, media: MEDIA });
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/narration` && method === "DELETE") {
        narration = null;
        return jsonResponse({ ok: true, track: track({ status: "removed" }) });
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/music` && method === "PATCH") {
        music = { ...(music ?? track({ id: "music-1", kind: "music" })), ...body };
        return jsonResponse({ ok: true, track: music, media: MEDIA });
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/media` && method === "POST") {
        return jsonResponse(
          {
            ok: true,
            media: { ...MEDIA, id: UPLOAD_MEDIA_ID, status: "pending", referenceCount: 0 },
            upload: {
              url: "https://upload.example/audio",
              method: "PUT",
              headers: { "Content-Type": "audio/mpeg" },
              expiresAt: NOW,
            },
          },
          201,
        );
      }
      if (
        url.pathname === `/api/projects/${PROJECT_ID}/media/${UPLOAD_MEDIA_ID}/complete` &&
        method === "POST"
      ) {
        return jsonResponse({ ok: true, media: { ...MEDIA, id: UPLOAD_MEDIA_ID } });
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/narration/upload` && method === "POST") {
        narration = track({
          id: "upload-track",
          source: "upload",
          mediaId: UPLOAD_MEDIA_ID,
          voiceModel: null,
          voiceName: null,
          costUsd: null,
        });
        return jsonResponse(
          { ok: true, track: narration, media: { ...MEDIA, id: UPLOAD_MEDIA_ID } },
          201,
        );
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/media/${MEDIA_ID}/url` && method === "GET") {
        return jsonResponse({
          ok: true,
          url: "https://media.example/narration.mp3",
          expiresAt: NOW,
          contentType: "audio/mpeg",
          byteSize: 12000,
        });
      }
      return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: url.pathname } }, 404);
    }),
  );

  return { requests };
}

function renderPanel() {
  render(<NarrationPanel projectId={PROJECT_ID} getAccessToken={async () => "token"} />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NarrationPanel", () => {
  it("previews, generates, and shows measured duration, cost, and timing warning", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:sample"),
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const backend = installBackend({ mismatch: true });
    renderPanel();

    const voice = await screen.findByLabelText(/Voice/);
    expect((voice as HTMLSelectElement).value).toBe("aura-2-thalia-en");
    expect(await screen.findByText(/Approved script: 2 scenes/)).toBeTruthy();
    expect(screen.getByText(/0.001920/)).toBeTruthy();
    expect(screen.getByLabelText("Daily narration spend")).toHaveTextContent(
      "Last 24 hours: 1 sample · 0 narration generations · 80 characters · $0.0024 spent of 100000 characters",
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview voice" }));
    expect(await screen.findByLabelText("Voice sample")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Generate narration" }));
    expect(await screen.findByText(/Narration saved with Thalia/)).toBeTruthy();
    expect(await screen.findByLabelText("narration playback")).toBeTruthy();
    expect(await screen.findByText(/1 narration generation · 150 characters/)).toBeTruthy();
    expect(screen.getByText(/Deepgram · Thalia · 1.00s/)).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("TIMING_MISMATCH")).toBeTruthy();
    expect(screen.getByText(/Speech is never sped up or cut automatically/)).toBeTruthy();
    expect(
      backend.requests.find(
        (request) => request.path === `/api/projects/${PROJECT_ID}/narration` && request.method === "POST",
      )?.body,
    ).toEqual({ voiceModel: "aura-2-thalia-en" });
  });

  it("shows staleness and lets the user mute or remove narration", async () => {
    const backend = installBackend({ initialNarration: track(), stale: true });
    renderPanel();

    expect(await screen.findByText("NARRATION_STALE")).toBeTruthy();
    expect(screen.getByText(/was not regenerated/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Mute narration"));
    await waitFor(() =>
      expect(
        backend.requests.find(
          (request) => request.path === `/api/projects/${PROJECT_ID}/narration` && request.method === "PATCH",
        )?.body,
      ).toEqual({ muted: true }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove narration" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove narration" }));
    expect(await screen.findByText("Narration removed from this project.")).toBeTruthy();
    expect(screen.getByText("No narration track yet.")).toBeTruthy();
  });

  it("uploads an audio file as narration and measures it", async () => {
    const backend = installBackend();
    renderPanel();

    const input = await screen.findByLabelText(/Narration audio/);
    const file = new File([new Uint8Array([1, 2, 3])], "voice.mp3", { type: "audio/mpeg" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(/Narration saved from the uploaded file · 1.00s measured/)).toBeTruthy();
    const attach = backend.requests.find(
      (request) => request.path === `/api/projects/${PROJECT_ID}/narration/upload`,
    );
    expect(attach?.body).toEqual({ mediaId: UPLOAD_MEDIA_ID });
    expect(
      backend.requests.some(
        (request) =>
          request.path === `/api/projects/${PROJECT_ID}/media/${UPLOAD_MEDIA_ID}/complete`,
      ),
    ).toBe(true);
  });

  it("rejects an empty audio file before initiating an upload", async () => {
    const backend = installBackend();
    renderPanel();

    const input = await screen.findByLabelText(/Narration audio/);
    const file = new File([], "voice.mp3", { type: "audio/mpeg" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("The selected audio file is empty.")).toBeTruthy();
    expect(
      backend.requests.some(
        (request) =>
          request.path === `/api/projects/${PROJECT_ID}/media` && request.method === "POST",
      ),
    ).toBe(false);
  });

  it("normalizes a missing browser MIME type before uploading audio", async () => {
    const backend = installBackend();
    renderPanel();

    const input = await screen.findByLabelText(/Narration audio/);
    const file = new File([new Uint8Array([1, 2, 3])], "voice.mp3", { type: "" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(/Narration saved from the uploaded file/)).toBeTruthy();
    const initiation = backend.requests.find(
      (request) =>
        request.path === `/api/projects/${PROJECT_ID}/media` && request.method === "POST",
    );
    expect(initiation?.body).toMatchObject({ kind: "audio", contentType: "audio/mpeg" });
  });

  it("shows the blocked-script message instead of an enabled generate button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/narration/voices") return jsonResponse(CATALOG);
        return jsonResponse({
          ok: true,
          narration: null,
          music: null,
          script: null,
          scriptBlocked: "Generate narration only after every scene is approved.",
          stale: false,
          timing: null,
          limits: { maxChars: 2000, usdPer1kChars: 0.03, rateVersion: "v1" },
          usage: {
            windowHours: 24,
            previews: 0,
            generations: 0,
            characters: 0,
            spentUsd: 0,
            limits: { characters: 100000, usd: 3 },
            resetAt: null,
          },
        });
      }),
    );
    renderPanel();

    expect(
      await screen.findByText("Generate narration only after every scene is approved."),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Generate narration" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByLabelText(/Narration audio/) as HTMLInputElement).disabled).toBe(true);
  });
});
