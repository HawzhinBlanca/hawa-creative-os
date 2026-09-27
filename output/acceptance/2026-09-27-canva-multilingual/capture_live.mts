import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDb } from '../../../packages/db/src/index.ts';
import { CanvaConnectService, downloadCanvaExport } from '../../../apps/core/src/services/canva-connect-service.ts';
import { checkCanvaPptx } from '../../../packages/qa/src/canva-pptx-check.ts';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const out=fileURLToPath(new URL('.',import.meta.url));
const manifest=JSON.parse(readFileSync(out+'fixtures.json','utf8'));
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
for(const [name,hash] of Object.entries(manifest.sourceHashes))if(digest(readFileSync(root+name))!==hash)throw new Error('Qualified runtime source changed');
if(manifest.groups.length!==4||manifest.corpus.caseCount!==40)throw new Error('Unexpected capture scope');
const journalPath=out+'live-capture.json';
const lockPath=out+'.capture.lock';
const lock=openSync(lockPath,'wx',0o600); // No automatic stale takeover across uncertain side effects.
const journal:any=existsSync(journalPath)?JSON.parse(readFileSync(journalPath,'utf8')):{schemaVersion:1,sourceCommit:manifest.sourceCommit,corpusSha256:manifest.corpus.sha256,startedAt:new Date().toISOString(),groups:{},scope:'Four synthetic one-page sheets; real Hawa typed provider client, no full task/approval/delivery workflow.'};
if(journal.corpusSha256!==manifest.corpus.sha256)throw new Error('Journal corpus changed');
const recapture=process.argv.includes('--recapture-group-1');
function save(){
 const temp=journalPath+'.tmp';const fd=openSync(temp,'w',0o600);
 try{writeFileSync(fd,JSON.stringify(journal,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 renameSync(temp,journalPath);const directory=openSync(out,'r');try{fsyncSync(directory);}finally{closeSync(directory);}
}
const cfg=JSON.parse(execFileSync('docker',['inspect','hawa-production-core-1'],{encoding:'utf8'}))[0];
const env=Object.fromEntries(cfg.Config.Env.map((s:string)=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1)];}));
const u=new URL(env.DATABASE_URL);u.hostname='127.0.0.1';u.port='54332';
const db=createDb(u.href);
const service=new CanvaConnectService(db,{clientId:env.CANVA_CLIENT_ID,clientSecret:env.CANVA_CLIENT_SECRET,redirectUri:env.CANVA_REDIRECT_URI,encryptionKey:env.CANVA_TOKEN_ENCRYPTION_KEY});
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
let phase='authorize';
try{
 const client=await service.authorizedClient({tenantId:'00000000-0000-4000-a000-000000000001',actorId:'00000000-0000-4000-b000-000000000001'});
 for(const group of (recapture?manifest.groups.slice(0,1):manifest.groups)){
  const recordId=recapture?group.id+'-round-2':group.id;
  const bytes=readFileSync(out+group.file);if(digest(bytes)!==group.sha256)throw new Error('Frozen source artifact changed');
  if(recapture&&!journal.groups[group.id]?.design)throw new Error('Recapture requires an existing design');
  const record=journal.groups[recordId]??={caseIds:group.cases.map((c:any)=>c.id),sourceSha256:group.sha256,exports:{},
   ...(recapture?{import:structuredClone(journal.groups[group.id].import),design:structuredClone(journal.groups[group.id].design),reason:'New capture after observed initial metadata change; first failed set retained.'}:{})};
  if(record.sourceSha256!==group.sha256)throw new Error('Journal source mismatch');
  phase=group.id+':import';
  if(record.import&&!record.import.jobId)throw new Error('Uncertain import claim; resubmit refused');
  if(!record.import){
   record.import={status:'claimed',operationKey:`rtl-20260927-${recordId}-import`,at:new Date().toISOString()};save();
   const created=await client.createImportJob(bytes,`[TEST] Hawa RTL 2026-09-27 ${group.id}`);
   record.import.jobId=created.job.id;record.import.status='submitted';save();
  }
  if(!record.design){
   phase=group.id+':import-readback';
   let job:any;
   for(let attempt=0;attempt<30;attempt++){job=(await client.getImportJob(record.import.jobId)).job;if(job.status!=='in_progress')break;await wait(1000);}
   if(job.status!=='success'||job.result?.designs?.length!==1)throw new Error('Import not completed with one design');
   const d=(await client.getDesign(job.result.designs[0].id)).design;
   if(d.page_count!==1)throw new Error('Unexpected page count');
   record.design={id:d.id,title:d.title,pageCount:d.page_count,createdAt:d.created_at,updatedAt:d.updated_at};record.import.status='completed';save();
   console.log(JSON.stringify({group:group.id,event:'imported',designId:d.id}));
  }
  if(!record.captureBefore){
   phase=group.id+':capture-metadata';
   if(Object.keys(record.exports).length){record.captureBefore=structuredClone(record.design);}
   else{
    let first=(await client.getDesign(record.design.id)).design;
    record.metadataSamples=[{updatedAt:first.updated_at,observedAt:new Date().toISOString()}];
    for(let attempt=0;attempt<4;attempt++){
     await wait(3000);const second=(await client.getDesign(record.design.id)).design;
     record.metadataSamples.push({updatedAt:second.updated_at,observedAt:new Date().toISOString()});
     if(second.updated_at===first.updated_at){record.captureBefore={id:second.id,updatedAt:second.updated_at,pageCount:second.page_count};break;}
     first=second;
    }
    if(!record.captureBefore)throw new Error('Design metadata did not stabilize');
   }
   save();
  }
  for(const format of ['png','pdf','pptx'] as const){
   phase=group.id+':'+format;
   let item=record.exports[format];
   if(item?.status==='captured'){
    if(digest(readFileSync(out+item.file))!==item.sha256)throw new Error('Retained export changed');
    continue;
   }
   if(item&&!item.jobId)throw new Error('Uncertain export claim; resubmit refused');
   if(!item){
    item=record.exports[format]={status:'claimed',operationKey:`rtl-20260927-${recordId}-${format}`,at:new Date().toISOString()};save();
    const created=await client.createExportJob(record.design.id,format);item.jobId=created.job.id;item.status='submitted';save();
   }
   let job:any;
   for(let attempt=0;attempt<30;attempt++){job=(await client.getExportJob(item.jobId)).job;if(job.status!=='in_progress')break;await wait(1000);}
   if(job.status!=='success'||job.urls?.length!==1)throw new Error('Export not completed with one file');
   const exported=await downloadCanvaExport(job.urls[0]);
   const magic=format==='png'?exported.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):format==='pdf'?exported.subarray(0,5).toString()==='%PDF-':exported.subarray(0,4).equals(Buffer.from([80,75,3,4]));
   if(!magic)throw new Error('Format signature refused');
   const file=`${recordId}-canva.${format}`;
   if(existsSync(out+file)&&digest(readFileSync(out+file))!==digest(exported))throw new Error('Conflicting retained artifact');
   writeFileSync(out+file,exported);Object.assign(item,{status:'captured',file,bytes:exported.length,sha256:digest(exported),capturedAt:new Date().toISOString()});
   if(format==='png')item.pixels=[exported.readUInt32BE(16),exported.readUInt32BE(20)];
   if(format==='pptx'){
    const qa=checkCanvaPptx(exported,group.cases.map((c:any)=>c.text),{allowedFontsByScript:{latin:['Noto Sans Arabic'],arabic:['Noto Sans Arabic']}});
    const qaFile=`${recordId}-qa.json`;writeFileSync(out+qaFile,JSON.stringify(qa,null,2)+'\n');
    item.qa={file:qaFile,sha256:digest(readFileSync(out+qaFile)),copyPass:qa.copyPass,fontPass:qa.fontPass,rtlPass:qa.rtlPass,rtlNote:qa.rtlNote,textObjectCount:qa.textObjectCount,observedFonts:qa.observedFonts,fullReleasePass:qa.fullReleasePass};
   }
   save();console.log(JSON.stringify({group:group.id,event:'captured',format,bytes:item.bytes,...(item.pixels?{pixels:item.pixels}:{}),...(item.qa?{qa:item.qa}:{})}));
   await wait(3500); // Bound the caller below documented per-user POST limits.
  }
  const after=(await client.getDesign(record.design.id)).design;
  record.captureAfter={id:after.id,updatedAt:after.updated_at,pageCount:after.page_count};
  record.captureMetadataUnchanged=after.updated_at===record.captureBefore.updatedAt;
  record.status=record.captureMetadataUnchanged?'captured':'design_changed';save();
  // Each changed set remains refused; other independent sheets can still collect evidence.
  if(!record.captureMetadataUnchanged)console.log(JSON.stringify({group:recordId,event:'capture_refused_metadata_changed',before:record.captureBefore.updatedAt,after:after.updated_at}));
 }
 journal.status=Object.values(journal.groups).every((r:any)=>r.status==='captured')?'captured':'captures_include_refused_set';journal.completedAt=new Date().toISOString();journal.fullMultilingualAdmission=false;save();
}catch(error){
 journal.lastFailure={at:new Date().toISOString(),phase,errorClass:error instanceof Error?error.name:'unknown',code:typeof(error as any)?.code==='string'?(error as any).code:null,httpStatus:typeof(error as any)?.status==='number'?(error as any).status:null,causeCode:typeof(error as any)?.cause?.code==='string'?(error as any).cause.code:null};
 (journal.failures??=[]).push(journal.lastFailure);save();console.error(JSON.stringify(journal.lastFailure));process.exitCode=1;
}finally{await db.destroy();closeSync(lock);unlinkSync(lockPath);}
