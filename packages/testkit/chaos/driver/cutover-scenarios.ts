/**
 * R10 acceptance on the chaos stack: what rolling back means once every chat is lifecycle-owned
 * (R10.K1, R10.K2). The handoff of requests made before the lifecycle cutover (R10.H1) was removed
 * with stage 2 of ADR-135, which deletes the code that finished them.
 * docs/10_WORKFLOW_RELIABILITY.md "Legacy delivery cutover pin"; ADR-052, ADR-059, ADR-065,
 * ADR-113/114, ADR-129, ADR-130, ADR-135 and ADR-136.
 *
 * This release has no Core poller, no chat list and no old intake. R10.K1 rolls it back to the previous
 * release (driver/cutover.ts buildPreviousRelease: --previous-release, else RELEASE_MANIFEST.json's
 * build commit) with lifecycle requests in flight and forward again; R10.K2 empties the retired chat
 * list on this release. Run them alone, in this order (the suite starts the stack on this release and
 * builds the previous one when they are selected):
 *
 *   npx tsx packages/testkit/chaos/run.ts --only R10.K1,R10.K2 [--previous-release <commit>]
 *
 * Every requester action is a Telegram update the fake serves to whichever process polls: a text, or
 * a Telegram reply that quotes the bot's message as Telegram does. Office actions are the Desk's API
 * calls.
 */
import { randomUUID } from 'node:crypto';
import { fakes, query, secrets, sql } from './stack.js';
import { deployConfig, type DeployReport, type StackConfig } from './cutover.js';
import {
  approve, briefText, chatInboxInvocations, deliver, designOutcome, OFFICE_CHAT, sentTo,
  storedOffset, tasksOfChat, taskState, textUpdate, waitDelivered, waitUntil, type InvariantResult,
} from './scenario.js';

const BOT = { id: 7000001, is_bot: true, first_name: 'Hawa chaos bot' };
type Sent = Awaited<ReturnType<typeof sentTo>>[number];

/** The bot's message as Telegram quotes it in reply_to_message: its text (or caption) and buttons. */
function quoted(chat: string, record: Sent): Record<string, unknown> {
  const body: Record<string, unknown> = { message_id: record.messageId, from: BOT, chat: { id: Number(chat), type: 'private' },
    date: Math.floor(Date.parse(record.at) / 1000) };
  if (record.method === 'sendDocument' || record.method === 'sendPhoto') {
    if (record.fullText) body.caption = record.fullText;
    if (record.method === 'sendDocument') body.document = { file_id: `sent-${record.messageId}`, file_name: record.fileName ?? 'design.png' };
  } else if (record.fullText) body.text = record.fullText;
  if (record.replyMarkup) body.reply_markup = record.replyMarkup;
  return body;
}

export function textReply(chat: string, text: string, to: Sent) {
  const update = textUpdate(chat, text);
  (update.message as Record<string, unknown>).reply_to_message = quoted(chat, to);
  return update;
}

async function send(update: Record<string, unknown>): Promise<number> {
  const [id] = await fakes.updates([update]);
  return id;
}

/** Messages that tell a requester their legitimate follow-up was refused or set aside. */
const REFUSALS: Array<[string, RegExp]> = [
  ['stale reply refusal', /no longer waiting for changes/i],
  ['ambiguous request refusal', /More than one design is waiting for your changes/i],
  ['/new required', /Please send \/new followed by/i],
  ['parked update notice', /could not process it automatically/i],
  ['late change', /so it was not applied to the design/i],
  ['revision blocked', /no revision started|no answer was applied/i],
];

