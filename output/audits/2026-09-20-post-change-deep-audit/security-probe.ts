/** Offline audit of real routes; database failures are injected doubles, not real DB writes. */
import { randomUUID } from 'node:crypto';
const root = new URL('../../../', import.meta.url);
delete process.env.DATABASE_URL;
process.env.NODE_ENV='test'; process.env.VITEST='true';
const operator=randomUUID(), admin=randomUUID();
process.env.HAWA_BEARER_TOKEN=operator; process.env.HAWA_ADMIN_KEY=admin;
process.env.HAWA_ACTION_HMAC_SECRET=randomUUID();
let networkAttempts=0;
globalThis.fetch=async()=>{networkAttempts++;throw new Error('Network prohibited');};
const {createApp,computeDnaHash}=await import(new URL('apps/core/src/app.ts',root).href);
const headers={Authorization:`Bearer ${operator}`,'Content-Type':'application/json','x-enforce-auth':'1'};
const adminHeaders={...headers,Authorization:`Bearer ${admin}`};
const app=createApp();
let clientExists=false,transactionAttempts=0;
const builder:any=new Proxy({}, {get(_o,key){
  if(key==='executeTakeFirst')return async()=>clientExists?{id:'c1000000-0000-4000-8000-000000000003'}:undefined;
  return()=>builder;
}});
const failingDb:any={selectFrom:()=>builder,transaction:()=>({execute:async()=>{transactionAttempts++;throw new Error('Injected database transaction failure');}})};
const dbApp=createApp({db:failingDb});
const dna=async(client:string)=>await(await app.request(`/v1/clients/${client}/dna`,{headers})).json() as any;
const rules=async(client:string)=>((await(await app.request(`/v1/clients/${client}/candidate-rules`,{headers})).json()) as any).candidateRules;
async function propose(client:string,label:string){
  return ((await(await app.request(`/v1/clients/${client}/candidate-rules/propose`,{method:'POST',headers,body:JSON.stringify({taskId:randomUUID(),title:label,category:'layout',ruleText:label,rationale:'Isolated offline audit'})})).json())as any).proposal;
}
async function promote(target:any,client:string,rule:any){return target.request(`/v1/clients/${client}/candidate-rules/${rule.id}/promote`,{method:'POST',headers:adminHeaders,body:'{}'});}

const missing=await propose('client-drustee','OFFLINE_MISSING_CLIENT');
const missingBefore=await dna('client-drustee');
const missingStatus=(await promote(dbApp,'client-drustee',missing)).status;
const missingAfter=await dna('client-drustee');
const missingRuleAfter=(await rules('client-drustee')).find((r:any)=>r.id===missing.id);

clientExists=true;
const failing=await propose('client-drustee','OFFLINE_TRANSACTION_REJECTED');
const failureBefore=await dna('client-drustee');
const transactionStatus=(await promote(dbApp,'client-drustee',failing)).status;
const failureAfter=await dna('client-drustee');
const failingRuleAfter=(await rules('client-drustee')).find((r:any)=>r.id===failing.id);

const snapshotsBefore:any=await(await app.request('/v1/clients/client-aster/snapshots',{headers})).json();
const baseline=snapshotsBefore[0];
const accepted=await propose('client-aster','OFFLINE_PROMOTED_ASTER');
const acceptedStatus=(await promote(app,'client-aster',accepted)).status;
const snapshotsAfter:any=await(await app.request('/v1/clients/client-aster/snapshots',{headers})).json();
const oldAfter=snapshotsAfter.find((s:any)=>s.snapshotId===baseline.snapshotId);
const dismiss=await app.request(`/v1/clients/client-nova/candidate-rules/${accepted.id}/dismiss`,{method:'POST',headers,body:'{}'});
const dismissed=(await rules('client-aster')).find((r:any)=>r.id===accepted.id);
const asterAfterDismiss=await dna('client-aster');

const forged=await app.request('/v1/clients/client-drustee/dna/rollback',{method:'POST',headers,body:JSON.stringify({targetVersion:1,role:'administrator',reason:'Offline control'})});
const crossRule=await propose('client-drustee','OFFLINE_CROSS_CLIENT_CONTROL');
const crossStatus=(await promote(app,'client-aster',crossRule)).status;

// Real Core stream plus genuine successful mutation: scoped delivery should preserve authorized updates.
const stream=await app.request('/v1/events/stream',{headers});
const reader=stream.body!.getReader();
await reader.read();
let received=false;
const pending=reader.read().then(value=>{if(!value.done)received=true;});
const original=await dna('client-nova');
const update=await app.request('/v1/clients/client-nova/dna',{method:'POST',headers,body:JSON.stringify({...original,name:'Offline stream update'})});
await new Promise(resolve=>setTimeout(resolve,200));
const authorizedUpdateObserved=received;
await reader.cancel(); await pending;
console.log(JSON.stringify({sourceCommit:'6d3c583791a404c914e25b77dda558b16d26bd6c',networkAttempts,transactionAttempts,
  missingClientPromotion:{status:missingStatus,dnaUnchanged:JSON.stringify(missingBefore)===JSON.stringify(missingAfter),ruleStatusBefore:missing.status,ruleStatusAfter:missingRuleAfter.status},
  rejectedTransactionPromotion:{status:transactionStatus,rulePresentBefore:failureBefore.guidelines.layoutRules.includes(failing.ruleText),rulePresentAfter:failureAfter.guidelines.layoutRules.includes(failing.ruleText),versionBefore:failureBefore.version,versionAfter:failureAfter.version,ruleStatusAfter:failingRuleAfter.status},
  historicalSnapshot:{promotionStatus:acceptedStatus,baselineContentChanged:JSON.stringify(baseline.dna)!==JSON.stringify(oldAfter.dna),savedHashUnchanged:baseline.sha256===oldAfter.sha256,savedHashMatchesCurrentContent:oldAfter.sha256===computeDnaHash(oldAfter.dna)},
  unauthorizedDismiss:{status:dismiss.status,authenticatedRole:'operator',urlClient:'client-nova',actualRuleClient:accepted.clientId,ruleStatusAfter:dismissed.status,activeDnaStillContainsRule:asterAfterDismiss.guidelines.layoutRules.includes(accepted.ruleText)},
  repairedControls:{forgedRollbackStatus:forged.status,crossClientPromotionStatus:crossStatus},
  authorizedRealtimeUpdate:{mutationStatus:update.status,streamStatus:stream.status,observationMilliseconds:200,eventObserved:authorizedUpdateObserved}},null,2));
