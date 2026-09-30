// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { StudioJudgeNotice } from '../src/components/StudioJudgeNotice.js';
import { mount } from './support/desk-harness.js';
afterEach(() => { document.body.innerHTML = ''; });

/** ADR-124: when automated preference is uncertain or untrusted, the Desk asks a person to choose. */
it('asks the reviewer to choose when the judge was uncertain, and says why', async () => {
  const view = await mount(React.createElement(StudioJudgeNotice, { tournament: {
    decidedBy: 'composite_judge_uncertain', judgeProtocol: 'brief_bound_v1', humanChoiceRecommended: true } }));
  expect(view.text()).toContain('Choose the design yourself');
  expect(view.text()).toContain('could not decide');
  expect(view.text()).toContain('brief-bound');
  expect(document.querySelector('[role="status"]')).not.toBeNull();
  await view.unmount();
});
it('explains an untrusted and an unavailable judge', async () => {
  let view = await mount(React.createElement(StudioJudgeNotice, { tournament: {
    decidedBy: 'composite_judge_unreliable', humanChoiceRecommended: true } }));
  expect(view.text()).toContain('degraded copy');
  await view.unmount();
  view = await mount(React.createElement(StudioJudgeNotice, { tournament: {
    decidedBy: 'composite_judge_unavailable', humanChoiceRecommended: true } }));
  expect(view.text()).toContain('unavailable');
  await view.unmount();
});
it('shows nothing when the judge decided or the run has not been judged', async () => {
  for (const tournament of [undefined, null, { decidedBy: 'judge', humanChoiceRecommended: false }, { decidedBy: 'single_candidate' }]) {
    const view = await mount(React.createElement(StudioJudgeNotice, { tournament }));
    expect(view.text()).toBe('');
    await view.unmount();
  }
});
it('is wired into the Studio panel from the run stages', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../src/components/StudioPanel.tsx'), 'utf8');
  expect(source).toMatch(/<StudioJudgeNotice tournament=\{run\.stages\?\.tournament\}/);
});

it('keeps a style fallback visible as a review choice after judge uncertainty', async () => {
  const view = await mount(React.createElement(StudioJudgeNotice, { tournament: {
    decidedBy: 'art_direction_prior', humanChoiceRecommended: true } }));
  expect(view.text()).toContain('Choose the design yourself');
  expect(view.text()).toContain('style policy');
  expect(view.text()).toContain('judge');
  await view.unmount();
});
