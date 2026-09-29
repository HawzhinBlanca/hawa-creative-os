import { describe, expect, it, vi } from 'vitest';
import { handleUpdate, type ChatInboxCore, type InboxContext, type IntakeAnswer } from '../src/lifecycle/chat-inbox.js';

/**
 * NATURAL-LANGUAGE FRICTION AUDIT (2026-09-29): what ChatInbox tells a requester for each Core answer
 * (plans/lean-design-implementation-2026-09-28/NATURAL_LANGUAGE_FRICTION_AUDIT.md). Every test was
 * `it.fails` and asserts the natural behaviour the owner asked for. ADR-144 made N1 to N4 plain tests;
 * ADR-145 made N5 (a sender outside the allowlist) one. None is expected to fail.
 */

class Ctx implements InboxContext {
  journal = new Map<string, unknown>();
  state = new Map<string, unknown>();
  notices: Array<{ text: string; key: string }> = [];
  async get<T>(name: string): Promise<T | null> { return (this.state.get(name) as T) ?? null; }
  async run<T>(name: string, action: () => Promise<T>): Promise<T> {
    if (this.journal.has(name)) return this.journal.get(name) as T;
    const value = await action();
    this.journal.set(name, value);
    return value;
  }
  async sleep(): Promise<void> {}
  set(name: string, value: unknown) { this.state.set(name, value); }
  async now() { return 1_790_000_000_000; }
  sendLifecycleDecision() {}
  sendLifecycleOpen() {}
  sendNotice(message: any) { this.notices.push(message); }
  scheduleSettle() {}
}

const updateWith = (text: string) => ({ update_id: 777, message: { message_id: 1, date: 1,
  chat: { id: 555, type: 'private' }, from: { id: 9, is_bot: false, first_name: 'R' }, text } });

async function noticesFor(answer: IntakeAnswer, text = 'a message'): Promise<string[]> {
  const ctx = new Ctx();
  const core: ChatInboxCore = { intake: vi.fn(async () => answer), park: vi.fn(async () => {}) };
  await handleUpdate(ctx, { v: 1, update: updateWith(text) }, core);
  return ctx.notices.map((n) => n.text);
}

const done = (extra: Partial<Extract<IntakeAnswer, { kind: 'done' }>>): IntakeAnswer =>
  ({ kind: 'done', intakeStatus: 409, chatId: '555', ...extra });

describe('N1: the requester is asked for a slash command', () => {
  it.each(['NEW_BRIEF_EMPTY', 'LEGACY_REQUEST_REFUSED'] as const)('%s: the notice does not ask for /new', async (code) => {
    const texts = await noticesFor(done({ lifecycleAction: 'new-brief-required', code: code as any }), 'KAAE follow-up event');
    // Today: "Please send /new followed by the full design brief and the exact words to place on it."
    expect(texts.join('\n')).not.toMatch(/\/new/);
  });
});

describe('N2: the requester is asked to "reply directly to the revision notice"', () => {
  it.each(['AMBIGUOUS_REQUEST', 'STALE_REQUEST_REPLY'] as const)('%s: the notice does not demand a reply to a specific message', async (code) => {
    const texts = await noticesFor(done({ lifecycleAction: 'request-choice-required', code }), 'thanks');
    expect(texts.join('\n')).not.toMatch(/reply (directly )?to the (current )?revision notice/i);
  });
});

describe('N3: a Sorani requester is answered in English', () => {
  it('an answer taken from a Sorani message is acknowledged in Sorani', async () => {
    const texts = await noticesFor({ kind: 'done', intakeStatus: 200, lifecycleAction: 'requester-answer', chatId: '555',
      requestId: '11111111-1111-4111-8111-111111111111', newTaskId: '22222222-2222-4222-8222-222222222222',
      priorTaskId: '33333333-3333-4333-8333-333333333333', round: 1, directive: 'پاشبنەمای شین',
      questionId: '44444444-4444-4444-8444-444444444444' }, 'پاشبنەمای شین');
    // Today: "Your answer is saved. I am continuing the same design with that detail."
    expect(texts.join('\n')).toMatch(/[؀-ۿ]/);
  });

  it('a late change written in Sorani is answered in Sorani', async () => {
    const texts = await noticesFor(done({ lifecycleAction: 'late-change', code: 'LATE_REQUESTER_CHANGE',
      requestId: '11111111-1111-4111-8111-111111111111', requestStage: 'in_review' }), 'ژمارەی تەلەفۆنەکە هەڵەیە');
    expect(texts.join('\n')).toMatch(/[؀-ۿ]/);
  });
});

describe('N4: approval words in reply to the draft', () => {
  it('"looks good, send it" is not told its words were "not applied to the design"', async () => {
    const texts = await noticesFor(done({ lifecycleAction: 'late-change', code: 'LATE_REQUESTER_CHANGE',
      requestId: '11111111-1111-4111-8111-111111111111', requestStage: 'in_review',
      officeAlert: { chatId: '1', text: 'x' } }), 'looks good, send it');
    // Today: "Your message arrived after this design went to the office, so it was not applied to the design. …"
    expect(texts.join('\n')).not.toMatch(/not applied/);
  });
});

describe('N5: silent drops', () => {
  it('a sender Core does not recognise hears something instead of nothing', async () => {
    const texts = await noticesFor({ kind: 'done', intakeStatus: 403, code: undefined } as any, 'Poster for our open day on Monday');
    expect(texts.length).toBeGreaterThan(0);
  });
});
