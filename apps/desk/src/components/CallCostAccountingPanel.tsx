import { useState } from 'react';
import type { CallCostDetail, CallCostEvidence, CallCostPage } from '@hawa/contracts';
import { apiClient } from '../api/client.js';
import { reasonOf } from '../services/statusReport.js';
import { EvaluationSettlementPanel } from './EvaluationSettlementPanel.js';

const usd=(value:number|null)=>value===null?'Unknown':`$${value.toFixed(6)}`;

export function CallCostAccountingPanel() {
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const [page,setPage]=useState<CallCostPage|null>(null),[detail,setDetail]=useState<CallCostDetail|null>(null);
  const load=async(more=false)=>{
    setBusy(true);setNotice('');
    try {const next=await apiClient.callCosts.list(more?page?.nextCursor:undefined);
      setPage(old=>({...next,items:more?[...(old?.items||[]),...next.items]:next.items}));
    }catch(error){setNotice(`Call costs unavailable: ${reasonOf(error)}`);}finally{setBusy(false);}
  };
  const inspect=async(call:CallCostEvidence)=>{
    setBusy(true);setNotice('');setDetail(null);
    try{setDetail(await apiClient.callCosts.get(call.kind,call.id));}
    catch(error){setNotice(`Call evidence unavailable: ${reasonOf(error)}`);}finally{setBusy(false);}
  };
  return <section className="card" aria-label="Call cost accounting" style={{marginBottom:16,padding:16}}>
    <h2>Call cost accounting</h2>
    <p>Review Studio, Canva planning, evaluation, voice and scheduled health probe charges. Calls without complete billing evidence keep their remaining allocation reserved.</p>
    <button className="btn" aria-expanded={open} disabled={busy} onClick={()=>{
      setOpen(!open);if(!open&&!page)void load();
    }}>{open?'Hide call costs':'Review call costs'}</button>
    {open&&<>
      <button className="btn" style={{marginInlineStart:8}} disabled={busy} onClick={()=>void load()}>Reload costs</button>
      {notice&&<p role="alert">{notice}</p>}
      {busy&&<p role="status">Loading call evidence…</p>}
      {page&&<div style={{overflowX:'auto'}}><table style={{width:'100%',marginTop:12}}>
        <caption>Newest calls first · administrator attestations are shown separately from original receipts</caption>
        <thead><tr><th>Call</th><th>Original cost</th><th>Reserved</th><th>Accounting</th><th>Evidence</th></tr></thead>
        <tbody>{page.items.map(call=><tr key={`${call.kind}:${call.id}`}>
          <td>{call.kind} · {call.model||'Model not reported'}<br/><small>{new Date(call.startedAt).toLocaleString()} · {call.id.slice(0,8)}</small></td>
          <td>{usd(call.originalCostUsd)}</td><td>{usd(call.reservedUsd)}</td>
          <td>{call.evidenceConflict?'Conflicting evidence':call.requiresCostEvidence?'Cost evidence needed':'Cost evidence recorded'}</td>
          <td><button className="btn btn-sm" disabled={busy} onClick={()=>void inspect(call)}>Review {call.id.slice(0,8)}</button></td>
        </tr>)}</tbody>
      </table>{page.items.length===0&&<p>No paid-call records are available in this office.</p>}</div>}
      {page?.nextCursor&&<button className="btn" disabled={busy} onClick={()=>void load(true)}>Older calls</button>}
      {detail&&<section aria-label="Selected call accounting" style={{borderTop:'1px solid var(--line)',paddingTop:16,marginTop:16}}>
        <h3>{detail.kind} call · {detail.model||'Model not reported'}</h3>
        <p style={{overflowWrap:'anywhere'}}>Call ID: {detail.id}<br/>Original outcome: {detail.status}<br/>Provider reference: {detail.providerRequestId||'Not reported'}</p>
        <dl><dt>Original recorded cost</dt><dd>{usd(detail.originalCostUsd)}</dd>
          <dt>Original allocation</dt><dd>{usd(detail.reservedUsd)}</dd>
          <dt>Prior run settlement</dt><dd>{detail.settledCostUsd===null?'None recorded':usd(detail.settledCostUsd)}</dd>
          <dt>Highest administrator-attested cost</dt><dd>{usd(detail.attestedCostUsd)}</dd>
          <dt>Known minimum charge</dt><dd>{usd(detail.accountedCostUsd)}{detail.requiresCostEvidence?' · unused allocation remains held':''}</dd></dl>
        {detail.evidenceConflict&&<p role="alert">Retained evidence disagrees. The highest recorded charge still counts toward spending. Review the original provider evidence before appending a correction.</p>}
        {detail.attestations.length>0&&<details><summary>Accounting history ({detail.attestations.length})</summary>
          {detail.attestations.map(a=><article key={a.id}><h4>Revision {a.revision} · {usd(a.reportedCostUsd)}</h4>
            <p>{a.conclusion==='provider_finished'?'Provider finished':'Provider did not accept'} · {a.evidenceReference}</p>
            <p>{a.reason}</p><p>Attested by {a.actorUserId} at {new Date(a.recordedAt).toLocaleString()}</p>
            <p style={{overflowWrap:'anywhere'}}>Evidence SHA-256: {a.evidenceSha256}</p></article>)}
        </details>}
        {detail.kind==='canva_planner'&&<p role="note">Terminal cost evidence preserves the original call. Resume the saved plan to recover a retained layout without another model call. If no layout was saved, retire the plan before explicitly requesting a new one.</p>}
        {detail.kind==='health_probe'&&<p role="note">Terminal evidence permits a new scheduled health probe after its interval if spending limits allow it. It does not retry this call or establish provider health.</p>}
        <EvaluationSettlementPanel key={`${detail.kind}:${detail.id}:${detail.snapshotHash}`} kind="accounting"
          detail={{runId:`${detail.kind}:${detail.id}`,status:detail.status,snapshotHash:detail.snapshotHash,canSettle:detail.canRecord,settlement:null,
            calls:[{id:detail.id,ordinal:1,status:detail.status,provider:detail.provider,model:detail.model}]}}
          recordSettlement={(action,body)=>apiClient.callCosts.record(detail.kind,detail.id,action,body)}
          onSettled={async()=>{setDetail(await apiClient.callCosts.get(detail.kind,detail.id));await load();}}/>
        <div style={{display:'flex',gap:8,marginTop:12}}>
          <button className="btn btn-sm" disabled={busy} onClick={()=>void inspect(detail)}>Reload selected call</button>
          <button className="btn btn-sm" onClick={()=>setDetail(null)}>Close call</button>
        </div>
      </section>}
    </>}
  </section>;
}