/** Sends in the chat (only those Telegram showed), each once; and no refusal the scenario did not expect. */
async function chatChecks(label: string, chat: string, allowRefusals: string[] = []): Promise<InvariantResult[]> {
  const shown = await sentTo(chat);
  const key = (s: Sent) => `${s.method}:${s.documentSha256 ?? s.textHash}`;
  const counts = new Map<string, number>();
  for (const s of shown) counts.set(key(s), (counts.get(key(s)) || 0) + 1);
  const dupes = [...counts].filter(([, n]) => n > 1);
  const refusals = shown.flatMap((s) => REFUSALS.filter(([name, re]) => !allowRefusals.includes(name) && re.test(s.fullText ?? s.text ?? ''))
    .map(([name]) => name));
  return [
    { name: `${label}: each message reaches the requester once`, ok: dupes.length === 0,
      detail: dupes.length ? `duplicates: ${dupes.map(([k, n]) => `${k.slice(0, 40)}×${n}`).join(', ')}` : `${shown.length} sends, all distinct` },
    { name: `${label}: no refusal of a legitimate follow-up`, ok: refusals.length === 0,
      detail: refusals.length ? refusals.join(', ') : 'none' },
  ];
}

/** Each update was handed on once and finished: one ChatInbox invocation per poller key, or Core's own intake. */
async function updateChecks(label: string, chat: string, viaWorker: number[], viaEither: number[] = []): Promise<InvariantResult[]> {
  const out: InvariantResult[] = [];
  const inv = await chatInboxInvocations(chat);
  for (const id of viaWorker) {
    const mine = inv.filter((i) => i.idempotency_key === `tg-${id}`);
    out.push({ name: `${label}: update ${id} has one ChatInbox invocation, completed`, ok: mine.length === 1 && mine[0].status === 'completed',
      detail: JSON.stringify(mine.map((i) => i.status)) });
  }
  for (const id of viaEither) {
    const mine = inv.filter((i) => i.idempotency_key === `tg-${id}`);
    out.push({ name: `${label}: update ${id} (both pollers live) has at most one ChatInbox invocation, completed`,
      ok: mine.length <= 1 && mine.every((i) => i.status === 'completed'), detail: JSON.stringify(mine.map((i) => i.status)) });
  }
  const unfinished = inv.filter((i) => i.status !== 'completed');
  out.push({ name: `${label}: every ChatInbox invocation of the chat completed`, ok: unfinished.length === 0,
    detail: `${inv.length} invocations${unfinished.length ? `: ${JSON.stringify(unfinished.map((i) => `${i.idempotency_key}:${i.status}`))}` : ''}` });
  const all = [...viaWorker, ...viaEither];
  if (all.length) {
    const parked = await query<{ n: string }>(sql`SELECT count(*) AS n FROM hawa.inbox_events WHERE source_event_id = ANY(${all.map((id) => `parked-update-${id}`)})`);
    out.push({ name: `${label}: no update was dead-lettered`, ok: Number(parked[0]?.n ?? 0) === 0, detail: `parked=${parked[0]?.n ?? 0}` });
    // One task at most per update, however many processes read it.
    const perUpdate = await query<{ key: string; n: string }>(sql`SELECT split_part(idempotency_key, '_', 1) AS key, count(*) AS n
      FROM hawa.outbox_commands WHERE command_type = 'task.created'
        AND split_part(idempotency_key, '_', 1) = ANY(${all.map((id) => `chat:telegram:${chat}:${id}`)}) GROUP BY 1`);
    const twice = perUpdate.filter((r) => Number(r.n) > 1);
    out.push({ name: `${label}: no update made two tasks`, ok: twice.length === 0, detail: twice.length ? JSON.stringify(twice) : `${perUpdate.length} update(s) made a task` });
  }
  return out;
}

async function pinOf(taskId: string): Promise<string | null> {
  const [row] = await query<{ pin: string }>(sql`SELECT delivery_executor_pin AS pin FROM hawa.tasks WHERE id = ${taskId}::uuid`);
  return row?.pin ?? null;
}

async function requestsOf(chat: string) {
  return query<{ request_id: string; owner: string; stage: string; rev: string; root_task_id: string; current_task_id: string }>(sql`
    SELECT request_id::text, owner, stage, rev, root_task_id::text, current_task_id::text FROM hawa.requests WHERE chat_id = ${chat} ORDER BY created_at`);
}

