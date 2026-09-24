import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { captureLogs } from '@hawa/observability';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import * as outcomeModule from '../src/services/canva-task-outcome.js';

// The outcome service's two writes, real unless a test makes them fail.
vi.mock('../src/services/canva-task-outcome.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/services/canva-task-outcome.js')>();
  return { ...real, bridgeCanvaDraftRevision: vi.fn(real.bridgeCanvaDraftRevision), transitionTaskForOutcome: vi.fn(real.transitionTaskForOutcome) };
});
const realOutcome = await vi.importActual<typeof import('../src/services/canva-task-outcome.js')>('../src/services/canva-task-outcome.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '../src/services/funnel-monitor.ts'), 'utf8');

/**
 * The funnel monitor decides the health endpoint's verdict, and it was alarming on the absence of
 * two stages this product does not run.
 *
 * Measured in production on 2026-09-21: 14 briefs in 48h, 13 drafts, 0 approvals, 0 deliveries.
 * The pipeline was working — 13 of 14 briefs produced a Canva design — but approvals and
 * publications belong to a flow that ends outside this system, in Canva, so both counts sit at zero
 * permanently. Health therefore read `degraded` permanently, which means a real outage looked
 * exactly like a normal day. A monitor that always alarms is worse than none.
 *
 * The task-level stall behavior is exercised against PostgreSQL in funnel-monitor.test.ts.
 * These older checks only guard the unused approval-stage regression.
 */
describe('the funnel does not alarm on an unused approval stage', () => {
  it('no longer treats zero approvals or zero deliveries as a stall', () => {
    // The exact condition that kept production red: `approvalsCount === 0 || deliveriesCount === 0`.
    expect(source).not.toMatch(/approvalsCount === 0 \|\| deliveriesCount === 0/);
  });

  it('still reports both counts, because they are true about a flow that may yet be used', () => {
    expect(source).toMatch(/approvalsCount,/);
    expect(source).toMatch(/deliveriesCount,/);
  });

  it('still distinguishes idle from stalled, so a quiet week is not an incident', () => {
    expect(source).toMatch(/if \(briefsCount === 0\)[\s\S]{0,60}status = 'idle'/);
  });
});

/**
 * A task whose design has been made and sent is no longer `received`. Nothing advanced it, so every
 * task in production read RECEIVED — including designs delivered the previous day with working
 * Canva links — and the records could not tell "designed and sent" apart from "never touched".
 */
describe('a delivered draft advances the task out of received', () => {
  // These used to read app.ts's text for the state name and the two log lines, which a move of the
  // handler to another file would break or, worse, keep passing. They now post the worker's report.
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
  afterAll(() => db.destroy());
  afterEach(() => {
    vi.mocked(outcomeModule.bridgeCanvaDraftRevision).mockReset().mockImplementation(realOutcome.bridgeCanvaDraftRevision);
    vi.mocked(outcomeModule.transitionTaskForOutcome).mockReset().mockImplementation(realOutcome.transitionTaskForOutcome);
  });

  const telegramTask = async () =>
    (
      await persistChatIntake(db, {
        platform: 'telegram',
        sourceEventId: randomUUID(),
        sourceChannelId: String(9_000_000_000 + Math.floor(Math.random() * 999_999_999)),
        clientId: 'c1000000-0000-4000-8000-000000000002',
        title: 'KAAE: Standards launch',
        rawText: 'Launch announcement\n---\nStandards Framework 2.0',
        designInstructions: '',
        exactCopy: [{ id: 'copy_0', role: 'headline', text: 'Standards Framework 2.0' }],
        autoGenerate: true,
      } as any)
    ).task.id as string;
  const telegramBridge = () => ({
    dispatchOutboundMessage: vi.fn(async () => ({ success: true, messageId: '1' })),
    dispatchOutboundPhoto: vi.fn(async () => ({ success: true })),
  });
  const notify = (taskId: string, body: Record<string, unknown>) =>
    createApp({ db, telegramBridge: telegramBridge() } as any)
      .request(`/v1/tasks/${taskId}/notifications/canva-status`, { method: 'POST', headers, body: JSON.stringify(body) });
  const stateOf = async (taskId: string) =>
    withRlsContext(db, scope, async (trx) => (await sql<{ state: string }>`SELECT state FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(trx)).rows[0].state);
  const notifications = async (taskId: string) =>
    withRlsContext(db, scope, async (trx) =>
      (await sql<{ idempotency_key: string }>`SELECT idempotency_key FROM hawa.outbox_commands WHERE aggregate_id = ${taskId} AND command_type = 'notify.telegram'`.execute(trx)).rows);

  it('moves the task to human_review when a Canva draft is delivered', async () => {
    const taskId = await telegramTask();
    const res = await notify(taskId, { status: 'DRAFT_READY', designId: 'DAGfunnel0001' });
    expect(res.status).toBe(200);
    expect(await stateOf(taskId)).toBe('human_review');
  });

  it('never fails the delivery over bookkeeping, and never hides it either', async () => {
    // The Canva link is the thing the owner is waiting for; a failed state write must not cost it.
    vi.mocked(outcomeModule.bridgeCanvaDraftRevision).mockRejectedValue(new Error('revision store down'));
    vi.mocked(outcomeModule.transitionTaskForOutcome).mockRejectedValue(new Error('state store down'));
    const taskId = await telegramTask();
    const logs = captureLogs();
    let res: Response;
    try {
      res = await notify(taskId, { status: 'DRAFT_READY', designId: 'DAGfunnel0002', runId: 'run-funnel' });
    } finally {
      logs.restore();
    }
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, taskId, notificationSent: true });
    expect((await notifications(taskId)).map((r) => r.idempotency_key)).toEqual([`notify.telegram:${taskId}:DRAFT_READY:run-funnel`]);
    const errors = logs.lines.filter((l) => l.level === 'error').map((l) => l.msg);
    expect(errors.some((m) => m.includes('could NOT be recorded as a Desk revision'))).toBe(true);
    expect(errors.some((m) => m.includes('could not record outcome DRAFT_READY as state failed_operator'))).toBe(true);
    // Nothing moved it, and nothing claimed to.
    expect(await stateOf(taskId)).toBe('received');
  });

  // The move itself lives in services/canva-task-outcome.ts since 2026-09-24 and is exercised against
  // the database in canva-outcome-task-state.test.ts; this keeps its source-level guarantee.
  const outcome = fs.readFileSync(path.join(here, '../src/services/canva-task-outcome.ts'), 'utf8');

  it('only ever moves forward, so a re-sent notification cannot drag back an approved task', () => {
    const advanceable = outcome.match(/const PRE_OUTCOME_STATES = \[([\s\S]{0,400}?)\];/);
    expect(advanceable).toBeTruthy();
    const list = advanceable![1];
    for (const before of ['received', 'brief_draft', 'qa']) expect(list).toContain(before);
    for (const after of ['approved', 'complete', 'rejected', 'revision_requested', 'human_review']) {
      expect(list).not.toContain(`'${after}'`);
    }
  });
});
