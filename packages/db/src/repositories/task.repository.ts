import crypto from 'node:crypto';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { API_STATUS_OF_DB_STATE, CHANNEL_INGRESS_USER_ID, TASK_DB_STATES, toApiTaskStatus, toDbTaskState } from '@hawa/contracts';
import type { Database, TasksTable, TaskEventsTable, TaskState } from '../types.js';
import { withRlsContext, type RlsContext } from '../client.js';
import { currentTraceId, withRequestId } from '../trace-context.js';

export class IdempotencyConflictError extends Error {
  constructor(message: string = 'Idempotency conflict: key already used with different payload') {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export class ConcurrencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyConflictError';
  }
}

export class TaskNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskNotFoundError';
  }
}

export interface CreateTaskAggregateParams {
  /** ADR259: immutable customer owner; absent for office requests. */
  customerAccountId?: string;
  tenantId: string;
  userId: string;
  idempotencyKey: string;
  title: string;
  description?: string;
  clientId?: string | null;
  projectId?: string | null;
  taskType?: string | null;
  language?: string | null;
  direction?: 'ltr' | 'rtl' | 'auto' | null;
  priority?: number; // 1-5 (default 3)
  sensitivity?: 'normal' | 'sensitive' | 'restricted';
  sourceMessageId?: string | null;
  actorType?: 'user' | 'model' | 'workflow' | 'adapter' | 'system';
  actorId?: string | null;
  correlationId?: string;
  traceId?: string | null;
  metadata?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  /** Original HTTP body, excluding server-derived evidence. Legacy receipts retain it as payload.body. */
  requestBody?: Record<string, unknown>;
  enqueueOutbox?: boolean;
  /** New intake validation/enrichment only; exact committed replays retain their recorded metadata. */
  prepareCreatePayload?: (trx: Kysely<Database>) => Promise<Record<string, unknown>>;
  /** Explicit lifecycle/manual ownership records creation without legacy worker dispatch. */
  outboxState?: 'pending' | 'recorded' | 'manual';
  /** Immutable at task creation; an enrolled chat cannot switch an existing task at Deliver. */
  deliveryExecutorPin?: 'core' | 'restate';
}

/**
 * The mapping between database states and API statuses is the one vocabulary's (packages/contracts
 * task-status.ts, architecture programme 1.2). Both functions throw on a word neither list has: this
 * one used to store every unknown word as 'received', and toApiTaskStatus upper-cased it.
 */
export { toDbTaskState, toApiTaskStatus };

/** Every value of the database's task_state enum (db/schema.sql), in its declared order. */
export const TASK_STATES: readonly TaskState[] = TASK_DB_STATES;

/**
 * The database states the list shows under the given API statuses: every state whose API status is
 * one of them. Built from the state-to-status mapping rather than toDbTaskState, so a filter matches
 * the tasks the list may label with that status (OPERATOR_REQUIRED takes failed_retryable too).
 * The reconciliation statuses share the publishing state; the page/count query checks the
 * latest publication error when either is requested. An unknown word matches nothing.
 */
export function dbStatesForApiStatuses(statuses: readonly string[]): TaskState[] {
  const wanted = new Set(statuses.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean));
  return TASK_STATES.filter((state) => wanted.has(API_STATUS_OF_DB_STATE[state]) ||
    (state === 'publishing' && (wanted.has('PUBLISH_RECONCILIATION') || wanted.has('ARCHIVE_RECONCILIATION') ||
      wanted.has('REQUESTER_SEND_RECONCILIATION'))));
}

/** Where a task page starts: the last row of the page before it, in list order. */
export interface TaskPageCursor {
  /** created_at to the microsecond, UTC. A JavaScript Date keeps milliseconds only, and two tasks
   * created in the same millisecond would be skipped or repeated at a page boundary. */
  createdAt: string;
  id: string;
}

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The opaque cursor the API hands out. Clients pass it back unchanged and never read it. */
export function encodeTaskCursor(cursor: TaskPageCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), 'utf8').toString('base64url');
}

