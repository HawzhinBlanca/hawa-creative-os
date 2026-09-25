/**
 * Scripted requests on the request lifecycle (architecture programme Phase 2, slice 2.3; PHASE2_DESIGN.md
 * sections 3 and 6.3): a chat on the worker's HAWA_LIFECYCLE_CHATS sends a brief, the worker's poller
 * hands it to its ChatInbox, intake decides it, RequestLifecycle opens the request and DesignRun designs
 * it; the draft, the requester's buttons, reminders, changes and answers all go through the lifecycle.
 *
 * The chats are 9400001 to 9400040, which docker-compose.chaos.yml lists for the workers only (Core's
 * own list is slice 2.2's): the requests of these chats are opened by the lifecycle, and a delivery
 * would still be Core's. These scenarios need the worker's poller (run.ts --poller worker).
 */
import { RESTATE_INGRESS_URL, compose, fakes, query, restateQuery, sql, type Service } from './stack.js';
import { OFFICE_CHAT, REQUESTER_ID, briefText, checkIntake, sentTo, sleep, textUpdate, waitUntil, type InvariantResult } from './scenario.js';

const FIRST_CHAT = 9_400_001;
const LAST_CHAT = 9_400_040;
let chatSeq = FIRST_CHAT - 1;

/** The next chat on the workers' HAWA_LIFECYCLE_CHATS. */
export function lifecycleChat(): string {
  if (chatSeq >= LAST_CHAT) throw new Error('every lifecycle chat of docker-compose.chaos.yml is used; add more there');
  return String(++chatSeq);
}

/** The workers' flag list: every lifecycle chat, less the ones a scenario took off it (R5). */
export function lifecycleChatList(except: string[] = []): string {
  const all: string[] = [];
  for (let c = FIRST_CHAT; c <= LAST_CHAT; c++) if (!except.includes(String(c))) all.push(String(c));
  return all.join(',');
}

/** The worker colour Restate sends new invocations to (the one whose poller runs). */
export async function liveColour(): Promise<'worker-blue' | 'worker-green'> {
  const res = await fetch(`http://127.0.0.1:56070/services/TaskWorkflow`);
  const service = res.ok ? await res.json() as { deployment_id?: string } : {};
  const [dep] = service.deployment_id ? await restateQuery<{ endpoint: string }>(`SELECT endpoint FROM sys_deployment WHERE id = '${service.deployment_id}'`) : [];
  return /worker-green/.test(dep?.endpoint ?? '') ? 'worker-green' : 'worker-blue';
}

/**
 * Starts the worker colour again with other settings (the flag list, the reminder scale): compose
 * recreates the container at the same address, so Restate's deployment and the live colour stay.
 */
export async function restartWorkerWith(colour: Service, env: { lifecycleChats?: string; reminderScale?: string }): Promise<void> {
  if (env.lifecycleChats !== undefined) process.env.CHAOS_WORKER_LIFECYCLE_CHATS = env.lifecycleChats;
  if (env.reminderScale !== undefined) process.env.CHAOS_REMINDER_SCALE = env.reminderScale;
  compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '180', colour], { timeoutMs: 5 * 60_000 });
}

/**
 * Moves the Telegram poller (PHASE2_DESIGN.md 2.1, its rollback): recreates Core and the worker
 * colour with HAWA_TELEGRAM_POLLER=`poller`. Both pollers share the Postgres offset row, so the new
 * one goes on where the other stopped.
 */
export async function switchPoller(poller: 'core' | 'worker', colour: Service): Promise<void> {
  process.env.CHAOS_TELEGRAM_POLLER = poller;
  compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '180', 'core', colour], { timeoutMs: 5 * 60_000 });
}

export interface LifecycleRequest {
  requestId: string;
  updateId: number;
  /** The round-0 task. */
  taskId: string;
}

