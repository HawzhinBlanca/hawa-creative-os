#!/usr/bin/env tsx
/**
 * The load test of the architecture programme (PLAN.md Phase 4 and section 5, Measures), on the chaos
 * stack (packages/testkit/chaos: compose project hawa-chaos, fakes for every provider). Never
 * production: it starts, seeds and tears down hawa-chaos only, and its database guard accepts
 * 127.0.0.1:56432/hawa_chaos alone.
 *
 *   npx tsx scripts/load/run.ts --poller core      # Core polls Telegram (production today)
 *   npx tsx scripts/load/run.ts --poller worker    # the worker polls, through ChatInbox (Phase 2.1)
 *   options: --tasks 5000 --chats 10 --idle-minutes 3 --after-minutes 2 --keep
 *            --plan-ms 30000        # every design plan's model call takes this long (the fakes answer
 *                                   # at once otherwise; real planner calls took 23-47 s, ADR-131)
 *            --planning-slots 4     # Core's HAWA_CANVA_PLANNING_SLOTS (its default when left out)
 *
 * What it does, in order:
 *  1. Waits until no container named hawa-chaos-* runs (another run, maybe another worktree's: the
 *     project name, ports and images are fixed, so only one may exist), polling every 30 s for up to
 *     30 minutes; then builds and starts the stack from this checkout as the chaos suite does.
 *  2. Seeds the Desk's tenant with `--tasks` tasks (scripts/load/seed-desk-tasks.ts) before Core
 *     starts, as a Core restart meets the office's queue.
 *  3. Opens three Desk tabs (scripts/load/desk-tab.ts: the Desk's own App in jsdom, one process each)
 *     signed in as the art director, and leaves them idle for `--idle-minutes`: requests per idle tab
 *     per minute.
 *  4. Load: `--chats` Telegram chats send a brief at the same moment (one getUpdates answer carries
 *     them all). Meanwhile tab "pager" pages 20 pages back and returns, tab "reviewer" opens ten queue
 *     cards, tab "idle" does nothing. Waits until every chat was shown its draft (or its design run
 *     ended otherwise, or 10 minutes pass), then until the stack is quiet.
 *  5. Idle again for `--after-minutes`.
 *  6. Reads everything back: the tabs' requests, the fake Telegram's polls and sends, Core's request
 *     and error lines, the worker's error lines, Restate's invocations, memory per container sampled
 *     every 5 s. Writes packages/testkit/chaos/.run/load-<poller>[-plan<ms>][-slots<n>].json (gitignored)
 *     and prints a summary.
 *  7. Always takes the project down with its volumes, unless --keep.
 *
 * Measures and where they come from:
 *  - brief to first draft, p50/p95: the fake Telegram's clock at both ends (load-stats.draftLatencies),
 *    and the host's clock from sending the update to seeing the draft (polled every 500 ms);
 *  - GET /tasks per page: each list request the tabs made, until its body was read, through the fakes'
 *    proxy (the chaos stack has no nginx, so there is no `rt=`), and Core's own `ms` for the same
 *    requests from its request log lines;
 *  - requests per idle tab per minute, by route;
 *  - memory of Core, the worker, Postgres and Restate (docker stats): before, peak, after;
 *  - errors: failed tab requests, console errors in the tabs, stream drops, error lines of Core and the
 *    worker, briefs without a draft, model calls no fixture answered, paused or failing invocations.
 */
import { fork, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  build, CHAOS_DIR, closeDb, down, fakes, logs, PORTS, query, REPO_ROOT, restateQuery, secrets, sql, up,
} from '../../packages/testkit/chaos/driver/stack.js';
import { connectCanva, kaaeClientDna, registerColour, upgradeSchema } from '../../packages/testkit/chaos/driver/provision.js';
import { briefText, designOutcome, quiescent, tasksOfChat, textUpdate } from '../../packages/testkit/chaos/driver/scenario.js';
import { draftLatencies, errorLines, isDraftSend, parseCoreRequestLines, requestRates, summarise, type SentRecord, type Summary, type TabRequest } from './load-stats.js';
import { seedDeskTasks } from './seed-desk-tasks.js';
import type { TabCommand, TabRecords, TabReply } from './desk-tab.js';

