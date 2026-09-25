/**
 * Disposable Restate replay drill for request-owned delivery. Core, Drive, Sheets, Canva and
 * Telegram are fixtures; RequestLifecycle, OfficeDecisionGateway and Delivery are production
 * handlers. The process dies after the synthetic final Core write and before answering Restate.
 */
import http from 'node:http';
import fs from 'node:fs';
import * as restate from '@restatedev/restate-sdk';
import { deliveryWorkflowId, type DeliveryInput, type PreparedDelivery } from '@hawa/contracts';
import { signLifecycleDeliveryClaim } from '@hawa/integrations';
import { createRequestLifecycle, RequestLifecycleApi, type DesignFinishedEvent,
  type OpenAutomaticEvent, type OfficeRevisionEvent } from '../src/lifecycle/request-lifecycle.js';
import { createOfficeDecisionGateway } from '../src/lifecycle/office-decision-gateway.js';
import { createDeliveryWorkflow } from '../src/lifecycle/delivery.js';

interface DrillState {
  requestId: string; taskId: string; revisionId: string; approvalId: string;
  actorId: string; approvalActionId: string; deliveryActionId: string; artifactId: string;
  claimWrites: number; prepareCalls: number; finishCalls: number; finishWrites: number;
  senderKeys: string[]; finishHash?: string; crashed: boolean; crashOnce: boolean;
}

const statePath = process.env.HAWA_DELIVERY_DRILL_STATE;
const secret = process.env.HAWA_WORKER_TOKEN || '';
const port = Number(process.env.PORT || 19081);
if (!statePath || !secret || !Number.isSafeInteger(port) || port < 1024) {
  throw new Error('Set HAWA_DELIVERY_DRILL_STATE, HAWA_WORKER_TOKEN and a non-privileged PORT');
}
const load = (): DrillState => JSON.parse(fs.readFileSync(statePath, 'utf8')) as DrillState;
const save = (state: DrillState) => fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
const tenantId = '00000000-0000-4000-a000-000000000001';
const chatId = '73000001';
const packageHash = 'b'.repeat(64);
const exportHash = 'a'.repeat(64);

