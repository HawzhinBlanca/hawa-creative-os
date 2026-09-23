import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

/** Bug hunt on b2bbbb8: questions, answers, sizes and rounds (webhook, PostgreSQL test DB). */
const url = process.env.HAWA_ISOLATED_TEST_DB;
const PNG_A = 'data:image/png;base64,' + Buffer.from('hunt-photo-A').toString('base64');
const PNG_B = 'data:image/png;base64,' + Buffer.from('hunt-photo-B').toString('base64');
const PNG_BUF = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('hunt-answer-picture')]);

describe.skipIf(!url)('review of 2026-09-24: around a question, sizes and rounds', () => {
  const db = createDb(url!);
  const operator = { tenantId: '00000000-0000-4000-a000-000000000001', userId: '00000000-0000-4000-b000-000000000001', role: 'operator' } as const;
  const secret = ['hunt', 'question', 'fixture'].join('_');
  const OFFICE = 91000017;
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
    const chat = 60000000 + Math.floor(Math.random() * 9000000);
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
    const child = async (of: string, options: Record<string, unknown>, title = 'KAAE members evening (Revision)') =>
      String((await persistChatIntake(db, {
        platform: 'telegram', sourceEventId: `${randomUUID()}_rev_${of}`, sourceChannelId: String(chat),
        rawText: parentRow.payload.rawRequestText, clientId: parentRow.client, title,
        headlineEn: parentRow.payload.headlineEn || undefined, copyEn: parentRow.payload.copyEn || undefined,
        designInstructions: `${parentRow.payload.designInstructions || ''}`, exactCopy: parentRow.payload.exactCopy || [],
        autoGenerate: true, variant: { width: 1080, height: 1350 },
        studioOptions: { parentTaskId: of, ...options } as any,
      })).task.id);
    const waiting = await child(parent, { revisionRound: 1, revisionDirective: 'add these photos, less empty space', ...extraOptions });
    await withRlsContext(db, operator, async (trx) => {
      await sql`UPDATE hawa.tasks SET state = 'paused' WHERE id = ${waiting}::uuid`.execute(trx);
      const stages = { directed: { refused: 'NEEDS_CLARIFICATION', asks: [{ ask: 'less empty space', status: 'asked' }], clarify: { ask: 'less empty space', question: 'Fill the space with what?', options: ['bigger title text', 'bigger logo'] } } };
      await sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status, stages)
        SELECT ${randomUUID()}::uuid, t.tenant_id, t.id, t.client_id, 'test', ${randomUUID()}, 'h', '{}'::jsonb, 'standard', 'failed', ${JSON.stringify(stages)}::jsonb
        FROM hawa.tasks t WHERE t.id = ${waiting}::uuid`.execute(trx);
    });
    const press = (data: string) =>
      post({ update_id: randomUUID(), callback_query: { id: randomUUID(), from: { id: OFFICE, is_bot: false }, message: { message_id: 5, chat: { id: chat, type: 'private' } }, data } });
    const payloadOf = async (id: string) =>
      (await withRlsContext(db, operator, async (trx) =>
        (await sql<{ payload: any }>`SELECT payload FROM hawa.outbox_commands WHERE aggregate_id = ${id}::uuid AND command_type = 'task.created'`.execute(trx)).rows[0].payload));
    const replyTo = (taskId: string, text: string) =>
      post({
        update_id: randomUUID(),
        message: {
          message_id: 9, from: { id: OFFICE, is_bot: false, first_name: 'Owner' }, chat: { id: chat, type: 'private' },
          reply_to_message: { message_id: 8, from: { id: 1, is_bot: true }, chat: { id: chat, type: 'private' }, caption: `Your draft is ready\n\nTask ID: ${taskId}` },
          text,
        },
      });
    return { app, chat, parent, waiting, press, post, dispatch, child, payloadOf, replyTo };
  };

  it('the album photos filed under the question reach the answer, but not any later change or size of it', async () => {
    const { parent, waiting, press, chat, child } = await setup({ referenceImageBase64: PNG_A, mediaGroupId: 'hunt-album' });
    const clientId = (await withRlsContext(db, operator, async (trx) => (await sql<{ c: string | null }>`SELECT client_id::text AS c FROM hawa.tasks WHERE id = ${waiting}::uuid`.execute(trx)).rows[0].c));
    await persistChatIntake(db, {
      platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: String(chat), rawText: 'Apply the attached visual reference image as a design style, layout, and composition guide.',
      clientId, title: 'x (reference image)', designInstructions: 'x', exactCopy: [], isInstructionOnly: true, autoGenerate: false,
      studioOptions: { referenceFor: waiting, referenceImageBase64: PNG_B, mediaGroupId: 'hunt-album' },
    });
    const tap = await press(`rq:a1:${waiting}`);
    const answer = String(tap.body.revisionTaskId);
    const answerPayload = (await withRlsContext(db, operator, async (trx) => (await sql<{ p: any }>`SELECT payload AS p FROM hawa.outbox_commands WHERE aggregate_id = ${answer}::uuid AND command_type = 'task.created'`.execute(trx)).rows[0].p));
    // A later change of the answer's design, and its story size, as the webhook and makeOtherSize save them.
    const later = await child(answer, { revisionRound: 2, revisionDirective: 'make the title gold' });
    const story = await child(answer, { revisionDirective: 'The same design as a story (1080x1920).', reformat: 'story' }, 'KAAE members evening (story)');
    const service = new DesignStudioService(db as any, undefined, { apiKey: 'x' });
    const scope = { tenantId: operator.tenantId, actorId: operator.userId };
    const asRun = (taskId: string, of: string, answers?: string) => ({ task_id: taskId, request: { pipelineV3: true, directed: { parentTaskId: of, ...(answers ? { answers } : {}) } } });
    const label = (u: string) => (u === PNG_A ? 'A' : u === PNG_B ? 'B' : 'other');
    const forAnswer = (await (service as any).imagesForRun(scope, asRun(answer, parent, answerPayload.studioOptions.answers))).map(label);
    const forLater = (await (service as any).imagesForRun(scope, asRun(later, answer))).map(label);
    const forStory = (await (service as any).imagesForRun(scope, asRun(story, answer))).map(label);
    expect(forAnswer).toEqual(expect.arrayContaining(['A', 'B']));
    expect(forLater).toEqual(expect.arrayContaining(['A', 'B']));
    expect(forStory).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('a size of a third-round change resets the round count: the next change is round 1 and the office is not alerted', async () => {
    const { parent, press, child, payloadOf, replyTo, dispatch, chat } = await setup();
    process.env.DESIGN_PIPELINE_V3_CHATS = String(chat);
    const c1 = await child(parent, { revisionRound: 1, revisionDirective: 'make the date gold' });
    const c2 = await child(c1, { revisionRound: 2, revisionDirective: 'make the title bigger' });
    const c3 = await child(c2, { revisionRound: 3, revisionDirective: 'move the logo to the top' });
    await withRlsContext(db, operator, async (trx) => sql`UPDATE hawa.tasks SET state = 'human_review' WHERE id = ${c3}::uuid`.execute(trx));
    await press(`rq:ok:${c3}`);
    const size = await press(`rq:sst:${c3}`);
    const story = String(size.body.sizeTaskId);
    const reply = await replyTo(story, 'make the date white');
    const revision = String(reply.body.revisionTaskId);
    expect((await payloadOf(revision)).studioOptions.revisionRound).toBe(4);
  });

  it('/status still says a superseded question waits for an answer, while its buttons say it was answered', async () => {
    const { parent, waiting, press, post, dispatch, chat, child } = await setup();
    const newer = await child(parent, { revisionRound: 1, revisionDirective: 'make the title bigger' });
    await withRlsContext(db, operator, async (trx) => sql`UPDATE hawa.tasks SET state = 'human_review' WHERE id = ${newer}::uuid`.execute(trx));
    const tap = await press(`rq:a1:${waiting}`);
    expect(tap.body).toMatchObject({ already: true });
    await post({ update_id: randomUUID(), message: { message_id: 3, from: { id: OFFICE, is_bot: false }, chat: { id: chat, type: 'private' }, text: '/status' } });
    const text = String(dispatch.mock.calls.at(-1)?.[1]?.text);
    const line = text.split('\n\n')[0];
    expect(text).not.toContain('waiting for your answer to a question');
  });

  it('a size button from an earlier message still makes a size task in a chat not on the v3 pipeline', async () => {
    const { parent, press } = await setup();
    process.env.DESIGN_PIPELINE_V3_CHATS = '1';
    delete process.env.DESIGN_PIPELINE_V3;
    const size = await press(`rq:sst:${parent}`);
    expect(size.body.sizeTaskId).toBeUndefined();
  });
});
