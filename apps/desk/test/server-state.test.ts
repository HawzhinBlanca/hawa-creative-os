// @vitest-environment jsdom
import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkScreen } from '../src/screens/WorkScreen.js';
import { App } from '../src/App.js';
import { DeskProviders, createDeskRuntime, type DeskRuntime } from '../src/DeskProviders.js';
import { apiClient } from '../src/api/client.js';
import { clearAuthToken, getAuthToken, setAuthToken } from '../src/services/auth.js';
import { TASK_EVENTS } from '../src/services/eventStream.js';
import { queryKeys } from '../src/services/queryClient.js';
import { FakeStream, advance, byText, click, flush, isListRead, json, mount, stubCore, type FetchCall } from './support/desk-harness.js';
import { taskTransitioned } from '@hawa/contracts/task-status';

/**
 * Architecture programme 1.5 (ADR-037, 2026-09-24): the Desk's server state on TanStack Query.
 *
 * Rendered for real in jsdom, with a fake event stream and a fake Core behind fetch, on fake time.
 * The acceptance criteria of the plan: a new draft shows within 2 s of its event; an idle tab makes
 * no list requests while the stream is up; a burst of events costs one read; approve shows pending
 * and never shows a status Core has not confirmed; an expired session reaches sign-in from any
 * screen, once.
 */

const h = React.createElement;

interface FakeTask {
  id: string;
  title: string;
  status: string;
  revision?: number;
  approved?: boolean;
}

const approvable = (id: string, title: string): FakeTask => ({ id, title, status: 'AWAITING_APPROVAL', revision: 1 });

/** A task as GET /tasks lists it and as GET /tasks/:id returns it. */
function asTask(t: FakeTask) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    clientName: 'KAAE',
    version: t.revision ?? 0,
    updatedAt: `2026-09-24T10:00:0${t.revision ?? 0}.000Z`,
    ...(t.revision
      ? {
          latestRevisionId: `r${t.revision}`,
          latestRevision: { id: `r${t.revision}`, version: t.revision, sha256: 'ab'.repeat(32), format: 'png' },
          qaReport: { passed: true, bidiIsolation: true, safeMargins: true, contrastCompliant: true, fontCoverage: true, errors: [] },
        }
      : {}),
    ...(t.approved ? { latestApproval: { decisionId: 'd1', role: 'art_director', decidedAt: '2026-09-24T10:05:00.000Z' } } : {}),
  };
}

/** Core as the Work screen reads it. `decision` holds a POST .../decisions until the test answers it. */
function fakeCore(initial: FakeTask[], opts: { role?: string } = {}) {
  const tasks = [...initial];
  let answerDecision: ((res: Response) => void) | null = null;
  const calls = stubCore((c: FetchCall) => {
    if (c.path === '/v1/auth/session' && c.method === 'GET') {
      return json({ authenticated: true, user: { id: 'u1', role: opts.role ?? 'art_director', displayName: 'Art Director' } });
    }
    if (isListRead(c)) return json({ items: tasks.map(asTask), total: tasks.length, limit: 50, nextCursor: null });
    const detail = /^\/v1\/tasks\/([^/]+)$/.exec(c.path);
    if (detail && c.method === 'GET') {
      const t = tasks.find((x) => x.id === detail[1]);
      return t ? json(asTask(t)) : json({ title: 'Not Found' }, 404);
    }
    if (/^\/v1\/tasks\/[^/]+\/timeline$/.test(c.path)) return json({ events: [] });
    if (/^\/v1\/tasks\/[^/]+\/canva$/.test(c.path)) {
      return json({ artifacts: [{ id: 'a1', format: 'png', sha256: 'cd'.repeat(32), byte_size: 1000 }] });
    }
    if (/\/decisions$/.test(c.path) && c.method === 'POST') {
      return new Promise<Response>((resolve) => {
        answerDecision = resolve;
      });
    }
    return undefined;
  });
  return {
    tasks,
    calls,
    listReads: () => calls.filter(isListRead).length,
    reads: (path: string) => calls.filter((c) => c.method === 'GET' && c.path === path).length,
    answerDecision(res: Response) {
      if (!answerDecision) throw new Error('no decision is waiting');
      answerDecision(res);
      answerDecision = null;
    },
  };
}

async function renderWork(stream: FakeStream, doc = { hidden: false }) {
  const runtime = createDeskRuntime({ stream, doc });
  const view = await mount(h(DeskProviders, { runtime, children: h(WorkScreen, {}) }));
  await advance(500);
  const queue = () => view.container.querySelector('[aria-label="Tasks List"]')?.textContent || '';
  return { runtime, view, queue };
}

