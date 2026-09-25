/**
 * The chaos suite (architecture programme, PLAN.md Phase 2; PHASE2_DESIGN.md section 6): scripted
 * requests through the whole stack in the hawa-chaos compose project, with processes killed at named
 * points, and the invariants of section 6.3 checked after each request.
 *
 * It runs only with HAWA_CHAOS=1 (README.md): it builds images and starts six containers.
 *   HAWA_CHAOS=1 npx vitest run packages/testkit/chaos/chaos.test.ts
 *   HAWA_CHAOS_KEEP=1   leave the project running afterwards (default: taken down with its volumes)
 *   HAWA_CHAOS_ONLY=R1.0,R4   run only these scenarios
 *   CHAOS_TELEGRAM_POLLER=worker   the worker polls Telegram through ChatInbox (Phase 2.1; run.ts --poller worker)
 *
 * It drives the legacy path; with the worker poller, intake goes through ChatInbox first. The results (per scenario: invariants, time, memory) are written to
 * .run/last-run.json and printed; a failed invariant fails its scenario.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { build, CHAOS_DIR, closeDb, down, fakes, kill, memory, PORTS, query, restateQuery, RESTATE_INGRESS_URL, sql, start, up, waitHealthy } from './driver/stack.js';
import { connectCanva, finishDrains, kaaeClientDna, registerColour, upgradeSchema, KAAE_CLIENT_ID } from './driver/provision.js';
import {
  checkLifecycle, lifecycleBrief, lifecycleChat, lifecycleChatList, lifecycleView, liveColour, messagesWith, replyToDraft, requestsOfChat,
  restartWorkerWith, roundTasks, tap, waitDraftSent, type LifecycleRequest,
} from './driver/lifecycle.js';
import {
  OFFICE_CHAT, approve, briefText, briefToDraft, checkIntake, checkRequest, deliver, draftOf, imageDocumentUpdate, killAtPoint, killWhileHeld, quiescent, sendBrief,
  sendToChatInbox, sentTo, sleep, tasksOfChat, taskState, textUpdate, uncoveredModelCalls, waitDelivered, waitUntil, type InvariantResult,
} from './driver/scenario.js';

const enabled = process.env.HAWA_CHAOS === '1';
const only = (process.env.HAWA_CHAOS_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const keep = process.env.HAWA_CHAOS_KEEP === '1';
// Who polls Telegram in the stack (run.ts --poller; docker-compose.chaos.yml): Core, as production
// does today, or the worker's poller and ChatInbox (Phase 2.1). Scenarios of 2.1 need the worker.
const poller = (process.env.CHAOS_TELEGRAM_POLLER || 'core').trim().toLowerCase() === 'worker' ? 'worker' : 'core';

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

let chatSeq = 9_200_000 + (Date.now() % 100_000) * 10;
const newChat = () => String(++chatSeq);
// Chats on HAWA_LIFECYCLE_CHATS (docker-compose.chaos.yml): 9300001 to 9300012, one per scenario.
let flaggedSeq = 9_300_000;
const flaggedChat = () => {
  if (flaggedSeq >= 9_300_012) throw new Error('every flagged chat of docker-compose.chaos.yml is used; add more there');
  return String(++flaggedSeq);
};

/**
 * One scenario: a fresh chat, the script, quiescence, then the invariants. Every invariant is
 * recorded; the scenario fails if any does not hold.
 */
interface Expectation {
  delivered: boolean;
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
  /** Who delivers: 'restate' for a chat on HAWA_LIFECYCLE_CHATS (slice 2.2). */
  executor?: 'core' | 'restate';
}

