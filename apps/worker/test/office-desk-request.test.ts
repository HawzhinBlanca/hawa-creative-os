/**
 * ADR-287: a Desk "New task" Core opened reaches RequestLifecycle through the worker's outbox and
 * OfficeDecisionGateway, and nothing is ever sent to its Desk channel.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DeliveryInput, OutboundMessage, PreparedDelivery } from '@hawa/contracts';
import { deliveryWorkflowId } from '@hawa/contracts';
import { signLifecycleDeliveryClaim, signLifecycleOfficeEvent } from '@hawa/integrations';
import { TaskWorkflowDispatcher } from '../src/workflow-dispatcher.js';
import { OutboxConsumer, type OutboxCommandRecord } from '../src/outbox-consumer.js';
import { checkSignedDeskOpen } from '../src/lifecycle/office-decision-gateway.js';
import { isDeskChannel } from '../src/lifecycle/telegram-sender.js';
import { openAutomaticRequest, type AutomaticOpenContext, type LifecycleState, type OpenAutomaticEvent } from '../src/lifecycle/request-lifecycle.js';
import type { DesignRunInput } from '../src/lifecycle/design-run.js';
import { runDelivery, type CoreInternal, type DeliveryContext } from '../src/lifecycle/delivery.js';
import { coreInternalFixture } from './core-internal-fixture.js';

const tenantId = '00000000-0000-4000-a000-000000000001';
const secret = ['desk', 'open', 'worker', 'fixture'].join('_');
const prior = process.env.HAWA_WORKER_TOKEN;
beforeAll(() => { process.env.HAWA_WORKER_TOKEN = secret; });
afterEach(() => vi.unstubAllEnvs());
afterAll(() => { if (prior === undefined) delete process.env.HAWA_WORKER_TOKEN; else process.env.HAWA_WORKER_TOKEN = prior; });

function openEvent(autoGenerate = true): OpenAutomaticEvent {
  const requestId = randomUUID(), chatId = `desk:${randomUUID()}`;
  return { v: 1, eventId: `open:${requestId}`, requestId, tenantId, chatId,
    draft: { platform: 'hawa_desk', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: chatId, rawText: 'Members evening',
      title: 'Members evening', designInstructions: 'Navy and gold.', exactCopy: [{ text: 'Members evening', language: 'en' }],
      clientId: randomUUID(), autoGenerate: autoGenerate as true, designStudio: true, variant: { width: 1080, height: 1080 } } };
}

function command(event = openEvent()): OutboxCommandRecord {
  return { id: randomUUID(), tenant_id: tenantId, aggregate_id: event.requestId, aggregate_type: 'request',
    command_type: 'office.request.open', idempotency_key: `office-open:${randomUUID()}`,
    payload: { v: 1, requestId: event.requestId, taskId: randomUUID(), event }, state: 'leased', attempts: 1 } as OutboxCommandRecord;
}

describe('a Desk request reaches its RequestLifecycle (ADR-287)', () => {
  it('signs the stored open event to OfficeDecisionGateway under the command key, with a real receipt', async () => {
    const cmd = command();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ invocationId: 'inv_desk_001' }, { status: 202 }));
    const dispatcher = new TaskWorkflowDispatcher({ restateIngressUrl: 'http://restate.test', customerSigningSecret: secret, fetcher });
    for (let n = 0; n < 2; n++) {
      expect(await dispatcher.dispatchDeskOpen(cmd)).toMatchObject({ receiptId: 'inv_desk_001', aggregateId: cmd.aggregate_id });
    }
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).toBe('http://restate.test/OfficeDecisionGateway/openDeskRequest/send');
      expect(new Headers(options?.headers).get('Idempotency-Key')).toBe(cmd.idempotency_key);
      const body = JSON.parse(String(options?.body));
      expect(body).toEqual({ v: 1, event: cmd.payload.event, signature: signLifecycleOfficeEvent(secret, cmd.payload.event) });
      expect(checkSignedDeskOpen(body, secret)).toBe('ok');
    }
    const noReceipt = new TaskWorkflowDispatcher({ restateIngressUrl: 'http://restate.test', customerSigningSecret: secret,
      fetcher: vi.fn<typeof fetch>(async () => Response.json({}, { status: 202 })) });
    await expect(noReceipt.dispatchDeskOpen(cmd)).rejects.toThrow('RECEIPT_MISSING');
    fetcher.mockClear();
    await expect(dispatcher.dispatchDeskOpen({ ...cmd, aggregate_id: randomUUID() })).rejects.toThrow('INVALID_DESK_OPEN_COMMAND');
    await expect(dispatcher.dispatchDeskOpen({ ...cmd, command_type: 'customer.request.open' })).rejects.toThrow('INVALID_DESK_OPEN_COMMAND');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(new TaskWorkflowDispatcher().dispatchDeskOpen(cmd)).rejects.toThrow('INGRESS_NOT_CONFIGURED');
  });

  it('is a command the outbox consumer knows', async () => {
    const dispatcher = { dispatchDeskOpen: vi.fn(async () => ({ workflowId: 'w' })) } as unknown as TaskWorkflowDispatcher;
    const consumer = new OutboxConsumer({} as never, { dispatcher, tenantIds: [tenantId] } as never);
    const handler = (consumer as unknown as { handlers: Map<string, (cmd: OutboxCommandRecord) => Promise<void>> }).handlers.get('office.request.open');
    expect(handler).toBeTypeOf('function');
    const cmd = command();
    await handler!(cmd);
    expect(dispatcher.dispatchDeskOpen).toHaveBeenCalledWith(cmd);
  });

  it('gateway accepts only a signed Desk open of the request it names', () => {
    const event = openEvent();
    const signed = { v: 1 as const, event, signature: signLifecycleOfficeEvent(secret, event) };
    expect(checkSignedDeskOpen(signed, secret)).toBe('ok');
    expect(checkSignedDeskOpen({ ...signed, signature: '0'.repeat(64) }, secret)).toBe('unauthorized');
    expect(checkSignedDeskOpen(signed, 'another-secret')).toBe('unauthorized');
    const bad: Array<Partial<OpenAutomaticEvent> & Record<string, unknown>> = [
      { chatId: '75000001' },
      { eventId: `open:${randomUUID()}` },
      { tenantId: randomUUID() },
      { draft: { ...event.draft, platform: 'telegram' } as never },
      { draft: { ...event.draft, sourceChannelId: `desk:${randomUUID()}` } },
      { draft: { ...event.draft, sourceEventId: 'lc-other-r0' } },
      { extra: true },
    ];
    for (const change of bad) {
      const e = { ...event, ...change } as OpenAutomaticEvent;
      expect(checkSignedDeskOpen({ v: 1, event: e, signature: signLifecycleOfficeEvent(secret, e) }, secret)).toBe('invalid');
    }
  });

  it('RequestLifecycle opens it and starts the design run', async () => {
    const event = openEvent(), taskId = randomUUID(), clientId = event.draft.clientId!;
    let state: LifecycleState | null = null;
    const sent: OutboundMessage[] = [], started: DesignRunInput[] = [];
    const ctx: AutomaticOpenContext = { key: event.requestId, get: async () => state, set: (_n, value) => { state = value; },
      run: async (_n, action) => action(), send: (m) => { sent.push(m); }, startDesign: (i) => { started.push(i); } };
    const core = coreInternalFixture({ v: 1, taskId, stage: 'designing', rev: 1, autoGenerate: true,
      design: { clientId, rawText: event.draft.rawText, sourcePlatform: 'hawa_desk', designStudio: true, variant: { width: 1080, height: 1080 } } });
    expect(await openAutomaticRequest(ctx, core, event)).toMatchObject({ taskId, stage: 'designing', rev: 1 });
    expect(started).toEqual([expect.objectContaining({ taskId, sourcePlatform: 'hawa_desk', canvaVariant: { width: 1080, height: 1080 } })]);
    // Its acknowledgement is addressed to the Desk channel, which TelegramSender answers desk_only.
    expect(sent.length > 0 && sent.every((m) => m.chatId === event.chatId && isDeskChannel(m.chatId))).toBe(true);
    const forged = { ...event, chatId: '75000001', draft: { ...event.draft, sourceChannelId: '75000001' } };
    await expect(openAutomaticRequest({ ...ctx, key: event.requestId }, core, forged)).rejects.toThrow(/LIFECYCLE_OPEN_REFUSED|different content/);
  });

  it('delivers to a Desk channel by the archive alone: no file and no notice is sent', async () => {
    const taskId = randomUUID(), approvalId = randomUUID(), chatId = `desk:${randomUUID()}`;
    const unsigned: DeliveryInput = { v: 1, requestId: randomUUID(), deliveryId: deliveryWorkflowId(taskId, approvalId), tenantId, taskId,
      approvalId, revisionId: randomUUID(), chatId, officeChatId: '9000001', reportTo: 'lifecycle', requestRev: 4, run: 1 };
    const { claimSignature: _none, ...claim } = unsigned;
    const input = { ...claim, claimSignature: signLifecycleDeliveryClaim(secret, claim) } as DeliveryInput;
    const files = [{ artifactId: randomUUID(), format: 'pptx', filename: 'deck.pptx', sha256: 'a'.repeat(64), byteSize: 10,
      webViewLink: 'https://drive.google.com/file/d/f/view' }];
    const prepared: PreparedDelivery = { ok: true, taskId, publicationKey: `pub_key_${taskId}_x`, chatId: null, title: 'Members evening', files,
      chatOnly: false, archived: true, sheetsConfirmed: true,
      notice: { title: 'Members evening', files, driveFolderId: 'folder', spreadsheetId: 'sheet', sheetsConfirmed: true, sheetRowNumber: 3, sheetProblem: null } } as PreparedDelivery;
    const sends: OutboundMessage[] = [], reports: unknown[] = [];
    const ctx: DeliveryContext = { run: (_n, action) => action(), send: async (m) => { sends.push(m); return { outcome: 'sent' }; },
      reportLifecycle: async (_i, outcome) => { reports.push(outcome); } };
    const core: CoreInternal = { post: async <T>() => prepared as unknown as T };
    const outcome = await runDelivery(ctx, core, input);
    expect(outcome).toMatchObject({ outcome: 'delivered', archived: true, sheetsConfirmed: true, filesSent: 0, uncertain: [] });
    expect(sends).toEqual([]);
    expect(reports).toEqual([outcome]);
  });
});
