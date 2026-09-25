import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ResilientModelGateway,
  CircuitBreaker,
} from '../src/index.js';
import type { RequestContext, StructuredModelRequest } from '@hawa/contracts';

describe('ResilientModelGateway & CircuitBreaker', () => {
  const ctx: RequestContext = {
    tenantId: 'tenant-model-test',
    actor: { type: 'workflow', id: 'wf-model-resilience' },
    correlationId: 'c-model-test-01',
    deadline: new Date(Date.now() + 60000).toISOString(),
    idempotencyKey: 'model-key-01',
  };

  const originalEnv = { ...process.env };
  let gateway: ResilientModelGateway;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = ['fixture', 'gemini', 'key'].join('-');
    process.env.ANTHROPIC_API_KEY = ['fixture', 'anthropic', 'key'].join('-');
    process.env.OPENAI_API_KEY = ['fixture', 'openai', 'key'].join('-');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const value = JSON.stringify({ status: 'ok' });
      if (url.includes('generativelanguage.googleapis.com')) return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: value }] } }],
        usageMetadata: { promptTokenCount: 520, candidatesTokenCount: 140 },
      }), { status: 200 });
      if (url.includes('api.anthropic.com')) return new Response(JSON.stringify({
        model: 'claude-sonnet-5', content: [{ type: 'text', text: value }],
        usage: { input_tokens: 520, output_tokens: 140 },
      }), { status: 200 });
      if (url.includes('api.openai.com')) return new Response(JSON.stringify({
        model: 'gpt-4o', choices: [{ message: { content: value } }],
        usage: { prompt_tokens: 520, completion_tokens: 140 },
      }), { status: 200 });
      throw new Error(`Unexpected test egress: ${url}`);
    });
    gateway = new ResilientModelGateway();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  describe('CircuitBreaker Unit Semantics', () => {
    it('initializes in CLOSED state and allows execution', () => {
      const cb = new CircuitBreaker({ name: 'test-cb', failureThreshold: 3, cooldownMs: 1000 });
      const snap = cb.getSnapshot();
      expect(snap.state).toBe('CLOSED');
      expect(snap.consecutiveFailures).toBe(0);
      expect(snap.totalTrips).toBe(0);
      expect(cb.canExecute()).toBe(true);
    });

    it('trips to OPEN after reaching consecutive failure threshold', () => {
      const cb = new CircuitBreaker({ name: 'test-cb', failureThreshold: 3, cooldownMs: 1000 });
      cb.recordFailure(new Error('fail 1'));
      expect(cb.getSnapshot().state).toBe('CLOSED');
      expect(cb.canExecute()).toBe(true);

      cb.recordFailure(new Error('fail 2'));
      expect(cb.getSnapshot().state).toBe('CLOSED');
      expect(cb.canExecute()).toBe(true);

      cb.recordFailure(new Error('fail 3'));
      const snap = cb.getSnapshot();
      expect(snap.state).toBe('OPEN');
      expect(snap.consecutiveFailures).toBe(3);
      expect(snap.totalTrips).toBe(1);
      expect(cb.canExecute()).toBe(false); // Fast-fails immediately without upstream call
    });

    it('transitions to HALF_OPEN after cooldown and closes on probe success', async () => {
      const cb = new CircuitBreaker({ name: 'test-cb', failureThreshold: 2, cooldownMs: 50 });
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.canExecute()).toBe(false);

      // Wait past cooldownMs
      await new Promise((r) => setTimeout(r, 60));

      // Next execution attempt transitions to HALF_OPEN
      expect(cb.canExecute()).toBe(true);
      expect(cb.getSnapshot().state).toBe('HALF_OPEN');

      // Probe success recovers circuit back to CLOSED
      cb.recordSuccess();
      expect(cb.getSnapshot().state).toBe('CLOSED');
      expect(cb.getSnapshot().consecutiveFailures).toBe(0);
    });

    it('trips immediately back to OPEN if probe in HALF_OPEN fails', async () => {
      const cb = new CircuitBreaker({ name: 'test-cb', failureThreshold: 2, cooldownMs: 50 });
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.canExecute()).toBe(false);

      await new Promise((r) => setTimeout(r, 60));
      expect(cb.canExecute()).toBe(true); // Now HALF_OPEN

      cb.recordFailure(new Error('probe failed'));
      expect(cb.getSnapshot().state).toBe('OPEN');
      expect(cb.getSnapshot().totalTrips).toBe(2);
      expect(cb.canExecute()).toBe(false);
    });
  });

  describe('ResilientModelGateway Structured Generation & Pricing', () => {
    it('executes normal request on primary provider and computes cost correctly', async () => {
      const req: StructuredModelRequest = {
        role: 'intake_router',
        prompt: 'Analyze marketing brief',
        temperature: 0.1,
      };

      const res = await gateway.generateStructured(ctx, req);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.deployment.provider).toBe('google');
        expect(res.value.deployment.exactModelId).toBe('gemini-3.8-flash');
        expect(res.value.attempts).toBe(1);
        expect(res.value.usage.inputTokens).toBe(520);
        expect(res.value.usage.outputTokens).toBe(140);
        // Google pricing: (520 * 0.10 + 140 * 0.40) / 1,000,000 = (52 + 56) / 1,000,000 = $0.000108
        expect(res.value.usage.estimatedCostUsd).toBe(0.000108);
        expect(res.value.traceId).toBeDefined();
      }
    });

    it('cascades to secondary provider when primary encounters 429 rate limit', async () => {
      // Inject failure on primary provider 'google'
      gateway.setSimulatedFailure('google', 1);

      const req: StructuredModelRequest = {
        role: 'intake_router',
        prompt: 'Analyze marketing brief',
      };

      const res = await gateway.generateStructured(ctx, req);
      expect(res.ok).toBe(true);
      if (res.ok) {
        // Fallback cascade for intake_router: google -> anthropic (claude-3-5-sonnet)
        expect(res.value.deployment.provider).toBe('anthropic');
        expect(res.value.deployment.exactModelId).toBe('claude-sonnet-5');
        expect(res.value.attempts).toBe(2);
        // Anthropic pricing: (520 * 3.00 + 140 * 15.00) / 1,000,000 = (1560 + 2100) / 1,000,000 = $0.00366
        expect(res.value.usage.estimatedCostUsd).toBe(0.00366);
      }
    });

    it('cascades to tertiary provider when top two providers fail', async () => {
      gateway.setSimulatedFailure('google', 1);
      gateway.setSimulatedFailure('anthropic', 1);

      const req: StructuredModelRequest = {
        role: 'intake_router',
        prompt: 'Analyze marketing brief',
      };

      const res = await gateway.generateStructured(ctx, req);
      expect(res.ok).toBe(true);
      if (res.ok) {
        // Third candidate in cascade is openai (gpt-4o)
        expect(res.value.deployment.provider).toBe('openai');
        expect(res.value.deployment.exactModelId).toBe('gpt-4o');
        expect(res.value.attempts).toBe(3);
      }
    });

    it('fast-fails over OPEN circuits and skips to available candidate without attempting tripped provider', async () => {
      // Trip Google circuit breaker with 3 failures
      gateway.setSimulatedFailure('google', 3);
      await gateway.generateStructured(ctx, { role: 'intake_router', prompt: 'test 1' });
      await gateway.generateStructured(ctx, { role: 'intake_router', prompt: 'test 2' });
      await gateway.generateStructured(ctx, { role: 'intake_router', prompt: 'test 3' });

      const googleSnap = gateway.getCircuitBreakerSnapshot('google');
      expect(googleSnap?.state).toBe('OPEN');

      // Next request should automatically skip Google without consuming an attempt on it
      const res = await gateway.generateStructured(ctx, { role: 'intake_router', prompt: 'test 4' });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.deployment.provider).toBe('anthropic');
        // Because google circuit is OPEN, it was skipped before attempting, so attempts is 1
        expect(res.value.attempts).toBe(1);
      }
    });

    it('returns MODEL_CASCADE_EXHAUSTED if all candidates in cascade fail', async () => {
      // intake_router has 4 candidates: google, anthropic, openai, local
      gateway.setSimulatedFailure('google', 1);
      gateway.setSimulatedFailure('anthropic', 1);
      gateway.setSimulatedFailure('openai', 1);
      gateway.setSimulatedFailure('local', 1);

      const res = await gateway.generateStructured(ctx, { role: 'intake_router', prompt: 'exhaust test' });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('MODEL_CASCADE_EXHAUSTED');
        expect(res.error.retryable).toBe(true);
      }
    });

    it('proves Google Gemini call uses x-goog-api-key header without URL query parameter leakage and forwards multimodal images', async () => {
      const originalKey = process.env.GEMINI_API_KEY;
      const originalFetch = globalThis.fetch;
      const testKey = 'AIzaSyModelGatewaySecret123';
      process.env.GEMINI_API_KEY = testKey;

      let capturedUrl: string | undefined;
      let capturedHeaders: Record<string, string> | undefined;
      let capturedBody: any;

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = url.toString();
        capturedHeaders = init?.headers as Record<string, string>;
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  passed: true,
                  rubricScores: { hierarchy: 9, legibility: 9, balance: 9, artifacts: 0, brandResemblance: 9, culturalAppropriateness: 9 },
                  findings: [],
                  overallScore: 9.0,
                }),
              }],
            },
          }],
          usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 50 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as any;

      try {
        const dummyBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const res = await gateway.generateStructured(ctx, {
          role: 'visual_judge',
          prompt: 'Evaluate layout quality',
          inputs: [
            { kind: 'image', mimeType: 'image/png', data: dummyBase64 },
          ],
        });

        expect(res.ok).toBe(true);
        expect(capturedUrl).toBeDefined();
        // Proof 1: No secret key in query string
        expect(capturedUrl).not.toContain(testKey);
        expect(capturedUrl).not.toContain('?key=');
        // Proof 2: Key in header
        expect(capturedHeaders?.['x-goog-api-key']).toBe(testKey);
        // Proof 3: Multimodal image was NOT dropped for visual judge
        expect(capturedBody?.contents?.[0]?.parts?.length).toBeGreaterThanOrEqual(2);
        const imagePart = capturedBody?.contents?.[0]?.parts?.find((p: any) => p.inline_data);
        expect(imagePart).toBeDefined();
        expect(imagePart.inline_data.data).toBe(dummyBase64);
      } finally {
        process.env.GEMINI_API_KEY = originalKey;
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('Multimodal Embeddings & Reranking', () => {
    it('reports an unavailable local embedding adapter instead of fixed vectors', async () => {
      const res = await gateway.embed(ctx, {
        role: 'embedding_multimodal',
        items: [{ id: 'item-1', text: 'Brand logo' }],
        dimensions: 1024,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('LOCAL_MODEL_UNAVAILABLE');
    });

    it('reports an unavailable local reranker instead of fabricated relevance scores', async () => {
      const res = await gateway.rerank(ctx, {
        role: 'reranker_multimodal',
        query: 'Kurdish typography banner',
        candidates: [
          { id: 'c1', text: 'Vazirmatn headline banner' },
          { id: 'c2', text: 'Generic English poster' },
        ],
      });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('LOCAL_MODEL_UNAVAILABLE');
    });
  });
});
