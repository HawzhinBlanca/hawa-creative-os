import type { WorkflowDurableContext } from './durable-context.js';
import type { WorkflowInput, WorkflowOutput } from './workflow.js';

/**
 * A failure that retrying can never fix (rejected request, scope mismatch). The Restate
 * adapter in index.ts converts it into a TerminalError so the engine stops retrying.
 */
export class WorkflowTerminalError extends Error {
  readonly terminal = true;
  constructor(message: string, readonly code?: string) { super(message); this.name = 'WorkflowTerminalError'; }
}

/** Core answered with an HTTP error. 4xx (except 408/429) is terminal: the request itself was refused. */
export class CoreBoundaryError extends Error {
  readonly terminal: boolean;
  constructor(readonly httpStatus: number, readonly code?: string) {
    super(`Canva workflow Core boundary HTTP ${httpStatus}${code ? ` ${code}` : ''}`);
    this.name = 'CoreBoundaryError';
    this.terminal = httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429;
  }
}

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
function coreClient(input: Pick<WorkflowInput, 'taskId'>, fetcher: typeof fetch): CoreCall {
  const base = process.env.HAWA_CORE_INTERNAL_URL || 'http://core:3001';
  const token = process.env.HAWA_BEARER_TOKEN;
  if (!token) throw new Error('Worker Core credential is not configured');
  return async (path: string, body?: unknown, key?: string) => {
    const res = await fetcher(base + '/v1/tasks/' + encodeURIComponent(input.taskId) + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(300000),
    });
    if (!res.ok) {
      let code: string | undefined;
      try { const problem: any = await res.json(); code = [problem?.title, problem?.error, problem?.code].find((v) => typeof v === 'string'); } catch { /* no body */ }
      throw new CoreBoundaryError(res.status, code ? String(code).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64) : undefined);
    }
    return res.json() as Promise<any>;
  };
}

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
  });
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
  if (/BUDGET_EXHAUSTED/i.test(text)) return 'BUDGET_EXHAUSTED';
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
    console.warn(`[worker] Task ${input.taskId}: the refusal could not be reported to Core: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Restate orchestrates retries; Core journals model charges and Canva side effects. */
export async function runCanvaDraft(input: WorkflowInput, ctx: WorkflowDurableContext, fetcher: typeof fetch = fetch): Promise<WorkflowOutput> {
  const output = (status: string, documentId?: string): WorkflowOutput =>
    ({ taskId: input.taskId, status, documentId, qcPassed: false, auditEventsCount: 0, executedSteps: [], replayedSteps: [] });
  const call = coreClient(input, fetcher);
  // A re-drive is a new run of the same task: its keys must not collide with the first run's, or
  // Core would hand back the first run's (failed) answer instead of starting again.
  const runKey = Number.isInteger(input.redriveAttempt) && (input.redriveAttempt as number) > 0
    ? `${input.taskId}-redrive-${input.redriveAttempt}`
    : input.taskId;
  let result: any;
  // Every terminal outcome is reported to the requester through Core. A failed chat message
  // must never fail (or retry) the workflow, so the notification swallows its own errors.
  const finish = async (
    status: string,
    designId?: string,
    code?: string,
    parity?: string,
    extra: { detail?: string; notifyRequester?: boolean } = {}
  ) => {
    await reportOutcome(ctx, call, 'canva-notify-' + status.toLowerCase(), {
      status,
      designId,
      code,
      runId: result?.runId,
      ...(parity ? { parity, parityError: code } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
      ...(extra.notifyRequester === false ? { notifyRequester: false } : {}),
    });
    return output(status, designId);
  };

  const handleBoundaryError = async (error: unknown, fallbackStatus: string = 'DESIGN_REJECTED', designId?: string) => {
    const boundary = boundaryOf(error);
    if (boundary?.terminal) {
      return finish(fallbackStatus, designId, boundary.code || `HTTP_${boundary.httpStatus}`);
    }
    const isExhaustedOrTerminal = Boolean(
      (error as any)?.name === 'TerminalError' ||
      (error as any)?.terminal ||
      (error as any)?.cause?.terminal ||
      String((error as any)?.name).includes('Terminal') ||
      String((error as any)?.message).includes('terminal workflow failure')
    );
    if (isExhaustedOrTerminal) {
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
  // A mismatch is final: retrying replays the same journalled answer. It used to be thrown outside
  // any step, as an ordinary error, so Restate retried the invocation without end and the requester,
  // promised "the link or an explanation", heard nothing. It now ends the run and is reported.
  if (task.clientId !== input.clientId || task.tenantId !== input.tenantId) {
    return finish('DESIGN_BLOCKED', undefined, 'SCOPE_MISMATCH', undefined, {
      detail: 'Workflow task/client/tenant mismatch: the dispatched client or tenant differs from the task record.',
    });
  }

  const variant = resolveCanvaVariant(input);
  if (input.designStudio) {
    const studioBody = {
      width: variant.width,
      height: variant.height,
      ...input.studioOptions,
    };
    try {
      result = await ctx.run('canva-studio-start', () =>
        call('/canva/studio', studioBody, 'workflow-studio-' + runKey)
      );
    } catch (error) {
      return await handleBoundaryError(error, 'DESIGN_REJECTED');
    }
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
      try {
        result = await ctx.run('canva-studio-resume-' + n, () =>
          call(
            '/canva/studio/' + encodeURIComponent(result.runId) + '/resume',
            {},
            'workflow-studio-resume-' + runKey + '-' + result.runId + '-' + n
          )
        );
      } catch (error) {
        return await handleBoundaryError(error, 'DESIGN_REJECTED');
      }
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
      result = await ctx.run('canva-create-draft', () => call('/canva/generate', variant, 'workflow-' + runKey));
    } catch (error) {
      return await handleBoundaryError(error, 'DESIGN_REJECTED');
    }
    for (let n = 0; n < 30 && ['planning', 'submitted', 'creating'].includes(result.status); n++) {
      if (ctx.sleep) await ctx.sleep(2000);
      try {
        result = await ctx.run('canva-resume-draft-' + n, () => call('/canva/plans/' + encodeURIComponent(result.planId) + '/resume', {}));
      } catch (error) {
        return await handleBoundaryError(error, 'DESIGN_REJECTED');
      }
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
    capture = await ctx.run('canva-export-preview', () => call('/canva/exports', { format: 'png', expectedVersion: currentBindingVersion }, 'workflow-preview-' + runKey));
    for (let n = 0; n < 30 && ['submitted', 'creating'].includes(capture.status); n++) {
      if (ctx.sleep) await ctx.sleep(2000);
      capture = await ctx.run('canva-resume-preview-' + n, () => call('/canva/exports/' + encodeURIComponent(capture.operationId) + '/resume', {}));
    }
  } catch (error) {
    return await handleBoundaryError(error, 'CANVA_PREVIEW_FAILED', result?.designId);
  }
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
      capture = await ctx.run('canva-preview-recovery-' + attempt, () => call('/canva/exports', { format: 'png', expectedVersion: currentBindingVersion }, 'workflow-preview-' + runKey + '-retry-' + attempt));
      for (let n = 0; n < 30 && ['submitted', 'creating'].includes(capture.status); n++) {
        if (ctx.sleep) await ctx.sleep(2000);
        capture = await ctx.run('canva-resume-preview-recovery-' + attempt + '-' + n, () => call('/canva/exports/' + encodeURIComponent(capture.operationId) + '/resume', {}));
      }
    } catch (error) {
      return await handleBoundaryError(error, 'CANVA_PREVIEW_FAILED', result?.designId);
    }
  }
  if (capture.status !== 'retrieved') return finish('CANVA_PREVIEW_' + String(capture.status).toUpperCase(), result.designId);
  let check: any;
  try {
    check = await ctx.run('canva-export-copy-font-check', () => call('/canva/exports', { format: 'pptx', expectedVersion: currentBindingVersion }, 'workflow-check-' + runKey));
    for (let n = 0; n < 30 && ['submitted', 'creating'].includes(check.status); n++) {
      if (ctx.sleep) await ctx.sleep(2000);
      check = await ctx.run('canva-resume-copy-font-check-' + n, () => call('/canva/exports/' + encodeURIComponent(check.operationId) + '/resume', {}));
    }
  } catch (error) {
    return await handleBoundaryError(error, 'CANVA_CHECK_REQUIRED', result?.designId);
  }
  if (check.status !== 'retrieved' || !check.artifact?.content_check) return finish('CANVA_CHECK_REQUIRED', result.designId);
  if (!check.artifact.content_check.copyPass) return finish('CANVA_COPY_MISMATCH', result.designId);
  if (!check.artifact.content_check.fontPass) return finish('CANVA_FONT_MISMATCH', result.designId);

  let parity = 'unknown';
  let parityError: string | undefined;

  if (input.designStudio) {
    try {
      const pRes = await ctx.run('canva-parity-check', () =>
        call('/canva/parity-check', { runId: result?.runId })
      );
      parity = pRes?.parity || 'match';
    } catch (err: any) {
      const boundary = boundaryOf(err);
      parity = 'unavailable';
      parityError = boundary?.code || err?.code || (boundary?.httpStatus ? `HTTP_${boundary.httpStatus}` : 'PARITY_ERROR');
    }
  }

  return finish(
    'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW',
    result.designId,
    parity === 'unavailable' ? parityError : undefined,
    parity
  );
}

