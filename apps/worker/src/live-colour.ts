/**
 * Which worker colour runs the background loops (architecture programme 0.1, ADR-034).
 *
 * Deploys are blue/green: the new colour is registered with Restate at its own address while the old
 * one finishes the invocations pinned to it, so for minutes (or until the next deploy) two workers
 * run. Restate handlers are safe with that; the outbox consumer is not. Its SKIP LOCKED lease keeps
 * a claim exclusive for 60 s only, so a batch that outlives its lease is leased again by the other
 * colour and a Telegram delivery goes out twice; and the old colour would run the old handlers on
 * commands the new Core writes. So the consumer runs in one colour only: the live one.
 *
 * The live colour is not written down anywhere of our own: it is the deployment Restate sends new
 * TaskWorkflow invocations to (GET /services/TaskWorkflow names it). That is the fact a deploy
 * changes when it registers the new colour, so the two can never disagree, and a deploy that stops
 * between steps leaves nothing to reconcile.
 */
import { log } from './logging.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Restate reports `http://worker-blue:9080/` for a deployment registered as `http://worker-blue:9080`. */
export function normaliseWorkerUri(uri: string): string {
  try {
    const url = new URL(uri);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return uri.replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * The address of the deployment that serves `serviceName` (TaskWorkflow unless named) now, or null
 * when none does. Throws when Restate does not answer.
 */
export async function liveWorkerUri(adminUrl: string, fetcher: FetchLike, timeoutMs = 2000, serviceName = 'TaskWorkflow'): Promise<string | null> {
  const service = await fetcher(`${adminUrl}/services/${encodeURIComponent(serviceName)}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (service.status === 404) return null;
  if (!service.ok) throw new Error(`Restate answered ${service.status} for ${serviceName}`);
  const deploymentId = ((await service.json()) as { deployment_id?: string }).deployment_id;
  if (!deploymentId) return null;
  const deployment = await fetcher(`${adminUrl}/deployments/${encodeURIComponent(deploymentId)}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!deployment.ok) throw new Error(`Restate answered ${deployment.status} for deployment ${deploymentId}`);
  const uri = ((await deployment.json()) as { uri?: string }).uri;
  return uri ? normaliseWorkerUri(uri) : null;
}

export type GateState = 'unknown' | 'standby' | 'taking_over' | 'live';

export interface LiveColourGateOptions {
  adminUrl: string;
  /** This worker's own address as Restate knows it, e.g. http://worker-blue:9080. */
  selfUri: string;
  fetcher?: FetchLike;
  /** How long an answer from Restate is used before asking again. */
  refreshMs?: number;
  /**
   * How long this colour must have been the live one before its loops start. The old colour stops
   * leasing within one refresh of the switch, and a batch it had already leased runs out within one
   * lease (60 s), so waiting both out keeps the two consumers from ever holding the same command.
   * Skipped when Restate holds no deployment but this one: then no other worker is left to wait for,
   * and a restart of the live colour does not stop the outbox for a minute.
   */
  takeoverMs?: number;
  timeoutMs?: number;
  now?: () => number;
  /**
   * The service whose deployment decides the live colour. TaskWorkflow for the outbox; the Telegram
   * poller (Phase 2.1) asks for ChatInbox, the service it hands updates to: a colour whose build is
   * not the one Restate sends ChatInbox work to must not poll, and one that hosts no ChatInbox at all
   * (a build from before 2.1) never does.
   */
  service?: string;
}

export class LiveColourGate {
  private readonly selfUri: string;
  private checkedAt = -Infinity;
  private liveSince: number | null = null;
  private known: boolean | null = null;
  private pending: Promise<void> | null = null;

  constructor(private readonly options: LiveColourGateOptions) {
    this.selfUri = normaliseWorkerUri(options.selfUri);
  }

  private get now() { return (this.options.now || Date.now)(); }

  private async refresh(): Promise<void> {
    try {
      const live = await liveWorkerUri(this.options.adminUrl, this.options.fetcher || fetch, this.options.timeoutMs ?? 2000, this.options.service);
      const isSelf = live === this.selfUri;
      if (isSelf && this.liveSince === null) {
        this.liveSince = (await this.alone()) ? this.now - (this.options.takeoverMs ?? 70_000) : this.now;
      }
      if (!isSelf) this.liveSince = null;
      this.known = isSelf;
    } catch {
      // Restate did not answer: keep the last answer. A live colour keeps delivering through a Restate
      // restart; a worker that has never heard from Restate stays still rather than guess.
    }
    this.checkedAt = this.now;
  }

  /**
   * Whether Restate holds no deployment but this worker's. A deploy deletes the old colour's
   * deployment only after it has drained, and stops its container straight after, so then no other
   * worker is left. Anything uncertain is "not alone", which keeps the takeover delay.
   */
  private async alone(): Promise<boolean> {
    if ((this.options.takeoverMs ?? 70_000) <= 0) return true;
    try {
      const res = await (this.options.fetcher || fetch)(`${this.options.adminUrl}/deployments`, { signal: AbortSignal.timeout(this.options.timeoutMs ?? 2000) });
      if (!res.ok) return false;
      const deployments = ((await res.json()) as { deployments?: Array<{ uri?: string }> }).deployments;
      return Array.isArray(deployments) && deployments.length > 0
        && deployments.every((d) => typeof d.uri === 'string' && normaliseWorkerUri(d.uri) === this.selfUri);
    } catch {
      return false;
    }
  }

  /** Whether this worker's background loops may run now. Asks Restate at most once per refresh interval. */
  async isLive(): Promise<boolean> {
    if (this.now - this.checkedAt >= (this.options.refreshMs ?? 10_000)) {
      this.pending ??= this.refresh().finally(() => { this.pending = null; });
      await this.pending;
    }
    return this.state() === 'live';
  }

  state(): GateState {
    if (this.known === null) return 'unknown';
    if (!this.known || this.liveSince === null) return 'standby';
    return this.now - this.liveSince >= (this.options.takeoverMs ?? 70_000) ? 'live' : 'taking_over';
  }
}

export interface LoopHandle { stop: () => void }

/**
 * Runs `tick` (one outbox batch) on every turn while the gate says this colour is live. One batch at a
 * time: the next turn is scheduled only after the previous one has finished. The gate is asked before
 * every batch, so a colour that stops being live finishes the batch in hand and leases nothing more.
 */
export function runWhileLive(options: {
  gate: Pick<LiveColourGate, 'isLive'>;
  tick: () => Promise<{ leased?: number; succeeded?: number; retried?: number; deadLettered?: number } | unknown>;
  intervalMs: number;
  onError?: (error: unknown) => void;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}): LoopHandle {
  const schedule = options.schedule || ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = options.cancel || ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let running = true;
  let handle: unknown = null;
  const turn = async () => {
    if (!running) return;
    try {
      if (await options.gate.isLive()) {
        const res = (await options.tick()) as { leased?: number; succeeded?: number; retried?: number; deadLettered?: number } | undefined;
        if (res && typeof res.leased === 'number' && res.leased > 0) {
          log.info(`[OutboxConsumer] Batch completed: ${res.succeeded ?? 0}/${res.leased} succeeded, ${res.retried ?? 0} retried, ${res.deadLettered ?? 0} dead-lettered`);
        }
      }
    } catch (error) {
      (options.onError || ((e) => log.error('[OutboxConsumer] Error during poll cycle:', e)))(error);
    } finally {
      if (running) handle = schedule(turn, options.intervalMs);
    }
  };
  handle = schedule(turn, 0);
  return {
    stop: () => {
      running = false;
      if (handle !== null) cancel(handle);
    },
  };
}

export type BackgroundLoopMode =
  | { mode: 'always' }
  | { mode: 'live-colour'; selfUri: string; adminUrl: string; takeoverMs: number; refreshMs: number }
  | { mode: 'misconfigured'; reason: string };

/**
 * A worker without HAWA_WORKER_SELF_URI (development, tests, a single worker) runs its loops as it
 * always has. A colour of the blue/green pair names its own address and gates them on Restate.
 */
export function backgroundLoopsFromEnv(env: NodeJS.ProcessEnv = process.env): BackgroundLoopMode {
  const selfUri = env.HAWA_WORKER_SELF_URI?.trim();
  if (!selfUri) return { mode: 'always' };
  let adminUrl = env.RESTATE_ADMIN_URL?.trim().replace(/\/+$/, '');
  if (!adminUrl && env.RESTATE_INGRESS_URL) {
    try {
      const url = new URL(env.RESTATE_INGRESS_URL);
      url.port = '9070';
      adminUrl = url.origin;
    } catch {
      adminUrl = undefined;
    }
  }
  if (!adminUrl) return { mode: 'misconfigured', reason: 'HAWA_WORKER_SELF_URI is set but neither RESTATE_ADMIN_URL nor RESTATE_INGRESS_URL says where Restate is' };
  const takeoverMs = env.HAWA_WORKER_TAKEOVER_MS ? Number(env.HAWA_WORKER_TAKEOVER_MS) : NaN;
  const refreshMs = env.HAWA_WORKER_LIVE_REFRESH_MS ? Number(env.HAWA_WORKER_LIVE_REFRESH_MS) : NaN;
  return {
    mode: 'live-colour',
    selfUri,
    adminUrl,
    takeoverMs: Number.isFinite(takeoverMs) && takeoverMs >= 0 ? takeoverMs : 70_000,
    refreshMs: Number.isFinite(refreshMs) && refreshMs > 0 ? refreshMs : 10_000,
  };
}