const mounted: Array<{ unmount(): Promise<void> }> = [];

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
});

beforeEach(() => {
  vi.useFakeTimers();
  setAuthToken(['hawa', 'sess', 'test'].join('_'));
});

afterEach(async () => {
  while (mounted.length) await mounted.pop()!.unmount();
  vi.useRealTimers();
  // Work an unmounted screen started (a refetch, a stream close) may still log; let it finish
  // before the file tears down, or vitest reports the pending console call as an unhandled error.
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.unstubAllGlobals();
  clearAuthToken();
  apiClient.auth.setUnauthorizedHint(null);
  window.location.hash = '';
});

describe('the Work queue follows the event stream', () => {
  it('shows a new draft within 2 s of its event', async () => {
    const stream = new FakeStream('connected');
    const core = fakeCore([approvable('t1', 'Members evening poster')]);
    const { view, queue } = await renderWork(stream);
    mounted.push(view);
    expect(queue()).toContain('Members evening poster');

    // A new request arrives.
    core.tasks.unshift(approvable('t2', 'Graduation ceremony draft'));
    stream.emit('task:created', { id: 't2', taskId: 't2', title: 'Graduation ceremony draft' });
    await advance(2_000);
    expect(queue()).toContain('Graduation ceremony draft');

    // A new draft of the task on screen: its detail (the preview) is read again.
    const detailReads = core.reads('/v1/tasks/t1');
    core.tasks.find((t) => t.id === 't1')!.revision = 2;
    stream.emit('task:revision_created', { taskId: 't1' });
    await advance(2_000);
    expect(core.reads('/v1/tasks/t1')).toBe(detailReads + 1);
    expect(view.container.querySelector('.revision-badge')?.textContent).toContain('Revision v2');
  });

  it('an idle tab makes no list requests while the stream is up, polls only while it is down, and reads once on reconnect', async () => {
    const stream = new FakeStream('connected');
    const core = fakeCore([approvable('t1', 'Members evening poster')]);
    const { view } = await renderWork(stream);
    mounted.push(view);
    const first = core.listReads();
    expect(first).toBe(1);

    await advance(10 * 60_000);
    expect(core.listReads()).toBe(first);

    // The stream drops: the list is polled every 30 s until it is back.
    await flush();
    stream.setStatus('connecting');
    await flush();
    await advance(61_000);
    expect(core.listReads()).toBe(first + 2);

    // Back: one read for what it missed, then nothing again.
    stream.setStatus('connected');
    await advance(1_000);
    expect(core.listReads()).toBe(first + 3);
    await advance(5 * 60_000);
    expect(core.listReads()).toBe(first + 3);
  });

  it('a burst of 20 task events causes one read of the list and one of the task it names', async () => {
    const stream = new FakeStream('connected');
    const core = fakeCore([approvable('t1', 'Members evening poster')]);
    const { view } = await renderWork(stream);
    mounted.push(view);
    const lists = core.listReads();
    const details = core.reads('/v1/tasks/t1');

    for (let i = 0; i < 20; i++) {
      stream.emit(TASK_EVENTS[i % TASK_EVENTS.length], { taskId: 't1' });
      await advance(10);
    }
    await advance(2_000);
    expect(core.listReads()).toBe(lists + 1);
    expect(core.reads('/v1/tasks/t1')).toBe(details + 1);
  });

  it('a hidden tab reads nothing on events, and reads once when it is shown', async () => {
    const stream = new FakeStream('connected');
    const core = fakeCore([approvable('t1', 'Members evening poster')]);
    const doc = { hidden: false };
    const { view } = await renderWork(stream, doc);
    mounted.push(view);
    const lists = core.listReads();

    doc.hidden = true;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    for (let i = 0; i < 5; i++) stream.emit('task:transitioned', taskTransitioned({ taskId: 't1', from: 'human_review', to: 'human_review', version: i + 2 }));
    await advance(5_000);
    expect(core.listReads()).toBe(lists);

    doc.hidden = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await advance(0);
    window.dispatchEvent(new Event('visibilitychange'));
    await advance(1_000);
    expect(core.listReads()).toBe(lists + 1);
  });
});

