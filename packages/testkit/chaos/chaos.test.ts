/**
 * The chaos suite (architecture programme, PLAN.md Phase 2; PHASE2_DESIGN.md section 6): scripted
 * requests through the whole stack in the hawa-chaos compose project, with processes killed at named
 * points, and the invariants of section 6.3 checked after each request.
 *
 * It runs only with HAWA_CHAOS=1 (README.md): it builds images and starts six containers.
 *   HAWA_CHAOS=1 npx vitest run packages/testkit/chaos/chaos.test.ts
 *   HAWA_CHAOS_KEEP=1   leave the project running afterwards (default: taken down with its volumes)
 *   HAWA_CHAOS_ONLY=R1.0,R4   run only these scenarios
 *   HAWA_CHAOS_REPEAT=3       run each selected scenario three times (run.ts --repeat 3)
 *   HAWA_CHAOS_SEED_DUMP=<file>    the scenarios run on a copy of production's data (run.ts --seed-dump; driver/seed.ts)
 *   HAWA_CHAOS_PREVIOUS_RELEASE=<commit>   the release R10 starts from and rolls back to (run.ts --previous-release)
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
import { acquireProject, build, CHAOS_DIR, closeDb, deploymentReceipt, down, fakes, releaseProject, kill, memory, PORTS, query, restateQuery, RESTATE_INGRESS_URL, secrets, sql, stackState, start, up, waitHealthy } from './driver/stack.js';
import { connectCanva, finishDrains, kaaeClientDna, registerColour, upgradeSchema } from './driver/provision.js';
import { neutralise, restoreDump, verifyEgressFence, type EgressProbe, type NeutraliseReport, type SeedReport } from './driver/seed.js';
import { buildPreviousRelease, startOnRelease } from './driver/cutover.js';
import { handoffOfOldRequests, retiredSettingsIgnored, rollbackToPreviousRelease } from './driver/cutover-scenarios.js';
import {
  approve, briefToDraft, captionedPhotoUpdate, RequestEndedError, chatInboxInvocations, checkIntake, checkRequest, deliver, designOutcome, draftOf, imageDocumentUpdate, killAtPoint, killWhileHeld, quiescent, sendBrief,
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
// run.ts --seed-dump: the scenarios run on a restored copy of production's data (driver/seed.ts).
const seedDump = process.env.HAWA_CHAOS_SEED_DUMP || '';
let seeded: { restore: SeedReport; upgrade: { applied: string[]; verified: number }; neutralised: NeutraliseReport; egress: EgressProbe[] } | null = null;
// Set once this run holds the project's lock; a run that never got it must not touch the project.
let owned = false;
const LOCK_WAIT_MS = 3 * 60 * 60_000;
// R10 (driver/cutover-scenarios.ts) starts on the previous release, which only a run that selects it
// builds (run.ts --only R10.H1,R10.K1,R10.K2): the stack then starts on that release, as production.
const r10 = ['R10.H1', 'R10.K1', 'R10.K2'].some((n) => only.includes(n));
if (r10 && only.some((n) => !n.startsWith('R10.'))) throw new Error('R10 scenarios run alone (they deploy releases on the stack)');

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

// run.ts --repeat N (HAWA_CHAOS_REPEAT): each selected scenario runs N times, reported as <name>#<n>.
const repeat = Math.max(1, Math.min(10, Number(process.env.HAWA_CHAOS_REPEAT) || 1));

function scenario(name: string, what: string, script: (chat: string, events: string[]) => Promise<Expectation>, timeoutMs = 12 * 60_000) {
  const run = enabled && (only.length === 0 ? !name.startsWith('R10.') : only.includes(name));
  for (let n = 1; n <= repeat; n++) runScenario(repeat > 1 ? `${name}#${n}` : name, what, script, timeoutMs, run);
}

function runScenario(name: string, what: string, script: (chat: string, events: string[]) => Promise<Expectation>, timeoutMs: number, run: boolean) {
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
    // One run at a time on this machine, from this down to the last (driver/stack.ts acquireProject).
    // The wait has its own budget (up to 3 h, reported every 30 s): with the lock's default 30 min
    // inside a 30 min hook, a run queued behind another was killed by the hook timeout (2026-09-28).
    await acquireProject({ waitMs: LOCK_WAIT_MS, log: (line) => console.log(`[chaos] ${line}`) });
    owned = true;
    // Always from nothing: a kept project from an earlier run would carry its tasks and journals.
    down({ volumes: true });
    // Core and the worker start below with --no-build, so their images are built from this checkout here.
    build(['core', 'worker-blue', ...(candidate ? ['desk', 'docling'] as const : [])]);
    // R10: the previous release's images too, from its commit, and the stack starts on it.
    if (r10) console.log(`[chaos] previous release: ${JSON.stringify(buildPreviousRelease())}`);
    up({ services: ['postgres', 'restate', 'fakes'] });
    if (seedDump) {
      // Production's data, then the pending migrations exactly as a deploy runs them, then nothing
      // restored that could act outside the stack (driver/seed.ts). No application container runs yet.
      const restore = await restoreDump(seedDump);
      console.log(`[chaos] restored ${restore.dump} (${restore.migrationsInDump} migrations recorded, ${restore.restoreMs} ms): ${JSON.stringify(restore.counts)}`);
      const upgrade = await upgradeSchema();
      console.log(`[chaos] upgraded the restored data: ${upgrade.applied.length} pending migration(s) applied, ${upgrade.verified.length} verified`);
      const neutralised = await neutralise();
      console.log(`[chaos] neutralised: ${JSON.stringify(neutralised)}`);
      seeded = { restore, upgrade: { applied: upgrade.applied, verified: upgrade.verified.length }, neutralised, egress: [] };
    } else {
      await upgradeSchema();
    }
    await connectCanva();
    await kaaeClientDna();
    // R10.H1 makes its old requests the way production made them: the previous release, Core polling
    // and no chat on the lifecycle (the configuration before 2026-09-28).
    if (r10) startOnRelease({ release: 'previous', poller: 'core', chats: '' });
    up({ build: false, services: ['core', 'worker-blue'] });
    if (seeded) {
      // Refuse to run a scenario on production's data unless the fence holds from inside the apps.
      seeded.egress = verifyEgressFence();
      const broken = seeded.egress.flatMap((p) => p.checks.filter((c) => !c.ok).map((c) => `${p.container}: ${c.name} ${c.detail}`));
      if (broken.length) throw new Error(`egress fence does not hold, not running on production data: ${broken.join('; ')}`);
      console.log(`[chaos] egress fence holds: ${seeded.egress.map((p) => `${p.container} ${p.checks.length} checks`).join(', ')}`);
    }
    const reg = await registerColour('blue');
    if (reg.code !== 0) throw new Error(`register blue: ${reg.lines.join(' | ')}`);
    if (candidate) up({ build: false, services: ['docling', 'desk', 'nginx'] });
    sampleMemory();
  }, LOCK_WAIT_MS + 45 * 60_000);

  afterAll(async () => {
    // Never started (the lock was not taken): the project, if any, is another run's.
    if (!owned) return;
    sampleMemory();
    const result = {
      finishedAt: new Date().toISOString(),
      telegramPoller: poller,
      ...(seeded ? { seededFrom: seeded } : {}),
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
    await releaseProject();
    if (keep) console.log(`[chaos] HAWA_CHAOS_KEEP=1: the hawa-chaos project is still running${seeded ? ' WITH A COPY OF PRODUCTION DATA' : ''}; take it down with \`npx tsx packages/testkit/chaos/run.ts --down\`.`);
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
    const ledgerSince = Math.max(0, ...((await fakes.modelLedger()).ledger as any[]).map((l) => l.seq));
    const request = fullRequest(chat, 'R1.K0', events).then(() => null, (error: unknown) => error);
    await waitUntil('the acknowledgement send', async () => (await fakes.telegramCalls()).some((c) => c.method === 'sendMessage' && c.chat === chat), 60_000, 200);
    kill('core');
    // Where the design's plan stood when Core died (ADR-138: a claim with no admitted call is carried on).
    const [task] = await tasksOfChat(chat);
    const plans = task ? await query<{ status: string; call: string | null }>(sql`SELECT p.status, c.status AS call FROM hawa.canva_design_plans p
      LEFT JOIN hawa.canva_planner_calls c ON c.id = p.id WHERE p.task_id = ${task.id}::uuid`) : [];
    events.push(`killed core while the acknowledgement was being sent (tasks then: ${task ? 1 : 0}; plans then: ${JSON.stringify(plans)})`);
    await sleep(5000);
    start('core');
    await waitHealthy('core');
    const ended = await request;
    // A kill while the paid planner call was in flight (admitted, no outcome) leaves a call that may
    // have reached the provider: ADR-101 never sends it again, so that design cannot finish on its own
    // and the office settles it. Every other moment of planning is recovered (ADR-138).
    if (plans.some((p) => p.call === 'started')) {
      if (!(ended instanceof RequestEndedError) || !/DESIGN_PLANNING/.test(ended.message)) throw ended ?? new Error('the in-flight paid call was finished without its outcome');
      events.push('the kill landed while the paid planner call was in flight: the uncertain call is not sent again');
      return { delivered: false, skipRequestChecks: true, extra: await uncertainPlannerCall(chat, ledgerSince) };
    }
    if (ended) throw ended;
    return { delivered: true, extra: await onePlannerCall(chat) };
  });

  // ADR-138/ADR-101: a Core killed after the paid call is admitted and before it is sent. From outside
  // this cannot be told from a call in flight, so it is never sent again: the request ends for the
  // office to settle, with one admitted call and no model request.
  scenario('R1.K0A', 'Core killed after the paid planner call is admitted, before it is sent: never sent again', async (chat, events) => {
    const ledgerSince = Math.max(0, ...((await fakes.modelLedger()).ledger as any[]).map((l) => l.seq));
    const k = await killAtPoint('core.planner.after-admission', {});
    const ended = await fullRequest(chat, 'R1.K0A', events).then(() => null, (error: unknown) => error);
    events.push(`killed ${(await k.done).killed} at core.planner.after-admission; the request ${ended ? `ended: ${ended instanceof Error ? ended.message : String(ended)}` : 'was delivered'}`);
    if (!(ended instanceof RequestEndedError) || !/DESIGN_PLANNING/.test(ended.message)) throw ended ?? new Error('an admitted call with no outcome was finished');
    return { delivered: false, skipRequestChecks: true, extra: await uncertainPlannerCall(chat, ledgerSince) };
  });

  // ADR-138: the same kill at a fixed moment, after the design's plan is claimed and before its paid
  // call is admitted (the moment R1.K0 most often lands in since ADR-135). The claim is carried on
  // after the restart with exactly one planner call.
  scenario('R1.K0P', 'Core killed after the plan is claimed, before its paid call is admitted, back after 2 s', async (chat, events) => {
    const k = await killAtPoint('core.planner.after-claim', {});
    await fullRequest(chat, 'R1.K0P', events);
    events.push(`killed ${(await k.done).killed} at core.planner.after-claim`);
    return { delivered: true, extra: await onePlannerCall(chat) };
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
    // Since ADR-135 the delivery belongs to the request's Delivery workflow, which carries on through
    // the Core restart: the request is past 'approved', so the second press goes straight to Core (the
    // Desk's helper would wait for 'approved' first) and must start nothing new.
    const second = await fakes.core(`/tasks/${taskId}/publish`, secrets().CHAOS_REVIEWER_KEY,
      { headers: { 'Idempotency-Key': randomUUID() }, body: {} });
    events.push(`second Deliver: HTTP ${second.status} ${JSON.stringify(second.json).slice(0, 160)}`);
    await waitDelivered(chat, taskId);
    const runs = await query<{ executor_run: number }>(sql`SELECT executor_run FROM hawa.publications WHERE task_id = ${taskId}::uuid`);
    return {
      delivered: true,
      extra: [
        { name: 'the second press is answered without a server error', ok: second.status > 0 && second.status < 500, detail: `HTTP ${second.status}` },
        { name: 'the delivery cut off by a Core restart finishes as one Delivery run', ok: runs.length === 1 && Number(runs[0].executor_run) === 1,
          detail: `task ${stateAtKill} at the kill, ${stateAfterRestart} after the restart; runs ${JSON.stringify(runs)}` },
      ],
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
  // it (slowed to 4 s). It must reach the requester once; the office hears of it only when its send
  // mark could not record it as sent. (The first ADR-135 run expected an uncertain send and saw no
  // office alert; the mark decides now, and the run records it.)
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
    // Whether the office must hear of it follows the acknowledgement's own send marks. Two runs on
    // 2026-09-28 differed: one saw no office alert, the next saw one with marks [attempted, attempted,
    // sent]; the kill lands before or after the attempt's result is written.
    const [request] = await query<{ request_id: string }>(sql`SELECT request_id FROM hawa.requests WHERE chat_id = ${chat}`);
    const marks = request ? await query<{ event_kind: string }>(sql`SELECT event_kind FROM hawa.inbox_events
      WHERE source_account_id = 'telegram_delivery' AND source_event_id LIKE ${`%${request.request_id}:1:ack%`}
      ORDER BY received_at`) : [];
    events.push(`acknowledgement send marks: ${JSON.stringify(marks.map((m) => m.event_kind))}`);
    // Every attempt writes 'attempted' before it sends and its result after; an attempt without a
    // result is one whose answer was lost, which ADR-130 keeps uncertain and alerts once.
    const attempts = marks.filter((m) => /_attempted$/.test(m.event_kind)).length;
    const ackUncertain = attempts > marks.length - attempts;
    const acks = (await sentTo(chat)).filter((m) => m.method === 'sendMessage' && m.text?.includes('Request received.'));
    return {
      delivered: false, uncertainSends: ackUncertain ? 1 : 0,
      extra: [
        { name: 'the acknowledgement has a send mark', ok: marks.length > 0, detail: JSON.stringify(marks.map((m) => m.event_kind)) },
        { name: 'the acknowledgement reached the requester once', ok: acks.length === 1, detail: `acknowledgements=${acks.length}` },
      ],
      after: () => checkIntake(chat, [update.update_id]),
    };
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

  // ADR-139: English copy for one graphic and Kurdish copy for another, in one brief, open one request
  // per language, as legacy intake made one task per language. Each is drafted, approved and
  // delivered on its own, with no paid call made twice.
  scenario('R1.BL', 'an English-and-Kurdish brief opens one request per language; each is drafted, approved and delivered', async (chat, events) => {
    const text = [
      'KAAE announcement for the standards framework, formal and clean. Reference R1.BL.',
      '',
      'Here is the text to add on each of the Kurdish and English graphics:',
      '',
      'K-12 STANDARDS FRAMEWORK (R1.BL)',
      '',
      'Now available at kaae.org.',
      '_____',
      'چوارچێوەی ستانداردەکانی پەروەردە (R1.BL)',
      '',
      'ئێستا لە kaae.org بەردەستە',
    ].join('\n');
    const ledgerSince = Math.max(0, ...((await fakes.modelLedger()).ledger as any[]).map((l) => l.seq));
    await fakes.updates([textUpdate(chat, text)]);
    const tasks = await waitUntil('two tasks, one per language', async () => { const t = await tasksOfChat(chat); return t.length >= 2 ? t : null; }, 120_000, 1000);
    for (const task of tasks) {
      await waitUntil(`the draft of ${task.id}`, async () => {
        const outcome = await designOutcome(task.id);
        if (outcome && outcome !== 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW') throw new Error(`task ${task.id}: design ended ${outcome}`);
        const [r] = await query<{ stage: string }>(sql`SELECT stage FROM hawa.requests WHERE current_task_id = ${task.id}::uuid`);
        return (await taskState(task.id)) === 'human_review' && r?.stage === 'in_review';
      }, 240_000, 2000);
      const approved = await approve(task.id);
      const delivered = await deliver(task.id);
      events.push(`task ${task.id}: approve HTTP ${approved.status}, deliver HTTP ${delivered.status}`);
    }
    await waitUntil('both deliveries', async () => (await Promise.all(tasks.map((t) => taskState(t.id)))).every((s) => s === 'complete'), 300_000, 2000);
    const requests = await query<{ request_id: string; owner: string; stage: string }>(sql`SELECT request_id::text, owner, stage FROM hawa.requests WHERE chat_id = ${chat}`);
    const scripts = await query<{ id: string; copy: string }>(sql`SELECT t.id::text, o.payload->>'rawRequestText' AS copy FROM hawa.tasks t
      JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created' WHERE o.payload->>'sourceChannelId' = ${chat}`);
    const pubs = await query<{ task_id: string; state: string; executor: string }>(sql`SELECT task_id::text, state::text AS state, executor FROM hawa.publications
      WHERE task_id = ANY(${tasks.map((t) => t.id)}::uuid[])`);
    const docs = (await sentTo(chat)).filter((s) => s.method === 'sendDocument');
    const ledger = ((await fakes.modelLedger()).ledger as any[]).filter((l) => l.seq > ledgerSince && l.status === 200 && l.route !== 'billing-probe');
    const twice = [...ledger.reduce((m, l) => m.set(l.fingerprint, (m.get(l.fingerprint) || 0) + 1), new Map<string, number>())].filter(([, n]) => n > 1);
    const kurdish = /[\u0600-\u06FF]/;
    return { delivered: false, skipRequestChecks: true, extra: [
      { name: 'two lifecycle requests, both delivered', ok: requests.length === 2 && requests.every((r) => r.owner === 'restate' && r.stage === 'delivered'), detail: JSON.stringify(requests) },
      { name: 'one task per language: one English-only copy, one Kurdish copy', ok: scripts.length === 2 &&
        scripts.filter((t) => /English copy only/.test(t.copy ?? '') && !kurdish.test((t.copy ?? '').split(/_{3,}/)[1] ?? '')).length === 1 &&
        scripts.filter((t) => /Kurdish copy only/.test(t.copy ?? '') && kurdish.test((t.copy ?? '').split(/_{3,}/)[1] ?? '')).length === 1,
        detail: JSON.stringify(scripts.map((t) => ({ id: t.id.slice(0, 8), en: /English copy only/.test(t.copy ?? ''), ckb: /Kurdish copy only/.test(t.copy ?? '') }))) },
      { name: 'each request delivered once by its Delivery workflow', ok: pubs.length === 2 && pubs.every((p) => p.state === 'complete' && p.executor === 'restate'), detail: JSON.stringify(pubs) },
      { name: 'the requester has both approved files, each once', ok: docs.length === 2 && new Set(docs.map((d) => d.documentSha256)).size === 2, detail: `documents=${docs.length}` },
      { name: 'no paid call runs twice', ok: twice.length === 0, detail: twice.length ? JSON.stringify(twice) : `${ledger.length} paid calls` },
      ...(await onePlannerCallEach(tasks.map((t) => t.id))),
    ] };
  }, 20 * 60_000);

  // R10 (driver/cutover-scenarios.ts): the requests made before the lifecycle cutover, and what rolling
  // back means since ADR-135 (the previous release, never Core's poller). Run alone, in this order:
  //   run.ts --only R10.H1,R10.K1,R10.K2
  // The stack starts on the previous release with Core polling and no chat on the lifecycle.
  scenario('R10.H1', 'requests made on the previous release while Core polled, continued after the deploy of this release', async (_chat, events) => {
    const { extra } = await handoffOfOldRequests(newChat, events);
    return { delivered: false, skipRequestChecks: true, extra };
  }, 75 * 60_000);

  scenario('R10.K1', 'lifecycle requests in flight, this release rolled back to the previous one by a deploy, then forward again', async (_chat, events) => {
    const { extra } = await rollbackToPreviousRelease(newChat, events);
    return { delivered: false, skipRequestChecks: true, extra };
  }, 75 * 60_000);

  scenario('R10.K2', 'the retired chat list emptied on this release changes nothing: a waiting request keeps its reply, a new chat opens a request', async (_chat, events) => {
    const { extra } = await retiredSettingsIgnored(newChat, events);
    return { delivered: false, skipRequestChecks: true, extra };
  }, 60 * 60_000);

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
/**
 * ADR-101 at a Core kill with the paid call admitted and no outcome: the call is never sent again (at
 * most the one model request), the task waits for an operator, the office is told once and the
 * requester hears each message once.
 */
