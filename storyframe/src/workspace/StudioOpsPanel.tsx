import { useEffect, useState } from "react";
import type {
  BillingInterval,
  PreWorkChargeQuote,
  ProjectCostSummary,
  ProviderRateCardEntry,
  SubscriptionPlanDefinition,
  SubscriptionPlanId,
  UserEntitlementRecord,
} from "../../shared/billing-contract";
import type {
  ApiCredentialRecord,
  BrandRecipeRecord,
  DisasterRecoveryDrillResult,
  DisasterScenarioId,
  LaunchAuditReport,
  LoadTestSummaryResult,
  ProjectTemplateRecord,
  WorkspaceMemberRecord,
  WorkspaceRole,
} from "../../shared/studio-ops-contract";
import {
  approveStudioLaunchAudit,
  createStudioBrandRecipe,
  getGlobalStudioState,
  inviteStudioMember,
  issueStudioApiKey,
  quoteStudioCharge,
  revokeStudioApiKey,
  revokeStudioMember,
  runStudioDrDrill,
  runStudioLoadTest,
  updateStudioBillingPlan,
} from "../api";

interface StudioOpsPanelProps {
  getAccessToken: () => Promise<string>;
}

export function StudioOpsPanel({ getAccessToken }: StudioOpsPanelProps) {
  const [rateCard, setRateCard] = useState<ProviderRateCardEntry[]>([]);
  const [plans, setPlans] = useState<SubscriptionPlanDefinition[]>([]);
  const [entitlement, setEntitlement] = useState<UserEntitlementRecord | null>(null);
  const [costSummary, setCostSummary] = useState<ProjectCostSummary | null>(null);
  const [members, setMembers] = useState<WorkspaceMemberRecord[]>([]);
  const [brandRecipes, setBrandRecipes] = useState<BrandRecipeRecord[]>([]);
  const [apiCredentials, setApiCredentials] = useState<ApiCredentialRecord[]>([]);
  const [templates, setTemplates] = useState<ProjectTemplateRecord[]>([]);
  const [drDrills, setDrDrills] = useState<DisasterRecoveryDrillResult[]>([]);
  const [loadTest, setLoadTest] = useState<LoadTestSummaryResult | null>(null);
  const [launchAudit, setLaunchAudit] = useState<LaunchAuditReport | null>(null);

  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlanId>("pro");
  const [billingInterval, setBillingInterval] = useState<BillingInterval>("monthly");
  const [autoTopUp, setAutoTopUp] = useState(false);
  const [spendingCeiling, setSpendingCeiling] = useState("25");
  const [chargeQuote, setChargeQuote] = useState<PreWorkChargeQuote | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("editor");

  const [brandName, setBrandName] = useState("");
  const [brandPrimaryColor, setBrandPrimaryColor] = useState("#f4b860");

  const [apiKeyLabel, setApiKeyLabel] = useState("");
  const [newPlainTextKey, setNewPlainTextKey] = useState<string | null>(null);

  const [selectedScenario, setSelectedScenario] = useState<DisasterScenarioId>("provider-outage");

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadAll();
  }, []);

  async function loadAll() {
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const state = await getGlobalStudioState(token);
      setRateCard(state.rateCard);
      setPlans(state.plans);
      setEntitlement(state.entitlement);
      setSelectedPlan(state.entitlement.planId);
      setBillingInterval(state.entitlement.billingInterval);
      setAutoTopUp(state.entitlement.autoTopUpEnabled);
      setCostSummary(state.costSummary);
      setMembers(state.members);
      setBrandRecipes(state.brandRecipes);
      setApiCredentials(state.apiCredentials);
      setTemplates(state.templates);
      setDrDrills(state.drDrills);
      setLoadTest(state.lastLoadTest);
      setLaunchAudit(state.launchAudit);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to load studio operations.");
    }
  }

  async function handleUpdatePlan() {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const updated = await updateStudioBillingPlan(token, {
        planId: selectedPlan,
        billingInterval,
        autoTopUpEnabled: autoTopUp,
        spendingCeilingUsd: autoTopUp ? Number(spendingCeiling) || 25 : null,
      });
      setEntitlement(updated);
      setStatusMessage(
        `Updated subscription plan to ${updated.planId.toUpperCase()} (${updated.billingInterval}).`,
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Plan update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleQuoteRender() {
    setBusy(true);
    try {
      const token = await getAccessToken();
      const quote = await quoteStudioCharge(token, {
        operation: "1080p 60s Video Render",
        provider: "json2video",
        modelOrTier: "v2-hd-30fps",
        units: 1,
      });
      setChargeQuote(quote);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Quote failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleInviteMember() {
    if (!inviteEmail.trim()) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const member = await inviteStudioMember(token, {
        email: inviteEmail,
        role: inviteRole,
      });
      setMembers((prev) => [member, ...prev]);
      setInviteEmail("");
      setStatusMessage(`Sent expiring workspace invitation to ${member.memberEmail} (${member.role}).`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Invite failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRevokeMember(memberId: string) {
    setBusy(true);
    try {
      const token = await getAccessToken();
      const updated = await revokeStudioMember(token, memberId);
      setMembers((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      setStatusMessage(`Revoked workspace access for ${updated.memberEmail}.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Revoke failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateBrand() {
    if (!brandName.trim()) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const recipe = await createStudioBrandRecipe(token, {
        name: brandName,
        headingFont: "Fraunces",
        bodyFont: "Inter",
        primaryColor: brandPrimaryColor,
        accentColor: "#63b3ed",
        backgroundColor: "#0b0f16",
        captionStyle: "minimal-lower",
        voicePreference: "warm",
        defaultPreset: "documentary",
        pacingBeatsPerMinute: 18,
        introText: brandName,
        outroText: "Subscribe for more",
        approvedReferenceNotes: "Standard brand kit recipe.",
      });
      setBrandRecipes((prev) => [...prev, recipe]);
      setBrandName("");
      setStatusMessage(`Created reusable brand recipe "${recipe.name}".`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Brand creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleIssueApiKey() {
    setBusy(true);
    try {
      const token = await getAccessToken();
      const res = await issueStudioApiKey(token, {
        label: apiKeyLabel || "Production Pipeline Key",
        scopes: ["projects:read", "projects:write", "renders:write"],
      });
      setApiCredentials((prev) => [res.credential, ...prev]);
      setNewPlainTextKey(res.plainTextKeyOnce);
      setApiKeyLabel("");
      setStatusMessage(`Issued scoped API key ${res.credential.keyPrefix}…`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not issue API key.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRevokeApiKey(id: string) {
    setBusy(true);
    try {
      const token = await getAccessToken();
      const revoked = await revokeStudioApiKey(token, id);
      setApiCredentials((prev) => prev.map((k) => (k.id === revoked.id ? revoked : k)));
      setStatusMessage(`Revoked API credential ${revoked.keyPrefix}…`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Revoke failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleApproveLaunch() {
    setBusy(true);
    try {
      const token = await getAccessToken();
      const report = await approveStudioLaunchAudit(token);
      setLaunchAudit(report);
      setStatusMessage(`Approved release ${report.buildId} for production launch.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Launch approval failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRunDrill() {
    setBusy(true);
    try {
      const token = await getAccessToken();
      const drill = await runStudioDrDrill(token, selectedScenario);
      setDrDrills((prev) => [drill, ...prev.filter((d) => d.scenario !== drill.scenario)]);
      setStatusMessage(`Verified disaster recovery drill: ${drill.title}.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Drill failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRunLoadTest() {
    setBusy(true);
    try {
      const token = await getAccessToken();
      const summary = await runStudioLoadTest(token, 25);
      setLoadTest(summary);
      setStatusMessage(
        `Completed concurrency load test (${summary.concurrentUsers} users, p95=${summary.p95LatencyMs}ms).`,
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Load test failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" data-testid="studio-ops-panel">
      <div className="panel-header">
        <div>
          <h2>Billing, Cost Ledger, Team, API & Launch Audit (Phases 14–22)</h2>
          <p className="muted">
            Versioned 6-provider rate card, subscription tiers ($29 / $79 / $199), workspace roles, brand recipes, public API keys, disaster recovery drills, and launch release gate.
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
          <strong>STUDIO_OPS_ERROR</strong>
          <p>{errorMessage}</p>
        </div>
      )}

      {/* Phase 15: Subscription Pricing & Entitlements */}
      {entitlement && (
        <div className="scene-card">
          <h3>Phase 15: Subscription Plan & Metering</h3>
          <dl className="metrics">
            <div>
              <dt>Active Plan</dt>
              <dd>{entitlement.planId.toUpperCase()} ({entitlement.billingInterval})</dd>
            </div>
            <div>
              <dt>AI Allowance Used</dt>
              <dd>${entitlement.aiAllowanceUsdUsed.toFixed(4)} / ${entitlement.aiAllowanceUsdLimit.toFixed(2)}</dd>
            </div>
            <div>
              <dt>Promotional Credits</dt>
              <dd>${entitlement.promotionalCreditsUsd.toFixed(4)}</dd>
            </div>
            <div>
              <dt>Source Processing</dt>
              <dd>{entitlement.sourceMinutesUsed} / {entitlement.sourceMinutesLimit} min</dd>
            </div>
            <div>
              <dt>Seats & Brand Kits</dt>
              <dd>{entitlement.seatsLimit} seats · {entitlement.brandKitsLimit} kits</dd>
            </div>
            <div>
              <dt>Max Concurrency & Batch</dt>
              <dd>{entitlement.maxConcurrentJobs} jobs · {entitlement.maxRepurposeBatchSize} clips</dd>
            </div>
          </dl>

          <div className="field-grid" style={{ marginTop: "0.75rem" }}>
            <label>
              <span>Select Plan Tier</span>
              <select
                aria-label="Select Plan Tier"
                value={selectedPlan}
                onChange={(e) => setSelectedPlan(e.target.value as SubscriptionPlanId)}
              >
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — ${p.monthlyPriceUsd}/mo or ${p.annualPriceUsd}/yr ({p.seats} seats, {p.storageGb}GB)
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Billing Interval</span>
              <select
                aria-label="Billing Interval"
                value={billingInterval}
                onChange={(e) => setBillingInterval(e.target.value as BillingInterval)}
              >
                <option value="monthly">Monthly</option>
                <option value="annual">Annual (2 Months Free)</option>
              </select>
            </label>
            <label className="lock-toggle">
              <input
                type="checkbox"
                checked={autoTopUp}
                onChange={(e) => setAutoTopUp(e.target.checked)}
              />
              <span>Enable Optional Auto-Top-Up (No default overages)</span>
            </label>
            {autoTopUp && (
              <label>
                <span>Explicit Spending Ceiling (USD)</span>
                <input
                  aria-label="Explicit Spending Ceiling"
                  value={spendingCeiling}
                  onChange={(e) => setSpendingCeiling(e.target.value)}
                />
              </label>
            )}
          </div>
          <div className="button-row" style={{ marginTop: "0.5rem" }}>
            <button type="button" className="primary" onClick={handleUpdatePlan} disabled={busy}>
              Save Subscription Plan
            </button>
            <button type="button" onClick={handleQuoteRender} disabled={busy}>
              Preview Pre-Work Max Charge Quote
            </button>
          </div>
          {chargeQuote && (
            <div className="notice" style={{ marginTop: "0.5rem" }}>
              <strong>Pre-Work Charge Disclosure ({chargeQuote.operation}):</strong> Estimated $
              {chargeQuote.estimatedChargeUsd.toFixed(4)} · Maximum Possible Charge: $
              {chargeQuote.maximumChargeUsd.toFixed(4)} · Covered by Allowance:{" "}
              <strong>{chargeQuote.coveredByAllowance ? "Yes" : "No"}</strong>
            </div>
          )}
        </div>
      )}

      {/* Phase 14: Actual Cost Ledger & Model-Price Matching */}
      {costSummary && (
        <div className="scene-card" style={{ marginTop: "1rem" }}>
          <h3>Phase 14: Actual Cost Ledger & Versioned Rate Card ({costSummary.rateCardVersion})</h3>
          <dl className="metrics">
            <div>
              <dt>Estimated Total</dt>
              <dd>${costSummary.totals.estimatedUsd.toFixed(4)}</dd>
            </div>
            <div>
              <dt>Reserved Allowance</dt>
              <dd>${costSummary.totals.reservedUsd.toFixed(4)}</dd>
            </div>
            <div>
              <dt>Settled / Reconciled</dt>
              <dd>${costSummary.totals.settledUsd.toFixed(4)}</dd>
            </div>
            <div>
              <dt>Promo Credits Applied</dt>
              <dd>${costSummary.totals.promotionalCreditsUsd.toFixed(4)}</dd>
            </div>
            <div>
              <dt>Unknown Pricing Rows</dt>
              <dd>{costSummary.totals.unknownCount}</dd>
            </div>
          </dl>
          <details style={{ marginTop: "0.5rem" }}>
            <summary>Inspect Versioned 6-Provider Rate Card ({rateCard.length} tiers)</summary>
            <ul>
              {rateCard.map((r, idx) => (
                <li key={idx}>
                  <strong>{r.provider}</strong> ({r.modelOrTier}): $
                  {r.rateUsd?.toFixed(4) ?? "unknown"} per {r.unitName} [{r.confidence}] — {r.notes}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {/* Phase 16B & 16C: Workspace Team & Brand Recipes */}
      <div className="scene-card" style={{ marginTop: "1rem" }}>
        <h3>Phase 16B & 16C: Workspace Team Roles & Brand Recipes</h3>
        <div className="field-grid">
          <label>
            <span>Invite Team Member Email</span>
            <input
              aria-label="Invite Team Member Email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="editor@example.com"
            />
          </label>
          <label>
            <span>Role</span>
            <select
              aria-label="Invite Role"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as WorkspaceRole)}
            >
              <option value="admin">Admin</option>
              <option value="editor">Editor</option>
              <option value="reviewer">Reviewer</option>
              <option value="viewer">Viewer</option>
            </select>
          </label>
          <div className="button-row">
            <button type="button" onClick={handleInviteMember} disabled={busy}>
              Send Expiring Invite
            </button>
          </div>
        </div>
        {members.length > 0 && (
          <ul className="revision-list" style={{ marginTop: "0.5rem" }}>
            {members.map((m) => (
              <li key={m.id} className="revision-item">
                <div>
                  <strong>{m.memberEmail}</strong> ({m.role}) — Status: <code>{m.status}</code> ·
                  Expires: {m.expiresAt.slice(0, 10)}
                </div>
                {m.status !== "revoked" && (
                  <button type="button" onClick={() => handleRevokeMember(m.id)}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="field-grid" style={{ marginTop: "0.75rem" }}>
          <label>
            <span>New Brand Recipe Name</span>
            <input
              aria-label="New Brand Recipe Name"
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
              placeholder="Acme Tech Documentary"
            />
          </label>
          <label>
            <span>Primary Brand Color</span>
            <input
              aria-label="Primary Brand Color"
              value={brandPrimaryColor}
              onChange={(e) => setBrandPrimaryColor(e.target.value)}
            />
          </label>
          <div className="button-row">
            <button type="button" onClick={handleCreateBrand} disabled={busy}>
              Create Brand Recipe
            </button>
          </div>
        </div>
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          Active Brand Recipes ({brandRecipes.length}):{" "}
          {brandRecipes.map((b) => `${b.name} (${b.primaryColor})`).join(" · ")}
        </p>
      </div>

      {/* Phase 21: Public API Credentials & Sanitized Templates */}
      <div className="scene-card" style={{ marginTop: "1rem" }}>
        <h3>Phase 21: Scoped Public API Credentials & Templates</h3>
        <div className="field-grid">
          <label>
            <span>API Key Label</span>
            <input
              aria-label="API Key Label"
              value={apiKeyLabel}
              onChange={(e) => setApiKeyLabel(e.target.value)}
              placeholder="CI/CD Automation Token"
            />
          </label>
          <div className="button-row">
            <button type="button" onClick={handleIssueApiKey} disabled={busy}>
              Issue Scoped API Key
            </button>
          </div>
        </div>
        {newPlainTextKey && (
          <div className="notice" style={{ marginTop: "0.5rem" }}>
            <strong>Copy API Secret Now (Shown Once):</strong> <code>{newPlainTextKey}</code>
          </div>
        )}
        {apiCredentials.length > 0 && (
          <ul className="revision-list" style={{ marginTop: "0.5rem" }}>
            {apiCredentials.map((cred) => (
              <li key={cred.id} className="revision-item">
                <div>
                  <strong>{cred.label}</strong> (<code>{cred.keyPrefix}…</code>) — Scopes:{" "}
                  {cred.scopes.join(", ")} · Status: <code>{cred.status}</code>
                </div>
                {cred.status === "active" && (
                  <button type="button" onClick={() => handleRevokeApiKey(cred.id)}>
                    Revoke Key
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {templates.length > 0 && (
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            Sanitized Reusable Templates ({templates.length}):{" "}
            {templates.map((t) => t.name).join(" · ")}
          </p>
        )}
      </div>

      {/* Phase 22: Load Testing & Disaster Recovery */}
      <div className="scene-card" style={{ marginTop: "1rem" }}>
        <h3>Phase 22: Concurrency Load Testing & Disaster Recovery Drills</h3>
        <div className="field-grid">
          <label>
            <span>Disaster Recovery Scenario</span>
            <select
              aria-label="Disaster Recovery Scenario"
              value={selectedScenario}
              onChange={(e) => setSelectedScenario(e.target.value as DisasterScenarioId)}
            >
              <option value="provider-outage">Upstream Provider Outage Failover</option>
              <option value="stuck-render-job">Stuck JSON2Video Render Reconciliation</option>
              <option value="quota-exhaustion">Daily Allowance & Concurrency Exhaustion</option>
              <option value="billing-webhook-failure">Duplicate Billing Webhook Replay</option>
              <option value="storage-object-loss">Orphaned / Missing R2 Object Audit</option>
              <option value="secret-rotation">Zero-Downtime API Key Rotation</option>
              <option value="failed-migration-rollback">Database Migration Preflight Rollback</option>
            </select>
          </label>
          <div className="button-row">
            <button type="button" onClick={handleRunDrill} disabled={busy}>
              Run Recovery Drill
            </button>
            <button type="button" onClick={handleRunLoadTest} disabled={busy}>
              Run 25-User Concurrency Load Simulation
            </button>
          </div>
        </div>
        {loadTest && (
          <p className="notice" style={{ marginTop: "0.5rem" }}>
            <strong>Load Test Result:</strong> {loadTest.concurrentUsers} concurrent users ·{" "}
            {loadTest.totalRequests} requests · Accepted within bounds:{" "}
            {loadTest.acceptedWithinBounds} · Gracefully throttled (HTTP 429):{" "}
            {loadTest.throttledGracefully} · p95 latency: {loadTest.p95LatencyMs}ms.
          </p>
        )}
        {drDrills.map((d) => (
          <div key={d.id} className="notice" style={{ marginTop: "0.5rem" }}>
            <strong>{d.title}</strong> (RTO {d.rtoTargetMinutes}m / RPO {d.rpoTargetMinutes}m) —{" "}
            {d.automatedMitigation}
          </div>
        ))}
      </div>

      {/* Phase 17: Launch Audit & Approved Release Gate */}
      {launchAudit && (
        <div className="scene-card" style={{ marginTop: "1rem" }}>
          <div className="panel-header">
            <div>
              <h3>Phase 17: Launch Audit & Approved Release Gate ({launchAudit.buildId})</h3>
              <p className="muted">
                Overall Gate: <strong>{launchAudit.overallStatus}</strong> · Release Approved:{" "}
                <strong>{launchAudit.releaseApproved ? `YES (by ${launchAudit.approvedBy})` : "AWAITING APPROVAL"}</strong>
              </p>
            </div>
            {!launchAudit.releaseApproved && (
              <button
                type="button"
                className="primary"
                onClick={handleApproveLaunch}
                disabled={busy}
              >
                Approve Release for Launch
              </button>
            )}
          </div>
          <ul>
            {launchAudit.checks.map((c) => (
              <li key={c.id}>
                <strong>[{c.status}]</strong> ({c.phase}) {c.title} —{" "}
                <span className="muted">{c.evidence}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
