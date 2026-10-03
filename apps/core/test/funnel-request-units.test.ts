import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Database, type Kysely } from '@hawa/db';
import { checkProductionFunnelHealth, percentileCont, summarizeFunnel, type FunnelUnit } from '../src/services/funnel-monitor.js';

/**
 * ADR-288: the funnel counts requests, once per stage, and times each stage when it ends.
 *
 * Production on 2026-10-03 read 29 briefs, 8 drafts, 1 approval and 1 delivery, with 0 samples for
 * draft→approval and approval→delivery. Three things made that picture:
 *  - the stage timings were read only for tasks whose brief fell in the window, while the counts read
 *    events in the window: a request briefed before the window and approved inside it was counted and
 *    never timed;
 *  - a delivery was timed only from a completed publication, and a chat-only delivery (ADR-230, the
 *    office's Google archive not connected) leaves its publication open with the task complete;
 *  - every task was a brief (a revision round, an office retry and an answered question are each a
 *    task of the same request), the nightly canary's requests were counted, and approvals and
 *    deliveries added a task's state to its approval and publication rows, so one request counted twice.
 */
const operatorUserId = '00000000-0000-4000-b000-000000000001';

let owner: Kysely<Database>;
let db: Kysely<Database>;
const tenant = randomUUID();
const client = randomUUID();

/** Fixture rows go in as the owner with triggers and foreign keys off: only the funnel's own columns matter. */
async function seed(write: (trx: Kysely<Database>, t: { h: (hours: number) => ReturnType<typeof sql> }) => Promise<void>) {
  await owner.transaction().execute(async (trx) => {
    await sql`SET LOCAL session_replication_role = replica`.execute(trx);
    await write(trx, { h: (hours: number) => sql`now() - make_interval(secs => ${hours * 3600}::double precision)` });
  });
}

