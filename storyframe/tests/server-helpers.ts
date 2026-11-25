import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createStoryframeServer, type ServerOptions } from "../server/app";
import {
  PUBLISHABLE_KEY,
  SERVICE_ROLE_KEY,
  USER_A,
  startFakeSupabase,
  type FakeSupabase,
  type FakeSupabaseOptions,
} from "./fake-supabase";
import { startFakeR2, type FakeR2 } from "./fake-r2";

/** Fake Ollama key. Not a real credential. */
export const FAKE_KEY = "TEST_ONLY_FAKE_OLLAMA_KEY";
export const USER_A_TOKEN = USER_A.token;

let idempotencySequence = 0;

/** Mirrors the server's request fingerprint for a normalized model and prompt. */
export function requestHashFor(modelId: string, prompt: string): string {
  return createHash("sha256").update(modelId).update("\n").update(prompt).digest("hex");
}

export function nextIdempotencyKey(prefix = "test-idempotency"): string {
  idempotencySequence += 1;
  return `${prefix}-${idempotencySequence}`;
}

export interface TestApp {
  url: string;
  server: Server;
  supabase: FakeSupabase;
  r2: FakeR2;
  close: () => Promise<void>;
}

export async function startTestServer(
  options: Omit<ServerOptions, "env"> & {
    env?: NodeJS.ProcessEnv;
    supabase?: FakeSupabaseOptions;
  } = {},
): Promise<TestApp> {
  const { supabase: supabaseOptions, ...serverOptions } = options;
  const supabase = await startFakeSupabase(supabaseOptions);
  const r2 = await startFakeR2();
  const server = createStoryframeServer({
    ...serverOptions,
    env: {
      OLLAMA_API_KEY: FAKE_KEY,
      AI_MAX_REQUESTS_PER_MINUTE: "30",
      SUPABASE_URL: supabase.url,
      SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      R2_ENDPOINT: r2.url,
      R2_BUCKET_NAME: r2.bucket,
      R2_ACCESS_KEY_ID: "test-access-key-id",
      R2_SECRET_ACCESS_KEY: "test-secret-access-key",
      MEDIA_SWEEP_INTERVAL_MS: "0",
      IMAGE_PENDING_SWEEP_INTERVAL_MS: "0",
      ...serverOptions.env,
    },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    server,
    supabase,
    r2,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await supabase.close();
      await r2.close();
    },
  };
}

export function postTest(
  appUrl: string,
  body: unknown,
  options: {
    token?: string | null;
    idempotencyKey?: string | null;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const token = options.token === undefined ? USER_A_TOKEN : options.token;
  const idempotencyKey =
    options.idempotencyKey === undefined ? nextIdempotencyKey() : options.idempotencyKey;
  return fetch(`${appUrl}/api/ai/test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
}

export function apiRequest(
  appUrl: string,
  path: string,
  init: RequestInit = {},
  token: string | null = USER_A_TOKEN,
): Promise<Response> {
  return fetch(`${appUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
}

export function getUsage(appUrl: string, token: string | null = USER_A_TOKEN): Promise<Response> {
  return fetch(`${appUrl}/api/ai/usage`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export function jsonProviderResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
