import { officeReviewUrl } from '../services/desk-review-link.js';
import crypto from 'node:crypto';
import { CanvaBindingRepository, sql, withRlsContext } from '@hawa/db';
import { CanvaDesignStudioAdapter, validateCanvaDesignUrl } from '@hawa/integrations';
import type { RouteContext } from './types.js';
import { evaluateCanvaExportQc, isValidUuid } from '../core-helpers.js';
import { log } from '../logging.js';
import { studioStatusNote, requesterDraftNotes } from '../services/design-studio/studio-status-note.js';
import { composeCanvaStatusMessage, composeChangeNeedsDesignerAlert } from '../services/canva-status-message.js';
import { composeDesignerHandoff, type AskRecord } from '../services/requester-actions.js';
import { createOfficeAlerts } from '../services/office-alerts.js';
import { createAskHistory } from '../services/ask-history.js';
import { rejectUnownedLifecycleDesignWrite, nativeRecoveryHeaders } from './lifecycle-design-proof.js';
import { lockNativeRecovery } from '../services/lifecycle-native-scope.js';
import { CanvaFlowError } from '../services/canva-flow-error.js';

/**
 * The Canva outcome routes (architecture programme 1.3, SPLIT_PLAN.md G4), moved unchanged from
 * app.ts: the manual Canva binding, the worker's terminal outcome report (canva-status and its older
 * name canva-ready; the worker's side of it is apps/worker/test/canva-status-contract.test.ts),
 * the editor link and the retired export package.
 */
