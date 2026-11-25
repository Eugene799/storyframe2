// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiStatusResponse, AiTestSuccess } from "../shared/ai-contract";
import { ConnectionTestScreen } from "../src/components/ConnectionTestScreen";

// MOCKED: fetch is stubbed. No provider or development server request leaves this test.

const STATUS: AiStatusResponse = {
  service: "storyframe-ai",
  mode: "development",
  configured: true,
  keyConfigured: true,
  auth: { mode: "supabase", configured: true, publishableKeyConfigured: true },
  ledger: { configured: true, ready: true, serviceRoleConfigured: true, table: "ai_usage" },
  provider: { name: "ollama-cloud", baseUrl: "https://ollama.com" },
  catalog: { source: "ollama.com/api/tags", checkedOn: "2026-11-24" },
  limits: {
    promptMaxChars: 500,
    bodyMaxBytes: 4096,
    providerTimeoutMs: 30000,
    maxOutputTokens: 120,
    maxConcurrentRequests: 1,
    requestsPerMinute: 6,
    abandonAfterMs: 90000,
  },
  models: [
    {
      id: "gemma",
      label: "Gemma 4 31B",
      family: "gemma4",
      requestId: "gemma4:31b",
      available: true,
      reason: null,
      catalogStatus: "listed",
    },
    {
      id: "nemotron",
      label: "Nemotron 3 Nano",
      family: "nemotron-3-nano",
      requestId: null,
      available: false,
      reason: "No verified direct-cloud identifier.",
      catalogStatus: "not-listed",
    },
  ],
  planning: { routes: [], registry: [] },
};