async function uncertainPlannerCall(chat: string, ledgerSince: number): Promise<InvariantResult[]> {
  const [task] = await tasksOfChat(chat);
  const rows = task ? await query<{ plan: string; call: string | null }>(sql`SELECT p.status AS plan, c.status AS call FROM hawa.canva_design_plans p
    LEFT JOIN hawa.canva_planner_calls c ON c.id = p.id WHERE p.task_id = ${task.id}::uuid`) : [];
  const planner = ((await fakes.modelLedger()).ledger as any[]).filter((l) => l.seq > ledgerSince && l.route === 'canva_design_plan');
  const alerts = task ? (await sentTo(OFFICE_CHAT)).filter((s) => s.text?.includes(task.id) && /needs an operator/.test(s.text)) : [];
  const shown = await sentTo(chat);
  const dupes = shown.length - new Set(shown.map((s) => `${s.method}:${s.documentSha256 ?? s.textHash}`)).size;
  return [
    { name: 'one plan, its admitted call left uncertain (started), never completed by a second send', ok: rows.length === 1 && rows[0].call === 'started', detail: JSON.stringify(rows) },
    { name: 'at most one planner request reached the model', ok: planner.length <= 1, detail: `planner requests=${planner.length}` },
    { name: 'the task waits for an operator', ok: task?.state === 'failed_operator', detail: `state=${task?.state}` },
    { name: 'the office is told once', ok: alerts.length === 1, detail: `alerts=${alerts.length}` },
    { name: 'each message reaches the requester once', ok: dupes === 0, detail: `${shown.length} sends, ${dupes} duplicate(s)` },
  ];
}

