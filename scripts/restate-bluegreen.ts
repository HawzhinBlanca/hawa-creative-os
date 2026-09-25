#!/usr/bin/env tsx
/**
 * Blue/green worker deploys with Restate (architecture programme 0.1, ADR-034).
 *
 * Restate pins every invocation to the deployment that started it, and a deployment is an address.
 * deploy.sh used to replace the worker container behind the one address it had (http://worker:9080)
 * and re-register it, with a force:true fallback, so journals in flight replayed on changed code:
 * the cause of journal mismatches (RT0016) in Restate's error reference. Now each colour has its own
 * address. A deploy goes to the colour that is not live, registers it with force:false (Restate then
 * sends new work there), waits until nothing is pinned to the old deployment any more, and only then
 * deletes that deployment and stops its container. A drain that takes too long leaves the old colour
 * running; the next deploy finishes it first.
 *
 * Behaviour of Restate 1.7.10 this relies on, measured on a scratch server on 2026-09-24:
 * - POST /deployments with a new address answers 201 and moves every service it hosts to it. A
 *   service the new build does not host stays on the old deployment (TaskService did, when a build
 *   hosted TaskWorkflow only), so a registration can move some services and not others.
 * - POST /deployments with an address Restate already holds answers 200 and changes nothing, even
 *   when the handlers at that address have changed. Only force:true would replace them, and that
 *   is what breaks invocations in flight. So an address Restate held before this deploy is refused
 *   without asking; a 200 for an address it did not hold means an earlier attempt of ours was
 *   committed and its answer lost, which is a success.
 * - An address it cannot reach is 500 with META0003 (a colour still starting); it is retried.
 * - DELETE /deployments/{id} without force answers 501; with ?force=true, 202.
 * - POST /query {"query": …} answers {"rows": […]} from sys_invocation.
 *
 * deploy.sh runs this on the host. Restate's admin port is not published, so the calls are made by
 * node inside the Core container (--via-container), which is on Restate's network.
 *
 *   npx tsx scripts/restate-bluegreen.ts plan [--via-container hawa-production-core-1]
 *   npx tsx scripts/restate-bluegreen.ts finish-drains --wait-seconds 900 [--require-drained blue]
 *   npx tsx scripts/restate-bluegreen.ts register green
 *   npx tsx scripts/restate-bluegreen.ts removable green
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Colour = 'blue' | 'green';
/** `legacy` is the single `worker` service every deploy before blue/green registered. */
export type WorkerSlot = Colour | 'legacy';
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface WorkerAddresses { blue: string; green: string; legacy: string }
export const DEFAULT_WORKER_ADDRESSES: WorkerAddresses = {
  blue: 'http://worker-blue:9080',
  green: 'http://worker-green:9080',
  legacy: 'http://worker:9080',
};

/** Restate reports `http://worker-blue:9080/` for a deployment registered as `http://worker-blue:9080`. */
export function normaliseUri(uri: string): string {
  try {
    const url = new URL(uri);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return uri.replace(/\/+$/, '').toLowerCase();
  }
}

export function slotOf(uri: string, addresses: WorkerAddresses = DEFAULT_WORKER_ADDRESSES): WorkerSlot | null {
  const u = normaliseUri(uri);
  for (const slot of ['blue', 'green', 'legacy'] as const) if (normaliseUri(addresses[slot]) === u) return slot;
  return null;
}

export class RestateAdmin {
  constructor(readonly adminUrl: string, private readonly fetcher: FetchLike, private readonly timeoutMs = 10_000) {
    this.adminUrl = adminUrl.replace(/\/+$/, '');
  }

