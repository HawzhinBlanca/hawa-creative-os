import React, {useState} from 'react';
import {ApiError,apiClient,type SettlementBody} from '../api/client.js';
import {reasonOf} from '../services/statusReport.js';

interface Detail {
  runId:string; status:string; snapshotHash:string; canSettle:boolean;
  calls:Array<{id:string;ordinal:number;status:string;provider?:string|null;model?:string|null;estimatedCostUsd?:number|null;error?:{code:string;detail?:{providerRequestId?:string|null}}|null}>;
  settlement:null|{actorUserId:string;recordedAt:string;reason:string;calls:SettlementBody['calls']};
}
type Draft={conclusion:'provider_not_accepted'|'provider_finished';cost:string;reference:string;hash:string};
type Pending={actionId:string;body:SettlementBody};
const storageKey=(id:string,kind:string)=>`hawa.${kind}-settlement.${id}`;
function saved(id:string,kind:string):Pending|null {
  try { const p=JSON.parse(sessionStorage.getItem(storageKey(id,kind))||'null');
    return p && typeof p.actionId==='string' && p.body && Array.isArray(p.body.calls) ? p : null;
  } catch {return null;}
}

/** Evidence files stay on the administrator's device; only their digest is submitted. */
export function EvaluationSettlementPanel({detail,onSettled,kind='evaluation',recordSettlement}:{
  detail:Detail;onSettled:()=>Promise<void>;kind?:'evaluation'|'studio';
  recordSettlement?:(actionId:string,body:SettlementBody)=>Promise<unknown>;
}) {
  const [pending,setPending]=useState(()=>saved(detail.runId,kind));
  const [reason,setReason]=useState(pending?.body.reason||'');
  const unresolved=detail.calls.filter(c=>c.status==='pending'||c.status==='uncertain');
  const [drafts,setDrafts]=useState<Record<string,Draft>>(()=>Object.fromEntries(unresolved.map(c=>{
    const s=pending?.body.calls.find(x=>x.callId===c.id);
    return [c.id,{conclusion:s?.conclusion||'provider_finished',cost:s ? String(s.reportedCostUsd) : '',reference:s?.evidenceReference||'',hash:s?.evidenceSha256||''}];
  })));
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  if(detail.settlement) return <div role="status">
    <h4>Closed with administrator-attested evidence</h4>
    <p>{detail.settlement.reason}</p>
    <p>Recorded by {detail.settlement.actorUserId} at {detail.settlement.recordedAt}. The original report and call outcomes are retained.</p>
    {detail.settlement.calls.map(c=><p key={c.callId}>{c.evidenceReference}: reported final cost ${c.reportedCostUsd} · {c.conclusion==='provider_not_accepted'?'provider rejection':'provider finished'}</p>)}
  </div>;
  if(!unresolved.length && detail.status!=='running') return null;
  if(!detail.canSettle) return <p>A named office administrator can settle this held {kind} run after reviewing terminal provider evidence and costs.</p>;
  const update=(id:string,patch:Partial<Draft>)=>setDrafts(old=>({...old,[id]:{...old[id],...patch}}));
  const valid=reason.trim() && unresolved.every(c=>{
    const d=drafts[c.id];return d && d.cost!=='' && Number.isFinite(Number(d.cost)) && Number(d.cost)>=0 && Number(d.cost)<=1_000_000 &&
      (d.conclusion!=='provider_not_accepted'||Number(d.cost)===0) && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(d.reference) && /^[a-f0-9]{64}$/.test(d.hash);
  });
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(busy)return;setBusy(true);setNotice('');
    try {
      const action=pending||{actionId:crypto.randomUUID(),body:{expectedSnapshot:detail.snapshotHash,reason:reason.trim(),calls:unresolved.map(c=>({callId:c.id,
        conclusion:drafts[c.id].conclusion,reportedCostUsd:Number(drafts[c.id].cost),evidenceReference:drafts[c.id].reference,evidenceSha256:drafts[c.id].hash}))}};
      // Freeze and retain before dispatch. A lost response cannot change the evidence on retry.
      sessionStorage.setItem(storageKey(detail.runId,kind),JSON.stringify(action));setPending(action);
      if(recordSettlement) await recordSettlement(action.actionId,action.body);
      else await apiClient.evaluations.settle(detail.runId,action.actionId,action.body);
      sessionStorage.removeItem(storageKey(detail.runId,kind));setPending(null);
      setNotice('Settlement recorded. No model request was sent.');await onSettled();
    }catch(error){
      // Busy/auth failures say nothing about an earlier request that may have committed.
      // Only an invalid request or a checked, unadmitted snapshot/coverage refusal permits editing.
      const refused=error instanceof ApiError && (error.status===400 ||
        ['EVALUATION_SNAPSHOT_CHANGED','EVALUATION_EVIDENCE_INCOMPLETE','STUDIO_SNAPSHOT_CHANGED','STUDIO_EVIDENCE_INCOMPLETE'].includes(error.problem?.title||''));
      if(refused){
        sessionStorage.removeItem(storageKey(detail.runId,kind));setPending(null);
        setNotice(`Settlement refused: ${reasonOf(error)}. Reload the saved calls before correcting the evidence.`);
      }else setNotice(`Settlement was not confirmed: ${reasonOf(error)}. Retry the saved action.`);
    }finally{setBusy(false);}
  };
  return <form onSubmit={e=>void submit(e)} aria-label={kind==='evaluation'?'Close held evaluation':'Settle held Studio calls'}>
    <h4>{kind==='evaluation'?'Close held evaluation':'Settle held Studio calls'}</h4>
    <p>Use a final provider receipt or support confirmation for every unresolved call. A timeout or request ID alone is insufficient. Unknown costs must remain held.</p>
    <p>{kind==='evaluation'?'Closing retains the stopped result and sends no model request. Starting another evaluation is a separate billable action.':'Settlement retains the original call outcomes and sends no model request. It cannot recover a missing design result. New generation remains a separate billable action through the task’s owner.'}</p>
    <fieldset disabled={busy||!!pending} style={{border:0,padding:0}}>
      {unresolved.map(c=>{const d=drafts[c.id];return <fieldset key={c.id} style={{marginBottom:12}}><legend>Call {c.ordinal}</legend>
        <p style={{overflowWrap:'anywhere'}}>Saved call: {c.id} · {c.provider||'provider not reported'} / {c.model||'model not reported'}</p>
        <label>Provider conclusion <select aria-label={`Call ${c.ordinal} conclusion`} value={d.conclusion} onChange={e=>update(c.id,{conclusion:e.target.value as Draft['conclusion']})}>
          <option value="provider_finished">Provider confirms processing finished</option><option value="provider_not_accepted">Provider confirms request was not accepted</option>
        </select></label>
        <label>Reported final cost (USD) <input aria-label={`Call ${c.ordinal} final cost`} type="number" min="0" max="1000000" step="any" required value={d.cost} onChange={e=>update(c.id,{cost:e.target.value})}/></label>
        <label>Provider or support reference <input aria-label={`Call ${c.ordinal} evidence reference`} required maxLength={200} value={d.reference} onChange={e=>update(c.id,{reference:e.target.value})}/></label>
        <label>Evidence SHA-256 <input aria-label={`Call ${c.ordinal} evidence hash`} required pattern="[a-f0-9]{64}" value={d.hash} onChange={e=>update(c.id,{hash:e.target.value})}/></label>
        <label>Or select the evidence file to calculate its hash <input type="file" aria-label={`Call ${c.ordinal} evidence file`} onChange={e=>{
          const file=e.target.files?.[0];if(!file)return;
          if(file.size>20*1024*1024){setNotice('Select evidence of at most 20 MB.');return;}
          update(c.id,{hash:''});setBusy(true);
          void file.arrayBuffer().then(bytes=>crypto.subtle.digest('SHA-256',bytes)).then(hash=>update(c.id,{hash:Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('')}))
            .catch(()=>setNotice('Could not hash this file. Keep the evidence locally and enter its SHA-256.')).finally(()=>setBusy(false));
        }}/></label><small>The file stays on this device. Keep it in the office’s evidence archive.</small>
      </fieldset>;})}
      <label>Reason <textarea aria-label="Settlement reason" required maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></label>
    </fieldset>
    <button type="submit" disabled={busy||(!pending&&!valid)}>{busy?'Recording…':pending?'Retry saved settlement':kind==='evaluation'?'Record evidence and close evaluation':'Record Studio settlement'}</button>
    {notice&&<p role="status">{notice}</p>}
  </form>;
}
