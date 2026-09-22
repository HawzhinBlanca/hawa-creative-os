import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { memoryExportStore } from './pinned-exports-fixture.js';
import { createHash } from 'node:crypto';
import { HumanApprovalManager } from '@hawa/integrations';
import type { ApprovalActor } from '@hawa/domain';

describe('CV-15: Bind Human Approval to Captured Revision & Review Desk (FR-041..044, FR-069)', () => {
  let app: ReturnType<typeof createApp>;
  let approvalManager: HumanApprovalManager;

  const defaultTenantId = '00000000-0000-4000-a000-000000000001';
  const defaultClientId = '00000000-0000-4000-a000-000000000002';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';

  let exports: ReturnType<typeof memoryExportStore>;

  beforeEach(() => {
    exports = memoryExportStore();
    app = createApp({ testAuth: { principal: { role: 'art_director' }, roleHeader: true },  deliverableStore: exports.store });
    approvalManager = new HumanApprovalManager();
  });

  async function createTestTask(clientName: string = 'KAAE Kurdistan Association') {
    const res = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'expected_office_secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        update_id: Math.floor(Math.random() * 1000000),
        message: {
          text: `Annual Gala Invitation Campaign for ${clientName}`,
          chat: { id: 888123 },
        },
      }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    return json.task;
  }

  it('1. Review Desk provides truthful inspection of full-size preview, exact copy, references, and QA evidence (FR-041)', async () => {
    const task = await createTestTask();
    const revId = 'rev_kaae_alpha';

    // Submit initial revision with Kurdish copy
    const revRes = await app.request(`/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: revId,
        document: {
          id: 'doc_kaae_1',
          title: 'KAAE Gala 2026',
          pages: [{ id: 'p1', name: 'main', width: 1080, height: 1920, unit: 'px', language: 'ckb', direction: 'rtl' }],
          nodes: [
            { id: 'headline', type: 'text', text: 'بانگهێشتنامەی فەرمی کۆنفرانسی نیشتمانی', role: 'headline' },
            { id: 'date-decree', type: 'text', text: 'بەروار: ١٥ی تشرینی یەکەمی ٢٠٢٦ بەپێی فەرمانی ژمارە ٤١٢', role: 'body' },
          ],
        },
      }),
    });
    expect(revRes.status).toBe(201);

    // Call Review Desk inspection endpoint
    const deskRes = await app.request(`/tasks/${task.id}/review-desk?revisionId=${revId}`, {
      headers: {
        Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}`,
      },
    });
    expect(deskRes.status).toBe(200);
    const deskData = await deskRes.json();

    expect(deskData.taskId).toBe(task.id);
    expect(deskData.revisionId).toBe(revId);
    expect(deskData.canvaEditUrl).toContain('canva.com/design/');
    expect(deskData.canvaEditUrl).toContain('return_url=');
    expect(deskData.capturedFiles.length).toBeGreaterThan(0);
    expect(deskData.exactCopy.some((c: any) => c.text.includes('بانگهێشتنامەی فەرمی'))).toBe(true);
    expect(deskData.exactCopy.some((c: any) => c.isKurdishRtl === true)).toBe(true);
    expect(deskData.brandReferences.officialLogoSha256).toBeDefined();
    // No QA ran on this revision, so the evidence says so instead of reporting a pass.
    expect(deskData.qaEvidence).toMatchObject({ status: 'not_run', criticalPass: null, qcReportHash: null, qcRunId: null });
  });

  it('2. Enforces real role authorization on review decisions (FR-043)', async () => {
    const task = await createTestTask();
    const revId = 'rev_role_auth_test';

    await app.request(`/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: revId,
        document: {
          id: 'doc_role_1',
          pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }],
          nodes: [{ id: 'title', type: 'text', text: 'Role Check Design' }],
        },
      }),
    });

    // Case 2a: Unauthorized role 'external_guest' fails with 403
    const guestRes = await app.request(`/tasks/${task.id}/revisions/${revId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}`,
        'x-user-role': 'external_guest',
      },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(guestRes.status).toBe(403);
    const guestErr = await guestRes.json();
    expect(guestErr.title).toBe('Forbidden');

    // Case 2b: Unauthorized role 'viewer' fails with 403
    const viewerRes = await app.request(`/tasks/${task.id}/revisions/${revId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}`,
        'x-user-role': 'viewer',
      },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(viewerRes.status).toBe(403);

    // Case 2c: Unauthenticated request fails with 401
    const anonRes = await app.request(`/tasks/${task.id}/revisions/${revId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-enforce-auth': 'true',
      },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(anonRes.status).toBe(401);

    // Case 2d: Authorized role 'art_director' succeeds with 201
    const artDirectorRes = await app.request(`/tasks/${task.id}/revisions/${revId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`,
      },
      body: JSON.stringify({ decision: 'approved', displayName: 'Lead Art Director' }),
    });
    expect(artDirectorRes.status).toBe(201);
  });

  it('3. Rejects stale revision approval and cross-task revision mismatch', async () => {
    const taskA = await createTestTask('Client Alpha');
    const taskB = await createTestTask('Client Beta');

    const revA1 = 'rev_alpha_1';
    const revA2 = 'rev_alpha_2';
    const revB1 = 'rev_beta_1';

    // Submit A1 then A2
    await app.request(`/tasks/${taskA.id}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: revA1,
        document: { id: 'd1', pages: [{ id: 'p1', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'n1', type: 'text', text: 'A1' }] },
      }),
    });
    await app.request(`/tasks/${taskA.id}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: revA2,
        document: { id: 'd2', pages: [{ id: 'p1', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'n1', type: 'text', text: 'A2' }] },
      }),
    });

    // Submit B1
    await app.request(`/tasks/${taskB.id}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: revB1,
        document: { id: 'd3', pages: [{ id: 'p1', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'n1', type: 'text', text: 'B1' }] },
      }),
    });

    // 3a. Attempting to approve stale revision A1 when current is A2 must fail with 409
    const staleRes = await app.request(`/tasks/${taskA.id}/revisions/${revA1}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`,
      },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(staleRes.status).toBe(409);
    const staleJson = await staleRes.json();
    expect(staleJson.detail).toContain('Cannot approve stale revision');

    // 3b. Attempting to approve B1 under Task A must fail with 400
    const crossRes = await app.request(`/tasks/${taskA.id}/revisions/${revB1}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`,
      },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(crossRes.status).toBe(400);
    const crossJson = await crossRes.json();
    expect(crossJson.title).toBe('Cross-Task Revision Mismatch');
  });

  it('4. Detects tampered artifact set hash and tampered QC report hash', async () => {
    const task = await createTestTask();
    const revId = 'rev_tamper_test';

    await app.request(`/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: revId,
        document: { id: 'doc_t', pages: [{ id: 'p1', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'n1', type: 'text', text: 'Authentic' }] },
        captureSet: {
          id: crypto.randomUUID(),
          capturedArtifactSetHash: 'authentic_merkle_root_sha256_hash_123',
        },
        qaReport: {
          criticalPass: true,
          reportSha256: 'authentic_qc_report_sha256_hash_456',
        },
      }),
    });

    // 4a. Tampered artifact set hash
    const badArtifactRes = await app.request(`/tasks/${task.id}/revisions/${revId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`,
      },
      body: JSON.stringify({
        decision: 'approved',
        capturedArtifactSetHash: 'forged_tampered_merkle_root_hex',
      }),
    });
    expect(badArtifactRes.status).toBe(422);
    expect((await badArtifactRes.json()).detail).toContain('Submitted captured artifact set hash');

    // 4b. Tampered QC report hash
    const badQcRes = await app.request(`/tasks/${task.id}/revisions/${revId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`,
      },
      body: JSON.stringify({
        decision: 'approved',
        qcReportHash: 'forged_qc_report_hash_789',
      }),
    });
    expect(badQcRes.status).toBe(422);
    expect((await badQcRes.json()).detail).toContain('Submitted QC report hash');
  });

  it('5. Enforces optimistic concurrency / prevents concurrent approvals on mismatched version', async () => {
    const task = await createTestTask();
    const revId = 'rev_concurrency_test';

    await app.request(`/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: revId,
        document: { id: 'doc_c', pages: [{ id: 'p1', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'n1', type: 'text', text: 'Race' }] },
      }),
    });

    // Assume current task version is 1
    // Operator 1 approves with expectedTaskVersion: 1 -> Succeeds and bumps version to 2
    const op1Res = await app.request(`/tasks/${task.id}/revisions/${revId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`,
      },
      body: JSON.stringify({
        decision: 'approved',
        expectedTaskVersion: 1,
      }),
    });
    expect(op1Res.status).toBe(201);

    // Operator 2 sends concurrent approval also with expectedTaskVersion: 1 -> Fails with 409
    const op2Res = await app.request(`/tasks/${task.id}/revisions/${revId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`,
      },
      body: JSON.stringify({
        decision: 'approved',
        expectedTaskVersion: 1,
      }),
    });
    expect(op2Res.status).toBe(409);
    expect((await op2Res.json()).detail).toContain('Concurrent modification detected');
  });

  it('6. Rejects stale two-way chat approval actions when task has advanced (Stale Chat Action)', async () => {
    const task = await createTestTask();
    const rev1 = 'rev_chat_v1';
    const rev2 = 'rev_chat_v2';

    // Create Revision 1
    await app.request(`/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: rev1,
        document: { id: 'd1', pages: [{ id: 'p1', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'n1', type: 'text', text: 'Draft 1' }] },
      }),
    });

    // Advance to Revision 2
    await app.request(`/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: rev2,
        document: { id: 'd2', pages: [{ id: 'p1', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'n1', type: 'text', text: 'Draft 2' }] },
      }),
    });

    // Chat webhook sends action referencing old rev1
    const chatRes = await app.request(`/tasks/${task.id}/chat-approval-action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}`,
      },
      body: JSON.stringify({
        revisionId: rev1,
        decision: 'approved',
      }),
    });
    expect(chatRes.status).toBe(409);
    const chatErr = await chatRes.json();
    expect(chatErr.detail).toContain('Stale chat action');
  });

  it('7. Captures structured revision requests with scope, category, target nodes, and reusable flag (FR-042)', async () => {
    const task = await createTestTask();
    const revId = 'rev_struct_req';

    await app.request(`/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: revId,
        document: { id: 'd1', pages: [{ id: 'p1', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'headline', type: 'text', text: 'Original Headline' }] },
      }),
    });

    const revReqRes = await app.request(`/tasks/${task.id}/revisions/${revId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`,
      },
      body: JSON.stringify({
        decision: 'revision_requested',
        revisionRequest: {
          scope: 'copy',
          category: 'factual_error',
          targetNodes: ['headline'],
          priority: 'high',
          isReusableFeedback: true,
          comment: 'Please use official Kurdistan Regional Government spelling for the ministry title',
        },
      }),
    });

    expect(revReqRes.status).toBe(201);
    const decJson = await revReqRes.json();
    expect(decJson.decision).toBe('revision_requested');
    expect(decJson.revisionRequest.scope).toBe('copy');
    expect(decJson.revisionRequest.category).toBe('factual_error');
    expect(decJson.revisionRequest.isReusableFeedback).toBe(true);

    const checkTask = await app.request(`/tasks/${task.id}`);
    const taskData = await checkTask.json();
    expect(taskData.status).toBe('REVISION_REQUESTED');
  });

  it('8. CORE ACCEPTANCE INVARIANT: B cannot ship using As approval; publication delivers stored A or blocks for B review; never exports live design (Acceptance Gate)', async () => {
    // A task for a client with a Drive destination (a task without a client is never delivered)
    const createRes = await app.request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Erbil Royal Hotel Grand Opening', clientId: 'c1000000-0000-4000-8000-000000000002' }),
    });
    const created = await createRes.json();
    const task = { id: created.id || created.task?.id };
    const revA = 'rev_erbil_A';
    const revB = 'rev_erbil_B';
    const bytesA = new TextEncoder().encode('export reviewed for revision A');
    const bytesB = new TextEncoder().encode('export reviewed for revision B');
    const exportA = exports.add(task.id, 'png', bytesA);
    const exportB = exports.add(task.id, 'png', bytesB);
    const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

    // Step 1: Submit Revision A
    await app.request(`/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: revA,
        document: { id: 'dA', pages: [{ id: 'p1', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 't1', type: 'text', text: 'Erbil Royal Grand Opening v1' }] },
      }),
    });

    // Step 2: Approve Revision A
    const approveARes = await app.request(`/tasks/${task.id}/revisions/${revA}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer test_art_director_bearer`,
      },
      body: JSON.stringify({
        decision: 'approved',
        role: 'art_director',
        pinnedExportIds: [exportA],
      }),
    });
    expect(approveARes.status).toBe(201);
    const approvalA = await approveARes.json();
    const approvalIdA = approvalA.decisionId;

    // Verify task is APPROVED
    const taskApproved = await (await app.request(`/tasks/${task.id}`)).json();
    expect(taskApproved.status).toBe('APPROVED');

    // Step 3: Canva edit occurs -> Revision B is submitted!
    const editBRes = await app.request(`/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: revB,
        document: { id: 'dB', pages: [{ id: 'p1', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 't1', type: 'text', text: 'Erbil Royal Grand Opening v2 - Edited in Canva' }] },
      }),
    });
    expect(editBRes.status).toBe(201);
    const editBJson = await editBRes.json();
    expect(editBJson.approvalInvalidated).toBe(true);

    // Verify task state reverted to AWAITING_APPROVAL
    const taskReverted = await (await app.request(`/tasks/${task.id}`)).json();
    expect(taskReverted.status).toBe('AWAITING_APPROVAL');

    // Step 4: ATTEMPT 1 — Try to publish Revision B using Approval A's ID
    // MUST BE STRICTLY REJECTED! B cannot ship using A's approval!
    const publishBWithApprovalARes = await app.request(`/tasks/${task.id}/publish-omnichannel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        designRevisionId: revB,
        approvalId: approvalIdA,
      }),
    });
    expect(publishBWithApprovalARes.status).toBe(409);
    const pubErr = await publishBWithApprovalARes.json();
    expect(pubErr.detail).toContain("B cannot ship using A's approval");

    // Step 5: ATTEMPT 2 — Try to publish current task without re-approval
    // MUST BE BLOCKED pending review of Revision B!
    const publishCurrentTaskRes = await app.request(`/tasks/${task.id}/publish-omnichannel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        policy: 'current_task',
      }),
    });
    expect(publishCurrentTaskRes.status).toBe(409);
    expect((await publishCurrentTaskRes.json()).detail).toContain("not 'approved'");

    // Step 6: ATTEMPT 3 — Publish approved stored Revision A under explicit policy 'deliver_approved_stored'
    // SUCCEEDS and delivers stored files without re-exporting live Canva design!
    const deliverStoredARes = await app.request(`/tasks/${task.id}/publish-omnichannel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        policy: 'deliver_approved_stored',
        designRevisionId: revA,
        approvalId: approvalIdA,
      }),
    });
    expect(deliverStoredARes.status).toBe(200);
    const deliverStoredJson = await deliverStoredARes.json();
    // The stored A delivery sends A's pinned export, byte for byte, never B's or a live re-export.
    expect(deliverStoredJson.publicationReceipt.driveFiles.map((f: any) => f.expectedSha256)).toEqual([sha(bytesA)]);
    expect(deliverStoredJson.status).toBe('COMPLETE');

    // Step 7: Conduct proper review and approval of Revision B
    const approveBRes = await app.request(`/tasks/${task.id}/revisions/${revB}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer test_art_director_bearer`,
      },
      body: JSON.stringify({
        decision: 'approved',
        role: 'art_director',
        pinnedExportIds: [exportB],
      }),
    });
    expect(approveBRes.status).toBe(201);
    const approvalB = await approveBRes.json();
    const approvalIdB = approvalB.decisionId;

    // Step 8: Now publish Revision B with its own verified approval -> SUCCEEDS!
    const publishBSuccessRes = await app.request(`/tasks/${task.id}/publish-omnichannel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        designRevisionId: revB,
        approvalId: approvalIdB,
      }),
    });
    expect(publishBSuccessRes.status).toBe(200);
    const pubBSuccess = await publishBSuccessRes.json();
    expect(pubBSuccess.status).toBe('COMPLETE');
    expect(pubBSuccess.publicationReceipt.driveFiles.map((f: any) => f.expectedSha256)).toEqual([sha(bytesB)]);
  });

  it('9. Maintains an immutable, cryptographically chained audit log (FR-069)', () => {
    const actor: ApprovalActor = {
      userId: operatorUserId,
      displayName: 'Senior Director',
      role: 'art_director',
      verifiedServerSide: true,
    };

    const recordRes = approvalManager.recordDecision({
      actor,
      taskId: '00000000-0000-4000-a000-000000000010',
      currentTaskRevisionId: 'rev-audit-1',
      currentTaskVersion: 1,
      submission: {
        revisionId: 'rev-audit-1',
        decision: 'approved',
        captureSetId: '00000000-0000-4000-a000-000000000020',
        capturedArtifactSetHash: 'artifact_sha_123',
        qcReportHash: 'qc_sha_456',
        sourceHash: 'source_sha_789',
      },
      storedCaptureSet: {
        id: '00000000-0000-4000-a000-000000000020',
        taskId: '00000000-0000-4000-a000-000000000010',
        capturedArtifactSetHash: 'artifact_sha_123',
        artifactsCount: 3,
      },
      storedQcRun: {
        id: '00000000-0000-4000-a000-000000000030',
        taskId: '00000000-0000-4000-a000-000000000010',
        designRevisionId: 'rev-audit-1',
        status: 'passed',
        criticalPass: true,
        reportSha256: 'qc_sha_456',
      },
    });

    expect(recordRes.ok).toBe(true);
    if (!recordRes.ok) return;

    // Invalidate when rev-2 is created
    approvalManager.invalidateApproval({
      taskId: '00000000-0000-4000-a000-000000000010',
      priorRevisionId: 'rev-audit-1',
      newRevisionId: 'rev-audit-2',
      reason: 'post_approval_edit',
      actor,
    });

    const auditLog = approvalManager.getAuditLog();
    expect(auditLog.length).toBe(2);
    expect(auditLog[0].eventType).toBe('approval.created');
    expect(auditLog[1].eventType).toBe('approval.invalidated');

    // Chaining verification: entry 1's prevHash must equal entry 0's entryHash
    expect(auditLog[1].prevHash).toBe(auditLog[0].entryHash);
    expect(auditLog[0].entryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(auditLog[1].entryHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('10. H03: Maps UI action "approve" to "approved", rejects invalid actions with 400, and denies role spoofing', async () => {
    const task = await createTestTask('H03 Test Client');
    const revId = 'rev_h03_proof';

    await app.request(`/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: revId,
        document: {
          id: 'doc_h03',
          pages: [{ id: 'p1', width: 1080, height: 1080, unit: 'px' }],
          nodes: [{ id: 't1', type: 'text', text: 'H03 Verified Decision Text' }],
        },
      }),
    });

    // 10a. Invalid action returns HTTP 400
    const badActionRes = await app.request(`/tasks/${task.id}/revisions/${revId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}`,
      },
      body: JSON.stringify({ action: 'unsupported_random_action' }),
    });
    expect(badActionRes.status).toBe(400);
    const badActionJson = await badActionRes.json();
    expect(badActionJson.title).toBe('Invalid Decision Action');

    // 10b. UI action 'approve' cleanly maps to 'approved' (HTTP 201)
    const uiApproveRes = await app.request(`/tasks/${task.id}/revisions/${revId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`,
      },
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(uiApproveRes.status).toBe(201);
    const uiApproveJson = await uiApproveRes.json();
    expect(uiApproveJson.decision).toBe('approved');
    expect(uiApproveJson.actor.role).toBe('art_director');

    // Verify task transitioned to APPROVED (not REVISION_REQUESTED)
    const checkTask = await (await app.request(`/tasks/${task.id}`)).json();
    expect(checkTask.status).toBe('APPROVED');
  });
});
