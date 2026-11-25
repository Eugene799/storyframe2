import { afterEach, describe, expect, it } from "vitest";
import { USER_A, USER_B } from "./fake-supabase";
import { documentFixture, sceneFixture } from "./project-fixture";
import { sceneFingerprint } from "../shared/scene-fingerprint";
import { startTestServer, type TestApp } from "./server-helpers";
import { DEEPGRAM_PREVIEW_TEXT } from "../server/deepgram";

function wavBytes(seconds = 1): Buffer {
  const sampleRate = 8000;
  const dataSize = sampleRate * seconds * 2;
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

const WAV = wavBytes(1);
const ENV = {
  DEEPGRAM_API_KEY: "dg-test-key",
  NARRATION_TIMEOUT_MS: "2000",
  NARRATION_MAX_AUDIO_BYTES: "5000000",
};

const apps: TestApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function startNarrationApp(
  overrides: Record<string, string> = {},
  providerStatus = 200,
): Promise<{ app: TestApp; calls: () => number }> {
  let calls = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.deepgram.com/v1/speak")) {
      calls += 1;
      expect(init?.method).toBe("POST");
      if (providerStatus >= 400) {
        return new Response(JSON.stringify({ err_msg: "provider failure" }), {
          status: providerStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(new Uint8Array(WAV), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    }
    return fetch(input, init);
  }) as typeof fetch;
  const app = await startTestServer({ env: { ...ENV, ...overrides }, fetchImpl });
  apps.push(app);
  return { app, calls: () => calls };
}

async function preview(
  app: TestApp,
  projectId: string,
): Promise<{ status: number; contentType: string | null; bytes: number; body: any }> {
  const response = await fetch(`${app.url}/api/projects/${projectId}/narration/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${USER_A.token}` },
    body: JSON.stringify({ voiceModel: "aura-2-thalia-en" }),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    bytes: buffer.length,
    body: response.headers.get("content-type")?.includes("json")
      ? JSON.parse(buffer.toString("utf8"))
      : null,
  };
}

function approvedDocument() {
  const first = sceneFixture({ body: "The letter waits under a seat." });
  const second = sceneFixture({
    id: "scene-2",
    heading: "EXT. PLATFORM - DAWN",
    body: "The courier steps off the train.",
    durationSeconds: 8,
  });
  return documentFixture({
    scenes: [
      { ...first, approved: true, approvedFingerprint: sceneFingerprint(first) },
      { ...second, approved: true, approvedFingerprint: sceneFingerprint(second) },
    ],
  });
}

async function createProject(app: TestApp, document = approvedDocument()): Promise<string> {
  const response = await api(app, USER_A.token, "POST", "/api/projects", {
    projectType: "story",
    title: "Narration project",
    document,
  });
  expect(response.status).toBe(201);
  return response.body.project.id;
}

async function api(
  app: TestApp,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${app.url}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

function seedAudio(app: TestApp, projectId: string, id = "99999999-9999-4999-8999-999999999999"): string {
  const key = `media/${USER_A.id}/${id}`;
  app.supabase.media.push({
    id,
    owner_id: USER_A.id,
    project_id: projectId,
    kind: "audio",
    status: "ready",
    scene_key: null,
    content_type: "audio/wav",
    byte_size: WAV.length,
    object_key: key,
    upload_expires_at: null,
    ready_at: new Date().toISOString(),
    deleted_at: null,
    created_at: new Date().toISOString(),
    provenance: null,
  });
  app.r2.objects.set(key, { body: WAV, contentType: "audio/wav" });
  return id;
}

describe("narration voices", () => {
  it("lists verified Aura-2 voices and whether Deepgram is configured", async () => {
    const { app } = await startNarrationApp();
    const response = await api(app, USER_A.token, "GET", "/api/narration/voices");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      configured: true,
      provider: "deepgram",
      modelFamily: "aura-2",
      maxChars: 2000,
      usdPer1kChars: 0.03,
      wordTimestamps: false,
    });
    expect(response.body.voices[0]).toMatchObject({
      model: "aura-2-thalia-en",
      name: "Thalia",
      accent: "American English",
    });
    const anonymous = await fetch(`${app.url}/api/narration/voices`);
    expect(anonymous.status).toBe(401);
  });
});

