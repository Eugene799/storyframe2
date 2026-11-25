import type { MediaStatus } from "../shared/media-contract";
import { MEDIA_OBJECT_PREFIX, type MediaAuditRow } from "./media";
import type { R2Client, R2ListedObject } from "./r2";

export { MEDIA_OBJECT_PREFIX };

/**
 * Read-only bucket-vs-database audit.
 *
 * Media rows and objects are removed in an order that normally leaves no drift:
 * the row is removed only after the object removal was attempted, and project
 * deletion reads every object key before the rows cascade. A bucket failure or
 * a crash between those steps can still leave one of the two sides behind, and
 * the deleted rows are gone, so no route can find the object any more. This
 * audit lists both sides in full and reports the difference.
 *
 * It never deletes anything: the caller decides what a finding means.
 */

export const MEDIA_AUDIT_ROW_PAGE = 500;
export const MEDIA_AUDIT_OBJECT_PAGE = 1000;
/** Reported entries per side; the counts are always complete. */
export const MEDIA_AUDIT_MAX_ENTRIES = 100;

export interface MediaAuditMissingObject {
  id: string;
  ownerId: string;
  projectId: string;
  objectKey: string;
  status: MediaStatus;
}

export interface MediaAuditReport {
  prefix: string;
  /** Rows found in `media_metadata`. */
  rows: number;
  /** Objects found in the bucket under the prefix. */
  objects: number;
  objectBytes: number;
  statuses: Record<MediaStatus, number>;
  /** Bucket objects that no media row owns. */
  orphanObjects: R2ListedObject[];
  orphanObjectCount: number;
  /** Ready rows whose object is missing, so playback would fail. */
  missingObjects: MediaAuditMissingObject[];
  missingObjectCount: number;
}

export interface MediaAuditOptions {
  store: { listStoredObjects(limit: number, afterId?: string): Promise<MediaAuditRow[]> };
  objects: Pick<R2Client, "listObjects">;
  rowPageSize?: number;
  objectPageSize?: number;
  maxEntries?: number;
}

/** True when the bucket and the media table disagree in either direction. */
export function hasMediaAuditDrift(report: MediaAuditReport): boolean {
  return report.orphanObjectCount > 0 || report.missingObjectCount > 0;
}

export async function auditMedia(options: MediaAuditOptions): Promise<MediaAuditReport> {
  const rowPageSize = Math.max(1, Math.floor(options.rowPageSize ?? MEDIA_AUDIT_ROW_PAGE));
  const objectPageSize = Math.min(
    1000,
    Math.max(1, Math.floor(options.objectPageSize ?? MEDIA_AUDIT_OBJECT_PAGE)),
  );
  const maxEntries = Math.max(0, Math.floor(options.maxEntries ?? MEDIA_AUDIT_MAX_ENTRIES));

  // The bucket side is held in memory so each row can be checked in one pass.
  // This is a maintenance command, not a request path.
  const objectsByKey = new Map<string, number>();
  let objectBytes = 0;
  let continuationToken: string | null = null;
  for (;;) {
    const page = await options.objects.listObjects(MEDIA_OBJECT_PREFIX, {
      continuationToken,
      maxKeys: objectPageSize,
    });
    for (const object of page.objects) {
      objectsByKey.set(object.key, object.byteSize);
      objectBytes += object.byteSize;
    }
    if (page.nextToken === null || page.nextToken === continuationToken) break;
    continuationToken = page.nextToken;
  }

  const statuses: Record<MediaStatus, number> = { pending: 0, ready: 0, deleted: 0 };
  const rowKeys = new Set<string>();
  const missingObjects: MediaAuditMissingObject[] = [];
  let missingObjectCount = 0;
  let rows = 0;
  let afterId: string | undefined;
  for (;;) {
    const page = await options.store.listStoredObjects(rowPageSize, afterId);
    if (page.length === 0) break;
    for (const row of page) {
      rows += 1;
      statuses[row.status] += 1;
      rowKeys.add(row.objectKey);
      // A pending upload legitimately has no object yet, and a deleted row's
      // object is removed before the row, so only a ready row is real drift.
      if (row.status === "ready" && !objectsByKey.has(row.objectKey)) {
        missingObjectCount += 1;
        if (missingObjects.length < maxEntries) {
          missingObjects.push({
            id: row.id,
            ownerId: row.ownerId,
            projectId: row.projectId,
            objectKey: row.objectKey,
            status: row.status,
          });
        }
      }
    }
    if (page.length < rowPageSize) break;
    const nextAfterId = page[page.length - 1].id;
    // Defensive: a store that ignores the cursor must not loop forever.
    if (nextAfterId === afterId) break;
    afterId = nextAfterId;
  }

  const orphanObjects: R2ListedObject[] = [];
  let orphanObjectCount = 0;
  for (const [key, byteSize] of objectsByKey) {
    if (rowKeys.has(key)) continue;
    orphanObjectCount += 1;
    if (orphanObjects.length < maxEntries) orphanObjects.push({ key, byteSize });
  }

  return {
    prefix: MEDIA_OBJECT_PREFIX,
    rows,
    objects: objectsByKey.size,
    objectBytes,
    statuses,
    orphanObjects,
    orphanObjectCount,
    missingObjects,
    missingObjectCount,
  };
}
