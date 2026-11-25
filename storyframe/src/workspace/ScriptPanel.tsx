import type { ProjectScene } from "../../shared/project-contract";
import { duplicateScene, formatDuration, moveScene, newScene, totalDurationSeconds } from "./model";

interface ScriptPanelProps {
  scenes: ProjectScene[];
  targetDurationSeconds: number;
  onChange: (scenes: ProjectScene[]) => void;
}

export function ScriptPanel({ scenes, targetDurationSeconds, onChange }: ScriptPanelProps) {
  const total = totalDurationSeconds(scenes);

  function updateScene(sceneId: string, patch: Partial<ProjectScene>) {
    onChange(scenes.map((scene) => (scene.id === sceneId ? { ...scene, ...patch } : scene)));
  }

  function toggleLock(scene: ProjectScene, key: keyof ProjectScene["locks"]) {
    updateScene(scene.id, { locks: { ...scene.locks, [key]: !scene.locks[key] } });
  }

  function removeScene(sceneId: string) {
    onChange(scenes.filter((scene) => scene.id !== sceneId));
  }

  function insertCopy(scene: ProjectScene) {
    const index = scenes.findIndex((candidate) => candidate.id === scene.id);
    onChange([...scenes.slice(0, index + 1), duplicateScene(scene), ...scenes.slice(index + 1)]);
  }

  return (
    <section className="panel editor-panel" aria-labelledby="script-heading">
      <div className="panel-heading">
        <h2 id="script-heading">Script</h2>
        <span className="status">
          {formatDuration(total)} / {formatDuration(targetDurationSeconds)} planned
        </span>
      </div>
      <p className="muted editor-intro">
        Narration here is the script. The storyboard and preview read this same wording, so editing one never leaves a
        stale copy behind.
      </p>

      {scenes.length === 0 && <p className="empty-state">No scenes yet. Add the first scene to begin the script.</p>}

      <div className="scene-list">
        {scenes.map((scene, index) => (
          <article className="scene-card" key={scene.id} aria-label={`Scene ${index + 1}`}>
            <div className="scene-toolbar">
              <div>
                <span className="scene-number">Scene {index + 1}</span>{" "}
                <code className="scene-id">{scene.id}</code>
              </div>
              <div className="button-row">
                <button
                  type="button"
                  className="button-secondary button-small"
                  onClick={() => onChange(moveScene(scenes, index, -1))}
                  disabled={index === 0}
                  aria-label={`Move scene ${index + 1} up`}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="button-secondary button-small"
                  onClick={() => onChange(moveScene(scenes, index, 1))}
                  disabled={index === scenes.length - 1}
                  aria-label={`Move scene ${index + 1} down`}
                >
                  Down
                </button>
                <button
                  type="button"
                  className="button-secondary button-small"
                  onClick={() => insertCopy(scene)}
                  aria-label={`Duplicate scene ${index + 1}`}
                >
                  Duplicate
                </button>
                <button
                  type="button"
                  className="button-secondary button-small button-danger"
                  onClick={() => removeScene(scene.id)}
                  disabled={Object.values(scene.locks).some(Boolean)}
                  title={
                    Object.values(scene.locks).some(Boolean)
                      ? "Unlock every component before deleting this scene."
                      : undefined
                  }
                  aria-label={`Delete scene ${index + 1}`}
                >
                  Delete
                </button>
              </div>
            </div>

            <label className="field" htmlFor={`${scene.id}-heading`}>
              <span className="field-label">Heading</span>
              <input
                id={`${scene.id}-heading`}
                value={scene.heading}
                maxLength={200}
                onChange={(event) => updateScene(scene.id, { heading: event.target.value })}
                aria-label={`Scene ${index + 1} heading`}
              />
            </label>

            <div className="field">
              <div className="field-label-row">
                <label className="field-label" htmlFor={`${scene.id}-narration`}>
                  Narration
                </label>
                <button
                  type="button"
                  className={scene.locks.narration ? "lock-button lock-on" : "lock-button"}
                  onClick={() => toggleLock(scene, "narration")}
                  aria-pressed={scene.locks.narration}
                  aria-label={`Lock narration for scene ${index + 1}`}
                >
                  {scene.locks.narration ? "Locked" : "Lock"}
                </button>
              </div>
              <textarea
                id={`${scene.id}-narration`}
                rows={5}
                maxLength={20000}
                value={scene.body}
                disabled={scene.locks.narration}
                onChange={(event) => updateScene(scene.id, { body: event.target.value })}
                aria-label={`Scene ${index + 1} narration`}
              />
              {scene.locks.narration && (
                <span className="hint">Narration is locked. Unlock it, then save, before changing this wording.</span>
              )}
            </div>

            <div className="field">
              <div className="field-label-row">
                <label className="field-label" htmlFor={`${scene.id}-onscreen`}>
                  On-screen text
                </label>
                <button
                  type="button"
                  className={scene.locks.onScreenText ? "lock-button lock-on" : "lock-button"}
                  onClick={() => toggleLock(scene, "onScreenText")}
                  aria-pressed={scene.locks.onScreenText}
                  aria-label={`Lock on-screen text for scene ${index + 1}`}
                >
                  {scene.locks.onScreenText ? "Locked" : "Lock"}
                </button>
              </div>
              <input
                id={`${scene.id}-onscreen`}
                value={scene.onScreenText}
                maxLength={500}
                disabled={scene.locks.onScreenText}
                onChange={(event) => updateScene(scene.id, { onScreenText: event.target.value })}
                aria-label={`Scene ${index + 1} on-screen text`}
              />
            </div>
          </article>
        ))}
      </div>

      <div className="editor-actions">
        <button type="button" onClick={() => onChange([...scenes, newScene(scenes.length)])}>
          Add scene
        </button>
        <p className="hint">
          Scene ids stay stable through reordering. Saving is explicit; unsaved edits are marked in the header.
        </p>
      </div>
    </section>
  );
}