function scenario(name: string, what: string, script: (chat: string, events: string[]) => Promise<Expectation>, timeoutMs = 12 * 60_000, options: { flagged?: boolean; lifecycle?: boolean; needs?: 'worker-poller' } = {}) {
  const run = enabled && (only.length === 0 || only.includes(name)) && (options.needs !== 'worker-poller' || poller === 'worker');
  it.skipIf(!run)(`${name}: ${what}`, async () => {
    const chat = options.lifecycle ? lifecycleChat() : options.flagged ? flaggedChat() : newChat();
    const events: string[] = [];
    const started = Date.now();
    const report: ScenarioReport = { name, what, ms: 0, invariants: [], events };
    reports.push(report);
    try {
      const ledger = await fakes.modelLedger();
      const ledgerSince = Math.max(0, ...(ledger.ledger as any[]).map((l) => l.seq));
      const expectation = await script(chat, events);
      await fakes.release();
      await quiescent();
      report.invariants = [
        ...(expectation.skipRequestChecks ? [] : await checkRequest(chat, { ...expectation, ledgerSince })),
        ...(expectation.extra || []),
        ...(expectation.after ? await expectation.after() : []),
      ];
    } catch (err) {
      report.error = err instanceof Error ? err.message : String(err);
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

/** The full request on the legacy path: brief, draft, Desk approval, delivery. */
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
    build(['core', 'worker-blue']);
    // Slice 2.3: the chats whose new requests the workers' ChatInbox opens on RequestLifecycle.
    process.env.CHAOS_WORKER_LIFECYCLE_CHATS = lifecycleChatList();
    process.env.CHAOS_REMINDER_SCALE = '1';
    up({ services: ['postgres', 'restate', 'fakes'] });
    await upgradeSchema();
    await connectCanva();
    await kaaeClientDna();
    up({ build: false, services: ['core', 'worker-blue'] });
    const reg = await registerColour('blue');
    if (reg.code !== 0) throw new Error(`register blue: ${reg.lines.join(' | ')}`);
    sampleMemory();
  }, 30 * 60_000);

  afterAll(async () => {
    sampleMemory();
    const result = {
      finishedAt: new Date().toISOString(),
      telegramPoller: poller,
      totalMs: Date.now() - suiteStarted,
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

  scenario('R1.0', 'happy path: brief, draft, approve, deliver, no faults', async (chat, events) => {
    await fullRequest(chat, 'R1.0', events);
    return { delivered: true };
  });

  scenario('R1.K0', 'Core killed while the intake classifier (a paid call) is answering, back after 5 s', async (chat, events) => {
    await fakes.modelDelay({ schema: 'telegram_classifier', delayMs: 4000, n: 1 });
    const before = (await fakes.modelLedger()).arrivals.length;
    const request = fullRequest(chat, 'R1.K0', events);
    await waitUntil('the classifier request', async () => (await fakes.modelLedger()).arrivals.slice(before).some((a: any) => a.schema === 'telegram_classifier'), 60_000, 200);
    kill('core');
    events.push('killed core while the classifier was answering');
    await sleep(5000);
    start('core');
    await waitHealthy('core');
    await request;
    // The update is polled again after the restart, so intake classifies it again: the design allows 2.
    return { delivered: true, classifierAllowance: 2 };
  });

  scenario('R1.K1', 'worker killed after claiming task.created, before dispatching it', async (chat, events) => {
    const k = await killAtPoint('worker.outbox.after-claim', { commandType: 'task.created' });
    await fullRequest(chat, 'R1.K1', events);
    events.push(`killed ${(await k.done).killed} at worker.outbox.after-claim`);
    return { delivered: true };
  });

  scenario('R1.K2', 'worker killed after Restate accepted the workflow, before the outbox recorded it', async (chat, events) => {
    const k = await killAtPoint('worker.dispatch.after-submit', {});
    await fullRequest(chat, 'R1.K2', events);
    events.push(`killed ${(await k.done).killed} at worker.dispatch.after-submit`);
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

  scenario('R1.K5', 'worker killed after Core took the outcome and sent the draft, before the step was journalled', async (chat, events) => {
    const k = await killAtPoint('worker.step.after-action', { step: 'canva-notify-canva_draft_ready_for_visual_review' });
    await fullRequest(chat, 'R1.K5', events);
    events.push(`killed ${(await k.done).killed} after canva-notify-canva_draft_ready_for_visual_review`);
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

  scenario('R1.K10', 'Telegram answers 429 (retry_after 3) to the draft message', async (chat, events) => {
    // The acknowledgement is the chat's first sendMessage; the draft (with the buttons) the second.
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

  scenario('R1.K12', 'worker killed after sending the approved file, before marking it sent', async (chat, events) => {
    const k = await killAtPoint('worker.sender.after-telegram', { commandType: 'notify.published', kind: 'document' });
    const taskId = await fullRequestUntilDelivery(chat, 'R1.K12', events);
    events.push(`killed ${(await k.done).killed} after the document send`);
    await waitUntil('the delivery command to settle', async () => !(await outboxOpen(taskId)), 240_000, 2000);
    return { delivered: true, uncertainSends: 1 };
  });

  scenario('R1.K13', 'Telegram takes the approved file and the answer is lost (uncertain send)', async (chat, events) => {
    await fakes.telegramFault({ method: 'sendDocument', chat, kind: 'drop-after-processing', n: 1 });
    const taskId = await fullRequestUntilDelivery(chat, 'R1.K13', events);
    await waitUntil('the delivery command to settle', async () => !(await outboxOpen(taskId)), 240_000, 2000);
    return { delivered: true, uncertainSends: 1 };
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

  scenario('R1.K15', 'Postgres killed after the approved file was sent, before its mark was written; back after 5 s', async (chat, events) => {
    const k = await killWhileHeld('worker.sender.after-telegram', { commandType: 'notify.published', kind: 'document' }, 'postgres');
    const taskId = await fullRequestUntilDelivery(chat, 'R1.K15', events);
    events.push(`killed ${(await k.done).killed} after the document send`);
    await waitUntil('the delivery command to settle', async () => !(await outboxOpen(taskId)), 300_000, 2000);
    return { delivered: true, uncertainSends: 1 };
  });

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
      `SELECT pinned_deployment_id, status FROM sys_invocation WHERE target_service_name = 'TaskWorkflow' AND target_service_key = 'task-wf-${tasks[0]?.id}'`
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
  // S2 kills around Core's intake. Run with `run.ts --poller worker`.
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
  }, 12 * 60_000, { needs: 'worker-poller' });

  scenario('R1.S1.K1', 'worker killed after Restate accepted the update, before the offset was stored', async (chat, events) => {
    const k = await killAtPoint('worker.poller.after-enqueue', { chat });
    const { update } = await toDraft(chat, 'R1.S1.K1', events);
    events.push(`killed ${(await k.done).killed} at worker.poller.after-enqueue`);
    return { delivered: false, after: () => checkIntake(chat, [update.update_id]) };
  }, 12 * 60_000, { needs: 'worker-poller' });

  scenario('R1.S1.K2', 'Restate killed right after getUpdates returned the update, back after 5 s', async (chat, events) => {
    const k = await killWhileHeld('worker.poller.after-getupdates', { chats: chat }, 'restate');
    const { update } = await toDraft(chat, 'R1.S1.K2', events);
    events.push(`killed ${(await k.done).killed} while the poller was held after getUpdates`);
    return { delivered: false, after: () => checkIntake(chat, [update.update_id]) };
  }, 12 * 60_000, { needs: 'worker-poller' });

  scenario('R1.S1.K3', 'Postgres killed after Restate accepted the update, before the offset was stored; back after 5 s', async (chat, events) => {
    const k = await killWhileHeld('worker.poller.after-enqueue', { chat }, 'postgres');
    const { update } = await toDraft(chat, 'R1.S1.K3', events);
    events.push(`killed ${(await k.done).killed} while the poller was held after the enqueue`);
    // The offset could not be stored, so the update was asked for and sent again with the same key.
    return { delivered: false, after: () => checkIntake(chat, [update.update_id]) };
  }, 12 * 60_000, { needs: 'worker-poller' });

  scenario('R1.S2.K4', 'Core killed after intake saved the request, before it answered ChatInbox', async (chat, events) => {
    const k = await killAtPoint('core.intake.after-decision', { chat });
    const { update } = await toDraft(chat, 'R1.S2.K4', events);
    events.push(`killed ${(await k.done).killed} at core.intake.after-decision`);
    return { delivered: false, after: () => checkIntake(chat, [update.update_id]) };
  }, 12 * 60_000, { needs: 'worker-poller' });

  scenario('R1.S2.K5', 'worker killed while Core\'s intake of its update was answering; back after 5 s', async (chat, events) => {
    const k = await killWhileHeld('core.intake.after-decision', { chat }, 'worker-blue');
    const { update } = await toDraft(chat, 'R1.S2.K5', events);
    events.push(`killed ${(await k.done).killed} while Core was held at core.intake.after-decision`);
    return { delivered: false, after: () => checkIntake(chat, [update.update_id]) };
  }, 12 * 60_000, { needs: 'worker-poller' });

  scenario('R1.S2.K5b', 'worker killed while the intake classifier (a paid call, slowed to 4 s) answers its update', async (chat, events) => {
    await fakes.modelDelay({ schema: 'telegram_classifier', delayMs: 4000, n: 1 });
    const before = (await fakes.modelLedger()).arrivals.length;
    const update = await sendBrief(chat, 'R1.S2.K5b');
    events.push(`update ${update.update_id} in chat ${chat}`);
    await waitUntil('the classifier request', async () => (await fakes.modelLedger()).arrivals.slice(before).some((a: any) => a.schema === 'telegram_classifier'), 60_000, 200);
    kill('worker-blue');
    events.push('killed worker-blue while the classifier was answering');
    await sleep(2000);
    start('worker-blue');
    await waitHealthy('worker-blue');
    const taskId = await draftOf(chat);
    events.push(`task ${taskId}: draft in chat`);
    // Core's first intake call may still be classifying when Restate retries the step on the restarted
    // worker, so the design allows the classifier twice here (PHASE2_DESIGN.md 2.1 acceptance (c)).
    return { delivered: false, classifierAllowance: 2, after: () => checkIntake(chat, [update.update_id]) };
  }, 12 * 60_000, { needs: 'worker-poller' });

  scenario('R1.DUP', 'the same update handed on twice (Restate\'s key, then past it) makes one task and one acknowledgement', async (chat, events) => {
    const { update } = await toDraft(chat, 'R1.DUP', events);
    const acksBefore = (await sentTo(chat)).length;
    // The poller's key again: Restate answers with the invocation it has.
    const again = await sendToChatInbox(chat, update, `tg-${update.update_id}`);
    // Past Restate's key (a rollback to Core's poller, or the key's 7 days gone): a new invocation,
    // and Core's intake answers it as the duplicate it is.
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
  }, 12 * 60_000, { needs: 'worker-poller' });

  // Slice 2.2 (PHASE2_DESIGN.md section 3; design R1 S8): the Delivery workflow and TelegramSender, on
  // chats listed in HAWA_LIFECYCLE_CHATS. Each request pins two files; no scenario presses Deliver twice.
  scenario('L2.0', 'flagged chat: the Delivery workflow sends both approved files and the notice once, no faults', async (chat, events) => {
    const { deliveryId } = await workflowRequest(chat, 'L2.0', events);
    // Core reads a finished run's outcome here when its report never arrived (startWorkflowDelivery).
    const output = await fetch(`http://127.0.0.1:${PORTS.restateIngress}/restate/workflow/Delivery/${encodeURIComponent(deliveryId)}/output`);
    const outcome = output.ok ? await output.json() as { outcome?: string } : null;
    events.push(`workflow output: HTTP ${output.status} ${JSON.stringify(outcome)}`);
    return {
      delivered: true, files: 2, executor: 'restate',
      extra: [{ name: "Restate keeps the finished run's outcome where Core reads it", ok: output.status === 200 && outcome?.outcome === 'delivered', detail: `HTTP ${output.status} ${JSON.stringify(outcome)}` }],
    };
  }, 12 * 60_000, { flagged: true });

  scenario('L2.K14', 'flagged chat: Core killed in the middle of the delivery (Drive upload slowed to 8 s), back after 5 s; Deliver pressed once', async (chat, events) => {
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
  }, 12 * 60_000, { flagged: true });

  scenario('L2.K15', 'flagged chat: Core killed at core.delivery.after-drive (files in Drive, nothing recorded), restarted', async (chat, events) => {
    const k = await killAtPoint('core.delivery.after-drive', { mode: 'workflow' });
    await workflowRequest(chat, 'L2.K15', events);
    events.push(`killed ${(await k.done).killed} at core.delivery.after-drive`);
    return { delivered: true, files: 2, executor: 'restate' };
  }, 12 * 60_000, { flagged: true });

  scenario('L2.K16', 'flagged chat: worker killed between the two files', async (chat, events) => {
    const k = await killAtPoint('worker.delivery.between-files', {});
    await workflowRequest(chat, 'L2.K16', events);
    events.push(`killed ${(await k.done).killed} at worker.delivery.between-files`);
    return { delivered: true, files: 2, executor: 'restate' };
  }, 12 * 60_000, { flagged: true });

  scenario('L2.K17', 'flagged chat: Postgres killed after Telegram took the first file, before its mark was written; back after 5 s', async (chat, events) => {
    const k = await killWhileHeld('worker.sender.after-telegram', { commandType: 'lifecycle', kind: 'document' }, 'postgres');
    await workflowRequest(chat, 'L2.K17', events);
    events.push(`killed ${(await k.done).killed} while the sender was held after the first file`);
    // The send's answer is journaled and its 'sent' mark written once Postgres is back: nothing is
    // uncertain, so the office hears nothing.
    return { delivered: true, files: 2, executor: 'restate', uncertainSends: 0 };
  }, 12 * 60_000, { flagged: true });

  scenario('L2.K18', 'flagged chat: Restate killed between the two files, back after 5 s', async (chat, events) => {
    const k = await killWhileHeld('worker.delivery.between-files', {}, 'restate');
    await workflowRequest(chat, 'L2.K18', events);
    events.push(`killed ${(await k.done).killed} while the delivery was held between the files`);
    return { delivered: true, files: 2, executor: 'restate' };
  }, 12 * 60_000, { flagged: true });

  scenario('L2.K12', 'flagged chat: worker killed after Telegram took the first file, before its mark (one uncertain send expected)', async (chat, events) => {
    const k = await killAtPoint('worker.sender.after-telegram', { commandType: 'lifecycle', kind: 'document' });
    await workflowRequest(chat, 'L2.K12', events);
    events.push(`killed ${(await k.done).killed} after the first document send`);
    return { delivered: true, files: 2, executor: 'restate', uncertainSends: 1 };
  }, 12 * 60_000, { flagged: true });

  scenario('L2.429', 'flagged chat: Telegram answers 429 (retry_after 3) to the second file', async (chat, events) => {
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
  }, 12 * 60_000, { flagged: true });

  // Slice 2.3 part B (the worker side; PHASE2_DESIGN.md 2.3, 2.4): RequestLifecycle and DesignRun on
  // the real Restate, each request opened through ingress (as ChatInbox sends it) and followed until
  // its draft is in the chat and recorded as sent (part C projects the outcome). The full path from a
  // Telegram brief is the L3.R* scenarios below.
  scenario('L3.0', 'RequestLifecycle.open through ingress: Core records the request, DesignRun designs it once, the outcome reaches the lifecycle', async (chat, events) => {
    return lifecycleOpen(chat, 'L3.0', events);
  }, 12 * 60_000, { flagged: true });

  scenario('L3.K7b', 'worker killed after Core projected the open, before the lifecycle journaled the answer', async (chat, events) => {
    return lifecycleOpen(chat, 'L3.K7b', events, async (requestId) => {
      const armed = await killAtPoint('worker.rl.after-project', { requestId });
      return { done: armed.done.then((d) => `killed ${d.killed} at ${d.point}`) };
    });
  }, 12 * 60_000, { flagged: true });

  scenario('L3.K6', 'Core killed after committing the open projection, before answering the worker', async (chat, events) => {
    return lifecycleOpen(chat, 'L3.K6', events, async (requestId) => {
      const armed = await killAtPoint('core.project.after-commit', { requestId });
      return { done: armed.done.then((d) => `killed ${d.killed} at ${d.point}`) };
    });
  }, 12 * 60_000, { flagged: true });

  scenario('L3.K8', 'worker killed inside the DesignRun after Core planned and imported the draft, before the step was journalled', async (chat, events) => {
    return lifecycleOpen(chat, 'L3.K8', events, async () => {
      const armed = await killAtPoint('worker.step.after-action', { step: 'canva-create-draft' });
      return { done: armed.done.then((d) => `killed ${d.killed} at ${d.point}`) };
    });
  }, 12 * 60_000, { flagged: true });

  // Slice 2.3 part C (PHASE2_DESIGN.md 2.3 acceptance; section 6.3 R1 S1-S6, R2, R3, R5): chats on the
  // workers' HAWA_LIFECYCLE_CHATS (9400001 to 9400040), whose ChatInbox runs intake in decide mode and
  // opens each new request on RequestLifecycle. Run with `run.ts --poller worker`. Order matters: R2
  // restarts the worker with the reminder scale, R3.D deploys to green and R2.D2 back to blue.
  const lifecycleOk = async (chat: string, events: string[], arms: { brief?: () => Promise<{ done: Promise<unknown> }>; ok?: () => Promise<{ done: Promise<unknown> }> } = {}, allowance?: number) => {
    const ledgerSince = Math.max(0, ...((await fakes.modelLedger()).ledger as any[]).map((l) => l.seq));
    const armed = arms.brief ? await arms.brief() : null;
    const request = await lifecycleBrief(chat, `L3R1-${chat}`, events);
    if (armed) events.push(`kill: ${JSON.stringify(await armed.done).slice(0, 200)}`);
    const okArmed = arms.ok ? await arms.ok() : null;
    const okUpdate = await tap(chat, `rq:ok:${request.taskId}`);
    events.push(`tapped rq:ok (update ${okUpdate})`);
    await waitUntil('the requester\'s sign-off answered', async () => (await messagesWith(chat, 'you approved this design')).length > 0, 180_000, 1000);
    if (okArmed) events.push(`kill: ${JSON.stringify(await okArmed.done).slice(0, 200)}`);
    return { request, ledgerSince, okUpdate };
  };
  const lifecycleOkChecks = (chat: string, r: { request: LifecycleRequest; ledgerSince: number; okUpdate: number }, extra: Partial<Parameters<typeof checkLifecycle>[1]> = {}) => async () => [
    ...await checkLifecycle(chat, { stage: 'in_review', rounds: 1, ledgerSince: r.ledgerSince, updateIds: [r.request.updateId, r.okUpdate], ...extra }),
    { name: 'the sign-off is answered once', ok: (await messagesWith(chat, 'you approved this design')).length === 1, detail: `${(await messagesWith(chat, 'you approved this design')).length}` },
    { name: 'the office hears of the sign-off once', ok: (await sentTo(OFFICE_CHAT)).filter((s) => s.text?.includes('requester approved a draft') && s.text.includes(r.request.taskId)).length === 1, detail: 'office alerts naming the task' },
    { name: 'the draft picture reached the chat once', ok: (await sentTo(chat)).filter((s) => s.method === 'sendPhoto').length === 1, detail: `photos=${(await sentTo(chat)).filter((s) => s.method === 'sendPhoto').length}` },
  ];

  scenario('L3.R1.0', 'lifecycle chat: brief, draft and picture, rq:ok; no faults', async (chat, events) => {
    const r = await lifecycleOk(chat, events);
    return { delivered: false, skipRequestChecks: true, after: lifecycleOkChecks(chat, r) };
  }, 12 * 60_000, { lifecycle: true, needs: 'worker-poller' });

  scenario('L3.R1.S1K1', 'lifecycle chat: worker killed after Restate accepted the brief, before the offset was stored', async (chat, events) => {
    const r = await lifecycleOk(chat, events, { brief: () => killAtPoint('worker.poller.after-enqueue', { chat }) });
    return { delivered: false, skipRequestChecks: true, after: lifecycleOkChecks(chat, r) };
  }, 12 * 60_000, { lifecycle: true, needs: 'worker-poller' });

  scenario('L3.R1.S2K4', 'lifecycle chat: Core killed after intake decided (and recorded) the brief, before ChatInbox had the answer', async (chat, events) => {
    const r = await lifecycleOk(chat, events, { brief: () => killAtPoint('core.intake.after-decision', { chat, decision: 'new_request' }) });
    // The decision was on record before the kill: the retry is answered from it, classified once.
    return { delivered: false, skipRequestChecks: true, after: lifecycleOkChecks(chat, r, { classifierAllowance: 1 }) };
  }, 12 * 60_000, { lifecycle: true, needs: 'worker-poller' });

  scenario('L3.R1.S2K5', 'lifecycle chat: worker killed while Core held its intake answer (decision recorded)', async (chat, events) => {
    const r = await lifecycleOk(chat, events, { brief: () => killWhileHeld('core.intake.after-decision', { chat, decision: 'new_request' }, 'worker-blue') });
    return { delivered: false, skipRequestChecks: true, after: lifecycleOkChecks(chat, r, { classifierAllowance: 1 }) };
  }, 12 * 60_000, { lifecycle: true, needs: 'worker-poller' });

  scenario('L3.R1.S3K6', 'lifecycle chat: Core killed after committing the open projection, before answering', async (chat, events) => {
    const r = await lifecycleOk(chat, events, { brief: () => killAtPoint('core.project.after-commit', { key: ':1:open' }) });
    return { delivered: false, skipRequestChecks: true, after: lifecycleOkChecks(chat, r) };
  }, 12 * 60_000, { lifecycle: true, needs: 'worker-poller' });

  scenario('L3.R1.S3K7b', 'lifecycle chat: worker killed after Core projected the open, before the lifecycle journaled it', async (chat, events) => {
    const r = await lifecycleOk(chat, events, { brief: () => killAtPoint('worker.rl.after-project', { key: ':1:open' }) });
    return { delivered: false, skipRequestChecks: true, after: lifecycleOkChecks(chat, r) };
  }, 12 * 60_000, { lifecycle: true, needs: 'worker-poller' });

  scenario('L3.R1.S4K8', 'lifecycle chat: worker killed inside the DesignRun after the Canva import, before the step was journaled', async (chat, events) => {
    const r = await lifecycleOk(chat, events, { brief: () => killAtPoint('worker.step.after-action', { step: 'canva-create-draft' }) });
    return { delivered: false, skipRequestChecks: true, after: lifecycleOkChecks(chat, r) };
  }, 12 * 60_000, { lifecycle: true, needs: 'worker-poller' });

  scenario('L3.R1.S5K7b', 'lifecycle chat: worker killed after Core projected the design outcome, before the lifecycle journaled it', async (chat, events) => {
    const r = await lifecycleOk(chat, events, { brief: () => killAtPoint('worker.rl.after-project', { key: ':designFinished' }) });
    return { delivered: false, skipRequestChecks: true, after: lifecycleOkChecks(chat, r) };
  }, 12 * 60_000, { lifecycle: true, needs: 'worker-poller' });

  scenario('L3.R1.S5K11', 'lifecycle chat: Core killed after bridging the draft revision, before the outcome committed', async (chat, events) => {
    const r = await lifecycleOk(chat, events, { brief: () => killAtPoint('core.outcome.after-bridge', {}) });
    return { delivered: false, skipRequestChecks: true, after: lifecycleOkChecks(chat, r) };
  }, 12 * 60_000, { lifecycle: true, needs: 'worker-poller' });

  scenario('L3.R1.S5K12', 'lifecycle chat: worker killed after Telegram took the draft message, before its mark (one uncertain send expected)', async (chat, events) => {
    const r = await lifecycleOk(chat, events, { brief: () => killAtPoint('worker.sender.after-telegram', { chat, key: ':outcome', kind: 'text' }) });
    return { delivered: false, skipRequestChecks: true, after: lifecycleOkChecks(chat, r, { uncertainSends: 1 }) };
  }, 12 * 60_000, { lifecycle: true, needs: 'worker-poller' });

  scenario('L3.R1.S5K13', 'lifecycle chat: Telegram answers 429 (retry_after 3) to the draft message', async (chat, events) => {
    await fakes.telegramFault({ method: 'sendMessage', chat, kind: '429', retryAfter: 3, n: 1, skip: 1 });
    const r = await lifecycleOk(chat, events);
    return { delivered: false, skipRequestChecks: true, after: lifecycleOkChecks(chat, r) };
  }, 12 * 60_000, { lifecycle: true, needs: 'worker-poller' });

  scenario('L3.R1.S6K5', 'lifecycle chat: worker killed while Core held its intake answer for rq:ok', async (chat, events) => {
    const r = await lifecycleOk(chat, events, { ok: () => killWhileHeld('core.intake.after-decision', { chat, decision: 'requester' }, 'worker-blue') });
    return { delivered: false, skipRequestChecks: true, after: lifecycleOkChecks(chat, r) };
  }, 12 * 60_000, { lifecycle: true, needs: 'worker-poller' });

  // R5 and acceptance (d): a flagged chat and an unflagged one send at once, each takes its own path;
  // then the flagged chat is taken off the flag (the worker restarts without it): a change to its
  // lifecycle draft still goes to its request, and its next brief takes the legacy path.
  scenario('L3.R5', 'un-flag mid-request: a reply to a lifecycle draft still reaches the lifecycle, a new brief goes legacy; an unflagged chat alongside stays legacy', async (chat, events) => {
    const other = newChat();
    const ledgerSince = Math.max(0, ...((await fakes.modelLedger()).ledger as any[]).map((l) => l.seq));
    const [otherUpdate] = await fakes.updates([textUpdate(other, briefText(`L3R5-other-${other}`))]);
    const request = await lifecycleBrief(chat, `L3R5-${chat}`, events);
    const colour = await liveColour();
    await restartWorkerWith(colour, { lifecycleChats: lifecycleChatList([chat]) });
    events.push(`${colour} restarted without chat ${chat} on its flag list`);
    const changeUpdate = await replyToDraft(chat, request.taskId, 'make the logo bigger');
    const round1 = await waitUntil('the change round in the request', async () => {
      const rows = await roundTasks(request.requestId);
      return rows.length === 2 ? rows[1] : null;
    }, 180_000);
    await waitDraftSent(chat, request.requestId, round1.id);
    events.push(`change routed to the request: round 1 task ${round1.id}, its draft sent`);
    const [legacyUpdate] = await fakes.updates([textUpdate(chat, briefText(`L3R5-legacy-${chat}`))]);
    const legacy = await waitUntil('the legacy task of the new brief', async () => {
      const rows = await query<{ id: string; request_id: string | null; state: string }>(sql`SELECT t.id::text, t.request_id::text, t.state::text FROM hawa.tasks t
        WHERE t.id IN (SELECT aggregate_id FROM hawa.outbox_commands WHERE command_type = 'task.created' AND payload->>'sourceChannelId' = ${chat}) AND t.request_id IS NULL`);
      return rows[0]?.state === 'human_review' ? rows[0] : null;
    }, 300_000, 2000);
    events.push(`new brief took the legacy path: task ${legacy.id}`);
    const otherTask = (await tasksOfChat(other))[0];
    await restartWorkerWith(colour, { lifecycleChats: lifecycleChatList() });
    return {
      delivered: false, skipRequestChecks: true,
      after: async () => [
        ...await checkLifecycle(chat, { stage: 'in_review', rounds: 2, drafts: 2, ledgerSince, updateIds: [request.updateId, changeUpdate, legacyUpdate] }),
        { name: 'the new brief after un-flagging is a legacy task (no request) run by TaskWorkflow', ok: legacy.request_id === null && (await restateQuery(`SELECT status FROM sys_invocation WHERE target_service_name = 'TaskWorkflow' AND target_service_key = 'task-wf-${legacy.id}'`)).some((r: any) => r.status === 'completed'), detail: JSON.stringify(legacy) },
        { name: 'the unflagged chat alongside took the legacy path (no request row)', ok: Boolean(otherTask) && (await requestsOfChat(other)).length === 0 && (await query(sql`SELECT 1 FROM hawa.tasks WHERE id = ${otherTask?.id ?? '00000000-0000-0000-0000-000000000000'}::uuid AND request_id IS NULL`)).length === 1, detail: `other chat task ${otherTask?.id} (update ${otherUpdate})` },
      ],
    };
  }, 15 * 60_000, { lifecycle: true, needs: 'worker-poller' });

  // R2 (scale 0.0001, D1): a silent requester. The draft is sent, reminders are scheduled; Restate,
  // the worker and Core are each killed between a reminder's scheduling and its firing. Exactly one
  // reminder per day reaches the chat, and the request expires.
  scenario('L3.R2.D1', 'silent requester, reminders at scale 0.0001: Restate, worker and Core killed between scheduling and firing; one reminder per day, then expiry', async (chat, events) => {
    const colour = await liveColour();
    await restartWorkerWith(colour, { reminderScale: '0.0001' });
    try {
      const request = await lifecycleBrief(chat, `L3R2-${chat}`, events);
      await waitUntil('the day-1 reminder scheduled', async () => (await restateQuery(`SELECT id FROM sys_invocation WHERE target_service_name = 'RequestLifecycle' AND target_service_key = '${request.requestId}' AND target_handler_name = 'remind'`)).length > 0, 60_000, 250);
      kill('restate'); await sleep(4000); start('restate'); await waitHealthy('restate');
      events.push('Restate killed after the day-1 reminder was scheduled, back after 4 s');
      await waitUntil('the day-1 reminder in the chat', async () => (await messagesWith(chat, 'Is this design right for you?')).length > 0, 180_000, 500);
      kill(colour); await sleep(2000); start(colour); await waitHealthy(colour);
      events.push(`${colour} killed after the day-1 reminder, back after 2 s`);
      kill('core'); await sleep(4000); start('core'); await waitHealthy('core');
      events.push('Core killed before the day-5 reminder, back after 4 s');
      await waitUntil('the day-5 reminder in the chat', async () => (await messagesWith(chat, 'Still waiting on this design')).length > 0, 240_000, 1000);
      await waitUntil('the request to expire', async () => (await requestsOfChat(chat))[0]?.stage === 'expired', 300_000, 2000);
      events.push('expired');
      return {
        delivered: false, skipRequestChecks: true,
        after: async () => [
          ...await checkLifecycle(chat, { stage: 'expired', rounds: 1, updateIds: [request.updateId] }),
          { name: 'exactly one day-1 reminder', ok: (await messagesWith(chat, 'Is this design right for you?')).length === 1, detail: `${(await messagesWith(chat, 'Is this design right for you?')).length}` },
          { name: 'exactly one day-5 reminder', ok: (await messagesWith(chat, 'Still waiting on this design')).length === 1, detail: `${(await messagesWith(chat, 'Still waiting on this design')).length}` },
        ],
      };
    } finally {
      await restartWorkerWith(colour, { reminderScale: '1' });
    }
  }, 15 * 60_000, { lifecycle: true, needs: 'worker-poller' });

  /**
   * R3's question. The fixtures cover no studio stage, so the change round's studio question is
   * simulated: the driver records the round's NEEDS_CLARIFICATION run (what the edit stage writes) and
   * hands RequestLifecycle the run's report with the DesignRun's own event id and key, while that run
   * is held after its Canva step; its own report, later, meets Restate's key and the seen list. Core's
   * outcome projection, the question message, its send and record, and the answer are all real.
   */
  const changeThenQuestion = async (chat: string, events: string[]) => {
    const ledgerSince = Math.max(0, ...((await fakes.modelLedger()).ledger as any[]).map((l) => l.seq));
    const request = await lifecycleBrief(chat, `L3R3-${chat}`, events);
    await fakes.hold('worker.step.after-action', { step: 'canva-create-draft' }, 1);
    const changeUpdate = await replyToDraft(chat, request.taskId, 'make the logo bigger');
    const round1 = await waitUntil('the change round', async () => {
      const rows = await roundTasks(request.requestId);
      return rows.length === 2 ? rows[1] : null;
    }, 180_000);
    const reached = await fakes.wait('worker.step.after-action', 240_000);
    events.push(`change round ${round1.id}; its DesignRun held at ${reached?.detail?.step}`);
    await query(sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status, stages)
      VALUES (gen_random_uuid(), ${TENANT_ID_}::uuid, ${round1.id}::uuid, ${KAAE_CLIENT_ID}::uuid, 'chaos', ${`chaos-question-${round1.id}`}, 'chaos', '{}'::jsonb, 'standard', 'failed',
        ${JSON.stringify({ directed: { refused: 'NEEDS_CLARIFICATION', clarify: { question: 'Which logo should be bigger?', options: ['The KAAE seal', 'The university crest'] }, asks: [{ ask: 'make the logo bigger', status: 'asked' }] } })}::jsonb)`);
    const runId = `dr-${round1.id}`;
    const res = await fetch(`${RESTATE_INGRESS_URL}/RequestLifecycle/${request.requestId}/designFinished/send`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `dr-finished:${runId}` },
      body: JSON.stringify({ v: 1, eventId: `dr-finished:${runId}`, runId, round: 1, taskId: round1.id, report: { status: 'DESIGN_FAILED', code: 'NEEDS_CLARIFICATION', runId } }),
    });
    events.push(`the studio's question handed to the lifecycle: HTTP ${res.status}`);
    await waitUntil('the question in the chat, recorded as asked', async () => {
      const [row] = await requestsOfChat(chat);
      return row?.stage === 'awaiting_answer' && row.question_asked_at && (await messagesWith(chat, 'One question before I make your change')).length > 0;
    }, 180_000, 1000);
    await fakes.release();
    await waitUntil('the held DesignRun to finish', async () => (await restateQuery<{ status: string }>(`SELECT status FROM sys_invocation WHERE target_service_name = 'DesignRun' AND target_service_key = '${runId}'`)).every((r) => r.status === 'completed'), 300_000, 2000);
    events.push('question asked; the held run finished and its report was ignored');
    return { request, round1, changeUpdate, ledgerSince };
  };
  const TENANT_ID_ = '00000000-0000-4000-a000-000000000001';
  const answerAndDraft = async (chat: string, events: string[], q: Awaited<ReturnType<typeof changeThenQuestion>>) => {
    const answerUpdate = await tap(chat, `rq:a1:${q.round1.id}`);
    const round2 = await waitUntil('the answer round', async () => {
      const rows = await roundTasks(q.request.requestId);
      return rows.length === 3 ? rows[2] : null;
    }, 180_000);
    await waitDraftSent(chat, q.request.requestId, round2.id);
    events.push(`answered (update ${answerUpdate}): round 2 task ${round2.id}, its draft sent`);
    return { answerUpdate, round2 };
  };
  const questionChecks = (chat: string, q: Awaited<ReturnType<typeof changeThenQuestion>>, a: Awaited<ReturnType<typeof answerAndDraft>>) => async () => {
    const [r1] = await query<{ state: string }>(sql`SELECT state::text AS state FROM hawa.tasks WHERE id = ${q.round1.id}::uuid`);
    const view = await lifecycleView(q.request.requestId);
    return [
      ...await checkLifecycle(chat, { stage: 'in_review', rounds: 3, drafts: 2, ledgerSince: q.ledgerSince, updateIds: [q.request.updateId, q.changeUpdate, a.answerUpdate] }),
      { name: 'the question\'s task is closed once answered', ok: r1?.state === 'cancelled', detail: `state=${r1?.state}` },
      { name: 'the lifecycle is on the answer\'s round, reviewing its draft', ok: view?.round === 2 && view?.draft?.taskId === a.round2.id, detail: JSON.stringify(view && { round: view.round, draft: view.draft }) },
      { name: 'the question reached the chat once', ok: (await messagesWith(chat, 'One question before I make your change')).length === 1, detail: 'question messages' },
    ];
  };

  scenario('L3.R3.K1', 'change, question, answer: worker killed at the answer\'s projection step', async (chat, events) => {
    const q = await changeThenQuestion(chat, events);
    const k = await killAtPoint('worker.rl.after-project', { key: ':answer' });
    const a = await answerAndDraft(chat, events, q);
    events.push(`kill: ${JSON.stringify(await k.done).slice(0, 160)}`);
    return { delivered: false, skipRequestChecks: true, after: questionChecks(chat, q, a) };
  }, 15 * 60_000, { lifecycle: true, needs: 'worker-poller' });

  scenario('L3.R3.K2', 'change, question, answer: Core killed after committing the answer round\'s design outcome, before answering', async (chat, events) => {
    const q = await changeThenQuestion(chat, events);
    const k = await killAtPoint('core.project.after-commit', { requestId: q.request.requestId, key: ':designFinished' });
    const a = await answerAndDraft(chat, events, q);
    events.push(`kill: ${JSON.stringify(await k.done).slice(0, 160)}`);
    return { delivered: false, skipRequestChecks: true, after: questionChecks(chat, q, a) };
  }, 15 * 60_000, { lifecycle: true, needs: 'worker-poller' });

  scenario('L3.R3.D', 'change, question, deploy to green, answer: nothing changes, no RT0016, blue drains', async (chat, events) => {
    const q = await changeThenQuestion(chat, events);
    const before = await liveColour();
    up({ build: false, services: ['worker-green'] });
    const reg = await registerColour('green');
    events.push(`deploy: register green exit ${reg.code}`);
    await waitUntil('green to be live', async () => (await liveColour()) === 'worker-green', 60_000, 1000);
    await sleep(6000); // the gate probes every few seconds: blue's poller stops, green's starts
    const a = await answerAndDraft(chat, events, q);
    const drains = await finishDrains(180);
    events.push(`finish-drains: exit ${drains.code} ${drains.lines.join(' | ').slice(0, 300)}`);
    return {
      delivered: false, skipRequestChecks: true,
      after: async () => [
        ...await questionChecks(chat, q, a)(),
        { name: 'green registered without force', ok: reg.code === 0 && before === 'worker-blue', detail: `exit ${reg.code}, live before: ${before}` },
        { name: 'blue drained and its deployment deleted', ok: drains.lines.some((l) => /deleted=blue/.test(l)), detail: drains.lines.join(' | ').slice(0, 400) },
      ],
    };
  }, 15 * 60_000, { lifecycle: true, needs: 'worker-poller' });

  // R2.D2: a deploy between a reminder's scheduling and its firing; the reminder fires on the new
  // colour and the old one drains. Runs after L3.R3.D, so green is live: this deploys back to blue.
  scenario('L3.R2.D2', 'reminders at scale 0.0001 across a deploy: scheduled on one colour, fired on the other, the old one drains', async (chat, events) => {
    const from = await liveColour();
    const to = from === 'worker-green' ? 'worker-blue' : 'worker-green';
    await restartWorkerWith(from, { reminderScale: '0.0001' });
    try {
      const request = await lifecycleBrief(chat, `L3R2D2-${chat}`, events);
      await waitUntil('the day-1 reminder scheduled', async () => (await restateQuery(`SELECT id FROM sys_invocation WHERE target_service_name = 'RequestLifecycle' AND target_service_key = '${request.requestId}' AND target_handler_name = 'remind'`)).length > 0, 60_000, 250);
      // A colour left registered by an earlier deploy (a scenario that stopped before its drain) is
      // drained first: registering never replaces a deployment Restate still holds.
      const leftover = await finishDrains(60);
      events.push(`drains before the deploy: exit ${leftover.code} ${leftover.lines.join(' | ').slice(0, 200)}`);
      up({ build: false, services: [to] });
      await restartWorkerWith(to, { reminderScale: '0.0001' });
      const reg = await registerColour(to === 'worker-green' ? 'green' : 'blue');
      events.push(`deploy ${from} → ${to}: exit ${reg.code}`);
      await waitUntil('the day-1 reminder in the chat', async () => (await messagesWith(chat, 'Is this design right for you?')).length > 0, 180_000, 500);
      const [fired] = await restateQuery<{ pinned_deployment_id: string | null }>(`SELECT pinned_deployment_id FROM sys_invocation WHERE target_service_name = 'RequestLifecycle' AND target_service_key = '${request.requestId}' AND target_handler_name = 'remind' AND status = 'completed' LIMIT 1`);
      const [target] = await restateQuery<{ id: string }>(`SELECT id FROM sys_deployment WHERE endpoint LIKE '%${to}%'`);
      await waitUntil('the request to expire', async () => (await requestsOfChat(chat))[0]?.stage === 'expired', 300_000, 2000);
      const drains = await finishDrains(180);
      events.push(`finish-drains: exit ${drains.code} ${drains.lines.join(' | ').slice(0, 300)}`);
      return {
        delivered: false, skipRequestChecks: true,
        after: async () => [
          ...await checkLifecycle(chat, { stage: 'expired', rounds: 1, updateIds: [request.updateId] }),
          { name: 'the day-1 reminder ran on the new colour', ok: Boolean(fired?.pinned_deployment_id) && fired?.pinned_deployment_id === target?.id, detail: JSON.stringify({ fired, target }) },
          { name: 'exactly one reminder per day', ok: (await messagesWith(chat, 'Is this design right for you?')).length === 1 && (await messagesWith(chat, 'Still waiting on this design')).length === 1, detail: 'day 1 and day 5 messages' },
          { name: 'the old colour drained and its deployment deleted', ok: drains.lines.some((l) => new RegExp(`deleted=${from === 'worker-green' ? 'green' : 'blue'}`).test(l)), detail: drains.lines.join(' | ').slice(0, 400) },
        ],
      };
    } finally {
      await restartWorkerWith(await liveColour(), { reminderScale: '1' });
    }
  }, 15 * 60_000, { lifecycle: true, needs: 'worker-poller' });

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
 * Slice 2.2: a request in a flagged chat, delivered by the Restate Delivery workflow. The PNG and the
 * PPTX are pinned, so two files go to the requester and a fault can fall between them. The Deliver
 * press is answered at once (202, executor restate); nothing presses it again.
 */
async function workflowRequest(chat: string, tag: string, events: string[], hooks: { beforeDeliver?: (taskId: string) => Promise<void>; afterDeliver?: (taskId: string) => Promise<void> } = {}) {
  const taskId = await briefToDraft(chat, tag);
  events.push(`task ${taskId}: draft in chat`);
  const approved = await approve(taskId, { pinDeck: true });
  events.push(`approve (PNG and PPTX pinned): HTTP ${approved.status}`);
  if (approved.status >= 300) throw new Error(`approval refused: HTTP ${approved.status} ${JSON.stringify(approved.body).slice(0, 300)}`);
  if (hooks.beforeDeliver) await hooks.beforeDeliver(taskId);
  const started = Date.now();
  const delivered = await deliver(taskId);
  events.push(`deliver: HTTP ${delivered.status} in ${Date.now() - started} ms, executor ${delivered.body?.executor}, ${delivered.body?.deliveryId}`);
  if (delivered.status !== 202 || delivered.body?.executor !== 'restate') {
    throw new Error(`the flagged chat's delivery was not handed to the workflow: HTTP ${delivered.status} ${JSON.stringify(delivered.body).slice(0, 300)}`);
  }
  if (hooks.afterDeliver) await hooks.afterDeliver(taskId);
  await waitDelivered(chat, taskId, 300_000, 2);
  events.push(`delivered, task ${await taskState(taskId)}`);
  return { taskId, deliveryId: String(delivered.body.deliveryId) };
}

/** Brief to the Deliver press, without waiting for the task to complete (a kill may stop it). */
async function fullRequestUntilDelivery(chat: string, tag: string, events: string[]): Promise<string> {
  const taskId = await briefToDraft(chat, tag);
  const approved = await approve(taskId);
  events.push(`approve: HTTP ${approved.status}`);
  const delivered = await deliver(taskId);
  events.push(`deliver: HTTP ${delivered.status}`);
  return taskId;
}

async function outboxOpen(taskId: string): Promise<boolean> {
  const { query, sql } = await import('./driver/stack.js');
  const [row] = await query<{ n: string }>(sql`SELECT count(*) AS n FROM hawa.outbox_commands WHERE aggregate_id = ${taskId}::uuid AND state IN ('pending', 'leased')`);
  return Number(row?.n ?? 0) > 0;
}

/**
 * Slice 2.3 part B: a request opened on RequestLifecycle through Restate's ingress, as ChatInbox sends
 * it, followed until its draft is in the chat and recorded as sent. `arm` may arm a kill before the
 * open is sent; it answers what happened, once it has.
 */
async function lifecycleOpen(chat: string, tag: string, events: string[], arm?: (requestId: string) => Promise<{ done: Promise<string> }>): Promise<Expectation> {
  const { query, sql } = await import('./driver/stack.js');
  const { TENANT_ID, KAAE_CLIENT_ID } = await import('./driver/provision.js');
  const { requestIdFor } = await import('../../domain/src/request-lifecycle.js');
  const { briefText } = await import('./driver/scenario.js');
  const updateId = 800_000 + Math.floor(Math.random() * 100_000);
  const requestId = requestIdFor(chat, updateId);
  const brief = briefText(tag);
  const killed = arm ? await arm(requestId) : null;
  const open = {
    v: 1, eventId: `open:${requestId}`, requestId, tenantId: TENANT_ID, chatId: chat,
    origin: { kind: 'telegram', chatId: chat, updateId },
    draft: { title: `KAAE invitation ${tag}`, rawText: brief, clientId: KAAE_CLIENT_ID, designInstructions: '', exactCopy: [], autoGenerate: true },
  };
  const res = await fetch(`${RESTATE_INGRESS_URL}/RequestLifecycle/${requestId}/open/send`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `open:${requestId}` }, body: JSON.stringify(open),
  });
  events.push(`open sent: HTTP ${res.status}`);
  if (!res.ok) throw new Error(`Restate refused the open: HTTP ${res.status} ${await res.text()}`);
  if (killed) events.push(await killed.done);

  const [task] = await waitUntil(`the request's task`, async () => {
    const rows = await query<{ id: string }>(sql`SELECT id::text AS id FROM hawa.tasks WHERE request_id = ${requestId}::uuid`);
    return rows.length ? rows : null;
  }, 120_000);
  events.push(`task ${task.id}`);
  const runKey = `dr-${task.id}`;
  await waitUntil('the design run to finish', async () => {
    const rows = await restateQuery<{ status: string }>(`SELECT status FROM sys_invocation WHERE target_service_name = 'DesignRun' AND target_service_key = '${runKey}'`);
    return rows.length > 0 && rows.every((r) => r.status === 'completed');
  }, 300_000, 2000);
  // Since part C, Core projects the outcome: the draft goes to the chat and is recorded as sent.
  await waitUntil('the lifecycle to record the draft as sent', async () => {
    const rows = await query<{ stage: string; draft_sent_at: Date | null }>(sql`SELECT stage, draft_sent_at FROM hawa.requests WHERE request_id = ${requestId}::uuid`);
    return rows[0]?.stage === 'in_review' && rows[0].draft_sent_at ? rows[0] : null;
  }, 180_000, 2000);
  const view = await fetch(`${RESTATE_INGRESS_URL}/RequestLifecycle/${requestId}/get`, { method: 'POST' })
    .then((r) => r.json()).catch((e) => ({ error: String(e) })) as Record<string, unknown>;
  events.push(`lifecycle view: ${JSON.stringify(view)}`);

  const extra: InvariantResult[] = [];
  const add = (name: string, ok: boolean, detail: string) => extra.push({ name, ok, detail });
  const requests = await query<{ owner: string; stage: string; rev: string; root_task_id: string }>(sql`SELECT owner, stage, rev::text AS rev, root_task_id::text AS root_task_id FROM hawa.requests WHERE request_id = ${requestId}::uuid`);
  add('one request row, owned by restate, in review at revision 3 (open, outcome, draft sent)', requests.length === 1 && requests[0].owner === 'restate' && requests[0].stage === 'in_review' && requests[0].rev === '3' && requests[0].root_task_id === task.id, JSON.stringify(requests));
  const tasks = await query<{ id: string }>(sql`SELECT id FROM hawa.tasks WHERE request_id = ${requestId}::uuid`);
  add('one task for the request', tasks.length === 1, `tasks=${tasks.length}`);
  const created = await query<{ state: string; last_error: string | null }>(sql`SELECT state::text AS state, last_error FROM hawa.outbox_commands WHERE aggregate_id = ${task.id}::uuid AND command_type = 'task.created'`);
  add('its task.created row is recorded, never dispatched', created.length === 1 && created[0].state === 'delivered' && created[0].last_error === 'OWNED_BY_LIFECYCLE', JSON.stringify(created));
  const projections = await query<{ idempotency_key: string }>(sql`SELECT idempotency_key FROM hawa.lifecycle_projections WHERE request_id = ${requestId}::uuid`);
  add('three projections: the open, the outcome, the draft sent', projections.map((p) => p.idempotency_key).sort().join(',') === [`${requestId}:1:open`, `${requestId}:2:designFinished`, `${requestId}:3:messageSent`].join(','), JSON.stringify(projections.map((p) => p.idempotency_key)));
  const legacy = await restateQuery<{ n: number }>(`SELECT count(*) AS n FROM sys_invocation WHERE target_service_name = 'TaskWorkflow' AND target_service_key LIKE 'task-wf-${task.id}%'`);
  add('no TaskWorkflow for a lifecycle task', Number(legacy[0]?.n ?? 0) === 0, `TaskWorkflow=${legacy[0]?.n ?? 0}`);
  const runs = await restateQuery<{ status: string; last_failure_error_code: string | null }>(`SELECT status, last_failure_error_code FROM sys_invocation WHERE target_service_name = 'DesignRun' AND target_service_key LIKE 'dr-${task.id}%'`);
  add('one DesignRun, completed', runs.length === 1 && runs[0].status === 'completed', JSON.stringify(runs));
  const [ops] = await query<{ imports: string }>(sql`SELECT count(*) FILTER (WHERE kind = 'create') AS imports FROM hawa.canva_remote_operations WHERE task_id = ${task.id}::uuid`);
  add('one Canva import', Number(ops.imports) === 1, `imports=${ops.imports}`);
  const opens = await restateQuery<{ status: string }>(`SELECT status FROM sys_invocation WHERE target_service_name = 'RequestLifecycle' AND target_service_key = '${requestId}' AND target_handler_name = 'open'`);
  add('one open invocation, completed', opens.length === 1 && opens[0].status === 'completed', JSON.stringify(opens));
  const outcomes = await restateQuery<{ n: number }>(`SELECT count(*) AS n FROM sys_invocation WHERE target_service_name = 'RequestLifecycle' AND target_service_key = '${requestId}' AND target_handler_name = 'designFinished'`);
  add('the outcome was sent to the lifecycle once', Number(outcomes[0]?.n ?? 0) === 1, `designFinished invocations=${outcomes[0]?.n ?? 0}`);
  add('the lifecycle shows the first round\'s draft in review', view?.stage === 'in_review' && view?.rev === 3 && view?.currentTaskId === task.id && view?.round === 0, JSON.stringify(view));
  const shown = await sentTo(chat);
  const kinds = shown.map((s: any) => `${s.method}:${s.documentSha256 ?? s.textHash}`);
  add('the requester has the acknowledgement, the draft and its picture, each once', shown.length === 3 && new Set(kinds).size === 3 && shown.filter((s: any) => s.method === 'sendPhoto').length === 1, `${shown.length} sends: ${shown.map((s: any) => s.method).join(',')}`);
  const [paused] = await restateQuery<{ n: number }>(`SELECT count(*) AS n FROM sys_invocation WHERE status = 'paused'`);
  add('no paused invocation', Number(paused?.n ?? 0) === 0, `paused=${paused?.n ?? 0}`);
  const [rt16] = await restateQuery<{ n: number }>(`SELECT count(*) AS n FROM sys_invocation WHERE last_failure_error_code = 'RT0016'`);
  add('no journal mismatch (RT0016)', Number(rt16?.n ?? 0) === 0, `RT0016=${rt16?.n ?? 0}`);
  return { delivered: false, skipRequestChecks: true, extra };
}