const TAB_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'desk-tab.ts');
const TABS = ['idle', 'pager', 'reviewer'] as const;
/** Requesters on TELEGRAM_INTAKE_ALLOWED_USERS in docker-compose.chaos.yml. */
const REQUESTERS = [9100001, 9100002, 9100003];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (line: string) => console.log(`[load] ${new Date().toISOString().slice(11, 19)} ${line}`);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Names of running containers of the chaos project (hawa-chaos-*), from `docker ps`. */
function chaosContainers(): string[] {
  const res = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`docker ps failed: ${res.stderr}`);
  return res.stdout.split('\n').map((s) => s.trim()).filter((n) => n.startsWith('hawa-chaos'));
}

async function waitForFreeChaosProject(): Promise<void> {
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    const running = chaosContainers();
    if (!running.length) return;
    if (Date.now() > deadline) throw new Error(`hawa-chaos is still in use after 30 minutes (${running.join(', ')}); not starting`);
    log(`hawa-chaos is in use (${running.join(', ')}); waiting 30 s`);
    await sleep(30_000);
  }
}

/** Memory per chaos container (MiB) from one `docker stats` sample, without blocking the event loop. */
function sampleMemory(): Promise<Record<string, number>> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}']);
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.on('close', () => {
      const m: Record<string, number> = {};
      for (const line of out.split('\n')) {
        const [name, usage] = line.split('\t');
        if (!name?.startsWith('hawa-chaos-') || !usage) continue;
        const hit = /([\d.]+)\s*([KMG]i?B)/.exec(usage);
        if (!hit) continue;
        const n = Number(hit[1]);
        m[name.replace(/^hawa-chaos-|-1$/g, '')] = Math.round(hit[2].startsWith('G') ? n * 1024 : hit[2].startsWith('K') ? n / 1024 : n);
      }
      resolve(m);
    });
    child.on('error', () => resolve({}));
  });
}

class Tab {
  readonly child: ChildProcess;
  private waiters: Array<(reply: TabReply) => boolean> = [];
  readonly output: string[] = [];

  constructor(readonly name: string) {
    this.child = fork(TAB_FILE, [], {
      cwd: REPO_ROOT,
      // Node's own notice that EventSource is experimental is not the Desk's error.
      execArgv: ['--experimental-eventsource', '--disable-warning=UNDICI-ES', '--import', 'tsx'],
      // The Desk's own compiler settings (react-jsx) for its .tsx files.
      env: { ...process.env, TSX_TSCONFIG_PATH: path.join(REPO_ROOT, 'apps', 'desk', 'tsconfig.json') },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const keep = (d: Buffer) => {
      for (const line of String(d).split('\n')) if (line.trim()) this.output.push(line.slice(0, 300));
      if (this.output.length > 200) this.output.splice(0, this.output.length - 200);
    };
    this.child.stdout?.on('data', keep);
    this.child.stderr?.on('data', keep);
    this.child.on('message', (reply: TabReply) => {
      this.waiters = this.waiters.filter((w) => !w(reply));
    });
  }

  /** Sends a command and waits for the reply it names (or a failure). */
  request(command: TabCommand, expect: TabReply['type'], timeoutMs = 300_000): Promise<TabReply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`tab ${this.name}: no ${expect} after ${timeoutMs} ms; last output: ${this.output.slice(-5).join(' | ')}`)), timeoutMs);
      this.waiters.push((reply) => {
        if (reply.type === 'failed') {
          clearTimeout(timer);
          reject(new Error(`tab ${this.name}: ${reply.error}`));
          return true;
        }
        if (reply.type !== expect) return false;
        clearTimeout(timer);
        resolve(reply);
        return true;
      });
      this.child.send(command);
    });
  }

  stop(): void {
    try {
      this.child.send({ type: 'stop' } satisfies TabCommand);
    } catch {
      // Already gone.
    }
    setTimeout(() => this.child.kill('SIGKILL'), 3000).unref();
  }
}

