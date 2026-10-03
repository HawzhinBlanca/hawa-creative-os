/**
 * ADR-200 addendum (incident 2026-10-01 12:33Z): redo words. The owner, office member and requester,
 * had been sent the final KAAE K-12 Pilot Study design (task 5edca743, request 95eeb08d) at 08:44Z
 * and wrote at 12:33Z, replying to nothing: "do a better design thats similar to earlier ones".
 * Production opened a new request for a designer, titled with that sentence. These pin the readings,
 * the plans, the words and the reopen of a delivered design; natural-language-stress.test.ts
 * (fixtures/nl-scripts/redo.ts, S151-S160) plays the conversations end to end. Sorani lines carry
 * their meaning in a comment.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, sql } from '@hawa/db';
import { isNeutralRequestTitle, neutralRequestTitle } from '@hawa/integrations';
import { askText, isWeakBriefLine, planTurn, readIntentByRules, redoText, shortTitle, type ChatRequestView,
  type PendingAsk, type TurnInput } from '../src/services/requester-turn.js';
import { intentRequestBody } from '../src/services/requester-intent-model.js';
import { LifecycleProjectionConflict, projectLifecycleOpen, projectLifecycleRequesterRevisionWithIntake } from '../src/services/lifecycle-projection.js';

const INCIDENT = 'do a better design thats similar to earlier ones';
const NOW = Date.parse('2026-10-01T12:33:00Z');
const H = 60 * 60_000;
const OWNER = '7000001';

function request(over: Partial<ChatRequestView> = {}): ChatRequestView {
  return { requestId: randomUUID(), stage: 'delivered', rev: 6, currentTaskId: randomUUID(), clientId: 'c1',
    title: 'KAAE: KAAE K-12 Pilot Study…', activeAt: new Date(NOW - 4 * H).toISOString(),
    createdAt: new Date(NOW - 6 * H).toISOString(), question: null, requesterId: OWNER, ...over };
}

function turn(text: string, requests: ChatRequestView[], over: Partial<TurnInput> = {}): TurnInput {
  return { text, reading: readIntentByRules(text), requests, bound: [], unboundReply: false, senderId: OWNER,
    officeIds: [OWNER], group: false, addressed: true, pendingAsk: null, now: NOW, ...over };
}

describe('redo words are read as redo words', () => {
  it.each([INCIDENT, 'do a better design', 'redo it', 'please redo the poster', 'make another version', 'try again',
    'make it better', 'similar to the earlier ones please', 'like the previous designs', 'not good, do it again',
    'start over', 'give it another try', 'hi, can you redo the poster?',
    // Sorani: "make it again", "make a better design like the previous ones", "it's not good, redo it",
    // "make another version", "make it better"
    'دووبارە دروستی بکەرەوە', 'دیزاینێکی باشتر بکە وەک ئەوانەی پێشوو', 'باش نییە، دووبارەی بکەرەوە',
    'وەشانێکی تر دروست بکە', 'باشتری بکە',
  ])('"%s" redoes the latest design', (words) => {
    expect(readIntentByRules(words)).toMatchObject({ intent: 'change', redo: 'redo' });
  });

  it.each(['do a better design for the conference', 'make a poster like the previous ones', 'redo it for the Nawroz party',
    // Sorani: "a better design for the conference"
    'دیزاینێکی باشتر بۆ کۆنفرانسەکە'])('"%s" may be a new design: asked', (words) => {
    expect(readIntentByRules(words)).toMatchObject({ intent: 'unclear', redo: 'or-new' });
  });

  it.each(['do a poster for the conference on the 5th', 'Can you make a poster for Nawroz?', 'make another one',
    'Another poster please: KAAE staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium.',
    'a poster for Nawroz like the previous ones', 'send it again', 'is the new version ready?', "don't redo it",
    'I like the previous ones better', 'make the title bigger', 'the date is wrong, it should be 5 October', 'cancel it',
    // Sorani: "send it again"
    'دووبارە بینێرەوە'])('"%s" is not', (words) => {
    expect(readIntentByRules(words).redo).toBeUndefined();
  });

  it('words with a photo or an album are read as before', () => {
    expect(readIntentByRules('redo it', { redo: false }).redo).toBeUndefined();
  });
});

describe('redo words are about the requester\'s most recent design', () => {
  it('the incident: the owner (office member and requester), four hours after delivery, replying to nothing', () => {
    const k12 = request();
    expect(planTurn(turn(INCIDENT, [k12]))).toEqual({ kind: 'redo', requestId: k12.requestId, directive: INCIDENT });
  });

  it('the latest of several, when it moved clearly last; Sorani too', () => {
    const older = request({ activeAt: new Date(NOW - 30 * H).toISOString(), createdAt: new Date(NOW - 40 * H).toISOString() });
    const k12 = request();
    // "make it better"
    expect(planTurn(turn('باشتری بکە', [older, k12]))).toMatchObject({ kind: 'redo', requestId: k12.requestId });
  });

  it('two delivered within minutes: one question naming both, and the answer redoes the one chosen', () => {
    const a = request({ title: 'KAAE: KAAE members evening…', activeAt: new Date(NOW - 2 * H).toISOString(), createdAt: new Date(NOW - 7 * H).toISOString() });
    const b = request({ title: 'KAAE: Staff football tournament…', activeAt: new Date(NOW - 2 * H + 3 * 60_000).toISOString() });
    const asked = planTurn(turn('try again', [a, b]));
    expect(asked).toMatchObject({ kind: 'ask', redo: 'redo', allowNew: false, options: [{ requestId: a.requestId }, { requestId: b.requestId }] });
    expect(askText(asked as Extract<typeof asked, { kind: 'ask' }>, 'en'))
      .toBe('Which one should I redo?\n1. <b>KAAE members evening</b>\n2. <b>Staff football tournament</b>');
    const pending: PendingAsk = { updateId: 9, ...(asked as Omit<PendingAsk, 'updateId'>) };
    expect(planTurn(turn('the second one', [a, b], { pendingAsk: pending })))
      .toEqual({ kind: 'redo', requestId: b.requestId, directive: 'try again', resolves: 9 });
    // "the football one"
    expect(planTurn(turn('the football one', [a, b], { pendingAsk: pending }))).toMatchObject({ kind: 'redo', requestId: b.requestId });
  });

  it('redo or new: asked by name; "redo it" redoes it, "a new one" opens one', () => {
    const k12 = request();
    const asked = planTurn(turn('do a better design for the conference', [k12]));
    expect(asked).toMatchObject({ kind: 'ask', redo: 'or-new', allowNew: true, options: [{ requestId: k12.requestId }] });
    expect(askText(asked as Extract<typeof asked, { kind: 'ask' }>, 'en')).toBe('Do you mean redo <b>KAAE K-12 Pilot Study</b>, or a new design?');
    const pending: PendingAsk = { updateId: 11, ...(asked as Omit<PendingAsk, 'updateId'>) };
    expect(planTurn(turn('redo it', [k12], { pendingAsk: pending }))).toMatchObject({ kind: 'redo', requestId: k12.requestId, resolves: 11 });
    expect(planTurn(turn('a new one', [k12], { pendingAsk: pending }))).toMatchObject({ kind: 'open', text: 'do a better design for the conference' });
  });

  it('an intake-router reading names the design to ask about; sure or not, it never redoes it by itself (ADR-286)', () => {
    const k12 = request();
    const model = (confidence: number) => ({ intent: 'change' as const, reason: 'router', source: 'model' as const,
      requestId: k12.requestId, confidence, redo: 'or-new' as const });
    expect(planTurn(turn('do a better design for the conference', [k12], { reading: model(0.9) })))
      .toMatchObject({ kind: 'ask', redo: 'or-new', options: [{ requestId: k12.requestId }] });
    expect(planTurn(turn('do a better design for the conference', [k12], { reading: model(0.7) }))).toMatchObject({ kind: 'ask', redo: 'or-new' });
  });

  it('by stage: waiting for changes starts its round; being made, with the office or a designer, kept for the office', () => {
    const revise = request({ stage: 'manual', rev: 3 });
    expect(planTurn(turn('try again', [revise]))).toEqual({ kind: 'revise', requestId: revise.requestId, directive: 'try again', redo: true });
    for (const stage of ['designing', 'in_review', 'approved', 'delivering'] as const) {
      const r = request({ stage, rev: 2 });
      expect(planTurn(turn('make another version', [r]))).toEqual({ kind: 'note', note: 'change', requestId: r.requestId,
        words: 'make another version', redo: true });
    }
    const manual = request({ stage: 'manual', rev: 1 });
    expect(planTurn(turn('redo it', [manual]))).toMatchObject({ kind: 'note', redo: true });
  });

  it('within seven days of delivery; other words keep the three days they had', () => {
    const fiveDays = request({ activeAt: new Date(NOW - 5 * 24 * H).toISOString() });
    expect(planTurn(turn('redo it', [fiveDays]))).toMatchObject({ kind: 'redo', requestId: fiveDays.requestId });
    expect(planTurn(turn('the date should be 6 December', [fiveDays]))).not.toMatchObject({ requestId: fiveDays.requestId });
    const eightDays = request({ activeAt: new Date(NOW - 8 * 24 * H).toISOString() });
    expect(planTurn(turn('redo it', [eightDays]))).not.toMatchObject({ kind: 'redo' });
    // With nothing recent, the incident's words ask a designer for a design, as they did before.
    expect(planTurn(turn(INCIDENT, [eightDays]))).toMatchObject({ kind: 'open', instructionOnly: true });
  });

  it('a new brief that looks like redo words stays new', () => {
    const k12 = request();
    expect(planTurn(turn('do a poster for the conference on the 5th', [k12]))).toMatchObject({ kind: 'open' });
  });

  it('a reply to another design is about that design; a group member never redoes someone else\'s', () => {
    const a = request({ title: 'A', activeAt: new Date(NOW - 30 * H).toISOString() });
    const b = request({ title: 'B' });
    expect(planTurn(turn('redo it', [a, b], { bound: [a.requestId] }))).toMatchObject({ kind: 'redo', requestId: a.requestId });
    const theirs = request({ requesterId: '555' });
    expect(planTurn(turn('try again', [theirs], { group: true, officeIds: [], addressed: true })))
      .not.toMatchObject({ requestId: theirs.requestId });
  });

  it('the requester hears the design named, in English and Sorani', () => {
    expect(redoText('delivered', 'KAAE: KAAE K-12 Pilot Study…', 'en', true)).toMatch(/^I'll redo <b>KAAE K-12 Pilot Study<\/b> — /);
    // ADR-231: kept words never promise a redo.
    expect(redoText('in_review', 'KAAE: KAAE K-12 Pilot Study…', 'en')).toMatch(/haven't started a new version\. I've passed what you said to them/);
    // "… is still being made, so I can't redo it yet"
    expect(redoText('designing', 'KAAE: KAAE K-12 Pilot Study…', 'ckb')).toMatch(/^<b>KAAE K-12 Pilot Study<\/b> هێشتا دروست دەکرێت/);
  });
});

describe('a chat sentence never names a request', () => {
  it.each([INCIDENT, 'make me a nice poster', 'can you help me?', 'hello', 'thanks', 'make it better', 'Hi!',
    // Sorani: "make a better design"
    'دیزاینێکی باشتر دروست بکە'])('"%s" names no design', (line) => {
    expect(isWeakBriefLine(line)).toBe(true);
  });

  it.each(['Poster for the graduation ceremony', 'KAAE members evening', 'Nawroz poster', 'Logo for our new cafe',
    'do a poster for the conference on the 5th', 'Beautiful Kurdistan poster',
    // Sorani: "a poster for Nawroz"
    'پۆستەرێک بۆ نەورۆز'])('"%s" names its design', (line) => {
    expect(isWeakBriefLine(line)).toBe(false);
  });

  it('a request opened from such words is named neutrally, and the requester hears "your design"', () => {
    expect(neutralRequestTitle('Hawzhin')).toBe('New design request from Hawzhin');
    expect(neutralRequestTitle('  ')).toBe('New design request from a requester');
    expect(isNeutralRequestTitle('New design request from Hawzhin')).toBe(true);
    expect(shortTitle('KAAE: New design request from Hawzhin')).toBe('your design');
    expect(shortTitle('KAAE: KAAE K-12 Pilot Study…')).toBe('KAAE K-12 Pilot Study');
  });
});

describe('the intake router sees when each design last moved', () => {
  it('lists recency and reads redo words as a change to the design they mean', () => {
    const body = JSON.parse(intentRequestBody('gpt-6.1-sol', INCIDENT, [request()], NOW));
    const prompt = body.messages[1].content as string;
    expect(prompt).toContain('1. "KAAE: KAAE K-12 Pilot Study…" (already delivered, last changed 4 hours ago)');
    expect(prompt).toMatch(/redo, retry or improve a design .* is a "change" to the design it means, usually the most recent/);
    expect(body.max_completion_tokens).toBe(400);
  });
});

describe('a delivered design reopened by redo words (Core projection)', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  afterAll(async () => { await db.destroy(); await owner.destroy(); });

  async function deliveredRequest(autoGenerate: boolean, deliveredDaysAgo = 0) {
    const requestId = randomUUID();
    const chatId = String(73_000_000 + Math.floor(Math.random() * 9_000_000));
    const opened = await projectLifecycleOpen(db, {
      requestId, tenantId, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
      draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: chatId,
        rawText: 'KAAE K-12 Pilot Study', title: 'KAAE: KAAE K-12 Pilot Study…', designInstructions: 'Use exact copy',
        exactCopy: ['KAAE K-12 Pilot Study'], clientId, autoGenerate, designStudio: false },
    });
    await sql`UPDATE hawa.requests SET stage = 'delivered', rev = 6, updated_at = now() - make_interval(days => ${deliveredDaysAgo}::int)
      WHERE request_id = ${requestId}::uuid`.execute(owner);
    return { requestId, chatId, taskId: opened.taskId };
  }

  function redo(r: { requestId: string; chatId: string; taskId: string }, extra: Record<string, unknown> = { reopenDelivered: true }) {
    const update = { update_id: 400_000 + Math.floor(Math.random() * 100_000), message: { message_id: 7, date: 1_790_000_000,
      chat: { id: Number(r.chatId), type: 'private' }, from: { id: Number(r.chatId), is_bot: false, first_name: 'Hawzhin' }, text: INCIDENT } };
    const hash = createHash('sha256').update(JSON.stringify(update)).digest('hex');
    return projectLifecycleRequesterRevisionWithIntake(db, { requestId: r.requestId, tenantId, priorTaskId: r.taskId, round: 2,
      directive: INCIDENT, sourceEventId: `lc-${r.requestId}-r2-u${update.update_id}`, sourceChannelId: r.chatId, rawText: INCIDENT,
      sourceUpdateHash: hash, sourceUpdate: update, clientId, expectedRev: 6, rev: 7,
      key: `${r.requestId}:7:requesterRevisionIntake:u${update.update_id}`, ...extra });
  }

  it('starts a new round of an automatic design delivered today, with the words as the change', async () => {
    const r = await deliveredRequest(true);
    const result = await redo(r);
    expect(result).toMatchObject({ requestId: r.requestId, priorTaskId: r.taskId, rev: 7, stage: 'designing', directive: INCIDENT });
    const row = (await sql<{ stage: string; rev: string; current_task_id: string }>`SELECT stage, rev, current_task_id::text
      FROM hawa.requests WHERE request_id = ${r.requestId}::uuid`.execute(owner)).rows[0];
    expect(row).toEqual({ stage: 'designing', rev: '7', current_task_id: result.newTaskId });
    const created = (await sql<{ payload: Record<string, any> }>`SELECT payload FROM hawa.outbox_commands
      WHERE aggregate_id = ${result.newTaskId}::uuid AND command_type = 'task.created'`.execute(owner)).rows[0];
    // "Similar to the earlier ones" goes to the design engine as the words were sent. ADR-233: as a fresh
    // round's art direction (a new design of the request), not as a native edit of the delivered design.
    expect(created.payload.studioOptions).toMatchObject({ freshFrom: { parentTaskId: r.taskId, kind: 'redo', directive: INCIDENT } });
    expect(created.payload.studioOptions).not.toHaveProperty('parentTaskId');
  });

  it('never reopens a design made by hand, one delivered too long ago, or a delivered one without redo words', async () => {
    const byHand = await deliveredRequest(false);
    await expect(redo(byHand)).rejects.toMatchObject({ code: 'WRONG_STAGE' });
    const old = await deliveredRequest(true, 8);
    await expect(redo(old)).rejects.toMatchObject({ code: 'WRONG_STAGE' });
    const plain = await deliveredRequest(true);
    await expect(redo(plain, {})).rejects.toBeInstanceOf(LifecycleProjectionConflict);
    for (const r of [byHand, old, plain]) {
      expect((await sql<{ stage: string }>`SELECT stage FROM hawa.requests WHERE request_id = ${r.requestId}::uuid`.execute(owner)).rows[0].stage)
        .toBe('delivered');
    }
  });
});
