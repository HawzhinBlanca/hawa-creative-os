import { escapeTelegramHtml } from '@hawa/integrations';
import { sql, withRlsContext, type Database, type Kysely, type OutboxRepository } from '@hawa/db';
import { requesterButtons, questionButtons, type InlineButton } from './requester-actions.js';
import { log } from '../logging.js';

/**
 * A draft the requester has not answered is asked about once a day after it was sent, and once more
 * after five days (ADR-032 §2.4): the loop stays with them until they approve, change it or hand it
 * to a designer. Never at night, never twice for the same draft and day, and never for a draft a
 * newer one replaced, one they answered (a button, a reply or any message after it), or one sent
 * before reminders existed.
 */

/** Drafts sent before this are never reminded about: the office was not told to expect it. */
export const REMINDERS_FROM = '2026-09-24T06:00:00Z';

export interface DraftToRemind {
  taskId: string;
  title: string | null;
  chat: string;
  sentAt: Date;
  /** Hours since the draft was sent, by the database's clock, as the windows above are. */
  ageHours: number;
}

export function composeDraftReminder(taskId: string, title: string | null, day: 1 | 5): {
  text: string;
  parse_mode: 'HTML';
  reply_markup: { inline_keyboard: InlineButton[][] };
} {
  const lead = day === 1 ? '👋 <b>Is this design right for you?</b>' : '👋 <b>Still waiting on this design</b>';
  return {
    text:
      `${lead}\n\n📜 ${escapeTelegramHtml(title || 'Your design')}\n\n` +
      `Tap Approve if it is right, tell us what to change, or ask for a designer.\n\n` +
      `🆔 Task ID: <code>${escapeTelegramHtml(taskId)}</code>`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: requesterButtons(taskId) },
  };
}

/**
 * A question asked before a change (edit stage, NEEDS_CLARIFICATION) that the requester has not
 * answered: the change waits on it, so it is asked again with its answers, like an unanswered draft.
 */
export interface QuestionToRemind {
  taskId: string;
  chat: string;
  ageHours: number;
  question: string;
  options: string[];
}

export function composeQuestionReminder(taskId: string, question: string, options: string[], day: 1 | 5): {
  text: string;
  parse_mode: 'HTML';
  reply_markup: { inline_keyboard: InlineButton[][] };
} {
  const lead = day === 1 ? '👋 <b>Your change is waiting for one answer</b>' : '👋 <b>Still waiting for your answer</b>';
  return {
    text:
      `${lead}\n\n${escapeTelegramHtml(question)}\n\n` +
      options.slice(0, 3).map((o, i) => `${i + 1}. ${escapeTelegramHtml(o)}\n`).join('') +
      `\nTap an answer, reply in your own words, or ask for a designer.\n\n` +
      `🆔 Task ID: <code>${escapeTelegramHtml(taskId)}</code>`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: questionButtons(taskId, options) },
  };
}

