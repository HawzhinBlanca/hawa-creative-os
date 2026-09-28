import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDb, OutboxRepository } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

/**
 * N4, Core's half of the canva-status contract (architecture programme 1.3, SPLIT_PLAN.md section 5).
 * The worker's half is apps/worker/test/canva-status-contract.test.ts. The handler is about to move
 * out of app.ts (SPLIT_PLAN G4); whatever file it lands in must take the bodies the worker records
 * and give the answers the worker is written for, all read from one shared file.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(fs.readFileSync(path.join(here, '../../../packages/testkit/fixtures/canva-status-contract.json'), 'utf8')) as {
  fields: string[];
  requests: Record<string, Record<string, unknown>>;
  answers: Record<string, { status: number; title?: string; body?: Record<string, unknown>; keys?: string[] }>;
};

describe('Core answers the worker\'s canva-status reports as recorded', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
  afterAll(() => db.destroy());
  afterEach(() => vi.restoreAllMocks());

  const telegramTask = async (studioOptions?: Record<string, unknown>, sourceChannelId?: string) =>
    (
      await persistChatIntake(db, {
        platform: 'telegram',
        sourceEventId: randomUUID(),
        sourceChannelId: sourceChannelId || String(9_000_000_000 + Math.floor(Math.random() * 999_999_999)),
        clientId: 'c1000000-0000-4000-8000-000000000002',
        title: 'KAAE: contract',
        rawText: 'Launch announcement\n---\nStandards Framework 2.0',
        designInstructions: '',
        exactCopy: [{ id: 'copy_0', role: 'headline', text: 'Standards Framework 2.0' }],
        autoGenerate: true,
        ...(studioOptions ? { studioOptions } : {}),
      } as any)
    ).task.id as string;
  const core = () => createApp({
    db,
    telegramBridge: {
      dispatchOutboundMessage: vi.fn(async () => ({ success: true, messageId: '1' })),
      dispatchOutboundPhoto: vi.fn(async () => ({ success: true })),
    },
  } as any);
  const report = (app: ReturnType<typeof createApp>, taskId: string, body: Record<string, unknown>, h: Record<string, string> = headers) =>
    app.request(`/v1/tasks/${taskId}/notifications/canva-status`, { method: 'POST', headers: h, body: JSON.stringify(body) });

  /** The answer, checked against the recorded one: its status, and its title or its body. */
  const expectAnswer = async (res: Response, name: string) => {
    const recorded = contract.answers[name];
    const body = await res.json();
    expect(res.status, name).toBe(recorded.status);
    if (recorded.title) expect(body.title, name).toBe(recorded.title);
    if (recorded.body) expect(body, name).toMatchObject(recorded.body);
    if (recorded.keys) expect(Object.keys(body).filter((k) => !recorded.keys!.includes(k)), name).toEqual([]);
    return body;
  };

  it.each(Object.keys(contract.requests))('records the worker\'s %s report', async (name) => {
    const body = contract.requests[name];
    const taskId = await telegramTask();
    const answer = await expectAnswer(await report(core(), taskId, body), 'recorded');
    expect(answer).toMatchObject({ taskId, status: body.status });
    // The requester hears once, unless the worker says intake already told them.
    expect(answer.notificationSent).toBe(body.notifyRequester !== false);
  });

  it('refuses a caller without a credential', async () => {
    await expectAnswer(await report(core(), randomUUID(), contract.requests.draftReady, { 'Content-Type': 'application/json' }), 'unauthenticated');
  });

  it('refuses without a database, where the notification could not be written down', async () => {
    await expectAnswer(await report(createApp(), randomUUID(), contract.requests.draftReady), 'noDatabase');
  });

  it('refuses a task id that is not one', async () => {
    await expectAnswer(await report(core(), 'not-a-task', contract.requests.draftReady), 'invalidTaskId');
  });

  it('refuses a task it does not know', async () => {
    await expectAnswer(await report(core(), randomUUID(), contract.requests.draftReady), 'unknownTask');
  });

  it('tells nobody about a task that only carries a reference image for another request', async () => {
    const chat = String(9_000_000_000 + Math.floor(Math.random() * 999_999_999));
    const other = await telegramTask(undefined, chat);
    const photoTask = await telegramTask({ referenceFor: other }, chat);
    await expectAnswer(await report(core(), photoTask, contract.requests.manualDesignToldAtIntake), 'referenceForAnotherRequest');
  });

  it('answers 500 when the notification cannot be written to the outbox', async () => {
    vi.spyOn(OutboxRepository.prototype, 'enqueue').mockRejectedValue(new Error('outbox unavailable'));
    const taskId = await telegramTask();
    await expectAnswer(await report(core(), taskId, contract.requests.refused), 'enqueueFailed');
  });

  it('covers every recorded answer', () => {
    expect(Object.keys(contract.answers).sort()).toEqual(
      ['enqueueFailed', 'invalidTaskId', 'noDatabase', 'recorded', 'referenceForAnotherRequest', 'unauthenticated', 'unknownTask'],
    );
  });
});
