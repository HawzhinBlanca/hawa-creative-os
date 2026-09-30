import { randomUUID } from 'node:crypto';
import * as restate from '@restatedev/restate-sdk';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryInput, DeliveryOutcome, OutboundMessage, PreparedDelivery, SendResult } from '@hawa/contracts';
import { deliveryWorkflowId } from '@hawa/contracts';
import { createDb } from '@hawa/db';
import { signLifecycleDeliveryClaim } from '@hawa/integrations';
import { DurableStepJournal } from '../src/durable-context.js';
import { DEPLOYMENT_FAULT_WAIT_MS } from '../src/canva-draft-workflow.js';
import { runOwnedDesign, type DesignRunInput } from '../src/lifecycle/design-run.js';
import { coreInternalFromEnv, runDelivery, type CoreInternal, type DeliveryContext } from '../src/lifecycle/delivery.js';
import {
  PROJECT_RETRY, openAutomaticRequest, recordDeliveryFinished, recordDesignFinished, recordRequesterDecision,
  type AutomaticLifecycleState, type AutomaticOpenContext, type LifecycleState, type OpenAutomaticEvent,
} from '../src/lifecycle/request-lifecycle.js';
import { handleSend, STUCK_ATTEMPTS, type SenderContext, type TelegramSenderDeps } from '../src/lifecycle/telegram-sender.js';

/**
 * ADR-155 (2026-09-30 audit, durability of the one request path). Each case failed on 6bd479c1:
 * a Core credential outage ended designs as DESIGN_REJECTED and lost the only report of a finished
 * design; a Core outage of more than 30 minutes lost a brief; a long delivery reason stranded a
 * request in `delivering`; office alerts reached one member (none for the owner's own requests); a
 * message that could not be sent held its chat's queue for hours; and the office list was read beside
 * the journal instead of in it.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const db = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => db.destroy());
afterEach(() => vi.unstubAllEnvs());

const problem = (status: number, title?: string) => title
  ? Response.json({ title }, { status })
  : new Response('404 Not Found', { status, headers: { 'content-type': 'text/plain' } });

function designInput(): DesignRunInput {
  const requestId = randomUUID();
  const taskId = randomUUID();
  return { v: 1, lifecycle: { requestId, round: 0, runId: `dr-${taskId}` }, taskId, tenantId, clientId,
    rawText: 'x', sourcePlatform: 'telegram', idempotencyKey: `lifecycle:${requestId}:${taskId}`, canvaAutoGenerate: true };
}

/** Like Restate: a step is tried `attempts` times, then ctx.run throws a TerminalError with its message. */
function restateLike(attempts = 3) {
  const steps: string[] = [];
  const sleeps: number[] = [];
  const ctx = {
    key: 'dr-contract',
    run: async <T>(name: string, action: () => Promise<T>): Promise<T> => {
      steps.push(name);
      let last: any;
      for (let i = 0; i < attempts; i++) {
        try { return await action(); } catch (err: any) {
          if (err?.terminal) throw new restate.TerminalError(err.message);
          last = err;
        }
      }
      throw new restate.TerminalError(`${last?.message || last}`);
    },
    sleep: async (ms: number) => { sleeps.push(ms); },
  };
  return { ctx, steps, sleeps };
}

