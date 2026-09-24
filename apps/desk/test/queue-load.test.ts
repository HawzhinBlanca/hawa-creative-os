import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../src/api/client.js';
import { TASK_EVENTS } from '../src/services/eventStream.js';
import { startQueueRefresh, startVisiblePolling, type TaskEventSource, type VisibilitySource } from '../src/services/queueRefresh.js';
import { inQueueFilter, queueFilterStatuses } from '../src/services/taskStatus.js';

/**
 * Architecture programme 0.3 (2026-09-24): the load one open Desk puts on Core.
 *
 * Before: the Work screen read every page of GET /tasks every 30 s while visible and 1 s after each
 * task event (a burst of events from one design run was one full read per event more than 1 s
 * apart), and the sidebar read the health handler every 30 s even in a hidden tab. These drive the
 * refresh and polling code the Work screen and the sidebar run, with fake timers, a fake event
 * stream and a fake document, and count the requests.
 */

class FakeDocument implements VisibilitySource {
  hidden = false;
  private listeners = new Set<() => void>();
  addEventListener(_type: 'visibilitychange', listener: () => void) { this.listeners.add(listener); }
  removeEventListener(_type: 'visibilitychange', listener: () => void) { this.listeners.delete(listener); }
  setHidden(hidden: boolean) {
    this.hidden = hidden;
    this.listeners.forEach((l) => l());
  }
}

class FakeStream implements TaskEventSource {
  private handlers = new Map<string, Set<(data: any) => void>>();
  private statusHandlers = new Set<(status: string) => void>();
  status = 'connected';
  on(event: string, handler: (data: any) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)!.delete(handler);
  }
  onStatusChange(handler: (status: string) => void) {
    this.statusHandlers.add(handler);
    handler(this.status); // as eventStream.onStatusChange does
    return () => this.statusHandlers.delete(handler);
  }
  emit(event: string, data: any = { taskId: 't1' }) { this.handlers.get(event)?.forEach((h) => h(data)); }
  setStatus(status: string) {
    this.status = status;
    this.statusHandlers.forEach((h) => h(status));
  }
}

const MINUTE = 60_000;

describe('the Work queue refresh (services/queueRefresh.ts startQueueRefresh, as WorkScreen runs it)', () => {
  let doc: FakeDocument;
  let stream: FakeStream;
  let listRequests: number;
  let stop: () => void;
  let refreshMs: number;
  let inFlight: number;
  let maxInFlight: number;

  const start = () => {
    // The screen's first read, made when it mounts, before any refresh.
    listRequests = 1;
    const handle = startQueueRefresh({
      refresh: async () => {
        listRequests++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, refreshMs));
        inFlight--;
      },
      stream,
      events: TASK_EVENTS,
      doc,
    });
    stop = handle.stop;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    doc = new FakeDocument();
    stream = new FakeStream();
    refreshMs = 200;
    inFlight = 0;
    maxInFlight = 0;
  });
  afterEach(() => {
    stop?.();
    vi.useRealTimers();
  });

  it('an idle visible tab with the event stream up makes at most 2 list requests a minute', async () => {
    start();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(listRequests).toBeLessThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    // Ten idle minutes: nothing after the first read. It used to be 20 full reads of every page.
    expect(listRequests).toBe(1);
  });

  it('a burst of 20 task events causes at most 2 list requests', async () => {
    start();
    for (let i = 0; i < 20; i++) {
      stream.emit(TASK_EVENTS[i % TASK_EVENTS.length]);
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(listRequests - 1).toBeLessThanOrEqual(2);
    expect(listRequests - 1).toBeGreaterThanOrEqual(1); // the events are read, not dropped
  });

  it('events that keep arriving while a slow read runs still make one read at a time, spaced at least 1 s apart', async () => {
    refreshMs = 3_000;
    const started: number[] = [];
    listRequests = 1;
    const handle = startQueueRefresh({
      refresh: async () => {
        started.push(Date.now());
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, refreshMs));
        inFlight--;
      },
      stream,
      events: TASK_EVENTS,
      doc,
    });
    stop = handle.stop;
    // An event every 700 ms for 20 s: a plain 1 s debounce would never fire, a plain delay would fire 28 times.
    for (let i = 0; i < 28; i++) {
      stream.emit('task:transitioned');
      await vi.advanceTimersByTimeAsync(700);
    }
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(maxInFlight).toBe(1);
    expect(started.length).toBeGreaterThanOrEqual(2); // never starved by a steady stream
    expect(started.length).toBeLessThanOrEqual(6); // at most one per 5 s window
    for (let i = 1; i < started.length; i++) expect(started[i] - started[i - 1]).toBeGreaterThanOrEqual(1_000);
  });

  it('a hidden tab makes no list requests, whatever the stream does', async () => {
    start();
    doc.setHidden(true);
    for (let i = 0; i < 20; i++) stream.emit('task:qa_completed');
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    stream.setStatus('connecting'); // the stream drops: the poll would run, but not in a hidden tab
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    stream.setStatus('connected');
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(listRequests - 1).toBe(0);

    // Shown again, it reads once for everything it heard while hidden.
    doc.setHidden(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listRequests - 1).toBe(1);
  });

  it('polls every 30 s only while the event stream is down, and reads once when it reconnects', async () => {
    start();
    stream.setStatus('connecting');
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(listRequests - 1).toBe(2); // the fallback: nothing else tells the screen about changes
    stream.setStatus('connected');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listRequests - 1).toBe(3); // the events sent while it was away
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(listRequests - 1).toBe(3);
  });

  it('stops reading when the screen unmounts', async () => {
    start();
    stop();
    stream.setStatus('connecting');
    stream.emit('task:created', { id: 't9' });
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(listRequests).toBe(1);
  });
});

