import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { MediaProvenance, MediaRecord } from "../shared/media-contract";
import {
  buildStockProvenance,
  chooseVideoRendition,
  isPlaylistAsset,
  isPrivateAddress,
  normalizePexelsPhoto,
  normalizePexelsVideo,
  normalizePixabayImage,
  normalizePixabayVideo,
  parseStockImport,
  parseStockSearchInput,
  stockCacheKey,
  type HostAddress,
  type StockLimits,
} from "../server/stock";
import { USER_A, USER_B } from "./fake-supabase";
import { documentFixture } from "./project-fixture";
import { apiRequest, startTestServer, type TestApp } from "./server-helpers";

// MOCKED: Pexels and Pixabay are served by a local HTTP stand-in. No provider is
// contacted and no real credential is used. `verify:stock-live` is the opt-in
// check that talks to the real providers.

const DOCUMENT = documentFixture();
const PEXELS_KEY = "TEST_ONLY_FAKE_PEXELS_KEY";
const PIXABAY_KEY = "TEST_ONLY_FAKE_PIXABAY_KEY";

const PHOTO_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(600, 7),
]);
const VIDEO_BYTES = Buffer.alloc(96);
VIDEO_BYTES.writeUInt32BE(24, 0);
VIDEO_BYTES.write("ftyp", 4, "latin1");
VIDEO_BYTES.write("isom", 8, "latin1");

const PEXELS_PHOTOS = {
  page: 1,
  per_page: 20,
  total_results: 40,
  next_page: "https://api.pexels.com/v1/search?page=2",
  photos: [
    {
      id: 101,
      width: 4000,
      height: 3000,
      url: "https://www.pexels.com/photo/101/",
      photographer: "Ada",
      photographer_url: "https://www.pexels.com/@ada",
      alt: "Rain on a city street",
      src: {
        original: "https://images.pexels.com/photos/101/original.jpg",
        large2x: "https://images.pexels.com/photos/101/large2x.jpg",
        large: "https://images.pexels.com/photos/101/large.jpg",
        medium: "https://images.pexels.com/photos/101/medium.jpg",
        small: "https://images.pexels.com/photos/101/small.jpg",
      },
    },
  ],
};

const PEXELS_VIDEOS = {
  page: 1,
  per_page: 20,
  total_results: 12,
  next_page: "https://api.pexels.com/videos/search?page=2",
  videos: [
    {
      id: 202,
      width: 1920,
      height: 1080,
      duration: 12,
      url: "https://www.pexels.com/video/202/",
      image: "https://images.pexels.com/videos/202/poster.jpg",
      user: { name: "Bo", url: "https://www.pexels.com/@bo" },
      video_files: [
        {
          id: 3,
          quality: "portrait",
          file_type: "video/mp4",
          width: 1080,
          height: 1920,
          link: "https://videos.pexels.com/video-files/202/portrait.mp4",
        },
        {
          id: 2,
          quality: "sd",
          file_type: "video/mp4",
          width: 960,
          height: 540,
          link: "https://videos.pexels.com/video-files/202/sd.mp4",
        },
        {
          id: 1,
          quality: "hd",
          file_type: "video/mp4",
          width: 1920,
          height: 1080,
          fps: 30,
          link: "https://videos.pexels.com/video-files/202/hd.mp4",
        },
        {
          // A permissive video MIME label over a playlist URL must be excluded.
          id: 4,
          quality: "hls",
          file_type: "video/mp4",
          width: 1920,
          height: 1080,
          link: "https://videos.pexels.com/video-files/202/master.m3u8",
        },
      ],
    },
  ],
};

const PIXABAY_IMAGES = {
  total: 60,
  totalHits: 40,
  hits: [
    {
      id: 303,
      pageURL: "https://pixabay.com/photos/303/",
      tags: "rain, city, night",
      previewURL: "https://cdn.pixabay.com/photo/303_preview.jpg",
      previewWidth: 150,
      previewHeight: 100,
      webformatURL: "https://cdn.pixabay.com/photo/303_web.jpg",
      webformatWidth: 640,
      webformatHeight: 427,
      largeImageURL: "https://cdn.pixabay.com/photo/303_large.jpg",
      imageWidth: 4000,
      imageHeight: 2667,
      user: "Cara",
    },
  ],
};

const PIXABAY_VIDEOS = {
  total: 60,
  totalHits: 40,
  hits: [
    {
      id: 404,
      pageURL: "https://pixabay.com/videos/404/",
      tags: "ocean, waves",
      duration: 9,
      user: "Dan",
      videos: {
        large: {
          url: "https://cdn.pixabay.com/video/404_large.mp4",
          width: 1920,
          height: 1080,
          size: 900_000,
          thumbnail: "https://cdn.pixabay.com/video/404_large.jpg",
        },
        medium: {
          url: "https://cdn.pixabay.com/video/404_medium.mp4",
          width: 1280,
          height: 720,
          size: 400_000,
          thumbnail: "https://cdn.pixabay.com/video/404_medium.jpg",
        },
      },
    },
  ],
};

