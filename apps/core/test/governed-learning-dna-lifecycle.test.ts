import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '@hawa/db';

describe('Milestone 6: Governed Learning, Candidate Rule Promotion & DNA Rollback Lifecycle', () => {
  const connectionString = process.env.TEST_DATABASE_URL || 'postgresql://hawa_app:hawa_app_secure_runtime_pass_2026@127.0.0.1:54332/hawa_test';
  const db = createDb(connectionString);
  const app = createApp({ db });

  const kaaeClientId = 'c1000000-0000-4000-8000-000000000002';
  const drusteeClientId = 'c1000000-0000-4000-8000-000000000003';

  const testBearer = process.env.HAWA_BEARER_TOKEN || 'hawa_test_suite_operator_bearer_token';
  const authSessionBearer = `Bearer ${testBearer}`;
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': authSessionBearer,
  };

  it('1. Ingests designer artboard refinements and synthesizes candidate rules with SHA-256 evidence', async () => {
    const taskId = `t-learn-${Date.now()}`;
    const initialArtboard = {
      taskId,
      clientId: drusteeClientId,
      layers: [
        { id: 'l1', type: 'text', text: 'Drustee Product', color: '#000000', fontSize: 24, lineHeight: 1.2, x: 50, y: 50, width: 300, height: 50 },
      ],
    };
    const finalArtboard = {
      taskId,
      clientId: drusteeClientId,
      layers: [
        { id: 'l1', type: 'text', text: 'دروستی - ڤیتامین کواڵێتی باڵا', color: '#01585F', fontSize: 32, lineHeight: 1.48, x: 50, y: 120, width: 400, height: 60 },
      ],
    };

    const mineRes = await app.request('/v1/feedback/mine', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        clientId: drusteeClientId,
        taskId,
        initialArtboard,
        finalArtboard,
      }),
    });

    expect(mineRes.status).toBe(201);
    const mineData = await mineRes.json();
    expect(mineData.count).toBeGreaterThan(0);
    expect(mineData.proposedRules.length).toBeGreaterThan(0);

    const firstRule = mineData.proposedRules[0];
    expect(firstRule.clientId).toBe(drusteeClientId);
    expect(firstRule.status).toBe('PROPOSED');
    expect(firstRule.sha256Digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('2. Enforces multi-tenant client isolation: Drustee candidate rules never leak into KAAE', async () => {
    const drusteeRes = await app.request(`/v1/clients/${drusteeClientId}/candidate-rules`);
    expect(drusteeRes.status).toBe(200);
    const drusteeData = await drusteeRes.json();
    expect(drusteeData.count).toBeGreaterThan(0);
    expect(drusteeData.candidateRules.every((r: any) => r.clientId === drusteeClientId)).toBe(true);

    const kaaeRes = await app.request(`/v1/clients/${kaaeClientId}/candidate-rules`);
    expect(kaaeRes.status).toBe(200);
    const kaaeData = await kaaeRes.json();
    // KAAE must not contain Drustee's mined candidate rules
    expect(kaaeData.candidateRules.every((r: any) => r.clientId === kaaeClientId)).toBe(true);
  });

  it('3. Candidate rule promotion requires authentication and role verification', async () => {
    const listRes = await app.request(`/v1/clients/${drusteeClientId}/candidate-rules`);
    const listData = await listRes.json();
    const candidateRule = listData.candidateRules[0];
    expect(candidateRule).toBeDefined();

    // 3a. Unauthenticated attempt -> 401
    const unauthRes = await app.request(`/v1/clients/${drusteeClientId}/candidate-rules/${candidateRule.id}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'art_director' }),
    });
    expect(unauthRes.status).toBe(401);

    // 3b. Unauthorized role (e.g. generic guest/requester) -> 403
    const forbiddenRes = await app.request(`/v1/clients/${drusteeClientId}/candidate-rules/${candidateRule.id}/promote`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ role: 'requester' }),
    });
    expect(forbiddenRes.status).toBe(403);
  });

  it('4. Authorized rule promotion increments Client DNA version and seals immutable snapshot', async () => {
    const dnaBeforeRes = await app.request(`/v1/clients/${drusteeClientId}/dna`);
    const dnaBefore = await dnaBeforeRes.json();
    const initialVersion = dnaBefore.version || 1;

    const listRes = await app.request(`/v1/clients/${drusteeClientId}/candidate-rules`);
    const listData = await listRes.json();
    const candidateRule = listData.candidateRules[0];

    // Promote rule as art_director
    const promoteRes = await app.request(`/v1/clients/${drusteeClientId}/candidate-rules/${candidateRule.id}/promote`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ role: 'art_director' }),
    });
    expect(promoteRes.status).toBe(200);
    const promoteData = await promoteRes.json();
    expect(promoteData.promoted).toBe(true);
    expect(promoteData.rule.status).toBe('PROMOTED');
    expect(promoteData.auditHash).toMatch(/^[a-f0-9]{64}$/);

    // Verify DNA version incremented
    const dnaAfterRes = await app.request(`/v1/clients/${drusteeClientId}/dna`);
    const dnaAfter = await dnaAfterRes.json();
    expect(dnaAfter.version).toBe(initialVersion + 1);
    expect(dnaAfter.guidelines.layoutRules).toContain(candidateRule.ruleText);

    // Verify snapshot created
    const snapsRes = await app.request(`/v1/clients/${drusteeClientId}/snapshots`);
    const snaps = await snapsRes.json();
    expect(snaps.length).toBeGreaterThan(0);
    expect(snaps[0].version).toBe(dnaAfter.version);
    expect(snaps[0].sha256).toMatch(/^(sha256_)?[a-f0-9]{64}$/);
    expect(snaps[0].commitMessage).toContain(candidateRule.title);
  });

  it('5. In-flight tasks remain pinned to their creation DNA version and are never mutated', async () => {
    // Current DNA is at version N
    const dnaRes = await app.request(`/v1/clients/${drusteeClientId}/dna`);
    const currentDna = await dnaRes.json();
    const pinnedVersion = currentDna.version;

    // Dispatch a task pinned to this version
    const taskRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Idempotency-Key': `idem_pin_test_${Date.now()}`,
      },
      body: JSON.stringify({
        title: 'Pinned Version Task',
        clientId: drusteeClientId,
        clientDnaVersion: pinnedVersion,
        source: 'manual',
        priority: 'normal',
      }),
    });
    expect(taskRes.status).toBe(201);
    const taskData = await taskRes.json();
    expect(taskData.clientDnaVersion).toBe(pinnedVersion);

    // Now update DNA again to version N+1
    const snapRes = await app.request(`/v1/clients/${drusteeClientId}/snapshots`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ commitMessage: 'Subsequent update' }),
    });
    expect(snapRes.status).toBe(201);
    const snapData = await snapRes.json();
    expect(snapData.version).toBe(pinnedVersion + 1);

    // The in-flight task MUST retain its original pinned version
    const recheckedTaskRes = await app.request(`/v1/tasks/${taskData.id}`, {
      headers: authHeaders,
    });
    expect(recheckedTaskRes.status).toBe(200);
    const recheckedTask = await recheckedTaskRes.json();
    expect(recheckedTask.clientDnaVersion).toBe(pinnedVersion);
  });

  it('6. Executes authorized DNA rollback to previous version and creates rollback audit snapshot', async () => {
    // Check available snapshots
    const snapsRes = await app.request(`/v1/clients/${drusteeClientId}/snapshots`);
    const snaps = await snapsRes.json();
    expect(snaps.length).toBeGreaterThanOrEqual(2);

    // Target the earlier snapshot
    const targetSnapshot = snaps[snaps.length - 1];
    const targetVersion = targetSnapshot.version;

    // Rollback request
    const rollbackRes = await app.request(`/v1/clients/${drusteeClientId}/dna/rollback`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        targetVersion,
        reason: 'Regression detected in candidate typography rule',
        role: 'creative_director',
      }),
    });

    expect(rollbackRes.status).toBe(200);
    const rollbackData = await rollbackRes.json();
    expect(rollbackData.rolledBack).toBe(true);
    expect(rollbackData.revertedToVersion).toBe(targetVersion);

    // Verify active DNA is now restored
    const activeDnaRes = await app.request(`/v1/clients/${drusteeClientId}/dna`);
    const activeDna = await activeDnaRes.json();
    expect(activeDna.version).toBe(rollbackData.activeVersion);

    // Verify new rollback audit snapshot is committed
    const updatedSnapsRes = await app.request(`/v1/clients/${drusteeClientId}/snapshots`);
    const updatedSnaps = await updatedSnapsRes.json();
    expect(updatedSnaps[0].commitMessage).toContain(`Rollback to baseline v${targetVersion}`);
    expect(updatedSnaps[0].sha256).toMatch(/^(sha256_)?[a-f0-9]{64}$/);
  });
});
