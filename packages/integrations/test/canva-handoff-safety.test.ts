import { describe, it, expect, vi } from 'vitest';
import { CanvaDesignStudioAdapter, validateCanvaDesignUrl } from '../src/canva-design-studio-adapter.js';
import type { RequestContext, StudioDocumentRef } from '@hawa/contracts';

const ctx: RequestContext = { tenantId: 'tenant-a', clientId: 'client-a', taskId: 'task-a', actor: { type: 'user', id: 'reviewer' }, correlationId: 'test', deadline: '2099-01-01', idempotencyKey: 'key' };
const doc: StudioDocumentRef = { documentId: 'doc', studioDocumentId: 'DAexample', sourceRevision: 1, sourceSha256: 'abc', studio: 'Canva', studioVersion: '2', schemaVersion: '2' };
const binding = { tenantId: ctx.tenantId, clientId: ctx.clientId!, taskId: ctx.taskId!, canvaDesignId: 'DAexample', editUrl: 'https://www.canva.com/design/DAexample/edit' };

describe('FR-011/029/030: honest Canva handoff', () => {
  it.each(['manual_native_handoff', 'canva_connect_cloud'] as const)('%s never manufactures create or render success', async mode => {
    const adapter = new CanvaDesignStudioAdapter(undefined, { mode });
    expect((await adapter.create(ctx, { name: 'A', pages: [], clientDnaVersion: 1 })).ok).toBe(false);
    expect((await adapter.import(ctx, { storageKey: 'x', sha256: 'x', byteSize: 42, studioSchemaVersion: '1' })).ok).toBe(false);
    expect((await adapter.render(ctx, { document: doc, format: 'pdf', colorSpace: 'cmyk' })).ok).toBe(false);
    expect((await adapter.exportSource(ctx, doc)).ok).toBe(false);
    expect((await adapter.verifyRoundTrip(ctx, doc)).ok).toBe(false);
    expect((await adapter.apply(ctx, { document: doc, expectedSourceSha256: doc.sourceSha256, operations: [], operationBatchId: 'b', destructiveOperationsAllowed: false })).ok).toBe(false);
  });
  it('does not fall back to a default client document', async () => {
    expect((await new CanvaDesignStudioAdapter().getEditorUrl(ctx, doc, 'edit')).ok).toBe(false);
  });
  it('resolves persisted binding again after a new adapter instance', async () => {
    const resolveBinding = vi.fn(async () => binding);
    for (let i = 0; i < 2; i++) {
      const result = await new CanvaDesignStudioAdapter(undefined, { resolveBinding }).getEditorUrl(ctx, doc, 'edit');
      expect(result.ok && result.value.url).toBe(binding.editUrl);
    }
    expect(resolveBinding).toHaveBeenCalledTimes(2);
  });
  it.each(['tenantId', 'clientId', 'taskId'] as const)('rejects %s mismatch even if storage returns the other client', async key => {
    const adapter = new CanvaDesignStudioAdapter(undefined, { resolveBinding: async () => ({ ...binding, [key]: 'foreign' }) });
    expect((await adapter.getEditorUrl(ctx, doc, 'edit')).ok).toBe(false);
  });
  it('rejects a substituted design ID', async () => {
    const adapter = new CanvaDesignStudioAdapter(undefined, { resolveBinding: async () => binding });
    expect((await adapter.getEditorUrl(ctx, { ...doc, studioDocumentId: 'foreign' }, 'edit')).ok).toBe(false);
  });
  it.each(['http://www.canva.com/design/DAexample/edit', 'https://www.canva.com.evil.test/design/DAexample/edit', 'https://user@www.canva.com/design/DAexample/edit', 'https://www.canva.com/design/DAexample/edit?redirect=evil', 'https://www.canva.com/design/foreign/edit'])('rejects unsafe or mismatched handoff URL %s', url => {
    expect(() => validateCanvaDesignUrl(url, 'DAexample')).toThrow();
  });
});
