import type { AiUsage } from "../shared/ai-contract";

/** Fixed upstream. The server never accepts a provider URL from the browser. */
export const OLLAMA_BASE_URL = "https://ollama.com";

const MAX_PROVIDER_RESPONSE_CHARS = 512 * 1024;

export type ProviderErrorCode =
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNREACHABLE"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_RATE_LIMITED"
  | "MODEL_UNAVAILABLE"
  | "PROVIDER_ERROR"
  | "MALFORMED_RESPONSE"
  | "EMPTY_RESPONSE";

export class ProviderError extends Error {
  readonly status: number;
  readonly code: ProviderErrorCode;
  readonly upstreamStatus?: number;

  constructor(code: ProviderErrorCode, status: number, message: string, upstreamStatus?: number) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

export interface OllamaChatInput {
  requestId: string;
  prompt: string;
  apiKey: string;
  timeoutMs: number;
  maxOutputTokens: number;
  fetchImpl?: typeof fetch;
}

export interface OllamaChatOutput {
  reply: string;
  returnedModel: string | null;
  usage: AiUsage;
  doneReason: string | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringOrNull(value: unknown, maxLength = 160): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, maxLength) : null;
}

function mapUpstreamStatus(status: number): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError(
      "PROVIDER_AUTH_FAILED",
      502,
      "Ollama Cloud rejected the server credentials. Check OLLAMA_API_KEY on the server.",
      status,
    );
  }
  if (status === 429) {
    return new ProviderError(
      "PROVIDER_RATE_LIMITED",
      429,
      "Ollama Cloud rate-limited or quota-limited this request. No retry was attempted.",
      status,
    );
  }
  if (status === 404) {
    return new ProviderError(
      "MODEL_UNAVAILABLE",
      502,
      "Ollama Cloud does not expose the configured model identifier to this account.",
      status,
    );
  }
  return new ProviderError(
    "PROVIDER_ERROR",
    502,
    `Ollama Cloud returned HTTP ${status}. No retry was attempted.`,
    status,
  );
}

/**
 * One bounded, non-streaming chat request. There is deliberately no retry.
 * The upstream response body is never echoed to the browser.
 */
export async function requestChat(input: OllamaChatInput): Promise<OllamaChatOutput> {
  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    let response: Response;
    try {
      response = await doFetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: input.requestId,
          messages: [{ role: "user", content: input.prompt }],
          stream: false,
          // Plain-text milestone: no reasoning trace. Without this, a thinking
          // model can spend the whole output bound on reasoning and return an
          // empty final message.
          think: false,
          options: { num_predict: input.maxOutputTokens },
        }),
        signal: controller.signal,
        redirect: "error",
      });
    } catch {
      if (controller.signal.aborted) {
        throw new ProviderError(
          "PROVIDER_TIMEOUT",
          504,
          `Ollama Cloud did not respond within ${input.timeoutMs} ms. No retry was attempted.`,
        );
      }
      throw new ProviderError("PROVIDER_UNREACHABLE", 502, "Could not reach the Ollama Cloud API.");
    }

    const raw = await response.text();
    if (raw.length > MAX_PROVIDER_RESPONSE_CHARS) {
      throw new ProviderError("MALFORMED_RESPONSE", 502, "Ollama Cloud returned an unexpectedly large response.");
    }

    if (!response.ok) {
      throw mapUpstreamStatus(response.status);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new ProviderError("MALFORMED_RESPONSE", 502, "Ollama Cloud returned a response that was not valid JSON.");
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ProviderError("MALFORMED_RESPONSE", 502, "Ollama Cloud returned an unexpected response shape.");
    }

    const root = payload as Record<string, unknown>;
    const message = root.message;
    const content =
      message && typeof message === "object" && !Array.isArray(message)
        ? (message as Record<string, unknown>).content
        : undefined;

    if (typeof content !== "string") {
      throw new ProviderError("MALFORMED_RESPONSE", 502, "Ollama Cloud did not return a final message.");
    }

    const reply = content.trim();
    if (!reply) {
      throw new ProviderError("EMPTY_RESPONSE", 502, "Ollama Cloud returned an empty final message.");
    }

    return {
      reply,
      returnedModel: stringOrNull(root.model),
      usage: {
        promptEvalCount: numberOrNull(root.prompt_eval_count),
        evalCount: numberOrNull(root.eval_count),
      },
      doneReason: stringOrNull(root.done_reason),
    };
  } finally {
    clearTimeout(timer);
  }
}
