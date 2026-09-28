// @vitest-environment jsdom
import React from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  requestId?: string;
  revision?: number;
  revisionId?: string;
  approved?: boolean;
  fontFamilyPass?: boolean | null;
}

const approvable = (id: string, title: string): FakeTask => ({ id, title, status: 'AWAITING_APPROVAL', revision: 1 });

/** A task as GET /tasks lists it and as GET /tasks/:id returns it. */
function asTask(t: FakeTask) {
  return {
    id: t.id,
    ...(t.requestId ? { requestId: t.requestId } : {}),
    title: t.title,
    status: t.status,
    clientName: 'KAAE',
    version: t.revision ?? 0,
    updatedAt: `2026-09-24T10:00:0${t.revision ?? 0}.000Z`,
    ...(t.revision
      ? {
          latestRevisionId: t.revisionId || `r${t.revision}`,
          latestRevision: { id: t.revisionId || `r${t.revision}`, version: t.revision, sha256: 'ab'.repeat(32), format: 'png' },
          qaReport: { passed: true, bidiIsolation: true, safeMargins: true, contrastCompliant: true, fontCoverage: true,
            ...(t.fontFamilyPass !== undefined ? { fontFamilyPass: t.fontFamilyPass } : {}), errors: [] },
        }
      : {}),
    ...(t.approved ? { latestApproval: { decisionId: 'd1', role: 'art_director', decidedAt: '2026-09-24T10:05:00.000Z' } } : {}),
  };
}

