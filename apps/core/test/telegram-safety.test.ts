import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext, RevisionRepository } from '@hawa/db';
import { computeActionSignature } from '@hawa/integrations';
import { createApp, evaluateCanvaExportQc } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { resolveQcProfileId } from '../src/services/canva-task-outcome.js';
import { memoryExportStore } from './pinned-exports-fixture.js';
import { checkedCanvaExportFixture } from '../../../packages/testkit/src/canva-export-fixture.js';

/**
 * Telegram safety (architecture programme 0.4, 2026-09-24), against hawa-test-postgres as hawa_app
 * (row-level security as in production): the getUpdates offset lives in Postgres and never moves
 * past an update intake did not accept (the worker's poller since ADR-135); the handlers that
 * deliver, publish and decide read the task's status from Postgres; delivery ignores an approval
 * only Core's memory holds.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const operatorUserId = '00000000-0000-4000-b000-000000000001';
const kaae = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId: operatorUserId, role: 'operator' as const };
const OFFICE = 91000004;
const admin = { 'Content-Type': 'application/json', Authorization: 'Bearer test_admin_key' };
const operator = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
const artDirector = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}` };

const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
  // The test database keeps every run's tasks of the day, so the daily cap on automatic drafts is
  // reached by the tests themselves; it is not what these tests are about.
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(async () => {
  vi.restoreAllMocks();
  // The kill switch is one switch per Core process, shared by every app built in this file.
  await createApp({ db } as any).request('/v1/operations/kill-switch', { method: 'POST', headers: { ...operator, Authorization: 'Bearer test_admin_key' }, body: JSON.stringify({ channel: 'telegram', active: false }) });
  delete process.env.TELEGRAM_BOT_TOKEN;
});
afterAll(async () => {
  process.env = saved;
  await db.destroy();
});

const chatId = () => 60_000_000 + Math.floor(Math.random() * 9_000_000);

// Core's own poller (its getUpdates offset, dead letters after five attempts, "poll now" and its
// pause under the kill switch) was removed by stage 2 of ADR-135. The worker's poller, the only one,
// has the same rules: apps/worker/test/telegram-poller.test.ts and chat-inbox.test.ts.

// The kill switch stops intake at the worker's hand-off (POST /v1/internal/telegram/intake answers
// INTAKE_PAUSED and starts nothing): lifecycle-internal-intake.test.ts. The webhook it used to stop was
// removed by stage 2 of ADR-135.

describe('handlers that act on a task read its status from Postgres', () => {
  const request = async (title: string) =>
    (
      await persistChatIntake(db, {
        platform: 'telegram',
        sourceEventId: randomUUID(),
        sourceChannelId: String(chatId()),
        clientId: kaae,
        title,
        rawText: 'KAAE members evening\n---\nDecember 4, 2026\nErbil',
        designInstructions: '',
        exactCopy: [{ id: 'copy_0', role: 'headline', text: 'KAAE members evening' }],
        autoGenerate: false,
      } as any)
    ).task.id as string;

  /** A Canva draft as the bridge records it: a revision and a passing QC run. */
  const draft = async (taskId: string, headline = 'KAAE members evening') => {
    const checked = await checkedCanvaExportFixture(headline);
    return withRlsContext(db, scope, async (trx) => {
      const revision = await new RevisionRepository(db).createRevision(
        {
          tenantId, taskId, studio: 'canva',
          neutralManifest: { documentId: `DAGsafe${taskId.slice(0, 6)}`, studio: 'canva', width: 1200, height: 1697, nodes: [{ id: 'headline', type: 'text', text: headline }] },
          authorType: 'model', authorId: 'canva_generator', status: 'review',
        } as any,
        trx
      );
      const qc = evaluateCanvaExportQc({
        sha256: createHash('sha256').update(checked.bytes).digest('hex'), format: 'pptx',
        content: checked.bytes, content_check: checked.contentCheck,
      });
      await trx.insertInto('qc_runs').values({
        tenant_id: tenantId, task_id: taskId, design_revision_id: revision.id, qc_profile_id: await resolveQcProfileId(trx, tenantId),
        status: qc.status, critical_pass: qc.criticalPass, report: qc.qaReport as any,
        report_sha256: createHash('sha256').update(JSON.stringify(qc.qaReport)).digest('hex'),
      }).execute();
      return revision.id as string;
    });
  };

  const decide = (app: any, taskId: string, revisionId: string, body: Record<string, unknown>) =>
    app.request(`/v1/tasks/${taskId}/revisions/${revisionId}/decisions`, { method: 'POST', headers: artDirector, body: JSON.stringify(body) });
  const sendBack = (app: any, taskId: string, revisionId: string) =>
    decide(app, taskId, revisionId, { action: 'revision_requested', revisionRequest: { comment: 'The date is wrong' } });
  const dbTask = async (taskId: string) =>
    withRlsContext(db, scope, async (trx) => (await sql<any>`SELECT state, version FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(trx)).rows[0]);

  it('publish: a task another process sent back for changes is not delivered by the Core that approved it', async () => {
    const taskId = await request('KAAE: stale status (publish)');
    const revisionId = await draft(taskId);
    const exports = memoryExportStore();
    const coreA = createApp({ db, deliverableStore: exports.store } as any);
    const coreB = createApp({ db, deliverableStore: exports.store } as any);
    expect((await decide(coreA, taskId, revisionId, { action: 'approve', pinnedExportIds: [exports.add(taskId)] })).status).toBe(201);
    expect((await sendBack(coreB, taskId, revisionId)).status).toBe(201);
    expect((await dbTask(taskId)).state).toBe('revision_requested');

    const res = await coreA.request(`/v1/tasks/${taskId}/publish`, { method: 'POST', headers: operator, body: JSON.stringify({}) });
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.title).toBe('Cannot Publish Unapproved Task');
    expect(body.detail).toContain("'revision_requested'");
  });

  it('approve: a draft recorded behind Core\'s back is the current one, and the one checked', async () => {
    const taskId = await request('KAAE: stale status (approve)');
    const first = await draft(taskId);
    const exports = memoryExportStore();
    const core = createApp({ db, deliverableStore: exports.store } as any);
    // Core reads the task (an answer it refuses still loads it into Core's memory).
    expect((await decide(core, taskId, first, { action: 'nonsense' })).status).toBe(400);
    // The worker records the next draft in Postgres; Core's copy still names the first.
    const second = await draft(taskId, 'KAAE members evening, corrected');

    const approved = await decide(core, taskId, second, { action: 'approve', pinnedExportIds: [exports.add(taskId)] });
    const body = await approved.json();
    expect(`${approved.status} ${body.detail || ''}`).not.toMatch(/Cannot approve stale revision/);
    expect(approved.status).toBe(201);
    expect((await dbTask(taskId)).state).toBe('approved');
    // And the first draft, which Postgres knows is no longer current, is refused as stale.
    const stale = await decide(core, taskId, first, { action: 'approve' });
    expect(stale.status).toBe(409);
  });

  it('delivery: with Postgres unreachable, delivery refuses instead of acting on the status in memory', async () => {
    const taskId = await request('KAAE: stale status (delivery)');
    const revisionId = await draft(taskId);
    const exports = memoryExportStore();
    const exportId = exports.add(taskId, 'png', new TextEncoder().encode('approved KAAE export'));
    const coreDb = createDb(process.env.TEST_DATABASE_URL!);
    const core = createApp({ db: coreDb, deliverableStore: exports.store } as any);
    expect((await decide(core, taskId, revisionId, { action: 'approve', pinnedExportIds: [exportId] })).status).toBe(201);
    const read = vi.spyOn(exports.store, 'read');
    await coreDb.destroy();

    // A signed WhatsApp approve-and-publish reads the task from Postgres before it acts (Core keeps
    // no copy of it since the cleanup step of the app.ts split), so that read refuses first.
    const sig = computeActionSignature(taskId, 'approve');
    const res = await core.request(`/api/webhooks/whatsapp/actions?taskId=${taskId}&action=approve&sig=${sig}&publish=true`);
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.detail).toMatch(/could not be read from the database/);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('delivery ignores an approval that exists only in Core\'s memory', () => {
  it('a memory-only approval cannot trigger delivery', async () => {
    // A Desk task: Core's own delivery refuses a Telegram-origin one before reading any approval
    // (ADR-135 stage 2d), which would hide what this test is about.
    const created = await createApp({ db } as any).request('/v1/tasks', {
      method: 'POST', headers: operator, body: JSON.stringify({ title: 'KAAE: memory-only approval', clientId: kaae }),
    });
    expect(created.status).toBe(201);
    const taskId = (await created.json()).id as string;
    const checked = await checkedCanvaExportFixture('KAAE members evening');
    const revisionId = await withRlsContext(db, scope, async (trx) => {
      const revision = await new RevisionRepository(db).createRevision({
        tenantId, taskId, studio: 'canva',
        neutralManifest: { documentId: `DAGmem${taskId.slice(0, 6)}`, studio: 'canva', width: 1200, height: 1697, nodes: [{ id: 'headline', type: 'text', text: 'KAAE members evening' }] },
        authorType: 'model', authorId: 'canva_generator', status: 'review',
      } as any, trx);
      const qc = evaluateCanvaExportQc({ sha256: createHash('sha256').update(checked.bytes).digest('hex'), format: 'pptx', content: checked.bytes, content_check: checked.contentCheck });
      await trx.insertInto('qc_runs').values({
        tenant_id: tenantId, task_id: taskId, design_revision_id: revision.id, qc_profile_id: await resolveQcProfileId(trx, tenantId),
        status: qc.status, critical_pass: qc.criticalPass, report: qc.qaReport as any,
        report_sha256: createHash('sha256').update(JSON.stringify(qc.qaReport)).digest('hex'),
      }).execute();
      return revision.id as string;
    });
    const exports = memoryExportStore();
    const exportId = exports.add(taskId, 'png', new TextEncoder().encode('approved KAAE export'));
    const core = createApp({ db, deliverableStore: exports.store } as any);
    const approved = await core.request(`/v1/tasks/${taskId}/revisions/${revisionId}/decisions`, {
      method: 'POST', headers: artDirector, body: JSON.stringify({ action: 'approve', pinnedExportIds: [exportId] }),
    });
    expect(approved.status).toBe(201);

    // The approval Postgres holds is taken away, as if its write had never committed; Core's memory
    // still has it. (The table is append-only, so the owner lifts its triggers for this one statement.)
    const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
    try {
      const removed = await owner.transaction().execute(async (trx) => {
        await sql`SET LOCAL session_replication_role = 'replica'`.execute(trx);
        return sql`DELETE FROM hawa.approvals WHERE task_id = ${taskId}::uuid`.execute(trx);
      });
      expect(Number(removed.numAffectedRows)).toBe(1);
    } finally {
      await owner.destroy();
    }
    const read = vi.spyOn(exports.store, 'read');

    const res = await core.request(`/v1/tasks/${taskId}/publish`, { method: 'POST', headers: operator, body: JSON.stringify({}) });
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.detail).toBe('Nothing to deliver: the task has no approval. Approve in the Desk with the captured export selected.');
    expect(read).not.toHaveBeenCalled();
  });
});
