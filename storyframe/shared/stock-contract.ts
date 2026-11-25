import type { MediaProvenance, MediaRecord } from "./media-contract";

/**
 * Phase 6: stock search.
 *
 * A search result is a preview, not a project asset. Importing one is a separate
 * server-mediated download that lands in private media storage with provenance.
 */

export const STOCK_PROVIDERS = ["pexels", "pixabay"] as const;
export type StockProvider = (typeof STOCK_PROVIDERS)[number];

export const STOCK_TYPES = ["image", "video"] as const;
export type StockType = (typeof STOCK_TYPES)[number];

/** One downloadable or previewable variant of a provider result. */
export interface StockRendition {
  label: string;
  url: string;
  width: number;
  height: number;
  contentType: string;
  /** Provider-reported size when it supplies one; null when it does not. */
  byteSize: number | null;
  fps: number | null;
}

export interface StockResult {
  provider: StockProvider;
  providerName: string;
  providerId: string;
  type: StockType;
  title: string;
  previewUrl: string;
  renditions: StockRendition[];
  /** Label of the rendition `width`/`height` and import recommendation describe. */
  selectedRendition: string;
  sourcePage: string;
  creator: string;
  creatorUrl: string | null;
  /** Ready-to-display credit line, e.g. "Photo by Ada on Pexels". */
  attribution: string;
  license: string;
  licenseUrl: string;
  width: number;
  height: number;
  durationSeconds: number | null;
}

export interface StockProviderStatus {
  provider: StockProvider;
  ok: boolean;
  count: number;
  page: number;
  hasMore: boolean;
  cached: boolean;
  rateLimitRemaining: number | null;
  /** Sanitized code only; never an upstream message or a URL with a key. */
  error: string | null;
}

export interface StockSearchResponse {
  ok: true;
  query: string;
  type: StockType;
  sources: StockProvider[];
  /** `page` is applied per provider, then the pages are merged. */
  page: number;
  resultsPerProvider: number;
  results: StockResult[];
  providers: StockProviderStatus[];
  fetchedAt: string;
}

export interface StockImportRequest {
  provider: StockProvider;
  providerId: string;
  type: StockType;
  /** Rendition label from the selected search result, for provenance. */
  rendition: string;
  /** Exact rendition URL to download; the server re-validates host and redirects. */
  url: string;
  sourcePage: string;
  creator: string;
  attribution: string;
  license: string;
}

export interface StockImportResponse {
  ok: true;
  media: MediaRecord;
  provenance: MediaProvenance;
  /** True when this asset and rendition was already in the project and reused. */
  reused: boolean;
}
