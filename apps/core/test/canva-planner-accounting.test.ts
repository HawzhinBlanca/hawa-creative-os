import {afterAll,expect,it} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {createDb,sql,withRlsContext,assertStudioCallsResolved} from '@hawa/db';
import {reserveStudioText} from '@hawa/creative';
import {upgradeCanvaSchema} from '../../../packages/db/src/upgrade.js';
import {CallCostAccountingService} from '../src/services/call-cost-accounting.js';
const owner=createDb(process.env.TEST_DATABASE_OWNER_URL!),db=createDb(process.env.TEST_DATABASE_URL!);
afterAll(async()=>{await db.destroy();await owner.destroy();});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const model='gpt-4.1-mini',body=JSON.stringify({model,messages:[{role:'user',content:'synthetic planner'}],response_format:{type:'text'},service_tier:'default',max_completion_tokens:4000});
const reservation=reserveStudioText(body);
async function fixture(cap=20){
 const tenantId=randomUUID(),userId=randomUUID(),clientId=randomUUID(),taskId=randomUUID();
 const scope={tenantId,userId,role:'administrator',sessionHash:hash(randomUUID())};
 await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Planner fixture',${tenantId})`.execute(owner);
 await sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES(${userId}::uuid,${userId+'@example.test'},'Planner administrator',${userId})`.execute(owner);
 await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'administrator')`.execute(owner);
 await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Planner fixture')`.execute(owner);
 await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Planner fixture')`.execute(owner);
 await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
   VALUES(${scope.sessionHash},${tenantId}::uuid,${userId}::uuid,'oidc:planner','administrator','Planner administrator',now()+interval '1 hour','google_oidc')`.execute(owner);
 await sql`INSERT INTO hawa.studio_spending_policies(tenant_id,version,reason,limits)
   SELECT ${tenantId}::uuid,coalesce(max(version),0)+1,'Synthetic planner limits',${JSON.stringify({officeUsd:cap,clientUsd:cap,roleUsd:cap,clients:{},roles:{}})}::jsonb
   FROM hawa.studio_spending_policies WHERE tenant_id=${tenantId}::uuid`.execute(owner);
 const tx=<T>(fn:Parameters<typeof withRlsContext<T>>[2])=>withRlsContext(db,scope,fn);
 const plan=async(legacy=false)=>{const id=randomUUID();await tx(q=>sql`INSERT INTO hawa.canva_design_plans
   (id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,request,status,paid_protocol)
   VALUES(${id}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,${userId},${id},${hash(id)},${JSON.stringify({model})}::jsonb,'failed',${legacy?null:'canva-planner-v1'})`.execute(q));
   // Test fixture needs the initial pending state; completed plan evidence is never mutated.
   return id;};
 const pending=async()=>{const id=randomUUID();await tx(q=>sql`INSERT INTO hawa.canva_design_plans
   (id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,request,status,paid_protocol)
   VALUES(${id}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,${userId},${id},${hash(id)},${JSON.stringify({model})}::jsonb,'planning','canva-planner-v1')`.execute(q));return id;};
 const admit=(id:string)=>tx(q=>sql`INSERT INTO hawa.canva_planner_calls(id,tenant_id,task_id,client_id,model,reservation,metadata,spending_policy_version)
   VALUES(${id}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,${model},${JSON.stringify(reservation)}::jsonb,'{}',1)`.execute(q));
 const retire=(id:string)=>tx(q=>sql`UPDATE hawa.canva_design_plans SET status='abandoned' WHERE id=${id}::uuid`.execute(q));
 const daily=async()=> (await tx(q=>sql<{daily:{scopes:Array<{scope:string;remainingUsd:number;heldUsd:number;spentUsd:number;historyIncomplete:boolean}>}}>`SELECT hawa.office_scope_budget() AS daily`.execute(q))).rows[0].daily.scopes.find(s=>s.scope==='office')!;
 const accounting=new CallCostAccountingService(db);
 const attest=async(id:string,cost:number)=>accounting.record(scope,'canva_planner',id,randomUUID(),{
   expectedSnapshot:(await accounting.get(scope,'canva_planner',id)).snapshotHash,reason:'Synthetic terminal provider evidence',
   calls:[{callId:id,conclusion:'provider_finished',reportedCostUsd:cost,evidenceReference:'synthetic-provider-proof',evidenceSha256:hash('synthetic')}],
 });
 return {tenantId,userId,taskId,scope,tx,plan,pending,admit,retire,daily,accounting,attest};
}
it('zero allowance refuses before a paid attempt exists',async()=>{
 const f=await fixture(0),id=await f.pending();await expect(f.admit(id)).rejects.toThrow('OFFICE_BUDGET_EXHAUSTED');
 expect((await f.tx(q=>sql`SELECT id FROM hawa.canva_planner_calls WHERE tenant_id=${f.tenantId}::uuid`.execute(q))).rows).toHaveLength(0);
});
it('serializes concurrent office admissions across tasks using the shared allowance',async()=>{
 const f=await fixture(reservation.usd),id=await f.pending();
 const otherTask=randomUUID(),otherId=randomUUID();
 await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) SELECT ${otherTask}::uuid,tenant_id,client_id,'Other planner' FROM hawa.tasks WHERE id=${f.taskId}::uuid`.execute(owner);
 await f.tx(q=>sql`INSERT INTO hawa.canva_design_plans(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,request,status,paid_protocol)
   SELECT ${otherId}::uuid,tenant_id,${otherTask}::uuid,client_id,actor_id,${otherId},request_hash,request,'planning',paid_protocol FROM hawa.canva_design_plans WHERE id=${id}::uuid`.execute(q));
 const second=f.tx(q=>sql`INSERT INTO hawa.canva_planner_calls(id,tenant_id,task_id,client_id,model,reservation,metadata,spending_policy_version)
   SELECT id,tenant_id,task_id,client_id,${model},${JSON.stringify(reservation)}::jsonb,'{}',1 FROM hawa.canva_design_plans WHERE id=${otherId}::uuid`.execute(q));
 const results=await Promise.allSettled([f.admit(id),second]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(await f.daily()).toMatchObject({heldUsd:reservation.usd,remainingUsd:0,spentUsd:0,historyIncomplete:false});
});
it('retirement and a fresh Studio run cannot clear a planner obligation; terminal evidence preserves its row',async()=>{
 const f=await fixture(),id=await f.pending();await f.admit(id);await f.retire(id);
 await expect(f.tx(q=>assertStudioCallsResolved(q,f.tenantId,f.taskId))).rejects.toMatchObject({code:'MODEL_CALL_UNCERTAIN'});
 const before=(await f.tx(q=>sql<{record:unknown}>`SELECT to_jsonb(c) AS record FROM hawa.canva_planner_calls c WHERE id=${id}::uuid`.execute(q))).rows[0];
 await f.attest(id,0.005);
 expect(await f.daily()).toMatchObject({heldUsd:0,spentUsd:0.005});
 await expect(f.tx(q=>assertStudioCallsResolved(q,f.tenantId,f.taskId))).resolves.toBeUndefined();
 expect((await f.tx(q=>sql<{record:unknown}>`SELECT to_jsonb(c) AS record FROM hawa.canva_planner_calls c WHERE id=${id}::uuid`.execute(q))).rows[0]).toEqual(before);
});
it('old plans remain incomplete history until named terminal cost evidence is recorded',async()=>{
 const f=await fixture(),id=await f.plan(true);expect(await f.daily()).toMatchObject({historyIncomplete:true});
 expect(await f.accounting.get(f.scope,'canva_planner',id)).toMatchObject({status:'history_incomplete',originalCostUsd:null,reservedUsd:null,requiresCostEvidence:true});
 const next=await f.pending();await expect(f.admit(next)).rejects.toThrow('OFFICE_BUDGET_HISTORY_INCOMPLETE');
 await f.attest(id,0.01);await expect(f.admit(next)).resolves.toBeDefined();expect(await f.daily()).toMatchObject({historyIncomplete:false,spentUsd:0.01});
});
it('one original outcome is immutable and cross-office accounting cannot read it',async()=>{
 const f=await fixture(),foreign=await fixture(),id=await f.pending();await f.admit(id);
 await f.tx(q=>sql`UPDATE hawa.canva_planner_calls SET status='completed',acceptance='not_accepted',cost_basis='not_accepted',cost_usd=0,
   reconciliation_required=false,diagnostic='MODEL_HTTP_401',latency_ms=10 WHERE id=${id}::uuid`.execute(q));
 await expect(f.tx(q=>sql`UPDATE hawa.canva_planner_calls SET cost_usd=2 WHERE id=${id}::uuid`.execute(q))).rejects.toThrow('immutable');
 await expect(foreign.accounting.get(foreign.scope,'canva_planner',id)).rejects.toMatchObject({status:404});
 expect(await f.daily()).toMatchObject({heldUsd:0,spentUsd:0});
 await expect(f.tx(q=>sql`UPDATE hawa.canva_design_plans SET paid_protocol=NULL WHERE id=${id}::uuid`.execute(q))).rejects.toThrow('immutable');
});

