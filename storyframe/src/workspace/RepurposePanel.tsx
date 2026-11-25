import { useEffect, useState } from "react";
import type { ProjectRecord } from "../../shared/project-contract";
import {
  buildClipRelativeCues,
  renderCuesToSrt,
  renderCuesToVtt,
  type RepurposeBatchExportManifest,
  type RepurposeClipRecord,
  type RepurposeIngestRecord,
  type RepurposeTranscriptRecord,
} from "../../shared/workflows-contract";
import {
  createModeCIngest,
  getModeCState,
  proposeModeCClips,
  runModeCBatchExport,
  transcribeModeCIngest,
  updateModeCClip,
  updateModeCTranscriptSegment,
} from "../api";

interface RepurposePanelProps {
  project: ProjectRecord;
  getAccessToken: () => Promise<string>;
}

export function RepurposePanel({ project, getAccessToken }: RepurposePanelProps) {
  const [ingests, setIngests] = useState<RepurposeIngestRecord[]>([]);
  const [transcripts, setTranscripts] = useState<RepurposeTranscriptRecord[]>([]);
  const [clips, setClips] = useState<RepurposeClipRecord[]>([]);
  const [batchManifest, setBatchManifest] = useState<RepurposeBatchExportManifest | null>(null);

  const [fileName, setFileName] = useState("keynote-interview-master.mp4");
  const [durationSeconds, setDurationSeconds] = useState(90);
  const [currentSeekSeconds, setCurrentSeekSeconds] = useState(0);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadState();
  }, [project.id]);

  async function loadState() {
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const state = await getModeCState(token, project.id);
      setIngests(state.ingests);
      setTranscripts(state.transcripts);
      setClips(state.clips);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not load Mode C state.");
    }
  }

  async function handleIngestSource() {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const created = await createModeCIngest(token, project.id, {
        sourceMediaId: `r2-master-${Date.now()}`,
        fileName,
        contentType: "video/mp4",
        byteSize: durationSeconds * 180_000,
        durationSeconds,
      });
      setIngests((prev) => [created, ...prev]);
      setStatusMessage(
        `Ingested immutable source video "${created.fileName}" (${created.durationSeconds}s, fingerprint ${created.sourceFingerprint}).`,
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Ingest failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleTranscribe(ingestId: string) {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const tr = await transcribeModeCIngest(token, project.id, ingestId);
      setTranscripts((prev) => [tr, ...prev]);
      setStatusMessage(
        `Transcribed via Deepgram STT (${tr.model}, ${tr.segments.length} speaker-labeled segments, $${tr.costUsd.toFixed(4)}).`,
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Transcription failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateSegment(
    transcriptId: string,
    segmentId: string,
    correctedText: string,
  ) {
    setBusy(true);
    try {
      const token = await getAccessToken();
      const updated = await updateModeCTranscriptSegment(token, project.id, {
        transcriptId,
        segmentId,
        correctedText,
      });
      setTranscripts((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      setStatusMessage("Updated caption transcript layer (original R2 audio preserved untouched).");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Segment update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleProposeClips(transcriptId: string) {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const proposed = await proposeModeCClips(token, project.id, transcriptId);
      setClips(proposed);
      setStatusMessage(`Proposed ${proposed.length} timestamp-grounded highlight clips.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Clip proposal failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleClipApproval(clip: RepurposeClipRecord) {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const updated = await updateModeCClip(token, project.id, clip.id, {
        approved: !clip.approved,
      });
      setClips((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setStatusMessage(
        `Clip "${updated.title}" marked ${updated.approved ? "approved for batch export" : "unapproved"}.`,
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Clip update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleBatchExport() {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const manifest = await runModeCBatchExport(token, project.id);
      setBatchManifest(manifest);
      setStatusMessage(
        `Completed bounded batch export ${manifest.batchId} (${manifest.clips.length} clips with .SRT, .VTT, and source-range manifest).`,
      );
      await loadState();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Batch export failed.");
    } finally {
      setBusy(false);
    }
  }

  const activeTranscript = transcripts[0] ?? null;

  return (
    <div className="panel" data-testid="repurpose-panel">
      <div className="panel-header">
        <div>
          <h3>Mode C: Footage Repurposing, Deepgram STT & Batch Clips</h3>
          <p className="muted">
            Phase 12A–12E workflow: immutable R2 video ingest, Deepgram STT speaker-labeled transcription, click-to-seek transcript editor, Ollama clip proposals, clip-relative SRT/VTT captions, and bounded batch export.
          </p>
        </div>
      </div>

      {statusMessage && (
        <p className="status-banner" role="status">
          {statusMessage}
        </p>
      )}
      {errorMessage && (
        <div className="alert" role="alert">
          <strong>MODE_C_REPURPOSE_ERROR</strong>
          <p>{errorMessage}</p>
        </div>
      )}

      {/* 12A: Ingest */}
      <section className="scene-card">
        <h4>Phase 12A: Immutable Source Video Ingest</h4>
        <div className="field-grid">
          <label>
            <span>Source Video File Name</span>
            <input
              aria-label="Source Video File Name"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
            />
          </label>
          <label>
            <span>Measured Duration (seconds)</span>
            <input
              type="number"
              aria-label="Measured Duration"
              value={durationSeconds}
              min={10}
              max={7200}
              onChange={(e) => setDurationSeconds(Number(e.target.value) || 60)}
            />
          </label>
          <div className="button-row">
            <button type="button" className="primary" onClick={handleIngestSource} disabled={busy}>
              Ingest Source Footage to R2
            </button>
          </div>
        </div>

        {ingests.length > 0 && (
          <ul className="revision-list" style={{ marginTop: "0.75rem" }}>
            {ingests.map((ing) => (
              <li key={ing.id} className="revision-item">
                <div>
                  <strong>{ing.fileName}</strong> ({ing.durationSeconds}s · {ing.width}×{ing.height}) ·
                  Fingerprint: <code>{ing.sourceFingerprint}</code> · Seek Verified:{" "}
                  <strong>{ing.seekVerified ? "Yes" : "No"}</strong> · Playhead:{" "}
                  <code>{currentSeekSeconds}s</code>
                </div>
                <div className="button-row">
                  <button
                    type="button"
                    onClick={() => handleTranscribe(ing.id)}
                    disabled={busy}
                  >
                    Run Deepgram STT Transcription
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 12B: Deepgram STT & Interactive Click-to-Seek Transcript */}
      {activeTranscript && (
        <section className="scene-card" style={{ marginTop: "1rem" }}>
          <div className="panel-header">
            <div>
              <h4>
                Phase 12B: Timestamped Transcript ({activeTranscript.model} · $
                {activeTranscript.costUsd.toFixed(4)})
              </h4>
              <p className="muted">
                Click any timestamp to seek the source player. Text edits update subtitles without altering the original R2 master recording.
              </p>
            </div>
            <button
              type="button"
              className="primary"
              onClick={() => handleProposeClips(activeTranscript.id)}
              disabled={busy}
            >
              Propose Clips with Ollama
            </button>
          </div>

          <ul className="revision-list">
            {activeTranscript.segments.map((seg) => (
              <li key={seg.id} className="revision-item">
                <div style={{ flex: 1 }}>
                  <div className="button-row">
                    <button
                      type="button"
                      onClick={() => {
                        setCurrentSeekSeconds(seg.startSeconds);
                        setStatusMessage(`Seeked source player to ${seg.startSeconds}s (${seg.speaker}).`);
                      }}
                    >
                      Seek {seg.startSeconds}s–{seg.endSeconds}s
                    </button>
                    <strong>{seg.speaker}</strong>
                  </div>
                  <input
                    aria-label={`Transcript segment ${seg.id}`}
                    style={{ width: "100%", marginTop: "0.4rem" }}
                    value={seg.correctedText}
                    onChange={(e) => {
                      const val = e.target.value;
                      setTranscripts((prev) =>
                        prev.map((t) =>
                          t.id === activeTranscript.id
                            ? {
                                ...t,
                                segments: t.segments.map((s) =>
                                  s.id === seg.id ? { ...s, correctedText: val } : s,
                                ),
                              }
                            : t,
                        ),
                      );
                    }}
                    onBlur={(e) =>
                      void handleUpdateSegment(activeTranscript.id, seg.id, e.target.value)
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 12C, 12D, 12E: Clip Proposals, Clip-Relative Subtitles & Batch Export */}
      {clips.length > 0 && (
        <section className="scene-card" style={{ marginTop: "1rem" }}>
          <div className="panel-header">
            <div>
              <h4>Phase 12C–12E: Proposed Clips, Clip-Relative SRT/VTT & Batch Export</h4>
              <p className="muted">
                Approve clips and export a bounded batch with clip-relative subtitle timestamps (00:00:00,000 start).
              </p>
            </div>
            <button
              type="button"
              className="primary"
              onClick={handleBatchExport}
              disabled={busy}
            >
              Run Bounded Batch Export
            </button>
          </div>

          <div className="project-grid">
            {clips.map((clip) => {
              const cues = buildClipRelativeCues(
                activeTranscript?.segments ?? [],
                clip.startSeconds,
                clip.endSeconds,
              );
              return (
                <div key={clip.id} className="project-card">
                  <h5>{clip.title}</h5>
                  <p className="muted">
                    Source Range: <code>{clip.startSeconds}s–{clip.endSeconds}s</code> (
                    {clip.durationSeconds}s) · Framing: <code>{clip.framingMode}</code> · Status:{" "}
                    <strong>{clip.status}</strong>
                  </p>
                  <p>&ldquo;{clip.quoteExcerpt}&rdquo;</p>
                  {clip.contextWarning && (
                    <p className="notice">
                      <strong>Context Warning:</strong> {clip.contextWarning}
                    </p>
                  )}
                  <details style={{ marginTop: "0.5rem" }}>
                    <summary>Preview Clip-Relative SRT / VTT ({cues.length} cues)</summary>
                    <pre className="code-block">{renderCuesToSrt(cues)}</pre>
                    <pre className="code-block">{renderCuesToVtt(cues)}</pre>
                  </details>
                  <div className="button-row" style={{ marginTop: "0.5rem" }}>
                    <button
                      type="button"
                      onClick={() => handleToggleClipApproval(clip)}
                      disabled={busy}
                    >
                      {clip.approved ? "Approved (Click to Unapprove)" : "Approve Clip for Batch"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {batchManifest && (
            <div className="notice" style={{ marginTop: "1rem" }}>
              <h5>Batch Export Manifest ({batchManifest.batchId})</h5>
              <p className="muted">
                Source Fingerprint: <code>{batchManifest.sourceFingerprint}</code> · Max Concurrency:{" "}
                {batchManifest.maxConcurrency}
              </p>
              <pre className="code-block" style={{ overflowX: "auto" }}>
                {JSON.stringify(batchManifest, null, 2)}
              </pre>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
