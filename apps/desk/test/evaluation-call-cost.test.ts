// @vitest-environment jsdom
import React from 'react';
import {afterEach,expect,it} from 'vitest';
import {EvaluationCallCost} from '../src/components/EvaluationCallCost.js';
import {mount} from './support/desk-harness.js';
afterEach(()=>{document.body.innerHTML='';});
it('shows a bound without representing unknown usage as zero or a final charge',async()=>{
  const view=await mount(React.createElement(EvaluationCallCost,{costBasis:'unknown',spending:{
    usd:.009,policy:'test',requestSha256:'a'.repeat(64),inputTokens:1000,outputTokens:2048}}));
  expect(view.text()).toContain('Unknown');expect(view.text()).toContain('Usage completeness unverified');
  expect(view.text()).toContain('Request bound: $0.009000');expect(view.text()).toContain('output cap 2,048');
  await view.unmount();
});
it('keeps a reported overrun separate from the original request bound',async()=>{
  const view=await mount(React.createElement(EvaluationCallCost,{estimatedCostUsd:.12,costBasis:'usage',spending:{
    usd:.009,policy:'test',requestSha256:'a'.repeat(64),inputTokens:1000,outputTokens:2048}}));
  expect(view.text()).toContain('$0.120000');expect(view.text()).toContain('Estimate from reported usage');
  expect(view.text()).toContain('Request bound: $0.009000');await view.unmount();
});
