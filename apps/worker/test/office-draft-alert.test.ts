import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { DraftImageRef, OutboundMessage } from '@hawa/contracts';
import { createDb } from '@hawa/db';
import { coreInternalFromEnv } from '../src/lifecycle/delivery.js';
import {
  recordDesignFinished, type AutomaticLifecycleState, type AutomaticOpenContext, type LifecycleState,
} from '../src/lifecycle/request-lifecycle.js';
import { handleSend, type SenderContext, type TelegramSenderDeps } from '../src/lifecycle/telegram-sender.js';

/**
 * ADR-155 addendum (owner report 2026-09-30): the office's "design ready" alert carries the draft. The
 * worker sends each office member a photo of it under the same key as the text alert (one alert per
 * member per revision), reads the picture by reference and checks its hash, and sends the alert's words
 * instead when the picture cannot be read or is refused. The requester is sent no picture.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const db = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => db.destroy());
afterEach(() => vi.unstubAllEnvs());

const OFFICE = ['9310001', '9310002'];
const CAPTION = 'A new draft is ready for office review: "Autumn poster"\nEdit in Canva: https://www.canva.com/design/DA_audit/edit';
const png = Buffer.from('draft picture bytes');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function designingState(chatId: string): AutomaticLifecycleState {
  const requestId = randomUUID();
  const taskId = randomUUID();
  return { v: 1, requestId, tenantId, chatId, owner: 'restate', stage: 'designing', rev: 1, taskId,
    openEventId: `open:${requestId}`, openSha256: 'x', runId: `dr-${taskId}`, lang: 'en', title: 'Autumn poster',
    designInput: { v: 1, lifecycle: { requestId, round: 0, runId: `dr-${taskId}` }, taskId, tenantId, clientId,
      rawText: 'x', sourcePlatform: 'telegram', idempotencyKey: `lifecycle:${requestId}:${taskId}`, canvaAutoGenerate: true } };
}

function lifecycleContext(state: LifecycleState) {
  const sends: OutboundMessage[] = [];
  let current: LifecycleState | null = state;
  const ctx: AutomaticOpenContext = {
    key: state.requestId, get: async () => current, run: (_name, action) => action(),
    set: (_n, value) => { current = value; }, send: (m) => { sends.push(m); }, startDesign: () => {},
  };
  return { ctx, sends };
}

const finished = (state: AutomaticLifecycleState) => ({
  v: 1 as const, eventId: `dr-finished:${state.runId}`, requestId: state.requestId, runId: state.runId, round: 0,
  taskId: state.taskId, report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DA_audit' },
});

describe('RequestLifecycle: the draft alert goes as a photo to every office member', () => {
  it('sends a photo per member under the text alert\'s key, the requester only their message, and a replay the same', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', 'test-only-worker-token');
    const state = designingState('7310001');
    const image: DraftImageRef = { source: 'canva_export', tenantId, taskId: state.taskId, id: randomUUID(), sha256: sha(png) };
    const core = coreInternalFromEnv(vi.fn<typeof fetch>(async () => Response.json({ v: 1, requestId: state.requestId,
      taskId: state.taskId, rev: 2, stage: 'in_review', status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW',
      message: { text: 'Your design is with the office for a check.', parseMode: 'HTML' },
      officeAlert: { chatId: OFFICE[0], text: CAPTION },
      officeAlerts: OFFICE.map((chatId) => ({ chatId, text: CAPTION })),
      officePhotoAlerts: OFFICE.map((chatId) => ({ chatId, text: CAPTION, image })) })));
    const h = lifecycleContext(state);
    await recordDesignFinished(h.ctx, core, finished(state));
    expect(h.sends.map((m) => [m.chatId, m.kind, m.key])).toEqual([
      ['7310001', 'text', `${state.requestId}:2:design-outcome`],
      [OFFICE[0], 'photo', `${state.requestId}:2:office-alert`],
      [OFFICE[1], 'photo', `${state.requestId}:2:office-alert:${OFFICE[1]}`],
    ]);
    expect(h.sends[1]).toMatchObject({ imageRef: image, caption: CAPTION, text: CAPTION, class: 'critical' });
    // The requester (not an office member) gets no picture before approval.
    expect(h.sends.filter((m) => m.chatId === '7310001').every((m) => m.kind === 'text' && !m.imageRef)).toBe(true);
    // A replay sends the same keys, so TelegramSender's marks keep it to one alert per member.
    const replayed = h.sends.length;
    await recordDesignFinished(h.ctx, core, finished(state));
    expect(h.sends.slice(replayed).map((m) => m.key)).toEqual(h.sends.slice(0, replayed).map((m) => m.key));
  });

  it('a Core from before (no photo alerts) still gets its text alerts sent', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', 'test-only-worker-token');
    const state = designingState('7310002');
    const core = coreInternalFromEnv(vi.fn<typeof fetch>(async () => Response.json({ v: 1, requestId: state.requestId,
      taskId: state.taskId, rev: 2, stage: 'in_review', status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW',
      officeAlert: { chatId: OFFICE[0], text: CAPTION }, officeAlerts: OFFICE.map((chatId) => ({ chatId, text: CAPTION })) })));
    const h = lifecycleContext(state);
    await recordDesignFinished(h.ctx, core, finished(state));
    expect(h.sends.map((m) => [m.chatId, m.kind])).toEqual([[OFFICE[0], 'text'], [OFFICE[1], 'text']]);
  });
});

describe('TelegramSender: a draft photo alert', () => {
  function harness(picture: Uint8Array | null, photoAnswer: { success: boolean; error?: string; messageId?: string } = { success: true, messageId: '501' }) {
    const calls: Array<{ kind: 'photo' | 'text' | 'document'; chatId: string; body: string; bytes?: Uint8Array }> = [];
    let next = 600;
    const deps: TelegramSenderDeps = {
      db, botToken: () => 'test-bot-token',
      bridge: () => ({
        dispatchOutboundMessage: async (chatId: string, msg: { text: string }) => {
          calls.push({ kind: 'text', chatId: String(chatId), body: msg.text });
          return { success: true, messageId: String(next++) };
        },
        dispatchOutboundDocument: async (chatId: string, bytes: Uint8Array, _f: string, o: { caption?: string }) => {
          calls.push({ kind: 'document', chatId: String(chatId), body: o.caption || '', bytes });
          return { success: true, messageId: String(next++) };
        },
        dispatchOutboundPhoto: async (chatId: string, bytes: Buffer, caption?: string) => {
          calls.push({ kind: 'photo', chatId: String(chatId), body: caption || '', bytes });
          return photoAnswer;
        },
      }) as never,
      readExportBytes: async () => null,
      readDraftImage: async () => picture,
      officeChatIds: () => OFFICE, markRetryDelaysMs: [1],
    };
    const ctx: SenderContext = { run: (_n, action) => action(), sleep: async () => {}, sendTo: () => {} };
    const message: OutboundMessage = { v: 1, key: `${randomUUID()}:2:office-alert`, chatId: OFFICE[0], kind: 'photo',
      imageRef: { source: 'canva_export', tenantId, taskId: randomUUID(), id: randomUUID(), sha256: sha(png) },
      caption: CAPTION, text: CAPTION, class: 'critical', tenantId };
    return { deps, ctx, calls, message };
  }

  it('sends the picture it read, checked against its hash, with the caption, and never twice', async () => {
    const h = harness(new Uint8Array(png));
    expect(await handleSend(h.ctx, h.deps, h.message)).toEqual({ outcome: 'sent', messageId: '501' });
    expect(h.calls).toEqual([{ kind: 'photo', chatId: OFFICE[0], body: CAPTION, bytes: png }]);
    // Asked again (a replay, or another build): the send mark answers, nothing is sent.
    expect(await handleSend(h.ctx, h.deps, h.message)).toEqual({ outcome: 'sent', messageId: '501' });
    expect(h.calls).toHaveLength(1);
  });

  it('a picture that cannot be read sends the alert as text, never nothing', async () => {
    const h = harness(null);
    expect(await handleSend(h.ctx, h.deps, h.message)).toMatchObject({ outcome: 'sent' });
    expect(h.calls).toEqual([{ kind: 'text', chatId: OFFICE[0], body: CAPTION }]);
  });

  it('a picture that no longer matches its hash is not sent: the text is', async () => {
    const h = harness(new Uint8Array(Buffer.from('some other picture')));
    await handleSend(h.ctx, h.deps, h.message);
    expect(h.calls.map((c) => c.kind)).toEqual(['text']);
  });

  it('a picture Telegram refuses is followed by the text, under the same key', async () => {
    const h = harness(new Uint8Array(png), { success: false, error: 'TELEGRAM_PHOTO_FAILED_400' });
    expect(await handleSend(h.ctx, h.deps, h.message)).toMatchObject({ outcome: 'sent' });
    expect(h.calls.map((c) => c.kind)).toEqual(['photo', 'text']);
    await handleSend(h.ctx, h.deps, h.message);
    expect(h.calls).toHaveLength(2);
  });
});
