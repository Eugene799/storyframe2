import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildClipRelativeCues,
  findProhibitedWordingHits,
  formatSrtTimestamp,
  formatVttTimestamp,
  projectContentFingerprint,
  renderCuesToSrt,
  renderCuesToVtt,
} from "../shared/workflows-contract";
import {
  DEFAULT_PROVIDER_RATE_CARD,
  DEFAULT_RATE_CARD_VERSION,
  SUBSCRIPTION_PLANS,
  findSubscriptionPlan,
} from "../shared/billing-contract";
import { computeIdeaSimilarity } from "../shared/discovery-contract";
import { dimensionsForAspectRatio, effectiveSceneDuration } from "../shared/render-contract";
import { createSanitizedTemplateFromProject } from "../shared/studio-ops-contract";
import { defaultBriefFor } from "../shared/project-defaults";
import { documentFixture } from "./project-fixture";
import type { ProjectDocumentV2, ProjectRecord } from "../shared/project-contract";
import { buildSimulatedMp4Bytes } from "../server/json2video";
import { apiRequest, startTestServer, type TestApp } from "./server-helpers";

/** Minimal valid 1x1 PNG header + IEND so detectMediaType recognizes image/png. */
const VALID_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

const VALID_MP4_BYTES = buildSimulatedMp4Bytes({
  id: "seed-video",
  projectId: "seed-proj",
  durationSeconds: 30,
});

