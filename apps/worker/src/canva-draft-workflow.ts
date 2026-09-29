import type { WorkflowDurableContext } from './durable-context.js';
import type { WorkflowInput, WorkflowOutput } from './workflow.js';
import type { OutcomeRecorder } from './outcome-without-core.js';
import { log, requestIdHeaders } from './logging.js';
import { lifecycleDesignProofHeaders } from './lifecycle/design-proof.js';

/** The one-way outcome channel of a RequestLifecycle-owned DesignRun. */
export interface LifecycleOutcomeReporter {
  requestId: string;
  runId: string;
  report(outcome: { status: string; designId?: string; code?: string; runId?: string;
    parity?: string; parityError?: string; detail?: string; notifyRequester?: boolean }): void;
}

/**
 * A failure that retrying can never fix (rejected request, scope mismatch). The Restate
 * adapter in index.ts converts it into a TerminalError so the engine stops retrying.
 */
export class WorkflowTerminalError extends Error {
  readonly terminal = true;
  constructor(message: string, readonly code?: string) { super(message); this.name = 'WorkflowTerminalError'; }
}

/**
 * Refusals another request clears by itself. Core answers 409 CANVA_RECONNECT_REQUIRED to every Canva
 * call that arrives while another call is rotating the shared token, and the draft of a design that
 * existed in Canva ended as CANVA_PREVIEW_FAILED over it (2026-09-24). Such a refusal is retried like
 * an outage, within the step's own retry window (index.ts CORE_STEP_RETRY: at most 10 minutes), and
 * reported as the refusal it was only when that window is spent: a connection that really needs the
 * owner to reconnect Canva still says so.
 */
const RETRIED_REFUSALS = new Set(['CANVA_RECONNECT_REQUIRED']);

/** Core answered with an HTTP error. 4xx (except 408/429) is terminal: the request itself was refused. */
export class CoreBoundaryError extends Error {
  readonly terminal: boolean;
  /** A 409 that is retried before it is believed (RETRIED_REFUSALS). */
  readonly retriedRefusal: boolean;
  /** retryAfterMs: Core's Retry-After on a busy answer, when it named one (ADR-131). */
  constructor(readonly httpStatus: number, readonly code?: string, readonly retryAfterMs?: number) {
    super(`Canva workflow Core boundary HTTP ${httpStatus}${code ? ` ${code}` : ''}`);
    this.name = 'CoreBoundaryError';
    this.retriedRefusal = httpStatus === 409 && Boolean(code && RETRIED_REFUSALS.has(code));
    this.terminal = httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429 && !this.retriedRefusal;
  }
}

/**
 * Whether a step has given up: Restate spent its retries (or the action was refused for good) and
 * handed back a TerminalError. Anything else is still being retried by the engine and is rethrown.
 */
const stepGaveUp = (error: unknown): boolean =>
  Boolean(
    (error as any)?.name === 'TerminalError' ||
    (error as any)?.terminal ||
    (error as any)?.cause?.terminal ||
    String((error as any)?.name).includes('Terminal') ||
    String((error as any)?.message).includes('terminal workflow failure')
  );

const BOUNDARY_MESSAGE = /^Canva workflow Core boundary HTTP (\d{3})(?: ([A-Z0-9_]+))?$/;
/**
 * The Core refusal behind an error. A step's failure comes back from Restate's journal as a new
 * TerminalError carrying only the message, so neither the CoreBoundaryError nor the cause set on it
 * survives: on 2026-09-18 a refused copy and font check ended the pilot's workflow as a failure,
 * and the requester was never told. The message carries the status and code, so it is rebuilt.
 */
const boundaryOf = (error: unknown): CoreBoundaryError | null => {
  if (error instanceof CoreBoundaryError) return error;
  if ((error as any)?.cause instanceof CoreBoundaryError) return (error as any).cause;
  const match = BOUNDARY_MESSAGE.exec(String((error as any)?.message ?? ''));
  return match ? new CoreBoundaryError(Number(match[1]), match[2]) : null;
};

/** Historical tasks carried no requested size; the print-oriented portrait default stays for them. */
export const DEFAULT_CANVA_VARIANT = { width: 1200, height: 1697 } as const;

/**
 * Statuses core's studio resume returns for a run it will not advance again. `awaiting_selection`
 * belongs here: the run is holding for a person to choose a candidate, and polling cannot move it.
 * The report after the loop turns it into DESIGN_AWAITING_SELECTION, as it always did.
 */
