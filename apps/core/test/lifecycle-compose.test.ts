import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import type { LifecycleEvent, LifecycleMessage, LifecycleStateV1, ProjectionRequest, ProjectionResponse } from '@hawa/contracts';
import { SYSTEM_AUTOMATION_USER_ID, questionIdOf } from '@hawa/contracts';
import { apply, plan, projectionRequestFor, requestIdFor } from '@hawa/domain';
import { createApp } from '../src/app.js';

/**
 * The projection ops that need Core's composition (slice 2.3 part C; PHASE2_DESIGN.md 2.3 and 2.8):
 * a design outcome, a requester's button, a reminder, and the acknowledgements of a new request and a
 * round. Each is the legacy path's own logic with its sends taken out, so these check what the
 * projection records and what it answers the lifecycle to send, and that nothing reached Telegram.
 */
const url = process.env.TEST_DATABASE_URL;
const TENANT = '00000000-0000-4000-a000-000000000001';
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const WORKER = ['worker', 'compose', 'token'].join('_');
const OFFICE = '91000011';

describe.skipIf(!url)('the lifecycle projection composes what the legacy path sent', () => {
  const db = createDb(url || 'postgres://localhost/hawa_test');
  const bridge = {
    dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }),
    dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }),
    downloadFile: vi.fn().mockResolvedValue(null),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    handleCommand: vi.fn().mockReturnValue(null),
  };
  let app: ReturnType<typeof createApp>;
  afterAll(() => db.destroy());
  beforeEach(() => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', OFFICE);
    vi.stubEnv('AUTO_GENERATE_DAILY_CAP_GLOBAL', '1000000');
    app = createApp({ db, telegramBridge: bridge as never });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` };
  const project = async (requestId: string, body: ProjectionRequest) => {
    const res = await app.request(`/v1/internal/lifecycle/${requestId}/project`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    return (await res.json()) as ProjectionResponse;
  };
  const asOwner = <T>(fn: (trx: Parameters<Parameters<typeof withRlsContext>[2]>[0]) => Promise<T>) =>
    withRlsContext(db, { tenantId: TENANT, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, fn);

  let seq = 0;
  const newChat = () => String(9_420_000 + Math.floor(Math.random() * 80_000) + ++seq);

  /** One event through the domain and the projection, as the worker's shell runs it. */
  const step = async (s: LifecycleStateV1 | undefined, ev: LifecycleEvent) => {
    const p = plan(s, ev, Date.now());
    if (p.ignored) throw new Error(`plan ignored ${ev.type}: ${p.reason}`);
    const answer = await project(s?.requestId ?? (ev as { requestId: string }).requestId, projectionRequestFor(s, ev, p));
    const applied = apply(s, ev, answer, Date.now());
    if (applied.ignored) throw new Error('ignored');
    return { answer, state: applied.next, effects: applied.effects };
  };
  const open = async (chat = newChat()) => {
    const requestId = requestIdFor(chat, 800_001, 0);
    return step(undefined, {
      type: 'open', v: 1, eventId: `open:${requestId}`, requestId, tenantId: TENANT, chatId: chat, origin: { kind: 'telegram', chatId: chat, updateId: 800_001 },
      draft: { title: 'KAAE: Members evening…', rawText: `Members evening ${randomUUID()}`, clientId: KAAE, designInstructions: '', exactCopy: [{ id: 'copy_0', role: 'headline', text: 'Members evening' }], autoGenerate: true, variant: { width: 1080, height: 1350 } },
    });
  };
  const finished = (s: LifecycleStateV1, report: Record<string, unknown>) =>
    step(s, { type: 'designFinished', v: 1, eventId: `dr-finished:${s.rounds[s.round].runId}`, runId: s.rounds[s.round].runId!, round: s.round, taskId: s.rounds[s.round].taskId, report: report as never });
  const messagesOf = (answer: ProjectionResponse): LifecycleMessage[] => answer.results.flatMap((r) => ((r as { messages?: LifecycleMessage[] }).messages ?? []));
  const taskState = async (taskId: string) => asOwner(async (trx) => (await sql<{ state: string; rev: string | null }>`
    SELECT state::text, current_design_revision_id::text AS rev FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(trx)).rows[0]);

  it('a new request is acknowledged in the words intake uses, as a courtesy message the lifecycle sends', async () => {
    const { answer } = await open();
    const [ack] = messagesOf(answer);
    expect(ack).toMatchObject({ kind: 'text', class: 'courtesy', parseMode: 'HTML' });
    expect(ack.text).toContain('Request saved. Preparing your Canva draft');
    expect(ack.text).toContain('KAAE (Accreditation)');
    expect(ack.text).toContain('1080×1350 (4:5)');
    expect(bridge.dispatchOutboundMessage).not.toHaveBeenCalled();
  });

  it('a draft outcome becomes the Desk revision, moves the task to review, and composes the draft message that starts its reminders', async () => {
    const opened = await open();
    const taskId = opened.state.rounds[0].taskId;
    const { answer, state } = await finished(opened.state, { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAGlc0000001', runId: opened.state.rounds[0].runId });
    expect(answer.stage).toBe('in_review');
    const [outcome] = answer.results as Array<{ op: string; hasDraft: boolean; revisionId?: string; designId?: string }>;
    expect(outcome).toMatchObject({ op: 'recordOutcome', hasDraft: true, designId: 'DAGlc0000001' });
    const row = await taskState(taskId);
    expect(row.state).toBe('human_review');
    expect(outcome.revisionId).toBe(row.rev);
    expect(state.draft).toMatchObject({ taskId, revisionId: row.rev });
    const [message] = messagesOf(answer);
    expect(message).toMatchObject({ key: `${state.requestId}:2:outcome`, chatId: opened.state.chatId, class: 'critical', onSent: { requestId: state.requestId, what: 'draft', taskId } });
    expect(message.text).toContain('Your Canva draft is ready');
    expect(JSON.stringify(message.replyMarkup)).toContain(`rq:ok:${taskId}`);
    // Nothing went to Telegram from Core, and the legacy outbox has no notify row for it.
    expect(bridge.dispatchOutboundMessage).not.toHaveBeenCalled();
    expect(bridge.dispatchOutboundPhoto).not.toHaveBeenCalled();
    const notices = await asOwner(async (trx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.outbox_commands WHERE aggregate_id = ${taskId}::uuid AND command_type = 'notify.telegram'`.execute(trx)).rows[0].n);
    expect(notices).toBe(0);
  });

  it('the draft picture goes by reference to its stored export, never as bytes', async () => {
    const opened = await open();
    const taskId = opened.state.rounds[0].taskId;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
    const ids = await asOwner(async (trx) => {
      const op = randomUUID();
      await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status)
        VALUES (${op}::uuid, ${TENANT}::uuid, ${taskId}::uuid, ${KAAE}::uuid, 'test', ${`t-${op}`}, 'h', 'export', 'retrieved')`.execute(trx);
      const id = randomUUID();
      await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content)
        VALUES (${id}::uuid, ${TENANT}::uuid, ${taskId}::uuid, ${KAAE}::uuid, ${op}::uuid, 'png', encode(digest(${png}::bytea, 'sha256'), 'hex'), ${png}::bytea)`.execute(trx);
      return { id };
    });
    const { answer } = await finished(opened.state, { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAGlc0000002' });
    const photo = messagesOf(answer).find((m) => m.kind === 'photo');
    expect(photo).toMatchObject({ class: 'critical', exportRef: { tenantId: TENANT, taskId, artifactId: ids.id } });
    expect(photo!.caption).toContain(`Task ID: ${taskId}`);
    // A TelegramSender built before 'photo' (a worker rolled back) sends any kind but a document as
    // `text`: it carries the caption, so the requester still gets the words they reply to.
    expect(photo!.text).toBe(photo!.caption);
    expect(JSON.stringify(photo)).not.toContain(png.toString('base64'));
  });

  it('a question the design run stopped to ask pauses the task and composes the question with its answer buttons', async () => {
    const opened = await open();
    const taskId = opened.state.rounds[0].taskId;
    await asOwner((trx) => sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status, stages)
      VALUES (${randomUUID()}::uuid, ${TENANT}::uuid, ${taskId}::uuid, ${KAAE}::uuid, 'test', ${`q-${taskId}`}, 'h', '{}'::jsonb, 'standard', 'failed',
        ${JSON.stringify({ directed: { refused: 'NEEDS_CLARIFICATION', clarify: { question: 'Which logo should be bigger?', options: ['The KAAE seal', 'The university crest'] } } })}::jsonb)`.execute(trx));
    const { answer, state } = await finished(opened.state, { status: 'DESIGN_FAILED', code: 'NEEDS_CLARIFICATION' });
    expect(answer.stage).toBe('awaiting_answer');
    expect(answer.results[0]).toMatchObject({ op: 'recordOutcome', hasDraft: false, question: { id: questionIdOf(taskId), question: 'Which logo should be bigger?' } });
    expect((await taskState(taskId)).state).toBe('paused');
    expect(state.question).toMatchObject({ id: questionIdOf(taskId), taskId, options: ['The KAAE seal', 'The university crest'] });
    const [message] = messagesOf(answer);
    expect(message.onSent).toMatchObject({ what: 'question', taskId });
    expect(JSON.stringify(message.replyMarkup)).toContain(`rq:a1:${taskId}`);
  });

  it('an outcome with no draft goes to an operator (stage manual), and the requester is told honestly', async () => {
    const opened = await open();
    const { answer } = await finished(opened.state, { status: 'DESIGN_FAILED', code: 'HARD_QA_REFUSED' });
    expect(answer.stage).toBe('manual');
    expect((await taskState(opened.state.rounds[0].taskId)).state).toBe('failed_operator');
    expect(messagesOf(answer)[0].text).toContain('We could not make the automatic draft');
    expect(messagesOf(answer)[0].onSent).toBeUndefined();
  });

  it('the requester\'s buttons: approve tells the office once; a button on a draft that is not current says why and acts on nothing', async () => {
    const opened = await open();
    const draft = await finished(opened.state, { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAGlc0000003' });
    const taskId = opened.state.rounds[0].taskId;
    const ok = await step(draft.state, { type: 'requesterDecision', v: 1, eventId: 'tg:ok:1', taskId, kind: 'ok', actorId: '7', callbackQueryId: 'cb-1' });
    const okMessages = messagesOf(ok.answer);
    expect(okMessages.map((m) => m.chatId)).toEqual([opened.state.chatId, OFFICE]);
    expect(okMessages[0].text).toContain('you approved this design');
    expect(okMessages[1]).toMatchObject({ key: `notify.office:requester-approved:${taskId}`, class: 'critical' });
    // The effects answer the tapped button too.
    expect(ok.effects).toContainEqual({ type: 'answerCallback', chatId: opened.state.chatId, callbackQueryId: 'cb-1' });

    // A change is being made: a button on the old draft says so.
    const change = await step(ok.state, { type: 'requesterDecision', v: 1, eventId: 'tg:chg:2', taskId, kind: 'change', directive: 'Make the logo bigger', actorId: '7' });
    expect(change.answer.stage).toBe('designing');
    expect(messagesOf(change.answer)[0].text).toContain('Change received');
    const stale = await step(change.state, { type: 'requesterDecision', v: 1, eventId: 'tg:ok:3', taskId, kind: 'ok', actorId: '7' });
    expect(messagesOf(stale.answer)).toHaveLength(1);
    expect(messagesOf(stale.answer)[0].text).toContain('still being made');
    const marks = await asOwner(async (trx) => (await sql<{ kind: string }>`SELECT event_kind AS kind FROM hawa.inbox_events
      WHERE source_event_id LIKE ${`lc:${opened.state.requestId}:%`} ORDER BY received_at`.execute(trx)).rows.map((r) => r.kind));
    expect(marks).toEqual(['telegram_requester_ok', 'telegram_requester_ok']);
  });

  it('a reminder is composed for a draft nobody answered, and skipped once the requester wrote in the chat', async () => {
    const opened = await open();
    const draft = await finished(opened.state, { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAGlc0000004' });
    const taskId = opened.state.rounds[0].taskId;
    const sentAt = Date.now() - 60_000;
    const sent = await step(draft.state, { type: 'messageSent', v: 1, eventId: `sent:${draft.state.requestId}:2:outcome`, key: `${draft.state.requestId}:2:outcome`, what: 'draft', taskId, at: sentAt });
    const remind = await step(sent.state, { type: 'remind', v: 1, eventId: `remind:${sent.state.requestId}:draft:1:${taskId}`, kind: 'draft', day: 1, stageEpoch: sent.state.stageEpoch, taskId });
    expect(remind.answer.results[0]).toMatchObject({ op: 'composeReminder', skip: false });
    const [reminder] = messagesOf(remind.answer);
    expect(reminder).toMatchObject({ key: `${sent.state.requestId}:reminder:draft:1:${taskId}`, class: 'critical' });
    expect(reminder.text).toContain('Is this design right for you?');

    // The requester wrote in the chat after the draft: the day-5 reminder is skipped.
    await asOwner((trx) => sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
      VALUES (${TENANT}::uuid, 'telegram', ${`${opened.state.chatId}:900001:decision`}, 'telegram_intake_decision_change', '{}'::jsonb, 'h', true)`.execute(trx));
    const day5 = await step(remind.state, { type: 'remind', v: 1, eventId: `remind:${sent.state.requestId}:draft:5:${taskId}`, kind: 'draft', day: 5, stageEpoch: remind.state.stageEpoch, taskId });
    expect(day5.answer.results[0]).toMatchObject({ op: 'composeReminder', skip: true, messages: [] });
  });
});
