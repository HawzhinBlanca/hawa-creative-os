import { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client.js';

interface Handoff {
  available: boolean;
  message: string;
  lifecycleOwned?: boolean;
  parentEditUrl?: string | null;
  directive?: string;
  bindingId?: string | null;
  basisSha256?: string;
  taskVersion?: number;
  confirmedEventId?: string | null;
  copy?: string[];
}

export function NativeRevisionHandoff({taskId,handoff,busy,onAction,onCapture}: {
  taskId:string; handoff:Handoff; busy:boolean; onAction:(action:()=>Promise<void>)=>Promise<void>; onCapture:()=>void;
}) {
  const [copy,setCopy]=useState<string[]>([]),[reviewed,setReviewed]=useState(false),[preserved,setPreserved]=useState(false);
  const [dirty,setDirty]=useState(false);
  const key=useRef<string | null>(null);
  const basis=useRef<string | undefined>(undefined);
  useEffect(()=>{
    setCopy(handoff.copy?.length?handoff.copy:['']);setReviewed(false);setPreserved(false);setDirty(false);key.current=null;basis.current=handoff.basisSha256;
  },[taskId,handoff.basisSha256,handoff.confirmedEventId,handoff.taskVersion]);
  const edit=(parts:string[])=>{setCopy(parts);setDirty(true);setReviewed(false);setPreserved(false);key.current=null;};
  const canConfirm=handoff.available&&!handoff.lifecycleOwned&&Boolean(handoff.bindingId)&&reviewed&&preserved&&
    copy.length>0&&copy.every(part=>part.trim().length>0)&&copy.join('\n').length<=16000;
  return <section aria-label="Native revision handoff">
    <h5>Preserve the current design</h5>
    <p>{handoff.message}</p>
    {handoff.directive&&<p><strong>Requested change:</strong> {handoff.directive}</p>}
    {handoff.parentEditUrl&&<a className="btn" href={handoff.parentEditUrl} target="_blank" rel="noopener noreferrer">Open original Canva design</a>}
    {handoff.lifecycleOwned?<p>Continue through this request’s current office action. Its workflow owns design changes.</p>:handoff.available&&<>
      {!handoff.bindingId&&<p>In Canva, duplicate the current original, make the requested changes, then use “Link this task’s Canva design” to link that separate copy.</p>}
      <p>Review every final text block below against the edited native copy. Keep exact spelling and punctuation. This records copy for export checks; it does not approve the design.</p>
      {copy.map((part,index)=><div key={index}>
        <label>Final copy block {index+1}<textarea value={part} dir="auto" disabled={busy} onChange={event=>edit(copy.map((p,i)=>i===index?event.target.value:p))}/></label>
        <button className="btn" disabled={busy||copy.length===1} onClick={()=>edit(copy.filter((_,i)=>i!==index))}>Remove block {index+1}</button>
      </div>)}
      <button className="btn" disabled={busy||copy.length>=128} onClick={()=>edit([...copy,''])}>Add copy block</button>
      <label><input type="checkbox" checked={reviewed} disabled={busy} onChange={event=>{setReviewed(event.target.checked);key.current=null;}}/> I checked the current original and the exact revised text in the linked copy.</label>
      <label><input type="checkbox" checked={preserved} disabled={busy} onChange={event=>{setPreserved(event.target.checked);key.current=null;}}/> I checked that unrelated manual changes are preserved.</label>
      <button className="btn" disabled={busy||!canConfirm} onClick={()=>void onAction(async()=>{
        if(basis.current!==handoff.basisSha256)throw new Error('The linked design changed. Review it again.');
        key.current ||= crypto.randomUUID();
        await apiClient.canva.confirmRevisionCopy(taskId,key.current,{expectedTaskVersion:handoff.taskVersion!,basisSha256:handoff.basisSha256!,copy,
          reviewedCurrentDesign:reviewed,preservedUnrequestedChanges:preserved});
      })}>Confirm revised copy</button>
      {handoff.confirmedEventId&&!dirty&&<p role="status">Revised copy recorded. Capture the native design for review, then inspect the resulting files.</p>}
      <button className="btn" disabled={busy||!handoff.confirmedEventId||dirty} onClick={onCapture}>Capture revised design for review</button>
    </>}
  </section>;
}
