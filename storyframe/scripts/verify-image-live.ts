import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createStoryframeServer } from "../server/app";

/**
 * Opt-in live check for the Phase 7 image-generation route.
 *
 * Creates one disposable Supabase user and one project, estimates an image,
 * explicitly generates one image through the configured provider (this spends
 * provider credit), verifies the stored generation record, the private media
 * row, and a playback URL, then deletes the project and user.
 *
 * Pass --fake-provider (npm run verify:image-routes-live) to keep real
 * Supabase and R2 but answer the provider call locally. That verifies the
 * route, record, and storage path without spending provider credit.
 *
 * The server runs with the per-user guard set to one image, so a second attempt
 * must be refused (429 IMAGE_SPEND_LIMIT) without reaching the provider.
 *
 * It never prints keys, tokens, signed URLs, prompts, or provider responses.
 */
try {
  loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // .env is optional when the variables already exist in the environment.
}

const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
const r2 = {
  endpoint: process.env.R2_ENDPOINT ?? process.env.CLOUDFLARE_S3_ENDPOINT_URL,
  bucket: process.env.R2_BUCKET_NAME ?? process.env.CLOUDFLARE_R2_BUCKET_NAME,
  accessKeyId: process.env.R2_ACCESS_KEY_ID ?? process.env.CLOUDFLARE_ACCESS_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
};
const cloudflareReady = Boolean(
  process.env.CLOUDFLARE_ACCOUNT_ID?.trim() &&
    (process.env.CLOUDFLARE_AI_API_TOKEN?.trim() || process.env.CF_API_TOKEN?.trim()),
);
const preferredProvider = process.env.IMAGE_VERIFY_PROVIDER?.trim().toLowerCase();
const leonardoReady = Boolean(process.env.LEONARDO_API_KEY?.trim());
const fakeProvider = process.argv.includes("--fake-provider");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Local answer for the Workers AI call; every other request stays real. */
function fakeProviderFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.cloudflare.com/")) {
      return new Response(
        JSON.stringify({
          result: { image: PNG.toString("base64"), usage: { neurons: 57.6 } },
          success: true,
        }),
        {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return fetch(input as RequestInfo, init);
  }) as typeof fetch;
}

