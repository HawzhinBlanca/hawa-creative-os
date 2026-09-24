import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { OutboxRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { composeOutcomeUnrecordedAlert, composeOutcomeUnrecordedMessage } from './delivery-notification.js';

/**
 * An outcome the Canva draft workflow could not report because Core did not answer for the report
 * step's whole window (canva-draft-workflow.ts). The work was finished, and the report was its only
 * record: the task stayed `received` and the requester was never told (2026-09-24). The worker has
 * the database, so it writes to the outbox what Core would have written, and the outbox, which this
 * worker drains without Core, carries it:
 *
 * - the requester's message, under the key Core uses for the same outcome, so a Core that takes the
 *   report later finds it written and sends nothing twice;
 * - an alert to the office chat, since with Core down the Desk shows nothing either;
 * - the report itself (`task.outcome`), sent to Core again until it is taken, so the task is still
 *   recorded and moved on as Core would have done it (outbox-consumer.ts).
 *
 * Every row is keyed by the task and the outcome, and written once.
 */

/** What the report step sent Core's /notifications/canva-status. */
export interface UnreportedOutcome {
  tenantId: string;
  taskId: string;
  report: Record<string, unknown>;
}

export interface OutcomeRecorded {
  requesterMessage: 'written' | 'already_written' | 'not_needed' | 'no_telegram_chat';
  officeAlert: 'written' | 'already_written' | 'no_office_chat';
  report: 'written' | 'already_written';
}

export type OutcomeRecorder = (outcome: UnreportedOutcome) => Promise<OutcomeRecorded | { skipped: string }>;

/** The part of a task's intake event this reads. */
type IntakeSource = { sourcePlatform?: unknown; sourceChannelId?: unknown; studioOptions?: { referenceFor?: unknown } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Core's own cleaning of a status or code (canvaStatusHandler), so the keys match its keys. */
const clean = (v: unknown) => (typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64) : undefined);

export function outcomeRecorder(
  db: Kysely<Database>,
  options: { userId?: string; officeChatId?: string | null } = {}
): OutcomeRecorder {
  const outbox = new OutboxRepository(db);
  // The worker's own identity, not a person's (outbox-consumer.ts scopeFor).
  const userId = options.userId || SYSTEM_AUTOMATION_USER_ID;
  return async ({ tenantId, taskId, report }) => {
    if (!UUID.test(String(tenantId)) || !UUID.test(String(taskId))) return { skipped: 'the task or tenant is not a stored id' };
    const status = clean(report.status) || 'DRAFT_READY';
    const code = clean(report.code);
    const designId = typeof report.designId === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(report.designId) ? report.designId : undefined;
    const runKey = typeof report.runId === 'string' ? report.runId : designId || 'no-run';
    const outcomeKey = `${taskId}:${status}${code ? `:${code}` : ''}:${runKey}`;
    const office =
      options.officeChatId !== undefined
        ? options.officeChatId || null
        : (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map((v) => v.trim()).find(Boolean) || null;

    return withRlsContext(db, { tenantId, userId, role: 'operator' }, async (trx) => {
      const row = (
        await sql<{ title: string | null; data: (IntakeSource & { payload?: IntakeSource }) | null }>`
          SELECT t.title, e.data FROM hawa.tasks t
          LEFT JOIN hawa.task_events e ON e.task_id = t.id AND e.event_type = 'task.created'
          WHERE t.tenant_id = ${tenantId}::uuid AND t.id = ${taskId}::uuid
          ORDER BY e.aggregate_version LIMIT 1`.execute(trx)
      ).rows[0];
      // Core writes the requester's message after it has recorded the outcome: if it is there, and not
      // this worker's, Core took the report and only its answer was lost.
      const earlier = await outbox.findByIdempotencyKey(tenantId, `notify.telegram:${outcomeKey}`, trx);
      if (earlier && !(earlier.payload as { recordedWithoutCore?: unknown } | null)?.recordedWithoutCore) {
        return { skipped: 'Core recorded this outcome already' };
      }
      const source: IntakeSource = row?.data?.payload || row?.data || {};
      const chat = source?.sourcePlatform === 'telegram' && source?.sourceChannelId ? String(source.sourceChannelId) : null;
      // Core sends nothing for a reference image joined to another request, or when intake told them.
      const wanted = report.notifyRequester !== false && !source?.studioOptions?.referenceFor;

      const writeOnce = async (idempotencyKey: string, commandType: string, payload: Record<string, unknown>): Promise<'written' | 'already_written'> => {
        if (await outbox.findByIdempotencyKey(tenantId, idempotencyKey, trx)) return 'already_written';
        await outbox.enqueue({ tenantId, aggregateType: 'task', aggregateId: taskId, commandType, idempotencyKey, payload }, trx);
        return 'written';
      };

      const officeAlert: OutcomeRecorded['officeAlert'] = office && office !== chat
        ? await writeOnce(`notify.office:outcome-unrecorded:${outcomeKey}`, 'notify.telegram', {
            chatId: office,
            taskId,
            message: composeOutcomeUnrecordedAlert({ taskId, status, code, designId, requesterChat: chat, requesterTold: Boolean(wanted && chat) }),
          })
        : 'no_office_chat';
      const requesterMessage: OutcomeRecorded['requesterMessage'] = !wanted
        ? 'not_needed'
        : !chat
          ? 'no_telegram_chat'
          : await writeOnce(`notify.telegram:${outcomeKey}`, 'notify.telegram', {
              chatId: chat,
              taskId,
              status,
              ...(code ? { code } : {}),
              ...(designId ? { designId } : {}),
              message: composeOutcomeUnrecordedMessage({ taskId, title: row?.title, draftMade: Boolean(designId), officeAlerted: officeAlert !== 'no_office_chat' }),
              recordedWithoutCore: true,
            });
      const reported = await writeOnce(`task.outcome:${outcomeKey}`, 'task.outcome', { taskId, report });
      return { requesterMessage, officeAlert, report: reported };
    });
  };
}
