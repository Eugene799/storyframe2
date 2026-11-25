import { describe, expect, it, vi } from "vitest";
import {
  IMAGE_MODELS,
  fetchLeonardoGeneration,
  generateWithCloudflare,
  loadImageProviderSettings,
  startLeonardoGeneration,
} from "../server/image-providers";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const CLOUDFLARE = loadImageProviderSettings({
  CLOUDFLARE_ACCOUNT_ID: "account-1",
  CLOUDFLARE_AI_API_TOKEN: "cf-token",
});
const LEONARDO = loadImageProviderSettings({ LEONARDO_API_KEY: "leo-key" });

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("image provider catalog", () => {
  it("records the exact verified model ids, units, and pricing sources", () => {
    const flux = IMAGE_MODELS.find((model) => model.key === "cloudflare:flux-1-schnell");
    const phoenix = IMAGE_MODELS.find((model) => model.key === "leonardo:phoenix-1.0");

    expect(flux).toMatchObject({
      provider: "cloudflare",
      providerModel: "@cf/black-forest-labs/flux-1-schnell",
      width: 1024,
      height: 1024,
      steps: 4,
      maxPromptChars: 2048,
    });
    expect(flux?.billing).toMatchObject({
      kind: "neurons",
      neuronsPerTile: 4.8,
      neuronsPerStep: 9.6,
      usdPerThousandNeurons: 0.011,
      freeDailyNeurons: 10_000,
    });

    expect(phoenix).toMatchObject({
      provider: "leonardo",
      providerModel: "de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3",
      width: 1024,
      height: 1024,
      maxPromptChars: 2000,
    });
    // Leonardo's per-image USD rate is not published; never invent the figure.
    expect(phoenix?.billing.kind).toBe("api-credit");
    if (phoenix?.billing.kind === "api-credit") {
      expect(phoenix.billing.usdPerImage).toBeNull();
      expect(phoenix.billing.note).toContain("unverified");
    }
    for (const model of IMAGE_MODELS) {
      expect(model.rateVersion.length).toBeGreaterThan(0);
      expect(model.billing.verifiedOn).toBe("2026-11-25");
      expect(model.billing.sourceUrl.startsWith("https://")).toBe(true);
    }
  });
});

describe("disabled image providers", () => {
  const none = loadImageProviderSettings({});

  it("reports both providers disabled when credentials are missing", () => {
    expect(none.cloudflare).toBeNull();
    expect(none.leonardo).toBeNull();
  });

  it("refuses to generate without credentials and never calls the network", async () => {
    const fetchImpl = vi.fn();
    await expect(
      generateWithCloudflare(none, { modelKey: "cloudflare:flux-1-schnell", prompt: "rain" }, { fetchImpl }),
    ).rejects.toMatchObject({ code: "IMAGE_PROVIDER_DISABLED", status: 503 });
    await expect(
      startLeonardoGeneration(none, { modelKey: "leonardo:phoenix-1.0", prompt: "rain" }, { fetchImpl }),
    ).rejects.toMatchObject({ code: "IMAGE_PROVIDER_DISABLED", status: 503 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("cloudflare adapter", () => {
  it("posts the verified model and steps and validates the returned image bytes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ result: { image: PNG.toString("base64") }, success: true }),
    );
    const result = await generateWithCloudflare(
      CLOUDFLARE,
      { modelKey: "cloudflare:flux-1-schnell", prompt: "  rainy street  " },
      { fetchImpl },
    );

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-1/ai/run/@cf/black-forest-labs/flux-1-schnell",
    );
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer cf-token");
    expect(JSON.parse(String(init?.body))).toEqual({ prompt: "rainy street", steps: 4 });
    expect(result.contentType).toBe("image/png");
    expect(result.steps).toBe(4);
    expect(result.bytes.equals(PNG)).toBe(true);
  });

  it("rejects unknown models, invalid steps, and non-image payloads", async () => {
    await expect(
      generateWithCloudflare(CLOUDFLARE, { modelKey: "leonardo:phoenix-1.0", prompt: "rain" }),
    ).rejects.toMatchObject({ code: "IMAGE_MODEL_UNKNOWN" });
    await expect(
      generateWithCloudflare(CLOUDFLARE, { modelKey: "cloudflare:flux-1-schnell", prompt: "rain", steps: 9 }),
    ).rejects.toMatchObject({ code: "IMAGE_STEPS_INVALID" });
    await expect(
      generateWithCloudflare(
        CLOUDFLARE,
        { modelKey: "cloudflare:flux-1-schnell", prompt: "rain" },
        { fetchImpl: async () => jsonResponse({ result: { image: Buffer.from("not an image").toString("base64") } }) },
      ),
    ).rejects.toMatchObject({ code: "IMAGE_PROVIDER_FAILED" });
  });
});

describe("leonardo adapter", () => {
  it("submits the verified model id and dimensions", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ sdGenerationJob: { generationId: "job-1" } }),
    );
    const started = await startLeonardoGeneration(
      LEONARDO,
      { modelKey: "leonardo:phoenix-1.0", prompt: "rainy street", width: 1024, height: 1024 },
      { fetchImpl },
    );

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://cloud.leonardo.ai/api/rest/v1/generations");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer leo-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      prompt: "rainy street",
      modelId: "de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3",
      width: 1024,
      height: 1024,
      num_images: 1,
    });
    expect(started.jobId).toBe("job-1");
  });

  it("maps pending, complete, and failed polls", async () => {
    const poll = (payload: unknown) =>
      fetchLeonardoGeneration(LEONARDO, "job-1", { fetchImpl: async () => jsonResponse(payload) });

    await expect(poll({ generations_by_pk: { status: "PENDING" } })).resolves.toEqual({
      status: "pending",
      imageUrls: [],
      apiCreditCost: null,
      cost: null,
    });
    await expect(
      poll({
        generations_by_pk: {
          status: "COMPLETE",
          generated_images: [
            { url: "https://cdn.leonardo.ai/image-1.png" },
            { url: "ftp://not-allowed" },
          ],
        },
      }),
    ).resolves.toEqual({
      status: "succeeded",
      imageUrls: ["https://cdn.leonardo.ai/image-1.png"],
      apiCreditCost: null,
      cost: null,
    });
    await expect(
      poll({
        generations_by_pk: {
          status: "COMPLETE",
          apiCreditCost: 3,
          cost: { amount: 0.02, unit: "USD" },
          generated_images: [{ url: "https://cdn.leonardo.ai/image-2.png" }],
        },
      }),
    ).resolves.toMatchObject({ apiCreditCost: 3, cost: { amount: 0.02, unit: "USD" } });
    await expect(poll({ generations_by_pk: { status: "FAILED" } })).resolves.toEqual({
      status: "failed",
      imageUrls: [],
      apiCreditCost: null,
      cost: null,
    });
  });

  it("returns a sanitized provider error without the key", async () => {
    const error = (await fetchLeonardoGeneration(LEONARDO, "job-1", {
      fetchImpl: async () => jsonResponse({ error: "bad key leo-key" }, 401),
    }).catch((cause: unknown) => cause)) as { code: string; message: string };
    expect(error.code).toBe("IMAGE_PROVIDER_FAILED");
    expect(error.message).not.toContain("leo-key");
  });
});
