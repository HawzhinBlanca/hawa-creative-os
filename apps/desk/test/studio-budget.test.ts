// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { StudioBudgetSummary, type StudioBudgetUsage } from '../src/components/StudioBudgetSummary.js';
import { mount } from './support/desk-harness.js';
afterEach(() => { document.body.innerHTML = ''; });
const usage: StudioBudgetUsage = { maxUsd: 2, maxCalls: 3, admittedCalls: 3, knownUsdEstimate: 0.25,
  attestedAdditionalUsd: 0.5, accountedUsd: 0.75, unresolvedCalls: 0, blocker: 'BUDGET_EXHAUSTED' };
it('shows cumulative calls and separately reported spend with the admission refusal', async () => {
  const view = await mount(React.createElement(StudioBudgetSummary, { usage }));
  expect(view.text()).toContain('Calls: 3 / 3');
  expect(view.text()).toContain('Spending counted: $0.750 / $2.000');
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
