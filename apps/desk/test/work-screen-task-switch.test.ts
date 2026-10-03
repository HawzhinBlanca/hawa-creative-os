// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkScreen } from '../src/screens/WorkScreen.js';
import { DeskProviders, createDeskRuntime } from '../src/DeskProviders.js';
import { clearAuthToken, setAuthToken } from '../src/services/auth.js';
import { FakeStream, advance, byText, click, flush, isListRead, json, mount, stubCore, type FetchCall } from './support/desk-harness.js';

/**
 * Hunt-3: what the Work screen carries from one task to the next. Rendered for real in jsdom
 * against a fake Core (no network).
 */

const h = React.createElement;
const task = (id: string, title: string) => ({
  id, title, status: 'AWAITING_APPROVAL', clientName: 'KAAE', version: 1, updatedAt: '2026-10-03T10:00:00.000Z',
  latestRevisionId: `rev-${id}`, latestRevision: { id: `rev-${id}`, version: 1, sha256: 'ab'.repeat(32), format: 'png' },
  qaReport: { passed: true, bidiIsolation: true, safeMargins: true, contrastCompliant: true, fontCoverage: true, errors: [] },
});
const TASKS = [task('task-a', 'Alpha poster'), task('task-b', 'Bravo poster')];

let mounted: Array<{ unmount(): Promise<void> }> = [];
beforeEach(() => { vi.useFakeTimers(); setAuthToken(['hawa', 'sess', 'test'].join('_')); });
afterEach(async () => {
  for (const m of mounted) await m.unmount();
  mounted = [];
  await flush();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearAuthToken();
});

function fakeCore(canvaState: (taskId: string) => Promise<Response> | Response) {
  return stubCore((c: FetchCall) => {
    if (c.path === '/v1/auth/session') return json({ authenticated: true, user: { id: 'u1', role: 'art_director', displayName: 'Art Director' } });
    if (isListRead(c)) return json({ items: TASKS, total: TASKS.length, limit: 50, nextCursor: null });
    const detail = /^\/v1\/tasks\/([^/]+)$/.exec(c.path);
    if (detail && c.method === 'GET') return json(TASKS.find((t) => t.id === detail[1]));
    if (/\/timeline$/.test(c.path)) return json({ events: [] });
    const canva = /^\/v1\/tasks\/([^/]+)\/canva$/.exec(c.path);
    if (canva && c.method === 'GET') return canvaState(canva[1]);
    return undefined;
  });
}

async function render() {
  const runtime = createDeskRuntime({ stream: new FakeStream(), doc: { hidden: false } });
  const view = await mount(h(DeskProviders, { runtime, children: h(WorkScreen, {}) }));
  mounted.push(view);
  await advance(500);
  const select = async (title: string) => {
    await click(view.container.querySelector(`[role="listitem"][aria-label^="${title}"]`));
    await advance(100);
  };
  return { view, select };
}

function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  return React.act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('switching tasks on the Work screen (hunt-3)', () => {
  it('the approval modal of the second task never lists or pins the first task\'s exports when its read answers late', async () => {
    let answerA: ((r: Response) => void) | undefined;
    fakeCore((taskId) => taskId === 'task-a'
      ? new Promise<Response>((resolve) => { answerA = resolve; })
      : json({ artifacts: [{ id: 'export-b', format: 'png', sha256: 'cd'.repeat(32), byte_size: 1000 }] }));
    const { view, select } = await render();
    await select('Alpha poster');
    await click(byText(view.container, 'button', 'Approve Captured Files'));
    await click(byText(view.container, '.btn', 'Cancel'));
    await select('Bravo poster');
    await click(byText(view.container, 'button', 'Approve Captured Files'));
    await flush();
    expect(view.text()).toContain('cdcdcdcd'.slice(0, 8));
    // Alpha's read answers only now.
    await React.act(async () => { answerA!(json({ artifacts: [{ id: 'export-a', format: 'png', sha256: 'ef'.repeat(32), byte_size: 2000 }] })); });
    await flush();
    expect(view.text()).not.toContain('efefefef');
    const exportsListed = [...view.container.querySelectorAll<HTMLLabelElement>('label')].filter((l) => /SHA-256/.test(l.textContent || ''));
    expect(exportsListed.map((l) => [l.textContent?.includes('cdcdcdcd'), l.querySelector('input')?.checked])).toEqual([[true, true]]);
  });

  it('notes typed for one task are not carried into the revision request of the next', async () => {
    fakeCore(() => json({ artifacts: [] }));
    const { view, select } = await render();
    await select('Alpha poster');
    await click(view.container.querySelector('#btn-request-revision'));
    await typeInto(view.container.querySelector<HTMLTextAreaElement>('#revision-comment')!, 'Make the Alpha logo larger');
    expect(view.container.querySelector<HTMLTextAreaElement>('#revision-comment')!.value).toBe('Make the Alpha logo larger');
    await click(byText(view.container, '.btn', 'Cancel'));
    await select('Bravo poster');
    await click(view.container.querySelector('#btn-request-revision'));
    expect(view.container.querySelector<HTMLTextAreaElement>('#revision-comment')!.value).toBe('');
  });
});