/** The cursor a client sent back, or null when it is not one this API issued. */
export function decodeTaskCursor(value: string): TaskPageCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, id] = parsed;
    if (typeof createdAt !== 'string' || !CURSOR_TIME.test(createdAt)) return null;
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export const TASK_PAGE_DEFAULT_LIMIT = 50;
export const TASK_PAGE_MAX_LIMIT = 200;

export interface TaskPageParams {
  tenantId: string;
  /** 1..200; anything else is clamped (default 50). */
  limit?: number;
  /** Start after this row (keyset). Takes precedence over offset. */
  cursor?: TaskPageCursor | null;
  /** Rows to skip: the older way to page, kept for callers that still send it. */
  offset?: number;
  clientId?: string | null;
  /** Only tasks in these states; an empty list matches nothing. Undefined means every state. */
  states?: readonly TaskState[];
  /** The publication substates requested by the API filter, for rows stored as publishing. */
  publishingStatuses?: readonly ('archive' | 'sheet' | 'requester_send' | 'ordinary')[];
  /** Text to find in the title, the description, the client's name or the task id. */
  search?: string | null;
}

/**
 * One row of the task list. It carries the text the queue shows and small summaries of the latest
 * QC run, approval, Canva binding and revision; never the intake event's JSON (a reference photo in
 * it is hundreds of kilobytes) nor any column that holds image bytes.
 */
export interface TaskListRow {
  id: string;
  tenant_id: string;
  client_id: string | null;
  project_id: string | null;
  request_id: string | null;
  state: TaskState;
  priority: number;
  title: string;
  description: string;
  version: string | number;
  current_design_revision_id: string | null;
  created_at: Date;
  updated_at: Date;
  cursor_created_at: string;
  client_name: string | null;
  headline_en: string | null;
  headline_ckb: string | null;
  copy_en: string | null;
  copy_ckb: string | null;
  design_instructions: string | null;
  reference_assets: string | null;
  source_platform: string | null;
  source_event_id: string | null;
  source_channel_id: string | null;
  qc_status: string | null;
  qc_critical_pass: boolean | null;
  qc_report: Record<string, unknown> | null;
  approval_id: string | null;
  approval_created_at: Date | null;
  approval_role: string | null;
  approval_actor_id: string | null;
  canva_design_id: string | null;
  canva_edit_url: string | null;
  rev_id: string | null;
  rev_version: number | null;
  rev_sha256: string | null;
  rev_created_at: Date | null;
  delivery_error_class: string | null;
  delivery_executor: string | null;
}

export interface TaskPage {
  rows: TaskListRow[];
  total: number;
  limit: number;
  nextCursor: string | null;
}

function clampLimit(limit: number | undefined): number {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n < 1) return TASK_PAGE_DEFAULT_LIMIT;
  return Math.min(n, TASK_PAGE_MAX_LIMIT);
}

/**
 * Letters one Kurdish word can be typed with, folded to one before the search compares (both the
 * search text and the stored text). Sorani is stored as the office writes it, with ە (U+06D5) for the
 * vowel, ی and ک; an Arabic keyboard has none of these and types ه (usually with a zero-width
 * non-joiner after it), ي or ى, and ك. Architecture programme 1.5 (2026-09-24) added the ە/ه pair and
 * the joiners: a Kurdish title typed on an Arabic keyboard was never found.
 *
 * FOLD_FROM[i] becomes FOLD_TO[i]; the characters past the end of FOLD_TO (the zero-width non-joiner
 * and the tatweel, which only shape the text) are dropped, as SQL translate() drops them.
 */
const FOLD_FROM = '\u064A\u0649\u0643\u06D5\u06BE\u200C\u0640'; // ي ى ك ە ھ ZWNJ tatweel
const FOLD_TO = '\u06CC\u06CC\u06A9\u0647\u0647'; // ی ی ک ه ه

/** `text` folded as the search compares it (see FOLD_FROM): lower case, one letter per variant. */
function foldSearchText(text: string): string {
  let out = '';
  for (const ch of text.toLowerCase()) {
    const i = FOLD_FROM.indexOf(ch);
    if (i < 0) out += ch;
    else if (i < FOLD_TO.length) out += FOLD_TO[i];
  }
  return out;
}

