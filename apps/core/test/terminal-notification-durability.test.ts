import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

// The Canva link is the only thing the owner receives for a design run that was already paid for,
// and the worker's finish() deliberately swallows notification errors so a failed message cannot
// fail the design (apps/worker/src/canva-draft-workflow.ts catches). Core's send was a single
// fire-and-forget attempt, so a Telegram rate limit, a 5xx or a restart at the wrong moment dropped
// the link with no record anywhere. Every terminal notification is now written to the outbox first.
describe('a terminal design notification survives a failed send', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}`,
  };
  afterAll(() => db.destroy());

  /** A task that came in from Telegram, so the status route has a chat to answer. */
  const telegramTask = async (channel: string) =>
    (
      await persistChatIntake(db, {
        platform: 'telegram',
        sourceEventId: randomUUID(),
        sourceChannelId: channel,
        clientId: null,
        title: 'KAAE: Standards launch',
        rawText: 'Launch announcement\n---\nStandards Framework 2.0',
        designInstructions: '',
        exactCopy: [],
        designStudio: false,
      })
    ).task.id as string;

  const notifyCommands = async (taskId: string) =>
    withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) =>
      (
        await sql<any>`SELECT * FROM hawa.outbox_commands
          WHERE tenant_id = ${tenantId}::uuid AND aggregate_id = ${taskId}::uuid
            AND command_type = 'notify.telegram'
          ORDER BY created_at`.execute(trx)
      ).rows
    );

  const appWith = (dispatch: any) =>
    createApp({
      db,
      telegramBridge: { dispatchOutboundMessage: dispatch, dispatchOutboundPhoto: vi.fn() } as any,
    });

  const notify = (app: any, taskId: string, body: Record<string, unknown>) =>
    app.request(`/v1/tasks/${taskId}/notifications/canva-status`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

  it('enqueues the message once, keyed by task, status and run, and marks it delivered when it goes out', async () => {
    const channel = `notify-${randomUUID().slice(0, 8)}`;
    const taskId = await telegramTask(channel);
    const designId = 'DAGtestdraft01';
    const dispatch = vi.fn().mockResolvedValue({ success: true, messageId: '42' });
    const app = appWith(dispatch);

    const first = await notify(app, taskId, {
      status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW',
      designId,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ notificationSent: true });

    const rows = await notifyCommands(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotency_key).toBe(
      `notify.telegram:${taskId}:CANVA_DRAFT_READY_FOR_VISUAL_REVIEW:${designId}`
    );
    expect(rows[0].state).toBe('delivered');
    expect(rows[0].payload.chatId).toBe(channel);
    // The composed message is stored, not rebuilt, so a retry sends exactly what was attempted. Since
    // ADR-145 the requester is told in plain words that the draft is with the office; no Canva edit
    // link is sent to a requester.
    expect(rows[0].payload.message.text).toContain('is ready, and the office is giving it a final check');
    expect(rows[0].payload.message.text).not.toContain('canva.com');

    // Restate journals finish() and re-issues the same call on a workflow retry.
    const second = await notify(app, taskId, {
      status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW',
      designId,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ notificationDeduplicated: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await notifyCommands(taskId)).toHaveLength(1);
  });

  it('still reports a second, different outcome for the same task', async () => {
    const taskId = await telegramTask(`notify-${randomUUID().slice(0, 8)}`);
    const dispatch = vi.fn().mockResolvedValue({ success: true, messageId: '7' });
    const app = appWith(dispatch);

    await notify(app, taskId, { status: 'DESIGN_REJECTED', code: 'COPY_REQUIRED' });
    // A different rejection is a different message; keying on the task alone would swallow it.
    await notify(app, taskId, { status: 'DESIGN_REJECTED', code: 'CLIENT_REFERENCE_REQUIRED' });
    await notify(app, taskId, { status: 'MANUAL_DESIGN_REQUIRED' });

    const keys = (await notifyCommands(taskId)).map((cmd: any) => cmd.idempotency_key);
    expect(keys).toEqual([
      `notify.telegram:${taskId}:DESIGN_REJECTED:COPY_REQUIRED:no-run`,
      `notify.telegram:${taskId}:DESIGN_REJECTED:CLIENT_REFERENCE_REQUIRED:no-run`,
      `notify.telegram:${taskId}:MANUAL_DESIGN_REQUIRED:no-run`,
    ]);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  // A task can be run again: the outbox requeue and redrive routes do exactly that, as happened
  // after the 2026-09-17 Restate incident. The second run carries a new Canva link, so keying on
  // task and status alone would have swallowed the only message naming the design that exists.
  it('sends the second run of a task, with its own design, as its own message', async () => {
    const taskId = await telegramTask(`notify-${randomUUID().slice(0, 8)}`);
    const dispatch = vi.fn().mockResolvedValue({ success: true, messageId: '9' });
    const app = appWith(dispatch);

    for (const designId of ['DAGfirstrun01', 'DAGsecondrun2']) {
      const res = await notify(app, taskId, { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId });
      expect(await res.json()).toMatchObject({ notificationSent: true });
    }

    const rows = await notifyCommands(taskId);
    expect(rows).toHaveLength(2);
    // Each run is its own message, keyed by its own design (ADR-145: the text no longer carries the link).
    expect(rows.map((cmd: any) => cmd.idempotency_key)).toEqual(expect.arrayContaining([
      expect.stringContaining('DAGfirstrun01'), expect.stringContaining('DAGsecondrun2')]));
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('keeps a rejected send recoverable, with backoff, instead of dropping it', async () => {
    const taskId = await telegramTask(`notify-${randomUUID().slice(0, 8)}`);
    const app = appWith(vi.fn().mockResolvedValue({ success: false, error: 'TELEGRAM_REJECTED_429' }));

    const res = await notify(app, taskId, { status: 'MANUAL_DESIGN_REQUIRED' });
    expect(await res.json()).toMatchObject({
      notificationSent: false,
      notificationError: 'TELEGRAM_REJECTED_429',
    });

    const rows = await notifyCommands(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('pending');
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].last_error).toContain('TELEGRAM_REJECTED_429');
    expect(new Date(rows[0].available_at).getTime()).toBeGreaterThan(Date.now());
    // ADR-145 wording: a designer makes it (it was "queued for manual design").
    expect(rows[0].payload.message.text).toContain('A designer will make');
  });

  it('leaves a lost receipt for an operator instead of resending it', async () => {
    const taskId = await telegramTask(`notify-${randomUUID().slice(0, 8)}`);
    const app = appWith(
      vi.fn().mockResolvedValue({ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' })
    );

    await notify(app, taskId, { status: 'DESIGN_UNCERTAIN' });

    const rows = await notifyCommands(taskId);
    expect(rows).toHaveLength(1);
    // A lost response can follow a successful send, so the bridge refuses to resend it and the
    // command goes straight to the dead-letter list a person reads.
    expect(rows[0].state).toBe('failed');
    expect(rows[0].last_error).toContain('DELIVERY_UNCERTAIN');
    const failed = await (await app.request('/v1/outbox/failed', { headers })).json();
    expect(failed.commands.map((cmd: any) => cmd.id)).toContain(rows[0].id);
  });
});
