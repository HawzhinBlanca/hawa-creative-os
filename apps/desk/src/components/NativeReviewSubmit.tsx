import { useEffect, useState } from 'react';
import { apiClient, type NativeReviewBody } from '../api/client.js';
import type { NativeRecoveryScope } from '@hawa/domain';

type Pending={key:string;body:NativeReviewBody};
const storageKey=(id:string)=>`hawa.native-review.${id}`;
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
function read(id:string):Pending|null {
  const text=sessionStorage.getItem(storageKey(id));
  if(!text)return null;
  const p=JSON.parse(text);
  if(!p||!uuid(p.key)||!p.body||!['requestId','artifactId','confirmationEventId'].every(k=>uuid(p.body[k]))||
    !Number.isSafeInteger(p.body.expectedRev)||p.body.expectedRev<2||!Number.isSafeInteger(p.body.expectedTaskVersion)||p.body.expectedTaskVersion<1)
    throw new Error('The retained review action is invalid. Clear it before submitting another review.');
  return p;
}
export function NativeReviewSubmit({taskId,scope,taskVersion,confirmationEventId,artifactId,busy,onAction}:{
  taskId:string;scope?:NativeRecoveryScope;taskVersion?:number;confirmationEventId?:string|null;artifactId?:string;
  busy:boolean;onAction:(action:()=>Promise<void>)=>Promise<void>;
}) {
  const [pending,setPending]=useState<Pending|null>(null),[invalid,setInvalid]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{setInvalid(false);setNotice('');try{setPending(read(taskId));}catch{setInvalid(true);}},[taskId]);
  if(!scope&&!pending&&!invalid&&!notice)return null;
  return <section aria-label="Submit native revision">
    <p>Submit the captured revision to the request’s review stage. Approval remains a separate action.</p>
    {pending&&<p>The previous submission has no confirmed response. Retry the same saved action to recover its result.</p>}
    {invalid&&<p role="alert">The saved review action cannot be read. It has not been sent.</p>}
    <button className="btn" disabled={busy||invalid||(!pending&&(!scope||!taskVersion||!confirmationEventId||!artifactId))}
      onClick={()=>void onAction(async()=>{
        const action=pending??{key:crypto.randomUUID(),body:{requestId:scope!.requestId,expectedRev:scope!.rev,
          expectedTaskVersion:taskVersion!,confirmationEventId:confirmationEventId!,artifactId:artifactId!}};
        const serialized=JSON.stringify(action);sessionStorage.setItem(storageKey(taskId),serialized);
        if(sessionStorage.getItem(storageKey(taskId))!==serialized)throw new Error('The review action could not be retained. Nothing was sent.');
        setPending(action);
        try{
          const result=await apiClient.canva.submitNativeReview(taskId,action.key,action.body);
          if(!result.accepted)throw new Error('The request is no longer accepting this capture.');
          sessionStorage.removeItem(storageKey(taskId));setPending(null);
          setNotice(result.qaPassed?'Captured revision submitted for human review.':'Revision submitted for review; QA needs correction before approval.');
        }catch(error){
          const status=(error as {status?:number}).status;
          if(status===409||status===422){sessionStorage.removeItem(storageKey(taskId));setPending(null);}
          throw error;
        }
      })}>{pending?'Retry saved review submission':'Submit captured revision for review'}</button>
    {invalid&&<button className="btn" disabled={busy} onClick={()=>{sessionStorage.removeItem(storageKey(taskId));setPending(null);setInvalid(false);}}>Clear unreadable browser action</button>}
    {notice&&<p role="status">{notice}</p>}
  </section>;
}
