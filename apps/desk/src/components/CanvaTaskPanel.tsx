import React,{useEffect,useRef,useState} from 'react';
import {apiClient} from '../api/client.js';
export const CanvaTaskPanel:React.FC<{taskId:string}>=({taskId})=>{
  const [state,setState]=useState<any>(null),[connected,setConnected]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [width,setWidth]=useState('1200'),[height,setHeight]=useState('1697'),[results,setResults]=useState<Record<string,any>>({});
  const [plans,setPlans]=useState<any[]>([]);
  const [preview,setPreview]=useState<string | null>(null);
  const activeTask=useRef(taskId); activeTask.current=taskId;
  const keys=useRef<Record<string,string>>({});
  const exportRequests=useRef<Record<string,{format:string;key:string}>>({});
  const refresh=async()=>{const [task,account,planning]=await Promise.all([apiClient.canva.taskState(taskId),apiClient.canva.status(),apiClient.canva.plans(taskId)]);if(activeTask.current!==taskId)return;setState(task);setPlans(planning.plans);setConnected(account.authorized===true);setResults(v=>({...v,...Object.fromEntries((task.artifacts||[]).map((a:any)=>[a.operation_id,{operationId:a.operation_id,status:'retrieved',artifact:a}]))}));};
  useEffect(()=>{setState(null);setPlans([]);setResults({});setMessage('');keys.current={};exportRequests.current={};void refresh().catch(e=>setMessage(e.message));},[taskId]);
  // A failed poll is retried in 5 s; a 401 among them reaches the Work screen's sign-in prompt through the API client (2026-09-24).
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden)void refresh().catch(()=>{});},5000);return()=>clearInterval(timer);},[taskId]);
  const latestPng=state?.artifacts?.find((a:any)=>a.format==='png');
  const latestCheck=state?.artifacts?.find((a:any)=>a.content_check)?.content_check;
  useEffect(()=>{let cancelled=false;let objectUrl:string|undefined;setPreview(null);
    if(latestPng)void apiClient.canva.download(taskId,latestPng.id).then(blob=>{if(cancelled)return;objectUrl=URL.createObjectURL(blob);setPreview(objectUrl);}).catch(()=>{});
    return()=>{cancelled=true;if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[taskId,latestPng?.id]);
  const run=async(fn:()=>Promise<void>)=>{setBusy(true);setMessage('');try{await fn();await refresh();}catch(e:any){setMessage(e.message);await refresh().catch(()=>{});}finally{setBusy(false);}};
  const requestKey=(name:string)=>keys.current[name]||(keys.current[name]=crypto.randomUUID());
  const finishExportRequest=(r:any)=>{
    const request=exportRequests.current[r.operationId];
    if(request&&['retrieved','stale','failed'].includes(r.status)){
      if(keys.current[request.format]===request.key)delete keys.current[request.format];
      delete exportRequests.current[r.operationId];
    }
  };
  const create=()=>run(async()=>{const r=await apiClient.canva.create(taskId,Number(width),Number(height),requestKey('create'));setMessage(r.status==='retrieved'?'Blank Canva design created and linked. Open Canva to add your design.':r.message||'Creation recorded; inspect its status before retrying.');});
  const generate=()=>run(async()=>{setMessage('Planning the saved copy with client references. The resulting plan records the model used. This may take up to 90 seconds.');const r=await apiClient.canva.generate(taskId,Number(width),Number(height),requestKey('generate'));setMessage(r.message);if(r.status==='failed')delete keys.current.generate;});
  const capture=(format:'png'|'pdf'|'pptx')=>run(async()=>{
    const current=await apiClient.canva.taskState(taskId);
    if(!current.binding)throw new Error('Link a Canva design first.');
    const key=requestKey(format);
    const r=await apiClient.canva.export(taskId,format,current.binding.version,key);
    exportRequests.current[r.operationId]={format,key};finishExportRequest(r);
    setResults(v=>({...v,[r.operationId]:r}));setMessage(r.message||'Export submitted to Canva. Check its progress below.');
  });
  const resume=(id:string)=>run(async()=>{const r=await apiClient.canva.resume(taskId,id);finishExportRequest(r);setResults(v=>({...v,[id]:r}));setMessage(r.message||(r.status==='stale'?'Canva changed during export. Let the design finish saving, then retrieve a fresh export.':`Export status: ${r.status}`));});
  const download=(artifact:any)=>run(async()=>{const blob=await apiClient.canva.download(taskId,artifact.id);const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`canva-${artifact.sha256}.${artifact.format==='png'?'png':artifact.format==='pptx'?'pptx':'pdf'}`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  return <section aria-label="Canva design and exports" className="rule" style={{marginTop:12}}>
    <h4>Canva design and exports</h4>
    {!connected&&<p>Connect Canva in Settings to create a native design or retrieve its exports.</p>}
    {state&&!state.binding&&<div>
      <p>Create an editable draft from the saved copy and verified client references. The saved plan records the model used. Native font, layout and copy still require review.</p>
      <label>Draft proportions <select value={`${width}x${height}`} onChange={e=>{const [w,h]=e.target.value.split('x');setWidth(w);setHeight(h);}}>
        <option value="1200x1697">Portrait invitation</option><option value="1080x1350">Portrait post</option><option value="1080x1080">Square post</option></select></label>
      <button className="btn" disabled={busy||!connected||plans.some(p=>['planning','planned','uncertain'].includes(p.status))||state.operations?.some((o:any)=>o.kind==='create')} onClick={generate}>Design in Canva</button>
    </div>}
    {plans.map(p=><div key={p.id}><p>Design plan · {p.status}{p.receipt?` · ${p.receipt.returnedModel}`:''}</p>{p.diagnostic&&<p>{p.diagnostic}</p>}
      {p.status==='planned'&&!state?.binding&&<button className="btn" disabled={busy||!connected} onClick={()=>run(async()=>{const r=await apiClient.canva.resumePlan(taskId,p.id);setMessage(r.message);})}>Resume saved design</button>}</div>)}
    {state&&!state.binding&&<details><summary>Create a blank Canva design</summary>
      <p>This creates an editable canvas. Add your approved content in Canva. Canva removes unused blank designs after seven days.</p>
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        <label>Width (px) <input type="number" min="40" max="8000" value={width} onChange={e=>setWidth(e.target.value)} style={{width:100}} /></label>
        <label>Height (px) <input type="number" min="40" max="8000" value={height} onChange={e=>setHeight(e.target.value)} style={{width:100}} /></label>
        <button className="btn" disabled={busy||!connected||!width||!height||state.operations?.some((o:any)=>o.kind==='create')} onClick={create}>Create in Canva</button>
      </div>
    </details>}
    {state?.binding&&<div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
      <button className="btn" disabled={busy||!connected} onClick={()=>capture('png')}>Retrieve PNG</button>
      <button className="btn" disabled={busy||!connected} onClick={()=>capture('pdf')}>Retrieve PDF</button>
      <button className="btn" disabled={busy||!connected} onClick={()=>capture('pptx')}>Check copy &amp; fonts</button>
    </div>}
    <p>Exports are stored as evidence pending QA. PDF here is a standard export, not a print certification.</p>
    {latestCheck&&<div role="status" style={{padding:12,borderRadius:8,background:latestCheck.copyPass&&latestCheck.fontPass?'var(--surface)':'#3b2022',color:latestCheck.copyPass&&latestCheck.fontPass?'inherit':'#ffe1df',marginTop:12}}>
      <strong>{!latestCheck.copyPass?'Copy needs correction':!latestCheck.fontPass?'Brand font needs correction':'Copy and font checks passed'}</strong>
      <p>{!latestCheck.fontPass?`Canva used ${latestCheck.observedFonts.join(', ')}. Required: ${latestCheck.requiredFont}. Correct the font in Canva, then check again.`:'Review the logo and layout before release.'}</p>
      <span>{latestCheck.copyPass?'All submitted copy matches.':'The exported copy differs from the saved request.'}</span>
    </div>}
    <div style={{display:'flex',gap:8,marginTop:12}}>{(state?.artifacts||[]).filter((a:any,i:number,all:any[])=>['png','pdf_standard'].includes(a.format)&&all.findIndex(b=>b.format===a.format)===i).map((a:any)=><button key={a.id} className="btn" disabled={busy} onClick={()=>download(a)}>Download {a.format==='png'?'PNG':'PDF'} draft</button>)}</div>
    {preview&&<figure style={{margin:'12px 0'}}><img src={preview} alt="Retrieved Canva export, pending design QA" style={{maxWidth:'100%',maxHeight:600,objectFit:'contain'}}/><figcaption>Retrieved Canva export — QA pending</figcaption></figure>}
    {message&&<p role="status">{message}</p>}
    <details style={{marginTop:12}}><summary>Evidence and operation history</summary>
    {(state?.operations||[]).map((o:any)=>{const r=results[o.id];return <div key={o.id} style={{borderTop:'1px solid var(--border)',padding:'8px 0'}}>
      <span>{o.kind==='create'?'Native design':'Export'} · {r?.status||o.status}</span>
      {o.kind==='create'&&o.method==='pptx_import'&&o.status!=='retrieved'&&<button className="btn" disabled={busy||!connected} onClick={()=>run(async()=>{const r=await apiClient.canva.resumeImport(taskId,o.id);setMessage(r.message||`Import status: ${r.status}`);})}>Check import</button>}
      {o.kind==='export'&&<button className="btn" disabled={busy||!connected} onClick={()=>resume(o.id)} style={{marginLeft:8}}>Check / resume</button>}
      {o.kind==='create'&&o.design_id&&<p>Returned design ID: {o.design_id}. Link it to recover an interrupted handoff.</p>}
      {r?.artifact?.content_check&&<p role="status">Copy: {r.artifact.content_check.copyPass?'matches':'MISMATCH'} · Font: {r.artifact.content_check.fontPass?'matches':'MISMATCH'} ({r.artifact.content_check.observedFonts.join(', ')}). Logo, layout and release still require review.</p>}
      {r?.artifact&&<div><p>{r.artifact.byte_size.toLocaleString()} bytes · SHA-256 {r.artifact.sha256}</p><button className="btn" disabled={busy} onClick={()=>download(r.artifact)}>Download retrieved file</button></div>}
      {['creating','uncertain'].includes(o.status)&&<p>The provider result is uncertain. Check Canva before starting another operation.</p>}
    </div>;})}
    </details>
    <button className="btn" disabled={busy} onClick={()=>run(async()=>{})}>Refresh</button>
  </section>;
};
