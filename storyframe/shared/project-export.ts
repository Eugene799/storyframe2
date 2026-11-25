import type { MediaKind, MediaRecord } from "./media-contract";
import type { ProjectDocumentV2 } from "./project-contract";

/**
 * The licensed credit for one imported stock asset, in the shape an export or
 * a renderer needs. Only fields the UI and a credit line use are copied.
 */
export interface StockAssetCredit {
  mediaId: string;
  kind: MediaKind;
  provider: "pexels" | "pixabay";
  providerId: string;
  rendition: string;
  creator: string;
  attribution: string;
  sourcePage: string;
  license: string;
}

/** One asset's credit plus every scene that references it, for a credit roll. */
export interface StockCredit extends StockAssetCredit {
  sceneIds: string[];
}

export interface RenderScenePayload {
  sceneId: string;
  heading: string;
  durationSeconds: number;
  /** Attached assets that carry stock provenance, in scene order. */
  assets: StockAssetCredit[];
}

export interface ProjectExportPayload {
  title: string;
  /** The editable document exactly as the editor holds it. */
  document: ProjectDocumentV2;
  /** Unique stock assets referenced anywhere in the document. */
  credits: StockCredit[];
  /** What a renderer consumes: scenes with their credited assets. */
  renderPayload: { scenes: RenderScenePayload[] };
}

function assetCredit(media: MediaRecord): StockAssetCredit | null {
  const provenance = media.provenance;
  if (!provenance || media.status !== "ready") return null;
  return {
    mediaId: media.id,
    kind: media.kind,
    provider: provenance.provider,
    providerId: provenance.providerId,
    rendition: provenance.rendition,
    creator: provenance.creator,
    attribution: provenance.attribution,
    sourcePage: provenance.sourcePage,
    license: provenance.license,
  };
}

/**
 * Joins the document's asset ids to the media rows that hold their credit.
 * Ids that are missing, not ready, or not stock imports are simply absent: an
 * export never invents a creator or license for a file.
 */
export function buildProjectExport(
  title: string,
  document: ProjectDocumentV2,
  media: readonly MediaRecord[],
): ProjectExportPayload {
  const byId = new Map<string, StockAssetCredit>();
  for (const record of media) {
    const credit = assetCredit(record);
    if (credit) byId.set(record.id, credit);
  }

  const credits = new Map<string, StockCredit>();
  const scenes = document.scenes.map((scene) => {
    const assets: StockAssetCredit[] = [];
    const seen = new Set<string>();
    for (const id of scene.assetIds) {
      if (seen.has(id)) continue;
      const credit = byId.get(id);
      if (!credit) continue;
      seen.add(id);
      assets.push(credit);
      const existing = credits.get(id);
      if (existing) {
        if (!existing.sceneIds.includes(scene.id)) existing.sceneIds.push(scene.id);
      } else {
        credits.set(id, { ...credit, sceneIds: [scene.id] });
      }
    }
    return {
      sceneId: scene.id,
      heading: scene.heading,
      durationSeconds: scene.durationSeconds,
      assets,
    };
  });

  return {
    title,
    document,
    credits: [...credits.values()],
    renderPayload: { scenes },
  };
}

/** The plain-text script, with a credit block only when stock media is used. */
export function buildScriptText(payload: ProjectExportPayload): string {
  const script = payload.document.scenes
    .map((scene, index) =>
      [
        `SCENE ${index + 1} — ${scene.heading}`,
        "",
        scene.body || "(no narration)",
        "",
        `VISUAL: ${scene.visualDirection || "(none)"}`,
        `ON SCREEN: ${scene.onScreenText || "(none)"}`,
        `DURATION: ${scene.durationSeconds}s`,
      ].join("\n"),
    )
    .join("\n\n---\n\n");

  const credits =
    payload.credits.length === 0
      ? ""
      : [
          "",
          "---",
          "",
          "CREDITS",
          "",
          ...payload.credits.map(
            (credit) => `${credit.attribution} — ${credit.license} — ${credit.sourcePage}`,
          ),
        ].join("\n");

  return `${payload.title}\n\n${script}${credits}\n`;
}
