/**
 * Isolated Restate process-kill drill for the first office revision protocol.
 * Bind this endpoint only to a disposable Restate server. All Core and Telegram calls below are
 * fixtures; the signed gateway and RequestLifecycle handlers are the production implementations.
 */
import http from 'node:http';
import fs from 'node:fs';
import * as restate from '@restatedev/restate-sdk';
import { createRequestLifecycle, RequestLifecycleApi, type DesignFinishedEvent,
  type OpenAutomaticEvent } from '../src/lifecycle/request-lifecycle.js';
import { createOfficeDecisionGateway } from '../src/lifecycle/office-decision-gateway.js';

interface DrillState { requestId: string; taskId: string; revisionId: string;
  approvalId: string; approvalWrites: number; actionHash?: string; crashOnce: boolean; crashed: boolean }

const statePath = process.env.HAWA_OFFICE_DRILL_STATE;
const secret = process.env.HAWA_WORKER_TOKEN || '';
const port = Number(process.env.PORT || 19080);
if (!statePath || !secret || !Number.isSafeInteger(port) || port < 1024) {
  throw new Error('Set HAWA_OFFICE_DRILL_STATE, HAWA_WORKER_TOKEN and a non-privileged PORT');
}
const load = (): DrillState => JSON.parse(fs.readFileSync(statePath, 'utf8')) as DrillState;
const save = (state: DrillState) => fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

const core = {
  async post<T>(path: string, body: unknown): Promise<T> {
    const state = load();
    if (!path.includes(state.requestId)) throw new Error('wrong request in fixture Core');
    if (path.endsWith('/project')) return { v: 1, taskId: state.taskId, stage: 'designing', rev: 1,
      autoGenerate: true, design: { clientId: 'c1000000-0000-4000-8000-000000000002',
        rawText: 'Autumn poster', sourcePlatform: 'telegram', designStudio: false } } as T;
    if (path.endsWith('/design-outcome')) return { v: 1, requestId: state.requestId,
      taskId: state.taskId, stage: 'in_review', rev: 2, revisionId: state.revisionId,
      status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW' } as T;
    if (path.endsWith('/office-decision')) {
      const hash = JSON.stringify(body);
      if (state.actionHash && state.actionHash !== hash) throw new restate.TerminalError('ACTION_KEY_CONFLICT', { errorCode: 409 });
      if (!state.actionHash) { state.actionHash = hash; state.approvalWrites += 1; }
      const shouldCrash = state.crashOnce && !state.crashed;
      if (shouldCrash) state.crashed = true;
      save(state);
      if (shouldCrash) process.kill(process.pid, 'SIGKILL');
      return { v: 1, requestId: state.requestId, taskId: state.taskId,
        revisionId: state.revisionId, actionId: (body as any).ops[0].actionId,
        approvalId: state.approvalId, taskState: 'revision_requested', rev: 3, stage: 'manual' } as T;
    }
    throw new Error(`Unexpected fixture Core call ${path}`);
  },
};

const requestLifecycle = createRequestLifecycle(core);
const officeGateway = createOfficeDecisionGateway(secret);
const fixtureDesignRun = restate.workflow({ name: 'DesignRun', handlers: {
  run: async () => ({ finished: true }),
} });
const fixtureSender = restate.object({ name: 'TelegramSender', handlers: {
  send: async () => ({ outcome: 'sent' }),
} });
const driver = restate.service({ name: 'OfficeDrillDriver', handlers: {
  prepare: async (ctx: restate.Context) => {
    const state = load();
    const open: OpenAutomaticEvent = {
      v: 1, eventId: `open:${state.requestId}`, requestId: state.requestId,
      tenantId: '00000000-0000-4000-a000-000000000001', chatId: '73000001',
      draft: { platform: 'telegram', sourceEventId: `lc-${state.requestId}-r0`,
        sourceChannelId: '73000001', rawText: 'Autumn poster', title: 'Autumn poster',
        designInstructions: 'Use exact copy', exactCopy: ['Autumn poster'],
        clientId: 'c1000000-0000-4000-8000-000000000002', autoGenerate: true },
    };
    await ctx.objectClient(RequestLifecycleApi, state.requestId).open(open);
    const runId = `dr-${state.taskId}`;
    const finished: DesignFinishedEvent = { v: 1, eventId: `dr-finished:${runId}`,
      requestId: state.requestId, taskId: state.taskId, runId, round: 0,
      report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DA0000000000' } };
    return ctx.objectClient(RequestLifecycleApi, state.requestId).designFinished(finished);
  },
  read: async (ctx: restate.Context) => {
    const state = load();
    return ctx.objectClient(RequestLifecycleApi, state.requestId).get();
  },
} });

const handler = restate.endpoint().bind(requestLifecycle).bind(officeGateway)
  .bind(fixtureDesignRun).bind(fixtureSender).bind(driver).http1Handler();
http.createServer(handler).listen(port, '0.0.0.0', () => {
  process.stdout.write(`Office Restate drill endpoint listening on ${port}\n`);
});
