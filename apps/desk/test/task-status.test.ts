import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../src/api/client.js';
import { TASK_EVENTS, readTaskTransitioned } from '../src/services/eventStream.js';
import { keepLoadedDetail, queueEntryChanged } from '../src/services/taskDetail.js';
import { FILTER_GROUPS, approveButtonState, inQueueFilter, searchFold, taskStatusView, type QueueFilter } from '../src/services/taskStatus.js';
import { TASK_API_STATUSES, TASK_DB_STATES, TASK_STATUS_LABELS, toApiTaskStatus } from '@hawa/contracts/task-status';

/**
 * 2026-09-24: the Work screen labelled most of Core's statuses RECEIVED, left failed drafts out of
 * "Needs Action", heard only six of Core's task events, and noticed an expired session only in the
 * queue. These check the shared pieces against the one status vocabulary (packages/contracts
 * task-status.ts, architecture programme 1.2), which Core, the database and the Desk all use.
 */
const REPO = path.resolve(__dirname, '../../..');

/** Every status Core can report: each database state's API status, and every API status. */
function coreStatuses(): string[] {
  return [...new Set([...TASK_DB_STATES.map(toApiTaskStatus), ...TASK_API_STATUSES])];
}

describe('the label and next step of every status Core reports', () => {
  it('gives each its own view; only RECEIVED reads as a new request to design', () => {
    const statuses = coreStatuses();
    expect(statuses.length).toBe(21);
    for (const status of statuses) {
      const view = taskStatusView(status);
      expect(view.known, status).toBe(true);
      expect(view.message, status).not.toMatch(/does not know/);
      expect(view.pill, status).toBe(TASK_STATUS_LABELS[status as keyof typeof TASK_STATUS_LABELS]);
      if (status !== 'RECEIVED') {
        expect(view.pill, status).not.toBe('RECEIVED');
        expect(view.message, status).not.toMatch(/Use the Canva controls below to design/);
      }
    }
  });

  it('every non-received database state reads as something other than RECEIVED', () => {
    for (const state of TASK_DB_STATES.filter((s) => s !== 'received')) {
      const view = taskStatusView(toApiTaskStatus(state));
      expect(view.pill, state).not.toBe('RECEIVED');
      expect(view.group === 'needs_action' && view.primaryButton === 'edit' && /saved/.test(view.message), state).toBe(false);
    }
  });

  it('offers approval only for a draft awaiting approval, and never for a status it does not know', () => {
    const ready = { hasRevision: true, qaPassed: true, busy: false };
    expect(approveButtonState('AWAITING_APPROVAL', ready)).toBe('enabled');
    for (const status of TASK_API_STATUSES.filter((s) => s !== 'AWAITING_APPROVAL')) expect(approveButtonState(status, ready), status).toBe('disabled');
    for (const unknown of ['ON_HOLD', 'IN_PROGRESS', 'CHANGES_REQUESTED', 'awaiting_approval', '', undefined, null]) {
      expect(taskStatusView(unknown).canApprove, String(unknown)).toBe(false);
      expect(taskStatusView(unknown).primaryButton, String(unknown)).toBe('none');
      expect(approveButtonState(unknown, ready), String(unknown)).toBe('hidden');
    }
    expect(approveButtonState('AWAITING_APPROVAL', { ...ready, qaPassed: false })).toBe('disabled');
    expect(approveButtonState('AWAITING_APPROVAL', { ...ready, hasRevision: false })).toBe('disabled');
  });

  it('decides by status: an approval of an earlier revision does not make a changed or new revision APPROVED', () => {
    expect(taskStatusView('REVISION_REQUESTED').pill).toBe('CHANGES REQUESTED');
    expect(taskStatusView('REVISION_REQUESTED').canApprove).toBe(false);
    expect(taskStatusView('AWAITING_APPROVAL').pill).toBe('NEEDS APPROVAL');
    expect(taskStatusView('AWAITING_APPROVAL').canApprove).toBe(true);
    expect(taskStatusView('APPROVED').primaryButton).toBe('deliver');
    expect(taskStatusView('REVISION_REQUESTED').primaryButton).not.toBe('deliver');
  });

  it('shows a status it does not know as unknown, under Needs Action, without guessing and without approval', () => {
    const view = taskStatusView('ON_HOLD');
    expect(view.known).toBe(false);
    expect(view.pill).toBe('UNKNOWN: ON HOLD');
    expect(view.pill).not.toBe('RECEIVED');
    expect(view.message).toMatch(/does not know/);
    expect(view.canApprove).toBe(false);
    expect(inQueueFilter('ON_HOLD', 'needs_action')).toBe(true);
    expect(taskStatusView(undefined).pill).toBe('UNKNOWN: NO STATUS');
  });
});

describe('the queue filters, built from the same groups', () => {
  const where = (status: string) => (['needs_action', 'review', 'in_progress', 'complete'] as QueueFilter[]).filter((f) => inQueueFilter(status, f));

  it('puts each status where the office looks for it', () => {
    expect(where('OPERATOR_REQUIRED')).toEqual(['needs_action']);
    expect(where('AWAITING_APPROVAL')).toEqual(['needs_action', 'review']);
    expect(where('REVISION_REQUESTED')).toEqual(['needs_action']);
    for (const s of ['PROMOTION_PENDING', 'ROUTING', 'BRIEFING', 'PLANNING', 'ASSET_GENERATION', 'COMPOSING', 'QA', 'REPAIRING']) expect(where(s), s).toEqual(['in_progress']);
    expect(where('COMPLETE')).toEqual(['complete']);
    for (const s of ['PAUSED', 'CANCELLED', 'REJECTED', 'PUBLISHING']) expect(where(s), s).toEqual([]);
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

describe('task:transitioned as the Desk reads it (eventStream readTaskTransitioned)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the one shape as a move, and an old or unknown shape only as the task to read again', () => {
    const move = { tenantId: 'x', taskId: 't1', from: 'AWAITING_APPROVAL', to: 'REVISION_REQUESTED', version: 5, at: '2026-09-24T10:00:00.000Z' };
    expect(readTaskTransitioned(move)).toEqual({ move: { taskId: 't1', from: 'AWAITING_APPROVAL', to: 'REVISION_REQUESTED', version: 5, at: move.at }, taskId: 't1' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readTaskTransitioned({ taskId: 't2', fromStatus: 'AWAITING_APPROVAL', toStatus: 'IN_PROGRESS' })).toEqual({ move: null, taskId: 't2' });
    expect(readTaskTransitioned({ ...move, to: 'IN_PROGRESS' })).toEqual({ move: null, taskId: 't1' });
    expect(readTaskTransitioned(null)).toEqual({ move: null, taskId: null });
    expect(warn).toHaveBeenCalledTimes(3);
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
