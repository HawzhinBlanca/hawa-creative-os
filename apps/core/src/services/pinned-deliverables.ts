import crypto from 'node:crypto';
import type { PackageFile } from '@hawa/contracts';
import type { PinnedExport } from '@hawa/domain';
import type { CanvaConnectService } from './canva-connect-service.js';

/**
 * What a publication delivers: the stored Canva exports the reviewer pinned when approving, sent
 * byte for byte. Until 2026-09-19 both publish routes invented their files instead (twelve fixed
 * names and sizes whose "sha256" hashed a label, or one `sha256_png_hash`), and in production the
 * publisher uploaded zero-filled placeholders of those sizes.
 */
export interface DeliverableStore {
  /** Retrieved exports of the task with these ids; ids the store does not hold are left out. */
  find(tenantId: string, userId: string, taskId: string, artifactIds: string[]): Promise<PinnedExport[]>;
  /** The stored bytes of one export, or null when the store does not hold it. */
  read(tenantId: string, userId: string, taskId: string, artifactId: string): Promise<Uint8Array | null>;
}

/** A store that holds nothing: without durable Canva storage no export can be pinned or delivered. */
export const EMPTY_DELIVERABLE_STORE: DeliverableStore = {
  find: async () => [],
  read: async () => null,
};

export function canvaDeliverableStore(service: CanvaConnectService): DeliverableStore {
  return {
    async find(tenantId, userId, taskId, artifactIds) {
      const rows = artifactIds.length > 0
        ? await service.exportsById({ tenantId, actorId: userId }, taskId, artifactIds)
        : await service.allExports({ tenantId, actorId: userId }, taskId);
      return rows.map((r) => ({ artifactId: r.id, format: r.format, sha256: r.sha256, byteSize: r.byte_size }));
    },
    async read(tenantId, userId, taskId, artifactId) {
      return service.exportBytes({ tenantId, actorId: userId }, taskId, artifactId);
    },
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PINNED_EXPORTS = 20;

/** Validates an approval's `pinnedExportIds`: absent means none; anything malformed is an error. */
export function parsePinnedExportIds(value: unknown): { ok: true; ids: string[] } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, ids: [] };
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && UUID_PATTERN.test(id))) {
    return { ok: false, message: 'pinnedExportIds must be a list of export artifact ids' };
  }
  const ids = [...new Set(value.map((id) => id.toLowerCase()))];
  if (ids.length > MAX_PINNED_EXPORTS) {
    return { ok: false, message: `At most ${MAX_PINNED_EXPORTS} exports can be pinned to one approval` };
  }
  return { ok: true, ids };
}

const MIME_TYPES: Record<PinnedExport['format'], string> = {
  png: 'image/png',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export type PinnedDeliverables =
  | { ok: true; files: PackageFile[]; packageHash: string }
  | { ok: false; code: 'NO_PINNED_EXPORTS' | 'PINNED_EXPORT_MISSING' | 'PINNED_EXPORT_CHANGED'; message: string };

/**
 * Loads the pinned exports and checks every byte against its pin before anything is sent. The
 * package hash is computed from the files' own hashes, so it names exactly this set of bytes.
 */
export async function loadPinnedDeliverables(
  store: DeliverableStore,
  scope: { tenantId: string; userId: string; taskId: string; filePrefix: string },
  pins: PinnedExport[] | undefined
): Promise<PinnedDeliverables> {
  if (!pins || pins.length === 0) {
    return {
      ok: false,
      code: 'NO_PINNED_EXPORTS',
      message: 'Nothing to deliver: the approval pins no exported file. Approve in the Desk with the captured export selected.',
    };
  }
  const files: PackageFile[] = [];
  for (const pin of pins) {
    const bytes = await store.read(scope.tenantId, scope.userId, scope.taskId, pin.artifactId);
    if (!bytes) {
      return { ok: false, code: 'PINNED_EXPORT_MISSING', message: `The approved export ${pin.artifactId} is no longer stored, so nothing was delivered.` };
    }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== pin.sha256 || bytes.length !== pin.byteSize) {
      return {
        ok: false,
        code: 'PINNED_EXPORT_CHANGED',
        message: `The stored export ${pin.artifactId} no longer matches what was approved (SHA-256 ${sha256.slice(0, 12)}…, ${bytes.length} bytes), so nothing was delivered.`,
      };
    }
    files.push({
      artifactId: pin.artifactId,
      relativePath: `deliverables/${pin.artifactId}.${pin.format}`,
      storageKey: `canva-export:${pin.artifactId}`,
      filename: `${scope.filePrefix}-${pin.artifactId.slice(0, 8)}.${pin.format}`,
      mimeType: MIME_TYPES[pin.format],
      byteSize: bytes.length,
      sha256,
      content: bytes,
    });
  }
  const packageHash = crypto
    .createHash('sha256')
    .update(files.map((f) => f.sha256).sort().join('\n'))
    .digest('hex');
  return { ok: true, files, packageHash };
}
