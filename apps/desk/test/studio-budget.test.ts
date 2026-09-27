// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { StudioBudgetSummary, type StudioBudgetUsage } from '../src/components/StudioBudgetSummary.js';
import { mount } from './support/desk-harness.js';
afterEach(() => { document.body.innerHTML = ''; });
const usage: StudioBudgetUsage = { maxUsd: 2, maxCalls: 3, admittedCalls: 3, knownUsdEstimate: 0.25,
  attestedAdditionalUsd: 0.5, accountedUsd: 0.75, reservedAdditionalUsd: 0.5, committedUsd: 1.25, remainingUsd: 0.75, unresolvedCalls: 0, blocker: 'BUDGET_EXHAUSTED' };
it('shows cumulative calls and separately reported spend with the admission refusal', async () => {
  const view = await mount(React.createElement(StudioBudgetSummary, { usage }));
  expect(view.text()).toContain('Calls: 3 / 3');
  expect(view.text()).toContain('Spending counted: $0.750 / $2.000');
  expect(view.text()).toContain('Available within this run: $0.750');
  expect(view.text()).toContain('Reserved for unfinished or estimated calls: $0.500');
  expect(view.text()).toContain('Recorded estimates: $0.250');
  expect(view.text()).toContain('administrator-reported cost: $0.500');
  expect(view.text()).toContain('Further model calls are blocked');
  await view.unmount();
});
it('keeps incomplete cost and missing accounting visible', async () => {
  let view = await mount(React.createElement(StudioBudgetSummary, { usage: { ...usage, unresolvedCalls: 1 } }));
  expect(view.text()).toContain('Final cost unknown for 1 call(s)');
  await view.unmount();
  view = await mount(React.createElement(StudioBudgetSummary));
  expect(view.text()).toContain('Budget accounting unavailable');
  expect(view.text()).not.toContain('$0.000');
  await view.unmount();
});
it('shows daily Studio scope limits and retained obligations without implying app-wide coverage', async () => {
  const view = await mount(React.createElement(StudioBudgetSummary, { usage: { ...usage,
    daily: { day: '2026-09-27', timezone: 'Asia/Baghdad', policyVersion: 2, scopes: [
      { scope: 'office', subject: 'office', maxUsd: 30, spentUsd: 1, heldUsd: 2, remainingUsd: 27, historyIncomplete: false },
      { scope: 'role', subject: 'visual_judge', maxUsd: 1, spentUsd: 0, heldUsd: 0, remainingUsd: 1, historyIncomplete: true },
    ] } } }));
  expect(view.text()).toContain('Studio daily limits');
  expect(view.text()).toContain('2026-09-27 (Asia/Baghdad)');
  expect(view.text()).toContain('office: $27.000 available / $30.000');
  expect(view.text()).toContain('$1.000 recorded today, $2.000 held');
  expect(view.text()).toContain('Historical cost is unresolved; new spending is blocked');
  await view.unmount();
});
