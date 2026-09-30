import { afterAll,it,expect } from 'vitest';
import { randomUUID,createHash } from 'node:crypto';
import { createDb,sql,withRlsContext,DesignStudioRepository,assertStudioCallsResolved } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { StudioCallSettlementService,uncertainCallHoldMs,DEFAULT_UNCERTAIN_CALL_HOLD_HOURS } from '../src/services/studio-call-settlement.js';

/**
 * ADR-159 (audit 2026-09-30 #8): an uncertain Studio call blocked its task for good and held its
 * reservation against every later office day; only a Google-signed-in administrator could clear it,
 * and production has no Google sign-in. Now System Automation charges it its whole reservation after
 * a bounded wait, recorded as evidence, and the trusted office may attest as the shared administrator.
 */
const owner=createDb(process.env.TEST_DATABASE_OWNER_URL!),db=createDb(process.env.TEST_DATABASE_URL!);
afterAll(async()=>{await owner.destroy();await db.destroy();});
const reservation={version:1 as const,policy:'synthetic-test',requestSha256:'a'.repeat(64),usd:0.5,inputTokens:100,outputTokens:100};
async function fixture(status:string|null='failed'){
  const tenantId=randomUUID(),userId=randomUUID(),clientId=randomUUID(),taskId=randomUUID(),runId=randomUUID(),callId=randomUUID();
  await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Expiry fixture',${tenantId})`.execute(owner);
  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${userId}::uuid,${userId+'@example.test'},'Office administrator')`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'administrator')`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${SYSTEM_AUTOMATION_USER_ID}::uuid,'operator') ON CONFLICT DO NOTHING`.execute(owner);
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Fixture client')`.execute(owner);
  await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Synthetic expiry')`.execute(owner);
  const repo=new DesignStudioRepository(owner);
  await repo.createRun({id:runId,tenantId,taskId,clientId,actorId:userId,requestKey:`run-${runId}`,requestHash:'a'.repeat(64),request:{},tier:'standard'});
  await repo.recordCallStart({id:callId,tenantId,runId,actorId:userId,stage:'briefing',provider:'openai',model:'synthetic',reservation,
    requestedModel:'synthetic',callOrdinal:1,logicalCallSha256:'b'.repeat(64)});
  if(status)await repo.updateRunStatus(runId,tenantId,status as 'failed');
  return {tenantId,userId,clientId,taskId,runId,callId,repo,scope:{tenantId,userId,role:'administrator'}};
}
/** Owner-only: admission time cannot be changed at runtime, so the fixture ages the call directly. */
async function age(callId:string,hours:number){
  await owner.transaction().execute(async tx=>{
    await sql`ALTER TABLE hawa.design_studio_calls DISABLE TRIGGER enforce_studio_scope_budget`.execute(tx);
    await sql`ALTER TABLE hawa.design_studio_calls DISABLE TRIGGER immutable_design_studio_call`.execute(tx);
    await sql`UPDATE hawa.design_studio_calls SET started_at=now()-${`${hours} hours`}::interval WHERE id=${callId}::uuid`.execute(tx);
    await sql`ALTER TABLE hawa.design_studio_calls ENABLE TRIGGER immutable_design_studio_call`.execute(tx);
    await sql`ALTER TABLE hawa.design_studio_calls ENABLE TRIGGER enforce_studio_scope_budget`.execute(tx);
  });
}
const blocked=(f:{tenantId:string;taskId:string;scope:any})=>withRlsContext(db,f.scope,tx=>assertStudioCallsResolved(tx,f.tenantId,f.taskId));
const office=async(f:{repo:DesignStudioRepository;runId:string;tenantId:string;userId:string})=>
  (await f.repo.getBudgetUsage(f.runId,f.tenantId,f.userId))!.daily!.scopes.find(s=>s.scope==='office')!;

it('reads the wait from HAWA_UNCERTAIN_CALL_HOLD_HOURS, 1 to 168 hours, else six',()=>{
  expect(DEFAULT_UNCERTAIN_CALL_HOLD_HOURS).toBe(6);
  expect(uncertainCallHoldMs({})).toBe(6*3_600_000);
  expect(uncertainCallHoldMs({HAWA_UNCERTAIN_CALL_HOLD_HOURS:'24'})).toBe(24*3_600_000);
  for(const bad of ['0','169','1.5','-2','soon',''])expect(uncertainCallHoldMs({HAWA_UNCERTAIN_CALL_HOLD_HOURS:bad})).toBe(6*3_600_000);
});

it('charges a stopped run\'s uncertain call its whole reservation after the wait, unblocking the task and later days',async()=>{
  const f=await fixture();await age(f.callId,30);
  await expect(blocked(f)).rejects.toMatchObject({code:'MODEL_CALL_UNCERTAIN'});
  // Admitted yesterday or earlier with no outcome: its whole reservation held against today, forever.
  expect(await office(f)).toMatchObject({heldUsd:0.5,spentUsd:0});
  const service=new StudioCallSettlementService(db);
  expect(await service.settleExpired(f.tenantId,6*3_600_000)).toEqual({studioRuns:[f.runId],plannerCalls:[]});
  await expect(blocked(f)).resolves.toBeUndefined();
  expect(await office(f)).toMatchObject({heldUsd:0,spentUsd:0});
  const detail=await service.get(f.scope,f.taskId,f.runId);
  expect(detail).toMatchObject({unresolvedCalls:0,canSettle:false});
  expect(detail.settlements).toEqual([expect.objectContaining({evidenceType:'reservation_expiry',actorUserId:SYSTEM_AUTOMATION_USER_ID,
    calls:[expect.objectContaining({callId:f.callId,conclusion:'reservation_charged',reportedCostUsd:0.5,evidenceReference:'hawa:reservation-expiry'})]})]);
  // Replayed passes add nothing; the call's own record is untouched.
  expect(await service.settleExpired(f.tenantId,6*3_600_000)).toEqual({studioRuns:[],plannerCalls:[]});
  expect(await f.repo.getCallsForRun(f.runId,f.tenantId)).toMatchObject([{id:f.callId,status:'uncertain',finished_at:null}]);
});