describe('D1: a Core deployment fault inside a design is not the design\'s outcome', () => {
  it('a 401 on the task read is thrown to be retried, never reported as DESIGN_REJECTED', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const input = designInput();
    const reports: unknown[] = [];
    const remote = vi.fn<typeof fetch>(async () => problem(401, 'Authentication Required'));
    const outcome = await runOwnedDesign(input, input.lifecycle.runId, new DurableStepJournal(), (r) => reports.push(r), remote)
      .then((r) => r.status, (e) => `waiting: ${String(e?.message || e)}`);
    expect({ outcome, reports }).toMatchObject({ outcome: expect.stringMatching(/^waiting.*HTTP 401/), reports: [] });
  });

  it('waits out 401, 403 and an unknown route past each step\'s window, then carries on with the design', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    vi.stubEnv('HAWA_WORKER_TOKEN', 'test-only-worker-token');
    const input = designInput();
    const faults = [...Array(3).fill(401), ...Array(3).fill(403), ...Array(3).fill(404)];
    const remote = vi.fn<typeof fetch>(async (url, init) => {
      if ((init?.method || 'GET') === 'GET') {
        const fault = faults.shift();
        if (fault === 401) return problem(401, 'Authentication Required');
        if (fault === 403) return problem(403, 'CSRF Check Failed');
        if (fault === 404) return problem(404);
        return Response.json({ id: input.taskId, requestId: input.lifecycle.requestId, clientId, tenantId });
      }
      return problem(422, 'STOP_AFTER_SCOPE');
    });
    const { ctx, steps, sleeps } = restateLike();
    const reports: Array<{ status: string; code?: string }> = [];
    await runOwnedDesign(input, input.lifecycle.runId, ctx, (r) => reports.push(r), remote);
    expect(steps.slice(0, 4)).toEqual(['canva-verify-task-scope', 'canva-verify-task-scope-after-deployment-fault-1',
      'canva-verify-task-scope-after-deployment-fault-2', 'canva-verify-task-scope-after-deployment-fault-3']);
    expect(sleeps).toEqual([DEPLOYMENT_FAULT_WAIT_MS, DEPLOYMENT_FAULT_WAIT_MS, DEPLOYMENT_FAULT_WAIT_MS]);
    // The design went on past the scope check: its next step's own answer is what is reported.
    expect(reports).toEqual([expect.objectContaining({ status: 'DESIGN_REJECTED', code: 'STOP_AFTER_SCOPE' })]);
  });

  it('a 404 Core words as a problem (the task is not there) is still the design\'s refusal', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const input = designInput();
    const reports: Array<{ status: string; code?: string }> = [];
    await runOwnedDesign(input, input.lifecycle.runId, restateLike().ctx, (r) => reports.push(r),
      vi.fn<typeof fetch>(async () => problem(404, 'Task Not Found')));
    expect(reports).toEqual([expect.objectContaining({ status: 'DESIGN_REJECTED', code: 'TASK_NOT_FOUND' })]);
  });
});

/** A RequestLifecycle context whose steps run at once; sends and step names are recorded. */
function lifecycleContext(state: LifecycleState | null, key: string) {
  const sends: OutboundMessage[] = [];
  const steps: string[] = [];
  let current = state;
  const ctx: AutomaticOpenContext = {
    key, get: async () => current, run: (name, action) => { steps.push(name); return action(); },
    set: (_n, value) => { current = value; }, send: (m) => { sends.push(m); }, startDesign: () => {},
  };
  return { ctx, sends, steps, state: () => current };
}

function designingState(chatId = '7300001'): AutomaticLifecycleState {
  const input = designInput();
  return { v: 1, requestId: input.lifecycle.requestId, tenantId, chatId, owner: 'restate', stage: 'designing', rev: 1,
    taskId: input.taskId, openEventId: `open:${input.lifecycle.requestId}`, openSha256: 'x', runId: input.lifecycle.runId,
    designInput: input, lang: 'en', title: 'Autumn poster' };
}

const finished = (state: AutomaticLifecycleState, report: Record<string, unknown> = { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DA_audit' }) => ({
  v: 1 as const, eventId: `dr-finished:${state.runId}`, requestId: state.requestId, runId: state.runId, round: 0,
  taskId: state.taskId, report: report as { status: string },
});

