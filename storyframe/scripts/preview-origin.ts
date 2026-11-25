import { readFileSync } from "node:fs";

/**
 * The origin the preview build uploads from: what `cors.json` declares, not
 * whatever the bucket happens to allow. The live checks preflight a real
 * presigned upload from it, so a bucket rule left on an old preview hostname
 * fails the run instead of only showing up as a 403 in the browser.
 */
const PREVIEW_ORIGIN: string | undefined = (
  JSON.parse(readFileSync(new URL("../cors.json", import.meta.url), "utf8")) as {
    rules: { allowed: { origins: string[] } }[];
  }
).rules
  .flatMap((rule) => rule.allowed.origins)
  .find((origin) => !origin.startsWith("http://localhost"));

/** A preflight verdict, plus the line to print when it fails. */
export interface Preflight {
  ok: boolean;
  detail: string;
}

/** Ask the bucket whether a browser on the preview origin may PUT this upload. */
export async function preflightUpload(uploadUrl: string): Promise<Preflight> {
  if (!PREVIEW_ORIGIN) return { ok: false, detail: "cors.json names no preview origin to test" };

  const response = await fetch(uploadUrl, {
    method: "OPTIONS",
    headers: {
      Origin: PREVIEW_ORIGIN,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  const allowOrigin = response.headers.get("access-control-allow-origin") ?? "none";
  return {
    ok: response.status >= 200 && response.status < 300 && allowOrigin === PREVIEW_ORIGIN,
    detail: `origin=${PREVIEW_ORIGIN} status=${response.status} allow-origin=${allowOrigin}`,
  };
}
