import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as restate from '@restatedev/restate-sdk';
import { createDb, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID, type OutboundMessage, type SendResult } from '@hawa/contracts';
import { handleSend, markIdOf, SEND_STEP, sendAttempt, type SenderContext, type TelegramSenderDeps } from '../src/lifecycle/telegram-sender.js';
import { readSendMark, writeSendMark, type TelegramSender as BridgeLike, type TelegramSendResult } from '../src/delivery-notification.js';

/**
 * TelegramSender (architecture programme Phase 2, slice 2.2; PHASE2_DESIGN.md 2.6): how one attempt
 * at a message is classified, and what the send marks make of an attempt that came before. The marks
 * are real rows in hawa.inbox_events, written as the worker writes them (SYSTEM_AUTOMATION_USER_ID).
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const OFFICE = '9000001';
const botToken = ['sender', 'test', 'bot'].join('_');
let db: Kysely<Database>;
beforeAll(() => { db = createDb(process.env.TEST_DATABASE_URL!); });
afterAll(async () => { await db?.destroy(); });

const asAutomation = <T>(fn: (trx: Kysely<Database>) => Promise<T>) =>
  withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, fn);
const markOf = async (key: string) => (await asAutomation((trx) => readSendMark(trx, tenantId, markIdOf(key), SEND_STEP)))?.outcome;

/** A bridge that answers each call from a script and records what it was asked to send. */
function scriptedBridge(answers: TelegramSendResult[]) {
  const calls: Array<{ method: string; chatId: string; filename?: string; text?: string }> = [];
  const next = () => answers.length > 1 ? answers.shift()! : answers[0];
  const bridge: BridgeLike = {
    async dispatchOutboundMessage(chatId, message) {
      calls.push({ method: 'sendMessage', chatId: String(chatId), text: message.text });
      return next();
    },
    async dispatchOutboundDocument(chatId, _bytes, filename) {
      calls.push({ method: 'sendDocument', chatId: String(chatId), filename });
      return next();
    },
  };
  return { bridge, calls };
}

function depsWith(bridge: BridgeLike, files: Record<string, Uint8Array> = {}): TelegramSenderDeps {
  return {
    db,
    botToken: () => botToken,
    bridge: () => bridge,
    readExportBytes: async (_trx, _tenant, _task, artifactId) => files[artifactId] ?? null,
    officeChatId: () => OFFICE,
    markRetryDelaysMs: [10, 10],
  };
}

const chat = () => String(7_100_000 + Math.floor(Math.random() * 800_000));
const text = (key = `test:${randomUUID()}`, overrides: Partial<OutboundMessage> = {}): OutboundMessage => ({
  v: 1, key, chatId: chat(), kind: 'text', text: 'Your approved design has been delivered.', class: 'critical', tenantId, taskId: randomUUID(), ...overrides,
});
function doc(bytes: Uint8Array, overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  const artifactId = randomUUID();
  return {
    v: 1, key: `dl-test:file:${artifactId}`, chatId: chat(), kind: 'document', filename: 'kaae.png', class: 'critical', tenantId,
    exportRef: { tenantId, taskId: randomUUID(), artifactId, sha256: createHash('sha256').update(bytes).digest('hex') }, ...overrides,
  };
}

/** A handler context that runs each step directly and keeps what the handler sent on to other chats. */
function fakeContext() {
  const forwarded: OutboundMessage[] = [];
  const ctx: SenderContext = { run: (_name, action) => action(), sendTo: (m) => { forwarded.push(m); } };
  return { ctx, forwarded };
}

