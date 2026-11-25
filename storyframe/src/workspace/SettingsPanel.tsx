import { useEffect, useState } from "react";
import type { ProjectRecord, ProjectRevisionSummary } from "../../shared/project-contract";
import { AiRequestError, deleteProject, listProjectRevisions } from "../api";
import { PROJECT_TYPE_LABELS } from "./model";

interface SettingsPanelProps {
  project: ProjectRecord;
  getAccessToken: () => Promise<string>;
  onDeleted: () => void;
}

export function SettingsPanel({ project, getAccessToken, onDeleted }: SettingsPanelProps) {
  const [revisions, setRevisions] = useState<ProjectRevisionSummary[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setHistoryError(null);
    (async () => {
      try {
        const list = await listProjectRevisions(await getAccessToken(), project.id);
        if (active) setRevisions(list);
      } catch (cause) {
        if (active) {
          setHistoryError(
            cause instanceof AiRequestError ? cause.message : "Could not load the revision history.",
          );
        }
      }
    })();
    return () => {
      active = false;
    };
    // History is loaded once per opened project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  async function removeProject() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteProject(await getAccessToken(), project.id);
      onDeleted();
    } catch (cause) {
      setDeleteError(cause instanceof AiRequestError ? cause.message : "The project could not be deleted.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="panel editor-panel" aria-labelledby="settings-heading">
      <div className="panel-heading">
        <h2 id="settings-heading">Project settings</h2>
        <span className="status">v{project.version}</span>
      </div>

      <dl className="facts">
        <div>
          <dt>Project type</dt>
          <dd>{PROJECT_TYPE_LABELS[project.projectType]}</dd>
        </div>
        <div>
          <dt>Document schema</dt>
          <dd>{project.schemaVersion}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{new Date(project.createdAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Last saved</dt>
          <dd>{new Date(project.updatedAt).toLocaleString()}</dd>
        </div>
      </dl>

      <div className="revision-block">
        <div className="field-label-row">
          <h3>Recent saved versions</h3>
          <span className="status">Last 20</span>
        </div>
        <p className="hint">
          The database records one revision per save. History is bounded and read-only in Phase 4; restoring an old
          version is not part of this phase.
        </p>
        {historyError && <p className="alert">{historyError}</p>}
        {!revisions && !historyError && <p className="muted">Loading revision history...</p>}
        {revisions && revisions.length === 0 && <p className="empty-state">No saved versions yet.</p>}
        <ol className="revision-list">
          {revisions?.map((revision) => (
            <li key={revision.revision}>
              <span className="revision-number">r{revision.revision}</span>
              <span>{revision.title}</span>
              <span className="hint">
                {new Date(revision.createdAt).toLocaleString()} · schema {revision.schemaVersion}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div className="danger-block">
        <h3>Delete project</h3>
        <p className="muted">
          Deleting removes this project, its saved versions, its media references, and the media objects uploaded for
          it. Storage cleanup is best effort, so a bucket failure can leave an object without a record.
        </p>
        {deleteError && <p className="alert">{deleteError}</p>}
        {!confirming ? (
          <button
            type="button"
            className="button-secondary button-danger"
            onClick={() => setConfirming(true)}
            disabled={deleting}
          >
            Delete project
          </button>
        ) : (
          <div className="button-row">
            <button
              type="button"
              className="button-danger"
              onClick={removeProject}
              disabled={deleting}
            >
              {deleting ? "Deleting..." : "Confirm delete project"}
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={() => setConfirming(false)}
              disabled={deleting}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