describe('D2: the only report of a finished design or delivery stays pending until Core takes it', () => {
  it('Core\'s internal client asks again on 401, 403 and an unknown route; a worded 409 is final', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', 'test-only-worker-token');
    for (const answer of [problem(401, 'Authentication Required'), problem(403, 'Forbidden'), problem(404), problem(503, 'Down')]) {
      const error = await coreInternalFromEnv(vi.fn<typeof fetch>(async () => answer.clone())).post('/x', {}).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(restate.TerminalError);
    }
    const conflict = await coreInternalFromEnv(vi.fn<typeof fetch>(async () => Response.json({ code: 'WRONG_STAGE' }, { status: 409 })))
      .post('/x', {}).catch((e) => e);
    expect(conflict).toBeInstanceOf(restate.TerminalError);
  });

  it.each([
    ['refuses the worker credential', () => problem(401, 'Authentication Required')],
    ['answers a stale revision', () => Response.json({ code: 'STALE_REVISION' }, { status: 409 })],
    ['has lost the route', () => problem(404)],
  ])('designFinished keeps the outcome pending when Core %s', async (_what, answer) => {
    vi.stubEnv('HAWA_WORKER_TOKEN', 'test-only-worker-token');
    const state = designingState();
    const h = lifecycleContext(state, state.requestId);
    const error = await recordDesignFinished(h.ctx, coreInternalFromEnv(vi.fn<typeof fetch>(async () => answer())), finished(state))
      .then(() => null, (e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error?.name).not.toBe('TerminalError');
    expect(h.sends).toEqual([]);
    expect(h.state()).toMatchObject({ stage: 'designing', rev: 1 });
  });

  it('a genuine idempotency conflict ends it, and every office member and the requester hear of it', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', 'test-only-worker-token');
    const state = designingState('7300002');
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', '7300002, 9100002');
    const h = lifecycleContext(state, state.requestId);
    const core = coreInternalFromEnv(vi.fn<typeof fetch>(async () => Response.json({ code: 'IDEMPOTENCY_CONFLICT' }, { status: 409 })));
    await expect(recordDesignFinished(h.ctx, core, finished(state))).rejects.toBeInstanceOf(restate.TerminalError);
    expect(h.steps).toContain(`office-chats:design-finished:${state.runId}`);
    const office = h.sends.filter((m) => /failed-alert/.test(m.key));
    expect(office.map((m) => m.chatId)).toEqual(['7300002', '9100002']);
    expect(office[0].text).toContain(state.taskId);
    expect(office[0].text).toContain('IDEMPOTENCY_CONFLICT');
    const told = h.sends.filter((m) => /failed-notice/.test(m.key));
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ chatId: '7300002', parseMode: 'HTML' });
    expect(told[0].text).toContain("I couldn't finish saving it");
  });

  it('deliveryFinished keeps a 503 pending, and alerts every office member on an idempotency conflict', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', 'test-only-worker-token');
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', '9100003,9100004');
    const base = designingState('7300003');
    const approvalId = randomUUID();
    const deliveryId = deliveryWorkflowId(base.taskId, approvalId);
    const deliveryInput: DeliveryInput = { v: 1, requestId: base.requestId, deliveryId, tenantId, taskId: base.taskId, approvalId,
      revisionId: randomUUID(), chatId: base.chatId, officeChatId: '9100003', reportTo: 'lifecycle', requestRev: 4, run: 1 };
    const state: AutomaticLifecycleState = { ...base, stage: 'delivering', rev: 4,
      delivery: { startEventId: 'desk:x', startSha256: 'y', actionId: randomUUID(), input: deliveryInput } };
    const event = { v: 1 as const, eventId: `delivery:${deliveryId}`, requestId: base.requestId, taskId: base.taskId, approvalId,
      deliveryId, run: 1, expectedRev: 4,
      outcome: { outcome: 'delivered', uncertain: [], sheetsConfirmed: true, archived: true, filesSent: 1 } as DeliveryOutcome };
    const down = lifecycleContext(state, base.requestId);
    const pending = await recordDeliveryFinished(down.ctx, coreInternalFromEnv(vi.fn<typeof fetch>(async () => problem(503, 'Down'))), event)
      .then(() => null, (e) => e);
    expect(pending?.name).not.toBe('TerminalError');
    expect(down.sends).toEqual([]);
    const refused = lifecycleContext(state, base.requestId);
    await expect(recordDeliveryFinished(refused.ctx,
      coreInternalFromEnv(vi.fn<typeof fetch>(async () => Response.json({ code: 'IDEMPOTENCY_CONFLICT' }, { status: 409 }))), event))
      .rejects.toBeInstanceOf(restate.TerminalError);
    expect(refused.sends.map((m) => m.chatId)).toEqual(['9100003', '9100004']);
    expect(refused.sends[0].text).toContain('record how the delivery ended');
  });
});

