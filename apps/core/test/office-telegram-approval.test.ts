import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CanvaBindingRepository, createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { projectLifecycleDesignOutcome, projectLifecycleOpen } from '../src/services/lifecycle-projection.js';
import { OFFICE_TURN_RULES, openAskIsCurrent, readOfficeIntent, unambiguousApproval } from '../src/services/office-telegram-turn.js';
import { checkSignedOfficeDecision, type SignedOfficeDecision } from '../../worker/src/lifecycle/office-decision-gateway.js';
import { recordOfficeDeliveryStart, recordOfficeRevision,
  type AutomaticLifecycleState, type AutomaticOpenContext } from '../../worker/src/lifecycle/request-lifecycle.js';

/**
 * ADR-040 addendum (owner decision 2026-09-30, "Yes, office can approve in Telegram"): an office member
 * approves, sends back or rejects a draft in their private Telegram chat, in plain words, by replying to
 * the draft's photo alert or, with one draft waiting, without a reply. The decision goes through the
 * Desk's own Core actions (office-decisions.ts) and the signed OfficeDecisionGateway into the real
 * RequestLifecycle handlers and Core projections; approval pins the photo's PNG and the checked PPTX of
 * one capture, then starts delivery. Requesters, groups and forwards never decide.
 */
const db = createDb(process.env.TEST_DATABASE_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-b000-000000000001';
const OFFICE_TEAM = '00000000-0000-4000-b000-000000000002';
const scope = { tenantId, userId, role: 'operator' as const };
const secret = ['office', 'telegram', 'gateway', 'fixture'].join('_');
const OFFICE_A = 93100001;
const OFFICE_B = 93100002;
const worker = { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` };
const saved = { ...process.env };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeAll(() => {
  process.env.HAWA_WORKER_TOKEN = secret;
  process.env.RESTATE_INGRESS_URL = 'http://restate.fixture:8080';
  process.env.TELEGRAM_WEBHOOK_SECRET = ['fixture', 'webhook'].join('-');
  process.env.TELEGRAM_ALLOWED_USERS = `${OFFICE_A},${OFFICE_B}`;
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  process.env = saved;
  await db.destroy();
});

/** The stored exports the Desk's approval reads (a stand-in for the Canva export store). */
const stored = new Map<string, { format: 'png' | 'pptx'; bytes: Buffer }>();
const store = {
  captureEvidenceRequired: true,
  verifyCurrentSource: async () => ({ ok: true as const, capturedVersion: '300', observedVersion: '300' }),
  find: async (_t: string, _u: string, _task: string, ids: string[]) => ids.filter((id) => stored.has(id)).map((id) => {
    const file = stored.get(id)!;
    return { artifactId: id, format: file.format, sha256: sha(file.bytes), byteSize: file.bytes.length };
  }),
  read: async (_t: string, _u: string, _task: string, id: string) => stored.get(id)?.bytes ?? null,
};
const app = createApp({ db, deliverableStore: store, requesterIntentModel: null } as any);

/** RequestLifecycle objects, per request, as Restate would keep them; what they send and start. */
const objects = new Map<string, AutomaticLifecycleState>();
const sent: Array<{ key: string; chatId: string; text?: string }> = [];
const deliveries: string[] = [];
const core = { post: async <T>(path: string, payload: unknown): Promise<T> => {
  const answer = await app.request(`/v1${path}`, { method: 'POST', headers: worker, body: JSON.stringify(payload) });
  if (!answer.ok) throw new Error(`Core projection HTTP ${answer.status}: ${await answer.text()}`);
  return answer.json() as Promise<T>;
} };
const objectFor = (requestId: string): AutomaticOpenContext => ({
  key: requestId, get: async () => objects.get(requestId) ?? null, run: async (_n, action) => action(),
  set: (_n, value) => { objects.set(requestId, value as AutomaticLifecycleState); },
  send: (m) => { sent.push({ key: m.key, chatId: m.chatId, text: m.text }); },
  startDesign: () => { throw new Error('no design starts here'); },
  startDelivery: (input) => { deliveries.push(input.deliveryId); },
});
/** Restate's ingress: the signed gateway checked as the worker checks it, then the private object. */
function gateway(options: { loseFirstAnswer?: boolean } = {}) {
  let lose = options.loseFirstAnswer === true;
  const calls: Array<{ kind: string; actor: Record<string, unknown> }> = [];
  const transport = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('http://restate.fixture:8080/OfficeDecisionGateway/decide');
    const envelope = JSON.parse(String(init?.body)) as SignedOfficeDecision;
    expect(checkSignedOfficeDecision(envelope, secret)).toBe('ok');
    calls.push({ kind: envelope.event.kind, actor: envelope.event.actor as Record<string, unknown> });
    try {
      const object = objectFor(envelope.event.requestId);
      const result = envelope.event.kind === 'deliver'
        ? await recordOfficeDeliveryStart(object, core, envelope.event)
        : await recordOfficeRevision(object, core, envelope.event);
      if (lose) { lose = false; throw new Error('gateway answer lost after commit'); }
      return Response.json(result);
    } catch (error) {
      if (error instanceof Error && error.message.includes('answer lost')) throw error;
      return Response.json({ title: String(error) }, { status: 409 });
    }
  });
  vi.stubGlobal('fetch', transport);
  return { transport, calls };
}

let nextUpdate = 1_500_000_000 + Math.floor(Math.random() * 100_000_000);
let nextMessage = 700;
type Msg = Record<string, unknown>;
const say = (from: number, text: string, fields: Msg = {}, chat: { id: number; type: string } = { id: from, type: 'private' }) => {
  const id = nextUpdate++;
  return { update_id: id, message: { message_id: nextMessage++, from: { id: from, is_bot: false, first_name: 'Office' },
    chat, date: 1790000000, text, ...fields } };
};
const replyTo = (messageId: string) => ({ reply_to_message: { message_id: Number(messageId), from: { id: 7000001, is_bot: true, first_name: 'Hawa' } } });
const intake = async (update: unknown) => {
  const res = await app.request('/v1/internal/telegram/intake', { method: 'POST', headers: worker,
    body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true }) });
  expect(res.status).toBe(200);
  return (await res.json()) as { chatAnswer: { text: string }; [key: string]: unknown };
};

/** Parks every draft other tests left in the office queue, so a test sees only its own. */
async function emptyQueue() {
  await withRlsContext(db, scope, (trx) => sql`UPDATE hawa.requests SET stage = 'rejected'
    WHERE tenant_id = ${tenantId}::uuid AND stage = 'in_review'`.execute(trx));
}

/**
 * A draft in office review as the automatic path leaves it: a Canva design with a PNG preview and a
 * checked PPTX from one capture, a passing QA run naming them, the office photo alerts Core chose, and
 * TelegramSender's sent marks (message ids) for each member.
 */
async function draftInReview(title = 'Autumn workshop poster', options: { qcPassed?: boolean;
  /** When the office alerts reached the members, in minutes before now (default: now). */
  alertedMinutesAgo?: number; photos?: number; exactCopy?: string[]; requesterChat?: string; requesterName?: string } = {}) {
  const requestId = randomUUID();
  const requesterChat = options.requesterChat ?? String(66_000_000 + Math.floor(Math.random() * 8_000_000));
  const opened = await projectLifecycleOpen(db, {
    requestId, tenantId, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
    draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: requesterChat,
      rawText: title, title, designInstructions: 'Use the exact copy', exactCopy: options.exactCopy ?? [title], clientId,
      autoGenerate: true, designStudio: false },
  });
  const taskId = opened.taskId;
  await withRlsContext(db, scope, async (trx) => {
    for (let i = 0; i < (options.photos ?? 0); i++) {
      const hash = sha(Buffer.from(`photo ${i} of ${taskId}`));
      await sql`INSERT INTO hawa.blobs (sha256, size, media_type) VALUES (${hash}, 1, 'image/jpeg') ON CONFLICT DO NOTHING`.execute(trx);
      await sql`INSERT INTO hawa.task_files (tenant_id, task_id, sha256, role)
        VALUES (${tenantId}::uuid, ${taskId}::uuid, ${hash}, 'reference_image')`.execute(trx);
    }
    if (options.requesterName) {
      // The request's source message, recorded at open: who sent it.
      const named = await sql`UPDATE hawa.inbox_events SET payload = payload ||
          ${JSON.stringify({ message: { from: { id: Number(requesterChat), first_name: options.requesterName } } })}::jsonb
        WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'telegram'
          AND source_event_id = ${`${requesterChat}:lc-${requestId}-r0`}`.execute(trx);
      expect(Number(named.numAffectedRows)).toBe(1);
    }
  });
  const designId = `DA${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const png = Buffer.from(`png of ${taskId}`);
  const pptx = Buffer.from(`pptx of ${taskId}`);
  const pngId = randomUUID();
  const pptxId = randomUUID();
  stored.set(pngId, { format: 'png', bytes: png });
  stored.set(pptxId, { format: 'pptx', bytes: pptx });
  await withRlsContext(db, scope, async (trx) => {
    await new CanvaBindingRepository(trx).createBinding({ tenantId, taskId, clientId, canvaDesignId: designId,
      editUrl: `https://www.canva.com/design/${designId}/edit` }, trx);
    const binding = await trx.selectFrom('canva_bindings').select(['canva_design_id', 'version'])
      .where('tenant_id', '=', tenantId).where('task_id', '=', taskId).executeTakeFirstOrThrow();
    for (const [id, format, bytes] of [[pngId, 'png', png], [pptxId, 'pptx', pptx]] as const) {
      const operationId = randomUUID();
      await sql`INSERT INTO hawa.canva_remote_operations
        (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata)
        VALUES (${operationId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, 'test', ${`capture-${operationId}`},
          ${sha(bytes)}, 'export', 'retrieved', ${binding.canva_design_id}, ${binding.version},
          ${JSON.stringify({ format, designUpdatedAt: '300' })}::jsonb)`.execute(trx);
      await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content)
        VALUES (${id}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, ${operationId}::uuid, ${format}, ${sha(bytes)}, ${bytes})`.execute(trx);
    }
  });
  const runId = `dr-${taskId}`;
  const designed = await projectLifecycleDesignOutcome(db, {
    requestId, tenantId, taskId, runId, expectedRev: 1, rev: 2, key: `${requestId}:2:designFinished:${runId}`,
    report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId },
  });
  expect(designed.officePhotoAlerts?.map((a) => a.image.id)).toEqual([pngId, pngId]);
  const revisionId = designed.revisionId!;
  const report = { exportArtifactId: pptxId, exportSha256: sha(pptx), captureVersion: '300' };
  const messageIds = { [OFFICE_A]: String(nextMessage++), [OFFICE_B]: String(nextMessage++) };
  await withRlsContext(db, scope, async (trx) => {
    const firstQc = await trx.selectFrom('qc_runs').select('qc_profile_id')
      .where('tenant_id', '=', tenantId).where('design_revision_id', '=', revisionId).executeTakeFirstOrThrow();
    await sql`INSERT INTO hawa.qc_runs (id, tenant_id, task_id, design_revision_id, qc_profile_id, attempt, status,
        critical_pass, report, report_sha256, started_at)
      VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${revisionId}::uuid, ${firstQc.qc_profile_id}::uuid, 2,
        ${options.qcPassed === false ? 'failed' : 'passed'}, ${options.qcPassed !== false}, ${JSON.stringify(report)}::jsonb,
        ${sha(Buffer.from(JSON.stringify(report)))}, clock_timestamp() + interval '1 minute')`.execute(trx);
    // TelegramSender's marks for the photo alerts: the first member's key has no chat (officeAlertKey).
    for (const [chat, key] of [[OFFICE_A, `lc:${requestId}:2:office-alert:send`], [OFFICE_B, `lc:${requestId}:2:office-alert:${OFFICE_B}:send`]] as const) {
      await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified, received_at)
        VALUES (${tenantId}::uuid, 'telegram_delivery', ${key}, 'telegram_message_sent',
          ${JSON.stringify({ commandId: key.replace(/:send$/, ''), step: 'send', outcome: 'sent', messageId: messageIds[chat], chatId: String(chat) })}::jsonb,
          ${`${key}:sent`}, true, clock_timestamp() - ${options.alertedMinutesAgo ?? 0} * interval '1 minute')`.execute(trx);
    }
  });
  objects.set(requestId, { v: 1, requestId, tenantId, chatId: requesterChat, owner: 'restate', stage: 'in_review', rev: 2,
    taskId, runId, lang: 'en', title, outcome: { eventId: `dr-finished:${runId}`, sha256: 'x', status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', revisionId },
    designInput: { v: 1, lifecycle: { requestId, round: 0, runId }, taskId, tenantId, clientId, rawText: title,
      sourcePlatform: 'telegram', idempotencyKey: `lifecycle:${requestId}:${taskId}`, canvaAutoGenerate: true } } as unknown as AutomaticLifecycleState);
  return { requestId, taskId, revisionId, requesterChat, pngId, pptxId, png, messageIds, title,
    caption: designed.officePhotoAlerts?.[0]?.text ?? '' };
}

const rows = async (requestId: string, taskId: string) => withRlsContext(db, scope, async (trx) => ({
  request: await trx.selectFrom('requests').select(['stage', 'rev']).where('request_id', '=', requestId).executeTakeFirstOrThrow(),
  approvals: await trx.selectFrom('approvals').select(['decision', 'decided_by', 'reason', 'decision_payload'])
    .where('task_id', '=', taskId).orderBy('created_at').execute(),
}));

describe('what an office member\'s words mean for a draft', () => {
  it.each([
    ['approved', 'approve'], ['Approved', 'approve'], ['ok send it', 'approve'], ['looks good send', 'approve'],
    ['looks good, send it', 'approve'], ['👍 send', 'approve'], ['پەسەندە', 'approve'], ['باشە بینێرە', 'approve'],
    ['ok but make the title bigger', 'change'], ['looks good but change the date to 5 October', 'change'],
    ['make the logo smaller', 'change'], ['ڕەنگی باگراوندەکە بگۆڕە', 'change'],
    ['reject', 'reject'], ['rejected', 'reject'], ['no, cancel this', 'reject'], ['ڕەتی بکەرەوە', 'reject'],
    ['hmm', 'unclear'], ['who made this?', 'unclear'], ['ok', 'unclear'],
    // A new brief is never read as a change to a draft.
    ['Can you make a poster for our Nawroz party?', 'unclear'], ['سڵاو، پۆستەرێک بۆ نەورۆز دروست بکە', 'unclear'],
  ] as const)('"%s" → %s', (words, intent) => {
    expect(readOfficeIntent(words).intent).toBe(intent);
  });
});

describe('an office member decides on a draft in Telegram (ADR-040 addendum)', () => {
  it('a reply "approved" to the draft photo approves through the Desk route, pins the photo, and starts delivery', async () => {
    await emptyQueue();
    const draft = await draftInReview();
    const { transport, calls } = gateway();
    const before = deliveries.length;
    const update = say(OFFICE_A, 'approved', replyTo(draft.messageIds[OFFICE_A]));
    const answer = await intake(update);
    expect(answer).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', chatId: String(OFFICE_A),
      chatAnswer: { text: `Approved. Sending <b>${draft.title}</b> to the requester now.`, parseMode: 'HTML' } });
    expect(calls.map((c) => c.kind)).toEqual(['approve', 'deliver']);
    expect(calls[0].actor).toEqual({ userId: OFFICE_TEAM, role: 'administrator', authMethod: 'telegram_office', telegramChatId: String(OFFICE_A) });
    const after = await rows(draft.requestId, draft.taskId);
    expect(after.request).toMatchObject({ stage: 'delivering', rev: '4' });
    expect(after.approvals).toHaveLength(1);
    const approval = after.approvals[0];
    expect(approval).toMatchObject({ decision: 'approved', decided_by: OFFICE_TEAM,
      reason: expect.stringContaining(`office member ${OFFICE_A}`),
      decision_payload: { authMethod: 'telegram_office', telegramChatId: String(OFFICE_A) } });
    const pins = (approval.decision_payload as { pinnedExports: Array<{ artifactId: string }> }).pinnedExports.map((p) => p.artifactId);
    expect(pins).toEqual([draft.pngId, draft.pptxId]);
    expect(deliveries.length - before).toBe(1);
    // The photo is the human visual check: the turn records which picture, sent to whom, was approved.
    const turn = await withRlsContext(db, scope, (trx) => sql<{ payload: { approval: { telegram: { visualCheck: unknown } } } }>`SELECT payload FROM hawa.inbox_events
      WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'office_telegram_turn' AND source_event_id = ${String(update.update_id)}`.execute(trx));
    expect(turn.rows[0].payload.approval.telegram.visualCheck).toMatchObject({ channel: 'telegram_photo', chatId: String(OFFICE_A),
      messageId: draft.messageIds[OFFICE_A], requestRev: 2, imageSha256: sha(draft.png), exportArtifactId: draft.pngId });
    // A replay of the same update answers the same and decides nothing again.
    expect(await intake(update)).toEqual(answer);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('plain "approved" with one draft waiting approves it without a reply', async () => {
    await emptyQueue();
    const draft = await draftInReview('Nawroz evening invitation');
    const { calls } = gateway();
    const answer = await intake(say(OFFICE_B, 'Approved'));
    expect(answer.chatAnswer.text).toBe('Approved. Sending <b>Nawroz evening invitation</b> to the requester now.');
    expect(calls.map((c) => c.kind)).toEqual(['approve', 'deliver']);
    expect((await rows(draft.requestId, draft.taskId)).request).toMatchObject({ stage: 'delivering' });
  });

  it('with two drafts waiting it asks which, in plain words, and takes the number', async () => {
    await emptyQueue();
    const first = await draftInReview('Book fair banner');
    const second = await draftInReview('Graduation flyer');
    const { calls } = gateway();
    const asked = await intake(say(OFFICE_A, 'approved'));
    // Sent to the member moments apart, so neither is taken for the one meant: newest first (2026-10-01).
    expect(asked.chatAnswer.text).toBe('Which draft do you mean?\n1. <b>Graduation flyer</b> (sent just now, no photos, newest)\n' +
      '2. <b>Book fair banner</b> (sent just now, no photos)\n\nAnswer with the number or the name.');
    expect(calls).toHaveLength(0);
    const answered = await intake(say(OFFICE_A, '2'));
    expect(answered.chatAnswer.text).toBe('Approved. Sending <b>Book fair banner</b> to the requester now.');
    expect((await rows(first.requestId, first.taskId)).request).toMatchObject({ stage: 'delivering' });
    expect((await rows(second.requestId, second.taskId))).toMatchObject({ request: { stage: 'in_review', rev: '2' }, approvals: [] });
  });

  it('"ok but make the title bigger" goes back as the Desk\'s revision request with those words', async () => {
    await emptyQueue();
    const draft = await draftInReview('Open day poster');
    const { calls } = gateway();
    const answer = await intake(say(OFFICE_A, 'ok but make the title bigger', replyTo(draft.messageIds[OFFICE_A])));
    expect(answer.chatAnswer.text).toContain('Sent back for changes with your words.');
    expect(calls.map((c) => c.kind)).toEqual(['revise']);
    const after = await rows(draft.requestId, draft.taskId);
    expect(after.request).toMatchObject({ stage: 'manual', rev: '3' });
    expect(after.approvals).toMatchObject([{ decision: 'revision_requested', decided_by: OFFICE_TEAM,
      decision_payload: { authMethod: 'telegram_office', revisionRequest: { comment: 'ok but make the title bigger', scope: 'full_design' } } }]);
    // The requester hears the office's note, as after the Desk's Request Revision.
    expect(sent.filter((m) => m.chatId === draft.requesterChat).map((m) => m.key)).toEqual([`${draft.requestId}:3:office-revision-notify`]);
  });

  it('"reject" rejects through the Desk\'s reject path', async () => {
    await emptyQueue();
    const draft = await draftInReview('Clinic leaflet');
    gateway();
    const answer = await intake(say(OFFICE_B, 'reject', replyTo(draft.messageIds[OFFICE_B])));
    expect(answer.chatAnswer.text).toBe('Rejected: <b>Clinic leaflet</b>. Nothing was sent to the requester.');
    expect(await rows(draft.requestId, draft.taskId)).toMatchObject({ request: { stage: 'rejected', rev: '3' },
      approvals: [{ decision: 'rejected', decision_payload: { rejectionCategory: 'concept', telegramChatId: String(OFFICE_B) } }] });
  });

  it('a reply that says nothing decisive is asked about briefly, and the next words decide', async () => {
    await emptyQueue();
    const draft = await draftInReview('Seminar card');
    const { calls } = gateway();
    const asked = await intake(say(OFFICE_A, 'hmm', replyTo(draft.messageIds[OFFICE_A])));
    expect(asked.chatAnswer.text).toContain('What should I do with <b>Seminar card</b>');
    expect(calls).toHaveLength(0);
    const decided = await intake(say(OFFICE_A, 'send it'));
    expect(decided.chatAnswer.text).toContain('Approved.');
  });

  it('a requester who is not in the office list saying "approved" changes nothing', async () => {
    await emptyQueue();
    const draft = await draftInReview('Charity dinner poster');
    const { transport } = gateway();
    const outsider = Number(draft.requesterChat);
    await intake(say(outsider, 'approved'));
    await intake(say(outsider, 'approved', replyTo(draft.messageIds[OFFICE_A])));
    expect(transport).not.toHaveBeenCalled();
    expect(await rows(draft.requestId, draft.taskId)).toMatchObject({ request: { stage: 'in_review', rev: '2' }, approvals: [] });
  });

  it('a forwarded "approved" or one said in a group is ignored', async () => {
    await emptyQueue();
    const draft = await draftInReview('Sports day banner');
    const { transport } = gateway();
    await intake(say(OFFICE_A, 'approved', { ...replyTo(draft.messageIds[OFFICE_A]),
      forward_origin: { type: 'user', date: 1790000000, sender_user: { id: 5, is_bot: false, first_name: 'X' } } }));
    await intake(say(OFFICE_A, 'approved', {}, { id: -1009300001, type: 'supergroup' }));
    expect(transport).not.toHaveBeenCalled();
    expect(await rows(draft.requestId, draft.taskId)).toMatchObject({ request: { stage: 'in_review', rev: '2' }, approvals: [] });
  });

  it('a Telegram approval after the Desk approved gets a truthful answer and no second decision', async () => {
    await emptyQueue();
    const draft = await draftInReview('Library week poster');
    const { calls } = gateway();
    const desk = createApp({ db, deliverableStore: store, testAuth: { principal: { role: 'art_director', userId } } } as any);
    const approvedAtDesk = await desk.request(`/v1/tasks/${draft.taskId}/revisions/${draft.revisionId}/decisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ action: 'approve', reason: 'Checked', pinnedExportIds: [draft.pngId, draft.pptxId] }) });
    expect(approvedAtDesk.status).toBe(201);
    const answer = await intake(say(OFFICE_A, 'approved', replyTo(draft.messageIds[OFFICE_A])));
    expect(answer.chatAnswer.text).toBe('<b>Library week poster</b> was already approved, so I did nothing more.');
    expect(calls.map((c) => c.kind)).toEqual(['approve']);
    const after = await rows(draft.requestId, draft.taskId);
    expect(after.request).toMatchObject({ stage: 'approved', rev: '3' });
    expect(after.approvals).toMatchObject([{ decided_by: userId }]);
  });

  it('a lost gateway answer is retried under the same action keys: one approval, one delivery', async () => {
    await emptyQueue();
    const draft = await draftInReview('Exhibition flyer');
    const { calls } = gateway({ loseFirstAnswer: true });
    const before = deliveries.length;
    const update = say(OFFICE_A, 'looks good, send it', replyTo(draft.messageIds[OFFICE_A]));
    const lost = await intake(update);
    expect(lost).toMatchObject({ intakeStatus: 503, code: 'OFFICE_DECISION_UNCERTAIN' });
    const retried = await intake(update);
    expect(retried.chatAnswer.text).toBe('Approved. Sending <b>Exhibition flyer</b> to the requester now.');
    expect(calls.map((c) => c.kind)).toEqual(['approve', 'approve', 'deliver']);
    const after = await rows(draft.requestId, draft.taskId);
    expect(after.approvals).toHaveLength(1);
    expect(after.request).toMatchObject({ stage: 'delivering', rev: '4' });
    expect(deliveries.length - before).toBe(1);
  });

  it('words the requester sent after the draft reached the office are quoted first; "send it anyway" approves and sends', async () => {
    await emptyQueue();
    const draft = await draftInReview('Nawroz concert poster');
    const { calls } = gateway();
    const late = await intake(say(Number(draft.requesterChat), 'the date should be 5 October not 4'));
    expect(late).toMatchObject({ lifecycleAction: 'late-change', requestId: draft.requestId });
    const asked = await intake(say(OFFICE_A, 'approved', replyTo(draft.messageIds[OFFICE_A])));
    expect(asked.chatAnswer.text).toContain('Not approved yet: the requester wrote after <b>Nawroz concert poster</b> reached the office:');
    expect(asked.chatAnswer.text).toContain('«the date should be 5 October not 4»');
    expect(calls).toHaveLength(0);
    const answered = await intake(say(OFFICE_A, 'send it anyway'));
    expect(answered.chatAnswer.text).toBe('Approved. Sending <b>Nawroz concert poster</b> to the requester now.');
    expect(calls.map((c) => c.kind)).toEqual(['approve', 'deliver']);
    expect((await rows(draft.requestId, draft.taskId)).request).toMatchObject({ stage: 'delivering' });
  });

  it('answers a member who writes in Sorani in Sorani', async () => {
    await emptyQueue();
    const draft = await draftInReview('Newroz poster');
    gateway();
    const answer = await intake(say(OFFICE_B, 'پەسەندە', replyTo(draft.messageIds[OFFICE_B])));
    expect(answer.chatAnswer.text).toBe('پەسەند کرا. ئێستا <b>Newroz poster</b> بۆ داواکارەکە دەنێرم.');
  });

  it('a brief of the member\'s own is not taken as an answer to "which draft?", nor as a change', async () => {
    await emptyQueue();
    const first = await draftInReview('Spring fair banner');
    const second = await draftInReview('Graduation dinner card');
    const { calls } = gateway();
    await intake(say(OFFICE_B, 'approved'));
    const brief = await intake(say(OFFICE_B, 'Can you make a graduation poster?'));
    expect(brief.officeTurn).toBeUndefined();
    expect(calls).toHaveLength(0);
    for (const draft of [first, second]) {
      expect(await rows(draft.requestId, draft.taskId)).toMatchObject({ request: { stage: 'in_review' }, approvals: [] });
    }
  });

  it('keeps the Desk\'s QA gate: a failed check is not approved from Telegram', async () => {
    await emptyQueue();
    const draft = await draftInReview('Menu board', { qcPassed: false });
    const { transport } = gateway();
    const answer = await intake(say(OFFICE_A, 'approved', replyTo(draft.messageIds[OFFICE_A])));
    expect(answer.chatAnswer.text).toContain("I can't approve <b>Menu board</b>: its automatic check did not pass.");
    expect(transport).not.toHaveBeenCalled();
  });
});

/**
 * ADR-040 addendum (2026-10-01). The owner, an office member, wrote feedback without replying to a
 * draft's picture while three drafts waited. The bot listed them by stored title only: two read
 * "KAAE: <RLM>KAAE K-12 Pilot Study…", one "KAAE: Here is the text and the photos:…", and the owner could
 * not tell them apart. And the words, "the design is not approved…", read as approval.
 */
const RLM = String.fromCharCode(0x200f);
const OWNER_WORDS = 'the design is not approved, the images cut with no content awareness, should have more images organized creatively';

describe('which draft, when several wait (ADR-040 addendum, 2026-10-01)', () => {
  it.each([
    [OWNER_WORDS, 'change'], ['the design is not approved', 'reject'], ['not approved yet', 'reject'],
    ["not good, the colours are too dark", 'change'], ["don't send it", 'unclear'], ['پەسەند نییە', 'reject'],
    // Incident 2026-10-01, second pass: feedback after "not approved" is the change, not a rejection;
    // "I can't approve this" and questions are never approval.
    ['not approved, the photos are cropped badly', 'change'], ["I can't approve this", 'reject'], ['approved?', 'unclear'],
    ['is it approved?', 'unclear'], ['please don\'t publish it', 'unclear'],
  ] as const)('refusing words are never approval: "%s" → %s', (words, intent) => {
    expect(readOfficeIntent(words).intent).toBe(intent);
  });

  it('the incident: three drafts, two with the same title, are told apart; "2" applies the kept words', async () => {
    await emptyQueue();
    const day = 24 * 60;
    const intro = await draftInReview('KAAE: Here is the text and the photos:…', { alertedMinutesAgo: 4 * day, photos: 6,
      exactCopy: ['Here is the text and the photos:', 'KAAE K-12 Pilot Study\nField Visit Report'], requesterName: 'Shno' });
    const older = await draftInReview(`KAAE: ${RLM}KAAE K-12 Pilot Study…`, { alertedMinutesAgo: 3 * day, photos: 4 });
    const newer = await draftInReview(`KAAE: ${RLM}KAAE K-12 Pilot Study…`, { alertedMinutesAgo: 2 * day, photos: 5 });
    const { calls } = gateway();
    const asked = await intake(say(OFFICE_A, OWNER_WORDS));
    expect(asked.chatAnswer.text).toBe('Which draft do you mean?\n' +
      '1. <b>KAAE K-12 Pilot Study…</b> (sent 2 days ago, 5 photos, newest, from the requester)\n' +
      '2. <b>KAAE K-12 Pilot Study…</b> (sent 3 days ago, 4 photos, from the requester)\n' +
      '3. <b>KAAE K-12 Pilot Study</b> (sent 4 days ago, 6 photos, from Shno)\n\nAnswer with the number or the name.');
    const lines = asked.chatAnswer.text.split('\n').filter((l) => /^\d\. /.test(l));
    expect(new Set(lines.map((l) => l.replace(/^\d\. /, ''))).size).toBe(3);
    expect(asked.chatAnswer.text).not.toContain(RLM);
    expect(calls).toHaveLength(0);
    // The number answers the question; the words are not asked for again.
    const answered = await intake(say(OFFICE_A, '2'));
    expect(answered.chatAnswer.text).toBe('Sent back for changes with your words. I have sent your note on <b>KAAE K-12 Pilot Study…</b> ' +
      'to the requester; the next draft starts once they answer.');
    expect(calls.map((c) => c.kind)).toEqual(['revise']);
    expect((await rows(older.requestId, older.taskId)).approvals).toMatchObject([{ decision: 'revision_requested',
      decision_payload: { revisionRequest: { comment: OWNER_WORDS } } }]);
    for (const untouched of [intro, newer]) {
      expect(await rows(untouched.requestId, untouched.taskId)).toMatchObject({ request: { stage: 'in_review', rev: '2' }, approvals: [] });
    }
  });

  it('words with no reply go to the draft the member was sent last, within two hours, and the answer names it', async () => {
    await emptyQueue();
    const earlier = await draftInReview('Science fair poster', { alertedMinutesAgo: 90 });
    const latest = await draftInReview('Parents evening invitation', { alertedMinutesAgo: 10, photos: 2 });
    const { calls } = gateway();
    const answer = await intake(say(OFFICE_A, 'make the logo smaller'));
    expect(answer.chatAnswer.text).toBe('About the <b>Parents evening invitation</b> draft I sent you 10 minutes ago:\n' +
      'Sent back for changes with your words. I have sent your note on <b>Parents evening invitation</b> to the requester; ' +
      'the next draft starts once they answer.');
    expect(calls.map((c) => c.kind)).toEqual(['revise']);
    expect((await rows(latest.requestId, latest.taskId)).approvals).toMatchObject([{ decision: 'revision_requested',
      decision_payload: { revisionRequest: { comment: 'make the logo smaller' } } }]);
    expect(await rows(earlier.requestId, earlier.taskId)).toMatchObject({ request: { stage: 'in_review', rev: '2' }, approvals: [] });
  });

  it('still asks when drafts came minutes apart, or none came in the last two hours; "the newest" is the first line', async () => {
    await emptyQueue();
    const a = await draftInReview('Winter camp flyer', { alertedMinutesAgo: 12 });
    const b = await draftInReview('Teachers day card', { alertedMinutesAgo: 10 });
    const { calls } = gateway();
    const close = await intake(say(OFFICE_B, 'approved'));
    expect(close.chatAnswer.text).toBe('Which draft do you mean?\n1. <b>Teachers day card</b> (sent 10 minutes ago, no photos, newest)\n' +
      '2. <b>Winter camp flyer</b> (sent 12 minutes ago, no photos)\n\nAnswer with the number or the name.');
    expect(calls).toHaveLength(0);
    const chosen = await intake(say(OFFICE_B, 'the newest'));
    expect(chosen.chatAnswer.text).toBe('Approved. Sending <b>Teachers day card</b> to the requester now.');
    expect((await rows(a.requestId, a.taskId)).approvals).toEqual([]);

    await emptyQueue();
    await draftInReview('Old poster one', { alertedMinutesAgo: 5 * 60 });
    await draftInReview('Old poster two', { alertedMinutesAgo: 3 * 60 });
    const stale = await intake(say(OFFICE_A, 'make the title bigger'));
    expect(stale.chatAnswer.text).toMatch(/^Which draft do you mean\?\n1\. <b>Old poster two<\/b> \(sent /);
    expect(calls.map((c) => c.kind)).toEqual(['approve', 'deliver']);
  });

  it('names drafts titled before ADR-180 and ADR-142 as new ones are named, in alerts and confirmations', async () => {
    await emptyQueue();
    const intro = await draftInReview('KAAE: Here is the text and the photos:…',
      { exactCopy: ['Here is the text and the photos:', 'KAAE K-12 Pilot Study\nField Visit Report'] });
    expect(intro.caption).toContain('A new draft is ready for office review: "KAAE K-12 Pilot Study"');
    gateway();
    const rejected = await intake(say(OFFICE_A, 'reject', replyTo(intro.messageIds[OFFICE_A])));
    expect(rejected.chatAnswer.text).toBe('Rejected: <b>KAAE K-12 Pilot Study</b>. Nothing was sent to the requester.');
    await emptyQueue();
    const marked = await draftInReview(`KAAE: ${RLM}KAAE K-12 Pilot Study…`);
    expect(marked.caption).toContain('"KAAE K-12 Pilot Study…"');
    const sentBack = await intake(say(OFFICE_A, 'make the logo smaller', replyTo(marked.messageIds[OFFICE_A])));
    expect(sentBack.chatAnswer.text).toContain('your note on <b>KAAE K-12 Pilot Study…</b> to the requester');
    expect(sentBack.chatAnswer.text).not.toContain(RLM);
  });

  it('leaves the requester side as it was: a requester\'s words are never applied by the office default', async () => {
    await emptyQueue();
    const requesterChat = String(67_000_000 + Math.floor(Math.random() * 1_000_000));
    const first = await draftInReview(`KAAE: ${RLM}KAAE K-12 Pilot Study…`, { requesterChat, alertedMinutesAgo: 60 });
    const second = await draftInReview('Open day poster', { requesterChat, alertedMinutesAgo: 10 });
    const { transport } = gateway();
    const answer = await intake(say(Number(requesterChat), 'make the logo smaller'));
    expect(answer.officeTurn).toBeUndefined();
    expect(transport).not.toHaveBeenCalled();
    for (const draft of [first, second]) {
      expect(await rows(draft.requestId, draft.taskId)).toMatchObject({ request: { stage: 'in_review', rev: '2' }, approvals: [] });
    }
    expect(answer.chatAnswer.text).toContain('Which design is this for?');
    expect(answer.chatAnswer.text).toContain('<b>KAAE K-12 Pilot Study…</b>');
    expect(answer.chatAnswer.text).not.toContain(RLM);
  });
});

/**
 * ADR-040 addendum, incident 2026-10-01 (task 5edca743, request 95eeb08d). At 07:35Z the owner wrote,
 * with no reply, "the design is not approved, the images cut with no content awareness, should have more
 * images organized creatively, not just straight image on same old bg". The rules of the day read it as
 * approval, and with three drafts waiting the bot saved a "which draft?" holding that approval reading.
 * The fixed reading was deployed at about 08:05Z; at 08:44Z the owner answered "3" to the old question,
 * the stored approval was applied, and the draft was approved and delivered. A pending choice now keeps
 * only the words, which the answer reads again; approval through a choice needs words that only
 * approve; and a question asked under other rules, or more than 30 minutes ago, does nothing.
 */
describe('a pending "which draft?" is read again when answered (ADR-040 addendum, incident 2026-10-01)', () => {
  const INCIDENT_WORDS = 'the design is not approved, the images cut with no content awareness, should have more images organized creatively, not just straight image on same old bg';
  const LOST = 'I\'ve lost track of that question — please reply to the draft picture with what you want.';

  /**
   * The "which draft?" turn as a deploy before this fix stored it: the decision kind read at question
   * time (`intent: 'approve'`) beside the words, the options newest first, and (optionally) the stamp.
   */
  async function storedChoice(chat: number, words: string, drafts: Array<{ requestId: string; title: string }>,
    stamp: { rules?: number; minutesAgo?: number } | null, botMessageId?: string) {
    const updateId = nextUpdate++;
    const ask = { kind: 'ask-which', intent: 'approve', words, options: drafts.map((d) => ({ requestId: d.requestId, title: d.title,
      sentAt: new Date().toISOString(), alerted: true, photos: 0, requester: null, own: false })) };
    const askedAt = new Date(Date.now() - (stamp?.minutesAgo ?? 0) * 60_000).toISOString();
    const payload = { chatId: String(chat), messageId: '1', lang: 'en', plan: ask, ask,
      answer: { status: 200, extra: { lifecycleAction: 'chat-answer', chatId: String(chat), chatAnswer: { text: 'Which draft do you mean?' } } },
      ...(stamp ? { askRules: stamp.rules ?? OFFICE_TURN_RULES, askedAt } : {}) };
    await withRlsContext(db, scope, async (trx) => {
      // Stored now, so it is the member's latest turn whatever earlier tests left; `askedAt` says when it was asked.
      await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
        VALUES (${tenantId}::uuid, 'office_telegram_turn', ${String(updateId)}, 'office_telegram_turn', ${JSON.stringify(payload)}::jsonb,
          ${`stored-choice-${updateId}`}, true)`.execute(trx);
      if (botMessageId) {
        // TelegramSender's mark for the question it sent: a reply to that message names the question.
        const key = `lc:chatinbox:chat-answer:${updateId}:send`;
        await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
          VALUES (${tenantId}::uuid, 'telegram_delivery', ${key}, 'telegram_message_sent',
            ${JSON.stringify({ messageId: botMessageId, chatId: String(chat) })}::jsonb, ${`${key}:sent`}, true)`.execute(trx);
      }
    });
  }

  /** Three drafts in review, sent days ago (none is "the one just sent"), listed newest first. */
  async function threeDrafts() {
    await emptyQueue();
    const day = 24 * 60;
    const first = await draftInReview('KAAE field visit report', { alertedMinutesAgo: 4 * day });
    const second = await draftInReview('KAAE K-12 Pilot Study', { alertedMinutesAgo: 3 * day });
    const third = await draftInReview('Pilot Study second version', { alertedMinutesAgo: 2 * day });
    return [third, second, first];
  }

  const untouched = async (drafts: Array<{ requestId: string; taskId: string }>) => {
    for (const draft of drafts) {
      expect(await rows(draft.requestId, draft.taskId)).toMatchObject({ request: { stage: 'in_review', rev: '2' }, approvals: [] });
    }
  };

  it('the incident replayed: kept words stored as approval are read again, and "3" sends the draft back, never approves or delivers', async () => {
    const options = await threeDrafts();
    await storedChoice(OFFICE_A, INCIDENT_WORDS, options, {});
    const { calls } = gateway();
    const before = deliveries.length;
    const answered = await intake(say(OFFICE_A, '3'));
    expect(answered.chatAnswer.text).toBe('Sent back for changes with your words. I have sent your note on <b>KAAE field visit report</b> ' +
      'to the requester; the next draft starts once they answer.');
    expect(calls.map((c) => c.kind)).toEqual(['revise']);
    expect(deliveries.length).toBe(before);
    expect((await rows(options[2].requestId, options[2].taskId)).approvals).toMatchObject([{ decision: 'revision_requested',
      decision_payload: { revisionRequest: { comment: INCIDENT_WORDS } } }]);
    await untouched(options.slice(0, 2));
  });

  it('approval through a choice needs kept words that only approve: anything less is asked about', async () => {
    const options = await threeDrafts();
    await storedChoice(OFFICE_B, 'no problem, send it', options, {});
    const { calls } = gateway();
    const answered = await intake(say(OFFICE_B, '1'));
    expect(answered.chatAnswer.text).toContain('What should I do with <b>Pilot Study second version</b>');
    expect(calls).toHaveLength(0);
    await untouched(options);
  });

  it('a question stored under older reading rules is discarded: the answer does nothing and says so', async () => {
    const options = await threeDrafts();
    // As every question stored before this fix: no stamp at all.
    await storedChoice(OFFICE_A, INCIDENT_WORDS, options, null);
    const { transport } = gateway();
    const unstamped = await intake(say(OFFICE_A, '3'));
    expect(unstamped).toMatchObject({ officeTurn: 'lost-track', chatAnswer: { text: LOST } });
    // An older stamp, answered by replying to the question itself.
    await storedChoice(OFFICE_A, 'approved', options, { rules: OFFICE_TURN_RULES - 1 }, '88001');
    const replied = await intake(say(OFFICE_A, '2', replyTo('88001')));
    expect(replied).toMatchObject({ officeTurn: 'lost-track', chatAnswer: { text: LOST } });
    expect(transport).not.toHaveBeenCalled();
    await untouched(options);
  });

  it('a question expires after 30 minutes: the answer does nothing and says so', async () => {
    const options = await threeDrafts();
    await storedChoice(OFFICE_B, 'approved', options, { minutesAgo: 31 });
    const { transport } = gateway();
    const late = await intake(say(OFFICE_B, '2'));
    expect(late).toMatchObject({ officeTurn: 'lost-track', chatAnswer: { text: LOST } });
    expect(transport).not.toHaveBeenCalled();
    await untouched(options);
    const now = Date.now();
    expect(openAskIsCurrent({ askRules: OFFICE_TURN_RULES, askedAt: new Date(now - 29 * 60_000).toISOString() }, now)).toBe(true);
    expect(openAskIsCurrent({ askRules: OFFICE_TURN_RULES, askedAt: new Date(now - 31 * 60_000).toISOString() }, now)).toBe(false);
  });

  it('genuine "approved" kept with a current question, then "2", approves and delivers as before', async () => {
    const options = await threeDrafts();
    await storedChoice(OFFICE_A, 'approved', options, { minutesAgo: 5 });
    const { calls } = gateway();
    const answered = await intake(say(OFFICE_A, '2'));
    expect(answered.chatAnswer.text).toBe('Approved. Sending <b>KAAE K-12 Pilot Study</b> to the requester now.');
    expect(calls.map((c) => c.kind)).toEqual(['approve', 'deliver']);
    await untouched([options[0], options[2]]);
  });

  it('a question asked now keeps only the words, is stamped, and its answer reads them again', async () => {
    await emptyQueue();
    const first = await draftInReview('Library week poster', { alertedMinutesAgo: 12 });
    const second = await draftInReview('Library week flyer', { alertedMinutesAgo: 10 });
    const { calls } = gateway();
    const asked = await intake(say(OFFICE_B, 'not approved, the photos are cropped badly'));
    expect(asked.chatAnswer.text).toMatch(/^Which draft do you mean\?/);
    const stored = await withRlsContext(db, scope, (trx) => sql<{ payload: Record<string, any> }>`SELECT payload FROM hawa.inbox_events
      WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'office_telegram_turn' AND payload->>'chatId' = ${String(OFFICE_B)}
      ORDER BY received_at DESC, id DESC LIMIT 1`.execute(trx));
    expect(stored.rows[0].payload).toMatchObject({ askRules: OFFICE_TURN_RULES,
      ask: { kind: 'ask-which', words: 'not approved, the photos are cropped badly' } });
    expect(stored.rows[0].payload.ask.intent).toBeUndefined();
    await intake(say(OFFICE_B, '2'));
    expect(calls.map((c) => c.kind)).toEqual(['revise']);
    expect((await rows(first.requestId, first.taskId)).approvals).toMatchObject([{ decision: 'revision_requested' }]);
    await untouched([second]);
  });

  it.each([
    ['approved', true], ['ok send it', true], ['looks good, send it', true], ['پەسەندە', true],
    [INCIDENT_WORDS, false], ['not approved', false], ["don't send it", false], ['no problem, send it', false],
    ['approved?', false], ['ok but make the title bigger', false], ["I can't approve this", false], ['پەسەند نییە', false],
  ] as const)('"%s" is an unambiguous approval: %s', (words, expected) => {
    expect(unambiguousApproval(words)).toBe(expected);
  });
});