describe('TelegramSender: one attempt, classified', () => {
  it('sent: answers sent with the message id, and marks it sent', async () => {
    const { bridge, calls } = scriptedBridge([{ success: true, messageId: '41' }]);
    const m = text();
    expect(await sendAttempt(depsWith(bridge), m)).toEqual({ outcome: 'sent', messageId: '41' });
    expect(calls).toHaveLength(1);
    expect(await markOf(m.key)).toBe('sent');
    expect(await asAutomation((trx) => readSendMark(trx, tenantId, markIdOf(m.key), SEND_STEP)))
      .toMatchObject({ outcome: 'sent', messageId: '41' });
  });

  it.each([undefined, '0', 'not-a-message-id'])(
    'a success response without a valid message id (%s) remains uncertain', async (messageId) => {
      const { bridge, calls } = scriptedBridge([{ success: true, ...(messageId ? { messageId } : {}) }]);
      const m = text();
      expect(await sendAttempt(depsWith(bridge), m)).toMatchObject({ outcome: 'uncertain', error: 'TELEGRAM_RECEIPT_INVALID' });
      expect(await markOf(m.key)).toBe('uncertain');
      expect(calls).toHaveLength(1);
      expect((await sendAttempt(depsWith(bridge), m)).outcome).toBe('uncertain');
      expect(calls).toHaveLength(1);
    },
  );

  it("429: marks it failed and asks Restate to try again after Telegram's retry_after", async () => {
    const { bridge } = scriptedBridge([{ success: false, error: 'TELEGRAM_DOCUMENT_REJECTED_429', retryAfterSeconds: 3 }]);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const m = doc(bytes);
    const err = await sendAttempt(depsWith(bridge, { [m.exportRef!.artifactId]: bytes }), m).catch((e) => e);
    expect(err).toBeInstanceOf(restate.RetryableError);
    expect((err as restate.RetryableError).retryAfter).toBe(3000);
    expect(await markOf(m.key)).toBe('failed');
  });

  it('429 then sent: the retry sends it (a failed mark does not fence it)', async () => {
    const { bridge, calls } = scriptedBridge([{ success: false, error: 'TELEGRAM_REJECTED_429', retryAfterSeconds: 1 }, { success: true, messageId: '7' }]);
    const m = text();
    await expect(sendAttempt(depsWith(bridge), m)).rejects.toBeInstanceOf(restate.RetryableError);
    expect(await sendAttempt(depsWith(bridge), m)).toEqual({ outcome: 'sent', messageId: '7' });
    expect(calls).toHaveLength(2);
    expect(await markOf(m.key)).toBe('sent');
  });

  it('a 5xx can follow an accepted send and must never be retried automatically', async () => {
    const { bridge, calls } = scriptedBridge([{ success: false, error: 'TELEGRAM_REJECTED_502' }]);
    const m = text();
    expect(await sendAttempt(depsWith(bridge), m)).toMatchObject({ outcome: 'uncertain' });
    expect(await markOf(m.key)).toBe('uncertain');
    expect((await sendAttempt(depsWith(bridge), m)).outcome).toBe('uncertain');
    expect(calls).toHaveLength(1);
  });

  it('a pre-connection failure marks failed and asks Restate to retry', async () => {
    const error = 'TELEGRAM_NETWORK_ERROR';
    const { bridge } = scriptedBridge([{ success: false, error }]);
    const m = text();
    const err = await sendAttempt(depsWith(bridge), m).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(restate.TerminalError);
    expect(err).not.toBeInstanceOf(restate.RetryableError);
    expect(await markOf(m.key)).toBe('failed');
  });

  it.each([
    ['the answer was lost', 'TELEGRAM_DELIVERY_UNCERTAIN'],
    ['the receipt did not match', 'TELEGRAM_RECEIPT_INVALID'],
  ])('uncertain (%s): answers uncertain, marks it uncertain, and does not retry', async (_what, error) => {
    const { bridge } = scriptedBridge([{ success: false, error }]);
    const m = text();
    expect(await sendAttempt(depsWith(bridge), m)).toEqual({ outcome: 'uncertain', error });
    expect(await markOf(m.key)).toBe('uncertain');
  });

  it.each([
    ['the bot was blocked', 'TELEGRAM_REJECTED_403'],
    ['chat not found', 'TELEGRAM_REJECTED_400'],
    ['the file is too large', 'TELEGRAM_DOCUMENT_REJECTED_413'],
  ])('refused (%s): answers refused and marks it failed', async (_what, error) => {
    const { bridge } = scriptedBridge([{ success: false, error }]);
    const m = text();
    expect(await sendAttempt(depsWith(bridge), m)).toEqual({ outcome: 'refused', error });
    expect(await markOf(m.key)).toBe('failed');
  });

  it('a stored file that no longer matches its approved hash is refused and never sent', async () => {
    const { bridge, calls } = scriptedBridge([{ success: true, messageId: '1' }]);
    const m = doc(new Uint8Array([9, 9, 9]));
    const result = await sendAttempt(depsWith(bridge, { [m.exportRef!.artifactId]: new Uint8Array([1]) }), m);
    expect(result.outcome).toBe('refused');
    expect(calls).toHaveLength(0);
    expect(await markOf(m.key)).toBeUndefined();
  });
});

