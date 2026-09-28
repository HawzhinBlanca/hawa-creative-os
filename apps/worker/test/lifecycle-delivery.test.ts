import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as restate from '@restatedev/restate-sdk';
import type { DeliveryInput, DeliveryOutcome, OutboundMessage, PreparedDelivery, SendResult } from '@hawa/contracts';
import { deliveryWorkflowId } from '@hawa/contracts';
import { signLifecycleDeliveryClaim } from '@hawa/integrations';
import { runDelivery, type CoreInternal, type DeliveryContext } from '../src/lifecycle/delivery.js';

/**
 * The Delivery workflow's body (architecture programme Phase 2, slice 2.2; PHASE2_DESIGN.md 2.5):
 * prepare through Core, each approved file and then the notice through the chat's TelegramSender,
 * then the report to the request's RequestLifecycle owner. The TelegramSender is scripted per message
 * key here; its own behaviour is in lifecycle-telegram-sender.test.ts. Since stage 2 of ADR-135 every
 * run is request-owned and signed: the report to Core (reportTo 'core') is gone.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const OFFICE = '9000001';

const WORKER_TOKEN = ['delivery', 'unit', 'worker', 'token'].join('_');
const priorToken = process.env.HAWA_WORKER_TOKEN;
beforeAll(() => { process.env.HAWA_WORKER_TOKEN = WORKER_TOKEN; });
afterAll(() => {
  if (priorToken === undefined) delete process.env.HAWA_WORKER_TOKEN;
  else process.env.HAWA_WORKER_TOKEN = priorToken;
});

/** A request-owned run with Core's signature over the claim, as RequestLifecycle starts one. */
function signed(unsigned: DeliveryInput): DeliveryInput {
  const { claimSignature: _old, ...claim } = unsigned;
  return { ...claim, claimSignature: signLifecycleDeliveryClaim(WORKER_TOKEN, claim) };
}

function input(overrides: Partial<DeliveryInput> = {}): DeliveryInput {
  const taskId = randomUUID();
  const approvalId = randomUUID();
  return signed({
    v: 1, requestId: randomUUID(), deliveryId: deliveryWorkflowId(taskId, approvalId), tenantId, taskId, approvalId, revisionId: randomUUID(),
    chatId: '7200001', officeChatId: OFFICE, reportTo: 'lifecycle', requestRev: 4, run: 1, ...overrides,
  });
}

function prepared(taskId: string, files: number, overrides: Partial<PreparedDelivery> = {}): PreparedDelivery {
  const list = Array.from({ length: files }, (_, i) => ({
    artifactId: randomUUID(), format: i === 0 ? 'png' : 'pptx', filename: `kaae-${i}.${i === 0 ? 'png' : 'pptx'}`, sha256: 'a'.repeat(64), byteSize: 10,
    webViewLink: `https://drive.google.com/file/d/f${i}/view`,
  }));
  return {
    ok: true, taskId, publicationKey: `pub_key_${taskId}_x`, chatId: '7200001', title: 'KAAE ceremony', files: list,
    chatOnly: false, archived: true, sheetsConfirmed: true,
    notice: { title: 'KAAE ceremony', files: list, driveFolderId: 'folder', spreadsheetId: 'sheet', sheetsConfirmed: true, sheetRowNumber: 7, sheetProblem: null },
    ...overrides,
  };
}

/** A workflow context that runs steps at once, answers sends from a script, and records both. */
function harness(options: { prepare: () => Promise<PreparedDelivery>; answer?: (m: OutboundMessage) => SendResult }) {
  const sends: OutboundMessage[] = [];
  const posts: Array<{ path: string; body: any }> = [];
  const steps: string[] = [];
  const reports: Array<{ input: DeliveryInput; outcome: DeliveryOutcome }> = [];
  const ctx: DeliveryContext = {
    run: (name, action) => { steps.push(name); return action(); },
    send: async (m) => { sends.push(m); return options.answer ? options.answer(m) : { outcome: 'sent', messageId: String(sends.length) }; },
    reportLifecycle: async (report, outcome) => { reports.push({ input: report, outcome }); },
  };
  const core: CoreInternal = {
    async post<T>(path: string, body: unknown): Promise<T> {
      posts.push({ path, body });
      if (path.endsWith('/prepare')) return (await options.prepare()) as unknown as T;
      return { status: 'applied' } as unknown as T;
    },
  };
  return { ctx, core, sends, posts, steps, reports };
}