async function publicationsOf(taskId: string) {
  return query<{ executor: string; state: string }>(sql`SELECT executor, state::text AS state FROM hawa.publications WHERE task_id = ${taskId}::uuid`);
}

/** Runs one chat's continuation; a failure becomes an invariant, so the other chats still report. */
async function step(label: string, events: string[], out: InvariantResult[], body: () => Promise<InvariantResult[]>): Promise<void> {
  try {
    const got = await body();
    out.push(...got);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    events.push(`${label}: FAILED ${detail}`);
    out.push({ name: `${label}: completed`, ok: false, detail });
  }
}

/** The office asks for a revision in the Desk; the request then waits for the requester (ADR-114, rev 3). */
async function officeRevision(taskId: string): Promise<{ status: number }> {
  const [root] = await query<{ revision_id: string }>(sql`SELECT current_design_revision_id AS revision_id FROM hawa.tasks WHERE id = ${taskId}::uuid`);
  if (!root?.revision_id) throw new Error(`task ${taskId} has no reviewable revision`);
  const res = await fakes.core(`/tasks/${taskId}/revisions/${root.revision_id}/decisions`, secrets().CHAOS_REVIEWER_KEY, {
    headers: { 'Idempotency-Key': randomUUID() }, body: { action: 'revision_requested', revisionRequest: {
      scope: 'copy', category: 'factual_error', targetNodes: ['venue'], priority: 'high', isReusableFeedback: false,
      comment: 'Please confirm the venue with the requester' } } });
  return { status: res.status };
}

async function lifecycleNotice(chat: string, requestId: string, key: string): Promise<Sent> {
  const messageId = await waitUntil(`the ${key} notice of request ${requestId}`, async () => {
    const [mark] = await query<{ message_id: string }>(sql`SELECT payload->>'messageId' AS message_id FROM hawa.inbox_events
      WHERE source_account_id = 'telegram_delivery' AND event_kind = 'telegram_message_sent'
        AND source_event_id LIKE ${`lc:${requestId}:%:${key}:send`} ORDER BY received_at DESC LIMIT 1`);
    return mark?.message_id ? Number(mark.message_id) : null;
  });
  const record = (await sentTo(chat)).find((s) => s.messageId === messageId);
  if (!record) throw new Error(`the fake chat ${chat} does not show message ${messageId}`);
  return record;
}

/** The first line of a bot message without markup or IDs. */
const gist = (s: Sent) => (s.fullText ?? s.text ?? `(${s.method})`).split('\n')[0].replace(/<[^>]+>/g, '')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>').trim().slice(0, 60);

/** What a chat holds, for the report: its tasks and what the bot said. */
async function chatSummary(name: string, chat: string): Promise<string> {
  const tasks = await query<{ id: string; state: string; pin: string; parent: string | null }>(sql`SELECT t.id::text, t.state::text AS state,
      t.delivery_executor_pin AS pin, o.payload->'studioOptions'->>'parentTaskId' AS parent FROM hawa.tasks t
    JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
    WHERE o.payload->>'sourceChannelId' = ${chat} ORDER BY t.created_at`);
  return `${name} ${chat}: tasks ${JSON.stringify(tasks.map((t) => `${t.id.slice(0, 8)}:${t.state}:${t.pin}${t.parent ? `<${t.parent.slice(0, 8)}` : ''}`))}; ` +
    `sends ${JSON.stringify((await sentTo(chat)).map((s) => `${s.method.replace('send', '')}:${gist(s)}`))}`;
}

// ---------------------------------------------------------------------------------------------------
// R10.H1 (requests made on the previous release while Core polled, continued after the deploy of this
// release) was removed with stage 2 of ADR-135: this release does not finish old-intake requests, and
// production had none open when it shipped (GET /v1/operations/legacy-path, stage2Ready). A reply or
// a button under an old draft is a stale reply now; apps/core/test/lifecycle-internal-intake.test.ts
// covers that.

/** This release as production runs it: the worker polls, and there is no chat list any more. */
export const THIS_RELEASE: StackConfig = { release: 'current', poller: 'worker', chats: null };

