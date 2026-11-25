import { useEffect, useState } from "react";
import type {
  DiscoveryIdeaRecord,
  DiscoveryPreferencesRecord,
  IdeaFeedbackReason,
  IdeaFormatTrack,
  IdeaProjectDraftPreview,
  TrendEvidenceIngestionResult,
} from "../../shared/discovery-contract";
import type { ProjectRecord } from "../../shared/project-contract";
import {
  createProjectFromDiscoveryIdea,
  generateDiscoveryIdeas,
  getDiscoveryState,
  saveDiscoveryPreferences,
  sendDiscoveryIdeaFeedback,
} from "../api";

interface DiscoverPanelProps {
  getAccessToken: () => Promise<string>;
  onProjectCreated: (project: ProjectRecord) => void;
}

export function DiscoverPanel({ getAccessToken, onProjectCreated }: DiscoverPanelProps) {
  const [activeTrack, setActiveTrack] = useState<"short-form" | "long-form" | "saved">(
    "short-form",
  );
  const [preferences, setPreferences] = useState<DiscoveryPreferencesRecord | null>(null);
  const [evidenceResult, setEvidenceResult] = useState<TrendEvidenceIngestionResult | null>(null);
  const [ideas, setIdeas] = useState<DiscoveryIdeaRecord[]>([]);
  const [draftPreview, setDraftPreview] = useState<IdeaProjectDraftPreview | null>(null);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [customPromptText, setCustomPromptText] = useState("");

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadDiscovery();
  }, []);

  async function loadDiscovery() {
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const state = await getDiscoveryState(token);
      setPreferences(state.preferences);
      setEvidenceResult(state.evidenceResult);
      setIdeas(state.ideas);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not load Discover Ideas.");
    }
  }

  async function handleSavePreferences() {
    if (!preferences) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const saved = await saveDiscoveryPreferences(token, preferences);
      setPreferences(saved);
      setStatusMessage("Saved niche profile and discovery preferences.");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to save preferences.");
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerateBatch(refreshExternalEvidence: boolean) {
    const track: IdeaFormatTrack = activeTrack === "long-form" ? "long-form" : "short-form";
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const res = await generateDiscoveryIdeas(token, {
        formatTrack: track,
        refreshExternalEvidence,
      });
      setEvidenceResult(res.evidenceResult);
      setIdeas(res.ideas);
      setStatusMessage(
        refreshExternalEvidence
          ? `Refreshed external trend data and synthesized 6 new ${track} ideas.`
          : `Synthesized 6 new ${track} ideas from cached trend evidence.`,
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Idea generation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCardFeedback(
    ideaId: string,
    action: "save" | "dismiss" | "replace" | "feedback" | "edit-prompt",
    reason?: IdeaFeedbackReason,
    customPromptNote?: string,
  ) {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const res = await sendDiscoveryIdeaFeedback(token, ideaId, {
        action,
        reason,
        customPromptNote,
      });
      setIdeas(res.ideas);
      setEditingPromptId(null);
      setCustomPromptText("");
      setStatusMessage(
        res.replacementIdea
          ? `Recorded feedback (${reason ?? action}) and replaced card with "${res.replacementIdea.title}".`
          : `Updated idea card "${res.updatedIdea.title}".`,
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Feedback action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handlePreviewProjectHandoff(ideaId: string) {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const res = await createProjectFromDiscoveryIdea(token, ideaId, {
        previewOnly: true,
      });
      setDraftPreview(res.draft);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not preview project draft.");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmCreateProject() {
    if (!draftPreview) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const res = await createProjectFromDiscoveryIdea(token, draftPreview.ideaId, {
        previewOnly: false,
        title: draftPreview.title,
        projectType: draftPreview.projectType,
        mode: draftPreview.mode,
        targetDurationSeconds: draftPreview.targetDurationSeconds,
        aspectRatio: draftPreview.aspectRatio,
      });
      if (res.project) {
        onProjectCreated(res.project);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not create project from idea.");
    } finally {
      setBusy(false);
    }
  }

  const displayedIdeas = ideas.filter((idea) => {
    if (activeTrack === "saved") return idea.status === "saved" || idea.status === "used";
    return idea.formatTrack === activeTrack && idea.status !== "dismissed";
  });

  return (
    <section className="panel" data-testid="discover-ideas-panel">
      <div className="panel-header">
        <div>
          <h2>Discover Ideas (Phases D1–D6)</h2>
          <p className="muted">
            Evidence-grounded short-form and long-form video concepts tailored to your niche profile, distinguishing cumulative popularity from measured growth velocity.
          </p>
        </div>
        <div className="button-row">
          <button
            type="button"
            onClick={() => handleGenerateBatch(false)}
            disabled={busy}
          >
            New Ideas (Cached Evidence)
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => handleGenerateBatch(true)}
            disabled={busy}
          >
            Update Trend Data & Generate
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
          <strong>DISCOVERY_ERROR</strong>
          <p>{errorMessage}</p>
        </div>
      )}

      {/* Phase D1: Niche Profile & Discovery Preferences */}
      {preferences && (
        <div className="scene-card" style={{ marginBottom: "1rem" }}>
          <h3>Niche Profile & Personalization Controls</h3>
          <div className="field-grid">
            <label>
              <span>Primary Niche</span>
              <input
                aria-label="Primary Niche"
                value={preferences.primaryNiche}
                onChange={(e) =>
                  setPreferences({ ...preferences, primaryNiche: e.target.value })
                }
              />
            </label>
            <label>
              <span>Subniches (up to 5, comma-separated)</span>
              <input
                aria-label="Subniches"
                value={preferences.subniches.join(", ")}
                onChange={(e) =>
                  setPreferences({
                    ...preferences,
                    subniches: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean)
                      .slice(0, 5),
                  })
                }
              />
            </label>
            <label>
              <span>Target Audience</span>
              <input
                aria-label="Discovery Target Audience"
                value={preferences.targetAudience}
                onChange={(e) =>
                  setPreferences({ ...preferences, targetAudience: e.target.value })
                }
              />
            </label>
            <label>
              <span>Topics to Avoid (comma-separated)</span>
              <input
                aria-label="Topics to Avoid"
                value={preferences.topicsToAvoid.join(", ")}
                onChange={(e) =>
                  setPreferences({
                    ...preferences,
                    topicsToAvoid: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
          </div>
          <div className="button-row" style={{ marginTop: "0.5rem" }}>
            <button type="button" onClick={handleSavePreferences} disabled={busy}>
              Save Niche Profile
            </button>
          </div>
        </div>
      )}

      {/* Phase D2: Trend Evidence Disclosure */}
      {evidenceResult && (
        <div className="notice" style={{ marginBottom: "1rem" }}>
          <strong>Trend Evidence Status ({evidenceResult.sourceStatus}):</strong>{" "}
          {evidenceResult.disclosure}
          <ul>
            {evidenceResult.evidence.map((ev) => (
              <li key={ev.id}>
                <code>[{ev.id}]</code> <strong>{ev.title}</strong> ({ev.channelTitle}) —{" "}
                <span className="badge">{ev.signalBasis}</span>: {ev.signalExplanation}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Phase D5: Editable Project Handoff Modal / Card */}
      {draftPreview && (
        <div className="scene-card" style={{ marginBottom: "1rem", border: "2px solid #f4b860" }}>
          <h3>Turn Idea into Video Project (Phase D5 Handoff Review)</h3>
          <p className="muted">{draftPreview.noAutoPaidGenerationDisclosure}</p>
          {draftPreview.longFormCapabilityDisclosure && (
            <p className="notice">{draftPreview.longFormCapabilityDisclosure}</p>
          )}
          <div className="field-grid">
            <label>
              <span>Project Title</span>
              <input
                aria-label="Draft Project Title"
                value={draftPreview.title}
                onChange={(e) =>
                  setDraftPreview({ ...draftPreview, title: e.target.value })
                }
              />
            </label>
            <label>
              <span>Workflow Mode</span>
              <select
                aria-label="Draft Workflow Type"
                value={draftPreview.projectType}
                onChange={(e) =>
                  setDraftPreview({
                    ...draftPreview,
                    projectType: e.target.value as "story" | "product-ad" | "repurpose",
                  })
                }
              >
                <option value="story">Mode A: Story / Explainer</option>
                <option value="product-ad">Mode B: Product Ad</option>
                <option value="repurpose">Mode C: Repurpose</option>
              </select>
            </label>
            <label>
              <span>Target Duration (seconds)</span>
              <input
                type="number"
                aria-label="Draft Target Duration"
                value={draftPreview.targetDurationSeconds}
                onChange={(e) =>
                  setDraftPreview({
                    ...draftPreview,
                    targetDurationSeconds: Number(e.target.value) || 45,
                  })
                }
              />
            </label>
          </div>
          <p className="muted">
            Provenance: Idea <code>{draftPreview.provenance.ideaId}</code> · Evidence:{" "}
            <code>{draftPreview.provenance.evidenceIds.join(", ")}</code> · Signal:{" "}
            <code>{draftPreview.provenance.signalBasis}</code>
          </p>
          <div className="button-row">
            <button
              type="button"
              className="primary"
              onClick={handleConfirmCreateProject}
              disabled={busy}
            >
              Accept & Create Video Project
            </button>
            <button type="button" onClick={() => setDraftPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Format Track Tabs */}
      <div className="editor-tabs" role="tablist" aria-label="Discover Idea Tracks">
        <button
          type="button"
          role="tab"
          aria-selected={activeTrack === "short-form"}
          className={activeTrack === "short-form" ? "tab active" : "tab"}
          onClick={() => setActiveTrack("short-form")}
        >
          Short-Form Ideas (15–60s)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTrack === "long-form"}
          className={activeTrack === "long-form" ? "tab active" : "tab"}
          onClick={() => setActiveTrack("long-form")}
        >
          Long-Form Ideas (3–5m)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTrack === "saved"}
          className={activeTrack === "saved" ? "tab active" : "tab"}
          onClick={() => setActiveTrack("saved")}
        >
          Saved & Used Ideas
        </button>
      </div>

      {/* Idea Cards Grid */}
      <div className="project-grid" style={{ marginTop: "1rem" }}>
        {displayedIdeas.map((idea) => (
          <div key={idea.id} className="project-card" data-testid={`idea-card-${idea.id}`}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
              <span className="badge">
                {idea.isDemoSample ? "DEMO SAMPLE CARD" : `Signal: ${idea.signalBasis}`}
              </span>
              <span className="badge">Match: {idea.matchScore}%</span>
            </div>
            <h4>{idea.title}</h4>
            <p>
              <strong>Hook:</strong> &ldquo;{idea.hook}&rdquo;
            </p>
            <p className="muted">{idea.angleSummary}</p>
            <p className="muted">
              <strong>Why Now:</strong> {idea.whyNow}
            </p>
            <p className="muted">
              Format: <code>{idea.recommendedProjectType}</code> ·{" "}
              <code>{idea.recommendedDurationSeconds}s</code> ·{" "}
              <code>{idea.recommendedAspectRatio}</code> · Evidence:{" "}
              <code>{idea.evidenceIds.join(", ")}</code>
            </p>
            <details>
              <summary>Why this idea matches ({idea.matchExplanation.length} factors)</summary>
              <ul>
                {idea.matchExplanation.map((reason, idx) => (
                  <li key={idx}>{reason}</li>
                ))}
              </ul>
            </details>

            {editingPromptId === idea.id && (
              <div style={{ marginTop: "0.5rem" }}>
                <input
                  aria-label="Custom Idea Direction"
                  value={customPromptText}
                  onChange={(e) => setCustomPromptText(e.target.value)}
                  placeholder="Add custom angle direction..."
                />
                <button
                  type="button"
                  onClick={() =>
                    void handleCardFeedback(
                      idea.id,
                      "edit-prompt",
                      undefined,
                      customPromptText,
                    )
                  }
                >
                  Apply Note
                </button>
              </div>
            )}

            <div className="button-row" style={{ marginTop: "0.75rem", flexWrap: "wrap" }}>
              <button
                type="button"
                className="primary"
                onClick={() => void handlePreviewProjectHandoff(idea.id)}
                disabled={busy}
              >
                Create Video
              </button>
              <button
                type="button"
                onClick={() => void handleCardFeedback(idea.id, "save")}
                disabled={busy}
              >
                {idea.status === "saved" ? "Saved" : "Save"}
              </button>
              <button
                type="button"
                onClick={() =>
                  void handleCardFeedback(idea.id, "replace", "more-like-this")
                }
                disabled={busy}
              >
                More Like This
              </button>
              <button
                type="button"
                onClick={() =>
                  void handleCardFeedback(idea.id, "dismiss", "not-relevant")
                }
                disabled={busy}
              >
                Dismiss & Replace
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingPromptId(idea.id);
                  setCustomPromptText(idea.customPromptNote ?? "");
                }}
              >
                Edit Direction
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