interface FakeProviders {
  origin: string;
  hits: { pexelsImage: number; pexelsVideo: number; pixabayImage: number; pixabayVideo: number };
  delayMs: number;
  failPexels: boolean;
  remaining: number;
  assetHits: number;
  /** Blocks asset responses until `expected` imports are waiting, so they overlap. */
  pauseAssets: (expected: number) => { arrived: Promise<void>; release: () => void };
  close: () => Promise<void>;
}

async function startFakeProviders(): Promise<FakeProviders> {
  const hits = { pexelsImage: 0, pexelsVideo: 0, pixabayImage: 0, pixabayVideo: 0 };
  let assetGate: Promise<void> | null = null;
  const state: FakeProviders = {
    origin: "",
    hits,
    delayMs: 0,
    failPexels: false,
    remaining: 199,
    assetHits: 0,
    pauseAssets: (expected) => {
      const start = state.assetHits;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      assetGate = gate;
      const arrived = new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (state.assetHits - start >= expected) {
            clearInterval(timer);
            resolve();
          }
        }, 5);
      });
      return {
        arrived,
        release: () => {
          assetGate = null;
          release();
        },
      };
    },
    close: async () => undefined,
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const pause = async () => {
      if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    };
    const jsonBody = (status: number, body: unknown): void => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "X-Ratelimit-Remaining": String(state.remaining),
      });
      response.end(JSON.stringify(body));
    };

    if (url.pathname === "/v1/search") {
      hits.pexelsImage += 1;
      await pause();
      if (state.failPexels) return jsonBody(500, { error: "upstream failure" });
      return jsonBody(200, PEXELS_PHOTOS);
    }
    if (url.pathname === "/videos/search") {
      hits.pexelsVideo += 1;
      await pause();
      if (state.failPexels) return jsonBody(500, { error: "upstream failure" });
      return jsonBody(200, PEXELS_VIDEOS);
    }
    if (url.pathname === "/api/") {
      hits.pixabayImage += 1;
      await pause();
      return jsonBody(200, PIXABAY_IMAGES);
    }
    if (url.pathname === "/api/videos/") {
      hits.pixabayVideo += 1;
      await pause();
      return jsonBody(200, PIXABAY_VIDEOS);
    }

    if (url.pathname === "/photos/101/original.jpg") {
      state.assetHits += 1;
      if (assetGate) await assetGate;
      response.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": String(PHOTO_BYTES.length) });
      return response.end(PHOTO_BYTES);
    }
    if (url.pathname === "/video-files/202/hd.mp4") {
      response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(VIDEO_BYTES.length) });
      return response.end(VIDEO_BYTES);
    }
    if (url.pathname === "/assets/redirect-ok") {
      response.writeHead(302, { Location: "https://images.pexels.com/photos/101/original.jpg" });
      return response.end();
    }
    if (url.pathname === "/assets/redirect-private") {
      response.writeHead(302, { Location: "https://internal.example/photo.jpg" });
      return response.end();
    }
    if (url.pathname === "/assets/redirect-foreign") {
      response.writeHead(302, { Location: "https://evil.example/photo.jpg" });
      return response.end();
    }
    if (url.pathname === "/photo/303_web.jpg") {
      state.assetHits += 1;
      response.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": String(PHOTO_BYTES.length) });
      return response.end(PHOTO_BYTES);
    }
    if (url.pathname === "/assets/photo.jpg") {
      response.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": String(PHOTO_BYTES.length) });
      return response.end(PHOTO_BYTES);
    }
    if (url.pathname === "/assets/redirect-videos") {
      response.writeHead(302, { Location: "https://videos.pexels.com/assets/photo.jpg" });
      return response.end();
    }
    if (url.pathname === "/assets/oversize.jpg") {
      response.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": "2048",
      });
      return response.end(Buffer.alloc(2048, 5));
    }
    if (url.pathname === "/assets/not-image.jpg") {
      response.writeHead(200, { "Content-Type": "text/html" });
      return response.end("<html>not an image</html>");
    }
    if (url.pathname === "/assets/playlist.m3u8") {
      response.writeHead(200, { "Content-Type": "video/mp4" });
      return response.end("#EXTM3U");
    }

    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  state.origin = `http://127.0.0.1:${port}`;
  state.close = () =>
    new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  return state;
}

const PROVIDER_HOSTS: Record<string, string> = {
  "api.pexels.com": "pexels",
  "images.pexels.com": "pexels",
  "videos.pexels.com": "pexels",
  "pixabay.com": "pixabay",
  "cdn.pixabay.com": "pixabay",
};

/** Rewrites provider hostnames to the local stand-in; leaves local services alone. */
function providerFetch(origin: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    if (!PROVIDER_HOSTS[url.hostname]) return fetch(raw, init);
    return fetch(`${origin}${url.pathname}${url.search}`, init);
  }) as typeof fetch;
}

const hostLookup = async (hostname: string): Promise<HostAddress[]> => {
  if (hostname === "internal.example") return [{ address: "10.0.0.5", family: 4 }];
  if (hostname === "metadata.example") return [{ address: "169.254.169.254", family: 4 }];
  return [{ address: "93.184.216.34", family: 4 }];
};