const STUDIO_SETTLED = ['transferred', 'degraded', 'failed', 'abandoned', 'awaiting_selection'];

/**
 * The advance loop used to wait a flat 5 s before every resume. Core's resume executes the next
 * stage inline and returns the status it reached, so after a poll that moved the status the next
 * stage is already runnable and the gap buys nothing: the 2026-09-19 audit measured 9 resumes and
 * 45 000 ms of pure sleep on a design that advanced on every poll. The workflow now waits a token
 * gap after a poll that moved the status, and backs off from 500 ms to a 5 s ceiling only while the
 * status stands still: the same design sleeps 9 ms instead of 45 000 ms.
 *
 * The token gap is still a journalled sleep. Dropping the entry would change the shape of the
 * journal, and an invocation suspended under the previous worker replays its recorded entries
 * against the new control flow: it would meet a resume where it had recorded a sleep, and fail.
 * The entry is what has to match, not its duration.
 *
 * Every gap is derived from journalled statuses alone, so a replay asks for the same timers in the
 * same order.
 */
const STUDIO_POLL_ADVANCED_WAIT_MS = 1;
const STUDIO_POLL_FIRST_WAIT_MS = 500;
const STUDIO_POLL_MAX_WAIT_MS = 5000;
const studioPollWaitMs = (idlePolls: number) =>
  idlePolls <= 0
    ? STUDIO_POLL_ADVANCED_WAIT_MS
    : Math.min(STUDIO_POLL_FIRST_WAIT_MS * 2 ** (idlePolls - 1), STUDIO_POLL_MAX_WAIT_MS);

/**
 * A run that stops moving used to be resumed 150 times and then reported under its own stage name,
 * which is how the audit's abandoned run cost 150 resumes and 750 000 ms of sleep while the owner
 * was told nothing. Ten consecutive polls at the same status, or 60 000 ms of accumulated waiting
 * across the whole loop, is treated as stuck and reported with the stage it stopped in.
 */
const STUDIO_MAX_RESUMES = 150;
const STUDIO_IDLE_POLL_LIMIT = 10;
const STUDIO_IDLE_WAIT_BUDGET_MS = 60000;

export function resolveCanvaVariant(input: Pick<WorkflowInput, 'canvaVariant'>): { width: number; height: number } {
  const v = input.canvaVariant;
  const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 640 && (n as number) <= 2400;
  return v && ok(v.width) && ok(v.height) ? { width: v.width, height: v.height } : { ...DEFAULT_CANVA_VARIANT };
}

type CoreCall = (path: string, body?: unknown, key?: string) => Promise<any>;

/** The worker's authenticated line to Core for one task. */
function coreClient(input: Pick<WorkflowInput, 'taskId'>, fetcher: typeof fetch, lifecycle?: Pick<LifecycleOutcomeReporter, 'requestId' | 'runId'>): CoreCall {
  const base = process.env.HAWA_CORE_INTERNAL_URL || 'http://core:3001';
  const token = process.env.HAWA_BEARER_TOKEN;
  if (!token) throw new Error('Worker Core credential is not configured');
  return async (path: string, body?: unknown, key?: string) => {
    const method = body === undefined ? 'GET' : 'POST';
    const pathname = '/v1/tasks/' + encodeURIComponent(input.taskId) + path;
    const res = await fetcher(base + pathname, {
      method,
      // Core logs the call under the request this invocation belongs to (logging.ts).
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}), ...requestIdHeaders(),
        ...(method === 'POST' && lifecycle ? lifecycleDesignProofHeaders({
          taskId: input.taskId, requestId: lifecycle.requestId, runId: lifecycle.runId, method, path: pathname,
        }) : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(300000),
    });
    if (!res.ok) {
      let code: string | undefined;
      try { const problem: any = await res.json(); code = [problem?.title, problem?.error, problem?.code].find((v) => typeof v === 'string'); } catch { /* no body */ }
      // Core sends Retry-After in whole seconds; a bare test double may carry no headers at all.
      const retryAfter = typeof res.headers?.get === 'function' ? res.headers.get('Retry-After') : null;
      const retryAfterSeconds = retryAfter !== null && /^\s*\d+\s*$/.test(retryAfter) ? Number(retryAfter) : NaN;
      throw new CoreBoundaryError(
        res.status,
        code ? String(code).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64) : undefined,
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 ? retryAfterSeconds * 1000 : undefined
      );
    }
    return res.json() as Promise<any>;
  };
}

