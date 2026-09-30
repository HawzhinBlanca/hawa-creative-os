import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, DesignStudioRepository, sql, withRlsContext } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { createApp } from '../src/app.js';
import { pauseRequesterDesign } from '../src/services/requester-hold.js';
import { controlTask } from '../src/services/task-control-service.js';
import { recordRoutingRefusal } from '../src/services/lifecycle-chat-target.js';
import { ConversationHarness } from './fixtures/conversation-harness.js';
import { Play } from './fixtures/conversation-script.js';
import { KAAE_EVENING } from './fixtures/nl-scripts/briefs.js';

const db=createDb(process.env.TEST_DATABASE_URL!);
const owner=createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenantId='00000000-0000-4000-a000-000000000001';
const actorId='00000000-0000-4000-b000-000000000001';
const scope={tenantId,userId:actorId,role:'operator' as const};
const officeScope={tenantId,actorId,role:'operator'};
const worker=['requester','hold','fixture'].join('_');
const headers={Authorization:`Bearer ${process.env.HAWA_BEARER_TOKEN}`,'Content-Type':'application/json'};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
afterAll(async()=>{await db.destroy();await owner.destroy();});

async function opened() {
  vi.stubEnv('HAWA_WORKER_TOKEN',worker);
  const requestId=randomUUID(), chat=String(70_000_000+Math.floor(Math.random()*9_000_000));
  vi.stubEnv('TELEGRAM_ALLOWED_USERS',chat);
  const app=createApp({db});
  const res=await app.request(`/v1/internal/lifecycle/${requestId}/project`,{
    method:'POST',headers:{...headers,Authorization:`Bearer ${worker}`},body:JSON.stringify({
      v:1,expectedRev:0,rev:1,key:`${requestId}:1:open`,ops:[{kind:'createRequest',draft:{
        platform:'telegram',sourceEventId:`lc-${requestId}-r0`,sourceChannelId:chat,
        title:'Synthetic held design',rawText:'Synthetic held design',exactCopy:['Synthetic held design'],
        designInstructions:'Use supplied copy',clientId:'c1000000-0000-4000-8000-000000000002',
        autoGenerate:true,designStudio:false,variant:{width:1080,height:1350}}}]}),
  });
  expect(res.status).toBe(200);
  const taskId=(await res.json()).taskId as string;
  const late:Parameters<typeof pauseRequesterDesign>[2]={requestId,taskId,requestRev:1,requestStage:'designing',text:"Wait, don't make it yet"};
  return {app,late};
}
const state=async(taskId:string)=>(await withRlsContext(db,scope,trx=>trx.selectFrom('tasks')
  .select(['state','version']).where('id','=',taskId).executeTakeFirstOrThrow()));
const hold=(late:Awaited<ReturnType<typeof opened>>['late'],updateId=1)=>withRlsContext(db,scope,trx=>pauseRequesterDesign(trx,tenantId,late,updateId));
const resume=(taskId:string,version:number,key=randomUUID())=>controlTask(db,officeScope,taskId,'resume',{
  expectedVersion:version,key,reason:'Requester confirmed the date; continue the saved design'});

