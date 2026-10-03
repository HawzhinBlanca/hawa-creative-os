import { withRlsContext } from '@hawa/db';
import type { Context } from 'hono';
import type { AuthContext, RouteContext } from './types.js';
import { isValidUuid } from '../core-helpers.js';
import { log } from '../logging.js';

/** The longest reason a dead letter may be retired with (bug hunt 3). */
export const MAX_RETIRE_REASON_CHARS = 1000;

/**
 * A task's outbox commands, and what an operator may do with one that failed (architecture programme
 * 1.3, group G5, moved from app.ts): list, redrive, the dead letters and retire. The outbox is only
 * held in Postgres; there is no in-memory one for an app without a database any more.
 */
export function registerOutboxRoutes(ctx: RouteContext): void {
  const {
    registerRoute,
    problem,
    db,
    outboxRepo,
  } = ctx;

  // createApp's verifyRequestAuth fills in every field, with '' for a caller who is not signed in
  // (app.ts); the context types it as AuthContext, whose fields are optional. These handlers were
  // written against the former.
  const verifyRequestAuth = ctx.verifyRequestAuth as (c: Context) => Required<AuthContext> & { displayName?: string };

  // Task R07: Inspect task outbox commands and notification delivery state
  registerRoute('get', '/tasks/:taskId/outbox', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) return problem(c, 401, 'Authentication Required');
    const taskId = c.req.param('taskId');
    // The outbox is only held in Postgres. Without it (or when it cannot be read) there is no list to
    // give: an empty one would say nothing is queued for the task.
    if (!db || !outboxRepo) return problem(c, 503, 'Database Unavailable', 'Outbox commands are only held in the database');

    let cmds: any[] = [];
    if (isValidUuid(taskId)) {
      try {
        cmds = await withRlsContext(
          db,
          { tenantId: auth.tenantId, userId: auth.userId, role: auth.role },
          async (trx) => await outboxRepo.findByAggregateId(auth.tenantId, 'task', taskId, trx)
        );
      } catch (err) {
        log.error('[core:outbox:query] DB outbox query error:', err);
        return problem(c, 503, 'Database Unavailable', 'The outbox could not be read; try again');
      }
    }

    const isUncertain = (cmd: any) => ((cmd.last_error || cmd.error_message) as string | undefined)?.startsWith('DELIVERY_UNCERTAIN:') || false;
    const isPermanent = (cmd: any) => {
      const err = (cmd.last_error || cmd.error_message || '') as string;
      return err.includes('CHAT_NOT_FOUND') ||
        err.includes('BOT_BLOCKED') ||
        err.includes('INVALID_DESTINATION') ||
        err.includes('CLIENT_REQUIRED');
    };

    const enriched = cmds.map((cmd: any) => {
      let actionableRecovery = 'Delivered successfully.';
      let errorCategory: 'none' | 'retryable' | 'permanent' | 'uncertain' = 'none';

      if (cmd.state === 'pending') {
        actionableRecovery = cmd.attempts > 0
          ? `Delivery failed on attempt ${cmd.attempts}; scheduled for retry with exponential backoff.`
          : 'Delivery is pending worker pickup.';
        errorCategory = 'retryable';
      } else if (cmd.state === 'failed') {
        if (isUncertain(cmd)) {
          actionableRecovery = 'Uncertain delivery: socket closed or timeout after dispatch. Automated redrive blocked to avoid duplicates. Requires explicit confirmUncertainReplay: true.';
          errorCategory = 'uncertain';
        } else if (isPermanent(cmd) || cmd.attempts === 1) {
          actionableRecovery = 'Permanent delivery failure: destination or client chat invalid. Automated redrive disabled. Fix recipient configuration before redriving.';
          errorCategory = 'permanent';
        } else {
          actionableRecovery = 'Retryable delivery failure: maximum retry attempts exhausted. Use POST /tasks/:taskId/outbox/:commandId/redrive to retry.';
          errorCategory = 'retryable';
        }
      }

      return {
        id: cmd.id,
        tenantId: cmd.tenant_id,
        aggregateType: cmd.aggregate_type,
        aggregateId: cmd.aggregate_id,
        commandType: cmd.command_type,
        idempotencyKey: cmd.idempotency_key,
        payload: cmd.payload,
        state: cmd.state,
        attempts: cmd.attempts,
        errorMessage: cmd.last_error || cmd.error_message || null,
        errorCategory,
        canRedrive: cmd.state === 'failed',
        requiresUncertainConfirmation: isUncertain(cmd),
        actionableRecovery,
        createdAt: cmd.created_at,
        updatedAt: cmd.updated_at,
      };
    });

    return c.json({
      taskId,
      count: enriched.length,
      commands: enriched,
    });
  });

  // Task R07: Operator redrive of failed outbox command with safety gate for uncertain deliveries
  registerRoute('post', '/tasks/:taskId/outbox/:commandId/redrive', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId) return problem(c, 401, 'Authentication Required');
    if (!['operator', 'administrator', 'system'].includes(auth.role || '')) {
      return problem(c, 403, 'Operator or Administrator Role Required', 'Only operators and administrators can redrive outbox commands');
    }
    const taskId = c.req.param('taskId');
    const commandId = c.req.param('commandId');
    const body = await c.req.json().catch(() => ({}));
    const confirmUncertainReplay = Boolean(body?.confirmUncertainReplay);

    // The outbox is only held in Postgres; a command id that is not a uuid names none of it.
    if (!db || !outboxRepo) return problem(c, 503, 'Database Unavailable', 'Outbox commands are only held in the database');
    if (!isValidUuid(commandId)) {
      return problem(c, 404, 'Command Not Found', `Outbox command ${commandId} was not found for task ${taskId}`);
    }
    try {
      const result = await withRlsContext(
        db,
        { tenantId: auth.tenantId, userId: auth.userId, role: auth.role },
        async (trx) => {
          const cmd = await outboxRepo.findById(auth.tenantId, commandId, trx);
          // Another task's command is not redriven from this task's page.
          if (!cmd || cmd.aggregate_id !== taskId) return { status: 404, error: `Outbox command ${commandId} was not found for task ${taskId}` };
          if (cmd.state !== 'failed') {
            return { status: 409, error: `Command ${commandId} is in '${cmd.state}' state. Only failed commands can be redriven.` };
          }
          const lastErr = cmd.last_error || '';
          if (lastErr.startsWith('DELIVERY_UNCERTAIN:') && !confirmUncertainReplay) {
            return { status: 422, error: 'Uncertain delivery requires explicit confirmation to replay. Set confirmUncertainReplay: true.' };
          }
          const redriven = await outboxRepo.redrive(auth.tenantId, commandId, trx);
          // Only a confirmed replay lets the worker make a send that may already have arrived again.
          if (confirmUncertainReplay) await outboxRepo.releaseUncertainSends(auth.tenantId, [commandId], trx);
          return { status: 200, data: redriven };
        }
      );

      if (result.status === 404) return problem(c, 404, 'Command Not Found', result.error);
      if (result.status === 409) return problem(c, 409, 'Command Not Failed', result.error);
      if (result.status === 422) return problem(c, 422, 'Uncertain Delivery Requires Explicit Confirmation', result.error);
      if (!result.data) return problem(c, 500, 'Redrive Failed', 'Failed to redrive outbox command');

      return c.json({
        redriven: true,
        commandId: result.data.id,
        state: result.data.state,
        attempts: result.data.attempts,
        confirmedUncertainReplay: confirmUncertainReplay,
        message: 'Outbox command queued for redelivery',
      });
    } catch (err: any) {
      log.error('[core:outbox:redrive] DB error:', err);
      return problem(c, 503, 'Database Unavailable', 'The command could not be redriven; try again');
    }
  });

  // Dead letters degrade the worker's health until someone acts on each one. Redrive is the only
  // other action, and for an obsolete request it would re-run it: the command dead-lettered on
  // 2026-09-17, when Restate had lost the worker, is a design request long since handled. Operators
  // list them here and retire the obsolete ones, with a reason; a retired command is kept, as 'dead'.
  registerRoute('get', '/outbox/failed', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId) return problem(c, 401, 'Authentication Required');
    if (!['operator', 'administrator', 'system'].includes(auth.role || '')) {
      return problem(c, 403, 'Operator or Administrator Role Required', 'Only operators and administrators can list dead letters');
    }
    if (!db || !outboxRepo) return problem(c, 503, 'Database Unavailable', 'Dead letters are only held in the database');
    const rows = await withRlsContext(db, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, (trx) =>
      outboxRepo.listFailed(auth.tenantId, trx)
    );
    return c.json({
      count: rows.length,
      commands: rows.map((cmd: any) => ({
        id: cmd.id,
        aggregateId: cmd.aggregate_id,
        commandType: cmd.command_type,
        attempts: cmd.attempts,
        errorMessage: cmd.last_error || null,
        createdAt: cmd.created_at,
        updatedAt: cmd.updated_at,
      })),
    });
  });

  registerRoute('post', '/tasks/:taskId/outbox/:commandId/retire', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId) return problem(c, 401, 'Authentication Required');
    if (!['operator', 'administrator'].includes(auth.role || '')) {
      return problem(c, 403, 'Operator or Administrator Role Required', 'Only operators and administrators can retire dead letters');
    }
    const taskId = c.req.param('taskId');
    const commandId = c.req.param('commandId');
    const body = await c.req.json().catch(() => ({}));
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!reason) return problem(c, 422, 'Reason Required', 'Say why this command will never be delivered.');
    // The reason is prepended to last_error, which the dead-letter list and health show (bug hunt 3).
    if (reason.length > MAX_RETIRE_REASON_CHARS) {
      return problem(c, 422, 'Reason Too Long', `Say why in at most ${MAX_RETIRE_REASON_CHARS} characters.`);
    }
    if (!db || !outboxRepo || !isValidUuid(commandId)) return problem(c, 404, 'Command Not Found', `No outbox command ${commandId}`);
    let result: { status: 404 } | { status: 409; state: string } | { status: 200; retired: any };
    try {
      result = await withRlsContext(db, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, async (trx) => {
        const cmd = await outboxRepo.findById(auth.tenantId, commandId, trx);
        if (!cmd || cmd.aggregate_id !== taskId) return { status: 404 as const };
        if (cmd.state !== 'failed') return { status: 409 as const, state: cmd.state };
        const retired = await outboxRepo.retire(auth.tenantId, commandId, reason, String(auth.userId || auth.actorId || 'operator'), trx);
        return retired ? { status: 200 as const, retired } : { status: 409 as const, state: 'changed' };
      });
    } catch (err) {
      log.error('[core:outbox:retire] the command could not be retired:', err instanceof Error ? err.message : err);
      return problem(c, 503, 'Database Unavailable', 'The command was not retired; try again');
    }
    if (result.status === 404) return problem(c, 404, 'Command Not Found', `Outbox command ${commandId} was not found for task ${taskId}`);
    if (result.status === 409) {
      return problem(c, 409, 'Command Not Failed', `Command ${commandId} is in '${result.state}' state. Only failed commands can be retired.`);
    }
    return c.json({ retired: true, commandId, state: result.retired.state, lastError: result.retired.last_error });
  });
}
