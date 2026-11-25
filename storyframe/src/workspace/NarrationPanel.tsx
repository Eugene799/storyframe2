import { useEffect, useRef, useState } from "react";
import type {
  NarrationKind,
  NarrationStateResponse,
  NarrationTrack,
  NarrationVoiceCatalogResponse,
} from "../../shared/narration-contract";
import type { MediaPlayback } from "../../shared/media-contract";
import {
  AiRequestError,
  attachAudioTrack,
  completeMediaUpload,
  generateNarration,
  getMediaPlaybackUrl,
  getNarrationState,
  initiateMediaUpload,
  listNarrationVoices,
  previewNarrationVoice,
  removeAudioTrack,
  updateAudioSettings,
  uploadMediaObject,
} from "../api";
import { formatBytes } from "./model";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
]);
const AUDIO_TYPE_ALIASES: Record<string, string> = {
  "audio/mp3": "audio/mpeg",
  "audio/x-mp3": "audio/mpeg",
  "audio/wave": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-aac": "audio/aac",
  "audio/x-ogg": "audio/ogg",
};
const AUDIO_EXTENSION_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
};

/** Browsers can omit or alias the MIME type; the server still checks the bytes. */
function audioContentType(file: File): string | null {
  const declared = file.type.trim().toLowerCase().split(";")[0].trim();
  const normalized = AUDIO_TYPE_ALIASES[declared] ?? declared;
  if (AUDIO_TYPES.has(normalized)) return normalized;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTENSION_TYPES[extension] ?? null;
}

function toRequestError(cause: unknown): AiRequestError {
  if (cause instanceof AiRequestError) return cause;
  return new AiRequestError(
    "NETWORK_ERROR",
    cause instanceof Error ? cause.message : "The request could not be completed.",
    0,
  );
}

function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

function seconds(value: number): string {
  return `${value.toFixed(2)}s`;
}

interface NarrationPanelProps {
  projectId: string;
  getAccessToken: () => Promise<string>;
  onBusyChange?: (busy: boolean) => void;
}

