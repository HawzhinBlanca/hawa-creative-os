import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coreInternalFixture } from './core-internal-fixture.js';
import type { OutboundMessage } from '@hawa/contracts';
import { DurableStepJournal } from '../src/durable-context.js';
import { lifecycleDesignProofHeaders } from '../src/lifecycle/design-proof.js';
import { runOwnedDesign, validDesignRun, type DesignRunInput } from '../src/lifecycle/design-run.js';
import { openAutomaticRequest, recordDesignFinished, recordQuestionSent, recordReminderTick, type AutomaticLifecycleState,
  type AutomaticOpenContext, type DesignFinishedEvent, type ManualLifecycleState,
  type OpenAutomaticEvent } from '../src/lifecycle/request-lifecycle.js';

const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
afterEach(() => vi.unstubAllEnvs());

class Context implements AutomaticOpenContext {
  state: ManualLifecycleState | AutomaticLifecycleState | null = null;
  journal = new Map<string, unknown>();
  sent: OutboundMessage[] = [];
  started: DesignRunInput[] = [];
  scheduledQuestions: Array<{ requestId: string; rev: number; questionId: string;
    day: 1 | 5; delayMs: number }> = [];
  failAt: 'ack' | 'start' | 'outcome' | 'schedule' | null = null;
  nowValue = Date.parse('2026-09-25T18:30:01Z');
  constructor(readonly key: string) {}
  async get() { return this.state; }
  async run<T>(name: string, action: () => Promise<T>): Promise<T> {
    if (this.journal.has(name)) return this.journal.get(name) as T;
    const value = await action(); this.journal.set(name, value); return value;
  }
  set(_name: string, value: ManualLifecycleState | AutomaticLifecycleState) { this.state = value; }
  send(message: OutboundMessage) {
    if ((message.key.endsWith(':ack') && this.failAt === 'ack') ||
        (message.key.endsWith(':design-outcome') && this.failAt === 'outcome')) {
      this.failAt = null; throw new Error('crash before message send');
    }
    this.sent.push(message);
  }
  startDesign(input: DesignRunInput) {
    if (this.failAt === 'start') { this.failAt = null; throw new Error('crash before workflow send'); }
    this.started.push(input);
  }
  scheduleQuestionReminder(requestId: string, rev: number, questionId: string,
    day: 1 | 5, delayMs: number) {
    if (this.failAt === 'schedule') { this.failAt = null; throw new Error('crash before timer'); }
    this.scheduledQuestions.push({ requestId, rev, questionId, day, delayMs });
  }
  async now() { return this.nowValue; }
}

function automatic(): OpenAutomaticEvent {
  const requestId = randomUUID();
  const chatId = String(60_000_000 + Math.floor(Math.random() * 9_000_000));
  return { v: 1, eventId: `open:${requestId}`, requestId, tenantId, chatId,
    draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: chatId,
      rawText: 'Autumn workshop', title: 'Autumn workshop', designInstructions: 'Use the supplied copy',
      exactCopy: ['Autumn workshop'], clientId, autoGenerate: true, designStudio: true,
      variant: { width: 1080, height: 1350 } } };
}

function projected(e: OpenAutomaticEvent, taskId = randomUUID()) {
  return { v: 1, taskId, stage: 'designing', rev: 1, autoGenerate: true,
    design: { clientId, rawText: e.draft.rawText, sourcePlatform: 'telegram',
      variant: e.draft.variant, designStudio: true } };
}

