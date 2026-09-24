import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Migration 020 (2026-09-24): inbox_events gets a unique index that works with the NULL
 * integration_id intake always writes, after moving any rows that already collide to
 * hawa.inbox_event_duplicates. The file's database was built with 020 already applied, so each case
 * that needs duplicates drops the index inside a transaction, writes them, runs the migration as the
 * upgrade runner does (without its BEGIN/COMMIT) and rolls back.
 */
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
const appUrl = process.env.TEST_DATABASE_URL;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migration = fs.readFileSync(path.join(repo, 'packages/db/migrations/020_inbox_event_dedupe.sql'), 'utf8')
  .replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
const TENANT = '00000000-0000-4000-a000-000000000001';

describe.skipIf(!ownerUrl || !appUrl)('migration 020: one inbox row per source event', () => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  const app = new pg.Client({ connectionString: appUrl });
  beforeAll(async () => {
    await owner.connect();
    await app.connect();
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  /** An inbox row as the owner writes it (RLS does not apply to the owner). */
  const insert = (c: pg.Client, sourceAccount: string, sourceEvent: string, receivedAt: string, kind = 'telegram_update') =>
    c.query(`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified, received_at)
      VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, true, $6::timestamptz) RETURNING id`, [TENANT, sourceAccount, sourceEvent, kind, randomUUID(), receivedAt])
      .then((r: pg.QueryResult<{ id: string }>) => r.rows[0].id);

  async function rolledBack<T>(fn: () => Promise<T>): Promise<T> {
    await owner.query('BEGIN');
    try {
      return await fn();
    } finally {
      await owner.query('ROLLBACK');
    }
  }

  it('applies to a database without duplicates and moves nothing', async () => {
    await rolledBack(async () => {
      await owner.query('DROP INDEX hawa.inbox_events_source_event_uidx');
      const before = Number((await owner.query('SELECT count(*) AS n FROM hawa.inbox_events')).rows[0].n);
      await owner.query(migration);
      const after = Number((await owner.query('SELECT count(*) AS n FROM hawa.inbox_events')).rows[0].n);
      const moved = Number((await owner.query('SELECT count(*) AS n FROM hawa.inbox_event_duplicates')).rows[0].n);
      const index = (await owner.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'hawa' AND indexname = 'inbox_events_source_event_uidx'`)).rows[0]?.indexdef;
      expect({ before, after, moved }).toEqual({ before, after: before, moved: 0 });
      expect(index).toMatch(/UNIQUE INDEX .* NULLS NOT DISTINCT WHERE \(source_account_id <> 'telegram_delivery'::text\)/);
    });
  });

  it('keeps the newest row of each duplicated event, moves the rest aside with the kept id, and repoints their messages', async () => {
    await rolledBack(async () => {
      await owner.query('DROP INDEX hawa.inbox_events_source_event_uidx');
      const event = `9001:${randomUUID()}`;
      const oldest = await insert(owner, 'telegram', event, '2026-09-20T10:00:00Z');
      const middle = await insert(owner, 'telegram', event, '2026-09-20T10:00:01Z');
      const newest = await insert(owner, 'telegram', event, '2026-09-20T10:00:02Z');
      const single = await insert(owner, 'telegram', `9001:${randomUUID()}`, '2026-09-20T10:00:00Z');
      // Send marks share one key by design (attempted, then sent) and must all stay.
      const mark = `${randomUUID()}:message`;
      const marks = [await insert(owner, 'telegram_delivery', mark, '2026-09-20T10:00:00Z', 'telegram_message_attempted'),
        await insert(owner, 'telegram_delivery', mark, '2026-09-20T10:00:01Z', 'telegram_message_sent')];
      // A message recorded against the oldest receipt.
      const message = (await owner.query(`INSERT INTO hawa.message_events (tenant_id, inbox_event_id, external_account_id, external_channel_id, external_message_id, text_original)
        VALUES ($1, $2, 'telegram', '9001', $3, 'x') RETURNING id`, [TENANT, oldest, randomUUID()])).rows[0].id;

      await owner.query(migration);

      const left = (await owner.query('SELECT id FROM hawa.inbox_events WHERE id = ANY($1::uuid[]) ORDER BY received_at, id', [[oldest, middle, newest, single, ...marks]])).rows.map((r) => r.id);
      expect(left.sort()).toEqual([newest, single, ...marks].sort());
      const moved = (await owner.query('SELECT id, kept_id, source_event_id, removed_by FROM hawa.inbox_event_duplicates ORDER BY received_at')).rows;
      expect(moved).toEqual([
        { id: oldest, kept_id: newest, source_event_id: event, removed_by: '020_inbox_event_dedupe.sql' },
        { id: middle, kept_id: newest, source_event_id: event, removed_by: '020_inbox_event_dedupe.sql' },
      ]);
      expect((await owner.query('SELECT inbox_event_id FROM hawa.message_events WHERE id = $1', [message])).rows[0].inbox_event_id).toBe(newest);
    });
  });

  it('leaves row-level security on for the migrations after it: the runner applies them all in one transaction', async () => {
    await rolledBack(async () => {
      await owner.query('DROP INDEX hawa.inbox_events_source_event_uidx');
      await owner.query(migration);
      // 021 and later run in this same transaction, and must not inherit 020's row_security = off.
      expect((await owner.query('SHOW row_security')).rows[0].row_security).toBe('on');
    });
  });

  it('refuses a second row for a source event from then on, ON CONFLICT DO NOTHING keeps the first, and send marks still append', async () => {
    const event = `9002:${randomUUID()}`;
    await rolledBack(async () => {
      await insert(owner, 'telegram', event, '2026-09-20T10:00:00Z');
      await owner.query('SAVEPOINT dup');
      await expect(insert(owner, 'telegram', event, '2026-09-20T10:00:05Z')).rejects.toMatchObject({ code: '23505' });
      await owner.query('ROLLBACK TO SAVEPOINT dup');
      const skipped = await owner.query(`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
        VALUES ($1, 'telegram', $2, 'telegram_update', '{}'::jsonb, 'h', true) ON CONFLICT DO NOTHING`, [TENANT, event]);
      expect(skipped.rowCount).toBe(0);
      const mark = `${randomUUID()}:notice`;
      await insert(owner, 'telegram_delivery', mark, '2026-09-20T10:00:00Z', 'telegram_notice_attempted');
      await insert(owner, 'telegram_delivery', mark, '2026-09-20T10:00:01Z', 'telegram_notice_sent');
      expect(Number((await owner.query('SELECT count(*) AS n FROM hawa.inbox_events WHERE source_event_id = $1', [mark])).rows[0].n)).toBe(2);
    });
  });

  it('keeps the moved rows from the app role, and lets it read which upgrades have run', async () => {
    const r = (await app.query(`SELECT has_table_privilege('hawa.inbox_event_duplicates', 'SELECT') AS dup_read,
        has_table_privilege('hawa.inbox_event_duplicates', 'INSERT') AS dup_write,
        has_table_privilege('hawa.schema_upgrades', 'SELECT') AS upgrades_read`)).rows[0];
    expect(r).toEqual({ dup_read: false, dup_write: false, upgrades_read: true });
    expect((await app.query(`SELECT count(*) AS n FROM hawa.schema_upgrades WHERE name = '020_inbox_event_dedupe.sql'`)).rows[0].n).toBe('1');
  });
});