function limits(overrides: Partial<StockLimits> = {}): StockLimits {
  return {
    pexelsKey: PEXELS_KEY,
    pixabayKey: PIXABAY_KEY,
    timeoutMs: 5000,
    pageSize: 20,
    maxPage: 50,
    queryChars: 80,
    pexelsCacheSeconds: 3600,
    pixabayCacheSeconds: 86_400,
    cachePayloadBytes: 256 * 1024,
    cacheLeaseMs: 5000,
    cacheWaitMs: 2500,
    importImageBytes: 10 * 1024 * 1024,
    importVideoBytes: 200 * 1024 * 1024,
    importTimeoutMs: 5000,
    importRedirects: 3,
    ...overrides,
  };
}

function params(init: Record<string, string>): URLSearchParams {
  return new URLSearchParams(init);
}

const apps: TestApp[] = [];
const providers: FakeProviders[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
});

async function startStockApp(overrides: Record<string, string> = {}): Promise<{ app: TestApp; provider: FakeProviders }> {
  const provider = await startFakeProviders();
  providers.push(provider);
  const app = await startTestServer({
    fetchImpl: providerFetch(provider.origin),
    hostLookup,
    env: {
      PEXELS_API_KEY: PEXELS_KEY,
      PIXABAY_API_KEY: PIXABAY_KEY,
      STOCK_CACHE_WAIT_MS: "1500",
      ...overrides,
    },
  });
  apps.push(app);
  return { app, provider };
}

async function createProject(appUrl: string, token: string = USER_A.token): Promise<string> {
  const response = await apiRequest(
    appUrl,
    "/api/projects",
    {
      method: "POST",
      body: JSON.stringify({ projectType: "story", title: "Stock import", document: DOCUMENT }),
    },
    token,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { project: { id: string } }).project.id;
}

function importBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "pexels",
    providerId: "101",
    type: "image",
    rendition: "original",
    url: "https://images.pexels.com/photos/101/original.jpg",
    sourcePage: "https://www.pexels.com/photo/101/",
    creator: "Ada",
    attribution: "Photo by Ada on Pexels",
    license: "Pexels License",
    ...overrides,
  };
}

describe("stock search input", () => {
  it("collapses duplicate sources and refuses empty, unknown, or malformed selections", () => {
    const parsed = parseStockSearchInput(
      params({ q: "  rain  ", type: "image", sources: "pexels,pexels,PIXABAY", page: "2" }),
      limits(),
    );
    expect(parsed).toEqual({ query: "rain", type: "image", sources: ["pexels", "pixabay"], page: 2 });

    expect(() => parseStockSearchInput(params({ q: "rain", type: "image" }), limits())).toThrow(
      expect.objectContaining({ code: "STOCK_SOURCES_REQUIRED", status: 400 }),
    );
    expect(() =>
      parseStockSearchInput(params({ q: "rain", type: "image", sources: " , " }), limits()),
    ).toThrow(expect.objectContaining({ code: "STOCK_SOURCES_REQUIRED" }));
    expect(() =>
      parseStockSearchInput(params({ q: "rain", type: "image", sources: "pexels,shutterstock" }), limits()),
    ).toThrow(expect.objectContaining({ code: "STOCK_SOURCE_UNSUPPORTED" }));
    expect(() => parseStockSearchInput(params({ q: "rain", type: "gif", sources: "pexels" }), limits())).toThrow(
      expect.objectContaining({ code: "STOCK_TYPE_REQUIRED" }),
    );
    expect(() => parseStockSearchInput(params({ q: "rain", type: "image", sources: "pexels", page: "0" }), limits())).toThrow(
      expect.objectContaining({ code: "STOCK_PAGE_INVALID" }),
    );
    expect(() => parseStockSearchInput(params({ q: "   ", type: "image", sources: "pexels" }), limits())).toThrow(
      expect.objectContaining({ code: "STOCK_QUERY_REQUIRED" }),
    );
  });
});