/** The search text as a LIKE pattern, folded (see FOLD_FROM). */
function searchPattern(search: string): string {
  const folded = foldSearchText(search.trim());
  return `%${folded.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** The same folding in SQL: lower-case, then translate() with the same two lists. */
const fold = (expr: RawBuilder<unknown>) => sql`translate(lower(${expr}), ${FOLD_FROM}, ${FOLD_TO})`;

/**
 * The filter every page and the total share. `t` is hawa.tasks. The search also reads the request's
 * headline and copy (the intake event), since titles are often English while the Kurdish lives there.
 */
function taskListFilter(params: TaskPageParams) {
  const conditions = [sql`t.tenant_id = ${params.tenantId}::uuid`, sql`t.deleted_at IS NULL`];
  if (params.clientId) conditions.push(sql`t.client_id = ${params.clientId}::uuid`);
  if (params.states) {
    const states = [...params.states];
    const publicationStatus = sql`COALESCE((SELECT CASE
      WHEN p.error_class = 'ARCHIVE_UNCONFIRMED' THEN 'archive'
      WHEN p.error_class = 'SHEET_UNCONFIRMED' THEN 'sheet'
      WHEN p.error_class = 'REQUESTER_SEND_UNCONFIRMED' THEN 'requester_send'
      ELSE 'ordinary' END
      FROM hawa.publications p WHERE p.tenant_id = t.tenant_id AND p.task_id = t.id
      ORDER BY p.created_at DESC LIMIT 1), 'ordinary')`;
    conditions.push(params.publishingStatuses && states.includes('publishing')
      ? sql`(t.state = ANY(${states}::hawa.task_state[]) AND
          (t.state <> 'publishing' OR ${publicationStatus} = ANY(${[...params.publishingStatuses]}::text[])))`
      : sql`t.state = ANY(${states}::hawa.task_state[])`);
  }
  if (params.search && params.search.trim()) {
    const pattern = searchPattern(params.search);
    conditions.push(sql`(
      ${fold(sql`t.title`)} LIKE ${pattern} ESCAPE '\\'
      OR ${fold(sql`t.description`)} LIKE ${pattern} ESCAPE '\\'
      OR t.id::text LIKE ${pattern} ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM hawa.clients cs WHERE cs.id = t.client_id AND ${fold(sql`cs.name`)} LIKE ${pattern} ESCAPE '\\')
      OR EXISTS (
        SELECT 1 FROM (
          SELECT CASE WHEN jsonb_typeof(e.data -> 'payload') = 'object' THEN e.data -> 'payload' ELSE e.data END AS p
          FROM hawa.task_events e
          WHERE e.task_id = t.id AND e.event_type = 'task.created'
        ) ev
        WHERE ${fold(sql`concat_ws(' ', ${intakeText('headlineCkb')}, ${intakeText('copyCkb')}, ${intakeText('headlineEn')}, ${intakeText('copyEn')})`)} LIKE ${pattern} ESCAPE '\\'
      )
    )`);
  }
  return conditions;
}

/** A string or number at `expr` (jsonb) as text; objects, arrays and anything bulky are left out. */
const scalarText = (expr: RawBuilder<unknown>) =>
  sql`CASE WHEN jsonb_typeof(${expr}) IN ('string', 'number') THEN ${expr} #>> '{}' END`;

/** The first non-empty text of the intake payload's `key`, then of `body.key` (as the detail route reads them). */
const intakeText = (key: string, bodyPath: readonly string[] = [key]) =>
  sql`COALESCE(NULLIF(${scalarText(sql`ev.p -> ${sql.lit(key)}`)}, ''), NULLIF(${scalarText(sql`ev.p #> ${sql.lit(`{body,${bodyPath.join(',')}}`)}`)}, ''))`;

/**
 * The page query. Tasks are chosen first (keyset on created_at, id, newest first, one index range
 * scan), and only the page's own rows then look up their latest QC run, approval, Canva binding,
 * revision and intake text, each through an index (migration 018). The old query ran six correlated
 * subqueries for every row it sorted and returned the whole intake event JSON with each row.
 *
 * It runs inside the caller's row-level-security context: every table read here has its policy
 * applied exactly as before, so a task, client name or approval the reader may not see stays hidden.
 */