const SUCCESS: AiTestSuccess = {
  ok: true,
  modelId: "gemma",
  configuredModel: "gemma4:31b",
  returnedModel: "gemma4:31b",
  reply: "Welcome to StoryFrame, where rough ideas become finished scenes.",
  latencyMs: 812,
  usage: { promptEvalCount: 19, evalCount: 12 },
  doneReason: "stop",
};

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => payload,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function installFetch(testHandler: () => Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/ai/status")) return jsonResponse(STATUS);
    if (url.endsWith("/api/ai/test")) return testHandler();
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderScreen(getAccessToken: () => Promise<string> = async () => "token-value") {
  return render(<ConnectionTestScreen getAccessToken={getAccessToken} />);
}

function fillAndFindButton() {
  return screen.getByRole("button", { name: /Send test request/i });
}

describe("ConnectionTestScreen", () => {
  it("displays the actual final reply, returned model, latency, and supplied usage", async () => {
    installFetch(async () => jsonResponse(SUCCESS));
    renderScreen();

    await screen.findByRole("option", { name: /Gemma 4 31B/ });
    fireEvent.click(fillAndFindButton());

    expect(await screen.findByTestId("ai-reply")).toHaveTextContent(SUCCESS.reply);
    expect(screen.getByText("812 ms")).toBeInTheDocument();
    expect(screen.getByText("19")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-unrecorded")).toBeNull();
  });

  it("does not present an unrecorded reply as an ordinary success", async () => {
    installFetch(async () => jsonResponse(SUCCESS, 200, { "X-Storyframe-Usage": "unrecorded" }));
    renderScreen();

    await screen.findByRole("option", { name: /Gemma 4 31B/ });
    fireEvent.click(fillAndFindButton());

    // The reply is still shown, but with the ledger gap called out next to it.
    expect(await screen.findByTestId("ai-reply")).toHaveTextContent(SUCCESS.reply);
    expect(screen.getByTestId("ai-unrecorded")).toHaveTextContent(/not recorded/i);
    expect(screen.getByTestId("ai-unrecorded")).toHaveTextContent(/second paid attempt/i);
  });

  it("sends only one request when the submit button is activated twice", async () => {
    let release: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = installFetch(() => pending);

    renderScreen();
    await screen.findByRole("option", { name: /Gemma 4 31B/ });
    const button = fillAndFindButton();

    fireEvent.click(button);
    fireEvent.click(button);

    const testCalls = () =>
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/ai/test")).length;
    await waitFor(() => expect(testCalls()).toBe(1));

    release?.(jsonResponse(SUCCESS));
    await screen.findByTestId("ai-reply");
    expect(testCalls()).toBe(1);
  });

  it("reuses the idempotency key while an outcome is unknown and starts a new attempt after a recorded error", async () => {
    const keys: string[] = [];
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/ai/status")) return jsonResponse(STATUS);
        if (url.endsWith("/api/ai/test")) {
          keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
          attempt += 1;
          if (attempt === 1) throw new TypeError("network down");
          if (attempt === 2) {
            return jsonResponse(
              {
                ok: false,
                error: { code: "PROVIDER_RATE_LIMITED", message: "Ollama Cloud rate-limited this request." },
              },
              429,
            );
          }
          return jsonResponse(SUCCESS);
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    renderScreen();
    await screen.findByRole("option", { name: /Gemma 4 31B/ });
    const button = fillAndFindButton();

    fireEvent.click(button);
    expect(await screen.findByTestId("ai-error")).toHaveTextContent("NETWORK_ERROR");

    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByTestId("ai-error")).toHaveTextContent("PROVIDER_RATE_LIMITED"),
    );

    fireEvent.click(button);
    expect(await screen.findByTestId("ai-reply")).toHaveTextContent(SUCCESS.reply);

    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("uses the current Supabase session token for the request", async () => {
    const fetchMock = installFetch(async () => jsonResponse(SUCCESS));
    const getAccessToken = vi.fn(async () => "session-token");
    renderScreen(getAccessToken);

    await screen.findByRole("option", { name: /Gemma 4 31B/ });
    fireEvent.click(fillAndFindButton());

    expect(await screen.findByTestId("ai-reply")).toHaveTextContent(SUCCESS.reply);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    const testCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/api/ai/test"));
    expect(new Headers(testCall?.[1]?.headers).get("Authorization")).toBe("Bearer session-token");
  });

  it("reports when a billable request is in flight so sign-out can wait for it", async () => {
    let release: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    installFetch(() => pending);
    const onBusyChange = vi.fn();
    render(
      <ConnectionTestScreen getAccessToken={async () => "token-value"} onBusyChange={onBusyChange} />,
    );

    await screen.findByRole("option", { name: /Gemma 4 31B/ });
    fireEvent.click(fillAndFindButton());
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));

    release?.(jsonResponse(SUCCESS));
    expect(await screen.findByTestId("ai-reply")).toHaveTextContent(SUCCESS.reply);
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  });

  it("shows a sanitized server error", async () => {
    installFetch(async () =>
      jsonResponse(
        {
          ok: false,
          error: {
            code: "PROVIDER_AUTH_FAILED",
            message: "Ollama Cloud rejected the server credentials. Check OLLAMA_API_KEY on the server.",
            upstreamStatus: 401,
          },
        },
        502,
      ),
    );

    renderScreen();
    await screen.findByRole("option", { name: /Gemma 4 31B/ });
    fireEvent.click(fillAndFindButton());

    const alert = await screen.findByTestId("ai-error");
    expect(alert).toHaveTextContent("PROVIDER_AUTH_FAILED");
    expect(alert).toHaveTextContent(/Check OLLAMA_API_KEY/);
    expect(alert).not.toHaveTextContent(/Bearer/);
  });

  it("explains how to configure a missing key without asking for it in the page", async () => {
    installFetch(async () => jsonResponse(SUCCESS));
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/ai/status")) {
        return jsonResponse({ ...STATUS, keyConfigured: false, configured: false });
      }
      throw new Error("unexpected");
    });

    renderScreen();
    expect(await screen.findByRole("option", { name: /Gemma 4 31B/ })).toBeInTheDocument();
    expect(await screen.findByText(/Configure the key on the server/i)).toBeInTheDocument();
    expect(screen.getByText(/storyframe\/.env/)).toBeInTheDocument();
  });
});
