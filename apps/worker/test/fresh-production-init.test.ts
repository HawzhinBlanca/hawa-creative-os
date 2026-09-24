import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, OutboxRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { SEEDED_TENANT_ID, SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { upgradeCanvaSchema } from '../../../packages/db/src/upgrade.js';
import { OutboxConsumer } from '../src/outbox-consumer.js';
import { readSendMarks, writeSendMark } from '../src/delivery-notification.js';

// The worker has no pg dependency of its own; the db package's copy is the one its pool uses.
type PgClient = { connect(): Promise<void>; query(text: string): Promise<unknown>; end(): Promise<void> };
const pg = createRequire(new URL('../../../packages/db/package.json', import.meta.url))('pg') as {
  Client: new (config: { connectionString: string }) => PgClient;
};

/**
 * A database built the way production's is built from an empty data directory: the postgres image's
 * entrypoint runs the files docker-compose.prod.yml mounts into /docker-entrypoint-initdb.d with psql,
 * in name order, and deploy.sh then runs the versioned upgrades (packages/db/src/upgrade.ts).
 *
 * The test suites build their databases another way (packages/db/src/test-template.ts grants the app
 * role every privilege on every table and never runs db/03-grants.sql), so nothing checked that a
 * fresh production database lets the worker work. The chaos harness found it did not (2026-09-24):
 * 03-grants.sql revoked UPDATE on hawa.outbox_commands, and the worker's claim failed with
 * "permission denied for table outbox_commands".
 *
 * The files run through psql inside the test server's container, as the entrypoint runs them
 * (00-init-roles.sql needs psql's \getenv and \gset). Roles are cluster-wide and hawa_app already
 * exists on the test server, so 00-init-roles.sql creates nothing here; it still runs, and must pass.
 */
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INIT_FILES = [
  'infra/docker/00-init-roles.sql',
  'db/schema.sql',
  'db/rls.sql',
  'db/03-grants.sql',
  'db/seed.sql',
];
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
const appUrl = process.env.TEST_DATABASE_URL;
const container = process.env.POSTGRES_DRILL_CONTAINER || 'hawa-test-postgres';
if (container.startsWith('hawa-production-')) throw new Error(`refusing to build a database in ${container}`);
const containerRunning = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', container], { encoding: 'utf8' }).stdout?.trim() === 'true';

/** A name the per-file database guard accepts and the global setup prunes if this run is killed. */
const database = `hawa_t_${Math.floor(Date.now() / 1000).toString(36)}${randomBytes(3).toString('hex')}_${process.pid}`;
const on = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};
const tenantId = SEEDED_TENANT_ID;

