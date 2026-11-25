import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/config";
import { auditMedia, hasMediaAuditDrift } from "../server/media-audit";
import { createSupabaseMediaStore } from "../server/media";
import { createR2Client } from "../server/r2";

/**
 * Read-only bucket-vs-database audit.
 *
 * Lists every object under `media/` and every `media_metadata` row, then reports
 * bucket objects that no row owns and ready rows whose object is missing. A
 * project deletion that could not reach the bucket leaves the first kind behind
 * and its rows are already gone, so this command is the only way to find them.
 *
 * It never deletes or changes anything. Exit codes: 0 clean, 1 drift found (or
 * the audit could not complete, so drift is unknown), 2 missing configuration.
 */

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
try {
  loadEnvFile(envPath);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") console.warn(`[media-audit] Could not load ${envPath} (${code ?? "unknown error"}).`);
}

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error(`SKIP  ${error instanceof Error ? error.message : "The environment is not valid."}`);
  process.exit(2);
}

if (!config.supabaseUrl || !config.supabaseServiceRoleKey || !config.r2) {
  console.error(
    "SKIP  Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and the R2 endpoint, bucket, access key, and secret.",
  );
  process.exit(2);
}

const store = createSupabaseMediaStore({
  url: config.supabaseUrl,
  serviceRoleKey: config.supabaseServiceRoleKey,
  timeoutMs: config.authTimeoutMs,
});
const objects = createR2Client(config.r2);

function line(name: string, value: number): void {
  console.log(`${name}: ${value}`);
}

const report = await auditMedia({ store, objects }).catch((error: unknown) => {
  // A failed scan is not "clean": report it as a failure, never as drift-free.
  const detail = error instanceof Error ? error.message : "unknown error";
  console.error(`\nFAIL  The audit could not complete, so drift is unknown: ${detail}`);
  process.exit(1);
});

console.log("StoryFrame media audit (read-only)");
console.log(`prefix ${report.prefix}`);
line("rows", report.rows);
console.log(
  `  ready ${report.statuses.ready}, pending ${report.statuses.pending}, deleted ${report.statuses.deleted}`,
);
line("objects", report.objects);
line("object bytes", report.objectBytes);

console.log("");
line("orphan objects (in the bucket, no row)", report.orphanObjectCount);
for (const orphan of report.orphanObjects) {
  console.log(`  ${orphan.key}  ${orphan.byteSize} bytes`);
}
if (report.orphanObjectCount > report.orphanObjects.length) {
  console.log(`  ... and ${report.orphanObjectCount - report.orphanObjects.length} more`);
}

line("ready rows without an object", report.missingObjectCount);
for (const missing of report.missingObjects) {
  console.log(`  ${missing.id}  owner ${missing.ownerId}  project ${missing.projectId}  ${missing.objectKey}`);
}
if (report.missingObjectCount > report.missingObjects.length) {
  console.log(`  ... and ${report.missingObjectCount - report.missingObjects.length} more`);
}

if (hasMediaAuditDrift(report)) {
  console.error("\nFAIL  The bucket and media rows disagree. Nothing was changed.");
  process.exit(1);
}
console.log("\nPASS  Every media object has a row and every ready row has its object.");