describe('D3: a long Core outage pauses a request, and a refusal for good is never silent', () => {
  it('the projection steps have no retry limit of their own (the invocation pauses instead)', () => {
    expect(PROJECT_RETRY).not.toHaveProperty('maxRetryDuration');
    expect(PROJECT_RETRY).not.toHaveProperty('maxRetryAttempts');
  });

  it('a brief Core refuses to open reaches the office in the requester\'s words, and the requester hears the truth', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', 'test-only-worker-token');
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', '9100005');
    const requestId = randomUUID();
    const chatId = '7300005';
    const event: OpenAutomaticEvent = { v: 1, eventId: `open:${requestId}`, requestId, tenantId, chatId,
      draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: chatId,
        rawText: 'Poster for the spring fair, 12 May', title: 'Spring fair poster', designInstructions: '',
        exactCopy: [], clientId, autoGenerate: true } };
    const h = lifecycleContext(null, requestId);
    const core = coreInternalFromEnv(vi.fn<typeof fetch>(async () => Response.json({ code: 'IDEMPOTENCY_CONFLICT' }, { status: 409 })));
    await expect(openAutomaticRequest(h.ctx, core, event)).rejects.toBeInstanceOf(restate.TerminalError);
    const office = h.sends.find((m) => m.chatId === '9100005')!;
    expect(office.text).toContain('Poster for the spring fair, 12 May');
    expect(office.text).toContain(requestId);
    const told = h.sends.find((m) => m.chatId === chatId)!;
    expect(told.key).toBe(`${requestId}:open:failed-notice`);
    expect(told.text).toContain("I couldn't start your design request");
    expect(h.sends.some((m) => m.key.endsWith(':ack'))).toBe(false);
  });
});

describe('D3: a requester\'s change Core refuses for good is passed to the office, not lost', () => {
  it('the office gets the requester\'s words, and the requester is told the office has the change', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', 'test-only-worker-token');
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', '9100008');
    const state: AutomaticLifecycleState = { ...designingState('7300008'), stage: 'manual', rev: 3 };
    const h = lifecycleContext(state, state.requestId);
    const core = coreInternalFromEnv(vi.fn<typeof fetch>(async () => Response.json({ code: 'IDEMPOTENCY_CONFLICT' }, { status: 409 })));
    await expect(recordRequesterDecision(h.ctx, core, { v: 1, eventId: `desk-change:${randomUUID()}`, requestId: state.requestId,
      round: 1, directive: 'Make the date bigger', priorTaskId: state.taskId, newTaskId: randomUUID() } as never))
      .rejects.toBeInstanceOf(restate.TerminalError);
    expect(h.sends.find((m) => m.chatId === '9100008')?.text).toContain('Make the date bigger');
    expect(h.sends.find((m) => m.chatId === '7300008')?.text).toContain("I've passed your change to the office");
    expect(h.state()).toMatchObject({ stage: 'manual', rev: 3 });
  });
});

const WORKER_TOKEN = ['durability', 'worker', 'token'].join('_');
function deliveryInput(overrides: Partial<DeliveryInput> = {}): DeliveryInput {
  const taskId = randomUUID();
  const approvalId = randomUUID();
  const unsigned: DeliveryInput = { v: 1, requestId: randomUUID(), deliveryId: deliveryWorkflowId(taskId, approvalId), tenantId, taskId,
    approvalId, revisionId: randomUUID(), chatId: '7200009', officeChatId: '9000009', reportTo: 'lifecycle', requestRev: 4, run: 1, ...overrides };
  const { claimSignature: _none, ...claim } = unsigned;
  return { ...claim, claimSignature: signLifecycleDeliveryClaim(WORKER_TOKEN, claim) };
}
function preparedFor(i: DeliveryInput, files: number, name = (n: number) => `file-${n}.png`): PreparedDelivery {
  const list = Array.from({ length: files }, (_, n) => ({ artifactId: randomUUID(), filename: name(n), sha256: 'a'.repeat(64) }));
  return { ok: true, taskId: i.taskId, publicationKey: `pub_${i.taskId}`, chatId: i.chatId!, title: 'Poster', files: list,
    chatOnly: false, archived: true, sheetsConfirmed: true,
    notice: { title: 'Poster', files: list, driveFolderId: 'folder', spreadsheetId: 'sheet', sheetsConfirmed: true, sheetRowNumber: 7, sheetProblem: null } } as PreparedDelivery;
}
/** A Delivery context with a journal: a step recorded once is answered from it on a replay. */
function deliveryContext(answer: (m: OutboundMessage) => SendResult, journal = new Map<string, unknown>()) {
  const sends: OutboundMessage[] = [];
  const steps: string[] = [];
  const reports: DeliveryOutcome[] = [];
  const ctx: DeliveryContext = {
    run: async (name, action) => {
      steps.push(name);
      if (journal.has(name)) return journal.get(name) as never;
      const value = await action();
      journal.set(name, value);
      return value;
    },
    send: async (m) => { sends.push(m); return answer(m); },
    reportLifecycle: async (_i, outcome) => { reports.push(outcome); },
  };
  return { ctx, sends, steps, reports, journal };
}
const coreFor = (prepared: () => PreparedDelivery): CoreInternal => ({ post: async <T>() => prepared() as unknown as T });

