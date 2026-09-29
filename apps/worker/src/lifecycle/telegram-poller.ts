/**
 * The Telegram poller, in the worker (architecture programme Phase 2.1, ADR-034, PHASE2_DESIGN.md
 * section 2.2).
 *
 * Core polled Telegram and handled one update at a time for every chat, so a 20 MB file in one chat
 * held every other chat for as long as its download took (chaos scenario R4: 30.9 s). Now the poller
 * only hands updates on: each goes to the ChatInbox Virtual Object of its chat, through Restate's
 * ingress, with idempotency key `tg-<update_id>`. Restate runs one update at a time per chat and
 * chats side by side, and the same update sent twice is one invocation.
 *
 * The offset moves past an update only after Restate has accepted it, and is stored in Postgres (the
 * row Core's poller used, packages/db telegram-poll-state.ts), so switching HAWA_TELEGRAM_POLLER back
 * to `core` carries on from the same place. An update Restate did not accept stops the batch: it is
 * asked for again on the next poll and nothing behind it goes first. If the offset could not be stored
 * the update is asked for and sent again, and Restate answers with the first invocation.
 *
 * The office's kill switch is read from Postgres (the channel's own `office-kill-switch` row) before
 * every poll and between updates, at most every few seconds. While it is thrown, or cannot be read,
 * Telegram is asked for nothing: it keeps the updates until intake is switched back on.
 *
 * Only the live colour polls (runPoller with a LiveColourGate on ChatInbox; index.ts).
 */
import { chaosPoint } from '@hawa/observability';
import { log as workerLog } from '../logging.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The parts of a Telegram update the poller reads. */
export interface TelegramUpdateLike {
  update_id: number;
  [kind: string]: unknown;
}

export interface PollerOffsets {
  /** The last update id handed on, 0 when none. Throws when it cannot be read. */
  getOffset(): Promise<number>;
  /** Moves the stored offset forward to `updateId` (never back). Throws when it could not be stored. */
  setOffset(updateId: number): Promise<void>;
}

export interface TelegramPollerOptions {
  botToken: string;
  /** Restate's ingress, e.g. http://restate:8080. */
  ingressUrl: string;
  offsets: PollerOffsets;
  /** Whether the office has switched Telegram intake off. Throws when that cannot be known. */
  killSwitch: () => Promise<boolean>;
  fetch?: FetchLike;
  /** getUpdates' long-poll timeout, in seconds. */
  longPollSeconds?: number;
  /** How long one answer of `killSwitch` is used. */
  killSwitchCacheMs?: number;
  now?: () => number;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
  /**
   * ADR-143: the settles Core finds overdue (albums saved before settles existed, or whose delayed call
   * was lost). Each is sent to its chat's ChatInbox `settle` handler, at start and every `everyMs`.
   */
  settleSweep?: { overdue(): Promise<Array<{ chatId: string; update: TelegramUpdateLike }>>; everyMs?: number };
}

export interface PollResult {
  /** Updates Telegram returned. */
  polled: number;
  /** Updates Restate accepted and the offset moved past. */
  enqueued: number;
  paused?: 'kill_switch' | 'kill_switch_unknown';
  /** Why this poll stopped early; the loop backs off. */
  error?: string;
  /** Telegram asked for this pause (429 retry_after). */
  retryAfterMs?: number;
}

interface ChatCarrier { chat?: { id?: number | string } }

/**
 * The ChatInbox key of an update: its chat (message, edited message, channel post, or the message a
 * button sits under), else the sender, else `misc`. The same reading as polled-update-dispatch.ts's
 * updateOrigin, so an update and its dead letter name the same chat.
 */
