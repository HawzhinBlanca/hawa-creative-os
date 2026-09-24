import fs from 'node:fs';
import path from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../src/api/client.js';
import { TASK_EVENTS } from '../src/services/eventStream.js';
import { bridgeTaskEvents, pollIntervalFor, taskIdOf } from '../src/services/liveUpdates.js';
import { POLL_WHILE_STREAM_DOWN_MS, queryKeys } from '../src/services/queryClient.js';
import { inQueueFilter, queueFilterStatuses } from '../src/services/taskStatus.js';
import { FakeStream } from './support/desk-harness.js';

/**
 * The load one open Desk puts on Core.
 *
 * Architecture programme 0.3 (2026-09-24) stopped the Work screen reading every page every 30 s and
 * 1 s after each event; ADR-037 (programme 1.5) replaced its hand-written refresh with the query
 * cache: the tab's one event stream invalidates what an event names, 300 ms of events at a time,
 * and nothing is polled while the stream is up. This drives the bridge (services/liveUpdates.ts) with
 * a fake stream and fake timers and records what it invalidates; test/server-state.test.ts counts the
 * requests of the rendered screen.
 */

function recordingClient() {
  const client = new QueryClient();
  const invalidated: Array<{ key: unknown; refetchType?: string }> = [];
  vi.spyOn(client, 'invalidateQueries').mockImplementation(async (filters?: any) => {
    invalidated.push({ key: filters?.queryKey ?? 'everything', refetchType: filters?.refetchType });
  });
  return { client, invalidated };
}

describe('task events reach the query cache (services/liveUpdates.ts bridgeTaskEvents)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a burst of 20 task events invalidates the list once and each task it named once', async () => {
    const stream = new FakeStream('connected');
    const { client, invalidated } = recordingClient();
    const stop = bridgeTaskEvents({ queryClient: client, stream, doc: { hidden: false } });
    for (let i = 0; i < 20; i++) {
      stream.emit(TASK_EVENTS[i % TASK_EVENTS.length], { taskId: i % 2 ? 't1' : 't2' });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(invalidated).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(invalidated).toEqual([
      { key: queryKeys.tasks, refetchType: 'active' },
      { key: queryKeys.task('t2'), refetchType: 'active' },
      { key: queryKeys.task('t1'), refetchType: 'active' },
    ]);
    stop();
  });

  it('applies events at most every 300 ms under a steady stream of them, never later', async () => {
    const stream = new FakeStream('connected');
    const { client, invalidated } = recordingClient();
    const stop = bridgeTaskEvents({ queryClient: client, stream });
    for (let i = 0; i < 100; i++) {
      stream.emit('task:transitioned', { taskId: 't1' });
      await vi.advanceTimersByTimeAsync(50);
    }
    const listReads = invalidated.filter((x) => x.key === queryKeys.tasks).length;
    expect(listReads).toBeGreaterThanOrEqual(15);
    expect(listReads).toBeLessThanOrEqual(17);
    stop();
  });

  it('in a hidden tab only marks answers stale (the tab reads them when shown)', async () => {
    const stream = new FakeStream('connected');
    const { client, invalidated } = recordingClient();
    const stop = bridgeTaskEvents({ queryClient: client, stream, doc: { hidden: true } });
    stream.emit('task:approved', { taskId: 't1' });
    await vi.advanceTimersByTimeAsync(300);
    expect(invalidated.every((x) => x.refetchType === 'none')).toBe(true);
    expect(invalidated).toHaveLength(2);
    stop();
  });

  it('invalidates everything after a reconnect, not on the first connection', async () => {
    const stream = new FakeStream('connecting');
    const { client, invalidated } = recordingClient();
    const stop = bridgeTaskEvents({ queryClient: client, stream });
    stream.setStatus('connected');
    expect(invalidated).toEqual([]);
    stream.setStatus('connecting');
    stream.setStatus('connected');
    expect(invalidated).toEqual([{ key: 'everything', refetchType: 'active' }]);
    stop();
  });

  it('hears every task event Core broadcasts, and nothing after it stops', async () => {
    const stream = new FakeStream('connected');
    const { client, invalidated } = recordingClient();
    const stop = bridgeTaskEvents({ queryClient: client, stream });
    for (const name of TASK_EVENTS) expect(stream.listeners(name), name).toBe(1);
    stop();
    for (const name of TASK_EVENTS) expect(stream.listeners(name), name).toBe(0);
    stream.emit('task:created', { id: 't9' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(invalidated).toEqual([]);
  });

  it('reads the task an event names in each of the shapes Core sends', () => {
    expect(taskIdOf({ taskId: 't1' })).toBe('t1');
    expect(taskIdOf({ task: { id: 't2' } })).toBe('t2');
    expect(taskIdOf({ id: 't3', title: 'x' })).toBe('t3');
    expect(taskIdOf({})).toBeUndefined();
    expect(taskIdOf(null)).toBeUndefined();
  });

  it('polls only while the stream is down', () => {
    expect(pollIntervalFor('connected')).toBe(false);
    expect(pollIntervalFor('connecting')).toBe(POLL_WHILE_STREAM_DOWN_MS);
    expect(pollIntervalFor('disconnected')).toBe(POLL_WHILE_STREAM_DOWN_MS);
  });
});

describe('the Work screen and the sidebar have no timers of their own (source)', () => {
  const source = (file: string) => fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8');

  it('the Work screen reads the queue through a query and subscribes to no task event but the new-request toast', () => {
    const work = source('screens/WorkScreen.tsx');
    expect(work).not.toMatch(/setInterval\(/);
    expect(work).toMatch(/placeholderData: keepPreviousData/);
    expect(work).toMatch(/refetchInterval: pollInterval/);
    expect(work.match(/stream\.on\(/g)).toHaveLength(1);
    expect(work).toMatch(/stream\.on\('task:created'/);
  });

  it('the sidebar reads health through a query polled only while the tab is visible', () => {
    const sidebar = source('components/Sidebar.tsx');
    expect(sidebar).not.toMatch(/setInterval\(/);
    expect(sidebar).toMatch(/useQuery\(\{\s*queryKey: queryKeys\.health,\s*queryFn: probeHealth,\s*refetchInterval: HEALTH_POLL_MS/);
    expect(sidebar).not.toMatch(/refetchIntervalInBackground/);
  });

  it('the hand-written refresh module is gone', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../src/services/queueRefresh.ts'))).toBe(false);
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
