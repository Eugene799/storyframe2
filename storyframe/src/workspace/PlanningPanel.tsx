import { useEffect, useRef, useState } from "react";
import type { GenerationProposalRecord } from "../../shared/child-contract";
import type {
  PlanningAngle,
  PlanningClaim,
  PlanningClip,
  PlanningPayload,
  PlanningRoute,
  PlanningSceneDraft,
} from "../../shared/planning-contract";
import {
  PLANNING_ROUTES,
  PLANNING_ROUTE_HINTS,
  PLANNING_ROUTE_LABELS,
} from "../../shared/planning-contract";
import type { ProjectRecord, ProjectScene } from "../../shared/project-contract";
import {
  AiRequestError,
  acceptPlanningProposal,
  deletePlanningProposal,
  generatePlanningProposal,
  getPlanningAttemptStatus,
  listProjectProposals,
  rejectPlanningProposal,
} from "../api";

interface PlanningPanelProps {
  projectId: string;
  baseVersion: number;
  scenes: ProjectScene[];
  dirty: boolean;
  getAccessToken: () => Promise<string>;
  onAccepted: (project: ProjectRecord) => void;
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

function payloadOf(proposal: GenerationProposalRecord): Partial<PlanningPayload> {
  return proposal.proposal as Partial<PlanningPayload>;
}

function listOf<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

const PENDING_KEY_PREFIX = "storyframe.planning.pendingKey.";
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
// A stored key is only useful while its paid attempt can still be replayed.
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_PREFIX = "storyframe.planning.lock.";
// Matches the server's default abandon window; the preflight returns the
// configured value and every new lease uses it.
const DEFAULT_LEASE_MS = 90_000;
const REMOTE_ATTEMPT_NOTICE =
  "Another device is already generating a proposal for this project. Wait for it to finish or for its lease to expire.";
const TAB_ID_KEY = "storyframe.planning.tabId";
const TAB_CHANNEL = "storyframe.planning.tabPresence";
const TAB_PROBE_MS = 80;
const ATTEMPTS_PREFIX = "storyframe.planning.attempts.";
const ATTEMPTS_LIMIT = 20;

/** The request identity a key was minted for; the server hashes route and prompt. */
interface PendingPlanningAttempt {
  key: string;
  route: PlanningRoute;
  instruction: string;
  baseVersion: number;
  startedAt: number;
}

type AttemptOutcome = "succeeded" | "replayed" | "failed" | "stopped";

interface PlanningAttemptEntry {
  at: number;
  route: PlanningRoute;
  outcome: AttemptOutcome;
  code?: string;
  proposalId?: string;
}

const ATTEMPT_LABELS: Record<AttemptOutcome, string> = {
  succeeded: "Succeeded",
  replayed: "Replayed",
  failed: "Failed",
  stopped: "Stopped",
};

function isAttemptOutcome(value: unknown): value is AttemptOutcome {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ATTEMPT_LABELS, value);
}

interface PlanningLock {
  tabId: string;
  expiresAt: number;
}

function pendingKeyStorageName(projectId: string): string {
  return `${PENDING_KEY_PREFIX}${projectId}`;
}

function isSameRequest(attempt: PendingPlanningAttempt, route: PlanningRoute, instruction: string, baseVersion: number) {
  return attempt.route === route && attempt.instruction === instruction && attempt.baseVersion === baseVersion;
}

/** Survives a reload in this tab, so Retry can still replay an unsettled attempt. */
function readPendingAttempt(projectId: string): PendingPlanningAttempt | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(pendingKeyStorageName(projectId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.key !== "string" ||
      !IDEMPOTENCY_KEY_PATTERN.test(record.key) ||
      typeof record.route !== "string" ||
      !PLANNING_ROUTES.includes(record.route as PlanningRoute) ||
      typeof record.instruction !== "string" ||
      typeof record.baseVersion !== "number" ||
      !Number.isInteger(record.baseVersion) ||
      record.baseVersion < 1 ||
      typeof record.startedAt !== "number" ||
      !Number.isFinite(record.startedAt)
    ) {
      return null;
    }
    if (Date.now() - record.startedAt >= PENDING_TTL_MS) {
      clearPendingAttempt(projectId);
      return null;
    }
    return {
      key: record.key,
      route: record.route as PlanningRoute,
      instruction: record.instruction,
      baseVersion: record.baseVersion,
      startedAt: record.startedAt,
    };
  } catch {
    return null;
  }
}