export function chatKey(update: TelegramUpdateLike): string {
  const u = update as TelegramUpdateLike & {
    message?: ChatCarrier; edited_message?: ChatCarrier; channel_post?: ChatCarrier;
    callback_query?: { from?: { id?: number | string }; message?: ChatCarrier };
  };
  const body = u.message || u.edited_message || u.channel_post || u.callback_query?.message;
  const id = body?.chat?.id ?? u.callback_query?.from?.id ?? (u.message as { from?: { id?: number } } | undefined)?.from?.id;
  return id === undefined || id === null || String(id) === '' ? 'misc' : String(id);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class TelegramPoller {
  private offset = 0;
  private killSwitchAt = -Infinity;
  private killSwitchValue: boolean | null = null;
  private lastPollAt?: string;
  private lastError?: string;
  /** The end of the last cycle that worked: updates read and handed on, or intake switched off on purpose. */
  private lastOkAt?: string;
  private firstPollAt?: string;
  private handedOn = 0;
  private lastSweepAt = -Infinity;

  constructor(private readonly options: TelegramPollerOptions) {}

  /**
   * Sends each overdue settle to its chat (ADR-143). Best effort: a failure is logged and the next
   * sweep asks again; the settle itself decides whether anything is left to do, so a second send of
   * the same settle (same idempotency key, or a later sweep) starts nothing twice.
   */
  async sweepSettles(): Promise<number> {
    const sweep = this.options.settleSweep;
    if (!sweep || this.now - this.lastSweepAt < (sweep.everyMs ?? 5 * 60_000)) return 0;
    this.lastSweepAt = this.now;
    let due: Array<{ chatId: string; update: TelegramUpdateLike }>;
    try {
      due = await sweep.overdue();
    } catch (err) {
      this.log.warn(`[telegram:poller] overdue settles could not be listed: ${errorText(err)}`);
      return 0;
    }
    let sent = 0;
    for (const item of due) {
      const key = `settle-sweep:${item.update.update_id}`;
      const url = `${this.options.ingressUrl.replace(/\/+$/, '')}/ChatInbox/${encodeURIComponent(chatKey(item.update))}/settle/send`;
      try {
        const res = await this.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key, 'x-request-id': key },
          body: JSON.stringify({ v: 1, update: item.update, attempt: 0 }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) sent++;
        else this.log.warn(`[telegram:poller] Restate did not accept the overdue settle of update ${item.update.update_id}: HTTP ${res.status}`);
      } catch (err) {
        this.log.warn(`[telegram:poller] Restate did not accept the overdue settle of update ${item.update.update_id}: ${errorText(err)}`);
      }
    }
    if (due.length) this.log.info(`[telegram:poller] sent ${sent} of ${due.length} overdue settle(s)`);
    return sent;
  }

  private get log() { return this.options.log ?? workerLog; }
  private get fetch(): FetchLike { return this.options.fetch ?? fetch; }
  private get now() { return (this.options.now ?? Date.now)(); }

  /** The kill switch, asked at most every `killSwitchCacheMs`. Throws when Postgres did not answer. */
  private async intakeOff(): Promise<boolean> {
    const cacheMs = this.options.killSwitchCacheMs ?? 5000;
    if (this.killSwitchValue !== null && this.now - this.killSwitchAt < cacheMs) return this.killSwitchValue;
    try {
      this.killSwitchValue = await this.options.killSwitch();
      this.killSwitchAt = this.now;
      return this.killSwitchValue;
    } catch (err) {
      // Unknown is not "on": the office may have switched intake off, so nothing is read until it is known.
      this.killSwitchValue = null;
      throw err;
    }
  }

  /** One getUpdates and the hand-off of what it returned, in order. Never throws. */
  async pollOnce(signal?: AbortSignal): Promise<PollResult> {
    const result: PollResult = { polled: 0, enqueued: 0 };
    this.firstPollAt ??= new Date(this.now).toISOString();
    try {
      if (await this.intakeOff()) {
        this.lastOkAt = new Date(this.now).toISOString();
        return { ...result, paused: 'kill_switch' };
      }
    } catch (err) {
      this.lastError = `kill switch unreadable: ${errorText(err)}`;
      return { ...result, paused: 'kill_switch_unknown' };
    }
    await this.sweepSettles();
    try {
      this.offset = Math.max(this.offset, await this.options.offsets.getOffset());
    } catch (err) {
      // Without the stored offset Telegram would hand back updates already handed on.
      return this.fail(result, `TELEGRAM_OFFSET_UNAVAILABLE: the stored offset could not be read (${errorText(err)})`);
    }

    const longPoll = this.options.longPollSeconds ?? 25;
    this.lastPollAt = new Date(this.now).toISOString();
    let updates: TelegramUpdateLike[];
    try {
      const url = `https://api.telegram.org/bot${this.options.botToken}/getUpdates?offset=${this.offset + 1}&timeout=${longPoll}`;
      const timeout = AbortSignal.timeout((longPoll + 10) * 1000);
      const res = await this.fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } };
      if (res.status === 429) {
        const seconds = Number(body.parameters?.retry_after);
        this.lastError = 'TELEGRAM_RATE_LIMITED';
        return { ...result, retryAfterMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000 };
      }
      if (!res.ok || !body.ok || !Array.isArray(body.result)) {
        return this.fail(result, `getUpdates answered HTTP ${res.status}${body.description ? `: ${body.description}` : ''}`);
      }
      updates = (body.result as TelegramUpdateLike[]).filter((u) => Number.isSafeInteger(u?.update_id) && u.update_id > this.offset);
    } catch (err) {
      return this.fail(result, `getUpdates failed: ${errorText(err)}`);
    }
    result.polled = updates.length;
    if (updates.length) await chaosPoint('worker.poller.after-getupdates', { n: updates.length, first: updates[0].update_id, chats: updates.map(chatKey).join(',') });

    for (const update of updates) {
      if (signal?.aborted) return result;
      // The switch can be thrown while a batch is being handed on: the rest waits in Telegram.
      try {
        if (await this.intakeOff()) return { ...result, paused: 'kill_switch' };
      } catch {
        return { ...result, paused: 'kill_switch_unknown' };
      }
      const accepted = await this.enqueue(update);
      if (accepted !== true) return this.fail(result, accepted);
      await chaosPoint('worker.poller.after-enqueue', { updateId: update.update_id, chat: chatKey(update) });
      try {
        await this.options.offsets.setOffset(update.update_id);
      } catch (err) {
        // Not advanced in memory either: the update is asked for and sent again, and Restate answers
        // with the invocation it already has (same idempotency key). Skipping it would not be safe.
        return this.fail(result, `TELEGRAM_OFFSET_NOT_SAVED: update ${update.update_id} was handed on but the offset could not be stored (${errorText(err)})`);
      }
      this.offset = Math.max(this.offset, update.update_id);
      result.enqueued++;
      this.handedOn++;
    }
    this.lastError = undefined;
    this.lastOkAt = new Date(this.now).toISOString();
    return result;
  }

  /** Sends the update to its chat's ChatInbox. True when Restate accepted it, else why not. */
  private async enqueue(update: TelegramUpdateLike): Promise<true | string> {
    const key = `tg-${update.update_id}`;
    const url = `${this.options.ingressUrl.replace(/\/+$/, '')}/ChatInbox/${encodeURIComponent(chatKey(update))}/handleUpdate/send`;
    try {
      const res = await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key, 'x-request-id': key },
        body: JSON.stringify({ v: 1, update, polledAt: this.now }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return true;
      return `Restate did not accept update ${update.update_id}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`;
    } catch (err) {
      return `Restate did not accept update ${update.update_id}: ${errorText(err)}`;
    }
  }

  private fail(result: PollResult, error: string): PollResult {
    this.lastError = error;
    this.log.warn(`[telegram:poller] ${error}`);
    return { ...result, error };
  }

  status() {
    return {
      offset: this.offset, handedOn: this.handedOn, lastPollAt: this.lastPollAt ?? null, lastError: this.lastError ?? null,
      lastOkAt: this.lastOkAt ?? null, firstPollAt: this.firstPollAt ?? null,
    };
  }
}

