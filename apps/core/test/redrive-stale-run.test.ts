import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

/**
 * Bug hunt 2026-09-24. A studio run the worker gave up on (DESIGN_STUCK, a step out of retries, a
 * workflow lost with Restate's volume, a Core restart mid-stage with the workflow already reported)
 * stays at its stage for ever: nothing abandons it. app.ts already knows ("a run left mid-stage by a
 * restart stays non-terminal for ever", LIVE_RUN, 30 minutes), but redriveTask does not use that rule:
 * it finds the dead run "unfinished", queues nothing, and tells the requester "A design for task ... is
 * still being made ... You will receive the result here." Nothing will ever arrive. createOrGetRun and
 * the unique index design_studio_one_active_run refuse a new run for the same reason.
 */
describe('HUNT: /redo on a task whose studio run died mid-stage', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';
  const kaaeClientId = 'c1000000-0000-4000-8000-000000000002';
  const scope = { tenantId, userId: operatorUserId, role: 'operator' };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
  const runIds: string[] = [];
  afterAll(async () => {
    // Only this suite's own run is closed; nothing tenant-wide.
    // Earlier runs of this suite included: its tasks carry their own title.
    await withRlsContext(db, scope, (trx) =>
      sql`UPDATE hawa.design_studio_runs r SET status = 'abandoned' FROM hawa.tasks t
        WHERE t.id = r.task_id AND t.tenant_id = r.tenant_id AND t.title = 'KAAE: hunt stale run'
          AND r.status NOT IN ('transferred', 'degraded', 'failed', 'abandoned')`.execute(trx));
    await db.destroy();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  // ADR-287: the studio re-drive of a task outside RequestLifecycle went through the retired task
  // workflow. It now starts nothing, promises nothing and leaves the dead run as it is.
  it('promises nothing for a run that stopped two days ago: the re-drive is retired (ADR-287)', async () => {
    const chat = String(9_000_000_000 + Math.floor(Math.random() * 999_999_999));
    vi.stubEnv('DESIGN_PIPELINE_V3_CHATS', chat);
    const taskId = (
      await persistChatIntake(db, {
        platform: 'telegram',
        sourceEventId: randomUUID(),
        sourceChannelId: chat,
        clientId: kaaeClientId,
        title: 'KAAE: hunt stale run',
        rawText: 'Launch announcement\n---\nStandards Framework 2.0',
        designInstructions: '',
        exactCopy: [{ id: 'copy_0', role: 'headline', text: 'Standards Framework 2.0' }],
        autoGenerate: true,
      } as any)
    ).task.id as string;

    // The first run, left at 'laying_out' two days ago (the worker reported DESIGN_STUCK and ended).
    const runId = randomUUID();
    runIds.push(runId);
    await withRlsContext(db, scope, (trx) =>
      sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status, stages, created_at, updated_at)
        VALUES (${runId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaaeClientId}::uuid, ${operatorUserId},
          ${`workflow-studio-${taskId}`}, 'h', '{}'::jsonb, 'premium', 'laying_out', '{}'::jsonb, now() - interval '2 days', now() - interval '2 days')`.execute(trx)
    );

    const sent: any[] = [];
    const telegramBridge = {
      dispatchOutboundMessage: vi.fn(async (chatId: string, message: any) => { sent.push({ chatId, message }); return { success: true, messageId: '1' }; }),
      dispatchOutboundPhoto: vi.fn(async () => ({ success: true })),
    };
    const res = await createApp({ db, telegramBridge } as any).request(`/v1/tasks/${taskId}/redrive`, { method: 'POST', headers, body: '{}' });
    const body = await res.json();

    expect({ status: res.status, title: body.title, sent }).toEqual({ status: 409, title: 'LEGACY_WORKFLOW_RETIRED', sent: [] });
    const queued = await withRlsContext(db, scope, (trx) => sql`SELECT id FROM hawa.outbox_commands
      WHERE aggregate_id = ${taskId}::uuid AND command_type = 'task.dispatch'`.execute(trx));
    expect(queued.rows).toEqual([]);
  });
});