export function registerCanvaOutcomeRoutes(ctx: RouteContext): void {
  const {
    registerRoute, verifyRequestAuth, problem, db, taskRepo, outboxRepo, revisionRepo, tasks, broadcastTransition,
  } = ctx;
  // createApp always builds one; the context types it optional for modules that can run without it.
  const telegramBridge = ctx.telegramBridge!;
  const { enqueueOfficeAlert } = createOfficeAlerts(ctx);
  const { askHistory } = createAskHistory(ctx);
  const canvaStudio = new CanvaDesignStudioAdapter(undefined, {
    resolveBinding: async (ctx) => {
      if (!db || !ctx.taskId || !ctx.clientId) return undefined;
      return withRlsContext(db, { tenantId: ctx.tenantId, clientId: ctx.clientId, userId: ctx.actor.id, role: 'operator' }, async trx => {
        const row = await new CanvaBindingRepository(trx).findByTaskId(ctx.tenantId, ctx.taskId!);
        if (!row || row.status !== 'bound') return undefined;
        return { tenantId: row.tenant_id, clientId: row.client_id, taskId: row.task_id,
          canvaDesignId: row.canva_design_id, editUrl: row.edit_url, viewUrl: row.view_url };
      });
    },
  });

  // Durable manual handoff. Task/client identity is server-derived, never inferred from a URL.
  registerRoute('post', '/tasks/:taskId/canva-binding', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId) return problem(c, 401, 'Authentication Required');
    if (!['operator', 'administrator', 'art_director', 'creative_director', 'designer'].includes(auth.role || '')) {
      return problem(c, 403, 'Canva Binding Forbidden');
    }
    if (!db || !taskRepo) return problem(c, 503, 'Database Required', 'Canva bindings require durable storage');
    const lifecycleRefusal = await rejectUnownedLifecycleDesignWrite(ctx, c, auth);
    if (lifecycleRefusal) return lifecycleRefusal;
    const body = await c.req.json().catch(() => null);
    let designId: string;
    try { designId = validateCanvaDesignUrl(body?.editUrl); }
    catch { return problem(c, 422, 'Invalid Canva URL', 'Paste the separate task design edit URL from Canva'); }
    const taskId = c.req.param('taskId');
    try {
      const binding = await withRlsContext(db, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, async trx => {
        const nativeRecovery = nativeRecoveryHeaders(c);
        if (nativeRecovery) await lockNativeRecovery(trx,{tenantId:auth.tenantId!,actorId:auth.userId!,role:auth.role,nativeRecovery},taskId);
        const task = await taskRepo.findById(taskId, auth.tenantId!, trx);
        if (!task?.client_id) return null;
        return new CanvaBindingRepository(trx).createBinding({ tenantId: auth.tenantId!, taskId,
          clientId: task.client_id, canvaDesignId: designId, editUrl: body.editUrl });
      });
      if (!binding) return problem(c, 404, 'Scoped Task Not Found', 'Select the client before binding a Canva design');
      return c.json({ taskId, designId: binding.canva_design_id, designUrl: binding.edit_url,
        version: binding.version, verification: 'handoff_only', captured: false }, 201);
    } catch (err) {
      if (err instanceof CanvaFlowError) return problem(c,err.status,err.code,err.message);
      if ((err as { code?: string }).code === '23505' || /binding conflict/i.test(String(err))) {
        return problem(c, 409, 'Canva Binding Conflict', 'This design or task already has a binding. Use a separate task copy');
      }
      throw err;
    }
  });

  // The durable worker reports every terminal Canva outcome here (ready, rejected, uncertain …).
  // The requester always learns what happened; a failed chat message never fails the workflow.
  const canvaStatusHandler = async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId) return problem(c, 401, 'Authentication Required');
    // The design worker reports here as an operator (app.ts, ADR-163). Any other signed-in role could
    // set a task's outcome and send its requester a Canva link of their choosing.
    if (auth.role !== 'operator' && auth.role !== 'administrator') {
      return problem(c, 403, 'Forbidden', 'Only the design worker or an office operator reports a Canva outcome.');
    }
    // The outbox is not optional here: a terminal notification that is not written down is the
    // paid design run's only link, and losing it is the failure this route exists to prevent.
    if (!db || !taskRepo || !outboxRepo) return problem(c, 503, 'Database Required');
    const taskId = c.req.param('taskId');
    if (!isValidUuid(taskId)) return problem(c, 422, 'Invalid Identifier', 'Use a valid task identifier');
    const body = await c.req.json().catch(() => ({}));
    const clean = (v: unknown) => (typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64) : undefined);
    const status = clean(body.status) || 'DRAFT_READY';
    const code = clean(body.code);
    const designId = typeof body.designId === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(body.designId) ? body.designId : undefined;
    const canvaUrl = designId ? `https://www.canva.com/design/${designId}/edit` : undefined;
    // The run's own words (a studio diagnostic, a mismatch) go to the task's history and the logs,
    // never to the requester. Control characters are dropped; length is bounded.
    const detail = typeof body.detail === 'string' ? body.detail.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500) : undefined;
    // False when intake already told the requester no automatic draft is coming: the outcome is
    // recorded on the task, and no second message is sent.
    const notifyRequester = body.notifyRequester !== false;

    const task = await withRlsContext(db, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, trx =>
      taskRepo.findById(taskId, auth.tenantId!, trx));
    if (!task) return problem(c, 404, 'Task Not Found');
    // A Restate-owned request projects its outcome through the versioned lifecycle ledger. The
    // legacy route sends messages and changes task state independently, so allowing it here would
    // give one task two owners after a replay or redrive.
    if (task.request_id) return problem(c, 409, 'LIFECYCLE_OWNED', 'Report this design through RequestLifecycle');

    const created = await withRlsContext(db, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, async trx =>
      (await sql<any>`SELECT data FROM hawa.task_events
        WHERE tenant_id = ${auth.tenantId}::uuid AND task_id = ${taskId}::uuid AND event_type = 'task.created'
        ORDER BY aggregate_version LIMIT 1`.execute(trx)).rows[0]);
    const source = created?.data?.payload || created?.data || {};
    // A legacy creation command can already be running at rollout. Its no-job report
    // owns no automatic work and cannot change an explicitly manual office task.
    if (source?.body?.workflow === 'canva_manual' && status === 'MANUAL_DESIGN_REQUIRED' &&
        detail === 'Dispatched without an automatic Canva job; nothing was generated or spent.' &&
        body.designId == null && body.runId == null && body.code == null) {
      return c.json({ taskId, status, notified: false, reason: 'MANUAL_DESK_OWNED' });
    }
    const sourceChannelId = source?.sourcePlatform === 'telegram' && source?.sourceChannelId ? String(source.sourceChannelId) : undefined;
    // A reference image joined to another request has no draft of its own; the requester was told
    // where it went when it arrived, and a "queued for manual design" notice would contradict that.
    if (source?.studioOptions?.referenceFor) {
      return c.json({ taskId, status, notified: false, reason: 'REFERENCE_FOR_ANOTHER_REQUEST' });
    }

    // A Sorani draft is set in a provisional typeface (ADR-028); the requester is told so with the result.
    const notes: string[] = [];
    try {
      const manifest = await withRlsContext(db, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, async trx =>
        (await sql<any>`SELECT result->'manifest' AS manifest FROM hawa.canva_design_plans
          WHERE tenant_id = ${auth.tenantId}::uuid AND task_id = ${taskId}::uuid AND status NOT IN ('failed','abandoned')
          ORDER BY created_at DESC LIMIT 1`.execute(trx)).rows[0]?.manifest);
      if (manifest?.rtlFontProvisional && typeof manifest?.rtlFont === 'string') {
        notes.push(`Kurdish text is set in a provisional typeface (${manifest.rtlFont}) until the brand's Kurdish font is confirmed by the art director.`);
      }
    } catch { /* the note is a courtesy; the status message must still go out */ }

    // Studio summary: only what the run recorded (concepts, revisions, score, imagery, typeface, ladder, parity).
    let studioSummary: string | undefined;
    // What a change asked for that no edit of the design can make: the requester is told, and the office.
    let notPossible: Array<{ ask: string; reason: string }> = [];
    // The question asked before a change is made (edit stage, NEEDS_CLARIFICATION), and whether the
    // request read as the sender losing patience: the first goes to the requester, the second to the office.
    let question: { question: string; options: string[] } | undefined;
    let frustrated = false;
    let studioRun: any = null;
    let studioCandidates: any[] = [];
    try {
      studioRun = await withRlsContext(db, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, async trx =>
        (await sql<any>`SELECT * FROM hawa.design_studio_runs
          WHERE tenant_id = ${auth.tenantId}::uuid AND task_id = ${taskId}::uuid
          ORDER BY created_at DESC LIMIT 1`.execute(trx)).rows[0]);
      if (studioRun) {
        studioCandidates = await withRlsContext(db, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, async trx =>
          (await sql<any>`SELECT * FROM hawa.design_studio_candidates
            WHERE tenant_id = ${auth.tenantId}::uuid AND run_id = ${studioRun.id}::uuid
            ORDER BY ordinal ASC`.execute(trx)).rows);

        let parityNote = '';
        if (body.parity === 'unavailable') {
          parityNote = ` · parity: unavailable (${body.parityError || 'error'})`;
          try {
            await withRlsContext(db, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, async trx => {
              await sql`INSERT INTO hawa.design_studio_judgments (id, run_id, tenant_id, kind, candidate_a, candidate_b, order_swapped, verdict, created_at)
                VALUES (${crypto.randomUUID()}::uuid, ${studioRun.id}::uuid, ${auth.tenantId}::uuid, 'parity', ${studioRun.winner_candidate_id || studioCandidates[0]?.id}::uuid, NULL, false, ${JSON.stringify({ parity: 'unavailable', errorCode: body.parityError || 'PARITY_ERROR' })}::jsonb, NOW())`.execute(trx);
            });
          } catch { /* courtesy record */ }
        }

        const models = (await withRlsContext(db, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, async trx =>
          (await sql<any>`SELECT model, count(*)::int AS n FROM hawa.design_studio_calls
            WHERE tenant_id = ${auth.tenantId}::uuid AND run_id = ${studioRun.id}::uuid AND status = 'ok'
            GROUP BY model ORDER BY n DESC, model`.execute(trx)).rows)).map((row: any) => String(row.model));
        // The requester reads plain words about their draft; the studio's own summary (models, score,
        // the edit's coordinates) is for the office, in the log and on the notification's record.
        studioSummary = studioStatusNote({ run: studioRun, candidates: studioCandidates, parityNote, models });
        log.info(`[canvaStatusHandler] Task ${taskId} studio summary: ${studioSummary}`);
        notes.push(...requesterDraftNotes({ run: studioRun, candidates: studioCandidates }));
        const runStages = typeof studioRun.stages === 'string' ? JSON.parse(studioRun.stages || '{}') : studioRun.stages || {};
        const recordedAsks = Array.isArray(runStages?.directed?.asks) ? runStages.directed.asks : [];
        notPossible = (recordedAsks as Array<{ ask?: unknown; status?: unknown; reason?: unknown } | null>)
          .filter((a) => a?.status === 'not_possible' && typeof a?.ask === 'string' && a.ask.trim())
          .map((a) => ({ ask: String(a!.ask).trim(), reason: typeof a!.reason === 'string' ? a!.reason.trim() : '' }));
        const clarify = runStages?.directed?.refused === 'NEEDS_CLARIFICATION' ? runStages.directed.clarify : undefined;
        if (clarify && typeof clarify.question === 'string' && Array.isArray(clarify.options)) {
          question = { question: clarify.question, options: clarify.options.filter((o: unknown): o is string => typeof o === 'string' && o.trim() !== '') };
        }
        frustrated = runStages?.directed?.frustrated === true;
      }
    } catch { /* courtesy note; do not fail status */ }

    // What this outcome does to the task record (services/canva-task-outcome.ts). A draft that exists,
    // ready or with a check to resolve, becomes the Desk revision with its QC run and moves the task
    // to review; a check that did not pass keeps QC failed, so approval stays blocked. An outcome with
    // no draft moves the task to OPERATOR_REQUIRED, which is what the requester is told. Every move
    // is an event, under this request's tenant context.
    const { outcomeHasDraft, bridgeCanvaDraftRevision, transitionTaskForOutcome } = await import('../services/canva-task-outcome.js');
    const outcomeScope = { tenantId: auth.tenantId, userId: auth.userId, role: auth.role };
    const hasDraft = outcomeHasDraft(status, designId);
    // A question to the requester is not a failure: the task waits for the answer (paused), which
    // starts the change again as a new revision; an operator has nothing to follow up yet.
    const waitingForAnswer = !hasDraft && code === 'NEEDS_CLARIFICATION' && Boolean(question);
    let outcomeState: 'human_review' | 'failed_operator' | 'paused' = hasDraft ? 'human_review' : waitingForAnswer ? 'paused' : 'failed_operator';
    let outcomeReason = hasDraft
      ? `Canva draft delivered (${status})${designId ? ` as ${designId}` : ''}; awaiting visual review.`
      : waitingForAnswer
        ? `A question was sent to the requester before the change is made: ${question!.question}`
        : `Automatic draft ended ${status}${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}. An operator has to follow up.`;
    let reviewRevisionId: string | undefined;
    if (hasDraft && revisionRepo) {
      try {
        const bridged = await withRlsContext(db, outcomeScope, async (trx) => {
          const result = await bridgeCanvaDraftRevision(trx, { revisionRepo, evaluateQc: evaluateCanvaExportQc }, {
            tenantId: auth.tenantId!, taskId, actorId: auth.userId || null, status, designId, canvaUrl,
            fallbackCopy: source?.exactCopy, reason: outcomeReason,
          });
          reviewRevisionId = result.created ? result.revisionId :
            (await trx.selectFrom('tasks').select('current_design_revision_id')
              .where('tenant_id', '=', auth.tenantId!).where('id', '=', taskId).executeTakeFirst())?.current_design_revision_id ?? undefined;
          return result;
        });
        // The bridge moves the task to review itself, so the transition below finds nothing to change
        // and told no one: the Desk kept the task as RECEIVED, Approve disabled, until a reload (review
        // of 2026-09-24).
        if (bridged.created && bridged.transition.changed) {
          broadcastTransition(taskId, bridged.transition.fromState, bridged.transition.toState, bridged.transition.version);
        }
      } catch (revErr: any) {
        // This used to be one log line and nothing else: the draft existed in Canva, the Desk could
        // not show it, and the task sat in RECEIVED. The task is now marked for an operator, saying why.
        log.error(
          `[canvaStatusHandler] Task ${taskId}: Canva draft ${designId || '(no design id)'} (${status}) could NOT be recorded as a Desk revision; ` +
            `the task is marked OPERATOR_REQUIRED instead:`,
          revErr
        );
        outcomeState = 'failed_operator';
        outcomeReason = `Canva draft ${designId || '(no design id)'} exists (${status}) but its Desk revision could not be recorded: ${String(revErr?.message || revErr).slice(0, 300)}`;
      }
    }

    // A task whose outcome is known is no longer `received`. `human_review` is the honest state for a
    // draft that exists and is with a person; `failed_operator` for an outcome that needs one. Neither
    // is `complete`. This also covers a draft whose revision already exists (a second run) and every
    // outcome with no draft. It used to read the task outside any tenant context, which row-level
    // security answers with no row, so it never ran in production and never said so.
    try {
      const moved = await withRlsContext(db, outcomeScope, (trx) =>
        transitionTaskForOutcome(trx, {
          tenantId: auth.tenantId!, taskId, toState: outcomeState, actorId: auth.userId || null, reason: outcomeReason,
          data: { outcome: status, ...(code ? { code } : {}), ...(designId ? { designId } : {}), ...(detail ? { detail } : {}) },
        }));
      if (moved.changed) {
        broadcastTransition(taskId, moved.fromState, moved.toState, moved.version);
      }
      if (outcomeState === 'failed_operator') {
        log.warn(`[canvaStatusHandler] Task ${taskId} needs an operator: ${outcomeReason}`);
      }
    } catch (stateErr) {
      // Never fail the delivery over bookkeeping, but never hide it either.
      log.error(`[canvaStatusHandler] Task ${taskId}: could not record outcome ${status} as state ${outcomeState}:`, stateErr);
    }

    let notificationSent = false;
    let notificationError: string | undefined;
    let notificationCommandId: string | undefined;
    if (sourceChannelId && notifyRequester) {
      const message = composeCanvaStatusMessage({ taskId, title: task.title, briefText: task.description, status, code, canvaUrl, notes, notPossible, question,
        reviewUrl: officeReviewUrl({ taskId, ...(reviewRevisionId ? { revisionId: reviewRevisionId } : {}) }) });
      const scope = { tenantId: auth.tenantId, userId: auth.userId, role: auth.role };
      // The worker's finish() swallows its own notification errors so a failed message cannot fail
      // a design (canva-draft-workflow.ts), and this was a single fire-and-forget send: a Telegram
      // rate limit, a 5xx or a restart dropped the owner's only link to work already paid for, with
      // no record anywhere. The message is written to the outbox before it is attempted.
      //
      // The key is the task and its terminal status, because Restate journals finish() and re-issues
      // the identical call on a workflow retry. The rejection code belongs in the key as well:
      // DESIGN_REJECTED/COPY_REQUIRED and DESIGN_REJECTED/CLIENT_REFERENCE_REQUIRED are different
      // messages, and the second must not be swallowed as a duplicate of the first.
      // The run (or the design it produced) is part of the key. A task can legitimately be run
      // again - the outbox requeue and redrive routes do exactly that, as happened after the
      // 2026-09-17 Restate incident - and the second run carries a new Canva link. Keyed on task,
      // status and code alone, that second, different message would be swallowed as a duplicate,
      // while a Restate retry still replays an identical body and is deduplicated as intended.
      const runKey = typeof body.runId === 'string' ? body.runId : designId || 'no-run';
      const idempotencyKey = `notify.telegram:${taskId}:${status}${code ? `:${code}` : ''}:${runKey}`;
      const existing = await withRlsContext(db, scope, (trx) =>
        outboxRepo.findByIdempotencyKey(auth.tenantId!, idempotencyKey, trx));
      if (existing) {
        // Already written down, so nothing is sent again: whatever state it is in is the record.
        return c.json({
          ok: true, taskId, status, code, designId, canvaUrl,
          notificationSent: existing.state === 'delivered',
          notificationError: existing.state === 'delivered' ? undefined : `NOTIFICATION_${String(existing.state).toUpperCase()}`,
          notificationCommandId: existing.id,
          notificationDeduplicated: true,
        });
      }

      // Held back from the worker for a minute because the inline attempt owns it first: the bridge
      // allows two sends of 15s each (telegram-bridge.ts), 30s at worst, so nobody else leases it
      // while it runs. A Core crash inside that minute leaves the command pending, not lost.
      let command;
      try {
        command = await withRlsContext(db, scope, (trx) =>
          outboxRepo.enqueue({
            tenantId: auth.tenantId!,
            aggregateType: 'task',
            aggregateId: taskId,
            commandType: 'notify.telegram',
            idempotencyKey,
            // The composed message travels with the command so a retry sends exactly what was
            // attempted, and never recomposes it from a database that has moved on since.
            payload: {
              chatId: sourceChannelId,
              message,
              taskId,
              status,
              ...(code ? { code } : {}),
              ...(designId ? { designId } : {}),
              ...(canvaUrl ? { canvaUrl } : {}),
              ...(studioSummary ? { studioSummary } : {}),
            },
            availableAt: new Date(Date.now() + 60_000),
          }, trx));
      } catch (enqueueErr) {
        // outbox_commands is UNIQUE (tenant_id, idempotency_key), so two identical calls racing
        // each other end here rather than sending the message twice.
        const raced = await withRlsContext(db, scope, (trx) =>
          outboxRepo.findByIdempotencyKey(auth.tenantId!, idempotencyKey, trx));
        if (raced) {
          return c.json({
            ok: true, taskId, status, code, designId, canvaUrl,
            notificationSent: raced.state === 'delivered',
            notificationError: raced.state === 'delivered' ? undefined : `NOTIFICATION_${String(raced.state).toUpperCase()}`,
            notificationCommandId: raced.id,
            notificationDeduplicated: true,
          });
        }
        log.error(`[canvaStatusHandler] Task ${taskId} status ${status} could not be written to the outbox:`, enqueueErr);
        return problem(c, 500, 'Notification Enqueue Failed', `Failed to persist notification command to durable outbox: ${String(enqueueErr)}`);
      }

      const dispatchRes = await telegramBridge.dispatchOutboundMessage(sourceChannelId, message);
      notificationSent = dispatchRes.success;
      notificationCommandId = command?.id;
      if (!command) {
        notificationError = dispatchRes.success ? 'NOTIFICATION_NOT_RECORDED' : dispatchRes.error;
      } else if (dispatchRes.success) {
        await withRlsContext(db, scope, (trx) => outboxRepo.markDelivered(command.id, trx));
      } else {
        notificationError = dispatchRes.error;
        const reason = dispatchRes.error || 'TELEGRAM_SEND_FAILED';
        await withRlsContext(db, scope, (trx) =>
          // A lost response can follow a successful send, which is why the bridge refuses to resend
          // an uncertain one; the outbox must refuse too, so it goes straight to the dead-letter
          // list an operator reads instead of being retried into a second message.
          // TELEGRAM_RECEIPT_INVALID belongs with it: the bridge returns that after Telegram has
          // answered 200 with a receipt it cannot match, so the message may well have arrived
          // (telegram-bridge.ts, the message_id and chat id check), and a retry would send it twice.
          /DELIVERY_UNCERTAIN|TELEGRAM_RECEIPT_INVALID/.test(reason)
            ? outboxRepo.markUncertain(command.id, reason, trx)
            // The repository's defaults, which the worker's consumer also applies to later attempts, so
            // the schedule does not change hands halfway.
            : outboxRepo.retryOrDeadLetter(command.id, reason, undefined, undefined, trx));
      }

      // A part of the change no edit can make goes to a designer: the requester was told the office
      // knows, so the office is told, once per run, through the outbox like every other message.
      if (notPossible.length > 0) {
        await enqueueOfficeAlert(
          taskId,
          `change-needs-designer:${taskId}:${runKey}`,
          composeChangeNeedsDesignerAlert({ taskId, title: task.title, asks: notPossible, draftSent: hasDraft }),
          sourceChannelId
        );
      }
      // A requester losing patience (repeating an ask, "still wrong", asking for a person) is a
      // designer's cue to step in before they give up (ADR-032 §2.4): once per design.
      if (frustrated) {
        const history = await askHistory(taskId).catch(() => ({ asks: [] as AskRecord[], rounds: 0 }));
        await enqueueOfficeAlert(
          taskId,
          `frustrated:${taskId}`,
          composeDesignerHandoff({ taskId, title: task.title, canvaUrl, asks: history.asks, rounds: history.rounds, why: 'frustrated' }),
          sourceChannelId
        );
      }

      // Photo Delivery via dispatchOutboundPhoto
      try {
        // 1. Exported Canva PNG (from canva_export_bytes)
        const exportedPngRow = await withRlsContext(db, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, async trx =>
          (await sql<any>`SELECT content FROM hawa.canva_export_bytes
            WHERE tenant_id = ${auth.tenantId}::uuid AND task_id = ${taskId}::uuid AND format = 'png'
            ORDER BY created_at DESC LIMIT 1`.execute(trx)).rows[0]);
        if (exportedPngRow?.content && Buffer.isBuffer(exportedPngRow.content)) {
          // The image is what the requester looks at and replies to. Its caption carries the task id,
          // so a reply to it reaches this task (the webhook reads the id from the replied-to caption)
          // rather than whichever task in the chat happens to be newest.
          await telegramBridge.dispatchOutboundPhoto(
            sourceChannelId,
            exportedPngRow.content,
            `🎨 Canva draft · Task ID: ${taskId}\nReply to this image with any change you want.`
          );
        }

        // 2. Up to previews - 1 runner-up local previews
        if (studioRun && studioCandidates.length > 1) {
          const runnerUps = studioCandidates.filter(c => c.status === 'runner_up' || (c.id !== studioRun.winner_candidate_id && c.preview_png));
          const reqObj = typeof studioRun.request === 'string' ? JSON.parse(studioRun.request || '{}') : (studioRun.request || {});
          const requestedPreviews = reqObj.previews || 3;
          const limit = Math.max(0, requestedPreviews - 1);
          const toSend = runnerUps.slice(0, limit);
          let optIndex = 2;
          for (const runnerUp of toSend) {
            if (runnerUp.preview_png && Buffer.isBuffer(runnerUp.preview_png)) {
              await telegramBridge.dispatchOutboundPhoto(
                sourceChannelId,
                runnerUp.preview_png,
                `Option ${optIndex++} (preview, not in Canva)`
              );
            }
          }
        }
      } catch (photoErr) {
        // Photo failures never fail the status message
        log.warn('[canvaStatusHandler] Photo delivery warning:', photoErr);
      }
    } else {
      notificationError = sourceChannelId ? 'REQUESTER_TOLD_AT_INTAKE' : 'NO_TELEGRAM_SOURCE';
    }
    return c.json({ ok: true, taskId, status, code, notificationSent, notificationError, notificationCommandId, designId, canvaUrl });
  };
  registerRoute('post', '/tasks/:taskId/notifications/canva-status', canvaStatusHandler);
  registerRoute('post', '/tasks/:taskId/notifications/canva-ready', canvaStatusHandler);

  registerRoute('get', '/tasks/:taskId/editor-url', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId) return problem(c, 401, 'Authentication Required');
    const taskId = c.req.param('taskId');
    const mode = c.req.query('mode') === 'edit' ? 'edit' : 'review';

    if (!db || !taskRepo) {
      const task = tasks.get(taskId);
      if (!task) return problem(c, 404, 'Task Not Found');
      return c.json({
        taskId,
        documentId: `doc_${taskId.slice(0, 8)}`,
        revisionId: task.latestRevisionId || null,
        mode,
        url: `https://www.canva.com/design/DAG_${taskId.slice(0, 8)}/${mode === 'edit' ? 'edit' : 'view'}`,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        verification: 'handoff_only',
      });
    }

    const task = await withRlsContext(db, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, trx =>
      taskRepo.findById(taskId, auth.tenantId!, trx));
    if (!task?.client_id) return problem(c, 404, 'Scoped Task Not Found');
    const result = await canvaStudio.getEditorUrl({ tenantId: auth.tenantId, clientId: task.client_id,
      taskId, actor: { type: 'user', id: auth.userId || auth.actorId! }, correlationId: crypto.randomUUID(),
      deadline: new Date(Date.now() + 30000).toISOString(), idempotencyKey: `handoff_${taskId}` },
      { documentId: taskId, sourceRevision: 0, sourceSha256: '', studio: 'Canva', studioVersion: '2.1.0', schemaVersion: '2' }, mode);
    if (!result.ok) return problem(c, 409, result.error.code, result.error.message);
    return c.json({ taskId, mode, ...result.value, verification: 'handoff_only' });
  });

  // Retired under ADR-025 with a database. Without one it assembled a package of files that were never
  // made: fixed byte counts, a logo hash and a Drive folder no delivery had used (architecture
  // programme 1.3, cleanup step). Native Canva exports are served by their own route.
  registerRoute('get', '/tasks/:taskId/export-package', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) return problem(c, 401, 'Authentication Required');
    return c.json({
      error: 'STUDIO_EXPORT_PACKAGE_RETIRED',
      statusCode: 410,
      message: 'The legacy export package endpoint was retired under ADR-025. Use /v1/tasks/:taskId/canva/artifacts/:artifactId for native Canva exports.',
      activeStudio: 'canva_native',
      decommissionedUnder: 'ADR-025',
    }, 410);
  });
}
