import {ReceiptAuditService} from '../src/services/receipt-audits.js';
import {afterAll,expect,it} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {createDb,sql,withRlsContext} from '@hawa/db';
import {createApp} from '../src/app.js';
const owner=createDb(process.env.TEST_DATABASE_OWNER_URL!),db=createDb(process.env.TEST_DATABASE_URL!);
afterAll(async()=>{await db.destroy();await owner.destroy();});
async function fixture(foreign=false){
 const tenantId=foreign?randomUUID():'00000000-0000-4000-a000-000000000001';
 await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Audit fixture',${tenantId}) ON CONFLICT DO NOTHING`.execute(owner);
 const makeUser=async()=>{
  const userId=randomUUID(),clientId=randomUUID(),taskId=randomUUID(),token=`hawa_sess_${randomUUID().replaceAll('-','')}`;
  await sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES(${userId}::uuid,${userId+'@example.test'},'Synthetic audit reader',${userId})`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'designer')`.execute(owner);
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Synthetic client')`.execute(owner);
  await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES(${tenantId}::uuid,${clientId}::uuid,${userId}::uuid,'designer')`.execute(owner);
  await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title,state) VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Synthetic missing receipts','complete')`.execute(owner);
  await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
   VALUES(${createHash('sha256').update(token).digest('hex')},${tenantId}::uuid,${userId}::uuid,${'oidc:'+userId},'designer','Synthetic audit reader',now()+interval '1 hour','google_oidc')`.execute(owner);
  return {userId,clientId,taskId,token};
 };
 return {tenantId,a:await makeUser(),b:await makeUser()};
}
const get=(app:ReturnType<typeof createApp>,token:string)=>app.request('/v1/operations/reconciliation',{headers:{Authorization:`Bearer ${token}`}});
const latest=(body:any)=>body&&'latest' in body?body.latest:body;
async function run(app:ReturnType<typeof createApp>,token:string,actionId=randomUUID()){
 const state=await(await get(app,token)).json();
 return app.request('/v1/operations/reconciliation/run',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':actionId},
  body:JSON.stringify({actionId,expectedScopeSha256:state?.scope?.sha256??'0'.repeat(64),expectedLatestAuditId:state?.latest?.auditId??null,reason:'Inspect synthetic publication receipts'})});
}
it("never returns another user's client audit through the shared Core process",async()=>{
 const f=await fixture(),g=await fixture(true),app=createApp({db});
 const r=await run(app,f.a.token);expect(r.status).toBe(201);const report=latest(await r.json());
 expect(report.anomalies.some((a:any)=>a.taskId===f.a.taskId)).toBe(true);
 expect(JSON.stringify(report)).not.toContain(f.b.taskId);
 expect(latest(await(await get(app,f.b.token)).json())).toBeNull();
 expect((await get(app,g.a.token)).status).toBe(401);
});
it('keeps a completed audit when a fresh Core instance reads PostgreSQL',async()=>{
 const f=await fixture(),r=await run(createApp({db}),f.a.token);expect(r.status).toBe(201);const report=latest(await r.json());
 const read=await get(createApp({db}),f.a.token);expect(read.status).toBe(200);expect(latest(await read.json())?.auditId).toBe(report.auditId);
});
it('hides an old audit immediately when the actor loses one of its recorded clients',async()=>{
 const f=await fixture(),app=createApp({db});expect((await run(app,f.a.token)).status).toBe(201);
 await sql`UPDATE hawa.client_memberships SET active=false WHERE tenant_id=${f.tenantId}::uuid AND user_id=${f.a.userId}::uuid`.execute(owner);
 const r=await get(app,f.a.token);expect(r.status).toBe(200);expect(latest(await r.json())).toBeNull();
});
it('requires the browser action identity in the transport header before recording anything',async()=>{
 const f=await fixture(),app=createApp({db}),state=await(await get(app,f.a.token)).json(),actionId=randomUUID();
 const body={actionId,expectedScopeSha256:state.scope.sha256,expectedLatestAuditId:null,reason:'Inspect header binding'};
 for(const key of [undefined,randomUUID()]){
  const headers:Record<string,string>={Authorization:`Bearer ${f.a.token}`,'Content-Type':'application/json'};
  if(key)headers['Idempotency-Key']=key;
  const r=await app.request('/v1/operations/reconciliation/run',{method:'POST',headers,body:JSON.stringify(body)});
  expect(r.status).toBe(400);expect(r.headers.get('Cache-Control')).toBe('no-store');
 }
 expect(latest(await(await get(app,f.a.token)).json())).toBeNull();
 const r=await run(app,f.a.token,actionId);expect(r.status).toBe(201);expect(r.headers.get('Cache-Control')).toBe('no-store');
});

const actor=(f:Awaited<ReturnType<typeof fixture>>,who=f.a)=>({tenantId:f.tenantId,userId:who.userId,role:'designer'});
const action=async(service:ReceiptAuditService,s:ReturnType<typeof actor>,reason='Inspect receipt history')=>{
 const state=await service.get(s);return {actionId:randomUUID(),expectedScopeSha256:state.scope.sha256,expectedLatestAuditId:state.latest?.auditId??null,reason};
};
it('replays the exact original result after a lost reply and a later audit, with one immutable identity',async()=>{
 const f=await fixture(),s=actor(f),service=new ReceiptAuditService(db),body=await action(service,s);
 const first=await service.record(s,body);await service.record(s,await action(service,s,'Later audit'));
 expect(await new ReceiptAuditService(db).record(s,body)).toEqual({...first,replayed:true});
 await expect(service.record(s,{...body,reason:'Different request'})).rejects.toMatchObject({code:'RECEIPT_AUDIT_ACTION_CONFLICT'});
 const integrity=(await sql<{ok:boolean}>`SELECT inputs_sha256=encode(sha256(convert_to(inputs::text,'UTF8')),'hex') AND report_sha256=encode(sha256(convert_to(report::text,'UTF8')),'hex') AS ok FROM hawa.receipt_audits WHERE id=${first.auditId}::uuid`.execute(owner)).rows[0];expect(integrity.ok).toBe(true);
 expect(first.inputsSha256).toMatch(/^[a-f0-9]{64}$/);expect(first.reportSha256).toMatch(/^[a-f0-9]{64}$/);
 for(const statement of ['UPDATE hawa.receipt_audits SET reason=reason','DELETE FROM hawa.receipt_audits','TRUNCATE hawa.receipt_audits'])
  await expect(sql.raw(statement).execute(owner)).rejects.toThrow('immutable');
});
it('serializes duplicate actions and refuses a competing stale predecessor',async()=>{
 const f=await fixture(),s=actor(f),service=new ReceiptAuditService(db),body=await action(service,s);
 const duplicate=await Promise.all([service.record(s,body),service.record(s,body)]);
 expect(duplicate.filter(r=>r.replayed)).toHaveLength(1);expect((await service.get(s)).history).toHaveLength(1);
 const next=await action(service,s),competing=await Promise.allSettled([service.record(s,next),service.record(s,{...next,actionId:randomUUID()})]);
 expect(competing.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(competing.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'RECEIPT_AUDIT_CHANGED'}});
 expect((await service.get(s)).history).toHaveLength(2);
});
it('RLS rechecks current scope and identity for reads and actor-spoofed writes',async()=>{
 const f=await fixture(),s=actor(f),service=new ReceiptAuditService(db),body=await action(service,s);
 await service.record(s,body);
 const raw=(await sql<Record<string,unknown>>`SELECT * FROM hawa.receipt_audits WHERE id=${body.actionId}::uuid`.execute(owner)).rows[0];
 await withRlsContext(db,actor(f,f.b),async tx=>{
  expect((await sql`SELECT * FROM hawa.receipt_audits WHERE id=${body.actionId}::uuid`.execute(tx)).rows).toEqual([]);
 });
 await expect(withRlsContext(db,actor(f,f.b),tx=>sql`INSERT INTO hawa.receipt_audits SELECT * FROM jsonb_populate_record(NULL::hawa.receipt_audits,${JSON.stringify({...raw,id:randomUUID()})}::jsonb)`.execute(tx))).rejects.toMatchObject({code:'42501'});
 await sql`UPDATE hawa.client_memberships SET active=false WHERE tenant_id=${f.tenantId}::uuid AND user_id=${f.a.userId}::uuid`.execute(owner);
 await withRlsContext(db,s,async tx=>expect((await sql`SELECT * FROM hawa.receipt_audits`.execute(tx)).rows).toEqual([]));
 expect((await service.get(s)).latest).toBeNull();
 await expect(service.record(s,body)).rejects.toMatchObject({code:'RECEIPT_AUDIT_SCOPE_CHANGED'});
 await sql`UPDATE hawa.tenant_memberships SET active=false WHERE tenant_id=${f.tenantId}::uuid AND user_id=${f.a.userId}::uuid`.execute(owner);
 await expect(service.get(s)).rejects.toMatchObject({status:403});
});
it('returns bounded history and does not reuse a report after newly granted client access',async()=>{
 const f=await fixture(),s=actor(f),service=new ReceiptAuditService(db);
 for(let i=0;i<22;i++)await service.record(s,await action(service,s,`Review ${i+1}`));
 const page=await service.get(s);expect(page.history).toHaveLength(20);expect(page.nextBeforeRevision).toBe(3);
 const older=await service.get(s,String(page.nextBeforeRevision));expect(older.history.map(r=>r.revision)).toEqual([2,1]);expect(older.latest?.revision).toBe(22);
 await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES(${f.tenantId}::uuid,${f.b.clientId}::uuid,${f.a.userId}::uuid,'designer')`.execute(owner);
 expect((await service.get(s)).latest).toBeNull();
 const result=await service.record(s,await action(service,s));expect(result.revision).toBe(1);expect(result.totalTasksAudited).toBe(2);
});
it('a failed report insert never replaces the last committed result',async()=>{
 const f=await fixture(),s=actor(f),service=new ReceiptAuditService(db),first=await service.record(s,await action(service,s));
 await sql`CREATE FUNCTION hawa.test_refuse_receipt_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic receipt write refused'; END $$`.execute(owner);
 await sql`CREATE TRIGGER test_refuse_receipt_audit BEFORE INSERT ON hawa.receipt_audits FOR EACH ROW WHEN (NEW.reason='Synthetic rollback') EXECUTE FUNCTION hawa.test_refuse_receipt_audit()`.execute(owner);
 try{await expect(service.record(s,await action(service,s,'Synthetic rollback'))).rejects.toThrow('Synthetic receipt write refused');}
 finally{await sql`DROP TRIGGER test_refuse_receipt_audit ON hawa.receipt_audits`.execute(owner);await sql`DROP FUNCTION hawa.test_refuse_receipt_audit()`.execute(owner);}
 expect((await new ReceiptAuditService(db).get(s)).latest?.auditId).toBe(first.auditId);
});

