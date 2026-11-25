import { describe, expect, it } from "vitest";
import type { AiStatusResponse } from "../shared/ai-contract";
import { PUBLISHABLE_KEY, SERVICE_ROLE_KEY } from "./fake-supabase";
import { FAKE_KEY, USER_A_TOKEN, startTestServer } from "./server-helpers";

// MOCKED: Supabase is a local fake. No external request is made in this file.

describe("GET /api/ai/status", () => {
  it("reports a missing provider key without exposing credentials", async () => {
    const app = await startTestServer({ env: { OLLAMA_API_KEY: "" } });
    try {
      const response = await fetch(`${app.url}/api/ai/status`);
      expect(response.status).toBe(200);

      const status = (await response.json()) as AiStatusResponse;
      expect(status.keyConfigured).toBe(false);
      expect(status.configured).toBe(false);
      expect(status.auth).toMatchObject({ mode: "supabase", configured: true });
      expect(status.ledger).toMatchObject({ configured: true, ready: true, table: "ai_usage" });

      const serialized = JSON.stringify(status);
      expect(serialized).not.toContain(FAKE_KEY);
      expect(serialized).not.toContain(USER_A_TOKEN);
      expect(serialized).not.toContain(PUBLISHABLE_KEY);
      expect(serialized).not.toContain(SERVICE_ROLE_KEY);
    } finally {
      await app.close();
    }
  });

  it("lists the auth boundary, ledger, catalog, limits, and model choices", async () => {
    const app = await startTestServer();
    try {
      const status = (await (await fetch(`${app.url}/api/ai/status`)).json()) as AiStatusResponse;

      expect(status.service).toBe("storyframe-ai");
      expect(status.mode).toBe("development");
      expect(status.configured).toBe(true);
      expect(status.auth).toEqual({
        mode: "supabase",
        configured: true,
        publishableKeyConfigured: true,
      });
      expect(status.ledger).toEqual({
        configured: true,
        ready: true,
        serviceRoleConfigured: true,
        table: "ai_usage",
      });
      expect(status.provider.baseUrl).toBe("https://ollama.com");
      expect(status.catalog).toEqual({ source: "ollama.com/api/tags", checkedOn: "2026-11-24" });
      expect(status.limits.maxConcurrentRequests).toBe(1);
      expect(status.limits.abandonAfterMs).toBe(90_000);

      const available = status.models.filter((model) => model.available);
      expect(available.map((model) => model.requestId)).toEqual([
        "deepseek-v4.1-flash",
        "gemma4:31b",
        "glm-5.3-flash",
        "gpt-oss:20b",
        "minimax-m3.1-flash",
      ]);

      const nemotron = status.models.find((model) => model.id === "nemotron");
      expect(nemotron).toMatchObject({
        available: false,
        requestId: null,
        family: "nemotron-3-nano",
        catalogStatus: "not-listed",
      });
      expect(nemotron?.reason).toMatch(/Not present in the public direct-request catalog/);
    } finally {
      await app.close();
    }
  });

  it("is not ready when ai_usage lacks the planning preflight column", async () => {
    const app = await startTestServer({ supabase: { missingProjectIdColumn: true } });
    try {
      const status = (await (await fetch(`${app.url}/api/ai/status`)).json()) as AiStatusResponse;
      expect(status.ledger).toMatchObject({ configured: true, ready: false, table: "ai_usage" });
    } finally {
      await app.close();
    }
  });

  it("reports a fully unconfigured server without leaking secrets", async () => {
    const app = await startTestServer({
      env: {
        OLLAMA_API_KEY: "",
        SUPABASE_URL: "",
        SUPABASE_PUBLISHABLE_KEY: "",
        SUPABASE_ANON_KEY: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
      },
    });
    try {
      const status = (await (await fetch(`${app.url}/api/ai/status`)).json()) as AiStatusResponse;
      expect(status.configured).toBe(false);
      expect(status.keyConfigured).toBe(false);
      expect(status.auth.configured).toBe(false);
      expect(status.auth.publishableKeyConfigured).toBe(false);
      expect(status.ledger.configured).toBe(false);
      expect(status.ledger.ready).toBe(false);
      expect(status.ledger.serviceRoleConfigured).toBe(false);
      expect(JSON.stringify(status)).not.toContain("service_role");
    } finally {
      await app.close();
    }
  });
});
