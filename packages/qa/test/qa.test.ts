import { describe, it, expect } from 'vitest';
import { DeterministicQAEngine } from '../src/engine.js';
import type { QARequest, RequestContext } from '@hawa/contracts';

describe('QA: DeterministicQAEngine', () => {
  const engine = new DeterministicQAEngine();
  const ctx: RequestContext = {
    tenantId: 't-1',
    actor: { type: 'workflow', id: 'wf-1' },
    correlationId: 'c-1',
    deadline: new Date(Date.now() + 60000).toISOString(),
    idempotencyKey: 'idem-1',
  };

  it('detects missing approved copy and fails hard QA', async () => {
    const request: QARequest = {
      taskId: 'task-1',
      designRevisionId: 'rev-1',
      document: {
        documentId: 'doc-1',
        sourceRevision: 1,
        sourceSha256: 'sha-1',
        studio: 'FakeStudio',
        studioVersion: '1.0',
        schemaVersion: '1.0',
      },
      sourceHash: 'sha-1',
      manifest: {
        pages: [{ id: 'p1', name: 'Page 1', width: 1080, height: 1080, unit: 'px' }],
        nodes: [{ id: 'n1', pageId: 'p1', type: 'text', text: 'Different headline', locked: false, zIndex: 0 }],
        fonts: [],
        assets: [],
        warnings: [],
      },
      renders: [],
      brief: {
        variants: [{ width: 1080, height: 1080 }],
        exactCopy: [
          { id: 'ec-1', role: 'headline', text: 'داشکاندنی فەرمی', language: 'ckb', direction: 'rtl', approved: true, protectedTokens: [] },
        ],
      },
      clientDna: { assets: [] },
      profile: { name: 'default', version: '1.0', rules: {} },
      repairCycle: 0,
    };

    const res = await engine.run(ctx, request);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.criticalPass).toBe(false);
      expect(res.value.status).toBe('failed');
      expect(res.value.findings.some((f) => f.ruleId === 'EXACT_COPY_MISSING')).toBe(true);
    }
  });

  it('passes hard QA when canvas dimensions, exact copy, and brand assets match', async () => {
    const request: QARequest = {
      taskId: 'task-1',
      designRevisionId: 'rev-1',
      document: {
        documentId: 'doc-1',
        sourceRevision: 1,
        sourceSha256: 'sha-1',
        studio: 'FakeStudio',
        studioVersion: '1.0',
        schemaVersion: '1.0',
      },
      sourceHash: 'sha-1',
      manifest: {
        pages: [{ id: 'p1', name: 'Page 1', width: 1080, height: 1080, unit: 'px' }],
        nodes: [
          { id: 'n1', pageId: 'p1', type: 'text', text: 'داشکاندنی فەرمی: ٢٥٬٠٠٠ دینار', locked: false, zIndex: 0 },
          { id: 'n2', pageId: 'p1', type: 'image', assetSha256: 'logo-sha-256', locked: true, zIndex: 1 },
        ],
        fonts: [],
        assets: [],
        warnings: [],
      },
      renders: [],
      brief: {
        variants: [{ width: 1080, height: 1080 }],
        exactCopy: [
          {
            id: 'ec-1',
            role: 'headline',
            text: 'داشکاندنی فەرمی: ٢٥٬٠٠٠ دینار',
            language: 'ckb',
            direction: 'rtl',
            approved: true,
            protectedTokens: [{ type: 'price', raw: '٢٥٬٠٠٠ دینار', normalized: '25000', mustPreserveExact: true }],
          },
        ],
      },
      clientDna: {
        assets: [{ role: 'logo_primary', sha256: 'logo-sha-256' }],
      },
      profile: { name: 'default', version: '1.0', rules: {} },
      repairCycle: 0,
    };

    const res = await engine.run(ctx, request);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.criticalPass).toBe(true);
      expect(res.value.status).toBe('passed');
      expect(res.value.findings.length).toBe(0);
    }
  });
});
