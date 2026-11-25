import { afterEach, describe, expect, it } from "vitest";
import { USER_A, USER_B } from "./fake-supabase";
import { documentFixture } from "./project-fixture";
import { startTestServer, type TestApp } from "./server-helpers";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
]);

const PROVIDER_ENV = {
  CLOUDFLARE_ACCOUNT_ID: "account-1",
  CLOUDFLARE_AI_API_TOKEN: "cf-token",
  LEONARDO_API_KEY: "leo-key",
  IMAGE_POLL_INTERVAL_MS: "100",
  IMAGE_GENERATION_TIMEOUT_MS: "1000",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface ProviderState {
  cloudflareStatus?: number;
  /** Holds the Workers AI response open so a concurrent request can arrive. */
  cloudflareGate?: Promise<void>;
  /** Polls return PENDING while true. */
  leonardoPending?: boolean;
  leonardoJobId?: string;
  /** Adds the provider's cost object and credits to the completed poll. */
  leonardoCost?: boolean;
  imageUrl?: string;
  imageBytes?: Buffer;
}

/** Routes only provider hosts; Supabase/R2 stay on their local fakes. */
function providerFetch(state: ProviderState = {}): typeof fetch {
  const jobId = state.leonardoJobId ?? "job-1";
  const imageUrl = state.imageUrl ?? "https://cdn.leonardo.ai/generated.png";
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.cloudflare.com/")) {
      if (state.cloudflareGate) await state.cloudflareGate;
      if (state.cloudflareStatus && state.cloudflareStatus >= 400) {
        return jsonResponse({ error: "provider failure cf-token" }, state.cloudflareStatus);
      }
      return jsonResponse({
        result: { image: PNG.toString("base64"), usage: { neurons: 57.6 } },
        success: true,
      });
    }
    if (url === "https://cloud.leonardo.ai/api/rest/v1/generations" && init?.method === "POST") {
      return jsonResponse({ sdGenerationJob: { generationId: jobId } });
    }
    if (url.startsWith("https://cloud.leonardo.ai/api/rest/v1/generations/")) {
      return jsonResponse({
        generations_by_pk: state.leonardoPending
          ? { status: "PENDING" }
          : {
              status: "COMPLETE",
              generated_images: [{ url: imageUrl }],
              ...(state.leonardoCost
                ? { apiCreditCost: 3, cost: { amount: 0.02, unit: "USD" } }
                : {}),
            },
      });
    }
    if (url === imageUrl) {
      return new Response(new Uint8Array(state.imageBytes ?? PNG), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }
    return fetch(input as RequestInfo, init);
  }) as typeof fetch;
}

const apps: TestApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function startImageApp(
  state: ProviderState = {},
  env: Record<string, string> = PROVIDER_ENV,
): Promise<TestApp> {
  const app = await startTestServer({ env, fetchImpl: providerFetch(state) });
  apps.push(app);
  return app;
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

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached");
}

/** Seeds a prior recorded attempt, as the guard counts store rows. */
function seedGeneration(app: TestApp, overrides: Record<string, unknown> = {}): void {
  const timestamp = new Date().toISOString();
  app.supabase.imageGenerations.push({
    id: `seed-${app.supabase.imageGenerations.length + 1}`,
    owner_id: USER_A.id,
    project_id: "seed-project",
    provider: "cloudflare",
    model_key: "cloudflare:flux-1-schnell",
    prompt: "seeded generation",
    settings: { width: 1024, height: 1024, steps: 4 },
    status: "succeeded",
    job_id: null,
    media_id: null,
    estimated_usd: 0.001901,
    estimated_neurons: 172.8,
    rate_version: "v1",
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  });
}

async function createProject(app: TestApp, token = USER_A.token): Promise<string> {
  const response = await api(app, token, "POST", "/api/projects", {
    projectType: "story",
    title: "Image generation",
    document: documentFixture(),
  });
  expect(response.status).toBe(201);
  return response.body.project.id;
}

