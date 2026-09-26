/**
 * Scripted requests on today's (legacy) path, and the checks the chaos suite makes after each:
 * brief in Telegram → Core intake → outbox → TaskWorkflow in the blue worker → Canva → outcome →
 * draft in Telegram → approve in the Desk API → deliver → files in Telegram.
 *
 * Each request runs in its own chat, so one scenario's messages, tasks and paid calls never mix with
 * another's, and nothing is reset between scenarios.
 */
import { RESTATE_INGRESS_URL, fakes, kill, query, restateQuery, secrets, sql, start, waitHealthy, type Service } from './stack.js';

export const OFFICE_CHAT = '9000001';
export const REQUESTER_ID = 9100001;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil<T>(label: string, probe: () => Promise<T | null | undefined | false>, timeoutMs = 180_000, everyMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (err) {
      if (err instanceof RequestEndedError) throw err;
      last = err;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}${last ? ` (last error: ${last instanceof Error ? last.message : String(last)})` : ''}`);
}

/** The brief of one scripted request: instructions, a divider, then the copy (planner path). */
export function briefText(tag: string): string {
  return [
    `KAAE invitation for the accreditation ceremony, formal and clean. Reference ${tag}.`,
    '',
    '-----',
    '',
    'KAAE Accreditation Ceremony',
    '',
    `Thursday 12 November 2026, 10:00 (${tag})`,
    '',
    'Erbil International Hotel',
  ].join('\n');
}

let messageSeq = 100;
export function textUpdate(chat: string, text: string, from = REQUESTER_ID) {
  return { message: { message_id: ++messageSeq, date: Math.floor(Date.now() / 1000), from: { id: from, is_bot: false, first_name: 'Chaos' }, chat: { id: Number(chat), type: 'private' }, text } };
}

export function imageDocumentUpdate(chat: string, fileId: string, size: number, caption: string, from = REQUESTER_ID) {
  return {
    message: {
      message_id: ++messageSeq,
      date: Math.floor(Date.now() / 1000),
      from: { id: from, is_bot: false, first_name: 'Chaos' },
      chat: { id: Number(chat), type: 'private' },
      caption,
      document: { file_id: fileId, file_unique_id: `u-${fileId}`, file_name: 'reference.jpg', mime_type: 'image/jpeg', file_size: size },
    },
  };
}

export function captionedPhotoUpdate(chat: string, fileId: string, size: number, caption: string, from = REQUESTER_ID) {
  return {
    message: {
      message_id: ++messageSeq,
      date: Math.floor(Date.now() / 1000),
      from: { id: from, is_bot: false, first_name: 'Chaos' },
      chat: { id: Number(chat), type: 'private' },
      caption,
      photo: [{ file_id: fileId, file_unique_id: `u-${fileId}`, width: 800, height: 600, file_size: size }],
    },
  };
}

/** Tasks Core created for a chat's requests (read from the intake's own outbox rows). */
export async function tasksOfChat(chat: string): Promise<Array<{ id: string; state: string; version: number }>> {
  return query(sql`SELECT t.id, t.state::text AS state, t.version FROM hawa.tasks t
    WHERE t.id IN (SELECT aggregate_id FROM hawa.outbox_commands WHERE command_type = 'task.created' AND payload->>'sourceChannelId' = ${chat})
    ORDER BY t.created_at`);
}

export async function taskState(taskId: string): Promise<string | null> {
  const [row] = await query<{ state: string }>(sql`SELECT state::text AS state FROM hawa.tasks WHERE id = ${taskId}::uuid`);
  return row?.state ?? null;
}

/** Sends to a chat that Telegram would have shown there. */
export async function sentTo(chat: string) {
  return (await fakes.sent()).filter((s) => s.chat_id === chat && s.delivered);
}

const isDraft = (s: any) => s.method === 'sendMessage' && /rq:ok:/.test(JSON.stringify(s.replyMarkup || ''));

/** The outcome the design run reported for a task (task.state_changed carries it), or null. */
export async function designOutcome(taskId: string): Promise<string | null> {
  const [row] = await query<{ outcome: string }>(sql`SELECT data->>'outcome' AS outcome FROM hawa.task_events
    WHERE task_id = ${taskId}::uuid AND event_type = 'task.state_changed' AND data ? 'outcome' ORDER BY occurred_at DESC LIMIT 1`);
  return row?.outcome ?? null;
}

export class RequestEndedError extends Error {}

/**
 * The request's brief, until Core has a task for it and the draft has reached the chat. A design
 * run that ends any other way (CANVA_PREVIEW_FAILED, DESIGN_SERVER_ERROR …) leaves nothing to
 * approve: that is reported at once, as the outcome it was, instead of waiting out the timeout.
 */
export async function briefToDraft(chat: string, tag: string, timeoutMs = 240_000): Promise<string> {
  await fakes.updates([textUpdate(chat, briefText(tag))]);
  const [task] = await waitUntil(`a task for chat ${chat}`, async () => {
    const t = await tasksOfChat(chat);
    return t.length ? t : null;
  }, 60_000);
  await waitUntil(`the draft of task ${task.id} in chat ${chat}`, async () => {
    const outcome = await designOutcome(task.id);
    if (outcome && outcome !== 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW') {
      throw new RequestEndedError(`task ${task.id}: the design run ended as ${outcome}, so there is no draft to approve`);
    }
    return (await sentTo(chat)).some(isDraft) && (await taskState(task.id)) === 'human_review';
  }, timeoutMs, 2000);
  return task.id;
}

/**
 * The Desk's approval: the stored exports, the PNG pinned (approvalPins.defaultPins), as the art
 * director. `pinDeck` pins the PPTX too, so a delivery sends two files (the slice 2.2 scenarios kill
 * and throttle between them).
 */
export async function approve(taskId: string, options: { pinDeck?: boolean } = {}): Promise<{ status: number; body: any }> {
  const token = secrets().CHAOS_REVIEWER_KEY;
  const state = await fakes.core(`/tasks/${taskId}/canva`, token);
  const artifacts: any[] = Array.isArray(state.json?.artifacts) ? state.json.artifacts : [];
  const png = artifacts.find((a) => String(a.format).toLowerCase() === 'png');
  const deck = options.pinDeck ? artifacts.find((a) => String(a.format).toLowerCase() === 'pptx') : null;
  if (options.pinDeck && !deck) throw new Error(`task ${taskId} has no stored PPTX export to pin`);
  const [task] = await query<{ rev: string | null }>(sql`SELECT current_design_revision_id AS rev FROM hawa.tasks WHERE id = ${taskId}::uuid`);
  if (!task?.rev) throw new Error(`task ${taskId} has no design revision to approve`);
  const res = await fakes.core(`/tasks/${taskId}/revisions/${task.rev}/decisions`, token, {
    body: { action: 'approve', reason: 'Brand, hierarchy, and exact-copy verified', pinnedExportIds: [png?.id, deck?.id].filter(Boolean) },
  });
  return { status: res.status, body: res.json };
}

/** The Desk's Deliver button. */
export async function deliver(taskId: string): Promise<{ status: number; body: any }> {
  const res = await fakes.core(`/tasks/${taskId}/publish`, secrets().CHAOS_REVIEWER_KEY, { body: {} });
  return { status: res.status, body: res.json };
}

export async function waitDelivered(chat: string, taskId: string, timeoutMs = 180_000, files = 1): Promise<void> {
  await waitUntil(`delivery of task ${taskId} to chat ${chat}`, async () => {
    const docs = (await sentTo(chat)).filter((s) => s.method === 'sendDocument');
    return docs.length >= files && (await taskState(taskId)) === 'complete';
  }, timeoutMs, 2000);
}

/**
 * No work ready now: no Restate invocation running or backing off, no ready outbox command,
 * and no fake Telegram call for `idleMs`. Durable lifecycle reminders may remain scheduled
 * until their business deadline; they must not prevent the next scenario from settling.
 */
export async function quiescent(idleMs = 5000, timeoutMs = 240_000): Promise<void> {
  await waitUntil('quiescence', async () => {
    const [inv] = await restateQuery<{ n: number }>(`SELECT count(*) AS n FROM sys_invocation
      WHERE status NOT IN ('completed') AND NOT (status = 'scheduled'
        AND target_service_name = 'RequestLifecycle' AND target_handler_name = 'reminderTick')`);
    const [outbox] = await query<{ n: string }>(sql`SELECT count(*) AS n FROM hawa.outbox_commands WHERE state IN ('pending', 'leased') AND available_at <= now() + interval '5 seconds'`);
    const sent = await fakes.sent();
    const last = sent.length ? Date.parse(sent[sent.length - 1].at) : 0;
    return Number(inv?.n ?? 0) === 0 && Number(outbox?.n ?? 0) === 0 && Date.now() - last >= idleMs;
  }, timeoutMs, 1000);
}

const SERVICE_OF: Record<string, Service> = { core: 'core', 'worker-blue': 'worker-blue', 'worker-green': 'worker-green' };

export interface ArmedKill {
  /** Settles once the process was killed at the point and started again (or the point was never reached). */
  done: Promise<{ point: string; reached: any; killed: Service }>;
}

/**
 * Arms a chaos point (armed when this returns), then, in the background: waits until a process
 * reaches it, kills that process's container there (SIGKILL), and starts it again after `downMs`.
 */
export async function killAtPoint(point: string, match: Record<string, string>, options: { downMs?: number; timeoutMs?: number } = {}): Promise<ArmedKill> {
  await fakes.hold(point, match, 1);
  const done = (async () => {
    const reached = await fakes.wait(point, options.timeoutMs ?? 300_000);
    if (!reached) throw new Error(`chaos point ${point} ${JSON.stringify(match)} was not reached`);
    const service = SERVICE_OF[String(reached.service)];
    if (!service) throw new Error(`chaos point ${point} was reached by ${reached.service}, which the driver does not kill`);
    kill(service);
    await sleep(options.downMs ?? 2000);
    start(service);
    await waitHealthy(service);
    return { point, reached, killed: service };
  })();
  done.catch(() => undefined);
  return { done };
}

/**
 * Arms a chaos point; when a process reaches it, kills `target` (a service without points of its own:
 * Core, Postgres, Restate) while the point is held, releases the point so the held process meets the
 * outage, and starts `target` again after `downMs`: a time-based kill at the moment the point marks.
 */
export async function killWhileHeld(point: string, match: Record<string, string>, target: Service, options: { downMs?: number; timeoutMs?: number } = {}): Promise<ArmedKill> {
  await fakes.hold(point, match, 1);
  const done = (async () => {
    const reached = await fakes.wait(point, options.timeoutMs ?? 300_000);
    if (!reached) throw new Error(`chaos point ${point} ${JSON.stringify(match)} was not reached`);
    kill(target);
    await fakes.release(point);
    await sleep(options.downMs ?? 5000);
    start(target);
    await waitHealthy(target);
    return { point, reached, killed: target };
  })();
  done.catch(() => undefined);
  return { done };
}

export interface InvariantResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** The checks of PHASE2_DESIGN.md section 6.3 that apply to the legacy path, for one request. */
export async function checkRequest(chat: string, options: {
  delivered: boolean; classifierAllowance?: number; uncertainSends?: number; ledgerSince?: number;
  /** The approved files the delivery sends (and archives): 1 unless the scenario pinned more. */
  files?: number;
  /** Who delivers: Core's own delivery and the outbox (legacy), or the Restate Delivery workflow (slice 2.2). */
  executor?: 'core' | 'restate';
}): Promise<InvariantResult[]> {
  const out: InvariantResult[] = [];
  const add = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });
  const tasks = await tasksOfChat(chat);
  add('one task per scripted request', tasks.length === 1, `tasks=${tasks.length}`);
  const task = tasks[0];
  if (!task) return out;

  const [rev] = await query<{ n: string }>(sql`SELECT count(*) AS n FROM hawa.design_revisions WHERE task_id = ${task.id}::uuid`);
  add('design_revisions per task = 1', Number(rev.n) === 1, `design_revisions=${rev.n}`);
  if (options.delivered) {
    const [appr] = await query<{ n: string }>(sql`SELECT count(*) AS n FROM hawa.approvals WHERE task_id = ${task.id}::uuid AND decision = 'approved'`);
    add('approvals = 1', Number(appr.n) === 1, `approvals=${appr.n}`);
    const pubs = await query<{ state: string }>(sql`SELECT state::text AS state FROM hawa.publications WHERE task_id = ${task.id}::uuid`);
    add("publications = 1, state 'complete'", pubs.length === 1 && pubs[0].state === 'complete', `publications=${JSON.stringify(pubs.map((p) => p.state))}`);
  }
  add('final task state', task.state === (options.delivered ? 'complete' : 'human_review'), `state=${task.state}`);

  // Each message, photo and file the chat saw appears once (a 429 or 5xx answer was not shown).
  const shown = await sentTo(chat);
  const key = (s: any) => `${s.method}:${s.documentSha256 ?? s.textHash}`;
  const counts = new Map<string, number>();
  for (const s of shown) counts.set(key(s), (counts.get(key(s)) || 0) + 1);
  const dupes = [...counts].filter(([, n]) => n > 1);
  add('each message reaches the requester once', dupes.length === 0, dupes.length ? `duplicates: ${dupes.map(([k, n]) => `${k.slice(0, 40)}…×${n}`).join(', ')}` : `${shown.length} sends, all distinct`);
  // A send nobody can confirm (the fake dropped its answer, or the worker died between the send and
  // its record) is not repeated, and the office hears about it once. Without one, no alert at all.
  const uncertain = options.uncertainSends ?? shown.filter((s) => s.fault === 'drop-after-processing').length;
  const alerts = (await sentTo(OFFICE_CHAT)).filter((s) => s.text && s.text.includes(task.id));
  add(uncertain ? 'an uncertain send has exactly one office alert' : 'no office alert without an uncertain send', alerts.length === uncertain, `uncertain sends expected=${uncertain} office alerts naming the task=${alerts.length}`);

  // Paid calls: every fingerprint once (the classifier may run again when intake died before saving).
  // Only this scenario's calls: each scenario's brief carries its own tag, so its fingerprints are its own.
  const ledger = await fakes.modelLedger();
  const mine = (ledger.ledger as any[]).filter((l) => l.seq > (options.ledgerSince ?? 0) && l.status === 200 && l.route !== 'billing-probe');
  const paid = new Map<string, { route: string; n: number }>();
  for (const l of mine) paid.set(l.fingerprint, { route: l.route, n: (paid.get(l.fingerprint)?.n || 0) + 1 });
  const over = [...paid].filter(([, p]) => p.n > (p.route === 'telegram_classifier' ? options.classifierAllowance ?? 1 : 1));
  add('no paid call runs twice', over.length === 0, over.length ? over.map(([f, p]) => `${p.route} ${f.slice(0, 8)}×${p.n}`).join(', ') : `${mine.length} paid calls: ${[...paid.values()].map((p) => `${p.route}×${p.n}`).join(', ')}`);

  if (options.delivered) {
    // Drive: the approved file archived once, however often delivery was pressed or restarted.
    const expected = options.files ?? 1;
    const files = (await fakes.driveFiles()).filter((f: any) => f.properties?.taskId === task.id);
    add(expected === 1 ? 'the approved file is archived to Drive once' : `the ${expected} approved files are archived to Drive once each`, files.length === expected, `drive files for the task=${files.length}`);
    // Telegram: each approved file reached the requester (once each is checked above).
    const docs = shown.filter((s) => s.method === 'sendDocument');
    add(`the requester has the ${expected} approved file${expected === 1 ? '' : 's'}`, new Set(docs.map((d) => d.documentSha256)).size === expected, `documents shown=${docs.length}`);
    if (options.executor === 'restate') {
      const pubs = await query<{ executor: string; executor_run: number; executor_finished_run: number }>(sql`SELECT executor, executor_run, executor_finished_run FROM hawa.publications WHERE task_id = ${task.id}::uuid`);
      add('the Delivery workflow delivered it, and reported every run it started', pubs.length === 1 && pubs[0].executor === 'restate' && pubs[0].executor_run >= 1 && pubs[0].executor_run === pubs[0].executor_finished_run,
        JSON.stringify(pubs));
      const [outbox] = await query<{ n: string }>(sql`SELECT count(*) AS n FROM hawa.outbox_commands WHERE aggregate_id = ${task.id}::uuid AND command_type = 'notify.published'`);
      add('no notify.published command for a workflow delivery', Number(outbox.n) === 0, `notify.published=${outbox.n}`);
      const runs = await restateQuery<{ status: string; target_service_key: string }>(
        `SELECT status, target_service_key FROM sys_invocation WHERE target_service_name = 'Delivery' AND target_service_key LIKE 'dl-${task.id}-%'`
      );
      add('each Delivery run completed', runs.length === (pubs[0]?.executor_run ?? -1) && runs.every((r) => r.status === 'completed'), JSON.stringify(runs.map((r) => `${r.target_service_key.slice(-12)}:${r.status}`)));
    }
  }

  // Canva: one import (one editable document) per task.
  const [ops] = await query<{ imports: string; exports: string }>(sql`SELECT count(*) FILTER (WHERE kind = 'create') AS imports, count(*) FILTER (WHERE kind = 'export') AS exports FROM hawa.canva_remote_operations WHERE task_id = ${task.id}::uuid`);
  add('one Canva import per task', Number(ops.imports) === 1, `imports=${ops.imports} exports=${ops.exports}`);

  // Restate: one workflow for the task, finished; nothing paused; no journal mismatch.
  const inv = await restateQuery<{ id: string; status: string; last_failure_error_code: string | null }>(
    `SELECT id, status, last_failure_error_code FROM sys_invocation WHERE target_service_name = 'TaskWorkflow' AND target_service_key = 'task-wf-${task.id}'`
  );
  add('one TaskWorkflow invocation, completed', inv.length === 1 && inv[0].status === 'completed', JSON.stringify(inv.map((i) => i.status)));
  const [paused] = await restateQuery<{ n: number }>(`SELECT count(*) AS n FROM sys_invocation WHERE status = 'paused'`);
  add('no paused invocation', Number(paused?.n ?? 0) === 0, `paused=${paused?.n ?? 0}`);
  const [rt16] = await restateQuery<{ n: number }>(`SELECT count(*) AS n FROM sys_invocation WHERE last_failure_error_code = 'RT0016'`);
  add('no journal mismatch (RT0016)', Number(rt16?.n ?? 0) === 0, `RT0016=${rt16?.n ?? 0}`);
  return out;
}

/** Model calls no fixture answered: stages the fixtures do not cover, reached by this run. */
export async function uncoveredModelCalls(): Promise<string[]> {
  const { ledger } = await fakes.modelLedger();
  return (ledger as any[]).filter((l) => String(l.route).startsWith('unmatched')).map((l) => `${l.provider} ${l.route} ${l.model}`);
}

// ---------------------------------------------------------------------------------------------------
// Phase 2.1: the worker polls Telegram and each update goes through its chat's ChatInbox.

/** Hands an update to a chat's ChatInbox through Restate's ingress, as the worker's poller does. */
export async function sendToChatInbox(chat: string, update: Record<string, unknown>, idempotencyKey: string): Promise<number> {
  const res = await fetch(`${RESTATE_INGRESS_URL}/ChatInbox/${encodeURIComponent(chat)}/handleUpdate/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ v: 1, update, polledAt: Date.now() }),
  });
  return res.status;
}

