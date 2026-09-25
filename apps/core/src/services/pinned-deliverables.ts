import crypto from 'node:crypto';
import type { PackageFile } from '@hawa/contracts';
import type { PinnedExport } from '@hawa/domain';
import type { CanvaConnectService, CanvaPublicationVersionCheck } from './canva-connect-service.js';

/**
 * What a publication delivers: the stored Canva exports the reviewer pinned when approving, sent
 * byte for byte. Until 2026-09-19 both publish routes invented their files instead (twelve fixed
 * names and sizes whose "sha256" hashed a label, or one `sha256_png_hash`), and in production the
 * publisher uploaded zero-filled placeholders of those sizes.
 */
export interface DeliverableStore {
  /** Server-owned marker: this store reads immutable Canva export rows. */
  captureEvidenceRequired?: boolean;
  /** Retrieved exports of the task with these ids; ids the store does not hold are left out. */
  find(tenantId: string, userId: string, taskId: string, artifactIds: string[]): Promise<PinnedExport[]>;
  /** The stored bytes of one export, or null when the store does not hold it. */
  read(tenantId: string, userId: string, taskId: string, artifactId: string): Promise<Uint8Array | null>;
  /** Required when captureEvidenceRequired: live source check before any publication effect. */
  verifyCurrentSource?(input: { tenantId: string; taskId: string; approvalId: string; artifactIds: string[] }): Promise<CanvaPublicationVersionCheck>;
}

/** A store that holds nothing: without durable Canva storage no export can be pinned or delivered. */
export const EMPTY_DELIVERABLE_STORE: DeliverableStore = {
  find: async () => [],
  read: async () => null,
};

/**
 * The delivery format of a stored export. Canva PDF exports are stored as `pdf_standard`
 * (canva-connect-service), which the delivery maps did not know: such a file went to Drive with no
 * MIME type and a `.pdf_standard` extension.
 */
export function deliverableFormat(format: string): PinnedExport['format'] {
  return format === 'pdf_standard' ? 'pdf' : (format as PinnedExport['format']);
}

export function canvaDeliverableStore(service: CanvaConnectService): DeliverableStore {
  return {
    captureEvidenceRequired: true,
    async find(tenantId, userId, taskId, artifactIds) {
      const rows = artifactIds.length > 0
        ? await service.exportsById({ tenantId, actorId: userId }, taskId, artifactIds)
        : await service.allExports({ tenantId, actorId: userId }, taskId);
      return rows.map((r) => ({ artifactId: r.id, format: deliverableFormat(r.format), sha256: r.sha256, byteSize: r.byte_size }));
    },
    async read(tenantId, userId, taskId, artifactId) {
      return service.exportBytes({ tenantId, actorId: userId }, taskId, artifactId);
    },
    verifyCurrentSource(input) {
      return service.verifyApprovedDesignVersion(input);
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
    // Approvals recorded before the format was normalised can still carry `pdf_standard`.
    const format = deliverableFormat(pin.format);
    files.push({
      artifactId: pin.artifactId,
      relativePath: `deliverables/${pin.artifactId}.${format}`,
      storageKey: `canva-export:${pin.artifactId}`,
      filename: `${scope.filePrefix}-${pin.artifactId.slice(0, 8)}.${format}`,
      mimeType: MIME_TYPES[format] ?? 'application/octet-stream',
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
