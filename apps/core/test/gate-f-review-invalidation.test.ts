import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { createDb } from '@hawa/db';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { memoryExportStore } from './pinned-exports-fixture.js';

// Revisions, decisions, receipts and the outbox are only held in Postgres (architecture programme
// 1.3, groups G3 and G5), so these apps run on this file's own test database.
const testDb = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => testDb.destroy());

/**
 * A QA engine whose every run passes: Postgres approves only a revision with a passing QA run, and
 * these tests are about what happens around the approval.
 */
const passingQa = {
  run: async (_ctx: unknown, input: { designRevisionId: string }) => ({
    ok: true as const,
    value: { qcRunId: crypto.randomUUID(), revisionId: input.designRevisionId, status: 'passed', criticalPass: true, findings: [], profile: 'strict' },
  }),
};

describe('Gate F: Human Review Integrity & Post-Approval Invalidation Engine (FR-043, FR-044, Invariant #11)', () => {
  const exports = memoryExportStore();
  const app = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'art_director' }, roleHeader: true },  deliverableStore: exports.store, qaEngine: passingQa as never });

  async function createFixtureTask(clientName: string = 'Aster Hotel') {
    const res = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'expected_office_secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        update_id: Math.floor(Math.random() * 100000),
        message: { text: `Ramadan campaign for ${clientName}`, chat: { id: 999 } },
      }),
    });
    const json = await res.json();
    return { ...json.task, taskId: json.task.id };
  }

  /** The QA run Postgres wants on record before a revision is approved. */
  async function passQa(taskId: string, revisionId: string) {
    expect((await app.request(`/tasks/${taskId}/revisions/${revisionId}/qa`, { method: 'POST' })).status).toBe(200);
  }

  it('binds human approval and permits omnichannel publication while approved', async () => {
    const task = await createFixtureTask('Aster Grand');
    const revId = crypto.randomUUID(); // Postgres names a revision by uuid

    // 1. Submit initial revision
    const revRes = await app.request(`/tasks/${task.taskId}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: revId,
        document: {
          id: 'doc_1',
          pages: [{ id: 'p1', name: 'main', width: 1080, height: 1920, unit: 'px' }],
          nodes: [
            { id: 'node-head', type: 'text', text: 'بەخێربێن بۆ ئاستێر', role: 'headline' },
          ],
        },
      }),
    });
    expect(revRes.status).toBe(201);
    await passQa(task.taskId, revId);

    // 2. Human review decision: approved
    const approveRes = await app.request(`/tasks/${task.taskId}/revisions/${revId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer test_art_director_bearer`,
      },
      body: JSON.stringify({
        decision: 'approved',
        role: 'art_director',
        displayName: 'Hero Art Director',
      }),
    });
    expect(approveRes.status).toBe(201);
    const approveJson = await approveRes.json();
    expect(approveJson.decision).toBe('approved');

    // 3. Verify task is in APPROVED state
    const taskGet = await app.request(`/tasks/${task.taskId}`);
    const taskData = await taskGet.json();
    expect(taskData.status).toBe('APPROVED');
    expect(taskData.latestApproval).toBeDefined();
  });

  it('strictly invalidates approval upon canvas edit and blocks premature publication (Invariant #11)', async () => {
    const task = await createFixtureTask('Nova Tech Solutions');
    // A client with a Drive destination: the chat request carries none, and delivery needs one.
    const routed = await app.request(`/tasks/${task.taskId}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'c1000000-0000-4000-8000-000000000002', reason: 'Client assigned' }),
    });
    expect(routed.status).toBe(202);
    const revId1 = crypto.randomUUID();

    // 1. Initial revision
    await app.request(`/tasks/${task.taskId}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: revId1,
        document: {
          id: 'doc_nova_1',
          pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }],
          nodes: [{ id: 'title', type: 'text', text: 'Nova Cloud v1' }],
        },
      }),
    });

    await passQa(task.taskId, revId1);

    // 2. Approve
    const firstApproval = await app.request(`/tasks/${task.taskId}/revisions/${revId1}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer test_art_director_bearer`,
      },
      body: JSON.stringify({
        decision: 'approved',
        role: 'art_director',
      }),
    });

    expect(firstApproval.status).toBe(201);

    const checkApproved = await app.request(`/tasks/${task.taskId}`);
    expect((await checkApproved.json()).status).toBe('APPROVED');

    // 3. Post-approval canvas edit!
    const postApprovalRes = await app.request(`/tasks/${task.taskId}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Nova Cloud Updated Copy',
        document: {
          id: 'doc_nova_2',
          pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }],
          nodes: [
            { id: 'title', type: 'text', text: 'Nova Cloud v2 - Updated Post Approval' },
            { id: 'badge', type: 'text', text: 'New Release' },
          ],
        },
        author: { userId: 'designer_42', role: 'senior_designer' },
      }),
    });
    expect(postApprovalRes.status).toBe(201);
    const postApprovalJson = await postApprovalRes.json();
    expect(postApprovalJson.approvalInvalidated).toBe(true);
    expect(postApprovalJson.status).toBe('AWAITING_APPROVAL');

    // 4. Verify task state reverted in store
    const checkTask = await app.request(`/tasks/${task.taskId}`);
    const taskState = await checkTask.json();
    expect(taskState.status).toBe('AWAITING_APPROVAL');
    // The invalidation is recorded in Postgres, on the task's timeline (the Desk reads the task from
    // there, not from this process's copy).
    const timeline = (await (await app.request(`/tasks/${task.taskId}/timeline`)).json()).events as Array<{ eventType: string; data: Record<string, unknown> }>;
    const invalidated = timeline.filter((e) => e.eventType === 'approval.invalidated');
    expect(invalidated).toHaveLength(1);
    expect(timeline).toContainEqual(expect.objectContaining({
      eventType: 'task.state_changed',
      data: expect.objectContaining({ toState: 'human_review', reason: 'Post-approval edit invalidated previous approval', invalidatedApprovalId: invalidated[0].data.invalidatedApprovalId }),
    }));

    // 5. Attempting to publish MUST fail with 409 Conflict (Publication Gate)
    const pubRes = await app.request(`/tasks/${task.taskId}/publish-omnichannel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(pubRes.status).toBe(409);
    const pubErr = await pubRes.json();
    expect(pubErr.title).toBe('Conflict');

    // 6. Re-approving the new revision re-enables publication
    await passQa(task.taskId, postApprovalJson.revisionId);
    const reapproveRes = await app.request(`/tasks/${task.taskId}/revisions/${postApprovalJson.revisionId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer test_art_director_bearer`,
      },
      body: JSON.stringify({
        decision: 'approved',
        role: 'creative_director',
        pinnedExportIds: [exports.add(task.taskId)],
      }),
    });
    expect(reapproveRes.status).toBe(201);

    // 7. Now publication succeeds
    const pubSuccessRes = await app.request(`/tasks/${task.taskId}/publish-omnichannel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(pubSuccessRes.status).toBe(200);
    const pubSuccess = await pubSuccessRes.json();
    expect(pubSuccess.status).toBe('COMPLETE');
  });

  it('enforces role authorization on node-level reviewer comments (FR-044)', async () => {
    const task = await createFixtureTask('Drustee Milk');

    // Authorized roles
    const roles = ['art_director', 'creative_director', 'client_reviewer', 'operator'];
    for (const role of roles) {
      // The reviewer's role is the signed-in caller's (x-user-role here), not the body's.
      const res = await app.request(`/tasks/${task.taskId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-role': role },
        body: JSON.stringify({
          nodeId: 'headline_layer_1',
          comment: `Looks great under ${role} review`,
          category: 'visual_balance',
          priority: 'high',
          author: { userId: `user_${role}`, role, displayName: `Reviewer ${role}` },
        }),
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.comment.author.role).toBe(role);
      expect(json.comment.nodeId).toBe('headline_layer_1');
    }

    // Unauthorized role fails with 403
    const forbiddenRes = await app.request(`/tasks/${task.taskId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-role': 'external_guest' },
      body: JSON.stringify({
        nodeId: 'headline_layer_1',
        comment: 'Illegal comment from unvetted account',
        author: { userId: 'intruder', role: 'external_guest' },
      }),
    });
    expect(forbiddenRes.status).toBe(403);

    // Query comments list
    const listRes = await app.request(`/tasks/${task.taskId}/comments`);
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.comments.length).toBe(roles.length);
  });

  it('computes semantic document revision diffs between revisions', async () => {
    const task = await createFixtureTask('Erbil Fashion');

    // Rev 1
    const r1 = await app.request(`/tasks/${task.taskId}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        document: {
          id: 'doc_diff_1',
          pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }],
          nodes: [
            { id: 'logo', type: 'image', x: 20, y: 20, width: 100, height: 100 },
            { id: 'headline', type: 'text', text: 'نرخی نوێ', x: 50, y: 200 },
          ],
        },
      }),
    });
    const { revisionId: revId1 } = await r1.json();

    // Rev 2
    const r2 = await app.request(`/tasks/${task.taskId}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        document: {
          id: 'doc_diff_2',
          pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }],
          nodes: [
            { id: 'logo', type: 'image', x: 20, y: 20, width: 100, height: 100 },
            { id: 'headline', type: 'text', text: 'نرخی داشکێنراو بۆ وەرزی نوێ', x: 50, y: 220 },
            { id: 'cta-button', type: 'shape', x: 50, y: 500, width: 200, height: 60 },
          ],
        },
      }),
    });
    const { revisionId: revId2 } = await r2.json();

    const diffRes = await app.request(`/tasks/${task.taskId}/revisions/diff?fromRevisionId=${revId1}&toRevisionId=${revId2}`);
    expect(diffRes.status).toBe(200);
    const diffJson = await diffRes.json();
    expect(diffJson.ok).toBe(true);
    expect(diffJson.fromRevisionId).toBe(revId1);
    expect(diffJson.toRevisionId).toBe(revId2);
    expect(diffJson.diff).toBeDefined();
    // Added cta-button, modified headline
    expect(diffJson.diff.addedNodes.some((n: any) => n.id === 'cta-button')).toBe(true);
    expect(diffJson.diff.textChanges.some((c: any) => c.nodeId === 'headline')).toBe(true);
  });
});
