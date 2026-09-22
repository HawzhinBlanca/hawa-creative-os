import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext, TaskRepository } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

/**
 * What a terminal Canva outcome does to the task record and to the requester.
 *
 * On 2026-09-23 almost every production task read RECEIVED after its design was delivered: only a
 * "ready" outcome moved a task, as a raw UPDATE with no event; the backup move read the task outside
 * any tenant context and silently found nothing (TEST_DATABASE_URL connects as hawa_app, the same
 * role, so these tests see the same row-level security production does); every failed run stayed
 * RECEIVED; drafts with a failed check were never shown in the Desk; and /redo handed v3 requests to
 * the older single-shot planner.
 */
describe('a Canva outcome moves the task truthfully and tells the requester plainly', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';
  const kaaeClientId = 'c1000000-0000-4000-8000-000000000002';
  const scope = { tenantId, userId: operatorUserId, role: 'operator' };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
  afterAll(() => db.destroy());
  afterEach(() => { vi.unstubAllEnvs(); });

  const channel = () => String(9_000_000_000 + Math.floor(Math.random() * 999_999_999));

  const telegramTask = async (sourceChannelId: string, extra: Record<string, unknown> = {}) =>
    (
      await persistChatIntake(db, {
        platform: 'telegram',
        sourceEventId: randomUUID(),
        sourceChannelId,
        clientId: kaaeClientId,
        title: 'KAAE: Standards launch',
        rawText: 'Launch announcement\n---\nStandards Framework 2.0',
        designInstructions: '',
        exactCopy: [{ id: 'copy_0', role: 'headline', text: 'Standards Framework 2.0' }],
        autoGenerate: true,
        ...extra,
      } as any)
    ).task.id as string;

  const bridge = () => {
    const sent: Array<{ chatId: string; message: any }> = [];
    const photos: Array<{ chatId: string; caption?: string }> = [];
    return {
      sent,
      photos,
      telegramBridge: {
        dispatchOutboundMessage: vi.fn(async (chatId: string, message: any) => { sent.push({ chatId, message }); return { success: true, messageId: String(sent.length) }; }),
        dispatchOutboundPhoto: vi.fn(async (chatId: string, _buf: Buffer, caption?: string) => { photos.push({ chatId, caption }); return { success: true }; }),
      },
    };
  };

  const notify = (app: any, taskId: string, body: Record<string, unknown>) =>
    app.request(`/v1/tasks/${taskId}/notifications/canva-status`, { method: 'POST', headers, body: JSON.stringify(body) });

  const taskRow = async (taskId: string) =>
    withRlsContext(db, scope, async (trx) => (await sql<any>`SELECT * FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(trx)).rows[0]);
  const stateEvents = async (taskId: string) =>
    withRlsContext(db, scope, async (trx) =>
      (await sql<any>`SELECT data FROM hawa.task_events WHERE task_id = ${taskId}::uuid AND event_type = 'task.state_changed' ORDER BY aggregate_version`.execute(trx)).rows.map((r: any) => r.data));
  const qcRuns = async (taskId: string) =>
    withRlsContext(db, scope, async (trx) => (await sql<any>`SELECT * FROM hawa.qc_runs WHERE task_id = ${taskId}::uuid`.execute(trx)).rows);

  it('moves a delivered draft to review with an event, and records it as the Desk revision', async () => {
    const taskId = await telegramTask(channel());
    const { telegramBridge } = bridge();
    const res = await notify(createApp({ db, telegramBridge } as any), taskId, { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAGoutcome001' });
    expect(res.status).toBe(200);

    const row = await taskRow(taskId);
    expect(row.state).toBe('human_review');
    expect(row.current_design_revision_id).toBeTruthy();
    // The move used to be a raw UPDATE: the history showed no move at all.
    expect((await stateEvents(taskId)).map((e: any) => [e.fromState, e.toState])).toEqual([['received', 'human_review']]);
    expect(await qcRuns(taskId)).toHaveLength(1);
  });

  it('moves a failed run to OPERATOR_REQUIRED, keeps the code in the history, and tells the requester in plain words', async () => {
    const taskId = await telegramTask(channel());
    const { telegramBridge, sent } = bridge();
    const detail = 'Studio v3 failed: Winner failed hard QA: TEXT_OVERFLOW, LOGO_CLEARANCE';
    await notify(createApp({ db, telegramBridge } as any), taskId, { status: 'DESIGN_FAILED', code: 'HARD_QA_REFUSED', detail, runId: randomUUID() });

    expect((await taskRow(taskId)).state).toBe('failed_operator');
    const [event] = await stateEvents(taskId);
    expect(event).toMatchObject({ fromState: 'received', toState: 'failed_operator', code: 'HARD_QA_REFUSED', detail });
    expect(event.reason).toContain('HARD_QA_REFUSED');

    expect(sent).toHaveLength(1);
    const text = sent[0].message.text as string;
    expect(text).toContain('The office has been alerted and will follow up with you here.');
    expect(text).not.toContain('HARD_QA_REFUSED');
    expect(text).not.toContain('TEXT_OVERFLOW');
  });

  it('records a draft whose automatic check failed, so the Desk shows it, with QC failed so approval stays blocked', async () => {
    const taskId = await telegramTask(channel());
    const { telegramBridge, sent } = bridge();
    await notify(createApp({ db, telegramBridge } as any), taskId, { status: 'CANVA_COPY_MISMATCH', designId: 'DAGcopymiss01' });

    const row = await taskRow(taskId);
    expect(row.state).toBe('human_review');
    expect(row.current_design_revision_id).toBeTruthy();
    const [qc] = await qcRuns(taskId);
    expect(qc.critical_pass).toBe(false);
    expect(JSON.stringify(qc.report)).toContain('CANVA_COPY_MISMATCH');
    // The requester still gets the link and the honest caveat.
    expect(sent[0].message.text).toContain('https://www.canva.com/design/DAGcopymiss01/edit');
  });

  it('moves a task back to review when a later run delivers a draft, even when its revision already exists', async () => {
    const taskId = await telegramTask(channel());
    const { telegramBridge } = bridge();
    const app = createApp({ db, telegramBridge } as any);
    await notify(app, taskId, { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAGfirst0001' });
    // An operator was called after it (a failed re-drive, say).
    await withRlsContext(db, scope, async (trx) => {
      const current = await new TaskRepository(trx).findById(taskId, tenantId, trx);
      await new TaskRepository(trx).transitionState({
        taskId, tenantId, expectedVersion: Number(current!.version), fromState: 'human_review', toState: 'failed_operator',
        actorType: 'workflow', actorId: operatorUserId, reason: 'test: operator called',
      }, trx);
    });

    await notify(app, taskId, { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAGsecond002' });
    // The bridge skips a task that has a revision; the move used to be left to a read that row-level
    // security answered with no row, so the task stayed where it was.
    expect((await taskRow(taskId)).state).toBe('human_review');
    expect((await stateEvents(taskId)).map((e: any) => e.toState)).toEqual(['human_review', 'failed_operator', 'human_review']);
  });

  it('never drags a task back from review because a late failure arrives', async () => {
    const taskId = await telegramTask(channel());
    const { telegramBridge } = bridge();
    const app = createApp({ db, telegramBridge } as any);
    await notify(app, taskId, { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAGkeep00001' });
    await notify(app, taskId, { status: 'DESIGN_SERVER_ERROR', code: 'RETRY_EXHAUSTED' });
    expect((await taskRow(taskId)).state).toBe('human_review');
  });

  it('records a not-runnable outcome without a second message when intake already told the requester', async () => {
    const taskId = await telegramTask(channel(), { autoGenerate: false });
    const { telegramBridge, sent } = bridge();
    const res = await notify(createApp({ db, telegramBridge } as any), taskId, { status: 'MANUAL_DESIGN_REQUIRED', notifyRequester: false });
    expect(await res.json()).toMatchObject({ notificationSent: false, notificationError: 'REQUESTER_TOLD_AT_INTAKE' });
    expect(sent).toHaveLength(0);
    expect((await taskRow(taskId)).state).toBe('failed_operator');
  });

  it('captions the draft image with the task id and how to ask for a change', async () => {
    const taskId = await telegramTask(channel());
    const opId = randomUUID();
    const png = Buffer.from('PNG_OUTCOME_TEST_BYTES_PADDED_TO_THE_32_BYTE_MINIMUM');
    await withRlsContext(db, scope, async (trx) => {
      await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata, created_at, updated_at)
        VALUES (${opId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaaeClientId}::uuid, ${operatorUserId}, ${'req_' + randomUUID().slice(0, 8)}, 'hash_req', 'export', 'retrieved', 'DAGphoto0001', 1,
          ${JSON.stringify({ format: 'png' })}::jsonb, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, created_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaaeClientId}::uuid, ${opId}::uuid, 'png',
          ${createHash('sha256').update(png).digest('hex')}, ${png}, now())`.execute(trx);
    });
    const { telegramBridge, photos } = bridge();
    await notify(createApp({ db, telegramBridge } as any), taskId, { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAGphoto0001' });
    expect(photos).toHaveLength(1);
    // The webhook binds a reply to the task whose id is in the replied-to caption.
    expect(photos[0].caption).toContain(taskId);
    expect(photos[0].caption).toContain('Reply to this image with any change you want.');
  });

  describe('/redo and the Desk re-drive', () => {
    const redrive = (app: any, taskId: string) =>
      app.request(`/v1/tasks/${taskId}/redrive`, { method: 'POST', headers, body: '{}' });
    const dispatches = async (taskId: string) =>
      withRlsContext(db, scope, async (trx) =>
        (await sql<any>`SELECT * FROM hawa.outbox_commands WHERE tenant_id = ${tenantId}::uuid AND aggregate_id = ${taskId}::uuid AND command_type = 'task.dispatch' ORDER BY created_at`.execute(trx)).rows);

    it('re-drives a v3 chat task through the studio worker path, never the single-shot planner', async () => {
      const chat = channel();
      vi.stubEnv('DESIGN_PIPELINE_V3_CHATS', chat);
      const taskId = await telegramTask(chat);
      const { telegramBridge, sent } = bridge();
      const app = createApp({ db, telegramBridge } as any);

      const res = await redrive(app, taskId);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, status: 'STUDIO_RUN_QUEUED', redriveAttempt: 1 });
      const [cmd] = await dispatches(taskId);
      expect(cmd.idempotency_key).toBe(`redrive:${taskId}:1`);
      expect(cmd.payload).toMatchObject({ workflow: 'canva', autoGenerate: true, designStudio: true, redriveAttempt: 1, clientId: kaaeClientId });
      const plans = await withRlsContext(db, scope, async (trx) =>
        (await sql<any>`SELECT id FROM hawa.canva_design_plans WHERE task_id = ${taskId}::uuid`.execute(trx)).rows);
      expect(plans).toHaveLength(0);
      expect(sent.at(-1)!.message.text).toContain('A new automatic design has been started');

      // A second request while the first is still queued starts nothing new.
      expect(await (await redrive(app, taskId)).json()).toMatchObject({ status: 'STUDIO_RUN_IN_PROGRESS' });
      expect(await dispatches(taskId)).toHaveLength(1);
    });

    it('says honestly that a design already exists instead of announcing it as a new draft', async () => {
      const chat = channel();
      vi.stubEnv('DESIGN_PIPELINE_V3_CHATS', chat);
      const taskId = await telegramTask(chat);
      const designId = `DAGbound${randomUUID().slice(0, 6)}`;
      await withRlsContext(db, scope, async (trx) => {
        await sql`INSERT INTO hawa.canva_bindings (id, tenant_id, task_id, client_id, canva_design_id, edit_url, status, version, created_at, updated_at)
          VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaaeClientId}::uuid, ${designId},
            ${`https://www.canva.com/design/${designId}/edit`}, 'bound', 1, now(), now())`.execute(trx);
      });
      const { telegramBridge, sent } = bridge();
      const res = await redrive(createApp({ db, telegramBridge } as any), taskId);
      expect(await res.json()).toMatchObject({ status: 'ALREADY_BOUND' });
      const text = sent.at(-1)!.message.text as string;
      expect(text).toContain('a design already exists');
      expect(text).toContain(`https://www.canva.com/design/${designId}/edit`);
      expect(text).not.toContain('draft is ready');
      expect(await dispatches(taskId)).toHaveLength(0);
    });
  });
});
