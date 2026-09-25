import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../src/api/client.js';
import { OfficeActionIds, isAnsweredFailure } from '../src/services/officeActions.js';
import { json } from './support/desk-harness.js';

/**
 * Slice 2.4 (PHASE2_DESIGN.md section 3): the Desk sends an action id with approve, revise, deliver and
 * re-drive, made per press and sent again on a retry. Core forwards a lifecycle request's decision to
 * RequestLifecycle under `desk:<actionId>`, so a double click or a retry after a lost answer is one
 * decision (apps/core/test/office-decisions-lifecycle.test.ts).
 */
describe('one action id per press (services/officeActions.ts)', () => {
  let n = 0;
  const keeper = () => new OfficeActionIds(() => `act-${++n}-0000`);

  it('a double click while the press is in flight sends the same id twice', async () => {
    const ids = keeper();
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const press = () => ids.run('approve:t1:r1', async (id) => { seen.push(id); await gate; return { ok: true }; });
    const both = Promise.all([press(), press()]);
    release();
    await both;
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it('no answer from Core (network, 5xx, 408, 429) keeps the id for the retry; an answer ends the press', async () => {
    const ids = keeper();
    const seen: string[] = [];
    const failWith = (err: unknown) => ids.run('deliver:t2', async (id) => { seen.push(id); throw err; }).catch(() => undefined);
    await failWith(new ApiError(0, 'Network error'));
    await failWith(new ApiError(503, 'Request Lifecycle Unavailable'));
    await failWith(new ApiError(429, 'Too many'));
    await ids.run('deliver:t2', async (id) => { seen.push(id); return 'accepted'; });
    expect(new Set(seen).size).toBe(1);
    // The next press is a new decision.
    await ids.run('deliver:t2', async (id) => { seen.push(id); return 'accepted'; });
    expect(seen[4]).not.toBe(seen[3]);
    // A refusal Core gave (409, 422) is an answer too.
    await failWith(new ApiError(409, 'Replaced By A Newer Revision'));
    await ids.run('deliver:t2', async (id) => { seen.push(id); return 'accepted'; });
    expect(seen[6]).not.toBe(seen[5]);
  });

  it('presses on different decisions or drafts do not share ids', () => {
    const ids = keeper();
    expect(ids.idFor('approve:t1:r1')).not.toBe(ids.idFor('approve:t1:r2'));
    expect(ids.idFor('approve:t1:r1')).not.toBe(ids.idFor('revise:t1:r1'));
  });

  it('isAnsweredFailure: only a 4xx Core gave (not 408 or 429) is an answer', () => {
    expect([0, 408, 429, 500, 503].map((s) => isAnsweredFailure(new ApiError(s, 'x')))).toEqual([false, false, false, false, false]);
    expect([400, 403, 409, 422].map((s) => isAnsweredFailure(new ApiError(s, 'x')))).toEqual([true, true, true, true]);
    expect(isAnsweredFailure(new Error('boom'))).toBe(false);
  });
});

describe('the client sends the press\'s id as Idempotency-Key', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('on a decision, a Deliver and a re-drive; nothing when none is given', async () => {
    const calls: Array<{ url: string; key: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, key: new Headers(init?.headers as Record<string, string>).get('Idempotency-Key') });
      return json({ ok: true }, 200);
    }));
    await apiClient.tasks.recordDecision('t1', 'r1', { action: 'approve' }, 'press-approve-1');
    await apiClient.tasks.publish('t1', { destination: 'google_drive' }, 'press-deliver-1');
    await apiClient.tasks.redrive('t1', 'press-redrive-1');
    await apiClient.tasks.recordDecision('t1', 'r1', { action: 'approve' });
    expect(calls.map((c) => [c.url.replace(/^.*\/tasks\//, '/tasks/'), c.key])).toEqual([
      ['/tasks/t1/revisions/r1/decisions', 'press-approve-1'],
      ['/tasks/t1/publish', 'press-deliver-1'],
      ['/tasks/t1/redrive', 'press-redrive-1'],
      ['/tasks/t1/revisions/r1/decisions', null],
    ]);
  });
});