describe('D4: a delivery cannot strand its request in `delivering`', () => {
  it('a long refusal reason and many uncertain names are cut to what Core accepts', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER_TOKEN);
    const i = deliveryInput();
    const refused = deliveryContext((m) => (m.kind === 'document'
      ? { outcome: 'refused', error: `TELEGRAM_DOCUMENT_REJECTED_400: ${'Bad Request: file is not acceptable '.repeat(8)}` } : { outcome: 'sent' }));
    const failed = await runDelivery(refused.ctx, coreFor(() => preparedFor(i, 60)), i);
    expect(failed.outcome).toBe('failed');
    expect(failed.reason!.length).toBeLessThanOrEqual(2000);
    expect(failed.reason).toMatch(/^TELEGRAM_REFUSED: /);
    const j = deliveryInput();
    const unsure = deliveryContext((m) => (m.kind === 'document' ? { outcome: 'uncertain', error: 'TELEGRAM_DELIVERY_UNCERTAIN' } : { outcome: 'sent' }));
    const uncertain = await runDelivery(unsure.ctx, coreFor(() => preparedFor(j, 60, (n) => `${'long-name-'.repeat(70)}${n}.png`)), j);
    expect(uncertain.uncertain.length).toBeLessThanOrEqual(50);
    expect(uncertain.uncertain.every((name) => name.length <= 500)).toBe(true);
  });

  it('the claim verdict is journaled: a replay after the worker token rotated still finishes the delivery', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER_TOKEN);
    const i = deliveryInput();
    const first = deliveryContext(() => ({ outcome: 'sent' }));
    await runDelivery(first.ctx, coreFor(() => preparedFor(i, 1)), i);
    expect(first.steps[0]).toBe('verify-claim');
    vi.stubEnv('HAWA_WORKER_TOKEN', 'rotated-away');
    vi.stubEnv('HAWA_WORKER_TOKEN_PREVIOUS', '');
    const replay = deliveryContext(() => ({ outcome: 'sent' }), first.journal);
    await expect(runDelivery(replay.ctx, coreFor(() => preparedFor(i, 1)), i)).resolves.toMatchObject({ outcome: 'delivered' });
  });
});

describe('D5 and D9: every office member hears a failed delivery, from a journaled list', () => {
  it('the signed office chat, then every member, the requester too when they are one', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER_TOKEN);
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', '7200009,9000010');
    const i = deliveryInput();
    const h = deliveryContext((m) => (m.kind === 'document' ? { outcome: 'refused', error: 'TELEGRAM_DOCUMENT_REJECTED_403' } : { outcome: 'sent' }));
    await runDelivery(h.ctx, coreFor(() => preparedFor(i, 1)), i);
    const alerts = h.sends.filter((m) => /failed-alert/.test(m.key));
    expect(alerts.map((m) => [m.chatId, m.key])).toEqual([
      ['9000009', `${i.deliveryId}:failed-alert`],
      ['7200009', `${i.deliveryId}:failed-alert:7200009`],
      ['9000010', `${i.deliveryId}:failed-alert:9000010`],
    ]);
    expect(h.steps).toContain('office-chats');
  });

  it('a replay alerts the members journaled, not the ones configured since', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER_TOKEN);
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', '9000011');
    const i = deliveryInput({ officeChatId: null });
    const journal = new Map<string, unknown>([['office-chats', ['9000012']]]);
    const h = deliveryContext((m) => (m.kind === 'document' ? { outcome: 'refused', error: 'TELEGRAM_DOCUMENT_REJECTED_403' } : { outcome: 'sent' }), journal);
    await runDelivery(h.ctx, coreFor(() => preparedFor(i, 1)), i);
    expect(h.sends.filter((m) => /failed-alert/.test(m.key)).map((m) => m.chatId)).toEqual(['9000012']);
  });

  it('a design outcome alert reaches every member Core names', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', 'test-only-worker-token');
    const state = designingState('7300006');
    const h = lifecycleContext(state, state.requestId);
    const alert = (chatId: string) => ({ chatId, text: `Automatic design needs an operator in Hawa Desk. Task ${state.taskId}.` });
    const core = coreInternalFromEnv(vi.fn<typeof fetch>(async () => Response.json({ v: 1, requestId: state.requestId, taskId: state.taskId,
      rev: 2, stage: 'manual', status: 'DESIGN_FAILED', officeAlert: alert('7300006'), officeAlerts: [alert('7300006'), alert('9100006')] })));
    await recordDesignFinished(h.ctx, core, finished(state, { status: 'DESIGN_FAILED', code: 'STUDIO_FAILED' }));
    expect(h.sends.map((m) => [m.chatId, m.key])).toEqual([
      ['7300006', `${state.requestId}:2:office-alert`],
      ['9100006', `${state.requestId}:2:office-alert:9100006`],
    ]);
  });
});