interface MemoryReport {
  before: Record<string, number>;
  peakDuringLoad: Record<string, number>;
  after: Record<string, number>;
}

async function main(): Promise<void> {
  const poller = arg('poller', 'core');
  if (poller !== 'core' && poller !== 'worker') throw new Error('--poller takes core or worker');
  const taskCount = Number(arg('tasks', '5000'));
  const chatCount = Number(arg('chats', '10'));
  const idleMinutes = Number(arg('idle-minutes', '3'));
  const afterMinutes = Number(arg('after-minutes', '2'));
  const keep = process.argv.includes('--keep');
  const planMs = Number(arg('plan-ms', '0'));
  if (!Number.isInteger(planMs) || planMs < 0 || planMs > 80_000) throw new Error('--plan-ms takes 0 to 80000 (the planner aborts a model call at 90 s)');
  const planningSlots = arg('planning-slots', '');
  // docker compose reads them from this process's environment (docker-compose.chaos.yml).
  process.env.CHAOS_TELEGRAM_POLLER = poller;
  process.env.HAWA_CANVA_PLANNING_SLOTS = planningSlots;

  const tabs: Tab[] = [];
  const memorySamples: Array<{ at: number; mib: Record<string, number> }> = [];
  let sampling = true;
  const result: Record<string, unknown> = { poller, taskCount, chatCount, idleMinutes, afterMinutes, planMs, planningSlots: planningSlots || 'default', startedAt: new Date().toISOString() };
  const outFile = path.join(CHAOS_DIR, '.run', `load-${poller}${planMs ? `-plan${planMs}` : ''}${planningSlots ? `-slots${planningSlots}` : ''}.json`);

  const stopEverything = () => {
    for (const t of tabs) t.stop();
  };
  process.on('SIGINT', () => {
    stopEverything();
    if (!keep) down({ volumes: true });
    process.exit(130);
  });

  try {
    await waitForFreeChaosProject();
    log(`starting hawa-chaos with the ${poller} poller`);
    down({ volumes: true });
    build(['core', 'worker-blue']);
    up({ services: ['postgres', 'restate', 'fakes'] });
    await upgradeSchema();
    await connectCanva();
    await kaaeClientDna();
    const ownerUrl = `postgresql://hawa_owner:${secrets().CHAOS_OWNER_PASSWORD}@127.0.0.1:${PORTS.postgres}/hawa_chaos`;
    const seeded = await seedDeskTasks(ownerUrl, { tasks: taskCount });
    log(`seeded ${seeded.created} tasks in ${seeded.ms} ms`);
    const [size] = await query<{ bytes: string }>(sql`SELECT pg_database_size('hawa_chaos') AS bytes`);
    result.seed = { ...seeded, databaseMiB: Math.round(Number(size.bytes) / 1048576) };
    up({ build: false, services: ['core', 'worker-blue'] });
    const reg = await registerColour('blue');
    if (reg.code !== 0) throw new Error(`register blue: ${reg.lines.join(' | ')}`);
    await fakes.reset();
    // Each brief makes one planner call; twice as many covers a re-drive.
    if (planMs) await fakes.modelDelay({ schema: 'canva_design_plan', delayMs: planMs, n: chatCount * 2 });

    void (async () => {
      while (sampling) {
        memorySamples.push({ at: Date.now(), mib: await sampleMemory() });
        await sleep(5000);
      }
    })();

    // Three tabs, signed in with the art director's key (through IPC, never printed).
    const coreUrl = `http://127.0.0.1:${PORTS.fakes}/__core`;
    for (const name of TABS) tabs.push(new Tab(name));
    const ready = await Promise.all(tabs.map((t) => t.request({ type: 'start', tab: t.name, coreUrl, key: secrets().CHAOS_REVIEWER_KEY }, 'ready', 180_000)));
    for (const r of ready) if (r.type === 'ready') log(`tab ${r.tab} ready in ${r.ms} ms: ${r.cards} cards, "${r.label}"`);
    result.tabsReady = ready;

    await sleep(15_000);
    const idleA = { from: Date.now(), to: 0 };
    log(`idle window: ${idleMinutes} min`);
    await sleep(idleMinutes * 60_000);
    idleA.to = Date.now();

    // The poller must be asking Telegram (the worker's takes over 30 s after its colour is live).
    await (async () => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const polls = (await fakes.polls()).polls as Array<{ at: string }>;
        if (polls.length && Date.now() - Date.parse(polls[polls.length - 1].at) < 5000) return;
        await sleep(1000);
      }
      throw new Error('nobody polls the fake Telegram');
    })();

    // Load: every chat sends its brief at once.
    const chats = Array.from({ length: chatCount }, (_, i) => String(9_400_001 + i));
    const updates = chats.map((chat, i) => textUpdate(chat, briefText(`LOAD-${poller}-${i + 1}`), REQUESTERS[i % REQUESTERS.length]));
    const loadStarted = Date.now();
    const updateIds = await fakes.updates(updates);
    const briefs = chats.map((chat, i) => ({ chat, updateId: updateIds[i], sentAt: loadStarted }));
    log(`${chatCount} briefs sent`);
    const pagerDone = tabs[1].request({ type: 'pages', count: 20 }, 'done', 600_000).catch((err: Error) => ({ type: 'failed', error: err.message }));
    const reviewerDone = tabs[2].request({ type: 'browse', count: 10, everyMs: 2000 }, 'done', 600_000).catch((err: Error) => ({ type: 'failed', error: err.message }));

    const seenAt = new Map<string, number>();
    const ended = new Map<string, string>();
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline && seenAt.size + ended.size < chats.length) {
      const sent = (await fakes.sent()) as SentRecord[];
      for (const chat of chats) {
        if (seenAt.has(chat) || ended.has(chat)) continue;
        if (sent.some((s) => s.chat_id === chat && isDraftSend(s))) seenAt.set(chat, Date.now());
        else {
          const [task] = await tasksOfChat(chat);
          const outcome = task ? await designOutcome(task.id) : null;
          if (outcome && outcome !== 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW') ended.set(chat, outcome);
        }
      }
      await sleep(500);
    }
    const loadEnded = Date.now();
    log(`drafts shown: ${seenAt.size}/${chats.length}; ended otherwise: ${ended.size}`);
    result.pager = await pagerDone;
    result.reviewer = await reviewerDone;
    await quiescent(5000, 240_000).then(() => (result.quiescent = true), (err: Error) => (result.quiescent = `not quiet: ${err.message}`));
    const loadWindow = { from: loadStarted, to: Date.now() };

    const idleB = { from: Date.now(), to: 0 };
    log(`idle window after the load: ${afterMinutes} min`);
    await sleep(afterMinutes * 60_000);
    idleB.to = Date.now();
    sampling = false;

    // Read everything back.
    const tabRecords: TabRecords[] = [];
    for (const t of tabs) {
      const reply = await t.request({ type: 'collect' }, 'records', 60_000);
      if (reply.type === 'records') tabRecords.push(reply.records);
    }
    const requests: TabRequest[] = tabRecords.flatMap((r) => r.requests);
    const sent = (await fakes.sent()) as SentRecord[];
    const polls = (await fakes.polls()).polls;
    const latencies = draftLatencies({ briefs, polls, sent });
    const hostMs = chats.map((c) => (seenAt.has(c) ? seenAt.get(c)! - loadStarted : null)).filter((v): v is number => v !== null);
    const chatReports = [];
    for (const [i, chat] of chats.entries()) {
      const [task] = await tasksOfChat(chat);
      chatReports.push({ ...latencies[i], taskId: task?.id ?? null, state: task?.state ?? null, outcome: task ? await designOutcome(task.id) : null, hostObservedMs: seenAt.has(chat) ? seenAt.get(chat)! - loadStarted : null });
    }
    result.briefToDraft = {
      fromPickupMs: summarise(latencies.map((l) => l.fromPickupMs).filter((v): v is number => v !== null)),
      fromSendHostMs: summarise(hostMs),
      chats: chatReports,
      missing: chats.filter((c) => !seenAt.has(c)),
      endedOtherwise: Object.fromEntries(ended),
    };

    const list = requests.filter((r) => r.route === 'GET /v1/tasks');
    const ok = list.filter((r) => r.status === 200);
    const inWindow = (w: { from: number; to: number }) => (r: { at: number }) => r.at >= w.from && r.at < w.to;
    const byPage: Record<string, Summary> = {};
    for (const page of [...new Set(ok.map((r) => r.page ?? 0))].sort((a, b) => a - b)) {
      byPage[page === 0 ? 'unknown' : String(page)] = summarise(ok.filter((r) => (r.page ?? 0) === page).map((r) => r.ms));
    }
    const coreLog = logs('core', 500_000);
    const coreList = parseCoreRequestLines(coreLog).filter((l) => l.method === 'GET' && l.path === '/v1/tasks');
    result.taskList = {
      viaProxyMs: summarise(ok.map((r) => r.ms)),
      viaProxyMsDuringLoad: summarise(ok.filter(inWindow(loadWindow)).map((r) => r.ms)),
      viaProxyMsByPage: byPage,
      coreHandlerMs: summarise(coreList.filter((l) => l.status === 200).map((l) => l.ms)),
      coreHandlerMsDuringLoad: summarise(coreList.filter((l) => l.status === 200).filter(inWindow(loadWindow)).map((l) => l.ms)),
      pageTurnsMs: summarise(tabRecords.flatMap((r) => r.pageTurnsMs)),
      detailMs: summarise(requests.filter((r) => r.route === 'GET /v1/tasks/:id' && r.status === 200).map((r) => r.ms)),
    };
    result.idleRequests = {
      before: requestRates(requests, idleA, TABS),
      after: requestRates(requests, idleB, TABS),
      windowsMinutes: { before: (idleA.to - idleA.from) / 60_000, after: (idleB.to - idleB.from) / 60_000 },
    };
    result.loadRequests = requestRates(requests, loadWindow, TABS);

    const peak = (from: number, to: number) => {
      const out: Record<string, number> = {};
      for (const s of memorySamples.filter((m) => m.at >= from && m.at <= to)) for (const [k, v] of Object.entries(s.mib)) out[k] = Math.max(out[k] || 0, v);
      return out;
    };
    const lastBefore = [...memorySamples].reverse().find((m) => m.at < loadStarted)?.mib ?? {};
    const memory: MemoryReport = { before: lastBefore, peakDuringLoad: peak(loadStarted, loadWindow.to), after: memorySamples[memorySamples.length - 1]?.mib ?? {} };
    result.memoryMiB = memory;
    result.memoryPeakWholeRunMiB = peak(0, Date.now());

    const invocations = await restateQuery<{ target_service_name: string; status: string; n: number }>(
      `SELECT target_service_name, status, count(*) AS n FROM sys_invocation GROUP BY target_service_name, status ORDER BY target_service_name, status`
    );
    const [rt16] = await restateQuery<{ n: number }>(`SELECT count(*) AS n FROM sys_invocation WHERE last_failure_error_code = 'RT0016'`);
    const failing = await restateQuery<{ target_service_name: string; status: string; last_failure: string | null }>(
      `SELECT target_service_name, status, last_failure FROM sys_invocation WHERE status IN ('paused', 'backing-off') LIMIT 10`
    );
    const ledger = await fakes.modelLedger();
    result.errors = {
      tabRequestsFailed: requests.filter((r) => r.status === 0 || r.status >= 400).map((r) => `${r.tab} ${r.route} ${r.status}${r.error ? ` ${r.error}` : ''}`),
      tabConsoleErrors: Object.fromEntries(tabRecords.map((r) => [r.tab, r.consoleErrors.slice(0, 10)])),
      tabUncaught: Object.fromEntries(tabRecords.map((r) => [r.tab, r.uncaught.slice(0, 10)])),
      streamOpens: Object.fromEntries(tabRecords.map((r) => [r.tab, r.streamOpens])),
      streamErrors: Object.fromEntries(tabRecords.map((r) => [r.tab, r.streamErrors])),
      coreErrorLines: errorLines(coreLog),
      workerErrorLines: errorLines(logs('worker-blue', 500_000)),
      briefsWithoutDraft: chats.filter((c) => !seenAt.has(c)),
      unmatchedModelCalls: (ledger.ledger as Array<{ route: string; provider: string }>).filter((l) => String(l.route).startsWith('unmatched')).map((l) => `${l.provider} ${l.route}`),
      restatePausedOrBackingOff: failing,
      restateRT0016: Number(rt16?.n ?? 0),
    };
    result.restateInvocations = invocations;
    result.events = Object.fromEntries(tabRecords.map((r) => [r.tab, r.events]));
    result.finishedAt = new Date().toISOString();
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify({ ...result, requests: requests.map(({ tab, at, route, status, ms, page }) => ({ tab, at, route, status, ms, page })) }, null, 2));
    printSummary(result);
    log(`results: ${path.relative(REPO_ROOT, outFile)}`);
  } catch (err) {
    result.failed = err instanceof Error ? err.message : String(err);
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify(result, null, 2));
    console.error(`[load] FAILED: ${result.failed}`);
    for (const t of tabs) if (t.output.length) console.error(`[load] tab ${t.name} last output:\n  ${t.output.slice(-15).join('\n  ')}`);
    process.exitCode = 1;
  } finally {
    sampling = false;
    stopEverything();
    await closeDb();
    if (!keep) {
      down({ volumes: true });
      log('hawa-chaos is down, with its volumes');
    } else log('--keep: hawa-chaos is still running; take it down with `npx tsx packages/testkit/chaos/run.ts --down`');
  }
}

