import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { TASK_EVENTS, type StreamConnectionStatus } from './eventStream.js';
import { POLL_WHILE_STREAM_DOWN_MS, queryKeys } from './queryClient.js';

/**
 * Task events from the live stream, applied to the query cache (ADR-037, 2026-09-24).
 *
 * The Work screen used to refresh itself: a 30 s poll, a read 1 s after each task event, a hand-made
 * debounce, one subscription per screen. Now one stream per tab feeds the cache:
 *
 * - a task event invalidates the list (`['tasks']`) and the task it names (`['task', id]`); events are
 *   applied together once 300 ms pass without another (at the latest 1 s after the first), so a burst
 *   from one design run costs one read of the page on screen, and of each task it named. A fixed
 *   300 ms window cost one read per window for a run spread over longer, and each new invalidation
 *   cancelled the read still under way;
 * - after the stream reconnects, everything is invalidated: events sent while it was away are lost;
 * - in a hidden tab the queries are only marked stale; the tab reads them once when it is shown
 *   (TanStack's refetch on focus), not once per event while nobody looks;
 * - polling (`refetchInterval`) runs only while the stream is down (`usePollInterval`).
 *
 * Nothing here changes a cached answer: it only says which answers to read again.
 */

/** The pause after the last task event before the cache is told. */
export const COALESCE_MS = 300;
/** Under a steady stream of events, the cache is told at least this often. */
export const COALESCE_MAX_WAIT_MS = 1_000;

/** The part of the event stream (services/eventStream.ts) the Desk's server state uses. */
export interface LiveEventSource {
  on(event: string, handler: (data: unknown) => void): () => void;
  onStatusChange(handler: (status: StreamConnectionStatus) => void): () => void;
  getStatus(): StreamConnectionStatus;
  connect(): void;
  disconnect(): void;
}

/** The part of `document` this file uses. */
export interface VisibilitySource {
  readonly hidden: boolean;
}

export interface BridgeTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserTimers: BridgeTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The task an event names. Core's payloads name it as `taskId`, as `task.id`, or (task:created) as `id`. */
export function taskIdOf(data: unknown): string | undefined {
  const payload = (data ?? {}) as { taskId?: unknown; task?: { id?: unknown }; id?: unknown };
  const id = payload.taskId ?? payload.task?.id ?? payload.id;
  return typeof id === 'string' && id ? id : undefined;
}

/** Starts applying the stream's task events to the cache. Returns the stop. Run once per tab. */
export function bridgeTaskEvents(input: {
  queryClient: QueryClient;
  stream: Pick<LiveEventSource, 'on' | 'onStatusChange'>;
  doc?: VisibilitySource;
  events?: readonly string[];
  windowMs?: number;
  timers?: BridgeTimers;
}): () => void {
  const { queryClient, stream, doc } = input;
  const events = input.events ?? TASK_EVENTS;
  const windowMs = input.windowMs ?? COALESCE_MS;
  const timers = input.timers ?? browserTimers;

  let pending: unknown = null;
  let deadline: unknown = null;
  const named = new Set<string>();
  let up = false;
  let wasUp = false;

  // A hidden tab marks the answers stale and reads nothing; showing it reads them (refetch on focus).
  const refetchType = () => (doc?.hidden ? 'none' : 'active');

  const flush = () => {
    if (pending !== null) timers.clearTimeout(pending);
    if (deadline !== null) timers.clearTimeout(deadline);
    pending = null;
    deadline = null;
    const ids = [...named];
    named.clear();
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks, refetchType: refetchType() });
    for (const id of ids) void queryClient.invalidateQueries({ queryKey: queryKeys.task(id), refetchType: refetchType() });
  };

  const onTaskEvent = (data: unknown) => {
    const id = taskIdOf(data);
    if (id) named.add(id);
    if (pending !== null) timers.clearTimeout(pending);
    pending = timers.setTimeout(flush, windowMs);
    if (deadline === null) deadline = timers.setTimeout(flush, Math.max(windowMs, COALESCE_MAX_WAIT_MS));
  };

  const unsubscribers = events.map((name) => stream.on(name, onTaskEvent));
  unsubscribers.push(
    stream.onStatusChange((status) => {
      const nowUp = status === 'connected';
      // Back after a drop: whatever changed meanwhile was never heard. The first connection needs
      // nothing: the screens have just read what they show.
      if (nowUp && !up && wasUp) void queryClient.invalidateQueries({ refetchType: refetchType() });
      if (nowUp) wasUp = true;
      up = nowUp;
    })
  );

  return () => {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    if (pending !== null) timers.clearTimeout(pending);
    if (deadline !== null) timers.clearTimeout(deadline);
    pending = null;
    deadline = null;
  };
}

/** The stream's status, as React state. */
export function useStreamStatus(stream: Pick<LiveEventSource, 'onStatusChange' | 'getStatus'>): StreamConnectionStatus {
  return useSyncExternalStore(
    (onChange) => stream.onStatusChange(() => onChange()),
    () => stream.getStatus(),
    () => stream.getStatus()
  );
}

/**
 * `refetchInterval` for a query the stream keeps current: no poll while the stream is up, one every
 * 30 s while it is down. TanStack runs it only while the tab is visible.
 */
export function pollIntervalFor(status: StreamConnectionStatus): number | false {
  return status === 'connected' ? false : POLL_WHILE_STREAM_DOWN_MS;
}
