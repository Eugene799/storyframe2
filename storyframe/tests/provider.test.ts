import { describe, expect, it, vi } from "vitest";
import type { AiTestSuccess } from "../shared/ai-contract";
import { FAKE_KEY, jsonProviderResponse, postTest, startTestServer } from "./server-helpers";

// MOCKED: every provider in this file is a local stub; no network call is made.

describe("provider failure handling", () => {
  it("sanitizes a provider authentication error", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: "invalid api key: SECRET_UPSTREAM_DETAIL" }), { status: 401 }),
    );
    const app = await startTestServer({ fetchImpl });

    try {
      const response = await postTest(app.url, { model: "gemma", prompt: "Hello" });
      const body = (await response.json()) as { error: { code: string; message: string; upstreamStatus?: number } };

      expect(response.status).toBe(502);
      expect(body.error.code).toBe("PROVIDER_AUTH_FAILED");
      expect(body.error.upstreamStatus).toBe(401);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("SECRET_UPSTREAM_DETAIL");
      expect(serialized).not.toContain(FAKE_KEY);
    } finally {
      await app.close();
    }
  });

  it("surfaces a provider rate limit without retrying", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", { status: 429 }));
    const app = await startTestServer({ fetchImpl });

    try {
      const response = await postTest(app.url, { model: "gemma", prompt: "Hello" });
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "PROVIDER_RATE_LIMITED", upstreamStatus: 429 },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("times out a slow provider once, without retrying", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );
    const app = await startTestServer({ env: { AI_TIMEOUT_MS: "150" }, fetchImpl });

    try {
      const response = await postTest(app.url, { model: "gemma", prompt: "Hello" });
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "PROVIDER_TIMEOUT" } });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("rejects malformed provider JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("<html>oops</html>", { status: 200 }));
    const app = await startTestServer({ fetchImpl });

    try {
      const response = await postTest(app.url, { model: "gemma", prompt: "Hello" });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "MALFORMED_RESPONSE" } });
    } finally {
      await app.close();
    }
  });

  it("rejects a provider response with no final message", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonProviderResponse({ model: "gemma4:31b", done: true }));
    const app = await startTestServer({ fetchImpl });

    try {
      const response = await postTest(app.url, { model: "gemma", prompt: "Hello" });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "MALFORMED_RESPONSE" } });
    } finally {
      await app.close();
    }
  });

  it("rejects an empty final message", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonProviderResponse({ message: { role: "assistant", content: "   " }, model: "gemma4:31b" }),
    );
    const app = await startTestServer({ fetchImpl });

    try {
      const response = await postTest(app.url, { model: "gemma", prompt: "Hello" });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "EMPTY_RESPONSE" } });
    } finally {
      await app.close();
    }
  });
});

describe("successful final-response extraction", () => {
  it("sends the documented request and extracts only the final answer plus real usage fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonProviderResponse({
        model: "gemma4:31b",
        created_at: "2026-11-24T00:00:00Z",
        message: { role: "assistant", content: "  Welcome to StoryFrame, where ideas become scenes.  " },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 19,
        eval_count: 9,
        total_duration: 1234567,
      }),
    );
    const app = await startTestServer({ fetchImpl });

    try {
      const response = await postTest(app.url, {
        model: "gemma",
        prompt: "  Write one short welcome sentence for StoryFrame.  ",
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as AiTestSuccess;

      expect(body).toMatchObject({
        ok: true,
        modelId: "gemma",
        configuredModel: "gemma4:31b",
        returnedModel: "gemma4:31b",
        reply: "Welcome to StoryFrame, where ideas become scenes.",
        usage: { promptEvalCount: 19, evalCount: 9 },
        doneReason: "stop",
      });
      expect(body.latencyMs).toBeGreaterThanOrEqual(0);

      const [url, init] = fetchImpl.mock.calls[0];
      expect(String(url)).toBe("https://ollama.com/api/chat");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Bearer TEST_ONLY_/);
      expect(headers["Content-Type"]).toBe("application/json");

      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({
        model: "gemma4:31b",
        messages: [{ role: "user", content: "Write one short welcome sentence for StoryFrame." }],
        stream: false,
        think: false,
        options: { num_predict: 120 },
      });
      expect(Object.keys(payload).sort()).toEqual(["messages", "model", "options", "stream", "think"]);
    } finally {
      await app.close();
    }
  });

  it("reports usage as not supplied instead of inventing token counts", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonProviderResponse({ message: { content: "Hello from the cloud." } }),
    );
    const app = await startTestServer({ fetchImpl });

    try {
      const body = (await (
        await postTest(app.url, { model: "deepseek", prompt: "Hello" })
      ).json()) as AiTestSuccess;

      expect(body.usage).toEqual({ promptEvalCount: null, evalCount: null });
      expect(body.returnedModel).toBeNull();
      expect(body.doneReason).toBeNull();
    } finally {
      await app.close();
    }
  });
});
