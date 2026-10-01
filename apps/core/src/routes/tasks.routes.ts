import { DocumentIntakeError, prepareDocumentIntake } from '../services/client-documents.js';
import { chaosPoint } from '@hawa/observability';
import { ManualIntakeScopeError, prepareManualIntake } from '../services/manual-intake-scope.js';
import type { Context } from 'hono';
import type { RouteContext } from './types.js';
import { log } from '../logging.js';
import crypto from 'node:crypto';
import { type UUID, isTaskApiStatus, isTaskDbState, isSha256Hex, parseBlobRef, publicationAwareTaskStatus } from '@hawa/contracts';
import { withRlsContext, IdempotencyConflictError, toDbTaskState, toApiTaskStatus, listTaskPage, decodeTaskCursor, dbStatesForApiStatuses, TASK_PAGE_DEFAULT_LIMIT, TASK_PAGE_MAX_LIMIT, sql, type Database, type TaskState } from '@hawa/db';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { blobStoreFor } from '../services/blob-store-context.js';
import { blobResponse, IMMUTABLE_CACHE_CONTROL } from '../services/blob-response.js';
import { canvaFontEvidence } from '../services/canva-font-evidence.js';
import { orderedAlbumImages } from '../services/lifecycle-album.js';
import { isCopyIntroducer } from '../services/chat-campaign-intake.js';

/**
 * The title shown where a task has no English headline (a lifecycle draft carries none), unless the
 * title quotes the line that introduced the copy, with a client prefix or without: before 2026-09-29 a
 * chat request could be titled "KAAE: Here is the text and the photos:…" or "Here is the text and the
 * photos:…", and that line is an instruction, never a headline. Then nothing is shown.
 */
