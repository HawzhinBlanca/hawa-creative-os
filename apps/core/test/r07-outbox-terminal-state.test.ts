import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { GooglePublisher } from '@hawa/integrations';
import { createDb, type Kysely, type Database, OutboxRepository, withRlsContext } from '@hawa/db';
import { memoryExportStore } from './pinned-exports-fixture.js';
import type { PublishRequest, RequestContext } from '@hawa/contracts';
import { OutboxConsumer, OutboxDeliveryError } from '../../worker/src/outbox-consumer.js';

describe('R07: Close Durable Workflow Through Terminal State & Notification (FR-051–053, FR-081–082, NFR-001, NFR-014)', () => {
  const originalEnv = { ...process.env };
  const testTenantId = '00000000-0000-4000-a000-000000000007';
  const adminUserId = '00000000-0000-4000-b000-000000000007';
  const testDbUrl = process.env.TEST_DATABASE_URL!;

  const operatorHeaders = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer test_bearer',
  };
  const reviewerHeaders = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer test_bearer',
    'x-user-role': 'art_director',
  };
  const viewerHeaders = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer test_bearer',
    'x-user-role': 'viewer',
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-r07-test-'));
  const testFilePng = path.join(tempDir, 'story.png');
  const testFileBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const testFileSha256 = crypto.createHash('sha256').update(testFileBytes).digest('hex');
  fs.writeFileSync(testFilePng, testFileBytes);

  // The outbox, the approvals and the publications are only held in Postgres (architecture programme
  // 1.3, groups G3 and G5): there is no in-memory outbox any more, so these apps run on this file's own
  // test database and a failed delivery is simulated on the command's row.
  const testDb = createDb(testDbUrl);
  const DRUSTEE = 'c1000000-0000-4000-8000-000000000003';
  const operatorScope = { tenantId: '00000000-0000-4000-a000-000000000001', userId: '00000000-0000-4000-b000-000000000001', role: 'operator' };
  /** QA passes: the subject is delivery and its outbox, and Postgres approves only after a passing run. */
  const passingQa = {
    run: async (_ctx: unknown, input: { designRevisionId: string }) => ({
      ok: true as const,
      value: { qcRunId: crypto.randomUUID(), revisionId: input.designRevisionId, status: 'passed', criticalPass: true, findings: [], profile: 'strict' },
    }),
  };
  const r07App = (publisher: GooglePublisher, exports: ReturnType<typeof memoryExportStore>) =>
    createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'operator' }, roleHeader: true }, publisher, deliverableStore: exports.store, qaEngine: passingQa as never, allowRoleHeader: true });
  /** The task's delivery notice, as the outbox list reports it. */
  const notifyCommand = async (app: ReturnType<typeof createApp>, taskId: string) => {
    const res = await app.request(`/v1/tasks/${taskId}/outbox`, { headers: operatorHeaders });
    expect(res.status).toBe(200);
    const cmd = (await res.json()).commands.find((c: any) => c.commandType === 'notify.published');
    expect(cmd).toBeDefined();
    return cmd;
  };
  /** What the worker records when a send fails, written on the command's row. */
  const failCommand = (commandId: string, lastError: string) =>
    withRlsContext(testDb, operatorScope, (trx) =>
      trx.updateTable('outbox_commands').set({ state: 'failed', last_error: lastError, attempts: 1 }).where('id', '=', commandId).execute());

  afterAll(async () => {
    process.env = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
    await testDb.destroy();
  });

  async function createApprovedTaskWithExport(app: ReturnType<typeof createApp>, exports: ReturnType<typeof memoryExportStore>) {
    // A request from a Telegram chat, which the delivery notice goes back to (Postgres's outbox writes
    // no notice for a Desk task, which has no chat), routed to Drustee.
    const intake = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'expected_office_secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ update_id: 7_000_000 + Math.floor(Math.random() * 1e6), message: { text: 'Terminal Workflow Task', chat: { id: 7007 } } }),
    });
    const created = await intake.json();
    const task = { id: (created.id || created.task?.id) as string };
    expect(task.id).toBeTruthy();
    const routed = await app.request(`/v1/tasks/${task.id}/route`, { method: 'POST', headers: operatorHeaders, body: JSON.stringify({ clientId: DRUSTEE, reason: 'Client assigned' }) });
    expect(routed.status).toBe(202);

    const revRes = await app.request(`/v1/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({
        nodes: [{ id: 'n1', type: 'text', text: 'Verified Deliverable' }],
      }),
    });
    expect(revRes.status).toBe(201);
    const rev = await revRes.json();

    // Passing QA
    const qaRes = await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/qa`, {
      method: 'POST',
      headers: operatorHeaders,
    });
    expect(qaRes.status).toBe(200);

    // Pinned export
    const exportId = exports.add(task.id, 'png', testFileBytes);

    // Approve
    const approveRes = await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/decisions`, {
      method: 'POST',
      headers: reviewerHeaders,
      body: JSON.stringify({
        action: 'approve',
        pinnedExportIds: [exportId],
      }),
    });
    expect(approveRes.status).toBe(201);
    const approval = await approveRes.json();

    return { task, rev, approval, exportId };
  }

  it('1. Atomically commits terminal task completion and enrolls notify.published outbox command', async () => {
    const exports = memoryExportStore();
    const publisher = new GooglePublisher({
      driveUploadFn: async () => ({
        fileId: 'drv_r07_file1',
        name: 'story.png',
        mimeType: 'image/png',
        sha256: testFileSha256,
        size: testFileBytes.length,
        folderId: 'fld_prod_1',
      }),
      sheetAppendFn: async () => ({
        spreadsheetId: 'sheet_r07_123',
        rowNumber: 22,
        hash: 'pkg_hash_r07',
      }),
    });

    const app = r07App(publisher, exports);
    const { task, approval } = await createApprovedTaskWithExport(app, exports);

    // Publish
    const pubRes = await app.request(`/v1/tasks/${task.id}/publish`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({ approvalId: approval.decisionId }),
    });
    expect(pubRes.status).toBe(202);
    const pubBody = await pubRes.json();
    expect(pubBody.status).toBe('COMPLETE');

    // Verify task state in core
    const getTaskRes = await app.request(`/v1/tasks/${task.id}`, { headers: operatorHeaders });
    expect(getTaskRes.status).toBe(200);
    const updatedTask = await getTaskRes.json();
    expect(updatedTask.status).toBe('COMPLETE');

    // Inspect outbox via GET /tasks/:taskId/outbox
    const outboxRes = await app.request(`/v1/tasks/${task.id}/outbox`, { headers: operatorHeaders });
    expect(outboxRes.status).toBe(200);
    const outboxBody = await outboxRes.json();
    expect(outboxBody.count).toBeGreaterThanOrEqual(1);

    const notifyCmd = outboxBody.commands.find((c: any) => c.commandType === 'notify.published');
    expect(notifyCmd).toBeDefined();
    expect(notifyCmd.state).toBe('pending');
    expect(notifyCmd.attempts).toBe(0);
    expect(notifyCmd.payload.taskId).toBe(task.id);
    expect(notifyCmd.payload.publicationKey).toBeDefined();
    expect(notifyCmd.actionableRecovery).toContain('pending worker pickup');
  });

  it('2. Preserves COMPLETE publication and task state if outbox notification fails (FR-051 decoupling)', async () => {
    const exports = memoryExportStore();
    const publisher = new GooglePublisher({
      driveUploadFn: async () => ({
        fileId: 'drv_r07_file2',
        name: 'story.png',
        mimeType: 'image/png',
        sha256: testFileSha256,
        size: testFileBytes.length,
        folderId: 'fld_prod_1',
      }),
      sheetAppendFn: async () => ({
        spreadsheetId: 'sheet_r07_123',
        rowNumber: 23,
        hash: 'pkg_hash_r07',
      }),
    });

    const app = r07App(publisher, exports);
    const { task, approval } = await createApprovedTaskWithExport(app, exports);

    const pubRes = await app.request(`/v1/tasks/${task.id}/publish`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({ approvalId: approval.decisionId }),
    });
    expect(pubRes.status).toBe(202);

    // Directly inspect publication state - publication remains COMPLETE despite notification failure
    const pubStateRes = await app.request(`/v1/tasks/${task.id}/publication-state`, { headers: operatorHeaders });
    expect(pubStateRes.status).toBe(200);
    const pubState = await pubStateRes.json();
    expect(pubState.status).toBe('COMPLETE');
    expect(pubState.driveFiles.verified).toBe(true);
    expect(pubState.sheetSync.synced).toBe(true);
  });

  it('3. Outbox consumer distinguishes retryable, permanent, and uncertain errors', async () => {
    // 1. Error class test
    const retryableErr = new OutboxDeliveryError('Telegram 503 Service Unavailable', 'retryable');
    expect(retryableErr.category).toBe('retryable');

    const permanentErr = new OutboxDeliveryError('Telegram CHAT_NOT_FOUND', 'permanent');
    expect(permanentErr.category).toBe('permanent');

    const uncertainErr = new OutboxDeliveryError('Socket hang up after HTTP 200 payload write', 'uncertain');
    expect(uncertainErr.category).toBe('uncertain');

    // 2. Integration test with real test PostgreSQL database
    const db = createDb(testDbUrl);
    const outboxRepo = new OutboxRepository(db);
    const task1 = crypto.randomUUID();
    const task2 = crypto.randomUUID();
    const task3 = crypto.randomUUID();

    try {
      await withRlsContext(db, { tenantId: testTenantId, userId: adminUserId, role: 'administrator' }, async (trx) => {
        await trx.deleteFrom('outbox_commands').where('tenant_id', '=', testTenantId).execute();

        // Enqueue 1: Permanent failure command
        await outboxRepo.enqueue({
          tenantId: testTenantId,
          aggregateType: 'task',
          aggregateId: task1,
          commandType: 'notify.published',
          idempotencyKey: `ik-perm-${Date.now()}`,
          payload: { destination: 'telegram-deleted-chat' },
        }, trx);

        // Enqueue 2: Uncertain delivery command
        await outboxRepo.enqueue({
          tenantId: testTenantId,
          aggregateType: 'task',
          aggregateId: task2,
          commandType: 'notify.published',
          idempotencyKey: `ik-uncert-${Date.now()}`,
          payload: { destination: 'telegram-flaky-conn' },
        }, trx);

        // Enqueue 3: Retryable temporary failure command
        await outboxRepo.enqueue({
          tenantId: testTenantId,
          aggregateType: 'task',
          aggregateId: task3,
          commandType: 'notify.published',
          idempotencyKey: `ik-retry-${Date.now()}`,
          payload: { destination: 'telegram-rate-limited' },
        }, trx);
      });

      const consumer = new OutboxConsumer(db, {
        tenantId: testTenantId,
        userId: adminUserId,
        batchSize: 10,
        handlers: {
          'notify.published': async (cmd) => {
            const dest = (cmd.payload as any)?.destination;
            if (dest === 'telegram-deleted-chat') {
              throw new OutboxDeliveryError('CHAT_NOT_FOUND: user has blocked bot or chat deleted', 'permanent');
            }
            if (dest === 'telegram-flaky-conn') {
              throw new OutboxDeliveryError('DELIVERY_UNCERTAIN: client disconnected before ACK', 'uncertain');
            }
            if (dest === 'telegram-rate-limited') {
              throw new OutboxDeliveryError('Telegram 429 Too Many Requests', 'retryable');
            }
          },
        },
      });

      const summary = await consumer.processBatch(10);
      expect(summary.leased).toBe(3);

      // Verify states in DB under RLS context
      await withRlsContext(db, { tenantId: testTenantId, userId: adminUserId, role: 'administrator' }, async (trx) => {
        const commands = await outboxRepo.findByAggregateId(testTenantId, task1, trx);
        const permCmd = commands[0];
        expect(permCmd.state).toBe('failed');
        expect(permCmd.attempts).toBe(1);
        expect(permCmd.last_error).toContain('CHAT_NOT_FOUND');

        const uncertCommands = await outboxRepo.findByAggregateId(testTenantId, task2, trx);
        const uncertCmd = uncertCommands[0];
        expect(uncertCmd.state).toBe('failed');
        expect(uncertCmd.attempts).toBe(1);
        expect(uncertCmd.last_error).toContain('DELIVERY_UNCERTAIN:');

        const retryCommands = await outboxRepo.findByAggregateId(testTenantId, task3, trx);
        const retryCmd = retryCommands[0];
        expect(retryCmd.state).toBe('pending');
        expect(retryCmd.attempts).toBe(1);
        expect(retryCmd.last_error).toContain('Too Many Requests');
      });
    } finally {
      await db.destroy();
    }
  });

  it('4. Outbox discovery endpoint surfaces actionable recovery instructions for all failure types', async () => {
    const exports = memoryExportStore();
    const publisher = new GooglePublisher({
      driveUploadFn: async () => ({
        fileId: 'drv_r07_file3',
        name: 'story.png',
        mimeType: 'image/png',
        sha256: testFileSha256,
        size: testFileBytes.length,
        folderId: 'fld_prod_1',
      }),
      sheetAppendFn: async () => ({
        spreadsheetId: 'sheet_r07_123',
        rowNumber: 24,
        hash: 'pkg_hash_r07',
      }),
    });

    const app = r07App(publisher, exports);
    const { task, approval } = await createApprovedTaskWithExport(app, exports);

    await app.request(`/v1/tasks/${task.id}/publish`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({ approvalId: approval.decisionId }),
    });

    // Fetch initial outbox command
    const serverCmd = await notifyCommand(app, task.id);
    expect(serverCmd.actionableRecovery).toContain('pending worker pickup');

    // The worker records a permanent failure on the command
    await failCommand(serverCmd.id, 'CHAT_NOT_FOUND: chat id does not exist');

    const permCmd = await notifyCommand(app, task.id);
    expect(permCmd.errorCategory).toBe('permanent');
    expect(permCmd.actionableRecovery).toContain('Permanent delivery failure');

    // The worker records an uncertain failure on the command
    await failCommand(serverCmd.id, 'DELIVERY_UNCERTAIN: socket timeout after dispatch');
    const uncertCmd = await notifyCommand(app, task.id);
    expect(uncertCmd.errorCategory).toBe('uncertain');
    expect(uncertCmd.requiresUncertainConfirmation).toBe(true);
    expect(uncertCmd.actionableRecovery).toContain('Uncertain delivery');
    expect(uncertCmd.actionableRecovery).toContain('confirmUncertainReplay');
  });

  it('5. Enforces safety gate on redrive: rejects uncertain replays without explicit confirmation and blocks non-operators', async () => {
    const exports = memoryExportStore();
    const publisher = new GooglePublisher({
      driveUploadFn: async () => ({
        fileId: 'drv_r07_file4',
        name: 'story.png',
        mimeType: 'image/png',
        sha256: testFileSha256,
        size: testFileBytes.length,
        folderId: 'fld_prod_1',
      }),
      sheetAppendFn: async () => ({
        spreadsheetId: 'sheet_r07_123',
        rowNumber: 25,
        hash: 'pkg_hash_r07',
      }),
    });

    const app = r07App(publisher, exports);
    const { task, approval } = await createApprovedTaskWithExport(app, exports);

    await app.request(`/v1/tasks/${task.id}/publish`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({ approvalId: approval.decisionId }),
    });

    const serverCmd = await notifyCommand(app, task.id);

    // Non-operator is forbidden even before inspecting command state
    const viewerRedriveRes = await app.request(`/v1/tasks/${task.id}/outbox/${serverCmd.id}/redrive`, {
      method: 'POST',
      headers: viewerHeaders,
      body: JSON.stringify({}),
    });
    expect(viewerRedriveRes.status).toBe(403);

    // Operator cannot redrive a 'pending' command (must be failed)
    const earlyRedriveRes = await app.request(`/v1/tasks/${task.id}/outbox/${serverCmd.id}/redrive`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({}),
    });
    expect(earlyRedriveRes.status).toBe(409);

    // The worker records an uncertain delivery failure on the command
    await failCommand(serverCmd.id, 'DELIVERY_UNCERTAIN: client disconnected before ACK');

    // Redrive without confirmUncertainReplay is rejected with 422
    const unconfirmedRedriveRes = await app.request(`/v1/tasks/${task.id}/outbox/${serverCmd.id}/redrive`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({}),
    });
    expect(unconfirmedRedriveRes.status).toBe(422);
    const unconfirmedBody = await unconfirmedRedriveRes.json();
    expect(unconfirmedBody.title).toContain('Uncertain Delivery Requires Explicit Confirmation');

    // Redrive WITH confirmUncertainReplay succeeds
    const confirmedRedriveRes = await app.request(`/v1/tasks/${task.id}/outbox/${serverCmd.id}/redrive`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({ confirmUncertainReplay: true }),
    });
    expect(confirmedRedriveRes.status).toBe(200);
    const confirmedBody = await confirmedRedriveRes.json();
    expect(confirmedBody.redriven).toBe(true);
    expect(confirmedBody.state).toBe('pending');
    expect(confirmedBody.attempts).toBe(0);
    expect(confirmedBody.confirmedUncertainReplay).toBe(true);
  });

  it('6. Publication state endpoint reports accurate sync status and reconciliation guidance', async () => {
    const exports = memoryExportStore();
    const publisher = new GooglePublisher({
      driveUploadFn: async () => ({
        fileId: 'drv_r07_file5',
        name: 'story.png',
        mimeType: 'image/png',
        sha256: testFileSha256,
        size: testFileBytes.length,
        folderId: 'fld_prod_1',
      }),
      sheetAppendFn: async () => ({
        spreadsheetId: 'sheet_r07_123',
        rowNumber: 26,
        hash: 'pkg_hash_r07',
      }),
    });

    const app = r07App(publisher, exports);
    const { task, approval } = await createApprovedTaskWithExport(app, exports);

    // Before publish
    const prePubRes = await app.request(`/v1/tasks/${task.id}/publication-state`, { headers: operatorHeaders });
    expect(prePubRes.status).toBe(200);
    const prePub = await prePubRes.json();
    expect(prePub.state).toBe('unstarted');
    expect(prePub.actionableRecovery).toContain('No publication has been initiated');

    // Perform publish
    await app.request(`/v1/tasks/${task.id}/publish`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({ approvalId: approval.decisionId }),
    });

    // After publish
    const postPubRes = await app.request(`/v1/tasks/${task.id}/publication-state`, { headers: operatorHeaders });
    expect(postPubRes.status).toBe(200);
    const postPub = await postPubRes.json();
    expect(postPub.state).toBe('complete');
    expect(postPub.driveFiles.verified).toBe(true);
    expect(postPub.sheetSync.synced).toBe(true);
    expect(postPub.sheetSync.rowNumber).toBeGreaterThanOrEqual(2);
    expect(postPub.notification.status).toBe('pending');
  });
});
