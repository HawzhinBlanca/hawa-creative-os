// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudioPanel } from '../src/components/StudioPanel.js';
import { apiClient } from '../src/api/client.js';
import { advance, click, mount } from './support/desk-harness.js';

vi.mock('../src/components/StudioRecoveryPanel.js', () => ({ StudioRecoveryPanel: () => null }));

/**
 * Bug hunt 3: "Retry design with current policy" re-drove the task and then re-read the failed run
 * it was showing, so the panel kept the old run. It now follows the task's latest run once the new
 * one exists (the retry starts it asynchronously).
 */
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

const run = (id: string, status: string) => ({ run: { id, taskId: 'task', status, tier: 'standard', planId: 'plan',
  ...(status === 'failed' ? { diagnostic: 'Synthetic stage failure' } : {}) }, candidates: [], calls: [] });

it('shows the new run after a design retry, not the failed one', async () => {
  const getRun = vi.spyOn(apiClient.studio, 'getRun').mockImplementation(async (_t: string, id: string) =>
    (id === 'run-1' ? run('run-1', 'failed') : run(id, 'briefing')) as never);
  const latest = vi.spyOn(apiClient.studio, 'latest')
    .mockResolvedValueOnce({ runId: 'run-1', status: 'failed' }) // the new run is not there yet
    .mockResolvedValue({ runId: 'run-2', status: 'briefing' });
  const redrive = vi.spyOn(apiClient.tasks, 'redrive').mockResolvedValue({ ok: true });
  const view = await mount(React.createElement(StudioPanel, { taskId: 'task', taskStatus: 'OPERATOR_REQUIRED', initialRunId: 'run-1', onOpenCanva: vi.fn() }));
  await advance(10);
  expect(view.text()).toContain('failed');
  const retry = Array.from(view.container.querySelectorAll('button')).find((b) => b.textContent?.includes('Retry design with current policy'));
  await click(retry);
  await advance(10);
  expect(redrive).toHaveBeenCalledOnce();
  // While the retry has not made its run yet, the failed run stays, said to be superseded, and cannot be retried twice.
  expect(view.text()).toContain('Waiting for the new run');
  expect(Array.from(view.container.querySelectorAll('button')).find((b) => b.textContent?.includes('Retry design with current policy'))?.disabled).toBe(true);
  await advance(5000);
  expect(latest.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(getRun).toHaveBeenCalledWith('task', 'run-2');
  expect(view.text()).toContain('briefing');
  expect(view.text()).not.toContain('Synthetic stage failure');
  await view.unmount();
});