export function buildTaskPageQuery(params: TaskPageParams) {
  const limit = clampLimit(params.limit);
  const conditions = taskListFilter(params);
  if (params.cursor) {
    conditions.push(sql`(t.created_at, t.id) < (${params.cursor.createdAt}::timestamptz, ${params.cursor.id}::uuid)`);
  }
  const offset = params.cursor ? 0 : Math.max(0, Math.floor(Number(params.offset) || 0));
  // One row more than the page shows tells whether an older page exists.
  return sql<TaskListRow>`
    SELECT t.id, t.tenant_id, t.client_id, t.project_id, t.request_id, t.state, t.priority, t.title, t.description, t.version,
      t.current_design_revision_id, t.created_at, t.updated_at,
      to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
      c.name AS client_name,
      ${intakeText('headlineEn')} AS headline_en,
      ${intakeText('headlineCkb')} AS headline_ckb,
      ${intakeText('copyEn')} AS copy_en,
      ${intakeText('copyCkb')} AS copy_ckb,
      ${intakeText('designInstructions')} AS design_instructions,
      ${intakeText('referenceAssets')} AS reference_assets,
      ${intakeText('sourcePlatform', ['source', 'platform'])} AS source_platform,
      NULLIF(${scalarText(sql`ev.p -> 'sourceEventId'`)}, '') AS source_event_id,
      NULLIF(${scalarText(sql`ev.p -> 'sourceChannelId'`)}, '') AS source_channel_id,
      q.status AS qc_status, q.critical_pass AS qc_critical_pass, q.report AS qc_report,
      a.id AS approval_id, a.created_at AS approval_created_at, a.role AS approval_role, a.decided_by AS approval_actor_id,
      b.canva_design_id, b.edit_url AS canva_edit_url,
      r.id AS rev_id, r.revision AS rev_version, r.source_sha256 AS rev_sha256, r.created_at AS rev_created_at,
      p.error_class AS delivery_error_class, p.executor AS delivery_executor
    FROM (
      SELECT t.id, t.tenant_id, t.client_id, t.project_id, t.request_id, t.state, t.priority, t.title, t.description, t.version,
        t.current_design_revision_id, t.created_at, t.updated_at
      FROM hawa.tasks t
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT ${limit + 1} OFFSET ${offset}
    ) t
    LEFT JOIN hawa.clients c ON c.id = t.client_id
    LEFT JOIN LATERAL (
      SELECT CASE WHEN jsonb_typeof(e.data -> 'payload') = 'object' THEN e.data -> 'payload' ELSE e.data END AS p
      FROM hawa.task_events e
      WHERE e.task_id = t.id AND e.event_type = 'task.created'
      ORDER BY e.aggregate_version
      LIMIT 1
    ) ev ON true
    LEFT JOIN LATERAL (
      SELECT q.status, q.critical_pass,
        jsonb_build_object(
          'bidiIsolation', q.report -> 'bidiIsolation', 'safeMargins', q.report -> 'safeMargins',
          'rtlVisualReviewRequired', q.report -> 'rtlVisualReviewRequired',
          'contrastCompliant', q.report -> 'contrastCompliant', 'fontCoverage', q.report -> 'fontCoverage',
          'fontFamilyPass', COALESCE(q.report -> 'fontFamilyPass',
            jsonb_path_query_first(q.report, '$.checks[*] ? (@.name == "fontPass").passed')),
          'copyFidelity', q.report -> 'copyFidelity', 'errors', q.report -> 'errors'
        ) AS report
      FROM hawa.qc_runs q
      WHERE q.task_id = t.id
      ORDER BY q.started_at DESC
      LIMIT 1
    ) q ON true
    LEFT JOIN LATERAL (
      SELECT a.id, a.created_at, a.decision_payload ->> 'approverRole' AS role, a.decided_by
      FROM hawa.approvals a
      WHERE a.task_id = t.id AND a.decision = 'approved'
      ORDER BY a.created_at DESC
      LIMIT 1
    ) a ON true
    LEFT JOIN LATERAL (
      SELECT b.canva_design_id, b.edit_url
      FROM hawa.canva_bindings b
      WHERE b.tenant_id = t.tenant_id AND b.task_id = t.id AND b.status = 'bound'
      ORDER BY b.created_at DESC
      LIMIT 1
    ) b ON true
    LEFT JOIN hawa.design_revisions r ON r.id = t.current_design_revision_id
    LEFT JOIN LATERAL (
      SELECT p.error_class, p.executor FROM hawa.publications p
      WHERE p.tenant_id = t.tenant_id AND p.task_id = t.id
        AND t.state = 'publishing'
      ORDER BY p.created_at DESC LIMIT 1
    ) p ON true
    ORDER BY t.created_at DESC, t.id DESC`;
}

