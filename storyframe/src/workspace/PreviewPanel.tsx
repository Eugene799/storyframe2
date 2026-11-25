import { useState } from "react";
import { sceneFingerprint } from "../../shared/scene-fingerprint";
import type { ProjectDocumentV2 } from "../../shared/project-contract";
import { buildScriptText } from "../../shared/project-export";
import { AiRequestError, exportProject } from "../api";
import { formatDuration, totalDurationSeconds } from "./model";

interface PreviewPanelProps {
  title: string;
  projectDocument: ProjectDocumentV2;
  projectId: string;
  getAccessToken: () => Promise<string>;
}

function downloadFile(name: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = globalThis.document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  globalThis.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function slugFor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "storyframe-project";
}

export function PreviewPanel({ title, projectDocument, projectId, getAccessToken }: PreviewPanelProps) {
  const scenes = projectDocument.scenes;
  const total = totalDurationSeconds(scenes);
  const [exporting, setExporting] = useState<"json" | "script" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // The server joins the draft's asset ids to the stored media rows, so the
  // credit comes from provenance rather than from anything the browser sends.
  async function loadExport() {
    return exportProject(await getAccessToken(), projectId, title, projectDocument);
  }

  async function exportJson() {
    if (exporting) return;
    setExporting("json");
    setExportError(null);
    try {
      const payload = await loadExport();
      downloadFile(`${slugFor(title)}.json`, JSON.stringify(payload, null, 2), "application/json");
    } catch (cause) {
      setExportError(
        cause instanceof AiRequestError ? cause.message : "The export could not be completed.",
      );
    } finally {
      setExporting(null);
    }
  }

  async function exportScript() {
    if (exporting) return;
    setExporting("script");
    setExportError(null);
    try {
      const payload = await loadExport();
      downloadFile(`${slugFor(title)}-script.txt`, buildScriptText(payload), "text/plain");
    } catch (cause) {
      setExportError(
        cause instanceof AiRequestError ? cause.message : "The export could not be completed.",
      );
    } finally {
      setExporting(null);
    }
  }

  return (
    <section className="panel editor-panel" aria-labelledby="preview-heading">
      <div className="panel-heading">
        <h2 id="preview-heading">Preview</h2>
        <span className="status">{formatDuration(total)} total</span>
      </div>

      <div className="callout" role="note">
        <strong>This is a storyboard preview, not a rendered movie.</strong>
        <p>
          It shows exactly the editable script, visual direction, on-screen text, media count, and timing stored in
          this project. No video is generated in Phase 4.
        </p>
      </div>

      <div className="preview-list">
        {scenes.map((scene, index) => {
          const approved =
            scene.approved && scene.approvedFingerprint === sceneFingerprint(scene);
          return (
            <article className="preview-card" key={scene.id}>
              <header>
                <span className="scene-number">{index + 1}</span>
                <h3>{scene.heading}</h3>
                <span className="duration-pill">{formatDuration(scene.durationSeconds)}</span>
              </header>
              <p className="preview-narration">{scene.body || <span className="muted">No narration yet.</span>}</p>
              <dl className="preview-facts">
                <div>
                  <dt>Visual direction</dt>
                  <dd>{scene.visualDirection || "Not set"}</dd>
                </div>
                <div>
                  <dt>On-screen text</dt>
                  <dd>{scene.onScreenText || "None"}</dd>
                </div>
                <div>
                  <dt>Media</dt>
                  <dd>{scene.assetIds.length === 0 ? "None attached" : `${scene.assetIds.length} attached`}</dd>
                </div>
                <div>
                  <dt>Approval</dt>
                  <dd>{approved ? "Approved" : "Not approved for this content"}</dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>

      <div className="export-block">
        <h3>Export</h3>
        <p className="muted">
          Export the editable project as JSON or the script as plain text. Video export is not available in Phase 4;
          rendering belongs to Phase 9.
        </p>
        <div className="button-row">
          <button type="button" onClick={() => void exportJson()} disabled={scenes.length === 0 || exporting !== null}>
            {exporting === "json" ? "Preparing JSON..." : "Download project JSON"}
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={() => void exportScript()}
            disabled={scenes.length === 0 || exporting !== null}
          >
            {exporting === "script" ? "Preparing script..." : "Download script text"}
          </button>
        </div>
        {exportError && <p className="alert">{exportError}</p>}
        <p className="hint">
          Both exports include exactly what is open here. Imported stock media adds its creator, provider, source
          page, and license: the JSON carries a credit list and the per-scene render payload, and the script ends with
          a credits block.
        </p>
      </div>
    </section>
  );
}
