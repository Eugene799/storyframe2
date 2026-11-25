import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createStoryframeServer } from "./app";
import {
  PUBLISHABLE_KEY,
  SERVICE_ROLE_KEY,
  startFakeSupabase,
} from "../tests/fake-supabase";
import { startFakeR2 } from "../tests/fake-r2";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
try {
  loadEnvFile(envPath);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") {
    console.warn(`[storyframe] Could not load ${envPath} (${code ?? "unknown error"}).`);
  }
}

async function main() {
  const host = process.env.HOST?.trim() || "127.0.0.1";
  const rawPort =
    process.env.API_PORT?.trim() ||
    (process.env.PORT && process.env.PORT.trim() !== "3000" ? process.env.PORT.trim() : "8787");
  const port = Number(rawPort || 8787);

  let fakeSupabase: Awaited<ReturnType<typeof startFakeSupabase>> | null = null;
  let fakeR2: Awaited<ReturnType<typeof startFakeR2>> | null = null;

  const runtimeEnv: NodeJS.ProcessEnv = { ...process.env };
  if (!runtimeEnv.SUPABASE_URL) {
    fakeSupabase = await startFakeSupabase();
    runtimeEnv.SUPABASE_URL = fakeSupabase.url;
    runtimeEnv.SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;
    runtimeEnv.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
  }
  if (!runtimeEnv.R2_ENDPOINT) {
    fakeR2 = await startFakeR2();
    runtimeEnv.R2_ENDPOINT = fakeR2.url;
    runtimeEnv.R2_BUCKET_NAME = fakeR2.bucket;
    runtimeEnv.R2_ACCESS_KEY_ID = "local-sandbox-access-key";
    runtimeEnv.R2_SECRET_ACCESS_KEY = "local-sandbox-secret-key";
  }

  const server = createStoryframeServer({ env: runtimeEnv });

  const hasPublishableKey = Boolean(runtimeEnv.SUPABASE_PUBLISHABLE_KEY || runtimeEnv.SUPABASE_ANON_KEY);

  server.listen(port, host, () => {
    console.log(`[storyframe] Development AI server listening on http://${host}:${port}`);
    console.log(`[storyframe] OLLAMA_API_KEY: ${runtimeEnv.OLLAMA_API_KEY ? "present" : "missing"}`);
    console.log(
      `[storyframe] Supabase auth: ${runtimeEnv.SUPABASE_URL && hasPublishableKey ? "configured" : "missing"}`,
    );
    console.log(
      `[storyframe] Usage ledger: ${
        runtimeEnv.SUPABASE_URL && runtimeEnv.SUPABASE_SERVICE_ROLE_KEY
          ? "configured; readiness reported by /api/ai/status"
          : "missing"
      }`,
    );
    console.log("[storyframe] Development arrangement only - not a production hosting solution.");
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(async () => {
        if (fakeSupabase) await fakeSupabase.close().catch(() => undefined);
        if (fakeR2) await fakeR2.close().catch(() => undefined);
        process.exit(0);
      });
    });
  }
}

void main();