describe('Delivery workflow', () => {
  it('refuses lifecycle reporting before any external effect without a private request owner', async () => {
    const i = input();
    const h = harness({ prepare: async () => prepared(i.taskId, 1) });
    delete h.ctx.reportLifecycle;
    await expect(runDelivery(h.ctx, h.core, i)).rejects.toThrow(/LIFECYCLE_DELIVERY_NOT_AVAILABLE/);
    expect(h.posts).toEqual([]);
    expect(h.sends).toEqual([]);
    expect(h.steps).toEqual([]);
  });

  it('refuses a run that would report to Core (removed by stage 2 of ADR-135) before any external effect', async () => {
    const i = { ...input(), reportTo: 'core' as const };
    const h = harness({ prepare: async () => prepared(i.taskId, 1) });
    await expect(runDelivery(h.ctx, h.core, i)).rejects.toThrow(/INVALID_LIFECYCLE_DELIVERY_CLAIM|INVALID_DELIVERY_REPORT_TARGET/);
    expect(h.posts).toEqual([]);
    expect(h.sends).toEqual([]);
    const { claimSignature: _unused, ...unsigned } = input();
    const unsignedCore = { ...unsigned, reportTo: 'core' as const };
    await expect(runDelivery(h.ctx, h.core, unsignedCore)).rejects.toThrow(/INVALID_DELIVERY_REPORT_TARGET/);
    expect(h.sends).toEqual([]);
  });

  it('keeps a signed request-owned outcome pending when its private owner refuses the report', async () => {
    const i = input();
    const h = harness({ prepare: async () => prepared(i.taskId, 1) });
    h.ctx.reportLifecycle = async () => { throw new restate.TerminalError('Core refused stale report', { errorCode: 409 }); };
    await expect(runDelivery(h.ctx, h.core, i)).rejects.toThrow('Core refused stale report');
    expect(h.steps).toEqual(['prepare']);
    expect(h.posts).toHaveLength(1);
    expect(h.sends.filter((m) => m.chatId === i.chatId)).toHaveLength(2);
  });

  it('sends each approved file once, then the notice with the count, then reports delivered to the request owner', async () => {
    const i = input();
    const h = harness({ prepare: async () => prepared(i.taskId, 2) });
    const outcome = await runDelivery(h.ctx, h.core, i);
    expect(outcome).toEqual({ outcome: 'delivered', uncertain: [], sheetsConfirmed: true, archived: true, filesSent: 2 });
    expect(h.sends.map((s) => s.kind)).toEqual(['document', 'document', 'text']);
    // Keys are the publication's, so a later run of the same publication never sends a file again.
    const base = deliveryWorkflowId(i.taskId, i.approvalId);
    expect(h.sends.map((s) => s.key)).toEqual([`${base}:file:${h.sends[0].exportRef!.artifactId}`, `${base}:file:${h.sends[1].exportRef!.artifactId}`, `${base}:notice`]);
    expect(h.sends.every((s) => s.class === 'critical' && s.chatId === '7200001')).toBe(true);
    expect(h.sends[2].text).toContain('The 2 approved files are attached above.');
    expect(h.sends[2].text).toContain('Your approved design has been delivered.');
    expect(h.steps).toEqual(['prepare']);
    expect(h.posts.map((p) => p.path)).toEqual([`/internal/lifecycle/${i.requestId}/deliveries/${i.approvalId}/prepare`]);
    expect(h.reports).toEqual([{ input: i, outcome }]);
  });

  it('a file Telegram may not have taken: the notice says so with the counts, and the outcome is uncertain', async () => {
    const i = input();
    const h = harness({
      prepare: async () => prepared(i.taskId, 2),
      answer: (m) => (m.kind === 'document' && m.filename === 'kaae-1.pptx' ? { outcome: 'uncertain', error: 'TELEGRAM_DELIVERY_UNCERTAIN' } : { outcome: 'sent' }),
    });
    const outcome = await runDelivery(h.ctx, h.core, i);
    expect(outcome).toMatchObject({ outcome: 'uncertain', uncertain: ['kaae-1.pptx'], filesSent: 1 });
    const notice = h.sends.find((s) => s.kind === 'text')!;
    expect(notice.text).toContain('Telegram did not confirm that it arrived');
    expect(notice.text).toContain('The approved file is attached above.');
    expect(notice.text).toContain('The office will check that the approved file reached you');
    // The office hears of it from TelegramSender (per message), not a second time from here.
    expect(h.sends.filter((s) => s.chatId === OFFICE)).toEqual([]);
  });

  it('a file Telegram refused: no notice, the delivery failed, and the office is told once', async () => {
    const i = input();
    const h = harness({
      prepare: async () => prepared(i.taskId, 1),
      answer: (m) => (m.kind === 'document' ? { outcome: 'refused', error: 'TELEGRAM_DOCUMENT_REJECTED_403' } : { outcome: 'sent' }),
    });
    const outcome = await runDelivery(h.ctx, h.core, i);
    expect(outcome.outcome).toBe('failed');
    expect(outcome.reason).toContain('TELEGRAM_DOCUMENT_REJECTED_403');
    expect(h.sends.filter((s) => s.chatId === '7200001').map((s) => s.kind)).toEqual(['document']);
    const alerts = h.sends.filter((s) => s.chatId === OFFICE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ key: `${i.deliveryId}:failed-alert`, class: 'critical' });
    expect(alerts[0].text).toContain(i.taskId);
  });

  it('never calls an archive-only result delivered when no requester chat or approved file can be sent', async () => {
    for (const change of [{ chatId: null }, { files: [] }]) {
      const i = input({ chatId: null });
      const h = harness({ prepare: async () => prepared(i.taskId, 1, change) });
      const outcome = await runDelivery(h.ctx, h.core, i);
      expect(outcome).toMatchObject({ outcome: 'failed', archived: true, sheetsConfirmed: true, filesSent: 0 });
      expect(h.reports.at(-1)?.outcome).toEqual(outcome);
    }
  });

  it('Core refuses the prepare step for good: nothing is sent to the requester, the office is told, and the owner hears failed', async () => {
    const i = input();
    const h = harness({ prepare: async () => { throw new restate.TerminalError('Core answered HTTP 409 NOT_PUBLISHING', { errorCode: 409 }); } });
    const outcome = await runDelivery(h.ctx, h.core, i);
    expect(outcome).toMatchObject({ outcome: 'failed', filesSent: 0, archived: false });
    expect(outcome.reason).toMatch(/^PREPARE_FAILED/);
    expect(h.sends.map((s) => s.chatId)).toEqual([OFFICE]);
    expect(h.reports.map((r) => r.outcome.outcome)).toEqual(['failed']);
  });

  it('a task Core has delivered already: nothing is sent and nobody is alerted', async () => {
    const i = input();
    const h = harness({ prepare: async () => { throw new restate.TerminalError(`Core answered HTTP 409 DELIVERY_ALREADY_COMPLETE for /internal/...`, { errorCode: 409 }); } });
    const outcome = await runDelivery(h.ctx, h.core, i);
    expect(outcome).toMatchObject({ outcome: 'delivered', filesSent: 0, archived: true, sheetsConfirmed: true });
    expect(h.sends).toEqual([]);
  });

  it('Core not answering the prepare step is not a failure: the error reaches Restate, which asks again', async () => {
    const i = input();
    const h = harness({ prepare: async () => { throw new Error('Core answered HTTP 503'); } });
    await expect(runDelivery(h.ctx, h.core, i)).rejects.toThrow(/503/);
    expect(h.sends).toEqual([]);
  });

  it('Drive refused (chat only): the files still go to the requester and the outcome says chat_only', async () => {
    const i = input();
    const h = harness({
      prepare: async () => {
        const p = prepared(i.taskId, 1, { chatOnly: true, archived: false, sheetsConfirmed: false });
        return { ...p, notice: { ...p.notice, archiveProblem: 'the office Google account is not connected', sheetsConfirmed: false } };
      },
    });
    const outcome = await runDelivery(h.ctx, h.core, i);
    expect(outcome).toMatchObject({ outcome: 'chat_only', archived: false, filesSent: 1 });
    expect(h.sends.find((s) => s.kind === 'text')!.text).toContain('Office archive: not saved to Google Drive yet');
  });

  it('a later run of the same publication (the archive retried) sends under the same keys as the first', async () => {
    const i = input();
    const again = signed({ ...i, deliveryId: deliveryWorkflowId(i.taskId, i.approvalId, 2), run: 2 });
    const files = prepared(i.taskId, 1);
    const first = harness({ prepare: async () => files });
    const second = harness({ prepare: async () => files });
    await runDelivery(first.ctx, first.core, i);
    await runDelivery(second.ctx, second.core, again);
    expect(second.sends.map((s) => s.key)).toEqual(first.sends.map((s) => s.key));
    expect(second.reports.at(-1)?.input).toMatchObject({ deliveryId: again.deliveryId, run: 2 });
  });
});
