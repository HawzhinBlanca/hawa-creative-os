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

const boundaryOf = (error: unknown): CoreBoundaryError | null =>
  error instanceof CoreBoundaryError ? error : (error as any)?.cause instanceof CoreBoundaryError ? (error as any).cause : null;

/** Historical tasks carried no requested size; the print-oriented portrait default stays for them. */
export const DEFAULT_CANVA_VARIANT = { width: 1200, height: 1697 } as const;

export function resolveCanvaVariant(input: Pick<WorkflowInput, 'canvaVariant'>): { width: number; height: number } {
  const v = input.canvaVariant;
  const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 640 && (n as number) <= 2400;
  return v && ok(v.width) && ok(v.height) ? { width: v.width, height: v.height } : { ...DEFAULT_CANVA_VARIANT };
}

/** Restate orchestrates retries; Core journals model charges and Canva side effects. */
export async function runCanvaDraft(input: WorkflowInput, ctx: WorkflowDurableContext, fetcher: typeof fetch = fetch): Promise<WorkflowOutput> {
  const output = (status: string, documentId?: string): WorkflowOutput =>
    ({ taskId: input.taskId, status, documentId, qcPassed: false, auditEventsCount: 0, executedSteps: [], replayedSteps: [] });
  const base = process.env.HAWA_CORE_INTERNAL_URL || 'http://core:3001';
  const token = process.env.HAWA_BEARER_TOKEN;
  if (!token) throw new Error('Worker Core credential is not configured');
  const call = async (path: string, body?: unknown, key?: string) => {
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
  let result: any;
  // Every terminal outcome is reported to the requester through Core. A failed chat message
  // must never fail (or retry) the workflow, so the notification swallows its own errors.
  const finish = async (status: string, designId?: string, code?: string, parity?: string) => {
    await ctx.run('canva-notify-' + status.toLowerCase(), () =>
      call('/notifications/canva-status', {
        status,
        designId,
        code,
        runId: result?.runId,
        ...(parity ? { parity, parityError: code } : {}),
      }).catch(() => ({}))
    );
    return output(status, designId);
  };

  if (!input.canvaAutoGenerate) return finish('MANUAL_DESIGN_REQUIRED');
  if (!input.clientId) return finish('CLIENT_REQUIRED');
  const task = await ctx.run('canva-verify-task-scope', () => call(''));
  if (task.clientId !== input.clientId || task.tenantId !== input.tenantId) throw new WorkflowTerminalError('Workflow task/client/tenant mismatch', 'SCOPE_MISMATCH');

  const variant = resolveCanvaVariant(input);
  if (input.designStudio) {
    const studioBody = {
      width: variant.width,
      height: variant.height,
      ...input.studioOptions,
    };
    try {
      result = await ctx.run('canva-studio-start', () =>
        call('/canva/studio', studioBody, 'workflow-studio-' + input.taskId)
      );
    } catch (error) {
      const boundary = boundaryOf(error);
      if (boundary?.terminal) return finish('DESIGN_REJECTED', undefined, boundary.code || `HTTP_${boundary.httpStatus}`);
      throw error;
    }
    for (let n = 0; n < 150 && !['transferred', 'degraded', 'failed'].includes(result.status); n++) {
      if (ctx.sleep) await ctx.sleep(5000);
      try {
        result = await ctx.run('canva-studio-resume-' + n, () =>
          call('/canva/studio/' + encodeURIComponent(result.runId) + '/resume', {})
        );
      } catch (error) {
        const boundary = boundaryOf(error);
        if (boundary?.terminal) return finish('DESIGN_REJECTED', undefined, boundary.code || `HTTP_${boundary.httpStatus}`);
        throw error;
      }
    }
    if (result.status === 'failed') {
      const code = result.code || result.diagnostic || result.error || 'STUDIO_FAILED';
      return finish('DESIGN_FAILED', undefined, code);
    }
    if (!['transferred', 'degraded'].includes(result.status)) {
      return finish('DESIGN_' + String(result.status).toUpperCase());
    }
  } else {
    try {
      result = await ctx.run('canva-create-draft', () => call('/canva/generate', variant, 'workflow-' + input.taskId));
    } catch (error) {
      const boundary = boundaryOf(error);
      if (boundary?.terminal) return finish('DESIGN_REJECTED', undefined, boundary.code || `HTTP_${boundary.httpStatus}`);
      throw error;
    }
    for (let n = 0; n < 30 && ['planning', 'submitted', 'creating'].includes(result.status); n++) {
      if (ctx.sleep) await ctx.sleep(2000);
      try {
        result = await ctx.run('canva-resume-draft-' + n, () => call('/canva/plans/' + encodeURIComponent(result.planId) + '/resume', {}));
      } catch (error) {
        const boundary = boundaryOf(error);
        if (boundary?.terminal) return finish('DESIGN_REJECTED', undefined, boundary.code || `HTTP_${boundary.httpStatus}`);
        throw error;
      }
    }
    if (result.status !== 'retrieved') return finish('DESIGN_' + String(result.status).toUpperCase());
  }
  let state: any;
  try {
    state = await ctx.run('canva-read-binding', () => call('/canva'));
  } catch (error) {
    const boundary = boundaryOf(error);
    if (boundary?.terminal) return finish('DESIGN_REJECTED', result.designId, boundary.code || `HTTP_${boundary.httpStatus}`);
    throw error;
  }
  if (result.status === 'degraded' && !result.designId && state.binding?.designId) {
    result.designId = state.binding.designId;
  }
  if (!result.designId || state.binding?.designId !== result.designId) throw new WorkflowTerminalError('Workflow binding differs from imported document', 'BINDING_MISMATCH');
  let currentBindingVersion = state.binding?.version;
  let capture: any;
  try {
    capture = await ctx.run('canva-export-preview', () => call('/canva/exports', { format: 'png', expectedVersion: currentBindingVersion }, 'workflow-preview-' + input.taskId));
    for (let n = 0; n < 30 && ['submitted', 'creating'].includes(capture.status); n++) {
      if (ctx.sleep) await ctx.sleep(2000);
      capture = await ctx.run('canva-resume-preview-' + n, () => call('/canva/exports/' + encodeURIComponent(capture.operationId) + '/resume', {}));
    }
  } catch (error) {
    const boundary = boundaryOf(error);
    if (boundary?.terminal) return finish('CANVA_PREVIEW_FAILED', result.designId, boundary.code || `HTTP_${boundary.httpStatus}`);
    throw error;
  }
  // Canva may finish settling an import during the first export. A stale capture
  // stays rejected; take at most two new snapshots without regenerating the design.
  for (let attempt = 1; attempt <= 2 && capture.status === 'stale'; attempt++) {
    if (ctx.sleep) await ctx.sleep(2000);
    let fresh: any;
    try {
      fresh = await ctx.run('canva-preview-refresh-binding-' + attempt, () => call('/canva'));
    } catch (error) {
      const boundary = boundaryOf(error);
      if (boundary?.terminal) return finish('CANVA_PREVIEW_FAILED', result.designId, boundary.code || `HTTP_${boundary.httpStatus}`);
      throw error;
    }
    if (fresh.binding?.designId !== result.designId) throw new WorkflowTerminalError('Workflow binding changed during preview recovery', 'BINDING_MISMATCH');
    currentBindingVersion = fresh.binding.version;
    try {
      capture = await ctx.run('canva-preview-recovery-' + attempt, () => call('/canva/exports', { format: 'png', expectedVersion: currentBindingVersion }, 'workflow-preview-' + input.taskId + '-retry-' + attempt));
      for (let n = 0; n < 30 && ['submitted', 'creating'].includes(capture.status); n++) {
        if (ctx.sleep) await ctx.sleep(2000);
        capture = await ctx.run('canva-resume-preview-recovery-' + attempt + '-' + n, () => call('/canva/exports/' + encodeURIComponent(capture.operationId) + '/resume', {}));
      }
    } catch (error) {
      const boundary = boundaryOf(error);
      if (boundary?.terminal) return finish('CANVA_PREVIEW_FAILED', result.designId, boundary.code || `HTTP_${boundary.httpStatus}`);
      throw error;
    }
  }
  if (capture.status !== 'retrieved') return finish('CANVA_PREVIEW_' + String(capture.status).toUpperCase(), result.designId);
  let check: any;
  try {
    check = await ctx.run('canva-export-copy-font-check', () => call('/canva/exports', { format: 'pptx', expectedVersion: currentBindingVersion }, 'workflow-check-' + input.taskId));
    for (let n = 0; n < 30 && ['submitted', 'creating'].includes(check.status); n++) {
      if (ctx.sleep) await ctx.sleep(2000);
      check = await ctx.run('canva-resume-copy-font-check-' + n, () => call('/canva/exports/' + encodeURIComponent(check.operationId) + '/resume', {}));
    }
  } catch (error) {
    const boundary = boundaryOf(error);
    if (boundary?.terminal) return finish('CANVA_CHECK_REQUIRED', result.designId);
    throw error;
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

