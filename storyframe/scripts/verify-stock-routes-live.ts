import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createStoryframeServer } from "../server/app";
import { stockCacheKey } from "../server/stock";

/**
 * Opt-in live check for the Phase 6 routes against the hosted project.
 *
 * Creates one disposable Supabase user and one project, exercises the protected
 * stock search (twice, to prove the durable cache), video search, and the media
 * list. With R2 configured it also imports one selected image, reads its
 * provenance, fetches a playback URL, and deletes it. It then removes the
 * project, the user, and the cache rows it caused, and checks they are gone.
 *
 * It never prints keys, tokens, signed URLs, or provider responses.
 */
try {
  loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // .env is optional when the variables already exist in the environment.
}

const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
const providerKeys = {
  pexels: process.env.PEXELS_API_KEY?.trim(),
  pixabay: process.env.PIXABAY_API_KEY?.trim(),
};
const r2 = {
  endpoint: process.env.R2_ENDPOINT ?? process.env.CLOUDFLARE_S3_ENDPOINT_URL,
  bucket: process.env.R2_BUCKET_NAME ?? process.env.CLOUDFLARE_R2_BUCKET_NAME,
  accessKeyId: process.env.R2_ACCESS_KEY_ID ?? process.env.CLOUDFLARE_ACCESS_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
};
const r2Configured = Boolean(r2.endpoint && r2.bucket && r2.accessKeyId && r2.secretAccessKey);

if (!base || !serviceRoleKey || !publishableKey) {
  console.error("verify:stock-routes-live requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_PUBLISHABLE_KEY.");
  process.exit(1);
}
if (!providerKeys.pexels || !providerKeys.pixabay) {
  console.error("verify:stock-routes-live requires PEXELS_API_KEY and PIXABAY_API_KEY.");
  process.exit(1);
}

const adminHeaders = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};
const serviceHeaders = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
const authHeaders = { apikey: publishableKey, "Content-Type": "application/json" };

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

async function createUser(): Promise<{ id: string; token: string }> {
  const email = `storyframe-stock-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
  const password = `R${randomUUID()}a1!`;
  const created = await fetch(`${base}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const createdBody = (await created.json().catch(() => ({}))) as { id?: string; user?: { id?: string } };
  const id = createdBody.id ?? createdBody.user?.id;
  if (!created.ok || typeof id !== "string") {
    throw new Error(`could not create a disposable user (HTTP ${created.status})`);
  }

  const login = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ email, password }),
  });
  const session = (await login.json().catch(() => ({}))) as { access_token?: string };
  if (!login.ok || typeof session.access_token !== "string") {
    throw new Error(`could not sign in the disposable user (HTTP ${login.status})`);
  }
  return { id, token: session.access_token };
}

const document = {
  schemaVersion: 2,
  summary: "",
  brief: {
    topic: "Live stock check",
    audience: "Internal",
    goal: "Prove the stock and media routes",
    mode: "fiction",
    targetDurationSeconds: 30,
    tone: "Neutral",
    preset: "Story short",
    voicePreference: "neutral",
    planningBudgetUsd: 0,
  },
  scenes: [
    {
      id: "s1",
      heading: "Opening",
      body: "Hello",
      visualDirection: "",
      assetIds: [],
      onScreenText: "",
      durationSeconds: 10,
      approved: false,
      approvedFingerprint: null,
      locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
    },
  ],
};

