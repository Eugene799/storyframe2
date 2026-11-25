import { emptyDocument } from "../../shared/project-defaults";
import type { ProjectDocumentV2, ProjectScene, ProjectType } from "../../shared/project-contract";

export { emptyDocument };

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  story: "Explain / tell a story",
  "product-ad": "Product ad",
  repurpose: "Repurpose footage",
};

export function newSceneId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `scene-${globalThis.crypto.randomUUID()}`;
  }
  return `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function newScene(index: number): ProjectScene {
  return {
    id: newSceneId(),
    heading: `Scene ${index + 1}`,
    body: "",
    visualDirection: "",
    assetIds: [],
    onScreenText: "",
    durationSeconds: 0,
    approved: false,
    approvedFingerprint: null,
    locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
  };
}

export function createDocument(projectType: ProjectType): ProjectDocumentV2 {
  const document = emptyDocument(projectType);
  return { ...document, scenes: [newScene(0)] };
}

export function duplicateScene(scene: ProjectScene): ProjectScene {
  return {
    ...scene,
    id: newSceneId(),
    heading: `${scene.heading} (copy)`,
    approved: false,
    approvedFingerprint: null,
    locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
  };
}

export function moveScene(scenes: ProjectScene[], index: number, offset: -1 | 1): ProjectScene[] {
  const target = index + offset;
  if (target < 0 || target >= scenes.length) return scenes;
  const next = scenes.slice();
  const [scene] = next.splice(index, 1);
  next.splice(target, 0, scene);
  return next;
}

export function totalDurationSeconds(scenes: ProjectScene[]): number {
  return scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}