type H = (hours: number) => ReturnType<typeof sql>;
async function task(trx: Kysely<Database>, h: H, p: { id: string; requestId?: string | null; created: number; state: string;
  completed?: number | null; clientId?: string }) {
  await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, request_id, title, state, priority, version, created_at, updated_at, completed_at)
    VALUES (${p.id}::uuid, ${tenant}::uuid, ${p.clientId ?? client}::uuid, ${p.requestId ?? null}::uuid, 'Funnel fixture', ${p.state}::hawa.task_state, 3, 1,
      ${h(p.created)}, ${h(p.completed ?? p.created)}, ${p.completed == null ? null : h(p.completed)})`.execute(trx);
}
async function request(trx: Kysely<Database>, h: H, p: { id: string; root: string; current: string; created: number; stage: string; chat?: string }) {
  await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, owner, stage, rev, chat_id, created_at, updated_at)
    VALUES (${p.id}::uuid, ${tenant}::uuid, ${p.root}::uuid, ${p.current}::uuid, 'restate', ${p.stage}, 3, ${p.chat ?? '7000001'}, ${h(p.created)}, ${h(p.created)})`.execute(trx);
}
async function draft(trx: Kysely<Database>, h: H, taskId: string, at: number) {
  await sql`INSERT INTO hawa.canva_bindings (tenant_id, task_id, client_id, canva_design_id, edit_url, direction_name, created_at, updated_at)
    VALUES (${tenant}::uuid, ${taskId}::uuid, ${client}::uuid, ${`D-${randomUUID()}`}, 'https://www.canva.com/design/fixture/edit',
      ${`direction-${at}`}, ${h(at)}, ${h(at)})`.execute(trx);
}
async function decision(trx: Kysely<Database>, h: H, taskId: string, at: number, decision: 'approved' | 'revision_requested'): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO hawa.approvals (id, tenant_id, task_id, review_request_id, design_revision_id, qc_run_id, decision, decided_by, nonce, created_at)
    VALUES (${id}::uuid, ${tenant}::uuid, ${taskId}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
      ${decision}::hawa.approval_decision, ${operatorUserId}::uuid, ${`fixture:${id}`}, ${h(at)})`.execute(trx);
  return id;
}
async function publication(trx: Kysely<Database>, h: H, taskId: string, approvalId: string, p: { created: number; completed?: number; error?: string }) {
  await sql`INSERT INTO hawa.publications (tenant_id, task_id, design_revision_id, approval_id, publication_key, state, package_manifest,
      package_sha256, error_class, created_at, updated_at, completed_at)
    VALUES (${tenant}::uuid, ${taskId}::uuid, ${randomUUID()}::uuid, ${approvalId}::uuid, ${`pub_key_${taskId}_${approvalId}`},
      ${p.completed == null ? 'drive_pending' : 'complete'}::hawa.publication_state, '{}'::jsonb, ${'a'.repeat(64)}, ${p.error ?? null},
      ${h(p.created)}, ${h(p.completed ?? p.created)}, ${p.completed == null ? null : h(p.completed)})`.execute(trx);
}
async function transition(trx: Kysely<Database>, h: H, taskId: string, at: number, toState: string, data: Record<string, unknown> = {}) {
  await sql`INSERT INTO hawa.task_events (tenant_id, task_id, event_type, aggregate_version, actor_type, actor_id, correlation_id, data, occurred_at)
    VALUES (${tenant}::uuid, ${taskId}::uuid, 'task.state_changed', 2, 'workflow', 'fixture', ${randomUUID()},
      ${JSON.stringify({ toState, ...data })}::jsonb, ${h(at)})`.execute(trx);
}

const ids = {
  oldBrief: { request: randomUUID(), task: randomUUID() },
  revised: { request: randomUUID(), first: randomUUID(), second: randomUUID() },
  legacy: randomUUID(),
  withdrawn: { request: randomUUID(), task: randomUUID() },
  officeCancelled: { request: randomUUID(), task: randomUUID() },
  failed: { request: randomUUID(), task: randomUUID() },
  canaryChat: { request: randomUUID(), task: randomUUID() },
  canaryIntake: randomUUID(),
};

beforeAll(async () => {
  owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
  db = createDb(process.env.TEST_DATABASE_URL!);
  await sql`INSERT INTO hawa.tenants (id, name, slug) VALUES (${tenant}::uuid, 'Funnel fixture', ${tenant})`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships (tenant_id, user_id, role) VALUES (${tenant}::uuid, ${operatorUserId}::uuid, 'operator')`.execute(owner);
  await seed(async (trx, { h }) => {
    // A: briefed 60 h ago (before the window), approved 20 h ago, delivered in the chat 10 h ago with the
    // Drive archive pending: the publication stays open, the task is complete (ADR-230).
    const a = ids.oldBrief;
    await task(trx, h, { id: a.task, requestId: a.request, created: 60, state: 'complete', completed: 10 });
    await request(trx, h, { id: a.request, root: a.task, current: a.task, created: 60, stage: 'delivered' });
    await draft(trx, h, a.task, 59);
    const aApproval = await decision(trx, h, a.task, 20, 'approved');
    await publication(trx, h, a.task, aApproval, { created: 12, error: 'ARCHIVE_PENDING' });
    await transition(trx, h, a.task, 10, 'complete');

    // B: briefed 30 h ago; the office asked for changes; the second round was approved and published.
    const b = ids.revised;
    await task(trx, h, { id: b.first, requestId: b.request, created: 30, state: 'revision_requested' });
    await task(trx, h, { id: b.second, requestId: b.request, created: 27, state: 'complete', completed: 24 });
    await request(trx, h, { id: b.request, root: b.first, current: b.second, created: 30, stage: 'delivered' });
    await draft(trx, h, b.first, 29.5);
    await draft(trx, h, b.first, 29.4); // a second Canva direction of the same draft
    await decision(trx, h, b.first, 28, 'revision_requested');
    await draft(trx, h, b.second, 26.5);
    const bApproval = await decision(trx, h, b.second, 25, 'approved');
    await publication(trx, h, b.second, bApproval, { created: 24.5, completed: 24 });

    // C: a task from before the request lifecycle, approved on its first draft and published: one
    // approval row and one complete publication beside a complete task, counted once each.
    await task(trx, h, { id: ids.legacy, created: 10, state: 'complete', completed: 7 });
    await draft(trx, h, ids.legacy, 9.9);
    const cApproval = await decision(trx, h, ids.legacy, 8, 'approved');
    await publication(trx, h, ids.legacy, cApproval, { created: 7.5, completed: 7 });

    // D, E: withdrawn before any draft, by the requester and by the office.
    for (const [unit, actor] of [[ids.withdrawn, 'requester'], [ids.officeCancelled, 'office']] as const) {
      await task(trx, h, { id: unit.task, requestId: unit.request, created: 5, state: 'cancelled', completed: 4 });
      await request(trx, h, { id: unit.request, root: unit.task, current: unit.task, created: 5, stage: 'cancelled' });
      await transition(trx, h, unit.task, 4, 'cancelled', { withdrawn: { requestId: unit.request, actor } });
    }

    // F: the design ended without a draft and waits for the office.
    await task(trx, h, { id: ids.failed.task, requestId: ids.failed.request, created: 6, state: 'failed_operator' });
    await request(trx, h, { id: ids.failed.request, root: ids.failed.task, current: ids.failed.task, created: 6, stage: 'manual' });

    // G: the nightly canary's request, by its chat: drafted, approved and delivered, and in no count.
    const g = ids.canaryChat;
    await task(trx, h, { id: g.task, requestId: g.request, created: 3, state: 'complete', completed: 1 });
    await request(trx, h, { id: g.request, root: g.task, current: g.task, created: 3, stage: 'delivered', chat: '4503599627370501' });
    await draft(trx, h, g.task, 2.9);
    const gApproval = await decision(trx, h, g.task, 2, 'approved');
    await publication(trx, h, g.task, gApproval, { created: 1.5, completed: 1 });

    // H: a canary task known only by its intake chat, cancelled.
    await task(trx, h, { id: ids.canaryIntake, created: 2, state: 'cancelled', completed: 1 });
    await sql`INSERT INTO hawa.outbox_commands (tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload)
      VALUES (${tenant}::uuid, 'task', ${ids.canaryIntake}::uuid, 'task.created', ${`fixture:${ids.canaryIntake}`},
        '{"sourceChannelId":"4503599627370501"}'::jsonb)`.execute(trx);
  });
});

