// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import type { AiStatusResponse } from "../shared/ai-contract";
import App from "../src/App";

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
  ],
  planning: { routes: [], registry: [] },
};

const SUCCESS = {
  ok: true,
  modelId: "gemma",
  configuredModel: "gemma4:31b",
  returnedModel: "gemma4:31b",
  reply: "Welcome to StoryFrame, where rough ideas become finished scenes.",
  latencyMs: 812,
  usage: { promptEvalCount: 19, evalCount: 12 },
  doneReason: "stop",
};

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => payload,
  } as unknown as Response;
}

function installStatusFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/ai/status")) return jsonResponse(STATUS);
      if (String(input).endsWith("/api/projects")) return jsonResponse({ ok: true, projects: [] });
      throw new Error(`Unexpected request: ${String(input)}`);
    }),
  );
}

function makeSession(email: string): Session {
  const user = {
    id: "user-1",
    email,
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: "2026-11-24T00:00:00.000Z",
  } as User;

  return {
    access_token: "access-token",
    refresh_token: "refresh-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user,
  } as Session;
}

function makeClient(
  initialSession: Session | null = null,
  signInError: string | null = null,
  signInWithoutSession = false,
) {
  let current = initialSession;
  let listener: ((event: string, session: Session | null) => void) | null = null;

  const signInWithPassword = vi.fn(async ({ email }: { email: string; password: string }) => {
    if (signInError) {
      return { data: { session: null, user: null }, error: { message: signInError } };
    }
    if (signInWithoutSession) {
      return { data: { session: null, user: null }, error: null };
    }

    const session = makeSession(email);
    current = session;
    listener?.("SIGNED_IN", session);
    return { data: { session, user: session.user }, error: null };
  });

  const signOut = vi.fn(async () => {
    current = null;
    listener?.("SIGNED_OUT", null);
    return { error: null };
  });

  const client = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: current }, error: null })),
      onAuthStateChange: vi.fn((callback: (event: string, session: Session | null) => void) => {
        listener = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      signInWithPassword,
      signOut,
      refreshSession: vi.fn(async () => ({
        data: { session: current, user: current?.user ?? null },
        error: null,
      })),
    },
  } as unknown as SupabaseClient;

  return { client, signInWithPassword, signOut };
}

function fillCredentials(email: string, password: string) {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App authentication", () => {
  it("signs in with email and password, shows the signed-in user, and signs out", async () => {
    installStatusFetch();
    const { client, signInWithPassword, signOut } = makeClient();
    render(<App client={client} />);

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    fillCredentials("ada@example.com", "correct horse battery staple");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(/ada@example.com/)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Server configuration" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Supabase access token/i)).toBeNull();
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "correct horse battery staple",
    });

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("restores an existing Supabase session on load", async () => {
    installStatusFetch();
    const { client } = makeClient(makeSession("persisted@example.com"));
    render(<App client={client} />);

    expect(await screen.findByText(/persisted@example.com/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("shows a sign-in error without leaving the form", async () => {
    const { client } = makeClient(null, "Invalid login credentials");
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Sign in" });
    fillCredentials("ada@example.com", "wrong");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid login credentials");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("explains a missing session after sign-in instead of silently staying signed out", async () => {
    const { client } = makeClient(null, null, true);
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Sign in" });
    fillCredentials("unconfirmed@example.com", "correct horse battery staple");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Confirm your email address/i);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("explains the missing browser configuration instead of accepting a pasted token", () => {
    render(<App client={null} />);

    expect(screen.getByText(/Browser-side Supabase Auth is not configured/i)).toBeInTheDocument();
    expect(screen.getByText("VITE_SUPABASE_URL")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Supabase access token/i)).toBeNull();
  });

  it("reports an invalid browser configuration instead of calling it missing", () => {
    render(<App client={null} configError="VITE_SUPABASE_URL is not a valid URL." />);

    expect(screen.getByRole("alert")).toHaveTextContent(/VITE_SUPABASE_URL is not a valid URL/i);
    expect(screen.queryByText(/Browser-side Supabase Auth is not configured/i)).toBeNull();
  });

  it("keeps sign-out from discarding a request that is still running", async () => {
    let release: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/ai/status")) return jsonResponse(STATUS);
        if (url.endsWith("/api/projects")) return jsonResponse({ ok: true, projects: [] });
        if (url.endsWith("/api/ai/test")) return pending;
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const { client, signOut } = makeClient();
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Sign in" });
    fillCredentials("ada@example.com", "correct horse battery staple");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByRole("option", { name: /Gemma 4 31B/ });
    fireEvent.click(screen.getByRole("button", { name: /Send test request/i }));

    expect(await screen.findByText(/Sign-out is paused until the current test request finishes/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).not.toHaveBeenCalled();

    release?.(jsonResponse(SUCCESS));
    expect(await screen.findByTestId("ai-reply")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
