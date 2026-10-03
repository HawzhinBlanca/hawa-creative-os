/**
 * The office's approval target (ADR-288): a draft waiting for office approval longer than a number of
 * working hours (default 4, office hours Sunday to Thursday 09:00 to 17:00, Asia/Baghdad) is named to
 * every office member, once per draft.
 *
 * This is the target the owner measures the office by, in working time, so a draft finished at 16:30
 * on Thursday is not late on Friday. It sits beside the lifecycle stale reminder (ADR-155,
 * lifecycle-stale-sweep.ts), which counts wall-clock hours per request stage; this one is keyed by the
 * task (one draft), so a draft is named once however often its request changes revision.
 *
 * Configuration: HAWA_APPROVAL_SLA_BUSINESS_HOURS (default 4), HAWA_OFFICE_TIMEZONE (Asia/Baghdad),
 * HAWA_OFFICE_DAYS (Sun-Thu; a range or a comma list of three-letter days), HAWA_OFFICE_HOURS
 * (09:00-17:00).
 */
import { CANARY_TEST_CLIENT_ID, SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { canaryChatSql } from './canary-sql.js';
import { officeReviewUrl } from './desk-review-link.js';

const HOUR_MS = 3_600_000;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface OfficeCalendar {
  timeZone: string;
  /** Working weekdays, 0 = Sunday. */
  days: ReadonlySet<number>;
  /** Opening and closing, in minutes after local midnight. */
  openMinute: number;
  closeMinute: number;
}

export interface ApprovalSlaConfig { calendar: OfficeCalendar; thresholdMs: number }

function parseDays(value: string): Set<number> | null {
  const days = new Set<number>();
  for (const part of value.toLowerCase().split(',').map((p) => p.trim()).filter(Boolean)) {
    const [from, to] = part.split('-').map((d) => DAY_NAMES.indexOf(d.trim().slice(0, 3)));
    if (from < 0 || (to !== undefined && to < 0)) return null;
    for (let d = from; ; d = (d + 1) % 7) { days.add(d); if (to === undefined || d === to) break; }
  }
  return days.size ? days : null;
}

function parseHours(value: string): [number, number] | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(value);
  if (!m) return null;
  const open = Number(m[1]) * 60 + Number(m[2]), close = Number(m[3]) * 60 + Number(m[4]);
  return open < close && close <= 24 * 60 ? [open, close] : null;
}

/** The office's calendar and target from the environment; a value that cannot be read keeps its default. */
export function approvalSlaConfig(env: Record<string, string | undefined> = process.env): ApprovalSlaConfig {
  let timeZone = env.HAWA_OFFICE_TIMEZONE?.trim() || 'Asia/Baghdad';
  try { new Intl.DateTimeFormat('en-US', { timeZone }); } catch { timeZone = 'Asia/Baghdad'; }
  const days = parseDays(env.HAWA_OFFICE_DAYS || '') ?? parseDays('sun-thu')!;
  const [openMinute, closeMinute] = parseHours(env.HAWA_OFFICE_HOURS || '') ?? [9 * 60, 17 * 60];
  const hours = Number(env.HAWA_APPROVAL_SLA_BUSINESS_HOURS);
  return { calendar: { timeZone, days, openMinute, closeMinute },
    thresholdMs: (Number.isFinite(hours) && hours > 0 && hours <= 100 ? hours : 4) * HOUR_MS };
}

function zoneParts(timeZone: string, instant: number) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** The instant a local wall-clock time names in `timeZone` (offsets read from Intl, DST included). */
function zonedInstant(timeZone: string, year: number, month: number, day: number, minuteOfDay: number): number {
  const guess = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  const offset = (at: number) => {
    const p = zoneParts(timeZone, at);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
  };
  const first = guess - offset(guess);
  const second = guess - offset(first);
  return second;
}

/** Working time between two instants under the office calendar, in milliseconds. */
export function businessMsBetween(startMs: number, endMs: number, calendar: OfficeCalendar): number {
  if (!(endMs > startMs)) return 0;
  const local = zoneParts(calendar.timeZone, startMs);
  let total = 0;
  for (let i = 0; i < 400; i++) {
    const date = new Date(Date.UTC(local.year, local.month - 1, local.day + i));
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    const open = zonedInstant(calendar.timeZone, y, m, d, calendar.openMinute);
    if (open >= endMs) break;
    if (!calendar.days.has(date.getUTCDay())) continue;
    const close = zonedInstant(calendar.timeZone, y, m, d, calendar.closeMinute);
    total += Math.max(0, Math.min(close, endMs) - Math.max(open, startMs));
  }
  return total;
}

export interface LateApproval {
  taskId: string; title: string; client: string | null; waitingSinceMs: number; businessMs: number;
}

const placeName = (timeZone: string) => (timeZone.split('/').pop() || timeZone).replaceAll('_', ' ');

