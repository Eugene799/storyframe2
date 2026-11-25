import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { AiErrorResponse, AiStatusResponse, AiTestSuccess, AiUsageListResponse } from "../shared/ai-contract";
import { createStoryframeServer } from "../server/app";

/**
 * Opt-in live smoke check. Makes five real, billable Ollama Cloud requests,
 * verifies the usage ledger, then repeats one request with its original
 * idempotency key to confirm the replay is free and unchanged. Not part of
 * `npm test`. No retries. Never prints the provider key or the session token.
 */
const PROMPT = "Write one short welcome sentence for StoryFrame.";
const ENABLED_FAMILIES = ["deepseek", "gemma", "glm", "gpt-oss", "minimax"] as const;

try {
  loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // .env is optional when the variables already exist in the environment.
}

const sessionToken = process.env.SMOKE_SUPABASE_ACCESS_TOKEN?.trim();

if (!process.env.OLLAMA_API_KEY?.trim()) {
  console.error("OLLAMA_API_KEY is not configured.");
  console.error("Set it in the server environment or storyframe/.env, then rerun `npm run smoke:live`.");
  process.exit(1);
}

if (!sessionToken) {
  console.error("SMOKE_SUPABASE_ACCESS_TOKEN is not configured.");
  console.error("Set it to a valid Supabase session access token (do not commit it), then rerun.");
  process.exit(1);
}

async function main(): Promise<number> {
  const server = createStoryframeServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const failures: string[] = [];
  const runId = randomUUID();
  const attempts = new Map<string, { key: string; body: unknown }>();

  async function readUsage(): Promise<AiUsageListResponse | null> {
    const response = await fetch(`${baseUrl}/api/ai/usage`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (!response.ok) return null;
    return (await response.json()) as AiUsageListResponse;
  }

  try {
    const status = (await (await fetch(`${baseUrl}/api/ai/status`)).json()) as AiStatusResponse;
    console.log(`StoryFrame Phase 2 live smoke | catalog ${status.catalog.source} checked ${status.catalog.checkedOn}`);
    console.log(`Supabase auth: ${status.auth.configured ? "configured" : "MISSING"} | ledger: ${status.ledger.ready ? "ready" : "NOT READY"}`);
    if (!status.auth.configured || !status.ledger.ready) {
      console.error("Supabase auth and a migrated usage ledger are required before running the smoke check.");
      return 1;
    }

    for (const model of status.models.filter((candidate) => !candidate.available)) {
      console.log(`${model.label}: disabled - ${model.reason ?? "no direct-request identifier"}`);
    }

    for (const family of ENABLED_FAMILIES) {
      const model = status.models.find((candidate) => candidate.id === family);
      if (!model?.available) {
        failures.push(family);
        console.error(`FAIL ${family}: not configured and available.`);
        continue;
      }

      const idempotencyKey = `smoke-${family}-${runId}`;
      const response = await fetch(`${baseUrl}/api/ai/test`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ model: family, prompt: PROMPT }),
        signal: AbortSignal.timeout(60_000),
      });
      const payload = (await response.json()) as AiTestSuccess | AiErrorResponse;

      if (!response.ok || !payload.ok) {
        failures.push(family);
        const error = payload.ok ? null : payload.error;
        console.error(
          `FAIL ${model.label} (${family}): ${error?.code ?? `HTTP ${response.status}`} - ${error?.message ?? "unknown error"}`,
        );
        continue;
      }

      console.log(`\n${model.label} (${family})`);
      console.log(`  request id: ${payload.configuredModel}`);
      console.log(`  returned:   ${payload.returnedModel ?? "not supplied"}`);
      console.log(`  latency:    ${payload.latencyMs} ms`);
      console.log(
        `  usage:      ${payload.usage.promptEvalCount ?? "n/a"} prompt / ${payload.usage.evalCount ?? "n/a"} output`,
      );
      console.log(`  reply:      ${payload.reply}`);
      attempts.set(family, { key: idempotencyKey, body: payload });
    }

    const beforeReplay = await readUsage();

    // Replay one request with its original key. A replay must return the same
    // stored values and add no ledger row, proving no second provider call was
    // billed. JSONB returns the same keys in a different order.
    const replayFamily = ENABLED_FAMILIES.find((family) => attempts.has(family));
    const replayAttempt = replayFamily ? attempts.get(replayFamily) : undefined;
    if (replayFamily && replayAttempt) {
      const replayResponse = await fetch(`${baseUrl}/api/ai/test`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": replayAttempt.key,
        },
        body: JSON.stringify({ model: replayFamily, prompt: PROMPT }),
        signal: AbortSignal.timeout(60_000),
      });
      const replayBody: unknown = await replayResponse.json();
      // JSONB does not preserve key order, so compare values rather than serializations.
      const identical = isDeepStrictEqual(replayBody, replayAttempt.body);
      console.log(
        `\nIdempotent replay (${replayFamily}): ${identical ? "identical stored response" : "MISMATCH"}`,
      );
      if (!identical) {
        failures.push("idempotency-replay");
        console.error("FAIL idempotent replay: the stored response was not returned unchanged.");
      }
    }

    const usage = await readUsage();
    const latest = usage?.usage[0];
    console.log(
      `\nUsage ledger: ${usage?.usage.length ?? 0} recent rows; latest ${latest?.configuredModel ?? "none"} (${latest?.status ?? "n/a"})`,
    );
    if (!usage || !latest) {
      failures.push("usage-ledger");
      console.error("FAIL usage ledger: no rows were returned after the smoke calls.");
    }
    if (replayAttempt && beforeReplay && usage && usage.usage.length !== beforeReplay.usage.length) {
      failures.push("idempotency-replay");
      console.error(
        `FAIL idempotent replay: the ledger went from ${beforeReplay.usage.length} to ${usage.usage.length} rows.`,
      );
    }

    const verified = ENABLED_FAMILIES.filter((family) => !failures.includes(family)).length;
    console.log(`\n${verified}/${ENABLED_FAMILIES.length} enabled families verified.`);
    return failures.length === 0 ? 0 : 1;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

try {
  process.exitCode = await main();
} catch (error: unknown) {
  console.error(`Live smoke failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}
