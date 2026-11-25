import { useEffect, useState } from "react";
import type {
  ImageEstimate,
  ImageGenerationInFlightDetails,
  ImageGenerationRecord,
  ImageModelView,
  ImagePendingJob,
  ImageUsageSummary,
} from "../../shared/image-generation-contract";
import type { MediaPlayback, MediaRecord } from "../../shared/media-contract";
import type { ProjectScene } from "../../shared/project-contract";
import {
  AiRequestError,
  attachMediaReference,
  createImageGeneration,
  estimateImageGeneration,
  getImageUsage,
  getMediaPlaybackUrl,
  listImageModels,
  refreshImageGeneration,
  settleImageGeneration,
} from "../api";
import { formatBytes } from "./model";

function toRequestError(cause: unknown): AiRequestError {
  if (cause instanceof AiRequestError) return cause;
  return new AiRequestError(
    "NETWORK_ERROR",
    cause instanceof Error ? cause.message : "The request could not be completed.",
    0,
  );
}

interface GeneratePanelProps {
  projectId: string;
  scenes: ProjectScene[];
  getAccessToken: () => Promise<string>;
  onAttachAsset: (sceneId: string, mediaId: string) => Promise<boolean>;
  onBusyChange?: (busy: boolean) => void;
}

export function GeneratePanel({
  projectId,
  scenes,
  getAccessToken,
  onAttachAsset,
  onBusyChange,
}: GeneratePanelProps) {
  const [models, setModels] = useState<ImageModelView[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelKey, setModelKey] = useState("");
  const [prompt, setPrompt] = useState("");
  const [estimate, setEstimate] = useState<ImageEstimate | null>(null);
  const [usage, setUsage] = useState<ImageUsageSummary | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [generation, setGeneration] = useState<ImageGenerationRecord | null>(null);
  const [media, setMedia] = useState<MediaRecord | null>(null);
  const [playback, setPlayback] = useState<MediaPlayback | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [sceneId, setSceneId] = useState(scenes[0]?.id ?? "");
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState<AiRequestError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [blockedBy, setBlockedBy] = useState<ImagePendingJob | null>(null);
  const [pendingAction, setPendingAction] = useState(false);
  const [pendingNotice, setPendingNotice] = useState<string | null>(null);

  const selectedModel = models?.find((model) => model.key === modelKey) ?? null;
  const canGenerate =
    Boolean(prompt.trim()) && Boolean(selectedModel?.configured) && !generating && Boolean(modelKey);
  const selectedScene = scenes.find((scene) => scene.id === sceneId) ?? null;
  const alreadyAttached = Boolean(media && selectedScene?.assetIds.includes(media.id));
  const scenePrompt = selectedScene
    ? [selectedScene.heading, selectedScene.visualDirection]
        .map((part) => part.trim())
        .filter(Boolean)
        .join(". ")
    : "";

  async function refreshUsage(includePending = false): Promise<void> {
    try {
      const next = await getImageUsage(await getAccessToken());
      setUsage(next.usage);
      // On open, the ledger also tells us about a job left pending elsewhere.
      if (includePending) setBlockedBy(next.pending);
    } catch {
      // The spend line is informational; the guard still enforces the limit.
    }
  }

  useEffect(() => {
    void refreshUsage(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!scenes.some((scene) => scene.id === sceneId)) {
      setSceneId(scenes[0]?.id ?? "");
    }
  }, [scenes, sceneId]);

  useEffect(() => {
    let active = true;
    setModelsError(null);
    (async () => {
      try {
        const next = await listImageModels(await getAccessToken());
        if (!active) return;
        setModels(next);
        setModelKey(next.find((model) => model.configured)?.key ?? next[0]?.key ?? "");
      } catch (cause) {
        if (active) setModelsError(toRequestError(cause).message);
      }
    })();
    return () => {
      active = false;
    };
    // The token helper reads the live session; the project decides the catalog request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // The estimate always comes from the server so the displayed rate is the
  // verified one, never a value recomputed in the browser.
  useEffect(() => {
    const trimmed = prompt.trim();
    if (!modelKey || !trimmed) {
      setEstimate(null);
      setEstimateError(null);
      setEstimating(false);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      setEstimating(true);
      setEstimateError(null);
      (async () => {
        try {
          const next = await estimateImageGeneration(await getAccessToken(), projectId, {
            modelKey,
            prompt: trimmed,
          });
          if (active) setEstimate(next);
        } catch (cause) {
          if (active) {
            setEstimate(null);
            setEstimateError(toRequestError(cause).message);
          }
        } finally {
          if (active) setEstimating(false);
        }
      })();
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, modelKey, prompt]);

  useEffect(() => {
    if (!media || media.status !== "ready") {
      setPlayback(null);
      return;
    }
    let active = true;
    setPreviewError(null);
    (async () => {
      try {
        const next = await getMediaPlaybackUrl(await getAccessToken(), projectId, media.id);
        if (active) setPlayback(next);
      } catch (cause) {
        if (active) setPreviewError(toRequestError(cause).message);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media?.id, media?.status, projectId]);

  function applyResult(next: ImageGenerationRecord, nextMedia: MediaRecord | null): void {
    setGeneration(next);
    setMedia(nextMedia);
    setError(null);
    setBlockedBy(null);
    void refreshUsage();
    if (next.status === "succeeded" && nextMedia) {
      setNotice("Image generated and stored in private media.");
    } else if (next.status === "pending") {
      setPlayback(null);
      setNotice("Generation queued with the provider. Press Refresh job to check it again.");
    } else {
      setNotice("The provider did not finish this generation.");
    }
  }

  async function generate(): Promise<void> {
    if (!canGenerate) return;
    setGenerating(true);
    setError(null);
    setNotice(null);
    setGeneration(null);
    setMedia(null);
    setPlayback(null);
    onBusyChange?.(true);
    try {
      const result = await createImageGeneration(await getAccessToken(), projectId, {
        modelKey,
        prompt: prompt.trim(),
      });
      applyResult(result.generation, result.media);
    } catch (cause) {
      const requestError = toRequestError(cause);
      setError(requestError);
      const details = requestError.details as Partial<ImageGenerationInFlightDetails> | undefined;
      if (requestError.code === "IMAGE_GENERATION_IN_FLIGHT" && details?.pending) {
        setBlockedBy(details.pending);
        setPendingNotice(null);
      }
    } finally {
      setGenerating(false);
      onBusyChange?.(false);
    }
  }

  /** Poll the blocking job through its own project, whichever project that is. */
  async function refreshBlockingJob(): Promise<void> {
    if (!blockedBy || pendingAction) return;
    setPendingAction(true);
    setPendingNotice(null);
    try {
      const result = await refreshImageGeneration(
        await getAccessToken(),
        blockedBy.projectId,
        blockedBy.generationId,
      );
      if (result.generation.status === "pending") {
        setPendingNotice("The job is still running; it will settle automatically after the deadline.");
      } else {
        setBlockedBy(null);
        setPendingNotice(null);
        setNotice(
          result.generation.status === "succeeded"
            ? "The job finished in its own project. You can generate here now."
            : "The job ended without an image. You can generate here now.",
        );
        void refreshUsage();
      }
    } catch (cause) {
      setPendingNotice(toRequestError(cause).message);
    } finally {
      setPendingAction(false);
    }
  }

  async function settleBlockingJob(): Promise<void> {
    if (!blockedBy || pendingAction) return;
    setPendingAction(true);
    setPendingNotice(null);
    try {
      await settleImageGeneration(await getAccessToken(), blockedBy.projectId, blockedBy.generationId);
      setBlockedBy(null);
      setError(null);
      setPendingNotice(null);
      setNotice("The pending job was settled; you can generate here now.");
      void refreshUsage();
    } catch (cause) {
      setPendingNotice(toRequestError(cause).message);
    } finally {
      setPendingAction(false);
    }
  }

  async function refresh(): Promise<void> {
    if (!generation || generation.status !== "pending" || refreshing) return;
    setRefreshing(true);
    setError(null);
    onBusyChange?.(true);
    try {
      const result = await refreshImageGeneration(await getAccessToken(), projectId, generation.id);
      applyResult(result.generation, result.media);
    } catch (cause) {
      setError(toRequestError(cause));
    } finally {
      setRefreshing(false);
      onBusyChange?.(false);
    }
  }

  async function attach(): Promise<void> {
    if (!media || !sceneId || attaching || alreadyAttached) return;
    setAttaching(true);
    setError(null);
    setNotice(null);
    onBusyChange?.(true);
    try {
      const accessToken = await getAccessToken();
      await attachMediaReference(accessToken, projectId, media.id, { refKind: "scene", refId: sceneId });
      const saved = await onAttachAsset(sceneId, media.id);
      const scene = scenes.find((candidate) => candidate.id === sceneId);
      setNotice(
        saved
          ? `Attached to ${scene ? `"${scene.heading}"` : "the selected scene"} and saved.`
          : "Referenced the image, but the project save did not complete. Resolve the save error and retry.",
      );
    } catch (cause) {
      setError(toRequestError(cause));
    } finally {
      setAttaching(false);
      onBusyChange?.(false);
    }
  }

  return (
    <section className="panel editor-panel" aria-labelledby="generate-heading">
      <div className="panel-heading">
        <h2 id="generate-heading">Generate an image</h2>
        <span className="status status-dev">Cloudflare + Leonardo</span>
      </div>
      <p className="muted editor-intro">
        Choose a model, write a prompt, and check the verified cost estimate. Nothing is generated until you press
        Generate; a provider without credentials stays disabled instead of falling back to the other.
      </p>

      {modelsError && (
        <p className="alert" role="alert">
          {modelsError}
        </p>
      )}
      {!models && !modelsError && <p className="muted">Loading image models...</p>}

      <form
        className="generate-form"
        onSubmit={(event) => {
          event.preventDefault();
          void generate();
        }}
      >
        <label className="field" htmlFor="generate-model">
          <span className="field-label">Model</span>
          <select
            id="generate-model"
            value={modelKey}
            onChange={(event) => {
              setModelKey(event.target.value);
              setGeneration(null);
              setMedia(null);
            }}
            disabled={!models || generating}
          >
            {(models ?? []).map((model) => (
              <option key={model.key} value={model.key} disabled={!model.configured}>
                {model.label}
                {model.configured ? "" : " — credentials missing"}
              </option>
            ))}
          </select>
        </label>
        {selectedModel && (
          <p className="hint">
            {selectedModel.provider} · {selectedModel.width}×{selectedModel.height}
            {selectedModel.steps !== null ? ` · ${selectedModel.steps} steps` : ""} · up to{" "}
            {selectedModel.maxPromptChars} characters
          </p>
        )}

        <label className="field" htmlFor="generate-scene-source">
          <span className="field-label">Scene</span>
          <select
            id="generate-scene-source"
            value={sceneId}
            onChange={(event) => setSceneId(event.target.value)}
            disabled={generating}
          >
            <option value="">No scene</option>
            {scenes.map((scene, index) => (
              <option key={scene.id} value={scene.id}>
                Scene {index + 1}: {scene.heading}
              </option>
            ))}
          </select>
        </label>

        <label className="field" htmlFor="generate-prompt">
          <span className="field-label">Prompt</span>
          <textarea
            id="generate-prompt"
            rows={4}
            value={prompt}
            maxLength={selectedModel?.maxPromptChars ?? 2000}
            placeholder="e.g. a lighthouse on a stormy coast at dusk, cinematic wide shot"
            onChange={(event) => setPrompt(event.target.value)}
            disabled={generating}
          />
        </label>
        <p className="hint">
          {prompt.trim().length} / {selectedModel?.maxPromptChars ?? "—"} characters
          {scenePrompt && (
            <>
              {" · "}
              <button
                type="button"
                className="button-secondary button-small"
                onClick={() => setPrompt(scenePrompt.slice(0, selectedModel?.maxPromptChars ?? 2000))}
                disabled={generating}
              >
                Use scene direction
              </button>
            </>
          )}
        </p>

        <div className="editor-actions">
          <button type="submit" disabled={!canGenerate}>
            {generating ? "Generating..." : "Generate image"}
          </button>
          <p className="hint">
            Generate calls exactly the selected provider once. A queued Leonardo job stays pending until you refresh it.
          </p>
        </div>
      </form>

      <div className="generation-estimate" aria-live="polite" aria-label="Estimated cost">
        <span className="field-label">Estimated cost</span>
        {estimating && <p className="hint">Estimating from the verified rate...</p>}
        {estimateError && <p className="alert">{estimateError}</p>}
        {!estimating && !estimateError && !estimate && (
          <p className="hint">Enter a prompt to see the verified cost estimate.</p>
        )}
        {estimate && !estimating && (
          <>
            <p className="generation-cost">
              {estimate.estimatedUsd !== null ? `$${estimate.estimatedUsd.toFixed(6)}` : "API credit"}
            </p>
            <p className="hint">
              {estimate.estimatedNeurons !== null ? `${estimate.estimatedNeurons} neurons · ` : ""}
              {estimate.width}×{estimate.height}
              {estimate.steps !== null ? ` · ${estimate.steps} steps` : " · model default size"} · rates verified{" "}
              {estimate.billing.verifiedOn}
            </p>
            {estimate.billing.note && <p className="hint">{estimate.billing.note}</p>}
            <p className="hint">
              Rate {estimate.rateVersion} ·{" "}
              <a href={estimate.billing.sourceUrl} target="_blank" rel="noreferrer noopener">
                Pricing source
              </a>
            </p>
          </>
        )}
      </div>

      {usage && (
        <p className="hint" aria-label="Daily image spend">
          Last 24 hours: {usage.attempts} generation{usage.attempts === 1 ? "" : "s"} · $
          {usage.spentUsd.toFixed(4)} spent
          {usage.limits.usd !== null ? ` of $${usage.limits.usd.toFixed(2)}` : " (no USD limit set)"}
          {usage.limits.images !== null ? ` · ${usage.limits.images} image limit` : ""}
          {usage.resetAt ? ` · resets ${new Date(usage.resetAt).toLocaleTimeString()}` : ""}
        </p>
      )}

      {blockedBy && (
        <div className="alert" role="alert" aria-label="Pending image job">
          <strong>IMAGE_GENERATION_IN_FLIGHT</strong>
          <p>
            A generation is still pending in project {blockedBy.projectId.slice(0, 8)}
            {blockedBy.jobId ? ` (job ${blockedBy.jobId.slice(0, 8)})` : ""}. It blocks new images for this
            account until it finishes or expires.
          </p>
          <p className="hint">
            Started {new Date(blockedBy.createdAt).toLocaleString()} · {blockedBy.provider} · {blockedBy.modelKey}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="button-secondary button-small"
              onClick={() => void refreshBlockingJob()}
              disabled={pendingAction}
            >
              {pendingAction ? "Checking..." : "Refresh pending job"}
            </button>
            <button
              type="button"
              className="button-secondary button-small"
              onClick={() => void settleBlockingJob()}
              disabled={pendingAction}
            >
              Settle and unblock
            </button>
          </div>
          {pendingNotice && <p className="hint">{pendingNotice}</p>}
        </div>
      )}

      {generation?.status === "pending" && (
        <div className="generation-pending">
          <p className="notice" role="status">
            Generation queued
            {generation.jobId ? ` (job ${generation.jobId.slice(0, 8)})` : ""}. No image exists yet.
          </p>
          <button
            type="button"
            className="button-secondary button-small"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            {refreshing ? "Checking..." : "Refresh job"}
          </button>
        </div>
      )}

      {media && media.status === "ready" && (
        <div className="generation-preview">
          <div className="panel-heading media-heading">
            <h3>Preview</h3>
            <span className="status">ready</span>
          </div>
          {previewError && <p className="alert">{previewError}</p>}
          {!playback && !previewError && <p className="hint">Requesting a private playback link...</p>}
          {playback && (
            <img
              className="media-image generation-image"
              src={playback.url}
              alt={`Generated image: ${generation?.prompt ?? "generated asset"}`}
            />
          )}
          {generation && (
            <p className="hint">
              {generation.modelKey} · {generation.settings.width}×{generation.settings.height}
              {generation.settings.steps !== null ? ` · ${generation.settings.steps} steps` : ""} ·{" "}
              {media.contentType} · {formatBytes(media.byteSize)}
            </p>
          )}

          <label className="field" htmlFor="generate-scene">
            <span className="field-label">Attach to scene</span>
            <select
              id="generate-scene"
              value={sceneId}
              onChange={(event) => setSceneId(event.target.value)}
              disabled={attaching}
            >
              <option value="">Unattached</option>
              {scenes.map((scene, index) => (
                <option key={scene.id} value={scene.id}>
                  Scene {index + 1}: {scene.heading}
                </option>
              ))}
            </select>
          </label>
          <div className="button-row">
            <button
              type="button"
              className="button-secondary button-small"
              onClick={() => void attach()}
              disabled={!sceneId || attaching || alreadyAttached}
            >
              {attaching ? "Attaching..." : "Attach image to scene"}
            </button>
            <button
              type="button"
              className="button-secondary button-small"
              onClick={() => void generate()}
              disabled={!canGenerate}
            >
              Regenerate
            </button>
            {alreadyAttached && <p className="hint">Already attached to this scene.</p>}
          </div>
        </div>
      )}

      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && !blockedBy && (
        <div className="alert" role="alert">
          <strong>{error.code}</strong>
          <p>{error.message}</p>
        </div>
      )}
    </section>
  );
}