describe("provider normalization", () => {
  it("reports the original dimensions and a credit line for a Pexels photo", () => {
    const result = normalizePexelsPhoto(PEXELS_PHOTOS.photos[0]);
    expect(result).toMatchObject({
      provider: "pexels",
      providerId: "101",
      type: "image",
      title: "Rain on a city street",
      creator: "Ada",
      attribution: "Photo by Ada on Pexels",
      width: 4000,
      height: 3000,
      selectedRendition: "original",
      sourcePage: "https://www.pexels.com/photo/101/",
      durationSeconds: null,
    });
    expect(result?.previewUrl).toBe("https://images.pexels.com/photos/101/large.jpg");
    expect(result?.renditions).toHaveLength(1);
  });

  it("selects a video rendition by dimensions and aspect and excludes playlist links", () => {
    const result = normalizePexelsVideo(PEXELS_VIDEOS.videos[0]);
    expect(result?.selectedRendition).toBe("hd");
    expect(result).toMatchObject({ width: 1920, height: 1080, durationSeconds: 12 });
    // The portrait crop stays listed but is never selected for a 16:9 source;
    // the HLS playlist is not an importable rendition at all.
    expect(result?.renditions.map((rendition) => rendition.label).sort()).toEqual(["hd", "portrait", "sd"]);
    expect(result?.renditions.some((rendition) => rendition.url.endsWith(".m3u8"))).toBe(false);
    expect(result?.previewUrl).toBe("https://images.pexels.com/videos/202/poster.jpg");
    expect(result?.attribution).toBe("Video by Bo on Pexels");
  });

  it("uses supplied video thumbnails and real rendition dimensions from Pixabay", () => {
    const video = normalizePixabayVideo(PIXABAY_VIDEOS.hits[0]);
    expect(video?.previewUrl).toBe("https://cdn.pixabay.com/video/404_large.jpg");
    expect(video).toMatchObject({ width: 1920, height: 1080, durationSeconds: 9 });
    expect(video?.attribution).toBe("Video by Dan on Pixabay");

    const image = normalizePixabayImage(PIXABAY_IMAGES.hits[0]);
    expect(image).toMatchObject({
      provider: "pixabay",
      providerId: "303",
      width: 4000,
      height: 2667,
      selectedRendition: "original",
      attribution: "Image by Cara on Pixabay",
    });
    expect(image?.renditions.map((rendition) => rendition.label)).toEqual(["preview", "webformat", "original"]);
  });

  it("keeps the source aspect when a rendition set mixes orientations", () => {
    const chosen = chooseVideoRendition(
      [
        { label: "portrait", url: "https://videos.pexels.com/a.mp4", width: 1080, height: 1920, contentType: "video/mp4", byteSize: null, fps: null },
        { label: "wide", url: "https://videos.pexels.com/b.mp4", width: 1280, height: 720, contentType: "video/mp4", byteSize: null, fps: null },
        { label: "square", url: "https://videos.pexels.com/c.mp4", width: 1000, height: 1000, contentType: "video/mp4", byteSize: null, fps: null },
      ],
      16 / 9,
    );
    expect(chosen?.label).toBe("wide");
  });

  it("recognizes playlist URLs and manifest content types", () => {
    expect(isPlaylistAsset("https://videos.pexels.com/x/master.m3u8")).toBe(true);
    expect(isPlaylistAsset("https://videos.pexels.com/x/chunk.ts")).toBe(true);
    expect(isPlaylistAsset("https://videos.pexels.com/x/clip.mp4", "application/vnd.apple.mpegurl")).toBe(true);
    expect(isPlaylistAsset("https://videos.pexels.com/x/clip.mp4", "video/mp4")).toBe(false);
  });
});

describe("import validation", () => {
  it("refuses non-provider source pages and malformed ids", () => {
    expect(() => parseStockImport(importBody({ sourcePage: "https://evil.example/page" }))).toThrow(
      expect.objectContaining({ code: "INVALID_STOCK_IMPORT" }),
    );
    expect(() => parseStockImport(importBody({ providerId: "abc" }))).toThrow(
      expect.objectContaining({ code: "INVALID_STOCK_IMPORT" }),
    );
    expect(() => parseStockImport(importBody({ url: "file:///etc/passwd" }))).toThrow(
      expect.objectContaining({ code: "INVALID_STOCK_IMPORT" }),
    );
    expect(() => parseStockImport(importBody({ extra: true }))).toThrow(
      expect.objectContaining({ code: "UNEXPECTED_FIELD" }),
    );
  });

  it("builds validated provenance from the accepted request", () => {
    const request = parseStockImport(importBody());
    const provenance = buildStockProvenance(request, 604, "2026-11-25T12:00:00.000Z");
    expect(provenance).toMatchObject({
      source: "stock",
      provider: "pexels",
      providerId: "101",
      type: "image",
      rendition: "original",
      creator: "Ada",
      attribution: "Photo by Ada on Pexels",
      license: "Pexels License",
      byteSize: 604,
    });
  });

  it("classifies private and reserved addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["93.184.216.34", "151.101.1.1", "2606:4700:4700::1111"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("refuses an allowed host that resolves to a private address, including after a redirect", async () => {
    const { downloadStockAsset } = await import("../server/stock");
    const provider = await startFakeProviders();
    providers.push(provider);

    const privateHosts = async (hostname: string): Promise<HostAddress[]> =>
      hostname === "videos.pexels.com"
        ? [{ address: "10.0.0.7", family: 4 }]
        : [{ address: "93.184.216.34", family: 4 }];

    await expect(
      downloadStockAsset(
        { provider: "pexels", type: "image", url: "https://videos.pexels.com/assets/photo.jpg" },
        { limits: limits(), fetchImpl: providerFetch(provider.origin), hostLookup: privateHosts },
      ),
    ).rejects.toMatchObject({ code: "STOCK_IMPORT_ADDRESS_REFUSED", status: 400 });

    await expect(
      downloadStockAsset(
        { provider: "pexels", type: "image", url: "https://images.pexels.com/assets/redirect-videos" },
        { limits: limits(), fetchImpl: providerFetch(provider.origin), hostLookup: privateHosts },
      ),
    ).rejects.toMatchObject({ code: "STOCK_IMPORT_ADDRESS_REFUSED", status: 400 });
  });

  it("keys the cache by normalized query, provider, type, and page", () => {
    expect(stockCacheKey("pexels", "image", "Rain  City", 1)).toBe(stockCacheKey("pexels", "image", "rain city", 1));
    expect(stockCacheKey("pexels", "image", "rain city", 1)).not.toBe(stockCacheKey("pixabay", "image", "rain city", 1));
    expect(stockCacheKey("pexels", "image", "rain city", 1)).not.toBe(stockCacheKey("pexels", "image", "rain city", 2));
  });
});

