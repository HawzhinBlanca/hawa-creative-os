import {createDb} from '@hawa/db';
import {FakeModelGateway} from '@hawa/testkit';
import {DurableEvaluationService} from '../../src/services/durable-evaluations.js';
import type {AppError,Result,StructuredModelResponse} from '@hawa/contracts';
const url=process.env.HAWA_EVAL_DRILL_DB!,port=Number(process.env.HAWA_EVAL_DRILL_PORT);
if (!url || !/^\/hawa_(t|tr)_/.test(new URL(url).pathname) || !Number.isInteger(port) || port<1) throw new Error('Isolated evaluation drill configuration required');
const db=createDb(url),gateway=new FakeModelGateway();
gateway.generateStructured=async<T>()=>{
  const response=await fetch(`http://127.0.0.1:${port}/model`,{method:'POST',body:'synthetic fixture'});
  return await response.json() as Result<StructuredModelResponse<T>,AppError>;
};
try{
  await new DurableEvaluationService(db,gateway).run({tenantId:process.env.HAWA_EVAL_DRILL_TENANT!,userId:process.env.HAWA_EVAL_DRILL_USER!,role:'operator'},
    {actionId:process.env.HAWA_EVAL_DRILL_ACTION!,name:'Kill boundary'});
}finally{await db.destroy();}
