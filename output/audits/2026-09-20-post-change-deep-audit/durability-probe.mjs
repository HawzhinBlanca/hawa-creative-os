// Offline execution of current application source. No DB or real network; unknown transport fails.
import fs from 'node:fs';
import crypto from 'node:crypto';
import ts from 'typescript';
const root = new URL('../../../', import.meta.url);
const compile = source => ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const load = source => import('data:text/javascript;base64,'+Buffer.from(compile(source)).toString('base64'));
const source = fs.readFileSync(new URL('packages/integrations/src/google-publisher.ts',root),'utf8');
const {GooglePublisher} = await load(source);
const bytes=Buffer.from('approved'), hash=crypto.createHash('sha256').update(bytes).digest('hex');
const request={taskId:'synthetic-task-a',clientId:'synthetic-client-a',designRevisionId:'synthetic-revision-a',approvalId:'synthetic-approval-a',publicationKey:'synthetic-publication-a',packageHash:hash,files:[{artifactId:'synthetic-artifact-a',filename:'approved.png',mimeType:'image/png',sha256:hash,byteSize:bytes.length,content:bytes}],destination:{productionRootFolderId:'synthetic-folder-a',sharedDriveId:'synthetic-drive-a',spreadsheetId:'synthetic-sheet-a',sheetId:123},sheetRow:{}};
const make=()=>new GooglePublisher({oauthToken:crypto.randomUUID()});
function transport(o={}) {
  const files=[],rows=[],calls=[],overwritten=[],blocked=[]; let uploadLost=false,sheetLost=false,readLost=false,moved=false;
  globalThis.fetch=async(url,opts={})=>{
    url=String(url);calls.push({method:opts.method||'GET',url});
    if(url.startsWith('https://www.googleapis.com/upload/drive/v3/files?')){
      const file={id:'synthetic-file-'+(files.length+1),name:'approved.png',size:String(bytes.length),mimeType:'image/png',...(o.missingChecksum?{}:{sha256Checksum:o.wrongChecksum?'0'.repeat(64):hash})};files.push(file);
      if(o.loseUpload&&!uploadLost){uploadLost=true;throw Error('Synthetic committed upload with lost reply');}
      return Response.json({id:file.id});
    }
    if(url.startsWith('https://www.googleapis.com/drive/v3/files/')){const file=files.find(f=>url.includes('/'+f.id+'?'));return file?Response.json(file):new Response('',{status:404});}
    if(url.endsWith('/values/A:A')){
      if(o.lookupFailure)return new Response('',{status:503});
      const snapshot=[['task_id'],...rows.map(r=>[r[0]])];
      if(o.moveAfterLookup&&!moved&&rows.length){moved=true;rows.unshift(['synthetic-other-task','synthetic-other-client','','','COMPLETE','','other']);}
      return Response.json({values:snapshot});
    }
    if(url.includes('/values/A1:append?')){rows.push(JSON.parse(opts.body).values[0]);if(o.loseSheet&&!sheetLost){sheetLost=true;throw Error('Synthetic committed append with lost reply');}return Response.json({updates:{updatedRange:'FirstTab!A'+(rows.length+1)+':G'+(rows.length+1)}});}
    const identity=url.match(/\/values\/A(\d+):A\d+$/);
    if(identity){if(o.identityFailure)return new Response('',{status:503});const row=rows[Number(identity[1])-2];return Response.json({values:row?[[row[0]]]:[]});}
    const range=url.match(/\/values\/A(\d+):G\d+/);
    if(range){const i=Number(range[1])-2;if(opts.method==='PUT'){overwritten.push(rows[i]?.[0]);rows[i]=JSON.parse(opts.body).values[0];return Response.json({});}if(o.firstReadFailure&&!readLost){readLost=true;return new Response('',{status:503});}return Response.json({values:rows[i]?[rows[i]]:[]});}
    blocked.push({url,method:opts.method});throw Error('OFFLINE_UNSUPPORTED_ENDPOINT');
  };
  return {files,rows,calls,overwritten,blocked};
}
const originalFetch=globalThis.fetch;
const results={head:'6d3c583791a404c914e25b77dda558b16d26bd6c',sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),scope:'actual source with synthetic transport; NOT production/real provider proof',databaseAccess:false,externalNetworkAccess:false,publication:{}};
try{
  let h=transport();await make().publish({},request);await make().publish({},request);results.publication.freshInstances={files:h.files.length,rows:h.rows.length,unsupportedEndpoints:h.blocked};
  h=transport({loseUpload:true});let p=make();let lostError;try{await p.publish({},request);}catch(e){lostError=e.message;}const replay=await p.publish({},request);results.publication.lostDriveReply={lostError,files:h.files.length,rows:h.rows.length,state:replay.value?.state,unsupportedEndpoints:h.blocked};
  h=transport();p=make();const concurrent=await Promise.all([p.publish({},request),p.publish({},request)]);results.publication.concurrentSameAdapter={files:h.files.length,rows:h.rows.length,states:concurrent.map(r=>r.value?.state),unsupportedEndpoints:h.blocked};
  h=transport({lookupFailure:true});p=make();const blocked=await p.publish({},request);results.publication.fullColumn503={state:blocked.value?.state,rows:h.rows.length,problem:blocked.value?.detail?.sheetProblem,unsupportedEndpoints:h.blocked};
  h=transport({loseSheet:true});p=make();await p.publish({},request);const recovered=await p.publish({},request);results.publication.lostSheetReply={state:recovered.value?.state,rows:h.rows.length,files:h.files.length};
  h=transport({wrongChecksum:true});const mismatch=await make().publish({},request);results.publication.wrongChecksum={state:mismatch.value?.state,verified:mismatch.value?.driveFiles[0]?.verified};
  h=transport({missingChecksum:true});const absent=await make().publish({},request);results.publication.missingChecksum={state:absent.value?.state,verified:absent.value?.driveFiles[0]?.verified};
  h=transport({moveAfterLookup:true});h.rows.push(['synthetic-task-a','synthetic-client-a','','','COMPLETE','old',hash]);const moved=await make().publish({},request);results.publication.moveBetweenLookupAndPut={state:moved.value?.state,overwritten:h.overwritten,rowTaskIds:h.rows.map(r=>r[0]),unsupportedEndpoints:h.blocked};
  h=transport();p=make();await p.publish({},request);const changed=await p.publish({}, {...request,destination:{...request.destination,productionRootFolderId:'synthetic-folder-b',spreadsheetId:'synthetic-sheet-b'}});results.publication.sameKeyChangedDestination={state:changed.value?.state,returnedFolder:changed.value?.driveFolderId,requestedFolder:'synthetic-folder-b',rejected:!changed.ok};
  const workflow=fs.readFileSync(new URL('apps/worker/src/canva-draft-workflow.ts',root),'utf8');
  results.workflowSourceSha256=crypto.createHash('sha256').update(workflow).digest('hex');
  const {runCanvaDraft}=await load(workflow);process.env.HAWA_BEARER_TOKEN=crypto.randomUUID();process.env.HAWA_CORE_INTERNAL_URL='https://synthetic.invalid';
  const journal=new Map();const ctx={run:async(k,fn)=>{if(journal.has(k))return journal.get(k);const v=await fn();journal.set(k,v);return v;}};let calls=0,firstError;
  try{await runCanvaDraft({taskId:'synthetic-task',tenantId:'synthetic-tenant',canvaAutoGenerate:false},ctx,async()=>{calls++;return new Response('',{status:503});});}catch(e){firstError=e.message;}
  const next=await runCanvaDraft({taskId:'synthetic-task',tenantId:'synthetic-tenant',canvaAutoGenerate:false},ctx,async()=>{calls++;return Response.json({ok:true});});
  results.notificationWorkflow503={firstError,calls,replayStatus:next.status,journalEntries:journal.size,realRestateRecoveryProven:false};
  let boundary400;
  try{await runCanvaDraft({taskId:'synthetic-task-400',tenantId:'synthetic-tenant',canvaAutoGenerate:false},{run:async(k,fn)=>fn()},async()=>new Response('',{status:400}));boundary400='returned';}catch(e){boundary400={threw:true,httpStatus:e.httpStatus,status:e.status??null};}
  results.notificationWorkflow400=boundary400;
}finally{globalThis.fetch=originalFetch;}
console.log(JSON.stringify(results,null,2));
