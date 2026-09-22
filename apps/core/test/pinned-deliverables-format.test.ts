import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canvaDeliverableStore, loadPinnedDeliverables, type DeliverableStore } from '../src/services/pinned-deliverables.js';

/**
 * Canva PDF exports are stored with the format `pdf_standard`. Delivery keyed its MIME map and file
 * extension on the stored format, so a pinned PDF went to Drive with no MIME type and a
 * `.pdf_standard` name.
 */

const bytes = new Uint8Array(crypto.randomBytes(64));
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const artifactId = crypto.randomUUID();
const scope = { tenantId: crypto.randomUUID(), userId: crypto.randomUUID(), taskId: crypto.randomUUID(), filePrefix: 'kaae' };

const store: DeliverableStore = {
  async find() { return []; },
  async read(_tenant, _user, taskId, id) { return taskId === scope.taskId && id === artifactId ? bytes : null; },
};

describe('a pinned PDF export stored as pdf_standard', () => {
  it('is delivered as application/pdf with a .pdf name', async () => {
    const pin = { artifactId, format: 'pdf_standard' as any, sha256, byteSize: bytes.length };
    const loaded = await loadPinnedDeliverables(store, scope, [pin]);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.files[0].mimeType).toBe('application/pdf');
    expect(loaded.files[0].filename).toBe(`kaae-${artifactId.slice(0, 8)}.pdf`);
    expect(loaded.files[0].relativePath).toBe(`deliverables/${artifactId}.pdf`);
  });

  it('is pinned with the delivery format pdf by the Canva export store', async () => {
    const service: any = {
      exportsById: async () => [{ id: artifactId, format: 'pdf_standard', sha256, byte_size: bytes.length }],
      allExports: async () => [{ id: artifactId, format: 'pdf_standard', sha256, byte_size: bytes.length }],
    };
    const canvaStore = canvaDeliverableStore(service);
    expect(await canvaStore.find(scope.tenantId, scope.userId, scope.taskId, [artifactId])).toEqual([
      { artifactId, format: 'pdf', sha256, byteSize: bytes.length },
    ]);
    expect((await canvaStore.find(scope.tenantId, scope.userId, scope.taskId, []))[0].format).toBe('pdf');
  });

  it('keeps PNG exports as image/png', async () => {
    const pin = { artifactId, format: 'png' as const, sha256, byteSize: bytes.length };
    const loaded = await loadPinnedDeliverables(store, scope, [pin]);
    expect(loaded.ok && loaded.files[0].mimeType).toBe('image/png');
    expect(loaded.ok && loaded.files[0].filename.endsWith('.png')).toBe(true);
  });
});
