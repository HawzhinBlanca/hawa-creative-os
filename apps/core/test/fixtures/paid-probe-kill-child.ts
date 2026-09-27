import {createDb} from '@hawa/db';
import {PaidModelProbeService} from '../../src/services/paid-model-probe.js';
const url=process.env.HAWA_PROBE_DRILL_DB!,port=Number(process.env.HAWA_PROBE_DRILL_PORT);
if(!url||!/^\/hawa_(t|tr)_/.test(new URL(url).pathname)||new URL(url).port!=='55432'||!Number.isInteger(port)||port<1)throw new Error('Isolated probe drill required');
const db=createDb(url);
const fake:typeof fetch=async(_url,init)=>{
  const response=await fetch(`http://127.0.0.1:${port}/probe`,{...init,headers:{'content-type':'application/json'}});
  await response.clone().text();process.send?.('received');return response;
};
await new PaidModelProbeService(db,fake).execute({tenantId:process.env.HAWA_PROBE_DRILL_TENANT!,userId:process.env.HAWA_PROBE_DRILL_USER!,role:'administrator'},
  'synthetic-probe-key','gpt-4.1-mini',300000);
process.send?.('committed');
setInterval(()=>{},1000); // The parent kills this actual process at the verified boundary.