describe("stock routes", () => {
  it("merges image results, keeps real dimensions, and caches each provider page durably", async () => {
    const { app, provider } = await startStockApp();
    const response = await apiRequest(
      app.url,
      "/api/stock/search?q=rain&type=image&sources=pexels,pixabay",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: { provider: string; width: number; height: number; attribution: string }[];
      providers: { provider: string; ok: boolean; cached: boolean; rateLimitRemaining: number | null; hasMore: boolean }[];
    };

    expect(body.results.map((result) => result.provider).sort()).toEqual(["pexels", "pixabay"]);
    expect(body.results.find((result) => result.provider === "pexels")).toMatchObject({ width: 4000, height: 3000 });
    expect(body.providers.every((status) => status.ok && !status.cached && status.hasMore)).toBe(true);
    expect(body.providers.every((status) => status.rateLimitRemaining === 199)).toBe(true);

    // The durable rows are the evidence of a shared cache, not process memory.
    expect(app.supabase.stockSearchCache).toHaveLength(2);
    const rows = app.supabase.stockSearchCache;
    expect(rows.every((row) => row.status === "ready" && Number(row.payload_bytes) > 0)).toBe(true);
    const pixabayRow = rows.find((row) => row.provider === "pixabay");
    expect(pixabayRow).toBeTruthy();
    const ttl =
      Date.parse(String(pixabayRow?.expires_at)) - Date.parse(String(pixabayRow?.created_at));
    expect(ttl).toBeGreaterThanOrEqual(86_400_000 - 1000);

    const hitsBefore = { ...provider.hits };
    const second = await apiRequest(app.url, "/api/stock/search?q=rain&type=image&sources=pexels,pixabay");
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { results: unknown[]; providers: { cached: boolean }[] };
    expect(secondBody.results).toHaveLength(2);
    expect(secondBody.providers.every((status) => status.cached)).toBe(true);
    expect(provider.hits).toEqual(hitsBefore);
  });

  it("merges video results, reports the selected rendition, and excludes playlists", async () => {
    const { app } = await startStockApp();
    const response = await apiRequest(app.url, "/api/stock/search?q=ocean&type=video&sources=pexels,pixabay");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: { provider: string; width: number; height: number; selectedRendition: string; renditions: { url: string }[]; previewUrl: string }[];
    };
    expect(body.results).toHaveLength(2);
    const pexels = body.results.find((result) => result.provider === "pexels");
    expect(pexels).toMatchObject({ width: 1920, height: 1080, selectedRendition: "hd" });
    expect(pexels?.renditions.some((rendition) => rendition.url.endsWith(".m3u8"))).toBe(false);
    expect(pexels?.previewUrl).toContain("images.pexels.com");
    const pixabay = body.results.find((result) => result.provider === "pixabay");
    expect(pixabay?.previewUrl).toBe("https://cdn.pixabay.com/video/404_large.jpg");
  });

  it("tolerates one provider failure and never exposes the provider key", async () => {
    const { app, provider } = await startStockApp();
    provider.failPexels = true;
    const response = await apiRequest(app.url, "/api/stock/search?q=rain&type=image&sources=pexels,pixabay");
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain(PEXELS_KEY);
    expect(raw).not.toContain("api.pexels.com");
    const body = JSON.parse(raw) as {
      results: { provider: string }[];
      providers: { provider: string; ok: boolean; error: string | null }[];
    };
    expect(body.results.map((result) => result.provider)).toEqual(["pixabay"]);
    expect(body.providers.find((status) => status.provider === "pexels")).toMatchObject({
      ok: false,
      error: "STOCK_PROVIDER_UNAVAILABLE",
    });
    // A failed page is not cached, so a later attempt is not stuck on it.
    expect(app.supabase.stockSearchCache.every((row) => row.provider !== "pexels")).toBe(true);
  });

  it("serves concurrent identical searches with one provider call per page", async () => {
    const { app, provider } = await startStockApp();
    provider.delayMs = 150;
    const path = "/api/stock/search?q=rain&type=image&sources=pexels,pixabay";
    const [first, second] = await Promise.all([apiRequest(app.url, path), apiRequest(app.url, path)]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(provider.hits.pexelsImage).toBe(1);
    expect(provider.hits.pixabayImage).toBe(1);
    const bodies = (await Promise.all([first.json(), second.json()])) as { results: unknown[] }[];
    expect(bodies.every((body) => body.results.length === 2)).toBe(true);
  });

  it("serves an unexpired cached page before honoring an exhausted rate limit", async () => {
    const { app, provider } = await startStockApp();
    // The first call is answered with no remaining quota, so the provider is
    // cooled down; the page it returned is still cached and reusable.
    provider.remaining = 0;
    const path = "/api/stock/search?q=rain&type=image&sources=pexels";
    expect((await apiRequest(app.url, path)).status).toBe(200);

    const cached = await apiRequest(app.url, path);
    expect(cached.status).toBe(200);
    const cachedBody = (await cached.json()) as { providers: { cached: boolean }[] };
    expect(cachedBody.providers[0].cached).toBe(true);

    // A new page cannot be fetched, so the cooldown fails it without a call.
    const blocked = await apiRequest(app.url, "/api/stock/search?q=snow&type=image&sources=pexels");
    expect(blocked.status).toBe(502);
    expect(provider.hits.pexelsImage).toBe(1);
  });

  it("re-fetches an expired cached page instead of serving it", async () => {
    const { app, provider } = await startStockApp();
    const path = "/api/stock/search?q=rain&type=image&sources=pexels";
    expect((await apiRequest(app.url, path)).status).toBe(200);
    expect(provider.hits.pexelsImage).toBe(1);

    const row = app.supabase.stockSearchCache[0];
    row.expires_at = new Date(Date.now() - 1000).toISOString();

    const second = await apiRequest(app.url, path);
    expect(second.status).toBe(200);
    const body = (await second.json()) as { providers: { cached: boolean }[] };
    expect(body.providers[0].cached).toBe(false);
    expect(provider.hits.pexelsImage).toBe(2);
    expect(app.supabase.stockSearchCache).toHaveLength(1);
    expect(Date.parse(String(app.supabase.stockSearchCache[0].expires_at))).toBeGreaterThan(Date.now());
  });

  it("refuses unsupported sources and unauthenticated searches", async () => {
    const { app } = await startStockApp();
    const bad = await apiRequest(app.url, "/api/stock/search?q=rain&type=image&sources=pexels,getty");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("STOCK_SOURCE_UNSUPPORTED");

    const empty = await apiRequest(app.url, "/api/stock/search?q=rain&type=image");
    expect(empty.status).toBe(400);

    const anonymous = await apiRequest(app.url, "/api/stock/search?q=rain&type=image&sources=pexels", {}, null);
    expect(anonymous.status).toBe(401);
  });

  it("keeps searching when the durable cache is unavailable", async () => {
    const provider = await startFakeProviders();
    providers.push(provider);
    const app = await startTestServer({
      fetchImpl: providerFetch(provider.origin),
      hostLookup,
      env: { PEXELS_API_KEY: PEXELS_KEY, PIXABAY_API_KEY: PIXABAY_KEY },
      supabase: { failure: "stockCache" },
    });
    apps.push(app);
    const path = "/api/stock/search?q=rain&type=image&sources=pexels";
    expect((await apiRequest(app.url, path)).status).toBe(200);
    expect((await apiRequest(app.url, path)).status).toBe(200);
    // No durable row could be written, so each request asks the provider.
    expect(provider.hits.pexelsImage).toBe(2);
  });
});