describe('TelegramSender: marks already present', () => {
  it('sent: answers sent without sending again', async () => {
    const { bridge, calls } = scriptedBridge([{ success: true, messageId: '1' }]);
    const m = text();
    await asAutomation((trx) => writeSendMark(trx, tenantId, markIdOf(m.key), SEND_STEP, 'message', 'sent'));
    expect(await sendAttempt(depsWith(bridge), m)).toEqual({ outcome: 'sent' });
    expect(calls).toHaveLength(0);
  });

  it('reuses a recorded Bot API message id without another send', async () => {
    const { bridge, calls } = scriptedBridge([{ success: true, messageId: '99' }]);
    const m = text();
    await asAutomation((trx) => writeSendMark(trx, tenantId, markIdOf(m.key), SEND_STEP, 'message', 'sent', '87'));
    expect(await sendAttempt(depsWith(bridge), m)).toEqual({ outcome: 'sent', messageId: '87' });
    expect(calls).toHaveLength(0);
  });

  it.each(['attempted', 'uncertain'] as const)('%s (it may have arrived): answers uncertain and never sends it again', async (prior) => {
    const { bridge, calls } = scriptedBridge([{ success: true, messageId: '1' }]);
    const m = text();
    await asAutomation((trx) => writeSendMark(trx, tenantId, markIdOf(m.key), SEND_STEP, 'message', prior));
    const result = await sendAttempt(depsWith(bridge), m);
    expect(result.outcome).toBe('uncertain');
    expect(calls).toHaveLength(0);
  });

  it('a key with underscores is matched exactly, not as a LIKE pattern', async () => {
    const { bridge, calls } = scriptedBridge([{ success: true, messageId: '1' }]);
    const suffix = randomUUID();
    await asAutomation((trx) => writeSendMark(trx, tenantId, markIdOf(`dl-aXb:${suffix}`), SEND_STEP, 'message', 'sent'));
    expect((await sendAttempt(depsWith(bridge), text(`dl-a_b:${suffix}`))).outcome).toBe('sent');
    expect(calls).toHaveLength(1);
  });

  it('courtesy messages skip the marks', async () => {
    const { bridge, calls } = scriptedBridge([{ success: true, messageId: '1' }]);
    const m = text(undefined, { class: 'courtesy' });
    await sendAttempt(depsWith(bridge), m);
    await sendAttempt(depsWith(bridge), m);
    expect(calls).toHaveLength(2);
    expect(await markOf(m.key)).toBeUndefined();
  });

  it('the worker killed after Telegram took the message (only attempted on record): the retry answers uncertain; sent once', async () => {
    // The first attempt: 'attempted' written, the message sent, then the process died before its mark.
    const { bridge, calls } = scriptedBridge([{ success: true, messageId: '1' }]);
    const m = text();
    await asAutomation((trx) => writeSendMark(trx, tenantId, markIdOf(m.key), SEND_STEP, 'message', 'attempted'));
    calls.push({ method: 'sendMessage', chatId: m.chatId, text: m.text });
    // Restate replays the step, which was never journaled.
    const { ctx, forwarded } = fakeContext();
    const result = await handleSend(ctx, depsWith(bridge), m);
    expect(result.outcome).toBe('uncertain');
    expect(calls).toHaveLength(1);
    expect(forwarded.map((f) => ({ key: f.key, chatId: f.chatId }))).toEqual([{ key: `${m.key}:uncertain-alert`, chatId: OFFICE }]);
  });

  it('a mark that cannot be written after Telegram answered is asked for again, so the message is not left attempted', async () => {
    const { bridge, calls } = scriptedBridge([{ success: true, messageId: '5' }]);
    const m = text();
    // The first try at the 'sent' mark meets a Postgres that is restarting (transactions: 1 reads the
    // marks, 2 writes 'attempted', 3 is the first try at 'sent').
    let transactions = 0;
    const restarting = {
      isTransaction: false,
      transaction() {
        transactions++;
        if (transactions === 3) return { execute: async () => { throw new Error('Connection terminated unexpectedly'); } };
        return db.transaction();
      },
    } as unknown as Kysely<Database>;
    expect(await sendAttempt({ ...depsWith(bridge), db: restarting }, m)).toEqual({ outcome: 'sent', messageId: '5' });
    expect(calls).toHaveLength(1);
    expect(await markOf(m.key)).toBe('sent');
  });

  it('does not claim delivery when the sent mark remains unwritten after retries', async () => {
    const { bridge, calls } = scriptedBridge([{ success: true, messageId: '91' }]);
    const m = text();
    let transactions = 0;
    const broken = {
      isTransaction: false,
      transaction() {
        transactions++;
        if (transactions >= 3) return { execute: async () => { throw new Error('Postgres write unavailable'); } };
        return db.transaction();
      },
    } as unknown as Kysely<Database>;
    expect(await sendAttempt({ ...depsWith(bridge), db: broken, markRetryDelaysMs: [1] }, m))
      .toEqual({ outcome: 'uncertain', error: 'SEND_MARK_UNCONFIRMED' });
    expect(await markOf(m.key)).toBe('attempted');
    expect(calls).toHaveLength(1);
  });
});

