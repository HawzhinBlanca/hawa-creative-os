import fs from 'node:fs';
import { draftStore } from '/tmp/hawa-deep-audit-20260910/apps/desk/src/services/draftStore.ts';
const out='/Users/hawzhin/Hawdesign/output/audits/2026-09-10-deep-audit/';
const memory=new Map<string,string>();
let reject=false;
Object.assign(globalThis,{window:{},localStorage:{setItem:(k:string,v:string)=>{if(reject)throw Error('AUDIT quota exceeded');memory.set(k,v)},getItem:(k:string)=>memory.get(k)||null,removeItem:(k:string)=>memory.delete(k)}});
draftStore.saveActiveDraft({title:'Audit draft',copy:'English',copyCkb:'سڵاو',clientId:'audit-client'} as any);
const saved=draftStore.getActiveDraft();
memory.clear();reject=true;
let quotaReported=false;
try{draftStore.saveActiveDraft({title:'Must save',copy:'Keep this'});}catch{quotaReported=true;}
const queued=draftStore.enqueueTask({title:'Offline task',copy:'Keep this',clientId:'audit-client'});
const result:any={draftStoredFields:Object.keys(saved||{}),quotaErrorPropagated:quotaReported,queueReturnedSuccess:!!queued.id,actuallyQueued:draftStore.getQueuedTasks().length};
reject=false;
draftStore.enqueueTask({title:'Downstream failure',copy:'Exact price 25',clientId:'audit-client'});
const calls:any[]=[];
globalThis.fetch=async(input:any,init:any={})=>{
 const route=String(input);const body=init.body?JSON.parse(init.body):null;calls.push({route,body});
 return route==='/v1/tasks'?Response.json({id:'audit-task'},{status:201}):Response.json({error:'failed'},{status:400});
};
result.flush=await draftStore.flushQueuedTasks();
result.queueAfterFailedDownstream=draftStore.getQueuedTasks().length;
result.calls=calls;
fs.writeFileSync(out+'draft-probes.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