export type PollerStatus = ReturnType<TelegramPoller['status']>;

/** A live poller with no working cycle for this long is reported; getUpdates itself waits 25 s at most. */
export const POLLER_STALE_MS = 5 * 60_000;

/**
 * Why a poller that should be reading Telegram is not, for the worker's /health; null when nothing is
 * wrong (ADR-129, Phase 4 operations finding 3). Only the colour that polls ('live', or 'always'
 * without blue/green) is judged: a standby or taking-over colour is not meant to poll yet.
 */
export function pollerProblem(input: {
  mode: PollerConfig['mode']; started: boolean; background: string; status: PollerStatus | null; now: number; staleMs?: number;
}): string | null {
  if (input.mode !== 'on') return null;
  if (!input.started) return 'the Telegram poller did not start (no database, or the outbox is misconfigured)';
  if (input.background !== 'live' && input.background !== 'always') return null;
  const s = input.status;
  if (!s) return null;
  if (s.lastError && /^getUpdates answered HTTP (401|404)\b/.test(s.lastError)) return `Telegram refuses the bot token: ${s.lastError}`;
  const since = s.lastOkAt ?? s.firstPollAt;
  if (!since) return null;
  const staleMs = input.staleMs ?? POLLER_STALE_MS;
  if (input.now - Date.parse(since) <= staleMs) return null;
  return `no successful poll for over ${Math.round(staleMs / 60_000)} minutes${s.lastError ? `: ${s.lastError}` : ''}`;
}

