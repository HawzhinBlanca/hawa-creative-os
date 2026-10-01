// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskControls } from '../src/components/TaskControls.js';
import { apiClient } from '../src/api/client.js';

let host: HTMLDivElement, root: Root;
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
beforeEach(()=>{host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();});
const button=(text:string)=>Array.from(host.querySelectorAll('button')).find(item=>item.textContent===text)!;
const reason=async()=>act(async()=>{
  const textarea=host.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Stop this synthetic request');
  textarea.dispatchEvent(new Event('input',{bubbles:true}));
});
describe('Desk durable task controls',()=>{
  it('shows the original requester hold and only its versioned office resume',async()=>{
    const send=vi.spyOn(apiClient.tasks,'control').mockResolvedValue({commandId:'held',status:'COMPOSING',version:9,replayed:false});
    const refresh=vi.fn(async()=>{});
    await act(async()=>root.render(createElement(TaskControls,{taskId:'held-task',status:'PAUSED',version:8,
      role:'operator',refresh,requesterHold:{reason:'Wait, we are confirming the new date'}})));
    expect(host.textContent).toContain('confirming the new date');expect(host.querySelectorAll('button')).toHaveLength(1);
    expect(button('Resume this design').disabled).toBe(true);await reason();
    await act(async()=>button('Resume this design').click());
    expect(send).toHaveBeenCalledWith('held-task','resume',{reason:'Stop this synthetic request',expectedVersion:8},expect.any(String));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('requires a reason, keeps a lost-response retry key, and shows confirmed closure',async()=>{
    const send=vi.spyOn(apiClient.tasks,'control').mockRejectedValueOnce(new Error('Response lost; retry the same action'))
      .mockResolvedValueOnce({commandId:'synthetic',status:'CANCELLED',version:2,replayed:true});
    const refresh=vi.fn(async()=>{});
    const props={taskId:'synthetic-task',status:'RECEIVED',version:1,role:'operator',refresh};
    await act(async()=>root.render(createElement(TaskControls,props)));
    expect(button('Cancel task').disabled).toBe(true);
    await reason();expect(button('Cancel task').disabled).toBe(false);
    await act(async()=>button('Cancel task').click());
    expect(host.textContent).toContain('Response lost');expect(refresh).not.toHaveBeenCalled();
    await act(async()=>button('Cancel task').click());
    expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
    expect(send.mock.calls[0].slice(0,3)).toEqual(['synthetic-task','cancel',{reason:'Stop this synthetic request',expectedVersion:1}]);
    expect(refresh).toHaveBeenCalledOnce();expect(host.textContent).toContain('Control recorded: cancelled');
    await act(async()=>root.render(createElement(TaskControls,{...props,status:'CANCELLED',version:2})));
    expect(host.querySelectorAll('button')).toHaveLength(0);expect(host.textContent).toContain('recorded results remain available');
  });
  it('offers operator-pause resume and prevents unprivileged controls',async()=>{
    const props={taskId:'synthetic-task',status:'PAUSED',version:2,role:'requester',refresh:async()=>{}};
    await act(async()=>root.render(createElement(TaskControls,props)));
    expect(button('Resume operator pause').disabled).toBe(true);expect(button('Cancel task').disabled).toBe(true);
    expect(host.textContent).toContain('operator or designer is required');
  });
});