it('reads task and receipt facts from the same snapshot despite an intervening committed change',async()=>{
 const {publishedReceiptTask}=await import('./fixtures/published-receipt-task.js');
 const pub=await publishedReceiptTask(db),f=await fixture(),s=actor(f);
 await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES(${f.tenantId}::uuid,${pub.clientId}::uuid,${f.a.userId}::uuid,'designer')`.execute(owner);
 let intervened=false;const paused=new Set<object>();
 const plugin:Parameters<typeof db.withPlugin>[0]={
  transformQuery(args){if(args.node.kind==='RawNode'&&args.node.sqlFragments.join('').includes('FROM hawa.tasks t LEFT JOIN LATERAL'))paused.add(args.queryId);return args.node;},
  async transformResult(args){
   if(paused.delete(args.queryId)&&!intervened){
    intervened=true;
    await owner.transaction().execute(async tx=>{
     await sql`UPDATE hawa.tasks SET state='publishing' WHERE id=${pub.taskId}::uuid`.execute(tx);
     await sql`UPDATE hawa.drive_refs SET status='missing' WHERE publication_id IN(SELECT id FROM hawa.publications WHERE task_id=${pub.taskId}::uuid)`.execute(tx);
    });
   }
   return args.result;
  },
 };
 const service=new ReceiptAuditService(db.withPlugin(plugin)),report=await service.record(s,await action(service,s));
 expect(intervened).toBe(true);expect(report.anomalies.filter(a=>a.taskId===pub.taskId)).toEqual([]);
 const stored=(await sql<{inputs:{tasks:Array<{id:string;status:string}>;driveFiles:Array<{taskId:string}>}}>`SELECT inputs FROM hawa.receipt_audits WHERE id=${report.auditId}::uuid`.execute(owner)).rows[0].inputs;
 const task=stored.tasks.find(t=>t.id===pub.taskId)!;
 // Serializable retry may choose the newer snapshot; either coherent state is valid.
 if(task.status==='COMPLETE')expect(stored.driveFiles.some(r=>r.taskId===pub.taskId)).toBe(true);
 else {expect(task.status).toBe('PUBLISHING');expect(stored.driveFiles.some(r=>r.taskId===pub.taskId)).toBe(false);}
});
it('old-revision receipts and partial manifests cannot qualify the current completed design',async()=>{
 const {publishedReceiptTask}=await import('./fixtures/published-receipt-task.js');
 const pub=await publishedReceiptTask(db),f=await fixture(),s=actor(f),service=new ReceiptAuditService(db);
 await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES(${f.tenantId}::uuid,${pub.clientId}::uuid,${f.a.userId}::uuid,'designer')`.execute(owner);
 let report=await service.record(s,await action(service,s));expect(report.anomalies.filter(a=>a.taskId===pub.taskId)).toEqual([]);
 await sql`UPDATE hawa.drive_refs SET expected_sha256=repeat('0',64) WHERE publication_id IN(SELECT id FROM hawa.publications WHERE task_id=${pub.taskId}::uuid)`.execute(owner);
 report=await service.record(s,await action(service,s));expect(report.anomalies).toContainEqual(expect.objectContaining({taskId:pub.taskId,kind:'CHECKSUM_MISMATCH'}));
 const result=await pub.app.request(`/tasks/${pub.taskId}/revisions`,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({document:{id:'new-revision',pages:[{id:'p',name:'main',width:1080,height:1080,unit:'px'}],nodes:[{id:'copy',type:'text',text:'New copy'}]}})});
 expect(result.status).toBe(201);const newer=await result.json();
 await sql`UPDATE hawa.tasks SET current_design_revision_id=${newer.revisionId}::uuid,state='complete' WHERE id=${pub.taskId}::uuid`.execute(owner);
 report=await service.record(s,await action(service,s));
 expect(report.anomalies).toContainEqual(expect.objectContaining({taskId:pub.taskId,kind:'MISSING_DRIVE_ASSET'}));
 expect(report.anomalies).toContainEqual(expect.objectContaining({taskId:pub.taskId,kind:'MISSING_SHEET_ROW'}));
});
