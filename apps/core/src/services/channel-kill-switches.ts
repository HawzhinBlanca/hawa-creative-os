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
 */
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { log } from '../logging.js';

export type KillSwitchChannel = 'telegram' | 'waha';
export type ChannelKillSwitches = Record<KillSwitchChannel, boolean>;

export const KILL_SWITCH_CHANNELS: readonly KillSwitchChannel[] = ['telegram', 'waha'];
/** The `hawa.integrations` name of each channel's switch row. */
export const KILL_SWITCH_ROW_NAME = 'office-kill-switch';
/** How old this process's copy may be before a read asks Postgres again. */
const REFRESH_AFTER_MS = 5_000;
/** How long to wait before trying again when the first read of Postgres failed. */
const RETRY_LOAD_MS = 5_000;

export interface ChannelKillSwitchStore {
  /**
   * The object on the route context. Reading a channel gives this process's copy; assigning one
   * changes the copy at once and writes it to Postgres in the background (a failed write is logged).
   * Routes that can wait use `set` instead, which answers only once Postgres has it.
   */
  readonly switches: ChannelKillSwitches;
  /** Resolves once Postgres has been read (at once without a database). It never rejects. */
  readonly loaded: Promise<void>;
  isLoaded(): boolean;
  /** Throws (`active`) or releases a switch: Postgres first, then this process. Rejects if Postgres refused it. */
  set(channel: KillSwitchChannel, active: boolean, actorId?: string): Promise<void>;
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
export async function setKillSwitch(switches: ChannelKillSwitches, channel: KillSwitchChannel, active: boolean, actorId?: string): Promise<void> {
  const store = killSwitchStoreOf(switches);
  if (store) await store.set(channel, active, actorId);
  else switches[channel] = active;
}

/** Reads Postgres again when the object has a store (a status report should not answer from a stale copy). */
export async function refreshKillSwitches(switches: ChannelKillSwitches): Promise<void> {
  const store = killSwitchStoreOf(switches);
  if (!store) return;
  await store.loaded;
  await store.refresh();
}

export function createChannelKillSwitchStore(
  db: Kysely<Database> | null | undefined,
  scope: { tenantId: string; userId: string } = { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID }
): ChannelKillSwitchStore {
  const copy: ChannelKillSwitches = { telegram: false, waha: false };
  let loaded = !db;
  let readAt = 0;
  let reading: Promise<void> | null = null;
  // Bumped by every local change: a read of Postgres that began before one does not undo it.
  let generation = 0;

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

  async function writeRow(channel: KillSwitchChannel, active: boolean, actorId?: string): Promise<void> {
    await run(async (trx) => {
      await sql`INSERT INTO hawa.integrations (tenant_id, kind, name, config_public)
        VALUES (${scope.tenantId}::uuid, ${channel}, ${KILL_SWITCH_ROW_NAME}, ${JSON.stringify({ purpose: 'office intake kill switch' })}::jsonb)
        ON CONFLICT (tenant_id, kind, name) DO NOTHING`.execute(trx);
      const row = (await sql<{ id: string }>`SELECT id FROM hawa.integrations
        WHERE tenant_id = ${scope.tenantId}::uuid AND kind = ${channel} AND name = ${KILL_SWITCH_ROW_NAME}`.execute(trx)).rows[0];
      if (!row) throw new Error(`The ${channel} kill switch row could not be created`);
      const detail = JSON.stringify({ killSwitch: { active, changedAt: new Date().toISOString(), changedBy: actorId ?? scope.userId } });
      await sql`INSERT INTO hawa.integration_health (integration_id, tenant_id, state, detail, last_checked_at)
        VALUES (${row.id}::uuid, ${scope.tenantId}::uuid, ${active ? 'disabled' : 'unknown'}::hawa.integration_health_state, ${detail}::jsonb, now())
        ON CONFLICT (integration_id) DO UPDATE SET state = EXCLUDED.state,
          detail = hawa.integration_health.detail || EXCLUDED.detail, last_checked_at = now(), updated_at = now()`.execute(trx);
    });
  }

  function refresh(): Promise<void> {
    if (!db) return Promise.resolve();
    if (reading) return reading;
    const startedAt = generation;
    reading = afterProcessWrites()
      .then(readRows)
      .then((found) => {
        readAt = Date.now();
        loaded = true;
        if (generation === startedAt) Object.assign(copy, found);
      })
      .finally(() => { reading = null; });
    return reading;
  }

  function refreshIfStale(): void {
    if (!db || !loaded || reading || Date.now() - readAt < REFRESH_AFTER_MS) return;
    refresh().catch((err) => log.warn('[core:kill_switch] could not re-read the kill switches; keeping this process\'s copy:', err?.message || err));
  }

  function enqueueWrite(channel: KillSwitchChannel, active: boolean, actorId?: string): Promise<void> {
    const write = processWrites.then(() => writeRow(channel, active, actorId));
    processWrites = write.catch(() => undefined);
    return write;
  }

  // The first read. Until it succeeds the store is not loaded and the Telegram poller stays paused
  // (app.ts): intake cannot tell whether the office switched it off. A failed read is tried again.
  const firstLoad: Promise<void> = new Promise((resolve) => {
    if (!db) return resolve();
    const attempt = () =>
      refresh().then(resolve, (err) => {
        log.error(`[core:kill_switch] could not read the kill switches from PostgreSQL; Telegram polling stays paused and the read is retried in ${RETRY_LOAD_MS / 1000} s:`, err?.message || err);
        setTimeout(attempt, RETRY_LOAD_MS).unref?.();
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
        generation += 1;
        copy[channel] = active;
        if (db) {
          enqueueWrite(channel, active).catch((err) =>
            log.error(`[core:kill_switch] the ${channel} kill switch was set to ${active} in this process but not saved to PostgreSQL; a restart forgets it:`, err?.message || err));
        }
      },
    });
  }

  const store: ChannelKillSwitchStore = {
    switches,
    loaded: firstLoad,
    isLoaded: () => loaded,
    async set(channel, active, actorId) {
      if (db) await enqueueWrite(channel, active, actorId);
      generation += 1;
      copy[channel] = active;
    },
    refresh,
  };
  stores.set(switches, store);
  return store;
}
