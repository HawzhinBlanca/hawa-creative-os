import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createDb } from '/Users/hawzhin/Hawdesign/packages/db/src/index.ts';
import { CanvaConnectService } from '/Users/hawzhin/Hawdesign/apps/core/src/services/canva-connect-service.ts';
const root='/Users/hawzhin/Hawdesign';
const out=root+'/output/acceptance/2026-09-27-native-canva';
const source=readFileSync(out+'/baseline.pptx');
const sourceSha256=createHash('sha256').update(source).digest('hex');
if(sourceSha256!=='73361fc1810373a274537715e819cb9a3795c4d2603c7e0d209aa1b2c1a363b6')throw new Error('Baseline source hash changed');
const journalPath=out+'/reimport.json';
const journal:any=existsSync(journalPath)?JSON.parse(readFileSync(journalPath,'utf8')):{schemaVersion:1,sourceSha256,sourceDesignId:'DAHWWmZ3P3g',sourceCommit:'751556fb1feebe221a89129ed3ddabde44fe4d16',status:'new'};
if(journal.sourceSha256!==sourceSha256)throw new Error('Import journal identity mismatch');
const save=()=>writeFileSync(journalPath,JSON.stringify(journal,null,2)+'\n');
const cfg=JSON.parse(execFileSync('docker',['inspect','hawa-production-core-1'],{encoding:'utf8'}))[0];
const env=Object.fromEntries(cfg.Config.Env.map((s:string)=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1)];}));
const u=new URL(env.DATABASE_URL);u.hostname='127.0.0.1';u.port='54332';
const db=createDb(u.href);
try{
 const service=new CanvaConnectService(db,{clientId:env.CANVA_CLIENT_ID,clientSecret:env.CANVA_CLIENT_SECRET,redirectUri:env.CANVA_REDIRECT_URI,encryptionKey:env.CANVA_TOKEN_ENCRYPTION_KEY});
 const client=await service.authorizedClient({tenantId:'00000000-0000-4000-a000-000000000001',actorId:'00000000-0000-4000-b000-000000000001'});
 if(journal.status!=='new'&&!journal.jobId)throw new Error('Uncertain prior import; resubmission refused');
 if(journal.status==='new'){
  journal.status='claimed';journal.claimedAt=new Date().toISOString();save();
  const result=await client.createImportJob(source,'[TEST] Hawa PPTX reconstruction 2026-09-27');
  journal.jobId=result.job.id;journal.status='submitted';save();
 }
 let job:any;
 for(let attempt=0;attempt<30;attempt++){
  job=(await client.getImportJob(journal.jobId)).job;
  if(job.status!=='in_progress')break;
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 if(job.status!=='success'||job.result?.designs?.length!==1)throw new Error('Import did not return one completed design');
 const design=(await client.getDesign(job.result.designs[0].id)).design;
 if(design.page_count!==1)throw new Error('Unexpected reconstructed page count');
 journal.status='imported';journal.design={id:design.id,title:design.title,pages:design.page_count,createdAt:design.created_at,updatedAt:design.updated_at};journal.completedAt=new Date().toISOString();save();
 console.log(JSON.stringify(journal));
}catch(error){journal.lastFailure={at:new Date().toISOString(),errorClass:error instanceof Error?error.name:'unknown',code:typeof(error as any)?.code==='string'?(error as any).code:null,httpStatus:typeof(error as any)?.status==='number'?(error as any).status:null};save();console.error(JSON.stringify(journal.lastFailure));process.exitCode=1;}finally{await db.destroy();}