export function titleAsHeadline(title: string): string | undefined {
  const whole = String(title || '').replace(/…$/u, '').trim();
  const quoted = whole.replace(/^[^:\n]{1,80}:\s*/u, '').trim();
  return [whole, quoted].some((line) => line && isCopyIntroducer(line)) ? undefined : title;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a Canva export is served as, by its stored format. */
const EXPORT_MEDIA: Record<string, { type: string; disposition: string }> = {
  png: { type: 'image/png', disposition: 'inline; filename="design.png"' },
  pdf_standard: { type: 'application/pdf', disposition: 'inline; filename="design.pdf"' },
  pptx: { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', disposition: 'attachment; filename="design.pptx"' },
};

/** A task's export's address: immutable, since the database refuses any change to an export's bytes. */
export function taskExportContentUrl(taskId: string, exportId: string): string {
  return `/v1/tasks/${taskId}/exports/${exportId}/content`;
}

/** A task's reference photo's address: the authorised file route below, keyed by the file's hash. */
export function taskFileContentUrl(taskId: string, sha256: string): string {
  return `/v1/tasks/${taskId}/files/${sha256}`;
}

/**
 * The Desk's task list, task creation, one task and its timeline (architecture programme 1.3, G7).
 * Moved from createApp unchanged.
 */
export function registerTasksRoutes(ctx: RouteContext): void {
  const {
    db,
    events,
    isProduction,
    problem,
    registerRoute,
    resolveClientDna,
    resolveTaskWithFallback,
    taskRepo,
    tasks,
    verifyRequestAuth,
    broadcastEvent: broadcast,
  } = ctx;
  const defaultTenantId = DEFAULT_TENANT_ID;
  // Reference photos are stored files (ADR-035), served after authorising on the task's file row.
  const blobStore = blobStoreFor(db, ctx.options?.blobStore);

  // List Tasks (H01, FR-076, FR-078). One page per request (architecture programme 0.3): keyset on
  // (created_at, id) with an opaque cursor, and the filter's total. The Desk read every page of this
  // every 30 s and after every task event, each row running six correlated subqueries (two on
  // columns with no index) and carrying the intake event's JSON, reference photo included.
  // `offset` still works for callers that send it; `cursor` wins when both are sent.
  registerRoute('get', '/tasks', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to list tasks');
    }
    const status = c.req.query('status');
    const statusList = c.req.query('statuses');
    const clientId = c.req.query('clientId');
    const search = String(c.req.query('q') || '').trim().slice(0, 200);
    const cursorParam = c.req.query('cursor');
    const tenantId = auth.tenantId || '00000000-0000-4000-a000-000000000001';

    const limit = Math.min(Math.max(1, Math.floor(Number(c.req.query('limit'))) || TASK_PAGE_DEFAULT_LIMIT), TASK_PAGE_MAX_LIMIT);
    const offset = Math.max(0, Math.floor(Number(c.req.query('offset'))) || 0);
    const cursor = cursorParam ? decodeTaskCursor(cursorParam) : null;
    if (cursorParam && !cursor) {
      return problem(c, 400, 'Bad Request', 'cursor is not one this API issued; start again without it');
    }
    // A malformed id reached Postgres as a cast error and came back as a 500.
    if (clientId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
      return problem(c, 400, 'Bad Request', 'clientId must be a UUID');
    }
    // `statuses` (comma-separated API statuses, as the Desk's filters send them) matches exactly the
    // tasks the list labels with one of them. `status` keeps its old mapping for existing callers.
    let states: TaskState[] | undefined;
    const requestedStatuses = statusList !== undefined ? String(statusList).split(',') : status ? [status] : [];
    const publishingStatuses = statusList !== undefined || (status && isTaskApiStatus(status))
      ? ([
          ...(requestedStatuses.includes('PUBLISHING') ? ['ordinary' as const] : []),
          ...(requestedStatuses.includes('ARCHIVE_RECONCILIATION') ? ['archive' as const] : []),
          ...(requestedStatuses.includes('PUBLISH_RECONCILIATION') ? ['sheet' as const] : []),
          ...(requestedStatuses.includes('REQUESTER_SEND_RECONCILIATION') ? ['requester_send' as const] : []),
        ]) : undefined;
    if (statusList !== undefined) states = dbStatesForApiStatuses(requestedStatuses);
    else if (status) {
      // One word of the vocabulary; an unknown one used to list the new requests ('received').
      if (!isTaskApiStatus(status) && !isTaskDbState(status)) {
        return problem(c, 400, 'Bad Request', `status "${status}" is not a task status`);
      }
      states = [toDbTaskState(status)];
    }

    if (db) {
      try {
        const page = await withRlsContext(
          db,
          { tenantId, userId: auth.userId, role: auth.role },
          (trx) => listTaskPage(trx, { tenantId, limit, cursor, offset, clientId: clientId || null,
            states, publishingStatuses, search })
        );

        const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
        const items = page.rows.map((t) => {
          // A check the QC did not measure (null: the Canva export check measures neither margins nor
          // contrast) is reported as not measured; `?? true` showed it to the office as a green tick
          // (review of 2026-09-24).
          const report = (t.qc_report || {}) as Record<string, any>;
          const qaReport = t.qc_status ? {
            passed: t.qc_status === 'passed' && t.qc_critical_pass === true,
            bidiIsolation: report.bidiIsolation ?? null,
            rtlVisualReviewRequired: report.rtlVisualReviewRequired === true,
            safeMargins: report.safeMargins ?? null,
            contrastCompliant: report.contrastCompliant ?? null,
            ...canvaFontEvidence(report),
            copyFidelity: report.copyFidelity ?? null,
            errors: report.errors || [],
          } : undefined;

          // An approval holds while the task is approved or being delivered; a task sent back for changes
          // since showed as APPROVED with Deliver enabled (review of 2026-09-24).
          const approvalHolds = ['approved', 'publishing', 'complete'].includes(String(t.state));
          const latestApproval = t.approval_id && approvalHolds ? {
            decisionId: t.approval_id,
            role: t.approval_role || 'art_director',
            actorId: t.approval_actor_id,
            decidedAt: iso(t.approval_created_at),
          } : undefined;

          const canvaBinding = t.canva_design_id ? {
            designId: t.canva_design_id,
            designUrl: t.canva_edit_url,
            title: t.title,
          } : undefined;

          // The list carries no preview: GET /tasks/:id does.
          const latestRevision = t.rev_id ? {
            id: t.rev_id,
            version: Number(t.rev_version || 1),
            sha256: t.rev_sha256,
            format: 'png',
            createdAt: iso(t.rev_created_at),
          } : undefined;

          return {
            id: t.id,
            tenantId: t.tenant_id,
            clientId: t.client_id,
            projectId: t.project_id,
            requestId: t.request_id || null,
            status: publicationAwareTaskStatus(t.state, { errorClass: t.delivery_error_class }),
            state: t.state,
            priority: t.priority,
            title: t.title,
            description: t.description,
            clientName: t.client_name || null,
            headlineEn: t.headline_en || titleAsHeadline(t.title),
            headlineCkb: t.headline_ckb || null,
            copyEn: t.copy_en || t.description,
            copyCkb: t.copy_ckb || null,
            designInstructions: t.design_instructions || '',
            referenceAssets: t.reference_assets || '',
            sourcePlatform: t.source_platform || 'hawa_desk',
            sourceEventId: t.source_event_id || t.id,
            sourceChannelId: t.source_channel_id || 'hawa_desk',
            clientScopeLocked: Boolean(t.client_id),
            version: Number(t.version),
            latestRevisionId: t.current_design_revision_id || undefined,
            latestRevision,
            qaReport,
            latestApproval,
            canvaBinding,
            createdAt: iso(t.created_at),
            updatedAt: iso(t.updated_at),
          };
        });
        return c.json({ items, total: page.total, limit: page.limit, ...(cursor ? {} : { offset }), nextCursor: page.nextCursor });
      } catch (err: any) {
        log.error('[core:tasks:list] DB list query error:', err);
        return problem(c, 500, 'Database Error', `Failed to query tasks from database: ${err.message}`);
      }
    }

    if (isProduction) {
      return problem(c, 503, 'Database Unavailable', 'Production task query strictly requires connected PostgreSQL database storage');
    }

    // Development without a database: the in-memory tasks, paged by offset only.
    let list = Array.from(tasks.values());
    if (status) list = list.filter((t) => t.status === status);
    if (statusList !== undefined) {
      const wanted = new Set(String(statusList).split(',').map((s) => s.trim().toUpperCase()));
      list = list.filter((t) => wanted.has(String(t.status).toUpperCase()));
    }
    if (clientId) list = list.filter((t) => t.clientId === clientId);
    const total = list.length;
    const paginated = list.slice(offset, offset + limit);
    return c.json({ items: paginated, total, limit, offset, nextCursor: null });
  });

  // Create Task
  registerRoute('post', '/tasks', async (c: any) => {
    const auth = verifyRequestAuth(c);
    const body = await c.req.json().catch(() => ({}));

    if (!auth.authenticated) {
      return problem(
        c,
        401,
        'Unauthorized',
        'Authentication required: anonymous or unauthorized task creation is denied'
      );
    }

    if (isProduction && !db && !process.env.HAWA_BEARER_TOKEN?.includes('disposable')) {
      return problem(
        c,
        503,
        'Database Unavailable',
        'Production task intake strictly requires connected PostgreSQL database storage'
      );
    }

    const manualIntake = body.workflow === 'canva_manual';
    const documentIntake = body.sourceDocument !== undefined;
    if (documentIntake && (!db || !taskRepo)) return problem(c, 503, 'Durable Storage Unavailable', 'PDF requests require PostgreSQL and retained source evidence.');
    if (documentIntake && (!manualIntake || !auth.userId || auth.role === 'service' || auth.role === 'adapter' ||
        !c.req.header('Idempotency-Key') || c.req.header('Idempotency-Key')!.length > 256 ||
        typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200 ||
        typeof body.copyEn !== 'string' || body.copyEn.length > 20000 ||
        typeof body.copyCkb !== 'string' || body.copyCkb.length > 20000 ||
        !(body.copyEn.trim() || body.copyCkb.trim()) ||
        typeof body.designInstructions !== 'string' || body.designInstructions.length > 4000)) {
      return problem(c, 422, 'Document Request Invalid', 'Use the reviewed PDF request form with exact copy and a stable request key.');
    }
    if (manualIntake && (!body.clientId || typeof body.clientId !== 'string')) {
      return problem(c, 422, 'Client Selection Required', 'Choose a registered client before saving this request');
    }
    if (manualIntake && body.projectId && !UUID_PATTERN.test(body.projectId)) {
      return problem(c, 422, 'Invalid Project Identifier', 'Choose a registered project in the selected client');
    }
    if (taskRepo && db && body.clientId) {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(body.clientId)) {
        return problem(
          c,
          400,
          'Invalid Client Identifier',
          `Client ID '${body.clientId}' must be a valid UUID for durable storage`
        );
      }
    }

    const idempotencyKey =
      c.req.header('Idempotency-Key') ||
      c.req.header('idempotency-key') ||
      body.idempotencyKey ||
      `key_${Date.now()}_${crypto.randomUUID()}`;

    const tenantId = auth.tenantId || '00000000-0000-4000-a000-000000000001';
    const userId = auth.userId || '00000000-0000-4000-b000-000000000001';

    // If database persistence is configured, execute atomic aggregate intake:
    if (taskRepo && db) {
      try {
        const priorityNum =
          typeof body.priority === 'number'
            ? body.priority
            : body.priority === 'urgent'
            ? 5
            : body.priority === 'rush'
            ? 4
            : 3;

        let clientDnaVersion = manualIntake ? undefined : body.clientDnaVersion;
        const aggregateResult = await withRlsContext(
          db,
          { tenantId, userId, role: auth.role || 'operator' },
          async (trx) => {
            if (documentIntake) await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`document-request:${tenantId}:${idempotencyKey}`},0))`.execute(trx);
            if (!manualIntake) clientDnaVersion ||= (await resolveClientDna(body.clientId, undefined, trx))?.version || 1;
            return await taskRepo.createTaskAggregate(
              {
                tenantId,
                userId,
                idempotencyKey,
                title: body.title || 'Untitled Task',
                description: body.description || '',
                clientId: body.clientId || null,
                projectId: body.projectId || null,
                priority: priorityNum,
                actorType: (auth.role === 'adapter' ? 'adapter' : 'user') as any,
                actorId: auth.actorId,
                payload: {
                  body,
                  headlineEn: body.headlineEn,
                  headlineCkb: body.headlineCkb,
                  copyEn: body.copyEn,
                  copyCkb: body.copyCkb,
                  clientDnaVersion,
                },
                enqueueOutbox: true,
                ...(manualIntake ? { requestBody: body, prepareCreatePayload: async (lockedTrx: Parameters<typeof prepareManualIntake>[0]) => ({
                  ...await prepareManualIntake(lockedTrx, { tenantId, clientId: body.clientId, projectId: body.projectId }),
                  ...(documentIntake ? await prepareDocumentIntake(lockedTrx, blobStore, { tenantId,
                    clientId: body.clientId, userId, source: body.sourceDocument }) : {}),
                }) } : {}),
              },
              trx
            );
          }
        );

        if (documentIntake && aggregateResult.created)
          await chaosPoint('core.documents.after-task-commit', { clientId: body.clientId, taskId: aggregateResult.task.id });
        if (manualIntake) clientDnaVersion = aggregateResult.payload.clientDnaVersion;
        const dbTask = aggregateResult.task;
        const normalizedTask = {
          id: dbTask.id,
          tenantId: dbTask.tenant_id,
          clientId: dbTask.client_id,
          projectId: dbTask.project_id,
          status: (dbTask.state || 'received').toUpperCase(),
          state: dbTask.state,
          priority: dbTask.priority,
          title: dbTask.title,
          description: dbTask.description,
          headlineEn: body.headlineEn || dbTask.title,
          headlineCkb: body.headlineCkb || null,
          copyEn: body.copyEn || dbTask.description,
          copyCkb: body.copyCkb || null,
          sourcePlatform: 'hawa_desk',
          sourceEventId: dbTask.id,
          sourceChannelId: 'hawa_desk',
          idempotencyKey,
          clientScopeLocked: false,
          clientDnaVersion,
          version: Number(dbTask.version),
          createdAt: dbTask.created_at instanceof Date ? dbTask.created_at.toISOString() : (dbTask.created_at || new Date().toISOString()),
          updatedAt: dbTask.updated_at instanceof Date ? dbTask.updated_at.toISOString() : (dbTask.updated_at || new Date().toISOString()),
        };

        if (aggregateResult.created) {
          broadcast('task:created', normalizedTask);
          return c.json(normalizedTask, 201);
        } else {
          return c.json(normalizedTask, 200);
        }
      } catch (err: any) {
        if (err instanceof DocumentIntakeError) return problem(c, err.status, 'Document Request Refused', err.message);
        if (err instanceof ManualIntakeScopeError) return problem(c, 403, 'Client Scope Unavailable', err.message);
        if (err instanceof IdempotencyConflictError) {
          return problem(
            c,
            409,
            'Idempotency Conflict',
            'Idempotency conflict: key already used with differing payload'
          );
        }
        log.error('[core:tasks:create] DB Aggregate Intake Failure:', err);
        return problem(
          c,
          503,
          'Durable Storage Unavailable',
          `Failed to commit task aggregate to durable storage: ${err.message}`
        );
      }
    }

    // Without a database the task lives in the no-database store (services/no-database-store.ts).
    for (const t of tasks.values()) {
      if (t.idempotencyKey === idempotencyKey) {
        if (t.title !== (body.title || 'Untitled Task')) {
          return problem(
            c,
            409,
            'Idempotency Conflict',
            'Idempotency conflict: key already used with differing payload'
          );
        }
        return c.json(t, 200);
      }
    }

    const taskId = crypto.randomUUID();
    const task = {
      id: taskId,
      tenantId: auth.tenantId || defaultTenantId,
      clientId: body.clientId || null,
      projectId: body.projectId || null,
      status: 'RECEIVED',
      priority: body.priority || 'routine',
      title: body.title || 'Untitled Task',
      description: body.description || '',
      headlineEn: body.headlineEn || body.title || 'Untitled Task',
      headlineCkb: body.headlineCkb || null,
      copyEn: body.copyEn || body.description || '',
      copyCkb: body.copyCkb || null,
      sourcePlatform: 'hawa_desk',
      sourceEventId: taskId,
      sourceChannelId: 'hawa_desk',
      idempotencyKey,
      clientScopeLocked: false,
      version: 1,
      repairCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    tasks.set(taskId, task);
    events.set(taskId, [
      {
        eventId: crypto.randomUUID(),
        taskId,
        fromStatus: null,
        toStatus: 'RECEIVED',
        actor: { type: 'user', id: auth.actorId || 'desk_user' },
        reason: 'Task created via Hawa Desk',
        occurredAt: new Date().toISOString(),
      },
    ]);

    broadcast('task:created', task);

    return c.json(task, 201);
  });

  // Get Task
  registerRoute('get', '/tasks/:taskId', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to access task');
    }
    const taskId = c.req.param('taskId');
    const tenantId = auth.tenantId || '00000000-0000-4000-a000-000000000001';

    // With a database the task, its copy, preview, QC, approval, Canva design and delivery are all
    // read from Postgres. This process's copy of the task used to fill whatever Postgres lacked, so
    // the Core that created a task showed it differently from every other Core.
    if (taskRepo && db) {
      try {
        const queryRes = await withRlsContext(
          db,
          { tenantId, userId: auth.userId, role: auth.role },
          async (trx) => {
            const withEv = await taskRepo.findWithEvents(taskId, tenantId, trx);
            if (!withEv?.task) return null;
            const dbTask = withEv.task;
            const createdEv = withEv.events.find((e: any) => e.event_type === 'task.created');

            let revRow: any = null;
            if (dbTask.current_design_revision_id) {
              revRow = await trx.selectFrom('design_revisions')
                .selectAll()
                .where('id', '=', dbTask.current_design_revision_id)
                .where('tenant_id', '=', tenantId)
                .executeTakeFirst();
            }

            // The preview is the newest PNG export. The newest export of any format is the deck the
            // worker exports after the PNG, which Desk drew as a broken "PNG" with the deck's hash.
            // Its bytes are not read here: the Desk fetches them from the export's own address
            // (ADR-035), where they were a base64 data URI inside this JSON.
            const exportRow = (await sql<any>`
              SELECT id, sha256, format, octet_length(content) as byte_size
              FROM hawa.canva_export_bytes
              WHERE task_id = ${taskId}::uuid AND tenant_id = ${tenantId}::uuid AND format = 'png'
              ORDER BY created_at DESC LIMIT 1`.execute(trx)).rows[0];

            const qcRow = await trx.selectFrom('qc_runs')
              .selectAll()
              .where('task_id', '=', taskId)
              .where('tenant_id', '=', tenantId)
              .orderBy('started_at', 'desc')
              .limit(1)
              .executeTakeFirst();

            const approvalRow = await trx.selectFrom('approvals')
              .selectAll()
              .where('task_id', '=', taskId)
              .where('tenant_id', '=', tenantId)
              .where('decision', '=', 'approved')
              .orderBy('created_at', 'desc')
              .limit(1)
              .executeTakeFirst();

            const canvaBindingRow = (await sql<any>`
              SELECT * FROM hawa.canva_bindings
              WHERE tenant_id = ${tenantId}::uuid AND task_id = ${taskId}::uuid AND status = 'bound'
              ORDER BY created_at DESC LIMIT 1`.execute(trx)).rows[0];

            const pubEvent = (await sql<any>`
              SELECT data, occurred_at as created_at FROM hawa.task_events
              WHERE tenant_id = ${tenantId}::uuid AND task_id = ${taskId}::uuid AND event_type = 'task.published'
              ORDER BY aggregate_version DESC LIMIT 1`.execute(trx)).rows[0];

            const publication = dbTask.state === 'publishing'
              ? await trx.selectFrom('publications').select(['executor', 'error_class'])
                .where('tenant_id', '=', tenantId).where('task_id', '=', taskId)
                .orderBy('created_at', 'desc').executeTakeFirst()
              : null;

            // The client's name, read under the caller's row-level security as the task list reads it.
            const clientRow = dbTask.client_id
              ? (await sql<{ name: string }>`SELECT name FROM hawa.clients WHERE id = ${dbTask.client_id}::uuid`.execute(trx)).rows[0]
              : undefined;

            // The task's reference photos (a Telegram album's, a lifecycle photo, a late reference):
            // hawa.task_files rows, not the free-text `referenceAssets` intake field (2026-09-29).
            const referenceRows = (await sql<{ sha256: string; media_type: string; size: string }>`
              SELECT f.sha256, b.media_type, b.size FROM hawa.task_files f JOIN hawa.blobs b ON b.sha256 = f.sha256
              WHERE f.tenant_id = ${tenantId}::uuid AND f.task_id = ${taskId}::uuid AND f.role = 'reference_image'
              ORDER BY f.created_at, f.sha256`.execute(trx)).rows;

            const holdCheckpoint = dbTask.state === 'paused' && dbTask.request_id
              ? withEv.events.filter(event=>event.event_type==='task.state_changed').at(-1) : undefined;
            return { dbTask, createdEv, revRow, exportRow, qcRow, approvalRow, canvaBindingRow, pubEvent, publication, clientRow, referenceRows, holdCheckpoint };
          }
        );

        if (queryRes && queryRes.dbTask) {
          const { dbTask, createdEv, revRow, exportRow, qcRow, approvalRow, canvaBindingRow, pubEvent, publication, clientRow, referenceRows } = queryRes;
          const payload = createdEv?.data?.payload || createdEv?.data?.body || (createdEv?.data as any) || {};

          // In the order the Studio and planner use them: the confirmed album's message order when the
          // request carries an album, stored order otherwise. An album that no longer matches its
          // files is refused by the Studio; shown here in stored order rather than hidden.
          let orderedReferences = referenceRows;
          try {
            orderedReferences = orderedAlbumImages(payload.lifecycleAlbum, referenceRows);
          } catch (err) {
            log.warn('[core:tasks:get] reference photos differ from the confirmed album; shown in stored order', { taskId, err: String(err) });
          }
          const referenceImages = orderedReferences.map((row) => ({
            sha256: row.sha256,
            mediaType: row.media_type,
            size: Number(row.size),
            url: taskFileContentUrl(taskId, row.sha256),
          }));

          const headlineEn = payload.headlineEn || payload.body?.headlineEn || dbTask.title;
          const headlineCkb = payload.headlineCkb || payload.body?.headlineCkb || null;
          const copyEn = payload.sourceDocument || payload.reviewedSource ? (payload.copyEn ?? '') : (payload.copyEn || payload.body?.copyEn || dbTask.description);
          const copyCkb = payload.sourceDocument || payload.reviewedSource ? (payload.copyCkb ?? '') : (payload.copyCkb || payload.body?.copyCkb || null);

          const latestRevisionId = dbTask.current_design_revision_id || undefined;

          let latestRevision;
          if (revRow || exportRow) {
            const versionNum = revRow ? Number(revRow.revision || 1) : 1;
            const sha256 = exportRow?.sha256 || revRow?.source_sha256;
            const previewUrl = exportRow?.id ? taskExportContentUrl(taskId, String(exportRow.id)) : undefined;
            const byteSize = exportRow?.byte_size ? Number(exportRow.byte_size) : undefined;
            // The planner records width and height; 1080 x 1350 was shown for any design whose manifest
            // had no "dimensions" (review of 2026-09-24). Unknown stays unknown.
            const manifest = revRow?.neutral_manifest;
            const dimensions = manifest?.dimensions
              || (Number(manifest?.width) > 0 && Number(manifest?.height) > 0 ? { width: Number(manifest.width), height: Number(manifest.height) } : undefined);
            const format = exportRow?.format || 'png';
            const createdAt = revRow?.created_at instanceof Date ? revRow.created_at.toISOString() : (revRow?.created_at ? String(revRow.created_at) : undefined);
            latestRevision = {
              id: revRow?.id || latestRevisionId || crypto.randomUUID(),
              version: versionNum,
              previewUrl,
              sha256,
              byteSize,
              dimensions,
              format,
              createdAt,
            };
          }

          let qaReport;
          if (qcRow) {
            const report = qcRow.report as any;
            qaReport = {
              passed: qcRow.status === 'passed' && qcRow.critical_pass === true,
              // Not measured is null, not a pass (see the task list).
              bidiIsolation: report?.bidiIsolation ?? null,
              rtlVisualReviewRequired: report?.rtlVisualReviewRequired === true,
              safeMargins: report?.safeMargins ?? null,
              contrastCompliant: report?.contrastCompliant ?? null,
              ...canvaFontEvidence(report),
              copyFidelity: report?.copyFidelity ?? null,
              exportArtifactId: typeof report?.exportArtifactId === 'string' ? report.exportArtifactId : null,
              exportSha256: typeof report?.exportSha256 === 'string' ? report.exportSha256 : null,
              captureVersion: typeof report?.captureVersion === 'string' ? report.captureVersion : null,
              errors: report?.errors || [],
            };
          }

          let latestApproval;
          if (['approved', 'publishing', 'complete'].includes(String(dbTask.state)) && approvalRow) {
            latestApproval = {
              decisionId: approvalRow.id,
              role: approvalRow.decision_payload?.approverRole || 'art_director',
              actorId: approvalRow.decided_by,
              decidedAt: approvalRow.created_at instanceof Date ? approvalRow.created_at.toISOString() : String(approvalRow.created_at),
            };
          }

          let canvaBinding;
          if (canvaBindingRow) {
            canvaBinding = {
              designId: canvaBindingRow.canva_design_id,
              designUrl: canvaBindingRow.edit_url,
              title: dbTask.title,
              lastSyncedAt: canvaBindingRow.updated_at instanceof Date ? canvaBindingRow.updated_at.toISOString() : String(canvaBindingRow.updated_at),
            };
          }

          let deliveryReceipt;
          if (pubEvent) {
            deliveryReceipt = {
              driveFolderUrl: pubEvent.data?.driveFolderUrl || pubEvent.data?.folderUrl,
              sheetRowUrl: pubEvent.data?.sheetRowUrl || pubEvent.data?.sheetUrl,
              deliveredAt: pubEvent.created_at instanceof Date ? pubEvent.created_at.toISOString() : String(pubEvent.created_at),
            };
          }

          const {holdCheckpoint} = queryRes;
          const requesterHold = holdCheckpoint?.data?.requesterHoldRequestId === dbTask.request_id
            ? {reason:String(holdCheckpoint?.data.reason ?? 'The requester asked to wait.')} : null;
          const normalizedTask = {
            id: dbTask.id,
            tenantId: dbTask.tenant_id,
            clientId: dbTask.client_id,
            clientName: clientRow?.name || null,
            requestId: dbTask.request_id || null,
            requesterHold,
            projectId: dbTask.project_id,
            status: publicationAwareTaskStatus(dbTask.state, { errorClass: publication?.error_class }),
            state: dbTask.state,
            priority: dbTask.priority,
            title: dbTask.title,
            description: dbTask.description,
            headlineEn,
            headlineCkb,
            copyEn,
            copyCkb,
            sourcePlatform: payload.sourcePlatform || payload.body?.source?.platform || 'hawa_desk',
            sourceEventId: payload.sourceEventId || dbTask.id,
            sourceChannelId: payload.sourceChannelId || 'hawa_desk',
            designInstructions: payload.designInstructions || payload.body?.designInstructions || '',
            referenceAssets: payload.referenceAssets || payload.body?.referenceAssets || '',
            referenceImages,
            referenceImageCount: referenceImages.length,
            sourceDocument: payload.sourceDocument || (payload.reviewedSource?.kind === 'pdf' ? {
              id: payload.reviewedSource.documentId, clientId: payload.reviewedSource.clientId,
              sourceSha256: payload.reviewedSource.sourceSha256,
            } : null),
            reviewedSource: payload.reviewedSource || null,
            clientScopeLocked: Boolean(dbTask.client_id),
            clientDnaVersion:
              payload.clientDnaVersion ||
              payload.body?.clientDnaVersion ||
              (dbTask.client_id ? (await resolveClientDna(dbTask.client_id))?.version : undefined) ||
              1,
            version: Number(dbTask.version),
            latestRevisionId,
            latestRevision,
            qaReport,
            latestApproval,
            canvaBinding,
            deliveryReceipt,
            createdAt: dbTask.created_at instanceof Date ? dbTask.created_at.toISOString() : (dbTask.created_at || new Date().toISOString()),
            updatedAt: dbTask.updated_at instanceof Date ? dbTask.updated_at.toISOString() : (dbTask.updated_at || new Date().toISOString()),
          };
          return c.json(normalizedTask);
        }
        return problem(c, 404, 'Task Not Found', `No task found with id ${taskId}`);
      } catch (err) {
        // Answered from this process's copy, a failed read showed a task Postgres may since have changed.
        log.error('[core:tasks:get] DB fetch error:', err);
        return problem(c, 503, 'Database Unavailable', 'The task could not be read; try again');
      }
    }

    const task = await resolveTaskWithFallback(taskId);
    if (!task) return problem(c, 404, 'Task Not Found', `No task found with id ${taskId}`);
    return c.json(task);
  });

  // A task's Canva export, by id (ADR-035 section 3). The bytes stay in canva_export_bytes, which the
  // database keeps append-only and hash-checked, so the address is immutable. Authorised on the export
  // row under row-level security: another tenant's task, or an export of another task, is 404.
  registerRoute('get', '/tasks/:taskId/exports/:exportId/content', async (c: Context) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId) return problem(c, 401, 'Unauthorized', 'Authentication required');
    const taskId = c.req.param('taskId');
    const exportId = c.req.param('exportId');
    if (!UUID_PATTERN.test(taskId || '') || !UUID_PATTERN.test(exportId || '')) return problem(c, 404, 'Not Found');
    if (!db) return problem(c, 503, 'Database Unavailable', 'Exports are kept in PostgreSQL');
    const row = await withRlsContext(db, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, async (trx) =>
      (await sql<{ sha256: string; format: string; content: Buffer }>`
        SELECT sha256, format, content FROM hawa.canva_export_bytes
        WHERE id = ${exportId}::uuid AND task_id = ${taskId}::uuid AND tenant_id = ${auth.tenantId}::uuid`.execute(trx)).rows[0]
    );
    const media = row ? EXPORT_MEDIA[row.format] : undefined;
    if (!row || !media) return problem(c, 404, 'Not Found', 'No such export for this task');
    const etag = `"sha256-${row.sha256}"`;
    const headers: Record<string, string> = {
      'Content-Type': media.type,
      'Content-Disposition': media.disposition,
      'Cache-Control': IMMUTABLE_CACHE_CONTROL,
      'X-Content-Type-Options': 'nosniff',
      'X-Content-SHA256': row.sha256,
      ETag: etag,
    };
    if ((c.req.header('If-None-Match') || '').split(',').some((t: string) => t.trim().replace(/^W\//, '') === etag)) {
      const { 'Content-Type': _type, ...rest } = headers;
      return new Response(null, { status: 304, headers: rest });
    }
    const bytes = Buffer.from(row.content);
    return new Response(new Uint8Array(bytes), { status: 200, headers: { ...headers, 'Content-Length': String(bytes.length) } });
  });

  // A task's reference photo, by its hash (ADR-035 section 3). Authorised on the task's file row
  // (hawa.task_files, row-level security), never on the hash: a hash another task or tenant holds,
  // or one this task never had, is 404.
  registerRoute('get', '/tasks/:taskId/files/:sha256', async (c: Context) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId) return problem(c, 401, 'Unauthorized', 'Authentication required');
    const taskId = c.req.param('taskId');
    const sha256 = c.req.param('sha256');
    if (!UUID_PATTERN.test(taskId || '') || !isSha256Hex(sha256)) return problem(c, 404, 'Not Found');
    if (!db || !blobStore) return problem(c, 404, 'Not Found');
    const row = await withRlsContext(db, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, async (trx) =>
      (await sql<{ sha256: string; media_type: string; size: string }>`
        SELECT b.sha256, b.media_type, b.size FROM hawa.task_files f JOIN hawa.blobs b ON b.sha256 = f.sha256
        WHERE f.tenant_id = ${auth.tenantId}::uuid AND f.task_id = ${taskId}::uuid AND f.sha256 = ${sha256}
        LIMIT 1`.execute(trx)).rows[0]
    );
    const ref = row ? parseBlobRef({ sha256: row.sha256, mediaType: row.media_type, size: Number(row.size) }) : undefined;
    if (!ref) return problem(c, 404, 'Not Found');
    return blobResponse(c, blobStore, ref);
  });

  // Get Task Timeline
  registerRoute('get', '/tasks/:taskId/timeline', async (c: any) => {
    const taskId = c.req.param('taskId');
    const auth = verifyRequestAuth(c);
    const tenantId = auth.tenantId || '00000000-0000-4000-a000-000000000001';

    if (taskRepo && db) {
      try {
        const dbEvents = await withRlsContext(
          db,
          { tenantId, userId: auth.userId, role: auth.role },
          async (trx) => await taskRepo.getEvents(taskId, tenantId, trx)
        );

        const mapped = dbEvents.map((e) => ({
          eventId: e.id,
          taskId: e.task_id,
          eventType: e.event_type,
          aggregateVersion: Number(e.aggregate_version),
          actor: { type: e.actor_type, id: e.actor_id },
          data: e.data,
          occurredAt: e.occurred_at instanceof Date ? e.occurred_at.toISOString() : e.occurred_at,
        }));
        return c.json({ events: mapped });
      } catch (err) {
        // Answered with the in-memory events (usually none), a failed read showed the Desk's History
        // tab as "no recorded events" (review of 2026-09-24).
        log.error('[core:tasks:timeline] DB timeline error:', err);
        return problem(c, 503, 'Database Unavailable', 'The task history could not be read; try again');
      }
    }

    // Without a database, the no-database store's events.
    const taskEvents = events.get(taskId) || [];
    return c.json({ events: taskEvents });
  });
}
