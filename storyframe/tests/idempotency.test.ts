import { describe, expect, it, vi } from "vitest";
import type { AiUsageListResponse } from "../shared/ai-contract";
import { USER_A, USER_B } from "./fake-supabase";
import {
  getUsage,
  jsonProviderResponse,
  postTest,
  requestHashFor,
  startTestServer,
} from "./server-helpers";

// MOCKED: Supabase and Ollama are local fakes. No external call is made.

const SUCCESS_PAYLOAD = {
  model: "gemma4:31b",
  message: { content: "Welcome to StoryFrame." },
  done: true,
  done_reason: "stop",
  prompt_eval_count: 21,
  eval_count: 6,
};

describe("idempotent AI requests", () => {
  it("requires an idempotency key before contacting the provider", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await startTestServer({ fetchImpl });

    try {
      const response = await postTest(
        app.url,
        { model: "gemma", prompt: "Hello" },
        { idempotencyKey: null },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "IDEMPOTENCY_KEY_REQUIRED" },
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(app.supabase.usage).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("rejects a malformed idempotency key", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await startTestServer({ fetchImpl });

    try {
      const response = await postTest(
        app.url,
        { model: "gemma", prompt: "Hello" },
        { idempotencyKey: "short" },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "INVALID_IDEMPOTENCY_KEY" },
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("replays a successful response without billing the provider twice", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonProviderResponse(SUCCESS_PAYLOAD));
    const app = await startTestServer({ fetchImpl });
    const idempotencyKey = "test-idempotency-replay-success";

    try {
      const first = await postTest(
        app.url,
        { model: "gemma", prompt: "Hello" },
        { idempotencyKey },
      );
      const firstBody = await first.json();
      expect(first.status).toBe(200);
      expect(firstBody).toMatchObject({ ok: true, reply: "Welcome to StoryFrame." });

      const second = await postTest(
        app.url,
        { model: "gemma", prompt: "Hello" },
        { idempotencyKey },
      );
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(firstBody);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      const usage = (await (await getUsage(app.url)).json()) as AiUsageListResponse;
      expect(usage.usage).toHaveLength(1);
      expect(usage.usage[0].status).toBe("success");
    } finally {
      await app.close();
    }
  });

  it("rejects reuse of a key for a different prompt", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonProviderResponse(SUCCESS_PAYLOAD));
    const app = await startTestServer({ fetchImpl });
    const idempotencyKey = "test-idempotency-conflict";

    try {
      expect(
        (
          await postTest(
            app.url,
            { model: "gemma", prompt: "Hello" },
            { idempotencyKey },
          )
        ).status,
      ).toBe(200);

      const response = await postTest(
        app.url,
        { model: "gemma", prompt: "A different prompt" },
        { idempotencyKey },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "IDEMPOTENCY_KEY_REUSED" },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("scopes a key to the verified user so two accounts may reuse it", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonProviderResponse(SUCCESS_PAYLOAD));
    const app = await startTestServer({ fetchImpl });
    const idempotencyKey = "test-idempotency-shared-across-users";

    try {
      const forA = await postTest(
        app.url,
        { model: "gemma", prompt: "Hello" },
        { idempotencyKey },
      );
      const forB = await postTest(
        app.url,
        { model: "gemma", prompt: "Hello" },
        { idempotencyKey, token: USER_B.token },
      );

      expect(forA.status).toBe(200);
      expect(forB.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(app.supabase.usage.map((row) => row.user_id).sort()).toEqual(
        [USER_A.id, USER_B.id].sort(),
      );
    } finally {
      await app.close();
    }
  });

  it("refuses to replay a completed reservation with no stored response", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await startTestServer({ fetchImpl });
    const idempotencyKey = "test-idempotency-missing-replay";
    const prompt = "Hello";

    try {
      app.supabase.usage.push({
        id: "33333333-3333-4333-8333-333333333333",
        user_id: USER_A.id,
        project_id: null,
        model_id: "gemma",
        configured_model: "gemma4:31b",
        returned_model: "gemma4:31b",
        prompt_eval_count: 21,
        eval_count: 6,
        latency_ms: 700,
        status: "success",
        error_code: null,
        upstream_status: null,
        created_at: new Date().toISOString(),
        idempotency_key: idempotencyKey,
        request_hash: requestHashFor("gemma", prompt),
        response_body: null,
        response_status: null,
      });

      const response = await postTest(
        app.url,
        { model: "gemma", prompt },
        { idempotencyKey },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "IDEMPOTENCY_REPLAY_UNAVAILABLE" },
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("replays a provider error without retrying the provider", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", { status: 429 }));
    const app = await startTestServer({ fetchImpl });
    const idempotencyKey = "test-idempotency-replay-error";

    try {
      const first = await postTest(
        app.url,
        { model: "gemma", prompt: "Hello" },
        { idempotencyKey },
      );
      expect(first.status).toBe(429);
      expect(await first.json()).toMatchObject({
        ok: false,
        error: { code: "PROVIDER_RATE_LIMITED", upstreamStatus: 429 },
      });

      const second = await postTest(
        app.url,
        { model: "gemma", prompt: "Hello" },
        { idempotencyKey },
      );
      expect(second.status).toBe(429);
      expect(await second.json()).toMatchObject({
        ok: false,
        error: { code: "PROVIDER_RATE_LIMITED", upstreamStatus: 429 },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