/**
 * How long the outcome report keeps asking a Core that does not answer. It had the ten minutes of
 * every other step, which the step that failed had usually just spent on the same dead Core, so the
 * outcome was lost and the requester waited for good (2026-09-24). An hour outlasts a restart, a
 * deploy and a rolled-back deploy; past it the worker records the outcome in the outbox itself.
 */
export const OUTCOME_REPORT_RETRY_MS = 60 * 60 * 1000;

/**
 * Posts a terminal outcome to Core, journalled as one step. Core records it on the task and, unless
 * told otherwise, messages the requester. A 4xx answer is final and swallowed: a message Core refuses
 * must never fail (or retry) the workflow.
 */
async function reportOutcome(ctx: WorkflowDurableContext, call: CoreCall, stepName: string, body: Record<string, unknown>) {
  return ctx.run(stepName, async () => {
    try {
      return await call('/notifications/canva-status', body);
    } catch (err) {
      if (err instanceof CoreBoundaryError && err.httpStatus >= 400 && err.httpStatus < 500 && err.httpStatus !== 429) {
        return { error: 'non_retryable_client_error', status: err.httpStatus };
      }
      throw err;
    }
  }, { maxRetryDuration: OUTCOME_REPORT_RETRY_MS });
}

/**
 * Core answers a studio start with 429 STUDIO_BUSY while two of the tenant's runs are unfinished, and a
 * generation with 429 PLANNING_BUSY while every planning slot is taken (ADR-131). The step retried that five times in under a second and the workflow then told the requester "We could
 * not make the automatic draft", although nothing was wrong with the request: it only had to wait its
 * turn (2026-09-23). A busy answer is now journalled as an answer rather than thrown, and the same
 * request is asked again after a durable 25 s wait, for up to 15 minutes. Only then does the run end
 * as it did before. The wait is counted from what was asked for, never from a clock, so a replay
 * reaches the same decision at the same try.
 *
 * When Core names the wait (Retry-After, which PLANNING_BUSY carries: until the oldest running plan
 * should finish), that wait is kept, from 1 to 30 s, and journalled with the answer, so a replay
 * sleeps the same without reading any header. The planning step used to throw the 429 into the
 * step's own retry, which doubles (2, 4, 8, 16, 30 s): ten briefs sent at once got their drafts in
 * pairs at about 5, 7, 11, 19 and 35 s while slots stood free between tries (2026-09-24 load test).
 *
 * Canva's own rate limit is answered the same way (ADR-132): an import or export Canva still refuses
 * with 429 after the client's short retry comes back as 429 CANVA_RATE_LIMITED with Canva's wait. It
 * used to be recorded as failed and ended the draft. Only a 429 is repeated, under the same key: Canva
 * refused it before acting, and Core keeps an import whose outcome is unknown 'uncertain' rather than
 * sending it again.
 */
const CORE_BUSY_WAIT_MS = 25000;
const CORE_BUSY_WINDOW_MS = 15 * 60 * 1000;
const CORE_NAMED_WAIT_MIN_MS = 1000;
const CORE_NAMED_WAIT_MAX_MS = 30000;

type CoreBusy = { coreBusy: string; retryAfterMs?: number };
const busyWaitMs = (busy: CoreBusy): number =>
  typeof busy.retryAfterMs === 'number' && Number.isFinite(busy.retryAfterMs)
    ? Math.min(CORE_NAMED_WAIT_MAX_MS, Math.max(CORE_NAMED_WAIT_MIN_MS, busy.retryAfterMs))
    : CORE_BUSY_WAIT_MS;
const isCoreBusy = (value: unknown): value is CoreBusy =>
  typeof value === 'object' && value !== null && typeof (value as { coreBusy?: unknown }).coreBusy === 'string';

async function runUnlessBusy<T>(ctx: WorkflowDurableContext, stepName: string, request: () => Promise<T>): Promise<T | CoreBusy> {
  let waitedMs = 0;
  for (let attempt = 0; ; attempt++) {
    const answer: T | CoreBusy = await ctx.run(attempt === 0 ? stepName : `${stepName}-after-busy-${attempt}`, async () => {
      try {
        return await request();
      } catch (err) {
        if (err instanceof CoreBoundaryError && err.httpStatus === 429) {
          return err.retryAfterMs === undefined
            ? { coreBusy: err.code || 'HTTP_429' }
            : { coreBusy: err.code || 'HTTP_429', retryAfterMs: err.retryAfterMs };
        }
        // A change whose original design is still being made waits for it the same way: the studio
        // refuses it with 409 PARENT_STILL_RUNNING rather than designing the change from nothing.
        if (err instanceof CoreBoundaryError && err.httpStatus === 409 && err.code === 'PARENT_STILL_RUNNING') return { coreBusy: err.code };
        throw err;
      }
    });
    if (!isCoreBusy(answer) || waitedMs >= CORE_BUSY_WINDOW_MS) return answer;
    const wait = busyWaitMs(answer);
    if (ctx.sleep) await ctx.sleep(wait);
    waitedMs += wait;
  }
}

