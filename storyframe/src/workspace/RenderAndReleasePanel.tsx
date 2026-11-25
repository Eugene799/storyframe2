import { useEffect, useState } from "react";
import type { ProjectAspectRatio, ProjectRecord } from "../../shared/project-contract";
import type { CompiledRenderSnapshot, RenderJobRecord } from "../../shared/render-contract";
import type {
  FingerprintApprovalRecord,
  ProjectChapterRecord,
  ProjectCommentRecord,
  ProjectFormatLayoutRecord,
  ProjectLocalizationRecord,
  PublishingJobRecord,
  PublishingPlatform,
} from "../../shared/studio-ops-contract";
import type { ModeAReadinessChecklist } from "../../shared/workflows-contract";
import {
  addProjectApproval,
  addProjectComment,
  approveProjectChapter,
  compileProjectRender,
  createProjectLocalization,
  exportProjectBackup,
  generateProjectChapters,
  getModeAReadiness,
  getProjectStudioOverview,
  listRenderJobs,
  newIdempotencyKey,
  pollProjectRenderJob,
  publishProjectRender,
  saveModeAContinuity,
  saveProjectTemplate,
  submitProjectRender,
  updateProjectFormatReview,
} from "../api";

interface RenderAndReleasePanelProps {
  project: ProjectRecord;
  getAccessToken: () => Promise<string>;
}