export function NarrationPanel({ projectId, getAccessToken, onBusyChange }: NarrationPanelProps) {
  const [catalog, setCatalog] = useState<NarrationVoiceCatalogResponse | null>(null);
  const [state, setState] = useState<NarrationStateResponse | null>(null);
  const [voiceModel, setVoiceModel] = useState("");
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [error, setError] = useState<AiRequestError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [uploading, setUploading] = useState<NarrationKind | null>(null);
  const [removing, setRemoving] = useState<NarrationKind | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<NarrationKind | null>(null);
  const [volumes, setVolumes] = useState<{ narration: number; music: number }>({
    narration: 1,
    music: 1,
  });
  const [playback, setPlayback] = useState<{ narration: MediaPlayback | null; music: MediaPlayback | null }>({
    narration: null,
    music: null,
  });
  const narrationFile = useRef<HTMLInputElement>(null);
  const musicFile = useRef<HTMLInputElement>(null);

  async function refresh(): Promise<void> {
    try {
      const next = await getNarrationState(await getAccessToken(), projectId);
      setState(next);
      setVolumes({
        narration: next.narration?.volume ?? 1,
        music: next.music?.volume ?? 1,
      });
    } catch (cause) {
      setLoadingError(toRequestError(cause).message);
    }
  }

  useEffect(() => {
    let active = true;
    setLoadingError(null);
    (async () => {
      try {
        const [voices, next] = await Promise.all([
          listNarrationVoices(await getAccessToken()),
          getNarrationState(await getAccessToken(), projectId),
        ]);
        if (!active) return;
        setCatalog(voices);
        setVoiceModel(voices.voices[0]?.model ?? "");
        setState(next);
        setVolumes({
          narration: next.narration?.volume ?? 1,
          music: next.music?.volume ?? 1,
        });
      } catch (cause) {
        if (active) setLoadingError(toRequestError(cause).message);
      }
    })();
    return () => {
      active = false;
    };
    // The token helper reads the live session; playback is loaded separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    let active = true;
    const ids = {
      narration: state?.narration?.mediaId ?? null,
      music: state?.music?.mediaId ?? null,
    };
    (async () => {
      const next: { narration: MediaPlayback | null; music: MediaPlayback | null } = {
        narration: null,
        music: null,
      };
      for (const kind of ["narration", "music"] as const) {
        const mediaId = ids[kind];
        if (!mediaId) continue;
        try {
          next[kind] = await getMediaPlaybackUrl(await getAccessToken(), projectId, mediaId);
        } catch {
          next[kind] = null;
        }
      }
      if (active) setPlayback(next);
    })();
    return () => {
      active = false;
    };
    // A new active media id is what needs a fresh private URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, state?.narration?.mediaId, state?.music?.mediaId]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function preview(): Promise<void> {
    if (!voiceModel || previewing) return;
    setPreviewing(true);
    setError(null);
    setNotice(null);
    onBusyChange?.(true);
    try {
      const blob = await previewNarrationVoice(await getAccessToken(), projectId, voiceModel);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
      void refresh();
    } catch (cause) {
      setError(toRequestError(cause));
    } finally {
      setPreviewing(false);
      onBusyChange?.(false);
    }
  }

  async function generate(): Promise<void> {
    if (!voiceModel || generating) return;
    setGenerating(true);
    setError(null);
    setNotice(null);
    onBusyChange?.(true);
    try {
      const result = await generateNarration(await getAccessToken(), projectId, voiceModel);
      setNotice(
        `Narration saved with ${result.track.voiceName ?? "the selected voice"} · ${seconds(
          result.track.durationSeconds ?? 0,
        )} measured.`,
      );
      await refresh();
    } catch (cause) {
      setError(toRequestError(cause));
    } finally {
      setGenerating(false);
      onBusyChange?.(false);
    }
  }

  async function upload(file: File | null, kind: NarrationKind): Promise<void> {
    if (!file || uploading) return;
    setError(null);
    setNotice(null);
    const contentType = audioContentType(file);
    if (!contentType) {
      setError(
        new AiRequestError(
          "INVALID_AUDIO_TYPE",
          "Choose an MP3, WAV, OGG, M4A, or AAC audio file for narration or music.",
          400,
        ),
      );
      return;
    }
    if (file.size <= 0) {
      setError(new AiRequestError("INVALID_AUDIO_TYPE", "The selected audio file is empty.", 400));
      return;
    }
    if (file.size > MAX_AUDIO_BYTES) {
      setError(
        new AiRequestError(
          "MEDIA_TOO_LARGE",
          `Audio files may be at most ${formatBytes(MAX_AUDIO_BYTES)}.`,
          400,
        ),
      );
      return;
    }
    setUploading(kind);
    onBusyChange?.(true);
    try {
      const accessToken = await getAccessToken();
      const initiation = await initiateMediaUpload(accessToken, projectId, {
        kind: "audio",
        contentType,
        byteSize: file.size,
      });
      await uploadMediaObject(initiation.upload, file);
      const completed = await completeMediaUpload(accessToken, projectId, initiation.media.id);
      const attached = await attachAudioTrack(accessToken, projectId, kind, completed.id);
      setNotice(
        `${kind === "music" ? "Music" : "Narration"} saved from the uploaded file · ${seconds(
          attached.track.durationSeconds ?? 0,
        )} measured.`,
      );
      await refresh();
    } catch (cause) {
      setError(toRequestError(cause));
    } finally {
      setUploading(null);
      if (kind === "music" && musicFile.current) musicFile.current.value = "";
      if (kind === "narration" && narrationFile.current) narrationFile.current.value = "";
      onBusyChange?.(false);
    }
  }

  async function saveSettings(
    kind: NarrationKind,
    patch: { volume?: number; muted?: boolean },
  ): Promise<void> {
    setError(null);
    try {
      const result = await updateAudioSettings(await getAccessToken(), projectId, kind, patch);
      setState((current) =>
        current
          ? {
              ...current,
              [kind]: result.track,
            }
          : current,
      );
      if (patch.volume !== undefined) {
        setVolumes((current) => ({ ...current, [kind]: result.track.volume }));
      }
    } catch (cause) {
      setError(toRequestError(cause));
      await refresh();
    }
  }

  async function remove(kind: NarrationKind): Promise<void> {
    setRemoving(kind);
    setError(null);
    setNotice(null);
    onBusyChange?.(true);
    try {
      await removeAudioTrack(await getAccessToken(), projectId, kind);
      setConfirmRemove(null);
      setNotice(`${kind === "music" ? "Music" : "Narration"} removed from this project.`);
      await refresh();
    } catch (cause) {
      setError(toRequestError(cause));
    } finally {
      setRemoving(null);
      onBusyChange?.(false);
    }
  }

  const script = state?.script ?? null;
  const estimate = script ? (script.characters / 1000) * (state?.limits.usdPer1kChars ?? 0) : null;

  if (!state && !loadingError) {
    return <p className="muted">Loading narration...</p>;
  }

  return (
    <section className="panel editor-panel" aria-labelledby="narration-heading">
      <div className="panel-heading">
        <h2 id="narration-heading">Narration</h2>
        <span className="status status-dev">Deepgram Aura-2</span>
      </div>
      <p className="muted editor-intro">
        Generate speech from the approved script or upload your own narration. Audio is stored privately in R2, and its
        real container duration is measured. This phase does not create word-level subtitle timings.
      </p>

      {loadingError && <p className="alert">{loadingError}</p>}

      {state && (
        <p className="hint" aria-label="Daily narration spend">
          Last 24 hours: {state.usage.previews} sample{state.usage.previews === 1 ? "" : "s"} ·{" "}
          {state.usage.generations} narration generation{state.usage.generations === 1 ? "" : "s"} ·{" "}
          {state.usage.characters} characters · ${state.usage.spentUsd.toFixed(4)} spent
          {state.usage.limits.characters !== null
            ? ` of ${state.usage.limits.characters} characters`
            : " (no character limit set)"}
          {state.usage.limits.usd !== null ? ` · $${state.usage.limits.usd.toFixed(2)} limit` : ""}
          {state.usage.resetAt ? ` · resets ${new Date(state.usage.resetAt).toLocaleTimeString()}` : ""}
        </p>
      )}

      {state && (
        <>
          {!catalog?.configured && (
            <p className="alert">
              Deepgram narration is disabled until <code>DEEPGRAM_API_KEY</code> is configured on the server.
            </p>
          )}

          {state.scriptBlocked && (
            <p className="alert" role="status">
              {state.scriptBlocked}
            </p>
          )}

          {script && (
            <p className="hint">
              Approved script: {script.sceneCount} scene{script.sceneCount === 1 ? "" : "s"} ·{" "}
              {script.characters} / {state.limits.maxChars} characters · target {seconds(script.targetSeconds)} ·{" "}
              {estimate !== null ? `${usd(estimate)} at ${usd(state.limits.usdPer1kChars)}/1k characters` : ""}
            </p>
          )}

          {state.stale && (
            <div className="alert" role="status">
              <strong>NARRATION_STALE</strong>
              <p>
                The script changed after this narration was made. The audio was not regenerated and may not match the
                current words.
              </p>
            </div>
          )}

          <div className="narration-generate">
            <label className="field" htmlFor="narration-voice">
              <span className="field-label">Voice</span>
              <select
                id="narration-voice"
                value={voiceModel}
                onChange={(event) => setVoiceModel(event.target.value)}
                disabled={!catalog || generating}
              >
                {(catalog?.voices ?? []).map((voice) => (
                  <option key={voice.model} value={voice.model}>
                    {voice.name} · {voice.gender} · {voice.accent} · {voice.characteristics}
                  </option>
                ))}
              </select>
            </label>
            <div className="button-row">
              <button
                type="button"
                className="button-secondary button-small"
                onClick={() => void preview()}
                disabled={!voiceModel || previewing || !catalog?.configured}
              >
                {previewing ? "Loading sample..." : "Preview voice"}
              </button>
              <button
                type="button"
                onClick={() => void generate()}
                disabled={!script || generating || !voiceModel || !catalog?.configured}
              >
                {generating ? "Generating..." : state.narration ? "Replace narration" : "Generate narration"}
              </button>
            </div>
            {previewUrl && (
              <div className="audio-preview">
                <audio controls src={previewUrl} aria-label="Voice sample" />
                <p className="hint">Short sample from Deepgram. It is not saved as a project asset.</p>
              </div>
            )}
            <p className="hint">
              The exact request uses the approved scene text and the selected voice. Nothing regenerates automatically.
            </p>
          </div>

          <AudioTrackCard
            kind="narration"
            title="Current narration"
            track={state.narration}
            playback={playback.narration}
            volume={volumes.narration}
            onVolume={(value) => setVolumes((current) => ({ ...current, narration: value }))}
            onVolumeCommit={(value) => void saveSettings("narration", { volume: value })}
            onMuted={(muted) => void saveSettings("narration", { muted })}
            confirming={confirmRemove === "narration"}
            removing={removing === "narration"}
            onConfirm={() => setConfirmRemove("narration")}
            onCancel={() => setConfirmRemove(null)}
            onRemove={() => void remove("narration")}
          />

          <div className="panel-heading media-heading">
            <h3>Upload narration instead</h3>
          </div>
          <div className="upload-form">
            <label className="field" htmlFor="narration-file">
              <span className="field-label">Narration audio</span>
              <input
                id="narration-file"
                ref={narrationFile}
                type="file"
                accept="audio/*"
                onChange={(event) => void upload(event.target.files?.[0] ?? null, "narration")}
                disabled={uploading !== null || !script}
              />
              <span className="hint">
                {script
                  ? "MP3, WAV, OGG, M4A, or AAC; up to 25 MiB. Duration is measured after upload."
                  : "Approve every scene before uploading narration."}
              </span>
            </label>
          </div>

          {state.timing && (
            <div className={state.timing.mismatch ? "alert" : "hint"} role={state.timing.mismatch ? "alert" : "status"}>
              <strong>{state.timing.mismatch ? "TIMING_MISMATCH" : "Timing"}</strong>
              <p>
                Narration is {seconds(state.timing.narrationSeconds)}; the scene timing adds up to{" "}
                {seconds(state.timing.targetSeconds)} ({state.timing.differenceSeconds >= 0 ? "+" : ""}
                {seconds(state.timing.differenceSeconds)}).{" "}
                {state.timing.mismatch
                  ? "Speech is never sped up or cut automatically. Edit the script or unlock scene timing in Script or Storyboard."
                  : "The measured audio is within the scene-timing tolerance."}
              </p>
            </div>
          )}

          <div className="panel-heading media-heading">
            <h3>Music</h3>
          </div>
          <AudioTrackCard
            kind="music"
            title="Current music"
            track={state.music}
            playback={playback.music}
            volume={volumes.music}
            onVolume={(value) => setVolumes((current) => ({ ...current, music: value }))}
            onVolumeCommit={(value) => void saveSettings("music", { volume: value })}
            onMuted={(muted) => void saveSettings("music", { muted })}
            confirming={confirmRemove === "music"}
            removing={removing === "music"}
            onConfirm={() => setConfirmRemove("music")}
            onCancel={() => setConfirmRemove(null)}
            onRemove={() => void remove("music")}
          />
          <div className="upload-form">
            <label className="field" htmlFor="music-file">
              <span className="field-label">Music file</span>
              <input
                id="music-file"
                ref={musicFile}
                type="file"
                accept="audio/*"
                onChange={(event) => void upload(event.target.files?.[0] ?? null, "music")}
                disabled={uploading !== null}
              />
              <span className="hint">Uploaded music is stored privately and can be replaced or removed.</span>
            </label>
          </div>
        </>
      )}

      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <div className="alert" role="alert">
          <strong>{error.code}</strong>
          <p>{error.message}</p>
        </div>
      )}
    </section>
  );
}