describe.skipIf(!ownerUrl || !appUrl || !containerRunning)('a database built by the production init scripts', () => {
  let app: Kysely<Database>;
  const asAutomation = <T>(fn: (trx: Kysely<Database>) => Promise<T>) =>
    withRlsContext(app, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, fn);

  async function admin<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: on(ownerUrl!, 'postgres') });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => {});
    }
  }

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8'`));
    const owner = new URL(ownerUrl!).username;
    for (const file of INIT_FILES) {
      // The entrypoint's own invocation (docker-entrypoint.sh docker_process_sql). The app URL
      // reaches psql through the environment, never the command line.
      const res = spawnSync('docker', ['exec', '-i', '-e', 'HAWA_APP_DATABASE_URL', container,
        'psql', '-v', 'ON_ERROR_STOP=1', '--username', owner, '--no-password', '--no-psqlrc', '--dbname', database, '-f', '-'], {
        input: readFileSync(path.join(repo, file)),
        env: { ...process.env, HAWA_APP_DATABASE_URL: appUrl },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (res.status !== 0) throw new Error(`${file} failed in a fresh database: ${String(res.stderr).trim().slice(0, 2000)}`);
    }
    // deploy.sh step 6.
    await upgradeCanvaSchema(on(ownerUrl!, database));
    app = createDb(on(appUrl!, database));
  }, 180_000);

  afterAll(async () => {
    await app?.destroy();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`));
  }, 60_000);

  it('runs the worker outbox as the app role: claim, send marks, delivered, retried and dead-lettered', async () => {
    const outbox = new OutboxRepository(app);
    const enqueue = (commandType: string) => asAutomation((trx) => outbox.enqueue({
      tenantId, aggregateType: 'task', aggregateId: randomUUID(), commandType, idempotencyKey: `fresh-init-${randomUUID()}`, payload: { note: commandType },
    }, trx));
    const ok = await enqueue('test.fresh_ok');
    const flaky = await enqueue('test.fresh_retry');
    const dead = await enqueue('test.fresh_dead');
    // The consumer is left on its own identity (System Automation), as the worker runs it.
    const consumer = new OutboxConsumer(app, {
      tenantId, batchSize: 10, backoffBaseSeconds: 60, telegramBotToken: null, officeAlertChatId: null,
      handlers: {
        // Send marks, the first written under the held claim, as a Telegram delivery writes them.
        'test.fresh_ok': async (cmd, _db, scope) => {
          await scope.whileHeld!((trx) => writeSendMark(trx, tenantId, cmd.id, 'message', 'message', 'attempted'));
          await scope.inTenant((trx) => writeSendMark(trx, tenantId, cmd.id, 'message', 'message', 'sent'));
        },
        'test.fresh_retry': async () => { throw new Error('TEMPORARY: try again later'); },
        'test.fresh_dead': async () => { throw new Error('PERMANENT_REJECTION: refused'); },
      },
    });
    const summary = await consumer.processBatch(10);
    expect({ leased: summary.leased, succeeded: summary.succeeded, deadLettered: summary.deadLettered, lost: summary.lostClaims })
      .toEqual({ leased: 3, succeeded: 1, deadLettered: 1, lost: 0 });
    const state = (id: string) => asAutomation(async (trx) =>
      (await sql<{ state: string; attempts: number; last_error: string | null }>`
        SELECT state::text, attempts, last_error FROM hawa.outbox_commands WHERE id = ${id}::uuid`.execute(trx)).rows[0]);
    expect(await state(ok.id)).toEqual({ state: 'delivered', attempts: 0, last_error: null });
    expect(await state(flaky.id)).toEqual({ state: 'pending', attempts: 1, last_error: 'TEMPORARY: try again later' });
    expect(await state(dead.id)).toMatchObject({ state: 'failed', last_error: 'PERMANENT_REJECTION: refused' });
    expect(await asAutomation((trx) => readSendMarks(trx, tenantId, ok.id))).toEqual(new Map([['message', { kind: 'message', outcome: 'sent' }]]));
    // An administrator's requeue (Core's /system/outbox/requeue) moves the dead letter back.
    expect(await asAutomation((trx) => outbox.redrive(tenantId, dead.id, trx))).toBeTruthy();
    expect(await state(dead.id)).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it('keeps the append-only guards: the app role can move a command on but never rewrite or erase it', async () => {
    const privileges = (await sql<Record<string, boolean>>`SELECT
        has_table_privilege('hawa_app', 'hawa.outbox_commands', 'DELETE') AS outbox_delete,
        has_column_privilege('hawa_app', 'hawa.outbox_commands', 'payload', 'UPDATE') AS outbox_payload,
        has_column_privilege('hawa_app', 'hawa.outbox_commands', 'idempotency_key', 'UPDATE') AS outbox_key,
        has_column_privilege('hawa_app', 'hawa.outbox_commands', 'state', 'UPDATE') AS outbox_state,
        has_column_privilege('hawa_app', 'hawa.outbox_commands', 'leased_until', 'UPDATE') AS outbox_lease,
        has_table_privilege('hawa_app', 'hawa.inbox_events', 'UPDATE') AS inbox_update,
        has_table_privilege('hawa_app', 'hawa.inbox_events', 'DELETE') AS inbox_delete,
        has_table_privilege('hawa_app', 'hawa.task_events', 'UPDATE') AS events_update,
        has_column_privilege('hawa_app', 'hawa.design_revisions', 'status', 'UPDATE') AS revision_status,
        has_column_privilege('hawa_app', 'hawa.design_revisions', 'source_sha256', 'UPDATE') AS revision_hash,
        has_table_privilege('hawa_app', 'hawa.design_revisions', 'DELETE') AS revision_delete,
        has_column_privilege('hawa_app', 'hawa.publications', 'state', 'UPDATE') AS publication_state,
        has_column_privilege('hawa_app', 'hawa.publications', 'package_sha256', 'UPDATE') AS publication_hash,
        has_table_privilege('hawa_app', 'hawa.publications', 'DELETE') AS publication_delete,
        has_table_privilege('hawa_app', 'hawa.approvals', 'UPDATE') AS approval_update,
        has_table_privilege('hawa_app', 'hawa.schema_upgrades', 'SELECT') AS upgrades_read`.execute(app)).rows[0];
    expect(privileges).toEqual({
      outbox_delete: false, outbox_payload: false, outbox_key: false, outbox_state: true, outbox_lease: true,
      inbox_update: false, inbox_delete: false, events_update: false,
      revision_status: true, revision_hash: false, revision_delete: false,
      publication_state: true, publication_hash: false, publication_delete: false,
      approval_update: false, upgrades_read: true,
    });
  });
});
