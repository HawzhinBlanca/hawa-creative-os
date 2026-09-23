import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../src/api/client.js';
import { TASK_EVENTS } from '../src/services/eventStream.js';
import { keepLoadedDetail, queueEntryChanged } from '../src/services/taskDetail.js';
import { FILTER_GROUPS, inQueueFilter, searchFold, taskStatusView, type QueueFilter } from '../src/services/taskStatus.js';
import { toApiTaskStatus } from '../../../packages/db/src/repositories/task.repository.js';
import { LEGAL_TRANSITIONS } from '../../../packages/domain/src/state-machine.js';

/**
 * 2026-09-24: the Work screen labelled most of Core's statuses RECEIVED, left failed drafts out of
 * "Needs Action", heard only six of Core's task events, and noticed an expired session only in the
 * queue. These check the shared pieces against Core's own lists.
 */
const REPO = path.resolve(__dirname, '../../..');

/** Every status Core can report: each database state through toApiTaskStatus, the domain statuses, and the in-memory ones. */
function coreStatuses(): string[] {
  const types = fs.readFileSync(path.join(REPO, 'packages/db/src/types.ts'), 'utf8');
  const union = /export type TaskState =([^;]+);/.exec(types)![1];
  const dbStates = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  expect(dbStates).toContain('failed_operator');
  const app = fs.readFileSync(path.join(REPO, 'apps/core/src/app.ts'), 'utf8');
  const inMemory = ['IN_PROGRESS', 'PAUSED', 'CHANGES_REQUESTED', 'COMPLETED'].filter((s) => app.includes(`'${s}'`));
  return [...new Set([...dbStates.map(toApiTaskStatus), ...Object.keys(LEGAL_TRANSITIONS), ...inMemory])];
}

describe('the label and next step of every status Core reports', () => {
  it('gives each its own view; only RECEIVED reads as a new request to design', () => {
    const statuses = coreStatuses();
    expect(statuses.length).toBeGreaterThan(20);
    for (const status of statuses) {
      const view = taskStatusView(status);
      expect(view.message, status).not.toMatch(/does not know/);
      if (status !== 'RECEIVED') {
        expect(view.pill, status).not.toBe('RECEIVED');
        expect(view.message, status).not.toMatch(/Use the Canva controls below to design/);
      }
    }
  });

  it('decides by status: an approval of an earlier revision does not make a changed or new revision APPROVED', () => {
    expect(taskStatusView('REVISION_REQUESTED').pill).toBe('CHANGES REQUESTED');
    expect(taskStatusView('REVISION_REQUESTED').canApprove).toBe(false);
    expect(taskStatusView('AWAITING_APPROVAL').pill).toBe('NEEDS APPROVAL');
    expect(taskStatusView('AWAITING_APPROVAL').canApprove).toBe(true);
    expect(taskStatusView('APPROVED').primaryButton).toBe('deliver');
    expect(taskStatusView('REVISION_REQUESTED').primaryButton).not.toBe('deliver');
  });

  it('shows a status it does not know as itself, under Needs Action, without guessing', () => {
    const view = taskStatusView('ON_HOLD');
    expect(view.pill).toBe('ON HOLD');
    expect(view.message).toMatch(/does not know/);
    expect(inQueueFilter('ON_HOLD', 'needs_action')).toBe(true);
  });
});

describe('the queue filters, built from the same groups', () => {
  const where = (status: string) => (['needs_action', 'review', 'in_progress', 'complete'] as QueueFilter[]).filter((f) => inQueueFilter(status, f));

  it('puts each status where the office looks for it', () => {
    expect(where('OPERATOR_REQUIRED')).toEqual(['needs_action']);
    expect(where('AWAITING_APPROVAL')).toEqual(['needs_action', 'review']);
    expect(where('REVISION_REQUESTED')).toEqual(['needs_action']);
    for (const s of ['ROUTING', 'BRIEFING', 'PLANNING', 'ASSET_GENERATION', 'COMPOSING', 'QA', 'REPAIRING', 'IN_PROGRESS']) expect(where(s), s).toEqual(['in_progress']);
    expect(where('COMPLETE')).toEqual(['complete']);
    for (const s of ['PAUSED', 'NEEDS_INFORMATION', 'CANCELLED', 'REJECTED', 'PUBLISHING']) expect(where(s), s).toEqual([]);
    expect(inQueueFilter('CANCELLED', 'all')).toBe(true);
  });

  it('every filter is the union of whole status groups', () => {
    for (const status of coreStatuses()) {
      for (const [filter, groups] of Object.entries(FILTER_GROUPS)) {
        expect(inQueueFilter(status, filter as QueueFilter), `${status} in ${filter}`).toBe(groups.includes(taskStatusView(status).group));
      }
    }
  });
});

