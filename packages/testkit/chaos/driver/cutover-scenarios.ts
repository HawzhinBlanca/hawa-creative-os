/**
 * R10 acceptance on the chaos stack: the handoff of requests made before the lifecycle cutover
 * (R10.H1), and what rolling back means once every chat is lifecycle-owned (R10.K1, R10.K2).
 * docs/10_WORKFLOW_RELIABILITY.md "Legacy delivery cutover pin"; ADR-052, ADR-059, ADR-065,
 * ADR-113/114, ADR-129, ADR-130, ADR-135 and ADR-136.
 *
 * Since ADR-135 this release has no Core poller and no chat list, and its old intake only finishes
 * requests it started. So the old requests are made the way production made them: on the previous
 * release (driver/cutover.ts buildPreviousRelease), with Core polling and no chat on the lifecycle.
 * R10.H1 then deploys this release; R10.K1 rolls it back to the previous release with lifecycle
 * requests in flight and forward again; R10.K2 empties the retired chat list on this release. Run them
 * alone, in this order (the suite starts the stack on the previous release when they are selected):
 *
 *   npx tsx packages/testkit/chaos/run.ts --only R10.H1,R10.K1,R10.K2
 *
 * Every requester action is a Telegram update the fake serves to whichever process polls: a text, a
 * Telegram reply that quotes the bot's message as Telegram does (text and buttons), a button press
 * (callback_query) or a captioned photo. Office actions are the Desk's API calls.
 */
