import { describe, it, expect, afterAll } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { memoryExportStore } from './pinned-exports-fixture.js';

// Revisions, decisions, receipts and the outbox are only held in Postgres (architecture programme
// 1.3, groups G3 and G5), so these apps run on this file's own test database.
const testDb = createDb(process.env.TEST_DATABASE_URL!);
/** KAAE's seeded client row; Postgres takes only a uuid client id. */
const KAAE = 'c1000000-0000-4000-8000-000000000002';
afterAll(() => testDb.destroy());

describe('R05: Immutable Approval Contract & QC Binding (FR-015, FR-041, FR-043-045, NFR-015, NFR-020)', () => {
  const defaultTenantId = '00000000-0000-4000-a000-000000000001';
  const adminHeaders = {
    Authorization: `Bearer ${process.env.HAWA_ADMIN_KEY || 'hawa_admin_dev'}`,
    'Content-Type': 'application/json',
  };
  const reviewerHeaders = {
    Authorization: `Bearer ${process.env.HAWA_REVIEWER_KEY || 'test_reviewer'}`,
    'Content-Type': 'application/json',
  };
  const operatorHeaders = {
    Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'hawa_dev_token'}`,
    'Content-Type': 'application/json',
  };

  it('1. Positive approval succeeds when verified passing QC is present', async () => {
    const exports = memoryExportStore();
    const app = createApp({ db: testDb, deliverableStore: exports.store });

    // Create task
    const taskRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...operatorHeaders, 'Idempotency-Key': `r05-pos-${Date.now()}` },
      body: JSON.stringify({ title: 'Positive QC Task', priority: 'routine', clientId: KAAE }),
    });
    expect(taskRes.status).toBe(201);
    const task = await taskRes.json();

    // Create revision
    const revRes = await app.request(`/v1/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({
        nodes: [{ id: 'n1', type: 'text', text: 'Valid Design Content' }],
      }),
    });
    expect(revRes.status).toBe(201);
    const rev = await revRes.json();

    // Run passing QA
    const qaRes = await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/qa`, {
      method: 'POST',
      headers: operatorHeaders,
    });
    expect(qaRes.status).toBe(200);
    const qa = await qaRes.json();
    console.log('QA FINDINGS:', qa.findings);
    expect(qa.criticalPass).toBe(true);

    // Approve as Art Director
    const approveRes = await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/decisions`, {
      method: 'POST',
      headers: reviewerHeaders,
      body: JSON.stringify({
        action: 'approve',
        reason: 'Passed QA inspection',
        pinnedExportIds: [exports.add(task.id)],
      }),
    });
    expect(approveRes.status).toBe(201);
    const decision = await approveRes.json();
    expect(decision.decision).toBe('approved');
    expect(decision.qcReportHash).toBeDefined();
    expect(decision.invalidated).toBe(false);
  });

  it('2. Null or unknown QC strictly refuses approval (null/unknown QC cannot publish)', async () => {
    const exports = memoryExportStore();
    const app = createApp({ db: testDb, deliverableStore: exports.store });

    // Create task
    const taskRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...operatorHeaders, 'Idempotency-Key': `r05-no-qc-${Date.now()}` },
      body: JSON.stringify({ title: 'No QC Task', priority: 'routine' }),
    });
    const task = await taskRes.json();

    // Create revision with NO prior QA executed
    const revRes = await app.request(`/v1/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({
        nodes: [{ id: 'n1', type: 'text', text: 'Uninspected Design' }],
      }),
    });
    const rev = await revRes.json();

    // Attempt approval without QA evaluation
    const approveRes = await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/decisions`, {
      method: 'POST',
      headers: { ...reviewerHeaders, 'x-require-qc': 'true' },
      body: JSON.stringify({
        action: 'approve',
        reason: 'Attempting unverified approval',
      }),
    });

    // Must be rejected with 412 QA Verification Required
    expect(approveRes.status).toBe(412);
    const err = await approveRes.json();
    expect(err.detail || err.title).toContain('QA');
  });

  it('3. Earlier PASS followed by later FAIL cannot qualify', async () => {
    let qaPass = true;
    const exports = memoryExportStore();
    const app = createApp({ db: testDb, deliverableStore: exports.store,
      qaEngine: {
        run: async (_ctx: any, params: any) => {
          if (!qaPass) {
            return {
              ok: true,
              value: {
                revisionId: params.designRevisionId,
                designRevisionId: params.designRevisionId,
                score: 30,
                criticalPass: false,
                findings: [
                  { ruleId: 'BIDI_ORDERING_ERROR', severity: 'critical', hardFailure: true, category: 'copy', message: 'BiDi text error' }
                ],
                checks: [{ name: 'bidi_ordering', pass: false, severity: 'critical' }],
              },
            };
          }
          return {
            ok: true,
            value: {
              revisionId: params.designRevisionId,
              designRevisionId: params.designRevisionId,
              score: 95,
              criticalPass: true,
              findings: [],
              checks: [{ name: 'bidi_ordering', pass: true, severity: 'critical' }],
            },
          };
        },
      },
    });

    const taskRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...operatorHeaders, 'Idempotency-Key': `r05-pass-fail-${Date.now()}` },
      body: JSON.stringify({ title: 'Pass Fail Task', priority: 'routine' }),
    });
    const task = await taskRes.json();

    const revRes = await app.request(`/v1/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({
        nodes: [{ id: 'n1', type: 'text', text: 'Sample Copy' }],
      }),
    });
    const rev = await revRes.json();

    // 1. First run: PASS
    const qa1Res = await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/qa`, {
      method: 'POST',
      headers: operatorHeaders,
    });
    expect(qa1Res.status).toBe(200);

    // 2. Simulate later regression QA run on the task that reports failure via injected QA engine
    qaPass = false;
    const qa2Res = await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/qa`, {
      method: 'POST',
      headers: operatorHeaders,
    });
    expect(qa2Res.status).toBe(200);

    // 3. Attempt approval: must fail because latest status is FAIL
    const approveRes = await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/decisions`, {
      method: 'POST',
      headers: reviewerHeaders,
      body: JSON.stringify({
        action: 'approve',
        reason: 'Attempting approval despite failed regression',
      }),
    });

    expect(approveRes.status).toBe(412);
  });

  it('4. Concurrent edit/approve has one valid serial outcome via expectedTaskVersion', async () => {
    const exports = memoryExportStore();
    const app = createApp({ db: testDb, deliverableStore: exports.store });

    const taskRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...operatorHeaders, 'Idempotency-Key': `r05-concurrency-${Date.now()}` },
      body: JSON.stringify({ title: 'Concurrency Task', priority: 'routine' }),
    });
    const task = await taskRes.json();

    const revRes = await app.request(`/v1/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({
        nodes: [{ id: 'n1', type: 'text', text: 'Original Content' }],
      }),
    });
    const rev = await revRes.json();

    await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/qa`, {
      method: 'POST',
      headers: operatorHeaders,
    });

    // Stale version: caller expected version 1, but task version is currently 2
    const approveRes = await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/decisions`, {
      method: 'POST',
      headers: reviewerHeaders,
      body: JSON.stringify({
        action: 'approve',
        expectedTaskVersion: 999, // Intentional conflict
      }),
    });

    expect(approveRes.status).toBe(409);
    const err = await approveRes.json();
    expect(err.detail || err.title).toContain('Concurrent modification');
  });

  it('5. Operator role cannot approve designs (FR-043 authority check)', async () => {
    const exports = memoryExportStore();
    const app = createApp({ db: testDb, deliverableStore: exports.store });

    const taskRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...operatorHeaders, 'Idempotency-Key': `r05-role-${Date.now()}` },
      body: JSON.stringify({ title: 'Role Authority Task' }),
    });
    const task = await taskRes.json();

    const revRes = await app.request(`/v1/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({ nodes: [{ id: 'n1', type: 'text', text: 'Content' }] }),
    });
    const rev = await revRes.json();

    await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/qa`, {
      method: 'POST',
      headers: operatorHeaders,
    });

    // Attempting to approve using operator credential
    const approveRes = await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/decisions`, {
      method: 'POST',
      headers: { ...operatorHeaders, 'x-user-role': 'operator' },
      body: JSON.stringify({ action: 'approve' }),
    });

    expect(approveRes.status).toBe(403);
    const err = await approveRes.json();
    expect(err.title).toBe('Forbidden');
  });

  it('6. Post-approval edit invalidates approval and blocks publication', async () => {
    const exports = memoryExportStore();
    const app = createApp({ db: testDb, deliverableStore: exports.store });

    // 1. Create and approve rev1
    const taskRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...operatorHeaders, 'Idempotency-Key': `r05-inval-${Date.now()}` },
      body: JSON.stringify({ title: 'Invalidation Task', clientId: KAAE }),
    });
    const task = await taskRes.json();

    const rev1Res = await app.request(`/v1/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({ nodes: [{ id: 'n1', type: 'text', text: 'Rev 1 Content' }] }),
    });
    const rev1 = await rev1Res.json();

    await app.request(`/v1/tasks/${task.id}/revisions/${rev1.id}/qa`, {
      method: 'POST',
      headers: operatorHeaders,
    });

    const approveRes = await app.request(`/v1/tasks/${task.id}/revisions/${rev1.id}/decisions`, {
      method: 'POST',
      headers: reviewerHeaders,
      body: JSON.stringify({
        action: 'approve',
        pinnedExportIds: [exports.add(task.id)],
      }),
    });
    expect(approveRes.status).toBe(201);

    // 2. Perform a post-approval edit (rev2)
    const rev2Res = await app.request(`/v1/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({ nodes: [{ id: 'n1', type: 'text', text: 'Rev 2 New Content' }] }),
    });
    expect(rev2Res.status).toBe(201);
    const rev2 = await rev2Res.json();

    // 3. Attempt to publish: must be rejected because approval was invalidated and rev2 is unapproved
    const pubRes = await app.request(`/v1/tasks/${task.id}/publish`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({}),
    });
    expect(pubRes.status).toBe(409);
    const pubErr = await pubRes.json();
    expect(pubErr.detail || pubErr.title).toMatch(/unapproved|invalidated|awaiting_approval/i);
  });

  it('7. Stale or revoked Canva binding cannot approve', async () => {
    const exports = memoryExportStore();
    const app = createApp({ db: testDb, deliverableStore: exports.store });

    const taskRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...operatorHeaders, 'Idempotency-Key': `r05-canva-stale-${Date.now()}` },
      body: JSON.stringify({ title: 'Canva Stale Task', clientId: KAAE }),
    });
    const task = await taskRes.json();

    await withRlsContext(testDb, { tenantId: defaultTenantId,
      userId: '00000000-0000-4000-b000-000000000001', role: 'operator' }, trx =>
      sql`INSERT INTO hawa.canva_bindings
        (id, tenant_id, task_id, client_id, canva_design_id, edit_url, status, version)
        VALUES (${crypto.randomUUID()}::uuid, ${defaultTenantId}::uuid, ${task.id}::uuid,
          ${KAAE}::uuid, ${'DA' + crypto.randomUUID().replaceAll('-', '')},
          'https://www.canva.com/design/revoked/edit', 'revoked', 1)`.execute(trx));

    const revRes = await app.request(`/v1/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({ nodes: [{ id: 'n1', type: 'text', text: 'Bound Content' }] }),
    });
    const rev = await revRes.json();

    await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/qa`, {
      method: 'POST',
      headers: operatorHeaders,
    });

    const approveRes = await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/decisions`, {
      method: 'POST',
      headers: reviewerHeaders,
      body: JSON.stringify({
        action: 'approve',
        canvaBindingStatus: 'bound',
      }),
    });

    expect(approveRes.status).toBe(422);
    const err = await approveRes.json();
    expect(err.title).toContain('Stale Canva Binding');
  });
});