/** Each task made one planner call, admitted once and completed (ADR-138, ADR-139). */
async function onePlannerCallEach(taskIds: string[]): Promise<InvariantResult[]> {
  const rows = await query<{ task_id: string; calls: number }>(sql`SELECT p.task_id::text, count(c.id)::int AS calls FROM hawa.canva_design_plans p
    LEFT JOIN hawa.canva_planner_calls c ON c.id = p.id AND c.status = 'completed' WHERE p.task_id = ANY(${taskIds}::uuid[]) GROUP BY p.task_id`);
  return [{ name: 'each task: one planner call, completed', ok: rows.length === taskIds.length && rows.every((r) => Number(r.calls) === 1), detail: JSON.stringify(rows) }];
}

/** ADR-138: the chat's design made one planner call, admitted once and completed, and its plan is planned. */
async function onePlannerCall(chat: string): Promise<InvariantResult[]> {
  const rows = await query<{ plan: string; call: string | null }>(sql`SELECT p.status AS plan, c.status AS call FROM hawa.canva_design_plans p
    JOIN hawa.tasks t ON t.id = p.task_id JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
    LEFT JOIN hawa.canva_planner_calls c ON c.id = p.id WHERE o.payload->>'sourceChannelId' = ${chat}`);
  return [{ name: 'one plan, its one planner call admitted and completed', ok: rows.length === 1 && ['planned', 'completed', 'transferred'].includes(rows[0].plan) && rows[0].call === 'completed',
    detail: JSON.stringify(rows) }];
}

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
