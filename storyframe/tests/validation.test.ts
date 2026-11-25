import { describe, expect, it, vi } from "vitest";
import { USER_A_TOKEN, startTestServer } from "./server-helpers";

// MOCKED: provider fetch is never called in this file.

const IDEMPOTENCY_KEY = "test-idempotency-validation";

describe("request validation", () => {
  it("rejects an unknown model selection", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await startTestServer({ fetchImpl });
    try {
      const response = await fetch(`${app.url}/api/ai/test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${USER_A_TOKEN}`,
          "Idempotency-Key": IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ model: "gpt-4o", prompt: "Hello" }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "UNKNOWN_MODEL" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("refuses a model that has no verified direct-request identifier", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await startTestServer({ fetchImpl });
    try {
      const response = await fetch(`${app.url}/api/ai/test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${USER_A_TOKEN}`,
          "Idempotency-Key": IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ model: "nemotron", prompt: "Hello" }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "MODEL_UNAVAILABLE" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects an oversized prompt", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await startTestServer({ env: { AI_MAX_PROMPT_CHARS: "20" }, fetchImpl });
    try {
      const response = await fetch(`${app.url}/api/ai/test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${USER_A_TOKEN}`,
          "Idempotency-Key": IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ model: "gemma", prompt: "x".repeat(21) }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "PROMPT_TOO_LONG" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects an oversized request body", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await startTestServer({ fetchImpl });
    try {
      const response = await fetch(`${app.url}/api/ai/test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${USER_A_TOKEN}`,
          "Idempotency-Key": IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ model: "gemma", prompt: "x".repeat(5000) }),
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "BODY_TOO_LARGE" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects client-supplied upstream URLs or extra fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await startTestServer({ fetchImpl });
    try {
      const response = await fetch(`${app.url}/api/ai/test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${USER_A_TOKEN}`,
          "Idempotency-Key": IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({
          model: "gemma",
          prompt: "Hello",
          baseUrl: "https://example.com",
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "UNEXPECTED_FIELD" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects an empty prompt", async () => {
    const app = await startTestServer();
    try {
      const response = await fetch(`${app.url}/api/ai/test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${USER_A_TOKEN}`,
          "Idempotency-Key": IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ model: "gemma", prompt: "   " }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "INVALID_PROMPT" } });
    } finally {
      await app.close();
    }
  });

  it("rejects non-JSON content", async () => {
    const app = await startTestServer();
    try {
      const response = await fetch(`${app.url}/api/ai/test`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Authorization: `Bearer ${USER_A_TOKEN}`,
          "Idempotency-Key": IDEMPOTENCY_KEY,
        },
        body: "hello",
      });
      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_MEDIA_TYPE" } });
    } finally {
      await app.close();
    }
  });

  it("rejects the wrong HTTP method", async () => {
    const app = await startTestServer();
    try {
      const response = await fetch(`${app.url}/api/ai/test`);
      expect(response.status).toBe(405);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
    } finally {
      await app.close();
    }
  });
});