/** Core as the Work screen reads it. `decision` holds a POST .../decisions until the test answers it. */
function fakeCore(initial: FakeTask[], opts: { role?: string; listIds?: string[] } = {}) {
  const tasks = [...initial];
  let answerDecision: ((res: Response) => void) | null = null;
  const calls = stubCore((c: FetchCall) => {
    if (c.path === '/v1/auth/session' && c.method === 'GET') {
      return json({ authenticated: true, user: { id: 'u1', role: opts.role ?? 'art_director', displayName: 'Art Director' } });
    }
    if (isListRead(c)) return json({ items: tasks.filter(t => !opts.listIds || opts.listIds.includes(t.id)).map(asTask), total: tasks.length, limit: 50, nextCursor: null });
    const detail = /^\/v1\/tasks\/([^/]+)$/.exec(c.path);
    if (detail && c.method === 'GET') {
      const t = tasks.find((x) => x.id === detail[1]);
      return t ? json(asTask(t)) : json({ title: 'Not Found' }, 404);
    }
    if (/^\/v1\/tasks\/[^/]+\/timeline$/.test(c.path)) return json({ events: [] });
    const requesterSend = /^\/v1\/tasks\/([^/]+)\/requester-send-evidence$/.exec(c.path);
    if (requesterSend && c.method === 'GET') {
      const t = tasks.find((task) => task.id === requesterSend[1]);
      if (t?.status !== 'REQUESTER_SEND_RECONCILIATION') return json({ title: 'No Uncertain Requester Send' }, 409);
      return json({ taskId: t.id, requestId: t.requestId, requestRev: 5, publicationId: 'p1',
        approvalId: 'd1', requesterChatId: '123456789', providerReceipt: 'not_available',
        files: [{ artifactId: 'a1', filename: 'approved-export.pptx', sha256: 'ab'.repeat(32),
          sendKey: 'send-file-a1', outcome: 'sent', attemptCount: 1, lastMarkAt: '2026-09-25T10:00:00.000Z', messageId: '87' }],
        notice: { sendKey: 'send-notice', outcome: 'uncertain', attemptCount: 1, lastMarkAt: '2026-09-25T10:00:01.000Z', messageId: null } });
    }
    const sendConfirmation = /^\/v1\/tasks\/([^/]+)\/requester-send-confirmation$/.exec(c.path);
    if (sendConfirmation && c.method === 'POST') {
      const t = tasks.find((task) => task.id === sendConfirmation[1]);
      if (!t || opts.role !== 'office_admin') return json({ title: 'Office Administrator Required' }, 403);
      if (c.body?.requesterChatId !== '123456789' ||
          c.body?.observed?.[0]?.messageId !== '87' || c.body?.observed?.[1]?.messageId !== '88') {
        return json({ title: 'Evidence Mismatch' }, 409);
      }
      t.status = 'COMPLETE';
      return json({ requestId: t.requestId, taskId: t.id, stage: 'delivered', requestRev: 6,
        confirmationSource: 'staff_visible' });
    }
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
    /**
     * Waits until the decision has reached Core. The Desk first digests the action key
     * (crypto.subtle, decisionActionId.ts): real work that no fake timer drives, so a fixed fake-time
     * advance after the click could look before the request left. On a loaded CI runner it did
     * (2026-09-28: 'no decision is waiting', and no POST recorded).
     */
    async decisionSent() {
      await React.act(async () => {
        await vi.waitFor(() => {
          if (!answerDecision) throw new Error('the decision has not reached Core yet');
        }, { timeout: 5000, interval: 5 });
      });
    },
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
  mounted.push({ view, runtime });
  await advance(500);
  const queue = () => view.container.querySelector('[aria-label="Tasks List"]')?.textContent || '';
  return { runtime, view, queue };
}

const mounted: Array<{ view: { unmount(): Promise<void> }; runtime: DeskRuntime }> = [];

/**
 * An event or a status change from the stream updates the screens (a toast, the connection state),
 * so it is delivered inside act, as the harness's clicks and timers are. Outside it React logged
 * "not wrapped in act" for each one.
 */
const live = (deliver: () => void) =>
  React.act(async () => {
    deliver();
  });

/**
 * Nothing these screens do may write to the console. React wrote a warning whenever a lazily loaded
 * screen (App.tsx) arrived: its module import finished at no fixed time, often after the test that
 * rendered it, and sometimes after the file, when vitest failed the run on the pending console call
 * ('onUserConsoleLog pending', about one run in four). Waits of 20 ms after each test and 100 ms
 * after the file hid that on a quiet machine. Now those screens are loaded before any test renders
 * them, so each arrives inside the test's own act; every console call is kept here for the whole
 * file, never sent on to vitest, and fails the test it happened in.
 */
const consoleCalls: string[] = [];
const consoleSpies: Array<{ mockRestore(): void }> = [];

beforeAll(async () => {
  await Promise.all([
    import('../src/screens/ClientsScreen.js'),
    import('../src/screens/SettingsScreen.js'),
    import('../src/screens/OpsScreen.js'),
    import('../src/screens/EvalScreen.js'),
    import('../src/screens/ComparisonScreen.js'),
  ]);
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    consoleSpies.push(vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(`console.${level}: ${args.map(String).join(' ')}`);
    }));
  }
});

beforeEach(() => {
  vi.useFakeTimers();
  setAuthToken(['hawa', 'sess', 'test'].join('_'));
});

afterEach(async () => {
  while (mounted.length) {
    const { view, runtime } = mounted.pop()!;
    await view.unmount();
    // Queries of the unmounted screens (a refetch in flight, a retry waiting) are dropped here, on
    // fake time: nothing of this test runs after it.
    await runtime.queryClient.cancelQueries();
    runtime.queryClient.clear();
  }
  await flush();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearAuthToken();
  apiClient.auth.setUnauthorizedHint(null);
  window.location.hash = '';
  // Emptied as it is checked: a call that comes in after this check fails the next test's.
  expect(consoleCalls.splice(0)).toEqual([]);
});

afterAll(() => {
  // Given back to vitest once the file is done: a call that still came after it is then reported
  // (and fails the run), not swallowed here.
  for (const spy of consoleSpies.splice(0)) spy.mockRestore();
  expect(consoleCalls).toEqual([]);
});

