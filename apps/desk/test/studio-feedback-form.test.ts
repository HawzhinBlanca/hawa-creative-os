// @vitest-environment jsdom
import React, {act} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {StudioFeedbackForm} from '../src/components/StudioFeedbackForm.js';
import {apiClient} from '../src/api/client.js';
import {click,mount} from './support/desk-harness.js';

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