export async function questionsToRemind(db: Kysely<Database>, tenantId: string, userId: string, from: string = REMINDERS_FROM): Promise<QuestionToRemind[]> {
  const rows = await withRlsContext(db, { tenantId, userId, role: 'operator' }, async (trx) =>
    (
      await sql<{ task_id: string; chat: string; age_hours: number; clarify: { question?: unknown; options?: unknown } | null }>`SELECT t.id::text AS task_id,
          o.payload->>'sourceChannelId' AS chat,
          (extract(epoch FROM now() - n.created_at) / 3600)::float8 AS age_hours,
          r.stages->'directed'->'clarify' AS clarify
        FROM hawa.tasks t
        JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.tenant_id = t.tenant_id AND o.command_type = 'task.created'
        JOIN LATERAL (SELECT x.stages FROM hawa.design_studio_runs x WHERE x.tenant_id = t.tenant_id AND x.task_id = t.id ORDER BY x.created_at DESC LIMIT 1) r ON true
        JOIN LATERAL (
          SELECT d.created_at FROM hawa.outbox_commands d
          WHERE d.tenant_id = t.tenant_id AND d.aggregate_id = t.id AND d.command_type = 'notify.telegram'
            AND d.state = 'delivered' AND d.idempotency_key NOT LIKE 'notify.telegram:%reminder%'
          ORDER BY d.created_at DESC LIMIT 1
        ) n ON true
        WHERE t.tenant_id = ${tenantId}::uuid AND t.state = 'paused'
          -- A request the lifecycle owns is reminded by RequestLifecycle, never here as well.
          AND t.request_id IS NULL
          AND r.stages->'directed'->>'refused' = 'NEEDS_CLARIFICATION'
          -- Not once a newer change to the same design exists, or the question was answered.
          AND NOT EXISTS (SELECT 1 FROM hawa.tasks n JOIN hawa.outbox_commands no ON no.aggregate_id = n.id AND no.command_type = 'task.created'
            WHERE n.tenant_id = t.tenant_id AND n.id <> t.id AND n.created_at > t.created_at
              AND no.payload->'studioOptions'->>'parentTaskId' = o.payload->'studioOptions'->>'parentTaskId'
              AND COALESCE(no.payload->'studioOptions'->>'reformat', '') = ''
              AND n.state NOT IN ('cancelled', 'rejected', 'failed_operator'))
          AND NOT EXISTS (SELECT 1 FROM hawa.outbox_commands a WHERE a.tenant_id = t.tenant_id AND a.command_type = 'task.created'
            AND a.payload->'studioOptions'->>'answers' = t.id::text)
          AND o.payload->>'sourcePlatform' = 'telegram' AND o.payload->>'sourceChannelId' ~ '^-?[0-9]+$'
          AND n.created_at > ${from}::timestamptz
          AND n.created_at < now() - interval '24 hours' AND n.created_at > now() - interval '14 days'
          AND NOT EXISTS (
            SELECT 1 FROM hawa.inbox_events e
            WHERE e.tenant_id = t.tenant_id AND e.source_account_id = 'telegram'
              AND e.source_event_id LIKE (o.payload->>'sourceChannelId') || ':%' AND e.received_at > n.created_at)
        ORDER BY n.created_at
        LIMIT 50`.execute(trx)
    ).rows
  );
  return rows
    .map((r) => ({
      taskId: r.task_id,
      chat: r.chat,
      ageHours: Number(r.age_hours),
      question: typeof r.clarify?.question === 'string' ? r.clarify.question : '',
      options: Array.isArray(r.clarify?.options) ? r.clarify.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '') : [],
    }))
    .filter((q) => q.question && q.options.length >= 2);
}

/** Whether a moment falls in office hours in Erbil (UTC+3): 09:00 to 20:00. */
export function inOfficeHours(now: Date): boolean {
  const hour = (now.getUTCHours() + 3) % 24;
  return hour >= 9 && hour < 20;
}

