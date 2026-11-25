import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createStoryframeServer } from "../server/app";
import { DEEPGRAM_PREVIEW_TEXT } from "../server/deepgram";
import { sceneFingerprint } from "../shared/scene-fingerprint";
import { preflightUpload } from "./preview-origin";

/**
 * Opt-in Phase 8 acceptance check against real Deepgram, Supabase, and R2.
 * Creates one disposable user/project, generates narration from an approved
 * script, verifies the measured persisted track and private playback, uploads
 * narration and music through the real media/R2 path, verifies both, then
 * removes the project and user. It never prints keys or signed URLs.
 */
try {
  loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // .env is optional when the variables already exist in the environment.
}

const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
const deepgramKey = process.env.DEEPGRAM_API_KEY?.trim();
const r2Ready = Boolean(
  (process.env.R2_ENDPOINT ?? process.env.CLOUDFLARE_S3_ENDPOINT_URL) &&
    (process.env.R2_BUCKET_NAME ?? process.env.CLOUDFLARE_R2_BUCKET_NAME) &&
    (process.env.R2_ACCESS_KEY_ID ?? process.env.CLOUDFLARE_ACCESS_ID) &&
    (process.env.R2_SECRET_ACCESS_KEY ?? process.env.CLOUDFLARE_SECRET_ACCESS_KEY),
);

if (!base || !serviceRoleKey || !publishableKey) {
  console.error("verify:narration-live requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_PUBLISHABLE_KEY.");
  process.exit(1);
}
if (!deepgramKey) {
  console.error("verify:narration-live requires DEEPGRAM_API_KEY.");
  process.exit(1);
}
if (!r2Ready) {
  console.error("verify:narration-live requires the R2 endpoint, bucket, access key, and secret.");
  process.exit(1);
}

const adminHeaders = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};
const serviceHeaders = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
const authHeaders = { apikey: publishableKey, "Content-Type": "application/json" };

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

async function createUser(): Promise<{ id: string; token: string }> {
  const email = `storyframe-narration-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
  const password = `R${randomUUID()}a1!`;
  const created = await fetch(`${base}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const createdBody = (await created.json().catch(() => ({}))) as { id?: string; user?: { id?: string } };
  const id = createdBody.id ?? createdBody.user?.id;
  if (!created.ok || typeof id !== "string") {
    throw new Error(`could not create a disposable user (HTTP ${created.status})`);
  }
  const login = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ email, password }),
  });
  const session = (await login.json().catch(() => ({}))) as { access_token?: string };
  if (!login.ok || typeof session.access_token !== "string") {
    throw new Error(`could not sign in the disposable user (HTTP ${login.status})`);
  }
  return { id, token: session.access_token };
}

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

const MUSIC_CASES = [
  { label: "WAV", contentType: "audio/wav", bytes: wavBytes(1) },
  {
    label: "M4A",
    contentType: "audio/mp4",
    bytes: readFileSync(new URL("../tests/fixtures/audio/tone-1s.m4a", import.meta.url)),
  },
  {
    label: "OGG",
    contentType: "audio/ogg",
    bytes: readFileSync(new URL("../tests/fixtures/audio/tone-1s.ogg", import.meta.url)),
  },
  {
    label: "AAC",
    contentType: "audio/aac",
    bytes: readFileSync(new URL("../tests/fixtures/audio/tone-1s.aac", import.meta.url)),
  },
] as const;

const scene = {
  id: "s1",
  heading: "Opening",
  body: "The letter waits under a seat as the night train crosses the coast.",
  visualDirection: "",
  assetIds: [],
  onScreenText: "",
  durationSeconds: 8,
  approved: true,
  approvedFingerprint: "",
  locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
};
scene.approvedFingerprint = sceneFingerprint(scene);

const document = {
  schemaVersion: 2,
  summary: "A short live narration check.",
  brief: {
    topic: "Live narration check",
    audience: "Internal",
    goal: "Prove the narration route",
    mode: "fiction",
    targetDurationSeconds: 30,
    tone: "Neutral",
    preset: "Story short",
    voicePreference: "neutral",
    planningBudgetUsd: 0,
  },
  scenes: [scene],
};

