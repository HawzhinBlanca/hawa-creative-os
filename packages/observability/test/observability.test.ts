import { describe, it, expect } from 'vitest';
import { redactSecrets, OfficeTracer, PhoenixClient } from '../src/index.js';

describe('Observability: Redaction, Tracing & Phoenix Exporter', () => {
  it('redactSecrets: masks API keys, secrets, and private keys from telemetry', () => {
    const dummyKey = ['sk', '12345678901234567890123456'].join('-');
    const raw = `Calling OpenAI with api_key="${dummyKey}" for client request`;
    const clean = redactSecrets(raw);
    expect(clean).not.toContain(dummyKey);
    expect(clean).toContain('[REDACTED_SECRET]');
  });

  it('OfficeTracer: creates spans and redacts secret attributes', () => {
    const dummySecret = ['sk', 'abcdef12345678901234567890'].join('-');
    const tracer = new OfficeTracer();
    const handle = tracer.startSpan('TaskIntake', undefined, {
      taskId: 'task-100',
      token: dummySecret,
      nested: { apiKey: dummySecret },
    });
    handle.addEvent('validated', { note: `Bearer ${dummySecret}` });
    const span = handle.end({ outcome: 'success', finalSecret: dummySecret });

    expect(span.name).toBe('TaskIntake');
    expect(span.attributes.taskId).toBe('task-100');
    expect(span.attributes.token).toBe('[REDACTED_SECRET]');
    expect((span.attributes.nested as any).apiKey).toBe('[REDACTED_SECRET]');
    expect(span.attributes.finalSecret).toBe('[REDACTED_SECRET]');
    expect(span.events.length).toBe(1);
    expect((span.events[0].attributes as any)?.note).toContain('[REDACTED_SECRET]');
  });

  it('PhoenixClient: records evaluation runs and exports telemetry spans', async () => {
    const client = new PhoenixClient('http://localhost:6006');
    const rec = await client.recordEvaluation({
      datasetName: 'brief_builder_eval',
      experimentName: 'gemini_3.8_flash_canary',
      runId: 'run-1',
      inputs: { rawText: 'Offer post' },
      outputs: { objective: 'Offer post' },
      scores: { factInvention: 0.0, exactCopyPreservation: 1.0 },
      metadata: {},
    });

    expect(rec.success).toBe(true);
    expect(client.getEvaluations().length).toBe(1);
  });
});