it('leaves a young call, and a run that has not stopped, for the office',async()=>{
  const young=await fixture();await age(young.callId,2);
  const running=await fixture(null);await age(running.callId,30);
  const service=new StudioCallSettlementService(db);
  expect(await service.settleExpired(young.tenantId,6*3_600_000)).toEqual({studioRuns:[],plannerCalls:[]});
  expect(await service.settleExpired(running.tenantId,6*3_600_000)).toEqual({studioRuns:[],plannerCalls:[]});
  await expect(blocked(young)).rejects.toMatchObject({code:'MODEL_CALL_UNCERTAIN'});
  const detail=await service.get(young.scope,young.taskId,young.runId);
  expect(Date.parse(detail.calls[0].chargedInFullAfter!)).toBeGreaterThan(Date.now());
});

it('SQL admits the automatic charge only from System Automation, in full, and only after an hour',async()=>{
  const f=await fixture();
  const insert=(scope:{tenantId:string;userId:string;role:string},actor:string,cost:number)=>withRlsContext(db,scope,tx=>sql`INSERT INTO hawa.studio_run_settlements
    (tenant_id,task_id,client_id,run_id,action_id,actor_user_id,request_hash,snapshot_hash,reason,calls,evidence_type)
    VALUES(${f.tenantId}::uuid,${f.taskId}::uuid,${f.clientId}::uuid,${f.runId}::uuid,${randomUUID()}::uuid,${actor}::uuid,
      ${'a'.repeat(64)},${'b'.repeat(64)},'Direct SQL',${JSON.stringify([{callId:f.callId,conclusion:'reservation_charged',
        reportedCostUsd:cost,evidenceReference:'hawa:reservation-expiry',evidenceSha256:'c'.repeat(64)}])}::jsonb,'reservation_expiry')`.execute(tx));
  const system={tenantId:f.tenantId,userId:SYSTEM_AUTOMATION_USER_ID,role:'operator'};
  await expect(insert(system,SYSTEM_AUTOMATION_USER_ID,0.5)).rejects.toThrow(/only after an hour/);
  await age(f.callId,2);
  await expect(insert(f.scope,f.userId,0.5)).rejects.toThrow();
  await expect(insert(system,SYSTEM_AUTOMATION_USER_ID,0.1)).rejects.toThrow(/charged in full/);
  await expect(insert(system,SYSTEM_AUTOMATION_USER_ID,0.5)).resolves.toBeDefined();
});

it('lets the trusted office settle as the shared administrator, recorded as that evidence type',async()=>{
  const f=await fixture(),service=new StudioCallSettlementService(db);
  const trusted={...f.scope,trustedOffice:true};
  const detail=await service.get(trusted,f.taskId,f.runId);
  expect(detail.canSettle).toBe(true);
  expect((await service.get(f.scope,f.taskId,f.runId)).canSettle).toBe(false);
  const body={expectedSnapshot:detail.snapshotHash,reason:'Provider dashboard shows the charge',calls:[{callId:f.callId,
    conclusion:'provider_finished',reportedCostUsd:0.125,evidenceReference:'openai-usage-2026-09-30',evidenceSha256:'d'.repeat(64)}]};
  await expect(service.settle(f.scope,f.taskId,f.runId,randomUUID(),body)).rejects.toMatchObject({status:403});
  await expect(service.settle({...trusted,role:'operator'},f.taskId,f.runId,randomUUID(),body)).rejects.toMatchObject({status:403});
  const saved=await service.settle(trusted,f.taskId,f.runId,randomUUID(),body);
  expect(saved.settlement).toMatchObject({evidenceType:'trusted_office_attestation',actorLabel:'trusted_office_team',actorUserId:f.userId});
  await expect(blocked(f)).resolves.toBeUndefined();
  expect(await office(f)).toMatchObject({heldUsd:0,spentUsd:0.125});
});

it('SQL refuses a trusted-office attestation the trusted-office policy did not admit',async()=>{
  const f=await fixture();
  await expect(withRlsContext(db,f.scope,tx=>sql`INSERT INTO hawa.studio_run_settlements
    (tenant_id,task_id,client_id,run_id,action_id,actor_user_id,request_hash,snapshot_hash,reason,calls,evidence_type)
    VALUES(${f.tenantId}::uuid,${f.taskId}::uuid,${f.clientId}::uuid,${f.runId}::uuid,${randomUUID()}::uuid,${f.userId}::uuid,
      ${'a'.repeat(64)},${'b'.repeat(64)},'Direct SQL',${JSON.stringify([{callId:f.callId,conclusion:'provider_finished',
        reportedCostUsd:0.1,evidenceReference:'case-1',evidenceSha256:createHash('sha256').update('x').digest('hex')}])}::jsonb,
      'trusted_office_attestation')`.execute(tx))).rejects.toThrow(/Trusted office administrator required/);
});
