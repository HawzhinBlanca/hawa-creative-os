// Disposable in-process Core instance. Explicit authentication, no DB, no external I/O.
import fs from 'node:fs';
for (const k of Object.keys(process.env)) if (/DATABASE|API_KEY|TOKEN|SECRET|PHOENIX|OTEL/.test(k)) delete process.env[k];
process.env.NODE_ENV='production';
process.env.HAWA_BEARER_TOKEN='audit-disposable-operator';
const blocked:string[]=[];
globalThis.fetch=(async(url:any)=>{blocked.push(String(url));throw Error('Audit blocks network');}) as any;
const {createApp}=await import('../../../apps/core/src/app.js');
const app=createApp();
const headers={'Content-Type':'application/json',Authorization:'Bearer audit-disposable-operator'};
async function post(path:string,body:any,extra:any={}) { const res=await app.request(path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});return {status:res.status,body:await res.json()}; }
const task=await post('/tasks',{title:'Disposable audit task',description:'Approved exact text'});
const id=task.body.id;
const revision=await post(`/tasks/${id}/revisions`,{nodes:[{id:'audit-text',type:'text',text:'Invented content without approved logo'}],qaReport:{criticalPass:true,reportSha256:'caller-invented'},captureSet:{capturedArtifactSetHash:'caller-invented'}});
const revId=revision.body.revisionId||revision.body.id||revision.body.revision?.revisionId;
const decision=await post(`/tasks/${id}/revisions/${revId}/decisions`,{decision:'approved',role:'creative_director'},{'x-user-role':'creative_director'});
const uiTask=await post('/tasks',{title:'Disposable UI payload audit'});
const uiRev=await post(`/tasks/${uiTask.body.id}/revisions`,{nodes:[{id:'text',type:'text',text:'Audit'}]});
const uiId=uiRev.body.revisionId||uiRev.body.id||uiRev.body.revision?.revisionId;
const uiDecision=await post(`/tasks/${uiTask.body.id}/revisions/${uiId}/decisions`,{action:'approve',role:'art_director'});
const r={timestamp:new Date().toISOString(),scope:'In-process Core source, production auth mode, disposable memory store; NOT deployed PostgreSQL',task,revision,decision,uiDecision,blockedNetworkCalls:blocked};
fs.writeFileSync(new URL('./CORE_PROBES.json',import.meta.url),JSON.stringify(r,null,2));
console.log(JSON.stringify(r,null,2));
