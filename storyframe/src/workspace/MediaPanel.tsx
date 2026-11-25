import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  MediaKind,
  MediaPlayback,
  MediaRecord,
} from "../../shared/media-contract";
import type { ProjectScene } from "../../shared/project-contract";
import {
  STOCK_PROVIDERS,
  type StockProvider,
  type StockResult,
  type StockSearchResponse,
  type StockType,
} from "../../shared/stock-contract";
import {
  AiRequestError,
  attachMediaReference,
  completeMediaUpload,
  deleteMediaRecord,
  deleteMediaReference,
  getMediaPlaybackUrl,
  importStockAsset,
  initiateMediaUpload,
  listMediaReferences,
  listProjectMedia,
  searchStock,
  uploadMediaObject,
} from "../api";
import { formatBytes } from "./model";

const KIND_BY_MIME: { prefix: string; kind: MediaKind }[] = [
  { prefix: "image/", kind: "image" },
  { prefix: "audio/", kind: "audio" },
  { prefix: "video/", kind: "video" },
];

const MAX_BYTES: Record<MediaKind, number> = {
  image: 10 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  video: 200 * 1024 * 1024,
};

function kindFor(contentType: string): MediaKind | null {
  return KIND_BY_MIME.find((entry) => contentType.startsWith(entry.prefix))?.kind ?? null;
}

function toRequestError(cause: unknown): AiRequestError {
  if (cause instanceof AiRequestError) return cause;
  return new AiRequestError(
    "NETWORK_ERROR",
    cause instanceof Error ? cause.message : "The request could not be completed.",
    0,
  );
}

