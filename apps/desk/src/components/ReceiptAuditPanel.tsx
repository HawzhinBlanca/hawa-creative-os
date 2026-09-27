import {useEffect,useRef,useState,type FormEvent} from 'react';
import {parseReceiptAuditAction,parseReceiptAuditState,parseStoredReceiptAudit,type ReceiptAuditState,type ReceiptAuditAction,type StoredReceiptAudit} from '@hawa/contracts';
import {apiClient} from '../api/client.js';
import {reasonOf} from '../services/statusReport.js';
const storageKey=(s:ReceiptAuditState)=>`hawa.receipt-audit.${s.tenantId}.${s.userId}`;

export function ReceiptAuditPanel({refreshKey=0}:{refreshKey?:number}) {
  const [state,setState]=useState<ReceiptAuditState|null>(null),[selected,setSelected]=useState<StoredReceiptAudit|null>(null);
  const [pending,setPending]=useState<ReceiptAuditAction|null>(null),[reason,setReason]=useState('');
  const [notice,setNotice]=useState(''),[unavailable,setUnavailable]=useState(''),[busy,setBusy]=useState(false),[storageInvalid,setStorageInvalid]=useState(false);
  const sequence=useRef(0),running=useRef(false);
  const load=async(beforeRevision?:number)=>{
    const epoch=++sequence.current;setBusy(true);setUnavailable('');
    try{
      const next=parseReceiptAuditState(await apiClient.operations.reconciliation(beforeRevision));
      if(!next)throw new Error('Unsupported or incomplete stored audit evidence');
      if(epoch!==sequence.current)return null;
      setState(next);setSelected(next.latest);
      try{
        const text=sessionStorage.getItem(storageKey(next)),saved=text?parseReceiptAuditAction(JSON.parse(text)):null;
        setPending(saved);setStorageInvalid(!!text&&!saved);
      }catch{setStorageInvalid(true);setPending(null);}
      return next;
    }catch(error){if(epoch===sequence.current){setState(null);setSelected(null);setUnavailable(reasonOf(error));}return null;}
    finally{if(epoch===sequence.current)setBusy(false);}
  };
  useEffect(()=>{void load();return()=>{sequence.current++;};},[refreshKey]);
  const record=async(e:FormEvent)=>{
    e.preventDefault();if(!state||busy||storageInvalid||running.current)return;
    const action=pending||parseReceiptAuditAction({actionId:crypto.randomUUID(),expectedScopeSha256:state.scope.sha256,
      expectedLatestAuditId:state.latest?.auditId??null,reason});
    if(!action)return;
    running.current=true;
    const epoch=++sequence.current,key=storageKey(state);setBusy(true);setNotice('');setSelected(null);
    let dispatched=false;
    try{
      const serialized=JSON.stringify(action);sessionStorage.setItem(key,serialized);
      if(sessionStorage.getItem(key)!==serialized)throw new Error('The saved audit action could not be verified.');
      setPending(action);dispatched=true;
      const result=await apiClient.operations.auditReconciliation(action),report=parseStoredReceiptAudit(result);
      if(!report||report.auditId!==action.actionId||report.actorUserId!==state.userId||report.scopeSha256!==action.expectedScopeSha256)
        throw new Error('The returned audit does not match the saved action.');
      if(epoch!==sequence.current)return;
      sessionStorage.removeItem(key);setPending(null);setReason('');setNotice(result.replayed?'Original audit recovered. No new audit was created.':'Stored receipt audit recorded. Nothing was repaired.');
      const current=await load();
      if(current&&current.scope.sha256===report.scopeSha256)setSelected(report);
    }catch(error){if(epoch===sequence.current)setNotice(dispatched?`Audit not confirmed: ${reasonOf(error)} Retry the saved action; its ID and inputs are unchanged.`:
      'The action could not be saved in this browser. No request was sent. Restore browser storage and try again.');}
    finally{running.current=false;if(epoch===sequence.current)setBusy(false);}
  };
  const clear=()=>{if(!state||busy||running.current)return;try{sessionStorage.removeItem(storageKey(state));setPending(null);setStorageInvalid(false);setNotice('Saved browser action cleared. Stored audit history is unchanged.');}
    catch{setNotice('Browser storage is unavailable. The saved action could not be cleared.');}};
  const audit=selected;
  return <section className="panel" aria-label="Stored publication receipt audit" style={{padding:16,marginTop:16}}>
    <div style={{display:'flex',justifyContent:'space-between',flexWrap:'wrap',gap:12,alignItems:'center'}}>
      <h2 style={{margin:0}}>Stored publication receipt audit</h2>
      <button className="btn" onClick={()=>void load()} disabled={busy}>Reload receipt audits</button>
    </div>
    <p>Compares one PostgreSQL snapshot for your current authorized clients. Google Drive and Sheets are not read; nothing is repaired.</p>
    {unavailable?<p role="alert">Receipt audit evidence unavailable: {unavailable}</p>:!state?<p>Reading audit scope…</p>:<>
      <p>Scope: {state.scope.clientIds.length} authorized client(s) and unassigned office tasks. History belongs to your current identity and this exact client scope.</p>
      <form onSubmit={record}>
        {pending?<p>A saved audit action needs confirmation. Retry returns its original result if it already committed.</p>:
          <label style={{display:'flex',flexDirection:'column',gap:6}}>Audit reason
            <textarea aria-label="Audit reason" required maxLength={500} value={reason} onChange={e=>setReason(e.target.value)} disabled={busy||storageInvalid} style={{width:'100%',boxSizing:'border-box'}}/>
          </label>}
        {storageInvalid&&<p role="alert">The saved browser action could not be read. Restore storage or clear it before starting a new audit.</p>}
        <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:10}}>
          <button className="btn" disabled={busy||running.current||storageInvalid||!pending&&!reason.trim()}>{busy?'Reading audit…':pending?'Retry saved audit':'Run receipt audit'}</button>
          {(pending||storageInvalid)&&<button className="btn" type="button" disabled={busy||running.current} onClick={clear}>Clear saved audit action</button>}
        </div>
      </form>
      <details style={{marginTop:12}}><summary>Audit history</summary>
        {state.history.length===0?<p>No stored audits for this identity and scope.</p>:state.history.map(item=><p key={item.auditId}>
          <button className="btn" onClick={()=>setSelected(item)}>View audit {item.revision}</button> {item.timestamp} · {item.reason}
        </p>)}
        {state.nextBeforeRevision!==null&&<button className="btn" disabled={busy} onClick={()=>void load(state.nextBeforeRevision!)}>Older audits</button>}
        {state.latest&&state.history[0]?.revision!==state.latest.revision&&<button className="btn" disabled={busy} onClick={()=>void load()}>Latest audits</button>}
      </details>
    </>}
    {notice&&<p role="status">{notice}</p>}
    <p><span className={`pill ${audit?.driftCount?'bad':''}`}>{!audit?'No audit read':audit.totalTasksAudited===0?'No tasks audited':audit.status==='divergent'?'Drift found':audit.inSyncCount===0?'No completed deliveries audited':'Stored receipts consistent'}</span></p>
    {audit&&<><p>Audit recorded {audit.timestamp} · Revision {audit.revision} · Stored receipt evidence</p><p>{audit.basis}</p><p>Reason: {audit.reason}</p></>}
    <div className="ops-audit-stats">
      {([['Tasks audited',audit?.totalTasksAudited],['Drive receipts',audit?.totalDriveDeliverablesChecked],['Sheet receipts',audit?.totalSheetRowsAudited],
        ['Deliveries consistent',audit?.inSyncCount],['Not yet due',audit?.pendingTaskCount],['Anomalies found',audit?.driftCount]] as const).map(([label,value])=>
        <div className="stat" key={label}><b>{value??'—'}</b><span>{label}</span></div>)}
    </div>
    {audit&&<>
      {audit.anomalies.map((a,i)=><div className="rule" key={`${a.taskId}:${i}`}><b>{a.kind.replaceAll('_',' ')}</b><p>Task {a.taskId} · {a.description}</p></div>)}
      <details><summary>Recorded audit identity</summary><p>Actor: {audit.actorUserId}</p><p>Audit: {audit.auditId}</p><p>Input hash: {audit.inputsSha256}</p><p>Report hash: {audit.reportSha256}</p><p>Scope hash: {audit.scopeSha256}</p></details>
    </>}
  </section>;
}
