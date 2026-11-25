import { createHash, createHmac } from "node:crypto";

/**
 * Minimal S3-compatible client for Cloudflare R2.
 *
 * Only the operations media storage needs are implemented: presigned PUT/GET and
 * signed HEAD, range GET, and DELETE. Presigning keeps the R2 secret in this
 * process: the browser receives a short-lived URL for one private object key.
 *
 * Signed URL query strings and the secret are never logged. Callers must not log
 * a presigned URL either; redact its query string if it ever needs to appear.
 */

const ALGORITHM = "AWS4-HMAC-SHA256";
const REGION = "auto";
const SERVICE = "s3";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface R2Config {
  /** S3 endpoint, e.g. https://<account>.r2.cloudflarestorage.com (no bucket in the path). */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface PresignedUrl {
  url: string;
  expiresAt: string;
}

export interface R2ObjectInfo {
  byteSize: number;
}

export interface R2ListedObject {
  key: string;
  byteSize: number;
}

export interface R2ListPage {
  objects: R2ListedObject[];
  /** Set when the bucket has more objects after this page. */
  nextToken: string | null;
}

export class R2Error extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "R2Error";
    this.code = code;
  }
}

export interface R2Client {
  presignPut(key: string, expiresInSeconds: number): PresignedUrl;
  presignGet(key: string, expiresInSeconds: number): PresignedUrl;
  head(key: string): Promise<R2ObjectInfo | null>;
  /** Reads the first bytes of an object. Null when the object does not exist. */
  readRange(key: string, byteCount: number): Promise<Buffer | null>;
  /** Reads a whole bounded object (narration duration inspection). */
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<boolean>;
  /** One page of the bucket's object list under a prefix (S3 ListObjectsV2). */
  listObjects(
    prefix: string,
    options?: { continuationToken?: string | null; maxKeys?: number },
  ): Promise<R2ListPage>;
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC 3986 encoding, which is stricter than encodeURIComponent. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalUri(bucket: string, key: string): string {
  const segments = key.split("/").map(encodeRfc3986);
  return `/${encodeRfc3986(bucket)}/${segments.join("/")}`;
}

function amzDateParts(nowMs: number): { amzDate: string; dateStamp: string } {
  const amzDate = new Date(nowMs).toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(secretAccessKey: string, dateStamp: string): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, REGION);
  const serviceKey = hmac(regionKey, SERVICE);
  return hmac(serviceKey, "aws4_request");
}

