import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, OutboxRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { ART_DIRECTOR_USER_ID, SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { OutboxConsumer } from '../src/outbox-consumer.js';
import { outcomeRecorder } from '../src/outcome-without-core.js';
import { automationMembershipGaps, servedTenantIds } from '../src/automation-identity.js';

/**
 * The worker's database identity (PHASE2_DESIGN.md section 1.2, finding 2). The worker wrote as the
 * Art Director (…b000-000000000002), a person: rows nobody pressed a button for were attributed to
 * her, and the worker could act only in tenants where she held a membership. Its own identity is
 * System Automation (ADR-027), which db/seed.sql and migration 012 make an operator of every tenant.
 *
 * Tenant 7 (db/test-fixtures.sql): the Art Director has no membership there and System Automation is
 * an operator, so a worker still acting as the Art Director sees none of the tenant's rows.
 */
const tenantId = '00000000-0000-4000-a000-000000000007';
const adminId = '00000000-0000-4000-b000-000000000007';
const url = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;

describe.skipIf(!url)('the worker acts as System Automation', () => {
  let db: Kysely<Database>;
  const asAdmin = <T>(fn: (trx: Kysely<Database>) => Promise<T>) => withRlsContext(db, { tenantId, userId: adminId, role: 'administrator' }, fn);

  beforeAll(async () => {
    db = createDb(url!);
    // The premise of this file: in this tenant only the service identity can act for the worker.
    const members = await asAdmin(async (trx) => (await sql<{ user_id: string; role: string }>`
      SELECT user_id::text, role::text FROM hawa.tenant_memberships WHERE tenant_id = ${tenantId}::uuid AND active`.execute(trx)).rows);
    expect(members.find((m) => m.user_id === ART_DIRECTOR_USER_ID)).toBeUndefined();
    expect(members).toContainEqual({ user_id: SYSTEM_AUTOMATION_USER_ID, role: 'operator' });
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('claims, handles and records outbox commands under the System Automation user', async () => {
    const idempotencyKey = `identity-test-${randomUUID()}`;
    await asAdmin((trx) => new OutboxRepository(db).enqueue({
      tenantId, aggregateType: 'task', aggregateId: randomUUID(), commandType: 'test.identity', idempotencyKey, payload: { n: 1 },
    }, trx));
    const seen: string[] = [];
    const consumer = new OutboxConsumer(db, {
      tenantId, batchSize: 5, telegramBotToken: null, officeAlertChatId: null,
      handlers: {
        'test.identity': async (_cmd, _db, scope) => {
          seen.push(await scope.inTenant(async (trx) =>
            (await sql<{ user_id: string }>`SELECT current_setting('app.user_id') AS user_id`.execute(trx)).rows[0].user_id));
        },
      },
    });
    const summary = await consumer.processBatch(5);
    const row = await asAdmin((trx) => new OutboxRepository(db).findByIdempotencyKey(tenantId, idempotencyKey, trx));
    expect({ leased: summary.leased, succeeded: summary.succeeded, state: row?.state, seen })
      .toEqual({ leased: 1, succeeded: 1, state: 'delivered', seen: [SYSTEM_AUTOMATION_USER_ID] });
  });

  it('records an outcome Core did not take under the System Automation user', async () => {
    const taskId = randomUUID();
    const clientId = randomUUID();
    await asAdmin(async (trx) => {
      await sql`INSERT INTO hawa.clients (id, tenant_id, code, name, default_language, status)
        VALUES (${clientId}::uuid, ${tenantId}::uuid, ${`identity-${taskId.slice(0, 8)}`}, 'Identity client', 'en', 'active')`.execute(trx);
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${tenantId}::uuid, ${clientId}::uuid, 'Identity poster', '', 'received', 3, 1, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.task_events (id, tenant_id, task_id, aggregate_version, event_type, actor_type, actor_id, correlation_id, data, occurred_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, 1, 'task.created', 'user', ${adminId}, ${randomUUID()}::uuid,
          ${JSON.stringify({ payload: { sourcePlatform: 'telegram', sourceChannelId: '7707' } })}::jsonb, now())`.execute(trx);
    });
    const recorded = await outcomeRecorder(db, { officeChatId: null })({
      tenantId, taskId, report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAidentity1', runId: 'identity-run' },
    } as Parameters<ReturnType<typeof outcomeRecorder>>[0]);
    expect(recorded).toMatchObject({ requesterMessage: 'written', report: 'written' });
  });

  it.skipIf(!ownerUrl)('names a served tenant created after migration 012, where System Automation has no membership', async () => {
    // A tenant made the way an administrator would make one today: no service memberships follow.
    const owner = createDb(ownerUrl!);
    const lateTenant = randomUUID();
    try {
      await sql`INSERT INTO hawa.tenants (id, name, slug) VALUES (${lateTenant}::uuid, 'Late tenant', ${`late-${lateTenant.slice(0, 8)}`})`.execute(owner);
      expect(await automationMembershipGaps(db, [tenantId, lateTenant])).toEqual([lateTenant]);
    } finally {
      // The per-file database clone owns cleanup. Tenant policy audit history is retained.
      await owner.destroy();
    }
  });

  it('checks the tenants its outbox serves: the TENANT_IDS list, or else the default tenant', () => {
    expect(servedTenantIds({ TENANT_IDS: ' a , b ,' })).toEqual(['a', 'b']);
    expect(servedTenantIds({ HAWA_TENANT_IDS: 'c' })).toEqual(['c']);
    // HAWA_TENANT_ID picks the tenant /health reads; the outbox consumer is never given it.
    expect(servedTenantIds({ HAWA_TENANT_ID: 'c' })).toEqual(['00000000-0000-4000-a000-000000000001']);
  });

  it('names no person as its database user anywhere in its source', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
    const offenders = readdirSync(src).filter((f) => f.endsWith('.ts'))
      .filter((f) => /ART_DIRECTOR_USER_ID|b000-000000000002|PRIMARY_OPERATOR_USER_ID|b000-000000000001/.test(readFileSync(path.join(src, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
