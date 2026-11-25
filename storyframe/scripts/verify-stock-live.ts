import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createStockSearch, loadStockLimits, parseStockSearchInput } from "../server/stock";

/**
 * Opt-in live provider check for Phase 6.
 *
 * Calls the real Pexels and Pixabay search endpoints through the same adapters
 * the server uses, then prints normalized counts and the selected rendition for
 * one image and one video search. It writes nothing, needs no Supabase or R2
 * account, and uses no cache (each call goes to the providers).
 *
 * Import is not exercised here: it needs the private bucket, which is covered by
 * `verify:media-live` and the local import tests.
 */
try {
  loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // .env is optional when the variables already exist in the environment.
}

const limits = loadStockLimits(process.env, { imageBytes: 10 * 1024 * 1024, videoBytes: 200 * 1024 * 1024 });
if (!limits.pexelsKey || !limits.pixabayKey) {
  console.error("verify:stock-live requires PEXELS_API_KEY and PIXABAY_API_KEY.");
  process.exit(1);
}

const search = createStockSearch({ limits, cache: null, logger: console });

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

async function run(type: "image" | "video", query: string): Promise<void> {
  const input = parseStockSearchInput(
    new URLSearchParams({ q: query, type, sources: "pexels,pixabay" }),
    limits,
  );
  const response = await search(input);
  const providers = response.providers.map((status) => `${status.provider}:${status.ok ? status.count : status.error}`);
  console.log(`\n${type} "${query}" -> ${response.results.length} merged result(s); ${providers.join(", ")}`);

  check(`${type}: at least one provider returned results`, response.results.length > 0);
  check(
    `${type}: every result carries a credit, page, and selected rendition`,
    response.results.every(
      (result) =>
        result.attribution.length > 0 &&
        result.sourcePage.startsWith("https://") &&
        result.selectedRendition.length > 0 &&
        result.width > 0 &&
        result.height > 0,
    ),
  );
  check(
    `${type}: no rendition URL is a playlist`,
    response.results.every((result) => result.renditions.every((rendition) => !/\.(m3u8|mpd)(\?|$)/.test(rendition.url))),
  );
  check(
    `${type}: provider names appear once per selected source`,
    new Set(response.sources).size === response.sources.length && response.providers.length === response.sources.length,
  );

  const sample = response.results[0];
  if (sample) {
    console.log(
      `  sample: ${sample.providerName} ${sample.providerId} "${sample.title.slice(0, 60)}" ` +
        `${sample.width}x${sample.height} ${sample.selectedRendition} — ${sample.attribution}`,
    );
    console.log(`  source: ${sample.sourcePage}`);
  }
}

await run("image", "rainy city street");
await run("video", "ocean waves");

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