  private call(pathname: string, init: RequestInit = {}) {
    return this.fetcher(`${this.adminUrl}${pathname}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
  }

  async deployments(): Promise<Array<{ id: string; uri: string }>> {
    const res = await this.call('/deployments');
    if (!res.ok) throw new Error(`GET /deployments answered ${res.status}`);
    return (((await res.json()) as { deployments?: Array<{ id: string; uri?: string }> }).deployments || [])
      .map((d) => ({ id: d.id, uri: d.uri || '' }));
  }

  /** The deployment new invocations of `service` go to, or null when Restate does not know the service. */
  async serviceDeployment(service: string): Promise<string | null> {
    const res = await this.call(`/services/${encodeURIComponent(service)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET /services/${service} answered ${res.status}`);
    return ((await res.json()) as { deployment_id?: string }).deployment_id || null;
  }

  /** Every service Restate knows, with the deployment its new invocations go to. */
  async services(): Promise<Array<{ name: string; deploymentId: string | null }>> {
    const res = await this.call('/services');
    if (!res.ok) throw new Error(`GET /services answered ${res.status}`);
    return (((await res.json()) as { services?: Array<{ name: string; deployment_id?: string }> }).services || [])
      .map((s) => ({ name: s.name, deploymentId: s.deployment_id || null }));
  }

  register(uri: string): Promise<Response> {
    // force stays false: forcing replaces the handlers under invocations in flight, which is what
    // this whole procedure exists to avoid. There is no fallback.
    return this.call('/deployments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uri, use_http_11: true, force: false }),
    });
  }

  /** Called only for a deployment nothing is pinned to (Restate 1.7 accepts no other kind of delete). */
  async deleteDeployment(id: string): Promise<void> {
    const res = await this.call(`/deployments/${encodeURIComponent(id)}?force=true`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`DELETE /deployments/${id} answered ${res.status}`);
  }

  /** Invocations pinned to a deployment that have not completed: running, suspended, backing off, paused. */
  inFlight(deploymentId: string): Promise<number> {
    return this.countPinned(deploymentId, "status <> 'completed'");
  }

  /** Invocations pinned to a deployment that will not finish without a person: paused, or retrying. */
  stuck(deploymentId: string): Promise<number> {
    return this.countPinned(deploymentId, "status IN ('paused', 'backing-off')");
  }

  private async countPinned(deploymentId: string, condition: string): Promise<number> {
    if (!/^[A-Za-z0-9_]+$/.test(deploymentId)) throw new Error(`not a deployment id: ${deploymentId}`);
    const res = await this.call('/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: `SELECT count(*) AS n FROM sys_invocation WHERE pinned_deployment_id = '${deploymentId}' AND ${condition}` }),
    });
    if (!res.ok) throw new Error(`POST /query answered ${res.status}`);
    const n = Number(((await res.json()) as { rows?: Array<{ n?: number | string }> }).rows?.[0]?.n);
    if (!Number.isFinite(n)) throw new Error('POST /query answered without a count');
    return n;
  }
}

export interface Topology {
  deployments: Array<{ id: string; uri: string; slot: WorkerSlot | null }>;
  /** The deployment new TaskWorkflow invocations go to. */
  liveDeploymentId: string | null;
  live: WorkerSlot | null;
  liveUri: string | null;
}

export async function readTopology(admin: RestateAdmin, addresses: WorkerAddresses = DEFAULT_WORKER_ADDRESSES): Promise<Topology> {
  const deployments = (await admin.deployments()).map((d) => ({ ...d, slot: slotOf(d.uri, addresses) }));
  const liveDeploymentId = await admin.serviceDeployment('TaskWorkflow');
  const live = deployments.find((d) => d.id === liveDeploymentId) || null;
  return { deployments, liveDeploymentId, live: live?.slot ?? null, liveUri: live?.uri ?? null };
}

export interface DeployPlan { live: WorkerSlot | null; liveDeploymentId: string | null; idle: Colour }

/** A deploy goes to the colour that is not live; the first one after the single `worker` goes to blue. */
export function planDeploy(topology: Topology): DeployPlan {
  if (topology.liveDeploymentId && !topology.live) {
    throw new Error(`TaskWorkflow is served from ${topology.liveUri}, which is not a worker colour; refusing to guess which colour is live`);
  }
  return { live: topology.live, liveDeploymentId: topology.liveDeploymentId, idle: topology.live === 'blue' ? 'green' : 'blue' };
}

interface Clock { sleep?: (ms: number) => Promise<void>; now?: () => number }
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * - ok: Restate holds the colour as a new deployment and routes every worker service to it.
 * - refused: Restate holds no deployment at the colour's address (or held one before this deploy,
 *   which force:false never replaces), so nothing it routes changed and the colour may be removed.
 * - partial: Restate registered the colour, so it may already be sending work there, but some
 *   service still goes elsewhere, or that could not be confirmed. The colour must not be removed.
 */
export type RegisterOutcome =
  | { ok: true; deploymentId: string }
  | { ok: false; state: 'refused'; reason: string }
  | { ok: false; state: 'partial'; deploymentId: string | null; reason: string };

/**
 * The services a worker build hosts (apps/worker/src/services.ts, which the worker checks what it
 * binds against); checked even when GET /services is short. Every service ever hosted stays here:
 * ChatInbox since Phase 2.1; Delivery and TelegramSender since Phase 2.2.
 */
export const WORKER_SERVICES = ['TaskWorkflow', 'TaskService', 'ChatInbox', 'Delivery', 'TelegramSender', 'RequestLifecycle', 'DesignRun', 'OfficeDecisionGateway'] as const;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function retrying<T>(attempts: number, fn: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts) throw err;
      await sleep(1000);
    }
  }
}

export async function registerColour(
  admin: RestateAdmin,
  colour: Colour,
  options: Clock & { attempts?: number; intervalMs?: number; addresses?: WorkerAddresses } = {},
): Promise<RegisterOutcome> {
  const addresses = options.addresses || DEFAULT_WORKER_ADDRESSES;
  const uri = addresses[colour];
  const attempts = Math.max(1, options.attempts ?? 30);
  const sleep = options.sleep || realSleep;
  const atAddress = (list: Array<{ id: string; uri: string }>) => list.find((d) => normaliseUri(d.uri) === normaliseUri(uri)) || null;

  // What Restate held before anything was sent. An address it already holds keeps its old handlers
  // under force:false, so that is a refusal without asking; any deployment at the address after this
  // point was made by this call, even when Restate's answer to it was lost.
  const before = await admin.deployments();
  const held = atAddress(before);
  if (held) {
    return { ok: false, state: 'refused', reason: `${uri} is already registered as ${held.id}; force:false never replaces its handlers (finish that colour's drain first)` };
  }

  let accepted: string | null = null;
  let answerLost = false;
  let lastReason = 'no attempt made';
  for (let attempt = 1; attempt <= attempts && !accepted; attempt++) {
    let res: Response;
    let text: string;
    try {
      res = await admin.register(uri);
      text = await res.text();
    } catch (err) {
      // Restate may have committed the registration before the answer was lost.
      answerLost = true;
      lastReason = `Restate did not answer: ${messageOf(err)}`;
      if (attempt < attempts) await sleep(options.intervalMs ?? 2000);
      continue;
    }
    let body: { id?: string; message?: string } = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
    if (res.ok && body.id) {
      // 201, or 200 for the registration an earlier attempt made (the address was not held before).
      accepted = body.id;
      break;
    }
    const message = String(body.message || text || '').trim();
    lastReason = `${res.status}${message ? `: ${message}` : ''}`;
    // A colour that is still starting cannot be reached yet: wait for it. Anything else is Restate's answer.
    if (res.status >= 500 && /META0003|unable to reach/i.test(message)) {
      if (attempt < attempts) await sleep(options.intervalMs ?? 2000);
      continue;
    }
    if (!answerLost) return { ok: false, state: 'refused', reason: lastReason };
    break;
  }

  if (!accepted) {
    if (!answerLost) return { ok: false, state: 'refused', reason: `gave up after ${attempts} attempts: ${lastReason}` };
    // Some answer was lost: only Restate's registry says whether that attempt was committed.
    try {
      const now = atAddress(await retrying(3, () => admin.deployments(), sleep));
      if (!now) return { ok: false, state: 'refused', reason: `${lastReason}; Restate holds no deployment at ${uri}` };
      accepted = now.id;
    } catch (err) {
      return { ok: false, state: 'partial', deploymentId: null, reason: `${lastReason}, and whether Restate registered ${uri} could not be read (${messageOf(err)})` };
    }
  }

  // Restate moves every service the new build hosts. One it does not host stays where it was, and a
  // registration that moved TaskWorkflow alone would leave TaskService on the old colour: say so, and
  // keep both colours, rather than call it done or call it refused.
  const names = new Set<string>(WORKER_SERVICES);
  const workerIds = new Set(before.filter((d) => slotOf(d.uri, addresses)).map((d) => d.id));
  try {
    for (const s of await admin.services()) if (s.deploymentId && workerIds.has(s.deploymentId)) names.add(s.name);
  } catch {
    // Older answers, or a hiccup: the services a worker build hosts are still checked one by one.
  }
  const elsewhere: string[] = [];
  for (const name of names) {
    let serving: string | null;
    try {
      serving = await retrying(3, () => admin.serviceDeployment(name), sleep);
    } catch (err) {
      return { ok: false, state: 'partial', deploymentId: accepted, reason: `registered as ${accepted}, but where Restate sends ${name} could not be read (${messageOf(err)})` };
    }
    if (serving !== accepted) elsewhere.push(`${name} -> ${serving ?? 'nothing'}`);
  }
  if (elsewhere.length) {
    return { ok: false, state: 'partial', deploymentId: accepted, reason: `registered as ${accepted}, but Restate still sends ${elsewhere.join(', ')} (does the new build host every service?)` };
  }
  return { ok: true, deploymentId: accepted };
}

export interface DrainReport {
  deleted: Array<{ slot: WorkerSlot; deploymentId: string }>;
  /** Invocations are still pinned to these (inFlight null: Restate did not say, so it is kept). */
  draining: Array<{ slot: WorkerSlot; deploymentId: string; inFlight: number | null }>;
  /** Not deleted for another reason: a service is still routed to it, or the delete kept failing. */
  kept: Array<{ slot: WorkerSlot; deploymentId: string; reason: string }>;
}

/**
 * Every worker deployment that is not the live one is drained: once no invocation pinned to it is
 * unfinished and no service is routed to it, it is deleted (the caller then stops its container).
 * Waits up to `waitMs`; what has not drained by then is reported and left alone. The live deployment
 * is never touched, nothing is deleted while Restate names no live deployment at all, and a
 * deployment any service still points at is never deleted: that is the "service not found" outage
 * of 2026-09-17 by another road.
 */
export async function finishDrains(
  admin: RestateAdmin,
  options: Clock & { waitMs: number; intervalMs?: number; addresses?: WorkerAddresses; log?: (line: string) => void },
): Promise<DrainReport> {
  const sleep = options.sleep || realSleep;
  const now = options.now || Date.now;
  const topology = await readTopology(admin, options.addresses);
  const report: DrainReport = { deleted: [], draining: [], kept: [] };
  if (!topology.liveDeploymentId) return report;
  type Pending = { slot: WorkerSlot; deploymentId: string; inFlight: number | null; deleteError: string | null };
  let pending: Pending[] = topology.deployments
    .filter((d) => d.slot && d.id !== topology.liveDeploymentId)
    .map((d) => ({ slot: d.slot as WorkerSlot, deploymentId: d.id, inFlight: null, deleteError: null }));
  const deadline = now() + Math.max(0, options.waitMs);
  for (;;) {
    // Read afresh every round: which deployment each service goes to is what a delete must not break.
    let routes: Array<{ name: string; deploymentId: string | null }> | null = null;
    try {
      routes = await admin.services();
    } catch (err) {
      options.log?.(`could not read which deployment each service goes to, so nothing is deleted this round: ${messageOf(err)}`);
    }
    for (const d of pending) {
      const serves = routes?.filter((s) => s.deploymentId === d.deploymentId).map((s) => s.name) || [];
      if (serves.length) {
        // Waiting does not change this; a person does (see the runbook).
        report.kept.push({ slot: d.slot, deploymentId: d.deploymentId, reason: `Restate still sends ${serves.join(', ')} to it` });
        continue;
      }
      try {
        d.inFlight = await admin.inFlight(d.deploymentId);
      } catch (err) {
        d.inFlight = null;
        options.log?.(`could not count invocations pinned to ${d.slot} (${d.deploymentId}): ${messageOf(err)}`);
        continue;
      }
      if (d.inFlight === 0 && routes) {
        try {
          await admin.deleteDeployment(d.deploymentId);
          report.deleted.push({ slot: d.slot, deploymentId: d.deploymentId });
        } catch (err) {
          d.deleteError = messageOf(err);
          options.log?.(`could not delete the drained ${d.slot} deployment ${d.deploymentId}: ${d.deleteError}`);
        }
      }
    }
    const done = new Set([...report.deleted, ...report.kept].map((d) => d.deploymentId));
    pending = pending.filter((d) => !done.has(d.deploymentId));
    const remaining = deadline - now();
    if (!pending.length || remaining <= 0) break;
    options.log?.(`waiting for ${pending.map((d) => `${d.slot}: ${d.inFlight ?? 'unknown'} in flight`).join(', ')}`);
    await sleep(Math.min(options.intervalMs ?? 10_000, remaining));
  }
  for (const d of pending) {
    if (d.inFlight === 0 && d.deleteError) report.kept.push({ slot: d.slot, deploymentId: d.deploymentId, reason: `drained, but its delete failed: ${d.deleteError}` });
    else report.draining.push({ slot: d.slot, deploymentId: d.deploymentId, inFlight: d.inFlight });
  }
  return report;
}

type Spawn = (cmd: string, args: string[], opts: { input: string; encoding: 'utf8'; timeout: number; maxBuffer: number }) => { status: number | null; stdout: string; stderr: string };

/** Runs inside the Core container: reads one request as JSON on stdin, answers {status, body} or {error}. */
const CONTAINER_PROXY = `let s='';process.stdin.on('data',(d)=>{s+=d;}).on('end',async()=>{const r=JSON.parse(s);try{const res=await fetch(r.url,{method:r.method,headers:r.headers,body:r.body,signal:AbortSignal.timeout(r.timeoutMs)});process.stdout.write(JSON.stringify({status:res.status,body:await res.text()}));}catch(e){process.stdout.write(JSON.stringify({error:String((e&&e.cause&&e.cause.code)||(e&&e.message)||e)}));}});`;

/** A fetch whose requests are made by node inside `container` (Restate's admin port is not published). */
export function containerFetch(container: string, spawn: Spawn = spawnSync as unknown as Spawn, timeoutMs = 15_000): FetchLike {
  return async (url, init = {}) => {
    const request = { url, method: init.method || 'GET', headers: init.headers || {}, body: init.body, timeoutMs };
    const result = spawn('docker', ['exec', '-i', container, 'node', '-e', CONTAINER_PROXY], {
      input: JSON.stringify(request), encoding: 'utf8', timeout: timeoutMs + 5000, maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0) throw new TypeError(`docker exec ${container} failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
    let answer: { status?: number; body?: string; error?: string };
    try { answer = JSON.parse(result.stdout); } catch { throw new TypeError(`unreadable answer from ${container}`); }
    if (answer.error || typeof answer.status !== 'number') throw new TypeError(`fetch ${url} failed inside ${container}: ${answer.error || 'no status'}`);
    const empty = answer.status === 204 || answer.status === 205 || answer.status === 304 || !answer.body;
    return new Response(empty ? null : answer.body, { status: answer.status });
  };
}

export function addressesFromEnv(env: NodeJS.ProcessEnv = process.env): WorkerAddresses {
  return {
    blue: env.HAWA_WORKER_URI_BLUE || DEFAULT_WORKER_ADDRESSES.blue,
    green: env.HAWA_WORKER_URI_GREEN || DEFAULT_WORKER_ADDRESSES.green,
    legacy: env.HAWA_WORKER_URI_LEGACY || DEFAULT_WORKER_ADDRESSES.legacy,
  };
}

export interface CliDeps extends Clock {
  fetcher?: FetchLike;
  out?: (line: string) => void;
  err?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

/**
 * Exit codes: 0 done; 1 Restate could not be read; 64 bad usage.
 * register: 2 refused, Restate holds nothing new at the colour's address (removing it is safe);
 *   4 Restate registered it but not every service moved there, or that could not be confirmed
 *   (the colour must stay).
 * removable: 0 Restate holds no deployment at the colour's address; 4 it holds one.
 * finish-drains --require-drained C: 3 when colour C, or the old single `worker` (whose outbox has
 *   no colour gate), is still registered: invocations pinned to it, a service routed to it, or a
 *   delete that failed. The reasons are printed.
 */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out || ((line: string) => console.log(line));
  const err = deps.err || ((line: string) => console.error(line));
  const env = deps.env || process.env;
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) flags.set(rest[i].slice(2), rest[++i] ?? '');
    else positional.push(rest[i]);
  }
  const container = flags.get('via-container');
  const fetcher = deps.fetcher || (container ? containerFetch(container) : fetch);
  const admin = new RestateAdmin(flags.get('admin') || env.RESTATE_ADMIN_URL || 'http://restate:9070', fetcher);
  const addresses = addressesFromEnv(env);
  const colourArg = (value: string | undefined): Colour | null => (value === 'blue' || value === 'green' ? value : null);
  const seconds = (name: string, fallback: number) => {
    const n = Number(flags.get(name));
    return flags.has(name) && Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  try {
    if (command === 'plan') {
      const plan = planDeploy(await readTopology(admin, addresses));
      out(`live=${plan.live ?? 'none'}`);
      out(`live_deployment=${plan.liveDeploymentId ?? ''}`);
      out(`idle=${plan.idle}`);
      // The old single `worker` runs its outbox with no colour gate for as long as its drain lasts, and
      // a paused or retrying invocation pinned to it never finishes on its own: deploy.sh refuses the
      // first blue/green deploy until there are none, rather than leave two consumers running.
      let stuck = '';
      if (plan.live === 'legacy' && plan.liveDeploymentId) {
        try { stuck = String(await admin.stuck(plan.liveDeploymentId)); } catch { stuck = 'unknown'; }
      }
      out(`live_stuck=${stuck}`);
      return 0;
    }
    if (command === 'register') {
      const colour = colourArg(positional[0]);
      if (!colour) { err('usage: register blue|green'); return 64; }
      const outcome = await registerColour(admin, colour, {
        attempts: seconds('attempts', 30), intervalMs: seconds('interval-seconds', 2) * 1000, sleep: deps.sleep, now: deps.now, addresses,
      });
      if (!outcome.ok && outcome.state === 'refused') {
        err(`ERROR: Restate refused to register the ${colour} colour (${addresses[colour]}): ${outcome.reason}. Restate holds nothing new at that address, so what it routes was not changed.`);
        return 2;
      }
      if (!outcome.ok) {
        err(`ERROR: Restate registered the ${colour} colour (${addresses[colour]}) but the switch is not complete: ${outcome.reason}. Restate may already send work to ${colour}, so it must keep running.`);
        if (outcome.deploymentId) out(`deployment=${outcome.deploymentId}`);
        return 4;
      }
      out(`deployment=${outcome.deploymentId}`);
      return 0;
    }
    if (command === 'removable') {
      const colour = colourArg(positional[0]);
      if (!colour) { err('usage: removable blue|green'); return 64; }
      const held = (await admin.deployments()).find((d) => normaliseUri(d.uri) === normaliseUri(addresses[colour]));
      if (!held) { out('registered='); return 0; }
      out(`registered=${held.id}`);
      let serves = 'unknown';
      try { serves = (await admin.services()).filter((x) => x.deploymentId === held.id).map((x) => x.name).join(',') || 'none'; } catch { /* reported as unknown */ }
      out(`serves=${serves}`);
      return 4;
    }
    if (command === 'finish-drains') {
      const required = flags.has('require-drained') ? colourArg(flags.get('require-drained')) : null;
      if (flags.has('require-drained') && !required) { err('usage: --require-drained blue|green'); return 64; }
      const report = await finishDrains(admin, {
        waitMs: seconds('wait-seconds', 900) * 1000, intervalMs: seconds('interval-seconds', 10) * 1000,
        sleep: deps.sleep, now: deps.now, addresses, log: (line) => err(`  ${line}`),
      });
      for (const d of report.deleted) out(`deleted=${d.slot}`);
      for (const d of report.draining) out(`draining=${d.slot}:${d.inFlight ?? 'unknown'}`);
      for (const d of report.kept) out(`kept=${d.slot}:${d.reason}`);
      if (!required) return 0;
      const blocking = [...report.draining, ...report.kept].filter((d) => d.slot === required || d.slot === 'legacy');
      return blocking.length ? 3 : 0;
    }
    err('usage: restate-bluegreen.ts plan | register blue|green | removable blue|green | finish-drains [--wait-seconds N] [--require-drained blue|green]  [--via-container NAME] [--admin URL]');
    return 64;
  } catch (e) {
    err(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