describe('queue search', () => {
  it('treats the Arabic-keyboard ي and ك as the Sorani ی and ک', () => {
    expect(searchFold('كوردي')).toBe(searchFold('کوردی'));
    expect(searchFold('Kurdistan کۆنفرانس').includes(searchFold('كۆنفرانس'))).toBe(true);
    expect(searchFold('KAAE')).toBe('kaae');
  });
});

describe('a background refresh of the queue', () => {
  type Entry = { id: string; status: string; latestRevision: { id: string; version: number; previewUrl?: string } };
  const detail: Entry = { id: 't1', status: 'AWAITING_APPROVAL', latestRevision: { id: 'r1', version: 1, previewUrl: 'data:image/png;base64,AA==' } };

  it('keeps the loaded preview while the revision is the same, and drops it for a new revision', () => {
    const same = keepLoadedDetail([detail], [{ id: 't1', status: 'APPROVED', latestRevision: { id: 'r1', version: 1 } }]);
    expect(same[0]).toMatchObject({ status: 'APPROVED', latestRevision: { previewUrl: 'data:image/png;base64,AA==' } });
    const next = keepLoadedDetail([detail], [{ id: 't1', status: 'AWAITING_APPROVAL', latestRevision: { id: 'r2', version: 2 } }]);
    expect(next[0].latestRevision).toEqual({ id: 'r2', version: 2 });
  });

  it('reads the selected task again only when the list shows it changed', () => {
    const entry = { id: 't1', status: 'AWAITING_APPROVAL', version: 3, updatedAt: 'a' };
    expect(queueEntryChanged(entry, { ...entry })).toBe(false);
    expect(queueEntryChanged(entry, { ...entry, status: 'APPROVED' })).toBe(true);
    expect(queueEntryChanged(entry, { ...entry, version: 4 })).toBe(true);
    expect(queueEntryChanged(undefined, entry)).toBe(true);
  });
});

describe('the live stream hears every task event Core broadcasts', () => {
  it('lists each `broadcast(\'task:…\')` name in apps/core/src', () => {
    const coreSrc = path.join(REPO, 'apps/core/src');
    const files = fs.readdirSync(coreSrc, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
    const names = new Set<string>();
    for (const file of files) {
      for (const m of fs.readFileSync(path.join(coreSrc, file), 'utf8').matchAll(/broadcast\(\s*(?:[^,]*\?\s*)?'(task:[a-z_]+)'/g)) names.add(m[1]);
      for (const m of fs.readFileSync(path.join(coreSrc, file), 'utf8').matchAll(/: '(task:[a-z_]+)'/g)) names.add(m[1]);
    }
    expect(names.size).toBeGreaterThan(8);
    for (const name of names) expect(TASK_EVENTS as readonly string[], name).toContain(name);
  });
});

describe('the session, as the API client ends it', () => {
  afterEach(() => vi.unstubAllGlobals());
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const signIn = async (token: string) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, token }, 201)));
    await apiClient.auth.login({ key: 'k' });
  };

  it('tells the screen about every 401, from any route, with Core\'s reason; a wrong sign-in key is not a session ending', async () => {
    await signIn('hawa_sess_a');
    const ended = vi.fn();
    const unsubscribe = apiClient.auth.onSessionEnded(ended);
    vi.stubGlobal('fetch', vi.fn(async () => json({ title: 'Authentication Required', detail: 'Sign in to Hawa first' }, 401)));
    await expect(apiClient.tasks.asks('t1')).rejects.toMatchObject({ status: 401 });
    await expect(apiClient.canva.taskState('t1')).rejects.toMatchObject({ status: 401 });
    expect(ended).toHaveBeenCalledTimes(2);
    expect(ended).toHaveBeenCalledWith('Sign in to Hawa first', true);
    await expect(apiClient.auth.login({ key: 'wrong' })).rejects.toMatchObject({ status: 401 });
    expect(ended).toHaveBeenCalledTimes(2);
    vi.stubGlobal('fetch', vi.fn(async () => json({ title: 'Database Unavailable' }, 503)));
    await expect(apiClient.tasks.asks('t1')).rejects.toMatchObject({ status: 503 });
    expect(ended).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('Sign Out revokes the session it ends, and signs the tab out even when Core does not answer', async () => {
    await signIn('hawa_sess_b');
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchSpy);
    await apiClient.auth.logout();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/v1/auth/session');
    expect(init?.method).toBe('DELETE');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer hawa_sess_b');
    // The next request goes without the ended token.
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [], total: 0 }, 200)));
    await apiClient.tasks.list({ limit: 1 });
    const headers = (vi.mocked(fetch).mock.calls[0][1]?.headers || {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});
