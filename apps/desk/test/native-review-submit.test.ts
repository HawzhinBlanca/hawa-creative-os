// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {NativeReviewSubmit} from '../src/components/NativeReviewSubmit.js';
import {apiClient} from '../src/api/client.js';
import {byText,click} from './support/desk-harness.js';

describe('native review submission recovery',()=>{
  let container:HTMLDivElement,root:Root;
  const taskId=randomUUID(),requestId=randomUUID(),artifactId=randomUUID(),confirmationEventId=randomUUID();
  const errors:unknown[]=[];
  let props:React.ComponentProps<typeof NativeReviewSubmit>;
  const render=async()=>act(async()=>root.render(React.createElement(NativeReviewSubmit,props)));
  const button=()=>byText(container,'button','review') as HTMLButtonElement;
  beforeEach(async()=>{
    sessionStorage.clear();errors.length=0;container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
    props={taskId,scope:{requestId,rev:4},taskVersion:2,artifactId,confirmationEventId,busy:false,
      onAction:async fn=>{try{await fn();}catch(e){errors.push(e);}}};
    vi.spyOn(apiClient.canva,'submitNativeReview').mockResolvedValue({accepted:true,requestId,taskId,actionId:randomUUID(),revisionId:randomUUID(),rev:5,stage:'in_review',qaPassed:true});
    await render();
  });
  afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.restoreAllMocks();sessionStorage.clear();});
  it('retains exact action through a lost reply and remount after request advances',async()=>{
    vi.mocked(apiClient.canva.submitNativeReview).mockRejectedValueOnce(new Error('response lost'));
    await click(button());expect(errors).toHaveLength(1);
    const first=vi.mocked(apiClient.canva.submitNativeReview).mock.calls[0];
    await act(async()=>root.unmount());root=createRoot(container);props={...props,scope:undefined,artifactId:undefined};await render();
    expect(container.textContent).toContain('Retry the same saved action');await click(button());
    expect(vi.mocked(apiClient.canva.submitNativeReview).mock.calls[1]).toEqual(first);
    expect(first[2]).toEqual({requestId,expectedRev:4,expectedTaskVersion:2,confirmationEventId,artifactId});
    expect(sessionStorage.getItem(`hawa.native-review.${taskId}`)).toBeNull();
    expect(container.textContent).toContain('submitted for human review');
  });
  it('requires current evidence and refuses dispatch if the browser cannot retain the action',async()=>{
    props={...props,artifactId:undefined};await render();expect(button().disabled).toBe(true);
    props={...props,artifactId};await render();
    vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('storage unavailable');});
    await click(button());expect(apiClient.canva.submitNativeReview).not.toHaveBeenCalled();expect(errors).toHaveLength(1);
  });
});
