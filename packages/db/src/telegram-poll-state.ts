/**
 * Where the Telegram poller keeps its place, in Postgres, per bot (architecture programme 0.4), and
 * the office's Telegram kill switch as the poller reads it. The worker's poller
 * (apps/worker/src/lifecycle/telegram-poller.ts) is the only one since ADR-135; Core's is gone.
 *
 * The offset lived only in Core's memory. After a restart the poller asked Telegram from the start,
 * and Telegram handed back every update it had not yet been told was handled, including the last
 * batch Core had finished just before it stopped. Intake's own record of handled updates caught most
 * of them; anything that record does not cover ran twice.
 *
 * No new table: the schema already has a place for an integration's cursor. Each bot is a row in
 * `hawa.integrations` (kind `telegram`, name `bot-<numeric bot id>`; the id is public, the token is
 * not stored) and its position is `hawa.integration_health.cursor_value`, the last update id intake
 * accepted. Rows written before ADR-159 may also carry `detail.failing` (Core's poller counted a
 * failing update there); moving the offset past that update still clears it.
 */
import crypto from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { withRlsContext } from './client.js';
import type { Database } from './types.js';

export interface TelegramPollScope {
  tenantId: string;
  userId: string;
}

/** `bot-<id>` from a token `<id>:<secret>`. A token of another shape is named by a short hash, never by itself. */
export function telegramBotKey(botToken: string): string {
  const id = /^(\d+):/.exec(botToken)?.[1];
  return id ? `bot-${id}` : `bot-sha256-${crypto.createHash('sha256').update(botToken).digest('hex').slice(0, 16)}`;
}

// The worker's poller reads it through its own PollerOffsets interface (getOffset, setOffset).
export class PostgresTelegramPollState {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly scope: TelegramPollScope,
    readonly botKey: string
  ) {}

  private run<T>(fn: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return withRlsContext(this.db, { ...this.scope, role: 'operator' }, fn);
  }

  /** The bot's integration row and its health row, created on first use. Returns the integration id. */
  private async ensureRows(trx: Kysely<Database>): Promise<string> {
    await sql`INSERT INTO hawa.integrations (tenant_id, kind, name, config_public)
      VALUES (${this.scope.tenantId}::uuid, 'telegram', ${this.botKey}, ${JSON.stringify({ purpose: 'getUpdates offset' })}::jsonb)
      ON CONFLICT (tenant_id, kind, name) DO NOTHING`.execute(trx);
    const row = (await sql<{ id: string }>`SELECT id FROM hawa.integrations
      WHERE tenant_id = ${this.scope.tenantId}::uuid AND kind = 'telegram' AND name = ${this.botKey}`.execute(trx)).rows[0];
    if (!row) throw new Error(`The Telegram integration row for ${this.botKey} could not be created`);
    await sql`INSERT INTO hawa.integration_health (integration_id, tenant_id, state, cursor_value)
      VALUES (${row.id}::uuid, ${this.scope.tenantId}::uuid, 'unknown', '0')
      ON CONFLICT (integration_id) DO NOTHING`.execute(trx);
    return row.id;
  }

  /** The last update id intake accepted, 0 when this bot has never been polled. Throws if unreadable. */
  async getOffset(): Promise<number> {
    const row = await this.run(async (trx) =>
      (await sql<{ cursor_value: string | null }>`SELECT h.cursor_value FROM hawa.integration_health h
        JOIN hawa.integrations i ON i.id = h.integration_id
        WHERE i.tenant_id = ${this.scope.tenantId}::uuid AND i.kind = 'telegram' AND i.name = ${this.botKey}`.execute(trx)).rows[0]);
    const n = Number(row?.cursor_value ?? 0);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  }

  /** Moves the offset forward to `updateId` (never back) and forgets a failure at or before it. */
  async setOffset(updateId: number): Promise<void> {
    await this.run((trx) => this.advanceWithin(trx, updateId));
  }

  private async advanceWithin(trx: Kysely<Database>, updateId: number): Promise<void> {
    const integrationId = await this.ensureRows(trx);
    await sql`UPDATE hawa.integration_health SET
        cursor_value = GREATEST(COALESCE(NULLIF(cursor_value, '')::bigint, 0), ${updateId}::bigint)::text,
        detail = CASE WHEN COALESCE((detail->'failing'->>'updateId')::bigint, 0) <= ${updateId}::bigint THEN detail - 'failing' ELSE detail END,
        state = 'healthy', last_event_at = now(), last_success_at = now(), updated_at = now()
      WHERE integration_id = ${integrationId}::uuid`.execute(trx);
  }
}

/**
 * The `hawa.integrations` name of each channel's office kill switch row. Core writes it
 * (apps/core/src/services/channel-kill-switches.ts, KILL_SWITCH_ROW_NAME); the worker's poller reads it.
 */
export const OFFICE_KILL_SWITCH_ROW_NAME = 'office-kill-switch';

/**
 * Whether the office has switched Telegram intake off: the channel's own kill switch row is
 * `disabled`. Not the bot's row, which the poller marks `healthy` on every accepted update and so
 * would release a thrown switch. No row means the switch was never thrown. Throws when Postgres does
 * not answer: the caller cannot know then, and must not poll.
 */
export async function readTelegramKillSwitch(db: Kysely<Database>, scope: TelegramPollScope): Promise<boolean> {
  const row = await withRlsContext(db, { ...scope, role: 'operator' }, async (trx) =>
    (await sql<{ state: string }>`SELECT h.state FROM hawa.integrations i
      JOIN hawa.integration_health h ON h.integration_id = i.id
      WHERE i.tenant_id = ${scope.tenantId}::uuid AND i.kind = 'telegram' AND i.name = ${OFFICE_KILL_SWITCH_ROW_NAME}`.execute(trx)).rows[0]);
  return row?.state === 'disabled';
}
