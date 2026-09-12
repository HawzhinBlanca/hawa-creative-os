import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

describe('Gate F: Human Review Integrity & Post-Approval Invalidation Engine (FR-043, FR-044, Invariant #11)', () => {
  const app = createApp();

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

  it('binds human approval and permits omnichannel publication while approved', async () => {
    const task = await createFixtureTask('Aster Grand');
    const revId = 'rev_initial_001';

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

    // 2. Human review decision: approved
    const approveRes = await app.request(`/tasks/${task.taskId}/revisions/${revId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}`,
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
    const revId1 = 'rev_nova_approved';

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

    // 2. Approve
    await app.request(`/tasks/${task.taskId}/revisions/${revId1}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}`,
      },
      body: JSON.stringify({
        decision: 'approved',
        role: 'art_director',
      }),
    });

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
    expect(taskState.invalidationHistory).toBeDefined();
    expect(taskState.invalidationHistory.length).toBeGreaterThan(0);
    expect(taskState.invalidationHistory[0].reason).toBe('post_approval_edit');

    // 5. Attempting to publish MUST fail with 409 Conflict (Publication Gate)
    const pubRes = await app.request(`/tasks/${task.taskId}/publish-omnichannel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(pubRes.status).toBe(409);
    const pubErr = await pubRes.json();
    expect(pubErr.title).toBe('Conflict');

    // 6. Re-approving the new revision re-enables publication
    const reapproveRes = await app.request(`/tasks/${task.taskId}/revisions/${postApprovalJson.revisionId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}`,
      },
      body: JSON.stringify({
        decision: 'approved',
        role: 'creative_director',
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
      const res = await app.request(`/tasks/${task.taskId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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
