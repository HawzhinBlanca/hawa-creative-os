/**
 * When the Work queue and the sidebar read Core again (architecture programme 0.3, 2026-09-24).
 *
 * The queue read every page of GET /tasks every 30 s while the tab was visible, and again 1 s after
 * each task event; the sidebar read the health handler every 30 s even in a hidden tab. With the event
 * stream up, the 30 s poll only repeated what the events already said. Now:
 *
 * - a task event asks for one refresh; events that arrive together (a burst from one design run)
 *   share it: the refresh runs once the events stop for 1 s, and no later than 5 s after the first;
 * - only one refresh is in flight at a time; one asked for meanwhile runs after it, 1 s later at least;
 * - the 30 s poll runs only while the tab is visible and the event stream is down (it is the fallback
 *   for missing events, not a second source of them);
 * - a hidden tab reads nothing. Events it heard while hidden, and a stream that was down, cost one
 *   refresh when it is shown again. A stream that reconnects costs one refresh too, for the events
 *   sent while it was away.
 *
 * Timers and the document are passed in, so the tests drive this with fake ones.
 */

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
}

export const browserTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

/** The part of `document` this file uses. */
export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** The part of the Desk's event stream (services/eventStream.ts) this file uses. */
export interface TaskEventSource {
  on(event: string, handler: (data: any) => void): () => void;
  onStatusChange(handler: (status: string) => void): () => void;
}

export interface QueueRefreshOptions {
  /** Quiet time after the last event before the refresh runs. */
  debounceMs?: number;
  /** The longest a refresh waits under a steady stream of events. */
  maxWaitMs?: number;
  /** The fallback poll while the stream is down. */
  pollMs?: number;
}

export const QUEUE_REFRESH_DEFAULTS: Required<QueueRefreshOptions> = { debounceMs: 1_000, maxWaitMs: 5_000, pollMs: 30_000 };

export interface QueueRefreshHandle {
  /** Ask for a refresh as a task event does (coalesced, skipped while hidden). */
  request(): void;
  stop(): void;
}

/**
 * Starts refreshing the queue on task events, visibility and stream changes. `refresh` reads the
 * page on screen once; it is never called twice at the same time.
 */
export function startQueueRefresh(input: {
  refresh: () => Promise<unknown>;
  stream: TaskEventSource;
  events: readonly string[];
  doc: VisibilitySource;
  timers?: Timers;
  options?: QueueRefreshOptions;
}): QueueRefreshHandle {
  const { refresh, stream, events, doc } = input;
  const timers = input.timers ?? browserTimers;
  const { debounceMs, maxWaitMs, pollMs } = { ...QUEUE_REFRESH_DEFAULTS, ...input.options };

  let stopped = false;
  let pending: unknown = null; // the debounce timer
  let firstAskedAt = 0;
  let inFlight = false;
  let askedWhileInFlight = false;
  let missedWhileHidden = false;
  let streamUp = false;
  let streamWasUp = false;

  const run = () => {
    if (stopped) return;
    if (inFlight) {
      askedWhileInFlight = true;
      return;
    }
    inFlight = true;
    void Promise.resolve()
      .then(refresh)
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (askedWhileInFlight) {
          askedWhileInFlight = false;
          request();
        }
      });
  };

  const request = () => {
    if (stopped) return;
    if (doc.hidden) {
      missedWhileHidden = true;
      return;
    }
    const now = timers.now();
    if (pending === null) firstAskedAt = now;
    else timers.clearTimeout(pending);
    const delay = Math.max(0, Math.min(debounceMs, firstAskedAt + maxWaitMs - now));
    pending = timers.setTimeout(() => {
      pending = null;
      run();
    }, delay);
  };

  const onVisibility = () => {
    if (doc.hidden) return;
    if (missedWhileHidden || !streamUp) {
      missedWhileHidden = false;
      request();
    }
  };

  const poll = timers.setInterval(() => {
    if (!doc.hidden && !streamUp) run();
  }, pollMs);

  const unsubscribers = events.map((name) => stream.on(name, () => request()));
  unsubscribers.push(
    stream.onStatusChange((status) => {
      const up = status === 'connected';
      if (up && !streamUp && streamWasUp) request(); // back after a drop: read what it missed
      if (up) streamWasUp = true;
      streamUp = up;
    })
  );
  doc.addEventListener('visibilitychange', onVisibility);

  return {
    request,
    stop() {
      stopped = true;
      if (pending !== null) timers.clearTimeout(pending);
      timers.clearInterval(poll);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

/**
 * Runs `probe` now and every `intervalMs` while the tab is visible, and never while it is hidden
 * (the sidebar's health line). Shown again after at least one interval, it probes at once.
 */
export function startVisiblePolling(input: {
  probe: () => unknown;
  intervalMs: number;
  doc: VisibilitySource;
  timers?: Timers;
}): () => void {
  const { probe, intervalMs, doc } = input;
  const timers = input.timers ?? browserTimers;
  let last = Number.NEGATIVE_INFINITY;
  const tick = () => {
    if (doc.hidden) return;
    last = timers.now();
    void Promise.resolve().then(probe).catch(() => {});
  };
  const onVisibility = () => {
    if (!doc.hidden && timers.now() - last >= intervalMs) tick();
  };
  tick();
  const interval = timers.setInterval(tick, intervalMs);
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    timers.clearInterval(interval);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
