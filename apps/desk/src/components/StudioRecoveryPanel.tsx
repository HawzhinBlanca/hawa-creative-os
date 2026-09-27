import {useEffect,useState} from 'react';
import { apiClient,type StudioRecoveryDetail } from '../api/client.js';
import { EvaluationSettlementPanel } from './EvaluationSettlementPanel.js';
import { reasonOf } from '../services/statusReport.js';

export function StudioRecoveryPanel({taskId,runId,status}:{taskId:string;runId:string;status:string}) {
  const [detail,setDetail]=useState<StudioRecoveryDetail|null>(null),[notice,setNotice]=useState('');
  const [reload,setReload]=useState(0);
  useEffect(()=>{
    let current=true;setDetail(null);setNotice('');
    void apiClient.studio.recovery(taskId,runId).then(result=>{
      if(!current)return;
      // A lost POST response may already be visible in durable history after reload.
      // Clear only a server-observed action; later parity calls must get their own action.
      try {
        const key=`hawa.studio-settlement.${runId}`,pending=JSON.parse(sessionStorage.getItem(key)||'null');
        if(pending?.actionId&&result.settlements.some(s=>s.actionId===pending.actionId)) sessionStorage.removeItem(key);
      }catch{/* Storage remains advisory; submission itself refuses if persistence is unavailable. */}
      setDetail(result);
    })
      .catch(error=>{if(current)setNotice(reasonOf(error));});
    return ()=>{current=false;};
  },[taskId,runId,status,reload]);
  return <details><summary>Resolve held model calls</summary>
    <button type="button" onClick={()=>setReload(n=>n+1)}>Reload recovery evidence</button>
    {notice&&<p role="status">Recovery evidence unavailable: {notice}</p>}
    {!detail&&!notice&&<p>Loading saved evidence…</p>}
    {detail&&<>
      {detail.requiresStop&&detail.unresolvedCalls>0&&<p>Stop this run through its owning workflow before settlement. Abandonment preserves unresolved provider calls.</p>}
      <ul>{detail.calls.map(call=><li key={call.id} style={{overflowWrap:'anywhere'}}>Saved call: {call.id} · {call.stage} · {call.provider} / {call.model} · original outcome: {call.status}
        {call.providerRequestId&&<> · request: {call.providerRequestId}</>}
        {call.responseId&&<> · response: {call.responseId}</>}
        {' · '}{call.estimatedCostUsd===null?'original cost unknown':`recorded estimate $${call.estimatedCostUsd}`}
        {call.settlement&&<> · separately attested final cost ${call.settlement.reportedCostUsd}</>}
      </li>)}</ul>
      {detail.settlements.map(receipt=><section key={receipt.id}>
        <h4>Administrator-attested settlement</h4><p>{receipt.reason}</p>
        <p>Recorded by {receipt.actorUserId} at {receipt.recordedAt}. Original receipts remain unchanged.</p>
        {receipt.calls.map(c=><p key={c.callId}>{c.evidenceReference} · reported final cost ${c.reportedCostUsd} · {c.conclusion==='provider_not_accepted'?'provider rejection':'provider finished'} · evidence SHA-256 {c.evidenceSha256}</p>)}
      </section>)}
      {!detail.unresolvedCalls&&<p>No unresolved calls currently require settlement. This does not establish design quality or approval.</p>}
      {!detail.requiresStop&&detail.unresolvedCalls>0&&<EvaluationSettlementPanel key={detail.snapshotHash} kind="studio"
        detail={{...detail,settlement:null,calls:detail.calls.filter(c=>!c.settlement).map((c,i)=>({...c,ordinal:c.ordinal??i+1}))}}
        recordSettlement={(action,body)=>apiClient.studio.settle(taskId,runId,action,body)}
        onSettled={async()=>{setReload(n=>n+1);}}/>}
    </>}
  </details>;
}
