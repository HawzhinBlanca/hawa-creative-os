import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coreInternalFixture } from './core-internal-fixture.js';
import type { OutboundMessage } from '@hawa/contracts';
import { createRequestLifecycle, openManualRequest, type ManualLifecycleState, type OpenContext, type OpenManualEvent } from '../src/lifecycle/request-lifecycle.js';

class FakeContext implements OpenContext {
  state: ManualLifecycleState | null = null;
  journal = new Map<string, unknown>();
  sent: OutboundMessage[] = [];
  crashBeforeSend = false;
  constructor(readonly key: string) {}
  async get() { return this.state; }
  async run<T>(name: string, action: () => Promise<T>): Promise<T> {
    if (this.journal.has(name)) return this.journal.get(name) as T;
    const result = await action();
    this.journal.set(name, result);
    return result;
  }
  set(_name: string, value: ManualLifecycleState) { this.state = value; }
  send(message: OutboundMessage) {
    if (this.crashBeforeSend) { this.crashBeforeSend = false; throw new Error('worker killed before send'); }
    this.sent.push(message);
  }
}

function event(): OpenManualEvent {
  const requestId = randomUUID();
  const chatId = String(80_000_000 + Math.floor(Math.random() * 9_000_000));
  return {
    v: 1, eventId: `open:${requestId}`, requestId,
    tenantId: '00000000-0000-4000-a000-000000000001', chatId,
    draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: chatId,
      rawText: 'An autumn event poster', title: 'Autumn event', designInstructions: 'Use supplied copy',
      exactCopy: ['Autumn event'], clientId: null, autoGenerate: false },
  };
}

afterEach(() => vi.unstubAllEnvs());
const core = (taskId = randomUUID()) => coreInternalFixture({ v: 1, taskId, stage: 'manual', rev: 1, autoGenerate: false });

describe('RequestLifecycle first manual open', () => {
  it('projects once and emits a stable critical acknowledgement after saving state', async () => {
    const e = event();
    const ctx = new FakeContext(e.requestId);
    const c = core();
    const result = await openManualRequest(ctx, c, e);
    expect(result).toMatchObject({ accepted: true, stage: 'manual', rev: 1 });
    expect(c.post).toHaveBeenCalledTimes(1);
    expect(c.postSpy.mock.calls[0][0]).toBe(`/internal/lifecycle/${e.requestId}/project`);
    expect(ctx.state).toMatchObject({ requestId: e.requestId, owner: 'restate', stage: 'manual', taskId: result.taskId });
    expect(ctx.sent).toEqual([expect.objectContaining({ key: `${e.requestId}:1:ack`, class: 'critical', taskId: result.taskId })]);
    // ADR-145 (#9): the brief's language and the design's name are kept, and the ack is plain words.
    expect(ctx.state).toMatchObject({ lang: 'en', title: 'Autumn event' });
    expect(ctx.sent[0]).toMatchObject({ parseMode: 'HTML',
      text: 'Got it. A designer will make <b>Autumn event</b> and send it to you here.' });
  });

  it('acknowledges a Sorani brief in Sorani, and old state without a language in English (ADR-145)', async () => {
    const e = event();
    e.draft = { ...e.draft, rawText: 'پۆستەرێک بۆ ئاهەنگی پاییز دروست بکە', title: 'ئاهەنگی پاییز' };
    const ctx = new FakeContext(e.requestId);
    await openManualRequest(ctx, core(), e);
    expect(ctx.state).toMatchObject({ lang: 'ckb' });
    expect(ctx.sent[0].text).toBe('تێگەیشتم. دیزاینەرێک <b>ئاهەنگی پاییز</b> دروست دەکات و لێرە بۆت دەنێرێت.');
    // State saved before ADR-145 has neither field: the replayed ack (same key) is English.
    const { lang: _lang, title: _title, ...old } = ctx.state!;
    ctx.state = old;
    ctx.sent = [];
    await openManualRequest(ctx, core(), e);
    expect(ctx.sent[0]).toMatchObject({ key: `${e.requestId}:1:ack`, text: 'Got it. A designer will make your design and send it to you here.' });
  });

  it('replays the same ack after a crash between state and send without projecting again', async () => {
    const e = event();
    const ctx = new FakeContext(e.requestId);
    const c = core();
    ctx.crashBeforeSend = true;
    await expect(openManualRequest(ctx, c, e)).rejects.toThrow('worker killed');
    expect(ctx.state?.taskId).toBeTruthy();
    const again = await openManualRequest(ctx, c, e);
    expect(again.taskId).toBe(ctx.state?.taskId);
    expect(c.post).toHaveBeenCalledTimes(1);
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].key).toBe(`${e.requestId}:1:ack`);
  });

  it('refuses changed content, wrong object key and automatic design before any effect', async () => {
    const e = event();
    const ctx = new FakeContext(e.requestId);
    const c = core();
    await openManualRequest(ctx, c, e);
    await expect(openManualRequest(ctx, c, { ...e, draft: { ...e.draft, rawText: 'changed' } })).rejects.toThrow('different content');
    const wrong = new FakeContext(randomUUID());
    await expect(openManualRequest(wrong, c, e)).rejects.toThrow('under its own key');
    const automatic = { ...event(), draft: { ...e.draft, autoGenerate: true } } as unknown as OpenManualEvent;
    await expect(openManualRequest(new FakeContext(automatic.requestId), c, automatic)).rejects.toThrow('manual round-zero');
    expect(c.post).toHaveBeenCalledTimes(1);
  });

  it('registers the stable RequestLifecycle service name', () => {
    const service = createRequestLifecycle(core());
    expect(service.name).toBe('RequestLifecycle');
  });
});