export function RenderAndReleasePanel({
  project,
  getAccessToken,
}: RenderAndReleasePanelProps) {
  const [aspectRatio, setAspectRatio] = useState<ProjectAspectRatio>("9:16");
  const [allowUnresolvedClaims, setAllowUnresolvedClaims] = useState(false);
  const [checklist, setChecklist] = useState<ModeAReadinessChecklist | null>(null);
  const [snapshot, setSnapshot] = useState<CompiledRenderSnapshot | null>(null);
  const [jobs, setJobs] = useState<RenderJobRecord[]>([]);
  const [formats, setFormats] = useState<ProjectFormatLayoutRecord[]>([]);
  const [chapters, setChapters] = useState<ProjectChapterRecord[]>([]);
  const [localizations, setLocalizations] = useState<ProjectLocalizationRecord[]>([]);
  const [publishingJobs, setPublishingJobs] = useState<PublishingJobRecord[]>([]);
  const [comments, setComments] = useState<ProjectCommentRecord[]>([]);
  const [approvals, setApprovals] = useState<FingerprintApprovalRecord[]>([]);

  const [characters, setCharacters] = useState("");
  const [setting, setSetting] = useState("");
  const [continuityRules, setContinuityRules] = useState("");

  const [targetLanguage, setTargetLanguage] = useState("es");
  const [publishPlatform, setPublishPlatform] = useState<PublishingPlatform>("youtube");
  const [publishAccount, setPublishAccount] = useState("@storyframe.studio");
  const [publishVisibility, setPublishVisibility] = useState<"private" | "unlisted" | "public">("unlisted");
  const [publishConfirmed, setPublishConfirmed] = useState(false);

  const [commentBody, setCommentBody] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadAll();
  }, [project.id, project.version]);

  async function loadAll() {
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const [modeA, renderList, studioOverview, compiled] = await Promise.all([
        getModeAReadiness(token, project.id),
        listRenderJobs(token, project.id),
        getProjectStudioOverview(token, project.id),
        compileProjectRender(token, project.id, { aspectRatio, allowUnresolvedClaims }),
      ]);
      setChecklist(modeA);
      if (modeA.continuityNotes) {
        setCharacters(modeA.continuityNotes.characters);
        setSetting(modeA.continuityNotes.setting);
        setContinuityRules(modeA.continuityNotes.continuityRules);
      }
      setJobs(renderList);
      setFormats(studioOverview.formats);
      setChapters(studioOverview.chapters);
      setLocalizations(studioOverview.localizations);
      setPublishingJobs(studioOverview.publishingJobs);
      setComments(studioOverview.comments);
      setApprovals(studioOverview.approvals);
      setSnapshot(compiled);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not load render readiness.");
    }
  }

  async function handleRecompile(nextRatio = aspectRatio, nextAllow = allowUnresolvedClaims) {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const compiled = await compileProjectRender(token, project.id, {
        aspectRatio: nextRatio,
        allowUnresolvedClaims: nextAllow,
      });
      setSnapshot(compiled);
      setStatusMessage(`Compiled JSON2Video v2 movie (${compiled.width}x${compiled.height}, ${compiled.totalDurationSeconds}s).`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Compile failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmitRender() {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const { job, replayed } = await submitProjectRender(
        token,
        project.id,
        { aspectRatio, allowUnresolvedClaims },
        newIdempotencyKey(),
      );
      setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
      setStatusMessage(
        replayed
          ? `Replayed existing render job ${job.id}.`
          : `Submitted JSON2Video render job ${job.id} (provider ID: ${job.providerJobId}).`,
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Render submission failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handlePollJob(jobId: string) {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const updated = await pollProjectRenderJob(token, project.id, jobId);
      setJobs((prev) => prev.map((j) => (j.id === updated.id ? updated : j)));
      setStatusMessage(
        updated.status === "ready"
          ? `Render ${updated.id} completed and copied to private R2 storage (${updated.byteSize} bytes).`
          : `Render ${updated.id} status: ${updated.status}.`,
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Poll failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveContinuity() {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      await saveModeAContinuity(token, project.id, {
        characters,
        setting,
        continuityRules,
      });
      setStatusMessage("Saved Mode A fiction continuity notes.");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not save continuity notes.");
    } finally {
      setBusy(false);
    }
  }

  async function handleReviewFormat(ratio: ProjectAspectRatio, reviewed: boolean) {
    setBusy(true);
    try {
      const token = await getAccessToken();
      const updated = await updateProjectFormatReview(token, project.id, ratio, reviewed);
      setFormats((prev) => prev.map((f) => (f.aspectRatio === ratio ? updated : f)));
      setStatusMessage(`Marked format ${ratio} as ${reviewed ? "reviewed" : "unreviewed"}.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Format update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerateChapters() {
    setBusy(true);
    try {
      const token = await getAccessToken();
      const created = await generateProjectChapters(token, project.id, 240);
      setChapters(created);
      setStatusMessage("Generated 4-chapter long-form outline (4:00 total).");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Chapter outline failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleApproveChapter(chapterId: string) {
    setBusy(true);
    try {
      const token = await getAccessToken();
      const updated = await approveProjectChapter(token, project.id, chapterId);
      setChapters((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setStatusMessage(`Approved and generated ${updated.title}.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Chapter generation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateLocalization() {
    setBusy(true);
    try {
      const token = await getAccessToken();
      const labels: Record<string, string> = {
        es: "Spanish (ES)",
        fr: "French (FR)",
        de: "German (DE)",
        ja: "Japanese (JA)",
      };
      const loc = await createProjectLocalization(token, project.id, {
        languageCode: targetLanguage,
        languageLabel: labels[targetLanguage] ?? targetLanguage,
      });
      setLocalizations((prev) => [loc, ...prev]);
      setStatusMessage(`Created ${loc.languageLabel} multilingual variant with timing proposals.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Localization failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handlePublish() {
    const readyJob = jobs.find((j) => j.status === "ready") ?? jobs[0];
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const pub = await publishProjectRender(token, project.id, {
        renderJobId: readyJob?.id ?? "rnd-latest",
        platform: publishPlatform,
        accountHandle: publishAccount,
        title: project.title,
        description: project.document.summary,
        tags: ["storyframe", project.projectType],
        visibility: publishVisibility,
        scheduledFor: null,
        humanConfirmed: publishConfirmed,
      });
      setPublishingJobs((prev) => [pub, ...prev]);
      setStatusMessage(`Published "${pub.title}" to ${pub.platform} (${pub.accountHandle}).`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Publish failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDownloadBackup() {
    setBusy(true);
    try {
      const token = await getAccessToken();
      const bundle = await exportProjectBackup(token, project.id);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-backup.json`;
      a.click();
      URL.revokeObjectURL(url);
      setStatusMessage(`Exported verified backup bundle (checksum ${bundle.bundleChecksum.slice(0, 12)}…).`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Backup export failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveTemplate() {
    setBusy(true);
    try {
      const token = await getAccessToken();
      const tpl = await saveProjectTemplate(token, project.id, {
        name: templateName || `${project.title} Template`,
        description: `Sanitized reusable ${project.projectType} template`,
      });
      setTemplateName("");
      setStatusMessage(`Saved sanitized reusable template "${tpl.name}" (all private media IDs stripped).`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Template save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddCommentAndApproval() {
    if (!commentBody.trim()) return;
    setBusy(true);
    try {
      const token = await getAccessToken();
      const [cmt, appr] = await Promise.all([
        addProjectComment(token, project.id, { body: commentBody }),
        addProjectApproval(token, project.id, {
          status: "approved",
          note: commentBody,
        }),
      ]);
      setComments((prev) => [cmt, ...prev]);
      setApprovals((prev) => [appr, ...prev]);
      setCommentBody("");
      setStatusMessage(`Recorded review comment & content-fingerprint approval (${appr.contentFingerprint.slice(0, 16)}…).`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not record comment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" data-testid="render-release-panel">
      <div className="panel-header">
        <div>
          <h3>JSON2Video Rendering, Formats & Release</h3>
          <p className="muted">
            Phase 9 JSON2Video v2 compiler, Phase 10 Mode A readiness checklist, Phase 16 multi-format reframing & backups, Phase 18 chapters, Phase 19 multilingual versions, and Phase 20 publishing.
          </p>
        </div>
        <div className="button-row">
          <button type="button" onClick={handleDownloadBackup} disabled={busy}>
            Export Backup Bundle
          </button>
        </div>
      </div>

      {statusMessage && (
        <p className="status-banner" role="status">
          {statusMessage}
        </p>
      )}
      {errorMessage && (
        <div className="alert" role="alert">
          <strong>RENDER_WORKFLOW_ERROR</strong>
          <p>{errorMessage}</p>
        </div>
      )}

      {/* Phase 10: Mode A Readiness Checklist */}
      {checklist && (
        <section className="scene-card">
          <h4>Mode A Pre-Render Readiness & Claim Gate</h4>
          <p className="muted">{checklist.factCheckDisclosure}</p>
          <dl className="metrics">
            <div>
              <dt>Mode</dt>
              <dd>{checklist.mode}</dd>
            </div>
            <div>
              <dt>Planned Duration</dt>
              <dd>{checklist.totalDurationSeconds}s</dd>
            </div>
            <div>
              <dt>Measured Narration</dt>
              <dd>{checklist.measuredNarrationSeconds}s</dd>
            </div>
            <div>
              <dt>Estimated Render Cost</dt>
              <dd>${checklist.estimatedRenderCostUsd.toFixed(4)}</dd>
            </div>
            <div>
              <dt>Locked Scenes</dt>
              <dd>{checklist.lockedScenesCount}</dd>
            </div>
            <div>
              <dt>Unresolved Claims</dt>
              <dd>{checklist.unresolvedClaims.length}</dd>
            </div>
          </dl>

          {checklist.missingAssets.length > 0 && (
            <div className="notice">
              <strong>Missing Scene Assets Checklist:</strong>
              <ul>
                {checklist.missingAssets.map((item) => (
                  <li key={item.sceneId}>
                    {item.heading}:{" "}
                    {item.missingVisual ? "Missing visual asset " : ""}
                    {item.missingNarration ? "(No active voiceover track)" : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {project.document.brief.mode === "fiction" && (
            <div className="field-grid" style={{ marginTop: "0.75rem" }}>
              <label>
                <span>Fiction Characters Continuity</span>
                <input
                  aria-label="Fiction Characters Continuity"
                  value={characters}
                  onChange={(e) => setCharacters(e.target.value)}
                  placeholder="Protagonist wardrobe, voice traits..."
                />
              </label>
              <label>
                <span>Fiction Setting Continuity</span>
                <input
                  aria-label="Fiction Setting Continuity"
                  value={setting}
                  onChange={(e) => setSetting(e.target.value)}
                  placeholder="Time of day, lighting palette..."
                />
              </label>
              <label>
                <span>Continuity Rules</span>
                <input
                  aria-label="Continuity Rules"
                  value={continuityRules}
                  onChange={(e) => setContinuityRules(e.target.value)}
                  placeholder="Keep train window on left side of frame..."
                />
              </label>
              <div className="button-row">
                <button type="button" onClick={handleSaveContinuity} disabled={busy}>
                  Save Continuity Notes
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Phase 9: JSON2Video Compiler & Durable Jobs */}
      <section className="scene-card" style={{ marginTop: "1rem" }}>
        <h4>Phase 9: JSON2Video v2 Composition Compiler</h4>
        <div className="field-grid">
          <label>
            <span>Render Aspect Ratio</span>
            <select
              aria-label="Render Aspect Ratio"
              value={aspectRatio}
              onChange={(e) => {
                const next = e.target.value as ProjectAspectRatio;
                setAspectRatio(next);
                void handleRecompile(next, allowUnresolvedClaims);
              }}
            >
              <option value="9:16">9:16 Vertical (1080×1920)</option>
              <option value="1:1">1:1 Square (1080×1080)</option>
              <option value="16:9">16:9 Horizontal (1920×1080)</option>
            </select>
          </label>
          <label className="lock-toggle">
            <input
              type="checkbox"
              checked={allowUnresolvedClaims}
              onChange={(e) => {
                setAllowUnresolvedClaims(e.target.checked);
                void handleRecompile(aspectRatio, e.target.checked);
              }}
            />
            <span>Acknowledge unverified factual claims for draft render</span>
          </label>
        </div>

        {snapshot && (
          <div style={{ marginTop: "0.75rem" }}>
            <p className="muted">
              Snapshot Fingerprint: <code>{snapshot.fingerprint}</code> · Resolution:{" "}
              <code>
                {snapshot.width}×{snapshot.height} @ 30fps
              </code>{" "}
              · Estimated Charge: <strong>${snapshot.estimatedCostUsd.toFixed(4)}</strong>
            </p>
            {snapshot.issues.length > 0 && (
              <ul>
                {snapshot.issues.map((issue, idx) => (
                  <li key={`${issue.code}-${idx}`}>
                    <strong>[{issue.severity.toUpperCase()}] {issue.code}:</strong> {issue.message}
                  </li>
                ))}
              </ul>
            )}
            <div className="button-row" style={{ marginTop: "0.75rem" }}>
              <button
                type="button"
                onClick={() => handleRecompile()}
                disabled={busy}
              >
                Validate Composition
              </button>
              <button
                type="button"
                className="primary"
                onClick={handleSubmitRender}
                disabled={busy || !snapshot.canSubmit}
              >
                Submit JSON2Video Render
              </button>
            </div>
          </div>
        )}

        {jobs.length > 0 && (
          <div style={{ marginTop: "1rem" }}>
            <h5>Render Jobs ({jobs.length})</h5>
            <ul className="revision-list">
              {jobs.map((job) => (
                <li key={job.id} className="revision-item">
                  <div>
                    <strong>{job.id}</strong> ({job.aspectRatio}) · Status:{" "}
                    <span className="badge">{job.status}</span> · Provider ID:{" "}
                    <code>{job.providerJobId}</code>
                    {job.outputMediaId && (
                      <span>
                        {" "}
                        · Stored R2 MP4: <code>{job.outputMediaId}</code> ({job.byteSize} bytes)
                      </span>
                    )}
                  </div>
                  <div className="button-row">
                    {job.status !== "ready" && (
                      <button
                        type="button"
                        onClick={() => handlePollJob(job.id)}
                        disabled={busy}
                      >
                        Poll & Reconcile R2 Output
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Phase 16D: Multi-Format Reframing & Validation */}
      <section className="scene-card" style={{ marginTop: "1rem" }}>
        <h4>Phase 16D: Multi-Format Layouts (9:16, 1:1, 16:9)</h4>
        <div className="project-grid">
          {formats.map((fmt) => (
            <div key={fmt.id} className="project-card">
              <h5>
                {fmt.aspectRatio} ({fmt.width}×{fmt.height})
              </h5>
              <p className="muted">
                Status: {fmt.reviewed ? "Reviewed & Approved" : "Needs Format Review"} · Safe Zones:{" "}
                {fmt.allScenesValid ? "All Valid" : "Warnings Present"}
              </p>
              <button
                type="button"
                onClick={() => handleReviewFormat(fmt.aspectRatio, !fmt.reviewed)}
                disabled={busy}
              >
                {fmt.reviewed ? `Unmark ${fmt.aspectRatio}` : `Approve ${fmt.aspectRatio} Reframe`}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Phase 18 & 19: Long-Form Chapters & Multilingual Variants */}
      <section className="scene-card" style={{ marginTop: "1rem" }}>
        <h4>Phase 18: Long-Form Chapter Production (3–5 Minutes)</h4>
        <div className="button-row">
          <button type="button" onClick={handleGenerateChapters} disabled={busy}>
            Generate 4-Chapter Outline
          </button>
        </div>
        {chapters.length > 0 && (
          <ul className="revision-list" style={{ marginTop: "0.75rem" }}>
            {chapters.map((chap) => (
              <li key={chap.id} className="revision-item">
                <div>
                  <strong>{chap.title}</strong> ({chap.targetDurationSeconds}s) — {chap.summary}
                  <div className="muted">
                    Status: <code>{chap.status}</code> · Continuity: {chap.continuityCarryover}
                  </div>
                </div>
                {chap.status !== "completed" && (
                  <button
                    type="button"
                    onClick={() => handleApproveChapter(chap.id)}
                    disabled={busy}
                  >
                    Approve & Generate Chapter {chap.chapterIndex}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="scene-card" style={{ marginTop: "1rem" }}>
        <h4>Phase 19: Multilingual Versions & Duration Proposals</h4>
        <div className="field-grid">
          <label>
            <span>Target Language</span>
            <select
              aria-label="Target Language"
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
            >
              <option value="es">Spanish (ES)</option>
              <option value="fr">French (FR)</option>
              <option value="de">German (DE)</option>
              <option value="ja">Japanese (JA)</option>
            </select>
          </label>
          <div className="button-row">
            <button type="button" onClick={handleCreateLocalization} disabled={busy}>
              Create Multilingual Variant
            </button>
          </div>
        </div>
        {localizations.map((loc) => (
          <div key={loc.id} className="notice" style={{ marginTop: "0.75rem" }}>
            <strong>
              {loc.languageLabel} (Base v{loc.baseVersion})
            </strong>{" "}
            — Preserves original claims & sources.
            <ul>
              {loc.translatedScenes.map((ts) => (
                <li key={ts.sceneId}>
                  {ts.translatedBody} (Original {ts.originalDurationSeconds}s → Measured{" "}
                  {ts.measuredTranslationDurationSeconds}s, Δ +
                  {ts.proposedDurationAdjustmentSeconds}s)
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {/* Phase 16B, 20 & 21B: Team Approvals, Publishing & Sanitized Templates */}
      <section className="scene-card" style={{ marginTop: "1rem" }}>
        <h4>Phase 20: Publishing Confirmation & Analytics</h4>
        <div className="field-grid">
          <label>
            <span>Platform</span>
            <select
              aria-label="Publishing Platform"
              value={publishPlatform}
              onChange={(e) => setPublishPlatform(e.target.value as PublishingPlatform)}
            >
              <option value="youtube">YouTube</option>
              <option value="tiktok">TikTok</option>
              <option value="instagram">Instagram</option>
              <option value="linkedin">LinkedIn</option>
            </select>
          </label>
          <label>
            <span>Target Account</span>
            <input
              aria-label="Target Account"
              value={publishAccount}
              onChange={(e) => setPublishAccount(e.target.value)}
            />
          </label>
          <label>
            <span>Visibility</span>
            <select
              aria-label="Publish Visibility"
              value={publishVisibility}
              onChange={(e) =>
                setPublishVisibility(e.target.value as "private" | "unlisted" | "public")
              }
            >
              <option value="private">Private</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>
          </label>
          <label className="lock-toggle">
            <input
              type="checkbox"
              checked={publishConfirmed}
              onChange={(e) => setPublishConfirmed(e.target.checked)}
            />
            <span>Confirm account, render version, metadata, and visibility</span>
          </label>
        </div>
        <div className="button-row" style={{ marginTop: "0.5rem" }}>
          <button type="button" onClick={handlePublish} disabled={busy}>
            Publish Confirmed Render
          </button>
        </div>
        {publishingJobs.map((pub) => (
          <div key={pub.id} className="notice" style={{ marginTop: "0.5rem" }}>
            <strong>
              {pub.platform.toUpperCase()} ({pub.accountHandle})
            </strong>{" "}
            — Status: <code>{pub.status}</code> · Visibility: {pub.visibility}
            {pub.analytics && (
              <span>
                {" "}
                · Views: {pub.analytics.views.toLocaleString()} · Likes: {pub.analytics.likes} ·
                Watch Time: {pub.analytics.watchTimeMinutes}m
              </span>
            )}
          </div>
        ))}
      </section>

      <section className="scene-card" style={{ marginTop: "1rem" }}>
        <h4>Phase 16B & 21B: Fingerprint Review Approvals & Reusable Template</h4>
        <div className="field-grid">
          <label>
            <span>Review Comment & Content-Fingerprint Approval</span>
            <input
              aria-label="Review Comment"
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              placeholder="Verified visual pacing and claim citations..."
            />
          </label>
          <div className="button-row">
            <button type="button" onClick={handleAddCommentAndApproval} disabled={busy}>
              Approve Current Content Fingerprint
            </button>
          </div>
        </div>
        {approvals.length > 0 && (
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            Latest Approval: {approvals[0].approverEmail} ({approvals[0].status}) on fingerprint{" "}
            <code>{approvals[0].contentFingerprint.slice(0, 18)}…</code> ({comments.length} comment(s))
          </p>
        )}
        <div className="field-grid" style={{ marginTop: "0.75rem" }}>
          <label>
            <span>Sanitized Template Name</span>
            <input
              aria-label="Sanitized Template Name"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder={`${project.title} Reusable Template`}
            />
          </label>
          <div className="button-row">
            <button type="button" onClick={handleSaveTemplate} disabled={busy}>
              Save as Sanitized Template
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
