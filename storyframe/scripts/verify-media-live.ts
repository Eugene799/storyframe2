import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createStoryframeServer } from "../server/app";
import { createR2Client } from "../server/r2";
import { preflightUpload } from "./preview-origin";

/**
 * Opt-in live check of the Phase 3 media routes against the hosted Supabase
 * project and the real private R2 bucket.
 *
 * It creates two disposable auth users, uploads a tiny PNG through the real
 * presigned ticket, plays it back through a presigned URL, checks reference
 * counting and two-account isolation, then deletes the users, projects, rows,
 * and objects. It never prints keys, tokens, or signed URLs.
 *
 * Requires SUPABASE_URL, a publishable key, SUPABASE_SERVICE_ROLE_KEY, and the
 * R2 endpoint/bucket/credentials (or their CLOUDFLARE_* fallbacks).
 */

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
try {
  loadEnvFile(envPath);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") console.warn(`[media-live] Could not load ${envPath} (${code ?? "unknown error"}).`);
}

function value(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

const supabaseUrl = value("SUPABASE_URL")?.replace(/\/+$/, "") ?? null;
const publishableKey = value("SUPABASE_PUBLISHABLE_KEY") ?? value("SUPABASE_ANON_KEY");
const serviceRoleKey = value("SUPABASE_SERVICE_ROLE_KEY");
const r2 = {
  endpoint: value("R2_ENDPOINT") ?? value("CLOUDFLARE_S3_ENDPOINT_URL"),
  bucket: value("R2_BUCKET_NAME") ?? value("CLOUDFLARE_R2_BUCKET_NAME"),
  accessKeyId: value("R2_ACCESS_KEY_ID") ?? value("CLOUDFLARE_ACCESS_ID"),
  secretAccessKey: value("R2_SECRET_ACCESS_KEY") ?? value("CLOUDFLARE_SECRET_ACCESS_KEY"),
};

if (!supabaseUrl || !publishableKey || !serviceRoleKey || !r2.endpoint || !r2.bucket || !r2.accessKeyId || !r2.secretAccessKey) {
  console.error("SKIP  Set the Supabase URL/publishable/service-role values and the R2 endpoint, bucket, and keys.");
  process.exit(2);
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(96, 3)]);
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
}

interface LiveUser {
  id: string;
  email: string;
  password: string;
  token: string;
}

const adminHeaders = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

async function createUser(label: string): Promise<LiveUser> {
  const email = `storyframe-media-${Date.now()}-${label}-${randomBytes(4).toString("hex")}@example.com`;
  const password = `${randomBytes(18).toString("base64url")}Aa1!`;
  const created = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`admin user create failed (HTTP ${created.status})`);
  const user = (await created.json()) as { id: string };

  const signedIn = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey!, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signedIn.ok) throw new Error(`password sign-in failed (HTTP ${signedIn.status})`);
  const session = (await signedIn.json()) as { access_token: string };
  return { id: user.id, email, password, token: session.access_token };
}

