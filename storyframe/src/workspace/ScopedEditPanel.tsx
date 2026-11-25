import { useEffect, useState } from "react";
import type { ProjectRecord } from "../../shared/project-contract";
import type {
  ScopedEditCommandType,
  ScopedEditPlanRecord,
} from "../../shared/workflows-contract";
import {
  applyScopedEditPlan,
  createScopedEditPlan,
  listScopedEditPlans,
  restoreScopedEditPlan,
} from "../api";

interface ScopedEditPanelProps {
  project: ProjectRecord;
  getAccessToken: () => Promise<string>;
  onProjectReplaced: (project: ProjectRecord) => void;
}

export function ScopedEditPanel({
  project,
  getAccessToken,
  onProjectReplaced,
}: ScopedEditPanelProps) {
  const [command, setCommand] = useState<ScopedEditCommandType>("rewrite-hook");
  const [targetSceneId, setTargetSceneId] = useState<string>(
    project.document.scenes[0]?.id ?? "scene-1",
  );
  const [instruction, setInstruction] = useState(
    "Make the opening hook more urgent without altering any locked visuals.",
  );
  const [replacementValue, setReplacementValue] = useState("");
  const [overrideLocks, setOverrideLocks] = useState(false);

  const [plans, setPlans] = useState<ScopedEditPlanRecord[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadPlans();
  }, [project.id, project.version]);

  async function loadPlans() {
    try {
      const token = await getAccessToken();
      const list = await listScopedEditPlans(token, project.id);
      setPlans(list);
    } catch {
      // ignore initial load error
    }
  }

  async function handleGeneratePlan() {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const plan = await createScopedEditPlan(token, project.id, {
        command,
        targetSceneId,
        instruction,
        replacementValue: replacementValue.trim() || undefined,
        overrideLocks,
      });
      setPlans((prev) => [plan, ...prev]);
      setStatusMessage(
        `Generated pre-mutation Scoped Edit Plan ${plan.id} (fingerprint ${plan.inputFingerprint.slice(0, 14)}…). Review affected & preserved components before applying.`,
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not generate edit plan.");
    } finally {
      setBusy(false);
    }
  }

  async function handleApplyPlan(planId: string) {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const { plan, project: updated } = await applyScopedEditPlan(
        token,
        project.id,
        planId,
        true,
      );
      setPlans((prev) => prev.map((p) => (p.id === plan.id ? plan : p)));
      onProjectReplaced(updated);
      setStatusMessage(
        `Applied scoped edit plan ${plan.id}. Project bumped to version ${updated.version} with all unaffected scenes preserved.`,
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not apply scoped edit plan.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRestorePlan(planId: string) {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const { plan, project: restored } = await restoreScopedEditPlan(
        token,
        project.id,
        planId,
      );
      setPlans((prev) => prev.map((p) => (p.id === plan.id ? plan : p)));
      onProjectReplaced(restored);
      setStatusMessage(
        `Restored project from scoped edit snapshot ${plan.id} (now version ${restored.version}) without deleting referenced assets.`,
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not restore snapshot.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" data-testid="scoped-edit-panel">
      <div className="panel-header">
        <div>
          <h3>Phase 13: Scoped AI Editing & Recovery</h3>
          <p className="muted">
            Execute allowlisted, surgical edits that inspect scene locks, verify input content fingerprints, estimate provider costs before mutation, and support non-destructive undo/restore.
          </p>
        </div>
      </div>

      {statusMessage && (
        <p className="status-banner" role="status">
          {statusMessage}
        </p>
      )}
      {errorMessage && (
        <div className="alert" role="alert">
          <strong>SCOPED_EDIT_CONFLICT</strong>
          <p>{errorMessage}</p>
        </div>
      )}

      <section className="scene-card">
        <h4>1. Configure Allowlisted Scoped Command</h4>
        <div className="field-grid">
          <label>
            <span>Allowlisted Command</span>
            <select
              aria-label="Allowlisted Command"
              value={command}
              onChange={(e) => setCommand(e.target.value as ScopedEditCommandType)}
            >
              <option value="rewrite-hook">Rewrite Only Opening Hook (Keep Visuals)</option>
              <option value="replace-scene-image">Replace Scene N Visual Direction / Image</option>
              <option value="change-narration-keep-visuals">
                Change Scene Narration & Keep Visuals
              </option>
              <option value="adjust-variant-cta">Adjust CTA Across Selected Ad Variants</option>
              <option value="expand-clip-range">Expand Repurposed Clip Source Range</option>
            </select>
          </label>

          <label>
            <span>Target Scene</span>
            <select
              aria-label="Target Scene"
              value={targetSceneId}
              onChange={(e) => setTargetSceneId(e.target.value)}
            >
              {project.document.scenes.map((scene, idx) => (
                <option key={scene.id} value={scene.id}>
                  Scene {idx + 1}: {scene.heading}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Scoped Instruction</span>
            <input
              aria-label="Scoped Instruction"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
            />
          </label>

          <label>
            <span>Exact Replacement Text (Optional)</span>
            <input
              aria-label="Exact Replacement Text"
              value={replacementValue}
              onChange={(e) => setReplacementValue(e.target.value)}
              placeholder="Leave blank to synthesize from instruction..."
            />
          </label>

          <label className="lock-toggle">
            <input
              type="checkbox"
              checked={overrideLocks}
              onChange={(e) => setOverrideLocks(e.target.checked)}
            />
            <span>Explicitly override scene lock if target field is locked</span>
          </label>
        </div>

        <div className="button-row" style={{ marginTop: "0.75rem" }}>
          <button
            type="button"
            className="primary"
            onClick={handleGeneratePlan}
            disabled={busy}
          >
            Preview Validated Edit Plan (Dry Run)
          </button>
        </div>
      </section>

      {plans.length > 0 && (
        <section className="scene-card" style={{ marginTop: "1rem" }}>
          <h4>2. Pre-Mutation Edit Plans & Undo History ({plans.length})</h4>
          <ul className="revision-list">
            {plans.map((plan) => (
              <li key={plan.id} className="revision-item">
                <div style={{ flex: 1 }}>
                  <div>
                    <strong>{plan.command}</strong> ({plan.id}) · Base Version:{" "}
                    <code>v{plan.baseVersion}</code> · Status:{" "}
                    <span className="badge">{plan.status}</span> · Estimated Cost:{" "}
                    <strong>${plan.estimatedCostUsd.toFixed(4)}</strong> · Timing Delta:{" "}
                    <code>{plan.timingDeltaSeconds >= 0 ? `+${plan.timingDeltaSeconds}s` : `${plan.timingDeltaSeconds}s`}</code>
                  </div>
                  <p className="muted">
                    Required Jobs: <code>{plan.requiredProviderJobs.join(", ")}</code>
                  </p>
                  <div>
                    <strong>Affected:</strong> {plan.affectedComponents.join(" | ")}
                  </div>
                  <div className="muted">
                    <strong>Preserved:</strong> {plan.preservedComponents.join(" | ")}
                  </div>
                  {plan.lockConflicts.length > 0 && (
                    <div className="alert" style={{ marginTop: "0.4rem" }}>
                      <strong>Lock Conflicts Detected:</strong>{" "}
                      {plan.lockConflicts.map((c) => c.message).join("; ")}
                    </div>
                  )}
                </div>
                <div className="button-row">
                  {plan.status === "planned" && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => handleApplyPlan(plan.id)}
                      disabled={busy}
                    >
                      Confirm & Apply Scoped Edit
                    </button>
                  )}
                  {plan.status === "applied" && (
                    <button
                      type="button"
                      onClick={() => handleRestorePlan(plan.id)}
                      disabled={busy}
                    >
                      Undo / Restore Snapshot
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