/** The chat's ChatInbox invocations as Restate records them. */
export async function chatInboxInvocations(chat: string): Promise<Array<{ id: string; status: string; idempotency_key: string | null; last_failure_error_code: string | null }>> {
  return restateQuery(`SELECT id, status, idempotency_key, last_failure_error_code FROM sys_invocation
    WHERE target_service_name = 'ChatInbox' AND target_service_key = '${chat.replace(/[^0-9-]/g, '')}'`);
}

/** The worker poller's stored offset (the bot's row, shared with Core's poller). */
export async function storedOffset(): Promise<number> {
  const botId = secrets().CHAOS_BOT_TOKEN.split(':')[0];
  const [row] = await query<{ cursor_value: string | null }>(sql`SELECT h.cursor_value FROM hawa.integration_health h
    JOIN hawa.integrations i ON i.id = h.integration_id WHERE i.kind = 'telegram' AND i.name = ${`bot-${botId}`}`);
  return Number(row?.cursor_value ?? 0);
}

/**
 * The checks of slice 2.1 for one chat's updates: each update was handed to ChatInbox and finished
 * there (one invocation per poller key), the offset moved past the last one, and nothing was
 * dead-lettered. The acknowledgement reaching the chat once is checkRequest's "each message once".
 */
export async function checkIntake(chat: string, updateIds: number[]): Promise<InvariantResult[]> {
  const out: InvariantResult[] = [];
  const inv = await chatInboxInvocations(chat);
  for (const id of updateIds) {
    const mine = inv.filter((i) => i.idempotency_key === `tg-${id}`);
    out.push({ name: `update ${id}: one ChatInbox invocation (key tg-${id}), completed`, ok: mine.length === 1 && mine[0].status === 'completed', detail: JSON.stringify(mine.map((i) => i.status)) });
  }
  const unfinished = inv.filter((i) => i.status !== 'completed');
  out.push({ name: 'every ChatInbox invocation of the chat completed', ok: unfinished.length === 0, detail: `${inv.length} invocations: ${JSON.stringify(inv.map((i) => `${i.idempotency_key}:${i.status}`))}` });
  const offset = await storedOffset();
  const last = Math.max(...updateIds);
  out.push({ name: 'the stored offset moved past the chat\'s last update', ok: offset >= last, detail: `offset=${offset} last update=${last}` });
  const parkedIds = updateIds.map((id) => `parked-update-${id}`);
  const [parked] = await query<{ n: string }>(sql`SELECT count(*) AS n FROM hawa.inbox_events WHERE source_event_id = ANY(${parkedIds})`);
  out.push({ name: 'no update was dead-lettered', ok: Number(parked?.n ?? 0) === 0, detail: `parked=${parked?.n ?? 0}` });
  return out;
}

/** A brief in a chat, as the scripted requests send it; returns the update as Telegram serves it. */
export async function sendBrief(chat: string, tag: string): Promise<Record<string, unknown> & { update_id: number }> {
  const update = textUpdate(chat, briefText(tag));
  const [id] = await fakes.updates([update]);
  return { ...update, update_id: id };
}

/** Waits until the chat has its task and the draft reached the chat (the brief was sent already). */
export async function draftOf(chat: string, timeoutMs = 240_000): Promise<string> {
  const [task] = await waitUntil(`a task for chat ${chat}`, async () => {
    const t = await tasksOfChat(chat);
    return t.length ? t : null;
  }, 180_000);
  await waitUntil(`the draft of task ${task.id} in chat ${chat}`, async () => {
    const outcome = await designOutcome(task.id);
    if (outcome && outcome !== 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW') {
      throw new RequestEndedError(`task ${task.id}: the design run ended as ${outcome}, so there is no draft to approve`);
    }
    return (await sentTo(chat)).some(isDraft) && (await taskState(task.id)) === 'human_review';
  }, timeoutMs, 2000);
  return task.id;
}
