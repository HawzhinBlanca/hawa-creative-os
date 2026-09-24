import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client.js';
import { reasonOf, type Reading } from './statusReport.js';

/**
 * The Desk's server state (ADR-037, architecture programme 1.5, 2026-09-24).
 *
 * One QueryClient per tab holds every answer Core gave the query layer. The Desk used to keep each
 * screen's copy by hand, with its own timers, paging and 401 handling; the review of 2026-09-24 found
 * a queue that never refreshed, a failed read shown as "no changes", and an expired session that froze
 * every screen but one. Here:
 *
 * - an answer is fresh for 30 s (a screen shown again within that reads nothing);
 * - a refused read (401, 403) is not retried; any other failure is retried at most twice;
 * - a mutation is never retried: approving or requesting changes has side effects on the server;
 * - every 401, from a query or a mutation, goes to one handler, which ends the session once.
 */

/** How long an answer counts as current. */
export const STALE_MS = 30_000;
/** The list's and the session's poll, run only while the event stream is down (services/liveUpdates.ts). */
export const POLL_WHILE_STREAM_DOWN_MS = 30_000;
/** Retries after the first failure, for reads that were not refused. */
export const MAX_RETRIES = 2;

export const isUnauthorized = (error: unknown): error is ApiError => error instanceof ApiError && error.status === 401;

/** TanStack's `retry` option: never for 401 or 403 (asking again gets the same answer), else at most twice. */
export function retryUnlessRefused(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false;
  return failureCount < MAX_RETRIES;
}

/** `onUnauthorized` is called for every 401 a query or mutation meets; it must be idempotent. */
export function createDeskQueryClient(onUnauthorized: (error: ApiError) => void): QueryClient {
  const onError = (error: unknown) => {
    if (isUnauthorized(error)) onUnauthorized(error);
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: { staleTime: STALE_MS, retry: retryUnlessRefused },
      mutations: { retry: false },
    },
  });
}

/** A query's answer as the screens show a status (services/statusReport.ts): loading, known or unknown. */
export function readingOf<T>(query: { status: 'pending' | 'error' | 'success'; data?: T; error: unknown }): Reading<T> {
  if (query.status === 'success') return { state: 'known', value: query.data as T };
  if (query.status === 'error') return { state: 'unknown', reason: reasonOf(query.error) };
  return { state: 'loading' };
}

/** What the Work queue shows: a filter, a search and the page (by the cursor that starts it). */
export interface TaskPageView {
  filter: string;
  search: string;
  /** Null: the newest page. */
  cursor: string | null;
}

/**
 * Query keys. `['tasks', …]` are the list's pages and `['task', id, …]` one task's detail and history,
 * so a task event invalidates `['tasks']` and `['task', id]` and reaches every page and both reads.
 */
export const queryKeys = {
  tasks: ['tasks'] as const,
  taskPage: (view: TaskPageView) => ['tasks', view] as const,
  task: (taskId: string) => ['task', taskId] as const,
  taskDetail: (taskId: string) => ['task', taskId, 'detail'] as const,
  taskTimeline: (taskId: string) => ['task', taskId, 'timeline'] as const,
  session: ['session'] as const,
  health: ['health'] as const,
};