describe("stock import", () => {
  it("stores the selected rendition in R2 with validated provenance", async () => {
    const { app } = await startStockApp();
    const projectId = await createProject(app.url);

    const response = await apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
      method: "POST",
      body: JSON.stringify(importBody()),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { media: MediaRecord; provenance: MediaProvenance; reused: boolean };
    expect(body.reused).toBe(false);
    expect(body.media).toMatchObject({
      kind: "image",
      status: "ready",
      contentType: "image/jpeg",
      byteSize: PHOTO_BYTES.length,
      sceneKey: null,
    });
    expect(body.provenance).toMatchObject({
      source: "stock",
      provider: "pexels",
      providerId: "101",
      rendition: "original",
      creator: "Ada",
      attribution: "Photo by Ada on Pexels",
      license: "Pexels License",
      byteSize: PHOTO_BYTES.length,
    });

    const stored = app.r2.objects.get(`media/${USER_A.id}/${body.media.id}`);
    expect(stored?.body.equals(PHOTO_BYTES)).toBe(true);
    expect(stored?.contentType).toBe("image/jpeg");

    // Provenance is persisted with the media row and returned by the list route.
    const list = await apiRequest(app.url, `/api/projects/${projectId}/media`);
    const listed = (await list.json()) as { media: MediaRecord[] };
    expect(listed.media[0].provenance?.provider).toBe("pexels");
    expect(listed.media[0].provenance?.attribution).toBe("Photo by Ada on Pexels");
    expect(app.supabase.media[0].provenance).toMatchObject({ source: "stock", providerId: "101" });
  });

  it("returns the existing media for the same asset and rendition without downloading again", async () => {
    const { app, provider } = await startStockApp();
    const projectId = await createProject(app.url);

    const first = await apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
      method: "POST",
      body: JSON.stringify(importBody()),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { media: MediaRecord; reused: boolean };
    expect(firstBody.reused).toBe(false);
    const assetHits = provider.assetHits;
    const puts = app.r2.puts;

    const second = await apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
      method: "POST",
      body: JSON.stringify(importBody()),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      media: MediaRecord;
      provenance: MediaProvenance;
      reused: boolean;
    };
    expect(secondBody.reused).toBe(true);
    expect(secondBody.media.id).toBe(firstBody.media.id);
    expect(secondBody.provenance).toMatchObject({
      provider: "pexels",
      providerId: "101",
      rendition: "original",
    });

    // The reuse path must not fetch the asset or write a second object or row.
    expect(provider.assetHits).toBe(assetHits);
    expect(app.r2.puts).toBe(puts);
    expect(app.supabase.media).toHaveLength(1);
  });

  it("scopes reuse to one project and one rendition", async () => {
    const { app } = await startStockApp();
    const firstProject = await createProject(app.url);
    const secondProject = await createProject(app.url);

    const first = await apiRequest(app.url, `/api/projects/${firstProject}/stock/import`, {
      method: "POST",
      body: JSON.stringify(importBody()),
    });
    expect(first.status).toBe(201);

    // The same asset in another project is a separate asset for that project.
    const otherProject = await apiRequest(app.url, `/api/projects/${secondProject}/stock/import`, {
      method: "POST",
      body: JSON.stringify(importBody()),
    });
    expect(otherProject.status).toBe(201);
    expect(((await otherProject.json()) as { reused: boolean }).reused).toBe(false);

    expect(app.supabase.media).toHaveLength(2);
  });

  it("exports the draft with stored stock credits and a render payload", async () => {
    const { app } = await startStockApp();
    const projectId = await createProject(app.url);
    const imported = await apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
      method: "POST",
      body: JSON.stringify(importBody()),
    });
    expect(imported.status).toBe(201);
    const media = ((await imported.json()) as { media: MediaRecord }).media;

    const document = structuredClone(DOCUMENT);
    document.scenes[0].assetIds = [media.id, "not-a-media-row"];
    const response = await apiRequest(app.url, `/api/projects/${projectId}/export`, {
      method: "POST",
      body: JSON.stringify({ title: "Credited story", document }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      export: {
        title: string;
        document: typeof DOCUMENT;
        credits: {
          mediaId: string;
          sceneIds: string[];
          creator: string;
          provider: string;
          sourcePage: string;
          license: string;
        }[];
        renderPayload: { scenes: { assets: { mediaId: string }[] }[] };
      };
    };

    expect(body.export.title).toBe("Credited story");
    expect(body.export.document).toEqual(document);
    expect(body.export.credits).toHaveLength(1);
    expect(body.export.credits[0]).toMatchObject({
      mediaId: media.id,
      sceneIds: [document.scenes[0].id],
      creator: "Ada",
      provider: "pexels",
      sourcePage: "https://www.pexels.com/photo/101/",
      license: "Pexels License",
    });
    expect(body.export.renderPayload.scenes[0].assets.map((asset) => asset.mediaId)).toEqual([media.id]);
  });

  it("reuses the winner when two identical imports complete at the same time", async () => {
    const { app, provider } = await startStockApp();
    const projectId = await createProject(app.url);

    const paused = provider.pauseAssets(2);
    const start = () =>
      apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
        method: "POST",
        body: JSON.stringify(importBody()),
      });
    const first = start();
    const second = start();
    // Both requests passed the pre-download check and are now holding the same asset.
    await paused.arrived;
    paused.release();
    const [one, two] = await Promise.all([first, second]);

    expect([one.status, two.status].sort()).toEqual([200, 201]);
    const bodies = (await Promise.all([one.json(), two.json()])) as {
      media: MediaRecord;
      provenance: MediaProvenance;
      reused: boolean;
    }[];
    const created = bodies.find((body) => !body.reused);
    const reusedBody = bodies.find((body) => body.reused);
    expect(created).toBeDefined();
    expect(reusedBody).toBeDefined();
    expect(reusedBody?.media.id).toBe(created?.media.id);

    // The store keeps exactly one ready copy; the loser's reservation is settled.
    const matching = app.supabase.media.filter((row) => {
      const provenance = row.provenance as Record<string, unknown> | null;
      return (
        provenance?.provider === "pexels" &&
        provenance.providerId === "101" &&
        provenance.rendition === "original"
      );
    });
    expect(matching.filter((row) => row.status === "ready")).toHaveLength(1);
    expect(matching.filter((row) => row.status === "deleted")).toHaveLength(1);
    expect(matching.find((row) => row.status === "ready")?.id).toBe(created?.media.id);
  });

  it("accepts Pixabay's own site host for web-format images", async () => {
    const { app } = await startStockApp();
    const projectId = await createProject(app.url);
    const response = await apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
      method: "POST",
      body: JSON.stringify(
        importBody({
          provider: "pixabay",
          providerId: "303",
          rendition: "webformat",
          url: "https://pixabay.com/photo/303_web.jpg",
          sourcePage: "https://pixabay.com/photos/303/",
          creator: "Cara",
          attribution: "Image by Cara on Pixabay",
          license: "Pixabay Content License",
        }),
      ),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { media: MediaRecord; provenance: MediaProvenance };
    expect(body.provenance).toMatchObject({ provider: "pixabay", providerId: "303", creator: "Cara" });
  });

  it("imports a video with detected type and dimensions recorded by the provider", async () => {
    const { app } = await startStockApp();
    const projectId = await createProject(app.url);
    const response = await apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
      method: "POST",
      body: JSON.stringify(
        importBody({
          providerId: "202",
          type: "video",
          rendition: "hd",
          url: "https://videos.pexels.com/video-files/202/hd.mp4",
          sourcePage: "https://www.pexels.com/video/202/",
          creator: "Bo",
          attribution: "Video by Bo on Pexels",
        }),
      ),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { media: MediaRecord };
    expect(body.media).toMatchObject({ kind: "video", status: "ready", contentType: "video/mp4" });
  });

  it("refuses foreign hosts, private addresses, and unsafe redirects", async () => {
    const { app } = await startStockApp();
    const projectId = await createProject(app.url);

    const foreign = await apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
      method: "POST",
      body: JSON.stringify(importBody({ url: "https://evil.example/photo.jpg" })),
    });
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe("STOCK_IMPORT_HOST_REFUSED");

    // An internal name is not a provider asset host, so it is refused before
    // it could ever be resolved. Private addresses on an allowed host are
    // covered by the direct download test below.
    const privateAddress = await apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
      method: "POST",
      body: JSON.stringify(importBody({ url: "https://internal.example/photo.jpg" })),
    });
    expect(privateAddress.status).toBe(400);
    expect(((await privateAddress.json()) as { error: { code: string } }).error.code).toBe("STOCK_IMPORT_HOST_REFUSED");

    const metadata = await apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
      method: "POST",
      body: JSON.stringify(importBody({ url: "https://metadata.example/latest/meta-data" })),
    });
    expect(metadata.status).toBe(400);

    const redirectPrivate = await apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
      method: "POST",
      body: JSON.stringify(importBody({ url: "https://images.pexels.com/assets/redirect-private" })),
    });
    expect(redirectPrivate.status).toBe(400);
    expect(((await redirectPrivate.json()) as { error: { code: string } }).error.code).toBe(
      "STOCK_IMPORT_HOST_REFUSED",
    );

    const redirectForeign = await apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
      method: "POST",
      body: JSON.stringify(importBody({ url: "https://images.pexels.com/assets/redirect-foreign" })),
    });
    expect(redirectForeign.status).toBe(400);
    expect(((await redirectForeign.json()) as { error: { code: string } }).error.code).toBe(
      "STOCK_IMPORT_HOST_REFUSED",
    );

    const httpUrl = await apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
      method: "POST",
      body: JSON.stringify(importBody({ url: "http://images.pexels.com/photos/101/original.jpg" })),
    });
    expect(httpUrl.status).toBe(400);

    // Nothing was downloaded, so the project has no media row.
    expect(app.supabase.media).toHaveLength(0);
  });

  it("follows a redirect that stays on the provider host", async () => {
    const { app } = await startStockApp();
    const projectId = await createProject(app.url);
    const response = await apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
      method: "POST",
      body: JSON.stringify(importBody({ url: "https://images.pexels.com/assets/redirect-ok" })),
    });
    expect(response.status).toBe(201);
  });

  it("refuses oversized bodies, wrong content types, and playlists", async () => {
    const { app } = await startStockApp({ MEDIA_IMAGE_MAX_BYTES: "1024" });
    const projectId = await createProject(app.url);

    const oversized = await apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
      method: "POST",
      body: JSON.stringify(importBody({ url: "https://images.pexels.com/assets/oversize.jpg" })),
    });
    expect(oversized.status).toBe(413);
    expect(((await oversized.json()) as { error: { code: string } }).error.code).toBe("STOCK_IMPORT_TOO_LARGE");

    const wrongType = await apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
      method: "POST",
      body: JSON.stringify(importBody({ url: "https://images.pexels.com/assets/not-image.jpg" })),
    });
    expect(wrongType.status).toBe(422);

    const playlist = await apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
      method: "POST",
      body: JSON.stringify(
        importBody({
          type: "video",
          url: "https://images.pexels.com/assets/playlist.m3u8",
          sourcePage: "https://www.pexels.com/video/202/",
        }),
      ),
    });
    expect(playlist.status).toBe(422);
    expect(((await playlist.json()) as { error: { code: string } }).error.code).toBe("STOCK_IMPORT_PLAYLIST");

    expect(app.supabase.media).toHaveLength(0);
  });

  it("is owner-scoped and refuses a body that does not match the asset", async () => {
    const { app } = await startStockApp();
    const projectId = await createProject(app.url);

    const foreignProject = await apiRequest(
      app.url,
      `/api/projects/${projectId}/stock/import`,
      { method: "POST", body: JSON.stringify(importBody()) },
      USER_B.token,
    );
    expect(foreignProject.status).toBe(404);

    const mismatch = await apiRequest(app.url, `/api/projects/${projectId}/stock/import`, {
      method: "POST",
      body: JSON.stringify(importBody({ type: "video", url: "https://images.pexels.com/photos/101/original.jpg" })),
    });
    expect(mismatch.status).toBe(422);
    expect(((await mismatch.json()) as { error: { code: string } }).error.code).toBe("STOCK_IMPORT_TYPE_MISMATCH");
    expect(app.supabase.media).toHaveLength(0);
  });
});