describe('requester hold checkpoint and current owner',()=>{
  it('a duplicate of a second hold made while already paused cannot undo office resume',async()=>{
    const {late}=await opened();await hold(late,10);
    await withRlsContext(db,scope,async trx=>{
      expect(await pauseRequesterDesign(trx,tenantId,late,11)).toBe(true);
      await recordRoutingRefusal(trx,tenantId,11,{code:'LATE_REQUESTER_CHANGE',chatId:'synthetic',payloadHash:'a'.repeat(64),
        late:{...late,kind:'hold',held:true,answer:'The design is paused.'}});
    });
    await resume(late.taskId,Number((await state(late.taskId)).version));
    const resumed=await state(late.taskId);
    expect(await hold(late,11)).toBe(true);expect(await state(late.taskId)).toEqual(resumed);
  });

  it('resumes the actual checkpoint once; a replayed old hold cannot re-pause it',async()=>{
    const {app,late}=await opened();const before=await state(late.taskId);
    expect(await hold(late)).toBe(true);
    const paused=await state(late.taskId);expect(paused.state).toBe('paused');
    const detail=await app.request(`/v1/tasks/${late.taskId}`,{headers});
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({requesterHold:{reason:expect.stringContaining(late.text)}});
    const key=randomUUID(),receipt=await resume(late.taskId,Number(paused.version),key);
    expect(receipt).toMatchObject({workflowId:late.requestId,version:Number(before.version)+2,replayed:false});
    expect(await resume(late.taskId,Number(paused.version),key)).toEqual({...receipt,replayed:true});
    expect(await hold(late)).toBe(true);
    const after=await state(late.taskId);expect(after.state).toBe(before.state);expect(Number(after.version)).toBe(Number(before.version)+2);
    expect(await (await app.request(`/v1/tasks/${late.taskId}`,{headers})).json()).toMatchObject({requesterHold:null});
  });
  it('rejects stale, foreign and non-current targets without pausing the task',async()=>{
    const {late}=await opened();const before=await state(late.taskId);
    expect(await hold({...late,requestRev:2})).toBe(false);
    expect(await hold({...late,requestId:randomUUID()})).toBe(false);
    expect(await hold({...late,taskId:randomUUID()})).toBe(false);
    expect(await hold({...late,requestStage:'in_review'})).toBe(false);
    expect(await state(late.taskId)).toEqual(before);
  });
  it('requires office authority and a current version; service and requester cannot resume',async()=>{
    const {app,late}=await opened();await hold(late);const paused=await state(late.taskId);
    await expect(resume(late.taskId,Number(paused.version)-1)).rejects.toMatchObject({code:'TASK_VERSION_CONFLICT'});
    await expect(controlTask(db,{...officeScope,actorId:SYSTEM_AUTOMATION_USER_ID},late.taskId,'resume',{
      expectedVersion:Number(paused.version),key:randomUUID(),reason:'Service may not resume'})).rejects.toMatchObject({code:'LIFECYCLE_OWNED'});
    const requesterApp=createApp({db,testAuth:{roleHeader:true}});
    const res=await requesterApp.request(`/v1/tasks/${late.taskId}/resume`,{method:'POST',
      headers:{...headers,'x-user-role':'requester','Idempotency-Key':randomUUID()},
      body:JSON.stringify({expectedVersion:Number(paused.version),reason:'Not authorized'})});
    expect(res.status).toBe(403);
    expect(await state(late.taskId)).toEqual(paused);
    const ok=await app.request(`/v1/tasks/${late.taskId}/resume`,{method:'POST',
      headers:{...headers,'Idempotency-Key':randomUUID()},body:JSON.stringify({expectedVersion:Number(paused.version),reason:'Office verified the date'})});
    expect(ok.status).toBe(202);
  });
  it('does not turn a clarification pause into a resumable requester hold',async()=>{
    const {late}=await opened();
    await sql`UPDATE hawa.tasks SET state='paused' WHERE id=${late.taskId}::uuid`.execute(owner);
    expect(await hold(late)).toBe(false);
    await expect(resume(late.taskId,Number((await state(late.taskId)).version))).rejects.toMatchObject({code:'LIFECYCLE_OWNED'});
  });
  it('rolls the pause back when the same transaction cannot retain its receipt',async()=>{
    const {late}=await opened();const before=await state(late.taskId);
    await expect(withRlsContext(db,scope,async trx=>{
      expect(await pauseRequesterDesign(trx,tenantId,late,100)).toBe(true);
      throw new Error('synthetic routing receipt failure');
    })).rejects.toThrow('synthetic routing receipt failure');
    expect(await state(late.taskId)).toEqual(before);
    expect(await hold(late,100)).toBe(true);
  });
  it('retains an admitted result without advancing review until resume',async()=>{
    const {app,late}=await opened();await hold(late);
    const runId=`dr-${late.taskId}`,body={v:1,expectedRev:1,rev:2,key:`${late.requestId}:2:designFinished:${runId}`,
      ops:[{kind:'recordOutcome',taskId:late.taskId,runId,report:{status:'DESIGN_REJECTED',code:'COPY_REQUIRED'}}]};
    const project=()=>app.request(`/v1/internal/lifecycle/${late.requestId}/design-outcome`,{method:'POST',
      headers:{...headers,Authorization:`Bearer ${worker}`},body:JSON.stringify(body)});
    const denied=await project();expect(denied.status).toBe(409);expect(await denied.json()).toMatchObject({code:'TASK_PAUSED'});
    const request=await withRlsContext(db,scope,trx=>trx.selectFrom('requests').select(['stage','rev'])
      .where('request_id','=',late.requestId).executeTakeFirstOrThrow());
    expect(request.stage).toBe('designing');expect(Number(request.rev)).toBe(1);
    await resume(late.taskId,Number((await state(late.taskId)).version));
    const accepted=await project();expect(accepted.status).toBe(200);
    const receipt=await accepted.json();expect(receipt).toMatchObject({rev:2,stage:'manual'});
    expect(await (await project()).json()).toEqual(receipt);
  });
});

