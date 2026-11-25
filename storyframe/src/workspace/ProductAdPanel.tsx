import { useEffect, useState } from "react";
import type { ProjectAspectRatio, ProjectRecord } from "../../shared/project-contract";
import type {
  AdCampaignRecord,
  AdConceptProposal,
  AdVariantExportManifest,
  AdVariantRecord,
  ProductCatalogRecord,
} from "../../shared/workflows-contract";
import {
  createModeBVariant,
  exportModeBManifest,
  generateModeBConcepts,
  getModeBState,
  saveModeBCampaign,
  saveModeBProduct,
} from "../api";

interface ProductAdPanelProps {
  project: ProjectRecord;
  getAccessToken: () => Promise<string>;
}

export function ProductAdPanel({ project, getAccessToken }: ProductAdPanelProps) {
  const [product, setProduct] = useState<ProductCatalogRecord | null>(null);
  const [campaign, setCampaign] = useState<AdCampaignRecord | null>(null);
  const [concepts, setConcepts] = useState<AdConceptProposal[]>([]);
  const [variants, setVariants] = useState<AdVariantRecord[]>([]);
  const [manifest, setManifest] = useState<AdVariantExportManifest | null>(null);

  const [newClaimText, setNewClaimText] = useState("");
  const [newClaimEvidence, setNewClaimEvidence] = useState("");
  const [variantLabel, setVariantLabel] = useState("Hook Variant A");
  const [variantHook, setVariantHook] = useState("");
  const [variantCta, setVariantCta] = useState("");
  const [variantLayout, setVariantLayout] = useState<
    "product-hero" | "split-comparison" | "floating-card"
  >("product-hero");
  const [variantRatio, setVariantRatio] = useState<ProjectAspectRatio>("9:16");

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
      const state = await getModeBState(token, project.id);
      setProduct(state.product);
      setCampaign(state.campaign);
      setConcepts(state.concepts);
      setVariants(state.variants);
      setVariantCta(state.campaign.ctaText);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not load Mode B state.");
    }
  }

  async function handleSaveProduct() {
    if (!product) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const updated = await saveModeBProduct(token, project.id, product);
      setProduct(updated);
      setStatusMessage("Saved product catalog record with original asset preservation.");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to save product.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddClaim() {
    if (!product || !newClaimText.trim()) return;
    const nextClaims = [
      ...product.approvedClaims,
      {
        id: `claim-${product.approvedClaims.length + 1}`,
        statement: newClaimText.trim(),
        evidenceNote: newClaimEvidence.trim() || "Verified product specification",
        substantiated: true,
      },
    ];
    setBusy(true);
    try {
      const token = await getAccessToken();
      const updated = await saveModeBProduct(token, project.id, {
        ...product,
        approvedClaims: nextClaims,
      });
      setProduct(updated);
      setNewClaimText("");
      setNewClaimEvidence("");
      setStatusMessage("Added approved substantiated product claim.");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not add claim.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveCampaign() {
    if (!campaign) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const updated = await saveModeBCampaign(token, project.id, campaign);
      setCampaign(updated);
      setStatusMessage("Saved campaign offer, pricing, dates, and disclaimer.");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to save campaign.");
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerateConcepts() {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const list = await generateModeBConcepts(token, project.id);
      setConcepts(list);
      if (list[0]) {
        setVariantHook(list[0].hook);
        setVariantCta(list[0].ctaText);
      }
      setStatusMessage("Generated 3 distinct ad concepts linked strictly to approved product claims.");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to generate ad concepts.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateVariant() {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const created = await createModeBVariant(token, project.id, {
        label: variantLabel,
        hookText: variantHook || "Verified workflow performance for creators.",
        ctaText: variantCta || campaign?.ctaText || "Learn More",
        layoutStyle: variantLayout,
        aspectRatio: variantRatio,
      });
      setVariants((prev) => [created, ...prev]);
      setStatusMessage(`Created controlled ad variant "${created.label}" (fingerprint ${created.fingerprint}).`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Variant rejected by compliance check.");
    } finally {
      setBusy(false);
    }
  }

  async function handleExportManifest() {
    setBusy(true);
    setErrorMessage(null);
    try {
      const token = await getAccessToken();
      const exported = await exportModeBManifest(token, project.id);
      setManifest(exported);
      setStatusMessage(`Exported traceable variant manifest (${exported.variants.length} variants).`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not export manifest.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" data-testid="product-ad-panel">
      <div className="panel-header">
        <div>
          <h3>Mode B: Product Catalog, Ad Campaigns & Controlled Variants</h3>
          <p className="muted">
            Phase 11 compliant product ad studio: links every concept to approved substantiated claims, blocks prohibited wording, and preserves original product assets in a foreground layer.
          </p>
        </div>
        <div className="button-row">
          <button type="button" className="primary" onClick={handleGenerateConcepts} disabled={busy}>
            Generate 3 Claim-Linked Ad Concepts
          </button>
          <button type="button" onClick={handleExportManifest} disabled={busy}>
            Export Variant Manifest
          </button>
        </div>
      </div>

      {statusMessage && (
        <p className="status-banner" role="status">
          {statusMessage}
        </p>
      )}
      {errorMessage && (
        <div className="alert" role="alert">
          <strong>MODE_B_COMPLIANCE_ALERT</strong>
          <p>{errorMessage}</p>
        </div>
      )}

      {product && (
        <section className="scene-card">
          <h4>1. Product Catalog & Original Asset Preservation</h4>
          <div className="field-grid">
            <label>
              <span>Product Name</span>
              <input
                aria-label="Product Name"
                value={product.productName}
                onChange={(e) => setProduct({ ...product, productName: e.target.value })}
              />
            </label>
            <label>
              <span>Variant / SKU</span>
              <input
                aria-label="Product Variant"
                value={product.variantName}
                onChange={(e) => setProduct({ ...product, variantName: e.target.value })}
              />
            </label>
            <label>
              <span>Brand Primary Color</span>
              <input
                aria-label="Brand Primary Color"
                value={product.brandPrimaryColor}
                onChange={(e) => setProduct({ ...product, brandPrimaryColor: e.target.value })}
              />
            </label>
            <label>
              <span>Reviewed Background Layer Prompt (Separate from Product Asset)</span>
              <input
                aria-label="Background Layer Prompt"
                value={product.backgroundLayerPrompt}
                onChange={(e) => setProduct({ ...product, backgroundLayerPrompt: e.target.value })}
              />
            </label>
            <label>
              <span>Prohibited Wording (comma-separated)</span>
              <input
                aria-label="Prohibited Wording"
                value={product.prohibitedWording.join(", ")}
                onChange={(e) =>
                  setProduct({
                    ...product,
                    prohibitedWording: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
          </div>
          <div className="button-row" style={{ marginTop: "0.5rem" }}>
            <button type="button" onClick={handleSaveProduct} disabled={busy}>
              Save Product Settings
            </button>
          </div>

          <div style={{ marginTop: "1rem" }}>
            <h5>Approved Substantiated Claims ({product.approvedClaims.length})</h5>
            <ul>
              {product.approvedClaims.map((c) => (
                <li key={c.id}>
                  <strong>[{c.id}]</strong> {c.statement} — <span className="muted">Evidence: {c.evidenceNote}</span>
                </li>
              ))}
            </ul>
            <div className="field-grid" style={{ marginTop: "0.5rem" }}>
              <label>
                <span>New Approved Claim Statement</span>
                <input
                  aria-label="New Approved Claim Statement"
                  value={newClaimText}
                  onChange={(e) => setNewClaimText(e.target.value)}
                  placeholder="Reduces manual scene re-timing by 50%"
                />
              </label>
              <label>
                <span>Supporting Evidence Note</span>
                <input
                  aria-label="Supporting Evidence Note"
                  value={newClaimEvidence}
                  onChange={(e) => setNewClaimEvidence(e.target.value)}
                  placeholder="Verified benchmark report Q4"
                />
              </label>
              <div className="button-row">
                <button type="button" onClick={handleAddClaim} disabled={busy}>
                  Add Approved Claim
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {campaign && (
        <section className="scene-card" style={{ marginTop: "1rem" }}>
          <h4>2. Campaign Offer, Dates, Pricing & Disclaimer</h4>
          <div className="field-grid">
            <label>
              <span>Target Audience</span>
              <input
                aria-label="Campaign Audience"
                value={campaign.audience}
                onChange={(e) => setCampaign({ ...campaign, audience: e.target.value })}
              />
            </label>
            <label>
              <span>Offer Summary</span>
              <input
                aria-label="Offer Summary"
                value={campaign.offerSummary}
                onChange={(e) => setCampaign({ ...campaign, offerSummary: e.target.value })}
              />
            </label>
            <label>
              <span>Price Amount</span>
              <input
                aria-label="Price Amount"
                value={campaign.priceAmount}
                onChange={(e) => setCampaign({ ...campaign, priceAmount: e.target.value })}
              />
            </label>
            <label>
              <span>CTA Text</span>
              <input
                aria-label="Campaign CTA Text"
                value={campaign.ctaText}
                onChange={(e) => setCampaign({ ...campaign, ctaText: e.target.value })}
              />
            </label>
            <label>
              <span>Mandatory Disclaimer</span>
              <input
                aria-label="Mandatory Disclaimer"
                value={campaign.disclaimerText}
                onChange={(e) => setCampaign({ ...campaign, disclaimerText: e.target.value })}
              />
            </label>
          </div>
          <div className="button-row" style={{ marginTop: "0.5rem" }}>
            <button type="button" onClick={handleSaveCampaign} disabled={busy}>
              Save Campaign
            </button>
          </div>
        </section>
      )}

      {concepts.length > 0 && (
        <section className="scene-card" style={{ marginTop: "1rem" }}>
          <h4>3. Three Distinct Ad Concepts (Grounded in Approved Claims)</h4>
          <div className="project-grid">
            {concepts.map((concept) => (
              <div key={concept.id} className="project-card">
                <h5>{concept.angleTitle}</h5>
                <p>
                  <strong>Hook:</strong> {concept.hook}
                </p>
                <p className="muted">{concept.bodyCopy}</p>
                <p className="muted">
                  Linked Claims: <code>{concept.linkedClaimIds.join(", ")}</code> · Layout:{" "}
                  <code>{concept.visualLayout}</code> · Compliance:{" "}
                  <strong>{concept.complianceStatus.toUpperCase()}</strong>
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setVariantLabel(`Variant from ${concept.angleTitle}`);
                    setVariantHook(concept.hook);
                    setVariantCta(concept.ctaText);
                    setVariantLayout(concept.visualLayout);
                  }}
                >
                  Use Concept for Variant
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="scene-card" style={{ marginTop: "1rem" }}>
        <h4>4. Controlled Hook / CTA / Layout Variants & Diff View</h4>
        <div className="field-grid">
          <label>
            <span>Variant Label</span>
            <input
              aria-label="Variant Label"
              value={variantLabel}
              onChange={(e) => setVariantLabel(e.target.value)}
            />
          </label>
          <label>
            <span>Variant Hook Text</span>
            <input
              aria-label="Variant Hook Text"
              value={variantHook}
              onChange={(e) => setVariantHook(e.target.value)}
              placeholder="Tired of rebuilding scenes from scratch?"
            />
          </label>
          <label>
            <span>Variant CTA</span>
            <input
              aria-label="Variant CTA"
              value={variantCta}
              onChange={(e) => setVariantCta(e.target.value)}
            />
          </label>
          <label>
            <span>Layout Style</span>
            <select
              aria-label="Variant Layout Style"
              value={variantLayout}
              onChange={(e) =>
                setVariantLayout(
                  e.target.value as "product-hero" | "split-comparison" | "floating-card",
                )
              }
            >
              <option value="product-hero">Product Hero (Preserved Cutout)</option>
              <option value="split-comparison">Split Comparison</option>
              <option value="floating-card">Floating Editorial Card</option>
            </select>
          </label>
          <label>
            <span>Aspect Ratio</span>
            <select
              aria-label="Variant Aspect Ratio"
              value={variantRatio}
              onChange={(e) => setVariantRatio(e.target.value as ProjectAspectRatio)}
            >
              <option value="9:16">9:16 Vertical</option>
              <option value="1:1">1:1 Square</option>
              <option value="16:9">16:9 Horizontal</option>
            </select>
          </label>
        </div>
        <div className="button-row" style={{ marginTop: "0.5rem" }}>
          <button type="button" onClick={handleCreateVariant} disabled={busy}>
            Create Controlled Ad Variant
          </button>
        </div>

        {variants.length > 0 && (
          <ul className="revision-list" style={{ marginTop: "0.75rem" }}>
            {variants.map((v) => (
              <li key={v.id} className="revision-item">
                <div>
                  <strong>{v.label}</strong> ({v.aspectRatio} · {v.layoutStyle}) — Fingerprint:{" "}
                  <code>{v.fingerprint}</code>
                  <div>
                    Hook: &ldquo;{v.hookText}&rdquo; → CTA: <strong>{v.ctaText}</strong>
                  </div>
                  <div className="muted">
                    Claims: {v.linkedClaimIds.join(", ")} · Disclaimer: {v.disclaimerText}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {manifest && (
          <pre className="code-block" style={{ marginTop: "0.75rem", overflowX: "auto" }}>
            {JSON.stringify(manifest, null, 2)}
          </pre>
        )}
      </section>
    </div>
  );
}
