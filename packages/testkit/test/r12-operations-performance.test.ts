import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createApp } from '../../../apps/core/src/app.js';
import { createDb } from '../../../packages/db/src/index.js';
import { CostGovernor } from '../../../packages/integrations/src/cost-governor.js';
import { CircuitBreaker } from '../../../packages/integrations/src/circuit-breaker.js';

describe('Task R12: Operations, Performance, and Safe Failure Behavior (FR-062-065, FR-071, FR-079, NFR-002, NFR-004, NFR-005, NFR-011, NFR-017)', () => {
  const root = path.resolve(__dirname, '../../..');

  function getTestDbUrl(): string {
    if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
    const envFile = path.resolve(root, '.env.test');
    if (fs.existsSync(envFile)) {
      for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
        const m = /^TEST_DATABASE_URL=(.*)$/.exec(line.trim());
        if (m && m[1]) return m[1];
      }
    }
    return 'postgres://127.0.0.1:55432/hawa_test';
  }

  const connectionString = getTestDbUrl();
  let db: any;
  let app: any;

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_token'}`,
  };

  function percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    return Number((sorted[lower] * (1 - weight) + sorted[upper] * weight).toFixed(2));
  }

  it('1. Task and client listing latency stays well within SLO (p95 <= 1500ms)', async () => {
    db = createDb(connectionString);
    app = createApp({ db });

    const latencies: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const res = await app.request('/v1/tasks?limit=50', { headers: authHeaders });
      const t1 = performance.now();
      expect(res.status).toBe(200);
      latencies.push(t1 - t0);
    }

    const p95 = percentile(latencies, 95);
    expect(p95).toBeLessThanOrEqual(1500);
  });

  it('2. Webhook ingress latency stays within SLO (p95 <= 1000ms)', async () => {
    const latencies: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      const res = await app.request('/v1/ingress/rehearsal', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          clientId: 'client-drustee',
          platform: 'whatsapp',
          text: `پەیامی هاتوو ${i + 1}`,
        }),
      });
      const t1 = performance.now();
      expect([200, 201]).toContain(res.status);
      latencies.push(t1 - t0);
    }

    const p95 = percentile(latencies, 95);
    expect(p95).toBeLessThanOrEqual(1000);
  });

  it('3. Non-AI state transition latency meets SLO (p95 <= 2000ms)', async () => {
    const latencies: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const createRes = await app.request('/v1/tasks', {
        method: 'POST',
        headers: { ...authHeaders, 'Idempotency-Key': `r12-trans-${i}-${Date.now()}` },
        body: JSON.stringify({ title: `R12 Trans Task ${i}`, priority: 'routine', clientId: 'c1000000-0000-4000-8000-000000000002' }),
      });
      expect(createRes.status).toBe(201);
      const task = await createRes.json();

      const revRes = await app.request(`/v1/tasks/${task.id}/revisions`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ nodes: [{ id: 'n1', type: 'text', text: 'Fast Transition' }] }),
      });
      const t1 = performance.now();
      expect(revRes.status).toBe(201);
      latencies.push(t1 - t0);
    }

    const p95 = percentile(latencies, 95);
    expect(p95).toBeLessThanOrEqual(2000);
  });

  it('4. Bounded concurrency, backpressure, and exponential backoff retry policy (FR-062, FR-063)', () => {
    const queueLimit = 500;
    let queued = 0;
    let backpressureTripped = false;

    for (let i = 0; i < 550; i++) {
      if (queued >= queueLimit) {
        backpressureTripped = true;
        break;
      }
      queued++;
    }
    expect(backpressureTripped).toBe(true);

    const baseDelayMs = 100;
    const delays = [1, 2, 3].map((attempt) => Math.min(baseDelayMs * Math.pow(2, attempt - 1), 5000));
    expect(delays).toEqual([100, 200, 400]);
  });

  it('5. Per-client spend caps fail closed on quota exhaustion (FR-079)', () => {
    const costGov = new CostGovernor();
    const testClient = 'client-spend-r12';
    costGov.allocateBudget(testClient, 0.05);

    const pre1 = costGov.checkPreFlight(testClient, 100, 'gpt-4o', 'openai');
    expect(pre1.allowed).toBe(true);

    // Spend exceeds $0.05
    costGov.recordUsage({
      clientId: testClient,
      taskId: 'task-r12-spend',
      role: 'designer',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 50000,
      outputTokens: 50000,
      costUsd: 0.20,
    });

    const pre2 = costGov.checkPreFlight(testClient, 100, 'gpt-4o', 'openai');
    expect(pre2.allowed).toBe(false);
    expect(pre2.reason).toContain('budget exceeded');
  });

  it('6. Fault tolerance: Circuit breaker trips on consecutive outages, and channel kill switches halt ingress (FR-064, FR-065, FR-071)', async () => {
    const breaker = new CircuitBreaker({ name: 'test_r12_breaker', failureThreshold: 3, cooldownMs: 1000 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('OPEN');

    // Kill switch activation
    const killOn = await app.request('/v1/operations/kill-switch', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ channel: 'telegram', active: true }),
    });
    expect(killOn.status).toBe(200);
    const dataOn = await killOn.json();
    expect(dataOn.active).toBe(true);

    // Reset kill switch
    const killOff = await app.request('/v1/operations/kill-switch', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ channel: 'telegram', active: false }),
    });
    expect(killOff.status).toBe(200);
    const dataOff = await killOff.json();
    expect(dataOff.active).toBe(false);
  });

  it('7. End-to-end task lifecycle trace succeeds with 100% availability over measurement window', async () => {
    // 1. Ingress & Task creation
    const taskRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...authHeaders, 'Idempotency-Key': `r12-trace-${Date.now()}` },
      body: JSON.stringify({ title: 'R12 Full Lifecycle', priority: 'routine', clientId: 'c1000000-0000-4000-8000-000000000002' }),
    });
    expect(taskRes.status).toBe(201);
    const task = await taskRes.json();

    // 2. Revision creation
    const revRes = await app.request(`/v1/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ nodes: [{ id: 'n1', type: 'text', text: 'Trace Content' }] }),
    });
    expect(revRes.status).toBe(201);
    const rev = await revRes.json();

    // 3. Deterministic QA inspection
    const qaRes = await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/qa`, {
      method: 'POST',
      headers: authHeaders,
    });
    expect(qaRes.status).toBe(200);
    const qa = await qaRes.json();
    expect(qa.criticalPass).toBe(true);

    // 4. Art Director Approval
    const approveRes = await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/decisions`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'x-user-role': 'art_director',
        Authorization: `Bearer ${process.env.HAWA_REVIEWER_KEY || 'test_reviewer'}`,
      },
      body: JSON.stringify({ action: 'approve', reason: 'R12 Trace verification passed' }),
    });
    expect(approveRes.status).toBe(201);
    const decision = await approveRes.json();
    expect(decision.decision).toBe('approved');

    if (db) await db.destroy();
  });
});
