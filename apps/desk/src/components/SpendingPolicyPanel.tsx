import { useState, type FormEvent } from 'react';
import type { SpendingLimits, SpendingPolicyChange, SpendingPolicyDetail, SpendingRole } from '@hawa/contracts';
import { parseSpendingPolicyChange, spendingPolicyChanges, SPENDING_ROLES } from '@hawa/domain/spending-policy';
import { ApiError, apiClient } from '../api/client.js';
import { reasonOf } from '../services/statusReport.js';
import { DailySpendingSummary } from './DailySpendingSummary.js';

type Pending = { actionId:string; body:SpendingPolicyChange; before:SpendingLimits };
const storageKey=(d:SpendingPolicyDetail)=>`hawa.spending-policy.${d.tenantId}.${d.userId}`;
function saved(d:SpendingPolicyDetail):Pending|null {
  try {
    const p=JSON.parse(sessionStorage.getItem(storageKey(d))||'null');
    const body=parseSpendingPolicyChange(p?.body),before=body&&parseSpendingPolicyChange({...body,limits:p.before});
    return body&&before&&typeof p.actionId==='string'&&/^[a-f0-9-]{36}$/i.test(p.actionId)?{actionId:p.actionId,body,before:before.limits}:null;
  }catch{return null;}
}
const grid={display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,250px),1fr))',gap:12} as const;
const labelStyle={display:'flex',flexDirection:'column',gap:6} as const;
const inputStyle={width:'100%',boxSizing:'border-box',minWidth:0} as const;
const money=(n:number)=>`$${n.toFixed(6)}`;

