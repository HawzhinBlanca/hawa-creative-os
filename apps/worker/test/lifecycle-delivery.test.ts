import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as restate from '@restatedev/restate-sdk';
import type { DeliveryInput, OutboundMessage, PreparedDelivery, SendResult } from '@hawa/contracts';
import { deliveryWorkflowId } from '@hawa/contracts';
import { runDelivery, type CoreInternal, type DeliveryContext } from '../src/lifecycle/delivery.js';

/**
 * The Delivery workflow's body (architecture programme Phase 2, slice 2.2; PHASE2_DESIGN.md 2.5):
 * prepare through Core, each approved file and then the notice through the chat's TelegramSender,
 * then the report. The TelegramSender is scripted per message key here; its own behaviour is in
 * lifecycle-telegram-sender.test.ts.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const OFFICE = '9000001';

function input(overrides: Partial<DeliveryInput> = {}): DeliveryInput {
  const taskId = randomUUID();
  const approvalId = randomUUID();
  return {
    v: 1, requestId: taskId, deliveryId: deliveryWorkflowId(taskId, approvalId), tenantId, taskId, approvalId, revisionId: randomUUID(),
    chatId: '7200001', officeChatId: OFFICE, reportTo: 'core', run: 1, ...overrides,
  };
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
  const ctx: DeliveryContext = {
    run: (name, action) => { steps.push(name); return action(); },
    send: async (m) => { sends.push(m); return options.answer ? options.answer(m) : { outcome: 'sent', messageId: String(sends.length) }; },
  };
  const core: CoreInternal = {
    async post<T>(path: string, body: unknown): Promise<T> {
      posts.push({ path, body });
      if (path.endsWith('/prepare')) return (await options.prepare()) as unknown as T;
      return { status: 'applied' } as unknown as T;
    },
  };
  return { ctx, core, sends, posts, steps };
}

describe('Delivery workflow', () => {
  it('refuses lifecycle reporting before any external effect while RequestLifecycle is unregistered', async () => {
    const i = input({ reportTo: 'lifecycle' });
    const h = harness({ prepare: async () => prepared(i.taskId, 1) });
    await expect(runDelivery(h.ctx, h.core, i)).rejects.toThrow(/LIFECYCLE_DELIVERY_NOT_AVAILABLE/);
    expect(h.posts).toEqual([]);
    expect(h.sends).toEqual([]);
    expect(h.steps).toEqual([]);
  });

  it('sends each approved file once, then the notice with the count, then reports delivered to Core', async () => {
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
    expect(h.steps).toEqual(['prepare', 'report']);
    expect(h.posts[0].path).toBe(`/internal/lifecycle/${i.requestId}/deliveries/${i.approvalId}/prepare`);
    expect(h.posts[1]).toEqual({
      path: `/internal/tasks/${i.taskId}/delivery-finished`,
      body: { tenantId, deliveryId: i.deliveryId, approvalId: i.approvalId, run: 1, outcome },
    });
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

  it('Core refuses the prepare step for good: nothing is sent to the requester, the office is told, and Core hears failed', async () => {
    const i = input();
    const h = harness({ prepare: async () => { throw new restate.TerminalError('Core answered HTTP 409 NOT_PUBLISHING', { errorCode: 409 }); } });
    const outcome = await runDelivery(h.ctx, h.core, i);
    expect(outcome).toMatchObject({ outcome: 'failed', filesSent: 0, archived: false });
    expect(outcome.reason).toMatch(/^PREPARE_FAILED/);
    expect(h.sends.map((s) => s.chatId)).toEqual([OFFICE]);
    expect(h.posts.at(-1)?.path).toBe(`/internal/tasks/${i.taskId}/delivery-finished`);
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
    const again = { ...i, deliveryId: deliveryWorkflowId(i.taskId, i.approvalId, 2), run: 2 };
    const files = prepared(i.taskId, 1);
    const first = harness({ prepare: async () => files });
    const second = harness({ prepare: async () => files });
    await runDelivery(first.ctx, first.core, i);
    await runDelivery(second.ctx, second.core, again);
    expect(second.sends.map((s) => s.key)).toEqual(first.sends.map((s) => s.key));
    expect(second.posts.at(-1)?.body).toMatchObject({ deliveryId: again.deliveryId, run: 2 });
  });
});
