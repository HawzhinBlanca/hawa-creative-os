/**
 * ADR-230: a delivery that reached the requester in the chat but was not archived closes its request.
 *
 * Live test 2026-10-01 (L3): the office Google account is not connected, so every Telegram delivery
 * ends `chat_only` (both files and the final notice confirmed by Telegram, nothing in Drive). Core kept
 * such a request `delivering` (task publishing, error REQUESTER_SEND_UNCONFIRMED) for good: status said
 * "is being sent to you now" hours later, and a redo reply to the final message was refused as "a
 * delivery had already started" (request 95eeb08d).
 *
 * Core still decides from its own stored receipts, never the worker's numbers: Telegram's send marks for
 * every approved file and the notice. The missing archive is recorded as ARCHIVE_PENDING, the
 * publication stays open for an archive later, and requests already stuck are repaired, through the
 * signed office gateway and RequestLifecycle, by scripts/repair_chat_only_delivery.ts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { deliveryBaseId, type DeliveryOutcome } from '@hawa/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CanvaBindingRepository, createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { projectLifecycleDesignOutcome, projectLifecycleOfficeDecision, projectLifecycleOpen } from '../src/services/lifecycle-projection.js';
import { projectLifecycleDeliveryFinish, projectLifecycleDeliveryStart } from '../src/services/lifecycle-delivery-projection.js';
import { checkSignedDeliveryReconcile } from '../../worker/src/lifecycle/office-decision-gateway.js';
import { coreInternalFromEnv } from '../../worker/src/lifecycle/delivery.js';
import { recordDeliveryFinished, reconcileDelivery, type AutomaticLifecycleState, type AutomaticOpenContext,
  type LifecycleState } from '../../worker/src/lifecycle/request-lifecycle.js';
import { repairChatOnlyDelivery } from '../../../scripts/repair_chat_only_delivery.js';

const db = createDb(process.env.TEST_DATABASE_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-b000-000000000001';
const secret = ['chat', 'only', 'delivery', 'fixture'].join('_');
const ingress = 'http://restate.chat-only-fixture:8080';
const scope = { tenantId, userId, role: 'operator' as const };
const saved = { ...process.env };
beforeAll(() => { process.env.HAWA_WORKER_TOKEN = secret; process.env.RESTATE_INGRESS_URL = ingress; });
afterAll(async () => { process.env = saved; await db.destroy(); });

/** An approved request with two pinned files, its delivery claimed (request rev 4, task publishing). */
async function deliveringRequest() {
  const requestId = randomUUID();
  const chat = 77_000_000 + Math.floor(Math.random() * 8_000_000);
  process.env.TELEGRAM_ALLOWED_USERS = String(chat + 1);
  const opened = await projectLifecycleOpen(db, {
    requestId, tenantId, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
    draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: String(chat),
      rawText: 'KAAE K-12 Pilot Study', title: 'KAAE K-12 Pilot Study', designInstructions: 'Use exact copy',
      exactCopy: ['KAAE K-12 Pilot Study'], clientId, autoGenerate: true, designStudio: false },
  });
  const taskId = opened.taskId;
  const designId = `DA${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await withRlsContext(db, scope, (trx) => new CanvaBindingRepository(trx).createBinding({ tenantId, taskId, clientId,
    canvaDesignId: designId, editUrl: `https://www.canva.com/design/${designId}/edit` }, trx));
  const runId = `dr-${taskId}`;
  const designed = await projectLifecycleDesignOutcome(db, { requestId, tenantId, taskId, runId, expectedRev: 1, rev: 2,
    key: `${requestId}:2:designFinished:${runId}`, report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId } });
  const revisionId = designed.revisionId!;
  const files = ['png', 'pptx'].map((format) => {
    const bytes = Buffer.from(`${format} of ${taskId}`);
    return { format, bytes, artifactId: randomUUID(), sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const qcRunId = randomUUID();
  const report = { exportArtifactId: files[1].artifactId, exportSha256: files[1].sha256, captureVersion: '300' };
  const reportHash = createHash('sha256').update(JSON.stringify(report)).digest('hex');
  await withRlsContext(db, scope, async (trx) => {
    const binding = await trx.selectFrom('canva_bindings').select(['canva_design_id', 'version'])
      .where('tenant_id', '=', tenantId).where('task_id', '=', taskId).executeTakeFirstOrThrow();
    const firstQc = await trx.selectFrom('qc_runs').select('qc_profile_id')
      .where('tenant_id', '=', tenantId).where('design_revision_id', '=', revisionId).executeTakeFirstOrThrow();
    for (const file of files) {
      const operationId = randomUUID();
      await sql`INSERT INTO hawa.canva_remote_operations
        (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata)
        VALUES (${operationId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, ${userId}, ${`deliver-${operationId}`},
          ${file.sha256}, 'export', 'retrieved', ${binding.canva_design_id}, ${binding.version},
          ${JSON.stringify({ format: file.format, designUpdatedAt: '300' })}::jsonb)`.execute(trx);
      await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content)
        VALUES (${file.artifactId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, ${operationId}::uuid,
          ${file.format}, ${file.sha256}, ${file.bytes})`.execute(trx);
    }
    await sql`INSERT INTO hawa.qc_runs (id, tenant_id, task_id, design_revision_id, qc_profile_id, attempt, status, critical_pass,
        report, report_sha256, started_at)
      VALUES (${qcRunId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${revisionId}::uuid, ${firstQc.qc_profile_id}::uuid, 2, 'passed', true,
        ${JSON.stringify(report)}::jsonb, ${reportHash}, clock_timestamp() + interval '1 minute')`.execute(trx);
  });
  const actionId = randomUUID();
  const approval = await projectLifecycleOfficeDecision(db, { requestId, tenantId, taskId, revisionId, actionId,
    actor: { userId, role: 'art_director' }, reason: 'Checked export', decision: 'approved', expectedRev: 2, rev: 3,
    key: `${requestId}:3:officeDecision:desk:${actionId}`, deskRequestFingerprint: 'b'.repeat(64),
    approvalProof: { qcRunId, qcReportHash: reportHash,
      pinnedExports: files.map((f) => ({ artifactId: f.artifactId, format: f.format as 'png' | 'pptx', sha256: f.sha256, byteSize: f.bytes.length })) } });
  const store = { captureEvidenceRequired: true,
    verifyCurrentSource: async () => ({ ok: true as const, capturedVersion: '200', observedVersion: '200' }),
    read: async (_t: string, _u: string, _task: string, id: string) => files.find((f) => f.artifactId === id)?.bytes ?? null,
    find: async () => files.map((f) => ({ artifactId: f.artifactId, format: f.format as 'png' | 'pptx', sha256: f.sha256, byteSize: f.bytes.length })) };
  const deliverAction = randomUUID();
  const claim = await projectLifecycleDeliveryStart(db, store, { requestId, tenantId, taskId, revisionId,
    approvalId: approval.approvalId, actionId: deliverAction, actor: { userId, role: 'art_director' }, reason: 'Deliver approved files',
    expectedRev: 3, rev: 4, key: `${requestId}:4:officeDecision:desk:${deliverAction}` });
  const state = { v: 1, requestId, tenantId, chatId: String(chat), owner: 'restate', stage: 'delivering', rev: 4, taskId,
    openEventId: `open:${requestId}`, openSha256: 'a'.repeat(64), runId, lang: 'en', title: 'KAAE K-12 Pilot Study',
    designInput: { v: 1, lifecycle: { requestId, round: 0, runId }, taskId, tenantId, clientId, rawText: 'x', sourcePlatform: 'telegram',
      idempotencyKey: `lifecycle:${requestId}:${taskId}`, canvaAutoGenerate: true, designStudio: false },
    officeRevision: { eventId: `desk:${actionId}`, sha256: 'c'.repeat(64), actionId, revisionId, approvalId: approval.approvalId, kind: 'approve' },
    delivery: { startEventId: `desk:${deliverAction}`, startSha256: 'd'.repeat(64), actionId: deliverAction, input: claim.delivery },
  } as unknown as AutomaticLifecycleState;
  return { requestId, taskId, chat, files, approvalId: approval.approvalId, delivery: claim.delivery, state };
}

/** Telegram's send marks as TelegramSender records them: each file, then the notice. */
async function sendMarks(taskId: string, approvalId: string, files: Array<{ artifactId: string }>, notice: 'sent' | 'uncertain' = 'sent') {
  const base = deliveryBaseId(taskId, approvalId);
  await withRlsContext(db, scope, async (trx) => {
    const mark = async (key: string, kind: string, outcome: string, messageId?: string) => sql`INSERT INTO hawa.inbox_events
        (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified, received_at)
      VALUES (${tenantId}::uuid, 'telegram_delivery', ${`lc:${key}:send`}, ${`telegram_${kind}_${outcome}`},
        ${JSON.stringify({ outcome, ...(messageId ? { messageId } : {}) })}::jsonb, ${`lc:${key}:send:${outcome}`}, true, clock_timestamp())`.execute(trx);
    for (const [index, file] of files.entries()) {
      await mark(`${base}:file:${file.artifactId}`, 'document', 'attempted');
      await mark(`${base}:file:${file.artifactId}`, 'document', 'sent', String(676 + index));
    }
    await mark(`${base}:notice`, 'message', 'attempted');
    await mark(`${base}:notice`, 'message', notice, notice === 'sent' ? '678' : undefined);
  });
}

const CHAT_ONLY: DeliveryOutcome = { outcome: 'chat_only', uncertain: [], archived: false, sheetsConfirmed: false, filesSent: 2 };
const finishOf = (r: Awaited<ReturnType<typeof deliveringRequest>>, outcome: DeliveryOutcome = CHAT_ONLY) => ({
  requestId: r.requestId, tenantId, taskId: r.taskId, approvalId: r.approvalId, deliveryId: r.delivery.deliveryId, run: 1,
  outcome, expectedRev: 4, rev: 5, key: `${r.requestId}:5:deliveryFinished:${r.delivery.deliveryId}` });
const rows = (requestId: string, taskId: string) => withRlsContext(db, scope, async (trx) => ({
  request: await trx.selectFrom('requests').select(['stage', 'rev']).where('request_id', '=', requestId).executeTakeFirstOrThrow(),
  task: await trx.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow(),
  publication: await trx.selectFrom('publications').select(['state', 'error_class', 'error_detail', 'executor_finished_run'])
    .where('task_id', '=', taskId).executeTakeFirstOrThrow(),
}));

/** RequestLifecycle in memory, with Core through the worker's own client and Core's internal routes. */
function requestObject(initial: LifecycleState) {
  let state: LifecycleState | null = initial;
  const app = createApp({ db } as any);
  const core = coreInternalFromEnv((async (url: string, init: RequestInit) => app.request(url, init)) as unknown as typeof fetch);
  const ctx: AutomaticOpenContext = { key: initial.requestId, get: async () => state, run: async (_n, action) => action(),
    set: (_n, value) => { state = value; }, send: () => { throw new Error('nothing is sent'); },
    startDesign: () => { throw new Error('no design starts'); } };
  return { ctx, core, state: () => state as AutomaticLifecycleState };
}

describe('a chat-only delivery delivers the request (ADR-230, L3)', () => {
  it('every file and the notice confirmed by Telegram, no archive: delivered, task complete, the archive recorded as pending', async () => {
    const r = await deliveringRequest();
    await sendMarks(r.taskId, r.approvalId, r.files);
    const object = requestObject(r.state);
    const reply = await recordDeliveryFinished(object.ctx, object.core, { v: 1, eventId: `delivery:${r.delivery.deliveryId}`,
      requestId: r.requestId, taskId: r.taskId, approvalId: r.approvalId, deliveryId: r.delivery.deliveryId, run: 1, expectedRev: 4, outcome: CHAT_ONLY });
    expect(reply).toMatchObject({ stage: 'delivered', taskState: 'complete', rev: 5 });
    expect(object.state()).toMatchObject({ stage: 'delivered', rev: 5 });
    const after = await rows(r.requestId, r.taskId);
    expect(after.request).toEqual({ stage: 'delivered', rev: '5' });
    expect(after.task.state).toBe('complete');
    // Not REQUESTER_SEND_UNCONFIRMED: the sends were confirmed; the archive is what is missing, and the
    // publication stays open (not complete) for an archive later.
    expect(after.publication).toMatchObject({ state: 'pending', error_class: 'ARCHIVE_PENDING', executor_finished_run: 1 });
    expect(JSON.parse(String(after.publication.error_detail))).toEqual(CHAT_ONLY);
    // A replay of the same report answers the same.
    expect(await projectLifecycleDeliveryFinish(db, finishOf(r))).toMatchObject({ stage: 'delivered', rev: 5 });
    // The requester's status says delivered, not "being sent to you now".
    const status = await createApp({ db, requesterIntentModel: null } as any).request('/v1/internal/telegram/intake', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ v: 1, mode: 'lifecycle', languageSiblings: true, update: { update_id: 1_900_000_000 + Math.floor(Math.random() * 9_000_000),
        message: { message_id: 901, from: { id: 5150, is_bot: false, first_name: 'Owner' }, chat: { id: r.chat, type: 'private' },
          date: 1790000000, text: "what's the status of my designs?" } } }) });
    expect((await status.json() as any).chatAnswer.text).toBe('<b>KAAE K-12 Pilot Study</b> has been delivered.');
  });

  it('the worker\'s numbers alone close nothing: a notice Telegram did not confirm keeps it unconfirmed', async () => {
    const r = await deliveringRequest();
    await sendMarks(r.taskId, r.approvalId, r.files, 'uncertain');
    expect(await projectLifecycleDeliveryFinish(db, finishOf(r))).toMatchObject({ stage: 'delivering', taskState: 'publishing' });
    expect((await rows(r.requestId, r.taskId)).publication.error_class).toBe('REQUESTER_SEND_UNCONFIRMED');
  });

  it('a report of fewer files than were approved closes nothing', async () => {
    const r = await deliveringRequest();
    await sendMarks(r.taskId, r.approvalId, r.files);
    expect(await projectLifecycleDeliveryFinish(db, finishOf(r, { ...CHAT_ONLY, filesSent: 1 }))).toMatchObject({ stage: 'delivering' });
  });
});

describe('the repair of a request already stuck "being delivered" (ADR-230)', () => {
  /** The state production is in: finished chat-only under the old rule (before the marks were read). */
  async function stuck(outcome: DeliveryOutcome = CHAT_ONLY, marks: 'sent' | 'uncertain' | 'none' = 'sent') {
    const r = await deliveringRequest();
    const old = await projectLifecycleDeliveryFinish(db, finishOf(r, outcome));
    expect(old).toMatchObject({ stage: 'delivering', taskState: 'publishing', rev: 5 });
    if (marks !== 'none') await sendMarks(r.taskId, r.approvalId, r.files, marks);
    const state = { ...r.state, rev: 5, delivery: { ...r.state.delivery!, finishEventId: `delivery:${r.delivery.deliveryId}`,
      finishSha256: 'e'.repeat(64), finishResult: { accepted: true, requestId: r.requestId, taskId: r.taskId, approvalId: r.approvalId,
        deliveryId: r.delivery.deliveryId, stage: 'delivering', taskState: 'publishing', rev: 5 } } } as AutomaticLifecycleState;
    return { ...r, state };
  }
  /** Restate's ingress for the office gateway: the signature checked, then the request object. */
  const gatewayFetch = (object: ReturnType<typeof requestObject>) => (async (url: string, init: RequestInit) => {
    expect(url).toBe(`${ingress}/OfficeDecisionGateway/reconcileDelivery`);
    const input = JSON.parse(String(init.body));
    const verdict = checkSignedDeliveryReconcile(input, secret);
    if (verdict !== 'ok') return new Response(JSON.stringify({ message: verdict }), { status: verdict === 'invalid' ? 400 : 401 });
    return new Response(JSON.stringify(await reconcileDelivery(object.ctx, object.core, input.event)), { status: 200 });
  }) as unknown as typeof fetch;

  it('the script closes a chat-only request whose sends Telegram confirmed; a second run answers replayed', async () => {
    const s = await stuck();
    // The production shape (L3): stage delivering, task publishing, REQUESTER_SEND_UNCONFIRMED.
    expect(await rows(s.requestId, s.taskId)).toMatchObject({ request: { stage: 'delivering', rev: '5' }, task: { state: 'publishing' },
      publication: { error_class: 'REQUESTER_SEND_UNCONFIRMED' } });
    const object = requestObject(s.state);
    const first = await repairChatOnlyDelivery(s.requestId, { ingress, secret, fetcher: gatewayFetch(object) });
    expect(first).toMatchObject({ status: 200, body: { accepted: true, stage: 'delivered', rev: 6, replayed: false } });
    expect(await rows(s.requestId, s.taskId)).toMatchObject({ request: { stage: 'delivered', rev: '6' }, task: { state: 'complete' },
      publication: { state: 'pending', error_class: 'ARCHIVE_PENDING' } });
    expect(object.state()).toMatchObject({ stage: 'delivered', rev: 6, delivery: { finishResult: { stage: 'delivered', rev: 6 } } });
    const second = await repairChatOnlyDelivery(s.requestId, { ingress, secret, fetcher: gatewayFetch(object) });
    expect(second).toMatchObject({ status: 200, body: { accepted: true, replayed: true, rev: 6 } });
    // A forged repair is refused by the gateway before the request object is reached.
    const wrongKey = ['not', 'the', 'worker', 'credential'].join('_');
    const forged = await repairChatOnlyDelivery(s.requestId, { ingress, secret: wrongKey, fetcher: gatewayFetch(object) });
    expect(forged.status).toBe(401);
  });

  it.each([
    ['an uncertain delivery', { outcome: 'uncertain', uncertain: ['delivery notice'], archived: false, sheetsConfirmed: false, filesSent: 2 }, 'sent', 'NOT_CHAT_ONLY'],
    ['a chat-only delivery whose notice Telegram did not confirm', CHAT_ONLY, 'uncertain', 'SENDS_UNCONFIRMED'],
    ['a chat-only delivery with no send marks at all', CHAT_ONLY, 'none', 'SENDS_UNCONFIRMED'],
  ] as const)('refuses %s and changes nothing', async (_what, outcome, marks, code) => {
    const s = await stuck(outcome as DeliveryOutcome, marks);
    const object = requestObject(s.state);
    expect(await reconcileDelivery(object.ctx, object.core, { v: 1, kind: 'reconcile-delivery', requestId: s.requestId }))
      .toEqual({ accepted: false, code, stage: 'delivering' });
    expect(await rows(s.requestId, s.taskId)).toMatchObject({ request: { stage: 'delivering', rev: '5' }, task: { state: 'publishing' },
      publication: { error_class: 'REQUESTER_SEND_UNCONFIRMED' } });
    expect(object.state()).toMatchObject({ stage: 'delivering', rev: 5 });
  });
});
