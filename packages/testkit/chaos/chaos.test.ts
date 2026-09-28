/**
 * The chaos suite (architecture programme, PLAN.md Phase 2; PHASE2_DESIGN.md section 6): scripted
 * requests through the whole stack in the hawa-chaos compose project, with processes killed at named
 * points, and the invariants of section 6.3 checked after each request.
 *
 * It runs only with HAWA_CHAOS=1 (README.md): it builds images and starts six containers.
 *   HAWA_CHAOS=1 npx vitest run packages/testkit/chaos/chaos.test.ts
 *   HAWA_CHAOS_KEEP=1   leave the project running afterwards (default: taken down with its volumes)
 *   HAWA_CHAOS_ONLY=R1.0,R4   run only these scenarios
 *
 * Since ADR-135 (2026-09-28) every chat is lifecycle-owned and only the worker polls Telegram, so every
 * scenario drives the lifecycle path: the worker's poller, ChatInbox, Core's internal intake,
 * RequestLifecycle, DesignRun and the Delivery workflow. The scenarios that drove the legacy path were
 * pointed at the lifecycle's own steps (README.md, "ADR-135"). The results (per scenario: invariants,
 * time, memory) are written to .run/last-run.json and printed; a failed invariant fails its scenario.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidateSources } from './driver/candidate-sources.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { build, CHAOS_DIR, closeDb, deploymentReceipt, down, fakes, kill, memory, PORTS, query, restateQuery, RESTATE_INGRESS_URL, secrets, sql, stackState, start, up, waitHealthy } from './driver/stack.js';
import { connectCanva, finishDrains, kaaeClientDna, registerColour, upgradeSchema } from './driver/provision.js';
import {
  approve, briefToDraft, captionedPhotoUpdate, chatInboxInvocations, checkIntake, checkRequest, deliver, designOutcome, draftOf, imageDocumentUpdate, killAtPoint, killWhileHeld, quiescent, sendBrief,
  OFFICE_CHAT, sendToChatInbox, sentTo, sleep, staffConfirmVisible, storedOffset, tasksOfChat, taskState, textUpdate, uncoveredModelCalls, waitDelivered, waitUntil, type InvariantResult,
} from './driver/scenario.js';

const enabled = process.env.HAWA_CHAOS === '1';
const only = (process.env.HAWA_CHAOS_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const keep = process.env.HAWA_CHAOS_KEEP === '1';
const candidate = process.env.HAWA_CHAOS_CANDIDATE === '1';
// Who polls Telegram in the stack: the worker's poller and ChatInbox, the only one since ADR-135.
if ((process.env.CHAOS_TELEGRAM_POLLER || 'worker').trim().toLowerCase() !== 'worker') {
  throw new Error('CHAOS_TELEGRAM_POLLER must be worker: Core no longer polls Telegram (ADR-135)');
}
const poller = 'worker';

interface ScenarioReport {
  name: string;
  what: string;
  ms: number;
  invariants: InvariantResult[];
  events: string[];
  error?: string;
}
const reports: ScenarioReport[] = [];
const peakMemory: Record<string, number> = {};
const samples: Array<{ at: string; totalMiB: number }> = [];
const suiteStarted = Date.now();

function sampleMemory(): void {
  const m = memory();
  for (const [name, mib] of Object.entries(m)) peakMemory[name] = Math.max(peakMemory[name] || 0, mib);
  samples.push({ at: new Date().toISOString(), totalMiB: Object.values(m).reduce((a, b) => a + b, 0) });
}

// Every chat is lifecycle-owned (ADR-135): no chat list to draw from, one fresh chat per scenario.
let chatSeq = 9_200_000 + (Date.now() % 100_000) * 10;
const newChat = () => String(++chatSeq);

/**
 * One scenario: a fresh chat, the script, quiescence, then the invariants. Every invariant is
 * recorded; the scenario fails if any does not hold.
 */
interface Expectation {
  delivered: boolean;
  /** An open lifecycle request keeps a future reminder scheduled in Restate. */
  skipQuiescence?: boolean;
  classifierAllowance?: number;
  /** Sends the scenario makes uncertain (each must end with one office alert and no resend). */
  uncertainSends?: number;
  /** Checks of the scenario's own, added to the per-request ones. */
  extra?: InvariantResult[];
  /** The scenario made no design request in its chat (R4), so only `extra` applies. */
  skipRequestChecks?: boolean;
  /** Checks made after quiescence (what Restate recorded once every invocation has finished). */
  after?: () => Promise<InvariantResult[]>;
  /** The approved files the delivery sends (default 1). */
  files?: number;
  /** Who delivers: the Delivery workflow ('restate') for every request since ADR-135 (the default). */
  executor?: 'core' | 'restate';
}

function scenario(name: string, what: string, script: (chat: string, events: string[]) => Promise<Expectation>, timeoutMs = 12 * 60_000) {
  const run = enabled && (only.length === 0 || only.includes(name));
  it.skipIf(!run)(`${name}: ${what}`, async () => {
    const chat = newChat();
    const events: string[] = [];
    const started = Date.now();
    const report: ScenarioReport = { name, what, ms: 0, invariants: [], events };
    reports.push(report);
    try {
      const ledger = await fakes.modelLedger();
      const ledgerSince = Math.max(0, ...(ledger.ledger as any[]).map((l) => l.seq));
      const expectation = await script(chat, events);
      await fakes.release();
      if (!expectation.skipQuiescence) await quiescent();
      report.invariants = [
        ...(expectation.skipRequestChecks ? [] : await checkRequest(chat, { ...expectation, executor: expectation.executor ?? 'restate', ledgerSince })),
        ...(expectation.extra || []),
        ...(expectation.after ? await expectation.after() : []),
      ];
    } catch (err) {
      report.error = err instanceof Error ? `${err.message}${err.cause instanceof Error ? `; cause: ${err.cause.message}` : ''}` : String(err);
      // A lost stack (a refused or failed connection) is reported with the containers' states.
      if (/ECONNREFUSED|fetch failed|ECONNRESET/.test(report.error)) report.events.push(`stack: ${stackState()}`);
    } finally {
      await fakes.clearFaults().catch(() => undefined);
      report.ms = Date.now() - started;
      sampleMemory();
    }
    expect(report.error).toBeUndefined();
    const failed = report.invariants.filter((i) => !i.ok);
    expect(failed, failed.map((f) => `${f.name}: ${f.detail}`).join('; ')).toEqual([]);
  }, timeoutMs);
}

/** The full request: brief, draft, Desk approval, delivery (through RequestLifecycle since ADR-135). */
async function fullRequest(chat: string, tag: string, events: string[], hooks: { afterApprove?: () => Promise<void> } = {}) {
  const taskId = await briefToDraft(chat, tag);
  events.push(`task ${taskId}: draft in chat`);
  const approved = await approve(taskId);
  events.push(`approve: HTTP ${approved.status}`);
  if (approved.status >= 300) throw new Error(`approval refused: HTTP ${approved.status} ${JSON.stringify(approved.body).slice(0, 300)}`);
  if (hooks.afterApprove) await hooks.afterApprove();
  const delivered = await deliver(taskId);
  events.push(`deliver: HTTP ${delivered.status}`);
  if (delivered.status >= 300) throw new Error(`delivery refused: HTTP ${delivered.status} ${JSON.stringify(delivered.body).slice(0, 300)}`);
  await waitDelivered(chat, taskId);
  events.push(`delivered, task ${await taskState(taskId)}`);
  return taskId;
}