/** How many tasks the list's filter matches, for "51-100 of 1,234". */
export function buildTaskCountQuery(params: TaskPageParams) {
  return sql<{ total: number }>`SELECT count(*)::int AS total FROM hawa.tasks t WHERE ${sql.join(taskListFilter(params), sql` AND `)}`;
}

/** One page of the task list and the filter's total. Run it inside withRlsContext. */
export async function listTaskPage(db: Kysely<Database>, params: TaskPageParams): Promise<TaskPage> {
  const limit = clampLimit(params.limit);
  const page = await buildTaskPageQuery(params).execute(db);
  const count = await buildTaskCountQuery(params).execute(db);
  const rows = page.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  const nextCursor = page.rows.length > limit && last ? encodeTaskCursor({ createdAt: last.cursor_created_at, id: last.id }) : null;
  return { rows, total: Number(count.rows[0]?.total ?? 0), limit, nextCursor };
}

export interface TransitionStateParams {
  taskId: string;
  tenantId: string;
  expectedVersion?: number;
  fromState?: TaskState;
  toState: TaskState;
  actorType: 'user' | 'model' | 'workflow' | 'adapter' | 'system';
  actorId?: string | null;
  reason: string;
  correlationId?: string;
  causationId?: string | null;
  traceId?: string | null;
  data?: Record<string, unknown>;
  command?: {
    type: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  };
}

export interface CreateTaskParams {
  tenantId: string;
  clientId?: string | null;
  projectId?: string | null;
  sourcePlatform?: string;
  sourceEventId?: string;
  sourceChannelId?: string;
  idempotencyKey: string;
  priority?: string | number;
  title?: string;
  description?: string;
  brief?: Record<string, unknown>;
  userId?: string;
}

export class TaskRepository {
  constructor(private readonly db: Kysely<Database>) {}

