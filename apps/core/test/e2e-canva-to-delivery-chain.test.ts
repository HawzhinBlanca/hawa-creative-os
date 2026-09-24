import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext, PublicationRepository, type Kysely, type Database } from '@hawa/db';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { canvaDeliverableStore } from '../src/services/pinned-deliverables.js';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { OutboxConsumer } from '../../worker/src/outbox-consumer.js';

describe('E2E Canva-to-Delivery Closed Loop', () => {
  let db: Kysely<Database>;
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';
  const kaaeClientId = 'c1000000-0000-4000-8000-000000000002';
  const testChannelId = '777888999';

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}`,
  };

  beforeAll(async () => {
    db = createDb(process.env.TEST_DATABASE_URL!);
    await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'administrator' }, async (trx) => {
      await sql`DELETE FROM hawa.outbox_commands WHERE tenant_id = ${tenantId}::uuid`.execute(trx);
    });
  });

  afterAll(async () => {
    if (db) await db.destroy();
  });

  it('completes the entire chain from intake to Canva draft, PostgreSQL revision & QC, Desk approval, delivery, and outbox notification', async () => {
    const sentMessages: Array<{ chatId: string; message: any }> = [];
    const mockTelegramBridge = {
      dispatchOutboundMessage: vi.fn().mockImplementation(async (chatId: string, message: any) => {
        sentMessages.push({ chatId, message });
        return { success: true, messageId: 'msg_' + randomUUID() };
      }),
      dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }),
    };

    const canvaService = new CanvaConnectService(db);
    const deliverableStore = canvaDeliverableStore(canvaService);

    const app = createAppWithClientFixtures({ testAuth: { roleHeader: true }, 
      db,
      deliverableStore,
      telegramBridge: mockTelegramBridge as any,
    });

    // -------------------------------------------------------------------------
    // 1. INTAKE: Create a new task for client KAAE with Telegram source channel
    // -------------------------------------------------------------------------
    const taskId = randomUUID();
    await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      await sql`
        INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${tenantId}::uuid, ${kaaeClientId}::uuid,
                'KAAE Accreditation Celebration 2026', 'Celebrate institutional accreditation',
                'received', 3, 1, now(), now())
      `.execute(trx);

      await sql`
        INSERT INTO hawa.task_events (id, tenant_id, task_id, aggregate_version, event_type, actor_type, actor_id, correlation_id, data, occurred_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, 1, 'task.created', 'user', ${operatorUserId}, ${randomUUID()}::uuid,
                ${JSON.stringify({
                  payload: {
                    sourcePlatform: 'telegram',
                    sourceChannelId: testChannelId,
                    headlineEn: 'Accreditation Milestone',
                    copyEn: 'We are pleased to announce full institutional accreditation.',
                  },
                })}::jsonb, now())
      `.execute(trx);
    });

    // -------------------------------------------------------------------------
    // 2. CANVA EXPORT: Record Canva binding and export bytes in hawa tables
    // -------------------------------------------------------------------------
    const designId = `canva_test_design_${randomUUID().slice(0, 8)}`;
    const opId = randomUUID();
    const exportId = randomUUID();
    const exportContent = Buffer.from('PNG_CANVA_TEST_EXPORT_BINARY_IMAGE_BYTES_12345');
    const exportSha256 = createHash('sha256').update(exportContent).digest('hex');

    await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      // Canva binding
      await sql`
        INSERT INTO hawa.canva_bindings (id, tenant_id, task_id, client_id, canva_design_id, edit_url, status, version, created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaaeClientId}::uuid,
                ${designId}, ${`https://www.canva.com/design/${designId}/edit`}, 'bound', 1, now(), now())
      `.execute(trx);

      // Remote operation for export
      await sql`
        INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata, created_at, updated_at)
        VALUES (${opId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaaeClientId}::uuid, ${operatorUserId},
                ${'req_' + randomUUID().slice(0, 8)}, 'hash_req', 'export', 'retrieved', ${designId}, 1,
                ${JSON.stringify({ format: 'pptx' })}::jsonb, now(), now())
      `.execute(trx);

      // Stored export bytes
      await sql`
        INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, content_check, created_at)
        VALUES (${exportId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaaeClientId}::uuid, ${opId}::uuid,
                'pptx', ${exportSha256}, ${exportContent},
                ${JSON.stringify({ copyPass: true, fontPass: true, rtlPass: true, status: 'passed' })}::jsonb, now())
      `.execute(trx);
    });

    // -------------------------------------------------------------------------
    // 3. WORKER STATUS WEBHOOK: Notify that Canva draft is ready for review
    // -------------------------------------------------------------------------
    const statusRes = await app.request(`/tasks/${taskId}/notifications/canva-status`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW',
        designId,
      }),
    });
    expect(statusRes.status).toBe(200);
    const statusJson = await statusRes.json();
    expect(statusJson.ok).toBe(true);
    expect(statusJson.canvaUrl).toContain(designId);

    // Verify in PostgreSQL: tasks.state must be 'human_review', current_design_revision_id must be populated
    const dbTaskAfterStatus = await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      return (await sql<any>`SELECT * FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(trx)).rows[0];
    });
    expect(dbTaskAfterStatus.state).toBe('human_review');
    expect(dbTaskAfterStatus.current_design_revision_id).toBeTruthy();

    const revId = dbTaskAfterStatus.current_design_revision_id;

    // Verify design_revisions record exists
    const dbRev = await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      return (await sql<any>`SELECT * FROM hawa.design_revisions WHERE id = ${revId}::uuid`.execute(trx)).rows[0];
    });
    expect(dbRev).toBeDefined();
    expect(dbRev.studio).toBe('canva');

    // Verify qc_runs record exists and critical_pass is true
    const dbQc = await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      return (await sql<any>`SELECT * FROM hawa.qc_runs WHERE design_revision_id = ${revId}::uuid`.execute(trx)).rows[0];
    });
    expect(dbQc).toBeDefined();
    expect(dbQc.critical_pass).toBe(true);
    expect(dbQc.status).toBe('passed');

    // -------------------------------------------------------------------------
    // 4. DESK API: Verify WorkScreen can query task, latestRevision, and qaReport
    // -------------------------------------------------------------------------
    const taskGetRes = await app.request(`/tasks/${taskId}`, { headers });
    expect(taskGetRes.status).toBe(200);
    const taskDetail = await taskGetRes.json();

    // Critical Desk button enablement assertions:
    expect(taskDetail.status).toBe('AWAITING_APPROVAL');
    expect(taskDetail.latestRevisionId).toBe(revId);
    expect(taskDetail.qaReport).toBeDefined();
    expect(taskDetail.qaReport.passed).toBe(true);
    expect(taskDetail.latestRevision).toBeDefined();
    expect(taskDetail.latestRevision.id).toBe(revId);
    expect(taskDetail.latestRevision.sha256).toBe(exportSha256);
    // The preview is the newest PNG export; this chain stored only the deck, so there is none to
    // draw (a deck drawn as a PNG was the broken preview of 2026-09-22).
    expect(taskDetail.latestRevision.previewUrl).toBeUndefined();
    expect(taskDetail.canvaBinding).toBeDefined();
    expect(taskDetail.canvaBinding.designId).toBe(designId);

    // Verify list endpoint /tasks also includes these fields
    const listRes = await app.request(`/tasks?status=AWAITING_APPROVAL`, { headers });
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    const taskInList = listJson.items.find((i: any) => i.id === taskId);
    expect(taskInList).toBeDefined();
    expect(taskInList.latestRevisionId).toBe(revId);
    expect(taskInList.qaReport.passed).toBe(true);
    expect(taskInList.canvaBinding.designId).toBe(designId);

    // -------------------------------------------------------------------------
    // 5. DESK APPROVAL: Approve the revision (auto-pinning retrieved exports)
    // -------------------------------------------------------------------------
    const approveRes = await app.request(`/tasks/${taskId}/revisions/${revId}/decisions`, {
      method: 'POST',
      headers: { ...headers, Authorization: 'Bearer test_art_director_bearer' },
      body: JSON.stringify({
        decision: 'approved',
        role: 'art_director',
        reason: 'Visual balance, exact copy, and KAAE brand compliance verified',
      }),
    });
    expect(approveRes.status).toBe(201);
    const approveJson = await approveRes.json();
    expect(approveJson.decision).toBe('approved');
    expect(approveJson.pinnedExports).toBeDefined();
    expect(approveJson.pinnedExports.length).toBeGreaterThanOrEqual(1);
    expect(approveJson.pinnedExports[0].artifactId).toBe(exportId);
    expect(approveJson.pinnedExports[0].sha256).toBe(exportSha256);

    // Verify task state in DB is now 'approved'
    const dbTaskAfterApprove = await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      return (await sql<any>`SELECT * FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(trx)).rows[0];
    });
    expect(dbTaskAfterApprove.state).toBe('approved');

    // Verify GET /tasks/:taskId returns status 'APPROVED' and populated latestApproval
    const approvedTaskGet = await (await app.request(`/tasks/${taskId}`, { headers })).json();
    expect(approvedTaskGet.status).toBe('APPROVED');
    expect(approvedTaskGet.latestApproval).toBeDefined();
    expect(approvedTaskGet.latestApproval.decisionId).toBeTruthy();

    // -------------------------------------------------------------------------
    // 6. DESK DELIVERY: Trigger publication to Google Drive and Google Sheets
    // -------------------------------------------------------------------------
    const deliverRes = await app.request(`/tasks/${taskId}/publish`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ policy: 'current_task' }),
    });
    expect(deliverRes.status).toBe(202);
    const deliverJson = await deliverRes.json();
    expect(deliverJson.status).toBe('COMPLETE');
    expect(deliverJson.receipt).toBeDefined();

    // Verify task state in DB is now 'complete'
    const dbTaskAfterDeliver = await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      return (await sql<any>`SELECT * FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(trx)).rows[0];
    });
    expect(dbTaskAfterDeliver.state).toBe('complete');

    // Verify publication record exists and is complete
    const dbPub = await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      return (await sql<any>`SELECT * FROM hawa.publications WHERE task_id = ${taskId}::uuid`.execute(trx)).rows[0];
    });
    expect(dbPub).toBeDefined();
    expect(dbPub.state).toBe('complete');

    // Verify hawa.outbox_commands has notify.published command
    const outboxCmd = await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      return (await sql<any>`
        SELECT * FROM hawa.outbox_commands
        WHERE aggregate_id = ${taskId}::uuid AND command_type = 'notify.published'
      `.execute(trx)).rows[0];
    });
    expect(outboxCmd).toBeDefined();
    expect(outboxCmd.command_type).toBe('notify.published');
    expect(outboxCmd.state).toBe('pending');

    // -------------------------------------------------------------------------
    // 7. OUTBOX CONSUMER: Worker leases and executes notify.published handler
    // -------------------------------------------------------------------------
    let outboxNotified = false;
    let publishedChatId: string | null = null;

    const consumer = new OutboxConsumer(db, {
      tenantId,
      userId: operatorUserId,
      batchSize: 10,
      handlers: {
        'notify.published': async (cmd, _db, scope) => {
          // Resolve task channel from DB under RLS, in its own short transaction: a handler runs
          // with no transaction open (outbox-consumer.ts).
          const taskInfo: any = await scope.inTenant((trx) => sql`
            SELECT t.title, e.data
            FROM hawa.tasks t
            LEFT JOIN hawa.task_events e ON e.task_id = t.id AND e.event_type = 'task.created'
            WHERE t.id = ${taskId}::uuid LIMIT 1
          `.execute(trx));

          const eventPayload = taskInfo.rows[0]?.data?.payload || {};
          publishedChatId = eventPayload.sourceChannelId;

          const dispatch = await mockTelegramBridge.dispatchOutboundMessage(publishedChatId!, {
            text: `🚀 Campaign Assets Delivered for task ${taskId}! Drive folder: ${cmd.payload.driveFiles?.[0]?.name}`,
          });

          if (dispatch.success) {
            outboxNotified = true;
          }
        },
      },
    });

    const summary = await consumer.processBatch(10);
    expect(summary.succeeded).toBeGreaterThanOrEqual(1);
    expect(outboxNotified).toBe(true);
    expect(publishedChatId).toBe(testChannelId);

    // Verify outbox command marked 'delivered' in PostgreSQL
    const deliveredCmd = await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      return (await sql<any>`
        SELECT state, delivered_at FROM hawa.outbox_commands WHERE id = ${outboxCmd.id}::uuid
      `.execute(trx)).rows[0];
    });
    expect(deliveredCmd.state).toBe('delivered');
    expect(deliveredCmd.delivered_at).toBeTruthy();

    // Verify telegram message was dispatched to the right chat
    expect(sentMessages.some((m) => m.chatId === testChannelId && m.message.text.includes(taskId))).toBe(true);

    // -------------------------------------------------------------------------
    // 8. SHEETS RETRY: a sheet that failed once can still be recorded as synced
    // -------------------------------------------------------------------------
    // recordSheetSync was a plain INSERT on a UNIQUE (spreadsheet, sheet, row_key) row, so the retry
    // after a failed first attempt always died on the key and the ledger row could never be closed.
    const repo = new PublicationRepository(db);
    const rowKey = `retry-${randomUUID()}`;
    const base = {
      tenantId, publicationId: dbPub.id, spreadsheetId: 'sheet_retry_fixture', sheetId: 0, taskId, rowKey,
      expectedHash: 'a'.repeat(64),
    };
    const asOperator = <T>(fn: (trx: any) => Promise<T>) => withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, fn);

    const first = await asOperator((trx) => repo.recordSheetSync({ ...base, status: 'pending', lastError: 'Sheets 503' }, trx));
    expect(first.status).toBe('pending');
    expect(first.attempts).toBe(1);

    const retried = await asOperator((trx) => repo.recordSheetSync({ ...base, status: 'synced', rowNumber: 42, observedHash: 'a'.repeat(64) }, trx));
    expect(retried.id).toBe(first.id);
    expect(retried.status).toBe('synced');
    expect(retried.attempts).toBe(2);
    expect(Number(retried.row_number)).toBe(42);
    expect(retried.last_error).toBeNull();
    expect(retried.synced_at).toBeTruthy();

    // A late 'pending' for the same content must not undo a confirmed sync.
    const late = await asOperator((trx) => repo.recordSheetSync({ ...base, status: 'pending' }, trx));
    expect(late.status).toBe('synced');
    expect(Number(late.row_number)).toBe(42);
    expect(late.attempts).toBe(3);

    const rows = await asOperator(async (trx) => (await sql<any>`SELECT count(*)::int AS n FROM hawa.sheet_syncs WHERE row_key = ${rowKey}`.execute(trx)).rows[0].n);
    expect(rows).toBe(1);

    // The same key presented for a different task is refused, not overwritten.
    const otherTask = randomUUID();
    await asOperator((trx) => sql`
      INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
      VALUES (${otherTask}::uuid, ${tenantId}::uuid, ${kaaeClientId}::uuid, 'Other task', 'owns no sheet row', 'received', 3, 1, now(), now())`.execute(trx));
    await expect(asOperator((trx) => repo.recordSheetSync({ ...base, taskId: otherTask, status: 'synced' }, trx))).rejects.toThrow(/already belongs to another task/);
    const untouched = await asOperator(async (trx) => (await sql<any>`SELECT task_id, status FROM hawa.sheet_syncs WHERE row_key = ${rowKey}`.execute(trx)).rows[0]);
    expect(untouched.task_id).toBe(taskId);
    expect(untouched.status).toBe('synced');
  });

  it('fails closed when exported copy is corrupted: records failed QC run and refuses approval (HTTP 412)', async () => {
    const canvaService = new CanvaConnectService(db);
    const deliverableStore = canvaDeliverableStore(canvaService);
    const app = createAppWithClientFixtures({ testAuth: { roleHeader: true }, 
      db,
      deliverableStore,
    });

    const taskId = randomUUID();
    await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      await sql`
        INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${tenantId}::uuid, ${kaaeClientId}::uuid,
                'Corrupted Copy Test Task', 'Task with mismatched copy',
                'received', 3, 1, now(), now())
      `.execute(trx);
    });

    const designId = `canva_corrupt_${randomUUID().slice(0, 8)}`;
    const opId = randomUUID();
    const exportId = randomUUID();
    const exportContent = Buffer.from('PNG_CORRUPTED_EXPORT_CONTENT_LONGER_THAN_32_BYTES_12345');
    const exportSha256 = createHash('sha256').update(exportContent).digest('hex');

    // Store export bytes with corrupted copy check failure
    await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      await sql`
        INSERT INTO hawa.canva_bindings (id, tenant_id, task_id, client_id, canva_design_id, edit_url, status, version, created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaaeClientId}::uuid,
                ${designId}, ${`https://www.canva.com/design/${designId}/edit`}, 'bound', 1, now(), now())
      `.execute(trx);

      await sql`
        INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata, created_at, updated_at)
        VALUES (${opId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaaeClientId}::uuid, ${operatorUserId},
                ${'req_' + randomUUID().slice(0, 8)}, 'hash_req', 'export', 'retrieved', ${designId}, 1,
                ${JSON.stringify({ format: 'pptx' })}::jsonb, now(), now())
      `.execute(trx);

      await sql`
        INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, content_check, created_at)
        VALUES (${exportId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaaeClientId}::uuid, ${opId}::uuid,
                'pptx', ${exportSha256}, ${exportContent},
                ${JSON.stringify({
                  copyPass: false,
                  fontPass: true,
                  status: 'failed',
                  offendingObjects: [{ text: 'Corrupted hallucinated slogan', reason: 'Mismatch with source copy' }],
                })}::jsonb, now())
      `.execute(trx);
    });

    // Notify Canva draft ready
    const statusRes = await app.request(`/tasks/${taskId}/notifications/canva-status`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW',
        designId,
      }),
    });
    expect(statusRes.status).toBe(200);

    // Verify task state in DB: state is 'human_review', revision is linked
    const dbTask = await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      return (await sql<any>`SELECT * FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(trx)).rows[0];
    });
    expect(dbTask.current_design_revision_id).toBeTruthy();
    const revId = dbTask.current_design_revision_id;

    // Verify qc_runs record in PostgreSQL recorded a REAL FAILURE
    const dbQc = await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      return (await sql<any>`SELECT * FROM hawa.qc_runs WHERE design_revision_id = ${revId}::uuid`.execute(trx)).rows[0];
    });
    expect(dbQc).toBeDefined();
    expect(dbQc.critical_pass).toBe(false);
    expect(dbQc.status).toBe('failed');
    expect(dbQc.report?.errors?.length).toBeGreaterThan(0);
    expect(dbQc.report.errors[0]).toContain('Copy mismatch');

    // Desk API: verify task details show changes requested / failed QC
    const taskGetRes = await app.request(`/tasks/${taskId}`, { headers });
    expect(taskGetRes.status).toBe(200);
    const taskDetail = await taskGetRes.json();
    expect(taskDetail.qaReport.passed).toBe(false);
    expect(taskDetail.qaReport.copyFidelity).toBe(false);

    // Desk Attempt to Approve MUST BE REFUSED WITH HTTP 412
    const approveRes = await app.request(`/tasks/${taskId}/revisions/${revId}/decisions`, {
      method: 'POST',
      headers: { ...headers, Authorization: 'Bearer test_art_director_bearer' },
      body: JSON.stringify({
        decision: 'approved',
        role: 'art_director',
        reason: 'Attempting approval despite corrupted copy',
      }),
    });
    expect(approveRes.status).toBe(412);
    const approveError = await approveRes.json();
    expect(approveError.title).toBe('QA Verification Required');

    // Ensure task in PostgreSQL remains unapproved
    const dbTaskAfterFailedApprove = await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      return (await sql<any>`SELECT * FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(trx)).rows[0];
    });
    expect(dbTaskAfterFailedApprove.state).toBe('human_review');
  });
});
