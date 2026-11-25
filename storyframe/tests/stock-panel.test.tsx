// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaProvenance, MediaRecord } from "../shared/media-contract";
import { MediaPanel } from "../src/workspace/MediaPanel";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_ID = "99999999-9999-4999-8999-999999999999";
const NOW = "2026-11-25T12:00:00.000Z";

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => payload,
  } as unknown as Response;
}

const PROVENANCE: MediaProvenance = {
  source: "stock",
  provider: "pexels",
  providerId: "101",
  type: "image",
  rendition: "original",
  renditionUrl: "https://images.pexels.com/photos/101/original.jpg",
  sourcePage: "https://www.pexels.com/photo/101/",
  creator: "Ada",
  attribution: "Photo by Ada on Pexels",
  license: "Pexels License",
  downloadedAt: NOW,
  byteSize: 604,
};

const IMPORTED: MediaRecord = {
  id: MEDIA_ID,
  kind: "image",
  status: "ready",
  sceneKey: null,
  contentType: "image/jpeg",
  byteSize: 604,
  uploadExpiresAt: null,
  readyAt: NOW,
  deletedAt: null,
  createdAt: NOW,
  referenceCount: 0,
  provenance: PROVENANCE,
};

function installBackend(options: { initialMedia?: MediaRecord[]; reused?: boolean } = {}) {
  const { initialMedia = [], reused = false } = options;
  const requests: { method: string; path: string; search: string; body: unknown }[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
      requests.push({ method, path: url.pathname, search: url.search, body });

      if (url.pathname === `/api/projects/${PROJECT_ID}/media` && method === "GET") {
        return jsonResponse({ ok: true, media: initialMedia });
      }
      if (url.pathname === "/api/stock/search" && method === "GET") {
        if (url.searchParams.get("page") === "2") {
          return jsonResponse({
            ok: true,
            query: "rain",
            type: "image",
            sources: ["pexels", "pixabay"],
            page: 2,
            resultsPerProvider: 20,
            fetchedAt: NOW,
            providers: [
              {
                provider: "pexels",
                ok: true,
                count: 1,
                page: 2,
                hasMore: false,
                cached: false,
                rateLimitRemaining: 198,
                error: null,
              },
              {
                provider: "pixabay",
                ok: false,
                count: 0,
                page: 2,
                hasMore: false,
                cached: false,
                rateLimitRemaining: null,
                error: "STOCK_PROVIDER_UNAVAILABLE",
              },
            ],
            results: [
              {
                provider: "pexels",
                providerName: "Pexels",
                providerId: "102",
                type: "image",
                title: "Wet rooftop",
                previewUrl: "https://images.pexels.com/photos/102/large.jpg",
                renditions: [
                  {
                    label: "original",
                    url: "https://images.pexels.com/photos/102/original.jpg",
                    width: 3000,
                    height: 2000,
                    contentType: "image/jpeg",
                    byteSize: null,
                    fps: null,
                  },
                ],
                selectedRendition: "original",
                sourcePage: "https://www.pexels.com/photo/102/",
                creator: "Bo",
                creatorUrl: "https://www.pexels.com/@bo",
                attribution: "Photo by Bo on Pexels",
                license: "Pexels License",
                licenseUrl: "https://www.pexels.com/license/",
                width: 3000,
                height: 2000,
                durationSeconds: null,
              },
            ],
          });
        }
        return jsonResponse({
          ok: true,
          query: "rain",
          type: "image",
          sources: ["pexels", "pixabay"],
          page: 1,
          resultsPerProvider: 20,
          fetchedAt: NOW,
          providers: [
            {
              provider: "pexels",
              ok: true,
              count: 1,
              page: 1,
              hasMore: true,
              cached: false,
              rateLimitRemaining: 199,
              error: null,
            },
            {
              provider: "pixabay",
              ok: false,
              count: 0,
              page: 1,
              hasMore: false,
              cached: false,
              rateLimitRemaining: null,
              error: "STOCK_PROVIDER_UNAVAILABLE",
            },
          ],
          results: [
            {
              provider: "pexels",
              providerName: "Pexels",
              providerId: "101",
              type: "image",
              title: "Rain on a city street",
              previewUrl: "https://images.pexels.com/photos/101/large.jpg",
              renditions: [
                {
                  label: "original",
                  url: "https://images.pexels.com/photos/101/original.jpg",
                  width: 4000,
                  height: 3000,
                  contentType: "image/jpeg",
                  byteSize: null,
                  fps: null,
                },
              ],
              selectedRendition: "original",
              sourcePage: "https://www.pexels.com/photo/101/",
              creator: "Ada",
              creatorUrl: "https://www.pexels.com/@ada",
              attribution: "Photo by Ada on Pexels",
              license: "Pexels License",
              licenseUrl: "https://www.pexels.com/license/",
              width: 4000,
              height: 3000,
              durationSeconds: null,
            },
          ],
        });
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/stock/import` && method === "POST") {
        return jsonResponse({ ok: true, media: IMPORTED, provenance: PROVENANCE, reused }, reused ? 200 : 201);
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/media/${MEDIA_ID}/url` && method === "GET") {
        return jsonResponse({
          ok: true,
          url: "https://bucket.example/object",
          expiresAt: NOW,
          contentType: "image/jpeg",
          byteSize: 604,
        });
      }
      return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
    }),
  );

  return { requests };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("stock search in the media panel", () => {
  it("shows credited previews, reports a failed provider, and imports only on request", async () => {
    const backend = installBackend();
    render(
      <MediaPanel
        projectId={PROJECT_ID}
        scenes={[]}
        getAccessToken={async () => "token"}
        onAttachAsset={async () => true}
        onDetachAsset={async () => true}
      />,
    );

    expect(await screen.findByText("No media yet. Upload an image, audio clip, or video for a scene.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Stock search"), { target: { value: "rain" } });
    fireEvent.click(screen.getByRole("button", { name: "Search stock" }));

    const credit = await screen.findByRole("link", { name: "Photo by Ada on Pexels" });
    expect(credit.getAttribute("href")).toBe("https://www.pexels.com/photo/101/");
    expect(screen.getByRole("link", { name: "Pexels License" }).getAttribute("href")).toBe(
      "https://www.pexels.com/license/",
    );
    expect(screen.getByText(/Image · 4000×3000/)).toBeTruthy();
    expect(screen.getByText(/pixabay unavailable \(STOCK_PROVIDER_UNAVAILABLE\)/)).toBeTruthy();

    const search = backend.requests.find((request) => request.path === "/api/stock/search");
    expect(search?.search).toContain("q=rain");
    expect(search?.search).toContain("type=image");
    expect(search?.search).toContain("sources=pexels%2Cpixabay");

    // A preview is not an asset: only the explicit import may write media.
    expect(
      backend.requests.some((request) => request.path === `/api/projects/${PROJECT_ID}/media` && request.method === "POST"),
    ).toBe(false);
    expect(await screen.findByText("No media yet. Upload an image, audio clip, or video for a scene.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Import to project" }));

    expect(await screen.findByText(/Imported Photo by Ada on Pexels/)).toBeTruthy();
    const imported = backend.requests.find(
      (request) => request.path === `/api/projects/${PROJECT_ID}/stock/import` && request.method === "POST",
    );
    expect(imported?.body).toMatchObject({
      provider: "pexels",
      providerId: "101",
      type: "image",
      rendition: "original",
      url: "https://images.pexels.com/photos/101/original.jpg",
      sourcePage: "https://www.pexels.com/photo/101/",
      creator: "Ada",
      attribution: "Photo by Ada on Pexels",
      license: "Pexels License",
    });

    await waitFor(() => {
      expect(screen.getAllByText("ready").length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/image\/jpeg · 604 B/)).toBeTruthy();

    // The project media list keeps the stored credit: provider, creator, a
    // source link, and the license, all scoped to the imported asset.
    const item = await screen.findByLabelText(`Media ${MEDIA_ID}`);
    const provenance = within(item);
    expect(provenance.getByText("Pexels")).toBeTruthy();
    expect(provenance.getByText("Ada")).toBeTruthy();
    const source = provenance.getByRole("link", { name: "Source on Pexels" });
    expect(source.getAttribute("href")).toBe(PROVENANCE.sourcePage);
    expect(source.getAttribute("target")).toBe("_blank");
    expect(source.getAttribute("rel")).toContain("noreferrer");
    expect(provenance.getByText("Pexels License")).toBeTruthy();
  });

  it("loads the next provider page and appends only new previews", async () => {
    const backend = installBackend();
    render(
      <MediaPanel
        projectId={PROJECT_ID}
        scenes={[]}
        getAccessToken={async () => "token"}
        onAttachAsset={async () => true}
        onDetachAsset={async () => true}
      />,
    );

    fireEvent.change(screen.getByLabelText("Stock search"), { target: { value: "rain" } });
    fireEvent.click(screen.getByRole("button", { name: "Search stock" }));
    await screen.findByRole("link", { name: "Photo by Ada on Pexels" });

    fireEvent.click(screen.getByRole("button", { name: "Load more (page 2)" }));

    await screen.findByRole("link", { name: "Photo by Bo on Pexels" });
    expect(screen.getByRole("link", { name: "Photo by Ada on Pexels" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Import to project" })).toHaveLength(2);
    // The second page reports no further results, so the control disappears.
    expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull();

    const pages = backend.requests
      .filter((request) => request.path === "/api/stock/search")
      .map((request) => request.search);
    expect(pages.some((search) => search.includes("page=2"))).toBe(true);
    expect(pages[1]).toContain("q=rain");
  });

  it("reports an asset that is already in the project without adding a duplicate", async () => {
    installBackend({ initialMedia: [IMPORTED], reused: true });
    render(
      <MediaPanel
        projectId={PROJECT_ID}
        scenes={[]}
        getAccessToken={async () => "token"}
        onAttachAsset={async () => true}
        onDetachAsset={async () => true}
      />,
    );

    expect(await screen.findByLabelText(`Media ${MEDIA_ID}`)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Stock search"), { target: { value: "rain" } });
    fireEvent.click(screen.getByRole("button", { name: "Search stock" }));
    fireEvent.click(await screen.findByRole("button", { name: "Import to project" }));

    expect(await screen.findByText(/already in the project/)).toBeTruthy();
    expect(screen.getAllByLabelText(`Media ${MEDIA_ID}`)).toHaveLength(1);
  });
});