import { randomUUID } from 'node:crypto';
import { fakes, query, restateQuery, secrets, sql } from './stack.js';
import { deployConfig, type DeployReport, type StackConfig } from './cutover.js';
import {
  approve, briefText, briefToDraft, chatInboxInvocations, deliver, designOutcome, OFFICE_CHAT, REQUESTER_ID, sentTo, sleep,
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

export function photoReply(chat: string, fileId: string, size: number, caption: string, to: Sent) {
  const update = textUpdate(chat, '');
  const message = update.message as Record<string, unknown>;
  delete message.text;
  message.caption = caption;
  message.photo = [{ file_id: fileId, file_unique_id: `u-${fileId}`, width: 800, height: 600, file_size: size }];
  message.reply_to_message = quoted(chat, to);
  return update;
}

export function buttonPress(chat: string, to: Sent, data: string) {
  return { callback_query: { id: `cb-${randomUUID()}`, from: { id: REQUESTER_ID, is_bot: false, first_name: 'Chaos' },
    message: quoted(chat, to), chat_instance: `chaos-${chat}`, data } };
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

/** The newest message in the chat whose text matches, once it has arrived. */
async function waitForMessage(chat: string, label: string, match: (s: Sent) => boolean, since = 0, timeoutMs = 180_000): Promise<Sent> {
  return waitUntil(`${label} in chat ${chat}`, async () => (await sentTo(chat)).filter((s) => s.seq > since && match(s)).pop() ?? null, timeoutMs, 1000);
}

const lastSeq = async (chat: string) => Math.max(0, ...(await sentTo(chat)).map((s) => s.seq));

/** Children of a task (revisions, answers) Core created from the chat. */
async function childrenOf(taskId: string) {
  return query<{ id: string; state: string; pin: string; created: string }>(sql`SELECT t.id::text, t.state::text AS state,
      t.delivery_executor_pin AS pin, t.created_at::text AS created FROM hawa.tasks t
    JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
    WHERE o.payload->'studioOptions'->>'parentTaskId' = ${taskId} ORDER BY t.created_at`);
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

const legacyDraft = async (chat: string, taskId: string): Promise<Sent> => {
  const draft = (await sentTo(chat)).filter((s) => JSON.stringify(s.replyMarkup ?? '').includes(`rq:ok:${taskId}`)).pop();
  if (!draft) throw new Error(`no legacy draft message with buttons for task ${taskId} in chat ${chat}`);
  return draft;
};

/** The first line of a bot message without markup or IDs, to compare how two chats were answered. */
const gist = (s: Sent) => (s.fullText ?? s.text ?? `(${s.method})`).split('\n')[0].replace(/<[^>]+>/g, '')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>').trim().slice(0, 60);

interface FollowUp { update: number; newTasks: number; children: number; answers: string[] }

/** One requester action and what it led to: new tasks, revisions of `parent`, and the bot's answers. */
async function followUp(chat: string, parent: string, act: () => Promise<number>): Promise<FollowUp> {
  const tasksBefore = (await tasksOfChat(chat)).length;
  const childrenBefore = (await childrenOf(parent)).length;
  const seq = await lastSeq(chat);
  const update = await act();
  await waitUntil(`update ${update} to be read`, async () => (await storedOffset()) >= update, 180_000, 1000);
  await waitUntil(`an answer to update ${update}`, async () => (await sentTo(chat)).some((s) => s.seq > seq), 30_000, 1000).catch(() => undefined);
  await sleep(8000);
  return { update, newTasks: (await tasksOfChat(chat)).length - tasksBefore, children: (await childrenOf(parent)).length - childrenBefore,
    answers: (await sentTo(chat)).filter((s) => s.seq > seq).map(gist) };
}

const sameAs = (label: string, after: FollowUp, control: FollowUp): InvariantResult => {
  const shape = (f: FollowUp) => JSON.stringify({ newTasks: f.newTasks, children: f.children, answers: f.answers });
  return { name: `${label}: answered as legacy intake answered the same action before the switch`, ok: shape(after) === shape(control),
    detail: `after=${shape(after)} control=${shape(control)}` };
};

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
// R10.H1: requests made on the previous release while Core polled and no chat was on the lifecycle,
// continued after this release is deployed.

/** This release as production runs it: the worker polls, and there is no chat list any more. */
export const THIS_RELEASE: StackConfig = { release: 'current', poller: 'worker', chats: null };

export async function handoffOfOldRequests(newChat: () => string, events: string[]): Promise<{ extra: InvariantResult[]; deploy: DeployReport }> {
  const out: InvariantResult[] = [];
  const chat = { A: newChat(), B: newChat(), C: newChat(), D: newChat(), E: newChat(), F: newChat(), G: newChat() };
  events.push(`chats ${JSON.stringify(chat)}; the previous release, Core polls, HAWA_LIFECYCLE_CHATS empty`);
  const beforeSwitch: Record<string, number[]> = {};
  const note = (c: string, id: number) => (beforeSwitch[c] ??= []).push(id);

  // --- Old configuration: five requests in five states -----------------------------------------------
  // D: delivered.
  const taskD = await briefToDraft(chat.D, 'R10.H1.D');
  if ((await approve(taskD)).status >= 300) throw new Error('approval of D refused');
  if ((await deliver(taskD)).status >= 300) throw new Error('delivery of D refused');
  await waitDelivered(chat.D, taskD);
  events.push(`D ${taskD}: delivered before the switch (${await taskState(taskD)})`);
  // G: the control. The same delivered request, and the follow-ups D makes after the switch, made now
  // under the old configuration: what legacy intake did with them is what D must get afterwards.
  const taskG = await briefToDraft(chat.G, 'R10.H1.G');
  if ((await approve(taskG)).status >= 300 || (await deliver(taskG)).status >= 300) throw new Error('G was not delivered');
  await waitDelivered(chat.G, taskG);
  const controlThanks = await followUp(chat.G, taskG, () => send(textUpdate(chat.G, 'Thank you, we received the files.')));
  const photoOf = async (c: string) => {
    const fileId = `r10-photo-${c}`;
    await fakes.file({ file_id: fileId, size: 2048, mime: 'image/jpeg' });
    const doc = (await sentTo(c)).filter((s) => s.method === 'sendDocument').pop();
    if (!doc) throw new Error(`chat ${c} has no delivered file to reply to`);
    return { fileId, update: () => send(photoReply(c, fileId, 2048, 'Please use this photo as the background and keep the text', doc)) };
  };
  const photoG = await photoOf(chat.G);
  const controlPhoto = await followUp(chat.G, taskG, photoG.update);
  events.push(`G ${taskG} (control, old configuration): thanks ${JSON.stringify(controlThanks)}; photo reply ${JSON.stringify(controlPhoto)}`);
  // C: approved, not delivered.
  const taskC = await briefToDraft(chat.C, 'R10.H1.C');
  if ((await approve(taskC)).status >= 300) throw new Error('approval of C refused');
  events.push(`C ${taskC}: approved before the switch (${await taskState(taskC)})`);
  // B: draft ready; the requester pressed "Change something" and has the prompt to answer.
  const taskB = await briefToDraft(chat.B, 'R10.H1.B');
  let seq = await lastSeq(chat.B);
  note('B', await send(buttonPress(chat.B, await legacyDraft(chat.B, taskB), `rq:chg:${taskB}`)));
  const promptB = await waitForMessage(chat.B, 'the change prompt', (s) => /What should change/i.test(s.fullText ?? ''), seq);
  events.push(`B ${taskB}: draft in review, the requester has the change prompt (message ${promptB.messageId})`);
  // E: draft ready; the requester replied without a change and was asked a question.
  const taskE = await briefToDraft(chat.E, 'R10.H1.E');
  seq = await lastSeq(chat.E);
  note('E', await send(textReply(chat.E, 'I showed it to the committee', await legacyDraft(chat.E, taskE))));
  const questionE = await waitForMessage(chat.E, 'the clarification question', (s) => /Clarification needed/i.test(s.fullText ?? ''), seq);
  events.push(`E ${taskE}: the requester has an open question (message ${questionE.messageId})`);
  // A: waiting for its draft; the design is held on the old worker colour across the switch.
  await fakes.hold('worker.step.after-action', { step: 'canva-read-binding' }, 1);
  const briefA = textUpdate(chat.A, briefText('R10.H1.A'));
  note('A', await send(briefA));
  const heldA = await fakes.wait('worker.step.after-action', 240_000);
  const [taskA] = await waitUntil('the task of A', async () => { const t = await tasksOfChat(chat.A); return t.length ? t : null; });
  events.push(`A ${taskA.id}: design held on ${heldA?.service} before its draft`);
  const offsetBefore = await storedOffset();

  // --- This release deployed (deploy.sh, ADR-129) --------------------------------------------------
  // This release's Core never polls, and the previous release's colour, created with `core`, does not
  // either: an update sent during the deploy waits in Telegram for the new colour and is read once.
  let windowUpdate = 0;
  let windowThanks: FollowUp | null = null;
  const deploy = await deployConfig(THIS_RELEASE, {
    afterRegister: async () => {
      windowThanks = await followUp(chat.D, taskD, () => send(textUpdate(chat.D, 'Thank you, we received the files.')));
      windowUpdate = windowThanks.update;
      events.push(`D: update ${windowUpdate} sent during the deploy: ${JSON.stringify(windowThanks)}`);
    },
    // A's design, pinned to the old colour, finishes there; the drain waits for it.
    beforeDrain: async () => { await fakes.release(); },
  });
  events.push(...deploy.steps.map((s) => `deploy: ${s}`));
  out.push({ name: 'deploy: the new colour registered and the old one drained and removed', ok: deploy.register.code === 0 && deploy.removed.includes(deploy.live),
    detail: `idle=${deploy.idle} live=${deploy.live} removed=${deploy.removed.join(',')} drains=${deploy.drains.lines.join(' ')}` });
  out.push({ name: 'deploy: the offset only moved forward', ok: (await storedOffset()) >= offsetBefore, detail: `before=${offsetBefore} after=${await storedOffset()}` });

  // --- Continue every old request under the new configuration -----------------------------------------
  // A: the draft arrives from the old colour; the requester approves with the button; the office
  // approves and delivers; Core delivers (pinned core).
  await step('A (was waiting for a draft)', events, out, async () => {
    const [wf] = await restateQuery<{ status: string; deployment: string | null }>(`SELECT status, pinned_deployment_id AS deployment FROM sys_invocation
      WHERE target_service_name = 'TaskWorkflow' AND target_service_key = 'task-wf-${taskA.id}'`);
    await waitUntil('the draft of A', async () => (await taskState(taskA.id)) === 'human_review' &&
      (await sentTo(chat.A)).some((s) => JSON.stringify(s.replyMarkup ?? '').includes(`rq:ok:${taskA.id}`)), 240_000, 2000);
    const seqA = await lastSeq(chat.A);
    const press = await send(buttonPress(chat.A, await legacyDraft(chat.A, taskA.id), `rq:ok:${taskA.id}`));
    const thanks = await waitForMessage(chat.A, 'the requester approval answer', (s) => /you approved this design/i.test(s.fullText ?? ''), seqA);
    events.push(`A: button press ${press} answered (message ${thanks.messageId})`);
    const approved = await approve(taskA.id);
    const delivered = await deliver(taskA.id);
    events.push(`A: office approve HTTP ${approved.status}, deliver HTTP ${delivered.status} executor ${delivered.body?.executor ?? 'core'}`);
    await waitDelivered(chat.A, taskA.id, 240_000);
    const pubs = await publicationsOf(taskA.id);
    return [
      { name: 'A: the held design finished on the colour it started on', ok: wf?.status === 'completed', detail: JSON.stringify(wf) },
      { name: 'A: Core delivered it (pinned core), complete', ok: (await pinOf(taskA.id)) === 'core' && pubs.length === 1 && pubs[0].executor === 'core' && pubs[0].state === 'complete', detail: JSON.stringify(pubs) },
      { name: 'A: no lifecycle request in the chat', ok: (await requestsOf(chat.A)).length === 0, detail: JSON.stringify(await requestsOf(chat.A)) },
      ...(await updateChecks('A', chat.A, [press])),
      ...(await chatChecks('A', chat.A)),
    ];
  });

  // B: the requester answers the change prompt with a Telegram reply; legacy intake owns the task.
  await step('B (draft in review, change prompt open)', events, out, async () => {
    const seqB = await lastSeq(chat.B);
    const reply = await send(textReply(chat.B, 'Please change the venue to Rotana Hotel, Erbil', promptB));
    await waitUntil('an answer to B\'s change', async () => (await sentTo(chat.B)).some((s) => s.seq > seqB), 180_000, 1000);
    const children = await waitUntil('a revision of B, or its absence settled', async () => {
      const c = await childrenOf(taskB);
      return c.length ? c : (await chatInboxInvocations(chat.B)).some((i) => i.idempotency_key === `tg-${reply}` && i.status === 'completed') ? [] : null;
    }, 180_000, 2000);
    const answer = (await sentTo(chat.B)).filter((s) => s.seq > seqB).map((s) => (s.fullText ?? '').slice(0, 80));
    events.push(`B: reply ${reply} → children ${JSON.stringify(children)}; answers ${JSON.stringify(answer)}`);
    return [
      { name: 'B: the reply became one revision of B, pinned core', ok: children.length === 1 && children[0].pin === 'core', detail: JSON.stringify(children) },
      { name: 'B: no lifecycle request in the chat', ok: (await requestsOf(chat.B)).length === 0, detail: JSON.stringify(await requestsOf(chat.B)) },
      ...(await updateChecks('B', chat.B, [reply])),
      ...(await chatChecks('B', chat.B)),
    ];
  });

  // C: approved before the switch; the office delivers after it. Core delivers (ADR-052).
  await step('C (approved, not delivered)', events, out, async () => {
    const delivered = await deliver(taskC);
    events.push(`C: deliver HTTP ${delivered.status} executor ${delivered.body?.executor ?? 'core'}`);
    await waitDelivered(chat.C, taskC, 240_000);
    const pubs = await publicationsOf(taskC);
    const workflows = await restateQuery<{ n: number }>(`SELECT count(*) AS n FROM sys_invocation WHERE target_service_name = 'Delivery' AND target_service_key LIKE 'dl-${taskC}-%'`);
    const files = (await fakes.driveFiles()).filter((f: any) => f.properties?.taskId === taskC);
    const [pin] = await query<{ n: number | null }>(sql`SELECT jsonb_array_length(decision_payload->'pinnedExports') AS n
      FROM hawa.approvals WHERE task_id = ${taskC}::uuid AND decision = 'approved' ORDER BY created_at DESC LIMIT 1`);
    const docs = (await sentTo(chat.C)).filter((s) => s.method === 'sendDocument');
    return [
      { name: 'C: Core delivered it after the switch (pinned core), complete, each pinned file once', ok: pubs.length === 1 && pubs[0].executor === 'core' &&
        pubs[0].state === 'complete' && Number(workflows[0]?.n ?? 0) === 0 && files.length === Number(pin?.n ?? 1) && new Set(docs.map((d) => d.documentSha256)).size === docs.length,
        detail: JSON.stringify({ pubs, deliveryWorkflows: workflows[0]?.n, driveFiles: files.length, pinned: pin?.n, documents: docs.length }) },
      ...(await chatChecks('C', chat.C)),
    ];
  });

  // D: delivered before the deploy; the requester thanked the office during it (above) and now replies
  // to the delivered file with a photo. The thanks is answered as legacy intake answered G's. The photo
  // asked for a change to a finished legacy design: before ADR-135 (G, the control) that was a paid
  // revision on the old path; since, the old intake starts no new work and the requester is asked for
  // /new (ADR-135, "Consequences").
  await step('D (delivered, then a follow-up and a photo reply)', events, out, async () => {
    const photoD = await photoOf(chat.D);
    const photo = await followUp(chat.D, taskD, photoD.update);
    const downloads = ((await fakes.polls()).downloads ?? []).filter((id: string) => id === photoD.fileId);
    const askedForNew = (await sentTo(chat.D)).some((s) => /Please send \/new followed by/i.test(s.fullText ?? s.text ?? ''));
    events.push(`D: photo reply ${JSON.stringify(photo)}; downloads ${downloads.length}; control ${JSON.stringify(controlPhoto)}`);
    return [
      ...(windowThanks ? [sameAs('D thanks (sent during the deploy)', windowThanks, controlThanks)] : []),
      { name: 'D photo reply: a change to a finished legacy design starts nothing and asks for /new (ADR-135)',
        ok: photo.newTasks === 0 && photo.children === 0 && askedForNew, detail: JSON.stringify({ photo, askedForNew }) },
      { name: 'D: the photo was downloaded at most once', ok: downloads.length <= 1, detail: `downloads=${downloads.length}` },
      { name: 'D: no lifecycle request in the chat', ok: (await requestsOf(chat.D)).length === 0, detail: JSON.stringify(await requestsOf(chat.D)) },
      ...(await updateChecks('D', chat.D, [photo.update, ...(windowUpdate ? [windowUpdate] : [])])),
      ...(await chatChecks('D', chat.D, ['/new required'])),
    ];
  });

  // E: the requester answers the open question with a reply to it.
  await step('E (open requester question)', events, out, async () => {
    const seqE = await lastSeq(chat.E);
    const answer = await send(textReply(chat.E, 'revise', questionE));
    await waitUntil('an answer to E', async () => (await sentTo(chat.E)).some((s) => s.seq > seqE) ||
      (await chatInboxInvocations(chat.E)).some((i) => i.idempotency_key === `tg-${answer}` && i.status === 'completed'), 180_000, 1000);
    await sleep(5000);
    const said = (await sentTo(chat.E)).filter((s) => s.seq > seqE).map((s) => (s.fullText ?? '').slice(0, 100));
    const children = await childrenOf(taskE);
    events.push(`E: answer ${answer} → children ${JSON.stringify(children)}; answers ${JSON.stringify(said)}`);
    return [
      { name: 'E: the answer reached legacy intake and was answered', ok: said.length >= 1, detail: JSON.stringify(said) },
      { name: 'E: no lifecycle request in the chat', ok: (await requestsOf(chat.E)).length === 0, detail: JSON.stringify(await requestsOf(chat.E)) },
      ...(await updateChecks('E', chat.E, [answer])),
      ...(await chatChecks('E', chat.E)),
    ];
  });

  // New requests. F: a chat with no history opens a lifecycle request at once. D: /new opens one in a
  // chat with Core history. B: an ordinary brief next to an open recent Core design goes to the old
  // intake (it could be a change to that design), which since ADR-135 continues that design or asks
  // for /new, never a new Core task; once that history is older than legacy intake's own 48-hour
  // reading window, an ordinary brief opens a lifecycle request (ADR-136). C: next to a finished
  // recent Core design an ordinary brief opens a lifecycle request at once (ADR-135).
  await step('F (new chat after the deploy)', events, out, async () => {
    const brief = await send(textUpdate(chat.F, briefText('R10.H1.F')));
    const taskF = await briefToDraftSent(chat.F);
    const approved = await approve(taskF, { pinDeck: true });
    const delivered = await deliver(taskF);
    events.push(`F ${taskF}: approve HTTP ${approved.status}, deliver HTTP ${delivered.status} executor ${delivered.body?.executor}`);
    await waitDelivered(chat.F, taskF, 300_000, 2);
    const requests = await requestsOf(chat.F);
    const pubs = await publicationsOf(taskF);
    return [
      { name: 'F: a new chat opens a lifecycle request that Restate delivers', ok: requests.length === 1 && requests[0].owner === 'restate' &&
        (await pinOf(taskF)) === 'restate' && pubs.length === 1 && pubs[0].executor === 'restate' && pubs[0].state === 'complete', detail: JSON.stringify({ requests, pubs }) },
      ...(await updateChecks('F', chat.F, [brief])),
      ...(await chatChecks('F', chat.F)),
    ];
  });

  await step('D /new (explicit new request in a chat with Core history)', events, out, async () => {
    const before = (await requestsOf(chat.D)).length;
    const update = await send(textUpdate(chat.D, `/new ${briefText('R10.H1.D-new')}`));
    const request = await waitUntil('the /new request of D', async () => (await requestsOf(chat.D))[before] ?? null, 180_000, 2000);
    return [
      { name: 'D: /new opens a lifecycle request in a chat with Core history', ok: request.owner === 'restate', detail: JSON.stringify(request) },
      ...(await updateChecks('D /new', chat.D, [update])),
    ];
  });

  await step('C new brief (a finished recent Core design)', events, out, async () => {
    const brief = await send(textUpdate(chat.C, briefText('R10.H1.C-new')));
    const request = await waitUntil('the lifecycle request of C', async () => (await requestsOf(chat.C))[0] ?? null, 180_000, 2000);
    return [
      { name: 'C: next to a finished recent Core design an ordinary brief opens a lifecycle request', ok: request.owner === 'restate', detail: JSON.stringify(request) },
      ...(await updateChecks('C new brief', chat.C, [brief])),
    ];
  });

  await step('B new brief (an open recent Core design, then older than 48 h)', events, out, async () => {
    const before = await tasksOfChat(chat.B);
    const recent = await send(textUpdate(chat.B, briefText('R10.H1.B-recent')));
    await waitUntil('B\'s recent-history brief to be handled', async () =>
      (await chatInboxInvocations(chat.B)).some((i) => i.idempotency_key === `tg-${recent}` && i.status === 'completed'), 180_000, 1000);
    await sleep(3000);
    const afterRecent = await requestsOf(chat.B);
    const newTasks = (await tasksOfChat(chat.B)).filter((t) => !before.some((b) => b.id === t.id));
    const newChildren = await query<{ id: string; parent: string | null }>(sql`SELECT t.id::text, o.payload->'studioOptions'->>'parentTaskId' AS parent
      FROM hawa.tasks t JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
      WHERE t.id = ANY(${newTasks.map((t) => t.id)}::uuid[])`);
    const askedForNew = (await sentTo(chat.B)).some((s) => /Please send \/new followed by/i.test(s.fullText ?? s.text ?? ''));
    // Age the chat's Core history past legacy intake's reading window (the chaos database only).
    await query(sql`UPDATE hawa.tasks SET created_at = created_at - interval '3 days'
      WHERE id IN (SELECT aggregate_id FROM hawa.outbox_commands WHERE command_type = 'task.created' AND payload->>'sourceChannelId' = ${chat.B})`);
    const old = await send(textUpdate(chat.B, briefText('R10.H1.B-old')));
    await waitUntil('B\'s aged-history brief to be handled', async () =>
      (await chatInboxInvocations(chat.B)).some((i) => i.idempotency_key === `tg-${old}` && i.status === 'completed'), 180_000, 1000);
    await sleep(3000);
    const afterOld = await requestsOf(chat.B);
    events.push(`B: recent brief ${recent} → requests ${afterRecent.length}, new tasks ${JSON.stringify(newChildren)}, asked for /new ${askedForNew}; aged brief ${old} → requests ${afterOld.length}`);
    return [
      { name: 'B: a brief next to an open recent Core design goes to the old intake, which starts no new Core request', ok: afterRecent.length === 0 &&
        newChildren.every((t) => t.parent !== null && before.some((b) => b.id === t.parent)) && (newChildren.length > 0 || askedForNew),
        detail: JSON.stringify({ requests: afterRecent, newTasks: newChildren, askedForNew }) },
      { name: 'B: once the Core history is older than 48 h, an ordinary brief opens a lifecycle request', ok: afterOld.length === 1 && afterOld[0].owner === 'restate',
        detail: JSON.stringify(afterOld) },
      ...(await updateChecks('B new briefs', chat.B, [recent, old])),
    ];
  });

  // Only B and D were asked for /new (a brief beside an open Core design; a change to a finished one).
  for (const [name, c] of Object.entries(chat)) out.push(...(await chatChecks(`${name} (whole chat)`, c, ['B', 'D'].includes(name) ? ['/new required'] : [])));
  for (const [name, c] of Object.entries(chat)) events.push(await chatSummary(name, c));
  out.push({ name: 'the stored offset passed every update', ok: (await storedOffset()) >= Math.max(...Object.values(beforeSwitch).flat(), windowUpdate),
    detail: `offset=${await storedOffset()}` });
  return { extra: out, deploy };
}

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
    const acks = (await sentTo(chat.W)).filter((s) => /Request (received|saved)/i.test(s.fullText ?? ''));
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

  // R again: the revision it took on the previous release is approved and delivered on this release.
  await step('R finished after the roll forward', events, out, async () => {
    const r = await waitUntil('R\'s revised draft in review', async () => { const [row] = await requestsOf(chat.R); return row?.stage === 'in_review' ? row : null; }, 300_000, 2000);
    const approved = await approve(r.current_task_id);
    const delivered = await deliver(r.current_task_id);
    events.push(`R: approve HTTP ${approved.status}, deliver HTTP ${delivered.status}`);
    await waitDelivered(chat.R, r.current_task_id, 300_000);
    const pubs = await publicationsOf(r.current_task_id);
    const [after] = await requestsOf(chat.R);
    return [
      { name: 'R: a request that crossed the rollback and the roll forward is delivered once', ok: after.stage === 'delivered' && pubs.length === 1 &&
        pubs[0].executor === 'restate' && pubs[0].state === 'complete', detail: JSON.stringify({ stage: after.stage, pubs }) },
      ...(await chatChecks('R after forward', chat.R)),
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