describe('holds through the actual requester conversation',()=>{
  let officeSeed=95_000_000+Math.floor(Math.random()*100_000)*10;
  async function play(type:'private'|'group'='private') {
    const office=[{id:++officeSeed,name:'Office'}];
    const h=new ConversationHarness({db,owner,office,workerToken:worker});await h.emptyOfficeQueue();
    const p=new Play(h,office,type);await p.say(KAAE_EVENING);await p.wait(20_000);return p;
  }
  it('a wait sent before brief settlement blocks the real paid-call ledger until office resume',async()=>{
    const office=[{id:++officeSeed,name:'Office'}];
    const initialStates:string[]=[],repo=new DesignStudioRepository(db),runId=randomUUID(),admissionCodes:string[]=[];
    const call={id:randomUUID(),runId,tenantId,actorId,stage:'briefing',provider:'openai',model:'synthetic-test',
      reservation:{version:1 as const,policy:'synthetic-test',requestSha256:'a'.repeat(64),usd:0.01,inputTokens:10,outputTokens:10},
      requestedModel:'synthetic-test',callOrdinal:1,logicalCallSha256:'b'.repeat(64)};
    const h=new ConversationHarness({db,owner,office,workerToken:worker,onDesignStart:async input=>{
      initialStates.push((await state(input.taskId)).state);
      if (!input.clientId) throw new Error('Automatic design dispatch omitted its client');
      await repo.createRun({id:runId,tenantId,taskId:input.taskId,clientId:input.clientId,
        actorId,requestKey:`early-hold-${runId}`,requestHash:'a'.repeat(64),request:{},tier:'premium'});
      try {await repo.recordCallStart(call);admissionCodes.push('ADMITTED');}
      catch (error) {
        if ((error as {code?:string}).code!=='TASK_PAUSED') throw error;
        admissionCodes.push('TASK_PAUSED');
      }
    }});await h.emptyOfficeQueue();
    const p=new Play(h,office);
    await p.say(KAAE_EVENING);
    const waiting=await p.say("Wait, don't make it yet",{after:1000});
    await p.wait(20_000);
    expect(p.opened).toHaveLength(1);
    expect(initialStates).toEqual(['paused']);
    expect(admissionCodes).toEqual(['TASK_PAUSED']);
    const request=(await h.requests(p.chatId))[0];
    const current=await h.taskState(request.requestId);
    expect(current.state).toBe('paused');
    expect(p.answer(waiting)).toMatch(/paused|wait/i);
    expect(h.t.sent.filter(s=>s.chatId===p.chatId).map(s=>s.text).join('\n')).not.toMatch(/making a first draft/i);
    const taskId=request.taskId;
    await expect(repo.recordCallStart(call)).rejects.toMatchObject({code:'TASK_PAUSED'});
    expect(await repo.getCallsForRun(runId,tenantId)).toHaveLength(0);
    await resume(taskId,Number(current.version));
    await expect(repo.recordCallStart(call)).resolves.toMatchObject({status:'uncertain'});
    expect(await repo.getCallsForRun(runId,tenantId)).toHaveLength(1);
  });
  it('asks which design to hold rather than pausing both',async()=>{
    const p=await play();await p.say('Another poster please: KAAE staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium.');
    await p.wait(20_000);expect(p.opened).toHaveLength(2);
    const asked=await p.say('pause the design please');expect(p.answer(asked)).toMatch(/which|1\./i);
    expect((await p.h.taskState(p.request(0))).state).not.toBe('paused');
    expect((await p.h.taskState(p.request(1))).state).not.toBe('paused');
    await p.say('2');expect((await p.h.taskState(p.request(1))).state).toBe('paused');
    expect((await p.h.taskState(p.request(0))).state).not.toBe('paused');
    expect(p.h.t.paidCalls).toEqual([]);
  });
  it('does not let another group member hold the requester’s design',async()=>{
    const p=await play('group');await p.say('@hawa_test_bot pause the design please',{from:p.colleague});
    expect((await p.h.taskState(p.request())).state).not.toBe('paused');
    expect(p.h.t.paidCalls).toEqual([]);
  });
  it('reports a held design as paused rather than claiming it is still being made',async()=>{
    const p=await play();await p.say('pause the design please');
    const answer=await p.say('where is my poster?',{after:60*60_000});
    expect(p.answer(answer)).toMatch(/paused|waiting for the office/i);
    expect(p.answer(answer)).not.toMatch(/being designed right now|taking longer than usual/i);
    expect((await p.h.taskState(p.request())).state).toBe('paused');
  });
});