function printSummary(r: Record<string, unknown>): void {
  const b = r.briefToDraft as { fromPickupMs: Summary; fromSendHostMs: Summary; missing: string[] };
  const t = r.taskList as Record<string, Summary>;
  const idle = r.idleRequests as { before: Record<string, { perMinute: number; listPerMinute: number }>; after: Record<string, { perMinute: number; listPerMinute: number }> };
  const m = r.memoryMiB as MemoryReport;
  const e = r.errors as Record<string, unknown>;
  console.log(`\n=== load test, poller ${String(r.poller)} ===`);
  console.log(`brief to first draft (fake Telegram clock, from pickup): p50 ${b.fromPickupMs.p50} ms, p95 ${b.fromPickupMs.p95} ms, max ${b.fromPickupMs.max} ms (n=${b.fromPickupMs.n})`);
  console.log(`brief to first draft (host clock, from send):           p50 ${b.fromSendHostMs.p50} ms, p95 ${b.fromSendHostMs.p95} ms (n=${b.fromSendHostMs.n}); missing: ${b.missing.length}`);
  console.log(`GET /v1/tasks via proxy: p50 ${t.viaProxyMs.p50} ms, p95 ${t.viaProxyMs.p95} ms, max ${t.viaProxyMs.max} ms (n=${t.viaProxyMs.n}); during load p95 ${t.viaProxyMsDuringLoad.p95} ms`);
  console.log(`GET /v1/tasks Core handler: p50 ${t.coreHandlerMs.p50} ms, p95 ${t.coreHandlerMs.p95} ms, max ${t.coreHandlerMs.max} ms (n=${t.coreHandlerMs.n})`);
  for (const [when, rates] of Object.entries(idle)) {
    if (when === 'windowsMinutes') continue;
    console.log(`idle requests per tab per minute (${when}): ${Object.entries(rates).map(([tab, v]) => `${tab} ${v.perMinute} (list ${v.listPerMinute})`).join(', ')}`);
  }
  console.log(`memory MiB before: ${JSON.stringify(m.before)}`);
  console.log(`memory MiB peak during load: ${JSON.stringify(m.peakDuringLoad)}`);
  console.log(`memory MiB after: ${JSON.stringify(m.after)}`);
  console.log(`errors: ${JSON.stringify(e)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