function MediaPlaybackView({
  media,
  projectId,
  getAccessToken,
}: {
  media: MediaRecord;
  projectId: string;
  getAccessToken: () => Promise<string>;
}) {
  const [playback, setPlayback] = useState<MediaPlayback | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (media.status !== "ready") return;
    setLoading(true);
    setError(null);
    try {
      setPlayback(await getMediaPlaybackUrl(await getAccessToken(), projectId, media.id));
    } catch (cause) {
      setError(toRequestError(cause).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (media.status !== "ready") return;
    let active = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const next = await getMediaPlaybackUrl(await getAccessToken(), projectId, media.id);
        if (active) setPlayback(next);
      } catch (cause) {
        if (active) setError(toRequestError(cause).message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // The media id and status decide whether a private playback link is needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.id, media.status, projectId]);

  if (media.status !== "ready") {
    return (
      <p className="hint">
        {media.status === "pending"
          ? "Upload is not complete, so there is nothing to play yet."
          : "This asset was deleted."}
      </p>
    );
  }

  return (
    <div className="media-playback">
      {loading && <p className="hint">Requesting a private playback link...</p>}
      {error && <p className="alert">{error}</p>}
      {playback && (
        <>
          {media.kind === "image" && (
            <img className="media-image" src={playback.url} alt={`Uploaded image ${media.id.slice(0, 8)}`} />
          )}
          {media.kind === "audio" && <audio controls src={playback.url} className="media-audio" />}
          {media.kind === "video" && <video controls src={playback.url} className="media-video" />}
          <p className="hint">
            Private link expires {new Date(playback.expiresAt).toLocaleTimeString()}.
          </p>
        </>
      )}
      <button
        type="button"
        className="button-secondary button-small"
        onClick={load}
        disabled={loading}
      >
        Refresh playback link
      </button>
    </div>
  );
}

interface MediaPanelProps {
  projectId: string;
  scenes: ProjectScene[];
  getAccessToken: () => Promise<string>;
  onAttachAsset: (sceneId: string, mediaId: string) => Promise<boolean>;
  onDetachAsset: (sceneId: string, mediaId: string) => Promise<boolean>;
  onBusyChange?: (busy: boolean) => void;
}

export function MediaPanel({
  projectId,
  scenes,
  getAccessToken,
  onAttachAsset,
  onDetachAsset,
  onBusyChange,
}: MediaPanelProps) {
  const [media, setMedia] = useState<MediaRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sceneId, setSceneId] = useState(scenes[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<AiRequestError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [stockQuery, setStockQuery] = useState("");
  const [stockType, setStockType] = useState<StockType>("image");
  const [stockSources, setStockSources] = useState<Record<StockProvider, boolean>>({
    pexels: true,
    pixabay: true,
  });
  const [stock, setStock] = useState<StockSearchResponse | null>(null);
  const [stockError, setStockError] = useState<string | null>(null);
  const [stockNotice, setStockNotice] = useState<string | null>(null);
  const [stockSearching, setStockSearching] = useState(false);
  const [stockLoadingMore, setStockLoadingMore] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);

  useEffect(() => {
    if (!scenes.some((scene) => scene.id === sceneId)) {
      setSceneId(scenes[0]?.id ?? "");
    }
  }, [scenes, sceneId]);

  useEffect(() => {
    let active = true;
    setLoadError(null);
    (async () => {
      try {
        const list = await listProjectMedia(await getAccessToken(), projectId);
        if (active) setMedia(list);
      } catch (cause) {
        if (active) setLoadError(toRequestError(cause).message);
      }
    })();
    return () => {
      active = false;
    };
    // Loading is tied to the project; the token helper reads the live session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || uploading) return;

    const kind = kindFor(file.type);
    setError(null);
    setNotice(null);
    if (!kind) {
      setError(
        new AiRequestError(
          "INVALID_MEDIA_TYPE",
          "Choose an image, audio, or video file. Other file types are refused.",
          400,
        ),
      );
      return;
    }
    if (file.size > MAX_BYTES[kind]) {
      setError(
        new AiRequestError(
          "MEDIA_TOO_LARGE",
          `${kind} files may be at most ${formatBytes(MAX_BYTES[kind])}.`,
          400,
        ),
      );
      return;
    }

    setUploading(true);
    onBusyChange?.(true);
    try {
      const accessToken = await getAccessToken();
      // The scene link is the explicit reference below. Sending `sceneKey` too
      // would make the media store count the same scene twice and refuse deletion.
      const initiation = await initiateMediaUpload(accessToken, projectId, {
        kind,
        contentType: file.type,
        byteSize: file.size,
      });
      setMedia((current) => [initiation.media, ...(current ?? [])]);

      // The browser sends the bytes straight to private storage. It never sees a
      // storage credential, only this short-lived presigned ticket.
      await uploadMediaObject(initiation.upload, file);
      const completed = await completeMediaUpload(accessToken, projectId, initiation.media.id);
      setMedia((current) =>
        (current ?? []).map((item) => (item.id === completed.id ? completed : item)),
      );

      if (sceneId) {
        const reference = await attachMediaReference(accessToken, projectId, completed.id, {
          refKind: "scene",
          refId: sceneId,
        });
        setMedia((current) =>
          (current ?? []).map((item) =>
            item.id === completed.id
              ? { ...item, referenceCount: item.referenceCount + 1 }
              : item,
          ),
        );
        const saved = await onAttachAsset(sceneId, completed.id);
        const scene = scenes.find((candidate) => candidate.id === sceneId);
        setNotice(
          saved
            ? `Uploaded, completed, and attached to ${scene ? `"${scene.heading}"` : "the selected scene"}. The saved scene now lists this asset.`
            : `Uploaded and referenced (reference ${reference.id.slice(0, 8)}), but the project save did not complete. The draft still lists the asset; resolve the save error and retry.`,
        );
      } else {
        setNotice("Uploaded and completed. It is not attached to a scene yet.");
      }

      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
    } catch (cause) {
      setError(toRequestError(cause));
    } finally {
      setUploading(false);
      onBusyChange?.(false);
    }
  }

  const selectedSources = STOCK_PROVIDERS.filter((provider) => stockSources[provider]);

  async function handleStockSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = stockQuery.trim();
    if (!query || selectedSources.length === 0 || stockSearching) return;

    setStockSearching(true);
    setStockError(null);
    setStockNotice(null);
    onBusyChange?.(true);
    try {
      setStock(
        await searchStock(await getAccessToken(), { query, type: stockType, sources: selectedSources }),
      );
    } catch (cause) {
      setStockError(toRequestError(cause).message);
    } finally {
      setStockSearching(false);
      onBusyChange?.(false);
    }
  }

  async function loadMoreStock() {
    if (!stock || stockSearching || stockLoadingMore) return;
    // Page forward on the search that produced these results, not on whatever
    // the form now holds: the query may have been edited after searching.
    const requested = {
      query: stock.query,
      type: stock.type,
      sources: stock.sources,
      page: stock.page + 1,
    };
    setStockLoadingMore(true);
    setStockError(null);
    onBusyChange?.(true);
    try {
      const next = await searchStock(await getAccessToken(), requested);
      setStock((current) => {
        if (!current || current.query !== requested.query || current.type !== requested.type) {
          return current;
        }
        const seen = new Set(current.results.map((result) => `${result.provider}:${result.providerId}`));
        const added = next.results.filter(
          (result) => !seen.has(`${result.provider}:${result.providerId}`),
        );
        return { ...next, results: [...current.results, ...added] };
      });
    } catch (cause) {
      setStockError(toRequestError(cause).message);
    } finally {
      setStockLoadingMore(false);
      onBusyChange?.(false);
    }
  }

  async function importResult(result: StockResult) {
    const rendition =
      result.renditions.find((entry) => entry.label === result.selectedRendition) ?? result.renditions[0];
    if (!rendition) return;

    const key = `${result.provider}:${result.providerId}`;
    setImportingId(key);
    setStockError(null);
    setStockNotice(null);
    onBusyChange?.(true);
    try {
      const accessToken = await getAccessToken();
      const imported = await importStockAsset(accessToken, projectId, {
        provider: result.provider,
        providerId: result.providerId,
        type: result.type,
        rendition: rendition.label,
        url: rendition.url,
        sourcePage: result.sourcePage,
        creator: result.creator,
        attribution: result.attribution,
        license: result.license,
      });
      setMedia((current) => {
        const list = current ?? [];
        return list.some((item) => item.id === imported.media.id)
          ? list.map((item) => (item.id === imported.media.id ? imported.media : item))
          : [imported.media, ...list];
      });

      if (imported.reused) {
        setStockNotice(
          `This ${result.type} is already in the project (media ${imported.media.id.slice(0, 8)}); nothing was downloaded again. Attach it from Project media.`,
        );
      } else if (sceneId) {
        await attachMediaReference(accessToken, projectId, imported.media.id, {
          refKind: "scene",
          refId: sceneId,
        });
        const saved = await onAttachAsset(sceneId, imported.media.id);
        setMedia((current) =>
          (current ?? []).map((item) =>
            item.id === imported.media.id ? { ...item, referenceCount: item.referenceCount + 1 } : item,
          ),
        );
        const scene = scenes.find((candidate) => candidate.id === sceneId);
        setStockNotice(
          saved
            ? `Imported ${result.attribution} and attached it to ${scene ? `\"${scene.heading}\"` : "the selected scene"}.`
            : `Imported ${result.attribution} and referenced it, but the project save did not complete. Resolve the save error and retry the attach.`,
        );
      } else {
        setStockNotice(`Imported ${result.attribution}. It is in the project, not attached to a scene yet.`);
      }
    } catch (cause) {
      setStockError(toRequestError(cause).message);
    } finally {
      setImportingId(null);
      onBusyChange?.(false);
    }
  }

  return (
    <section className="panel editor-panel" aria-labelledby="media-heading">
      <div className="panel-heading">
        <h2 id="media-heading">Media</h2>
        <span className="status status-dev">Private R2</span>
      </div>
      <p className="muted editor-intro">
        Files upload directly to private storage with a presigned ticket, then the server verifies and records them.
        Playback links are fetched fresh and expire quickly; nothing here is public.
      </p>

      <div className="panel-heading media-heading">
        <h3>Find stock media</h3>
        <span className="status status-dev">Pexels + Pixabay</span>
      </div>
      <p className="hint">
        Searches go to the providers you select. Results below are previews with credit; nothing joins the project
        until you import it, and import downloads the selected rendition through the server.
      </p>

      <form className="stock-search-form" onSubmit={handleStockSearch}>
        <label className="field" htmlFor="stock-query">
          <span className="field-label">Stock search</span>
          <input
            id="stock-query"
            type="search"
            value={stockQuery}
            placeholder="e.g. rainy city street"
            onChange={(event) => setStockQuery(event.target.value)}
            disabled={stockSearching}
          />
        </label>

        <label className="field" htmlFor="stock-type">
          <span className="field-label">Type</span>
          <select
            id="stock-type"
            value={stockType}
            onChange={(event) => setStockType(event.target.value as StockType)}
            disabled={stockSearching}
          >
            <option value="image">Images</option>
            <option value="video">Videos</option>
          </select>
        </label>

        <fieldset className="field stock-sources">
          <legend className="field-label">Sources</legend>
          {STOCK_PROVIDERS.map((provider) => (
            <label key={provider} htmlFor={`stock-source-${provider}`}>
              <input
                id={`stock-source-${provider}`}
                type="checkbox"
                checked={stockSources[provider]}
                onChange={(event) =>
                  setStockSources((current) => ({ ...current, [provider]: event.target.checked }))
                }
                disabled={stockSearching}
              />
              {provider === "pexels" ? "Pexels" : "Pixabay"}
            </label>
          ))}
        </fieldset>

        <div className="editor-actions">
          <button type="submit" disabled={stockSearching || !stockQuery.trim() || selectedSources.length === 0}>
            {stockSearching ? "Searching..." : "Search stock"}
          </button>
          <p className="hint">
            Pagination applies to each provider, then pages are merged. One provider can fail without hiding the
            other&apos;s results.
          </p>
        </div>
      </form>

      {stockError && (
        <p className="alert" role="alert">
          {stockError}
        </p>
      )}
      {stockNotice && (
        <p className="notice" role="status">
          {stockNotice}
        </p>
      )}

      {stock && (
        <div className="stock-results-block">
          <div className="panel-heading media-heading">
            <h3>Previews</h3>
            <span className="status">{stock.results.length}</span>
          </div>
          {stock.providers.some((provider) => !provider.ok) && (
            <p className="hint">
              {stock.providers
                .filter((provider) => !provider.ok)
                .map((provider) => `${provider.provider} unavailable (${provider.error ?? "unknown"})`)
                .join(" · ")}
            </p>
          )}
          {stock.results.length === 0 && (
            <p className="empty-state">No {stock.type === "image" ? "images" : "videos"} matched. Try another query.</p>
          )}
          <ul className="stock-results">
            {stock.results.map((result) => {
              const key = `${result.provider}:${result.providerId}`;
              return (
                <li className="stock-result" key={key}>
                  <div className="stock-thumb">
                    <img src={result.previewUrl} alt={result.title} loading="lazy" />
                    <span className="status">{result.providerName}</span>
                  </div>
                  <div className="stock-result-body">
                    <p className="stock-title">{result.title}</p>
                    <p className="hint">
                      {result.type === "image" ? "Image" : "Video"} · {result.width}×{result.height}
                      {result.durationSeconds !== null ? ` · ${Math.round(result.durationSeconds)}s` : ""} ·{" "}
                      {result.selectedRendition}
                    </p>
                    <p className="stock-credit">
                      <a href={result.sourcePage} target="_blank" rel="noreferrer noopener">
                        {result.attribution}
                      </a>
                      {" · "}
                      <a href={result.licenseUrl} target="_blank" rel="noreferrer noopener">
                        {result.license}
                      </a>
                    </p>
                    <button
                      type="button"
                      className="button-secondary button-small"
                      onClick={() => void importResult(result)}
                      disabled={importingId !== null}
                    >
                      {importingId === key ? "Importing..." : "Import to project"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {stock.providers.some((provider) => provider.hasMore) && (
            <div className="editor-actions">
              <button
                type="button"
                className="button-secondary"
                onClick={() => void loadMoreStock()}
                disabled={stockSearching || stockLoadingMore}
              >
                {stockLoadingMore ? "Loading more..." : `Load more (page ${stock.page + 1})`}
              </button>
              <p className="hint">
                Requests page {stock.page + 1} from each provider that still has results, then merges the new pages
                and skips assets already shown.
              </p>
            </div>
          )}
        </div>
      )}

      <div className="panel-heading media-heading">
        <h3>Upload a file</h3>
      </div>

      <form className="upload-form" onSubmit={handleUpload}>
        <label className="field" htmlFor="media-file">
          <span className="field-label">Media file</span>
          <input
            id="media-file"
            ref={fileInput}
            type="file"
            accept="image/*,audio/*,video/*"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            disabled={uploading}
          />
          <span className="hint">Image up to 10 MiB, audio 25 MiB, video 200 MiB.</span>
        </label>

        <label className="field" htmlFor="media-scene">
          <span className="field-label">Attach to scene</span>
          <select
            id="media-scene"
            value={sceneId}
            onChange={(event) => setSceneId(event.target.value)}
            disabled={uploading}
          >
            <option value="">Unattached</option>
            {scenes.map((scene, index) => (
              <option key={scene.id} value={scene.id}>
                Scene {index + 1}: {scene.heading}
              </option>
            ))}
          </select>
        </label>

        <div className="editor-actions">
          <button type="submit" disabled={!file || uploading}>
            {uploading ? "Uploading..." : "Upload media"}
          </button>
          <p className="hint">
            Upload, completion, scene reference, and the saved asset id all happen in one action.
          </p>
        </div>
      </form>

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

      <div className="panel-heading media-heading">
        <h3>Project media</h3>
        {media && <span className="status">{media.length}</span>}
      </div>

      {!media && !loadError && <p className="muted">Loading media records...</p>}
      {loadError && <p className="alert">{loadError}</p>}
      {media && media.length === 0 && (
        <p className="empty-state">No media yet. Upload an image, audio clip, or video for a scene.</p>
      )}

      <div className="media-list">
        {media?.map((item) => (
          <MediaItem
            key={item.id}
            media={item}
            projectId={projectId}
            scenes={scenes}
            getAccessToken={getAccessToken}
            onDetachAsset={onDetachAsset}
            onDeleted={(id) => setMedia((current) => (current ?? []).filter((record) => record.id !== id))}
            onReferenceReleased={(id) =>
              setMedia((current) =>
                (current ?? []).map((record) =>
                  record.id === id
                    ? { ...record, referenceCount: Math.max(0, record.referenceCount - 1) }
                    : record,
                ),
              )
            }
          />
        ))}
      </div>
    </section>
  );
}

function providerName(provider: "pexels" | "pixabay"): string {
  return provider === "pexels" ? "Pexels" : "Pixabay";
}

function MediaItem({
  media,
  projectId,
  scenes,
  getAccessToken,
  onDetachAsset,
  onDeleted,
  onReferenceReleased,
}: {
  media: MediaRecord;
  projectId: string;
  scenes: ProjectScene[];
  getAccessToken: () => Promise<string>;
  onDetachAsset: (sceneId: string, mediaId: string) => Promise<boolean>;
  onDeleted: (id: string) => void;
  onReferenceReleased: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [detachingId, setDetachingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const attached = scenes
    .map((scene, index) => ({ scene, index }))
    .filter(({ scene }) => scene.assetIds.includes(media.id));
  // After a failed detach save the reference is gone but the stored document
  // still lists the asset. Deleting then would leave a dangling asset id, so
  // require the retry to save the removal first.
  const canDelete = !(attached.length > 0 && media.referenceCount === 0);

  async function detach(sceneId: string, index: number) {
    setDetachingId(sceneId);
    setError(null);
    setNotice(null);
    try {
      const accessToken = await getAccessToken();
      const references = await listMediaReferences(accessToken, projectId, media.id);
      const reference = references.find((item) => item.refKind === "scene" && item.refId === sceneId);
      if (reference) {
        try {
          await deleteMediaReference(accessToken, projectId, media.id, reference.id);
        } catch (cause) {
          // A concurrent attempt may have released it first; the save below is
          // still the step that makes the document match.
          if (!(cause instanceof AiRequestError && cause.code === "MEDIA_REFERENCE_NOT_FOUND")) {
            throw cause;
          }
        }
      }
      const saved = await onDetachAsset(sceneId, media.id);
      onReferenceReleased(media.id);
      setNotice(
        saved
          ? `Detached from scene ${index + 1} and saved. Delete asset is now available.`
          : "The reference was released, but the project save did not complete. Fix the save error and press Detach again; the missing reference will not block the retry.",
      );
    } catch (cause) {
      setError(toRequestError(cause).message);
    } finally {
      setDetachingId(null);
    }
  }

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      await deleteMediaRecord(await getAccessToken(), projectId, media.id);
      onDeleted(media.id);
    } catch (cause) {
      setError(toRequestError(cause).message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <article className="media-item" aria-label={`Media ${media.id}`}>
      <div className="media-item-header">
        <div>
          <span className="status">{media.kind}</span>{" "}
          <span className="status">{media.status}</span>
          <p className="hint">
            {media.contentType} · {formatBytes(media.byteSize)} · {media.referenceCount} reference
            {media.referenceCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="button-row">
          {!confirming ? (
            <button
              type="button"
              className="button-secondary button-small button-danger"
              onClick={() => setConfirming(true)}
              disabled={deleting || !canDelete}
              title={
                canDelete
                  ? undefined
                  : "The saved document still lists this asset. Press Detach again to save the removal before deleting."
              }
            >
              Delete asset
            </button>
          ) : (
            <>
              <button
                type="button"
                className="button-secondary button-small button-danger"
                onClick={remove}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Confirm delete"}
              </button>
              <button
                type="button"
                className="button-secondary button-small"
                onClick={() => setConfirming(false)}
                disabled={deleting}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {media.provenance && (
        <div className="media-provenance">
          <span className="field-label">Stock provenance</span>
          <p className="stock-credit">
            <span className="status">{providerName(media.provenance.provider)}</span>{" "}
            <span>{media.provenance.creator}</span>{" · "}
            <a href={media.provenance.sourcePage} target="_blank" rel="noreferrer noopener">
              Source on {providerName(media.provenance.provider)}
            </a>
            {" · "}
            <span>{media.provenance.license}</span>
          </p>
        </div>
      )}

      {attached.length > 0 && (
        <div className="media-attachments">
          <span className="field-label">Attached to</span>
          <ul>
            {attached.map(({ scene, index }) => (
              <li key={scene.id}>
                <span>
                  Scene {index + 1}: {scene.heading}
                </span>
                <button
                  type="button"
                  className="button-secondary button-small"
                  onClick={() => void detach(scene.id, index)}
                  disabled={detachingId !== null || deleting}
                  aria-label={`Detach media from scene ${index + 1}`}
                >
                  {detachingId === scene.id ? "Detaching..." : "Detach"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <MediaPlaybackView media={media} projectId={projectId} getAccessToken={getAccessToken} />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && <p className="alert">{error}</p>}
    </article>
  );
}
