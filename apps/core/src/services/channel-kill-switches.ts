/**
 * The office's intake kill switches, one for Telegram and one for WhatsApp (WAHA), kept in Postgres
 * (architecture programme 1.3, G8; PHASE2_DESIGN.md slice 2.1).
 *
 * They lived only in Core's memory. A restart, a deploy included, switched intake back on: the office
 * stopped Telegram because something was wrong, Core restarted, and the poller read the chats again.
 *
 * No new table. Each channel has a row in `hawa.integrations` (kind `telegram` or `waha`, name
 * `office-kill-switch`) and the switch is that row's `hawa.integration_health.state`: `disabled`
 * while it is thrown. It is not the bot's own row (`bot-<id>`, telegram-poll-state.ts): the poller
 * sets that row's state to `healthy` on every update it accepts, which would release a thrown
 * switch, and WhatsApp has no such row. The row also records who threw it and when, in
 * `detail.killSwitch`.
 *
 * Reading stays synchronous, because the health report, the webhook and the poller's pause check read
 * `ctx.channelKillSwitches.telegram` as a plain value. That object is this process's copy of the
 * rows: loaded when the app is built, re-read at most every few seconds when a switch is read (so a
 * switch thrown by another process is seen), and written through when a route assigns a channel.
 *
 * A channel assigned in this process but not yet saved is this process's to decide: a re-read of
 * Postgres leaves it alone, and the write is tried again until it lands. Otherwise a switch the office
 * threw, which the route had already answered as thrown, was released by the next re-read whenever
 * its one background write failed.
 */
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import crypto from 'node:crypto';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { log } from '../logging.js';

export type KillSwitchChannel = 'telegram' | 'waha';
export type ChannelKillSwitches = Record<KillSwitchChannel, boolean>;

export class KillSwitchRevisionConflict extends Error {
  constructor() { super('The channel switch changed after this action read it'); }
}

export const KILL_SWITCH_CHANNELS: readonly KillSwitchChannel[] = ['telegram', 'waha'];

/**
 * Who may throw or release each switch, on every route that changes one (ADR-128). WhatsApp is the
 * administrator's, as POST /waha/kill-switch always was: an art director or operator used to release
 * it through the ingress toggle or /operations/kill-switch. Telegram is the office's: the Desk, and the
 * nightly Restate backup (infra/backup/restate_nightly.py, ADR-054), which pauses it with the art
 * director's key, or the bearer key, and releases it with the pause's changeTag.
 */
const KILL_SWITCH_ROLES: Record<KillSwitchChannel, readonly string[]> = {
  telegram: ['operator', 'administrator', 'art_director'],
  waha: ['administrator'],
};

export function mayChangeKillSwitch(channel: KillSwitchChannel, role: string | undefined): boolean {
  return KILL_SWITCH_ROLES[channel].includes(role ?? '');
}

/** The `hawa.integrations` name of each channel's switch row. */
export const KILL_SWITCH_ROW_NAME = 'office-kill-switch';
/** How old this process's copy may be before a read asks Postgres again. */
const REFRESH_AFTER_MS = 5_000;
/** How long to wait before trying again when the first read of Postgres, or a switch's save, failed. */
const RETRY_MS = 5_000;
/** How long a status report or the WhatsApp webhook waits for the first read before answering without it. */
const FIRST_READ_WAIT_MS = 2_000;
/** A repeated failure is logged at most this often (the first one always). */
const LOG_REPEAT_MS = 60_000;

export interface ChannelKillSwitchStore {
  /**
   * The object on the route context. Reading a channel gives this process's copy; assigning one
   * changes the copy at once and writes it to Postgres in the background, trying again until the
   * write lands; until then Postgres does not overwrite it. Routes that can wait use `set` instead,
   * which answers only once Postgres has it.
   */
  readonly switches: ChannelKillSwitches;
  /** Resolves once Postgres has been read (at once without a database). It never rejects. */
  readonly loaded: Promise<void>;
  isLoaded(): boolean;
  isUnsaved(channel: KillSwitchChannel): boolean;
  /** Throws (`active`) or releases a switch: Postgres first, then this process. Rejects if Postgres refused it. */
  set(channel: KillSwitchChannel, active: boolean, actorId?: string): Promise<string | undefined>;
  /** Reads Postgres again now (after every write this process has started). */
  refresh(): Promise<void>;
}

