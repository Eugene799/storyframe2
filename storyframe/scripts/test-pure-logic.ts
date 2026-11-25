import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dimensionsForAspectRatio,
  effectiveSceneDuration,
} from "../shared/render-contract";
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
import {
  DEFAULT_DISCOVERY_PREFERENCES,
  computeIdeaSimilarity,
} from "../shared/discovery-contract";
import { createSanitizedTemplateFromProject } from "../shared/studio-ops-contract";
import { documentFixture, sceneFixture } from "../tests/project-fixture";
import { buildSimulatedMp4Bytes } from "../server/json2video";

test("Phase 9: dimensionsForAspectRatio and effectiveSceneDuration handle standard and narration-extended scenes", () => {
  assert.deepEqual(dimensionsForAspectRatio("9:16"), { width: 1080, height: 1920 });
  assert.deepEqual(dimensionsForAspectRatio("1:1"), { width: 1080, height: 1080 });
  assert.deepEqual(dimensionsForAspectRatio("16:9"), { width: 1920, height: 1080 });

  const scene = sceneFixture({ durationSeconds: 8 });
  assert.equal(effectiveSceneDuration(scene, undefined), 8);
  assert.equal(
    effectiveSceneDuration(scene, {
      id: "track-1",
      kind: "narration",
      source: "deepgram",
      status: "active",
      mediaId: "media-1",
      voiceModel: "aura-2-thalia-en",
      voiceName: "Thalia",
      scriptFingerprint: "fp",
      scriptCharacters: 120,
      durationSeconds: 11.2,
      volume: 1,
      muted: false,
      costUsd: 0.0018,
      costRateVersion: "v1",
      createdAt: "2026-11-24T00:00:00.000Z",
    }),
    12,
  );
});

test("Phase 9: buildSimulatedMp4Bytes generates valid ISO-BMFF ftypisom header", () => {
  const bytes = buildSimulatedMp4Bytes({
    id: "rnd-123",
    projectId: "proj-123",
    durationSeconds: 15,
  });
  assert.ok(bytes.byteLength >= 36);
  const ftyp = Buffer.from(bytes.slice(4, 12)).toString("ascii");
  assert.equal(ftyp, "ftypisom");
});

test("Phase 11: findProhibitedWordingHits catches deceptive or unsubstantiated ad claims", () => {
  const clean = findProhibitedWordingHits(
    "Precision-machined aluminum body with 24-hour battery life.",
    ["unapproved superlative"],
  );
  assert.deepEqual(clean, []);

  const flagged = findProhibitedWordingHits(
    "Guaranteed results and a 100% cure with instant magic!",
    ["instant magic"],
  );
  assert.ok(flagged.includes("guaranteed results"));
  assert.ok(flagged.includes("100% cure"));
  assert.ok(flagged.includes("instant magic"));
});

test("Phase 12: clip-relative subtitle cues start at 00:00:00,000 and format valid SRT/VTT", () => {
  const segments = [
    {
      id: "seg-1",
      speaker: "Speaker 1",
      startSeconds: 30,
      endSeconds: 36,
      originalText: "First raw segment",
      correctedText: "First corrected segment",
    },
    {
      id: "seg-2",
      speaker: "Speaker 2",
      startSeconds: 36,
      endSeconds: 45,
      originalText: "Second raw segment",
      correctedText: "Second corrected segment",
    },
  ];

  const cues = buildClipRelativeCues(segments, 32, 42);
  assert.equal(cues.length, 2);
  assert.equal(cues[0]?.clipStartSeconds, 0);
  assert.equal(cues[0]?.clipEndSeconds, 4);
  assert.equal(cues[0]?.text, "First corrected segment");
  assert.equal(cues[1]?.clipStartSeconds, 4);
  assert.equal(cues[1]?.clipEndSeconds, 10);

  const srt = renderCuesToSrt(cues);
  assert.ok(srt.includes("00:00:00,000 --> 00:00:04,000"));
  assert.ok(srt.includes("First corrected segment"));

  const vtt = renderCuesToVtt(cues);
  assert.ok(vtt.startsWith("WEBVTT"));
  assert.ok(vtt.includes("00:00:00.000 --> 00:00:04.000"));
  assert.equal(formatSrtTimestamp(0), "00:00:00,000");
  assert.equal(formatVttTimestamp(0), "00:00:00.000");
});

test("Phase 14 & 15: provider rate card and subscription plans match contract specifications", () => {
  assert.equal(DEFAULT_RATE_CARD_VERSION, "2026-11-v1");
  const providers = new Set(DEFAULT_PROVIDER_RATE_CARD.map((e) => e.provider));
  assert.ok(providers.has("ollama"));
  assert.ok(providers.has("cloudflare"));
  assert.ok(providers.has("leonardo"));
  assert.ok(providers.has("deepgram-tts"));
  assert.ok(providers.has("deepgram-stt"));
  assert.ok(providers.has("json2video"));
  assert.ok(providers.has("r2"));

  assert.equal(SUBSCRIPTION_PLANS.length, 3);
  assert.equal(findSubscriptionPlan("creator").monthlyPriceUsd, 29);
  assert.equal(findSubscriptionPlan("pro").monthlyPriceUsd, 79);
  assert.equal(findSubscriptionPlan("studio").monthlyPriceUsd, 199);
});

test("Phase D3 & D4: computeIdeaSimilarity detects duplicate topics and default preferences are bounded", () => {
  assert.equal(DEFAULT_DISCOVERY_PREFERENCES.preferredShortDurationSeconds, 45);
  const sim = computeIdeaSimilarity(
    {
      title: "5 Hidden PostgreSQL Indexing Mistakes Slowing Down Your App",
      hook: "Why your database queries stall under load",
    },
    {
      title: "PostgreSQL Indexing Mistakes That Slow Down Your App",
      hook: "Database queries stalling under heavy load",
    },
  );
  assert.ok(sim > 0.5);
});

test("Phase 13 & 21: projectContentFingerprint is deterministic and createSanitizedTemplateFromProject strips private assetIds", () => {
  const doc = documentFixture();
  doc.scenes[0] = {
    ...doc.scenes[0]!,
    assetIds: ["11111111-1111-4111-8111-111111111111"],
    approved: true,
    approvedFingerprint: "fp-old",
  };

  const fp1 = projectContentFingerprint(doc.scenes);
  const fp2 = projectContentFingerprint(doc.scenes);
  assert.equal(fp1, fp2);

  const sanitized = createSanitizedTemplateFromProject(
    {
      id: "proj-1",
      projectType: "story",
      title: "Consensus Explainer",
      schemaVersion: 2,
      version: 1,
      document: doc,
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
    },
    "Consensus Template",
    "Engineering",
  );
  assert.equal(sanitized.sanitizedPrivateAssets, true);
  assert.deepEqual(sanitized.templateDocument.scenes[0]?.assetIds, []);
  assert.equal(sanitized.templateDocument.scenes[0]?.approved, false);
});