afterAll(async () => {
  // The test runner drops this file's disposable database, fixture tenant included.
  await owner?.destroy();
  await db?.destroy();
});

describe('funnel: one request, counted once per stage, timed when the stage ends (ADR-288)', () => {
  it('counts requests, not tasks, rows or states, and leaves the canary out', async () => {
    const m = await checkProductionFunnelHealth(db, { tenantId: tenant, windowHours: 48 });
    expect(m.status).not.toBe('unknown');
    // B, C, D, E and F were briefed in the window; A was briefed before it; G and H are the canary's.
    expect(m.briefsCount).toBe(5);
    // First drafts in the window: B (two rounds, two directions: one draft) and C.
    expect(m.draftsCount).toBe(2);
    // A, B and C approved; C's approval row, publication and complete task are one approval and one delivery.
    expect(m.approvalsCount).toBe(3);
    expect(m.deliveriesCount).toBe(3);
    expect(m.briefsDrafted).toBe(2);
    expect(m.cancelledBeforeDraft).toEqual({ total: 3, requesterWithdrew: 1, officeCancelled: 1, systemFailed: 1, other: 0 });
    expect(m.excluded).toEqual({ canaryRequests: 2 });
  });

  it('times draft→approval and approval→delivery for every approval and delivery it counts', async () => {
    const m = await checkProductionFunnelHealth(db, { tenantId: tenant, windowHours: 48 });
    const d = m.stageDurations!;
    expect(d.briefToDraft.samples).toBe(2);
    expect(d.draftToApproval.samples).toBe(m.approvalsCount);
    expect(d.approvalToDelivery.samples).toBe(m.deliveriesCount);
    // From the first draft: A 59 h → 20 h, B 29.5 h → 25 h, C 9.9 h → 8 h.
    expect(d.draftToApproval.p50Hours).toBeCloseTo(4.5, 3);
    // A was delivered in the chat 10 h after its approval, with its publication still open.
    expect(d.approvalToDelivery.p95Hours).toBeCloseTo(9.1, 3);
  });

  it('reports the north-star numbers over seven days', async () => {
    const m = await checkProductionFunnelHealth(db, { tenantId: tenant, windowHours: 48 });
    expect(m.northStar).toEqual({
      days: 7, deliveredDesigns: 3, approvals: 3, approvedFirstDraft: 2,
      firstDraftApprovalRate: 2 / 3,
      // Brief → delivery: A 50 h, B 6 h, C 3 h.
      medianBriefToDeliveryHours: expect.closeTo(6, 3), briefToDeliverySamples: 3,
    });
  });

  it('a narrower window times a delivery inside it whose approval came before it', async () => {
    const m = await checkProductionFunnelHealth(db, { tenantId: tenant, windowHours: 12 });
    expect([m.briefsCount, m.draftsCount, m.approvalsCount, m.deliveriesCount]).toEqual([4, 1, 1, 2]);
    // A's approval (20 h ago) is outside these 12 hours, its delivery (10 h ago) inside: it is timed.
    expect(m.stageDurations!.approvalToDelivery.samples).toBe(2);
    expect(m.stageDurations!.draftToApproval.samples).toBe(1);
  });
});

describe('summarizeFunnel', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000);
  const unit = (p: Partial<FunnelUnit>): FunnelUnit => ({ unitId: randomUUID(), canary: false, briefAt: at(1), draftAt: null,
    draftedTasks: 0, approvalEvidenceAt: null, approvalStateAt: null, revisionDecisions: 0, deliveredAt: null,
    requestStage: null, latestTaskState: 'received', withdrawnBy: null, ...p });

  it('counts an approval known only from a task state, and never times it', () => {
    const s = summarizeFunnel([unit({ briefAt: at(5), draftAt: at(4), draftedTasks: 1, approvalStateAt: at(2), deliveredAt: at(2),
      latestTaskState: 'complete' })], { nowMs: now, windowHours: 48 });
    expect(s.approvalsCount).toBe(1);
    expect(s.deliveriesCount).toBe(1);
    expect(s.stageDurations.draftToApproval.samples).toBe(0);
    expect(s.stageDurations.approvalToDelivery.samples).toBe(0);
  });

  it('has no rate without approvals, and interpolates percentiles as Postgres does', () => {
    expect(summarizeFunnel([], { nowMs: now, windowHours: 48 }).northStar.firstDraftApprovalRate).toBeNull();
    expect(percentileCont([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentileCont([1, 10], 0.95)).toBeCloseTo(9.55, 10);
    expect(percentileCont([], 0.5)).toBeNull();
  });
});