it('upgrades actual pre-ledger Studio artifacts without inventing or duplicating planner calls',async()=>{
 const name='hawa_t_canva_upgrade_'+randomUUID().replaceAll('-',''),ownerUrl=new URL(process.env.TEST_DATABASE_OWNER_URL!);
 ownerUrl.pathname='/postgres';const server=createDb(ownerUrl.toString(),{max:1});
 ownerUrl.pathname='/'+name;let fresh:ReturnType<typeof createDb>|undefined;
 try{
  await sql`CREATE DATABASE ${sql.id(name)} TEMPLATE template0 ENCODING 'UTF8'`.execute(server);
  fresh=createDb(ownerUrl.toString(),{max:1});
  const root=fileURLToPath(new URL('../../../',import.meta.url));
  for(const file of ['db/schema.sql','db/rls.sql','db/seed.sql'])await sql.raw(readFileSync(root+file,'utf8')).execute(fresh);
  const dir=root+'packages/db/migrations/';
  await sql`CREATE TABLE hawa.schema_upgrades(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`.execute(fresh);
  for(const file of readdirSync(dir).filter(f=>/^\d{3}_.*\.sql$/.test(f)&&!f.endsWith('_down.sql')&&f<'056_').sort()){
   const source=readFileSync(dir+file,'utf8');await sql.raw(source).execute(fresh);
   await sql`INSERT INTO hawa.schema_upgrades(name,sha256) VALUES(${file},${hash(source)})`.execute(fresh);
  }
  const tenant=randomUUID(),client=randomUUID(),task=randomUUID(),run=randomUUID(),plan=randomUUID(),legacy=randomUUID(),bytes=Buffer.from('synthetic saved transfer'),requestHash=hash('frozen request');
  await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenant}::uuid,'Migration fixture',${tenant})`.execute(fresh);
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${client}::uuid,${tenant}::uuid,${client},'Migration fixture')`.execute(fresh);
  await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${task}::uuid,${tenant}::uuid,${client}::uuid,'Historical transfer')`.execute(fresh);
  await sql`INSERT INTO hawa.design_studio_runs(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,request,tier,status)
   VALUES(${run}::uuid,${tenant}::uuid,${task}::uuid,${client}::uuid,'synthetic-actor',${run},${requestHash},'{}','standard','transferred')`.execute(fresh);
  await sql`INSERT INTO hawa.canva_design_plans(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,request,status,result,source_content,source_sha256)
   VALUES(${plan}::uuid,${tenant}::uuid,${task}::uuid,${client}::uuid,'synthetic-actor',${plan},${requestHash},'{}','planned',
     ${JSON.stringify({receipt:{source:'design_studio_v2',runId:run}})}::jsonb,${bytes},${createHash('sha256').update(bytes).digest('hex')})`.execute(fresh);
  await sql`INSERT INTO hawa.canva_design_plans(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,request,status)
   VALUES(${legacy}::uuid,${tenant}::uuid,${task}::uuid,${client}::uuid,'synthetic-actor',${legacy},${requestHash},'{}','failed')`.execute(fresh);
  const before=(await sql<{result:unknown;source_content:Buffer;source_sha256:string}>`SELECT result,source_content,source_sha256 FROM hawa.canva_design_plans WHERE id=${plan}::uuid`.execute(fresh)).rows[0];
  expect((await upgradeCanvaSchema(ownerUrl.toString())).applied).toEqual(['056_durable_canva_planner_calls.sql','057_scoped_receipt_audits.sql','058_availability_observations.sql']);
  expect((await sql<{paid_protocol:string;studio_run_id:string}>`SELECT paid_protocol,studio_run_id FROM hawa.canva_design_plans WHERE id=${plan}::uuid`.execute(fresh)).rows[0])
   .toEqual({paid_protocol:'studio-transfer-v1',studio_run_id:run});
  expect((await sql`SELECT result,source_content,source_sha256 FROM hawa.canva_design_plans WHERE id=${plan}::uuid`.execute(fresh)).rows[0]).toEqual(before);
  expect((await sql<{paid_protocol:null}>`SELECT paid_protocol FROM hawa.canva_design_plans WHERE id=${legacy}::uuid`.execute(fresh)).rows[0].paid_protocol).toBeNull();
  expect((await sql`SELECT id FROM hawa.canva_planner_calls`.execute(fresh)).rows).toHaveLength(0);
  expect((await sql`SELECT id FROM hawa.receipt_audits`.execute(fresh)).rows).toHaveLength(0);
  expect((await sql`SELECT id FROM hawa.availability_observations`.execute(fresh)).rows).toHaveLength(0);
  expect((await sql`SELECT id FROM hawa.availability_probe_values`.execute(fresh)).rows).toHaveLength(0);
  await expect(sql`UPDATE hawa.canva_design_plans SET studio_run_id=NULL,paid_protocol=NULL WHERE id=${plan}::uuid`.execute(fresh)).rejects.toThrow('immutable');
 }finally{await fresh?.destroy();await sql`DROP DATABASE IF EXISTS ${sql.id(name)} WITH (FORCE)`.execute(server);await server.destroy();}
},30000);
