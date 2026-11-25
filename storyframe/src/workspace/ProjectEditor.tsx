import { useEffect, useState } from "react";
import type { ProjectDocumentV2, ProjectRecord } from "../../shared/project-contract";
import { AiRequestError, getProject, updateProject } from "../api";
import { BriefPanel } from "./BriefPanel";
import { GeneratePanel } from "./GeneratePanel";
import { MediaPanel } from "./MediaPanel";
import { NarrationPanel } from "./NarrationPanel";
import { PlanningPanel } from "./PlanningPanel";
import { SourcesPanel } from "./SourcesPanel";
import { PreviewPanel } from "./PreviewPanel";
import { ProductAdPanel } from "./ProductAdPanel";
import { RenderAndReleasePanel } from "./RenderAndReleasePanel";
import { RepurposePanel } from "./RepurposePanel";
import { ScopedEditPanel } from "./ScopedEditPanel";
import { ScriptPanel } from "./ScriptPanel";
import { SettingsPanel } from "./SettingsPanel";
import { StoryboardPanel } from "./StoryboardPanel";

type EditorTab =
  | "brief"
  | "sources"
  | "plan"
  | "script"
  | "storyboard"
  | "narration"
  | "generate"
  | "media"
  | "product-ad"
  | "repurpose"
  | "scoped-edit"
  | "render-release"
  | "preview"
  | "settings";

const TABS: { id: EditorTab; label: string }[] = [
  { id: "brief", label: "Brief" },
  { id: "sources", label: "Sources" },
  { id: "plan", label: "Plan" },
  { id: "script", label: "Script" },
  { id: "storyboard", label: "Storyboard" },
  { id: "narration", label: "Narration" },
  { id: "generate", label: "Generate" },
  { id: "media", label: "Media" },
  { id: "product-ad", label: "Product Ad (Mode B)" },
  { id: "repurpose", label: "Repurpose (Mode C)" },
  { id: "scoped-edit", label: "Scoped Edit" },
  { id: "render-release", label: "Render & Release" },
  { id: "preview", label: "Preview" },
  { id: "settings", label: "Settings" },
];

interface ProjectEditorProps {
  project: ProjectRecord;
  getAccessToken: () => Promise<string>;
  onBack: () => void;
  onDeleted: () => void;
  onSaved?: (project: ProjectRecord) => void;
  onBusyChange?: (busy: boolean) => void;
}

function toRequestError(cause: unknown): AiRequestError {
  if (cause instanceof AiRequestError) return cause;
  return new AiRequestError(
    "NETWORK_ERROR",
    cause instanceof Error ? cause.message : "The request could not be completed.",
    0,
  );
}

