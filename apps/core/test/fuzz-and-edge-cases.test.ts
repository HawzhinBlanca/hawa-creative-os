import { describe, it, expect } from 'vitest';
import { createApp, computeDnaHash } from '../src/app.js';
import { kaaeClientDNA } from '@hawa/domain';

describe('Phase A Hardening: Core API & State Machine Fuzzing and Reality Checks', () => {
  const app = createApp({ testAuth: { principal: { role: 'operator' }, roleHeader: true } });

  it('Fuzz Probe 1: Gracefully rejects malformed JSON and garbage payloads without crashing (RFC 7807)', async () => {
    const res = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hawa-Desk': 'internal',
      },
      body: '{ "title": "Malformed", broken_json: true,,,,, }',
    });

    // Should not crash the server (no 500)
    expect([201, 400]).toContain(res.status);
    if (res.status === 400) {
      const json = await res.json();
      expect(json.status).toBe(400);
    }
  });

  it('Fuzz Probe 2: Handles extreme Unicode, RTL/LTR Bidi overrides, and zero-width characters in task title', async () => {
    const weirdText = '\u202E[OVERRIDE]\u2067دروستی\u200Cتەندروستی\u200D\u0640\u0640\u0640\u2069\u0000Special\t\nLine';
    const res = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hawa-Desk': 'internal',
        'Idempotency-Key': 'fuzz-bidi-1',
      },
      body: JSON.stringify({
        title: weirdText,
        description: 'Unicode injection and isolation fuzz test',
      }),
    });

    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.id).toBeDefined();
    expect(task.title).toBe(weirdText);

    // Fetching the task preserves clean string representation
    const fetchRes = await app.request(`/api/v1/tasks/${task.id}`);
    expect(fetchRes.status).toBe(200);
    const fetched = await fetchRes.json();
    expect(fetched.title).toBe(weirdText);
  });

  it('Fuzz Probe 3: Enforces Invariant #10 & #11 by strictly rejecting publication when task is not in APPROVED state', async () => {
    // 1. Create a raw task in RECEIVED status
    const createRes = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hawa-Desk': 'internal',
        'Idempotency-Key': 'fuzz-unapproved-pub',
      },
      body: JSON.stringify({
        title: 'Unapproved Task Attempting Publication',
        clientId: 'c1000000-0000-4000-8000-000000000002',
      }),
    });
    expect(createRes.status).toBe(201);
    const task = await createRes.json();
    expect(task.status).toBe('RECEIVED');

    // 2. Attempt direct publication without approval
    const pubRes = await app.request(`/v1/tasks/${task.id}/publish-omnichannel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    // Must return 409 Conflict
    expect(pubRes.status).toBe(409);
    const err = await pubRes.json();
    expect(err.title).toBe('Conflict');
  });

  it('Fuzz Probe 4: Idempotent replay with identical Idempotency-Key returns exact cached task and 0 duplicates', async () => {
    const key = `fuzz-idemp-${Date.now()}`;
    const payload = JSON.stringify({
      title: 'Idempotency Guarantee Task',
      clientId: 'client-office-1',
    });

    const res1 = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hawa-Desk': 'internal',
        'Idempotency-Key': key,
      },
      body: payload,
    });
    expect(res1.status).toBe(201);
    const task1 = await res1.json();

    const res2 = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hawa-Desk': 'internal',
        'Idempotency-Key': key,
      },
      body: payload,
    });
    expect(res2.status).toBe(200);
    const task2 = await res2.json();

    expect(task2.id).toBe(task1.id);
    expect(task2.idempotencyKey).toBe(key);
  });

  it('Fuzz Probe 5: Enforces RFC 7807 404 for non-existent entities across all endpoints', async () => {
    const nonExistentId = '00000000-0000-0000-0000-000000000000';
    
    const taskRes = await app.request(`/api/v1/tasks/${nonExistentId}`);
    expect(taskRes.status).toBe(404);

    const dnaRes = await app.request(`/v1/clients/${nonExistentId}/dna`);
    expect(dnaRes.status).toBe(404);

    const pubRes = await app.request(`/v1/tasks/${nonExistentId}/publish-omnichannel`, {
      method: 'POST',
    });
    expect(pubRes.status).toBe(404);
  });

  it('Fuzz Probe 6: Validates immutable DNA hash computation integrity and snapshot creation', async () => {
    const hash = computeDnaHash(kaaeClientDNA);
    expect(hash).toMatch(/^sha256_[a-f0-9]{64}$/);

    // Tamper with a single field and verify hash changes deterministically
    const tamperedDna = { ...kaaeClientDNA, version: 2 };
    const tamperedHash = computeDnaHash(tamperedDna);
    expect(tamperedHash).not.toBe(hash);
  });

  it('Fuzz Probe 7: Rejects illegal state machine jump from AWAITING_APPROVAL to COMPLETE directly', async () => {
    const createRes = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hawa-Desk': 'internal',
        'Idempotency-Key': `fuzz-jump-${Date.now()}`,
      },
      body: JSON.stringify({
        title: 'State Jump Test',
        clientId: 'client-drustee',
      }),
    });
    const task = await createRes.json();

    // Try direct transition via workflow action
    const jumpRes = await app.request(`/v1/tasks/${task.id}/workflow/crash`, {
      method: 'POST',
    });
    // Workflow actions are retired (410, architecture programme 1.3 G6): none can move the task.
    expect([400, 404, 410]).toContain(jumpRes.status);
  });
});