// Every write this process has started, in order. A read waits for them, in any app built in the
// process: an app built right after another one threw a switch must not read Postgres before that
// write lands and so miss it. This orders writes; it holds no switch.
let processWrites: Promise<unknown> = Promise.resolve();
const afterProcessWrites = () => processWrites.then(() => undefined);

const stores = new WeakMap<object, ChannelKillSwitchStore>();

/** The store behind `ctx.channelKillSwitches`, so a route can wait for Postgres (undefined for a plain object). */
export function killSwitchStoreOf(switches: object): ChannelKillSwitchStore | undefined {
  return stores.get(switches);
}

/**
 * Throws or releases a channel's switch through its store when it has one, answering once Postgres
 * has it; a plain object (a hand-built context) is just assigned.
 */
export async function setKillSwitch(switches: ChannelKillSwitches, channel: KillSwitchChannel, active: boolean, actorId?: string): Promise<string | undefined> {
  const store = killSwitchStoreOf(switches);
  if (store) return store.set(channel, active, actorId);
  switches[channel] = active;
  return undefined;
}

/** Conditional release under the same PostgreSQL row lock used by ordinary switch writes. */
export async function compareAndSetKillSwitch(
  db: Kysely<Database>, switches: ChannelKillSwitches, channel: KillSwitchChannel,
  active: boolean, expectedChangeTag: string, actorId: string,
  scope: { tenantId: string; userId: string } = { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID },
): Promise<string> {
  const changeTag = crypto.randomUUID();
  const detail = JSON.stringify({ killSwitch: { active, changedAt: new Date().toISOString(), changedBy: actorId, changeTag } });
  const write = processWrites.then(() => {
    if (killSwitchStoreOf(switches)?.isUnsaved(channel)) {
      throw new Error('The channel switch has an unsaved local operator decision');
    }
    return withRlsContext(db, { ...scope, role: 'operator' }, async (trx) =>
    (await sql<{ integration_id: string }>`UPDATE hawa.integration_health h
      SET state = ${active ? 'disabled' : 'unknown'}::hawa.integration_health_state,
          detail = h.detail || ${detail}::jsonb, last_checked_at = now(), updated_at = now()
      FROM hawa.integrations i
      WHERE h.integration_id = i.id AND i.tenant_id = ${scope.tenantId}::uuid
        AND i.kind = ${channel} AND i.name = ${KILL_SWITCH_ROW_NAME}
        AND h.detail #>> '{killSwitch,changeTag}' = ${expectedChangeTag}
      RETURNING h.integration_id`.execute(trx)).rows);
  });
  processWrites = write.catch(() => undefined);
  const rows = await write;
  if (rows.length !== 1) throw new KillSwitchRevisionConflict();
  await refreshKillSwitches(switches);
  await refreshKillSwitches(switches); // the first refresh may have begun before the conditional write
  return changeTag;
}

const within = <T>(work: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms).unref?.()),
  ]);

/**
 * Reads Postgres again when the object has a store (a status report should not answer from a stale
 * copy). Rejects when Postgres does not answer within `waitMs`, so the caller can answer from the copy.
 */
export async function refreshKillSwitches(switches: ChannelKillSwitches, waitMs = FIRST_READ_WAIT_MS): Promise<void> {
  const store = killSwitchStoreOf(switches);
  if (!store) return;
  await within(store.refresh(), waitMs, 'reading the kill switches');
}

/**
 * Whether intake on a channel must be refused. Until this process has read the switches from Postgres
 * it cannot know whether the office threw one, so it waits for that read a little and refuses when
 * it has still not succeeded (the Telegram poller stays paused for the same reason).
 */
export async function intakeRefused(switches: ChannelKillSwitches, channel: KillSwitchChannel, waitMs = FIRST_READ_WAIT_MS): Promise<boolean> {
  const store = killSwitchStoreOf(switches);
  if (store && !store.isLoaded()) {
    await within(store.loaded, waitMs, 'the first read of the kill switches').catch(() => undefined);
    if (!store.isLoaded()) return true;
  }
  return switches[channel];
}