describe("Phases 9–22 & Discover Ideas (D1–D6)", () => {
  let app: TestApp | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  async function createTestProject(
    appUrl: string,
    projectType: "story" | "product-ad" | "repurpose" = "story",
    title = "Test Studio Project",
  ): Promise<ProjectRecord> {
    const res = await apiRequest(appUrl, "/api/projects", {
      method: "POST",
      body: JSON.stringify({
        projectType,
        title,
        document: documentFixture({
          brief: {
            ...defaultBriefFor(projectType),
            topic: "A courier on the midnight train",
            audience: "Creators",
            goal: "Explain the system",
            mode: "factual",
          },
        }),
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { project: ProjectRecord };
    return body.project;
  }

  async function uploadReadyMedia(
    testApp: TestApp,
    projectId: string,
    kind: "image" | "video",
  ): Promise<string> {
    const bytes = kind === "image" ? VALID_PNG_BYTES : VALID_MP4_BYTES;
    const contentType = kind === "image" ? "image/png" : "video/mp4";

    const presignRes = await apiRequest(testApp.url, `/api/projects/${projectId}/media`, {
      method: "POST",
      body: JSON.stringify({
        kind,
        contentType,
        byteSize: bytes.byteLength,
      }),
    });
    expect(presignRes.status).toBe(201);
    const presigned = (await presignRes.json()) as {
      media: { id: string };
      upload: { url: string; headers: Record<string, string> };
    };

    const putRes = await fetch(presigned.upload.url, {
      method: "PUT",
      headers: presigned.upload.headers,
      body: Buffer.from(bytes),
    });
    expect(putRes.status).toBe(200);

    const completeRes = await apiRequest(
      testApp.url,
      `/api/projects/${projectId}/media/${presigned.media.id}/complete`,
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(completeRes.status).toBe(200);
    return presigned.media.id;
  }

  async function attachAssetToAllScenes(
    testApp: TestApp,
    project: ProjectRecord,
    mediaId: string,
  ): Promise<ProjectRecord> {
    const doc: ProjectDocumentV2 = {
      ...project.document,
      scenes: project.document.scenes.map((scene) => ({
        ...scene,
        assetIds: [mediaId],
      })),
    };
    const res = await apiRequest(testApp.url, `/api/projects/${project.id}`, {
      method: "PUT",
      body: JSON.stringify({
        title: project.title,
        version: project.version,
        document: doc,
      }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { project: ProjectRecord }).project;
  }

  describe("Pure Domain Helpers (Phases 9–22 & D1–D6)", () => {
    it("computes aspect ratio dimensions and scene duration accurately", () => {
      expect(dimensionsForAspectRatio("16:9")).toEqual({ width: 1920, height: 1080 });
      expect(dimensionsForAspectRatio("9:16")).toEqual({ width: 1080, height: 1920 });
      expect(dimensionsForAspectRatio("1:1")).toEqual({ width: 1080, height: 1080 });

      const doc = documentFixture();
      expect(effectiveSceneDuration({ ...doc.scenes[0]!, durationSeconds: 8 }, undefined)).toBe(8);
    });

    it("formats SRT and VTT timestamps and converts clip cues relative to 00:00:00,000", () => {
      expect(formatSrtTimestamp(0)).toBe("00:00:00,000");
      expect(formatSrtTimestamp(65.432)).toBe("00:01:05,432");
      expect(formatVttTimestamp(65.432)).toBe("00:01:05.432");

      const cues = buildClipRelativeCues(
        [
          {
            id: "seg-1",
            speaker: "Host",
            startSeconds: 10,
            endSeconds: 15,
            originalText: "Welcome back.",
            correctedText: "Welcome back everyone.",
          },
          {
            id: "seg-2",
            speaker: "Guest",
            startSeconds: 15,
            endSeconds: 22,
            originalText: "Great to be here.",
            correctedText: "Great to be here!",
          },
        ],
        12,
        20,
      );

      expect(cues).toHaveLength(2);
      expect(cues[0]?.clipStartSeconds).toBe(0);
      expect(cues[0]?.clipEndSeconds).toBe(3);
      expect(cues[0]?.text).toBe("Welcome back everyone.");
      expect(cues[1]?.clipStartSeconds).toBe(3);
      expect(cues[1]?.clipEndSeconds).toBe(8);

      const srt = renderCuesToSrt(cues);
      expect(srt).toContain("00:00:00,000 --> 00:00:03,000");
      const vtt = renderCuesToVtt(cues);
      expect(vtt).toContain("WEBVTT");
      expect(vtt).toContain("00:00:00.000 --> 00:00:03.000");
    });

    it("flags prohibited ad claim wording and computes idea similarity", () => {
      const hits = findProhibitedWordingHits(
        "Our serum offers guaranteed results and a 100% cure for aging.",
        ["miracle elixir"],
      );
      expect(hits).toContain("guaranteed results");
      expect(hits).toContain("100% cure");

      const simHigh = computeIdeaSimilarity(
        {
          title: "Why PostgreSQL indexes fail under heavy write loads",
          hook: "Database write amplification explained",
        },
        {
          title: "PostgreSQL index performance under heavy write loads",
          hook: "Why database write amplification slows indexes",
        },
      );
      const simLow = computeIdeaSimilarity(
        {
          title: "Why PostgreSQL indexes fail under heavy write loads",
          hook: "Database write amplification explained",
        },
        {
          title: "Sourdough bread baking starter hydration guide",
          hook: "Crispy crust fermentation tips",
        },
      );
      expect(simHigh).toBeGreaterThan(0.45);
      expect(simLow).toBeLessThan(0.2);
    });

    it("produces valid ISO-BMFF MP4 container bytes and sanitizes project templates", () => {
      const mp4 = buildSimulatedMp4Bytes({ id: "r1", projectId: "p1", durationSeconds: 15 });
      expect(mp4.byteLength).toBeGreaterThan(32);
      const headerAscii = Buffer.from(mp4.slice(4, 12)).toString("ascii");
      expect(headerAscii).toBe("ftypisom");

      const doc = documentFixture();
      const fp = projectContentFingerprint(doc.scenes);
      expect(fp.length).toBeGreaterThan(10);

      const tpl = createSanitizedTemplateFromProject(
        {
          id: "p1",
          projectType: "story",
          title: "Sample",
          schemaVersion: 2,
          version: 1,
          document: doc,
          createdAt: "2026-11-24T00:00:00.000Z",
          updatedAt: "2026-11-24T00:00:00.000Z",
        },
        "Clean Template",
        "Desc",
      );
      expect(tpl.sanitizedPrivateAssets).toBe(true);
      expect(tpl.templateDocument.scenes.every((s) => s.assetIds.length === 0)).toBe(true);
    });
  });

  describe("Phase 9: JSON2Video Composition Compiler & Render Pipeline", () => {
    it("compiles a project composition, submits an idempotent render job, polls completion, and stores MP4 in R2", async () => {
      app = await startTestServer();
      let project = await createTestProject(app.url, "story", "Phase 9 Render Story");
      const imageMediaId = await uploadReadyMedia(app, project.id, "image");
      project = await attachAssetToAllScenes(app, project, imageMediaId);

      // 1. Compile preview
      const compileRes = await apiRequest(app.url, `/api/projects/${project.id}/renders-v2/compile`, {
        method: "POST",
        body: JSON.stringify({ aspectRatio: "16:9", allowUnresolvedClaims: true }),
      });
      expect(compileRes.status).toBe(200);
      const compiled = (await compileRes.json()) as {
        snapshot: {
          fingerprint: string;
          width: number;
          height: number;
          canSubmit: boolean;
          movie: { scenes: Array<{ elements: Array<{ type: string; src?: string }> }> };
        };
      };
      expect(compiled.snapshot.width).toBe(1920);
      expect(compiled.snapshot.height).toBe(1080);
      expect(compiled.snapshot.canSubmit).toBe(true);
      expect(compiled.snapshot.movie.scenes[0]?.elements[0]?.type).toBe("image");
      expect(compiled.snapshot.movie.scenes[0]?.elements[0]?.src).toContain("X-Amz-Signature");

      // 2. Submit render job with idempotency key
      const submitRes1 = await apiRequest(
        app.url,
        `/api/projects/${project.id}/renders-v2/submit`,
        {
          method: "POST",
          headers: { "Idempotency-Key": "render-idem-001" },
          body: JSON.stringify({ aspectRatio: "16:9", allowUnresolvedClaims: true }),
        },
      );
      expect(submitRes1.status).toBe(201);
      const body1 = (await submitRes1.json()) as {
        job: { id: string; status: string; outputMediaId: string | null };
        replayed: boolean;
      };
      expect(body1.replayed).toBe(false);

      // Replaying same idempotency key returns existing job without double-billing
      const submitRes2 = await apiRequest(
        app.url,
        `/api/projects/${project.id}/renders-v2/submit`,
        {
          method: "POST",
          headers: { "Idempotency-Key": "render-idem-001" },
          body: JSON.stringify({ aspectRatio: "16:9", allowUnresolvedClaims: true }),
        },
      );
      expect(submitRes2.status).toBe(200);
      const body2 = (await submitRes2.json()) as { job: { id: string }; replayed: boolean };
      expect(body2.replayed).toBe(true);
      expect(body2.job.id).toBe(body1.job.id);

      // 3. Poll job to completion and verify output MP4 is stored in private R2 media
      const pollRes = await apiRequest(
        app.url,
        `/api/projects/${project.id}/renders-v2/${body1.job.id}/poll`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      expect(pollRes.status).toBe(200);
      const polledBody = (await pollRes.json()) as {
        job: { id: string; status: string; outputMediaId: string | null; settledCostUsd: number | null };
      };
      expect(polledBody.job.status).toBe("ready");
      expect(polledBody.job.outputMediaId).toBeTruthy();
      expect(polledBody.job.settledCostUsd).toBeGreaterThan(0);
    });
  });

  describe("Phase 10: Complete Mode A — Stories and Explainers", () => {
    it("evaluates story readiness checklist, unsupported factual claims, and continuity notes", async () => {
      app = await startTestServer();
      let project = await createTestProject(app.url, "story", "Mode A Explainer");
      const imageId = await uploadReadyMedia(app, project.id, "image");
      project = await attachAssetToAllScenes(app, project, imageId);

      // Create an unverified factual claim
      const claimRes = await apiRequest(app.url, `/api/projects/${project.id}/claims`, {
        method: "POST",
        body: JSON.stringify({
          statement: "Global battery density doubled in five years.",
        }),
      });
      expect(claimRes.status).toBe(201);

      // Checklist should flag the unresolved claim
      const check1 = await apiRequest(app.url, `/api/projects/${project.id}/workflow/mode-a`);
      expect(check1.status).toBe(200);
      const readiness1 = ((await check1.json()) as {
        checklist: {
          readyToRender: boolean;
          unresolvedClaims: unknown[];
          missingAssets: Array<{ sceneId: string; missingVisual: boolean; missingNarration: boolean }>;
        };
      }).checklist;
      expect(readiness1.missingAssets[0]?.missingVisual).toBe(false);
      expect(readiness1.missingAssets[0]?.missingNarration).toBe(true);
      expect(readiness1.unresolvedClaims.length).toBe(1);
      expect(readiness1.readyToRender).toBe(false);

      // Save continuity notes
      const saveRes = await apiRequest(
        app.url,
        `/api/projects/${project.id}/workflow/mode-a/continuity`,
        {
          method: "PUT",
          body: JSON.stringify({
            characters: "Mira wears a cobalt coat.",
            setting: "Rain-soaked terminal station.",
            continuityRules: "Keep lantern in left hand.",
          }),
        },
      );
      expect(saveRes.status).toBe(200);
      const continuity = ((await saveRes.json()) as {
        continuity: { characters: string; setting: string };
      }).continuity;
      expect(continuity.characters).toContain("cobalt coat");
    });
  });

  describe("Phase 11: Complete Mode B — Product Ads", () => {
    it("enforces prohibited wording validation, links claims to 3 ad concepts, builds controlled variants, and exports traceable manifest", async () => {
      app = await startTestServer();
      const project = await createTestProject(app.url, "product-ad", "Mode B Coffee Grinder Ad");
      const fgMediaId = await uploadReadyMedia(app, project.id, "image");

      // Save product catalog with prohibited wording list and substantiated claim
      const prodRes = await apiRequest(
        app.url,
        `/api/projects/${project.id}/workflow/mode-b/product`,
        {
          method: "PUT",
          body: JSON.stringify({
            productName: "AeroGrind Pro",
            variantName: "Matte Obsidian",
            productAssetMediaIds: [fgMediaId],
            preserveOriginalProductAsset: true,
            prohibitedWording: ["miracle brew"],
            approvedClaims: [
              {
                id: "claim-1",
                statement: "Retains less than 0.1g of coffee grounds per 18g dose in lab testing.",
                evidenceNote: "Internal BrewLab report #2026-04",
                substantiated: true,
              },
            ],
          }),
        },
      );
      expect(prodRes.status).toBe(200);

      // Attempt campaign with prohibited wording -> must reject with 422
      const badCampRes = await apiRequest(
        app.url,
        `/api/projects/${project.id}/workflow/mode-b/campaign`,
        {
          method: "PUT",
          body: JSON.stringify({
            offerSummary: "Get guaranteed results with our miracle brew grinder!",
            ctaText: "Shop AeroGrind",
          }),
        },
      );
      expect(badCampRes.status).toBe(422);

      // Valid campaign succeeds
      const goodCampRes = await apiRequest(
        app.url,
        `/api/projects/${project.id}/workflow/mode-b/campaign`,
        {
          method: "PUT",
          body: JSON.stringify({
            audience: "Specialty coffee home baristas",
            offerSummary: "20% Launch Week Bundle",
            priceAmount: "$249",
            ctaText: "Order AeroGrind Pro",
            disclaimerText: "Offer valid while launch stock lasts.",
          }),
        },
      );
      expect(goodCampRes.status).toBe(200);

      // Generate 3 distinct ad concepts linked to approved claims
      const conceptsRes = await apiRequest(
        app.url,
        `/api/projects/${project.id}/workflow/mode-b/concepts`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      expect(conceptsRes.status).toBe(201);
      const concepts = ((await conceptsRes.json()) as {
        concepts: Array<{ id: string; linkedClaimIds: string[] }>;
      }).concepts;
      expect(concepts).toHaveLength(3);
      expect(concepts[0]?.linkedClaimIds).toContain("claim-1");

      // Create controlled variant
      const variantRes = await apiRequest(
        app.url,
        `/api/projects/${project.id}/workflow/mode-b/variants`,
        {
          method: "POST",
          body: JSON.stringify({
            conceptId: concepts[0]!.id,
            label: "9:16 Hero Variant A",
            hookText: "Zero retention. Pure espresso clarity.",
            ctaText: "Order AeroGrind Pro",
            layoutStyle: "product-hero",
            aspectRatio: "9:16",
          }),
        },
      );
      expect(variantRes.status).toBe(201);

      // Export traceable variant manifest
      const manifestRes = await apiRequest(
        app.url,
        `/api/projects/${project.id}/workflow/mode-b/manifest`,
      );
      expect(manifestRes.status).toBe(200);
      const manifest = ((await manifestRes.json()) as {
        manifest: {
          productName: string;
          variants: Array<{ productAssetMediaIds: string[]; linkedClaims: Array<{ id: string }> }>;
        };
      }).manifest;
      expect(manifest.productName).toBe("AeroGrind Pro (Matte Obsidian)");
      expect(manifest.variants).toHaveLength(1);
      expect(manifest.variants[0]?.productAssetMediaIds).toContain(fgMediaId);
      expect(manifest.variants[0]?.linkedClaims[0]?.id).toBe("claim-1");
    });
  });

  describe("Phase 12: Complete Mode C — Footage Repurposing", () => {
    it("ingests source video, transcribes with Deepgram STT ledger entry, edits subtitle text non-destructively, proposes clips, and runs bounded batch export with clip-relative SRT/VTT", async () => {
      app = await startTestServer();
      const project = await createTestProject(app.url, "repurpose", "Mode C Podcast Repurpose");
      const videoMediaId = await uploadReadyMedia(app, project.id, "video");

      // 12A Ingest
      const ingestRes = await apiRequest(
        app.url,
        `/api/projects/${project.id}/workflow/mode-c/ingest`,
        {
          method: "POST",
          body: JSON.stringify({
            sourceMediaId: videoMediaId,
            fileName: "founder-interview.mp4",
            contentType: "video/mp4",
            byteSize: VALID_MP4_BYTES.byteLength,
            durationSeconds: 180,
          }),
        },
      );
      expect(ingestRes.status).toBe(201);
      const ingest = ((await ingestRes.json()) as {
        ingest: { id: string; immutableOriginal: boolean; seekVerified: boolean };
      }).ingest;
      expect(ingest.immutableOriginal).toBe(true);
      expect(ingest.seekVerified).toBe(true);

      // 12B Transcribe (Deepgram STT nova-2-general)
      const transcribeRes = await apiRequest(
        app.url,
        `/api/projects/${project.id}/workflow/mode-c/transcribe`,
        {
          method: "POST",
          body: JSON.stringify({ ingestId: ingest.id }),
        },
      );
      expect(transcribeRes.status).toBe(201);
      const transcript = ((await transcribeRes.json()) as {
        transcript: {
          id: string;
          model: string;
          segments: Array<{ id: string; originalText: string; correctedText: string }>;
        };
      }).transcript;
      expect(transcript.model).toBe("nova-2-general");
      expect(transcript.segments.length).toBeGreaterThanOrEqual(3);

      // Edit subtitle segment without altering originalText or R2 source
      const seg0 = transcript.segments[0]!;
      const editSegRes = await apiRequest(
        app.url,
        `/api/projects/${project.id}/workflow/mode-c/transcript-segment`,
        {
          method: "PATCH",
          body: JSON.stringify({
            transcriptId: transcript.id,
            segmentId: seg0.id,
            correctedText: "Corrected subtitle opening line.",
          }),
        },
      );
      expect(editSegRes.status).toBe(200);
      const updatedTranscript = ((await editSegRes.json()) as {
        transcript: { segments: Array<{ id: string; originalText: string; correctedText: string }> };
      }).transcript;
      expect(updatedTranscript.segments[0]?.correctedText).toBe("Corrected subtitle opening line.");
      expect(updatedTranscript.segments[0]?.originalText).toBe(seg0.originalText);

      // 12C Propose clips
      const clipsRes = await apiRequest(
        app.url,
        `/api/projects/${project.id}/workflow/mode-c/propose-clips`,
        {
          method: "POST",
          body: JSON.stringify({ transcriptId: transcript.id }),
        },
      );
      expect(clipsRes.status).toBe(201);
      const clips = ((await clipsRes.json()) as {
        clips: Array<{ id: string; startSeconds: number; endSeconds: number }>;
      }).clips;
      expect(clips.length).toBeGreaterThanOrEqual(2);

      // 12D & 12E Batch export with clip-relative SRT/VTT and failure isolation
      const batchRes = await apiRequest(
        app.url,
        `/api/projects/${project.id}/workflow/mode-c/batch-export`,
        {
          method: "POST",
          body: JSON.stringify({
            clipIds: clips.map((c) => c.id),
          }),
        },
      );
      expect(batchRes.status).toBe(200);
      const manifest = ((await batchRes.json()) as {
        manifest: {
          clips: Array<{ status: string; srt: string; vtt: string }>;
        };
      }).manifest;
      expect(manifest.clips.length).toBe(clips.length);
      expect(manifest.clips[0]?.srt).toContain("00:00:00,000 -->");
      expect(manifest.clips[0]?.vtt).toContain("WEBVTT");
    });
  });

  describe("Phase 13: Scoped AI Editing & Recovery", () => {
    it("generates pre-mutation edit plans, enforces confirmation gate, applies scoped changes, and restores previous document non-destructively", async () => {
      app = await startTestServer();
      const project = await createTestProject(app.url, "story", "Phase 13 Scoped Edit");
      const firstSceneId = project.document.scenes[0]!.id;

      // Plan a hook rewrite on Scene 1
      const planRes = await apiRequest(
        app.url,
        `/api/projects/${project.id}/workflow/scoped-edits/plan`,
        {
          method: "POST",
          body: JSON.stringify({
            command: "rewrite-hook",
            targetSceneId: firstSceneId,
            instruction: "Rewrite opening hook with higher curiosity",
            replacementValue: "What if the midnight train never stopped at Platform 4?",
          }),
        },
      );
      expect(planRes.status).toBe(201);
      const plan = ((await planRes.json()) as {
        plan: {
          id: string;
          affectedComponents: string[];
          preservedComponents: string[];
          requiresConfirmation: boolean;
        };
      }).plan;
      expect(plan.affectedComponents.length).toBeGreaterThan(0);
      expect(plan.preservedComponents.length).toBeGreaterThan(0);

      // Apply without confirmation must reject with 422
      const unconfirmedApply = await apiRequest(
        app.url,
        `/api/projects/${project.id}/workflow/scoped-edits/${plan.id}/apply`,
        {
          method: "POST",
          body: JSON.stringify({ confirm: false }),
        },
      );
      expect(unconfirmedApply.status).toBe(422);

      // Apply with confirmation succeeds
      const goodApply = await apiRequest(
        app.url,
        `/api/projects/${project.id}/workflow/scoped-edits/${plan.id}/apply`,
        {
          method: "POST",
          body: JSON.stringify({ confirm: true }),
        },
      );
      expect(goodApply.status).toBe(200);
      const applied = (await goodApply.json()) as {
        plan: { status: string };
        project: ProjectRecord;
      };
      expect(applied.plan.status).toBe("applied");
      expect(applied.project.document.scenes[0]?.body).toContain("Platform 4");

      // Restore previous snapshot non-destructively
      const restoreRes = await apiRequest(
        app.url,
        `/api/projects/${project.id}/workflow/scoped-edits/${plan.id}/restore`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      expect(restoreRes.status).toBe(200);
      const restored = (await restoreRes.json()) as {
        plan: { status: string };
        project: ProjectRecord;
      };
      expect(restored.plan.status).toBe("restored");
      expect(restored.project.version).toBeGreaterThan(applied.project.version);
      expect(restored.project.document.scenes[0]?.body).not.toContain("Platform 4");
    });
  });

  describe("Phases 14 & 15: Cost Ledger, Rate Cards, Subscriptions, Max Charge Quote & HMAC Webhooks", () => {
    it("exposes 6-provider rate card, quotes max charge, enforces spending ceiling, and processes idempotent HMAC billing webhooks", async () => {
      const webhookSecret = "whsec_test_secret_123";
      app = await startTestServer({
        env: {
          BILLING_WEBHOOK_SECRET: webhookSecret,
        },
      });

      const stateRes = await apiRequest(app.url, "/api/studio/state");
      expect(stateRes.status).toBe(200);
      const state = (await stateRes.json()) as {
        rateCard: Array<{ provider: string; effectiveVersion: string }>;
        plans: Array<{ id: string; monthlyPriceUsd: number }>;
        entitlement: { planId: string; autoTopUpEnabled: boolean };
      };
      expect(state.rateCard[0]?.effectiveVersion).toBe(DEFAULT_RATE_CARD_VERSION);
      expect(state.plans.map((p) => p.monthlyPriceUsd)).toEqual([29, 79, 199]);

      // Quote known operation
      const knownQuoteRes = await apiRequest(app.url, "/api/studio/billing/quote", {
        method: "POST",
        body: JSON.stringify({
          operation: "json2video-render",
          provider: "json2video",
          modelOrTier: "v2-hd-30fps",
          units: 2,
        }),
      });
      expect(knownQuoteRes.status).toBe(200);
      const knownQuote = ((await knownQuoteRes.json()) as {
        quote: { estimatedChargeUsd: number; maximumChargeUsd: number; allowed: boolean };
      }).quote;
      expect(knownQuote.maximumChargeUsd).toBeGreaterThan(0);
      expect(knownQuote.allowed).toBe(true);

      // Enabling auto-top-up without positive ceiling must fail with 422
      const badSubRes = await apiRequest(app.url, "/api/studio/billing/plan", {
        method: "PUT",
        body: JSON.stringify({
          planId: "pro",
          billingInterval: "monthly",
          autoTopUpEnabled: true,
          spendingCeilingUsd: 0,
        }),
      });
      expect(badSubRes.status).toBe(422);

      // Valid HMAC billing webhook is processed once and deduplicated on replay
      const eventId = "evt_stripe_001";
      const eventType = "subscription.upgraded";
      const signature = createHmac("sha256", webhookSecret)
        .update(`${eventId}:${eventType}`)
        .digest("hex");

      const wh1 = await apiRequest(app.url, "/api/studio/billing/webhook", {
        method: "POST",
        body: JSON.stringify({
          eventId,
          eventType,
          planId: "studio",
          billingInterval: "annual",
          signature,
        }),
      });
      expect(wh1.status).toBe(200);
      const whBody1 = (await wh1.json()) as {
        replayed: boolean;
        entitlement: { planId: string; billingInterval: string };
      };
      expect(whBody1.replayed).toBe(false);
      expect(whBody1.entitlement.planId).toBe("studio");

      const wh2 = await apiRequest(app.url, "/api/studio/billing/webhook", {
        method: "POST",
        body: JSON.stringify({
          eventId,
          eventType,
          planId: "studio",
          billingInterval: "annual",
          signature,
        }),
      });
      expect(wh2.status).toBe(200);
      const whBody2 = (await wh2.json()) as { replayed: boolean };
      expect(whBody2.replayed).toBe(true);
    });
  });

  describe("Discover Ideas Add-on (Phases D1–D6)", () => {
    it("saves niche profile, ingests trend evidence, generates deduplicated short/long idea batches, replaces single card, records feedback, and creates a project without auto paid generation", async () => {
      app = await startTestServer();

      // D1: Update niche profile
      const prefRes = await apiRequest(app.url, "/api/discovery/preferences", {
        method: "PUT",
        body: JSON.stringify({
          primaryNiche: "Developer Productivity & AI Engineering",
          subniches: ["TypeScript Architecture", "Database Performance"],
          targetAudience: "Senior full-stack engineers",
          regionCode: "US",
          languageCode: "en",
          platforms: ["youtube-shorts", "youtube-long"],
          contentGoal: "authority-education",
          tone: "Analytical",
          preferredShortDurationSeconds: 45,
          preferredLongDurationSeconds: 240,
          topicsToAvoid: ["Crypto trading"],
        }),
      });
      expect(prefRes.status).toBe(200);

      // D2 & D3: Generate 6 short-form ideas
      const batchRes = await apiRequest(app.url, "/api/discovery/generate", {
        method: "POST",
        body: JSON.stringify({
          formatTrack: "short-form",
          refreshExternalEvidence: true,
        }),
      });
      expect(batchRes.status).toBe(201);
      const batchBody = (await batchRes.json()) as {
        batchId: string;
        ideas: Array<{ id: string; title: string; matchExplanation: string[]; status: string }>;
      };
      const activeShortIdeas = batchBody.ideas.filter((i) => i.status === "active");
      expect(activeShortIdeas.length).toBeGreaterThanOrEqual(6);
      expect(activeShortIdeas[0]?.matchExplanation.length).toBeGreaterThan(0);

      // D4: Replace a single idea card
      const firstCardId = activeShortIdeas[0]!.id;
      const replaceRes = await apiRequest(
        app.url,
        `/api/discovery/ideas/${firstCardId}/feedback`,
        {
          method: "POST",
          body: JSON.stringify({
            action: "replace",
            reason: "too-similar",
          }),
        },
      );
      expect(replaceRes.status).toBe(200);
      const replaceBody = (await replaceRes.json()) as {
        replacementIdea: { id: string; title: string } | null;
      };
      expect(replaceBody.replacementIdea).toBeTruthy();
      expect(replaceBody.replacementIdea!.id).not.toBe(firstCardId);

      // D4: Save replacement card
      const saveCardRes = await apiRequest(
        app.url,
        `/api/discovery/ideas/${replaceBody.replacementIdea!.id}/feedback`,
        {
          method: "POST",
          body: JSON.stringify({
            action: "save",
            reason: "more-like-this",
          }),
        },
      );
      expect(saveCardRes.status).toBe(200);

      // D5: Preview and then turn idea into project without automatic paid generation
      const createProjRes = await apiRequest(
        app.url,
        `/api/discovery/ideas/${replaceBody.replacementIdea!.id}/create-project`,
        {
          method: "POST",
          body: JSON.stringify({
            previewOnly: false,
            title: "Custom Handoff Project Title",
            projectType: "story",
            aspectRatio: "9:16",
          }),
        },
      );
      expect(createProjRes.status).toBe(201);
      const createdBody = (await createProjRes.json()) as {
        draft: { noAutoPaidGenerationDisclosure: string };
        project: { id: string; title: string };
      };
      expect(createdBody.draft.noAutoPaidGenerationDisclosure).toContain("never triggered automatically");
      expect(createdBody.project.title).toBe("Custom Handoff Project Title");
    });
  });

  describe("Phases 16–22: Backups, Teams, Brands, Formats, Launch Audit, Chapters, Multilingual, Publish, API Keys & DR Drills", () => {
    it("exports and validates backup bundle, manages team seats/approvals, validates format safe zones, runs DR drills, issues API keys, and approves launch audit", async () => {
      app = await startTestServer();
      const project = await createTestProject(app.url, "story", "Phase 16-22 Full Ops");

      // 16A Backup export & import validation
      const exportRes = await apiRequest(app.url, `/api/projects/${project.id}/studio/backup`);
      expect(exportRes.status).toBe(200);
      const bundle = ((await exportRes.json()) as { bundle: Record<string, unknown> }).bundle;
      expect(bundle.bundleFormat).toBe("storyframe-backup-v1");

      // Tampered checksum is rejected with 422
      const badImport = await apiRequest(app.url, "/api/studio/backup/import", {
        method: "POST",
        body: JSON.stringify({
          bundle: {
            ...bundle,
            bundleChecksum: "0000000000000000000000000000000000000000000000000000000000000000",
          },
        }),
      });
      expect(badImport.status).toBe(422);

      // Valid bundle imports cleanly
      const goodImport = await apiRequest(app.url, "/api/studio/backup/import", {
        method: "POST",
        body: JSON.stringify({ bundle }),
      });
      expect(goodImport.status).toBe(201);

      // 16B Team invite (Switch to Creator 1-seat plan first to test seat limit enforcement)
      await apiRequest(app.url, "/api/studio/billing/plan", {
        method: "PUT",
        body: JSON.stringify({
          planId: "creator",
          billingInterval: "monthly",
        }),
      });
      const inviteDenied = await apiRequest(app.url, "/api/studio/team/invite", {
        method: "POST",
        body: JSON.stringify({ email: "editor@example.com", role: "editor" }),
      });
      expect(inviteDenied.status).toBe(422);

      // Upgrade to Pro (3 seats) and invite succeeds
      await apiRequest(app.url, "/api/studio/billing/plan", {
        method: "PUT",
        body: JSON.stringify({
          planId: "pro",
          billingInterval: "monthly",
        }),
      });
      const inviteOk = await apiRequest(app.url, "/api/studio/team/invite", {
        method: "POST",
        body: JSON.stringify({ email: "editor@example.com", role: "editor" }),
      });
      expect(inviteOk.status).toBe(201);

      // 16D Format variants (9:16, 1:1, 16:9)
      const formatRes = await apiRequest(app.url, `/api/projects/${project.id}/studio/formats`, {
        method: "PUT",
        body: JSON.stringify({ aspectRatio: "9:16", reviewed: true }),
      });
      expect(formatRes.status).toBe(200);
      const format = ((await formatRes.json()) as {
        format: { aspectRatio: string; reviewed: boolean; allScenesValid: boolean };
      }).format;
      expect(format.aspectRatio).toBe("9:16");
      expect(format.reviewed).toBe(true);
      expect(format.allScenesValid).toBe(true);

      // Phase 18 Long-form chapter plan & outline approval
      const chaptersRes = await apiRequest(app.url, `/api/projects/${project.id}/studio/chapters`, {
        method: "POST",
        body: JSON.stringify({ targetTotalSeconds: 240 }),
      });
      expect(chaptersRes.status).toBe(201);
      const chapters = ((await chaptersRes.json()) as {
        chapters: Array<{ id: string; status: string }>;
      }).chapters;
      expect(chapters.length).toBeGreaterThanOrEqual(3);

      const approveChapter = await apiRequest(
        app.url,
        `/api/projects/${project.id}/studio/chapters/${chapters[0]!.id}/approve`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      expect(approveChapter.status).toBe(200);

      // Phase 19 Multilingual version
      const locRes = await apiRequest(
        app.url,
        `/api/projects/${project.id}/studio/localizations`,
        {
          method: "POST",
          body: JSON.stringify({ languageCode: "es", languageLabel: "Spanish" }),
        },
      );
      expect(locRes.status).toBe(201);
      const localization = ((await locRes.json()) as {
        localization: { preserveOriginalClaims: boolean; translatedScenes: unknown[] };
      }).localization;
      expect(localization.preserveOriginalClaims).toBe(true);
      expect(localization.translatedScenes.length).toBeGreaterThan(0);

      // Phase 20 Publishing gate requires humanConfirmed=true
      const pubUnconfirmed = await apiRequest(
        app.url,
        `/api/projects/${project.id}/studio/publish`,
        {
          method: "POST",
          body: JSON.stringify({
            platform: "youtube",
            accountHandle: "@storyframe",
            renderJobId: "render-1",
            title: "Launch Video",
            description: "Desc",
            tags: ["ai"],
            visibility: "unlisted",
            scheduledFor: null,
            humanConfirmed: false,
          }),
        },
      );
      expect(pubUnconfirmed.status).toBe(422);

      const pubConfirmed = await apiRequest(
        app.url,
        `/api/projects/${project.id}/studio/publish`,
        {
          method: "POST",
          body: JSON.stringify({
            platform: "youtube",
            accountHandle: "@storyframe",
            renderJobId: "render-1",
            title: "Launch Video",
            description: "Desc",
            tags: ["ai"],
            visibility: "unlisted",
            scheduledFor: null,
            humanConfirmed: true,
          }),
        },
      );
      expect(pubConfirmed.status).toBe(201);

      // Phase 21 Public API key & sanitized project template
      const keyRes = await apiRequest(app.url, "/api/studio/api-keys", {
        method: "POST",
        body: JSON.stringify({
          label: "CI Pipeline Key",
          scopes: ["projects:read", "renders:write"],
        }),
      });
      expect(keyRes.status).toBe(201);
      const keyBody = (await keyRes.json()) as {
        plainTextKeyOnce: string;
        credential: { id: string };
      };
      expect(keyBody.plainTextKeyOnce.startsWith("sf_live_")).toBe(true);

      const tplRes = await apiRequest(
        app.url,
        `/api/projects/${project.id}/studio/save-template`,
        {
          method: "POST",
          body: JSON.stringify({
            name: "Clean Reusable Story Template",
            description: "Explainer",
          }),
        },
      );
      expect(tplRes.status).toBe(201);
      const tpl = ((await tplRes.json()) as {
        template: { sanitizedPrivateAssets: boolean };
      }).template;
      expect(tpl.sanitizedPrivateAssets).toBe(true);

      // Phase 22 DR drill & Load test
      const drillRes = await apiRequest(app.url, "/api/studio/dr/drill", {
        method: "POST",
        body: JSON.stringify({ scenario: "provider-outage" }),
      });
      expect(drillRes.status).toBe(201);
      const drill = ((await drillRes.json()) as { drill: { verified: boolean } }).drill;
      expect(drill.verified).toBe(true);

      const loadRes = await apiRequest(app.url, "/api/studio/dr/load-test", {
        method: "POST",
        body: JSON.stringify({ concurrentUsers: 25 }),
      });
      expect(loadRes.status).toBe(200);

      // Phase 17 Launch audit approval
      const auditRes = await apiRequest(app.url, "/api/studio/launch-audit/approve", {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(auditRes.status).toBe(200);
      const audit = ((await auditRes.json()) as {
        launchAudit: { releaseApproved: boolean };
      }).launchAudit;
      expect(audit.releaseApproved).toBe(true);
    });
  });
});