function AudioTrackCard({
  kind,
  title,
  track,
  playback,
  volume,
  onVolume,
  onVolumeCommit,
  onMuted,
  confirming,
  removing,
  onConfirm,
  onCancel,
  onRemove,
}: {
  kind: NarrationKind;
  title: string;
  track: NarrationTrack | null;
  playback: MediaPlayback | null;
  volume: number;
  onVolume: (value: number) => void;
  onVolumeCommit: (value: number) => void;
  onMuted: (muted: boolean) => void;
  confirming: boolean;
  removing: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="audio-track">
      <div className="panel-heading media-heading">
        <h3>{title}</h3>
        <span className="status">{track ? track.status : "none"}</span>
      </div>
      {!track && <p className="empty-state">No {kind} track yet.</p>}
      {track && (
        <>
          <p className="hint">
            {track.source === "deepgram" ? `Deepgram · ${track.voiceName ?? track.voiceModel}` : "Uploaded audio"} ·{" "}
            {track.durationSeconds !== null ? seconds(track.durationSeconds) : "duration unknown"} · volume{" "}
            {Math.round(track.volume * 100)}%{track.muted ? " · muted" : ""}
            {track.costUsd !== null ? ` · ${usd(track.costUsd)} at the verified rate` : ""}
          </p>
          {playback ? (
            <audio controls src={playback.url} aria-label={`${kind} playback`} />
          ) : (
            <p className="hint">Requesting a private playback link...</p>
          )}
          <label className="field" htmlFor={`${kind}-volume`}>
            <span className="field-label">Volume</span>
            <input
              id={`${kind}-volume`}
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(event) => onVolume(Number(event.target.value))}
              onBlur={(event) => onVolumeCommit(Number(event.target.value))}
              onKeyUp={(event) => onVolumeCommit(Number(event.currentTarget.value))}
            />
          </label>
          <label className="field" htmlFor={`${kind}-muted`}>
            <input
              id={`${kind}-muted`}
              type="checkbox"
              checked={track.muted}
              onChange={(event) => onMuted(event.target.checked)}
            />{" "}
            Mute {kind}
          </label>
          <div className="button-row">
            {!confirming ? (
              <button
                type="button"
                className="button-secondary button-small button-danger"
                onClick={onConfirm}
                disabled={removing}
              >
                Remove {kind}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="button-secondary button-small button-danger"
                  onClick={onRemove}
                  disabled={removing}
                >
                  {removing ? "Removing..." : `Confirm remove ${kind}`}
                </button>
                <button
                  type="button"
                  className="button-secondary button-small"
                  onClick={onCancel}
                  disabled={removing}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