function storePendingAttempt(projectId: string, attempt: PendingPlanningAttempt): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(pendingKeyStorageName(projectId), JSON.stringify(attempt));
  } catch {
    // Storage can be unavailable (private mode); the attempt still works in memory.
  }
}

function clearPendingAttempt(projectId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(pendingKeyStorageName(projectId));
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

function storeTabId(tabId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(TAB_ID_KEY, tabId);
  } catch {
    // Without storage the id is still stable for this page lifetime.
  }
}

/**
 * Resolve true only when another live page claims the same tab id. A reload
 * has no live predecessor, so it can reclaim its own lease; a duplicated tab
 * inherits the stored id while the original page is still listening.
 */
function openTabChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(TAB_CHANNEL);
  } catch {
    return null;
  }
}

function anotherInstanceIsAlive(tabId: string, instanceId: string): Promise<boolean> {
  const channel = openTabChannel();
  if (!channel) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let timer: number | null = null;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== null) window.clearTimeout(timer);
      channel.close();
      resolve(alive);
    };
    timer = window.setTimeout(() => finish(false), TAB_PROBE_MS);
    channel.onmessage = (event) => {
      const message: unknown = event.data;
      if (!message || typeof message !== "object") return;
      const record = message as Record<string, unknown>;
      if (
        record.type === "planning-tab-alive" &&
        record.tabId === tabId &&
        typeof record.instanceId === "string" &&
        record.instanceId !== instanceId
      ) {
        finish(true);
      }
    };
    channel.postMessage({ type: "planning-tab-probe", tabId, instanceId });
  });
}

function lockStorageName(projectId: string): string {
  return `${LOCK_PREFIX}${projectId}`;
}

function readPlanningLock(projectId: string): PlanningLock | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(lockStorageName(projectId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.tabId !== "string" ||
      record.tabId.length === 0 ||
      typeof record.expiresAt !== "number" ||
      !Number.isFinite(record.expiresAt)
    ) {
      return null;
    }
    return { tabId: record.tabId, expiresAt: record.expiresAt };
  } catch {
    return null;
  }
}

/** A short lease keeps two tabs from paying for the same duplicate attempt. */
function tryAcquirePlanningLock(
  projectId: string,
  tabId: string,
  ttlMs: number = DEFAULT_LEASE_MS,
): boolean {
  if (typeof window === "undefined") return true;
  const current = readPlanningLock(projectId);
  if (current && current.tabId !== tabId && current.expiresAt > Date.now()) return false;
  try {
    window.localStorage.setItem(
      lockStorageName(projectId),
      JSON.stringify({ tabId, expiresAt: Date.now() + ttlMs }),
    );
    return true;
  } catch {
    // If storage is unavailable, do not block the only tab that can be seen.
    return true;
  }
}

function releasePlanningLock(projectId: string, tabId: string): void {
  if (typeof window === "undefined") return;
  try {
    const current = readPlanningLock(projectId);
    if (current?.tabId === tabId) window.localStorage.removeItem(lockStorageName(projectId));
  } catch {
    // Nothing to release when storage is unavailable.
  }
}

function attemptsStorageName(projectId: string): string {
  return `${ATTEMPTS_PREFIX}${projectId}`;
}