describe('D6 and D9: a message that cannot be sent gives way after a bounded number of attempts', () => {
  const OFFICE = ['9200001', '9200002'];
  function deps(answer: () => { success: boolean; error?: string; messageId?: string }, files: Record<string, Uint8Array | null> = {}): TelegramSenderDeps {
    return {
      db, botToken: () => 'test-bot-token',
      bridge: () => ({ dispatchOutboundMessage: async () => answer(), dispatchOutboundDocument: async () => answer() }) as never,
      readExportBytes: async (_trx, _tenant, _task, artifactId) => files[artifactId] ?? null,
      officeChatIds: () => OFFICE, markRetryDelaysMs: [1],
    };
  }
  function context(journal = new Map<string, unknown>()) {
    const steps: string[] = [];
    const sleeps: number[] = [];
    const forwarded: OutboundMessage[] = [];
    const ctx: SenderContext = {
      run: async (name, action) => {
        steps.push(name);
        if (journal.has(name)) return journal.get(name) as never;
        const value = await action();
        journal.set(name, value);
        return value;
      },
      sleep: async (ms) => { sleeps.push(ms); },
      sendTo: (m) => { forwarded.push(m); },
    };
    return { ctx, steps, sleeps, forwarded };
  }
  const message = (chatId = '9200001'): OutboundMessage => ({ v: 1, key: `durability:${randomUUID()}`, chatId, kind: 'text',
    text: 'Hello', class: 'critical', tenantId, taskId: randomUUID() });

  it('a refusal this sender does not know is answered refused after its attempts, and the other members are alerted', async () => {
    const h = context();
    const m = message('9200001');
    const result = await handleSend(h.ctx, deps(() => ({ success: false, error: 'TELEGRAM_SOMETHING_NEW' })), m);
    expect(result).toMatchObject({ outcome: 'refused', error: expect.stringContaining(`not sent after ${STUCK_ATTEMPTS} attempts`) });
    expect(h.steps.filter((s) => /^send(-\d+)?$/.test(s))).toHaveLength(STUCK_ATTEMPTS);
    expect(h.sleeps).toEqual([5000, 10000, 20000, 40000, 80000, 160000, 300000]);
    expect(h.forwarded.map((a) => [a.chatId, a.key])).toEqual([['9200002', `${m.key}:stuck-alert`]]);
    expect(h.forwarded[0].text).toContain(m.taskId!);
  });

  it('an approved file that cannot be read gives way the same way', async () => {
    const h = context();
    const artifactId = randomUUID();
    const m: OutboundMessage = { v: 1, key: `dl-durability:file:${artifactId}`, chatId: '7400001', kind: 'document', filename: 'final.png',
      class: 'critical', tenantId, taskId: randomUUID(), exportRef: { tenantId, taskId: randomUUID(), artifactId, sha256: 'a'.repeat(64) } };
    const result = await handleSend(h.ctx, deps(() => ({ success: true, messageId: '1' })), m);
    expect(result.outcome).toBe('refused');
    expect(h.forwarded.map((a) => a.chatId)).toEqual(OFFICE);
    expect(h.forwarded[0].text).toContain('final.png');
  });

  it('the office list is read in a journaled step, and a replay alerts the members journaled', async () => {
    const h = context(new Map<string, unknown>([['office-chats', ['9200009']]]));
    await handleSend(h.ctx, deps(() => ({ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' })), message('7400002'));
    expect(h.steps).toContain('office-chats');
    expect(h.forwarded.map((a) => a.chatId)).toEqual(['9200009']);
  });
});
