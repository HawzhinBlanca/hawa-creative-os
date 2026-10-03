import {persistClientDnaFixture} from './fixtures/persisted-client-dna.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { createDb, withRlsContext } from '@hawa/db';
import { randomUUID } from 'node:crypto';
import { approvedRefinementPair } from './fixtures/approved-refinement-pair.js';
import { memoryExportStore } from './pinned-exports-fixture.js';

describe('Milestone 6: Governed Learning, Candidate Rule Promotion & DNA Rollback Lifecycle', () => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const db = createDb(connectionString);
  const exports=memoryExportStore();
  const app = createAppWithClientFixtures({ db, deliverableStore:exports.store });

  const kaaeClientId = 'c1000000-0000-4000-8000-000000000002';
  const drusteeClientId = 'c1000000-0000-4000-8000-000000000003';
  const defaultTenantId = '00000000-0000-4000-a000-000000000001';
  const adminUserId = '00000000-0000-4000-b000-000000000002';

  const testBearer = process.env.HAWA_ART_DIRECTOR_KEY!;
  const authSessionBearer = `Bearer ${testBearer}`;
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': authSessionBearer,
  };

  beforeAll(async () => {
    try {
      await withRlsContext(db, { tenantId: defaultTenantId, userId: adminUserId, role: 'administrator' }, async (trx) => {
        await (trx as any).deleteFrom('hawa.client_dna_versions').where('client_id', 'in', [drusteeClientId, kaaeClientId]).execute();
      });
      await persistClientDnaFixture(app,drusteeClientId,authHeaders);
      await persistClientDnaFixture(app,kaaeClientId,authHeaders);
      // Also reset in-memory DNA version to 1 if it was previously incremented
      const drusteeDnaRes = await app.request(`/v1/clients/${drusteeClientId}/dna`, { headers: authHeaders });
      if (drusteeDnaRes.status === 200) {
        const dna = await drusteeDnaRes.json();
        if (dna.version > 1) {
          dna.version = 1;
          delete dna.__commitMessage;
        }
      }
    } catch {
      // ignore if table not accessible
    }
  });

  it('1. Ingests designer artboard refinements and synthesizes candidate rules with SHA-256 evidence', async () => {
    const pair=await approvedRefinementPair(app,authHeaders,drusteeClientId,exports);
    const mineRes = await app.request('/v1/feedback/mine', {
      method:'POST',headers:{...authHeaders,'Idempotency-Key':randomUUID()},body:JSON.stringify(pair),
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
    const drusteeRes = await app.request(`/v1/clients/${drusteeClientId}/candidate-rules`, {
      headers: authHeaders,
    });
    expect(drusteeRes.status).toBe(200);
    const drusteeData = await drusteeRes.json();
    expect(drusteeData.count).toBeGreaterThan(0);
    expect(drusteeData.candidateRules.every((r: any) => r.clientId === drusteeClientId)).toBe(true);

    const kaaeRes = await app.request(`/v1/clients/${kaaeClientId}/candidate-rules`, {
      headers: authHeaders,
    });
    expect(kaaeRes.status).toBe(200);
    const kaaeData = await kaaeRes.json();
    // KAAE must not contain Drustee's mined candidate rules
    expect(kaaeData.candidateRules.every((r: any) => r.clientId === kaaeClientId)).toBe(true);
  });

  it('3. Candidate rule promotion requires authentication and role verification', async () => {
    const listRes = await app.request(`/v1/clients/${drusteeClientId}/candidate-rules`, {
      headers: authHeaders,
    });
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

    // 3b. A verified operator cannot promote by requesting a director role -> 403.
    const forbiddenRes = await app.request(`/v1/clients/${drusteeClientId}/candidate-rules/${candidateRule.id}/promote`, {
      method: 'POST',
      headers: {...authHeaders,Authorization:`Bearer ${process.env.HAWA_BEARER_TOKEN}`},
      body: JSON.stringify({ role: 'art_director' }),
    });
    expect(forbiddenRes.status).toBe(403);
  });

  it('4. Authorized rule promotion increments Client DNA version and seals immutable snapshot', async () => {
    const dnaBeforeRes = await app.request(`/v1/clients/${drusteeClientId}/dna`, {
      headers: authHeaders,
    });
    const dnaBefore = await dnaBeforeRes.json();
    const initialVersion = dnaBefore.version || 1;

    const listRes = await app.request(`/v1/clients/${drusteeClientId}/candidate-rules`, {
      headers: authHeaders,
    });
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
    const dnaAfterRes = await app.request(`/v1/clients/${drusteeClientId}/dna`, {
      headers: authHeaders,
    });
    const dnaAfter = await dnaAfterRes.json();
    expect(dnaAfter.version).toBe(initialVersion + 1);
    expect(dnaAfter.guidelines.layoutRules).toContain(candidateRule.ruleText);

    // Verify snapshot created
    const snapsRes = await app.request(`/v1/clients/${drusteeClientId}/snapshots`, {
      headers: authHeaders,
    });
    const snaps = await snapsRes.json();
    expect(snaps.length).toBeGreaterThan(0);
    expect(snaps[0].version).toBe(dnaAfter.version);
    expect(snaps[0].sha256).toMatch(/^(sha256_)?[a-f0-9]{64}$/);
    expect(snaps[0].commitMessage).toContain(candidateRule.title);
  });

  it('5. In-flight tasks remain pinned to their creation DNA version and are never mutated', async () => {
    // Current DNA is at version N
    const dnaRes = await app.request(`/v1/clients/${drusteeClientId}/dna`, {
      headers: authHeaders,
    });
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
      body: JSON.stringify({ commitMessage: 'Subsequent update', expectedVersion: pinnedVersion }),
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
    const snapsRes = await app.request(`/v1/clients/${drusteeClientId}/snapshots`, {
      headers: authHeaders,
    });
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
        expectedVersion: (await (await app.request(`/v1/clients/${drusteeClientId}/dna`, { headers: authHeaders })).json()).version,
      }),
    });

    expect(rollbackRes.status).toBe(200);
    const rollbackData = await rollbackRes.json();
    expect(rollbackData.rolledBack).toBe(true);
    expect(rollbackData.revertedToVersion).toBe(targetVersion);

    // Verify active DNA is now restored
    const activeDnaRes = await app.request(`/v1/clients/${drusteeClientId}/dna`, {
      headers: authHeaders,
    });
    const activeDna = await activeDnaRes.json();
    expect(activeDna.version).toBe(rollbackData.activeVersion);

    // Verify new rollback audit snapshot is committed
    const updatedSnapsRes = await app.request(`/v1/clients/${drusteeClientId}/snapshots`, {
      headers: authHeaders,
    });
    const updatedSnaps = await updatedSnapsRes.json();
    expect(updatedSnaps[0].commitMessage).toContain(`Rollback to baseline v${targetVersion}`);
    expect(updatedSnaps[0].sha256).toMatch(/^(sha256_)?[a-f0-9]{64}$/);
  });
});
