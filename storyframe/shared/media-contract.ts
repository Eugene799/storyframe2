export type MediaKind = "image" | "audio" | "video";
export type MediaStatus = "pending" | "ready" | "deleted";
export type MediaRefKind = "scene" | "render" | "document" | "other";

/**
 * Where an imported asset came from. Stored as validated JSONB on the media row
 * so a project's licensed media keeps its credit after the search is gone.
 */
export interface MediaProvenance {
  source: "stock";
  provider: "pexels" | "pixabay";
  providerId: string;
  type: "image" | "video";
  rendition: string;
  renditionUrl: string;
  sourcePage: string;
  creator: string;
  attribution: string;
  license: string;
  downloadedAt: string;
  byteSize: number;
}

export interface MediaRecord {
  id: string;
  kind: MediaKind;
  status: MediaStatus;
  sceneKey: string | null;
  contentType: string;
  byteSize: number;
  uploadExpiresAt: string | null;
  readyAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  referenceCount: number;
  provenance: MediaProvenance | null;
}

export interface MediaReferenceRecord {
  id: string;
  refKind: MediaRefKind;
  refId: string;
  createdAt: string;
}

export interface MediaUploadTicket {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

export interface MediaPlayback {
  url: string;
  expiresAt: string;
  contentType: string;
  byteSize: number;
}
