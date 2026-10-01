import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createDb,sql} from '@hawa/db';
import {type ClientDNA} from '@hawa/domain';
import {SYSTEM_AUTOMATION_USER_ID} from '@hawa/contracts';
import {createClientDnaResolver} from '../src/services/client-dna-resolver.js';
import {createChatCampaignIntake} from '../src/services/chat-campaign-intake.js';
import {createApp} from '../src/app.js';
import {persistClientDnaFixture} from './fixtures/persisted-client-dna.js';
import {createAppWithClientFixtures} from './fixtures/app-with-client-fixtures.js';
import type {CoreContext} from '../src/core-context.js';
const db=createDb(process.env.TEST_DATABASE_URL!),owner=createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenantId='00000000-0000-4000-a000-000000000001',clientId='c1000000-0000-4000-8000-000000000004';
const operator='00000000-0000-4000-b000-000000000001';
afterAll(async()=>{await db.destroy();await owner.destroy();});
const cached={clientId,guidelines:{layoutRules:['Stale process promotion']}} as ClientDNA;
const map=new Map([[clientId,cached],['client-fastpay',cached]]);
const resolveClientDna=createClientDnaResolver({db,clientDnas:map});
const input=()=>({platform:'whatsapp' as const,sourceEventId:randomUUID(),sourceChannelId:`scope-${randomUUID()}`,
 senderName:'Office',rawText:'Make a FastPay poster\nText:\nSend money in seconds\nNo transfer fees',explicitClientId:'client-fastpay',autoGenerate:true});
function intake() {
 const generate=vi.fn(()=>[]);
 const context={db,resolveClientDna,telegramBridge:{},tasks:new Map(),events:new Map(),briefs:new Map(),
  creativeDirector:{generateCommercialBrandOperations:generate},broadcastEvent:vi.fn(),broadcastTransition:vi.fn(),isProduction:false} as unknown as CoreContext;
 return {service:createChatCampaignIntake(context),generate};
}
beforeAll(async()=>{
 await persistClientDnaFixture(createApp({db,testAuth:{principal:{role:'operator'}}}),clientId,
  {Authorization:`Bearer ${process.env.HAWA_BEARER_TOKEN}`},['Actual saved hierarchy']);
});
describe('design learning consumers read current authorized DNA',()=>{
 it('holds legacy generation when stored DNA is absent or unreadable despite warm fixtures',async()=>{
  const app=createAppWithClientFixtures({db,testAuth:{principal:{role:'operator'}}});
  await app.clientDnaHydrated;
  const created=await app.request('/v1/tasks',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID()},
   body:JSON.stringify({clientId:'c1000000-0000-4000-8000-000000000003',title:'Missing stored authority'})});
  expect(created.status).toBe(201);const task=(await created.json()).id;
  const generate=()=>app.request(`/v1/tasks/${task}/generate`,{method:'POST'});
  expect((await generate()).status).toBe(409);
  await sql.raw('REVOKE SELECT ON hawa.client_dna_versions FROM hawa_app').execute(owner);
  try {expect((await generate()).status).toBe(503);}
  finally {await sql.raw('GRANT SELECT ON hawa.client_dna_versions TO hawa_app').execute(owner);}
  expect((await sql`SELECT id FROM hawa.design_revisions WHERE task_id=${task}::uuid`.execute(owner)).rows).toEqual([]);
  expect((await sql`SELECT id FROM hawa.qc_runs WHERE task_id=${task}::uuid`.execute(owner)).rows).toEqual([]);
 });
 it('reads active DNA rather than a cached rule and cannot fall back across denied client scope',async()=>{
  const dna=await resolveClientDna(clientId,{tenantId,userId:operator,role:'operator',requireDatabase:true});
  expect(dna?.guidelines.layoutRules).toEqual(['Actual saved hierarchy']);
  const user=randomUUID();
  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${user}::uuid,${`${user}@example.test`},'Scoped designer')`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${user}::uuid,'designer')`.execute(owner);
  expect(await resolveClientDna(clientId,{tenantId,userId:user,role:'designer',requireDatabase:true})).toBeUndefined();
 });
 it('uses the service identity and current rules for a preview after durable intake',async()=>{
  const {service,generate}=intake(),request=input();
  const result=await service.ingestChatCampaignTask(request);
  expect(generate).toHaveBeenCalledOnce();
  expect(generate.mock.calls[0]).toEqual(['fastpay',expect.any(Object),expect.objectContaining({learnedRules:['Actual saved hierarchy']})]);
  const task=(await sql<{client_id:string}>`SELECT client_id FROM hawa.tasks WHERE id=${result.task.id}::uuid`.execute(owner)).rows[0];
  expect(task.client_id).toBe(clientId);
  expect(await resolveClientDna(clientId,{tenantId,userId:SYSTEM_AUTOMATION_USER_ID,role:'operator',requireDatabase:true})).toBeDefined();
 });
 it('refuses cached DNA after read failure and retains the saved chat request without a preview',async()=>{
  const {service,generate}=intake(),request=input();
  await sql.raw('REVOKE SELECT ON hawa.client_dna_versions FROM hawa_app').execute(owner);
  try {
   await expect(resolveClientDna(clientId,{tenantId,userId:operator,role:'operator',requireDatabase:true})).rejects.toBeDefined();
   const result=await service.ingestChatCampaignTask(request);
   expect(generate).not.toHaveBeenCalled();expect(result.task.generatedOps).toEqual([]);
   expect((await sql`SELECT id FROM hawa.tasks WHERE id=${result.task.id}::uuid`.execute(owner)).rows).toHaveLength(1);
  } finally {await sql.raw('GRANT SELECT ON hawa.client_dna_versions TO hawa_app').execute(owner);}
 });
});