function readAttempts(projectId: string): PlanningAttemptEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(attemptsStorageName(projectId));
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry): entry is PlanningAttemptEntry => {
        if (!entry || typeof entry !== "object") return false;
        const record = entry as Record<string, unknown>;
        return (
          typeof record.at === "number" &&
          Number.isFinite(record.at) &&
          typeof record.route === "string" &&
          PLANNING_ROUTES.includes(record.route as PlanningRoute) &&
          isAttemptOutcome(record.outcome)
        );
      })
      .slice(-ATTEMPTS_LIMIT);
  } catch {
    return [];
  }
}

function appendAttempt(projectId: string, entry: PlanningAttemptEntry): PlanningAttemptEntry[] {
  if (typeof window === "undefined") return readAttempts(projectId);
  try {
    const next = [...readAttempts(projectId), entry].slice(-ATTEMPTS_LIMIT);
    window.localStorage.setItem(attemptsStorageName(projectId), JSON.stringify(next));
    return next;
  } catch {
    // History is diagnostics; a full or blocked store must not break planning.
    return readAttempts(projectId);
  }
}

/** Stable for the life of the tab, including a reload, so its own lease is recognizable. */
function readOrCreateTabId(): string {
  if (typeof window === "undefined") return newIdempotencyKey();
  try {
    const existing = window.sessionStorage.getItem(TAB_ID_KEY);
    if (existing && IDEMPOTENCY_KEY_PATTERN.test(existing)) return existing;
    const created = newIdempotencyKey();
    storeTabId(created);
    return created;
  } catch {
    return newIdempotencyKey();
  }
}

function newIdempotencyKey(): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return uuid.replace(/[^A-Za-z0-9._:-]/g, "-");
}

/** A retry with the same key is the safe option while the attempt's fate is unknown. */
function keepsKeyOnRetry(error: AiRequestError): boolean {
  return (
    error.status === 0 ||
    error.code === "IDEMPOTENCY_IN_PROGRESS" ||
    error.code === "LEDGER_UNAVAILABLE"
  );
}

function statusLabel(status: GenerationProposalRecord["status"]): string {
  if (status === "accepted") return "Accepted";
  if (status === "rejected") return "Rejected";
  return "Proposed";
}

function ScenarioList({ scenes }: { scenes: PlanningSceneDraft[] }) {
  return (
    <ol className="planning-list">
      {scenes.map((scene, index) => (
        <li key={`${index}-${scene.heading}`}>
          <p>
            <strong>
              Scene {index + 1}: {scene.heading}
            </strong>{" "}
            <span className="hint">{scene.durationSeconds}s</span>
          </p>
          <p>{scene.narration}</p>
          {scene.visualDirection && <p className="hint">Visual: {scene.visualDirection}</p>}
          {scene.onScreenText && <p className="hint">On screen: {scene.onScreenText}</p>}
        </li>
      ))}
    </ol>
  );
}

function AngleList({
  angles,
  disabled,
  onUse,
}: {
  angles: PlanningAngle[];
  disabled: boolean;
  onUse: (angle: PlanningAngle) => void;
}) {
  return (
    <ol className="planning-list">
      {angles.map((angle, index) => (
        <li key={`${index}-${angle.title}`}>
          <p>
            <strong>{angle.title}</strong>
          </p>
          <p>{angle.hook}</p>
          <p className="hint">{angle.rationale}</p>
          <button
            type="button"
            className="button-secondary button-small"
            onClick={() => onUse(angle)}
            disabled={disabled}
          >
            Use this angle
          </button>
        </li>
      ))}
    </ol>
  );
}

function ClipList({ clips }: { clips: PlanningClip[] }) {
  return (
    <ol className="planning-list">
      {clips.map((clip, index) => (
        <li key={`${index}-${clip.startSeconds}`}>
          <p>
            <strong>
              {clip.startSeconds}s–{clip.endSeconds}s: {clip.heading}
            </strong>
          </p>
          <p>“{clip.quote}”</p>
          <p className="hint">{clip.rationale}</p>
        </li>
      ))}
    </ol>
  );
}