describe('TelegramSender: the office hears of an uncertain critical message once', () => {
  it('an uncertain file sends one alert to the office chat, keyed by the message', async () => {
    const { bridge } = scriptedBridge([{ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' }]);
    const bytes = new Uint8Array([4, 5, 6]);
    const m = doc(bytes, { taskId: randomUUID() });
    const { ctx, forwarded } = fakeContext();
    const result: SendResult = await handleSend(ctx, depsWith(bridge, { [m.exportRef!.artifactId]: bytes }), m);
    expect(result.outcome).toBe('uncertain');
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ key: `${m.key}:uncertain-alert`, chatId: OFFICE, kind: 'text', class: 'critical' });
    expect(forwarded[0].text).toContain(m.taskId!);
    expect(forwarded[0].text).toContain('kaae.png');
  });

  it('a sent, refused or courtesy message alerts nobody', async () => {
    for (const [answer, overrides] of [
      [{ success: true, messageId: '1' }, {}],
      [{ success: false, error: 'TELEGRAM_REJECTED_403' }, {}],
      [{ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' }, { class: 'courtesy' as const }],
    ] as const) {
      const { bridge } = scriptedBridge([answer as TelegramSendResult]);
      const { ctx, forwarded } = fakeContext();
      await handleSend(ctx, depsWith(bridge), text(undefined, overrides));
      expect(forwarded).toEqual([]);
    }
  });

  it('an uncertain message to the office chat itself is logged, not sent to the office again', async () => {
    const { bridge } = scriptedBridge([{ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' }]);
    const { ctx, forwarded } = fakeContext();
    await handleSend(ctx, depsWith(bridge), text(undefined, { chatId: OFFICE }));
    expect(forwarded).toEqual([]);
  });

  it('notifies a question send after its confirmed mark, including after a callback crash', async () => {
    const requestId = randomUUID();
    const taskId = randomUUID();
    const questionId = randomUUID();
    const m = text(`${requestId}:2:design-outcome`, { taskId, onSent: {
      kind: 'question', requestId, requestRev: 2, taskId, questionId,
    } });
    const { bridge, calls } = scriptedBridge([{ success: true, messageId: '739' }]);
    const callbacks: string[] = [];
    let fail = true;
    const ctx: SenderContext = { run: (_name, action) => action(), sendTo: () => {},
      notifySent: (_message, messageId) => {
        if (fail) { fail = false; throw new Error('callback crashed'); }
        callbacks.push(messageId);
      } };
    await expect(handleSend(ctx, depsWith(bridge), m)).rejects.toThrow('callback crashed');
    expect(await markOf(m.key)).toBe('sent');
    expect(await handleSend(ctx, depsWith(bridge), m)).toEqual({ outcome: 'sent', messageId: '739' });
    expect(calls).toHaveLength(1);
    expect(callbacks).toEqual(['739']);
  });

  it('does not start a question timer for an uncertain send or mismatched callback identity', async () => {
    const requestId = randomUUID();
    const taskId = randomUUID();
    const message = text(`${requestId}:2:design-outcome`, { taskId, onSent: {
      kind: 'question', requestId, requestRev: 2, taskId, questionId: randomUUID(),
    } });
    const { bridge, calls } = scriptedBridge([{ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' }]);
    const callbacks: string[] = [];
    const ctx: SenderContext = { run: (_name, action) => action(), sendTo: () => {},
      notifySent: (_message, messageId) => { callbacks.push(messageId); } };
    expect((await handleSend(ctx, depsWith(bridge), message)).outcome).toBe('uncertain');
    expect(callbacks).toEqual([]);
    await expect(handleSend(ctx, depsWith(bridge), { ...message, key: `wrong:${randomUUID()}` }))
      .rejects.toBeInstanceOf(restate.TerminalError);
    expect(calls).toHaveLength(1);
  });

  it('a message without a key or chat is refused for good', async () => {
    const { bridge } = scriptedBridge([{ success: true }]);
    const { ctx } = fakeContext();
    await expect(handleSend(ctx, depsWith(bridge), { ...text(), key: '' })).rejects.toBeInstanceOf(restate.TerminalError);
  });
});
