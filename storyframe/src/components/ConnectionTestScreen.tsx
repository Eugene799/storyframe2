import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AiStatusResponse, AiTestSuccess } from "../../shared/ai-contract";
import { AiRequestError, fetchStatus, runModelTest } from "../api";
import { AuthSessionError } from "../auth";

const DEFAULT_PROMPT = "Write one short welcome sentence for StoryFrame.";

/**
 * Errors where the billable call may have reached the provider or is still
 * running. The same key must be reused, or a retry could bill a second time.
 * Every other error is a recorded outcome, so the next click is a new attempt.
 */
const KEY_RETAINING_ERROR_CODES = new Set([
  "NETWORK_ERROR",
  "IDEMPOTENCY_IN_PROGRESS",
  "REQUEST_IN_PROGRESS",
]);

function createIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

interface ConnectionTestScreenProps {
  getAccessToken: () => Promise<string>;
  /** Reports whether a billable request is in flight, so sign-out can wait for it. */
  onBusyChange?: (busy: boolean) => void;
}

export function ConnectionTestScreen({ getAccessToken, onBusyChange }: ConnectionTestScreenProps) {
  const [status, setStatus] = useState<AiStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiTestSuccess | null>(null);
  const [usageRecorded, setUsageRecorded] = useState(true);
  const [error, setError] = useState<AiRequestError | null>(null);
  const busyRef = useRef(false);
  const idempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    idempotencyKeyRef.current = null;
  }, [modelId, prompt]);

  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  useEffect(() => {
    let cancelled = false;
    fetchStatus()
      .then((response) => {
        if (cancelled) return;
        setStatus(response);
        setModelId((current) => current || response.models.find((model) => model.available)?.id || "");
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setStatusError(cause instanceof Error ? cause.message : "Could not load server configuration.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const availableModels = status?.models.filter((model) => model.available) ?? [];
  const unavailableModels = status?.models.filter((model) => !model.available) ?? [];
  const promptLimit = status?.limits.promptMaxChars ?? 500;
  const canSubmit = Boolean(modelId) && !busy;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    setResult(null);

    try {
      const accessToken = await getAccessToken();
      const idempotencyKey = idempotencyKeyRef.current ?? createIdempotencyKey();
      idempotencyKeyRef.current = idempotencyKey;
      const outcome = await runModelTest(accessToken, modelId, prompt, idempotencyKey);
      idempotencyKeyRef.current = null;
      setResult(outcome.result);
      setUsageRecorded(outcome.usageRecorded);
    } catch (cause) {
      const requestError =
        cause instanceof AiRequestError
          ? cause
          : cause instanceof AuthSessionError
            ? new AiRequestError(cause.code, cause.message, cause.status)
            : new AiRequestError("NETWORK_ERROR", "The StoryFrame development server could not be reached.", 0);
      if (!KEY_RETAINING_ERROR_CODES.has(requestError.code)) idempotencyKeyRef.current = null;
      setError(requestError);
    } finally {
      busyRef.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <div className="layout">
      <section className="panel" aria-labelledby="config-heading">
        <div className="panel-heading">
          <h2 id="config-heading">Server configuration</h2>
          {status && (
            <span className={status.configured ? "status status-ok" : "status status-warn"}>
              {status.configured ? "Ready" : "Needs setup"}
            </span>
          )}
        </div>

        {!status && !statusError && <p className="muted">Reading the server configuration...</p>}
        {statusError && (
          <p className="alert" role="alert">
            {statusError} Start the development server with <code>npm run dev</code>.
          </p>
        )}

        {status && (
          <>
            <dl className="facts">
              <div>
                <dt>Ollama API key</dt>
                <dd>{status.keyConfigured ? "Configured in the server process" : "Missing on the server"}</dd>
              </div>
              <div>
                <dt>Supabase auth</dt>
                <dd>{status.auth.configured ? "Configured (session verified server-side)" : "Not configured"}</dd>
              </div>
              <div>
                <dt>Usage ledger</dt>
                <dd>
                  {status.ledger.configured
                    ? status.ledger.ready
                      ? "Ready (ai_usage)"
                      : "Configured, migration not applied"
                    : "Not configured"}
                </dd>
              </div>
              <div>
                <dt>Upstream</dt>
                <dd>
                  <code>{status.provider.baseUrl}/api/chat</code>
                </dd>
              </div>
              <div>
                <dt>Limits</dt>
                <dd>
                  {status.limits.promptMaxChars} chars, {status.limits.maxOutputTokens} output tokens,{" "}
                  {status.limits.providerTimeoutMs} ms timeout
                </dd>
              </div>
            </dl>

            {!status.keyConfigured && (
              <div className="callout">
                <strong>Configure the key on the server.</strong>
                <p>
                  Add <code>OLLAMA_API_KEY</code> to <code>storyframe/.env</code> (git-ignored) and restart the API
                  process. Do not paste it into this page, a chat, or source control.
                </p>
              </div>
            )}

            {!status.auth.configured && (
              <div className="callout">
                <strong>Configure Supabase auth.</strong>
                <p>
                  Set <code>SUPABASE_URL</code> and <code>SUPABASE_PUBLISHABLE_KEY</code> (or the legacy{" "}
                  <code>SUPABASE_ANON_KEY</code>) in the server environment, then restart the API process.
                </p>
              </div>
            )}

            {status.ledger.configured && !status.ledger.ready && (
              <div className="callout">
                <strong>Apply the usage ledger migration.</strong>
                <p>
                  The ledger is configured but <code>ai_usage</code> is not reachable. Apply{" "}
                  <code>supabase/migrations/</code> and restart the API process. Billable calls are refused until then.
                </p>
              </div>
            )}

            {!status.ledger.configured && (
              <div className="callout">
                <strong>Configure the usage ledger.</strong>
                <p>
                  Set <code>SUPABASE_SERVICE_ROLE_KEY</code> and apply the migration in{" "}
                  <code>supabase/migrations/</code>. Billable calls are refused until the ledger is available.
                </p>
              </div>
            )}

            <div className="model-list">
              <p className="field-label">Configured model choices</p>
              {availableModels.map((model) => (
                <p className="model-row" key={model.id}>
                  <span>{model.label}</span>
                  <code>{model.requestId}</code>
                </p>
              ))}
              {unavailableModels.map((model) => (
                <p className="model-row model-row-disabled" key={model.id}>
                  <span>
                    {model.label} <em>(disabled)</em>
                  </span>
                  <span className="model-reason">{model.reason}</span>
                </p>
              ))}
              <p className="hint">
                Identifiers were checked against <code>{status.catalog.source}</code> on {status.catalog.checkedOn}.
                Account-level availability still requires a live test.
              </p>
            </div>
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="test-heading">
        <div className="panel-heading">
          <h2 id="test-heading">Send a test request</h2>
          <span className="status status-dev">Dev</span>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <p className="hint session-hint">
            Requests use the signed-in Supabase session; no token is pasted or displayed here.
          </p>

          <label className="field" htmlFor="model">
            <span className="field-label">Model</span>
            <select
              id="model"
              name="model"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              disabled={busy || availableModels.length === 0}
            >
              {availableModels.length === 0 && <option value="">No model available</option>}
              {availableModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label} ({model.requestId})
                </option>
              ))}
            </select>
          </label>

          <label className="field" htmlFor="prompt">
            <span className="field-label">Test prompt</span>
            <textarea
              id="prompt"
              name="prompt"
              rows={3}
              maxLength={promptLimit}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              disabled={busy}
            />
            <span className="hint">
              {prompt.trim().length}/{promptLimit} characters
            </span>
          </label>

          <button type="submit" disabled={!canSubmit} aria-busy={busy}>
            {busy ? "Sending..." : "Send test request"}
          </button>
        </form>

        {error && (
          <div className="alert" role="alert" data-testid="ai-error">
            <strong>{error.code}</strong>
            <p>{error.message}</p>
            {error.upstreamStatus !== undefined && <p className="hint">Upstream HTTP status: {error.upstreamStatus}</p>}
          </div>
        )}

        {result && (
          <div className="result" aria-live="polite">
            {!usageRecorded && (
              <div className="callout" role="status" data-testid="ai-unrecorded">
                <strong>This reply was not recorded.</strong>
                <p>
                  Ollama answered and may have charged for it, but the usage ledger could not store the outcome. The
                  reply below exists only in this page, so retrying with a new key would be a second paid attempt.
                </p>
              </div>
            )}
            <h3>Actual reply</h3>
            <p className="reply" data-testid="ai-reply">
              {result.reply}
            </p>
            <dl className="facts">
              <div>
                <dt>Configured model</dt>
                <dd>
                  <code>{result.configuredModel}</code>
                </dd>
              </div>
              <div>
                <dt>Returned model</dt>
                <dd>{result.returnedModel ? <code>{result.returnedModel}</code> : "Not supplied"}</dd>
              </div>
              <div>
                <dt>Latency</dt>
                <dd>{result.latencyMs} ms</dd>
              </div>
              <div>
                <dt>Prompt tokens</dt>
                <dd>{result.usage.promptEvalCount ?? "Not supplied"}</dd>
              </div>
              <div>
                <dt>Output tokens</dt>
                <dd>{result.usage.evalCount ?? "Not supplied"}</dd>
              </div>
              <div>
                <dt>Done reason</dt>
                <dd>{result.doneReason ?? "Not supplied"}</dd>
              </div>
            </dl>
            <p className="hint">
              Final answer only. No hidden reasoning is requested or displayed, and no token counts or costs are
              estimated.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
