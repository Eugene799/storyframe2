import { useEffect, useState } from "react";
import type { ProjectRecord, ProjectSummary, ProjectType } from "../../shared/project-contract";
import { AiRequestError, createProject, getProject, listProjects } from "../api";
import { DiscoverPanel } from "./DiscoverPanel";
import { ProjectEditor } from "./ProjectEditor";
import { StudioOpsPanel } from "./StudioOpsPanel";
import { PROJECT_TYPE_LABELS, createDocument } from "./model";

interface WorkspaceProps {
  getAccessToken: () => Promise<string>;
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

export function Workspace({ getAccessToken, onBusyChange }: WorkspaceProps) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<AiRequestError | null>(null);
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [createType, setCreateType] = useState<ProjectType>("story");
  const [creating, setCreating] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [topView, setTopView] = useState<"dashboard" | "discover" | "studio-ops">("dashboard");

  async function refresh() {
    try {
      setProjects(await listProjects(await getAccessToken()));
      setError(null);
    } catch (cause) {
      setError(toRequestError(cause));
    }
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await listProjects(await getAccessToken());
        if (active) setProjects(list);
      } catch (cause) {
        if (active) setError(toRequestError(cause));
      }
    })();
    return () => {
      active = false;
    };
    // The dashboard loads once; later refreshes are explicit after a create/delete.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const created = await createProject(
        await getAccessToken(),
        createType,
        `Untitled ${PROJECT_TYPE_LABELS[createType].toLowerCase()}`,
        createDocument(createType),
      );
      setProject(created);
      await refresh();
    } catch (cause) {
      setError(toRequestError(cause));
    } finally {
      setCreating(false);
      onBusyChange?.(false);
    }
  }

  async function handleOpen(projectId: string) {
    if (openingId) return;
    setOpeningId(projectId);
    setError(null);
    try {
      setProject(await getProject(await getAccessToken(), projectId));
    } catch (cause) {
      setError(toRequestError(cause));
    } finally {
      setOpeningId(null);
    }
  }

  if (project) {
    return (
      <ProjectEditor
        key={project.id}
        project={project}
        getAccessToken={getAccessToken}
        onBack={() => {
          setProject(null);
          void refresh();
        }}
        onDeleted={() => {
          setProject(null);
          void refresh();
        }}
        onSaved={() => void refresh()}
        onBusyChange={onBusyChange}
      />
    );
  }

  return (
    <div className="workspace">
      <div className="button-row" style={{ marginBottom: "0.75rem" }}>
        <button
          type="button"
          className={topView === "dashboard" ? "button-small" : "button-secondary button-small"}
          onClick={() => setTopView("dashboard")}
        >
          Projects Dashboard
        </button>
        <button
          type="button"
          className={topView === "discover" ? "button-small" : "button-secondary button-small"}
          onClick={() => setTopView("discover")}
        >
          Discover Ideas (D1–D6)
        </button>
        <button
          type="button"
          className={topView === "studio-ops" ? "button-small" : "button-secondary button-small"}
          onClick={() => setTopView("studio-ops")}
        >
          Billing, Team, API & Launch Audit (14–22)
        </button>
      </div>

      {topView === "discover" && (
        <DiscoverPanel
          getAccessToken={getAccessToken}
          onProjectCreated={(created) => {
            setProject(created);
            setTopView("dashboard");
            void refresh();
          }}
        />
      )}

      {topView === "studio-ops" && <StudioOpsPanel getAccessToken={getAccessToken} />}

      {topView === "dashboard" && (
      <section className="panel dashboard" aria-labelledby="dashboard-heading">
        <div className="panel-heading">
          <h2 id="dashboard-heading">Dashboard</h2>
          <span className="status status-ok">{projects ? `${projects.length} project${projects.length === 1 ? "" : "s"}` : "Loading"}</span>
        </div>

        <p className="muted editor-intro">
          Create a project to write the brief, script, and storyboard. Projects are private to your signed-in account
          and reopen with their saved version and history.
        </p>

        <div className="create-row">
          <label className="field" htmlFor="create-type">
            <span className="field-label">New project</span>
            <select
              id="create-type"
              value={createType}
              onChange={(event) => setCreateType(event.target.value as ProjectType)}
              disabled={creating}
            >
              <option value="story">Explain / tell a story</option>
              <option value="product-ad">Product ad</option>
              <option value="repurpose">Repurpose footage</option>
            </select>
          </label>
          <button type="button" onClick={() => void handleCreate()} disabled={creating}>
            {creating ? "Creating..." : "Create project"}
          </button>
        </div>

        {error && (
          <div className="alert" role="alert">
            <strong>{error.code}</strong>
            <p>{error.message}</p>
          </div>
        )}

        {!projects && !error && <p className="muted">Loading projects...</p>}

        {projects && projects.length === 0 && (
          <p className="empty-state">
            No projects yet. Choose a type above and create one to start the brief, script, and storyboard.
          </p>
        )}

        <div className="project-grid">
          {projects?.map((item) => (
            <article className="project-card" key={item.id}>
              <div className="project-card-header">
                <h3>{item.title}</h3>
                <span className="status">{PROJECT_TYPE_LABELS[item.projectType]}</span>
              </div>
              <p className="hint">
                Updated {new Date(item.updatedAt).toLocaleString()} · version {item.version} · schema{" "}
                {item.schemaVersion}
              </p>
              <div className="button-row">
                <button
                  type="button"
                  onClick={() => void handleOpen(item.id)}
                  disabled={openingId !== null}
                  aria-label={`Open ${item.title}`}
                >
                  {openingId === item.id ? "Opening..." : "Open project"}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
      )}
    </div>
  );
}
