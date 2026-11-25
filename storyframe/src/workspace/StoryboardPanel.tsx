import { sceneFingerprint } from "../../shared/scene-fingerprint";
import type { ProjectScene } from "../../shared/project-contract";
import { formatDuration, totalDurationSeconds } from "./model";

interface StoryboardPanelProps {
  scenes: ProjectScene[];
  targetDurationSeconds: number;
  onChange: (scenes: ProjectScene[]) => void;
}

export function StoryboardPanel({ scenes, targetDurationSeconds, onChange }: StoryboardPanelProps) {
  const total = totalDurationSeconds(scenes);

  function updateScene(sceneId: string, patch: Partial<ProjectScene>) {
    onChange(scenes.map((scene) => (scene.id === sceneId ? { ...scene, ...patch } : scene)));
  }

  function toggleLock(scene: ProjectScene, key: keyof ProjectScene["locks"]) {
    updateScene(scene.id, { locks: { ...scene.locks, [key]: !scene.locks[key] } });
  }

  function approve(scene: ProjectScene) {
    updateScene(scene.id, { approved: true, approvedFingerprint: sceneFingerprint(scene) });
  }

  return (
    <section className="panel editor-panel" aria-labelledby="storyboard-heading">
      <div className="panel-heading">
        <h2 id="storyboard-heading">Storyboard</h2>
        <span className="status">
          {formatDuration(total)} / {formatDuration(targetDurationSeconds)} planned
        </span>
      </div>

      <div className="callout" role="note">
        <strong>Storyboard preview, not a rendered movie.</strong>
        <p>
          Each card arranges the script, visuals, on-screen text, media, and timing. Rendering video is not part of
          Phase 4.
        </p>
      </div>

      {scenes.length === 0 && <p className="empty-state">Add scenes in the Script tab to build the storyboard.</p>}

      <div className="storyboard-grid">
        {scenes.map((scene, index) => {
          const fingerprint = sceneFingerprint(scene);
          const approvedCurrent = scene.approved && scene.approvedFingerprint === fingerprint;
          const stale = scene.approved && !approvedCurrent;

          return (
            <article className="storyboard-card" key={scene.id} aria-label={`Storyboard card ${index + 1}`}>
              <header className="storyboard-card-header">
                <span className="scene-number">{index + 1}</span>
                <div>
                  <h3>{scene.heading}</h3>
                  <code className="scene-id">{scene.id}</code>
                </div>
                <span className="duration-pill">{formatDuration(scene.durationSeconds)}</span>
              </header>

              <p className="storyboard-narration">
                {scene.body.trim() || <span className="muted">No narration yet.</span>}
              </p>

              <div className="field">
                <div className="field-label-row">
                  <label className="field-label" htmlFor={`${scene.id}-visual`}>
                    Visual direction
                  </label>
                  <button
                    type="button"
                    className={scene.locks.visualDirection ? "lock-button lock-on" : "lock-button"}
                    onClick={() => toggleLock(scene, "visualDirection")}
                    aria-pressed={scene.locks.visualDirection}
                    aria-label={`Lock visual direction for scene ${index + 1}`}
                  >
                    {scene.locks.visualDirection ? "Locked" : "Lock"}
                  </button>
                </div>
                <textarea
                  id={`${scene.id}-visual`}
                  rows={3}
                  maxLength={4000}
                  value={scene.visualDirection}
                  disabled={scene.locks.visualDirection}
                  onChange={(event) => updateScene(scene.id, { visualDirection: event.target.value })}
                  aria-label={`Scene ${index + 1} visual direction`}
                />
              </div>

              <div className="field">
                <div className="field-label-row">
                  <label className="field-label" htmlFor={`${scene.id}-duration`}>
                    Duration (seconds)
                  </label>
                  <button
                    type="button"
                    className={scene.locks.duration ? "lock-button lock-on" : "lock-button"}
                    onClick={() => toggleLock(scene, "duration")}
                    aria-pressed={scene.locks.duration}
                    aria-label={`Lock duration for scene ${index + 1}`}
                  >
                    {scene.locks.duration ? "Locked" : "Lock"}
                  </button>
                </div>
                <input
                  id={`${scene.id}-duration`}
                  type="number"
                  min={0}
                  max={3600}
                  step={1}
                  value={scene.durationSeconds}
                  disabled={scene.locks.duration}
                  onChange={(event) =>
                    updateScene(scene.id, {
                      durationSeconds: Math.max(0, Math.floor(event.target.valueAsNumber || 0)),
                    })
                  }
                  aria-label={`Scene ${index + 1} duration`}
                />
              </div>

              {scene.onScreenText.trim() && (
                <p className="on-screen-text">
                  <span className="field-label">On screen</span> {scene.onScreenText}
                </p>
              )}

              <p className="hint">
                {scene.assetIds.length === 0
                  ? "No media attached."
                  : `${scene.assetIds.length} media asset${scene.assetIds.length === 1 ? "" : "s"} attached.`}
              </p>

              <div className="approval">
                <div>
                  <span className="field-label">Approval</span>
                  <p
                    className={
                      approvedCurrent
                        ? "approval-state approval-current"
                        : stale
                          ? "approval-state approval-stale"
                          : "approval-state"
                    }
                    data-testid={`approval-${scene.id}`}
                  >
                    {approvedCurrent ? "Approved" : stale ? "Approval out of date" : "Not approved"}
                  </p>
                  <span className="hint">
                    Content {fingerprint.slice(0, 8)}
                    {stale && scene.approvedFingerprint
                      ? ` · approved ${scene.approvedFingerprint.slice(0, 8)}`
                      : ""}
                  </span>
                </div>
                <div className="button-row">
                  <button
                    type="button"
                    className="button-secondary button-small"
                    onClick={() => approve(scene)}
                    disabled={approvedCurrent}
                    aria-label={`Approve current content for scene ${index + 1}`}
                  >
                    Approve content
                  </button>
                  {scene.approved && (
                    <button
                      type="button"
                      className="button-secondary button-small"
                      onClick={() => updateScene(scene.id, { approved: false, approvedFingerprint: null })}
                      aria-label={`Clear approval for scene ${index + 1}`}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