  private computePayloadHash(payload: Record<string, unknown>): string {
    const sortObject = (obj: any): any => {
      if (obj === null || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(sortObject);
      const sortedKeys = Object.keys(obj).sort();
      const result: Record<string, any> = {};
      for (const k of sortedKeys) {
        if (obj[k] !== undefined) {
          result[k] = sortObject(obj[k]);
        }
      }
      return result;
    };
    const canonical = JSON.stringify(sortObject(payload));
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  async findById(id: string, tenantId?: string, trx?: Kysely<Database>) {
    let query = (trx || this.db).selectFrom('tasks').selectAll().where('id', '=', id);
    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }
    return await query.executeTakeFirst();
  }

  async findWithEvents(id: string, tenantId?: string, trx?: Kysely<Database>) {
    const task = await this.findById(id, tenantId, trx);
    if (!task) return null;

    let eventsQuery = (trx || this.db)
      .selectFrom('task_events')
      .selectAll()
      .where('task_id', '=', id);

    if (tenantId) {
      eventsQuery = eventsQuery.where('tenant_id', '=', tenantId);
    }

    const events = await eventsQuery.orderBy('aggregate_version', 'asc').execute();
    return { task, events };
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string, trx?: Kysely<Database>) {
    const cmd = await (trx || this.db)
      .selectFrom('outbox_commands')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', '=', idempotencyKey)
      .where('aggregate_type', '=', 'task')
      .executeTakeFirst();

    if (!cmd) return null;

    const task = await (trx || this.db)
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', cmd.aggregate_id)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();

    return task || null;
  }

  async createTaskAggregate(
    params: CreateTaskAggregateParams,
    trx?: Kysely<Database>
  ): Promise<{ task: any; created: boolean; payload: Record<string, unknown> }> {
    const runner = async (dbClient: Kysely<Database>) => {
      // 1. Check idempotency in outbox_commands
      const existingCmd = await dbClient
        .selectFrom('outbox_commands')
        .selectAll()
        .where('tenant_id', '=', params.tenantId)
        .where('idempotency_key', '=', params.idempotencyKey)
        .executeTakeFirst();

      const incomingPayload = params.payload || {
        title: params.title,
        clientId: params.clientId || null,
        description: params.description || '',
        priority: params.priority || 3,
      };
      const incomingHash = this.computePayloadHash(params.requestBody || incomingPayload);

      if (existingCmd) {
        const storedPayload = typeof existingCmd.payload === 'string' ? JSON.parse(existingCmd.payload) : existingCmd.payload;
        const storedHash =
          (storedPayload as any)?.requestHash ||
          this.computePayloadHash(storedPayload as Record<string, unknown>);

        const matchesRequest = params.requestBody
          ? existingCmd.command_type === 'task.created' && (storedPayload.requestIdentityHash
              ? storedPayload.requestIdentityHash === incomingHash
              : storedPayload.body && this.computePayloadHash(storedPayload.body) === incomingHash)
          : storedHash === incomingHash;
        if (!matchesRequest) {
          throw new IdempotencyConflictError(
            `Idempotency conflict: key '${params.idempotencyKey}' already used with differing payload`
          );
        }

        const existingTask = await dbClient
          .selectFrom('tasks')
          .selectAll()
          .where('id', '=', existingCmd.aggregate_id)
          .where('tenant_id', '=', params.tenantId)
          .executeTakeFirst();

        if (existingTask) {
          return { task: existingTask, created: false, payload: storedPayload as Record<string, unknown> };
        }
      }

      // Enrichment is server evidence, not part of the submitted request's idempotency identity.
      const recordedPayload = { ...(params.payload || {}), ...(await params.prepareCreatePayload?.(dbClient) || {}) };

      // 2. Insert into tasks
      const priorityNum = typeof params.priority === 'number' ? params.priority : 3;
      const task = await dbClient
        .insertInto('tasks')
        .values({
          tenant_id: params.tenantId,
          customer_account_id: params.customerAccountId ?? null,
          client_id: params.clientId || null,
          project_id: params.projectId || null,
          source_message_id: params.sourceMessageId || null,
          title: params.title,
          description: params.description || '',
          state: 'received',
          delivery_executor_pin: params.deliveryExecutorPin || 'core',
          task_type: params.taskType || null,
          language: params.language || null,
          direction: params.direction || null,
          priority: priorityNum,
          sensitivity: params.sensitivity || 'normal',
          requested_by: params.userId || null,
          assigned_to: null,
          due_at: null,
          version: 1,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // 3. Insert into task_events (aggregate_version = 1)
      const correlationId = params.correlationId || crypto.randomUUID();
      await dbClient
        .insertInto('task_events')
        .values({
          tenant_id: params.tenantId,
          task_id: task.id,
          event_type: 'task.created',
          schema_version: 1,
          aggregate_version: 1,
          actor_type: params.actorType || 'user',
          actor_id: params.actorId || params.userId,
          correlation_id: correlationId,
          causation_id: null,
          trace_id: params.traceId || currentTraceId(),
          data: {
            title: task.title,
            clientId: task.client_id,
            state: task.state,
            priority: task.priority,
            deliveryExecutorPin: task.delivery_executor_pin,
            metadata: params.metadata || {},
            payload: recordedPayload,
            ...recordedPayload,
          },
        })
        .execute();

      // 4. Insert into outbox_commands if requested
      if (params.enqueueOutbox !== false) {
        const recordedOwner = params.outboxState === 'recorded' ? 'OWNED_BY_LIFECYCLE'
          : params.outboxState === 'manual' ? 'MANUAL_DESK_OWNED' : null;
        await dbClient
          .insertInto('outbox_commands')
          .values({
            tenant_id: params.tenantId,
            aggregate_type: 'task',
            aggregate_id: task.id,
            command_type: 'task.created',
            idempotency_key: params.idempotencyKey,
            payload: withRequestId({
              ...recordedPayload,
              taskId: task.id,
              tenantId: params.tenantId,
              title: task.title,
              clientId: task.client_id,
              priority: task.priority,
              deliveryExecutorPin: task.delivery_executor_pin,
              requestHash: incomingHash,
              ...(params.requestBody ? { requestIdentityHash: incomingHash } : {}),
            }),
            state: recordedOwner ? 'delivered' : 'pending',
            ...(recordedOwner
              ? { delivered_at: new Date(), last_error: recordedOwner }
              : {}),
          })
          .execute();
      }

      return { task, created: true, payload: recordedPayload };
    };

    if (trx) {
      return await runner(trx);
    }
    return await this.db.transaction().execute(runner);
  }

  async transitionState(
    params: TransitionStateParams,
    trx?: Kysely<Database>
  ): Promise<any> {
    const runner = async (dbClient: Kysely<Database>) => {
      let expectedVersion = params.expectedVersion;
      if (expectedVersion === undefined) {
        const current = await dbClient
          .selectFrom('tasks')
          .select(['version', 'state'])
          .where('id', '=', params.taskId)
          .where('tenant_id', '=', params.tenantId)
          .executeTakeFirst();

        if (!current) {
          throw new TaskNotFoundError(`Task ${params.taskId} not found in tenant ${params.tenantId}`);
        }
        expectedVersion = Number(current.version);
      }

      const nextVersion = expectedVersion + 1;
      const isCompletion = params.toState === 'complete' || params.toState === 'cancelled';

      const updateData: any = {
        state: params.toState,
        version: nextVersion,
        updated_at: new Date(),
      };
      if (isCompletion) {
        updateData.completed_at = new Date();
      }

      let updateQuery = dbClient
        .updateTable('tasks')
        .set(updateData)
        .where('id', '=', params.taskId)
        .where('tenant_id', '=', params.tenantId)
        .where('version', '=', expectedVersion);

      if (params.fromState) {
        updateQuery = updateQuery.where('state', '=', params.fromState);
      }

      const updated = await updateQuery.returningAll().executeTakeFirst();

      if (!updated) {
        // Find current state to produce descriptive conflict error
        const current = await dbClient
          .selectFrom('tasks')
          .select(['version', 'state'])
          .where('id', '=', params.taskId)
          .where('tenant_id', '=', params.tenantId)
          .executeTakeFirst();

        if (!current) {
          throw new TaskNotFoundError(`Task ${params.taskId} not found in tenant ${params.tenantId}`);
        }
        throw new ConcurrencyConflictError(
          `Conflict on task ${params.taskId}: expected version ${expectedVersion} (state: ${params.fromState || '*'}), but current version is ${current.version} (state: ${current.state})`
        );
      }

      // Record immutable audit event
      const correlationId = params.correlationId || crypto.randomUUID();
      await dbClient
        .insertInto('task_events')
        .values({
          tenant_id: params.tenantId,
          task_id: params.taskId,
          event_type: 'task.state_changed',
          schema_version: 1,
          aggregate_version: nextVersion,
          actor_type: params.actorType,
          actor_id: params.actorId || null,
          correlation_id: correlationId,
          causation_id: params.causationId || null,
          trace_id: params.traceId || currentTraceId(),
          data: {
            fromState: params.fromState,
            toState: params.toState,
            reason: params.reason,
            ...(params.data || {}),
          },
        })
        .execute();

      // Enqueue optional outbox command
      if (params.command) {
        await dbClient
          .insertInto('outbox_commands')
          .values({
            tenant_id: params.tenantId,
            aggregate_type: 'task',
            aggregate_id: params.taskId,
            command_type: params.command.type,
            idempotency_key: params.command.idempotencyKey,
            payload: withRequestId(params.command.payload),
            state: 'pending',
          })
          .execute();
      }

      return updated;
    };

    if (trx) {
      return await runner(trx);
    }
    return await this.db.transaction().execute(runner);
  }

  async getEvents(taskId: string, tenantId?: string, trx?: Kysely<Database>) {
    let query = (trx || this.db)
      .selectFrom('task_events')
      .selectAll()
      .where('task_id', '=', taskId);

    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }

    return await query.orderBy('aggregate_version', 'asc').execute();
  }

  // --- Backward-compatibility methods for unit tests and legacy callers ---

  async create(params: CreateTaskParams) {
    const priority =
      typeof params.priority === 'number'
        ? params.priority
        : params.priority === 'urgent'
        ? 5
        : params.priority === 'rush'
        ? 4
        : 3;

    const result = await this.createTaskAggregate({
      tenantId: params.tenantId,
      userId: params.userId || CHANNEL_INGRESS_USER_ID,
      idempotencyKey: params.idempotencyKey,
      title: params.title || 'Untitled Task',
      description: params.description || '',
      clientId: params.clientId || null,
      projectId: params.projectId || null,
      priority,
      actorType: 'system',
      actorId: 'system',
      payload: {
        brief: params.brief,
        sourcePlatform: params.sourcePlatform,
        sourceEventId: params.sourceEventId,
        sourceChannelId: params.sourceChannelId,
      },
      enqueueOutbox: false,
    });

    const taskWithStatus = {
      ...result.task,
      status: toApiTaskStatus(result.task.state),
      client_scope_locked: Boolean(result.task.client_id),
    };

    return { task: taskWithStatus, created: result.created };
  }

  async lockClientScope(
    taskId: string,
    clientId: string,
    projectId?: string,
    tenantId?: string,
    trx?: Kysely<Database>
  ) {
    const task = await this.findById(taskId, tenantId, trx);
    if (!task) throw new TaskNotFoundError(`Task ${taskId} not found`);

    // Invariant: Keep client scope immutable once set / retrieval begins
    if (task.client_id && task.client_id !== clientId) {
      throw new Error(
        `Client scope is immutable: Task ${taskId} is already locked to client ${task.client_id}, cannot re-lock to client ${clientId}`
      );
    }

    if (task.client_id === clientId && (!projectId || task.project_id === projectId)) {
      return {
        ...task,
        client_scope_locked: true,
        status: toApiTaskStatus(task.state),
      };
    }

    const client = trx || this.db;
    let query = client
      .updateTable('tasks')
      .set({
        client_id: clientId,
        project_id: projectId || null,
        updated_at: new Date(),
      })
      .where('id', '=', taskId);

    if (tenantId || task.tenant_id) {
      query = query.where('tenant_id', '=', tenantId || task.tenant_id);
    }

    const updated = await query.returningAll().executeTakeFirstOrThrow();

    return {
      ...updated,
      client_scope_locked: true,
      status: toApiTaskStatus(updated.state),
    };
  }

  async updateStatus(
    taskId: string,
    fromStatus: string,
    toStatus: string,
    actorId: string,
    actorType: string,
    reason: string,
    payload?: Record<string, unknown>,
    /**
     * Where to run. `tasks` has FORCE ROW LEVEL SECURITY and the runtime role does not bypass it, so a
     * read outside a tenant context finds no row: without a scope this threw "not found" for every
     * task in production, and its one caller swallowed that. Pass the caller's transaction (already
     * in a tenant context) or the tenant identity to open one.
     */
    scope?: { trx?: Kysely<Database> } | (RlsContext & { trx?: undefined })
  ) {
    const run = async (client?: Kysely<Database>) => {
      const task = await this.findById(taskId, scope && 'tenantId' in scope ? scope.tenantId : undefined, client);
      if (!task) throw new TaskNotFoundError(`Task ${taskId} not found`);

      const validActorTypes = ['user', 'model', 'workflow', 'adapter', 'system'] as const;
      const resolvedActorType = validActorTypes.includes(actorType as any)
        ? (actorType as any)
        : 'system';

      const normalizedToState = toDbTaskState(toStatus);
      const normalizedFromState = fromStatus ? toDbTaskState(fromStatus) : undefined;

      const updated = await this.transitionState({
        taskId,
        tenantId: task.tenant_id,
        expectedVersion: Number(task.version),
        fromState: normalizedFromState,
        toState: normalizedToState,
        actorType: resolvedActorType,
        actorId,
        reason,
        data: payload,
      }, client);

      return {
        ...updated,
        status: toApiTaskStatus(updated.state),
      };
    };
    if (scope?.trx) return run(scope.trx);
    if (scope && 'tenantId' in scope && scope.tenantId) {
      const { tenantId, userId, role, clientId } = scope;
      return withRlsContext(this.db, { tenantId, userId, role, clientId }, (trx) => run(trx));
    }
    return run();
  }
}