async function main(): Promise<number> {
  const server = createStoryframeServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no loopback port assigned");
  const appUrl = `http://127.0.0.1:${address.port}`;

  async function api(
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${appUrl}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  async function serviceRows(query: string): Promise<Record<string, unknown>[]> {
    const response = await fetch(`${base}/rest/v1/${query}`, { headers: serviceHeaders });
    const rows = await response.json().catch(() => null);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  }

  const imageQuery = "rainy street";
  const videoQuery = "ocean waves";
  const cacheKeys = [
    stockCacheKey("pexels", "image", imageQuery, 1),
    stockCacheKey("pixabay", "image", imageQuery, 1),
  ];
  const cacheFilter = `cache_key=in.(${cacheKeys.join(",")})`;

  const user = await createUser();
  let projectId: string | null = null;
  let importedMediaId: string | null = null;
  try {
    check(
      "hosted stock search refuses an anonymous caller",
      (await api(null, "GET", `/api/stock/search?q=${encodeURIComponent(imageQuery)}&type=image&sources=pexels,pixabay`)).status === 401,
    );

    const created = await api(user.token, "POST", "/api/projects", {
      projectType: "story",
      title: "Stock route check",
      document,
    });
    projectId = typeof created.body?.project?.id === "string" ? created.body.project.id : null;
    check("disposable project is created", created.status === 201 && projectId !== null);

    const searchPath = `/api/stock/search?q=${encodeURIComponent(imageQuery)}&type=image&sources=pexels,pexels,pixabay`;
    const first = await api(user.token, "GET", searchPath);
    check("image search returns 200", first.status === 200);
    check(
      "image search merges both providers with normalized fields",
      Array.isArray(first.body?.results) &&
        first.body.results.length > 0 &&
        first.body.sources.length === 2 &&
        first.body.results.every(
          (result: any) =>
            typeof result.provider === "string" &&
            typeof result.providerId === "string" &&
            typeof result.attribution === "string" &&
            result.width > 0 &&
            result.height > 0 &&
            typeof result.sourcePage === "string",
        ),
    );
    check(
      "image search reports each provider once",
      Array.isArray(first.body?.providers) && first.body.providers.length === 2,
    );

    const cacheRows = await serviceRows(`stock_search_cache?select=cache_key,provider,status,payload_bytes,expires_at&${cacheFilter}`);
    check(
      "provider pages are cached in the shared table",
      cacheRows.length === 2 && cacheRows.every((row) => row.status === "ready" && Number(row.payload_bytes) > 0),
      `rows=${cacheRows.length}`,
    );
    const pixabayRow = cacheRows.find((row) => row.provider === "pixabay");
    check(
      "Pixabay cache window is at least 24 hours",
      pixabayRow !== undefined && Date.parse(String(pixabayRow.expires_at)) - Date.now() >= 86_400_000 - 120_000,
    );

    const second = await api(user.token, "GET", searchPath);
    check(
      "a repeated search is served from the durable cache",
      second.status === 200 &&
        Array.isArray(second.body?.providers) &&
        second.body.providers.every((provider: any) => provider.cached === true),
    );

    const video = await api(
      user.token,
      "GET",
      `/api/stock/search?q=${encodeURIComponent(videoQuery)}&type=video&sources=pexels,pixabay`,
    );
    check("video search returns 200", video.status === 200);
    check(
      "video search reports selected rendition dimensions",
      Array.isArray(video.body?.results) &&
        video.body.results.length > 0 &&
        video.body.results.every((result: any) => result.width > 0 && result.height > 0),
    );

    const mediaList = await api(user.token, "GET", `/api/projects/${projectId}/media`);
    check(
      "media list route reads the migrated provenance column",
      mediaList.status === 200 && Array.isArray(mediaList.body?.media) && mediaList.body.media.length === 0,
      `status=${mediaList.status} code=${mediaList.body?.error?.code ?? "none"}`,
    );

    if (!r2Configured) {
      console.log("SKIP  R2 is not configured; import, playback, and delete are not exercised.");
    } else {
      // Prefer a bounded web-format rendition so the check is about the import
      // path, not whether one provider's original happens to fit the image cap.
      const preferred = ["webformat", "medium", "small", "preview"];
      let result: any = null;
      let rendition: any = null;
      for (const candidate of first.body?.results ?? []) {
        for (const label of preferred) {
          const match = candidate.renditions?.find((entry: any) => entry.label === label);
          if (match) {
            result = candidate;
            rendition = match;
            break;
          }
        }
        if (result) break;
      }
      if (!result) {
        result = first.body?.results?.find((candidate: any) => candidate.renditions?.length > 0) ?? null;
        rendition =
          result?.renditions?.find((entry: any) => entry.label === result.selectedRendition) ??
          result?.renditions?.[0] ??
          null;
      }
      if (!result || !rendition) {
        check("a selected rendition is available to import", false);
      } else {
        const importRequest = {
          provider: result.provider,
          providerId: result.providerId,
          type: result.type,
          rendition: rendition.label,
          url: rendition.url,
          sourcePage: result.sourcePage,
          creator: result.creator,
          attribution: result.attribution,
          license: result.license,
        };
        const imported = await api(user.token, "POST", `/api/projects/${projectId}/stock/import`, importRequest);
        importedMediaId = typeof imported.body?.media?.id === "string" ? imported.body.media.id : null;
        check(
          "a selected stock image imports into the project",
          imported.status === 201 && imported.body?.media?.status === "ready" && importedMediaId !== null,
          `status=${imported.status} code=${imported.body?.error?.code ?? "none"}`,
        );
        check(
          "imported media carries validated provenance",
          imported.body?.provenance?.provider === result.provider &&
            imported.body?.provenance?.providerId === result.providerId &&
            typeof imported.body?.provenance?.downloadedAt === "string",
        );

        if (importedMediaId) {
          const repeat = await api(user.token, "POST", `/api/projects/${projectId}/stock/import`, importRequest);
          check(
            "a repeated import reuses the stored asset without a second copy",
            repeat.status === 200 &&
              repeat.body?.reused === true &&
              repeat.body?.media?.id === importedMediaId,
            `status=${repeat.status} code=${repeat.body?.error?.code ?? "none"}`,
          );

          const listed = await api(user.token, "GET", `/api/projects/${projectId}/media`);
          const stored = Array.isArray(listed.body?.media)
            ? listed.body.media.find((entry: any) => entry.id === importedMediaId)
            : null;
          check(
            "media list returns the imported provenance",
            stored?.provenance?.providerId === result.providerId && stored?.status === "ready",
          );

          const draft = {
            ...document,
            scenes: [{ ...document.scenes[0], assetIds: [importedMediaId] }],
          };
          const exported = await api(user.token, "POST", `/api/projects/${projectId}/export`, {
            title: "Live export check",
            document: draft,
          });
          const credit = exported.body?.export?.credits?.[0];
          const sceneAsset = exported.body?.export?.renderPayload?.scenes?.[0]?.assets?.[0];
          check(
            "the export carries the stored stock credit and render payload",
            exported.status === 200 &&
              exported.body?.export?.credits?.length === 1 &&
              credit?.mediaId === importedMediaId &&
              credit?.creator === result.creator &&
              credit?.provider === result.provider &&
              credit?.sourcePage === result.sourcePage &&
              credit?.license === result.license &&
              credit?.sceneIds?.length === 1 &&
              credit.sceneIds[0] === draft.scenes[0].id &&
              sceneAsset?.mediaId === importedMediaId,
            `status=${exported.status} code=${exported.body?.error?.code ?? "none"}`,
          );

          const playback = await api(user.token, "GET", `/api/projects/${projectId}/media/${importedMediaId}/url`);
          check(
            "imported media has a private playback URL",
            playback.status === 200 &&
              typeof playback.body?.url === "string" &&
              playback.body.url.includes("X-Amz-Signature=") &&
              String(playback.body?.contentType).startsWith("image/"),
          );

          const deleted = await api(user.token, "DELETE", `/api/projects/${projectId}/media/${importedMediaId}`);
          check("imported media deletes with its object", deleted.status === 200);
          importedMediaId = null;

          const afterDelete = await api(user.token, "GET", `/api/projects/${projectId}/media`);
          // Deleted rows stay visible as `deleted` until retention removes them.
          check(
            "deleted media is no longer ready or playable",
            afterDelete.status === 200 &&
              Array.isArray(afterDelete.body?.media) &&
              afterDelete.body.media.length === 1 &&
              afterDelete.body.media[0].status === "deleted",
          );
        }
      }
    }
  } finally {
    if (projectId) {
      const deletedProject = await api(user.token, "DELETE", `/api/projects/${projectId}`);
      console.log(`cleanup project delete -> ${deletedProject.status}`);
      check("cleanup removes the project", deletedProject.status === 200);
    }

    const deleteCache = await fetch(`${base}/rest/v1/stock_search_cache?${cacheFilter}`, {
      method: "DELETE",
      headers: serviceHeaders,
    });
    console.log(`cleanup cache delete -> ${deleteCache.status}`);
    check(
      "cleanup removes this run's cache rows",
      (await serviceRows(`stock_search_cache?select=cache_key&${cacheFilter}`)).length === 0,
    );

    const deletedUser = await fetch(`${base}/auth/v1/admin/users/${user.id}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
    console.log(`cleanup user delete -> ${deletedUser.status}`);
    check("cleanup removes the disposable user", deletedUser.status === 200);
    check(
      "cleanup leaves no project rows",
      (await serviceRows(`projects?select=id&owner_id=eq.${user.id}`)).length === 0,
    );

    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
