import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, IngressRepository, TaskRepository, withRlsContext } from '@hawa/db';
import { PostgresIngressPersistenceAdapter } from '../src/ingress-persistence-adapter.js';
import { UnifiedIngressService } from '@hawa/integrations';
import { createHash } from 'node:crypto';

describe('CV-06: Unified Ingress PostgreSQL Production Integration Tests', () => {
  const connectionString =
    process.env.TEST_DATABASE_URL!;
  const db = createDb(connectionString);
  const tenantId = '00000000-0000-4000-a000-000000000007';
  const userId = '00000000-0000-4000-b000-000000000007';

  const ingressRepo = new IngressRepository(db);
  const taskRepo = new TaskRepository(db);
  const persistence = new PostgresIngressPersistenceAdapter(db, ingressRepo, taskRepo);
  const service = new UnifiedIngressService(persistence);
  const app = createApp({ db });

  const testBearer = process.env.HAWA_BEARER_TOKEN!;
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${testBearer}`,
  };

  const runId = Date.now();

  it('1. Commits inbox_events, message_events, and message_attachments durably to PostgreSQL', async () => {
    const assetBuf = Buffer.from(`Official Vector Stamp PNG ${runId}`);
    const sha256 = createHash('sha256').update(assetBuf).digest('hex');
    const sourceEventId = `evt_pg_1_${runId}`;
    const sourceMessageId = `msg_pg_1_${runId}`;

    const result = await service.ingest({
      tenantId,
      channel: 'telegram',
      sourceAccountId: 'office_main_bot',
      sourceEventId,
      sourceChannelId: 'tg_chat_111',
      sourceMessageId,
      senderExternalId: 'tg_sender_111',
      senderDisplayName: 'Office Designer',
      text: '/task Annual Kurdistan Academic Exhibition',
      rawPayload: { update_id: runId, message: { text: '/task Annual Kurdistan Academic Exhibition' } },
      verified: true,
      attachments: [
        {
          filename: 'stamp.png',
          mimeType: 'image/png',
          byteSize: assetBuf.length,
          content: assetBuf,
          sha256,
        },
      ],
    });

    expect(result.acknowledged).toBe(true);
    expect(result.actionTaken).toBe('task_created');
    expect(result.taskId).toBeDefined();

    // Verify durable storage in PostgreSQL via RLS query
    const { inboxRows, messageRows, attachmentRows, taskRows, outboxRows } = await withRlsContext(
      db,
      { tenantId, userId, role: 'administrator' },
      async (trx) => {
        const inbox = await trx
          .selectFrom('inbox_events')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('source_event_id', '=', sourceEventId)
          .execute();
        const msg = await trx
          .selectFrom('message_events')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('external_message_id', '=', sourceMessageId)
          .execute();
        const att = await trx
          .selectFrom('message_attachments')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('sha256', '=', sha256)
          .execute();
        const tsk = await trx
          .selectFrom('tasks')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('id', '=', result.taskId!)
          .execute();
        const out = await trx
          .selectFrom('outbox_commands')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('aggregate_id', '=', result.taskId!)
          .execute();
        return { inboxRows: inbox, messageRows: msg, attachmentRows: att, taskRows: tsk, outboxRows: out };
      }
    );

    expect(inboxRows.length).toBe(1);
    expect(inboxRows[0].source_event_id).toBe(sourceEventId);
    expect(inboxRows[0].verified).toBe(true);

    expect(messageRows.length).toBe(1);
    expect(messageRows[0].external_message_id).toBe(sourceMessageId);
    expect(messageRows[0].direction).toBe('ltr');

    expect(attachmentRows.length).toBe(1);
    expect(attachmentRows[0].sha256).toBe(sha256);
    expect(attachmentRows[0].filename).toBe('stamp.png');
    expect(attachmentRows[0].scan_state).toBe('clean');

    expect(taskRows.length).toBe(1);
    expect(taskRows[0].id).toBe(result.taskId);
    expect(taskRows[0].source_message_id).toBe(messageRows[0].id);

    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0].aggregate_id).toBe(result.taskId);
  });

  it('2. Enforces conversational gate: ordinary chat records message_events but creates ZERO tasks', async () => {
    const sourceEventId = `wa_chat_2_${runId}`;
    const sourceMessageId = `wa_msg_2_${runId}`;

    const result = await service.ingest({
      tenantId,
      channel: 'waha',
      sourceAccountId: 'waha_office_session',
      sourceEventId,
      sourceChannelId: '9647501234567@c.us',
      sourceMessageId,
      senderExternalId: '9647501234567@c.us',
      senderDisplayName: 'Friendly Client',
      text: 'سڵاو کاکە گیان بەیانیتان باش، هیوای ڕۆژێکی خۆش',
      rawPayload: { body: 'سڵاو کاکە گیان بەیانیتان باش، هیوای ڕۆژێکی خۆش' },
      verified: true,
    });

    expect(result.acknowledged).toBe(true);
    expect(result.actionTaken).toBe('message_only');
    expect(result.taskId).toBeUndefined();

    // Verify DB: message_event exists, but zero tasks created
    const { messageRows, taskRows } = await withRlsContext(
      db,
      { tenantId, userId, role: 'administrator' },
      async (trx) => {
        const msg = await trx
          .selectFrom('message_events')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('external_message_id', '=', sourceMessageId)
          .execute();
        const tsk = await trx
          .selectFrom('tasks')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('source_message_id', '=', msg[0]?.id || '00000000-0000-0000-0000-000000000000')
          .execute();
        return { messageRows: msg, taskRows: tsk };
      }
    );

    expect(messageRows.length).toBe(1);
    expect(messageRows[0].direction).toBe('rtl');
    expect(taskRows.length).toBe(0);
  });

  it('3. Replays duplicate event idempotently without duplicating tasks or rows', async () => {
    const sourceEventId = `desk_replay_evt_${runId}`;
    const sourceMessageId = `desk_replay_msg_${runId}`;

    const payload = {
      tenantId,
      channel: 'hawa_desk' as const,
      sourceAccountId: 'desk_admin',
      sourceEventId,
      sourceChannelId: 'desk_channel',
      sourceMessageId,
      senderExternalId: 'admin_user',
      text: '/task KAAE Accreditation Guidelines 2026',
      rawPayload: { title: 'KAAE Guidelines' },
      verified: true,
      isTaskSubmission: true,
    };

    const res1 = await service.ingest(payload);
    expect(res1.isDuplicate).toBe(false);
    expect(res1.actionTaken).toBe('task_created');

    const res2 = await service.ingest(payload);
    expect(res2.isDuplicate).toBe(true);
    expect(res2.actionTaken).toBe('duplicate_acknowledged');
    expect(res2.taskId).toBe(res1.taskId);

    const taskCount = await withRlsContext(
      db,
      { tenantId, userId, role: 'administrator' },
      async (trx) => {
        const rows = await trx
          .selectFrom('tasks')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('id', '=', res1.taskId!)
          .execute();
        return rows.length;
      }
    );

    expect(taskCount).toBe(1);
  });

  it('4. Refuses to alter approved brief on source message edit, logging revision request', async () => {
    const sourceMessageId = `tg_msg_stable_${runId}`;

    // 1. Initial message creates task
    const res1 = await service.ingest({
      tenantId,
      channel: 'telegram',
      sourceAccountId: 'office_main_bot',
      sourceEventId: `brief_evt_v1_${runId}`,
      sourceChannelId: 'tg_channel_test',
      sourceMessageId,
      sourceRevisionId: 'rev_1',
      senderExternalId: 'client_vp',
      text: '/task KAAE Ministry Launch Campaign',
      rawPayload: { text: '/task KAAE Ministry Launch Campaign' },
      verified: true,
    });

    const taskId = res1.taskId!;

    // 2. Transition task to approved state directly
    await withRlsContext(
      db,
      { tenantId, userId, role: 'administrator' },
      async (trx) => {
        await trx
          .updateTable('tasks')
          .set({ state: 'approved' })
          .where('id', '=', taskId)
          .execute();
      }
    );

    // 3. Edit source message on Telegram after approval
    const res2 = await service.ingest({
      tenantId,
      channel: 'telegram',
      sourceAccountId: 'office_main_bot',
      sourceEventId: `brief_evt_v2_${runId}`,
      sourceChannelId: 'tg_channel_test',
      sourceMessageId,
      sourceRevisionId: 'rev_2_post_approval',
      senderExternalId: 'client_vp',
      text: 'KAAE Ministry Launch Campaign - Changed date to October 25',
      rawPayload: { text: 'KAAE Ministry Launch Campaign - Changed date to October 25', edited: true },
      verified: true,
    });

    expect(res2.acknowledged).toBe(true);
    expect(res2.actionTaken).toBe('revision_requested');
    expect(res2.taskId).toBe(taskId);

    // Verify in PostgreSQL: task is flagged for revision and state transition is durably stored in task_events
    const { taskEvents, task } = await withRlsContext(
      db,
      { tenantId, userId, role: 'administrator' },
      async (trx) => {
        const events = await trx.selectFrom('task_events').selectAll().where('task_id', '=', taskId).execute();
        const t = await trx.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirstOrThrow();
        return { taskEvents: events, task: t };
      }
    );

    expect(task.state).toBe('revision_requested');
    const revEvent = taskEvents.find((e) => e.event_type === 'task.state_changed' && (e.data as any)?.toState === 'revision_requested');
    expect(revEvent).toBeDefined();
    expect((revEvent?.data as any)?.reason).toContain('Source message edited at source after brief approval');
  });

  it('5. Tests /api/ingress/unified endpoint via HTTP request', async () => {
    // Unified ingress is an authenticated boundary: an anonymous caller may not declare verified messages.
    const anonymous = await app.request('/api/ingress/unified', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'telegram', text: 'x' }) });
    expect(anonymous.status).toBe(401);
    const res = await app.request('/api/ingress/unified', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testBearer}`,
      },
      body: JSON.stringify({
        tenantId,
        channel: 'telegram',
        sourceAccountId: 'office_main_bot',
        sourceEventId: `http_evt_${runId}`,
        sourceChannelId: `http_chat_${runId}`,
        sourceMessageId: `http_msg_${runId}`,
        senderExternalId: 'http_sender',
        text: '/task Webhook API Ingress Test Campaign',
        rawPayload: { update_id: runId },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.acknowledged).toBe(true);
    expect(body.actionTaken).toBe('task_created');
    expect(body.taskId).toBeDefined();
    expect(body.normalizedEnvelope.adapter.kind).toBe('telegram');
  });

  it('6. Tests /api/ingress/promote endpoint for explicit promotion of MESSAGE_ONLY', async () => {
    // 1. Ingest as MESSAGE_ONLY
    const ingRes = await service.ingest({
      tenantId,
      channel: 'waha',
      sourceAccountId: 'waha_office_session',
      sourceEventId: `promote_evt_wa_${runId}`,
      sourceChannelId: 'wa_chat_promote',
      sourceMessageId: `wa_msg_promote_${runId}`,
      senderExternalId: 'wa_client',
      text: 'We had a great team lunch today, see you on Monday',
      rawPayload: { body: 'lunch' },
      verified: true,
    });

    expect(ingRes.actionTaken).toBe('message_only');
    const messageEventId = ingRes.messageEventId;

    // 2. Explicitly promote. Tenant 007 is not the operator credential's tenant: only an administrator
    // may name another tenant and user (hunt-3).
    const promoteRes = await app.request('/api/ingress/promote', {
      method: 'POST',
      headers: { ...authHeaders, Authorization: `Bearer ${process.env.HAWA_ADMIN_KEY}` },
      body: JSON.stringify({
        tenantId,
        userId,
        messageEventId,
        title: 'Promoted Event Flyer Campaign',
        description: 'Design flyer for client based on WhatsApp discussion',
        priority: 4,
      }),
    });

    expect(promoteRes.status).toBe(201);
    const promoteBody = await promoteRes.json();
    expect(promoteBody.ok).toBe(true);
    expect(promoteBody.promoted).toBe(true);
    expect(promoteBody.task.id).toBeDefined();
    expect(promoteBody.task.source_message_id).toBe(messageEventId);
  });
});
