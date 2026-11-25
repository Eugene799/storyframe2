import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createStoryframeServer } from "../server/app";
import { createSupabaseUsageLedger } from "../server/usage-ledger";

/**
 * Provider-free live verification. Creates two disposable Supabase users,
 * exercises profile, project, and child routes against the real hosted schema,
 * proves owner isolation and the ledger completion predicate, then deletes the
 * users and their rows. It never calls Ollama and spends no billable tokens.
 */
try {
  loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // .env is optional when the variables already exist in the environment.
}

const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishableKey =
  process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;

if (!base || !serviceRoleKey || !publishableKey) {
  console.error(
    "verify:live-routes requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY.",
  );
  process.exit(1);
}

// Bind the checked values so the narrowing survives into the async helpers.
const verifiedBase: string = base;
const verifiedServiceRoleKey: string = serviceRoleKey;

const adminHeaders = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};
const authHeaders = { apikey: publishableKey, "Content-Type": "application/json" };
const serviceHeaders = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
};

interface TestUser {
  id: string;
  token: string;
}

type ApiResult = { status: number; body: any };

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

async function createUser(label: string): Promise<TestUser> {
  const email = `storyframe-routes-${label}-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
  const password = `R${randomUUID()}a1!`;

  const created = await fetch(`${base}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const createdBody = await created.json().catch(() => ({}));
  const id = createdBody.id ?? createdBody.user?.id;
  if (!created.ok || typeof id !== "string") {
    throw new Error(`could not create disposable user ${label} (HTTP ${created.status})`);
  }

  const login = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ email, password }),
  });
  const session = await login.json().catch(() => ({}));
  if (!login.ok || typeof session.access_token !== "string") {
    throw new Error(`could not sign in disposable user ${label} (HTTP ${login.status})`);
  }

  return { id, token: session.access_token };
}

async function deleteUser(id: string): Promise<number> {
  const response = await fetch(`${base}/auth/v1/admin/users/${id}`, {
    method: "DELETE",
    headers: adminHeaders,
  });
  console.log(`cleanup user delete -> ${response.status}`);
  return response.status;
}

