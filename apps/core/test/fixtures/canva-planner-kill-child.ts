import {createDb} from '@hawa/db';
import {CanvaDesignPlanner} from '../../src/services/canva-design-planner.js';
import type {CanvaConnectService} from '../../src/services/canva-connect-service.js';
const url=process.env.HAWA_PLANNER_DRILL_DB!,port=Number(process.env.HAWA_PLANNER_DRILL_PORT);
if(!url||!/^\/hawa_(repair|tr)_/.test(new URL(url).pathname)||new URL(url).port!=='55432'||!Number.isInteger(port)||port<1)throw new Error('Isolated planner drill required');
const db=createDb(url),boundary=process.env.HAWA_PLANNER_DRILL_BOUNDARY;
const hold=()=>new Promise<never>(()=>{});
const fake:typeof fetch=async(_url,init)=>{
 const response=await fetch(`http://127.0.0.1:${port}/planner`,{...init,headers:{'content-type':'application/json'}});
 await response.clone().text();process.send?.('received');
 if(boundary==='after-response-before-save')await hold();
 return response;
};
const canva={importEditableDesign:async()=>{throw new Error('Child must die before import');}} as unknown as CanvaConnectService;
const planner=new CanvaDesignPlanner(db,canva,{apiKey:'synthetic-key',fetcher:fake});
if(boundary==='after-save'){
 // Stop at the production recovery boundary, after the real SQL outcome commit.
 (planner as unknown as {materialize:()=>Promise<void>}).materialize=async()=>{process.send?.('committed');await hold();};
}
await planner.generate({tenantId:process.env.HAWA_PLANNER_DRILL_TENANT!,actorId:process.env.HAWA_PLANNER_DRILL_USER!},
 process.env.HAWA_PLANNER_DRILL_TASK!,process.env.HAWA_PLANNER_DRILL_KEY!,1200,1697);
process.send?.('unexpected-end');await db.destroy();