function ClaimList({ claims }: { claims: PlanningClaim[] }) {
  return (
    <ul className="planning-list">
      {claims.map((claim, index) => (
        <li key={`${index}-${claim.statement.slice(0, 24)}`}>
          <p>
            <span className={claim.supported ? "status status-ok" : "status"}>
              {claim.supported ? "Supported" : "Unverified"}
            </span>{" "}
            {claim.statement}
          </p>
          {claim.quote ? <p className="hint">“{claim.quote}”</p> : <p className="hint">No supporting quote supplied.</p>}
        </li>
      ))}
    </ul>
  );
}

export function PlanningPanel({
  projectId,
  baseVersion,
  scenes,
  dirty,
  getAccessToken,
  onAccepted,
  onBusyChange,
}: PlanningPanelProps) {
  const [route, setRoute] = useState<PlanningRoute>("angles");
  const [instruction, setInstruction] = useState("");
  const [proposals, setProposals] = useState<GenerationProposalRecord[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<AiRequestError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Reused only while an attempt's outcome is unknown, so a retry replays the
  // recorded proposal instead of paying for another one.
  const pendingAttempt = useRef<PendingPlanningAttempt | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const tabId = useRef(readOrCreateTabId());
  const instanceId = useRef(newIdempotencyKey());
  // True while this tab holds a lease whose attempt has not settled. It is kept
  // through unknown outcomes so another tab cannot start a duplicate paid call.
  const leaseHeld = useRef(false);
  const mounted = useRef(true);
  // Advance during render, not in an effect, so a preflight resolving between
  // commit and passive effects cannot acquire a lease for the previous project.
  const projectEpoch = useRef(0);
  const renderedProject = useRef(projectId);
  if (renderedProject.current !== projectId) {
    renderedProject.current = projectId;
    projectEpoch.current += 1;
  }
  const [attempts, setAttempts] = useState<PlanningAttemptEntry[]>(() => readAttempts(projectId));
  const [otherTabGenerating, setOtherTabGenerating] = useState(false);
  const [checkingAttempt, setCheckingAttempt] = useState(false);
  const [remoteAttemptUntil, setRemoteAttemptUntil] = useState<number | null>(null);
  const [leaseSettling, setLeaseSettling] = useState(() => {
    const lock = readPlanningLock(projectId);
    return Boolean(lock && lock.tabId === tabId.current && lock.expiresAt > Date.now());
  });
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const busy = generating || acting || checkingAttempt;

  // A different project is a different attempt; never carry a key or history across it.
  useEffect(() => {
    setCheckingAttempt(false);
    const pending = readPendingAttempt(projectId);
    pendingAttempt.current = null;
    setAttempts(readAttempts(projectId));
    // Retry must rebuild the exact request the stored key was minted for.
    setRoute(pending?.route ?? "angles");
    setInstruction(pending?.instruction ?? "");
    setRemoteAttemptUntil(null);
    // A reload keeps the tab id and the unsettled key, so it also keeps the
    // lease: unmounting again must not free a possibly-running paid attempt.
    const lock = readPlanningLock(projectId);
    leaseHeld.current = Boolean(
      lock &&
        lock.tabId === tabId.current &&
        lock.expiresAt > Date.now() &&
        pending,
    );
  }, [projectId]);

  useEffect(() => {
    const channel = openTabChannel();
    if (!channel) return;
    channel.onmessage = (event) => {
      const message: unknown = event.data;
      if (!message || typeof message !== "object") return;
      const record = message as Record<string, unknown>;
      if (
        record.type === "planning-tab-probe" &&
        record.tabId === tabId.current &&
        typeof record.instanceId === "string" &&
        record.instanceId !== instanceId.current
      ) {
        channel.postMessage({
          type: "planning-tab-alive",
          tabId: tabId.current,
          instanceId: instanceId.current,
        });
      }
    };
    return () => channel.close();
  }, []);

  // A duplicated tab inherits the sessionStorage id. Ask whether a live page
  // still owns it before treating its lease as this tab's own.
  useEffect(() => {
    const lock = readPlanningLock(projectId);
    if (!lock || lock.tabId !== tabId.current || lock.expiresAt <= Date.now()) {
      setLeaseSettling(false);
      return;
    }
    let active = true;
    setLeaseSettling(true);
    void anotherInstanceIsAlive(tabId.current, instanceId.current).then((alive) => {
      if (!active) return;
      if (alive) {
        const fresh = newIdempotencyKey();
        tabId.current = fresh;
        storeTabId(fresh);
        leaseHeld.current = false;
        setOtherTabGenerating(true);
        setNotice(
          "This tab inherited another tab's planning lease. Generate in the original tab, or wait for that lease to expire.",
        );
      }
      setLeaseSettling(false);
    });
    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    const refreshLock = () => {
      const lock = readPlanningLock(projectId);
      setOtherTabGenerating(Boolean(lock && lock.tabId !== tabId.current && lock.expiresAt > Date.now()));
    };
    refreshLock();
    const timer = window.setInterval(refreshLock, 5000);
    window.addEventListener("storage", refreshLock);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("storage", refreshLock);
    };
  }, [projectId]);

  // Leaving the panel stops waiting locally. A settled attempt releases its
  // lease; an unknown one keeps it until expiry, just like Stop waiting.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (!leaseHeld.current) releasePlanningLock(projectId, tabId.current);
    };
  }, [projectId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A remote attempt blocks this tab only until the server's abandon window
  // ends; the next Generate re-checks the server anyway.
  useEffect(() => {
    if (remoteAttemptUntil === null) return;
    const remaining = remoteAttemptUntil - Date.now();
    if (remaining <= 0) {
      setRemoteAttemptUntil(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setRemoteAttemptUntil(null);
      setNotice((current) => (current === REMOTE_ATTEMPT_NOTICE ? null : current));
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [remoteAttemptUntil]);

  function recordAttempt(entry: PlanningAttemptEntry) {
    setAttempts(appendAttempt(projectId, entry));
  }

  function settleLease() {
    leaseHeld.current = false;
    releasePlanningLock(projectId, tabId.current);
  }

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await listProjectProposals(await getAccessToken(), projectId);
        if (!active) return;
        setProposals(list);
        setSelectedId((current) => current ?? list[list.length - 1]?.id ?? null);
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

  const selected = proposals?.find((proposal) => proposal.id === selectedId) ?? null;
  const selectedPayload = selected ? payloadOf(selected) : null;
  const canAct = Boolean(selected && selected.status === "proposed" && !dirty && !busy);

  function handleUseAngle(angle: PlanningAngle) {
    setRoute("script");
    setInstruction(`${angle.title}: ${angle.hook}`.slice(0, 500));
    setNotice("Angle loaded into the script instruction. Generate a script when you are ready.");
  }

  async function handleGenerate() {
    if (busy || dirty || otherTabGenerating || leaseSettling || remoteAttemptUntil !== null) return;
    const epoch = projectEpoch.current;
    const isCurrentProject = () => mounted.current && projectEpoch.current === epoch;
    const previous = pendingAttempt.current ?? readPendingAttempt(projectId);
    const key =
      previous && isSameRequest(previous, route, instruction, baseVersion)
        ? previous.key
        : newIdempotencyKey();
    setError(null);
    setNotice(null);
    setCheckingAttempt(true);
    let leaseMs = DEFAULT_LEASE_MS;
    try {
      try {
        const status = await getPlanningAttemptStatus(await getAccessToken(), projectId);
        if (!isCurrentProject()) return;
        leaseMs =
          Number.isFinite(status.abandonAfterMs) && status.abandonAfterMs > 0
            ? status.abandonAfterMs
            : DEFAULT_LEASE_MS;
        if (status.inFlight && status.idempotencyKey !== key) {
          const startedAtMs = status.startedAt ? Date.parse(status.startedAt) : NaN;
          const until = (Number.isFinite(startedAtMs) ? startedAtMs : Date.now()) + leaseMs;
          setRemoteAttemptUntil(until);
          setNotice(REMOTE_ATTEMPT_NOTICE);
          return;
        }
        setRemoteAttemptUntil(null);
      } catch {
        // The reservation's unique pending row still enforces this server-side.
      }
      if (!isCurrentProject()) return;
      if (!tryAcquirePlanningLock(projectId, tabId.current, leaseMs)) {
        setOtherTabGenerating(true);
        setNotice("Another tab is already generating a proposal for this project. Wait for it to finish before starting one here.");
        return;
      }
      leaseHeld.current = true;
      setGenerating(true);
    } finally {
      if (isCurrentProject()) setCheckingAttempt(false);
    }

    const controller = new AbortController();
    abortRef.current = controller;
    // A changed request can never replay the old attempt (the server hashes the
    // exact prompt), so keeping the old key would only produce a 409 reuse.
    pendingAttempt.current = { key, route, instruction, baseVersion, startedAt: Date.now() };
    storePendingAttempt(projectId, pendingAttempt.current);
    try {
      const created = await generatePlanningProposal(
        await getAccessToken(),
        projectId,
        { route, instruction, baseVersion },
        key,
        controller.signal,
      );
      const replayed = (proposals ?? []).some((proposal) => proposal.id === created.id);
      pendingAttempt.current = null;
      clearPendingAttempt(projectId);
      settleLease();
      // A replayed attempt may already be in the list loaded after a reload.
      setProposals((current) => {
        const list = current ?? [];
        return list.some((proposal) => proposal.id === created.id)
          ? list.map((proposal) => (proposal.id === created.id ? created : proposal))
          : [...list, created];
      });
      setSelectedId(created.id);
      recordAttempt({
        at: Date.now(),
        route,
        outcome: replayed ? "replayed" : "succeeded",
        proposalId: created.id,
      });
      setNotice(
        created.modelId === "none" || payloadOf(created).insufficientEvidence
          ? "Planning notes created. No model was called because no source excerpt was supplied."
          : `Proposal created with ${created.modelId}${payloadOf(created).repairAttempted ? " after one repair attempt" : ""}. Review it before accepting.`,
      );
    } catch (cause) {
      if (controller.signal.aborted) {
        // The browser stopped waiting, not the server. Keep the key so Retry
        // replays the recorded proposal instead of paying for a second attempt.
        recordAttempt({ at: Date.now(), route, outcome: "stopped" });
        setNotice(
          "Stopped waiting. The attempt may still finish on the server; Retry reuses this key instead of calling the provider again.",
        );
      } else {
        const requestError = toRequestError(cause);
        // Keep the key when no response arrived, the attempt is still running, or
        // the ledger is temporarily unavailable: retrying may replay a paid reply.
        if (!keepsKeyOnRetry(requestError)) {
          pendingAttempt.current = null;
          clearPendingAttempt(projectId);
          settleLease();
        }
        recordAttempt({ at: Date.now(), route, outcome: "failed", code: requestError.code });
        setError(requestError);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setOtherTabGenerating(false);
      setGenerating(false);
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  async function handleAccept() {
    if (!selected || !canAct) return;
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await acceptPlanningProposal(await getAccessToken(), projectId, selected.id);
      setProposals((current) =>
        (current ?? []).map((proposal) => (proposal.id === result.proposal.id ? result.proposal : proposal)),
      );
      onAccepted(result.project);
      setNotice(
        result.claimsRecorded
          ? `Accepted. The project is now version ${result.project.version}.`
          : `Accepted and saved as version ${result.project.version}, but the claims could not be recorded.`,
      );
    } catch (cause) {
      setError(toRequestError(cause));
    } finally {
      setActing(false);
    }
  }

  async function handleDeleteProposal() {
    if (!selected || selected.status === "accepted" || busy) return;
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      await deletePlanningProposal(await getAccessToken(), projectId, selected.id);
      const remaining = (proposals ?? []).filter((proposal) => proposal.id !== selected.id);
      setProposals(remaining);
      setSelectedId(remaining[remaining.length - 1]?.id ?? null);
      setConfirmingDeleteId(null);
      setNotice("Proposal deleted. The project was not changed.");
    } catch (cause) {
      setError(toRequestError(cause));
    } finally {
      setActing(false);
    }
  }

  async function handleReject() {
    if (!selected || !canAct) return;
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      const rejected = await rejectPlanningProposal(await getAccessToken(), projectId, selected.id);
      setProposals((current) =>
        (current ?? []).map((proposal) => (proposal.id === rejected.id ? rejected : proposal)),
      );
      setNotice("Proposal rejected. The project was not changed.");
    } catch (cause) {
      setError(toRequestError(cause));
    } finally {
      setActing(false);
    }
  }

  return (
    <section className="panel editor-panel" aria-labelledby="planning-heading">
      <div className="panel-heading">
        <h2 id="planning-heading">Plan</h2>
        <span className="status status-dev">One model per task</span>
      </div>
      <p className="muted editor-intro">
        Planning asks one configured model for JSON, validates it independently, and stores it as a proposal. Nothing is
        applied until you accept it; accepting saves a new version, and locked components are never replaced.
      </p>

      <div className="planning-form">
        <label className="field" htmlFor="planning-route">
          <span className="field-label">Task</span>
          <select
            id="planning-route"
            value={route}
            onChange={(event) => setRoute(event.target.value as PlanningRoute)}
            disabled={busy}
          >
            {PLANNING_ROUTES.map((item) => (
              <option key={item} value={item}>
                {PLANNING_ROUTE_LABELS[item]}
              </option>
            ))}
          </select>
          <span className="hint">{PLANNING_ROUTE_HINTS[route]}</span>
        </label>

        <label className="field" htmlFor="planning-instruction">
          <span className="field-label">Instruction (optional)</span>
          <textarea
            id="planning-instruction"
            rows={2}
            maxLength={500}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            disabled={busy}
          />
        </label>

        <div className="editor-actions">
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={busy || dirty || otherTabGenerating || leaseSettling || remoteAttemptUntil !== null}
          >
            {checkingAttempt ? "Checking..." : generating ? "Generating..." : "Generate proposal"}
          </button>
          {generating && (
            <button type="button" className="button-secondary" onClick={handleStop}>
              Stop waiting
            </button>
          )}
          <p className="hint">
            {dirty
              ? "Save or discard the draft first: planning is generated from the saved version."
              : otherTabGenerating
                ? "Another tab is generating a proposal for this project. Wait for it to finish before starting one here."
                : remoteAttemptUntil !== null
                  ? "Another device is generating a proposal for this project. This tab will unlock when the server's attempt window ends."
                  : leaseSettling
                  ? "Checking whether this tab owns the project lease before reusing it."
                  : "Each attempt uses one Idempotency-Key; a retry after a lost response replays it instead of calling the provider again."}
          </p>
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

      <div className="planning-layout">
        <div className="planning-history">
          <h3>Proposals</h3>
          {!proposals && !error && <p className="muted">Loading proposals...</p>}
          {proposals && proposals.length === 0 && <p className="empty-state">No proposals yet.</p>}
          <ul className="planning-proposals">
            {[...(proposals ?? [])].reverse().map((proposal) => (
              <li key={proposal.id}>
                <button
                  type="button"
                  className={proposal.id === selectedId ? "planning-proposal planning-proposal-active" : "planning-proposal"}
                  onClick={() => setSelectedId(proposal.id)}
                >
                  <span>{proposal.route === "legacy" ? "Recorded" : PLANNING_ROUTE_LABELS[proposal.route as PlanningRoute]}</span>
                  <span className="hint">
                    {statusLabel(proposal.status)} · v{proposal.baseVersion} · {proposal.modelId}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <h3>Recent attempts</h3>
          {attempts.length === 0 ? (
            <p className="hint">No attempts recorded in this browser.</p>
          ) : (
            <ul className="planning-list">
              {[...attempts].reverse().map((attempt, index) => (
                <li key={`${attempt.at}-${index}`}>
                  <span>{PLANNING_ROUTE_LABELS[attempt.route]}</span>{" "}
                  <span className="hint">
                    {ATTEMPT_LABELS[attempt.outcome]}
                    {attempt.code ? ` · ${attempt.code}` : ""} · {new Date(attempt.at).toLocaleTimeString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="planning-review">
          {!selected && <p className="empty-state">Select a proposal to review it.</p>}
          {selected && selectedPayload && (
            <article aria-label="Proposal review">
              <div className="panel-heading">
                <h3>
                  {selected.route === "legacy" ? "Recorded proposal" : PLANNING_ROUTE_LABELS[selected.route as PlanningRoute]}
                </h3>
                <span className={selected.status === "accepted" ? "status status-ok" : "status"}>
                  {statusLabel(selected.status)}
                </span>
              </div>
              <p className="hint">
                {selected.modelId} · generated from version {selected.baseVersion} · {new Date(selected.createdAt).toLocaleString()}
              </p>

              {selectedPayload.insufficientEvidence && (
                <div className="alert" role="status">
                  <strong>Planning notes only</strong>
                  <p>No sourced script was produced because no source excerpt was supplied.</p>
                </div>
              )}
              {selectedPayload.repairAttempted && (
                <p className="notice" role="status">
                  The first reply failed validation; this is the single repaired reply.
                </p>
              )}

              <p>{selectedPayload.summary}</p>
              {listOf(selectedPayload.notes).length > 0 && (
                <ul className="planning-list">
                  {listOf(selectedPayload.notes).map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}

              {listOf(selectedPayload.angles).length > 0 && (
                <AngleList
                  angles={listOf(selectedPayload.angles)}
                  disabled={busy}
                  onUse={handleUseAngle}
                />
              )}
              {listOf(selectedPayload.scenes).length > 0 && <ScenarioList scenes={listOf(selectedPayload.scenes)} />}
              {listOf(selectedPayload.clips).length > 0 && <ClipList clips={listOf(selectedPayload.clips)} />}
              {listOf(selectedPayload.claims).length > 0 && (
                <>
                  <h4>Claims</h4>
                  <ClaimList claims={listOf(selectedPayload.claims)} />
                </>
              )}

              {selected.status === "proposed" && (
                <div className="editor-actions">
                  <button type="button" onClick={() => void handleAccept()} disabled={!canAct}>
                    {acting ? "Working..." : "Accept and save"}
                  </button>
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => void handleReject()}
                    disabled={!canAct}
                  >
                    Reject
                  </button>
                  <p className="hint">
                    {dirty
                      ? "Save or discard the draft before accepting: accepting writes a new version from the stored one."
                      : `${scenes.length} scene${scenes.length === 1 ? "" : "s"} currently stored; locked components are kept.`}
                  </p>
                </div>
              )}

              {selected.status !== "accepted" && (
                <div className="editor-actions">
                  {confirmingDeleteId === selected.id ? (
                    <>
                      <button type="button" className="button-danger" onClick={() => void handleDeleteProposal()} disabled={busy}>
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => setConfirmingDeleteId(null)}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                      <p className="hint">Deleting removes this proposal record. The project is unchanged.</p>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => setConfirmingDeleteId(selected.id)}
                      disabled={busy}
                    >
                      Delete proposal
                    </button>
                  )}
                </div>
              )}
            </article>
          )}
        </div>
      </div>
    </section>
  );
}