if (!base || !serviceRoleKey || !publishableKey) {
  console.error("verify:image-live requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_PUBLISHABLE_KEY.");
  process.exit(1);
}
if (!r2.endpoint || !r2.bucket || !r2.accessKeyId || !r2.secretAccessKey) {
  console.error("verify:image-live requires R2_ENDPOINT/R2_BUCKET_NAME/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY (or the CLOUDFLARE_* aliases).");
  process.exit(1);
}
if (!fakeProvider && !leonardoReady && !cloudflareReady) {
  console.error("verify:image-live requires LEONARDO_API_KEY or CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AI_API_TOKEN.");
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
  const email = `storyframe-image-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
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

const document = {
  schemaVersion: 2,
  summary: "",
  brief: {
    topic: "Live image check",
    audience: "Internal",
    goal: "Prove the image generation route",
    mode: "fiction",
    targetDurationSeconds: 30,
    tone: "Neutral",
    preset: "Story short",
    voicePreference: "neutral",
    planningBudgetUsd: 0,
  },
  scenes: [
    {
      id: "s1",
      heading: "Opening",
      body: "Hello",
      visualDirection: "",
      assetIds: [],
      onScreenText: "",
      durationSeconds: 10,
      approved: false,
      approvedFingerprint: null,
      locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
    },
  ],
};

async function main(): Promise<number> {
  const server = createStoryframeServer({
    env: {
      ...process.env,
      IMAGE_DAILY_IMAGES_PER_USER: process.env.IMAGE_VERIFY_DAILY_IMAGES ?? "1",
      IMAGE_DAILY_USD_PER_USER: process.env.IMAGE_VERIFY_DAILY_USD ?? "1",
      ...(fakeProvider
        ? { CLOUDFLARE_ACCOUNT_ID: "fake-account", CLOUDFLARE_AI_API_TOKEN: "fake-token" }
        : {}),
    },
    ...(fakeProvider ? { fetchImpl: fakeProviderFetch() } : {}),
  });
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

    const models = await api(user.token, "GET", "/api/image-models");
    // Cloudflare wins by default because its request is synchronous and cheap.
    const useLeonardo =
      !fakeProvider &&
      (preferredProvider === "leonardo" || (preferredProvider !== "cloudflare" && !cloudflareReady && leonardoReady));
    const modelKey = useLeonardo ? "leonardo:phoenix-1.0" : "cloudflare:flux-1-schnell";
    const model = models.body?.models?.find((entry: any) => entry.key === modelKey);
    check(
      "the configured provider's model is listed and enabled",
      models.status === 200 && model?.configured === true,
      `status=${models.status} model=${modelKey}`,
    );

    const createdProject = await api(user.token, "POST", "/api/projects", {
      projectType: "story",
      title: "Image generation check",
      document,
    });
    projectId = createdProject.body?.project?.id ?? null;
    check("disposable project is created", createdProject.status === 201 && projectId !== null);
    if (!projectId) return 1;

    const estimate = await api(user.token, "POST", `/api/projects/${projectId}/image-generations/estimate`, {
      modelKey,
      prompt: "a lighthouse on a stormy coast, cinematic light",
    });
    if (modelKey === "leonardo:phoenix-1.0") {
      check(
        "the estimate reports api credit and no invented USD rate",
        estimate.status === 200 &&
          estimate.body?.estimate?.estimatedUsd === null &&
          estimate.body?.estimate?.billing?.kind === "api-credit",
        `status=${estimate.status}`,
      );
    } else {
      check(
        "the estimate reports neurons and a US dollar cost",
        estimate.status === 200 &&
          estimate.body?.estimate?.estimatedNeurons > 0 &&
          estimate.body?.estimate?.estimatedUsd > 0,
        `status=${estimate.status}`,
      );
    }

    let generated = await api(user.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey,
      prompt: "a lighthouse on a stormy coast, cinematic light",
    });
    let generation = generated.body?.generation;
    for (let attempt = 0; generated.status === 202 && attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      generated = await api(
        user.token,
        "POST",
        `/api/projects/${projectId}/image-generations/${generation.id}/refresh`,
      );
      generation = generated.body?.generation ?? generation;
    }
    check(
      "a real image is generated and recorded",
      (generated.status === 201 || generated.status === 200) &&
        generation?.status === "succeeded" &&
        typeof generation?.id === "string" &&
        generation?.prompt?.length > 0 &&
        generation?.modelKey === modelKey &&
        generation?.rateVersion?.length > 0,
      `status=${generated.status} code=${generated.body?.error?.code ?? "none"}`,
    );
    if (modelKey === "cloudflare:flux-1-schnell") {
      const actualNeurons = generation?.actualNeurons;
      const expectedUsd =
        typeof actualNeurons === "number" ? Number(((actualNeurons / 1000) * 0.011).toFixed(6)) : null;
      check(
        "the provider-reported cost is stored with the generation",
        typeof actualNeurons === "number" &&
          actualNeurons > 0 &&
          generation?.actualUsd === expectedUsd &&
          generation?.costSource === "rate" &&
          typeof generation?.providerCost?.usage?.neurons === "number" &&
          Math.abs(generation.providerCost.usage.neurons - actualNeurons) < 0.001,
        `neurons=${actualNeurons} usd=${generation?.actualUsd} expected=${expectedUsd} source=${generation?.costSource} cost=${JSON.stringify(generation?.providerCost).slice(0, 200)}`,
      );
    }

    check(
      "the generation keeps the provider job or synchronous marker and settings",
      generation?.provider === (modelKey === "leonardo:phoenix-1.0" ? "leonardo" : "cloudflare") &&
        typeof generation?.settings?.width === "number" &&
        typeof generation?.settings?.height === "number",
    );

    const mediaId = generation?.mediaId;
    check("the generated bytes are stored as ready media", generated.body?.media?.status === "ready" && Boolean(mediaId));

    const mediaList = await api(user.token, "GET", `/api/projects/${projectId}/media`);
    const stored = Array.isArray(mediaList.body?.media)
      ? mediaList.body.media.find((entry: any) => entry.id === mediaId)
      : null;
    check("the generated media is listed in the project", stored?.status === "ready" && stored?.kind === "image");

    const playback = await api(user.token, "GET", `/api/projects/${projectId}/media/${mediaId}/url`);
    check(
      "the generated media has a private playback URL",
      playback.status === 200 && typeof playback.body?.url === "string" && playback.body.url.includes("X-Amz-Signature="),
    );

    const list = await api(user.token, "GET", `/api/projects/${projectId}/image-generations`);
    check(
      "the generation record is listed for the project",
      list.status === 200 && list.body?.generations?.some((row: any) => row.id === generation.id),
    );

    const recorded = await serviceRows(`image_generations?select=id&owner_id=eq.${user.id}`);
    const guarded = await api(user.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey,
      prompt: "a second image the spending guard should refuse",
    });
    check(
      "the per-user spending guard refuses a second generation",
      guarded.status === 429 && guarded.body?.error?.code === "IMAGE_SPEND_LIMIT",
      `status=${guarded.status} code=${guarded.body?.error?.code ?? "none"}`,
    );
    const afterGuard = await serviceRows(`image_generations?select=id&owner_id=eq.${user.id}`);
    check(
      "the refused generation is not recorded or stored",
      recorded.length > 0 && afterGuard.length === recorded.length && Boolean(generated.body?.media?.id),
      `before=${recorded.length} after=${afterGuard.length}`,
    );
  } finally {
    const generationRows = user
      ? await serviceRows(`image_generations?select=id&owner_id=eq.${user.id}`)
      : [];
    if (projectId && user) {
      const deleted = await api(user.token, "DELETE", `/api/projects/${projectId}`);
      console.log(`cleanup project delete -> ${deleted.status}`);
      check("cleanup removes the project", deleted.status === 200);
    }
    if (user) {
      const remaining = await serviceRows(`image_generations?select=id&owner_id=eq.${user.id}`);
      check("cleanup leaves no generation rows", generationRows.length > 0 && remaining.length === 0);
      const deletedUser = await fetch(`${base}/auth/v1/admin/users/${user.id}`, {
        method: "DELETE",
        headers: adminHeaders,
      });
      console.log(`cleanup user delete -> ${deletedUser.status}`);
      check("cleanup removes the disposable user", deletedUser.ok);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`verify:image-live failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exit(1);
  });