describe.skipIf(!enabled)('chaos suite (hawa-chaos compose project)', () => {
  beforeAll(async () => {
    // Always from nothing: a kept project from an earlier run would carry its tasks and journals.
    down({ volumes: true });
    // Core and the worker start below with --no-build, so their images are built from this checkout here.
    build(['core', 'worker-blue', ...(candidate ? ['desk', 'docling'] as const : [])]);
    up({ services: ['postgres', 'restate', 'fakes'] });
    await upgradeSchema();
    await connectCanva();
    await kaaeClientDna();
    up({ build: false, services: ['core', 'worker-blue'] });
    const reg = await registerColour('blue');
    if (reg.code !== 0) throw new Error(`register blue: ${reg.lines.join(' | ')}`);
    if (candidate) up({ build: false, services: ['docling', 'desk', 'nginx'] });
    sampleMemory();
  }, 30 * 60_000);

  afterAll(async () => {
    sampleMemory();
    const result = {
      finishedAt: new Date().toISOString(),
      telegramPoller: poller,
      ...(candidate ? { deployment: deploymentReceipt() } : {}),
      totalMs: Date.now() - suiteStarted,
      memoryMeasurement: 'start/end and scenario samples; not a continuous peak measurement',
      peakMemoryMiB: peakMemory,
      peakTotalMiB: Math.max(0, ...samples.map((s) => s.totalMiB)),
      uncoveredModelCalls: await uncoveredModelCalls().catch(() => ['(fakes unreachable)']),
      scenarios: reports,
    };
    mkdirSync(join(CHAOS_DIR, '.run'), { recursive: true });
    writeFileSync(join(CHAOS_DIR, '.run', 'last-run.json'), JSON.stringify(result, null, 2));
    for (const r of reports) {
      const bad = r.invariants.filter((i) => !i.ok);
      console.log(`[chaos] ${r.name} ${r.error ? 'ERROR' : bad.length ? 'FAIL' : 'ok'} ${Math.round(r.ms / 1000)} s — ${r.what}${r.error ? `\n    error: ${r.error}` : ''}${bad.map((b) => `\n    ✗ ${b.name}: ${b.detail}`).join('')}`);
    }
    console.log(`[chaos] total ${Math.round(result.totalMs / 1000)} s, peak memory ${result.peakTotalMiB} MiB (${JSON.stringify(peakMemory)})`);
    await closeDb();
    if (!keep) down({ volumes: true });
    else console.log('[chaos] HAWA_CHAOS_KEEP=1: the hawa-chaos project is still running; take it down with `npx tsx packages/testkit/chaos/run.ts --down`.');
  }, 10 * 60_000);

  if (candidate) scenario('R1.S3.SOURCES', 'full-app PDF source to voice revision and simulated approved delivery', async (chat, events) => ({
    delivered: false, skipRequestChecks: true, skipQuiescence: true, extra: await candidateSources(chat, events, suiteStarted),
  }));

  scenario('R1.0', 'happy path: brief, draft, approve, deliver, no faults', async (chat, events) => {
    await fullRequest(chat, 'R1.0', events);
    return { delivered: true };
  });

  // Since 82b28988 (2026-09-25) intake classifies an unscoped Telegram text locally, so intake makes no
  // model call to kill Core in. The slow moment is the acknowledgement, which RequestLifecycle's
  // TelegramSender sends once the request is open (ADR-135: every request): Core is killed during that
  // send, and the request must go on to delivery with one task and one acknowledgement.
  scenario('R1.K0', 'Core killed while the acknowledgement is sent (the send slowed to 4 s), back after 5 s', async (chat, events) => {
    await fakes.telegramFault({ method: 'sendMessage', chat, kind: 'delay', delayMs: 4000, n: 1 });
    const request = fullRequest(chat, 'R1.K0', events);
    await waitUntil('the acknowledgement send', async () => (await fakes.telegramCalls()).some((c) => c.method === 'sendMessage' && c.chat === chat), 60_000, 200);
    kill('core');
    events.push(`killed core while the acknowledgement was being sent (tasks then: ${(await tasksOfChat(chat)).length})`);
    await sleep(5000);
    start('core');
    await waitHealthy('core');
    await request;
    return { delivered: true };
  });

  // Until ADR-135 these killed the worker around the outbox's dispatch of task.created to TaskWorkflow.
  // A request's task now comes from RequestLifecycle, which starts its DesignRun itself; the start of
  // the design run is the moment they cover.
  scenario('R1.K1', 'worker killed after the design run checked its task, before the step was journalled', async (chat, events) => {
    const k = await killAtPoint('worker.step.after-action', { step: 'canva-verify-task-scope' });
    await fullRequest(chat, 'R1.K1', events);
    events.push(`killed ${(await k.done).killed} after canva-verify-task-scope`);
    return { delivered: true };
  });

  scenario('R1.K2', 'Restate killed right after the design run started (worker held after its first step), back after 5 s', async (chat, events) => {
    const k = await killWhileHeld('worker.step.after-action', { step: 'canva-verify-task-scope' }, 'restate');
    await fullRequest(chat, 'R1.K2', events);
    events.push(`killed ${(await k.done).killed} while the worker was held after canva-verify-task-scope`);
    return { delivered: true };
  });

  scenario('R1.K3', 'worker killed after Core planned and imported the draft, before the step was journalled', async (chat, events) => {
    const k = await killAtPoint('worker.step.after-action', { step: 'canva-create-draft' });
    await fullRequest(chat, 'R1.K3', events);
    events.push(`killed ${(await k.done).killed} after canva-create-draft`);
    return { delivered: true };
  });

  scenario('R1.K4', 'worker killed after the copy-and-font check export, before the step was journalled', async (chat, events) => {
    const k = await killAtPoint('worker.step.after-action', { step: 'canva-export-copy-font-check' });
    await fullRequest(chat, 'R1.K4', events);
    events.push(`killed ${(await k.done).killed} after canva-export-copy-font-check`);
    return { delivered: true };
  });

  // Until ADR-135 this killed the worker after TaskWorkflow's `canva-notify-…` step (Core took the
  // outcome). A DesignRun reports to its RequestLifecycle instead, with no step of that name; the last
  // step before the report is the preview export.
  scenario('R1.K5', 'worker killed after the preview export, before the step was journalled (just before the outcome is reported)', async (chat, events) => {
    const k = await killAtPoint('worker.step.after-action', { step: 'canva-export-preview' });
    await fullRequest(chat, 'R1.K5', events);
    events.push(`killed ${(await k.done).killed} after canva-export-preview`);
    return { delivered: true };
  });

  scenario('R1.K6', 'Core killed mid-design (worker held after reading the binding), back after 5 s', async (chat, events) => {
    const k = await killWhileHeld('worker.step.after-action', { step: 'canva-read-binding' }, 'core');
    await fullRequest(chat, 'R1.K6', events);
    events.push(`killed ${(await k.done).killed} while the worker was held after canva-read-binding`);
    return { delivered: true };
  });

  scenario('R1.K7', 'Postgres killed mid-design (worker held after the preview export), back after 5 s', async (chat, events) => {
    const k = await killWhileHeld('worker.step.after-action', { step: 'canva-export-preview' }, 'postgres');
    await fullRequest(chat, 'R1.K7', events);
    events.push(`killed ${(await k.done).killed} while the worker was held after canva-export-preview`);
    return { delivered: true };
  });

  scenario('R1.K8', 'Restate killed mid-design (worker held inside the draft step), back after 5 s', async (chat, events) => {
    const k = await killWhileHeld('worker.step.after-action', { step: 'canva-create-draft' }, 'restate');
    await fullRequest(chat, 'R1.K8', events);
    events.push(`killed ${(await k.done).killed} while the worker was held after canva-create-draft`);
    return { delivered: true };
  });

  scenario('R1.K9', 'Canva answers 5xx three times and then 429 on export creation', async (chat, events) => {
    await fakes.canvaFault({ method: 'POST', path: '^/exports$', kind: '5xx', n: 3 });
    await fakes.canvaFault({ method: 'POST', path: '^/exports$', kind: '429', n: 1 });
    await fullRequest(chat, 'R1.K9', events);
    return { delivered: true };
  });

  scenario('R1.K10', 'Telegram answers 429 (retry_after 3) to the chat\'s second message', async (chat, events) => {
    // The acknowledgement is the chat's first sendMessage. Until ADR-135 the second was the legacy
    // draft with its buttons; a lifecycle request's second message to the requester is its next notice.
    await fakes.telegramFault({ method: 'sendMessage', chat, kind: '429', n: 1, retryAfter: 3, skip: 1 });
    await fullRequest(chat, 'R1.K10', events);
    return { delivered: true };
  });

  scenario('R1.K11', 'Core killed right after the Desk approval, back after 5 s, then delivered', async (chat, events) => {
    await fullRequest(chat, 'R1.K11', events, {
      afterApprove: async () => {
        kill('core');
        await sleep(5000);
        start('core');
        await waitHealthy('core');
        events.push('killed core after the approval');
      },
    });
    return { delivered: true };
  });

  // R1.K12 (worker killed after the approved file was sent, before its mark) and R1.K15 (Postgres killed
  // there) drove Core's `notify.published` sender, which no new request reaches since ADR-135. Their
  // lifecycle twins are L2.K12 and L2.K17 below (the same kills in the Delivery workflow's sender).
  // R1.K13 had no twin, so it is the lifecycle's own now: an unconfirmed send is held for staff
  // (ADR-043, ADR-045) and settled by an administrator (ADR-046), as in L2.K12.
  scenario('R1.K13', 'Telegram takes the first approved file and the answer is lost (one uncertain send, settled by staff)', async (chat, events) => {
    await fakes.telegramFault({ method: 'sendDocument', chat, kind: 'drop-after-processing', n: 1 });
    let settlement: InvariantResult[] = [];
    await workflowRequest(chat, 'R1.K13', events, { beforeComplete: async (taskId) => {
      settlement = await staffConfirmVisible(chat, taskId, events);
    } });
    return { delivered: true, files: 2, uncertainSends: 1, extra: settlement };
  });

  scenario('R1.K14', 'Core killed in the middle of a Deliver request (Drive upload slowed to 8 s), back after 5 s; Deliver pressed again once', async (chat, events) => {
    const taskId = await briefToDraft(chat, 'R1.K14');
    const approved = await approve(taskId);
    events.push(`approve: HTTP ${approved.status}`);
    await fakes.googleDelay({ path: '^/drive/v3/files', delayMs: 8000, n: 1 });
    const first = deliver(taskId).catch((e) => ({ status: 0, body: String(e) }));
    await sleep(2000);
    const stateAtKill = await taskState(taskId);
    kill('core');
    const firstAnswer = await first;
    events.push(`task ${stateAtKill} when Core was killed; that Deliver request got HTTP ${firstAnswer.status}`);
    await sleep(5000);
    start('core');
    await waitHealthy('core');
    await sleep(3000);
    const stateAfterRestart = await taskState(taskId);
    events.push(`after Core restarted, before a second Deliver: task ${stateAfterRestart}`);
    const second = await deliver(taskId);
    events.push(`second Deliver: HTTP ${second.status} ${JSON.stringify(second.body).slice(0, 160)}`);
    await waitDelivered(chat, taskId);
    return {
      delivered: true,
      extra: [{ name: 'a delivery cut off by a Core restart does not stay stuck in publishing', ok: stateAfterRestart !== 'publishing', detail: `task ${stateAtKill} at the kill, ${stateAfterRestart} after the restart` }],
    };
  });

  // Since ADR-135 the design is a DesignRun (dr-<task>), not TaskWorkflow (task-wf-<task>).
  scenario('R1.D1', 'deploy to green while the design runs on blue: it finishes on blue, blue drains and is deleted', async (chat, events) => {
    const [blue] = await restateQuery<{ id: string }>(`SELECT id FROM sys_deployment WHERE endpoint LIKE '%worker-blue%'`);
    await fakes.hold('worker.step.after-action', { step: 'canva-read-binding' }, 1);
    const request = fullRequest(chat, 'R1.D1', events);
    const reached = await fakes.wait('worker.step.after-action', 240_000);
    events.push(`design held on ${reached?.service} (blue deployment ${blue?.id})`);
    up({ build: false, services: ['worker-green'] });
    const reg = await registerColour('green');
    events.push(`register green: exit ${reg.code} ${reg.lines.join(' ')}`);
    await fakes.release();
    await request;
    const [tasks] = [await tasksOfChat(chat)];
    const inv = await restateQuery<{ pinned_deployment_id: string | null; status: string }>(
      `SELECT pinned_deployment_id, status FROM sys_invocation WHERE target_service_name = 'DesignRun' AND target_service_key = 'dr-${tasks[0]?.id}'`
    );
    const drains = await finishDrains(180);
    events.push(`finish-drains: exit ${drains.code} ${drains.lines.join(' | ')}`);
    return {
      delivered: true,
      extra: [
        { name: 'green registered without force', ok: reg.code === 0, detail: `exit ${reg.code}` },
        { name: 'the in-flight design finished on the blue deployment it started on', ok: inv.length === 1 && inv[0].pinned_deployment_id === blue?.id, detail: JSON.stringify(inv) },
        { name: 'blue drained and its deployment deleted', ok: drains.lines.some((l) => /deleted=blue/.test(l)), detail: drains.lines.join(' | ') },
      ],
    };
  });

  // Phase 2.1 (PHASE2_DESIGN.md slice 2.1; R1 steps S1 and S2): the worker polls Telegram, each
  // update goes to its chat's ChatInbox with key tg-<update_id>, and ChatInbox hands it to Core's
  // intake. Each scenario takes its brief to the draft; S1 kills are around the hand-off to Restate,
  // S2 kills around Core's intake. Since ADR-135 the brief opens a RequestLifecycle request.
  const toDraft = async (chat: string, tag: string, events: string[]) => {
    const update = await sendBrief(chat, tag);
    events.push(`update ${update.update_id} in chat ${chat}`);
    const taskId = await draftOf(chat);
    events.push(`task ${taskId}: draft in chat`);
    return { update, taskId };
  };

  scenario('R1.W0', 'the worker polls: brief to delivery through ChatInbox, no faults', async (chat, events) => {
    const { update, taskId } = await toDraft(chat, 'R1.W0', events);
    const approved = await approve(taskId);
    events.push(`approve: HTTP ${approved.status}`);
    const delivered = await deliver(taskId);
    events.push(`deliver: HTTP ${delivered.status}`);
    await waitDelivered(chat, taskId);
    return { delivered: true, after: () => checkIntake(chat, [update.update_id]) };
  });

  scenario('R1.S1.K1', 'worker killed after Restate accepted the update, before the offset was stored', async (chat, events) => {
    const k = await killAtPoint('worker.poller.after-enqueue', { chat });
    const { update } = await toDraft(chat, 'R1.S1.K1', events);
    events.push(`killed ${(await k.done).killed} at worker.poller.after-enqueue`);
    return { delivered: false, after: () => checkIntake(chat, [update.update_id]) };
  });

  scenario('R1.S1.K2', 'Restate killed right after getUpdates returned the update, back after 5 s', async (chat, events) => {
    const k = await killWhileHeld('worker.poller.after-getupdates', { chats: chat }, 'restate');
    const { update } = await toDraft(chat, 'R1.S1.K2', events);
    events.push(`killed ${(await k.done).killed} while the poller was held after getUpdates`);
    return { delivered: false, after: () => checkIntake(chat, [update.update_id]) };
  });

  scenario('R1.S1.K3', 'Postgres killed after Restate accepted the update, before the offset was stored; back after 5 s', async (chat, events) => {
    const k = await killWhileHeld('worker.poller.after-enqueue', { chat }, 'postgres');
    const { update } = await toDraft(chat, 'R1.S1.K3', events);
    events.push(`killed ${(await k.done).killed} while the poller was held after the enqueue`);
    // The offset could not be stored, so the update was asked for and sent again with the same key.
    return { delivered: false, after: () => checkIntake(chat, [update.update_id]) };
  });

  scenario('R1.S2.K4', 'Core killed after intake saved the request, before it answered ChatInbox', async (chat, events) => {
    const k = await killAtPoint('core.intake.after-decision', { chat });
    const { update } = await toDraft(chat, 'R1.S2.K4', events);
    events.push(`killed ${(await k.done).killed} at core.intake.after-decision`);
    return { delivered: false, after: () => checkIntake(chat, [update.update_id]) };
  });

  scenario('R1.S2.K5', 'worker killed while Core\'s intake of its update was answering; back after 5 s', async (chat, events) => {
    const k = await killWhileHeld('core.intake.after-decision', { chat }, 'worker-blue');
    const { update } = await toDraft(chat, 'R1.S2.K5', events);
    events.push(`killed ${(await k.done).killed} while Core was held at core.intake.after-decision`);
    return { delivered: false, after: () => checkIntake(chat, [update.update_id]) };
  });

  // As R1.K0: since 82b28988 intake makes no classifier call for an unscoped text. Since ADR-135 the
  // acknowledgement is the worker's own TelegramSender send: the worker is killed while Telegram holds
  // it (slowed to 4 s), so the send is uncertain, never repeated, and the office hears of it once.
  scenario('R1.S2.K5b', 'worker killed while its acknowledgement send waits for Telegram (slowed to 4 s)', async (chat, events) => {
    await fakes.telegramFault({ method: 'sendMessage', chat, kind: 'delay', delayMs: 4000, n: 1 });
    const update = await sendBrief(chat, 'R1.S2.K5b');
    events.push(`update ${update.update_id} in chat ${chat}`);
    await waitUntil('the acknowledgement send', async () => (await fakes.telegramCalls()).some((c) => c.method === 'sendMessage' && c.chat === chat), 60_000, 200);
    kill('worker-blue');
    events.push('killed worker-blue while intake was acknowledging');
    await sleep(2000);
    start('worker-blue');
    await waitHealthy('worker-blue');
    const taskId = await draftOf(chat);
    events.push(`task ${taskId}: draft in chat`);
    return { delivered: false, uncertainSends: 1, after: () => checkIntake(chat, [update.update_id]) };
  });

  scenario('R1.DUP', 'the same update handed on twice (Restate\'s key, then past it) makes one task and one acknowledgement', async (chat, events) => {
    const { update } = await toDraft(chat, 'R1.DUP', events);
    const acksBefore = (await sentTo(chat)).length;
    // The poller's key again: Restate answers with the invocation it has.
    const again = await sendToChatInbox(chat, update, `tg-${update.update_id}`);
    // Past Restate's key (the key's 7 days gone): a new invocation, and Core's intake answers it as
    // the duplicate it is.
    const other = await sendToChatInbox(chat, update, `chaos-dup-${update.update_id}`);
    events.push(`sent again: tg key HTTP ${again}, another key HTTP ${other}`);
    await waitUntil('the second hand-off to finish', async () => {
      const res = await fetch(`${RESTATE_INGRESS_URL}/ChatInbox/${chat}/get`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' });
      const view = res.ok ? await res.json() as { lastUpdateId?: number; lastIntakeStatus?: number; at?: number } : null;
      return view && view.lastUpdateId === update.update_id && view.lastIntakeStatus === 200 ? view : null;
    }, 120_000, 500).then((view) => events.push(`ChatInbox view after the second hand-off: ${JSON.stringify(view)}`));
    return {
      delivered: false,
      extra: [{ name: 'nothing new reached the chat after the update was handed on again', ok: (await sentTo(chat)).length === acksBefore, detail: `sends before=${acksBefore} after=${(await sentTo(chat)).length}` }],
      after: () => checkIntake(chat, [update.update_id]),
    };
  });

  // R07/FR-060/NFR-001: a chat opens its first request through RequestLifecycle.
  // Crash Core after it commits the intake decision but before ChatInbox receives the answer;
  // then cross Restate's seven-day key with another invocation of the same Telegram update.
  scenario('R1.S3.K1', 'a Core crash and update replay open one owned request and send one acknowledgement', async (chat, events) => {
    const killed = await killAtPoint('core.intake.after-decision', { chat });
    const update = textUpdate(chat, 'Please use a navy background and a clean serif font for the design.');
    const [updateId] = await fakes.updates([update]);
    const polled = { ...update, update_id: updateId };
    events.push(`update ${updateId} in chat ${chat}`);
    events.push(`killed ${(await killed.done).killed} after Core committed the intake decision`);
    await waitUntil('the request-owned task and acknowledgement', async () => {
      const tasks = await tasksOfChat(chat);
      const acknowledgements = (await sentTo(chat)).filter((send) => send.method === 'sendMessage' &&
        send.text?.includes('Request received.'));
      return tasks.length === 1 && acknowledgements.length === 1 ? tasks[0] : null;
    });
    const replay = await sendToChatInbox(chat, polled, `chaos-lifecycle-replay-${updateId}`);
    events.push(`same update under a second Restate key: HTTP ${replay}`);
    return {
      delivered: false,
      skipRequestChecks: true,
      extra: [{ name: 'second Restate key accepted for replay', ok: replay === 200 || replay === 202,
        detail: `HTTP ${replay}` }],
      after: async () => {
        const tasks = await tasksOfChat(chat);
        const requests = await query<{ request_id: string; root_task_id: string; owner: string; stage: string; rev: string }>(sql`
          SELECT request_id, root_task_id, owner, stage, rev FROM hawa.requests WHERE chat_id = ${chat}`);
        const projections = requests.length === 1
          ? await query<{ rev: string }>(sql`SELECT rev FROM hawa.lifecycle_projections
              WHERE request_id = ${requests[0].request_id}::uuid`)
          : [];
        const acknowledgements = (await sentTo(chat)).filter((send) => send.method === 'sendMessage' &&
          send.text?.includes('Request received.'));
        const invocations = requests.length === 1 ? await restateQuery<{ status: string }>(
          `SELECT status FROM sys_invocation WHERE target_service_name = 'RequestLifecycle' AND target_service_key = '${requests[0].request_id}' AND target_handler_name = 'open'`
        ) : [];
        const inbox = (await chatInboxInvocations(chat)).filter((item) =>
          item.idempotency_key === `tg-${updateId}` ||
          item.idempotency_key === `chaos-lifecycle-replay-${updateId}`);
        const offset = await storedOffset();
        return [
          { name: 'one task and one Restate-owned request', ok: tasks.length === 1 && requests.length === 1 &&
            requests[0].owner === 'restate' && requests[0].stage === 'manual' && tasks[0].id === requests[0].root_task_id,
            detail: JSON.stringify({ tasks, requests }) },
          { name: 'one version-one projection', ok: projections.length === 1 && Number(projections[0].rev) === 1,
            detail: JSON.stringify(projections) },
          { name: 'one requester acknowledgement', ok: acknowledgements.length === 1,
            detail: `acknowledgements=${acknowledgements.length}` },
          { name: 'request owner invocation completed', ok: invocations.length === 1 && invocations[0].status === 'completed',
            detail: JSON.stringify(invocations) },
          { name: 'both ChatInbox invocations completed', ok: inbox.length === 2 && inbox.every((item) => item.status === 'completed'),
            detail: JSON.stringify(inbox) },
          { name: 'Telegram offset passed the update', ok: offset >= updateId,
            detail: `offset=${offset} update=${updateId}` },
        ];
      },
    };
  });

  scenario('R1.S3.PHOTO', 'a captioned photo survives a Core crash, binds to one request, and is downloaded once', async (chat, events) => {
    const fileId = `lifecycle-reference-${chat}`;
    const size = 1024;
    await fakes.file({ file_id: fileId, size, mime: 'image/jpeg' });
    const killed = await killAtPoint('core.intake.after-decision', { chat });
    const update = captionedPhotoUpdate(chat, fileId, size,
      'Please use the attached image as a reference and change the background to navy.');
    const [updateId] = await fakes.updates([update]);
    const polled = { ...update, update_id: updateId };
    events.push(`captioned photo update ${updateId} in chat ${chat}`);
    events.push(`killed ${(await killed.done).killed} after the stored photo decision`);
    await waitUntil('the photo-owned request and acknowledgement', async () => {
      const requests = await query<{ request_id: string }>(sql`SELECT request_id FROM hawa.requests WHERE chat_id = ${chat}`);
      const acks = (await sentTo(chat)).filter((send) => send.method === 'sendMessage' && send.text?.includes('Request received.'));
      return requests.length === 1 && acks.length === 1 ? requests[0] : null;
    });
    const replay = await sendToChatInbox(chat, polled, `chaos-photo-replay-${updateId}`);
    events.push(`same photo under a second Restate key: HTTP ${replay}`);
    return {
      delivered: false, skipRequestChecks: true,
      extra: [{ name: 'second photo update accepted for replay', ok: replay === 200 || replay === 202, detail: `HTTP ${replay}` }],
      after: async () => {
        const requests = await query<{ request_id: string; root_task_id: string; owner: string; stage: string }>(sql`
          SELECT request_id, root_task_id, owner, stage FROM hawa.requests WHERE chat_id = ${chat}`);
        const tasks = await tasksOfChat(chat);
        const files = requests.length === 1 ? await query<{ sha256: string; role: string; size: string; media_type: string }>(sql`
          SELECT f.sha256, f.role, b.size, b.media_type FROM hawa.task_files f
          JOIN hawa.blobs b ON b.sha256 = f.sha256 WHERE f.task_id = ${requests[0].root_task_id}::uuid`) : [];
        const refs = files.length === 1 ? await query<{ h: string }>(sql`
          SELECT h FROM hawa.blob_reference_hashes() AS h WHERE h = ${files[0].sha256}`) : [];
        const decisions = await query<{ payload: any }>(sql`SELECT payload FROM hawa.inbox_events
          WHERE source_account_id = 'lifecycle_chat_open' AND source_event_id = ${String(updateId)}`);
        const downloads = (await fakes.polls()).downloads?.filter((id: string) => id === fileId) ?? [];
        const acks = (await sentTo(chat)).filter((send) => send.method === 'sendMessage' && send.text?.includes('Request received.'));
        const parked = await query<{ n: string }>(sql`SELECT count(*) AS n FROM hawa.inbox_events WHERE source_event_id = ${`parked-update-${updateId}`}`);
        const inbox = (await chatInboxInvocations(chat)).filter((item) =>
          item.idempotency_key === `tg-${updateId}` || item.idempotency_key === `chaos-photo-replay-${updateId}`);
        return [
          { name: 'one Restate-owned manual request and task', ok: requests.length === 1 && tasks.length === 1 &&
            requests[0].owner === 'restate' && requests[0].stage === 'manual' && requests[0].root_task_id === tasks[0].id,
            detail: JSON.stringify({ requests, tasks }) },
          { name: 'the image is bound to the task and retained for retrieval', ok: files.length === 1 &&
            files[0].role === 'reference_image' && files[0].media_type === 'image/jpeg' && Number(files[0].size) === size && refs.length === 1,
            detail: JSON.stringify({ files, refs }) },
          { name: 'the decision carries only an image reference', ok: decisions.length === 1 &&
            decisions[0].payload?.draft?.lifecycleImage?.sha256 === files[0]?.sha256 &&
            !JSON.stringify(decisions[0].payload).includes('/9j/'), detail: JSON.stringify(decisions[0]?.payload?.draft?.lifecycleImage) },
          { name: 'the photo is downloaded once across crash and replay', ok: downloads.length === 1, detail: `downloads=${downloads.length}` },
          { name: 'one acknowledgement and no parked update', ok: acks.length === 1 && Number(parked[0]?.n ?? 0) === 0,
            detail: `acknowledgements=${acks.length} parked=${parked[0]?.n ?? 0}` },
          { name: 'both photo intake invocations completed', ok: inbox.length === 2 && inbox.every((item) => item.status === 'completed'),
            detail: JSON.stringify(inbox) },
        ];
      },
    };
  });

  for (const mediaKind of ['captioned', 'captionless', 'album', 'document', 'document-album'] as const) {
  const document = mediaKind === 'document' || mediaKind === 'document-album';
  const album = mediaKind === 'album' || mediaKind === 'document-album';
  const captionless = mediaKind === 'captionless' || mediaKind === 'document';
  const scenarioId = document ? (album ? 'R1.S3.DOCUMENT_ALBUM' : 'R1.S3.IMAGE_DOCUMENT')
    : album ? 'R1.S3.ALBUM' : captionless ? 'R1.S3.CAPTIONLESS_PHOTO' : 'R1.S3.REVISION_PHOTO';
  scenario(scenarioId, `${mediaKind} photo input survives Core SIGKILL before task projection`, async (chat, events) => {
    await sendBrief(chat, scenarioId);
    const request = await waitUntil('the first draft to enter lifecycle review', async () => {
      const [row] = await query<{ request_id: string; current_task_id: string; rev: string; stage: string }>(sql`
        SELECT request_id, current_task_id, rev, stage FROM hawa.requests WHERE chat_id = ${chat}`);
      return row?.stage === 'in_review' && Number(row.rev) === 2 ? row : null;
    });
    const rootTaskId = request.current_task_id;
    const [root] = await query<{ revision_id: string }>(sql`
      SELECT current_design_revision_id AS revision_id FROM hawa.tasks WHERE id = ${rootTaskId}::uuid`);
    if (!root?.revision_id) throw new Error(`task ${rootTaskId} has no reviewable revision`);
    const office = await fakes.core(`/tasks/${rootTaskId}/revisions/${root.revision_id}/decisions`,
      secrets().CHAOS_REVIEWER_KEY, { headers: { 'Idempotency-Key': randomUUID() }, body: {
        action: 'revision_requested', revisionRequest: {
          scope: 'copy', category: 'factual_error', targetNodes: ['venue'], priority: 'high',
          isReusableFeedback: false, comment: 'Use the new image as the visual reference',
        },
      } });
    events.push(`office revision: HTTP ${office.status}`);
    if (office.status !== 201) throw new Error(`office revision refused: ${JSON.stringify(office.json).slice(0, 400)}`);
    await waitUntil('request waiting for a revision at rev 3', async () => {
      const [row] = await query<{ rev: string; stage: string }>(sql`
        SELECT rev, stage FROM hawa.requests WHERE request_id = ${request.request_id}::uuid`);
      return row?.stage === 'manual' && Number(row.rev) === 3 ? row : null;
    });
    const fileId = `lifecycle-revision-${chat}`;
    const secondFileId = `${fileId}-second`;
    const size = 1024;
    await fakes.file({ file_id: fileId, size, mime: 'image/jpeg' });
    let update: { message: Record<string, unknown> } = captionedPhotoUpdate(chat, fileId, size,
      'Please use this photo as the reference and change the background to navy.');
    const asDocument = (part: { message: Record<string, unknown> }, id: string, bytes: number) => {
      delete part.message.photo;
      part.message.document = { file_id: id, file_name: 'original.jpg', mime_type: 'image/jpeg', file_size: bytes,
        thumbnail: { file_id: `${id}-thumbnail` } };
    };
    if (document) asDocument(update, fileId, size);
    if (captionless || album) {
      const noticeId = await waitUntil('the current office revision notice to be confirmed', async () => {
        const [mark] = await query<{ message_id: string }>(sql`SELECT payload->>'messageId' AS message_id
          FROM hawa.inbox_events WHERE source_account_id = 'telegram_delivery'
            AND event_kind = 'telegram_message_sent'
            AND source_event_id = ${`lc:${request.request_id}:3:office-revision-notify:send`}`);
        return mark?.message_id ? Number(mark.message_id) : null;
      });
      if (captionless) delete update.message.caption;
      update.message.reply_to_message = { message_id: noticeId };
      events.push(`${mediaKind} reply to confirmed notice ${noticeId}`);
      if (album) {
        await fakes.file({ file_id: secondFileId, size: size + 1, mime: 'image/jpeg' });
        const second: { message: Record<string, unknown> } = captionedPhotoUpdate(chat, secondFileId, size + 1, '');
        if (document) asDocument(second, secondFileId, size + 1);
        delete second.message.caption;
        const groupId = `chaos-album-${chat}`;
        update.message.media_group_id = groupId;
        second.message.media_group_id = groupId;
        second.message.reply_to_message = { message_id: noticeId };
        const partIds = await fakes.updates([update, second]);
        await waitUntil('both album parts saved before confirmation', async () => {
          const [row] = await query<{ n: string }>(sql`SELECT count(*) AS n FROM hawa.inbox_events
            WHERE source_account_id = 'lifecycle_album_part' AND payload->>'chatId' = ${chat}
              AND payload->>'groupId' = ${groupId} AND payload->'image'->>'sha256' IS NOT NULL`);
          return Number(row?.n) === 2 ? true : null;
        });
        if ((await tasksOfChat(chat)).length !== 1) throw new Error('An album started a task before confirmation');
        events.push(`saved album updates ${partIds.join(', ')}; no child before confirmation`);
        const confirmation: { message: Record<string, unknown> } = textUpdate(chat, '/use_album');
        confirmation.message.reply_to_message = { message_id: update.message.message_id };
        update = confirmation;
      }
    }
    const killed = await killAtPoint(album ? 'core.intake.after-album-confirmation' : 'core.intake.after-revision-photo-decision', { chat });
    const [updateId] = await fakes.updates([update]);
    const polled = { ...update, update_id: updateId };
    events.push(`revision photo update ${updateId} in request ${request.request_id}`);
    events.push(`killed ${(await killed.done).killed} after ${album ? 'album confirmation' : 'photo decision'}, before child task projection`);
    const child = await waitUntil('one revision task after Core restart', async () => {
      const tasks = await tasksOfChat(chat);
      const [row] = await query<{ rev: string; current_task_id: string }>(sql`
        SELECT rev, current_task_id FROM hawa.requests WHERE request_id = ${request.request_id}::uuid`);
      return tasks.length === 2 && Number(row?.rev) >= 4 && row?.current_task_id !== rootTaskId
        ? row.current_task_id : null;
    });
    events.push(`child task ${child} after restart`);
    const replay = await sendToChatInbox(chat, polled, `chaos-revision-photo-replay-${updateId}`);
    events.push(`same update under a second Restate key: HTTP ${replay}`);
    await waitUntil('both photo intakes to complete', async () => {
      const inbox = (await chatInboxInvocations(chat)).filter((item) =>
        item.idempotency_key === `tg-${updateId}` ||
        item.idempotency_key === `chaos-revision-photo-replay-${updateId}`);
      return inbox.length === 2 && inbox.every((item) => item.status === 'completed') ? inbox : null;
    });
    const outcome = await waitUntil('the revision design to settle', async () => {
      const result = await designOutcome(child);
      const [row] = await query<{ stage: string }>(sql`
        SELECT stage FROM hawa.requests WHERE request_id = ${request.request_id}::uuid`);
      const state = await taskState(child);
      return result && (row?.stage === 'in_review' || state?.startsWith('failed')) ? result : null;
    });
    events.push(`child design outcome: ${outcome}`);
    // Since ADR-113 (7765a9e3) a revision linked to an earlier design never regenerates from the local
    // recipe: its run ends DESIGN_REJECTED (NATIVE_REVISION_HANDOFF_REQUIRED) with no plan, no import
    // and no paid call, and RequestLifecycle holds the request at `manual` for the office's native
    // revision recovery (ADR-114). Until 2026-09-28 this scenario expected a planner redraw here and
    // approved and delivered it; the recovery route itself (link, confirm, capture, submit) is not driven.
    const [held] = await query<{ code: string | null }>(sql`SELECT data->>'code' AS code FROM hawa.task_events
      WHERE task_id = ${child}::uuid AND event_type = 'task.state_changed' AND data ? 'outcome'
      ORDER BY occurred_at DESC LIMIT 1`);
    events.push(`child held: ${outcome} (${held?.code ?? 'no code'})`);
    return { delivered: false, skipRequestChecks: true,
      extra: [{ name: 'second revision photo update accepted for replay',
        ok: replay === 200 || replay === 202, detail: `HTTP ${replay}` }],
      after: async () => {
        const tasks = await tasksOfChat(chat);
        const [state] = await query<{ current_task_id: string; rev: string; owner: string; stage: string }>(sql`
          SELECT current_task_id, rev, owner, stage FROM hawa.requests WHERE request_id = ${request.request_id}::uuid`);
        const projections = await query<{ rev: string }>(sql`
          SELECT rev FROM hawa.lifecycle_projections WHERE request_id = ${request.request_id}::uuid ORDER BY rev`);
        const files = await query<{ task_id: string; sha256: string; role: string; size: string; media_type: string }>(sql`
          SELECT f.task_id, f.sha256, f.role, b.size, b.media_type FROM hawa.task_files f
          JOIN hawa.blobs b ON b.sha256 = f.sha256 WHERE f.task_id IN (${rootTaskId}::uuid, ${child}::uuid)`);
        const decisions = await query<{ payload: any }>(sql`SELECT payload FROM hawa.inbox_events
          WHERE source_account_id = ${album ? 'lifecycle_album_confirm' : 'lifecycle_chat_revision_photo'}
            AND source_event_id = ${String(updateId)}`);
        const downloads = (await fakes.polls()).downloads?.filter((id: string) =>
          id.startsWith(fileId)) ?? [];
        const parked = await query<{ n: string }>(sql`SELECT count(*) AS n FROM hawa.inbox_events
          WHERE source_event_id = ${`parked-update-${updateId}`}`);
        const inbox = (await chatInboxInvocations(chat)).filter((item) =>
          item.idempotency_key === `tg-${updateId}` ||
          item.idempotency_key === `chaos-revision-photo-replay-${updateId}`);
        const unfinished = await restateQuery<{ status: string; target_service_name: string; target_handler_name: string }>(
          `SELECT status, target_service_name, target_handler_name FROM sys_invocation WHERE status NOT IN ('completed')`);
        const active = unfinished.filter((item) => !(item.status === 'scheduled' &&
          item.target_service_name === 'RequestLifecycle' && item.target_handler_name === 'reminderTick'));
        const [outbox] = await query<{ n: string }>(sql`SELECT count(*) AS n FROM hawa.outbox_commands
          WHERE state IN ('pending', 'leased') AND available_at <= now() + interval '5 seconds'`);
        const model = (await fakes.modelLedger()).ledger as Array<{route:string;status:number;imageSha256?:string[]}>;
        const [effects] = await query<{ plans: string; operations: string }>(sql`SELECT
            (SELECT count(*) FROM hawa.canva_design_plans WHERE task_id = ${child}::uuid) AS plans,
            (SELECT count(*) FROM hawa.canva_remote_operations WHERE task_id = ${child}::uuid) AS operations`);
        return [
          { name: 'one owned child task after the office revision',
            ok: tasks.length === 2 && tasks[0].id === rootTaskId && tasks[1].id === child &&
              state?.owner === 'restate' && state.current_task_id === child && Number(state.rev) >= 4,
            detail: JSON.stringify({ tasks, state }) },
          { name: 'requester revision projection recorded exactly once',
            ok: projections.filter((row) => Number(row.rev) === 4).length === 1,
            detail: JSON.stringify(projections) },
          { name: 'all selected photos bound only to the child task', ok: files.length === (album ? 2 : 1) &&
              files.every((file) => file.task_id === child && file.role === 'reference_image' &&
                file.media_type === 'image/jpeg') &&
              files.map((file) => Number(file.size)).sort().join(',') === (album ? `${size},${size + 1}` : String(size)),
            detail: JSON.stringify(files) },
          { name: 'hash-bound photo decision, with no image bytes in the event',
            ok: decisions.length === 1 && (album
              ? decisions[0].payload?.snapshot?.ref?.images?.length === 2 && files.every((file) =>
                decisions[0].payload.snapshot.ref.images.some((image: { sha256: string }) => image.sha256 === file.sha256))
              : decisions[0].payload?.requestId === request.request_id && decisions[0].payload?.image?.sha256 === files[0]?.sha256) &&
              !JSON.stringify(decisions[0].payload).includes('/9j/'),
            detail: JSON.stringify(decisions[0]?.payload) },
          { name: 'one download per photo and no parked update across kill and replay',
            ok: downloads.length === (album ? 2 : 1) && new Set(downloads).size === downloads.length && Number(parked[0]?.n ?? 0) === 0,
            detail: `downloads=${downloads.length} parked=${parked[0]?.n ?? 0}` },
          { name: 'both ChatInbox invocations completed',
            ok: inbox.length === 2 && inbox.every((item) => item.status === 'completed'),
            detail: JSON.stringify(inbox) },
          { name: 'the linked revision is held for the native handoff (ADR-113, ADR-114)',
            ok: tasks[1]?.state === 'failed_operator' && state?.stage === 'manual' && Number(state.rev) === 5 &&
              outcome === 'DESIGN_REJECTED' && held?.code === 'NATIVE_REVISION_HANDOFF_REQUIRED',
            detail: JSON.stringify({ childState: tasks[1]?.state, request: state, outcome, code: held?.code }) },
          { name: 'the held revision made no plan, no Canva effect and no unmatched model call',
            ok: Number(effects?.plans) === 0 && Number(effects?.operations) === 0 &&
              !model.some((entry) => entry.route.startsWith('unmatched')),
            detail: JSON.stringify({ effects, unmatched: model.filter((entry) => entry.route.startsWith('unmatched')).length }) },
          { name: 'only future lifecycle reminders remain scheduled',
            ok: active.length === 0 && Number(outbox?.n ?? -1) === 0,
            detail: JSON.stringify({ unfinished, readyOutbox: outbox?.n }) },
        ];
      },
    };
  });

  }

  scenario('R1.S3.MEDIA', 'a PDF without client selection gets one durable review prompt and no task', async (chat, events) => {
    const update = imageDocumentUpdate(chat, 'lifecycle-pdf', 128,
      'KAAE members evening\n---\nDecember 4, 2026\nErbil');
    update.message.document.mime_type = 'application/pdf';
    update.message.document.file_name = 'brief.pdf';
    const [updateId] = await fakes.updates([update]);
    const polled = { ...update, update_id: updateId };
    events.push(`captioned PDF update ${updateId} in chat ${chat}`);
    await waitUntil('the PDF review prompt to be sent', async () => {
      const rows = await query<{ n: string }>(sql`SELECT count(*) AS n FROM hawa.inbox_events
        WHERE source_account_id = 'lifecycle_source_admission' AND source_event_id = ${String(updateId)}`);
      const notices = (await sentTo(chat)).filter(s => s.method === 'sendMessage' && s.text?.includes('Name one active client'));
      return Number(rows[0]?.n) === 1 && notices.length === 1 ? true : null;
    });
    const replay = await sendToChatInbox(chat, polled, `chaos-media-replay-${updateId}`);
    events.push(`duplicate media update under a second Restate key: HTTP ${replay}`);
    return { delivered: false, skipRequestChecks: true,
      extra: [{ name: 'second media update accepted for replay', ok: replay === 200 || replay === 202,
        detail: `HTTP ${replay}` }],
      after: async () => {
        const tasks = await tasksOfChat(chat);
        const rows = await query<{ source_account_id: string }>(sql`SELECT source_account_id
          FROM hawa.inbox_events WHERE source_event_id IN (${String(updateId)}, ${`parked-update-${updateId}`})
            AND source_account_id IN ('lifecycle_source_admission', 'telegram')`);
        const notices = (await sentTo(chat)).filter((s) => s.method === 'sendMessage' &&
          s.text?.includes('Name one active client'));
        const alerts = (await sentTo(OFFICE_CHAT)).filter((s) => s.method === 'sendMessage' &&
          s.text?.includes(String(updateId)));
        const inbox = (await chatInboxInvocations(chat)).filter((item) =>
          item.idempotency_key === `tg-${updateId}` || item.idempotency_key === `chaos-media-replay-${updateId}`);
        return [
          { name: 'no legacy task created', ok: tasks.length === 0, detail: `tasks=${tasks.length}` },
          { name: 'one admission refusal and no parked update', ok: rows.length === 1 &&
            rows[0].source_account_id === 'lifecycle_source_admission',
            detail: JSON.stringify(rows) },
          { name: 'one requester correction prompt without an office failure alert', ok: notices.length === 1 && alerts.length === 0,
            detail: `sender=${notices.length} office=${alerts.length}` },
          { name: 'both media intake invocations completed', ok: inbox.length === 2 &&
            inbox.every((item) => item.status === 'completed'), detail: JSON.stringify(inbox) },
        ];
      },
    };
  });

  // Slice 2.2 (PHASE2_DESIGN.md section 3; design R1 S8): the Delivery workflow and TelegramSender.
  // Each request pins two files; no scenario presses Deliver twice. Since ADR-059 (99eb6b04) a task
  // claims the Restate executor only when RequestLifecycle opens it, and since ADR-135 every request
  // is opened that way.
  scenario('L2.0', 'the Delivery workflow sends both approved files and the notice once, no faults', async (chat, events) => {
    const { deliveryId } = await workflowRequest(chat, 'L2.0', events);
    // Core reads a finished run's outcome here when its report never arrived (startWorkflowDelivery).
    const output = await fetch(`http://127.0.0.1:${PORTS.restateIngress}/restate/workflow/Delivery/${encodeURIComponent(deliveryId)}/output`);
    const outcome = output.ok ? await output.json() as { outcome?: string } : null;
    events.push(`workflow output: HTTP ${output.status} ${JSON.stringify(outcome)}`);
    return {
      delivered: true, files: 2, executor: 'restate',
      extra: [{ name: "Restate keeps the finished run's outcome where Core reads it", ok: output.status === 200 && outcome?.outcome === 'delivered', detail: `HTTP ${output.status} ${JSON.stringify(outcome)}` }],
    };
  });

  scenario('L2.K14', 'Core killed in the middle of the delivery (Drive upload slowed to 8 s), back after 5 s; Deliver pressed once', async (chat, events) => {
    let stateAfterRestart = '';
    await workflowRequest(chat, 'L2.K14', events, {
      beforeDeliver: async () => { await fakes.googleDelay({ path: '^/drive/v3/files', delayMs: 8000, n: 1 }); },
      afterDeliver: async (taskId) => {
        await sleep(2000);
        const stateAtKill = await taskState(taskId);
        kill('core');
        await sleep(5000);
        start('core');
        await waitHealthy('core');
        stateAfterRestart = String(await taskState(taskId));
        events.push(`killed core 2 s into the delivery (task ${stateAtKill}); after the restart: task ${stateAfterRestart}`);
      },
    });
    return {
      delivered: true, files: 2, executor: 'restate',
      extra: [{ name: 'the delivery finishes after a Core restart without a second Deliver press', ok: true, detail: `task ${stateAfterRestart} right after the restart, complete without another press` }],
    };
  });

  scenario('L2.K15', 'Core killed at core.delivery.after-drive (files in Drive, nothing recorded), restarted', async (chat, events) => {
    const k = await killAtPoint('core.delivery.after-drive', { mode: 'workflow' });
    await workflowRequest(chat, 'L2.K15', events);
    events.push(`killed ${(await k.done).killed} at core.delivery.after-drive`);
    return { delivered: true, files: 2, executor: 'restate' };
  });

  scenario('L2.K16', 'worker killed between the two files', async (chat, events) => {
    const k = await killAtPoint('worker.delivery.between-files', {});
    await workflowRequest(chat, 'L2.K16', events);
    events.push(`killed ${(await k.done).killed} at worker.delivery.between-files`);
    return { delivered: true, files: 2, executor: 'restate' };
  });

  scenario('L2.K17', 'Postgres killed after Telegram took the first file, before its mark was written; back after 5 s', async (chat, events) => {
    const k = await killWhileHeld('worker.sender.after-telegram', { commandType: 'lifecycle', kind: 'document' }, 'postgres');
    await workflowRequest(chat, 'L2.K17', events);
    events.push(`killed ${(await k.done).killed} while the sender was held after the first file`);
    // The send's answer is journaled and its 'sent' mark written once Postgres is back: nothing is
    // uncertain, so the office hears nothing.
    return { delivered: true, files: 2, executor: 'restate', uncertainSends: 0 };
  });

  scenario('L2.K18', 'Restate killed between the two files, back after 5 s', async (chat, events) => {
    const k = await killWhileHeld('worker.delivery.between-files', {}, 'restate');
    await workflowRequest(chat, 'L2.K18', events);
    events.push(`killed ${(await k.done).killed} while the delivery was held between the files`);
    return { delivered: true, files: 2, executor: 'restate' };
  });

  scenario('L2.K12', 'worker killed after Telegram took the first file, before its mark (one uncertain send expected)', async (chat, events) => {
    const k = await killAtPoint('worker.sender.after-telegram', { commandType: 'lifecycle', kind: 'document' });
    // A request-owned delivery with an unconfirmed send is held for staff (ADR-043, ADR-045) and
    // completes only on an administrator's confirmation (ADR-046); until 2026-09-28 this expected the
    // slice 2.2 workflow to complete on its own.
    let settlement: InvariantResult[] = [];
    await workflowRequest(chat, 'L2.K12', events, { beforeComplete: async (taskId) => {
      events.push(`killed ${(await k.done).killed} after the first document send`);
      settlement = await staffConfirmVisible(chat, taskId, events);
    } });
    return { delivered: true, files: 2, executor: 'restate', uncertainSends: 1, extra: settlement };
  });

  scenario('L2.429', 'Telegram answers 429 (retry_after 3) to the second file', async (chat, events) => {
    await fakes.telegramFault({ method: 'sendDocument', chat, kind: '429', n: 1, retryAfter: 3, skip: 1 });
    await workflowRequest(chat, 'L2.429', events);
    const calls = (await fakes.sent()).filter((s: any) => s.chat_id === chat && s.method === 'sendDocument');
    const limited = calls.find((s: any) => s.fault === '429');
    const after = limited ? calls.find((s: any) => s.delivered && s.seq > limited.seq) : undefined;
    const waitedMs = limited && after ? Date.parse(after.at) - Date.parse(limited.at) : -1;
    events.push(`429 at ${limited?.at ?? 'never'}; the second file delivered ${waitedMs} ms later`);
    return {
      delivered: true, files: 2, executor: 'restate',
      extra: [{ name: "the second file is sent again no sooner than Telegram's retry_after (3 s)", ok: Boolean(limited && after) && waitedMs >= 3000, detail: `waited ${waitedMs} ms after the 429` }],
    };
  });

  scenario('R4', 'two chats: a 19.9 MB picture with a 30 s download in chat A must not delay chat B', async (_chat, events) => {
    const chatA = newChat();
    const chatB = newChat();
    await fakes.file({ file_id: 'r4-big', size: 19_900_000, mime: 'image/jpeg', delayMs: 30_000 });
    // Neither names a client, so neither starts a paid design: only intake is measured.
    const sentAt = Date.now();
    await fakes.updates([
      imageDocumentUpdate(chatA, 'r4-big', 19_900_000, 'A reference picture for our next poster'),
      textUpdate(chatB, 'Staff meeting notice\n\n-----\n\nStaff meeting\n\nSunday 10:00, room 4'),
    ]);
    const firstToB = await waitUntil('any answer in chat B', async () => (await sentTo(chatB))[0], 120_000, 250);
    const bMs = Date.parse(firstToB.at) - sentAt;
    const firstToA = await waitUntil('any answer in chat A', async () => (await sentTo(chatA))[0], 120_000, 500);
    const aMs = Date.parse(firstToA.at) - sentAt;
    events.push(`chat B answered after ${bMs} ms; chat A after ${aMs} ms`);
    const tasksB = await tasksOfChat(chatB);
    return {
      delivered: false,
      // R4 has no Canva request of its own: the per-request checks do not apply to chat _chat.
      extra: [
        { name: 'chat B is acknowledged in under 5 s while chat A downloads', ok: bMs < 5000, detail: `chat B first answer after ${bMs} ms (chat A after ${aMs} ms)` },
        { name: 'chat B has its one task', ok: tasksB.length === 1, detail: `tasks=${tasksB.length}` },
      ],
      skipRequestChecks: true,
    };
  });
});

/**
 * Slice 2.2: a request delivered by the Restate Delivery workflow. The PNG and the
 * PPTX are pinned, so two files go to the requester and a fault can fall between them. The Deliver
 * press is answered at once (202, executor restate); nothing presses it again.
 */
async function workflowRequest(chat: string, tag: string, events: string[], hooks: { beforeDeliver?: (taskId: string) => Promise<void>; afterDeliver?: (taskId: string) => Promise<void>; beforeComplete?: (taskId: string) => Promise<void> } = {}) {
  const taskId = await briefToDraft(chat, tag);
  events.push(`task ${taskId}: draft in chat`);
  const approved = await approve(taskId, { pinDeck: true });
  events.push(`approve (PNG and PPTX pinned): HTTP ${approved.status}`);
  if (approved.status >= 300) throw new Error(`approval refused: HTTP ${approved.status} ${JSON.stringify(approved.body).slice(0, 300)}`);
  if (hooks.beforeDeliver) await hooks.beforeDeliver(taskId);
  const started = Date.now();
  const delivered = await deliver(taskId);
  events.push(`deliver: HTTP ${delivered.status} in ${Date.now() - started} ms, executor ${delivered.body?.executor}, ${delivered.body?.deliveryId}`);
  // 202 while the workflow runs; a request-owned delivery that finished before Core answered is 200.
  if ((delivered.status !== 202 && delivered.status !== 200) || delivered.body?.executor !== 'restate') {
    throw new Error(`the request's delivery was not handed to the workflow: HTTP ${delivered.status} ${JSON.stringify(delivered.body).slice(0, 300)}`);
  }
  if (hooks.afterDeliver) await hooks.afterDeliver(taskId);
  if (hooks.beforeComplete) await hooks.beforeComplete(taskId);
  await waitDelivered(chat, taskId, 300_000, 2);
  events.push(`delivered, task ${await taskState(taskId)}`);
  return { taskId, deliveryId: String(delivered.body.deliveryId) };
}