describe("narration generation", () => {
  it("persists a measured narration for the approved script", async () => {
    const { app, calls } = await startNarrationApp();
    const projectId = await createProject(app);
    const response = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/narration`, {
      voiceModel: "aura-2-thalia-en",
    });

    expect(response.status).toBe(201);
    expect(response.body.track).toMatchObject({
      kind: "narration",
      source: "deepgram",
      status: "active",
      voiceModel: "aura-2-thalia-en",
      voiceName: "Thalia",
      durationSeconds: 1,
      volume: 1,
      muted: false,
      costUsd: 0.00192,
      costRateVersion: "deepgram-aura-2-2026-11-25",
    });
    expect(response.body.track.scriptFingerprint).toHaveLength(64);
    expect(response.body.track.scriptCharacters).toBe(64);
    expect(response.body.track.costUsd).toBe(0.00192);
    expect(response.body.media).toMatchObject({ kind: "audio", status: "ready", contentType: "audio/wav" });
    expect(calls()).toBe(1);
    expect(app.r2.puts).toBe(1);
    expect(app.supabase.narrationTracks).toHaveLength(1);
    expect(app.supabase.mediaReferences[0]).toMatchObject({
      media_id: response.body.media.id,
      ref_kind: "document",
      ref_id: response.body.track.id,
    });

    const state = await api(app, USER_A.token, "GET", `/api/projects/${projectId}/narration`);
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({
      stale: false,
      script: { characters: 64, sceneCount: 2, approved: true, targetSeconds: 20 },
      timing: { narrationSeconds: 1, targetSeconds: 20, mismatch: true },
      usage: { previews: 0, generations: 1, characters: 64, spentUsd: 0.00192 },
    });
    expect(app.supabase.narrationUsage).toHaveLength(1);
    expect(app.supabase.narrationUsage[0]).toMatchObject({
      kind: "generation",
      status: "succeeded",
      characters: 64,
      cost_usd: 0.00192,
      rate_version: "deepgram-aura-2-2026-11-25",
    });
  });

  it("marks generated narration stale after the approved script changes", async () => {
    const { app, calls } = await startNarrationApp();
    const projectId = await createProject(app);
    const created = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/narration`, {
      voiceModel: "aura-2-thalia-en",
    });
    expect(created.status).toBe(201);

    const project = await api(app, USER_A.token, "GET", `/api/projects/${projectId}`);
    const document = project.body.project.document;
    const changedScenes = document.scenes.map((scene: any, index: number) => {
      if (index !== 0) return scene;
      const next = { ...scene, body: "The letter waits under a different seat." };
      return { ...next, approvedFingerprint: sceneFingerprint(next) };
    });
    const changed = { ...document, scenes: changedScenes };
    const saved = await api(app, USER_A.token, "PUT", `/api/projects/${projectId}`, {
      title: project.body.project.title,
      document: changed,
      version: project.body.project.version,
    });
    expect(saved.status).toBe(200);

    const state = await api(app, USER_A.token, "GET", `/api/projects/${projectId}/narration`);
    expect(state.body.stale).toBe(true);
    expect(state.body.narration.id).toBe(created.body.track.id);
    // Staleness never triggers a silent regeneration.
    expect(calls()).toBe(1);
    expect(app.supabase.narrationTracks).toHaveLength(1);
  });

  it("refuses narration until the script is approved", async () => {
    const { app, calls } = await startNarrationApp();
    const projectId = await createProject(app, documentFixture());
    const response = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/narration`, {
      voiceModel: "aura-2-thalia-en",
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("SCRIPT_NOT_APPROVED");
    expect(calls()).toBe(0);
    expect(app.supabase.narrationTracks).toHaveLength(0);
  });

  it("refuses a foreign project and an unknown voice", async () => {
    const { app } = await startNarrationApp();
    const projectId = await createProject(app);
    const foreign = await api(app, USER_B.token, "POST", `/api/projects/${projectId}/narration`, {
      voiceModel: "aura-2-thalia-en",
    });
    expect(foreign.status).toBe(404);
    const voice = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/narration`, {
      voiceModel: "aura-2-unknown-en",
    });
    expect(voice.status).toBe(400);
    expect(voice.body.error.code).toBe("INVALID_VOICE");
  });
});