describe("image models", () => {
  it("lists both verified models and their configuration state", async () => {
    const app = await startImageApp();
    const response = await api(app, USER_A.token, "GET", "/api/image-models");

    expect(response.status).toBe(200);
    const flux = response.body.models.find((model: any) => model.key === "cloudflare:flux-1-schnell");
    const phoenix = response.body.models.find((model: any) => model.key === "leonardo:phoenix-1.0");
    expect(flux).toMatchObject({ provider: "cloudflare", configured: true, steps: 4, maxPromptChars: 2048 });
    expect(flux.billing).toMatchObject({ kind: "neurons", usdPerThousandNeurons: 0.011 });
    expect(phoenix).toMatchObject({ provider: "leonardo", configured: true, maxPromptChars: 2000 });
    expect(phoenix.billing).toMatchObject({ kind: "api-credit" });
    expect(phoenix.billing.note).toContain("unverified");

    const anonymous = await fetch(`${app.url}/api/image-models`);
    expect(anonymous.status).toBe(401);
  });

  it("estimates from verified rates without calling a provider", async () => {
    const app = await startImageApp();
    const projectId = await createProject(app);
    const response = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations/estimate`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "rainy city street",
    });

    expect(response.status).toBe(200);
    expect(response.body.estimate).toMatchObject({
      width: 1024,
      height: 1024,
      steps: 4,
      estimatedNeurons: 172.8,
      estimatedUsd: 0.001901,
    });
    expect(app.supabase.imageGenerations).toHaveLength(0);
    expect(app.r2.puts).toBe(0);
  });
});

describe("image generation", () => {
  it("generates with Cloudflare, persists the bytes, and stores the record", async () => {
    const app = await startImageApp();
    const projectId = await createProject(app);
    const response = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "rainy city street",
    });

    expect(response.status).toBe(201);
    expect(response.body.generation).toMatchObject({
      provider: "cloudflare",
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "rainy city street",
      settings: { width: 1024, height: 1024, steps: 4 },
      status: "succeeded",
      jobId: null,
      estimatedNeurons: 172.8,
      actualNeurons: 57.6,
      actualUsd: 0.000634,
      costSource: "rate",
      providerCost: { provider: "cloudflare", usage: { neurons: 57.6 } },
      rateVersion: "cloudflare-flux-schnell-2026-11-25",
    });
    expect(response.body.media).toMatchObject({ kind: "image", status: "ready", contentType: "image/png" });
    expect(response.body.generation.mediaId).toBe(response.body.media.id);
    expect(app.r2.puts).toBe(1);
    expect(app.supabase.imageGenerations).toHaveLength(1);
    expect(app.supabase.imageGenerations[0]).toMatchObject({ status: "succeeded", rate_version: expect.any(String) });

    const media = await api(app, USER_A.token, "GET", `/api/projects/${projectId}/media`);
    expect(media.body.media[0]).toMatchObject({ id: response.body.media.id, status: "ready" });

    const generations = await api(app, USER_A.token, "GET", `/api/projects/${projectId}/image-generations`);
    expect(generations.body.generations.map((row: any) => row.id)).toEqual([response.body.generation.id]);
    expect(app.r2.objects.size).toBe(1);
  });

  it("polls Leonardo, downloads the result, and records its job id", async () => {
    const app = await startImageApp();
    const projectId = await createProject(app);
    const response = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey: "leonardo:phoenix-1.0",
      prompt: "orange cat on a basketball",
      width: 1472,
      height: 832,
    });

    expect(response.status).toBe(201);
    expect(response.body.generation).toMatchObject({
      provider: "leonardo",
      status: "succeeded",
      jobId: "job-1",
      settings: { width: 1472, height: 832 },
      estimatedUsd: null,
      estimatedNeurons: null,
    });
    expect(response.body.media.status).toBe("ready");
    expect(app.r2.puts).toBe(1);
    // Without a provider cost object, no dollar amount is invented.
    expect(response.body.generation.actualUsd).toBeNull();
    expect(response.body.generation.costSource).toBeNull();
  });

  it("captures a provider-reported dollar cost on completion", async () => {
    const app = await startImageApp({ leonardoCost: true });
    const projectId = await createProject(app);
    const response = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey: "leonardo:phoenix-1.0",
      prompt: "a lighthouse",
    });

    expect(response.status).toBe(201);
    expect(response.body.generation).toMatchObject({
      actualUsd: 0.02,
      actualNeurons: null,
      costSource: "provider",
      providerCost: { provider: "leonardo", apiCreditCost: 3, cost: { amount: 0.02, unit: "USD" } },
    });
  });

  it("leaves a pending Leonardo job refreshable and completes it later", async () => {
    const state: ProviderState = { leonardoPending: true };
    const app = await startImageApp(state);
    const projectId = await createProject(app);
    const created = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey: "leonardo:phoenix-1.0",
      prompt: "a lighthouse",
    });

    expect(created.status).toBe(202);
    expect(created.body.generation).toMatchObject({ status: "pending", jobId: "job-1", mediaId: null });
    expect(created.body.media).toBeNull();
    expect(app.r2.puts).toBe(0);

    state.leonardoPending = false;
    const refreshed = await api(
      app,
      USER_A.token,
      "POST",
      `/api/projects/${projectId}/image-generations/${created.body.generation.id}/refresh`,
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.generation.status).toBe("succeeded");
    expect(refreshed.body.media.status).toBe("ready");
    expect(app.r2.puts).toBe(1);
  });

  it("accepts CF_API_TOKEN as the Workers AI credential", async () => {
    const app = await startImageApp({}, { CLOUDFLARE_ACCOUNT_ID: "account-1", CF_API_TOKEN: "cf-token" });
    const projectId = await createProject(app);
    const models = await api(app, USER_A.token, "GET", "/api/image-models");
    expect(models.body.models.find((model: any) => model.provider === "cloudflare").configured).toBe(true);

    const generated = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "rain",
    });
    expect(generated.status).toBe(201);
    expect(generated.body.generation.status).toBe("succeeded");
  });

  it("refuses providers without credentials while still offering estimates", async () => {
    const app = await startImageApp({}, {});
    const projectId = await createProject(app);
    const models = await api(app, USER_A.token, "GET", "/api/image-models");
    expect(models.body.models.every((model: any) => model.configured === false)).toBe(true);

    const estimate = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations/estimate`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "rain",
    });
    expect(estimate.status).toBe(200);

    const generated = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "rain",
    });
    expect(generated.status).toBe(503);
    expect(generated.body.error.code).toBe("IMAGE_PROVIDER_DISABLED");
    expect(app.supabase.imageGenerations).toHaveLength(0);
  });

  it("stores a failed record when the provider rejects the generation", async () => {
    const app = await startImageApp({ cloudflareStatus: 500 });
    const projectId = await createProject(app);
    const response = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "rain",
    });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("IMAGE_PROVIDER_FAILED");
    expect(response.body.error.message).not.toContain("cf-token");
    expect(app.supabase.imageGenerations[0]).toMatchObject({
      status: "failed",
      error_code: "IMAGE_PROVIDER_FAILED",
    });
    expect(app.supabase.media).toHaveLength(0);
    expect(app.r2.puts).toBe(0);
  });

  it("enforces the per-user image limit before creating a generation", async () => {
    const app = await startImageApp({}, { ...PROVIDER_ENV, IMAGE_DAILY_IMAGES_PER_USER: "2" });
    const projectId = await createProject(app);
    seedGeneration(app);
    seedGeneration(app);

    const response = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "one more",
    });

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("IMAGE_SPEND_LIMIT");
    expect(response.body.error.message).toContain("limit is 2");
    expect(app.supabase.imageGenerations).toHaveLength(2);
    expect(app.r2.puts).toBe(0);
  });

  it("enforces the estimated USD limit for priced models", async () => {
    const app = await startImageApp({}, { ...PROVIDER_ENV, IMAGE_DAILY_USD_PER_USER: "0.0035" });
    const projectId = await createProject(app);
    seedGeneration(app);

    const response = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "one more",
    });

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("IMAGE_SPEND_LIMIT");
    expect(response.body.error.message).toContain("Image spend");
    expect(app.supabase.imageGenerations).toHaveLength(1);
    expect(app.r2.puts).toBe(0);
  });

  it("ignores old attempts and other accounts when counting the window", async () => {
    const app = await startImageApp({}, {
      ...PROVIDER_ENV,
      IMAGE_DAILY_IMAGES_PER_USER: "2",
      IMAGE_DAILY_USD_PER_USER: "0",
    });
    const projectId = await createProject(app);
    seedGeneration(app, {
      owner_id: USER_A.id,
      created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    seedGeneration(app, { owner_id: USER_B.id });
    seedGeneration(app, { owner_id: USER_B.id });

    const response = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "fresh window",
    });

    expect(response.status).toBe(201);
    expect(app.r2.puts).toBe(1);
  });

  it("does not apply the USD cap to a provider without a published rate", async () => {
    const app = await startImageApp({}, {
      ...PROVIDER_ENV,
      IMAGE_DAILY_IMAGES_PER_USER: "5",
      IMAGE_DAILY_USD_PER_USER: "0.000001",
    });
    const projectId = await createProject(app);
    seedGeneration(app, { estimated_usd: 99 });

    const response = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey: "leonardo:phoenix-1.0",
      prompt: "a lighthouse",
    });

    expect(response.status).toBe(201);
    expect(response.body.generation.estimatedUsd).toBeNull();
  });

  it("refuses a new generation while a stored job is still pending", async () => {
    const app = await startImageApp();
    const projectId = await createProject(app);
    seedGeneration(app, { status: "pending", media_id: null, job_id: "job-old" });

    const response = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "another",
    });

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("IMAGE_GENERATION_IN_FLIGHT");
    expect(app.supabase.imageGenerations).toHaveLength(1);
    expect(app.r2.puts).toBe(0);
  });

  it("names the blocking job from another project and refreshes it there", async () => {
    const state: ProviderState = { leonardoPending: true };
    const app = await startImageApp(state);
    const currentProject = await createProject(app);
    const otherProject = await createProject(app);
    seedGeneration(app, {
      project_id: otherProject,
      provider: "leonardo",
      model_key: "leonardo:phoenix-1.0",
      status: "pending",
      job_id: "job-other",
      media_id: null,
      estimated_usd: null,
      estimated_neurons: null,
    });
    const pendingId = app.supabase.imageGenerations[0].id as string;

    const blocked = await api(app, USER_A.token, "POST", `/api/projects/${currentProject}/image-generations`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "another",
    });

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("IMAGE_GENERATION_IN_FLIGHT");
    expect(blocked.body.error.details.pending).toMatchObject({
      generationId: pendingId,
      projectId: otherProject,
      jobId: "job-other",
      provider: "leonardo",
      modelKey: "leonardo:phoenix-1.0",
    });

    // The client can finish the job through the project that owns it.
    state.leonardoPending = false;
    const refreshed = await api(
      app,
      USER_A.token,
      "POST",
      `/api/projects/${otherProject}/image-generations/${pendingId}/refresh`,
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.generation.status).toBe("succeeded");
    expect(refreshed.body.media.status).toBe("ready");

    const created = await api(app, USER_A.token, "POST", `/api/projects/${currentProject}/image-generations`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "another",
    });
    expect(created.status).toBe(201);
  });

  it("settles the named pending job and unblocks generation", async () => {
    const app = await startImageApp();
    const currentProject = await createProject(app);
    const otherProject = await createProject(app);
    seedGeneration(app, { project_id: otherProject, status: "pending", job_id: "job-held", media_id: null });
    const pendingId = app.supabase.imageGenerations[0].id as string;

    const settled = await api(
      app,
      USER_A.token,
      "POST",
      `/api/projects/${otherProject}/image-generations/${pendingId}/settle`,
    );
    expect(settled.status).toBe(200);
    expect(settled.body.generation).toMatchObject({
      status: "failed",
      errorCode: "IMAGE_GENERATION_ABANDONED",
    });

    // Settling an already settled job reports its state instead of failing.
    const again = await api(
      app,
      USER_A.token,
      "POST",
      `/api/projects/${otherProject}/image-generations/${pendingId}/settle`,
    );
    expect(again.status).toBe(200);
    expect(again.body.generation.status).toBe("failed");

    const created = await api(app, USER_A.token, "POST", `/api/projects/${currentProject}/image-generations`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "after settle",
    });
    expect(created.status).toBe(201);
  });

  it("settles a pending job automatically after the abandon deadline", async () => {
    const app = await startImageApp({}, { ...PROVIDER_ENV, IMAGE_PENDING_ABANDON_AFTER_MS: "60000" });
    const projectId = await createProject(app);
    seedGeneration(app, {
      status: "pending",
      media_id: null,
      job_id: "job-abandoned",
      created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    });

    const created = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "after deadline",
    });

    expect(created.status).toBe(201);
    expect(app.supabase.imageGenerations[0]).toMatchObject({
      status: "failed",
      error_code: "IMAGE_GENERATION_ABANDONED",
    });
    expect(app.supabase.imageGenerations).toHaveLength(2);
  });

  it("sweeps abandoned pending rows on the timer without a request", async () => {
    const app = await startImageApp({}, {
      ...PROVIDER_ENV,
      IMAGE_PENDING_ABANDON_AFTER_MS: "60000",
      IMAGE_PENDING_SWEEP_INTERVAL_MS: "50",
    });
    seedGeneration(app, {
      status: "pending",
      media_id: null,
      created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    });

    await eventually(() => app.supabase.imageGenerations[0].status === "failed");
    expect(app.supabase.imageGenerations[0]).toMatchObject({
      error_code: "IMAGE_GENERATION_ABANDONED",
    });
  });

  it("refuses a second generation while the first is still in flight", async () => {
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const app = await startImageApp({ cloudflareGate: gate });
    const projectId = await createProject(app);

    const first = api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "first",
    });
    // The row exists before the provider call, so the slot is held.
    await eventually(() => app.supabase.imageGenerations.length === 1);

    const second = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "second",
    });
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe("IMAGE_GENERATION_IN_FLIGHT");

    releaseGate();
    const completed = await first;
    expect(completed.status).toBe(201);
    expect(app.supabase.imageGenerations).toHaveLength(1);
  });

  it("charges the guard the actual cost, not the estimate, once settled", async () => {
    const app = await startImageApp({}, { ...PROVIDER_ENV, IMAGE_DAILY_USD_PER_USER: "0.005" });
    const projectId = await createProject(app);
    seedGeneration(app, { estimated_usd: 0.0009, actual_usd: 0.01, cost_source: "provider" });

    const response = await api(app, USER_A.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "one more",
    });

    // The estimates alone (0.0009 + 0.001901) would fit under 0.005.
    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("IMAGE_SPEND_LIMIT");
    expect(app.r2.puts).toBe(0);
  });

  it("reports the caller's image cost ledger", async () => {
    const app = await startImageApp();
    seedGeneration(app, { estimated_usd: 0.001, actual_usd: 0.01, cost_source: "provider" });
    seedGeneration(app, { estimated_usd: 0.002 });
    seedGeneration(app, { owner_id: USER_B.id, estimated_usd: 5 });

    const response = await api(app, USER_A.token, "GET", "/api/image-usage");

    expect(response.status).toBe(200);
    expect(response.body.usage).toMatchObject({
      windowHours: 24,
      attempts: 2,
      actualUsd: 0.01,
      estimatedUsd: 0.003,
      spentUsd: 0.012,
      limits: { images: 20, usd: 1 },
    });
    expect(typeof response.body.usage.resetAt).toBe("string");
    const anonymous = await fetch(`${app.url}/api/image-usage`);
    expect(anonymous.status).toBe(401);
  });

  it("reports the pending job with the usage ledger and clears an expired one", async () => {
    const app = await startImageApp();
    seedGeneration(app, { status: "pending", media_id: null, job_id: "job-usage" });
    const pendingId = app.supabase.imageGenerations[0].id as string;

    const usage = await api(app, USER_A.token, "GET", "/api/image-usage");
    expect(usage.status).toBe(200);
    expect(usage.body.pending).toMatchObject({
      generationId: pendingId,
      jobId: "job-usage",
      provider: "cloudflare",
    });

    const stale = await startImageApp({}, {
      ...PROVIDER_ENV,
      IMAGE_PENDING_ABANDON_AFTER_MS: "60000",
    });
    seedGeneration(stale, {
      status: "pending",
      media_id: null,
      created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    });
    const expired = await api(stale, USER_A.token, "GET", "/api/image-usage");
    expect(expired.status).toBe(200);
    expect(expired.body.pending).toBeNull();
    expect(stale.supabase.imageGenerations[0]).toMatchObject({
      status: "failed",
      error_code: "IMAGE_GENERATION_ABANDONED",
    });
  });

  it("refuses another account's project", async () => {
    const app = await startImageApp();
    const projectId = await createProject(app);
    const response = await api(app, USER_B.token, "POST", `/api/projects/${projectId}/image-generations`, {
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "rain",
    });
    expect(response.status).toBe(404);
    expect(app.supabase.imageGenerations).toHaveLength(0);
  });
});
