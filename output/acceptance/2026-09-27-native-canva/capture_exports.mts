import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createDb } from '/Users/hawzhin/Hawdesign/packages/db/src/index.ts';
import { CanvaConnectService, downloadCanvaExport } from '/Users/hawzhin/Hawdesign/apps/core/src/services/canva-connect-service.ts';

const root = '/Users/hawzhin/Hawdesign';
const out = root + '/output/acceptance/2026-09-27-native-canva';
const stage = process.argv.includes('--reconstructed') ? 'reconstructed' : 'baseline';
const designId = stage==='baseline' ? 'DAHWWmZ3P3g' : 'DAHWWrLK0so';
const expectedUpdatedAt = stage==='baseline' ? 1790477298 : 1790477617;
mkdirSync(out, { recursive: true });
const journalPath = `${out}/${stage}-capture.json`;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const cfg = JSON.parse(execFileSync('docker', ['inspect', 'hawa-production-core-1'], { encoding: 'utf8' }))[0];
const env = Object.fromEntries(cfg.Config.Env.map((line: string) => {
  const i = line.indexOf('='); return [line.slice(0,i),line.slice(i+1)];
}));
const url = new URL(env.DATABASE_URL); url.hostname='127.0.0.1'; url.port='54332';
const db = createDb(url.href);
const service = new CanvaConnectService(db, {
  clientId:env.CANVA_CLIENT_ID, clientSecret:env.CANVA_CLIENT_SECRET,
  redirectUri:env.CANVA_REDIRECT_URI, encryptionKey:env.CANVA_TOKEN_ENCRYPTION_KEY,
});
const journal: any = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath,'utf8')) : {
  schemaVersion:1, designId, stage, expectedUpdatedAt,
  sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  startedAt:new Date().toISOString(), sourceHashes:Object.fromEntries([
    'apps/core/src/services/canva-connect-service.ts','packages/integrations/src/canva-connect-client.ts'
  ].map(name=>[name,sha256(readFileSync(`${root}/${name}`))])), formats:{},
  scope:'Real Connect API exports of a disposable connector-created copy; no Hawa task/binding, approval or delivery.'
};
if (journal.designId!==designId || journal.expectedUpdatedAt!==expectedUpdatedAt) throw new Error('Journal identity mismatch');
const save=()=>writeFileSync(journalPath,JSON.stringify(journal,null,2)+'\n');
const inspectDesign=(d:any)=>{
  if(d.id!==designId || d.updated_at!==expectedUpdatedAt || d.page_count!==1) throw new Error('Design changed; capture refused');
  return {id:d.id,title:d.title,pages:d.page_count,createdAt:d.created_at,updatedAt:d.updated_at};
};
try {
  const client=await service.authorizedClient({tenantId:'00000000-0000-4000-a000-000000000001',actorId:'00000000-0000-4000-b000-000000000001'});
  journal.before=inspectDesign((await client.getDesign(designId)).design); save();
  for(const format of (stage==='baseline' ? ['png','pdf','pptx'] : ['png']) as Array<'png'|'pdf'|'pptx'>){
    let item=journal.formats[format];
    if(item?.status==='captured'){
      if(sha256(readFileSync(`${out}/${item.file}`))!==item.sha256)throw new Error('Retained artifact changed');
      continue;
    }
    if(item && !item.jobId)throw new Error('Uncertain export request; automatic resubmit refused');
    if(!item){
      item=journal.formats[format]={status:'claimed',claimedAt:new Date().toISOString()}; save();
      const created=await client.createExportJob(designId,format);
      item.jobId=created.job.id; item.status='submitted'; save();
    }
    let job:any;
    for(let attempt=0;attempt<20;attempt++){
      job=(await client.getExportJob(item.jobId)).job;
      if(job.status!=='in_progress')break;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    if(job.status!=='success' || job.urls?.length!==1)throw new Error('Export has not produced exactly one file');
    const bytes=await downloadCanvaExport(job.urls[0]);
    const magic=format==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
      format==='pdf'?bytes.subarray(0,5).toString()==='%PDF-':bytes.subarray(0,4).equals(Buffer.from([80,75,3,4]));
    if(!magic || bytes.length<100)throw new Error('Export format signature failed');
    const file=`${stage}.${format}`;
    if(existsSync(`${out}/${file}`)&&sha256(readFileSync(`${out}/${file}`))!==sha256(bytes))throw new Error('Conflicting artifact refused');
    writeFileSync(`${out}/${file}`,bytes);
    Object.assign(item,{status:'captured',file,sha256:sha256(bytes),bytes:bytes.length,capturedAt:new Date().toISOString()}); save();
    console.log(JSON.stringify({format,status:item.status,bytes:item.bytes,sha256:item.sha256}));
  }
  journal.after=inspectDesign((await client.getDesign(designId)).design);
  journal.completedAt=new Date().toISOString(); journal.status='captured';
  journal.limit='Equal provider timestamps are a consistency observation, not an atomic Canva revision lock.'; save();
}catch(error){
  journal.lastFailure={at:new Date().toISOString(),errorClass:error instanceof Error?error.name:'unknown',
    code:typeof(error as any)?.code==='string'?(error as any).code:null,
    httpStatus:typeof(error as any)?.status==='number'?(error as any).status:null};save();
  console.error(JSON.stringify(journal.lastFailure));process.exitCode=1;
}finally{await db.destroy();}