/** The office's words for one late draft (English, like every office alert). */
export function approvalSlaText(late: LateApproval, config: ApprovalSlaConfig): string {
  const hours = Math.floor(late.businessMs / HOUR_MS);
  const target = Math.round(config.thresholdMs / HOUR_MS * 10) / 10;
  const since = new Intl.DateTimeFormat('en-GB', { timeZone: config.calendar.timeZone, weekday: 'long', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23' }).format(new Date(late.waitingSinceMs));
  const title = late.title.length > 80 ? `${late.title.slice(0, 79)}…` : late.title;
  const reviewUrl = officeReviewUrl({ taskId: late.taskId });
  return `A draft has been waiting for office approval for ${hours} working hours, longer than the ${target}-hour target: `
    + `"${title}"${late.client ? ` for ${late.client}` : ''}. It has waited since ${since} (${placeName(config.calendar.timeZone)} time). `
    + 'Please approve it or ask for changes.'
    + (reviewUrl ? `\nOpen it in Hawa Desk (office sign-in required): ${reviewUrl}` : '');
}

const alertKey = (taskId: string) => `notify.office:approval-sla:${taskId}`;
/** A draft waiting longer than this is old news to the office: never alerted on a first sweep. */
export const APPROVAL_SLA_HORIZON_MS = 14 * 24 * HOUR_MS;
export const APPROVAL_SLA_ALERTS_PER_SWEEP = 5;

/**
 * One pass: drafts in office review (task `human_review`) past the target in working time, that no
 * earlier pass named, oldest first, each named to every office member through the outbox. The nightly
 * canary's drafts are never the office's business and are skipped. Returns what it alerted.
 */
export async function sweepApprovalSla(db: Kysely<Database>, options: {
  tenantId: string; officeChatIds: readonly string[]; nowMs: number; config?: ApprovalSlaConfig; limit?: number;
}): Promise<LateApproval[]> {
  const members = [...new Set(options.officeChatIds.map((c) => c.trim()).filter(Boolean))];
  if (!members.length) return [];
  const config = options.config ?? approvalSlaConfig();
  const horizon = new Date(options.nowMs - APPROVAL_SLA_HORIZON_MS);
  return withRlsContext(db, { tenantId: options.tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
    // Waiting since the draft last entered review (its task event), else the task's last change.
    const rows = (await sql<{ id: string; title: string; client: string | null; since: Date }>`
      SELECT t.id, t.title, c.name AS client,
        COALESCE((SELECT max(e.occurred_at) FROM hawa.task_events e WHERE e.tenant_id = t.tenant_id AND e.task_id = t.id
          AND e.event_type = 'task.state_changed' AND e.data->>'toState' = 'human_review'), t.updated_at) AS since
      FROM hawa.tasks t
      LEFT JOIN hawa.clients c ON c.tenant_id = t.tenant_id AND c.id = t.client_id
      LEFT JOIN hawa.requests r ON r.tenant_id = t.tenant_id AND r.request_id = t.request_id
      WHERE t.tenant_id = ${options.tenantId}::uuid AND t.state = 'human_review' AND t.deleted_at IS NULL
        AND t.client_id IS DISTINCT FROM ${CANARY_TEST_CLIENT_ID}::uuid
        AND NOT ${canaryChatSql(sql`r.chat_id`)}
        AND NOT EXISTS (SELECT 1 FROM hawa.outbox_commands o WHERE o.tenant_id = t.tenant_id AND o.aggregate_id = t.id
          AND o.command_type = 'task.created' AND ${canaryChatSql(sql`o.payload->>'sourceChannelId'`)})
        AND NOT EXISTS (SELECT 1 FROM hawa.outbox_commands o WHERE o.tenant_id = t.tenant_id
          AND o.idempotency_key = ${'notify.office:approval-sla:'} || t.id::text)
      ORDER BY since ASC LIMIT 100`.execute(trx)).rows;
    const late: LateApproval[] = [];
    for (const row of rows) {
      const since = new Date(row.since).getTime();
      if (since < horizon.getTime()) continue;
      const businessMs = businessMsBetween(since, options.nowMs, config.calendar);
      if (businessMs < config.thresholdMs) continue;
      const item: LateApproval = { taskId: row.id, title: row.title, client: row.client, waitingSinceMs: since, businessMs };
      const text = approvalSlaText(item, config);
      for (const [index, chatId] of members.entries()) {
        // The first member's key is the one the query looks for; the others name their chat.
        const key = index === 0 ? alertKey(item.taskId) : `${alertKey(item.taskId)}:${chatId}`;
        await sql`INSERT INTO hawa.outbox_commands
            (tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload, state, attempts, available_at)
          VALUES (${options.tenantId}::uuid, 'task', ${item.taskId}::uuid, 'notify.telegram', ${key},
            ${JSON.stringify({ chatId, taskId: item.taskId, message: { text } })}::jsonb, 'pending', 0, now())
          ON CONFLICT DO NOTHING`.execute(trx);
      }
      late.push(item);
      if (late.length >= Math.max(1, options.limit ?? APPROVAL_SLA_ALERTS_PER_SWEEP)) break;
    }
    return late;
  });
}
