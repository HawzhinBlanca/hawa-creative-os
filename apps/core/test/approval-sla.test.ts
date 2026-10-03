import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CANARY_TEST_CLIENT_ID, SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { createDb, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { approvalSlaConfig, businessMsBetween, sweepApprovalSla } from '../src/services/approval-sla.js';

/**
 * ADR-288: a draft waiting for office approval longer than the target in working hours (default 4,
 * Sunday to Thursday 09:00-17:00, Baghdad) is named to every office member, once per draft.
 */
const HOUR = 3_600_000;
const baghdad = (iso: string) => Date.parse(`${iso}+03:00`);
const config = approvalSlaConfig({});
const TENANT = '00000000-0000-4000-a000-000000000001';
const OFFICE = ['7200001', '7200002'];

describe('working hours under the office calendar', () => {
  it('skips the Friday-Saturday weekend and the nights', () => {
    // Thursday 15:00 to Sunday 11:00: two hours on Thursday, two on Sunday.
    expect(businessMsBetween(baghdad('2026-10-01T15:00:00'), baghdad('2026-10-04T11:00:00'), config.calendar)).toBe(4 * HOUR);
    // Sunday 16:30 to Monday 09:30: half an hour each side of the night.
    expect(businessMsBetween(baghdad('2026-10-04T16:30:00'), baghdad('2026-10-05T09:30:00'), config.calendar)).toBe(1 * HOUR);
    expect(businessMsBetween(baghdad('2026-10-02T08:00:00'), baghdad('2026-10-03T20:00:00'), config.calendar)).toBe(0);
    expect(businessMsBetween(baghdad('2026-10-04T10:00:00'), baghdad('2026-10-04T09:00:00'), config.calendar)).toBe(0);
  });

  it('reads the calendar and target from the environment, keeping defaults for what it cannot read', () => {
    expect(config.thresholdMs).toBe(4 * HOUR);
    expect(config.calendar).toMatchObject({ timeZone: 'Asia/Baghdad', openMinute: 540, closeMinute: 1020 });
    expect([...config.calendar.days].sort()).toEqual([0, 1, 2, 3, 4]);
    const custom = approvalSlaConfig({ HAWA_APPROVAL_SLA_BUSINESS_HOURS: '2', HAWA_OFFICE_DAYS: 'Sat-Wed',
      HAWA_OFFICE_HOURS: '08:30-16:00', HAWA_OFFICE_TIMEZONE: 'Asia/Baghdad' });
    expect(custom.thresholdMs).toBe(2 * HOUR);
    expect([...custom.calendar.days].sort()).toEqual([0, 1, 2, 3, 6]);
    expect(custom.calendar).toMatchObject({ openMinute: 510, closeMinute: 960 });
    const broken = approvalSlaConfig({ HAWA_APPROVAL_SLA_BUSINESS_HOURS: 'soon', HAWA_OFFICE_DAYS: 'someday',
      HAWA_OFFICE_HOURS: '17:00-09:00', HAWA_OFFICE_TIMEZONE: 'Mars/Olympus' });
    expect(broken).toEqual(config);
    expect(config.enabled).toBe(true);
    expect(approvalSlaConfig({ HAWA_APPROVAL_SLA_ENABLED: 'OFF' }).enabled).toBe(false);
  });
});

describe('the approval target sweep', () => {
  let owner: Kysely<Database>;
  let db: Kysely<Database>;
  const ids = { late: randomUUID(), early: randomUUID(), weekend: randomUUID(), canaryClient: randomUUID(),
    canaryChat: randomUUID(), canaryRequest: randomUUID() };
  const client = 'c1000000-0000-4000-8000-000000000002';

  beforeAll(async () => {
    owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
    db = createDb(process.env.TEST_DATABASE_URL!);
    await owner.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      const draft = async (id: string, since: string, p: { clientId?: string; requestId?: string; title?: string } = {}) => {
        await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, request_id, title, state, priority, version, created_at, updated_at)
          VALUES (${id}::uuid, ${TENANT}::uuid, ${p.clientId ?? client}::uuid, ${p.requestId ?? null}::uuid, ${p.title ?? 'Open day poster'},
            'human_review', 3, 2, ${new Date(baghdad(since) - HOUR)}, ${new Date(baghdad('2026-10-04T08:00:00'))})`.execute(trx);
        await sql`INSERT INTO hawa.task_events (tenant_id, task_id, event_type, aggregate_version, actor_type, actor_id, correlation_id, data, occurred_at)
          VALUES (${TENANT}::uuid, ${id}::uuid, 'task.state_changed', 2, 'workflow', 'fixture', ${randomUUID()},
            '{"fromState":"qa","toState":"human_review"}'::jsonb, ${new Date(baghdad(since))})`.execute(trx);
      };
      await draft(ids.late, '2026-10-04T09:00:00');
      await draft(ids.early, '2026-10-04T12:00:00');
      await draft(ids.weekend, '2026-10-01T16:00:00', { title: 'Graduation banner' });
      await draft(ids.canaryClient, '2026-10-04T09:00:00', { clientId: CANARY_TEST_CLIENT_ID });
      await draft(ids.canaryChat, '2026-10-04T09:00:00', { requestId: ids.canaryRequest });
      await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, owner, stage, rev, chat_id)
        VALUES (${ids.canaryRequest}::uuid, ${TENANT}::uuid, ${ids.canaryChat}::uuid, ${ids.canaryChat}::uuid, 'restate', 'in_review', 3,
          '4503599627370501')`.execute(trx);
    });
  });
  afterAll(async () => { await owner?.destroy(); await db?.destroy(); });

  const ours = (taskIds: string[]) => taskIds.filter((id) => (Object.values(ids) as string[]).includes(id));
  const sent = () => withRlsContext(db, { tenantId: TENANT, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
    (await sql<{ idempotency_key: string; aggregate_id: string; payload: any }>`SELECT idempotency_key, aggregate_id, payload
      FROM hawa.outbox_commands WHERE tenant_id = ${TENANT}::uuid AND idempotency_key LIKE 'notify.office:approval-sla:%'`.execute(trx))
      .rows.filter((r) => (Object.values(ids) as string[]).includes(r.aggregate_id)));

  it('names the late drafts, in working time, to every office member, and never the canary\'s', async () => {
    // Sunday 14:00: five working hours since 09:00; two since 12:00; Thursday 16:00 to now is
    // one hour on Thursday and five on Sunday (the weekend does not count).
    const now = baghdad('2026-10-04T14:00:00');
    const late = await sweepApprovalSla(db, { tenantId: TENANT, officeChatIds: OFFICE, nowMs: now, limit: 100 });
    expect(ours(late.map((l) => l.taskId)).sort()).toEqual([ids.late, ids.weekend].sort());
    const rows = await sent();
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.idempotency_key).sort()).toEqual([
      `notify.office:approval-sla:${ids.late}`, `notify.office:approval-sla:${ids.late}:${OFFICE[1]}`,
      `notify.office:approval-sla:${ids.weekend}`, `notify.office:approval-sla:${ids.weekend}:${OFFICE[1]}`].sort());
    const weekend = rows.find((r) => r.idempotency_key === `notify.office:approval-sla:${ids.weekend}`)!.payload;
    expect(weekend.chatId).toBe(OFFICE[0]);
    expect(weekend.message.text).toMatch(/^A draft has been waiting for office approval for 6 working hours, longer than the 4-hour target: "Graduation banner"/);
    expect(weekend.message.text).toContain('It has waited since Thursday 16:00 (Baghdad time). Please approve it or ask for changes.');
  });

  it('names each draft once, however often it sweeps', async () => {
    const late = await sweepApprovalSla(db, { tenantId: TENANT, officeChatIds: OFFICE, nowMs: baghdad('2026-10-04T16:30:00'), limit: 100 });
    // Only the draft that reached the target since: 12:00 to 16:30.
    expect(ours(late.map((l) => l.taskId))).toEqual([ids.early]);
    expect(await sent()).toHaveLength(6);
    expect(ours((await sweepApprovalSla(db, { tenantId: TENANT, officeChatIds: OFFICE, nowMs: baghdad('2026-10-05T12:00:00'), limit: 100 }))
      .map((l) => l.taskId))).toEqual([]);
  });

  it('writes nothing without office members', async () => {
    expect(await sweepApprovalSla(db, { tenantId: TENANT, officeChatIds: [' '], nowMs: baghdad('2026-10-08T12:00:00') })).toEqual([]);
  });
});

