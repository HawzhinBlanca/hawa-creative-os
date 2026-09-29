// @vitest-environment jsdom
import React, {act} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {StudioPanel} from '../src/components/StudioPanel.js';
import {StudioFeedbackForm} from '../src/components/StudioFeedbackForm.js';
import {apiClient} from '../src/api/client.js';
import {click,mount} from './support/desk-harness.js';

vi.mock('../src/components/StudioRecoveryPanel.js',()=>({StudioRecoveryPanel:()=>null}));

const props={taskId:'task',runId:'run',candidateId:'candidate',previewSha256:'a'.repeat(64)};
afterEach(()=>{vi.restoreAllMocks();sessionStorage.clear();document.body.innerHTML='';});
async function choose(container:HTMLElement) {
  await click(container.querySelector('input[type="radio"]'));
  const input=container.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async()=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'8');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  });
}
it('does not manufacture a verdict or rating and refuses pending concepts',async()=>{
  const send=vi.spyOn(apiClient.studio,'feedback').mockResolvedValue({});
  let view=await mount(React.createElement(StudioFeedbackForm,{...props,previewSha256:undefined}));
  expect(view.container.querySelector('fieldset')?.disabled).toBe(true);
  expect(view.container.querySelector('input:checked')).toBeNull();
  expect(view.container.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('');
  expect(view.container.querySelector('button')?.disabled).toBe(true);await view.unmount();
  view=await mount(React.createElement(StudioFeedbackForm,props));
  expect(view.container.querySelector('button')?.disabled).toBe(true);await choose(view.container);
  expect(view.container.querySelector('button')?.disabled).toBe(false);
  await click(view.container.querySelector('button'));expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][1]).toMatchObject({candidateId:props.candidateId,previewSha256:props.previewSha256,verdict:'approve',rating:8});
  expect(view.text()).toContain('Final release requires a separate approval');await view.unmount();
});
it('replays the original review across an uncertain response and remount',async()=>{
  const send=vi.spyOn(apiClient.studio,'feedback').mockRejectedValueOnce(new Error('lost response')).mockResolvedValue({replayed:true});
  let view=await mount(React.createElement(StudioFeedbackForm,props));await choose(view.container);
  await click(view.container.querySelector('button'));await view.unmount();
  view=await mount(React.createElement(StudioFeedbackForm,props));
  expect(view.text()).toContain('Retry saved feedback');expect(view.container.querySelector('fieldset')?.disabled).toBe(true);
  await click(view.container.querySelector('button'));
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  expect(sessionStorage.length).toBe(0);await view.unmount();
});

it('opens a transferred design through the authenticated task editor action',async()=>{
  vi.spyOn(apiClient.studio,'getRun').mockResolvedValue({run:{id:'run',taskId:'task',status:'transferred',tier:'standard',planId:'plan'},candidates:[],calls:[]});
  const open=vi.fn();
  const view=await mount(React.createElement(StudioPanel,{taskId:'task',taskStatus:'OPERATOR_REQUIRED',initialRunId:'run',hasCanvaBinding:true,onOpenCanva:open}));
  const button=Array.from(view.container.querySelectorAll('button')).find(b=>b.textContent?.includes('Open Canva Editor'))!;
  expect(button).toBeDefined();expect(view.container.querySelector('a[href*="/canva/editor"]')).toBeNull();
  await click(button);expect(open).toHaveBeenCalledOnce();await view.unmount();
});


it('does not claim native transfer success or open an editor without a linked design',async()=>{
  vi.spyOn(apiClient.studio,'getRun').mockResolvedValue({run:{id:'run',taskId:'task',status:'transferred',tier:'standard',planId:'plan'},candidates:[],calls:[]});
  const view=await mount(React.createElement(StudioPanel,{taskId:'task',taskStatus:'RECEIVED',initialRunId:'run',hasCanvaBinding:false,onOpenCanva:vi.fn()}));
  expect(view.text()).toContain('Transfer record needs reconciliation');
  expect(view.text()).not.toContain('native Canva document');
  expect(Array.from(view.container.querySelectorAll('button')).some(b=>b.textContent?.includes('Open Canva Editor'))).toBe(false);
  await view.unmount();
});
