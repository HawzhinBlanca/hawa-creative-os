/**
 * The RequestLifecycle object's line to Core's projection endpoint (architecture programme Phase 2,
 * slice 2.3; PHASE2_DESIGN.md section 2.8, ADR-034):
 * POST /v1/internal/lifecycle/:requestId/project, with HAWA_WORKER_TOKEN, never the operator's bearer.
 *
 * What each answer means to the object, which journals the answer as its `project:<rev>` step:
 * - 200: the projection, applied now or replayed from Core's record of the same key;
 * - 409 AHEAD / STALE_REVISION / KEY_REUSED: a conflict, answered (the object acts on it);
 * - a refusal of the ops themselves (400, 404, a 422 other than OP_NOT_AVAILABLE): answered, final;
 * - no answer, a 5xx, 408 or 429, or a fault of this deployment rather than of the event (the token
 *   refused, a Core too old to have an op, no database): thrown, so the step asks again. Only the
 *   design outcome's step gives up (after 30 minutes); every other event waits for Core.
 */
import type { ProjectionConflict, ProjectionRequest, ProjectionResponse } from '@hawa/contracts';
import { requestIdHeaders } from '../logging.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ProjectionAnswer =
  | { kind: 'projected'; response: ProjectionResponse }
  | { kind: 'conflict'; conflict: ProjectionConflict }
  | { kind: 'refused'; status: number; code: string; message: string };

export interface ProjectionCore {
  project(requestId: string, body: ProjectionRequest): Promise<ProjectionAnswer>;
}

export interface ProjectionCoreOptions {
  /** Core's address on the internal network, e.g. http://core:3001. */
  baseUrl: string;
  /** HAWA_WORKER_TOKEN. */
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** Codes that name a fault of this deployment, not of the event: the step waits for it to be fixed. */
const WAIT_CODES = new Set(['OP_NOT_AVAILABLE', 'DATABASE_UNAVAILABLE']);
const CONFLICTS = new Set(['AHEAD', 'STALE_REVISION', 'KEY_REUSED']);

export function createProjectionCore(options: ProjectionCoreOptions): ProjectionCore {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  return {
    async project(requestId: string, body: ProjectionRequest): Promise<ProjectionAnswer> {
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/internal/lifecycle/${encodeURIComponent(requestId)}/project`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json', ...requestIdHeaders() },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
        });
      } catch (err) {
        throw new Error(`Core did not answer projection ${body.key}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const answer = (await res.json().catch(() => null)) as (Record<string, unknown> & { code?: string; detail?: string }) | null;
      if (res.ok) return { kind: 'projected', response: answer as unknown as ProjectionResponse };
      const code = typeof answer?.code === 'string' ? answer.code : '';
      const what = `Core answered HTTP ${res.status}${code ? ` ${code}` : ''} to projection ${body.key}${answer?.detail ? `: ${String(answer.detail).slice(0, 300)}` : ''}`;
      if (res.status === 409 && CONFLICTS.has(code)) {
        return {
          kind: 'conflict',
          conflict: {
            code: code as ProjectionConflict['code'],
            pgRev: Number(answer?.pgRev ?? -1),
            expectedRev: Number(answer?.expectedRev ?? body.expectedRev),
            rev: Number(answer?.rev ?? body.rev),
          },
        };
      }
      if (res.status >= 500 || res.status === 408 || res.status === 429 || res.status === 401 || res.status === 403 || WAIT_CODES.has(code)) {
        throw new Error(what);
      }
      return { kind: 'refused', status: res.status, code: code || `HTTP_${res.status}`, message: what };
    },
  };
}

/** Core's client from the environment, or null while the worker has no HAWA_WORKER_TOKEN (events then wait). */
export function projectionCoreFromEnv(env: Record<string, string | undefined> = process.env, fetcher?: FetchLike): ProjectionCore | null {
  const token = env.HAWA_WORKER_TOKEN?.trim();
  if (!token) return null;
  return createProjectionCore({ baseUrl: env.HAWA_CORE_INTERNAL_URL || 'http://core:3001', token, ...(fetcher ? { fetch: fetcher } : {}) });
}