/**
 * ADR-288 (owner decision): one reminder per waiting draft. While the approval target alert runs it is
 * the only reminder about a draft in office review, and the lifecycle stale sweep skips its in_review
 * stage; switched off (HAWA_APPROVAL_SLA_ENABLED=off), the stale sweep's in_review reminder comes back.
 */
describe('one reminder per draft waiting in office review', () => {
  let owner: Kysely<Database>;
  let db: Kysely<Database>;
  const MEMBER = ['7300001'];
  const since = '2026-10-04T09:00:00';
  const now = baghdad('2026-10-04T15:00:00'); // six working hours later

  async function waitingDraft() {
    const taskId = randomUUID(), requestId = randomUUID();
    await owner.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, request_id, title, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${TENANT}::uuid, 'c1000000-0000-4000-8000-000000000002'::uuid, ${requestId}::uuid, 'Open day poster',
          'human_review', 3, 2, ${new Date(baghdad(since) - HOUR)}, ${new Date(baghdad(since))})`.execute(trx);
      await sql`INSERT INTO hawa.task_events (tenant_id, task_id, event_type, aggregate_version, actor_type, actor_id, correlation_id, data, occurred_at)
        VALUES (${TENANT}::uuid, ${taskId}::uuid, 'task.state_changed', 2, 'workflow', 'fixture', ${randomUUID()},
          '{"fromState":"qa","toState":"human_review"}'::jsonb, ${new Date(baghdad(since))})`.execute(trx);
      await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, owner, stage, rev, chat_id, created_at, updated_at)
        VALUES (${requestId}::uuid, ${TENANT}::uuid, ${taskId}::uuid, ${taskId}::uuid, 'restate', 'in_review', 3, '7000001',
          ${new Date(baghdad(since) - HOUR)}, ${new Date(baghdad(since))})`.execute(trx);
    });
    return { taskId, requestId };
  }
  const remindersFor = (taskId: string) => withRlsContext(db, { tenantId: TENANT, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
    async (trx) => (await sql<{ idempotency_key: string }>`SELECT idempotency_key FROM hawa.outbox_commands
      WHERE tenant_id = ${TENANT}::uuid AND aggregate_id = ${taskId}::uuid AND command_type = 'notify.telegram'`.execute(trx)).rows
      .map((r) => r.idempotency_key));
  const sweepBoth = async () => {
    const { sweepStaleLifecycleRequests } = await import('../src/services/lifecycle-stale-sweep.js');
    // As app.ts runs them: the stale pass, then the approval target pass, each reading the configuration.
    for (const at of [now, now + 15 * 60_000]) {
      await sweepStaleLifecycleRequests(db, { tenantId: TENANT, officeChatIds: MEMBER, nowMs: at, limit: 100 });
      await sweepApprovalSla(db, { tenantId: TENANT, officeChatIds: MEMBER, nowMs: at, limit: 100 });
    }
  };

  beforeAll(async () => {
    owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
    db = createDb(process.env.TEST_DATABASE_URL!);
  });
  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => { await owner?.destroy(); await db?.destroy(); });

  it('with the approval target alert on (the default): one alert, the target alert, and no stale reminder', async () => {
    const { taskId, requestId } = await waitingDraft();
    await sweepBoth();
    expect(await remindersFor(taskId)).toEqual([`notify.office:approval-sla:${taskId}`]);
    expect((await remindersFor(taskId)).some((k) => k.includes(requestId))).toBe(false);
  });

  it('with it switched off: the stale sweep\'s in-review reminder comes back, once', async () => {
    vi.stubEnv('HAWA_APPROVAL_SLA_ENABLED', 'off');
    expect(approvalSlaConfig().enabled).toBe(false);
    const { taskId, requestId } = await waitingDraft();
    await sweepBoth();
    expect(await remindersFor(taskId)).toEqual([`notify.office:lifecycle-stale:${requestId}:3`]);
  });
});