async function main(): Promise<number> {
  const server = createStoryframeServer({ env: process.env });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no loopback port assigned");
  const appUrl = `http://127.0.0.1:${address.port}`;

  async function api(
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${appUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  async function uploadAudio(
    token: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<{
    id: string;
    status: string;
    byteSize: number;
    contentType: string;
    uploadUrl: string;
  }> {
    const initiated = await api(token, "POST", `/api/projects/${projectId}/media`, {
      kind: "audio",
      contentType,
      byteSize: bytes.length,
    });
    if (initiated.status !== 201) {
      throw new Error(`media initiation failed (HTTP ${initiated.status})`);
    }
    const put = await fetch(initiated.body.upload.url, {
      method: "PUT",
      headers: initiated.body.upload.headers,
      body: new Uint8Array(bytes),
    });
    if (!put.ok) throw new Error(`R2 upload failed (HTTP ${put.status})`);
    const completed = await api(
      token,
      "POST",
      `/api/projects/${projectId}/media/${initiated.body.media.id}/complete`,
      {},
    );
    if (completed.status !== 200) {
      throw new Error(`media completion failed (HTTP ${completed.status})`);
    }
    return { ...completed.body.media, uploadUrl: initiated.body.upload.url };
  }

  async function serviceRows(query: string): Promise<any[]> {
    const response = await fetch(`${base}/rest/v1/${query}`, { headers: serviceHeaders });
    if (!response.ok) return [];
    const payload = await response.json().catch(() => null);
    return Array.isArray(payload) ? payload : [];
  }

  let user: { id: string; token: string } | null = null;
  let projectId: string | null = null;

  try {
    user = await createUser();

    const voices = await api(user.token, "GET", "/api/narration/voices");
    const voice = voices.body?.voices?.find((item: any) => item.model === "aura-2-thalia-en");
    check(
      "the verified Aura-2 voice is listed and Deepgram is configured",
      voices.status === 200 && voices.body?.configured === true && voice?.model === "aura-2-thalia-en",
      `status=${voices.status}`,
    );

    const createdProject = await api(user.token, "POST", "/api/projects", {
      projectType: "story",
      title: "Narration live check",
      document,
    });
    projectId = createdProject.body?.project?.id ?? null;
    check("disposable project with an approved script is created", createdProject.status === 201 && projectId !== null);
    if (!projectId) return 1;

    const preview = await fetch(`${appUrl}/api/projects/${projectId}/narration/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` },
      body: JSON.stringify({ voiceModel: "aura-2-thalia-en" }),
    });
    const previewType = preview.headers.get("content-type") ?? "audio/mpeg";
    const previewBytes = Buffer.from(await preview.arrayBuffer());
    check(
      "a real Deepgram voice sample is returned as audio",
      preview.status === 200 &&
        String(preview.headers.get("content-type")).startsWith("audio/") &&
        previewBytes.length > 0,
      `status=${preview.status} bytes=${previewBytes.length}`,
    );

    const generated = await api(user.token, "POST", `/api/projects/${projectId}/narration`, {
      voiceModel: "aura-2-thalia-en",
    });
    const generatedTrack = generated.body?.track;
    check(
      "a real Deepgram response becomes a persisted narration",
      generated.status === 201 &&
        generatedTrack?.source === "deepgram" &&
        generatedTrack?.status === "active" &&
        typeof generatedTrack?.durationSeconds === "number" &&
        generatedTrack.durationSeconds > 0 &&
        generated.body?.media?.status === "ready" &&
        generated.body?.media?.kind === "audio",
      `status=${generated.status} duration=${generatedTrack?.durationSeconds}`,
    );
    check(
      "the exact script fingerprint and voice settings are recorded",
      typeof generatedTrack?.scriptFingerprint === "string" &&
        generatedTrack.scriptFingerprint.length === 64 &&
        generatedTrack?.scriptCharacters === scene.body.length &&
        generatedTrack?.voiceModel === "aura-2-thalia-en" &&
        generatedTrack?.voiceName === "Thalia",
    );
    check(
      "the provider charge is recorded from the verified per-character rate",
      generatedTrack?.costUsd > 0 &&
        generatedTrack?.costRateVersion === "deepgram-aura-2-2026-11-25",
      `cost=${generatedTrack?.costUsd}`,
    );

    const state = await api(user.token, "GET", `/api/projects/${projectId}/narration`);
    check(
      "the active narration and measured timing are reported",
      state.status === 200 &&
        state.body?.narration?.id === generatedTrack?.id &&
        state.body?.stale === false &&
        typeof state.body?.timing?.narrationSeconds === "number",
    );

    const playbackLink = await api(
      user.token,
      "GET",
      `/api/projects/${projectId}/media/${generated.body?.media?.id}/url`,
    );
    const played = await fetch(playbackLink.body?.url);
    const playedBytes = Buffer.from(await played.arrayBuffer());
    check(
      "the persisted narration is playable through a private URL",
      playbackLink.status === 200 && played.ok && playedBytes.length === generated.body?.media?.byteSize,
      `status=${played.status} bytes=${playedBytes.length}`,
    );

    const rows = await serviceRows(
      `narration_tracks?select=id,status,duration_seconds,cost_usd&project_id=eq.${projectId}`,
    );
    check(
      "the hosted database holds the settled narration row",
      rows.length === 1 && rows[0]?.status === "active" && rows[0]?.duration_seconds > 0,
    );

    const usageRows = await serviceRows(
      `narration_usage?select=kind,status,characters,cost_usd&project_id=eq.${projectId}`,
    );
    check(
      "previews and generations are recorded in the hosted usage ledger",
      usageRows.length === 2 &&
        usageRows.every((row) => row.status === "succeeded") &&
        usageRows.some((row) => row.kind === "preview") &&
        usageRows.some((row) => row.kind === "generation") &&
        usageRows.reduce((sum, row) => sum + row.characters, 0) ===
          scene.body.length + Array.from(DEEPGRAM_PREVIEW_TEXT).length &&
        usageRows.every((row) => row.cost_usd > 0),
      JSON.stringify(usageRows.map((row) => [row.kind, row.status, row.characters, row.cost_usd])),
    );

    const deniedReservation = await fetch(`${base}/rest/v1/rpc/reserve_narration_usage`, {
      method: "POST",
      headers: { ...serviceHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_owner_id: user.id,
        p_project_id: projectId,
        p_kind: "generation",
        p_characters: 1,
        p_cost_usd: 0.00003,
        p_rate_version: "deepgram-aura-2-2026-11-25",
        p_character_limit: 1,
        p_usd_limit: 0,
        p_window_seconds: 86400,
      }),
    });
    const deniedBody = (await deniedReservation.json().catch(() => null)) as any;
    check(
      "the hosted atomic reservation refuses an over-budget attempt without adding a row",
      deniedReservation.status === 200 &&
        Array.isArray(deniedBody) &&
        deniedBody[0]?.allowed === false &&
        deniedBody[0]?.usage_id === null &&
        (await serviceRows(`narration_usage?select=id&project_id=eq.${projectId}`)).length === 2,
      `status=${deniedReservation.status}`,
    );

    const uploadedNarration = await uploadAudio(user.token, previewBytes, previewType);
    check(
      "a real narration file uploads through the private R2 media path",
      uploadedNarration.status === "ready" &&
        uploadedNarration.byteSize === previewBytes.length &&
        uploadedNarration.contentType === previewType,
      `type=${uploadedNarration.contentType} bytes=${uploadedNarration.byteSize}`,
    );
    const cors = await preflightUpload(uploadedNarration.uploadUrl);
    check("the bucket CORS rule lets the browser upload from the cors.json preview origin", cors.ok, cors.detail);

    const attachedNarration = await api(
      user.token,
      "POST",
      `/api/projects/${projectId}/narration/upload`,
      { mediaId: uploadedNarration.id },
    );
    check(
      "uploaded narration is measured from R2 and replaces the generated track",
      attachedNarration.status === 201 &&
        attachedNarration.body?.track?.source === "upload" &&
        attachedNarration.body?.track?.status === "active" &&
        attachedNarration.body?.track?.durationSeconds > 0,
      `status=${attachedNarration.status} duration=${attachedNarration.body?.track?.durationSeconds}`,
    );

    const uploadedMusic = await uploadAudio(user.token, playedBytes, generated.body.media.contentType);
    check(
      "a real music file uploads through the private R2 media path",
      uploadedMusic.status === "ready" && uploadedMusic.byteSize === playedBytes.length,
      `type=${uploadedMusic.contentType} bytes=${uploadedMusic.byteSize}`,
    );
    const attachedMusic = await api(user.token, "POST", `/api/projects/${projectId}/music`, {
      mediaId: uploadedMusic.id,
    });
    check(
      "uploaded music is measured and active alongside narration",
      attachedMusic.status === 201 &&
        attachedMusic.body?.track?.source === "upload" &&
        attachedMusic.body?.track?.status === "active" &&
        attachedMusic.body?.track?.durationSeconds > 0,
      `status=${attachedMusic.status} duration=${attachedMusic.body?.track?.durationSeconds}`,
    );

    const uploadedState = await api(user.token, "GET", `/api/projects/${projectId}/narration`);
    check(
      "the state exposes uploaded narration and music together",
      uploadedState.status === 200 &&
        uploadedState.body?.narration?.mediaId === uploadedNarration.id &&
        uploadedState.body?.music?.mediaId === uploadedMusic.id,
    );
    const narrationPlayback = await api(
      user.token,
      "GET",
      `/api/projects/${projectId}/media/${uploadedNarration.id}/url`,
    );
    const narrationBytes = Buffer.from(await (await fetch(narrationPlayback.body?.url)).arrayBuffer());
    check(
      "uploaded narration plays back byte-for-byte from private R2",
      narrationPlayback.status === 200 && narrationBytes.equals(previewBytes),
      `bytes=${narrationBytes.length}`,
    );
    const musicPlayback = await api(
      user.token,
      "GET",
      `/api/projects/${projectId}/media/${uploadedMusic.id}/url`,
    );
    const musicBytes = Buffer.from(await (await fetch(musicPlayback.body?.url)).arrayBuffer());
    check(
      "uploaded music plays back byte-for-byte from private R2",
      musicPlayback.status === 200 && musicBytes.equals(playedBytes),
      `bytes=${musicBytes.length}`,
    );

    let activeMusicMediaId: string | null = null;
    for (const music of MUSIC_CASES) {
      const uploaded = await uploadAudio(user.token, music.bytes, music.contentType);
      check(
        `${music.label} music uploads and is detected from its bytes`,
        uploaded.status === "ready" &&
          uploaded.contentType === music.contentType &&
          uploaded.byteSize === music.bytes.length,
        `type=${uploaded.contentType} bytes=${uploaded.byteSize}`,
      );
      const attached = await api(user.token, "POST", `/api/projects/${projectId}/music`, {
        mediaId: uploaded.id,
      });
      check(
        `uploaded ${music.label} music is measured and replaces the prior music track`,
        attached.status === 201 &&
          attached.body?.track?.source === "upload" &&
          attached.body?.track?.durationSeconds > 0,
        `status=${attached.status} duration=${attached.body?.track?.durationSeconds}`,
      );
      const playback = await api(
        user.token,
        "GET",
        `/api/projects/${projectId}/media/${uploaded.id}/url`,
      );
      const bytesBack = Buffer.from(await (await fetch(playback.body?.url)).arrayBuffer());
      check(
        `uploaded ${music.label} music plays back byte-for-byte from private R2`,
        playback.status === 200 && bytesBack.equals(music.bytes),
        `bytes=${bytesBack.length}`,
      );
      activeMusicMediaId = uploaded.id;
    }

    const activeRows = await serviceRows(
      `narration_tracks?select=kind,status,media_id,duration_seconds&project_id=eq.${projectId}&status=eq.active&order=kind`,
    );
    check(
      "the hosted database holds active uploaded narration and music rows",
      activeRows.length === 2 &&
        activeRows.every((row) => row.status === "active" && row.duration_seconds > 0) &&
        activeRows.some((row) => row.kind === "narration" && row.media_id === uploadedNarration.id) &&
        activeRows.some((row) => row.kind === "music" && row.media_id === activeMusicMediaId),
      JSON.stringify(activeRows.map((row) => [row.kind, row.status, row.duration_seconds])),
    );

    const removedProject = await api(user.token, "DELETE", `/api/projects/${projectId}`);
    check("cleanup removes the project", removedProject.status === 200);
    const remaining = await serviceRows(`narration_tracks?select=id&project_id=eq.${projectId}`);
    check("cleanup leaves no narration rows", remaining.length === 0);
    const remainingUsage = await serviceRows(
      `narration_usage?select=id,project_id&owner_id=eq.${user.id}`,
    );
    check(
      "project cleanup preserves the usage ledger and clears its project reference",
      remainingUsage.length === 2 && remainingUsage.every((row) => row.project_id === null),
      JSON.stringify(remainingUsage.map((row) => [row.id, row.project_id])),
    );
  } finally {
    if (projectId) await api(user?.token ?? null, "DELETE", `/api/projects/${projectId}`).catch(() => undefined);
    if (user) {
      await fetch(`${base}/auth/v1/admin/users/${user.id}`, {
        method: "DELETE",
        headers: adminHeaders,
      }).catch(() => undefined);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
