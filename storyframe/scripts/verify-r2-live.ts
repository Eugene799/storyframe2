import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createR2Client } from "../server/r2";
import { preflightUpload } from "./preview-origin";

/**
 * Opt-in live check of the R2 signing and bucket access the media routes use.
 *
 * It writes one tiny, clearly named test object, reads it back through a
 * presigned URL, checks a range read, and deletes it. It never prints the access
 * key, the secret, or a signed URL (whose query string is a temporary
 * capability). No bucket, user, or other resource is created.
 *
 * R2_BUCKET_NAME (or CLOUDFLARE_R2_BUCKET_NAME) selects the bucket; without it
 * the check exits 2 instead of guessing.
 */

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
try {
  loadEnvFile(envPath);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") console.warn(`[r2] Could not load ${envPath} (${code ?? "unknown error"}).`);
}

function value(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

const endpoint = value("R2_ENDPOINT") ?? value("CLOUDFLARE_S3_ENDPOINT_URL");
const bucket = value("R2_BUCKET_NAME") ?? value("CLOUDFLARE_R2_BUCKET_NAME");
const accessKeyId = value("R2_ACCESS_KEY_ID") ?? value("CLOUDFLARE_ACCESS_ID");
const secretAccessKey = value("R2_SECRET_ACCESS_KEY") ?? value("CLOUDFLARE_SECRET_ACCESS_KEY");

if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
  console.error(
    "SKIP  Set R2_ENDPOINT (or CLOUDFLARE_S3_ENDPOINT_URL), R2_BUCKET_NAME, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.",
  );
  process.exit(2);
}

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
}

const client = createR2Client({ endpoint, bucket, accessKeyId, secretAccessKey });
const key = `media/verify-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`;
const payload = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

try {
  const put = client.presignPut(key, 120);

  // The browser uploads straight to this URL, so the bucket must answer the
  // preview origin's preflight. A rule left on an old hostname fails here.
  const cors = await preflightUpload(put.url);
  check("the bucket CORS rule lets the browser upload from the cors.json preview origin", cors.ok, cors.detail);

  const putResponse = await fetch(put.url, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: payload,
  });
  check("presigned PUT stores the test object", putResponse.status === 200);

  const head = await client.head(key);
  check("signed HEAD reports the stored size", head?.byteSize === payload.length);

  const prefixed = await client.readRange(key, 32);
  check("signed range GET reads the leading bytes", prefixed !== null && prefixed.equals(payload.subarray(0, 32)));

  // The bucket audit depends on a correctly signed ListObjectsV2 request. The
  // narrow prefix keeps this independent of whatever else the bucket holds.
  const listed = await client.listObjects("media/verify-");
  const found = listed.objects.find((object) => object.key === key);
  check("signed list finds the test object with its size", found?.byteSize === payload.length);

  const get = client.presignGet(key, 60);
  const getResponse = await fetch(get.url);
  const downloaded = getResponse.ok ? Buffer.from(await getResponse.arrayBuffer()) : Buffer.alloc(0);
  check("presigned GET returns the exact object", getResponse.status === 200 && downloaded.equals(payload));

  const removed = await client.delete(key);
  check("signed DELETE removes the object", removed);
  check("the object is gone afterwards", (await client.head(key)) === null);
} catch (error) {
  console.error(`FAIL  ${(error as Error).name}: ${(error as Error).message}`);
  results.push({ name: "live R2 operations", ok: false });
} finally {
  // A failed run must not leave the test object behind.
  await client.delete(key).catch(() => undefined);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
