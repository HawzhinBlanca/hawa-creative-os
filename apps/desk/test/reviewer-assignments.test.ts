// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReviewerAssignmentsPanel } from '../src/components/ReviewerAssignmentsPanel.js';
import { flush, json, mount, stubCore } from './support/desk-harness.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

it('keeps one action identity when an assignment commits but its first answer is lost', async () => {
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  const userId = '00000000-0000-4000-b000-000000000123';
  let assigned = false;
  let writes = 0;
  stubCore((call) => {
    if (call.path === '/v1/office/review-directory') return json({
      reviewers: [{ userId, displayName: 'Ava', clientId, clientName: 'North Studio' }], projects: [],
    });
    if (call.path === '/v1/office/review-assignments' && call.method === 'GET') return json(assigned
      ? [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, clientId,
        projectId: null, active: true, version: 1 }] : []);
    if (call.path.startsWith('/v1/office/review-assignments/') && call.method === 'PUT') {
      writes++;
      assigned = true;
      if (writes === 1) throw new Error('Desk answer lost after commit');
      return json({ id: call.path.split('/').at(-1), version: 1, replayed: true, created: false });
    }
    return undefined;
  });
  const view = await mount(React.createElement(ReviewerAssignmentsPanel));
  await flush();
  const reviewer = view.container.querySelector<HTMLSelectElement>('select[aria-label="Reviewer and client"]')!;
  const reason = view.container.querySelector<HTMLInputElement>('input[aria-label="Reason for granting review access"]')!;
  await act(async () => {
    reviewer.value = `${clientId}:${userId}`;
    reviewer.dispatchEvent(new Event('change', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(reason, 'Assigned for launch campaign');
    reason.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(view.container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  const form = view.container.querySelector('form')!;
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await flush();
  expect(view.text()).toContain('Access change was not confirmed');
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await flush();
  const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url, init]) =>
    String(url).startsWith('/v1/office/review-assignments/') && init?.method === 'PUT');
  expect(calls).toHaveLength(2);
  expect(calls[0][0]).toBe(calls[1][0]);
  expect((calls[0][1] as RequestInit).headers).toMatchObject({
    'Idempotency-Key': (calls[1][1] as RequestInit).headers?.['Idempotency-Key'],
  });
  expect(view.text()).toContain('now has client-wide review access');
  await view.unmount();
});

it('does not show permission controls to a non-administrator', async () => {
  stubCore((call) => call.path.startsWith('/v1/office/review-')
    ? json({ title: 'Named Administrator Required', status: 403 }, 403) : undefined);
  const view = await mount(React.createElement(ReviewerAssignmentsPanel));
  await flush();
  expect(view.text()).toBe('');
  await view.unmount();
});