export interface PollerLoopHandle {
  stop(): void;
  /** Settles when the loop has stopped. */
  done: Promise<void>;
}

/**
 * Polls while `gate` says this colour is live, one poll at a time. After a poll that handed on its
 * updates the next starts at once (getUpdates itself waits for new ones); after an error it backs off
 * 2, 4, 8, 16, then 30 s; Telegram's retry_after is honoured; a thrown or unknown kill switch is asked
 * again every 5 s; a colour that is not live asks the gate again every 2 s.
 */
export function runPoller(
  poller: Pick<TelegramPoller, 'pollOnce'>,
  options: { gate: { isLive(): Promise<boolean> }; sleep?: (ms: number) => Promise<void>; log?: Pick<Console, 'error'> }
): PollerLoopHandle {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const abort = new AbortController();
  let running = true;
  let errors = 0;
  const loop = async () => {
    while (running) {
      let wait = 2000;
      try {
        if (await options.gate.isLive()) {
          const r = await poller.pollOnce(abort.signal);
          if (r.retryAfterMs) wait = r.retryAfterMs;
          else if (r.error) wait = Math.min(30_000, 1000 * 2 ** Math.min(5, ++errors));
          else if (r.paused) wait = 5000;
          else wait = 0;
          if (!r.error) errors = 0;
        }
      } catch (err) {
        (options.log ?? workerLog).error('[telegram:poller] poll failed:', err);
        wait = Math.min(30_000, 1000 * 2 ** Math.min(5, ++errors));
      }
      if (!running) break;
      await sleep(wait);
    }
  };
  const done = loop();
  return {
    stop: () => {
      running = false;
      abort.abort();
    },
    done,
  };
}

export type PollerConfig =
  | { mode: 'off' }
  | { mode: 'misconfigured'; reason: string }
  | { mode: 'on'; botToken: string; ingressUrl: string; takeoverMs: number };

/**
 * Whether this worker polls Telegram. Only with HAWA_TELEGRAM_POLLER=worker (Core polls by default,
 * and both read the same value from compose). It then needs the bot token, Restate's ingress, a
 * database (the offset and the kill switch) and HAWA_WORKER_TOKEN, the credential ChatInbox calls
 * Core's intake with; without any of them it refuses to start rather than take updates it cannot
 * hand to intake.
 */
export function pollerConfigFromEnv(env: Record<string, string | undefined> = process.env): PollerConfig {
  if ((env.HAWA_TELEGRAM_POLLER || '').trim().toLowerCase() !== 'worker') return { mode: 'off' };
  const missing = ['HAWA_WORKER_TOKEN', 'TELEGRAM_BOT_TOKEN', 'RESTATE_INGRESS_URL', 'DATABASE_URL'].filter((k) => !env[k]?.trim());
  if (missing.length) {
    return { mode: 'misconfigured', reason: `HAWA_TELEGRAM_POLLER=worker but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set; the Telegram poller is not started` };
  }
  const takeover = env.HAWA_POLLER_TAKEOVER_MS ? Number(env.HAWA_POLLER_TAKEOVER_MS) : NaN;
  return {
    mode: 'on',
    botToken: env.TELEGRAM_BOT_TOKEN!.trim(),
    ingressUrl: env.RESTATE_INGRESS_URL!.trim().replace(/\/+$/, ''),
    // Long enough for the old colour's last getUpdates (25 s) to end; a second poller would only
    // make Telegram refuse one of the two (409), and anything both handed on is one invocation.
    takeoverMs: Number.isFinite(takeover) && takeover >= 0 ? takeover : 30_000,
  };
}