async function serviceRows(path: string): Promise<unknown[]> {
  const response = await fetch(`${base}${path}`, { headers: serviceHeaders });
  const rows = await response.json().catch(() => null);
  return Array.isArray(rows) ? rows : [];
}

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
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResult> {
    const response = await fetch(`${appUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => null);
    return { status: response.status, body: parsed };
  }

  const users: TestUser[] = [];
  try {
    const readinessResponse = await fetch(`${appUrl}/api/ai/status`);
    const readiness = (await readinessResponse.json().catch(() => null)) as
      | { ledger?: { ready?: boolean } }
      | null;
    check(
      "hosted ai_usage ledger is ready after the migrations",
      readinessResponse.status === 200 && readiness?.ledger?.ready === true,
    );

    const a = await createUser("a");
    users.push(a);
    const b = await createUser("b");
    users.push(b);

    const unauthorized = await fetch(`${appUrl}/api/profile`);
    check("unauthenticated profile is refused", unauthorized.status === 401);

    let result = await api(a.token, "GET", "/api/profile");
    check("A starts without a profile", result.status === 404);
    result = await api(a.token, "PUT", "/api/profile", {
      workspaceName: "A workspace",
      settings: { theme: "dark" },
    });
    check(
      "A saves a profile",
      result.status === 200 && result.body?.profile?.workspaceName === "A workspace",
    );
    result = await api(b.token, "PUT", "/api/profile", { workspaceName: "B workspace" });
    check("B saves a separate profile", result.status === 200);
    result = await api(a.token, "GET", "/api/profile");
    check("A profile survives B write", result.body?.profile?.workspaceName === "A workspace");

    const document = {
      schemaVersion: 2,
      summary: "",
      brief: {
        topic: "Live route check",
        audience: "Internal",
        goal: "Prove the project routes",
        mode: "fiction",
        targetDurationSeconds: 60,
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
    result = await api(a.token, "POST", "/api/projects", {
      projectType: "story",
      title: "A project",
      document,
    });
    const projectId = result.body?.project?.id;
    check("A creates a project", result.status === 201 && typeof projectId === "string");

    check(
      "B cannot read A project",
      (await api(b.token, "GET", `/api/projects/${projectId}`)).status === 404,
    );
    check(
      "B cannot update A project",
      (
        await api(b.token, "PUT", `/api/projects/${projectId}`, {
          title: "stolen",
          document,
          version: 1,
        })
      ).status === 404,
    );
    check(
      "B cannot delete A project",
      (await api(b.token, "DELETE", `/api/projects/${projectId}`)).status === 404,
    );

    result = await api(a.token, "PUT", `/api/projects/${projectId}`, {
      title: "A project v2",
      document,
      version: 1,
    });
    check(
      "A updates own project to version 2",
      result.status === 200 && result.body?.project?.version === 2,
    );
    check(
      "stale project version is refused",
      (
        await api(a.token, "PUT", `/api/projects/${projectId}`, {
          title: "stale",
          document,
          version: 1,
        })
      ).status === 409,
    );

    result = await api(a.token, "PUT", `/api/projects/${projectId}/scenes`, {
      scenes: [
        { key: "s1", heading: "Opening", body: "Hello" },
        { key: "s2", heading: "Close", body: "Bye" },
      ],
    });
    check("A replaces scenes", result.status === 200 && result.body?.scenes?.length === 2);
    check(
      "B cannot read A scenes",
      (await api(b.token, "GET", `/api/projects/${projectId}/scenes`)).status === 404,
    );

    const bProjectResult = await api(b.token, "POST", "/api/projects", {
      projectType: "story",
      title: "B project",
      document,
    });
    const bProjectId = bProjectResult.body?.project?.id;
    check("B creates a project", bProjectResult.status === 201);

    const bSourceResult = await api(b.token, "POST", `/api/projects/${bProjectId}/sources`, {
      kind: "web",
      title: "B source",
      url: "https://example.com/b",
    });
    const bSourceId = bSourceResult.body?.source?.id;
    check("B creates a source", bSourceResult.status === 201);

    const aSourceResult = await api(a.token, "POST", `/api/projects/${projectId}/sources`, {
      kind: "web",
      title: "A source",
      url: "https://example.com/a",
    });
    const aSourceId = aSourceResult.body?.source?.id;
    check("A creates a source", aSourceResult.status === 201);

    result = await api(a.token, "POST", `/api/projects/${projectId}/claims`, {
      statement: "Cross-owner link",
      sourceId: bSourceId,
    });
    check(
      "A cannot attach B source to A claim",
      result.status === 400 && result.body?.error?.code === "SOURCE_NOT_FOUND",
    );

    result = await api(a.token, "POST", `/api/projects/${projectId}/claims`, {
      statement: "A claim",
      sourceId: aSourceId,
    });
    const claimId = result.body?.claim?.id;
    check("A creates a claim with own source", result.status === 201);
    check(
      "B cannot read A claims",
      (await api(b.token, "GET", `/api/projects/${projectId}/claims`)).status === 404,
    );
    check(
      "B cannot update A claim",
      (
        await api(b.token, "PATCH", `/api/projects/${projectId}/claims/${claimId}`, {
          status: "supported",
        })
      ).status === 404,
    );

    result = await api(a.token, "POST", `/api/projects/${projectId}/proposals`, {
      modelId: "gemma",
      prompt: "Proposal",
      proposal: { text: "Draft" },
    });
    const proposalId = result.body?.proposal?.id;
    check("A creates a proposal", result.status === 201);
    check(
      "B cannot update A proposal",
      (
        await api(b.token, "PATCH", `/api/projects/${projectId}/proposals/${proposalId}`, {
          status: "accepted",
        })
      ).status === 404,
    );

    result = await api(a.token, "POST", `/api/projects/${projectId}/jobs`, {
      provider: "internal",
      request: { test: true },
    });
    const jobId = result.body?.job?.id;
    check("A creates a job", result.status === 201);
    check(
      "B cannot update A job",
      (
        await api(b.token, "PATCH", `/api/projects/${projectId}/jobs/${jobId}`, {
          status: "running",
        })
      ).status === 404,
    );

    check(
      "A can pin a render to revision 2",
      (
        await api(a.token, "POST", `/api/projects/${projectId}/renders`, {
          projectRevision: 2,
          status: "pending",
        })
      ).status === 201,
    );
    check(
      "unknown revision is refused",
      (
        await api(a.token, "POST", `/api/projects/${projectId}/renders`, {
          projectRevision: 99,
          status: "pending",
        })
      ).status === 409,
    );

    check(
      "B cannot delete A source",
      (await api(b.token, "DELETE", `/api/projects/${projectId}/sources/${aSourceId}`))
        .status === 404,
    );
    check(
      "A can delete own source",
      (await api(a.token, "DELETE", `/api/projects/${projectId}/sources/${aSourceId}`))
        .status === 200,
    );

    check(
      "A can delete own project",
      (await api(a.token, "DELETE", `/api/projects/${projectId}`)).status === 200,
    );
    check(
      "A project is gone",
      (await api(a.token, "GET", `/api/projects/${projectId}`)).status === 404,
    );
    check(
      "B project is untouched",
      (await api(b.token, "GET", `/api/projects/${bProjectId}`)).status === 200,
    );

    const statusAttemptId = randomUUID();
    const statusKey = `routes-status-${randomUUID()}`;
    const insertStatus = await fetch(`${base}/rest/v1/ai_usage`, {
      method: "POST",
      headers: { ...adminHeaders, Prefer: "return=representation" },
      body: JSON.stringify({
        id: statusAttemptId,
        user_id: b.id,
        project_id: bProjectId,
        model_id: "gemma",
        configured_model: "gemma4:31b",
        latency_ms: 0,
        status: "pending",
        idempotency_key: statusKey,
        request_hash: "routes-status-hash",
        created_at: new Date().toISOString(),
      }),
    });
    check("seed B pending planning attempt", insertStatus.status === 201);

    const bPlanningStatus = await api(
      b.token,
      "GET",
      `/api/projects/${bProjectId}/planning/status`,
    );
    check(
      "B planning status reports its live attempt",
      bPlanningStatus.status === 200 &&
        bPlanningStatus.body?.inFlight === true &&
        bPlanningStatus.body?.idempotencyKey === statusKey &&
        typeof bPlanningStatus.body?.startedAt === "string" &&
        typeof bPlanningStatus.body?.abandonAfterMs === "number" &&
        bPlanningStatus.body.abandonAfterMs > 0,
    );
    check(
      "A cannot preflight B project",
      (await api(a.token, "GET", `/api/projects/${bProjectId}/planning/status`)).status === 404,
    );

    const settleStatus = await fetch(
      `${base}/rest/v1/ai_usage?id=eq.${statusAttemptId}&status=eq.pending`,
      {
        method: "PATCH",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({
          status: "success",
          latency_ms: 1,
          response_status: 200,
          response_body: { ok: true },
        }),
      },
    );
    check("settle B planning attempt", settleStatus.status === 200);
    const settledPlanningStatus = await api(
      b.token,
      "GET",
      `/api/projects/${bProjectId}/planning/status`,
    );
    check(
      "B planning status clears after settlement",
      settledPlanningStatus.status === 200 &&
        settledPlanningStatus.body?.inFlight === false &&
        settledPlanningStatus.body?.idempotencyKey === null,
    );

    const pendingId = randomUUID();
    const insertPending = await fetch(`${base}/rest/v1/ai_usage`, {
      method: "POST",
      headers: { ...adminHeaders, Prefer: "return=representation" },
      body: JSON.stringify({
        id: pendingId,
        user_id: a.id,
        model_id: "gemma",
        configured_model: "gemma4:31b",
        latency_ms: 0,
        status: "pending",
        idempotency_key: `routes-pending-${randomUUID()}`,
        request_hash: "routes-request-hash",
        created_at: new Date().toISOString(),
      }),
    });
    check("seed A pending ledger row", insertPending.status === 201);

    const ledger = createSupabaseUsageLedger({
      url: verifiedBase,
      serviceRoleKey: verifiedServiceRoleKey,
      timeoutMs: 5_000,
    });
    const completion = {
      status: "success" as const,
      returnedModel: "gemma4:31b",
      promptEvalCount: 1,
      evalCount: 1,
      latencyMs: 1,
      responseStatus: 200,
      responseBody: { ok: true },
    };

    check(
      "B cannot settle A reservation",
      (await ledger.complete(b.id, pendingId, completion)) === false,
    );
    const readPendingStatus = async (): Promise<string | undefined> => {
      const rows = await serviceRows(
        `/rest/v1/ai_usage?id=eq.${pendingId}&select=status`,
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      return typeof row?.status === "string" ? row.status : undefined;
    };
    check("A reservation stays pending after B attempt", (await readPendingStatus()) === "pending");
    check("A can settle own reservation", (await ledger.complete(a.id, pendingId, completion)) === true);
    check("A reservation is recorded as success", (await readPendingStatus()) === "success");

    const bLedgerId = randomUUID();
    const insertB = await fetch(`${base}/rest/v1/ai_usage`, {
      method: "POST",
      headers: { ...adminHeaders, Prefer: "return=representation" },
      body: JSON.stringify({
        id: bLedgerId,
        user_id: b.id,
        model_id: "gemma",
        configured_model: "gemma4:31b",
        returned_model: "gemma4:31b",
        prompt_eval_count: 1,
        eval_count: 1,
        latency_ms: 1,
        status: "success",
        idempotency_key: `routes-completed-${randomUUID()}`,
        request_hash: "routes-request-hash",
        response_body: { ok: true },
        response_status: 200,
      }),
    });
    check("seed B completed ledger row", insertB.status === 201);

    const aUsage = await api(a.token, "GET", "/api/ai/usage");
    const bUsage = await api(b.token, "GET", "/api/ai/usage");
    const usageIds = (usage: ApiResult): string[] =>
      Array.isArray(usage.body?.usage)
        ? usage.body.usage.map((row: { id: string }) => row.id)
        : [];
    check(
      "A usage contains only A rows",
      aUsage.status === 200 &&
        usageIds(aUsage).includes(pendingId) &&
        !usageIds(aUsage).includes(bLedgerId),
    );
    check(
      "B usage contains only B rows",
      bUsage.status === 200 &&
        usageIds(bUsage).includes(bLedgerId) &&
        !usageIds(bUsage).includes(pendingId),
    );

    for (const user of users.splice(0)) {
      const status = await deleteUser(user.id);
      check("disposable user deleted", status >= 200 && status < 300, `HTTP ${status}`);
    }

    for (const [label, path] of [
      ["ledger", `/rest/v1/ai_usage?select=id&user_id=eq.${a.id}`],
      ["profiles", `/rest/v1/profiles?select=owner_id&owner_id=eq.${a.id}`],
      ["projects", `/rest/v1/projects?select=id&owner_id=eq.${a.id}`],
      ["B projects", `/rest/v1/projects?select=id&owner_id=eq.${b.id}`],
    ] as const) {
      check(`cleanup removed ${label}`, (await serviceRows(path)).length === 0);
    }
  } finally {
    for (const user of users.splice(0)) {
      await deleteUser(user.id);
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return failed === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error: unknown) {
  console.error(
    `verify:live-routes failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
}
