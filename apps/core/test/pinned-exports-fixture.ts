import crypto from 'node:crypto';
import type { PinnedExport } from '@hawa/domain';
import type { DeliverableStore } from '../src/services/pinned-deliverables.js';

/**
 * An in-memory stand-in for the Canva export store: it holds real bytes, so every hash and size a
 * test publishes is computed from actual content, exactly as in production.
 */
export function memoryExportStore() {
  const exportsById = new Map<string, { taskId: string; format: PinnedExport['format']; bytes: Uint8Array }>();

  const store: DeliverableStore = {
    async find(_tenantId, _userId, taskId, artifactIds) {
      return artifactIds.flatMap((id) => {
        const entry = exportsById.get(id);
        if (!entry || entry.taskId !== taskId) return [];
        return [{
          artifactId: id,
          format: entry.format,
          sha256: crypto.createHash('sha256').update(entry.bytes).digest('hex'),
          byteSize: entry.bytes.length,
        }];
      });
    },
    async read(_tenantId, _userId, taskId, artifactId) {
      const entry = exportsById.get(artifactId);
      return entry && entry.taskId === taskId ? entry.bytes : null;
    },
  };

  return {
    store,
    /** Stores an export for the task and returns its artifact id. */
    add(taskId: string, format: PinnedExport['format'] = 'png', bytes?: Uint8Array): string {
      const id = crypto.randomUUID();
      exportsById.set(id, { taskId, format, bytes: bytes ?? crypto.randomBytes(256) });
      return id;
    },
    /** Replaces an export's bytes, as if the stored file had changed after approval. */
    replaceBytes(artifactId: string, bytes: Uint8Array) {
      const entry = exportsById.get(artifactId);
      if (entry) entry.bytes = bytes;
    },
    remove(artifactId: string) {
      exportsById.delete(artifactId);
    },
  };
}