describe('the sidebar health line (services/queueRefresh.ts startVisiblePolling, as Sidebar runs it)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('probes only while the tab is visible', async () => {
    const doc = new FakeDocument();
    doc.hidden = true;
    const probe = vi.fn(async () => {});
    const stop = startVisiblePolling({ probe, intervalMs: 30_000, doc });
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(probe).not.toHaveBeenCalled();

    doc.setHidden(false); // shown after a long time: the line is read at once
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(probe.mock.calls.length).toBeLessThanOrEqual(3);

    doc.setHidden(true);
    const before = probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(probe.mock.calls.length).toBe(before);
    stop();
  });
});

describe('the Work screen and the sidebar use these (source)', () => {
  const source = (file: string) => fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8');

  it('the Work screen refreshes through startQueueRefresh, with the live stream and the document, and has no timer of its own', () => {
    const work = source('screens/WorkScreen.tsx');
    expect(work).toMatch(/startQueueRefresh\(\{[^}]*stream: eventStream[^}]*events: TASK_EVENTS[^}]*doc: document/);
    expect(work).not.toMatch(/setInterval\(/);
    // The live-event handler no longer schedules its own queue read.
    expect(work).not.toMatch(/setTimeout\(refreshQueueQuietly/);
  });

  it('the sidebar probes health through startVisiblePolling and has no timer of its own', () => {
    const sidebar = source('components/Sidebar.tsx');
    expect(sidebar).toMatch(/startVisiblePolling\(\{ probe: probeHealth/);
    expect(sidebar).not.toMatch(/setInterval\(/);
  });
});

describe('the queue filters sent to Core (taskStatus.ts queueFilterStatuses)', () => {
  it('names exactly the statuses the filter shows', () => {
    expect(queueFilterStatuses('all')).toBeUndefined();
    expect(queueFilterStatuses('review')).toEqual(['AWAITING_APPROVAL']);
    for (const filter of ['needs_action', 'review', 'in_progress', 'complete'] as const) {
      const statuses = queueFilterStatuses(filter)!;
      expect(statuses.length).toBeGreaterThan(0);
      expect(statuses.every((s) => inQueueFilter(s, filter))).toBe(true);
    }
    expect(queueFilterStatuses('needs_action')).toEqual(expect.arrayContaining(['OPERATOR_REQUIRED', 'AWAITING_APPROVAL', 'APPROVED', 'REVISION_REQUESTED']));
  });
});

describe('the task list request (api/client.ts tasks.list)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the cursor, the filter statuses and the search to Core', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ items: [], total: 0, nextCursor: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchSpy);
    await apiClient.tasks.list({ limit: 50, cursor: 'WyIyMDI2Il0', statuses: ['AWAITING_APPROVAL', 'APPROVED'], q: 'كوردی' });
    const url = new URL(String(fetchSpy.mock.calls[0][0]), 'http://desk.invalid');
    expect(url.pathname).toBe('/v1/tasks');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('cursor')).toBe('WyIyMDI2Il0');
    expect(url.searchParams.get('statuses')).toBe('AWAITING_APPROVAL,APPROVED');
    expect(url.searchParams.get('q')).toBe('كوردی');
    expect(url.searchParams.has('offset')).toBe(false);
  });
});