const core = {
  async post<T>(path: string, body: unknown): Promise<T> {
    const state = load();
    if (!path.includes(state.requestId)) throw new Error('wrong request in fixture Core');
    if (path.endsWith('/project')) return { v: 1, taskId: state.taskId, stage: 'designing', rev: 1,
      autoGenerate: true, design: { clientId: 'c1000000-0000-4000-8000-000000000002',
        rawText: 'Synthetic delivery drill', sourcePlatform: 'telegram', designStudio: false } } as T;
    if (path.endsWith('/design-outcome')) return { v: 1, requestId: state.requestId,
      taskId: state.taskId, stage: 'in_review', rev: 2, revisionId: state.revisionId,
      status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW' } as T;
    if (path.endsWith('/office-decision')) {
      const op = (body as { ops: Array<{ actionId: string }> }).ops[0]!;
      return { v: 1, requestId: state.requestId, taskId: state.taskId,
        revisionId: state.revisionId, actionId: op.actionId, approvalId: state.approvalId,
        taskState: 'approved', rev: 3, stage: 'approved' } as T;
    }
    if (path.endsWith('/delivery-start')) {
      const op = (body as { ops: Array<{ actionId: string }> }).ops[0]!;
      if (state.claimWrites === 0) { state.claimWrites = 1; save(state); }
      const unsigned: DeliveryInput = { v: 1, requestId: state.requestId, tenantId,
        taskId: state.taskId, approvalId: state.approvalId, revisionId: state.revisionId,
        deliveryId: deliveryWorkflowId(state.taskId, state.approvalId),
        chatId, officeChatId: null, reportTo: 'lifecycle', requestRev: 4, run: 1 };
      return { v: 1, requestId: state.requestId, taskId: state.taskId,
        approvalId: state.approvalId, actionId: op.actionId, stage: 'delivering', rev: 4,
        delivery: { ...unsigned, claimSignature: signLifecycleDeliveryClaim(secret, unsigned) } } as T;
    }
    if (path.endsWith('/prepare')) {
      state.prepareCalls += 1;
      save(state);
      const file = { artifactId: state.artifactId, filename: 'approved-fixture.pdf',
        mimeType: 'application/pdf', sha256: exportHash, byteSize: 4 };
      return { ok: true, taskId: state.taskId,
        publicationKey: `pub_key_${state.taskId}_${state.approvalId}`,
        chatId, title: 'Synthetic delivery drill', files: [file], chatOnly: false,
        archived: true, sheetsConfirmed: true,
        notice: { title: 'Synthetic delivery drill', files: [file],
          driveFolderId: 'fixture-folder', spreadsheetId: 'fixture-sheet',
          sheetsConfirmed: true, sheetRowNumber: 1, sheetProblem: null } } satisfies PreparedDelivery as T;
    }
    if (path.endsWith('/delivery-finished')) {
      state.finishCalls += 1;
      const hash = JSON.stringify(body);
      if (state.finishHash && state.finishHash !== hash) {
        throw new restate.TerminalError('CHANGED_DELIVERY_RESULT', { errorCode: 409 });
      }
      if (!state.finishHash) { state.finishHash = hash; state.finishWrites += 1; }
      const shouldCrash = state.crashOnce && !state.crashed;
      if (shouldCrash) state.crashed = true;
      save(state);
      if (shouldCrash) process.kill(process.pid, 'SIGKILL');
      return { v: 1, requestId: state.requestId, taskId: state.taskId,
        approvalId: state.approvalId, deliveryId: deliveryWorkflowId(state.taskId, state.approvalId),
        stage: 'delivered', taskState: 'complete', rev: 5 } as T;
    }
    throw new Error(`Unexpected fixture Core call ${path}`);
  },
};

const fixtureDesignRun = restate.workflow({ name: 'DesignRun', handlers: {
  run: async () => ({ finished: true }),
} });
const fixtureSender = restate.object({ name: 'TelegramSender', handlers: {
  send: async (_ctx: restate.ObjectContext, message: { key: string }) => {
    const state = load();
    if (!state.senderKeys.includes(message.key)) {
      state.senderKeys.push(message.key);
      save(state);
    }
    return { outcome: 'sent' as const, messageId: String(state.senderKeys.indexOf(message.key) + 1) };
  },
} });
const driver = restate.service({ name: 'DeliveryDrillDriver', handlers: {
  prepare: async (ctx: restate.Context) => {
    const state = load();
    const open: OpenAutomaticEvent = { v: 1, eventId: `open:${state.requestId}`,
      requestId: state.requestId, tenantId, chatId,
      draft: { platform: 'telegram', sourceEventId: `lc-${state.requestId}-r0`,
        sourceChannelId: chatId, rawText: 'Synthetic delivery drill', title: 'Synthetic delivery drill',
        designInstructions: 'Use exact copy', exactCopy: ['Synthetic delivery drill'],
        clientId: 'c1000000-0000-4000-8000-000000000002', autoGenerate: true } };
    await ctx.objectClient(RequestLifecycleApi, state.requestId).open(open);
    const runId = `dr-${state.taskId}`;
    const finished: DesignFinishedEvent = { v: 1, eventId: `dr-finished:${runId}`,
      requestId: state.requestId, taskId: state.taskId, runId, round: 0,
      report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DA0000000000' } };
    await ctx.objectClient(RequestLifecycleApi, state.requestId).designFinished(finished);
    const approve: OfficeRevisionEvent = { v: 1, kind: 'approve', eventId: `desk:${state.approvalActionId}`,
      requestId: state.requestId, taskId: state.taskId, revisionId: state.revisionId,
      actionId: state.approvalActionId, expectedRev: 2,
      actor: { userId: state.actorId, role: 'art_director' }, reason: 'Synthetic approved export',
      deskRequestFingerprint: 'c'.repeat(64),
      approvalProof: { qcRunId: state.approvalId, qcReportHash: 'd'.repeat(64),
        pinnedExports: [{ artifactId: state.artifactId, format: 'pdf', sha256: exportHash, byteSize: 4 }] } };
    return ctx.objectClient(RequestLifecycleApi, state.requestId).officeDecision(approve);
  },
  read: async (ctx: restate.Context) => {
    const state = load();
    return ctx.objectClient(RequestLifecycleApi, state.requestId).get();
  },
} });

const handler = restate.endpoint().bind(createRequestLifecycle(core))
  .bind(createOfficeDecisionGateway(secret)).bind(createDeliveryWorkflow(core))
  .bind(fixtureDesignRun).bind(fixtureSender).bind(driver).http1Handler();
http.createServer(handler).listen(port, '0.0.0.0', () => {
  process.stdout.write(`Delivery Restate drill endpoint listening on ${port}\n`);
});