/**
 * The code Core records for a studio run that ended `failed`. It used to be the run's free-text
 * diagnostic ("Studio v3 failed: Winner failed hard QA: TEXT_OVERFLOW, …"), which Core squashed into
 * an upper-case token and printed to the requester. The code is now a short, stable name; the
 * diagnostic travels separately as `detail`, for the task's history and the logs only.
 */
export function studioFailureCode(result: { code?: unknown; diagnostic?: unknown; message?: unknown; error?: unknown }): string {
  if (typeof result.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(result.code)) return result.code;
  const text = [result.diagnostic, result.message, result.error].filter((v) => typeof v === 'string').join(' ');
  // ADR-142: one request larger than the run had left; nothing was laid out or sent for it.
  if (/STUDIO_RUN_LIMIT_TOO_SMALL/.test(text)) return 'STUDIO_RUN_LIMIT_TOO_SMALL';
  if (/BUDGET_EXHAUSTED/i.test(text)) return 'BUDGET_EXHAUSTED';
  // The provider account out of credit or its key refused: every design fails the same way until
  // the office tops it up, which the generic STUDIO_FAILED hid in the task history.
  if (/insufficient_quota|exceeded your current quota|INSUFFICIENT_QUOTA|billing_hard_limit/i.test(text)) return 'MODEL_CREDIT_EXHAUSTED';
  if (/invalid_api_key|incorrect api key|HTTP 401\b/i.test(text)) return 'MODEL_KEY_REFUSED';
  if (/hard QA/i.test(text)) return 'HARD_QA_REFUSED';
  if (/judge|critic/i.test(text) && /unavailable/i.test(text)) return 'MODEL_UNAVAILABLE';
  return 'STUDIO_FAILED';
}

const detailOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : undefined;

/**
 * A dispatch the runner refuses (no Canva job: daily cap, no client, instruction only, a reference
 * image) is reported to Core before the refusal is thrown, so the task leaves RECEIVED for an
 * operator. Core messages the requester only if intake did not already tell them. Best effort: a
 * failure here is logged and never replaces the refusal itself.
 */
