// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { DesignReviewFindings } from '../src/components/DesignReviewFindings.js';
import { mount } from './support/desk-harness.js';

afterEach(() => { document.body.innerHTML = ''; });
it('shows saved unmeasured and uncovered font evidence as review warnings without claiming approval', async () => {
  const findings = [
    { code: 'FONT_FIDELITY_UNMEASURED', severity: 'warning', message: 'The rendered font for Amiri could not be verified; inspect its appearance in the final export before approval.' },
    { code: 'FONT_FIDELITY_UNCOVERED', severity: 'warning', message: 'The local face does not cover its verification sample; inspect the text in the final export.' },
  ];
  const before = JSON.stringify(findings);
  const view = await mount(React.createElement(DesignReviewFindings, { findings: JSON.parse(before) }));
  expect(view.text()).toContain('Check before approving');
  expect(view.text()).toContain('could not be verified');
  expect(view.text()).toContain('does not cover');
  expect(view.text()).toContain('Original copy is unchanged');
  expect(view.container.querySelector('button')).toBeNull();
  expect(JSON.stringify(findings)).toBe(before);
  await view.unmount();
});