describe('the Work queue follows the event stream', () => {
  it.each([undefined, true, false, null])('keeps rendered glyphs unverified with legacy coverage=true and family result %s', async (fontFamilyPass) => {
    fakeCore([{ ...approvable('t1', 'Font evidence'), fontFamilyPass }]);
    const { view } = await renderWork(new FakeStream('connected'));
    await click(byText(view.container, 'button', /QA Preflight/));
    const panel = view.container.querySelector('[aria-label="Automated QA Preflight"]')!;
    expect(panel.textContent).not.toContain('All glyphs covered');
    expect(panel.textContent).not.toContain('Zero placeholder tofu boxes');
    const rows = [...panel.querySelectorAll('.qa-item')];
    const family = rows.find(row => row.textContent?.includes('Declared font families'));
    const glyphs = rows.find(row => row.textContent?.includes('Rendered glyph coverage'));
    expect(family?.classList.contains(fontFamilyPass === true ? 'passed' : fontFamilyPass === false ? 'failed' : 'pending')).toBe(true);
    expect(glyphs?.classList.contains('pending')).toBe(true);
  });

  it('shows a new draft within 2 s of its event', async () => {
    const stream = new FakeStream('connected');
    const core = fakeCore([approvable('t1', 'Members evening poster')]);
    const { view, queue } = await renderWork(stream);
    expect(queue()).toContain('Members evening poster');

    // A new request arrives.
    core.tasks.unshift(approvable('t2', 'Graduation ceremony draft'));
    await live(() => stream.emit('task:created', { id: 't2', taskId: 't2', title: 'Graduation ceremony draft' }));
    await advance(2_000);
    expect(queue()).toContain('Graduation ceremony draft');

    // A new draft of the task on screen: its detail (the preview) is read again.
    const detailReads = core.reads('/v1/tasks/t1');
    core.tasks.find((t) => t.id === 't1')!.revision = 2;
    await live(() => stream.emit('task:revision_created', { taskId: 't1' }));
    await advance(2_000);
    expect(core.reads('/v1/tasks/t1')).toBe(detailReads + 1);
    expect(view.container.querySelector('.revision-badge')?.textContent).toContain('Revision v2');
  });

  it('an idle tab makes no list requests while the stream is up, polls only while it is down, and reads once on reconnect', async () => {
    const stream = new FakeStream('connected');
    const core = fakeCore([approvable('t1', 'Members evening poster')]);
    const { view } = await renderWork(stream);
    const first = core.listReads();
    expect(first).toBe(1);

    await advance(10 * 60_000);
    expect(core.listReads()).toBe(first);

    // The stream drops: the list is polled every 30 s until it is back.
    await flush();
    await live(() => stream.setStatus('connecting'));
    await flush();
    await advance(61_000);
    expect(core.listReads()).toBe(first + 2);

    // Back: one read for what it missed, then nothing again.
    await live(() => stream.setStatus('connected'));
    await advance(1_000);
    expect(core.listReads()).toBe(first + 3);
    await advance(5 * 60_000);
    expect(core.listReads()).toBe(first + 3);
  });

  it('a burst of 20 task events causes one read of the list and one of the task it names', async () => {
    const stream = new FakeStream('connected');
    const core = fakeCore([approvable('t1', 'Members evening poster')]);
    const { view } = await renderWork(stream);
    const lists = core.listReads();
    const details = core.reads('/v1/tasks/t1');

    for (let i = 0; i < 20; i++) {
      await live(() => stream.emit(TASK_EVENTS[i % TASK_EVENTS.length], { taskId: 't1' }));
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
    const lists = core.listReads();

    doc.hidden = true;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    for (let i = 0; i < 5; i++) await live(() => stream.emit('task:transitioned', taskTransitioned({ taskId: 't1', from: 'human_review', to: 'human_review', version: i + 2 })));
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
  it('holds an uncertain Telegram send for staff without offering Sheet or delivery retry', async () => {
    const stream = new FakeStream('connected');
    const core = fakeCore([{ id: 't1', title: 'Members evening poster', status: 'REQUESTER_SEND_RECONCILIATION',
      requestId: '11111111-1111-4111-8111-111111111111', revision: 1, approved: true }]);
    const { view } = await renderWork(stream);
    expect(view.text()).toContain('Requester delivery did not complete or could not be confirmed');
    expect(view.text()).toContain('Check Telegram Delivery');
    expect(view.text()).toContain('approved-export.pptx');
    expect(view.text()).toContain('Bot API message ID: 87');
    expect(view.text()).toContain('May have arrived; requester receipt unknown');
    expect(view.text()).toContain('Telegram requester receipt: unavailable');
    expect(view.text()).not.toContain('Confirm visible in requester chat');
    expect(view.text()).not.toContain('Retry Sheet Sync');
    expect(view.container.querySelector('#btn-deliver-approved')?.hasAttribute('disabled')).toBe(true);
    await click(view.container.querySelector('#btn-deliver-approved'));
    expect(core.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/publish'))).toHaveLength(0);
  });

  it('requires office administrator inspection of every send before recording confirmation', async () => {
    const stream = new FakeStream('connected');
    const core = fakeCore([{ id: 't1', title: 'Members evening poster', status: 'REQUESTER_SEND_RECONCILIATION',
      requestId: '11111111-1111-4111-8111-111111111111', revision: 1, approved: true }], { role: 'office_admin' });
    const { view } = await renderWork(stream);
    const button = byText(view.container, 'button', 'Confirm visible in requester chat');
    expect(button?.hasAttribute('disabled')).toBe(true);
    const notice = view.container.querySelector('input[aria-label="Observed message ID for delivery notice"]') as HTMLInputElement;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(notice, '88');
      notice.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button?.hasAttribute('disabled')).toBe(true);
    const checkbox = view.container.querySelector('.requester-send-confirmation input[type="checkbox"]') as HTMLInputElement;
    await click(checkbox);
    expect(button?.hasAttribute('disabled')).toBe(false);
    await click(button);
    await advance(100);
    expect(core.calls.find((call) => call.method === 'POST' &&
      call.path.endsWith('/requester-send-confirmation'))?.body).toMatchObject({
      expectedRev: 5, publicationId: 'p1', approvalId: 'd1', requesterChatId: '123456789',
      attested: true, observed: [{ sendKey: 'send-file-a1', messageId: '87' },
        { sendKey: 'send-notice', messageId: '88' }],
    });
  });

  it('offers a request-owned Sheet retry only when Core reports the reconciliation status', async () => {
    const stream = new FakeStream('connected');
    fakeCore([{ id: 't1', title: 'Members evening poster', status: 'PUBLISH_RECONCILIATION',
      requestId: '11111111-1111-4111-8111-111111111111', revision: 1, approved: true }]);
    const { view } = await renderWork(stream);
    expect(view.text()).toContain('Sheets row is not confirmed');
    expect(view.text()).toContain('Retry Sheet Sync');
    expect(view.container.querySelector('#btn-deliver-approved')?.hasAttribute('disabled')).toBe(false);
  });

  it('shows uncertain Drive archive in Needs Action with a safe recheck action', async () => {
    const stream = new FakeStream('connected');
    fakeCore([{ id: 't1', title: 'Members evening poster', status: 'ARCHIVE_RECONCILIATION',
      requestId: '11111111-1111-4111-8111-111111111111', revision: 1, approved: true }]);
    const { view } = await renderWork(stream);
    expect(view.text()).toContain('Drive may already have the approved files');
    expect(view.text()).toContain('Recheck Drive Archive');
    expect(view.container.querySelector('#btn-deliver-approved')?.hasAttribute('disabled')).toBe(false);
  });

  it('shows a request-owned approval as recorded while delivery remains unavailable', async () => {
    const stream = new FakeStream('connected');
    const core = fakeCore([{ ...approvable('t1', 'Members evening poster'),
      requestId: '11111111-1111-4111-8111-111111111111' }]);
    const { view } = await renderWork(stream);
    await click(view.container.querySelector('#btn-approve-captured'));
    await advance(100);
    expect(view.text()).toContain('Approve Captured Files');
    expect(view.text()).not.toContain('Authorize Release & Approve');
    await click(byText(view.container, 'button', 'Confirm Approval'));
    await core.decisionSent();
    await advance(100);
    const t1 = core.tasks[0];
    t1.status = 'APPROVED';
    t1.approved = true;
    core.answerDecision(json({ decisionId: 'd1' }, 201));
    await advance(500);
    expect(view.text()).toContain('Delivery will need a separate workflow action.');
    expect(view.text()).toContain('Approval is recorded. Delivery starts separately');
    expect(view.container.querySelector('#btn-deliver-approved')?.hasAttribute('disabled')).toBe(false);
    expect(core.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/publish'))).toHaveLength(0);
  });

  it('approve shows pending, leaves the status Core reported until Core answers, then reads the task and the list again', async () => {
    const stream = new FakeStream('connected');
    const core = fakeCore([approvable('t1', 'Members evening poster')]);
    const { runtime, view } = await renderWork(stream);
    const status = () => view.container.querySelector('[data-testid="task-status"]')?.textContent;
    expect(status()).toBe('NEEDS APPROVAL');

    await click(view.container.querySelector('#btn-approve-captured'));
    await advance(100);
    await click(byText(view.container, 'button', 'Confirm Approval'));
    await core.decisionSent();
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
    await click(view.container.querySelector('#btn-approve-captured'));
    await advance(100);
    await click(byText(view.container, 'button', 'Confirm Approval'));
    await core.decisionSent();
    await advance(100);
    const lists = core.listReads();
    core.answerDecision(json({ title: 'Conflict', detail: 'The revision changed since it was captured' }, 409));
    await advance(500);
    expect(view.container.querySelector('[data-testid="task-status"]')?.textContent).toBe('NEEDS APPROVAL');
    expect(view.text()).toContain('Approval failed: The revision changed since it was captured');
    expect(core.listReads()).toBe(lists);
    expect(byText(view.container, 'button', 'Confirm Approval')?.hasAttribute('disabled')).toBe(false);
  });

  it('an approval Core recorded is reported as recorded even when reading the task again fails', async () => {
    const stream = new FakeStream('connected');
    const core = fakeCore([approvable('t1', 'Members evening poster')]);
    const { view } = await renderWork(stream);
    await click(view.container.querySelector('#btn-approve-captured'));
    await advance(100);
    await click(byText(view.container, 'button', 'Confirm Approval'));
    await core.decisionSent();
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
    const status = () => view.container.querySelector('[data-testid="task-status"]')?.textContent;

    await click(view.container.querySelector('#btn-request-revision'));
    const notes = view.container.querySelector('textarea.hawa-textarea') as HTMLTextAreaElement;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(notes, 'Make the Kurdish headline larger');
      notes.dispatchEvent(new Event('input', { bubbles: true }));
    });
    for (const [id, value] of [['revision-scope', 'typography'],
      ['revision-category', 'aesthetic_preference'], ['revision-priority', 'high']]) {
      const select = view.container.querySelector(`#${id}`) as HTMLSelectElement;
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    const targets = view.container.querySelector('#revision-targets') as HTMLInputElement;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(targets, 'headline');
      targets.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(byText(view.container, 'button', 'Submit Revision Request'));
    await core.decisionSent();
    await advance(100);

    expect(core.calls.find((c) => c.method === 'POST' && c.path.endsWith('/decisions'))?.body).toMatchObject({
      action: 'revision_requested',
      revisionRequest: { scope: 'typography', category: 'aesthetic_preference', targetNodes: ['headline'],
        priority: 'high', isReusableFeedback: false, comment: 'Make the Kurdish headline larger' },
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
    mounted.push({ view, runtime });
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

  it("clears the offline copies of Core's answers at sign-out (audit 2026-09-27 #21)", async () => {
    const deleted: string[] = [];
    const fakeCaches = {
      keys: async () => ['hawa-api-v1', 'hawa-shell-v1', 'another-app'],
      delete: async (key: string) => { deleted.push(key); return true; },
    };
    Object.defineProperty(window, 'caches', { value: fakeCaches, configurable: true });
    try {
      stubCore(expired);
      const { runtime } = await renderApp('work');
      await advance(3_000);
      expect(runtime.session.getState()).toMatchObject({ status: 'signed_out' });
      await flush();
      expect(deleted.sort()).toEqual(['hawa-api-v1', 'hawa-shell-v1']);
    } finally {
      delete (window as { caches?: unknown }).caches;
    }
  });

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

describe('chat review navigation (ADR-065)', () => {
  const taskId = 'aa000000-0000-4000-8000-000000000001';
  const revisionId = 'aa000000-0000-4000-8000-000000000002';
  const oldRevision = 'aa000000-0000-4000-8000-000000000003';
  async function openLink(hash: string) {
    window.location.hash = hash;
    const runtime = createDeskRuntime({ stream: new FakeStream('connected'), doc: { hidden: false } });
    const view = await mount(h(DeskProviders, { runtime, children: h(App) }));
    mounted.push({ view, runtime });
    await advance(3_000);
    return { view, runtime };
  }

  for (const hash of [`#/work?task=${taskId}&revision=${revisionId}`, `#task-${taskId}`]) {
    it(`opens the linked task, not the first queue item: ${hash}`, async () => {
      fakeCore([approvable('first', 'Unrelated first task'), { ...approvable(taskId, 'Linked review'), revisionId }], { listIds: ['first'] });
      const { view } = await openLink(hash);
      const detail = view.container.querySelector('[aria-label="Task Detail View"]')!;
      expect(detail.textContent).toContain('Linked review');
      expect(detail.textContent).not.toContain('Unrelated first task');
      expect(detail.classList.contains('mobile-hidden')).toBe(false);
    });
  }

  it('does not substitute a queue task when the linked task is unavailable', async () => {
    fakeCore([approvable('first', 'Unrelated first task')]);
    const { view } = await openLink(`#/work?task=${taskId}&revision=${revisionId}`);
    const detail = view.container.querySelector('[aria-label="Task Detail View"]')!;
    expect(detail.textContent).toContain('Linked task unavailable');
    expect(detail.textContent).not.toContain('Unrelated first task');
  });

  it('requires an explicit review of the current revision after opening an old notification', async () => {
    const core = fakeCore([{ ...approvable(taskId, 'Linked review'), revisionId }]);
    const { view, runtime } = await openLink(`#/work?task=${taskId}&revision=${oldRevision}`);
    expect(view.text()).toContain('This notification names an older revision');
    expect((byText(view.container, 'button', 'Approve Captured Files') as HTMLButtonElement).disabled).toBe(true);
    expect((byText(view.container, 'button', 'Request Revision') as HTMLButtonElement).disabled).toBe(true);
    await click(byText(view.container, 'button', 'Review current revision'));
    expect((byText(view.container, 'button', 'Approve Captured Files') as HTMLButtonElement).disabled).toBe(false);
    expect(core.calls.filter(c => c.method === 'POST')).toHaveLength(0);
    core.tasks[0] = { ...core.tasks[0], revisionId: 'aa000000-0000-4000-8000-000000000004', revision: 2 };
    await live(() => { void runtime.queryClient.invalidateQueries({ queryKey: queryKeys.taskDetail(taskId) }); });
    await advance(500);
    expect((byText(view.container, 'button', 'Approve Captured Files') as HTMLButtonElement).disabled).toBe(true);
  });

  it('follows another task link in an already open Desk tab', async () => {
    fakeCore([approvable('first', 'Unrelated first task'), { ...approvable(taskId, 'Linked review'), revisionId }]);
    const { view } = await openLink('#/work');
    await live(() => {
      window.location.hash = `#/work?task=${taskId}&revision=${revisionId}`;
      window.dispatchEvent(new Event('hashchange'));
    });
    await advance(500);
    expect(view.container.querySelector('.detail-title')?.textContent).toBe('Linked review');
  });

  it('carries only the parsed task and revision into Google sign-in', async () => {
    clearAuthToken();
    stubCore(c => c.path === '/v1/auth/providers' ? json({ googleWorkspace: true })
      : c.path === '/v1/health' ? json({ status: 'ok' }) : json({ title: 'Sign in' }, 401));
    const { view } = await openLink(`#/work?task=${taskId}&revision=${revisionId}`);
    const signIn = byText(view.container, 'a', 'Sign in with Google Workspace');
    expect(signIn?.getAttribute('href')).toBe(`/v1/auth/google/start?task=${taskId}&revision=${revisionId}`);
  });
});
