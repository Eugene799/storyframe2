import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { USER_B } from "./fake-supabase";
import { USER_A_TOKEN, jsonProviderResponse, postTest, startTestServer } from "./server-helpers";

// MOCKED: the provider is held open locally to exercise duplicate submission.

describe("duplicate submission", () => {
  it("allows only one provider request per account at a time", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await gate;
      return new Response(
        JSON.stringify({
          model: "gemma4:31b",
          message: { content: "First request wins." },
          done: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const app = await startTestServer({ fetchImpl });

    try {
      const first = postTest(app.url, { model: "gemma", prompt: "Hello" });
      // Give the first request time to occupy the single concurrency slot.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const second = await postTest(app.url, { model: "gemma", prompt: "Hello again" });
      expect(second.status).toBe(429);
      expect(await second.json()).toMatchObject({ ok: false, error: { code: "REQUEST_IN_PROGRESS" } });

      release?.();
      const firstResponse = await first;
      expect(firstResponse.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      release?.();
      await app.close();
    }
  });

  it("does not let one account's in-flight request block another account", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await gate;
      return jsonProviderResponse({
        model: "gemma4:31b",
        message: { content: "Both requests can finish." },
        done: true,
      });
    });

    const app = await startTestServer({ fetchImpl });

    try {
      const first = postTest(app.url, { model: "gemma", prompt: "Hello from A" });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const second = postTest(
        app.url,
        { model: "gemma", prompt: "Hello from B" },
        { token: USER_B.token },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      // B must reach the provider even while A's request is still running.
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      release?.();
      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
    } finally {
      release?.();
      await app.close();
    }
  });

  it("scopes the per-minute limit to the verified account", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonProviderResponse({
        model: "gemma4:31b",
        message: { content: "Hello." },
        done: true,
      }),
    );
    const app = await startTestServer({
      fetchImpl,
      env: { AI_MAX_REQUESTS_PER_MINUTE: "1" },
    });

    try {
      expect((await postTest(app.url, { model: "gemma", prompt: "First A" })).status).toBe(200);

      const limited = await postTest(app.url, { model: "gemma", prompt: "Second A" });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({
        ok: false,
        error: { code: "TOO_MANY_REQUESTS" },
      });

      // A's exhausted window must not consume B's.
      const forB = await postTest(
        app.url,
        { model: "gemma", prompt: "First B" },
        { token: USER_B.token },
      );
      expect(forB.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("releases the account's slot when a client aborts a partial body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonProviderResponse({
        model: "gemma4:31b",
        message: { content: "Hello after the abort." },
        done: true,
      }),
    );
    const app = await startTestServer({ fetchImpl });

    try {
      const target = new URL("/api/ai/test", app.url);
      const aborted = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          Authorization: `Bearer ${USER_A_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": "200",
          "Idempotency-Key": "test-aborted-body-key",
        },
      });
      aborted.on("error", () => {});
      aborted.write('{"model":"gemma","prompt":"');
      await new Promise((resolve) => setTimeout(resolve, 50));
      aborted.destroy();
      await new Promise((resolve) => setTimeout(resolve, 75));

      const response = await postTest(app.url, { model: "gemma", prompt: "Hello" });
      expect(response.status).toBe(200);
      expect(app.supabase.usage).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