export async function draftsToRemind(db: Kysely<Database>, tenantId: string, userId: string, from: string = REMINDERS_FROM): Promise<DraftToRemind[]> {
  return withRlsContext(db, { tenantId, userId, role: 'operator' }, async (trx) =>
    (
      await sql<{ task_id: string; title: string | null; chat: string; sent_at: Date; age_hours: number }>`SELECT t.id::text AS task_id, t.title,
          o.payload->>'sourceChannelId' AS chat, n.created_at AS sent_at,
          (extract(epoch FROM now() - n.created_at) / 3600)::float8 AS age_hours
        FROM hawa.tasks t
        JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.tenant_id = t.tenant_id AND o.command_type = 'task.created'
        JOIN LATERAL (
          SELECT d.created_at FROM hawa.outbox_commands d
          WHERE d.tenant_id = t.tenant_id AND d.aggregate_id = t.id AND d.command_type = 'notify.telegram'
            AND d.payload->>'status' = 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW' AND d.state = 'delivered'
          ORDER BY d.created_at DESC LIMIT 1
        ) n ON true
        WHERE t.tenant_id = ${tenantId}::uuid AND t.state = 'human_review'
          -- A request the lifecycle owns is reminded by RequestLifecycle, never here as well.
          AND t.request_id IS NULL
          AND o.payload->>'sourcePlatform' = 'telegram' AND o.payload->>'sourceChannelId' ~ '^-?[0-9]+$'
          AND n.created_at > ${from}::timestamptz
          AND n.created_at < now() - interval '24 hours' AND n.created_at > now() - interval '14 days'
          AND NOT EXISTS (
            SELECT 1 FROM hawa.tasks ct JOIN hawa.outbox_commands co ON co.aggregate_id = ct.id AND co.command_type = 'task.created'
            WHERE ct.tenant_id = t.tenant_id AND co.payload->'studioOptions'->>'parentTaskId' = t.id::text
              AND ct.state NOT IN ('cancelled', 'rejected', 'failed_operator'))
          AND NOT EXISTS (
            SELECT 1 FROM hawa.inbox_events e
            WHERE e.tenant_id = t.tenant_id AND e.source_account_id = 'telegram'
              AND e.source_event_id LIKE (o.payload->>'sourceChannelId') || ':%' AND e.received_at > n.created_at)
          AND NOT EXISTS (
            SELECT 1 FROM hawa.inbox_events e
            WHERE e.tenant_id = t.tenant_id AND e.event_kind LIKE 'telegram_requester_%' AND e.payload->>'taskId' = t.id::text)
        ORDER BY n.created_at
        LIMIT 50`.execute(trx)
    ).rows.map((r) => ({ taskId: r.task_id, title: r.title, chat: r.chat, sentAt: new Date(r.sent_at), ageHours: Number(r.age_hours) }))
  );
}

/**
 * One pass: every unanswered draft due a reminder gets one, through the outbox (the worker sends
 * it), keyed by task and day so a second pass or a second process writes nothing twice.
 */
export async function remindUnansweredDrafts(input: {
  db: Kysely<Database>;
  outbox: OutboxRepository;
  tenantId: string;
  userId: string;
  now?: Date;
  /** Drafts sent before this are left alone (tests move it; the office's is REMINDERS_FROM). */
  from?: string;
}): Promise<number> {
  const now = input.now ?? new Date();
  if (!inOfficeHours(now)) return 0;
  const due = await draftsToRemind(input.db, input.tenantId, input.userId, input.from ?? REMINDERS_FROM);
  let written = 0;
  for (const d of due) {
    const day: 1 | 5 = d.ageHours >= 5 * 24 ? 5 : 1;
    try {
      await withRlsContext(input.db, { tenantId: input.tenantId, userId: input.userId, role: 'operator' }, (trx) =>
        input.outbox.enqueue({
          tenantId: input.tenantId,
          aggregateType: 'task',
          aggregateId: d.taskId,
          commandType: 'notify.telegram',
          idempotencyKey: `notify.telegram:reminder${day}:${d.taskId}`,
          payload: { chatId: d.chat, taskId: d.taskId, status: `DRAFT_REMINDER_DAY_${day}`, message: composeDraftReminder(d.taskId, d.title, day) },
        }, trx)
      );
      written++;
    } catch {
      // Already written for this draft and day: the key is unique, which is the point.
    }
  }
  for (const q of await questionsToRemind(input.db, input.tenantId, input.userId, input.from ?? REMINDERS_FROM)) {
    const day: 1 | 5 = q.ageHours >= 5 * 24 ? 5 : 1;
    try {
      await withRlsContext(input.db, { tenantId: input.tenantId, userId: input.userId, role: 'operator' }, (trx) =>
        input.outbox.enqueue({
          tenantId: input.tenantId,
          aggregateType: 'task',
          aggregateId: q.taskId,
          commandType: 'notify.telegram',
          idempotencyKey: `notify.telegram:question-reminder${day}:${q.taskId}`,
          payload: { chatId: q.chat, taskId: q.taskId, status: `QUESTION_REMINDER_DAY_${day}`, message: composeQuestionReminder(q.taskId, q.question, q.options, day) },
        }, trx)
      );
      written++;
    } catch {
      // Already written for this question and day.
    }
  }
  if (written) log.info(`[draft-reminders] ${written} reminder(s) written`);
  return written;
}