export function createChannelKillSwitchStore(
  db: Kysely<Database> | null | undefined,
  scope: { tenantId: string; userId: string } = { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID },
  timing: { refreshAfterMs?: number; retryMs?: number } = {}
): ChannelKillSwitchStore {
  const refreshAfterMs = timing.refreshAfterMs ?? REFRESH_AFTER_MS;
  const retryMs = timing.retryMs ?? RETRY_MS;
  const copy: ChannelKillSwitches = { telegram: false, waha: false };
  // What this process last asked Postgres to hold for each channel. Every write saves the latest
  // value when it runs, so a retry of an older assignment cannot land after a newer one.
  const wanted: ChannelKillSwitches = { telegram: false, waha: false };
  // Channels assigned in this process whose value Postgres does not have yet: a re-read leaves them alone.
  const unsaved: Record<KillSwitchChannel, boolean> = { telegram: false, waha: false };
  const saving: Record<KillSwitchChannel, boolean> = { telegram: false, waha: false };
  // Bumped by every local change to a channel: a read of Postgres that began before one does not undo it.
  const version: Record<KillSwitchChannel, number> = { telegram: 0, waha: 0 };
  let loaded = !db;
  let readAt = 0;
  let reading: Promise<void> | null = null;
  const lastLogged: Record<string, number> = {};
  const logRepeated = (key: string, level: 'warn' | 'error', message: string, err: unknown) => {
    const now = Date.now();
    if (lastLogged[key] && now - lastLogged[key] < LOG_REPEAT_MS) return;
    lastLogged[key] = now;
    log[level](message, err instanceof Error ? err.message : err);
  };

  const run = <T>(fn: (trx: Kysely<Database>) => Promise<T>) => withRlsContext(db!, { ...scope, role: 'operator' }, fn);

  async function readRows(): Promise<ChannelKillSwitches> {
    const rows = await run(async (trx) =>
      (await sql<{ kind: KillSwitchChannel; state: string }>`SELECT i.kind, h.state FROM hawa.integrations i
        JOIN hawa.integration_health h ON h.integration_id = i.id
        WHERE i.tenant_id = ${scope.tenantId}::uuid AND i.name = ${KILL_SWITCH_ROW_NAME} AND i.kind IN ('telegram', 'waha')`.execute(trx)).rows);
    const found: ChannelKillSwitches = { telegram: false, waha: false };
    for (const row of rows) found[row.kind] = row.state === 'disabled';
    return found;
  }

  async function writeRow(channel: KillSwitchChannel, actorId?: string): Promise<string> {
    const active = wanted[channel];
    const changeTag = crypto.randomUUID();
    await run(async (trx) => {
      await sql`INSERT INTO hawa.integrations (tenant_id, kind, name, config_public)
        VALUES (${scope.tenantId}::uuid, ${channel}, ${KILL_SWITCH_ROW_NAME}, ${JSON.stringify({ purpose: 'office intake kill switch' })}::jsonb)
        ON CONFLICT (tenant_id, kind, name) DO NOTHING`.execute(trx);
      const row = (await sql<{ id: string }>`SELECT id FROM hawa.integrations
        WHERE tenant_id = ${scope.tenantId}::uuid AND kind = ${channel} AND name = ${KILL_SWITCH_ROW_NAME}`.execute(trx)).rows[0];
      if (!row) throw new Error(`The ${channel} kill switch row could not be created`);
      const detail = JSON.stringify({ killSwitch: { active, changedAt: new Date().toISOString(), changedBy: actorId ?? scope.userId, changeTag } });
      await sql`INSERT INTO hawa.integration_health (integration_id, tenant_id, state, detail, last_checked_at)
        VALUES (${row.id}::uuid, ${scope.tenantId}::uuid, ${active ? 'disabled' : 'unknown'}::hawa.integration_health_state, ${detail}::jsonb, now())
        ON CONFLICT (integration_id) DO UPDATE SET state = EXCLUDED.state,
          detail = hawa.integration_health.detail || EXCLUDED.detail, last_checked_at = now(), updated_at = now()`.execute(trx);
    });
    return changeTag;
  }

  function refresh(): Promise<void> {
    if (!db) return Promise.resolve();
    if (reading) return reading;
    const startedAt = { ...version };
    reading = afterProcessWrites()
      .then(readRows)
      .then((found) => {
        readAt = Date.now();
        loaded = true;
        for (const channel of KILL_SWITCH_CHANNELS) {
          if (!unsaved[channel] && version[channel] === startedAt[channel]) copy[channel] = found[channel];
        }
      })
      .finally(() => { reading = null; });
    return reading;
  }

  function refreshIfStale(): void {
    if (!db || !loaded || reading || Date.now() - readAt < refreshAfterMs) return;
    refresh().catch((err) => logRepeated('reread', 'warn', '[core:kill_switch] could not re-read the kill switches; keeping this process\'s copy:', err));
  }

  function enqueueWrite(channel: KillSwitchChannel, actorId?: string): Promise<string> {
    const write = processWrites.then(() => writeRow(channel, actorId));
    processWrites = write.catch(() => undefined);
    return write;
  }

  // Saves an unsaved channel, trying again every few seconds until Postgres has it. One loop per
  // channel; it ends when the channel is saved, including by a later `set`.
  async function saveUntilDone(channel: KillSwitchChannel, actorId?: string): Promise<void> {
    if (saving[channel]) return;
    saving[channel] = true;
    try {
      while (unsaved[channel]) {
        const assigned = version[channel];
        try {
          await enqueueWrite(channel, actorId);
          // A newer assignment made during the write goes round again, so Postgres ends with it.
          if (version[channel] === assigned) unsaved[channel] = false;
        } catch (err: unknown) {
          logRepeated(`save:${channel}`, 'error', `[core:kill_switch] the ${channel} kill switch is ${copy[channel] ? 'thrown' : 'released'} in this process but not yet saved to PostgreSQL; this process keeps it and tries again every ${retryMs / 1000} s:`, err);
          await new Promise((resolve) => setTimeout(resolve, retryMs).unref?.());
        }
      }
    } finally {
      saving[channel] = false;
    }
  }

  // The first read. Until it succeeds the store is not loaded and the Telegram poller stays paused
  // (app.ts): intake cannot tell whether the office switched it off. A failed read is tried again.
  const firstLoad: Promise<void> = new Promise((resolve) => {
    if (!db) return resolve();
    const attempt = () =>
      refresh().then(resolve, (err) => {
        logRepeated('load', 'error', `[core:kill_switch] could not read the kill switches from PostgreSQL; Telegram polling stays paused, WhatsApp intake is refused and the read is retried every ${retryMs / 1000} s:`, err);
        setTimeout(attempt, retryMs).unref?.();
      });
    attempt();
  });

  const switches = {} as ChannelKillSwitches;
  for (const channel of KILL_SWITCH_CHANNELS) {
    Object.defineProperty(switches, channel, {
      enumerable: true,
      get() {
        refreshIfStale();
        return copy[channel];
      },
      set(value: unknown) {
        const active = Boolean(value);
        version[channel] += 1;
        copy[channel] = active;
        wanted[channel] = active;
        if (db) {
          unsaved[channel] = true;
          void saveUntilDone(channel);
        }
      },
    });
  }

  const store: ChannelKillSwitchStore = {
    switches,
    loaded: firstLoad,
    isLoaded: () => loaded,
    isUnsaved: (channel) => unsaved[channel],
    async set(channel, active, actorId) {
      const mine = ++version[channel];
      let changeTag: string | undefined;
      if (db) {
        const before = wanted[channel];
        wanted[channel] = active;
        try {
          changeTag = await enqueueWrite(channel, actorId);
        } catch (err) {
          // Unchanged: what this process wanted before still stands (and is still being saved if it
          // was unsaved), unless the channel was assigned again meanwhile.
          if (version[channel] === mine) wanted[channel] = before;
          throw err;
        }
        // Assigned again while this write ran: that newer assignment stands and is saved by its own loop.
        if (version[channel] !== mine) return changeTag;
        unsaved[channel] = false;
      }
      version[channel] += 1;
      copy[channel] = active;
      return changeTag;
    },
    refresh,
  };
  stores.set(switches, store);
  return store;
}
