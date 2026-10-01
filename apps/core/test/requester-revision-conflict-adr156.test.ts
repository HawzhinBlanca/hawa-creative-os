import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { ROUTING_MESSAGES } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

/**
 * ADR-156 (audit P2): a requester's change planned as a round on a design that moved on before the
 * round started (409 STALE_REVISION from the projection) is never left without an answer. Intake reads
 * the chat again and plans the words once more; a second miss passes the words to the office, and the
 * requester is told so. The projection is made to conflict here; everything else is real.
 */
const conflict = vi.hoisted(() => ({ times: 0, before: null as null | (() => Promise<void>) }));
vi.mock('../src/services/lifecycle-projection.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/services/lifecycle-projection.js')>();
  return { ...real, projectLifecycleRequesterRevisionWithIntake: async (...args: unknown[]) => {
    if (conflict.times > 0) {
      conflict.times--;
      if (conflict.before) await conflict.before();
      throw new real.LifecycleProjectionConflict('STALE_REVISION', 'The request moved on');
    }
    return (real.projectLifecycleRequesterRevisionWithIntake as (...a: unknown[]) => unknown)(...args);
  } };
});

const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const OFFICE = 91000041;
const REQUESTER = 91000142;
const WORKER = ['worker', 'conflict', 'adr156', 'token'].join('_');
const worker = { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` };
const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => { vi.unstubAllEnvs(); conflict.times = 0; conflict.before = null; });
afterAll(async () => { process.env = saved; await db.destroy(); });

const chatId = () => 64_000_000 + Math.floor(Math.random() * 9_000_000);
const updateId = () => 1_100_000_000 + Math.floor(Math.random() * 800_000_000);
const text = (chat: number, words: string) => {
  const id = updateId();
  return { update_id: id, message: { message_id: id % 1_000_000, date: 1790000000, text: words,
    from: { id: REQUESTER, is_bot: false, first_name: 'Requester' }, chat: { id: chat, type: 'private' } } };
};
const app = () => { vi.stubEnv('HAWA_WORKER_TOKEN', WORKER); return createApp({ db, requesterIntentModel: null } as any); };
const intake = async (a: any, update: unknown) => (await (await a.request('/v1/internal/telegram/intake', { method: 'POST', headers: worker,
  body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true }) })).json()) as Record<string, any>;

async function waitingRequest(chat: number, title: string) {
  const requestId = randomUUID();
  const brief = { update_id: updateId(), message: { message_id: 700, from: { id: REQUESTER, is_bot: false, first_name: 'Requester' },
    chat: { id: chat, type: 'private' }, date: 1790000000, text: title } };
  const created = await persistChatIntake(db, { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: String(chat),
    rawJson: brief, rawText: title, title, clientId, designInstructions: 'Make the event design', exactCopy: [{ text: 'December 4, 2026' }],
    autoGenerate: true, designStudio: true, variant: { width: 1200, height: 1697 } }, { outboxState: 'recorded' });
  const taskId = String(created.task.id);
  await withRlsContext(db, scope, async (trx) => {
    await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, parent_request_id, owner, stage, rev, chat_id)
      VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid, null, 'restate', 'manual', 3, ${String(chat)})`.execute(trx);
    await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx);
  });
  return { requestId, taskId };
}

describe('a round that could not start still gets an answer (audit P2)', () => {
  it('the design moved on to be made again: the change is kept on it for the office, and the requester is told', async () => {
    const chat = chatId();
    const waiting = await waitingRequest(chat, 'Nawroz poster');
    conflict.times = 1;
    // The office started a round meanwhile: the request is being designed at a newer revision.
    conflict.before = async () => { await withRlsContext(db, scope, (trx) => sql`UPDATE hawa.requests SET stage = 'designing', rev = 4
      WHERE request_id = ${waiting.requestId}::uuid`.execute(trx)); };
    const answer = await intake(app(), text(chat, 'make the title bigger'));
    expect(answer).toMatchObject({ intakeStatus: 409, lifecycleAction: 'late-change', requestId: waiting.requestId, requestStage: 'designing',
      chatAnswer: { text: ROUTING_MESSAGES.changeAddedWhileDesigning.en.replace('{title}', '<b>Nawroz poster</b>') } });
  });

  it('when the second reading misses too, the words go to the office and the requester hears that', async () => {
    const chat = chatId();
    await waitingRequest(chat, 'Graduation flyer');
    conflict.times = 2;
    const answer = await intake(app(), text(chat, 'make the title bigger'));
    expect(answer).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer',
      chatAnswer: { text: ROUTING_MESSAGES.forwardedToOffice.en },
      officeAlert: { chatId: String(OFFICE), text: expect.stringContaining('make the title bigger') } });
    // ADR-231: the requester by name, in plainer words.
    expect(answer.officeAlert.text).toMatch(/changed while the words were being read/);
  });
});
