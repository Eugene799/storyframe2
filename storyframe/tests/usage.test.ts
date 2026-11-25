import { describe, expect, it, vi } from "vitest";
import type { AiUsageListResponse } from "../shared/ai-contract";
import { createSupabaseUsageLedger } from "../server/usage-ledger";
import { SERVICE_ROLE_KEY, USER_A, USER_B, pendingUsageRow, startFakeSupabase } from "./fake-supabase";
import {
  USER_A_TOKEN,
  jsonProviderResponse,
  getUsage,
  postTest,
  requestHashFor,
  startTestServer,
} from "./server-helpers";

// MOCKED: Supabase and Ollama are local fakes. No external call is made.

const SUCCESS_PAYLOAD = {
  model: "gemma4:31b",
  message: { content: "Welcome to StoryFrame." },
  done: true,
  prompt_eval_count: 21,
  eval_count: 6,
};

describe("usage ledger", () => {
  it("records the actual reported usage after a successful request", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonProviderResponse(SUCCESS_PAYLOAD));
    const app = await startTestServer({ fetchImpl });

    try {
      const response = await postTest(app.url, { model: "gemma", prompt: "Hello" });
      expect(response.status).toBe(200);

      const usage = (await (await getUsage(app.url)).json()) as AiUsageListResponse;
      expect(usage.usage).toHaveLength(1);
      expect(usage.usage[0]).toMatchObject({
        modelId: "gemma",
        configuredModel: "gemma4:31b",
        returnedModel: "gemma4:31b",
        promptEvalCount: 21,
        evalCount: 6,
        status: "success",
        errorCode: null,
        upstreamStatus: null,
      });
      expect(usage.usage[0].latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      await app.close();
    }
  });

  it("settles a stale pending reservation without contacting the provider again", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonProviderResponse(SUCCESS_PAYLOAD));
    const startedAt = Date.parse("2026-11-24T12:00:00.000Z");
    const app = await startTestServer({ fetchImpl, now: () => startedAt });
    const idempotencyKey = "test-idempotency-stale-pending";
    const prompt = "Hello";

    try {
      app.supabase.usage.push(
        pendingUsageRow({
          userId: USER_A.id,
          idempotencyKey,
          requestHash: requestHashFor("gemma", prompt),
          createdAt: new Date(startedAt - 10 * 60_000).toISOString(),
        }),
      );

      const response = await postTest(app.url, { model: "gemma", prompt }, { idempotencyKey });
      expect(response.status).toBe(409);
      const abandonedBody = await response.json();
      expect(abandonedBody).toMatchObject({ ok: false, error: { code: "REQUEST_ABANDONED" } });

      // Recovery must never call the provider: the original attempt may have billed.
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(app.supabase.usage).toHaveLength(1);
      expect(app.supabase.usage[0]).toMatchObject({
        status: "error",
        error_code: "REQUEST_ABANDONED",
        prompt_eval_count: null,
        eval_count: null,
      });
      expect(app.supabase.usage[0].response_body).toMatchObject({
        ok: false,
        error: { code: "REQUEST_ABANDONED" },
      });

      const replay = await postTest(app.url, { model: "gemma", prompt }, { idempotencyKey });
      expect(replay.status).toBe(409);
      expect(await replay.json()).toEqual(abandonedBody);
      expect(fetchImpl).not.toHaveBeenCalled();

      const usage = (await (await getUsage(app.url)).json()) as AiUsageListResponse;
      expect(usage.usage).toHaveLength(1);
      expect(usage.usage[0]).toMatchObject({ status: "error", errorCode: "REQUEST_ABANDONED" });
    } finally {
      await app.close();
    }
  });

  it("leaves a fresh pending reservation alone", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonProviderResponse(SUCCESS_PAYLOAD));
    const startedAt = Date.parse("2026-11-24T12:00:00.000Z");
    const app = await startTestServer({ fetchImpl, now: () => startedAt });
    const idempotencyKey = "test-idempotency-fresh-pending";
    const prompt = "Hello";

    try {
      app.supabase.usage.push(
        pendingUsageRow({
          userId: USER_A.id,
          idempotencyKey,
          requestHash: requestHashFor("gemma", prompt),
          createdAt: new Date(startedAt).toISOString(),
        }),
      );

      const response = await postTest(app.url, { model: "gemma", prompt }, { idempotencyKey });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "IDEMPOTENCY_IN_PROGRESS" },
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(app.supabase.usage[0]).toMatchObject({ status: "pending", response_body: null });
    } finally {
      await app.close();
    }
  });

  it("never settles a live request when the threshold is configured too low", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonProviderResponse(SUCCESS_PAYLOAD));
    const startedAt = Date.parse("2026-11-24T12:00:00.000Z");
    const app = await startTestServer({
      fetchImpl,
      now: () => startedAt,
      env: { AI_TIMEOUT_MS: "120000", AUTH_TIMEOUT_MS: "15000", AI_ABANDON_AFTER_MS: "30000" },
    });
    const idempotencyKey = "test-idempotency-abandon-floor";
    const prompt = "Hello";

    try {
      // Past the requested 30 s threshold but far inside the 165 s floor, so the
      // original request could still be running at the provider.
      app.supabase.usage.push(
        pendingUsageRow({
          userId: USER_A.id,
          idempotencyKey,
          requestHash: requestHashFor("gemma", prompt),
          createdAt: new Date(startedAt - 60_000).toISOString(),
        }),
      );

      const response = await postTest(app.url, { model: "gemma", prompt }, { idempotencyKey });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "IDEMPOTENCY_IN_PROGRESS" },
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(app.supabase.usage[0]).toMatchObject({ status: "pending", response_body: null });
    } finally {
      await app.close();
    }
  });

  it("keeps a stale reservation pending when the takeover loses, without billing", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonProviderResponse(SUCCESS_PAYLOAD));
    const startedAt = Date.parse("2026-11-24T12:00:00.000Z");
    const app = await startTestServer({
      fetchImpl,
      now: () => startedAt,
      supabase: { loseConditionalUpdate: true },
    });
    const idempotencyKey = "test-idempotency-stale-contended";
    const prompt = "Hello";

    try {
      app.supabase.usage.push(
        pendingUsageRow({
          userId: USER_A.id,
          idempotencyKey,
          requestHash: requestHashFor("gemma", prompt),
          createdAt: new Date(startedAt - 10 * 60_000).toISOString(),
        }),
      );

      const response = await postTest(app.url, { model: "gemma", prompt }, { idempotencyKey });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "IDEMPOTENCY_IN_PROGRESS" },
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(app.supabase.usage[0].status).toBe("pending");
    } finally {
      await app.close();
    }
  });

  it("keeps the paid reply when the completion write cannot be made", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonProviderResponse(SUCCESS_PAYLOAD));
    const logger = { error: vi.fn() };
    const app = await startTestServer({
      fetchImpl,
      logger,
      supabase: { failure: "complete" },
    });
    const idempotencyKey = "test-idempotency-ledger-complete";

    try {
      const response = await postTest(
        app.url,
        { model: "gemma", prompt: "Hello" },
        { idempotencyKey },
      );

      // The provider was already paid, so its answer reaches the caller instead of
      // being thrown away by a ledger failure.
      expect(response.status).toBe(200);
      expect(response.headers.get("x-storyframe-usage")).toBe("unrecorded");
      expect(await response.json()).toMatchObject({
        ok: true,
        modelId: "gemma",
        reply: "Welcome to StoryFrame.",
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("LEDGER_WRITE_FAILED"));
      expect(app.supabase.usage).toHaveLength(1);
      expect(app.supabase.usage[0].status).toBe("pending");
    } finally {
      await app.close();
    }
  });

  it("re-records a completion that fails once, so the key replays the reply", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonProviderResponse(SUCCESS_PAYLOAD));
    const logger = { error: vi.fn() };
    const app = await startTestServer({
      fetchImpl,
      logger,
      supabase: { failWrites: 1 },
    });
    const idempotencyKey = "test-idempotency-ledger-retry";
    const prompt = "Hello";

    try {
      const response = await postTest(app.url, { model: "gemma", prompt }, { idempotencyKey });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-storyframe-usage")).toBeNull();
      const firstBody = await response.json();
      expect(firstBody).toMatchObject({ ok: true, reply: "Welcome to StoryFrame." });
      expect(logger.error).not.toHaveBeenCalled();

      // The retried write settled the reservation, so the key replays the reply
      // instead of falling through to abandonment.
      expect(app.supabase.usage[0]).toMatchObject({
        status: "success",
        response_status: 200,
        returned_model: "gemma4:31b",
        prompt_eval_count: 21,
        eval_count: 6,
      });

      const replay = await postTest(app.url, { model: "gemma", prompt }, { idempotencyKey });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(firstBody);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("reports an unrecorded reply when its reservation was settled during the provider call", async () => {
    let settleAsAbandoned: (() => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      // A concurrent retry can settle the reservation while the provider is still
      // answering. The late completion then matches no pending row.
      settleAsAbandoned?.();
      return jsonProviderResponse(SUCCESS_PAYLOAD);
    });
    const logger = { error: vi.fn() };
    const app = await startTestServer({ fetchImpl, logger });
    settleAsAbandoned = () => {
      const row = app.supabase.usage[0];
      row.status = "error";
      row.error_code = "REQUEST_ABANDONED";
      row.response_status = 409;
      row.response_body = {
        ok: false,
        error: { code: "REQUEST_ABANDONED", message: "abandoned by a concurrent retry" },
      };
    };

    try {
      const response = await postTest(app.url, { model: "gemma", prompt: "Hello" });

      // The provider replied, so the caller keeps the reply, but the ledger did
      // not record it and the response must say so.
      expect(response.status).toBe(200);
      expect(response.headers.get("x-storyframe-usage")).toBe("unrecorded");
      expect(await response.json()).toMatchObject({ ok: true, reply: "Welcome to StoryFrame." });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(app.supabase.usage[0]).toMatchObject({
        status: "error",
        error_code: "REQUEST_ABANDONED",
        returned_model: null,
        prompt_eval_count: null,
        eval_count: null,
      });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("LEDGER_WRITE_FAILED"));
    } finally {
      await app.close();
    }
  });

  it("records a provider failure as an error row", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", { status: 429 }));
    const app = await startTestServer({ fetchImpl });

    try {
      const response = await postTest(app.url, { model: "gemma", prompt: "Hello" });
      expect(response.status).toBe(429);

      const usage = (await (await getUsage(app.url)).json()) as AiUsageListResponse;
      expect(usage.usage).toHaveLength(1);
      expect(usage.usage[0]).toMatchObject({
        status: "error",
        errorCode: "PROVIDER_RATE_LIMITED",
        upstreamStatus: 429,
        promptEvalCount: null,
        evalCount: null,
      });
    } finally {
      await app.close();
    }
  });

  it("isolates usage between two users", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonProviderResponse(SUCCESS_PAYLOAD));
    const app = await startTestServer({ fetchImpl });

    try {
      expect((await postTest(app.url, { model: "gemma", prompt: "Hello" })).status).toBe(200);
      expect(
        (
          await postTest(
            app.url,
            { model: "deepseek", prompt: "Hello" },
            { token: USER_B.token },
          )
        ).status,
      ).toBe(200);

      const a = (await (await getUsage(app.url, USER_A.token)).json()) as AiUsageListResponse;
      const b = (await (await getUsage(app.url, USER_B.token)).json()) as AiUsageListResponse;

      expect(a.usage).toHaveLength(1);
      expect(b.usage).toHaveLength(1);
      expect(a.usage[0].modelId).toBe("gemma");
      expect(b.usage[0].modelId).toBe("deepseek");
      expect(a.usage.map((row) => row.id)).not.toContain(b.usage[0].id);
      expect(app.supabase.usage.map((row) => row.user_id).sort()).toEqual([USER_A.id, USER_B.id].sort());
    } finally {
      await app.close();
    }
  });

  it("cannot complete a reservation owned by another account", async () => {
    const supabase = await startFakeSupabase();
    const ledger = createSupabaseUsageLedger({
      url: supabase.url,
      serviceRoleKey: SERVICE_ROLE_KEY,
      timeoutMs: 1_000,
    });
    const row = pendingUsageRow({
      userId: USER_A.id,
      idempotencyKey: "test-idempotency-owner-completion",
      requestHash: "request-hash",
      createdAt: new Date().toISOString(),
    });
    supabase.usage.push(row);

    const completion = {
      status: "success" as const,
      returnedModel: "gemma4:31b",
      promptEvalCount: 21,
      evalCount: 6,
      latencyMs: 1,
      responseStatus: 200,
      responseBody: { ok: true },
    };

    try {
      // B knows A's reservation id but must not be able to settle A's row.
      expect(await ledger.complete(USER_B.id, row.id, completion)).toBe(false);
      expect(supabase.usage[0].status).toBe("pending");

      expect(await ledger.complete(USER_A.id, row.id, completion)).toBe(true);
      expect(supabase.usage[0]).toMatchObject({
        status: "success",
        response_status: 200,
        returned_model: "gemma4:31b",
      });
    } finally {
      await supabase.close();
    }
  });

  it("returns project_busy when a second key races the project's pending row", async () => {
    const supabase = await startFakeSupabase();
    const ledger = createSupabaseUsageLedger({
      url: supabase.url,
      serviceRoleKey: SERVICE_ROLE_KEY,
      timeoutMs: 1_000,
    });
    const projectId = "77777777-7777-4777-8777-777777777777";
    const reservation = {
      userId: USER_A.id,
      projectId,
      modelId: "gemma",
      configuredModel: "gemma4:31b",
    };

    try {
      const first = await ledger.reserve({
        ...reservation,
        idempotencyKey: "race-first-key-12345678",
        requestHash: "race-first-hash",
      });
      expect(first).toEqual({ state: "reserved", id: expect.any(String) });

      // Bypasses the route preflight entirely: the unique index is the backstop.
      const second = await ledger.reserve({
        ...reservation,
        idempotencyKey: "race-second-key-12345678",
        requestHash: "race-second-hash",
      });
      expect(second).toEqual({ state: "project_busy" });
      expect(supabase.usage).toHaveLength(1);
      expect(supabase.usage[0]).toMatchObject({
        idempotency_key: "race-first-key-12345678",
        project_id: projectId,
        status: "pending",
      });
    } finally {
      await supabase.close();
    }
  });

  it("reports a ledger read failure without contacting the provider", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await startTestServer({ fetchImpl, supabase: { failure: "reads" } });

    try {
      const response = await getUsage(app.url);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "LEDGER_UNAVAILABLE" },
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("requires a session to read usage", async () => {
    const app = await startTestServer();
    try {
      const response = await getUsage(app.url, null);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    } finally {
      await app.close();
    }
  });

  it("refuses billable calls when the ledger is not configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await startTestServer({
      fetchImpl,
      env: { SUPABASE_SERVICE_ROLE_KEY: "" },
    });

    try {
      const response = await postTest(app.url, { model: "gemma", prompt: "Hello" });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "LEDGER_NOT_CONFIGURED" } });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(app.supabase.usage).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("fails closed when the ledger is configured but unreachable", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await startTestServer({
      fetchImpl,
      env: { SUPABASE_SERVICE_ROLE_KEY: "wrong-service-role-key" },
    });

    try {
      const response = await postTest(app.url, { model: "gemma", prompt: "Hello" });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "LEDGER_UNAVAILABLE" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects a client-supplied owner id", async () => {
    const app = await startTestServer();
    try {
      const response = await postTest(app.url, {
        model: "gemma",
        prompt: "Hello",
        user_id: USER_B.id,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "UNEXPECTED_FIELD" } });
    } finally {
      await app.close();
    }
  });
});