export async function reportNotRunnable(input: WorkflowInput, ctx: WorkflowDurableContext, fetcher: typeof fetch = fetch): Promise<void> {
  try {
    const call = coreClient(input, fetcher);
    await reportOutcome(ctx, call, 'canva-notify-not-runnable', {
      status: input.clientId ? 'MANUAL_DESIGN_REQUIRED' : 'CLIENT_REQUIRED',
      notifyRequester: !input.requesterToldAtIntake,
      detail: 'Dispatched without an automatic Canva job; nothing was generated or spent.',
    });
  } catch (err) {
    log.warn(`[worker] Task ${input.taskId}: the refusal could not be reported to Core: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Restate orchestrates retries; Core journals model charges and Canva side effects. `recordOutcome`
 * writes an outcome Core would not take to the outbox instead (outcome-without-core.ts); without it
 * such an outcome is only logged.
 */
export async function runCanvaDraft(
  input: WorkflowInput,
  ctx: WorkflowDurableContext,
  fetcher: typeof fetch = fetch,
  recordOutcome?: OutcomeRecorder,
  lifecycle?: LifecycleOutcomeReporter
): Promise<WorkflowOutput> {
  const output = (status: string, documentId?: string): WorkflowOutput =>
    ({ taskId: input.taskId, status, documentId, qcPassed: false, auditEventsCount: 0, executedSteps: [], replayedSteps: [] });
  const call = coreClient(input, fetcher, lifecycle);
  // A re-drive is a new run of the same task: its keys must not collide with the first run's, or
  // Core would hand back the first run's (failed) answer instead of starting again.
  const runKey = Number.isInteger(input.redriveAttempt) && (input.redriveAttempt as number) > 0
    ? `${input.taskId}-redrive-${input.redriveAttempt}`
    : input.taskId;
  let result: any;

  /**
   * A studio run the workflow stops following used to be left at its stage: nothing abandoned it,
   * and Core refuses a new run for the task while one is unfinished, so a re-drive was refused as
   * "still being made" for good (2026-09-24). A run that has not settled when the workflow finishes
   * is one it gave up on (stuck, its resume step exhausted, still busy, refused), so it is abandoned
   * first, as a step of its own. A refusal (a run Core already settled) needs nothing more; a Core
   * that does not answer is left to Core's own handling of stale runs.
   */
  const abandonUnsettledRun = async (status: string, code?: string) => {
    if (typeof result?.runId !== 'string' || STUDIO_SETTLED.includes(String(result.status))) return;
    const runId: string = result.runId;
    try {
      await ctx.run('canva-studio-abandon', async () => {
        try {
          return await call('/canva/studio/' + encodeURIComponent(runId) + '/abandon', {
            reason: `The workflow stopped following this run: ${status}${code ? ` (${code})` : ''}.`,
          });
        } catch (err) {
          if (err instanceof CoreBoundaryError && err.terminal) return { abandoned: false, status: err.httpStatus, code: err.code };
          throw err;
        }
      });
    } catch (err) {
      if (!stepGaveUp(err)) throw err;
      log.warn(`[worker] Task ${input.taskId}: studio run ${runId} could not be abandoned: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * The report Core would not take, past the report step's own hour. The finished work used to end
   * there with nothing written anywhere, the task `received` and the requester waiting for good
   * (2026-09-24). The worker has the database: the requester's message, an office alert and the
   * report itself (sent again until Core takes it) go to the outbox, under keys per task and outcome.
   */
  const recordWithoutCore = async (status: string, report: Record<string, unknown>) => {
    if (!recordOutcome) {
      log.error(`[worker] Task ${input.taskId}: outcome ${status} could not be reported to Core, and there is no database to record it in.`);
      return;
    }
    try {
      const recorded = await ctx.run('canva-outcome-without-core-' + status.toLowerCase(), () =>
        recordOutcome({ tenantId: input.tenantId, taskId: input.taskId, report })
      );
      log.error(`[worker] Task ${input.taskId}: Core did not take outcome ${status}; recorded in the outbox instead: ${JSON.stringify(recorded)}`);
    } catch (err) {
      if (!stepGaveUp(err)) throw err;
      log.error(`[worker] Task ${input.taskId}: outcome ${status} was recorded neither by Core nor in the outbox: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Every terminal outcome is reported to the requester through Core. A failed chat message
  // must never fail (or retry) the workflow, so the notification swallows its own errors.
  const finish = async (
    status: string,
    designId?: string,
    code?: string,
    parity?: string,
    extra: { detail?: string; notifyRequester?: boolean } = {}
  ) => {
    await abandonUnsettledRun(status, code);
    const report = {
      status,
      designId,
      code,
      runId: result?.runId,
      ...(parity ? { parity, parityError: code } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
      ...(extra.notifyRequester === false ? { notifyRequester: false } : {}),
    };
    if (lifecycle) {
      lifecycle.report(report);
    } else {
      try {
        await reportOutcome(ctx, call, 'canva-notify-' + status.toLowerCase(), report);
      } catch (error) {
        if (!stepGaveUp(error)) throw error;
        await recordWithoutCore(status, report);
      }
    }
    return output(status, designId);
  };

  const handleBoundaryError = async (error: unknown, fallbackStatus: string = 'DESIGN_REJECTED', designId?: string) => {
    const boundary = boundaryOf(error);
    if (boundary?.terminal) {
      return finish(fallbackStatus, designId, boundary.code || `HTTP_${boundary.httpStatus}`);
    }
    if (stepGaveUp(error)) {
      // A refusal retried to the end of the step's window is reported as that refusal, as it was before.
      if (boundary?.retriedRefusal) return finish(fallbackStatus, designId, boundary.code);
      return finish('DESIGN_SERVER_ERROR', designId, boundary?.code || (boundary ? `HTTP_${boundary.httpStatus}` : 'RETRY_EXHAUSTED'));
    }
    throw error;
  };

  if (!input.canvaAutoGenerate) {
    return finish('MANUAL_DESIGN_REQUIRED', undefined, undefined, undefined, { notifyRequester: !input.requesterToldAtIntake });
  }
  if (!input.clientId) return finish('CLIENT_REQUIRED');
  let task: any;
  try {
    task = await ctx.run('canva-verify-task-scope', () => call(''));
  } catch (error) {
    return await handleBoundaryError(error, 'DESIGN_REJECTED');
  }
  // The task read above is already a durable workflow step. Use its persisted request owner to
  // refuse a direct TaskWorkflow/TaskService invocation before Studio or Canva can spend money.
  // A future DesignRun needs an owner-aware report path; the legacy status endpoint cannot record
  // this outcome, and retrying the invocation cannot change the owner. Check before the scope
  // mismatch handler so even a malformed direct invocation sends no legacy outcome.
  if (task.requestId && (!lifecycle || task.requestId !== lifecycle.requestId)) {
    log.warn(`[worker] Task ${input.taskId}: direct legacy workflow refused; RequestLifecycle owns ${task.requestId}.`);
    return output('LIFECYCLE_OWNED');
  }
  if (lifecycle && !task.requestId) {
    log.warn(`[worker] Task ${input.taskId}: DesignRun refused a task with no matching RequestLifecycle owner.`);
    return output('LIFECYCLE_OWNER_MISMATCH');
  }
  // A mismatch is final: retrying replays the same journalled answer. It used to be thrown outside
  // any step, as an ordinary error, so Restate retried the invocation without end and the requester,
  // promised "the link or an explanation", heard nothing. It now ends the run and is reported.
  if (task.clientId !== input.clientId || task.tenantId !== input.tenantId) {
    return finish('DESIGN_BLOCKED', undefined, 'SCOPE_MISMATCH', undefined, {
      detail: 'Workflow task/client/tenant mismatch: the dispatched client or tenant differs from the task record.',
    });
  }

  const variant = resolveCanvaVariant(input);
  // Still busy after the whole window: the run ends as a busy start always did, with Core's code. A
  // preview or check export Canva kept refusing ends as that step's failure, naming the design it has.
  const endBusy = (busy: CoreBusy, slot: 'studio' | 'planning' | 'export', status = 'DESIGN_SERVER_ERROR', designId?: string) =>
    finish(status, designId, busy.coreBusy, undefined, {
      detail: busy.coreBusy === 'CANVA_RATE_LIMITED'
        ? `Canva was still refusing new imports and exports with its rate limit (${busy.coreBusy}) after ${CORE_BUSY_WINDOW_MS / 60000} minutes of waiting.`
        : `Core was still busy (${busy.coreBusy}) after ${CORE_BUSY_WINDOW_MS / 60000} minutes of waiting for a free ${slot} slot.`,
    });
  if (input.designStudio) {
    const studioBody = {
      width: variant.width,
      height: variant.height,
      ...input.studioOptions,
    };
    try {
      result = await runUnlessBusy(ctx, 'canva-studio-start', () =>
        call('/canva/studio', studioBody, 'workflow-studio-' + runKey)
      );
    } catch (error) {
      return await handleBoundaryError(error, 'DESIGN_REJECTED');
    }
    if (isCoreBusy(result)) return endBusy(result, 'studio');
    let idlePolls = 0;
    let waitedMs = 0;
    let stuckStage: string | undefined;
    for (let n = 0; n < STUDIO_MAX_RESUMES && !STUDIO_SETTLED.includes(result.status); n++) {
      const wait = studioPollWaitMs(idlePolls);
      if (ctx.sleep) await ctx.sleep(wait);
      // Counted from what was asked for, never from a clock: a replay has to reach the same budget
      // at the same poll, and a wall-clock read would make that decision non-deterministic.
      waitedMs += wait;
      const before = String(result.status);
      let next: unknown;
      try {
        next = await runUnlessBusy(ctx, 'canva-studio-resume-' + n, () =>
          call(
            '/canva/studio/' + encodeURIComponent(result.runId) + '/resume',
            {},
            'workflow-studio-resume-' + runKey + '-' + result.runId + '-' + n
          )
        );
      } catch (error) {
        return await handleBoundaryError(error, 'DESIGN_REJECTED');
      }
      // The run's own answer is kept until then, so the report still names the run.
      if (isCoreBusy(next)) return endBusy(next, 'studio');
      result = next;
      if (String(result.status) !== before) {
        idlePolls = 0;
        continue;
      }
      idlePolls++;
      if (idlePolls >= STUDIO_IDLE_POLL_LIMIT || waitedMs >= STUDIO_IDLE_WAIT_BUDGET_MS) {
        stuckStage = before;
        break;
      }
    }
    if (stuckStage) {
      // The owner hears which stage stopped moving instead of waiting for a design that will never
      // arrive. Core's status handler strips everything that is not [A-Z0-9_] from `code` and
      // renders it in the Telegram message, so the stage travels in the code rather than in free text.
      return finish('DESIGN_STUCK', undefined, 'STUCK_IN_' + stuckStage.toUpperCase().replace(/[^A-Z0-9_]/g, '_'));
    }
    if (result.status === 'failed') {
      return finish('DESIGN_FAILED', undefined, studioFailureCode(result), undefined, {
        detail: detailOf(result.diagnostic) || detailOf(result.message) || detailOf(result.error),
      });
    }
    if (!['transferred', 'degraded'].includes(result.status)) {
      return finish('DESIGN_' + String(result.status).toUpperCase());
    }
  } else {
    try {
      // The first try keeps its step name, so an invocation journalled before ADR-131 replays unchanged.
      result = await runUnlessBusy(ctx, 'canva-create-draft', () => call('/canva/generate', variant, 'workflow-' + runKey));
    } catch (error) {
      return await handleBoundaryError(error, 'DESIGN_REJECTED');
    }
    if (isCoreBusy(result)) return endBusy(result, 'planning');
    for (let n = 0; n < 30 && ['planning', 'submitted', 'creating'].includes(result.status); n++) {
      if (ctx.sleep) await ctx.sleep(2000);
      const planId: string = result.planId;
      let next: any;
      try {
        // A resume that sends the saved plan to Canva meets Canva's rate limit like the generation does.
        next = await runUnlessBusy(ctx, 'canva-resume-draft-' + n, () => call('/canva/plans/' + encodeURIComponent(planId) + '/resume', {}));
      } catch (error) {
        return await handleBoundaryError(error, 'DESIGN_REJECTED');
      }
      if (isCoreBusy(next)) return endBusy(next, 'planning');
      result = next;
    }
    if (result.status !== 'retrieved') return finish('DESIGN_' + String(result.status).toUpperCase());
  }
  let state: any;
  try {
    state = await ctx.run('canva-read-binding', () => call('/canva'));
  } catch (error) {
    return await handleBoundaryError(error, 'DESIGN_REJECTED', result?.designId);
  }
  if (result.status === 'degraded' && !result.designId && state.binding?.designId) {
    result.designId = state.binding.designId;
  }
  // Final, like the scope check above: reported, never retried. No design id is passed on, because
  // which design belongs to the task is exactly what is in doubt.
  if (!result.designId || state.binding?.designId !== result.designId) {
    return finish('DESIGN_BLOCKED', undefined, 'BINDING_MISMATCH', undefined, {
      detail: `Workflow binding differs from imported document (imported ${result.designId || 'none'}, bound ${state.binding?.designId || 'none'}).`,
    });
  }
  let currentBindingVersion = state.binding?.version;
  let capture: any;
  try {
    capture = await runUnlessBusy(ctx, 'canva-export-preview', () => call('/canva/exports', { format: 'png', expectedVersion: currentBindingVersion }, 'workflow-preview-' + runKey));
    for (let n = 0; n < 30 && !isCoreBusy(capture) && ['submitted', 'creating'].includes(capture.status); n++) {
      if (ctx.sleep) await ctx.sleep(2000);
      capture = await ctx.run('canva-resume-preview-' + n, () => call('/canva/exports/' + encodeURIComponent(capture.operationId) + '/resume', {}));
    }
  } catch (error) {
    return await handleBoundaryError(error, 'CANVA_PREVIEW_FAILED', result?.designId);
  }
  if (isCoreBusy(capture)) return endBusy(capture, 'export', 'CANVA_PREVIEW_FAILED', result.designId);
  // Canva may finish settling an import during the first export. A stale capture
  // stays rejected; take at most two new snapshots without regenerating the design.
  for (let attempt = 1; attempt <= 2 && capture.status === 'stale'; attempt++) {
    if (ctx.sleep) await ctx.sleep(2000);
    let fresh: any;
    try {
      fresh = await ctx.run('canva-preview-refresh-binding-' + attempt, () => call('/canva'));
    } catch (error) {
      return await handleBoundaryError(error, 'CANVA_PREVIEW_FAILED', result?.designId);
    }
    if (fresh.binding?.designId !== result.designId) {
      return finish('DESIGN_BLOCKED', undefined, 'BINDING_MISMATCH', undefined, {
        detail: `Workflow binding changed during preview recovery (imported ${result.designId}, now bound ${fresh.binding?.designId || 'none'}).`,
      });
    }
    currentBindingVersion = fresh.binding.version;
    try {
      capture = await runUnlessBusy(ctx, 'canva-preview-recovery-' + attempt, () => call('/canva/exports', { format: 'png', expectedVersion: currentBindingVersion }, 'workflow-preview-' + runKey + '-retry-' + attempt));
      for (let n = 0; n < 30 && !isCoreBusy(capture) && ['submitted', 'creating'].includes(capture.status); n++) {
        if (ctx.sleep) await ctx.sleep(2000);
        capture = await ctx.run('canva-resume-preview-recovery-' + attempt + '-' + n, () => call('/canva/exports/' + encodeURIComponent(capture.operationId) + '/resume', {}));
      }
    } catch (error) {
      return await handleBoundaryError(error, 'CANVA_PREVIEW_FAILED', result?.designId);
    }
    if (isCoreBusy(capture)) return endBusy(capture, 'export', 'CANVA_PREVIEW_FAILED', result.designId);
  }
  if (capture.status !== 'retrieved') return finish('CANVA_PREVIEW_' + String(capture.status).toUpperCase(), result.designId);
  let check: any;
  try {
    check = await runUnlessBusy(ctx, 'canva-export-copy-font-check', () => call('/canva/exports', { format: 'pptx', expectedVersion: currentBindingVersion }, 'workflow-check-' + runKey));
    for (let n = 0; n < 30 && !isCoreBusy(check) && ['submitted', 'creating'].includes(check.status); n++) {
      if (ctx.sleep) await ctx.sleep(2000);
      check = await ctx.run('canva-resume-copy-font-check-' + n, () => call('/canva/exports/' + encodeURIComponent(check.operationId) + '/resume', {}));
    }
  } catch (error) {
    return await handleBoundaryError(error, 'CANVA_CHECK_REQUIRED', result?.designId);
  }
  if (isCoreBusy(check)) return endBusy(check, 'export', 'CANVA_CHECK_REQUIRED', result.designId);
  if (check.status !== 'retrieved' || !check.artifact?.content_check) return finish('CANVA_CHECK_REQUIRED', result.designId);
  if (!check.artifact.content_check.copyPass) return finish('CANVA_COPY_MISMATCH', result.designId);
  if (!check.artifact.content_check.fontPass) return finish('CANVA_FONT_MISMATCH', result.designId);

  let parity = 'unknown';
  let parityError: string | undefined;

  if (input.designStudio) {
    try {
      // Every other step here keeps retrying through a Core restart (index.ts). Parity pays a vision
      // model on every call and Core keeps no earlier answer, so it keeps the short bound: a restart
      // costs this courtesy check, reported as unavailable, not a model bill per retry.
      //
      // An answer from Core (a 5xx) or no answer within the call's timeout means Core ran the check,
      // which is where the model is paid: the five quick attempts were five vision calls for one
      // question (2026-09-24). Such a failure is final; only a Core that never answered is retried.
      const pRes = await ctx.run('canva-parity-check', async () => {
        try {
          return await call('/canva/parity-check', { runId: result?.runId });
        } catch (err) {
          const answered = err instanceof CoreBoundaryError && err.httpStatus >= 500;
          const timedOut = (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError';
          if (answered || timedOut) throw new WorkflowTerminalError((err as Error).message, err instanceof CoreBoundaryError ? err.code : 'PARITY_TIMEOUT');
          throw err;
        }
      }, { maxRetryAttempts: 5 });
      // An answer without a verdict is not a match: it used to be counted as one (2026-09-24).
      if (typeof pRes?.parity === 'string' && pRes.parity.trim()) {
        parity = pRes.parity;
      } else {
        parity = 'unavailable';
        parityError = 'PARITY_NO_VERDICT';
      }
    } catch (err: any) {
      const boundary = boundaryOf(err);
      parity = 'unavailable';
      // Restate's TerminalError carries a numeric `code` (its HTTP status); the workflow's own code is on its cause.
      const named = [err?.code, err?.cause?.code].find((v) => typeof v === 'string');
      parityError = boundary?.code || named || (boundary?.httpStatus ? `HTTP_${boundary.httpStatus}` : 'PARITY_ERROR');
    }
  }

  return finish(
    'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW',
    result.designId,
    parity === 'unavailable' ? parityError : undefined,
    parity
  );
}