describe("narration spending guard", () => {
  it("records previews and enforces one rolling character budget across previews and generations", async () => {
    const previewCharacters = Array.from(DEEPGRAM_PREVIEW_TEXT).length;
    const { app, calls } = await startNarrationApp({ NARRATION_DAILY_CHARS_PER_USER: "100" });
    const projectId = await createProject(app);

    const sample = await preview(app, projectId);
    expect(sample.status).toBe(200);
    expect(calls()).toBe(1);

    const state = await api(app, USER_A.token, "GET", `/api/projects/${projectId}/narration`);
    expect(state.body.usage).toMatchObject({
      previews: 1,
      generations: 0,
      characters: previewCharacters,
      limits: { characters: 100, usd: 3 },
    });
    expect(app.supabase.narrationUsage[0]).toMatchObject({
      kind: "preview",
      status: "succeeded",
      characters: previewCharacters,
    });

    // 82 preview characters plus a 64-character generation exceed the 100-character budget.
    const blocked = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/narration`, {
      voiceModel: "aura-2-thalia-en",
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("NARRATION_SPEND_LIMIT");
    expect(calls()).toBe(1);
    expect(app.supabase.narrationUsage).toHaveLength(1);
    expect(app.supabase.narrationTracks).toHaveLength(0);
  });

  it("keeps the spending window after the project is deleted", async () => {
    const { app, calls } = await startNarrationApp({ NARRATION_DAILY_CHARS_PER_USER: "100" });
    const projectId = await createProject(app);
    expect((await preview(app, projectId)).status).toBe(200);
    expect(calls()).toBe(1);

    const removed = await api(app, USER_A.token, "DELETE", `/api/projects/${projectId}`);
    expect(removed.status).toBe(200);
    expect(app.supabase.narrationUsage).toHaveLength(1);
    expect(app.supabase.narrationUsage[0].project_id).toBeNull();

    const replacement = await createProject(app);
    const blocked = await preview(app, replacement);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("NARRATION_SPEND_LIMIT");
    expect(calls()).toBe(1);
    expect(app.supabase.narrationUsage).toHaveLength(1);
  });

  it("refuses a preview before the provider call when the character or USD budget is exhausted", async () => {
    const chars = await startNarrationApp({ NARRATION_DAILY_CHARS_PER_USER: "10" });
    const charsProject = await createProject(chars.app);
    const charsResponse = await preview(chars.app, charsProject);
    expect(charsResponse.status).toBe(429);
    expect(charsResponse.body.error.code).toBe("NARRATION_SPEND_LIMIT");
    expect(chars.calls()).toBe(0);
    expect(chars.app.supabase.narrationUsage).toHaveLength(0);

    const usd = await startNarrationApp({ NARRATION_DAILY_USD_PER_USER: "0.001" });
    const usdProject = await createProject(usd.app);
    const usdResponse = await preview(usd.app, usdProject);
    expect(usdResponse.status).toBe(429);
    expect(usdResponse.body.error.code).toBe("NARRATION_SPEND_LIMIT");
    expect(usd.calls()).toBe(0);
    expect(usd.app.supabase.narrationUsage).toHaveLength(0);
  });

  it("keeps a failed provider attempt in the ledger so retries remain bounded", async () => {
    const { app, calls } = await startNarrationApp({}, 401);
    const projectId = await createProject(app);
    const failed = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/narration`, {
      voiceModel: "aura-2-thalia-en",
    });
    expect(failed.status).toBe(502);
    expect(calls()).toBe(1);
    expect(app.supabase.narrationUsage).toHaveLength(1);
    expect(app.supabase.narrationUsage[0]).toMatchObject({
      kind: "generation",
      status: "failed",
      characters: 64,
      cost_usd: 0.00192,
    });

    const state = await api(app, USER_A.token, "GET", `/api/projects/${projectId}/narration`);
    expect(state.body.usage).toMatchObject({ generations: 1, characters: 64, spentUsd: 0.00192 });
  });
});

describe("uploaded narration and music", () => {
  it("attaches measured uploaded narration and music, then updates volume and removes", async () => {
    const { app } = await startNarrationApp();
    const projectId = await createProject(app);
    const narrationMedia = seedAudio(app, projectId);
    const musicMedia = seedAudio(app, projectId, "88888888-8888-4888-8888-888888888888");

    const narration = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/narration/upload`, {
      mediaId: narrationMedia,
    });
    expect(narration.status).toBe(201);
    expect(narration.body.track).toMatchObject({
      kind: "narration",
      source: "upload",
      mediaId: narrationMedia,
      durationSeconds: 1,
      costUsd: null,
    });
    expect(narration.body.track.scriptFingerprint).toHaveLength(64);

    const music = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/music`, {
      mediaId: musicMedia,
    });
    expect(music.status).toBe(201);
    expect(music.body.track).toMatchObject({ kind: "music", source: "upload", durationSeconds: 1 });

    const patched = await api(app, USER_A.token, "PATCH", `/api/projects/${projectId}/music`, {
      volume: 0.35,
      muted: true,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.track).toMatchObject({ volume: 0.35, muted: true });

    const removed = await api(app, USER_A.token, "DELETE", `/api/projects/${projectId}/narration`);
    expect(removed.status).toBe(200);
    expect(removed.body.track.status).toBe("removed");
    const state = await api(app, USER_A.token, "GET", `/api/projects/${projectId}/narration`);
    expect(state.body.narration).toBeNull();
    expect(state.body.music).toMatchObject({ mediaId: musicMedia, volume: 0.35, muted: true });
    expect(
      app.supabase.mediaReferences.filter((row) => row.ref_id === narration.body.track.id),
    ).toHaveLength(0);
  });

  it("replaces an active track and keeps the prior row as history", async () => {
    const { app } = await startNarrationApp();
    const projectId = await createProject(app);
    const first = seedAudio(app, projectId);
    const second = seedAudio(app, projectId, "77777777-7777-4777-8777-777777777777");
    const one = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/music`, { mediaId: first });
    const two = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/music`, { mediaId: second });
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(app.supabase.narrationTracks.map((row) => row.status)).toEqual(["replaced", "active"]);
    expect(
      app.supabase.mediaReferences.filter((row) => row.ref_id === one.body.track.id),
    ).toHaveLength(0);
  });

  it("refuses a non-audio or not-ready asset", async () => {
    const { app } = await startNarrationApp();
    const projectId = await createProject(app);
    const mediaId = seedAudio(app, projectId);
    const row = app.supabase.media.find((item) => item.id === mediaId)!;
    row.kind = "image";
    const response = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/narration/upload`, {
      mediaId,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("AUDIO_ASSET_INVALID");
  });
});
