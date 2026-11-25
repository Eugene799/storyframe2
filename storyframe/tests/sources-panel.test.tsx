// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "../shared/child-contract";
import { SourcesPanel } from "../src/workspace/SourcesPanel";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-11-25T12:00:00.000Z";

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => payload,
  } as unknown as Response;
}

function sourceFixture(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: SOURCE_ID,
    kind: "interview",
    title: "Founder interview",
    url: "https://example.com/interview",
    excerpt: "We rebuilt the whole engine in a weekend.",
    retrievedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function installBackend() {
  const requests: { method: string; path: string; body: unknown }[] = [];
  let sources: SourceRecord[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
      requests.push({ method, path, body });

      if (path === `/api/projects/${PROJECT_ID}/sources` && method === "GET") {
        return jsonResponse({ ok: true, sources });
      }
      if (path === `/api/projects/${PROJECT_ID}/sources` && method === "POST") {
        const write = body as { kind: SourceRecord["kind"]; title: string; url: string | null; excerpt: string | null };
        const created = sourceFixture({ ...write });
        sources = [...sources, created];
        return jsonResponse({ ok: true, source: created }, 201);
      }
      if (path === `/api/projects/${PROJECT_ID}/sources/${SOURCE_ID}` && method === "DELETE") {
        sources = sources.filter((source) => source.id !== SOURCE_ID);
        return jsonResponse({ ok: true, deletedId: SOURCE_ID });
      }
      return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
    }),
  );

  return { requests, setSources: (next: SourceRecord[]) => { sources = next; } };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SourcesPanel", () => {
  it("adds a source with its excerpt and deletes it", async () => {
    const backend = installBackend();
    render(
      <SourcesPanel projectId={PROJECT_ID} getAccessToken={async () => "token"} />,
    );

    expect(await screen.findByText("No sources yet.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "interview" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Founder interview" } });
    fireEvent.change(screen.getByLabelText("URL (optional)"), {
      target: { value: "https://example.com/interview" },
    });
    fireEvent.change(screen.getByLabelText(/Excerpt/), {
      target: { value: "We rebuilt the whole engine in a weekend." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));

    expect(await screen.findByText("Founder interview")).toBeTruthy();
    expect(screen.getByText("We rebuilt the whole engine in a weekend.")).toBeTruthy();
    expect(screen.getByText(/Factual planning can now quote this excerpt/)).toBeTruthy();

    const post = backend.requests.find((request) => request.method === "POST");
    expect(post?.body).toEqual({
      kind: "interview",
      title: "Founder interview",
      url: "https://example.com/interview",
      excerpt: "We rebuilt the whole engine in a weekend.",
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete source Founder interview" }));
    expect(await screen.findByText(/Source deleted/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("No sources yet.")).toBeTruthy());
    expect(backend.requests.some((request) => request.method === "DELETE")).toBe(true);
  });

  it("flags a source without an excerpt as unusable evidence", async () => {
    installBackend();
    render(
      <SourcesPanel projectId={PROJECT_ID} getAccessToken={async () => "token"} />,
    );

    expect(await screen.findByText("No sources yet.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Untitled notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));

    expect(await screen.findByText("Untitled notes")).toBeTruthy();
    expect(screen.getByText(/No excerpt supplied; not usable as evidence/)).toBeTruthy();
    expect(screen.getByText(/factual planning will not treat it as evidence/i)).toBeTruthy();
  });

  it("requires a title before adding", async () => {
    installBackend();
    render(
      <SourcesPanel projectId={PROJECT_ID} getAccessToken={async () => "token"} />,
    );

    expect(await screen.findByText("No sources yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add source" }).closest("button")?.disabled).toBe(true);
  });
});
