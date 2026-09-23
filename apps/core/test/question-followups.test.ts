import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

/**
 * What happens around a question asked before a change (edit stage, NEEDS_CLARIFICATION), as the
 * 2026-09-24 review found it: a reply after the answer revised the question's task, which has no
 * design, and started a new paid design; a picture sent as the answer was dropped; the album that came
 * with the change was lost; an old question could still be answered after a newer change; a re-driven
 * task's question had dead buttons; a failed answer was reported saved.
 */
const url = process.env.HAWA_ISOLATED_TEST_DB;
const PNG_A = 'data:image/png;base64,' + Buffer.from('photo-A-bytes').toString('base64');
const PNG_B = 'data:image/png;base64,' + Buffer.from('photo-B-bytes').toString('base64');
// A real PNG header so sniffImageMime says image/png.
const PNG_BUF = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('new-photo-in-reply')]);

describe.skipIf(!url)('around a question asked before a change (webhook, PostgreSQL)', () => {
  const db = createDb(url!);
  const operator = { tenantId: '00000000-0000-4000-a000-000000000001', userId: '00000000-0000-4000-b000-000000000001', role: 'operator' } as const;
  const secret = ['question', 'followups', 'fixture'].join('_');
  const OFFICE = 91000006;
  const saved = { ...process.env };
  beforeAll(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = secret;
    process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
    process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
    process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER = '1000';
    delete process.env.OPENAI_API_KEY;
  });
  afterAll(async () => {
    process.env = saved;
    await db.destroy();
  });

  const setup = async (extraOptions: Record<string, unknown> = {}) => {
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const bridge = {
      dispatchOutboundMessage: dispatch,
      dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }),
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      downloadFile: vi.fn().mockResolvedValue(PNG_BUF),
      handleCommand: vi.fn().mockReturnValue(null),
      formatTaskPreviewCard: vi.fn().mockReturnValue({}),
    };
    const app = createApp({ db, telegramBridge: bridge as any } as any);
    const chat = 70000000 + Math.floor(Math.random() * 9000000);
    const post = async (body: unknown) => {
      const res = await app.request('/api/webhooks/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
    };
    const request = async (text: string) => {
      const res = await post({ update_id: randomUUID(), message: { message_id: 1, from: { id: OFFICE, is_bot: false, first_name: 'Owner' }, chat: { id: chat, type: 'private' }, text } });
      expect(res.status).toBe(201);
      return String(res.body.task?.id || res.body.taskId);
    };
    const parent = await request('KAAE members evening\n---\nDecember 4, 2026\nErbil');
    const parentRow = await withRlsContext(db, operator, async (trx) =>
      (await sql<{ client: string | null; payload: any }>`SELECT t.client_id::text AS client, o.payload FROM hawa.tasks t JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created' WHERE t.id = ${parent}::uuid`.execute(trx)).rows[0]);
    const waitingTask = await persistChatIntake(db, {
      platform: 'telegram', sourceEventId: `${randomUUID()}_rev_${parent}`, sourceChannelId: String(chat),
      rawText: parentRow.payload.rawRequestText, clientId: parentRow.client, title: 'KAAE members evening (Revision)',
      headlineEn: parentRow.payload.headlineEn || undefined, copyEn: parentRow.payload.copyEn || undefined,
      designInstructions: `${parentRow.payload.designInstructions || ''}\nOperator Revision Directive: less empty space`, exactCopy: parentRow.payload.exactCopy || [],
      autoGenerate: true, variant: { width: 1080, height: 1350 },
      studioOptions: { parentTaskId: parent, revisionRound: 1, revisionDirective: 'less empty space', ...extraOptions } as any,
    });
    const waiting = waitingTask.task.id as string;
    await withRlsContext(db, operator, async (trx) => {
      await sql`UPDATE hawa.tasks SET state = 'paused' WHERE id = ${waiting}::uuid`.execute(trx);
      const stages = { directed: { refused: 'NEEDS_CLARIFICATION', asks: [{ ask: 'less empty space', status: 'asked' }], clarify: { ask: 'less empty space', question: 'Fill the space with what?', options: ['bigger title text', 'bigger logo'] } } };
      await sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status, stages)
        SELECT ${randomUUID()}::uuid, t.tenant_id, t.id, t.client_id, 'test', ${randomUUID()}, 'h', '{}'::jsonb, 'standard', 'failed', ${JSON.stringify(stages)}::jsonb
        FROM hawa.tasks t WHERE t.id = ${waiting}::uuid`.execute(trx);
    });
    const press = (data: string, inChat = chat) =>
      post({ update_id: randomUUID(), callback_query: { id: randomUUID(), from: { id: OFFICE, is_bot: false }, message: { message_id: 5, chat: { id: inChat, type: 'private' } }, data } });
    const childrenOf = async (id: string) =>
      (await withRlsContext(db, operator, async (trx) =>
        (await sql<{ id: string; options: any; state: string }>`SELECT t.id::text AS id, o.payload->'studioOptions' AS options, t.state::text AS state FROM hawa.tasks t
          JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
          WHERE o.payload->'studioOptions'->>'parentTaskId' = ${id} ORDER BY t.created_at`.execute(trx)).rows));
    const replyToQuestion = (msg: Record<string, unknown>) =>
      post({
        update_id: randomUUID(),
        message: {
          message_id: 9, from: { id: OFFICE, is_bot: false, first_name: 'Owner' }, chat: { id: chat, type: 'private' },
          reply_to_message: { message_id: 8, from: { id: 1, is_bot: true }, chat: { id: chat, type: 'private' }, text: `One question before I make your change\n\nTask ID: ${waiting}` },
          ...msg,
        },
      });
    return { app, chat, parent, waiting, press, post, dispatch, bridge, childrenOf, replyToQuestion };
  };

  it('a reply after the question was answered goes to the answer\'s revision, never to the question\'s task', async () => {
    const { waiting, press, childrenOf, replyToQuestion } = await setup();
    const tap = await press(`rq:a2:${waiting}`);
    expect(tap.body).toMatchObject({ ok: true, requesterAction: 'a2' });
    const answered = String(tap.body.revisionTaskId);
    const reply = await replyToQuestion({ text: 'change the date colour to gold please' });
    expect(reply.status).toBeLessThan(500);
    expect(await childrenOf(waiting)).toEqual([]);
    // The answer's revision is still being made, so the reply waits for its draft; nothing new starts from the question's task.
    expect(JSON.stringify(reply.body)).toContain(answered);
  });

  it('a picture sent as the answer is the answer, and reaches the revision', async () => {
    const { parent, waiting, childrenOf, replyToQuestion } = await setup();
    const reply = await replyToQuestion({ photo: [{ file_id: 'f1', width: 100, height: 100 }] });
    const kids = (await childrenOf(parent)).filter((k) => k.id !== waiting);
    const r = kids.at(-1)!;
    expect(r.options.revisionDirective).toContain('the client answered: the attached picture');
    expect(String(r.options.referenceImageBase64 || '')).toContain(PNG_BUF.toString('base64'));
    expect(r.options.answers).toBe(waiting);
  });

  it('/status says the change is waiting for the requester\'s answer', async () => {
    const { chat, post, dispatch } = await setup();
    await post({ update_id: randomUUID(), message: { message_id: 3, from: { id: OFFICE, is_bot: false }, chat: { id: chat, type: 'private' }, text: '/status' } });
    const text = String(dispatch.mock.calls.at(-1)?.[1]?.text);
    expect(text).not.toContain('paused by the office');
    expect(text).toContain('waiting for your answer to a question');
  });

  it('an old question cannot be answered once a newer change to the design exists', async () => {
    const { parent, waiting, press, childrenOf } = await setup();
    // A newer revision of the design, made after the question (the requester replied to the draft instead).
    const newer = await persistChatIntake(db, {
      platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: String((await withRlsContext(db, operator, async (trx) => (await sql<{ c: string }>`SELECT payload->>'sourceChannelId' AS c FROM hawa.outbox_commands WHERE aggregate_id = ${parent}::uuid AND command_type='task.created'`.execute(trx)).rows[0].c))),
      rawText: 'KAAE members evening', clientId: null, title: 'newer (Revision)', designInstructions: 'x', exactCopy: [], autoGenerate: false,
      studioOptions: { parentTaskId: parent, revisionDirective: 'make the title bigger', revisionRound: 1 },
    });
    await withRlsContext(db, operator, async (trx) => sql`UPDATE hawa.tasks SET state = 'human_review' WHERE id = ${newer.task.id}::uuid`.execute(trx));
    const tap = await press(`rq:a1:${waiting}`);
    const kids = await childrenOf(parent);
    expect(tap.body).toMatchObject({ already: true });
    expect((await childrenOf(parent)).length).toBe(2);
  });

  it('the album photos that came with the change reach the answered revision', async () => {
    const { parent, waiting, press, chat } = await setup({ referenceImageBase64: PNG_A, mediaGroupId: 'album-1' });
    const clientId = (await withRlsContext(db, operator, async (trx) => (await sql<{ c: string | null }>`SELECT client_id::text AS c FROM hawa.tasks WHERE id = ${waiting}::uuid`.execute(trx)).rows[0].c));
    // The album's second photo, as the webhook saves it (findAlbumRequest -> referenceFor the waiting change).
    await persistChatIntake(db, {
      platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: String(chat), rawText: 'Apply the attached visual reference image as a design style, layout, and composition guide.',
      clientId, title: 'x (reference image)', designInstructions: 'x', exactCopy: [], isInstructionOnly: true, autoGenerate: false,
      studioOptions: { referenceFor: waiting, referenceImageBase64: PNG_B, mediaGroupId: 'album-1' },
    });
    const tap = await press(`rq:a1:${waiting}`);
    const revision = String(tap.body.revisionTaskId);
    const service = new DesignStudioService(db as any, undefined, { apiKey: 'x' });
    const scope = { tenantId: operator.tenantId, actorId: operator.userId };
    const asRun = (taskId: string, answers?: string) => ({ task_id: taskId, request: { pipelineV3: true, directed: { parentTaskId: parent, ...(answers ? { answers } : {}) } } });
    const forWaiting = await (service as any).imagesForRun(scope, asRun(waiting));
    const forRevision = await (service as any).imagesForRun(scope, asRun(revision, waiting));
    const label = (u: string) => (u === PNG_A ? 'A' : u === PNG_B ? 'B' : 'other');
    expect(forWaiting.map(label)).toContain('B');
    expect(forRevision.map(label)).toContain('B');
  });

  it('a question asked on a re-driven task pauses it, and its buttons answer it', async () => {
    const { parent, waiting, press, app, dispatch, bridge } = await setup();
    await withRlsContext(db, operator, async (trx) => sql`UPDATE hawa.tasks SET state = 'failed_operator' WHERE id = ${waiting}::uuid`.execute(trx));
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
    const res = await app.request(`/v1/tasks/${waiting}/notifications/canva-status`, { method: 'POST', headers, body: JSON.stringify({ status: 'DESIGN_FAILED', code: 'NEEDS_CLARIFICATION', runId: randomUUID() }) });
    const state = (await withRlsContext(db, operator, async (trx) => (await sql<{ s: string }>`SELECT state::text AS s FROM hawa.tasks WHERE id = ${waiting}::uuid`.execute(trx)).rows[0].s));
    const msg = dispatch.mock.calls.at(-1)?.[1];
    const tap = await press(`rq:a1:${waiting}`);
    expect(state).toBe('paused');
    expect(tap.body.revisionTaskId).toBeTruthy();
  });

  it('an answer that could not be saved says so, and nothing was made', async () => {
    const { waiting, press, dispatch, bridge, childrenOf, parent } = await setup();
    // Make the save fail: the payload names a client that does not exist (foreign key).
    await withRlsContext(db, operator, async (trx) => sql`UPDATE hawa.outbox_commands SET payload = jsonb_set(payload, '{clientId}', to_jsonb(${randomUUID()}::text))
      WHERE aggregate_id = ${waiting}::uuid AND command_type = 'task.created'`.execute(trx));
    const tap = await press(`rq:a1:${waiting}`);
    expect(bridge.answerCallbackQuery.mock.calls.at(-1)?.[1]).toBe('Your answer was not saved. Please tap it again in a minute.');
    expect((await childrenOf(parent)).length).toBe(1);
  });
});
