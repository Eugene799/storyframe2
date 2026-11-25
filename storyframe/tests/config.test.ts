import { describe, expect, it } from "vitest";
import { loadConfig } from "../server/config";

// Pure configuration test: no provider, Supabase, or server request is made.

describe("abandon threshold", () => {
  it("defaults comfortably above the provider and auth timeouts", () => {
    const config = loadConfig({});
    expect(config.providerTimeoutMs).toBe(30_000);
    expect(config.authTimeoutMs).toBe(5_000);
    expect(config.abandonAfterMs).toBe(90_000);
  });

  it("never falls below the provider timeout plus three auth timeouts", () => {
    const config = loadConfig({
      AI_ABANDON_AFTER_MS: "30000",
      AI_TIMEOUT_MS: "120000",
      AUTH_TIMEOUT_MS: "15000",
    });

    expect(config.providerTimeoutMs).toBe(120_000);
    expect(config.authTimeoutMs).toBe(15_000);
    expect(config.abandonAfterMs).toBe(120_000 + 3 * 15_000);
  });

  it("honors a longer explicit threshold", () => {
    expect(loadConfig({ AI_ABANDON_AFTER_MS: "600000" }).abandonAfterMs).toBe(600_000);
  });

  it("sizes the planning window for the disclosed repair call", () => {
    const config = loadConfig({
      AI_ABANDON_AFTER_MS: "30000",
      AI_TIMEOUT_MS: "60000",
      AUTH_TIMEOUT_MS: "5000",
    });

    expect(config.abandonAfterMs).toBe(60_000 + 3 * 5_000);
    expect(config.planningAbandonAfterMs).toBe(2 * 60_000 + 3 * 5_000);
  });
});
