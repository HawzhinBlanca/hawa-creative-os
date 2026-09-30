import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CanvaBindingRepository, createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { projectLifecycleDesignOutcome, projectLifecycleOpen } from '../src/services/lifecycle-projection.js';
import { readOfficeIntent } from '../src/services/office-telegram-turn.js';
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
async function draftInReview(title = 'Autumn workshop poster', options: { qcPassed?: boolean } = {}) {
  const requestId = randomUUID();
  const requesterChat = String(66_000_000 + Math.floor(Math.random() * 8_000_000));
  const opened = await projectLifecycleOpen(db, {
    requestId, tenantId, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
    draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: requesterChat,
      rawText: title, title, designInstructions: 'Use the exact copy', exactCopy: [title], clientId,
      autoGenerate: true, designStudio: false },
  });
  const taskId = opened.taskId;
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
          ${`${key}:sent`}, true, clock_timestamp())`.execute(trx);
    }
  });
  objects.set(requestId, { v: 1, requestId, tenantId, chatId: requesterChat, owner: 'restate', stage: 'in_review', rev: 2,
    taskId, runId, lang: 'en', title, outcome: { eventId: `dr-finished:${runId}`, sha256: 'x', status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', revisionId },
    designInput: { v: 1, lifecycle: { requestId, round: 0, runId }, taskId, tenantId, clientId, rawText: title,
      sourcePlatform: 'telegram', idempotencyKey: `lifecycle:${requestId}:${taskId}`, canvaAutoGenerate: true } } as unknown as AutomaticLifecycleState);
  return { requestId, taskId, revisionId, requesterChat, pngId, pptxId, png, messageIds, title };
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
    expect(asked.chatAnswer.text).toBe('Which draft do you mean?\n1. <b>Book fair banner</b>\n2. <b>Graduation flyer</b>\n\nAnswer with the number or the name.');
    expect(calls).toHaveLength(0);
    const answered = await intake(say(OFFICE_A, '2'));
    expect(answered.chatAnswer.text).toBe('Approved. Sending <b>Graduation flyer</b> to the requester now.');
    expect((await rows(second.requestId, second.taskId)).request).toMatchObject({ stage: 'delivering' });
    expect((await rows(first.requestId, first.taskId))).toMatchObject({ request: { stage: 'in_review', rev: '2' }, approvals: [] });
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
