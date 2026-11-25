import type { ProjectScene } from "./project-contract";

/**
 * Exact content fingerprint for a scene's approved storyboard content.
 *
 * It covers the fields a viewer would see, not revision counters or timestamps,
 * so editing narration in a typing burst changes the fingerprint on the first
 * differing character. The 64-bit FNV-1a hash is used only for display and
 * staleness comparison; it is not a security boundary.
 */
export type FingerprintScene = Pick<
  ProjectScene,
  "heading" | "body" | "visualDirection" | "onScreenText" | "durationSeconds" | "assetIds"
>;

export function sceneFingerprint(scene: FingerprintScene): string {
  // Canonical form: fixed field order, every value explicitly present.
  const canonical = JSON.stringify([
    scene.heading,
    scene.body,
    scene.visualDirection,
    scene.onScreenText,
    scene.durationSeconds,
    scene.assetIds,
  ]);

  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= BigInt(canonical.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