const server = createStoryframeServer({
  env: {
    ...process.env,
    SUPABASE_URL: supabaseUrl,
    SUPABASE_PUBLISHABLE_KEY: publishableKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    R2_ENDPOINT: r2.endpoint,
    R2_BUCKET_NAME: r2.bucket,
    R2_ACCESS_KEY_ID: r2.accessKeyId,
    R2_SECRET_ACCESS_KEY: r2.secretAccessKey,
    MEDIA_SWEEP_INTERVAL_MS: "0",
  },
  logger: { error: () => undefined },
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const appUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const objects = createR2Client({
  endpoint: r2.endpoint,
  bucket: r2.bucket,
  accessKeyId: r2.accessKeyId,
  secretAccessKey: r2.secretAccessKey,
});

let userA: LiveUser | null = null;
let userB: LiveUser | null = null;
let projectA: string | null = null;
let mediaA: string | null = null;
let mediaKey: string | null = null;

function api(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${appUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
}

async function cleanup(): Promise<void> {
  try {
    // Objects first: database rows cascade, bucket objects do not.
    if (userA || userB) {
      const ownerIds = [userA?.id, userB?.id].filter(Boolean).join(",");
      const rows = await fetch(
        `${supabaseUrl}/rest/v1/media_metadata?select=object_key&owner_id=in.(${ownerIds})`,
        { headers: adminHeaders },
      );
      if (rows.ok) {
        for (const row of (await rows.json()) as { object_key: string }[]) {
          await objects.delete(row.object_key).catch(() => undefined);
        }
      }
    }
    // Delete the project while its owner's session is still valid; the users go last.
    if (projectA && userA) {
      await api(`/api/projects/${projectA}`, userA.token, { method: "DELETE" }).catch(() => undefined);
    }
    for (const user of [userA, userB]) {
      if (!user) continue;
      await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, {
        method: "DELETE",
        headers: adminHeaders,
      }).catch(() => undefined);
    }
  } catch {
    console.error("[media-live] cleanup did not finish cleanly");
  }
}

try {
  userA = await createUser("a");
  userB = await createUser("b");
  check("disposable users created and signed in through Supabase Auth", Boolean(userA.token && userB.token));

  const projectResponse = await api("/api/projects", userA.token, {
    method: "POST",
    body: JSON.stringify({
      projectType: "story",
      title: "Media live check",
      document: {
        schemaVersion: 2,
        summary: "Live media route check.",
        brief: {
          topic: "Live media",
          audience: "Internal",
          goal: "Prove the media routes",
          mode: "fiction",
          targetDurationSeconds: 60,
          tone: "Neutral",
          preset: "Story short",
          voicePreference: "neutral",
          planningBudgetUsd: 0,
        },
        scenes: [],
      },
    }),
  });
  check("project created for the first account", projectResponse.status === 201);
  projectA = ((await projectResponse.json()) as { project: { id: string } }).project.id;

  const initiate = await api(`/api/projects/${projectA}/media`, userA.token, {
    method: "POST",
    body: JSON.stringify({ kind: "image", contentType: "image/png", byteSize: PNG.length }),
  });
  check("upload initiation returns 201", initiate.status === 201);
  const ticket = (await initiate.json()) as {
    media: { id: string; status: string };
    upload: { url: string; method: "PUT"; headers: Record<string, string> };
  };
  mediaA = ticket.media.id;
  mediaKey = `media/${userA.id}/${mediaA}`;
  check("reservation is pending with a private key shape", ticket.media.status === "pending");
  check(
    "ticket contains a presigned URL, not a credential",
    ticket.upload.url.includes("X-Amz-Signature=") && !ticket.upload.url.includes(r2.secretAccessKey!),
  );

  // The browser uploads straight to this ticket, so the bucket must answer the
  // preview origin's preflight. A rule left on an old hostname fails here.
  const cors = await preflightUpload(ticket.upload.url);
  check("the bucket CORS rule lets the browser upload from the cors.json preview origin", cors.ok, cors.detail);

  const put = await fetch(ticket.upload.url, {
    method: "PUT",
    headers: ticket.upload.headers,
    body: new Uint8Array(PNG),
  });
  check("direct presigned upload to the real bucket succeeds", put.status === 200);

  const complete = await api(`/api/projects/${projectA}/media/${mediaA}/complete`, userA.token, { method: "POST" });
  const completed = complete.ok
    ? ((await complete.json()) as { media: { status: string; contentType: string; byteSize: number } })
    : null;
  if (!complete.ok) {
    console.log(`      completion failed: HTTP ${complete.status} ${JSON.stringify(await complete.json())}`);
  }
  check("completion marks the media ready", complete.status === 200 && completed?.media.status === "ready");
  check(
    "completion reports the detected type and real size",
    completed?.media.contentType === "image/png" && completed?.media.byteSize === PNG.length,
  );

  const playback = await api(`/api/projects/${projectA}/media/${mediaA}/url`, userA.token);
  check("playback URL issued for the owner", playback.status === 200);
  const playbackBody = playback.ok ? ((await playback.json()) as { url: string }) : null;
  const downloaded = playbackBody ? await fetch(playbackBody.url) : null;
  const bytes = downloaded ? Buffer.from(await downloaded.arrayBuffer()) : Buffer.alloc(0);
  check(
    "presigned playback returns the exact uploaded bytes",
    downloaded?.status === 200 && bytes.equals(PNG),
  );

  const attach = await api(`/api/projects/${projectA}/media/${mediaA}/references`, userA.token, {
    method: "POST",
    body: JSON.stringify({ refKind: "scene", refId: "scene-1" }),
  });
  check("reference attached", attach.status === 201);
  const referenceId = attach.ok
    ? ((await attach.json()) as { reference: { id: string } }).reference.id
    : "";

  const blocked = await api(`/api/projects/${projectA}/media/${mediaA}`, userA.token, { method: "DELETE" });
  check("deletion is refused while a reference remains (409)", blocked.status === 409);

  // Row-level security on the new table, exercised directly as a signed-in user.
  const ownRows = await fetch(
    `${supabaseUrl}/rest/v1/media_metadata?select=id&owner_id=eq.${userA.id}`,
    { headers: { apikey: publishableKey!, Authorization: `Bearer ${userA.token}` } },
  );
  const ownRowsBody = ownRows.ok ? ((await ownRows.json()) as { id: string }[]) : [];
  check("RLS: owner reads their own media row", ownRows.ok && ownRowsBody.some((row) => row.id === mediaA));

  const otherRows = await fetch(
    `${supabaseUrl}/rest/v1/media_metadata?select=id&owner_id=eq.${userA.id}`,
    { headers: { apikey: publishableKey!, Authorization: `Bearer ${userB.token}` } },
  );
  const otherRowsBody = otherRows.ok ? ((await otherRows.json()) as { id: string }[]) : [];
  check("RLS: the second account reads none of the first account's media", otherRows.ok && otherRowsBody.length === 0);

  const browserWrite = await fetch(`${supabaseUrl}/rest/v1/media_references`, {
    method: "POST",
    headers: {
      apikey: publishableKey!,
      Authorization: `Bearer ${userB.token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      media_id: mediaA,
      project_id: projectA,
      owner_id: userB.id,
      ref_kind: "scene",
      ref_id: "scene-1",
    }),
  });
  check("RLS: browser writes to media_references are refused", browserWrite.status >= 400);

  // Cross-owner routes on the same project id.
  const foreignPlayback = await api(`/api/projects/${projectA}/media/${mediaA}/url`, userB.token);
  check("second account cannot get a playback URL (404)", foreignPlayback.status === 404);
  const foreignDelete = await api(`/api/projects/${projectA}/media/${mediaA}`, userB.token, { method: "DELETE" });
  check("second account cannot delete the media (404)", foreignDelete.status === 404);

  const release = await api(`/api/projects/${projectA}/media/${mediaA}/references/${referenceId}`, userA.token, {
    method: "DELETE",
  });
  check("reference released", release.status === 200);
  const stillPlayable = await api(`/api/projects/${projectA}/media/${mediaA}/url`, userA.token);
  check("asset remains playable after its reference is released", stillPlayable.status === 200);
  const stillThere = await objects.head(mediaKey);
  check("object is still present after one reference is released", stillThere?.byteSize === PNG.length);

  const removeAsset = await api(`/api/projects/${projectA}/media/${mediaA}`, userA.token, { method: "DELETE" });
  check("unreferenced media deletion returns 200", removeAsset.status === 200);
  check("deleted object is gone from the bucket", (await objects.head(mediaKey)) === null);

  const listAfter = await api(`/api/projects/${projectA}/media`, userA.token);
  const listed = listAfter.ok ? ((await listAfter.json()) as { media: { id: string; status: string }[] }) : null;
  check(
    "deleted media remains visible as deleted until retention",
    listed?.media.find((row) => row.id === mediaA)?.status === "deleted",
  );

  // Project deletion must clean up a remaining object, not just rows, even
  // after its scene id was removed.
  const secondInitiate = await api(`/api/projects/${projectA}/media`, userA.token, {
    method: "POST",
    body: JSON.stringify({ kind: "image", contentType: "image/png", byteSize: PNG.length }),
  });
  check("second upload initiated for project-deletion cleanup", secondInitiate.status === 201);
  const secondTicket = (await secondInitiate.json()) as {
    media: { id: string };
    upload: { url: string; headers: Record<string, string> };
  };
  const secondKey = `media/${userA.id}/${secondTicket.media.id}`;
  const secondPut = await fetch(secondTicket.upload.url, {
    method: "PUT",
    headers: secondTicket.upload.headers,
    body: new Uint8Array(PNG),
  });
  check("second upload reaches the real bucket", secondPut.status === 200);
  const secondComplete = await api(
    `/api/projects/${projectA}/media/${secondTicket.media.id}/complete`,
    userA.token,
    { method: "POST" },
  );
  check("second upload completes", secondComplete.status === 200);
  check("second object is present before project deletion", (await objects.head(secondKey))?.byteSize === PNG.length);

  // A saved scene asset id is a link even with no reference row. The delete
  // must refuse it rather than leave the stored document dangling.
  const projectRead = await api(`/api/projects/${projectA}`, userA.token);
  check("project reads back for the document guard", projectRead.status === 200);
  const projectBody = (await projectRead.json()) as {
    project: {
      title: string;
      version: number;
      document: { schemaVersion: number; summary: string; brief: unknown; scenes: unknown[] };
    };
  };
  const guardScene = {
    id: "scene-1",
    heading: "Media guard",
    body: "The saved document still lists this asset.",
    visualDirection: "",
    assetIds: [secondTicket.media.id],
    onScreenText: "",
    durationSeconds: 5,
    approved: false,
    approvedFingerprint: null,
    locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
  };
  const saveWithAsset = await api(`/api/projects/${projectA}`, userA.token, {
    method: "PUT",
    body: JSON.stringify({
      title: projectBody.project.title,
      document: { ...projectBody.project.document, scenes: [guardScene] },
      version: projectBody.project.version,
    }),
  });
  check("document saved with the second asset id", saveWithAsset.status === 200);

  const guardedDelete = await api(`/api/projects/${projectA}/media/${secondTicket.media.id}`, userA.token, {
    method: "DELETE",
  });
  const guardedBody = (await guardedDelete.json()) as { error?: { code?: string } };
  check(
    "deleting a document-listed asset is refused (409)",
    guardedDelete.status === 409 && guardedBody.error?.code === "MEDIA_ASSET_IN_DOCUMENT",
  );
  check("refused delete leaves the object in the bucket", (await objects.head(secondKey))?.byteSize === PNG.length);

  const clearAsset = await api(`/api/projects/${projectA}`, userA.token, {
    method: "PUT",
    body: JSON.stringify({
      title: projectBody.project.title,
      document: {
        ...projectBody.project.document,
        scenes: [{ ...guardScene, assetIds: [] }],
      },
      version: projectBody.project.version + 1,
    }),
  });
  check("document saved without the second asset id", clearAsset.status === 200);

  const removeProject = await api(`/api/projects/${projectA}`, userA.token, { method: "DELETE" });
  check("project deletion returns 200", removeProject.status === 200);
  check("project deletion removes the remaining object", (await objects.head(secondKey)) === null);
  check("deleted project is no longer readable (404)", (await api(`/api/projects/${projectA}`, userA.token)).status === 404);
} catch (error) {
  check(`live check ran without an unexpected error (${(error as Error).message})`, false);
} finally {
  await cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// Cleanup evidence: the disposable users and their rows must be gone.
if (userA && userB) {
  const leftovers = await fetch(
    `${supabaseUrl}/rest/v1/media_metadata?select=id&owner_id=in.(${userA.id},${userB.id})`,
    { headers: adminHeaders },
  );
  const leftoverRows = leftovers.ok ? ((await leftovers.json()) as unknown[]) : null;
  check("cleanup removed the disposable media rows", leftoverRows !== null && leftoverRows.length === 0);

  const goneA = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userA.id}`, { headers: adminHeaders });
  const goneB = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userB.id}`, { headers: adminHeaders });
  check("cleanup removed both disposable auth users", goneA.status === 404 && goneB.status === 404);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