export function createR2Client(config: R2Config, options: { fetchImpl?: typeof fetch; now?: () => number } = {}): R2Client {
  const base = new URL(config.endpoint.replace(/\/+$/, ""));
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());

  function presign(method: "GET" | "PUT", key: string, expiresInSeconds: number): PresignedUrl {
    const at = now();
    const { amzDate, dateStamp } = amzDateParts(at);
    const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const uri = canonicalUri(config.bucket, key);

    const params: Record<string, string> = {
      "X-Amz-Algorithm": ALGORITHM,
      "X-Amz-Credential": `${config.accessKeyId}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(expiresInSeconds),
      "X-Amz-SignedHeaders": "host",
    };
    const pairs = Object.entries(params).map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const);
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const canonicalQuery = pairs.map(([name, value]) => `${name}=${value}`).join("&");

    const canonicalRequest = [
      method,
      uri,
      canonicalQuery,
      `host:${base.host}`,
      "",
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");

    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const signature = hmac(signingKey(config.secretAccessKey, dateStamp), stringToSign).toString("hex");

    return {
      url: `${base.protocol}//${base.host}${uri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
      expiresAt: new Date(at + expiresInSeconds * 1000).toISOString(),
    };
  }

  async function signedFetch(
    method: "HEAD" | "GET" | "DELETE",
    uri: string,
    canonicalQuery: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const { amzDate, dateStamp } = amzDateParts(now());
    const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const headers: Record<string, string> = {
      host: base.host,
      "x-amz-content-sha256": EMPTY_SHA256,
      "x-amz-date": amzDate,
      ...Object.fromEntries(Object.entries(extraHeaders).map(([name, value]) => [name.toLowerCase(), value])),
    };
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((name) => `${name}:${headers[name].trim()}\n`).join("");
    const signedHeaders = names.join(";");

    const canonicalRequest = [method, uri, canonicalQuery, canonicalHeaders, signedHeaders, EMPTY_SHA256].join("\n");
    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const signature = hmac(signingKey(config.secretAccessKey, dateStamp), stringToSign).toString("hex");

    const target = `${base.protocol}//${base.host}${uri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
    try {
      return await fetchImpl(target, {
        method,
        headers: {
          ...headers,
          Authorization: `${ALGORITHM} Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new R2Error("R2_UNAVAILABLE", "The media bucket is unreachable.");
    }
  }

  function signedRequest(method: "HEAD" | "GET" | "DELETE", key: string, extraHeaders: Record<string, string> = {}) {
    return signedFetch(method, canonicalUri(config.bucket, key), "", extraHeaders);
  }

  return {
    presignPut(key, expiresInSeconds) {
      return presign("PUT", key, expiresInSeconds);
    },

    presignGet(key, expiresInSeconds) {
      return presign("GET", key, expiresInSeconds);
    },

    async head(key) {
      const response = await signedRequest("HEAD", key);
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new R2Error("R2_UNAVAILABLE", `The media bucket rejected the object check (HTTP ${response.status}).`);
      }
      const rawLength = response.headers.get("content-length");
      const byteSize = rawLength === null ? Number.NaN : Number(rawLength);
      if (!Number.isFinite(byteSize) || byteSize < 0) {
        throw new R2Error("R2_UNAVAILABLE", "The media bucket returned an unreadable object size.");
      }
      return { byteSize };
    },

    async readRange(key, byteCount) {
      const response = await signedRequest("GET", key, { range: `bytes=0-${Math.max(0, byteCount - 1)}` });
      if (response.status === 404) return null;
      if (!response.ok && response.status !== 206) {
        throw new R2Error("R2_UNAVAILABLE", `The media bucket rejected the object read (HTTP ${response.status}).`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      return bytes.subarray(0, byteCount);
    },

    async get(key) {
      const response = await signedRequest("GET", key);
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new R2Error("R2_UNAVAILABLE", `The media bucket rejected the object read (HTTP ${response.status}).`);
      }
      return Buffer.from(await response.arrayBuffer());
    },

    async delete(key) {
      const response = await signedRequest("DELETE", key);
      if (response.status === 204 || response.status === 200 || response.status === 404) return true;
      throw new R2Error("R2_UNAVAILABLE", `The media bucket rejected the object removal (HTTP ${response.status}).`);
    },

    async listObjects(prefix, options = {}) {
      const maxKeys = Math.min(1000, Math.max(1, Math.floor(options.maxKeys ?? 1000)));
      const pairs: [string, string][] = [
        ["list-type", "2"],
        ["max-keys", String(maxKeys)],
      ];
      if (prefix.length > 0) pairs.push(["prefix", prefix]);
      if (options.continuationToken) pairs.push(["continuation-token", options.continuationToken]);
      const canonicalQuery = pairs
        .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([name, value]) => `${name}=${value}`)
        .join("&");
      const response = await signedFetch("GET", `/${encodeRfc3986(config.bucket)}`, canonicalQuery);
      if (!response.ok) {
        throw new R2Error(
          "R2_UNAVAILABLE",
          `The media bucket rejected the object list (HTTP ${response.status}).`,
        );
      }
      return parseObjectList(await response.text());
    },
  };
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Reads the S3 ListObjectsV2 document without a full XML parser. */
function parseObjectList(document: string): R2ListPage {
  const objects: R2ListedObject[] = [];
  for (const match of document.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(match[1])?.[1];
    if (key === undefined) continue;
    const size = Number(/<Size>([\s\S]*?)<\/Size>/.exec(match[1])?.[1]);
    objects.push({ key: xmlUnescape(key), byteSize: Number.isFinite(size) ? size : 0 });
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(document);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(document)?.[1];
  return { objects, nextToken: truncated && token ? xmlUnescape(token) : null };
}
