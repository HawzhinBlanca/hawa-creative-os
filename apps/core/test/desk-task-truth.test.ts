import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext, RevisionRepository } from '@hawa/db';
import { createApp, evaluateCanvaExportQc } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { askLedger } from '../src/services/ask-ledger.js';
import { resolveQcProfileId } from '../src/services/canva-task-outcome.js';
import { memoryExportStore } from './pinned-exports-fixture.js';
import { checkedCanvaExportFixture } from '../../../packages/testkit/src/canva-export-fixture.js';

/**
 * Bug hunt (2026-09-24): what Core tells the Desk about a real request, and what the Desk lets an
 * art director approve. Runs against hawa-test-postgres as hawa_app (row-level security as in
 * production). Each task is recorded the way production records a Canva draft: a design revision
 * whose manifest carries the planner's width and height, and a QC run whose report is
 * evaluateCanvaExportQc's own output for a PPTX whose copy, font and RTL checks passed.
 */
describe('Desk task reads and approvals (PostgreSQL)', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  const scope = { tenantId, userId: operatorUserId, role: 'operator' as const };
  const operator = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
  const artDirector = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}` };
  const exports = memoryExportStore();
  afterAll(() => db.destroy());

  const channel = () => String(7_000_000_000 + Math.floor(Math.random() * 999_999_999));

  const request = async (title: string, studioOptions?: Record<string, unknown>) => {
    const predecessorId = studioOptions?.parentTaskId;
    const sourceChannelId = typeof predecessorId === 'string'
      ? await withRlsContext(db, scope, async (trx) => (await sql<{ chat: string }>`
          SELECT o.payload->>'sourceChannelId' AS chat FROM hawa.outbox_commands o
          WHERE o.tenant_id = ${tenantId}::uuid AND o.aggregate_id = ${predecessorId}::uuid
            AND o.command_type = 'task.created'`.execute(trx)).rows[0].chat)
      : channel();
    return (
      await persistChatIntake(db, {
        platform: 'telegram',
        sourceEventId: randomUUID(),
        sourceChannelId,
        clientId: kaae,
        title,
        rawText: 'KAAE members evening\n---\nDecember 4, 2026\nErbil',
        designInstructions: '',
        exactCopy: [{ id: 'copy_0', role: 'headline', text: 'KAAE members evening' }],
        autoGenerate: false,
        ...(studioOptions ? { studioOptions } : {}),
      } as any)
    ).task.id as string;
  };

  /** A Canva draft as the bridge records it: revision (planner manifest: 1200x1697) and a passing QC run. */
  const draft = async (taskId: string, headline = 'KAAE members evening') => {
    const checked = await checkedCanvaExportFixture(headline);
    return withRlsContext(db, scope, async (trx) => {
      const revision = await new RevisionRepository(db).createRevision(
        {
          tenantId,
          taskId,
          studio: 'canva',
          neutralManifest: {
            documentId: `DAGhunt${taskId.slice(0, 6)}`,
            studio: 'canva',
            width: 1200,
            height: 1697,
            nodes: [{ id: 'headline', type: 'text', text: headline }],
          },
          authorType: 'model',
          authorId: 'canva_generator',
          status: 'review',
        } as any,
        trx
      );
      const qc = evaluateCanvaExportQc({
        sha256: createHash('sha256').update(checked.bytes).digest('hex'),
        format: 'pptx',
        content: checked.bytes,
        content_check: checked.contentCheck,
      });
      await trx
        .insertInto('qc_runs')
        .values({
          tenant_id: tenantId,
          task_id: taskId,
          design_revision_id: revision.id,
          qc_profile_id: await resolveQcProfileId(trx, tenantId),
          status: qc.status,
          critical_pass: qc.criticalPass,
          report: qc.qaReport as any,
          report_sha256: createHash('sha256').update(JSON.stringify(qc.qaReport)).digest('hex'),
        })
        .execute();
      return { revisionId: revision.id as string, qc };
    });
  };

  const approve = (app: any, taskId: string, revisionId: string) =>
    app.request(`/v1/tasks/${taskId}/revisions/${revisionId}/decisions`, {
      method: 'POST',
      headers: artDirector,
      body: JSON.stringify({ action: 'approve', reason: 'Checked in the Desk', pinnedExportIds: [exports.add(taskId)] }),
    });

  describe('GET /tasks/:id and GET /tasks (the Work screen reads these)', () => {
    it('reports the checks the QC never measured (safe margins, contrast) as not measured, not as passed', async () => {
      const taskId = await request('KAAE: members evening (QA read)');
      const { qc } = await draft(taskId);
      expect(qc.qaReport.safeMargins).toBeNull(); // what was stored: "null = this evaluator did not measure it"
      expect(qc.qaReport.contrastCompliant).toBeNull();

      const app = createApp({ db, deliverableStore: exports.store } as any);
      const detail = await (await app.request(`/v1/tasks/${taskId}`, { headers: operator })).json();
      const list = await (await app.request('/v1/tasks?limit=200', { headers: operator })).json();
      const listed = list.items.find((t: any) => t.id === taskId);

      // The Desk's QA tab draws true as a green tick: "All text nodes maintain minimum 32px safe
      // margins away from artboard edges" and "Observed contrast ratio meets ... standards".
      expect({ detail: detail.qaReport.safeMargins, list: listed.qaReport.safeMargins }).toEqual({ detail: null, list: null });
      expect({ detail: detail.qaReport.contrastCompliant, list: listed.qaReport.contrastCompliant }).toEqual({ detail: null, list: null });
    });

    it("reports the design's recorded size, not an invented 1080 x 1350", async () => {
      const taskId = await request('KAAE: members evening (size read)');
      await draft(taskId);
      const app = createApp({ db, deliverableStore: exports.store } as any);
      const detail = await (await app.request(`/v1/tasks/${taskId}`, { headers: operator })).json();
      // VectorInspector prints this as "<w> × <h> px · recorded dimensions".
      expect(detail.latestRevision.dimensions).toEqual({ width: 1200, height: 1697 });
    });

    it("serves the task's history the Desk's History & Audit tab reads (GET /tasks/:id/timeline)", async () => {
      const taskId = await request('KAAE: members evening (history read)');
      await draft(taskId);
      const app = createApp({ db, deliverableStore: exports.store } as any);
      const timeline = await (await app.request(`/v1/tasks/${taskId}/timeline`, { headers: operator })).json();
      expect(JSON.stringify(timeline)).toContain('task.created');
    });

    it('does not report an approval that no longer holds as the current approval (approved, then sent back for changes)', async () => {
      const taskId = await request('KAAE: members evening (approval then change)');
      const { revisionId } = await draft(taskId);
      expect((await approve(createApp({ db, deliverableStore: exports.store } as any), taskId, revisionId)).status).toBe(201);
      // The art director spots a typo after approving and presses Request Revision, as the Desk sends it.
      const sentBack = await createApp({ db, deliverableStore: exports.store } as any).request(`/v1/tasks/${taskId}/revisions/${revisionId}/decisions`, {
        method: 'POST',
        headers: artDirector,
        body: JSON.stringify({ action: 'revision_requested', revisionRequest: { comment: 'The date is wrong: 4 December, not 14' } }),
      });
      expect(sentBack.status).toBe(201);

      const detail = await (await createApp({ db, deliverableStore: exports.store } as any).request(`/v1/tasks/${taskId}`, { headers: operator })).json();
      expect(detail.status).toBe('REVISION_REQUESTED');
      // The Desk checks latestApproval before the status: pill "APPROVED", "Deliver Approved Files" enabled.
      expect(detail.latestApproval).toBeUndefined();
    });
  });

  describe('after Request Revision in the Desk', () => {
    it('the reworked design can be approved again: the refusal does not name a newer revision that does not exist', async () => {
      const taskId = await request('KAAE: members evening (Desk change)');
      const { revisionId } = await draft(taskId);
      const sentBack = await createApp({ db, deliverableStore: exports.store } as any).request(`/v1/tasks/${taskId}/revisions/${revisionId}/decisions`, {
        method: 'POST',
        headers: artDirector,
        body: JSON.stringify({ action: 'revision_requested', revisionRequest: { comment: 'Make the Kurdish headline bigger' } }),
      });
      expect(sentBack.status).toBe(201);
      // The designer edits the Canva design and presses Capture for Review: that stores an export and
      // creates no revision (WorkScreen handleCaptureForReview), so the Desk approves the same revision.
      const res = await approve(createApp({ db, deliverableStore: exports.store } as any), taskId, revisionId);
      const body = await res.json();
      expect(`${res.status} ${body.detail}`).not.toMatch(/replaced by a newer revision/);
    });

    it('a new revision can be recorded for a task that was approved before (createRevision after an approval)', async () => {
      const taskId = await request('KAAE: members evening (revision after approval)');
      const { revisionId } = await draft(taskId);
      expect((await approve(createApp({ db, deliverableStore: exports.store } as any), taskId, revisionId)).status).toBe(201);
      // createRevision appends approval.invalidated and design.revision_created with the same aggregate_version.
      await expect(draft(taskId, 'KAAE members evening, corrected')).resolves.toMatchObject({ revisionId: expect.any(String) });
    });
  });

  describe('the Desk hears when a draft arrives (GET /events/stream)', () => {
    /** The events naming `taskId` on the Desk's live stream while `notify` is posted, and the status after. */
    const eventsDuring = async (taskId: string, notify: Record<string, unknown>) => {
      const telegramBridge = { dispatchOutboundMessage: async () => ({ success: true }), dispatchOutboundPhoto: async () => ({ success: true }) };
      const app = createApp({ db, telegramBridge, deliverableStore: exports.store } as any);
      const stream = await app.request('/v1/events/stream', { headers: operator });
      expect(stream.status).toBe(200);
      const reader = stream.body!.getReader();
      let seen = '';
      const pump = (async () => {
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done) return;
          seen += new TextDecoder().decode(value);
        }
      })();
      const res = await app.request(`/v1/tasks/${taskId}/notifications/canva-status`, {
        method: 'POST',
        headers: operator,
        body: JSON.stringify({ ...notify, notifyRequester: false }),
      });
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 300));
      await reader.cancel().catch(() => undefined);
      await pump;
      const status = (await (await app.request(`/v1/tasks/${taskId}`, { headers: operator })).json()).status;
      const events = seen.split('\n\n').filter((block) => block.includes(taskId)).map((block) => /event: (\S+)/.exec(block)?.[1]);
      return { status, events };
    };
    const beingMade = async (title: string) => {
      const taskId = await request(title);
      await withRlsContext(db, scope, (trx) => sql`UPDATE hawa.tasks SET state = 'studio_composition' WHERE id = ${taskId}::uuid`.execute(trx));
      return taskId;
    };

    it('control: a run that ended with no draft is broadcast (OPERATOR_REQUIRED)', async () => {
      const { status, events } = await eventsDuring(await beingMade('KAAE: members evening (live, failed)'), { status: 'GENERATION_FAILED' });
      expect(status).toBe('OPERATOR_REQUIRED');
      expect(events).toContain('task:transitioned');
    });

    it('broadcasts the move to review when a Canva draft is delivered for a task being made', async () => {
      const { status, events } = await eventsDuring(await beingMade('KAAE: members evening (live, draft)'), {
        status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW',
        designId: 'DAGhuntLive01',
      });
      expect(status).toBe('AWAITING_APPROVAL'); // the task did move
      // The Desk updates a card only on task:transitioned (WorkScreen); nothing names this task.
      expect(events).toContain('task:transitioned');
    });
  });

  describe("approving a design whose requester asked for a change (POST /tasks/:id/revisions/:rev/decisions)", () => {
    it('refuses while the change waits for the requester to answer a question (the change task is paused)', async () => {
      const design = await request('KAAE: members evening (question pending)');
      const { revisionId } = await draft(design);
      const change = await request('KAAE: members evening (Revision)', { parentTaskId: design, revisionDirective: 'less empty space', revisionRound: 1 });
      await withRlsContext(db, scope, async (trx) => {
        await sql`UPDATE hawa.tasks SET state = 'paused' WHERE id = ${change}::uuid`.execute(trx);
        const stages = { directed: { refused: 'NEEDS_CLARIFICATION', asks: [{ ask: 'less empty space', status: 'asked' }], clarify: { ask: 'less empty space', question: 'Fill the space with what?', options: ['bigger title text', 'bigger logo'] } } };
        await sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status, stages)
          VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${change}::uuid, ${kaae}::uuid, 'test', ${randomUUID()}, 'h', '{}'::jsonb, 'standard', 'failed', ${JSON.stringify(stages)}::jsonb)`.execute(trx);
      });

      const res = await approve(createApp({ db, deliverableStore: exports.store } as any), design, revisionId);
      // 201: the version without "less empty space" is approved and can be delivered.
      expect(res.status).toBe(409);
    });

    it('refuses while the change is saved but not yet started (no run: queued, or over the daily cap for the art director)', async () => {
      const design = await request('KAAE: members evening (change queued)');
      const { revisionId } = await draft(design);
      await request('KAAE: members evening (Revision)', { parentTaskId: design, revisionDirective: 'make the logo bigger', revisionRound: 1 });

      const res = await approve(createApp({ db, deliverableStore: exports.store } as any), design, revisionId);
      expect(res.status).toBe(409);
    });

    it("shows the pending change on the ask ledger of the design being approved", async () => {
      const design = await request('KAAE: members evening (ledger of the approved design)');
      await draft(design);
      const change = await request('KAAE: members evening (Revision)', { parentTaskId: design, revisionDirective: 'make the logo bigger', revisionRound: 1 });

      const onDesign = await askLedger(db, scope, design);
      const onChange = await askLedger(db, scope, change);
      expect(onChange.some((r) => r.directive === 'make the logo bigger')).toBe(true); // the change's own ledger has it
      // The design's ledger walks only up the chain, so the Desk shows no ledger at all on it.
      expect(onDesign.some((r) => r.directive === 'make the logo bigger')).toBe(true);
    });
  });
});
