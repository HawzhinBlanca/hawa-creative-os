import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResilientModelGateway } from '../src/model-gateway.js';
import type { RequestContext, StructuredModelRequest } from '@hawa/contracts';

const ctx: RequestContext = {
  tenantId: 'tenant-egress-test',
  actor: { type: 'workflow', id: 'egress-test' },
  correlationId: 'egress-test',
  deadline: new Date(Date.now() + 60_000).toISOString(),
  idempotencyKey: 'egress-test',
};

function request(mode: StructuredModelRequest['egressPolicy']['mode'], allowedProviders: string[]): StructuredModelRequest {
  return {
    role: 'creative_director',
    inputs: [{ kind: 'text', text: 'Create an editable poster' }],
    systemPromptVersion: 'test-v1',
    responseSchema: { type: 'object' },
    budget: { maxCostUsd: 1, maxLatencyMs: 5000, maxAttempts: 4 },
    egressPolicy: { mode, allowedProviders },
    cachePolicy: 'disabled',
  };
}

describe('R20 governed model egress truth', () => {
  const keys = ['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const;
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('does not manufacture a cloud result in production for an older ungoverned caller', async () => {
    for (const key of keys) delete process.env[key];
    vi.stubEnv('NODE_ENV', 'production');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected provider request'); });
    const result = await new ResilientModelGateway().generateStructured(ctx, { ...request('approved_providers', ['google']), egressPolicy: undefined } as unknown as StructuredModelRequest);
    if (result.ok) expect(result.value.deployment.provider).toBe('local');
    else if (result.ok === false) expect(result.error.code).toBe('MISSING_PROVIDER_CREDENTIALS');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not manufacture a cloud result when the only authorized provider has no credentials', async () => {
    for (const key of keys) delete process.env[key];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected provider request'); });
    const result = await new ResilientModelGateway().generateStructured(ctx, request('approved_providers', ['google']));
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.error.code).toBe('MISSING_PROVIDER_CREDENTIALS');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an empty cloud allowlist before any request', async () => {
    process.env.GEMINI_API_KEY = 'test-only-key';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected provider request'); });
    const result = await new ResilientModelGateway().generateStructured(ctx, request('approved_providers', []));
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.error.code).toBe('EGRESS_DISALLOWED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps text, image and audio local-only requests off the external network', async () => {
    for (const key of keys) process.env[key] = 'test-only-key';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected provider request'); });
    const gateway = new ResilientModelGateway();
    for (const inputs of [
      [{ kind: 'text' as const, text: 'local text' }],
      [{ kind: 'image' as const, mimeType: 'image/png', text: 'image metadata' }],
      [{ kind: 'document' as const, mimeType: 'audio/wav', text: 'audio metadata' }],
    ]) {
      const result = await gateway.generateStructured(ctx, { ...request('local_only', ['local']), inputs });
      if (result.ok) expect(result.value.deployment.provider).toBe('local');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not claim a Qwen embedding or rerank invocation without a local model', async () => {
    const gateway = new ResilientModelGateway();
    const embedding = await gateway.embed(ctx, {
      role: 'embedding_multimodal', items: [{ id: 'one', text: 'one' }], normalize: true,
      egressPolicy: { mode: 'local_only', allowedProviders: ['local'] },
    });
    const rerank = await gateway.rerank(ctx, {
      role: 'reranker_multimodal', query: [{ kind: 'text', text: 'query' }],
      candidates: [{ id: 'one', parts: [{ kind: 'text', text: 'one' }] }], topK: 1,
      egressPolicy: { mode: 'local_only', allowedProviders: ['local'] },
    });
    expect(embedding.ok).toBe(false);
    expect(rerank.ok).toBe(false);
  });
});
