// @vitest-environment jsdom
import React from 'react';
import {expect,it} from 'vitest';
import {mount} from './support/desk-harness.js';
import {LearningEvidencePanel,learningEvidenceFromCore} from '../src/components/LearningEvidencePanel.js';
const base={clientId:'client',taskId:'task',actor:{id:'collector',role:'designer'},recordedAt:'2026-10-01T00:00:00Z',basis:'approved_refinement' as const};
it('shows exact corrected designs and distinguishes the collector from the approver',async()=>{
  const evidence=learningEvidenceFromCore('client',[
    {...base,feedbackId:'pair',target:{kind:'design_revision',revisionId:'before',sourceSha256:'a'.repeat(64)},verdict:'corrected'},
    {...base,feedbackId:'pair',target:{kind:'design_revision',revisionId:'after',sourceSha256:'b'.repeat(64)},verdict:'approve',approval:{id:'approval',actorId:'director'}},
    {...base,basis:'revision_decision',feedbackId:'decision',target:{kind:'design_revision',revisionId:'after',sourceSha256:'b'.repeat(64)},verdict:'approve',approval:{id:'approval',actorId:'director'}},
  ]);
  const view=await mount(React.createElement(LearningEvidencePanel,{evidence}));
  expect(view.text()).toContain('1 positive · 1 negative · 0 task holds · 3 receipts');
  expect(view.text()).toContain('Revision: before');expect(view.text()).toContain('Revision: after');
  expect(view.text()).toContain('Recorded by: collector');expect(view.text()).toContain('decided by: director');
  expect(view.text()).toContain('b'.repeat(64));await view.unmount();
});
it('refuses foreign or malformed evidence and never turns a rating into approval',async()=>{
  const receipt={...base,feedbackId:'rating',target:{kind:'studio_candidate',candidateId:'candidate',runId:'run',previewSha256:'a'.repeat(64)},verdict:'rating',rating:9};
  expect(learningEvidenceFromCore('foreign',[receipt])).toBeNull();expect(learningEvidenceFromCore('client',[{...receipt,target:{kind:'bad'}}])).toBeNull();
  const evidence=learningEvidenceFromCore('client',[receipt]);
  const view=await mount(React.createElement(LearningEvidencePanel,{evidence}));
  expect(view.text()).toContain('0 positive · 0 negative · 0 task holds · 1 receipts');expect(view.text()).toContain('rating 9/10');await view.unmount();
});
