import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Local stand-in for an R2 bucket's S3 endpoint. Presigned query strings and
 * Authorization headers are ignored here; the real SigV4 signing is exercised by
 * `npm run verify:r2-live` against the configured bucket, not by these tests.
 */
export interface FakeR2Object {
  body: Buffer;
  contentType: string;
}

export interface FakeR2 {
  url: string;
  bucket: string;
  objects: Map<string, FakeR2Object>;
  puts: number;
  close: () => Promise<void>;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function startFakeR2(bucket = "storyframe-test-media"): Promise<FakeR2> {
  const objects = new Map<string, FakeR2Object>();
  let puts = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const prefix = `/${bucket}/`;

    // S3 ListObjectsV2: the bucket root with list-type=2, prefix and a keyset
    // continuation token. The audit relies on this being paged.
    if (
      (url.pathname === `/${bucket}` || url.pathname === `/${bucket}/`) &&
      request.method === "GET" &&
      url.searchParams.get("list-type") === "2"
    ) {
      const objectPrefix = url.searchParams.get("prefix") ?? "";
      const requested = Math.floor(Number(url.searchParams.get("max-keys") ?? "1000"));
      const maxKeys = Number.isFinite(requested) ? Math.max(1, Math.min(1000, requested)) : 1000;
      const token = url.searchParams.get("continuation-token");
      const all = [...objects.keys()].filter((key) => key.startsWith(objectPrefix)).sort();
      const remaining = token ? all.filter((key) => key > token) : all;
      const page = remaining.slice(0, maxKeys);
      const truncated = remaining.length > page.length;
      const contents = page
        .map((key) => {
          const size = objects.get(key)?.body.length ?? 0;
          return `<Contents><Key>${xmlEscape(key)}</Key><Size>${size}</Size></Contents>`;
        })
        .join("");
      const next =
        truncated && page.length > 0
          ? `<NextContinuationToken>${xmlEscape(page[page.length - 1])}</NextContinuationToken>`
          : "";
      response.writeHead(200, { "Content-Type": "application/xml" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>${contents}${next}</ListBucketResult>`,
      );
      return;
    }

    if (!url.pathname.startsWith(prefix)) {
      response.writeHead(404).end();
      return;
    }
    const key = decodeURIComponent(url.pathname.slice(prefix.length));

    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      objects.set(key, {
        body: Buffer.concat(chunks),
        contentType: String(request.headers["content-type"] ?? "application/octet-stream"),
      });
      puts += 1;
      response.writeHead(200).end();
      return;
    }

    const object = objects.get(key);
    if (!object) {
      response.writeHead(404).end();
      return;
    }

    if (request.method === "HEAD") {
      response
        .writeHead(200, {
          "Content-Length": String(object.body.length),
          "Content-Type": object.contentType,
          ETag: '"fake-etag"',
        })
        .end();
      return;
    }

    if (request.method === "GET") {
      const range = request.headers.range;
      if (typeof range === "string") {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (match) {
          const start = Number(match[1]);
          const end = match[2] ? Math.min(Number(match[2]), object.body.length - 1) : object.body.length - 1;
          const slice = object.body.subarray(start, end + 1);
          response
            .writeHead(206, {
              "Content-Length": String(slice.length),
              "Content-Range": `bytes ${start}-${end}/${object.body.length}`,
              "Content-Type": object.contentType,
            })
            .end(slice);
          return;
        }
      }
      response.writeHead(200, { "Content-Length": String(object.body.length) }).end(object.body);
      return;
    }

    if (request.method === "DELETE") {
      objects.delete(key);
      response.writeHead(204).end();
      return;
    }

    response.writeHead(405).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    bucket,
    objects,
    get puts() {
      return puts;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