describe('approve and request revision are mutations', () => {
  it('approve shows pending, leaves the status Core reported until Core answers, then reads the task and the list again', async () => {
    const stream = new FakeStream('connected');
    const core = fakeCore([approvable('t1', 'Members evening poster')]);
    const { runtime, view } = await renderWork(stream);
    mounted.push(view);
    const status = () => view.container.querySelector('[data-testid="task-status"]')?.textContent;
    expect(status()).toBe('NEEDS APPROVAL');

    await click(view.container.querySelector('#btn-approve-captured'));
    await advance(100);
    await click(byText(view.container, 'button', 'Confirm Approval & Release'));
    await advance(100);

    // Sent, and Core has not answered.
    expect(core.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/decisions'))).toHaveLength(1);
    const lists = core.listReads();
    const details = core.reads('/v1/tasks/t1');
    expect(byText(view.container, 'button', 'Approving…')?.hasAttribute('disabled')).toBe(true);
    expect(view.text()).toContain('Approval sent; waiting for Core…');
    expect(status()).toBe('NEEDS APPROVAL');
    expect(runtime.queryClient.getQueryData<any>(queryKeys.taskDetail('t1'))?.status).toBe('AWAITING_APPROVAL');
    await advance(10_000);
    expect(status()).toBe('NEEDS APPROVAL');

    // Core records it; only then does the screen show it, from Core's answer.
    const t1 = core.tasks.find((t) => t.id === 't1')!;
    t1.status = 'APPROVED';
    t1.approved = true;
    core.answerDecision(json({ decisionId: 'd1' }, 201));
    await advance(500);
    expect(status()).toBe('APPROVED');
    expect(core.listReads()).toBe(lists + 1);
    expect(core.reads('/v1/tasks/t1')).toBe(details + 1);
    expect(view.text()).not.toContain('Approval sent; waiting for Core…');
  });

  it('a refused approval changes nothing on screen and says why', async () => {
    const stream = new FakeStream('connected');
    const core = fakeCore([approvable('t1', 'Members evening poster')]);
    const { view } = await renderWork(stream);
    mounted.push(view);
    await click(view.container.querySelector('#btn-approve-captured'));
    await advance(100);
    await click(byText(view.container, 'button', 'Confirm Approval & Release'));
    await advance(100);
    const lists = core.listReads();
    core.answerDecision(json({ title: 'Conflict', detail: 'The revision changed since it was captured' }, 409));
    await advance(500);
    expect(view.container.querySelector('[data-testid="task-status"]')?.textContent).toBe('NEEDS APPROVAL');
    expect(view.text()).toContain('Approval failed: The revision changed since it was captured');
    expect(core.listReads()).toBe(lists);
    expect(byText(view.container, 'button', 'Confirm Approval & Release')?.hasAttribute('disabled')).toBe(false);
  });

  it('an approval Core recorded is reported as recorded even when reading the task again fails', async () => {
    const stream = new FakeStream('connected');
    const core = fakeCore([approvable('t1', 'Members evening poster')]);
    const { view } = await renderWork(stream);
    mounted.push(view);
    await click(view.container.querySelector('#btn-approve-captured'));
    await advance(100);
    await click(byText(view.container, 'button', 'Confirm Approval & Release'));
    await advance(100);
    // Core goes away right after recording the approval.
    const answered = core.answerDecision.bind(core);
    stubCore(() => json({ title: 'Service Unavailable' }, 503));
    answered(json({ decisionId: 'd1' }, 201));
    // The read is retried twice (1 s, then 2 s later) before it counts as failed; the notice follows.
    let shown = '';
    for (let waited = 0; waited < 10_000 && !shown.includes('Approved Revision'); waited += 250) {
      await advance(250);
      shown = view.text();
    }
    expect(shown).toContain('Approved Revision r1. Decision ID: d1. Refresh the page to see the latest status.');
    expect(shown).not.toContain('Approval failed');
  });

  it('request revision shows pending and keeps the status until Core answers', async () => {
    const stream = new FakeStream('connected');
    const core = fakeCore([approvable('t1', 'Members evening poster')]);
    const { view } = await renderWork(stream);
    mounted.push(view);
    const status = () => view.container.querySelector('[data-testid="task-status"]')?.textContent;

    await click(view.container.querySelector('#btn-request-revision'));
    const notes = view.container.querySelector('textarea.hawa-textarea') as HTMLTextAreaElement;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(notes, 'Make the Kurdish headline larger');
      notes.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(byText(view.container, 'button', 'Submit Revision Request'));
    await advance(100);

    expect(core.calls.find((c) => c.method === 'POST' && c.path.endsWith('/decisions'))?.body).toMatchObject({
      action: 'revision_requested',
      revisionRequest: { comment: 'Make the Kurdish headline larger' },
    });
    expect(byText(view.container, 'button', 'Sending request…')?.hasAttribute('disabled')).toBe(true);
    expect(status()).toBe('NEEDS APPROVAL');

    core.tasks.find((t) => t.id === 't1')!.status = 'REVISION_REQUESTED';
    core.answerDecision(json({ decisionId: 'd2' }, 201));
    await advance(500);
    expect(status()).toBe('CHANGES REQUESTED');
    expect(view.text()).toContain('Core now reports this task as CHANGES REQUESTED');
  });
});

describe('an expired session reaches sign-in from any screen, once', () => {
  const expired = (c: FetchCall) =>
    c.path === '/v1/health' ? json({ status: 'ok' }) : json({ title: 'Authentication Required', detail: 'Session expired' }, 401);

  async function renderApp(screen: string): Promise<{ runtime: DeskRuntime; stream: FakeStream; view: Awaited<ReturnType<typeof mount>> }> {
    window.location.hash = `#/${screen}`;
    const stream = new FakeStream('connected');
    const runtime = createDeskRuntime({ stream, doc: { hidden: false } });
    const view = await mount(h(DeskProviders, { runtime, children: h(App) }));
    mounted.push(view);
    return { runtime, stream, view };
  }

  const signInForms = (container: HTMLElement) => container.querySelectorAll('input[aria-label="Office access key"]').length;

  for (const screen of ['work', 'review', 'clients', 'library', 'settings', 'ops', 'eval', 'comparison']) {
    it(`from the ${screen} screen, opened with a session Core no longer accepts`, async () => {
      stubCore(expired);
      const { runtime, stream, view } = await renderApp(screen);
      await advance(3_000);
      expect(signInForms(view.container)).toBe(1);
      expect(runtime.session.getState()).toMatchObject({ status: 'signed_out', ended: 1 });
      expect(view.text()).toContain('Your session has ended (Core answered: Session expired). Sign in again to continue.');
      expect(getAuthToken()).toBeNull();
      expect(stream.disconnects).toBe(1);
      // Whatever else is still running (panels, polls) does not end it again.
      await advance(2 * 60_000);
      expect(runtime.session.getState().ended).toBe(1);
      expect(signInForms(view.container)).toBe(1);
    });
  }

  it('mid-use, from a screen not on the query layer: its first 401 makes the Desk check the session, and sign-in shows once', async () => {
    let sessionEnded = false;
    const calls = stubCore((c) => {
      if (sessionEnded) return expired(c);
      if (c.path === '/v1/auth/session') return json({ authenticated: true, user: { id: 'u1', role: 'operator', displayName: 'Operator' } });
      if (c.path === '/v1/health') return json({ status: 'ok' });
      return json({});
    });
    const { runtime, view } = await renderApp('ops');
    await advance(3_000);
    expect(runtime.session.getState().status).toBe('signed_in');
    expect(signInForms(view.container)).toBe(0);
    const sessionReads = calls.filter((c) => c.path === '/v1/auth/session').length;

    // The session expires. Three calls outside the query layer meet it.
    sessionEnded = true;
    await Promise.all([
      apiClient.operations.failures().catch(() => undefined),
      apiClient.operations.slo().catch(() => undefined),
      apiClient.canva.status().catch(() => undefined),
    ]);
    await advance(1_000);
    expect(calls.filter((c) => c.path === '/v1/auth/session').length).toBe(sessionReads + 1);
    expect(runtime.session.getState()).toMatchObject({ status: 'signed_out', ended: 1 });
    expect(signInForms(view.container)).toBe(1);
  });

  it('signing in again opens the stream and shows the screen', async () => {
    let accepted = false;
    stubCore((c) => {
      if (c.path === '/v1/auth/session' && c.method === 'POST') {
        accepted = true;
        return json({ ok: true, token: ['hawa', 'sess', 'new'].join('_'), user: { id: 'u1', role: 'art_director' } }, 201);
      }
      if (!accepted) return expired(c);
      if (c.path === '/v1/auth/session') return json({ authenticated: true, user: { id: 'u1', role: 'art_director', displayName: 'Art Director' } });
      if (isListRead(c)) return json({ items: [], total: 0, limit: 50, nextCursor: null });
      return json({});
    });
    const { runtime, stream, view } = await renderApp('work');
    await advance(3_000);
    expect(signInForms(view.container)).toBe(1);
    const input = view.container.querySelector('input[aria-label="Office access key"]') as HTMLInputElement;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'office-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(byText(view.container, 'button', 'Sign In'));
    await advance(1_000);
    expect(runtime.session.getState().status).toBe('signed_in');
    expect(signInForms(view.container)).toBe(0);
    expect(stream.connects).toBeGreaterThanOrEqual(2);
    expect(view.text()).toContain('No tasks currently pending in the work queue.');
  });
});