function PolicyForm({detail,onSaved}:{detail:SpendingPolicyDetail;onSaved:()=>Promise<void>}) {
  const [pending,setPending]=useState<Pending|null>(()=>saved(detail));
  const initial=pending?.body.limits||detail.current.limits;
  const [base,setBase]=useState({officeUsd:String(initial.officeUsd),clientUsd:String(initial.clientUsd),roleUsd:String(initial.roleUsd)});
  const [clients,setClients]=useState<Record<string,string>>(()=>Object.fromEntries(Object.entries(initial.clients).map(([k,v])=>[k,String(v)])));
  const [roles,setRoles]=useState<Partial<Record<SpendingRole,string>>>(()=>Object.fromEntries(Object.entries(initial.roles).map(([k,v])=>[k,String(v)])));
  const [reason,setReason]=useState(pending?.body.reason||''),[selected,setSelected]=useState('');
  const [proposal,setProposal]=useState<SpendingPolicyChange|null>(pending?.body||null);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const value=(s:string)=>s.trim()===''?NaN:Number(s);
  const candidate=parseSpendingPolicyChange({expectedVersion:detail.current.version,expectedLimitsSha256:detail.current.limitsSha256,reason,
    limits:{officeUsd:value(base.officeUsd),clientUsd:value(base.clientUsd),roleUsd:value(base.roleUsd),
      clients:Object.fromEntries(Object.entries(clients).map(([k,v])=>[k,value(v)])),
      roles:Object.fromEntries(Object.entries(roles).filter(([,v])=>v?.trim()).map(([k,v])=>[k,value(v!)]))}});
  const changes=proposal?spendingPolicyChanges(pending?.before||detail.current.limits,proposal.limits):[];
  const clientName=(id:string)=>detail.clients.find(c=>c.id===id)?.name||id;
  const record=async()=>{
    if(!proposal||busy||!detail.canEdit)return;
    setBusy(true);setNotice('');
    let dispatched=false;
    try{
      const action=pending||{actionId:crypto.randomUUID(),body:proposal,before:detail.current.limits};
      sessionStorage.setItem(storageKey(detail),JSON.stringify(action));setPending(action);
      dispatched=true;
      await apiClient.spendingPolicy.record(action.actionId,action.body);
      sessionStorage.removeItem(storageKey(detail));setPending(null);setProposal(null);
      setNotice('Budget policy recorded.');await onSaved();
    }catch(error){
      const refused=error instanceof ApiError&&(error.status===400||error.problem?.title==='SPENDING_POLICY_CHANGED');
      if(!dispatched){setNotice('The action could not be saved in this browser. No new request was sent. Keep the proposal open and retry when browser storage is available.');}
      else if(refused){sessionStorage.removeItem(storageKey(detail));setPending(null);setProposal(null);
        setNotice(`Policy refused: ${reasonOf(error)} Reload the policy before reviewing another proposal.`);
      }else setNotice(`Policy change was not confirmed: ${reasonOf(error)} Retry the saved action.`);
    }finally{setBusy(false);}
  };
  if(!detail.canEdit)return <p>Sign in as a named office administrator to change limits.</p>;
  return <section aria-label="Change daily spending limits">
    <h3>Change daily limits</h3>
    <p>Zero stops new spending within that scope. Lower limits preserve existing charges and reservations. Defaults apply to clients and roles without an override.</p>
    {!proposal?<form onSubmit={(e:FormEvent)=>{e.preventDefault();if(candidate){setProposal(candidate);setNotice('');}}}>
      <fieldset disabled={busy} style={{border:0,padding:0}}>
        <div style={grid}>{([['officeUsd','Office daily limit'],['clientUsd','Default client daily limit'],['roleUsd','Default role daily limit']] as const).map(([k,title])=>
          <label key={k} style={labelStyle}>{title} (USD)<input style={inputStyle} aria-label={title} type="number" min="0" max="1000000" step="0.000001" required value={base[k]} onChange={e=>setBase({...base,[k]:e.target.value})}/></label>)}</div>
        <h4>Role overrides</h4><p>Leave a role blank to use the default role limit.</p>
        <div style={grid}>{SPENDING_ROLES.map(role=><label key={role} style={labelStyle}>{role.replaceAll('_',' ')} (USD)
          <input style={inputStyle} aria-label={`${role} limit`} type="number" min="0" max="1000000" step="0.000001" placeholder={`Default: ${base.roleUsd}`} value={roles[role]||''} onChange={e=>setRoles({...roles,[role]:e.target.value})}/>
        </label>)}</div>
        <h4>Client overrides</h4>
        {Object.entries(clients).map(([id,cap])=><div key={id} style={{display:'flex',alignItems:'end',gap:12,marginBottom:12}}>
          <label style={{...labelStyle,flex:1}}>{clientName(id)} (USD)<input style={inputStyle} aria-label={`Client ${id} limit`} type="number" min="0" max="1000000" step="0.000001" required value={cap} onChange={e=>setClients({...clients,[id]:e.target.value})}/></label>
          <button className="btn" type="button" onClick={()=>setClients(old=>Object.fromEntries(Object.entries(old).filter(([key])=>key!==id)))}>Use default for {clientName(id)}</button>
        </div>)}
        <div style={{display:'flex',gap:12,alignItems:'end'}}><label style={{...labelStyle,flex:1}}>Client
          <select style={inputStyle} aria-label="Client to override" value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Select a client</option>
            {detail.clients.filter(c=>!Object.hasOwn(clients,c.id)).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label><button type="button" className="btn" disabled={!selected||Object.keys(clients).length>=1000} onClick={()=>{setClients({...clients,[selected]:base.clientUsd});setSelected('');}}>Add client override</button></div>
        <label style={{...labelStyle,marginBlock:16}}>Reason<textarea style={{...inputStyle,minHeight:80}} aria-label="Budget change reason" required maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></label>
      </fieldset>
      <button className="btn primary" type="submit" disabled={!candidate||busy||(candidate&&spendingPolicyChanges(detail.current.limits,candidate.limits).length===0)}>Review budget changes</button>
    </form>:<section aria-label="Review budget changes">
      <h4>{pending?'Saved budget action':'Review proposed limits'}</h4>
      <p>Based on policy revision {proposal.expectedVersion}. Changes apply to subsequent paid-call admissions.</p>
      <div style={{overflowX:'auto'}}><table style={{width:'100%'}}><thead><tr><th>Scope</th><th>Previous</th><th>Proposed</th></tr></thead>
        <tbody>{changes.map(c=><tr key={c.scope}><td>{c.scope.startsWith('Client: ')?`Client: ${clientName(c.scope.slice(8))}`:c.scope}</td><td>{c.before}</td><td>{c.after}</td></tr>)}</tbody></table></div>
      <p>Reason: {proposal.reason}</p>
      {detail.daily.scopes.some(s=>s.historyIncomplete)&&<p role="status">Historical cost is unresolved. Raising limits cannot clear that hold.</p>}
      {proposal.limits.officeUsd<((detail.daily.scopes.find(s=>s.scope==='office')?.spentUsd||0)+(detail.daily.scopes.find(s=>s.scope==='office')?.heldUsd||0))&&
        <p role="status">The proposed office limit is below current charges and reservations. Those obligations remain and new spending will be held.</p>}
      <div style={{display:'flex',gap:12,marginBlock:12}}>
        <button type="button" className="btn primary" disabled={busy} onClick={()=>void record()}>{busy?'Saving policy…':pending?'Retry saved budget action':'Apply reviewed limits'}</button>
        {!pending&&<button type="button" className="btn" disabled={busy} onClick={()=>setProposal(null)}>Edit proposal</button>}
      </div>
    </section>}
    {notice&&<p role="status">{notice}</p>}
  </section>;
}

export function SpendingPolicyPanel() {
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const [detail,setDetail]=useState<SpendingPolicyDetail|null>(null);
  const load=async(more=false)=>{
    setBusy(true);setNotice('');
    try{const data=await apiClient.spendingPolicy.get(more?detail?.nextBeforeVersion:undefined);
      setDetail(old=>({...data,history:more?[...(old?.history||[]),...data.history]:data.history}));
    }catch(error){setDetail(null);setNotice(`Spending policy unavailable: ${reasonOf(error)}`);}finally{setBusy(false);}
  };
  return <section className="card" aria-label="Daily spending policy" style={{padding:16,marginBottom:16}}>
    <h2>Daily spending policy</h2>
    <p>Shared limits for Studio, Canva planning, fixture evaluation, retained voice and scheduled health probes. Unresolved costs keep their allocation reserved.</p>
    <button className="btn" disabled={busy} aria-expanded={open} onClick={()=>{setOpen(!open);if(!open&&!detail)void load();}}>{open?'Hide budget policy':'Review budget policy'}</button>
    {open&&<>
      <button className="btn" style={{marginInlineStart:8}} disabled={busy} onClick={()=>void load()}>Reload budget policy</button>
      {busy&&<p role="status">Loading budget policy…</p>}{notice&&<p role="alert">{notice}</p>}
      {detail&&<><h3>Current policy · revision {detail.current.version}</h3>
        <p>Office: {money(detail.current.limits.officeUsd)} · Default client: {money(detail.current.limits.clientUsd)} · Default role: {money(detail.current.limits.roleUsd)}</p>
        <ul>{Object.entries(detail.current.limits.clients).map(([id,cap])=><li key={id}>{detail.clients.find(c=>c.id===id)?.name||id}: {money(cap)}</li>)}
          {Object.entries(detail.current.limits.roles).map(([role,cap])=><li key={role}>{role.replaceAll('_',' ')}: {money(cap!)}</li>)}</ul>
        <DailySpendingSummary daily={detail.daily}/>
        <PolicyForm key={`${detail.tenantId}:${detail.userId}:${detail.current.version}`} detail={detail} onSaved={()=>load()}/>
        <details style={{marginTop:16}}><summary>Budget policy history</summary>{detail.history.map(r=><article key={r.version}>
          <h4>Revision {r.version} · {new Date(r.recordedAt).toLocaleString()}</h4><p>{r.reason}</p>
          <p>{r.actorUserId?`Recorded by administrator ${r.actorUserId}`:`Database setup · ${r.recordedBy}`}</p>
          <p>Office {money(r.limits.officeUsd)} · Default client {money(r.limits.clientUsd)} · Default role {money(r.limits.roleUsd)}</p>
          <ul>{Object.entries(r.limits.clients).map(([id,cap])=><li key={id}>Client {id}: {money(cap)}</li>)}
            {Object.entries(r.limits.roles).map(([role,cap])=><li key={role}>{role.replaceAll('_',' ')}: {money(cap!)}</li>)}</ul>
          <small style={{overflowWrap:'anywhere'}}>Limits SHA-256: {r.limitsSha256}</small>
        </article>)}{detail.nextBeforeVersion&&<button type="button" className="btn" disabled={busy} onClick={()=>void load(true)}>Older policy revisions</button>}</details>
      </>}
    </>}
  </section>;
}