/** A request's first draft reached review (legacy draft with buttons, or a lifecycle request in review). */
async function briefToDraftSent(chat: string): Promise<string> {
  const [task] = await waitUntil(`a task for chat ${chat}`, async () => { const t = await tasksOfChat(chat); return t.length ? t : null; }, 180_000);
  await waitUntil(`the draft of ${task.id}`, async () => {
    const outcome = await designOutcome(task.id);
    if (outcome && outcome !== 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW') throw new Error(`design ended ${outcome}`);
    const [r] = await query<{ stage: string }>(sql`SELECT stage FROM hawa.requests WHERE chat_id = ${chat} AND current_task_id = ${task.id}::uuid`);
    return (await taskState(task.id)) === 'human_review' && (r ? r.stage === 'in_review' : true);
  }, 240_000, 2000);
  return task.id;
}

// ---------------------------------------------------------------------------------------------------
// R10.K1: lifecycle requests in flight, this release rolled back to the previous one by a deploy, then
// forward again. Since ADR-135 that is the rollback (runbooks/20_architecture_operations.md): the
// previous release keeps the worker poller and every chat on the lifecycle (`*`, which it still reads).

/** The previous release as production ran it from 2026-09-28: the worker polls, every chat enrolled. */
export const PREVIOUS_RELEASE_LIVE: StackConfig = { release: 'previous', poller: 'worker', chats: '*' };

export async function rollbackToPreviousRelease(newChat: () => string, events: string[]): Promise<{ extra: InvariantResult[]; back: DeployReport; forward: DeployReport }> {
  const out: InvariantResult[] = [];
  const chat = { P: newChat(), Q: newChat(), R: newChat(), N1: newChat(), N2: newChat(), W: newChat() };
  events.push(`chats ${JSON.stringify(chat)}; this release, the worker polls`);

  // --- Lifecycle requests in flight on this release ---------------------------------------------------
  const briefs: Record<string, number> = {};
  for (const k of ['P', 'Q', 'R'] as const) briefs[k] = await send(textUpdate(chat[k], briefText(`R10.K1.${k}`)));
  const taskP = await briefToDraftSent(chat.P);
  const taskQ = await briefToDraftSent(chat.Q);
  const taskR = await briefToDraftSent(chat.R);
  const [reqP, reqQ, reqR] = [(await requestsOf(chat.P))[0], (await requestsOf(chat.Q))[0], (await requestsOf(chat.R))[0]];
  if (![reqP, reqQ, reqR].every((r) => r?.owner === 'restate')) throw new Error(`requests not lifecycle-owned: ${JSON.stringify([reqP, reqQ, reqR])}`);
  // Q: approved and mid-delivery (held between its two files).
  if ((await approve(taskQ, { pinDeck: true })).status >= 300) throw new Error('approval of Q refused');
  await fakes.hold('worker.delivery.between-files', {}, 1);
  const deliveredQ = await deliver(taskQ);
  events.push(`Q ${taskQ}: deliver HTTP ${deliveredQ.status} executor ${deliveredQ.body?.executor}`);
  const heldQ = await fakes.wait('worker.delivery.between-files', 240_000);
  events.push(`Q: delivery held between files on ${heldQ?.service}`);
  // R: the office asked for a revision; the request waits for the requester's reply to its notice.
  const office = await officeRevision(taskR);
  if (office.status !== 201) throw new Error(`office revision of R: HTTP ${office.status}`);
  await waitUntil('R waiting for the requester (rev 3)', async () => { const [r] = await requestsOf(chat.R); return r?.stage === 'manual' && Number(r.rev) === 3 ? r : null; });
  const noticeR = await lifecycleNotice(chat.R, reqR.request_id, 'office-revision-notify');
  events.push(`P ${taskP} in review; R ${taskR} waits for the requester (notice ${noticeR.messageId})`);

  // --- Roll back: the previous release, deployed as any release -------------------------------------
  // W: a new brief sent right after Core was recreated from the previous release, while this release's
  // colour still polls (until Restate routes ChatInbox to the new colour): one task and one
  // acknowledgement, whoever reads it.
  let windowBrief = 0;
  const back = await deployConfig(PREVIOUS_RELEASE_LIVE, {
    afterCore: async () => { windowBrief = await send(textUpdate(chat.W, briefText('R10.K1.W'))); },
    beforeDrain: async () => { await fakes.release(); },
  });
  events.push(...back.steps.map((s) => `rollback: ${s}`));
  out.push({ name: 'rollback: the previous release registered, this release\'s colour drained and removed', ok: back.register.code === 0 && back.removed.includes(back.live),
    detail: `idle=${back.idle} live=${back.live} removed=${back.removed.join(',')} drains=${back.drains.lines.join(' ')}` });

  // Q: the delivery held on this release's colour finishes there, once.
  await step('Q (mid-delivery at the rollback)', events, out, async () => {
    await waitDelivered(chat.Q, taskQ, 300_000, 2);
    const pubs = await publicationsOf(taskQ);
    const [r] = await requestsOf(chat.Q);
    return [
      { name: 'Q: the delivery in flight finished once after the rollback', ok: pubs.length === 1 && pubs[0].executor === 'restate' && pubs[0].state === 'complete' && r.stage === 'delivered',
        detail: JSON.stringify({ pubs, stage: r.stage }) },
      ...(await chatChecks('Q', chat.Q)),
    ];
  });

  // P: awaiting office approval: the Desk approves and delivers on the previous release.
  await step('P (awaiting approval at the rollback)', events, out, async () => {
    const approved = await approve(taskP, { pinDeck: true });
    const delivered = await deliver(taskP);
    events.push(`P: approve HTTP ${approved.status}, deliver HTTP ${delivered.status} executor ${delivered.body?.executor}`);
    await waitDelivered(chat.P, taskP, 300_000, 2);
    const pubs = await publicationsOf(taskP);
    return [
      { name: 'P: approved and delivered by its request after the rollback', ok: pubs.length === 1 && pubs[0].executor === 'restate' && pubs[0].state === 'complete',
        detail: JSON.stringify(pubs) },
      ...(await chatChecks('P', chat.P)),
    ];
  });

  // R: the requester replies to the office's revision notice after the rollback.
  let replyR = 0;
  await step('R (waiting for the requester at the rollback)', events, out, async () => {
    replyR = await send(textReply(chat.R, 'The venue is Rotana Hotel, Erbil', noticeR));
    const r = await waitUntil('R to take the reply', async () => { const [row] = await requestsOf(chat.R); return Number(row?.rev) >= 4 ? row : null; }, 180_000, 2000);
    const tasks = await tasksOfChat(chat.R);
    events.push(`R: reply ${replyR} → request ${r.stage} rev ${r.rev}; tasks ${tasks.length}`);
    return [
      { name: 'R: the requester\'s reply reached its request on the previous release', ok: Number(r.rev) >= 4 &&
        tasks.every((t) => t.id === r.root_task_id || t.id === r.current_task_id), detail: JSON.stringify({ request: r, tasks: tasks.length }) },
      ...(await updateChecks('R', chat.R, [briefs.R, replyR])),
      ...(await chatChecks('R', chat.R)),
    ];
  });

  await step('W (new brief during the rollback)', events, out, async () => {
    await waitUntil('W to be read', async () => (await storedOffset()) >= windowBrief, 180_000, 1000);
    const task = await briefToDraftSent(chat.W);
    const tasks = await tasksOfChat(chat.W);
    const requests = await requestsOf(chat.W);
    // The previous release acknowledges "Request received."; this one (ADR-145) "Got it. I'm making a first
    // draft of …" or "Got it. A designer will make …". The brief may be answered by either.
    const acks = (await sentTo(chat.W)).filter((s) => /Request (received|saved)|I'm making a first draft of|A designer will make/i.test(s.fullText ?? ''));
    events.push(`W: brief ${windowBrief} → task ${task} pin ${await pinOf(task)}, requests ${requests.length}, acknowledgements ${acks.length}`);
    return [
      { name: 'W: one lifecycle request, one task and one acknowledgement for the brief sent during the rollback', ok: tasks.length === 1 && acks.length === 1 &&
        requests.length === 1 && requests[0].owner === 'restate', detail: JSON.stringify({ tasks: tasks.length, requests: requests.length, acks: acks.length, pin: await pinOf(task) }) },
      ...(await updateChecks('W', chat.W, [windowBrief])),
      ...(await chatChecks('W', chat.W)),
    ];
  });

  // N1: a new chat after the rollback: the previous release, with every chat enrolled, opens a lifecycle request.
  await step('N1 (new chat after the rollback)', events, out, async () => {
    const brief = await send(textUpdate(chat.N1, briefText('R10.K1.N1')));
    const task = await briefToDraftSent(chat.N1);
    const requests = await requestsOf(chat.N1);
    return [
      { name: 'N1: a new request on the previous release is a lifecycle request', ok: requests.length === 1 && requests[0].owner === 'restate' && (await pinOf(task)) === 'restate',
        detail: JSON.stringify({ pin: await pinOf(task), requests }) },
      ...(await updateChecks('N1', chat.N1, [brief])),
      ...(await chatChecks('N1', chat.N1)),
    ];
  });

  // --- Roll forward again ---------------------------------------------------------------------------------
  const forward = await deployConfig(THIS_RELEASE);
  events.push(...forward.steps.map((s) => `forward: ${s}`));
  out.push({ name: 'roll forward: this release registered, the previous one drained and removed', ok: forward.register.code === 0 && forward.removed.includes(forward.live),
    detail: `idle=${forward.idle} live=${forward.live} removed=${forward.removed.join(',')} drains=${forward.drains.lines.join(' ')}` });

  await step('N2 (new chat after the roll forward)', events, out, async () => {
    const brief = await send(textUpdate(chat.N2, briefText('R10.K1.N2')));
    const task = await briefToDraftSent(chat.N2);
    const requests = await requestsOf(chat.N2);
    return [
      { name: 'N2: a new request after the roll forward opens a lifecycle request', ok: requests.length === 1 && requests[0].owner === 'restate' && (await pinOf(task)) === 'restate',
        detail: JSON.stringify(requests) },
      ...(await updateChecks('N2', chat.N2, [brief])),
      ...(await chatChecks('N2', chat.N2)),
    ];
  });

  // N1, opened on the previous release, is approved and delivered on this one; R, whose requester
  // revision went to native editing on the previous release (ADR-113/114), is left exactly as it was.
  await step('N1 and R after the roll forward', events, out, async () => {
    const [before] = await requestsOf(chat.R);
    const [n1] = await tasksOfChat(chat.N1);
    const approved = await approve(n1.id);
    const delivered = await deliver(n1.id);
    events.push(`N1: approve HTTP ${approved.status}, deliver HTTP ${delivered.status}`);
    await waitDelivered(chat.N1, n1.id, 300_000);
    const pubs = await publicationsOf(n1.id);
    const [after] = await requestsOf(chat.R);
    return [
      { name: 'N1: a request opened on the previous release is delivered once after the roll forward', ok: pubs.length === 1 &&
        pubs[0].executor === 'restate' && pubs[0].state === 'complete', detail: JSON.stringify(pubs) },
      { name: 'R: unchanged by the roll forward', ok: JSON.stringify(after) === JSON.stringify(before), detail: JSON.stringify({ before, after }) },
      ...(await chatChecks('N1 after forward', chat.N1)),
    ];
  });

  for (const [name, c] of Object.entries(chat)) out.push(...(await chatChecks(`${name} (whole chat)`, c)));
  for (const [name, c] of Object.entries(chat)) events.push(await chatSummary(name, c));
  const officeAlerts = (await sentTo(OFFICE_CHAT)).filter((s) => /could not be processed|set aside/i.test(s.fullText ?? ''));
  out.push({ name: 'no update was set aside for the office', ok: officeAlerts.length === 0, detail: `office alerts=${officeAlerts.length}` });
  return { extra: out, back, forward };
}

// ---------------------------------------------------------------------------------------------------
// R10.K2: ADR-136's smaller rollback was emptying HAWA_LIFECYCLE_CHATS. On this release the setting is
// retired (ADR-135): emptied by a deploy it changes nothing, with a lifecycle request waiting for its
// requester and a new chat; then the setting is removed again.

export async function retiredSettingsIgnored(newChat: () => string, events: string[]): Promise<{ extra: InvariantResult[] }> {
  const out: InvariantResult[] = [];
  const chat = { X: newChat(), Y: newChat() };
  const brief = await send(textUpdate(chat.X, briefText('R10.K2.X')));
  const taskX = await briefToDraftSent(chat.X);
  const [reqX] = await requestsOf(chat.X);
  if (reqX?.owner !== 'restate') throw new Error(`X is not a lifecycle request: ${JSON.stringify(reqX)}`);
  const office = await officeRevision(taskX);
  if (office.status !== 201) throw new Error(`office revision of X: HTTP ${office.status}`);
  await waitUntil('X waiting for the requester (rev 3)', async () => { const [r] = await requestsOf(chat.X); return r?.stage === 'manual' && Number(r.rev) === 3 ? r : null; });
  const noticeX = await lifecycleNotice(chat.X, reqX.request_id, 'office-revision-notify');

  const emptied = await deployConfig({ ...THIS_RELEASE, chats: '' });
  events.push(...emptied.steps.map((s) => `chat list emptied: ${s}`));
  out.push({ name: 'chat list emptied: registered, the old colour drained and removed', ok: emptied.register.code === 0 && emptied.removed.includes(emptied.live),
    detail: `idle=${emptied.idle} live=${emptied.live} removed=${emptied.removed.join(',')}` });

  await step('X (waiting for the requester with the chat list emptied)', events, out, async () => {
    const reply = await send(textReply(chat.X, 'The venue is Rotana Hotel, Erbil', noticeX));
    const r = await waitUntil('X to take the reply', async () => { const [row] = await requestsOf(chat.X); return Number(row?.rev) >= 4 ? row : null; }, 180_000, 2000);
    const tasks = await tasksOfChat(chat.X);
    return [
      { name: 'X: the reply reached its request with the chat list emptied', ok: Number(r.rev) >= 4 && tasks.every((t) => t.id === r.root_task_id || t.id === r.current_task_id),
        detail: JSON.stringify({ request: r, tasks: tasks.length }) },
      ...(await updateChecks('X', chat.X, [brief, reply])),
      ...(await chatChecks('X', chat.X)),
    ];
  });

  await step('Y (new chat with the chat list emptied)', events, out, async () => {
    const update = await send(textUpdate(chat.Y, briefText('R10.K2.Y')));
    const task = await briefToDraftSent(chat.Y);
    const requests = await requestsOf(chat.Y);
    return [
      { name: 'Y: a new request is still a lifecycle request (the retired setting sends nothing to the old path)', ok: requests.length === 1 &&
        requests[0].owner === 'restate' && (await pinOf(task)) === 'restate', detail: JSON.stringify({ pin: await pinOf(task), requests }) },
      ...(await updateChecks('Y', chat.Y, [update])),
      ...(await chatChecks('Y', chat.Y)),
    ];
  });

  const removed = await deployConfig(THIS_RELEASE);
  events.push(...removed.steps.map((s) => `chat list removed: ${s}`));
  out.push({ name: 'chat list removed: registered, the old colour drained and removed', ok: removed.register.code === 0 && removed.removed.includes(removed.live),
    detail: `idle=${removed.idle} live=${removed.live} removed=${removed.removed.join(',')}` });
  for (const [name, c] of Object.entries(chat)) events.push(await chatSummary(name, c));
  return { extra: out };
}