export function ProjectEditor({
  project,
  getAccessToken,
  onBack,
  onDeleted,
  onSaved,
  onBusyChange,
}: ProjectEditorProps) {
  const [saved, setSaved] = useState(project);
  const [title, setTitle] = useState(project.title);
  const [draft, setDraft] = useState<ProjectDocumentV2>(project.document);
  const [tab, setTab] = useState<EditorTab>("brief");
  const [saving, setSaving] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [error, setError] = useState<AiRequestError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const busy = saving || mediaBusy || planBusy;
  const dirty = title !== saved.title || JSON.stringify(draft) !== JSON.stringify(saved.document);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  async function saveDocument(nextDocument: ProjectDocumentV2, nextTitle = title): Promise<boolean> {
    if (saving) return false;
    const trimmed = nextTitle.trim();
    if (!trimmed) {
      setError(new AiRequestError("INVALID_PROJECT", "A project title is required before saving.", 400));
      return false;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateProject(await getAccessToken(), saved.id, {
        title: trimmed,
        document: nextDocument,
        version: saved.version,
      });
      setSaved(updated);
      setDraft(updated.document);
      setTitle(updated.title);
      setConflict(false);
      setNotice(`Saved version ${updated.version}.`);
      onSaved?.(updated);
      return true;
    } catch (cause) {
      const requestError = toRequestError(cause);
      setError(requestError);
      if (requestError.code === "PROJECT_VERSION_CONFLICT") setConflict(true);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function reloadLatest() {
    setError(null);
    try {
      const latest = await getProject(await getAccessToken(), saved.id);
      setSaved(latest);
      setDraft(latest.document);
      setTitle(latest.title);
      setConflict(false);
      setNotice(`Loaded version ${latest.version} from the server.`);
    } catch (cause) {
      setError(toRequestError(cause));
    }
  }

  async function attachAsset(sceneId: string, mediaId: string): Promise<boolean> {
    const next: ProjectDocumentV2 = {
      ...draft,
      scenes: draft.scenes.map((scene) =>
        scene.id === sceneId && !scene.assetIds.includes(mediaId)
          ? { ...scene, assetIds: [...scene.assetIds, mediaId] }
          : scene,
      ),
    };
    setDraft(next);
    const ok = await saveDocument(next);
    if (ok) setNotice(`Media ${mediaId.slice(0, 8)} attached to the scene and saved.`);
    return ok;
  }

  async function detachAsset(sceneId: string, mediaId: string): Promise<boolean> {
    const next: ProjectDocumentV2 = {
      ...draft,
      scenes: draft.scenes.map((scene) =>
        scene.id === sceneId
          ? { ...scene, assetIds: scene.assetIds.filter((assetId) => assetId !== mediaId) }
          : scene,
      ),
    };
    // The draft is replaced only by a successful save. A failed detach keeps
    // the scene link visible, so pressing Detach again can finish the job even
    // though the server reference is already gone.
    const ok = await saveDocument(next);
    if (ok) setNotice(`Media ${mediaId.slice(0, 8)} detached from the scene and saved.`);
    return ok;
  }

  return (
    <div className="workspace editor">
      <section className="panel editor-header" aria-labelledby="editor-heading">
        <div className="editor-header-top">
          <button type="button" className="button-secondary button-small" onClick={onBack} disabled={saving}>
            Back to dashboard
          </button>
          <span className="status">{saved.projectType}</span>
        </div>

        <div className="editor-title-row">
          <div className="editor-title">
            <label className="field-label" htmlFor="project-title">
              Project title
            </label>
            <h2 className="sr-only" id="editor-heading">
              Editing project
            </h2>
            <input
              id="project-title"
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
              aria-label="Project title"
            />
          </div>
          <div className="editor-save">
            <span className="hint" role="status">
              {saving ? "Saving..." : dirty ? "Unsaved changes" : "Saved"}
            </span>
            <button
              type="button"
              onClick={() => void saveDocument(draft)}
              disabled={!dirty || saving || !title.trim()}
            >
              {saving ? "Saving..." : "Save changes"}
            </button>
          </div>
        </div>
        <p className="hint">
          Version {saved.version} · document schema {saved.schemaVersion} · scene ids stay stable, and saving is
          explicit so one change is one revision.
        </p>
      </section>

      {conflict && (
        <div className="alert" role="alert">
          <strong>PROJECT_VERSION_CONFLICT</strong>
          <p>Another save changed this project after it was opened. Your draft is still here.</p>
          <div className="button-row">
            <button type="button" className="button-secondary button-small" onClick={() => void reloadLatest()}>
              Load latest version
            </button>
          </div>
        </div>
      )}

      {error && !conflict && (
        <div className="alert" role="alert">
          <strong>{error.code}</strong>
          <p>{error.message}</p>
        </div>
      )}

      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <div className="tab-bar" role="tablist" aria-label="Project sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? "tab tab-active" : "tab"}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-label={TABS.find((item) => item.id === tab)?.label}>
        {tab === "brief" && (
          <BriefPanel brief={draft.brief} onChange={(brief) => setDraft({ ...draft, brief })} />
        )}
        {tab === "sources" && (
          <SourcesPanel
            projectId={saved.id}
            getAccessToken={getAccessToken}
            onBusyChange={setPlanBusy}
          />
        )}
        {tab === "plan" && (
          <PlanningPanel
            projectId={saved.id}
            baseVersion={saved.version}
            scenes={draft.scenes}
            dirty={dirty}
            getAccessToken={getAccessToken}
            onBusyChange={setPlanBusy}
            onAccepted={(updated) => {
              setSaved(updated);
              setDraft(updated.document);
              setTitle(updated.title);
              setConflict(false);
              setNotice(`Accepted proposal; saved version ${updated.version}.`);
              onSaved?.(updated);
            }}
          />
        )}
        {tab === "script" && (
          <ScriptPanel
            scenes={draft.scenes}
            targetDurationSeconds={draft.brief.targetDurationSeconds}
            onChange={(scenes) => setDraft({ ...draft, scenes })}
          />
        )}
        {tab === "storyboard" && (
          <StoryboardPanel
            scenes={draft.scenes}
            targetDurationSeconds={draft.brief.targetDurationSeconds}
            onChange={(scenes) => setDraft({ ...draft, scenes })}
          />
        )}
        {tab === "narration" && (
          <NarrationPanel
            projectId={saved.id}
            getAccessToken={getAccessToken}
            onBusyChange={setMediaBusy}
          />
        )}
        {tab === "generate" && (
          <GeneratePanel
            projectId={saved.id}
            scenes={draft.scenes}
            getAccessToken={getAccessToken}
            onAttachAsset={attachAsset}
            onBusyChange={setMediaBusy}
          />
        )}
        {tab === "media" && (
          <MediaPanel
            projectId={saved.id}
            scenes={draft.scenes}
            getAccessToken={getAccessToken}
            onAttachAsset={attachAsset}
            onDetachAsset={detachAsset}
            onBusyChange={setMediaBusy}
          />
        )}
        {tab === "product-ad" && (
          <ProductAdPanel project={saved} getAccessToken={getAccessToken} />
        )}
        {tab === "repurpose" && (
          <RepurposePanel project={saved} getAccessToken={getAccessToken} />
        )}
        {tab === "scoped-edit" && (
          <ScopedEditPanel
            project={saved}
            getAccessToken={getAccessToken}
            onProjectReplaced={(updated) => {
              setSaved(updated);
              setDraft(updated.document);
              setTitle(updated.title);
              setConflict(false);
              onSaved?.(updated);
            }}
          />
        )}
        {tab === "render-release" && (
          <RenderAndReleasePanel project={saved} getAccessToken={getAccessToken} />
        )}
        {tab === "preview" && (
          <PreviewPanel
            title={title}
            projectDocument={draft}
            projectId={saved.id}
            getAccessToken={getAccessToken}
          />
        )}
        {tab === "settings" && (
          <SettingsPanel project={saved} getAccessToken={getAccessToken} onDeleted={onDeleted} />
        )}
      </div>
    </div>
  );
}