/** The chat's lifecycle requests, oldest first. */
export async function requestsOfChat(chat: string) {
  return query<{ request_id: string; owner: string; stage: string; rev: string; root_task_id: string; current_task_id: string; draft_sent_at: Date | null; question_asked_at: Date | null }>(
    sql`SELECT request_id::text, owner, stage, rev::text, root_task_id::text, current_task_id::text, draft_sent_at, question_asked_at
      FROM hawa.requests WHERE chat_id = ${chat} ORDER BY created_at`);
}

export async function roundTasks(requestId: string) {
  return query<{ id: string; state: string; current_design_revision_id: string | null }>(
    sql`SELECT id::text, state::text, current_design_revision_id::text FROM hawa.tasks WHERE request_id = ${requestId}::uuid ORDER BY created_at, id`);
}

/** What RequestLifecycle.get answers for a request. */
export async function lifecycleView(requestId: string): Promise<Record<string, any> | null> {
  const res = await fetch(`${RESTATE_INGRESS_URL}/RequestLifecycle/${requestId}/get`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' });
  return res.ok ? await res.json() as Record<string, any> : null;
}

const isDraftText = (s: any, taskId: string) => s.method === 'sendMessage' && JSON.stringify(s.replyMarkup || '').includes(`rq:ok:${taskId}`);

/** A brief from a lifecycle chat, until the request's draft reached the chat and was recorded as sent. */
export async function lifecycleBrief(chat: string, tag: string, events: string[], timeoutMs = 300_000): Promise<LifecycleRequest> {
  const [updateId] = await fakes.updates([textUpdate(chat, briefText(tag))]);
  events.push(`brief: update ${updateId} in chat ${chat}`);
  const [request] = await waitUntil(`a lifecycle request of chat ${chat}`, async () => {
    const rows = await requestsOfChat(chat);
    return rows.length ? rows : null;
  }, 180_000);
  events.push(`request ${request.request_id}, round 0 task ${request.root_task_id}`);
  await waitDraftSent(chat, request.request_id, request.root_task_id, timeoutMs);
  events.push('draft in chat and recorded as sent');
  return { requestId: request.request_id, updateId, taskId: request.root_task_id };
}

/** Until the round's draft (its message with the buttons) is in the chat and Postgres records it sent. */
export async function waitDraftSent(chat: string, requestId: string, taskId: string, timeoutMs = 300_000): Promise<void> {
  await waitUntil(`the draft of task ${taskId} in chat ${chat}, recorded as sent`, async () => {
    const shown = (await sentTo(chat)).some((s) => isDraftText(s, taskId));
    const [notify] = await query<{ n: string }>(sql`SELECT count(*) AS n FROM hawa.outbox_commands WHERE aggregate_id = ${taskId}::uuid
      AND command_type = 'notify.telegram' AND state = 'delivered' AND payload->>'status' = 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW'`);
    const [task] = await query<{ state: string }>(sql`SELECT state::text AS state FROM hawa.tasks WHERE id = ${taskId}::uuid`);
    const [request] = await query<{ stage: string }>(sql`SELECT stage FROM hawa.requests WHERE request_id = ${requestId}::uuid`);
    if (task && ['failed_operator', 'cancelled'].includes(task.state)) throw new Error(`task ${taskId} ended ${task.state}: no draft`);
    return shown && Number(notify?.n ?? 0) === 1 && task?.state === 'human_review' && request?.stage === 'in_review';
  }, timeoutMs, 2000);
}

let callbackSeq = 0;
/** The requester taps a button (callback data `rq:<action>:<taskId>`) under a message in their chat. */
export async function tap(chat: string, data: string): Promise<number> {
  const id = `chaos-cb-${Date.now()}-${++callbackSeq}`;
  const [updateId] = await fakes.updates([{
    callback_query: {
      id, data, chat_instance: 'chaos', from: { id: REQUESTER_ID, is_bot: false, first_name: 'Chaos' },
      message: { message_id: 1000 + callbackSeq, date: Math.floor(Date.now() / 1000), chat: { id: Number(chat), type: 'private' }, from: { id: 7000001, is_bot: true, first_name: 'Hawa' }, text: 'draft' },
    },
  }]);
  return updateId;
}

/** The requester replies to the draft of `taskId` (its picture's caption names the task). */
export async function replyToDraft(chat: string, taskId: string, words: string): Promise<number> {
  const update = textUpdate(chat, words) as { message: Record<string, unknown> };
  update.message.reply_to_message = {
    message_id: 900, date: Math.floor(Date.now() / 1000), chat: { id: Number(chat), type: 'private' }, from: { id: 7000001, is_bot: true, first_name: 'Hawa' },
    caption: `🎨 Canva draft · Task ID: ${taskId}\nReply to this image with any change you want.`,
  };
  const [updateId] = await fakes.updates([update]);
  return updateId;
}

/**
 * The checks of PHASE2_DESIGN.md 6.3 for one chat's lifecycle requests: the request rows (owned by
 * restate, the expected stage), the rounds, one design revision per drafted round, one DesignRun and
 * one Canva import per designed round, no legacy TaskWorkflow, each message once in the chat, an
 * uncertain send with exactly one office alert, no paid call twice, the chat's ChatInbox invocations
 * completed, nothing paused, no RT0016.
 */
export async function checkLifecycle(chat: string, expect: {
  requests?: number;
  stage: string;
  rounds: number;
  /** Rounds that were designed by a DesignRun (default: every round). */
  designedRounds?: number;
  /** Rounds that ended with a draft (default 1). */
  drafts?: number;
  uncertainSends?: number;
  classifierAllowance?: number;
  ledgerSince?: number;
  updateIds?: number[];
}): Promise<InvariantResult[]> {
  const out: InvariantResult[] = [];
  const add = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });
  const requests = await requestsOfChat(chat);
  const wantRequests = expect.requests ?? 1;
  add(`${wantRequests} request row(s) for the chat, owned by restate`, requests.length === wantRequests && requests.every((r) => r.owner === 'restate'), JSON.stringify(requests.map((r) => ({ owner: r.owner, stage: r.stage, rev: r.rev }))));
  const request = requests[0];
  if (!request) return out;
  add(`the request's stage in Postgres is ${expect.stage}`, request.stage === expect.stage, `stage=${request.stage}`);
  const view = await lifecycleView(request.request_id);
  add(`RequestLifecycle agrees: stage ${expect.stage}, revision ${request.rev}`, view?.stage === expect.stage && String(view?.rev) === request.rev, JSON.stringify(view && { stage: view.stage, rev: view.rev, round: view.round }));
  const rounds = await roundTasks(request.request_id);
  add(`${expect.rounds} round task(s) in the request`, rounds.length === expect.rounds, `tasks=${rounds.length}`);
  const ids = rounds.map((r) => r.id);
  const revisions = ids.length ? await query<{ task_id: string; n: string }>(sql`SELECT task_id::text, count(*) AS n FROM hawa.design_revisions WHERE task_id = ANY(${ids}::uuid[]) GROUP BY task_id`) : [];
  const drafts = expect.drafts ?? 1;
  add(`${drafts} drafted round(s), one design revision each`, revisions.length === drafts && revisions.every((r) => Number(r.n) === 1), JSON.stringify(revisions));
  const legacy = ids.length ? await restateQuery<{ n: number }>(`SELECT count(*) AS n FROM sys_invocation WHERE target_service_name = 'TaskWorkflow' AND (${ids.map((id) => `target_service_key LIKE 'task-wf-${id}%'`).join(' OR ')})`) : [{ n: 0 }];
  add('no legacy TaskWorkflow for a lifecycle round', Number(legacy[0]?.n ?? 0) === 0, `TaskWorkflow=${legacy[0]?.n ?? 0}`);
  const runs = ids.length ? await restateQuery<{ target_service_key: string; status: string }>(`SELECT target_service_key, status FROM sys_invocation WHERE target_service_name = 'DesignRun' AND (${ids.map((id) => `target_service_key LIKE 'dr-${id}%'`).join(' OR ')})`) : [];
  const designed = expect.designedRounds ?? expect.rounds;
  add(`${designed} DesignRun(s), one per designed round, completed`, runs.length === designed && runs.every((r) => r.status === 'completed'), JSON.stringify(runs.map((r) => `${r.target_service_key.slice(0, 16)}…:${r.status}`)));
  const imports = ids.length ? await query<{ task_id: string; n: string }>(sql`SELECT task_id::text, count(*) FILTER (WHERE kind = 'create') AS n FROM hawa.canva_remote_operations WHERE task_id = ANY(${ids}::uuid[]) GROUP BY task_id`) : [];
  add('at most one Canva import per round', imports.every((i) => Number(i.n) <= 1), JSON.stringify(imports));
  const [pendingOutbox] = ids.length ? await query<{ n: string }>(sql`SELECT count(*) AS n FROM hawa.outbox_commands WHERE aggregate_id = ANY(${ids}::uuid[]) AND state IN ('pending', 'leased')`) : [{ n: '0' }];
  add('no outbox command of a lifecycle round is pending (nothing legacy dispatches them)', Number(pendingOutbox?.n ?? 0) === 0, `pending=${pendingOutbox?.n}`);

  const shown = await sentTo(chat);
  // A picture is its bytes and its caption: every round's draft picture has the fake Canva's same
  // bytes, and a different caption (its task id).
  const key = (s: any) => `${s.method}:${s.documentSha256 ?? ''}:${s.textHash ?? ''}`;
  const counts = new Map<string, number>();
  for (const s of shown) counts.set(key(s), (counts.get(key(s)) || 0) + 1);
  const dupes = [...counts].filter(([, n]) => n > 1);
  add('each message reaches the requester once', dupes.length === 0, dupes.length ? `duplicates: ${dupes.map(([k, n]) => `${k.slice(0, 40)}…×${n}`).join(', ')}` : `${shown.length} sends, all distinct`);
  const uncertain = expect.uncertainSends ?? shown.filter((s) => s.fault === 'drop-after-processing').length;
  const alerts = (await sentTo(OFFICE_CHAT)).filter((s) => s.text && ids.some((id) => s.text.includes(id)) && /did not confirm/i.test(s.text));
  add(uncertain ? 'an uncertain send has exactly one office alert' : 'no uncertain-send alert without an uncertain send', alerts.length === uncertain, `uncertain sends expected=${uncertain} alerts=${alerts.length}`);

  const ledger = await fakes.modelLedger();
  const mine = (ledger.ledger as any[]).filter((l) => l.seq > (expect.ledgerSince ?? 0) && l.status === 200 && l.route !== 'billing-probe');
  const paid = new Map<string, { route: string; n: number }>();
  for (const l of mine) paid.set(l.fingerprint, { route: l.route, n: (paid.get(l.fingerprint)?.n || 0) + 1 });
  const over = [...paid].filter(([, p]) => p.n > (p.route === 'telegram_classifier' ? expect.classifierAllowance ?? 1 : 1));
  add('no paid call runs twice', over.length === 0, over.length ? over.map(([f, p]) => `${p.route} ${f.slice(0, 8)}×${p.n}`).join(', ') : `${mine.length} paid calls`);

  if (expect.updateIds?.length) out.push(...await checkIntake(chat, expect.updateIds));
  const [paused] = await restateQuery<{ n: number }>(`SELECT count(*) AS n FROM sys_invocation WHERE status = 'paused'`);
  add('no paused invocation', Number(paused?.n ?? 0) === 0, `paused=${paused?.n ?? 0}`);
  const [rt16] = await restateQuery<{ n: number }>(`SELECT count(*) AS n FROM sys_invocation WHERE last_failure_error_code = 'RT0016'`);
  add('no journal mismatch (RT0016)', Number(rt16?.n ?? 0) === 0, `RT0016=${rt16?.n ?? 0}`);
  return out;
}

/** The chat's messages whose text contains `words`. */
export async function messagesWith(chat: string, words: string): Promise<any[]> {
  return (await sentTo(chat)).filter((s) => typeof s.text === 'string' && s.text.includes(words));
}

export { sleep };
