import { taskGenerationBlocker } from '@hawa/contracts';
import { assertTaskGenerationAllowed } from './task-generation-guard.js';
/**
 * Re-driving a task whose automatic design failed, and the sweep that re-drives every such task.
 * Moved unchanged from app.ts (architecture programme 1.3, SPLIT_PLAN.md G6): the controls routes
 * call it, and so does the Telegram handler's /redo, through a same-name binding left in app.ts
 * until Telegram intake moves (G9).
 */
import crypto from 'node:crypto';
import { PRIMARY_OPERATOR_USER_ID, SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { sql, withRlsContext } from '@hawa/db';
import { evaluateCanvaExportQc } from '../core-helpers.js';
import { DEFAULT_TENANT_ID, type CoreContext } from '../core-context.js';
import { log } from '../logging.js';
import { CanvaConnectService } from './canva-connect-service.js';
import { CanvaDesignPlanner } from './canva-design-planner.js';
import { composeCanvaStatusMessage } from './canva-status-message.js';

export type RedriveDeps = Pick<
  CoreContext,
  | 'db'
  | 'taskRepo'
  | 'outboxRepo'
  | 'revisionRepo'
  | 'canvaConnectService'
  | 'telegramBridge'
  | 'telegramAllowedUsers'
  | 'broadcastEvent'
  | 'broadcastTransition'
  | 'probeModelProvider'
>;

export type Redrive = ReturnType<typeof createRedrive>;

export function createRedrive(deps: RedriveDeps) {
  const {
    db, taskRepo, outboxRepo, revisionRepo, canvaConnectService, telegramBridge, telegramAllowedUsers,
    broadcastEvent: broadcast, broadcastTransition, probeModelProvider,
  } = deps;

  // --- Re-drive Failed Tasks & Automated Recovery Sweep ---
  async function redriveTask(
    taskId: string,
    sourceChannelId?: string,
    actor: { id: string; role: string; type?: string } = { id: PRIMARY_OPERATOR_USER_ID, role: 'operator', type: 'user' }
  ) {
    if (!db) throw new Error('Database required for task redrive');
    const tenantId = DEFAULT_TENANT_ID;
    const actorId = (actor.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actor.id))
      ? actor.id
      : PRIMARY_OPERATOR_USER_ID;

    // 1. Fetch task details from DB
    const taskData = await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
      const row = await sql<any>`
        SELECT t.id, t.tenant_id, t.client_id, t.title, t.description, t.state, t.request_id,
               (SELECT o.payload FROM hawa.outbox_commands o WHERE o.aggregate_id = t.id AND o.command_type = 'task.created' ORDER BY o.created_at DESC LIMIT 1) as payload
        FROM hawa.tasks t
        WHERE t.id = ${taskId}::uuid`.execute(trx);
      return row.rows[0];
    });

    if (!taskData) {
      return { ok: false, code: 'TASK_NOT_FOUND', message: `Task ${taskId} not found` };
    }

    if (taskData.request_id) {
      return { ok: false, code: 'LIFECYCLE_OWNED',
        message: 'This request is managed by RequestLifecycle; use its office redrive action' };
    }

    const generationBlocker = taskGenerationBlocker(taskData.state);
    if (generationBlocker) return { ok: false, code: 'TASK_GENERATION_BLOCKED', message: generationBlocker };

    if (!taskData.client_id) {
      if (sourceChannelId && sourceChannelId !== 'tg_default') {
        await telegramBridge?.dispatchOutboundMessage(sourceChannelId, {
          text: composeCanvaStatusMessage({
            taskId,
            title: taskData.title,
            briefText: taskData.description,
            status: 'CLIENT_REQUIRED',
          }).text,
          parse_mode: 'HTML',
        });
      }
      return { ok: false, code: 'CLIENT_REQUIRED', message: 'Task has no client assigned' };
    }

    const rawChannelId = sourceChannelId || taskData.payload?.sourceChannelId;
    const isChannelNumericOrAllowed = Boolean(
      rawChannelId &&
      rawChannelId !== 'tg_default' &&
      !rawChannelId.startsWith('isolated-test-') &&
      !taskData.title?.startsWith('[TEST]') &&
      (/^[0-9]+$/.test(rawChannelId) || /@(s\.whatsapp\.net|c\.us)$/.test(rawChannelId) || telegramAllowedUsers.includes(rawChannelId))
    );

    if (!isChannelNumericOrAllowed) {
      return {
        ok: false,
        code: 'NON_REDRIVABLE_SOURCE',
        message: `Task ${taskId} has no valid external intake channel (channel=${rawChannelId}) and is excluded from re-drive`,
      };
    }
    const channelId = rawChannelId!;
    const variant = taskData.payload?.variant || { width: 1080, height: 1350 };
    const width = variant.width || 1080;
    const height = variant.height || 1350;

    // 2. Check if Canva already has a bound design for this task
    const existingBinding = await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
      return (await sql<any>`
        SELECT * FROM hawa.canva_bindings
        WHERE tenant_id = ${tenantId}::uuid AND task_id = ${taskId}::uuid AND status = 'bound'
        ORDER BY created_at DESC LIMIT 1`.execute(trx)).rows[0];
    });

    if (existingBinding?.edit_url) {
      // Nothing new is generated for a task that has a design. This used to re-send the old link as
      // "Your Canva draft is ready", right after the requester was told a new draft was being made.
      if (channelId && channelId !== 'tg_default') {
        const existsMsg = composeCanvaStatusMessage({
          taskId,
          title: taskData.title,
          briefText: taskData.description,
          status: 'DESIGN_REJECTED',
          code: 'CANVA_ALREADY_BOUND',
          canvaUrl: existingBinding.edit_url,
        });
        await telegramBridge?.dispatchOutboundMessage(channelId, existsMsg);
      }
      // The design's exports and checks are run again, and the draft recorded as the Desk's revision
      // or its check as a new QC run (canva-task-outcome.ts). Until 2026-09-24 this was the whole
      // answer, so a draft whose check had timed out, or whose preview Canva had refused once, could
      // never be approved: the office's re-drive was the only button left and it did nothing.
      let recheck: import('./canva-task-outcome.js').DraftRecheckResult | { error: string } | undefined;
      if (canvaConnectService && revisionRepo) {
        const { recheckBoundDraft } = await import('./canva-task-outcome.js');
        try {
          const done = await recheckBoundDraft(db, { canva: canvaConnectService, revisionRepo, evaluateQc: evaluateCanvaExportQc }, {
            tenantId, taskId, actorId, designId: existingBinding.canva_design_id, bindingVersion: Number(existingBinding.version),
            canvaUrl: existingBinding.edit_url, fallbackCopy: taskData.payload?.exactCopy,
          });
          recheck = done;
          if (done.transition?.changed) broadcastTransition(taskId, done.transition.fromState, done.transition.toState, done.transition.version);
          // A new check without a move is still news to the Desk, which re-reads the task on it.
          if (done.qc) broadcast('task:qa_completed', { taskId, revisionId: done.revisionId, qaReport: done.qc.qaReport });
        } catch (err) {
          log.error(`[redrive] Task ${taskId}: re-checking bound Canva draft ${existingBinding.canva_design_id} failed:`, err);
          recheck = { error: String((err as Error)?.message || err).slice(0, 300) };
        }
      }
      return {
        ok: true,
        status: 'ALREADY_BOUND',
        designId: existingBinding.canva_design_id,
        canvaUrl: existingBinding.edit_url,
        ...(recheck ? { recheck } : {}),
      };
    }

    // A task from a v3 chat (or any task the studio designed) is re-driven through the studio, never
    // the older single-shot planner below: v3 runs refuse that planner even as a fallback, and /redo
    // used to hand a v3 request to it. The studio run is durable and long, so it is not run here:
    // an outbox `task.dispatch` with the attempt number reaches the worker, which starts a new studio
    // run under new keys and reports the outcome through the Canva status route like any other run.
    const { runsPipelineV3 } = await import('./chat-intake.js');
    if (runsPipelineV3(String(taskData.payload?.sourceChannelId || channelId)) || taskData.payload?.designStudio === true) {
      if (!outboxRepo) throw new Error('Durable outbox required for a studio re-drive');
      const queued = await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
        const currentTask = (await sql<{state:string}>`SELECT state FROM hawa.tasks WHERE tenant_id=${tenantId}::uuid AND id=${taskId}::uuid FOR UPDATE`.execute(trx)).rows[0];
        assertTaskGenerationAllowed(currentTask?.state);
        // `stale`: not live by the Desk's own rule (LIVE_RUN), 30 minutes without progress.
        const unfinishedRun = (await sql<any>`SELECT id, status, updated_at <= now() - interval '30 minutes' AS stale FROM hawa.design_studio_runs
          WHERE tenant_id = ${tenantId}::uuid AND task_id = ${taskId}::uuid
            AND status NOT IN ('transferred', 'degraded', 'failed', 'abandoned')
          LIMIT 1`.execute(trx)).rows[0];
        const redrives = (await sql<any>`SELECT state FROM hawa.outbox_commands
          WHERE tenant_id = ${tenantId}::uuid AND aggregate_id = ${taskId}::uuid
            AND command_type = 'task.dispatch' AND payload->>'redriveAttempt' IS NOT NULL`.execute(trx)).rows;
        if ((unfinishedRun && !unfinishedRun.stale) || redrives.some((r: any) => r.state === 'pending' || r.state === 'leased')) return null;
        // A run nothing has advanced for 30 minutes was given up on (the worker stopped following it,
        // or a restart cut it off mid-stage): it is abandoned, as the studio's abandon does, and a new
        // one queued. Until 2026-09-24 such a run counted as in progress for ever, and /redo answered
        // "still being made" for a design that would never arrive.
        if (unfinishedRun) {
          await sql`UPDATE hawa.design_studio_runs
            SET status = 'abandoned', diagnostic = ${`Abandoned by ${actorId}: no progress at '${unfinishedRun.status}' for 30 minutes; re-driven`}, updated_at = now()
            WHERE tenant_id = ${tenantId}::uuid AND id = ${unfinishedRun.id}::uuid
              AND status NOT IN ('transferred', 'degraded', 'failed', 'abandoned') AND updated_at <= now() - interval '30 minutes'`.execute(trx);
        }
        const attempt = redrives.length + 1;
        await outboxRepo.enqueue({
          tenantId,
          aggregateType: 'task',
          aggregateId: taskId,
          commandType: 'task.dispatch',
          idempotencyKey: `redrive:${taskId}:${attempt}`,
          payload: {
            ...(taskData.payload || {}),
            workflow: 'canva',
            autoGenerate: true,
            designStudio: true,
            clientId: taskData.client_id,
            redriveAttempt: attempt,
            redriveRequestedBy: actorId,
          },
        }, trx);
        return { attempt };
      });
      if (channelId && channelId !== 'tg_default') {
        await telegramBridge?.dispatchOutboundMessage(channelId, {
          text: queued
            ? `🔄 <b>A new automatic design has been started</b> for task <code>${taskId}</code>.\n<i>You will receive the Canva link here when it is ready, or an explanation if it cannot be made.</i>`
            : `⏳ <b>A design for task</b> <code>${taskId}</code> <b>is still being made</b>, so no second one was started.\n<i>You will receive the result here.</i>`,
          parse_mode: 'HTML',
        });
      }
      return queued
        ? { ok: true, taskId, status: 'STUDIO_RUN_QUEUED', redriveAttempt: queued.attempt }
        : { ok: true, taskId, status: 'STUDIO_RUN_IN_PROGRESS' };
    }
    const redriveOutcome = await import('./canva-task-outcome.js');

    // 3. Notify requester on Telegram that re-drive has started
    if (channelId && channelId !== 'tg_default') {
      await telegramBridge?.dispatchOutboundMessage(channelId, {
        text: `🔄 <b>Re-driving design generation for task</b> <code>${taskId}</code>...\n<i>Generating an updated Canva draft now.</i>`,
        parse_mode: 'HTML',
      });
    }

    // 4. Instantiate planner and run generation
    const service = new CanvaConnectService(db);
    const planner = new CanvaDesignPlanner(db, service);
    const scope = { tenantId, actorId };

    const planKey = `redrive_${taskId}_${Date.now()}`;
    const planResult = await planner.generate(scope, taskId, planKey, width, height);

    if (planResult.status === 'failed' || planResult.status === 'uncertain') {
      const failedMsg = composeCanvaStatusMessage({
        taskId,
        title: taskData.title,
        briefText: taskData.description,
        status: planResult.status === 'uncertain' ? 'DESIGN_UNCERTAIN' : 'DESIGN_FAILED',
        code: (planResult as any).message || 'PLAN_FAILED',
      });
      if (channelId && channelId !== 'tg_default') {
        await telegramBridge?.dispatchOutboundMessage(channelId, failedMsg);
      }
      return { ok: false, status: planResult.status, diagnostic: (planResult as any).message };
    }

    // 5. Resume to import into Canva if needed
    let finalDesignId: string | undefined = (planResult as any).designId;
    let finalCanvaUrl: string | undefined = (planResult as any).editUrl || (planResult as any).canvaUrl;

    if (!finalCanvaUrl && planResult.planId) {
      for (let attempt = 0; attempt < 15; attempt++) {
        const resumeResult = await planner.resume(scope, taskId, planResult.planId);
        if (resumeResult.status === 'retrieved' && (resumeResult as any).designId) {
          finalDesignId = (resumeResult as any).designId;
          finalCanvaUrl = (resumeResult as any).editUrl || `https://www.canva.com/design/${finalDesignId}/edit`;
          break;
        }
        if (resumeResult.status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    // 6. Update task state to human review and bridge revision/qc_run
    let redriveMove: import('./canva-task-outcome.js').OutcomeTransition | undefined;
    await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
      const currentTask = await taskRepo?.findById(taskId, tenantId, trx);
      if (revisionRepo && !currentTask?.current_design_revision_id) {
        const revisionId = crypto.randomUUID();
        const exportRow = (await sql<any>`SELECT b.id, b.sha256, b.format, b.content, b.content_check,
            o.metadata->>'designUpdatedAt' AS capture_version FROM hawa.canva_export_bytes b
          JOIN hawa.canva_remote_operations o ON o.id = b.operation_id AND o.tenant_id = b.tenant_id AND o.status = 'retrieved'
          JOIN hawa.canva_bindings g ON g.tenant_id = b.tenant_id AND g.task_id = b.task_id AND g.status = 'bound'
            AND g.canva_design_id = o.design_id AND g.version = o.binding_version
          WHERE b.tenant_id = ${tenantId}::uuid AND b.task_id = ${taskId}::uuid AND b.format = 'pptx'
          ORDER BY b.created_at DESC LIMIT 1`.execute(trx)).rows[0];
        const planRow = (await sql<any>`SELECT result->'manifest' AS manifest FROM hawa.canva_design_plans
          WHERE tenant_id = ${tenantId}::uuid AND task_id = ${taskId}::uuid AND status NOT IN ('failed','abandoned')
          ORDER BY created_at DESC LIMIT 1`.execute(trx)).rows[0]?.manifest;
        const candidateLayouts = (await sql<any>`SELECT c.layouts FROM hawa.design_studio_candidates c
          JOIN hawa.design_studio_runs r ON r.id = c.run_id
          WHERE r.tenant_id = ${tenantId}::uuid AND r.task_id = ${taskId}::uuid AND c.status = 'winner'
          ORDER BY c.created_at DESC LIMIT 1`.execute(trx)).rows[0]?.layouts;

        const baseNodes = planRow?.nodes || candidateLayouts?.[0]?.shapes || [
          { id: 'canva-page-1', type: 'frame', name: 'Canva Composition', width: 1080, height: 1350 },
          { id: 'canva-text-1', type: 'text', text: taskData.title || 'Canva Draft' },
        ];

        const neutralManifest = {
          documentId: finalDesignId || revisionId,
          title: taskData.title || 'Canva Draft',
          studio: 'canva',
          designId: finalDesignId,
          canvaUrl: finalCanvaUrl,
          nodes: baseNodes,
          ...(planRow || {}),
        };
        const sourceSha256 = exportRow?.sha256 || crypto.createHash('sha256').update(JSON.stringify(neutralManifest)).digest('hex');
        // Recorded as an event before the revision, which sets the same state without one.
        redriveMove = await redriveOutcome.transitionTaskForOutcome(trx, {
          tenantId, taskId, toState: 'human_review', actorId,
          reason: `Canva draft re-driven${finalDesignId ? ` as ${finalDesignId}` : ''}; awaiting visual review.`,
        });
        const dbRev = await revisionRepo.createRevision({
          id: revisionId,
          tenantId,
          taskId,
          studio: 'canva',
          sourceStorageKey: `tasks/${taskId}/revisions/${revisionId}/source.json`,
          sourceSha256,
          neutralManifest,
          authorType: 'model',
          authorId: 'canva_generator',
          status: 'review',
        }, trx);
        const finalRevId = dbRev?.id || revisionId;
        // A real profile or a clear error: the fallback id this used exists in no database.
        const profileId = await redriveOutcome.resolveQcProfileId(trx, tenantId);

        const qcEval = evaluateCanvaExportQc(exportRow, planRow?.copy || taskData.exactCopy);
        if (exportRow) {
          qcEval.qaReport.exportArtifactId = exportRow.id;
          qcEval.qaReport.captureVersion = exportRow.capture_version;
        }
        await trx.insertInto('qc_runs').values({
          tenant_id: tenantId as any,
          task_id: taskId as any,
          design_revision_id: finalRevId as any,
          qc_profile_id: profileId as any,
          status: qcEval.status as any,
          critical_pass: qcEval.criticalPass,
          report: qcEval.qaReport as any,
          report_sha256: crypto.createHash('sha256').update(JSON.stringify(qcEval.qaReport)).digest('hex'),
        }).execute();

      } else {
        // Forward only, with an event: this used to set the state outright, and could drag an
        // approved task back to review.
        redriveMove = await redriveOutcome.transitionTaskForOutcome(trx, {
          tenantId, taskId, toState: 'human_review', actorId,
          reason: `Canva draft re-driven${finalDesignId ? ` as ${finalDesignId}` : ''}; awaiting visual review.`,
        });
      }
    });

    // 7. Notify requester on Telegram
    if (channelId && channelId !== 'tg_default') {
      const statusMsg = composeCanvaStatusMessage({
        taskId,
        title: taskData.title,
        briefText: taskData.description,
        status: finalCanvaUrl ? 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW' : 'DRAFT_READY',
        canvaUrl: finalCanvaUrl,
      });
      await telegramBridge?.dispatchOutboundMessage(channelId, statusMsg);
    }

    // Only a move is a transition; the move's own words (the Desk showed 'HUMAN_REVIEW' as RECEIVED).
    // A re-drive that found the task past review moved nothing and says nothing.
    if (redriveMove?.changed) broadcastTransition(taskId, redriveMove.fromState, redriveMove.toState, redriveMove.version);

    return {
      ok: true,
      taskId,
      status: finalCanvaUrl ? 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW' : 'DRAFT_READY',
      designId: finalDesignId,
      canvaUrl: finalCanvaUrl,
    };
  }

  async function sweepFailedTasks(tenantId: string = DEFAULT_TENANT_ID) {
    if (!db) return { swept: 0, redriven: 0, errors: [] };
    const probe = await probeModelProvider();
    if (probe === 'unauthorized' || probe === 'unreachable' || probe === 'billing_exhausted') {
      return { swept: 0, redriven: 0, error: `Model provider is not healthy (${probe}), sweep paused` };
    }

    const failedRows = await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
      return (await sql<any>`
        SELECT DISTINCT ON (p.task_id) p.task_id, p.status, p.diagnostic, p.created_at,
               (SELECT o.payload->>'sourceChannelId' FROM hawa.outbox_commands o WHERE o.aggregate_id = t.id AND o.command_type = 'task.created' ORDER BY o.created_at DESC LIMIT 1) as source_channel
        FROM hawa.canva_design_plans p
        JOIN hawa.tasks t ON t.id = p.task_id
        LEFT JOIN hawa.canva_bindings b ON b.task_id = p.task_id AND b.status = 'bound'
        WHERE p.tenant_id = ${tenantId}::uuid
          AND p.status IN ('failed', 'uncertain')
          AND b.id IS NULL
          AND t.request_id IS NULL
          AND t.client_id IS NOT NULL
          AND t.title NOT LIKE '[TEST]%'
          AND (
            SELECT o.payload->>'sourceChannelId'
            FROM hawa.outbox_commands o
            WHERE o.aggregate_id = t.id AND o.command_type = 'task.created'
            ORDER BY o.created_at DESC LIMIT 1
          ) ~ '^[0-9]+$'
        ORDER BY p.task_id, p.created_at DESC`.execute(trx)).rows;
    });

    const results: any[] = [];
    for (const row of failedRows) {
      try {
        const res = await redriveTask(row.task_id);
        results.push({ taskId: row.task_id, success: res.ok, result: res });
      } catch (err: any) {
        results.push({ taskId: row.task_id, success: false, error: err.message });
      }
    }
    return { swept: failedRows.length, redriven: results.filter(r => r.success).length, results };
  }

  return { redriveTask, sweepFailedTasks };
}
