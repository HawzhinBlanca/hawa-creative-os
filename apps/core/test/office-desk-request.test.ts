/**
 * ADR-287: the Desk's "New task" opens a RequestLifecycle request.
 *
 * Until ADR-287 the form saved a designer-owned task (outbox MANUAL_DESK_OWNED) that nothing designed
 * unless someone pressed Generate; 52 of them sat in RECEIVED until 2026-10-02. Now Core admits the
 * request in the office member's scope, makes the request's first projection itself and writes the
 * outbox command the worker forwards to RequestLifecycle, whose own projection call replays it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CanvaBindingRepository, PublicationRepository, createDb, sql, withRlsContext } from '@hawa/db';
import { kaaeClientDNA } from '@hawa/domain';
import { createApp } from '../src/app.js';
import { projectLifecycleDesignOutcome, projectLifecycleOfficeDecision } from '../src/services/lifecycle-projection.js';
import { projectLifecycleDeliveryFinish, projectLifecycleDeliveryStart } from '../src/services/lifecycle-delivery-projection.js';
import { savedDesignCopy, savedDesignCopyLocales } from '../src/services/saved-design-copy.js';
import { openDraft } from '../src/services/lifecycle-open-draft.js';

const db = createDb(process.env.TEST_DATABASE_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const userId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId, role: 'operator' as const };
const token = ['worker', 'desk', 'request', 'fixture'].join('_');
const saved = { ...process.env };
const app = (principal: Record<string, unknown> = { role: 'operator', userId }) => createApp({ db, testAuth: { principal } } as any);

beforeAll(() => {
  process.env.HAWA_WORKER_TOKEN = token;
  process.env.AUTO_GENERATE_CHAT_DESIGNS = 'true';
  process.env.TELEGRAM_ALLOWED_USERS = '75000001';
});
afterAll(async () => { process.env = saved; await db.destroy(); });

async function client(active = true) {
  const id = randomUUID(), name = `Desk client ${id}`;
  await withRlsContext(db, scope, async (trx) => {
    await trx.insertInto('clients').values({ id, tenant_id: tenantId, code: id, name, aliases: [], default_language: 'en',
      retention_policy: {}, model_egress_policy: {}, status: active ? 'active' : 'inactive' }).execute();
    await trx.insertInto('client_dna_versions').values({ id: randomUUID(), tenant_id: tenantId, client_id: id,
      version: 1, status: 'active', content_hash: randomUUID(), dna: { ...kaaeClientDNA, clientId: id, name } }).execute();
  });
  return id;
}

const deskBody = (clientId: string, extra: Record<string, unknown> = {}) => ({
  clientId, title: 'Members evening', priority: 'routine', workflow: 'office_request',
  copyEn: 'Members evening\n\n2 October 2026, 7 pm', copyCkb: 'ئێوارەی ئەندامان',
  description: 'Members evening\n\n2 October 2026, 7 pm\n\nئێوارەی ئەندامان',
  designInstructions: 'Navy and gold.', referenceAssets: 'approved logo',
  source: { platform: 'hawa_desk', externalId: 'operator-desk' }, ...extra,
});

async function post(body: Record<string, unknown>, key = randomUUID(), principal?: Record<string, unknown>) {
  const response = await app(principal).request('/v1/tasks', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function internal(requestId: string, path: string, body: unknown) {
  const response = await createApp({ db } as any).request(`/v1/internal/lifecycle/${requestId}/${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
}

async function recorded(key: string, taskId?: string) {
  return withRlsContext(db, scope, async (trx) => ({
    open: await trx.selectFrom('outbox_commands').selectAll().where('idempotency_key', '=', `office-open:${key}`).execute(),
    created: taskId ? await trx.selectFrom('outbox_commands').selectAll().where('aggregate_id', '=', taskId)
      .where('command_type', '=', 'task.created').execute() : [],
    task: taskId ? await trx.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirst() : undefined,
    event: taskId ? (await sql<{ data: any }>`SELECT data FROM hawa.task_events WHERE task_id = ${taskId}::uuid
      AND event_type = 'task.created'`.execute(trx)).rows[0]?.data : undefined,
  }));
}

describe('Desk "New task" opens a RequestLifecycle request (ADR-287)', () => {
  it('admits the request in one transaction and the worker\'s open replays Core\'s projection', async () => {
    const clientId = await client(), key = randomUUID();
    const first = await post(deskBody(clientId), key);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ clientId, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), clientDnaVersion: 1,
      sourcePlatform: 'hawa_desk' });
    const { requestId, id: taskId } = first.body;
    const rows = await recorded(key, taskId);
    expect(rows.task).toMatchObject({ request_id: requestId, delivery_executor_pin: 'restate', client_id: clientId });
    expect(rows.created).toEqual([expect.objectContaining({ state: 'delivered', last_error: 'OWNED_BY_LIFECYCLE' })]);
    expect(rows.open).toEqual([expect.objectContaining({ aggregate_type: 'request', aggregate_id: requestId,
      command_type: 'office.request.open', state: 'pending' })]);
    const event = (rows.open[0].payload as { event: { draft: Record<string, unknown> } }).event;
    expect(event).toMatchObject({ v: 1, eventId: `open:${requestId}`, requestId, tenantId, chatId: `desk:${userId}`,
      draft: { platform: 'hawa_desk', sourceChannelId: `desk:${userId}`, sourceEventId: `lc-${requestId}-r0`, autoGenerate: true,
        designStudio: true, clientId, copyEn: deskBody(clientId).copyEn, copyCkb: deskBody(clientId).copyCkb } });
    expect(openDraft(JSON.parse(JSON.stringify(event.draft)), requestId)).toEqual(event.draft);
    const request = await withRlsContext(db, scope, (trx) => trx.selectFrom('requests').selectAll()
      .where('request_id', '=', requestId).executeTakeFirstOrThrow());
    expect(request).toMatchObject({ owner: 'restate', stage: 'designing', rev: '1', chat_id: `desk:${userId}`, root_task_id: taskId });

    // The Desk's own fields stay the copy's authority, with their languages (saved-design-copy.ts).
    const source = rows.event.payload;
    expect(source.body).toMatchObject({ workflow: 'office_request', copyEn: deskBody(clientId).copyEn, referenceAssets: 'approved logo' });
    expect(savedDesignCopy(source, '').copy).toEqual([deskBody(clientId).copyEn, deskBody(clientId).copyCkb]);
    expect(savedDesignCopyLocales(source, [deskBody(clientId).copyEn, deskBody(clientId).copyCkb])).toEqual(['en', 'ckb']);
    expect(savedDesignCopy(source, '').instructions).toBe('Navy and gold.');

    // RequestLifecycle's own projection call (the worker sends the draft it was handed) replays it.
    const replayed = await internal(requestId, 'project', { v: 1, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
      ops: [{ kind: 'createRequest', draft: event.draft }] });
    expect(replayed).toMatchObject({ status: 200, body: { v: 1, taskId, stage: 'designing', autoGenerate: true,
      design: { clientId, sourcePlatform: 'hawa_desk', designStudio: true, variant: { width: 1080, height: 1080 } } } });
    const changed = await internal(requestId, 'project', { v: 1, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
      ops: [{ kind: 'createRequest', draft: { ...event.draft, copyEn: 'Something else' } }] });
    expect(changed).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } });

    // The same request saved again answers the same task; another body under the key is refused.
    const again = await post(deskBody(clientId), key);
    expect(again).toMatchObject({ status: 200, body: { id: taskId, requestId, clientDnaVersion: 1 } });
    expect((await post(deskBody(clientId, { title: 'Another title' }), key)).status).toBe(409);
    expect((await recorded(key)).open).toHaveLength(1);
  });

  it('refuses before recording anything: no copy, a client out of scope, a service, a PDF', async () => {
    const inactive = await client(false), clientId = await client();
    const cases: Array<[Record<string, unknown>, number, Record<string, unknown>?]> = [
      [deskBody(clientId, { copyEn: '  ', copyCkb: '' }), 422],
      [deskBody(inactive), 403],
      [deskBody(randomUUID()), 403],
      [deskBody(clientId, { clientId: 'not-a-client' }), 422],
      [deskBody(clientId), 403, { role: 'service' }],
      [deskBody(clientId, { sourceDocument: { blobSha256: 'a'.repeat(64) } }), 422],
    ];
    for (const [body, status, principal] of cases) {
      const key = randomUUID();
      expect((await post(body, key, principal)).status).toBe(status);
      expect((await recorded(key)).open).toEqual([]);
    }
  });

  it('opens nothing for a worker that sends a Desk brief Core never admitted', async () => {
    const clientId = await client(), requestId = randomUUID();
    const draft = { platform: 'hawa_desk', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: `desk:${userId}`,
      rawText: 'Forged', title: 'Forged', designInstructions: '', exactCopy: [], clientId, autoGenerate: true };
    const forged = await internal(requestId, 'project', { v: 1, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
      ops: [{ kind: 'createRequest', draft }] });
    expect(forged).toMatchObject({ status: 409, body: { code: 'UNAUTHORIZED_ACTOR' } });
    const wrongChannel = await internal(requestId, 'project', { v: 1, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
      ops: [{ kind: 'createRequest', draft: { ...draft, sourceChannelId: '75000001' } }] });
    expect(wrongChannel.status).toBe(400);
    const requests = await withRlsContext(db, scope, (trx) => trx.selectFrom('requests').select('request_id')
      .where('request_id', '=', requestId).execute());
    expect(requests).toEqual([]);
  });

  it('opens for a designer when automatic drafts are off, and never asks the Desk a question', async () => {
    const clientId = await client();
    process.env.AUTO_GENERATE_CHAT_DESIGNS = 'false';
    const manual = await post(deskBody(clientId));
    process.env.AUTO_GENERATE_CHAT_DESIGNS = 'true';
    expect(manual.status).toBe(201);
    const manualRequest = await withRlsContext(db, scope, (trx) => trx.selectFrom('requests').select('stage')
      .where('request_id', '=', manual.body.requestId).executeTakeFirstOrThrow());
    expect(manualRequest.stage).toBe('manual');

    const opened = await post(deskBody(clientId, { title: 'Question case' }));
    const { requestId, id: taskId } = opened.body;
    const runId = randomUUID();
    await withRlsContext(db, scope, async (trx) => {
      const stages = { directed: { refused: 'NEEDS_CLARIFICATION', clarify: { ask: 'less space', question: 'Fill the space with what?',
        options: ['bigger title text', 'bigger logo'] } } };
      await sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status, stages)
        VALUES (${runId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, 'test', ${randomUUID()}, 'h', '{}'::jsonb, 'standard', 'failed',
          ${JSON.stringify(stages)}::jsonb)`.execute(trx);
    });
    const outcome = await projectLifecycleDesignOutcome(db, { requestId, tenantId, taskId, runId: `dr-${taskId}`, expectedRev: 1, rev: 2,
      key: `${requestId}:2:designFinished:dr-${taskId}`, report: { status: 'DESIGN_FAILED', code: 'NEEDS_CLARIFICATION', runId } });
    expect(outcome).toMatchObject({ stage: 'manual' });
    expect(outcome.question).toBeUndefined();
  });

  it('is delivered on its archive and Sheet receipts, with no file sent to the Desk channel', async () => {
    const clientId = await client();
    const opened = await post(deskBody(clientId, { title: 'Delivery case' }));
    const { requestId, id: taskId } = opened.body;
    const designId = `DA${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await withRlsContext(db, scope, (trx) => new CanvaBindingRepository(trx).createBinding({ tenantId, taskId, clientId,
      canvaDesignId: designId, editUrl: `https://www.canva.com/design/${designId}/edit` }, trx));
    const designed = await projectLifecycleDesignOutcome(db, { requestId, tenantId, taskId, runId: `dr-${taskId}`, expectedRev: 1, rev: 2,
      key: `${requestId}:2:designFinished:dr-${taskId}`, report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId } });
    expect(designed.stage).toBe('in_review');
    const revisionId = designed.revisionId!;
    const bytes = Buffer.from(`Desk deck ${randomUUID()}`), artifactId = randomUUID();
    const sha256 = createHash('sha256').update(bytes).digest('hex'), qcRunId = randomUUID();
    const report = { exportArtifactId: artifactId, exportSha256: sha256, captureVersion: '300' };
    const reportHash = createHash('sha256').update(JSON.stringify(report)).digest('hex');
    await withRlsContext(db, scope, async (trx) => {
      const binding = await trx.selectFrom('canva_bindings').select(['canva_design_id', 'version'])
        .where('tenant_id', '=', tenantId).where('task_id', '=', taskId).executeTakeFirstOrThrow();
      const firstQc = await trx.selectFrom('qc_runs').select('qc_profile_id')
        .where('tenant_id', '=', tenantId).where('design_revision_id', '=', revisionId).executeTakeFirstOrThrow();
      const operationId = randomUUID();
      await sql`INSERT INTO hawa.canva_remote_operations
        (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata)
        VALUES (${operationId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, ${userId}, ${`deliver-${operationId}`},
          ${sha256}, 'export', 'retrieved', ${binding.canva_design_id}, ${binding.version},
          ${JSON.stringify({ format: 'pptx', designUpdatedAt: '300' })}::jsonb)`.execute(trx);
      await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content)
        VALUES (${artifactId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, ${operationId}::uuid, 'pptx', ${sha256}, ${bytes})`.execute(trx);
      await sql`INSERT INTO hawa.qc_runs (id, tenant_id, task_id, design_revision_id, qc_profile_id, attempt, status, critical_pass,
          report, report_sha256, started_at)
        VALUES (${qcRunId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${revisionId}::uuid, ${firstQc.qc_profile_id}::uuid, 2, 'passed', true,
          ${JSON.stringify(report)}::jsonb, ${reportHash}, clock_timestamp() + interval '1 minute')`.execute(trx);
    });
    const actionId = randomUUID();
    const approval = await projectLifecycleOfficeDecision(db, { requestId, tenantId, taskId, revisionId, actionId,
      actor: { userId, role: 'art_director' }, reason: 'Checked export', decision: 'approved', expectedRev: 2, rev: 3,
      key: `${requestId}:3:officeDecision:desk:${actionId}`, deskRequestFingerprint: 'b'.repeat(64),
      approvalProof: { qcRunId, qcReportHash: reportHash, pinnedExports: [{ artifactId, format: 'pptx', sha256, byteSize: bytes.length }] } });
    const store = { captureEvidenceRequired: true,
      verifyCurrentSource: async () => ({ ok: true as const, capturedVersion: '200', observedVersion: '200' }),
      read: async (_tenant: string, _user: string, _task: string, id: string) => id === artifactId ? bytes : null,
      find: async () => [{ artifactId, format: 'pptx' as const, sha256, byteSize: bytes.length }] };
    const deliverAction = randomUUID();
    const claim = await projectLifecycleDeliveryStart(db, store, { requestId, tenantId, taskId, revisionId, approvalId: approval.approvalId,
      actionId: deliverAction, actor: { userId, role: 'art_director' }, reason: 'Deliver approved files',
      expectedRev: 3, rev: 4, key: `${requestId}:4:officeDecision:desk:${deliverAction}` });
    expect(claim.delivery.chatId).toBe(`desk:${userId}`);
    await withRlsContext(db, scope, async (trx) => {
      const publication = await trx.selectFrom('publications').select(['id', 'package_manifest', 'package_sha256'])
        .where('tenant_id', '=', tenantId).where('task_id', '=', taskId).executeTakeFirstOrThrow();
      const repo = new PublicationRepository(trx);
      for (const file of publication.package_manifest.files as Array<{ name: string; sha256: string; size: number }>) {
        await repo.recordDriveRef({ tenantId, publicationId: publication.id, sharedDriveId: 'fixture-drive', folderId: `folder-${taskId}`,
          fileId: randomUUID(), fileName: file.name, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          expectedSha256: file.sha256, observedSize: file.size, status: 'verified' }, trx);
      }
      await repo.recordSheetSync({ tenantId, publicationId: publication.id, spreadsheetId: 'fixture-sheet', sheetId: 0, taskId,
        rowKey: taskId, rowNumber: 1, expectedHash: publication.package_sha256, observedHash: publication.package_sha256, status: 'synced' }, trx);
    });
    const finish = { requestId, tenantId, taskId, approvalId: approval.approvalId, deliveryId: claim.delivery.deliveryId, run: 1,
      outcome: { outcome: 'delivered' as const, uncertain: [], archived: true, sheetsConfirmed: true, filesSent: 0 },
      expectedRev: 4, rev: 5, key: `${requestId}:5:deliveryFinished:${claim.delivery.deliveryId}` };
    expect(await projectLifecycleDeliveryFinish(db, finish)).toMatchObject({ stage: 'delivered', taskState: 'complete' });
  });
});
