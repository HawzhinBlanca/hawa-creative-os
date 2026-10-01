import {persistClientDnaFixture} from './persisted-client-dna.js';
import {randomUUID} from 'node:crypto';
import {createAppWithClientFixtures} from './app-with-client-fixtures.js';
import {memoryExportStore} from '../pinned-exports-fixture.js';
import type {createDb} from '@hawa/db';
/** Existing fake-publisher path: actual revision, QA, approval and stored publication receipts. */
export async function publishedReceiptTask(db:ReturnType<typeof createDb>){
 const exports=memoryExportStore(),clientId='c1000000-0000-4000-8000-000000000002';
 const app=createAppWithClientFixtures({db,testAuth:{principal:{role:'art_director'}},deliverableStore:exports.store,
  qaEngine:{run:async(_ctx:unknown,input:{designRevisionId:string})=>({ok:true,value:{qcRunId:randomUUID(),revisionId:input.designRevisionId,status:'passed',criticalPass:true,findings:[],profile:'strict'}})} as never});
 await persistClientDnaFixture(app,clientId,{Authorization:`Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`});
 const request=async(path:string,body?:unknown)=>{
  const r=await app.request(path,{method:'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(r.status>=300)throw new Error(`Publication fixture ${path}: ${r.status} ${await r.text()}`);return r.json();
 };
 const task=await request('/tasks',{clientId,title:'Receipt snapshot fixture'}),taskId=String(task.id||task.task?.id);
 const revision=await request(`/tasks/${taskId}/revisions`,{document:{id:'receipt-fixture',pages:[{id:'p',name:'main',width:1080,height:1080,unit:'px'}],nodes:[{id:'copy',type:'text',text:'Receipt fixture'}]}});
 await request(`/tasks/${taskId}/revisions/${revision.revisionId}/qa`);
 await request(`/tasks/${taskId}/revisions/${revision.revisionId}/decisions`,{decision:'approved',role:'art_director',pinnedExportIds:[exports.add(taskId)]});
 await request(`/tasks/${taskId}/publish-omnichannel`);
 return {app,clientId,taskId,revisionId:String(revision.revisionId)};
}
