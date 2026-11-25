import { useEffect, useState } from "react";
import type { SourceKind, SourceRecord } from "../../shared/child-contract";
import {
  AiRequestError,
  createProjectSource,
  deleteProjectSource,
  listProjectSources,
} from "../api";

interface SourcesPanelProps {
  projectId: string;
  getAccessToken: () => Promise<string>;
  onBusyChange?: (busy: boolean) => void;
}

const SOURCE_KINDS: { value: SourceKind; label: string }[] = [
  { value: "web", label: "Web page" },
  { value: "document", label: "Document" },
  { value: "interview", label: "Interview / transcript" },
  { value: "other", label: "Other" },
];

const EXCERPT_MAX = 4000;

function toRequestError(cause: unknown): AiRequestError {
  if (cause instanceof AiRequestError) return cause;
  return new AiRequestError(
    "NETWORK_ERROR",
    cause instanceof Error ? cause.message : "The request could not be completed.",
    0,
  );
}

export function SourcesPanel({ projectId, getAccessToken, onBusyChange }: SourcesPanelProps) {
  const [sources, setSources] = useState<SourceRecord[] | null>(null);
  const [kind, setKind] = useState<SourceKind>("web");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<AiRequestError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const busy = adding || deletingId !== null;

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await listProjectSources(await getAccessToken(), projectId);
        if (active) setSources(list);
      } catch (cause) {
        if (active) setError(toRequestError(cause));
      }
    })();
    return () => {
      active = false;
    };
    // The list is tied to the project; token changes are handled by the helper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleAdd() {
    if (adding || title.trim().length === 0) return;
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const created = await createProjectSource(await getAccessToken(), projectId, {
        kind,
        title: title.trim(),
        url: url.trim().length > 0 ? url.trim() : null,
        excerpt: excerpt.trim().length > 0 ? excerpt.trim() : null,
      });
      setSources((current) => [...(current ?? []), created]);
      setTitle("");
      setUrl("");
      setExcerpt("");
      setNotice(
        created.excerpt
          ? "Source added. Factual planning can now quote this excerpt."
          : "Source added without an excerpt; factual planning will not treat it as evidence.",
      );
    } catch (cause) {
      setError(toRequestError(cause));
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(source: SourceRecord) {
    if (deletingId) return;
    setDeletingId(source.id);
    setError(null);
    setNotice(null);
    try {
      await deleteProjectSource(await getAccessToken(), projectId, source.id);
      setSources((current) => (current ?? []).filter((item) => item.id !== source.id));
      setNotice("Source deleted. Any claims that quoted it were removed with it.");
    } catch (cause) {
      setError(toRequestError(cause));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="panel editor-panel" aria-labelledby="sources-heading">
      <div className="panel-heading">
        <h2 id="sources-heading">Sources</h2>
        <span className="status">{sources ? `${sources.length} source${sources.length === 1 ? "" : "s"}` : "Loading"}</span>
      </div>
      <p className="muted editor-intro">
        Add the exact passage planning may quote. Factual planning uses only these excerpts; a source without one is
        listed but never treated as evidence, and planning returns notes instead of inventing a sourced script.
      </p>

      <div className="sources-form">
        <label className="field" htmlFor="source-kind">
          <span className="field-label">Kind</span>
          <select
            id="source-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as SourceKind)}
            disabled={busy}
          >
            {SOURCE_KINDS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field" htmlFor="source-title">
          <span className="field-label">Title</span>
          <input
            id="source-title"
            value={title}
            maxLength={300}
            onChange={(event) => setTitle(event.target.value)}
            disabled={busy}
            placeholder="Ridership report"
          />
        </label>

        <label className="field" htmlFor="source-url">
          <span className="field-label">URL (optional)</span>
          <input
            id="source-url"
            value={url}
            maxLength={2048}
            onChange={(event) => setUrl(event.target.value)}
            disabled={busy}
            placeholder="https://example.com/report"
          />
        </label>

        <label className="field" htmlFor="source-excerpt">
          <span className="field-label">Excerpt (optional)</span>
          <textarea
            id="source-excerpt"
            rows={4}
            maxLength={EXCERPT_MAX}
            value={excerpt}
            onChange={(event) => setExcerpt(event.target.value)}
            disabled={busy}
            placeholder="City ridership rose 12 percent in 2025."
          />
          <span className="hint">
            {excerpt.length}/{EXCERPT_MAX} characters. Quotes in planning must copy this passage word for word.
          </span>
        </label>

        <div className="editor-actions">
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={busy || title.trim().length === 0}
          >
            {adding ? "Adding..." : "Add source"}
          </button>
        </div>
      </div>

      {error && (
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

      <h3>Supplied sources</h3>
      {!sources && !error && <p className="muted">Loading sources...</p>}
      {sources && sources.length === 0 && <p className="empty-state">No sources yet.</p>}
      <ul className="source-list">
        {(sources ?? []).map((source) => (
          <li key={source.id} className="source-card">
            <div className="source-card-header">
              <div>
                <strong>{source.title}</strong>{" "}
                <span className="hint">{SOURCE_KINDS.find((item) => item.value === source.kind)?.label ?? source.kind}</span>
              </div>
              <button
                type="button"
                className="button-secondary button-small"
                onClick={() => void handleDelete(source)}
                disabled={busy}
                aria-label={`Delete source ${source.title}`}
              >
                {deletingId === source.id ? "Deleting..." : "Delete"}
              </button>
            </div>
            {source.url && (
              <p className="hint">
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.url}
                </a>
              </p>
            )}
            {source.excerpt ? (
              <p className="source-excerpt">{source.excerpt}</p>
            ) : (
              <p className="hint">No excerpt supplied; not usable as evidence.</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
