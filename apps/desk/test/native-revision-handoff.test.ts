// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeRevisionHandoff } from '../src/components/NativeRevisionHandoff.js';
import { apiClient } from '../src/api/client.js';
import { byText, click } from './support/desk-harness.js';

describe('native revision handoff controls',()=>{
  let container:HTMLDivElement,root:Root;
  const capture=vi.fn(),errors:unknown[]=[];
  const initial={available:true,message:'Review the current native copy.',parentEditUrl:'https://www.canva.com/design/parent/edit',
    directive:'Change the date only.',bindingId:'binding',basisSha256:'a'.repeat(64),taskVersion:3,confirmedEventId:null as string|null,copy:['Exact copy 2026']};
  let handoff:React.ComponentProps<typeof NativeRevisionHandoff>['handoff']=initial;
  const render=async()=>act(async()=>root.render(React.createElement(NativeRevisionHandoff,{taskId:'task',handoff,busy:false,
    onCapture:capture,onAction:async action=>{try{await action();}catch(error){errors.push(error);}}})));
  const button=(text:string)=>byText(container,'button',text) as HTMLButtonElement;
  const check=async()=>{for(const input of container.querySelectorAll<HTMLInputElement>('input[type=checkbox]'))await click(input);};
  const edit=async(value:string)=>act(async()=>{
    const textarea=container.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,value);
    textarea.dispatchEvent(new Event('input',{bubbles:true}));
  });
  beforeEach(async()=>{
    container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
    handoff={...initial,copy:[...initial.copy]};errors.length=0;capture.mockClear();
    vi.spyOn(apiClient.canva,'confirmRevisionCopy').mockResolvedValue({confirmationEventId:'confirmation',replayed:false});
    await render();
  });
  afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.restoreAllMocks();});
  it('requires both human checks and sends exact copy with the current optimistic basis',async()=>{
    expect(button('Confirm revised copy').disabled).toBe(true);
    await edit('  New exact copy — 2027  ');await check();await click(button('Confirm revised copy'));
    expect(apiClient.canva.confirmRevisionCopy).toHaveBeenCalledWith('task',expect.any(String),{
      expectedTaskVersion:3,basisSha256:initial.basisSha256,copy:['  New exact copy — 2027  '],
      reviewedCurrentDesign:true,preservedUnrequestedChanges:true});
    expect(button('Capture revised design').disabled).toBe(true);
  });
  it('retries a lost response with the same key and invalidates human checks after an edit',async()=>{
    vi.mocked(apiClient.canva.confirmRevisionCopy).mockRejectedValueOnce(new Error('lost response'));
    await check();await click(button('Confirm revised copy'));await click(button('Confirm revised copy'));
    const calls=vi.mocked(apiClient.canva.confirmRevisionCopy).mock.calls;
    expect(calls[0][1]).toBe(calls[1][1]);expect(errors).toHaveLength(1);
    await edit('Changed again');expect(button('Confirm revised copy').disabled).toBe(true);
    expect([...container.querySelectorAll<HTMLInputElement>('input')].every(input=>!input.checked)).toBe(true);
  });
  it('captures only the confirmed unchanged draft and resets when the native basis changes',async()=>{
    handoff={...handoff,confirmedEventId:'confirmation'};await render();
    await click(button('Capture revised design'));expect(capture).toHaveBeenCalledTimes(1);
    await edit('New unconfirmed draft');expect(button('Capture revised design').disabled).toBe(true);
    handoff={...handoff,basisSha256:'b'.repeat(64),confirmedEventId:null,copy:['Server current copy']};await render();
    expect(container.querySelector('textarea')!.value).toBe('Server current copy');
    expect(button('Confirm revised copy').disabled).toBe(true);expect(button('Capture revised design').disabled).toBe(true);
  });
  it('allows a fresh preservation review for unchanged copy and respects lifecycle ownership',async()=>{
    handoff={...handoff,confirmedEventId:'previous'};await render();await check();
    expect(button('Confirm revised copy').disabled).toBe(false);
    await click(button('Confirm revised copy'));expect(apiClient.canva.confirmRevisionCopy).toHaveBeenCalledTimes(1);
    handoff={...handoff,lifecycleOwned:true};await render();
    expect(container.querySelector('textarea')).toBeNull();expect(button('Confirm revised copy')).toBeUndefined();
    expect(container.textContent).toContain('workflow owns design changes');
  });
});