describe('request-owned automatic design', () => {
  it('keeps an admitted outcome at the pause boundary, including a restart at its durable timer', async () => {
    const e=automatic(),ctx=new Context(e.requestId) as Context & {sleep:(ms:number)=>Promise<void>};
    const opened=projected(e);await openAutomaticRequest(ctx,coreInternalFixture(opened),e);
    const finish:DesignFinishedEvent={v:1,eventId:`dr-finished:dr-${opened.taskId}`,requestId:e.requestId,
      runId:`dr-${opened.taskId}`,round:0,taskId:opened.taskId,report:{status:'DESIGN_REJECTED',code:'COPY_REQUIRED'}};
    const core=coreInternalFixture({v:1,requestId:e.requestId,taskId:opened.taskId,rev:2,stage:'manual',
      status:'DESIGN_REJECTED',message:{text:'The office will follow up.',parseMode:'HTML'}});
    core.remote.mockResolvedValueOnce(Response.json({code:'TASK_PAUSED'},{status:409}));
    core.remote.mockResolvedValueOnce(Response.json({code:'TASK_PAUSED'},{status:409}));
    ctx.sleep=vi.fn(async()=>{throw new Error('synthetic process stop at saved pause timer');});
    await expect(recordDesignFinished(ctx,core,finish)).rejects.toThrow('synthetic process stop');
    expect(ctx.state).toMatchObject({stage:'designing',rev:1});
    expect(ctx.started).toHaveLength(1);expect(ctx.sent.filter(m=>m.key.endsWith(':design-outcome'))).toEqual([]);
    expect(core.remote).toHaveBeenCalledTimes(1);
    const sleeps:number[]=[];ctx.sleep=async ms=>{sleeps.push(ms);};
    expect(await recordDesignFinished(ctx,core,finish)).toMatchObject({stage:'manual',rev:2});
    expect(sleeps).toEqual([30_000,60_000]);expect(core.remote).toHaveBeenCalledTimes(3);
    const bodies=core.remote.mock.calls.map(call=>JSON.parse(String(call[1]?.body)));
    expect(bodies[1]).toEqual(bodies[0]);expect(bodies[2]).toEqual(bodies[0]);
    expect(ctx.started).toHaveLength(1);expect(ctx.sent.filter(m=>m.key.endsWith(':design-outcome'))).toHaveLength(1);
    await recordDesignFinished(ctx,core,finish);expect(core.remote).toHaveBeenCalledTimes(3);
  });

  it('starts one stable DesignRun from the persisted projection and can resume after the send boundary', async () => {
    const e = automatic(); const ctx = new Context(e.requestId);
    const answer = projected(e);
    const core = coreInternalFixture(answer);
    ctx.failAt = 'start';
    await expect(openAutomaticRequest(ctx, core, e)).rejects.toThrow('crash');
    expect(ctx.state).toMatchObject({ stage: 'designing', rev: 1, taskId: answer.taskId });
    const retry = await openAutomaticRequest(ctx, core, e);
    expect(retry).toMatchObject({ stage: 'designing', rev: 1 });
    expect(core.post).toHaveBeenCalledTimes(1);
    expect(ctx.started).toHaveLength(1);
    expect(ctx.started[0]).toMatchObject({ taskId: answer.taskId, clientId,
      canvaVariant: { width: 1080, height: 1350 }, designStudio: true,
      lifecycle: { requestId: e.requestId, round: 0, runId: `dr-${answer.taskId}` } });
    expect(ctx.sent.map((m) => m.key)).toEqual([`${e.requestId}:1:ack`, `${e.requestId}:1:ack`]);
    // ADR-145 (#10): plain words by the design's name, in the brief's language.
    expect(ctx.sent[0]).toMatchObject({ parseMode: 'HTML',
      text: "Got it. I'm making a first draft of <b>Autumn workshop</b>; the office checks it before you get it." });
  });

  it('accepts a Core daily-cap decline as a manual request without starting paid work', async () => {
    const e = automatic(); const ctx = new Context(e.requestId);
    const core = coreInternalFixture({ v: 1, taskId: randomUUID(),
      stage: 'manual', rev: 1, autoGenerate: false, autoGenerateDeclined: 'SENDER_DAILY_CAP' });
    expect(await openAutomaticRequest(ctx, core, e)).toMatchObject({ stage: 'manual', rev: 1 });
    expect(ctx.started).toEqual([]);
    expect(ctx.sent).toHaveLength(1);
    expect(await openAutomaticRequest(ctx, core, e)).toMatchObject({ stage: 'manual', rev: 1 });
    expect(core.post).toHaveBeenCalledTimes(1);
  });

  it('records a terminal report once, then replays its fenced message after a crash', async () => {
    const e = automatic(); const ctx = new Context(e.requestId); const answer = projected(e);
    await openAutomaticRequest(ctx, coreInternalFixture(answer), e);
    const finish: DesignFinishedEvent = { v: 1, eventId: `dr-finished:dr-${answer.taskId}`,
      requestId: e.requestId, runId: `dr-${answer.taskId}`, round: 0, taskId: answer.taskId,
      report: { status: 'DESIGN_REJECTED', code: 'COPY_REQUIRED' } };
    const core = coreInternalFixture({ v: 1, requestId: e.requestId, taskId: answer.taskId,
      rev: 2, stage: 'manual', status: 'DESIGN_REJECTED',
      message: { text: 'The office will follow up.', parseMode: 'HTML' },
      officeAlert: { chatId: '88880001', text: 'Task needs an operator.' } });
    ctx.failAt = 'outcome';
    await expect(recordDesignFinished(ctx, core, finish)).rejects.toThrow('crash');
    expect(ctx.state).toMatchObject({ stage: 'manual', rev: 2 });
    expect(await recordDesignFinished(ctx, core, finish)).toMatchObject({ stage: 'manual', rev: 2 });
    expect(core.post).toHaveBeenCalledTimes(1);
    expect(ctx.sent.find((m) => m.key === `${e.requestId}:2:design-outcome`)).toMatchObject({ text: 'The office will follow up.' });
    expect(ctx.sent.at(-1)).toMatchObject({ key: `${e.requestId}:2:office-alert`, text: 'Task needs an operator.' });
    await expect(recordDesignFinished(ctx, core, { ...finish, report: { status: 'DESIGN_FAILED' } })).rejects.toThrow('different content');
  });

  it('keeps a verified clarification question in request state across notice replay', async () => {
    const e = automatic(); const ctx = new Context(e.requestId); const opened = projected(e);
    await openAutomaticRequest(ctx, coreInternalFixture(opened), e);
    const questionId = randomUUID();
    const finish: DesignFinishedEvent = { v: 1, eventId: `dr-finished:dr-${opened.taskId}`,
      requestId: e.requestId, runId: `dr-${opened.taskId}`, round: 0, taskId: opened.taskId,
      report: { status: 'DESIGN_FAILED', code: 'NEEDS_CLARIFICATION', runId: questionId } };
    const core = coreInternalFixture({ v: 1, requestId: e.requestId,
      taskId: opened.taskId, rev: 2, stage: 'awaiting_answer', status: 'DESIGN_FAILED',
      question: { id: questionId, text: 'Bigger headline?', options: ['Yes', 'No'] },
      message: { text: '<b>Bigger headline?</b>', parseMode: 'HTML' } });
    ctx.failAt = 'outcome';
    await expect(recordDesignFinished(ctx, core, finish)).rejects.toThrow('crash');
    expect(ctx.state).toMatchObject({ stage: 'awaiting_answer', rev: 2,
      question: { id: questionId, taskId: opened.taskId, rev: 2 } });
    await recordDesignFinished(ctx, core, finish);
    expect(core.post).toHaveBeenCalledTimes(1);
    expect(ctx.sent.at(-1)).toMatchObject({ key: `${e.requestId}:2:design-outcome`, class: 'critical',
      onSent: { kind: 'question', requestId: e.requestId, requestRev: 2,
        taskId: opened.taskId, questionId } });
    expect(ctx.scheduledQuestions).toEqual([]);
    await recordDesignFinished(ctx, core, finish);
    expect(ctx.scheduledQuestions).toEqual([]);
    const sentAtMs = Date.parse('2026-09-25T18:30:00Z');
    const sent = { v: 1 as const, requestId: e.requestId, expectedRev: 2,
      taskId: opened.taskId, questionId, messageKey: `${e.requestId}:2:design-outcome`,
      messageId: '735' };
    const confirmed = coreInternalFixture({ v: 1, requestId: e.requestId,
      rev: 2, taskId: opened.taskId, questionId, messageId: '735', sentAtMs });
    ctx.failAt = 'schedule';
    await expect(recordQuestionSent(ctx, confirmed, sent)).rejects.toThrow('crash before timer');
    expect(ctx.state).toMatchObject({ question: { sentAtMs, messageId: '735' } });
    expect(ctx.scheduledQuestions).toEqual([]);
    expect(await recordQuestionSent(ctx, confirmed, sent)).toEqual({ recorded: true, sentAtMs });
    expect(confirmed.post).toHaveBeenCalledTimes(1);
    expect(ctx.scheduledQuestions).toMatchObject([
      { requestId: e.requestId, rev: 2, questionId, day: 1 },
      { requestId: e.requestId, rev: 2, questionId, day: 5 },
    ]);
    // 21:30 Erbil + 24 hours is outside office hours: wait until the following 09:00.
    expect(ctx.scheduledQuestions[0].delayMs)
      .toBe(Date.parse('2026-09-27T06:00:00Z') - ctx.nowValue);
    expect(ctx.scheduledQuestions[1].delayMs)
      .toBe(Date.parse('2026-10-01T06:00:00Z') - ctx.nowValue);
    expect(await recordReminderTick(ctx, { v: 1, requestId: e.requestId,
      expectedRev: 2, kind: 'question', questionId, day: 1 })).toEqual({ reminded: true });
    expect(ctx.sent.at(-1)).toMatchObject({ key: `${e.requestId}:2:question-reminder-1`,
      class: 'critical', parseMode: 'HTML',
      // ADR-145 (#12): by name, with its answers; no "reply to this message".
      text: '<b>Autumn workshop</b> is still waiting for one answer:\n\n<b>Bigger headline?</b>\n\n1. Yes\n2. No\n\nAnswer with a number or in your own words.' });
    expect(ctx.scheduledQuestions).toHaveLength(2);
    expect(await recordReminderTick(ctx, { v: 1, requestId: e.requestId,
      expectedRev: 2, kind: 'question', questionId, day: 5 })).toEqual({ reminded: true });
    expect(ctx.sent.at(-1)).toMatchObject({ key: `${e.requestId}:2:question-reminder-5` });
    ctx.state = { ...ctx.state as AutomaticLifecycleState, stage: 'designing', rev: 3,
      question: undefined };
    expect(await recordQuestionSent(ctx, confirmed, sent)).toEqual({ skipped: true });
    expect(confirmed.post).toHaveBeenCalledTimes(1);
    expect(await recordReminderTick(ctx, { v: 1, requestId: e.requestId,
      expectedRev: 2, kind: 'question', questionId, day: 5 })).toEqual({ skipped: true });
  });

  it('refuses a run with the wrong workflow key before any Core request', async () => {
    const taskId = randomUUID(); const requestId = randomUUID();
    const input: DesignRunInput = { v: 1, lifecycle: { requestId, round: 0, runId: `dr-${taskId}` },
      taskId, tenantId, clientId, rawText: 'Autumn workshop', sourcePlatform: 'telegram',
      idempotencyKey: `lifecycle:${requestId}:${taskId}`, canvaAutoGenerate: true };
    const remote = vi.fn();
    await expect(runOwnedDesign(input, `dr-${randomUUID()}`, new DurableStepJournal(), vi.fn(), remote)).rejects.toThrow('DESIGN_RUN_REFUSED');
    expect(remote).not.toHaveBeenCalled();
  });

  it('does not run or report a legacy task under a forged lifecycle identity', async () => {
    const taskId = randomUUID(); const requestId = randomUUID();
    const input: DesignRunInput = { v: 1, lifecycle: { requestId, round: 0, runId: `dr-${taskId}` },
      taskId, tenantId, clientId, rawText: 'Autumn workshop', sourcePlatform: 'telegram',
      idempotencyKey: `lifecycle:${requestId}:${taskId}`, canvaAutoGenerate: true };
    const remote = vi.fn(async () => Response.json({ tenantId, clientId, requestId: null }));
    const report = vi.fn();
    expect(validDesignRun(input, input.lifecycle.runId)).toBe(true);
    const result = await runOwnedDesign(input, input.lifecycle.runId, new DurableStepJournal(), report, remote);
    expect(result.status).toBe('LIFECYCLE_OWNER_MISMATCH');
    expect(remote).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it('reports an owned run to RequestLifecycle without posting the legacy outcome', async () => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    vi.stubEnv('HAWA_WORKER_TOKEN', ['worker', 'design', 'proof', 'fixture'].join('_'));
    const taskId = randomUUID(); const requestId = randomUUID();
    const input: DesignRunInput = { v: 1, lifecycle: { requestId, round: 0, runId: `dr-${taskId}` },
      taskId, tenantId, clientId, rawText: 'Autumn workshop', sourcePlatform: 'telegram',
      idempotencyKey: `lifecycle:${requestId}:${taskId}`, canvaAutoGenerate: true };
    const remote = vi.fn()
      .mockResolvedValueOnce(Response.json({ tenantId, clientId, requestId }))
      .mockResolvedValueOnce(Response.json({ title: 'COPY_UNSUPPORTED' }, { status: 422 }));
    const report = vi.fn();
    const result = await runOwnedDesign(input, input.lifecycle.runId, new DurableStepJournal(), report, remote);
    expect(result.status).toBe('DESIGN_REJECTED');
    expect(remote).toHaveBeenCalledTimes(2);
    expect(remote.mock.calls[1][1].headers).toMatchObject(lifecycleDesignProofHeaders({
      taskId, requestId, runId: input.lifecycle.runId, method: 'POST',
      path: `/v1/tasks/${taskId}/canva/generate`,
    }));
    expect(remote.mock.calls.some((call) => String(call[0]).includes('/notifications/'))).toBe(false);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ status: 'DESIGN_REJECTED', code: 'COPY_UNSUPPORTED' }));
  });
});
