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
import { connectCanva, finishDrains, kaaeClientDna, registerColour, upgradeSchema } from './driver/provision.js';
import {
  approve, briefToDraft, chatInboxInvocations, checkIntake, checkRequest, deliver, draftOf, imageDocumentUpdate, killAtPoint, killWhileHeld, quiescent, sendBrief,
  sendToChatInbox, sentTo, sleep, storedOffset, tasksOfChat, taskState, textUpdate, uncoveredModelCalls, waitDelivered, waitUntil, type InvariantResult,
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

function scenario(name: string, what: string, script: (chat: string, events: string[]) => Promise<Expectation>, timeoutMs = 12 * 60_000, options: { flagged?: boolean; needs?: 'worker-poller' } = {}) {
  const run = enabled && (only.length === 0 || only.includes(name)) && (options.needs !== 'worker-poller' || poller === 'worker');
  it.skipIf(!run)(`${name}: ${what}`, async () => {
    const chat = options.flagged ? flaggedChat() : newChat();
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

  // R07/FR-060/NFR-001: a flagged chat opens its first request through RequestLifecycle.
  // Crash Core after it commits the intake decision but before ChatInbox receives the answer;
  // then cross Restate's seven-day key with another invocation of the same Telegram update.
  scenario('R1.S3.K1', 'flagged chat: a Core crash and update replay open one owned request and send one acknowledgement', async (chat, events) => {
    const killed = await killAtPoint('core.intake.after-decision', { chat });
    const update = textUpdate(chat, 'Please use a navy background and a clean serif font for the design.');
    const [updateId] = await fakes.updates([update]);
    const polled = { ...update, update_id: updateId };
    events.push(`update ${updateId} in flagged chat ${chat}`);
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
  }, 12 * 60_000, { flagged: true, needs: 'worker-poller' });

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
