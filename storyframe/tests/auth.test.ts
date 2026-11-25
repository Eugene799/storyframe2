import { describe, expect, it, vi } from "vitest";
import type { AiTestSuccess } from "../shared/ai-contract";
import { EXPIRED_TOKEN, USER_A } from "./fake-supabase";
import {
  FAKE_KEY,
  USER_A_TOKEN,
  jsonProviderResponse,
  postTest,
  startTestServer,
} from "./server-helpers";

// MOCKED: Supabase is a local fake; Ollama is a local stub. No external call is made.

const SUCCESS_PAYLOAD = {
  model: "gemma4:31b",
  message: { role: "assistant", content: "Welcome to StoryFrame." },
  done: true,
  done_reason: "stop",
  prompt_eval_count: 21,
  eval_count: 6,
};

describe("Supabase auth boundary", () => {
  it("rejects a request with no session token before contacting the provider", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await startTestServer({ fetchImpl });

    try {
      const response = await postTest(app.url, { model: "gemma", prompt: "Hello" }, { token: null });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(app.supabase.usage).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("rejects an invalid session", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await startTestServer({ fetchImpl });

    try {
      const response = await postTest(
        app.url,
        { model: "gemma", prompt: "Hello" },
        { token: "not-a-real-session" },
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "SESSION_INVALID" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects an expired session without billing or writing usage", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await startTestServer({ fetchImpl });

    try {
      const response = await postTest(
        app.url,
        { model: "gemma", prompt: "Hello" },
        { token: EXPIRED_TOKEN },
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "SESSION_INVALID" } });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(app.supabase.usage).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("reports a Supabase auth outage without contacting the provider", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await startTestServer({ fetchImpl, supabase: { failure: "auth" } });

    try {
      const response = await postTest(app.url, { model: "gemma", prompt: "Hello" });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "AUTH_UNAVAILABLE" } });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(app.supabase.usage).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("refuses billable requests when Supabase auth is not configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await startTestServer({
      fetchImpl,
      env: { SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "" },
    });

    try {
      const response = await postTest(app.url, { model: "gemma", prompt: "Hello" });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "AUTH_NOT_CONFIGURED" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("accepts a valid session and attributes the usage to the verified user", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonProviderResponse(SUCCESS_PAYLOAD));
    const app = await startTestServer({ fetchImpl });

    try {
      const response = await postTest(app.url, {
        model: "gemma",
        prompt: "Write one short welcome sentence for StoryFrame.",
      });
      expect(response.status).toBe(200);

      const body = (await response.json()) as AiTestSuccess;
      expect(body.ok).toBe(true);
      expect(body.reply).toBe("Welcome to StoryFrame.");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(app.supabase.usage).toHaveLength(1);
      expect(app.supabase.usage[0]).toMatchObject({
        user_id: USER_A.id,
        model_id: "gemma",
        configured_model: "gemma4:31b",
        status: "success",
      });
    } finally {
      await app.close();
    }
  });

  it("still requires a provider key with a valid session", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await startTestServer({ fetchImpl, env: { OLLAMA_API_KEY: "" } });

    try {
      const response = await postTest(app.url, { model: "gemma", prompt: "Hello" });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "PROVIDER_NOT_CONFIGURED" } });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(app.supabase.usage).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("does not return session or provider credentials in responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonProviderResponse({ message: { content: "OK" } }));
    const app = await startTestServer({ fetchImpl });

    try {
      const response = await postTest(app.url, { model: "gemma", prompt: "Hello" });
      const text = await response.text();
      expect(text).not.toContain(FAKE_KEY);
      expect(text).not.toContain(USER_A_TOKEN);
    } finally {
      await app.close();
    }
  });
});
