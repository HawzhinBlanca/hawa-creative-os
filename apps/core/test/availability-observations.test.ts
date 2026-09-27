import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID, type AvailabilityObservation } from '@hawa/contracts';
import { createApp } from '../src/app.js';
import { availabilityConfig, probeOfficeReadiness, recordAvailabilityObservation, readAvailabilityReport } from '../src/services/availability-observations.js';
import { canonicalJson } from '../src/core-helpers.js';
const owner=createDb(process.env.TEST_DATABASE_OWNER_URL!),db=createDb(process.env.TEST_DATABASE_URL!);
const tenantId='00000000-0000-4000-a000-000000000001';
const secret=randomUUID()+randomUUID();
let monitorId:string;
beforeEach(()=>{
 monitorId=randomUUID();vi.stubEnv('HAWA_AVAILABILITY_MONITOR_ID',monitorId);vi.stubEnv('HAWA_AVAILABILITY_TARGET_ORIGIN','https://office.example.test');
 vi.stubEnv('HAWA_AVAILABILITY_MONITOR_SECRET',secret);vi.stubEnv('HAWA_AVAILABILITY_WORKER_URLS','http://worker-blue:9080/health,http://worker-green:9080/health');
 vi.stubEnv('RESTATE_ADMIN_URL','http://restate:9070');vi.stubEnv('RESTATE_INGRESS_URL','http://restate:8080');
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();});
afterAll(async()=>{await db.destroy();await owner.destroy();});
const config=()=>availabilityConfig()!;
function observation():AvailabilityObservation {
 const slot=Math.floor(Date.now()/60000)*60000-60000,good={outcome:'available',error:'none',httpStatus:200,durationMs:20} as const;
 return {schemaVersion:1,observationId:randomUUID(),monitorId,targetOrigin:config().targetOrigin,slotStart:new Date(slot).toISOString(),
  observedAt:new Date(slot+100).toISOString(),completedAt:new Date(slot+200).toISOString(),durationMs:100,probes:{desk:{...good},office:{...good}},buildCommit:null};
}
async function actor(){
 const userId=randomUUID(),token='hawa_sess_'+randomUUID().replaceAll('-','');
 await sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES(${userId}::uuid,${userId+'@example.test'},'Readiness fixture',${userId})`.execute(owner);
 await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'designer')`.execute(owner);
 await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
  VALUES(${createHash('sha256').update(token).digest('hex')},${tenantId}::uuid,${userId}::uuid,${'oidc:'+userId},'designer','Readiness fixture',now()+interval '1 hour','google_oidc')`.execute(owner);
 return {tenantId,userId,role:'designer',token};
}
const post=(app:ReturnType<typeof createApp>,v:AvailabilityObservation,credential=secret,extra:Record<string,string>={})=>app.request('/v1/monitoring/availability/observations',
 {method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json','Idempotency-Key':v.observationId,...extra},body:JSON.stringify(v)});
const worker={status:'healthy',outboxActive:true,background:'live',dependencies:{postgres:'connected'},outbox:{staleOver5m:0},tenantsWithoutAutomationMembership:[]};
const names=['TaskWorkflow','TaskService','ChatInbox','Delivery','TelegramSender','RequestLifecycle','DesignRun','OfficeDecisionGateway'];
function healthyFetch(){return vi.fn(async(input:Parameters<typeof fetch>[0])=>new Response(JSON.stringify(String(input).endsWith('/services')?{services:names.map(name=>({name}))}:worker),{headers:{'Content-Type':'application/json'}}));}
it('binds exact replay to one immutable database receipt and verifies both stored and transport hashes',async()=>{
 const v=observation(),c=config(),first=await recordAvailabilityObservation(db,tenantId,c,v);
 const replay=await recordAvailabilityObservation(db,tenantId,c,JSON.parse(JSON.stringify(v)));
 expect(replay).toEqual({...first,replayed:true});expect(first.observationSha256).toBe(createHash('sha256').update(canonicalJson(v)).digest('hex'));
 const row=(await sql<{valid:boolean}>`SELECT payload_sha256=encode(sha256(convert_to(payload::text,'UTF8')),'hex') AS valid FROM hawa.availability_observations WHERE id=${v.observationId}::uuid`.execute(owner)).rows[0];expect(row.valid).toBe(true);
 await expect(recordAvailabilityObservation(db,tenantId,c,{...v,durationMs:101})).rejects.toMatchObject({status:409});
 await expect(recordAvailabilityObservation(db,tenantId,c,{...v,observationId:randomUUID()})).rejects.toMatchObject({status:409});
 for(const statement of ['UPDATE hawa.availability_observations SET payload=payload','DELETE FROM hawa.availability_observations','TRUNCATE hawa.availability_observations'])
  await expect(sql.raw(statement).execute(owner)).rejects.toThrow('immutable');
});
it('serializes concurrent identical uploads and rejects competing identities for the same minute',async()=>{
 const v=observation(),c=config();const receipts=await Promise.all([recordAvailabilityObservation(db,tenantId,c,v),recordAvailabilityObservation(db,tenantId,c,v)]);
 expect(receipts.filter(r=>r.replayed)).toHaveLength(1);
 const changed={...v,observationId:randomUUID()};await expect(recordAvailabilityObservation(db,tenantId,c,changed)).rejects.toMatchObject({status:409});
});
it('keeps old data separate after a monitor or target change and rejects malformed clocks',async()=>{
 const v=observation(),c=config();await recordAvailabilityObservation(db,tenantId,c,v);const a=await actor();
 expect((await readAvailabilityReport(db,a,c)).availability.observationCount).toBe(1);
 vi.stubEnv('HAWA_AVAILABILITY_MONITOR_ID',randomUUID());expect((await readAvailabilityReport(db,a,config())).availability.observationCount).toBe(0);
 await expect(recordAvailabilityObservation(db,tenantId,config(),v)).rejects.toMatchObject({status:409});
 const future=observation(),slot=Math.floor((Date.now()+3600000)/60000)*60000;
 Object.assign(future,{slotStart:new Date(slot).toISOString(),observedAt:new Date(slot+100).toISOString(),completedAt:new Date(slot+200).toISOString()});
 await expect(recordAvailabilityObservation(db,tenantId,c,future)).rejects.toMatchObject({status:400});
});
it('uses Baghdad calendar boundaries, current active membership and unknown missing intervals',async()=>{
 const a=await actor(),c=config(),r=await readAvailabilityReport(db,a,c,'2026-08');
 expect(r.period).toMatchObject({startAt:'2026-07-31T21:00:00.000Z',endAt:'2026-08-31T21:00:00.000Z',complete:true});
 expect(r.availability).toMatchObject({elapsedSlots:44640,missingSlots:44640,observedPercent:null,sloCompliant:null});
 await expect(readAvailabilityReport(db,a,c,'2026-99')).rejects.toMatchObject({status:400});
 await expect(readAvailabilityReport(db,a,c,'2099-01')).rejects.toMatchObject({status:400});
 await sql`UPDATE hawa.tenant_memberships SET active=false WHERE user_id=${a.userId}::uuid`.execute(owner);
 await expect(readAvailabilityReport(db,a,c)).rejects.toMatchObject({status:403});
});
it('RLS refuses staff writes, foreign tenants and revoked membership reads',async()=>{
 const v=observation();await recordAvailabilityObservation(db,tenantId,config(),v);const a=await actor();
 const row=(await sql<Record<string,unknown>>`SELECT * FROM hawa.availability_observations WHERE id=${v.observationId}::uuid`.execute(owner)).rows[0];
 await expect(withRlsContext(db,a,tx=>sql`INSERT INTO hawa.availability_observations SELECT * FROM jsonb_populate_record(NULL::hawa.availability_observations,${JSON.stringify({...row,id:randomUUID()})}::jsonb)`.execute(tx))).rejects.toMatchObject({code:'42501'});
 await withRlsContext(db,{...a,tenantId:randomUUID()},async tx=>expect((await sql`SELECT * FROM hawa.availability_observations`.execute(tx)).rows).toEqual([]));
 await sql`UPDATE hawa.tenant_memberships SET active=false WHERE user_id=${a.userId}::uuid`.execute(owner);
 await withRlsContext(db,a,async tx=>expect((await sql`SELECT * FROM hawa.availability_observations`.execute(tx)).rows).toEqual([]));
});
it('requires a distinct monitor credential, body identity and bounded valid JSON; never grants office access',async()=>{
 const app=createApp({db}),v=observation(),a=await actor();
 for(const token of [a.token,'test_bearer','wrong'])expect((await post(app,v,token)).status).toBe(401);
 expect((await app.request('/v1/operations/slo',{headers:{Authorization:'Bearer '+secret}})).status).toBe(401);
 expect((await app.request('/v1/tasks',{headers:{Authorization:'Bearer '+secret}})).status).toBe(401);
 expect((await post(app,v,secret,{'Idempotency-Key':randomUUID()})).status).toBe(400);
 const huge=await app.request('/v1/monitoring/availability/observations',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:'x'.repeat(8193)});expect(huge.status).toBe(413);
 const first=await post(app,v);expect(first.status).toBe(201);expect(first.headers.get('Cache-Control')).toBe('no-store');
 expect((await post(createApp({db}),v)).status).toBe(200);
 const r=await app.request('/v1/operations/slo',{headers:{Authorization:'Bearer '+a.token}});expect(r.status).toBe(200);expect((await r.json()).availability.observationCount).toBe(1);
});
it('invalid and reused monitor credentials disable ingestion',()=>{
 for(const key of ['HAWA_BEARER_TOKEN','HAWA_WORKER_TOKEN','HAWA_DEV_TOKEN'])expect(availabilityConfig({...process.env,[key]:secret})).toBeNull();
 expect(availabilityConfig({...process.env,HAWA_AVAILABILITY_TARGET_ORIGIN:'http://public.example.test'})).toBeNull();
});
it('successful readiness uses the actual scoped storage path and always rolls its witness back',async()=>{
 const fetcher=healthyFetch(),r=await probeOfficeReadiness(db,tenantId,config(),process.env,fetcher);expect(r).toEqual({ready:true,intakeStorage:true,reviewStorage:true,workflowRegistration:true,activeWorker:true});
 expect((await sql`SELECT * FROM hawa.availability_probe_values`.execute(owner)).rows).toEqual([]);
 expect(fetcher.mock.calls).toHaveLength(3);
});
it('dead workers cannot be hidden by persistent workflow registration, and one live blue/green worker suffices',async()=>{
 const c=config();const dead=vi.fn(async(input:Parameters<typeof fetch>[0])=>String(input).endsWith('/services')?new Response(JSON.stringify({services:names.map(name=>({name}))})):new Response('down',{status:503}));
 expect(await probeOfficeReadiness(db,tenantId,c,process.env,dead)).toMatchObject({ready:false,workflowRegistration:true,activeWorker:false});
 const healthy=healthyFetch(),one=vi.fn(async(input:Parameters<typeof fetch>[0])=>String(input).includes('green')?new Response('down',{status:503}):healthy(input));
 expect((await probeOfficeReadiness(db,tenantId,c,process.env,one)).ready).toBe(true);
 const missing=vi.fn(async(input:Parameters<typeof fetch>[0])=>new Response(JSON.stringify(String(input).endsWith('/services')?{services:names.slice(0,-1).map(name=>({name}))}:worker)));
 expect(await probeOfficeReadiness(db,tenantId,c,process.env,missing)).toMatchObject({ready:false,workflowRegistration:false});
});
it('refuses storage failures and missing automation membership without retaining probe mutations',async()=>{
 expect((await probeOfficeReadiness(null,tenantId,config(),process.env,healthyFetch())).ready).toBe(false);
 await sql`UPDATE hawa.tenant_memberships SET active=false WHERE tenant_id=${tenantId}::uuid AND user_id=${SYSTEM_AUTOMATION_USER_ID}::uuid`.execute(owner);
 try{expect((await probeOfficeReadiness(db,tenantId,config(),process.env,healthyFetch())).ready).toBe(false);}
 finally{await sql`UPDATE hawa.tenant_memberships SET active=true WHERE tenant_id=${tenantId}::uuid AND user_id=${SYSTEM_AUTOMATION_USER_ID}::uuid`.execute(owner);}
 expect((await sql`SELECT * FROM hawa.availability_probe_values`.execute(owner)).rows).toEqual([]);
});
it('binds fresh readiness replies to the collector nonce and excludes office cookies',async()=>{
 vi.stubGlobal('fetch',healthyFetch());const app=createApp({db}),nonce=randomUUID();
 const request=(headers:Record<string,string>)=>app.request('/v1/monitoring/availability/probe',{headers});
 expect((await request({Cookie:'hawa_session=anything','X-Hawa-Probe-Nonce':nonce})).status).toBe(401);
 expect((await request({Authorization:'Bearer '+secret})).status).toBe(400);
 const r=await request({Authorization:'Bearer '+secret,'X-Hawa-Probe-Nonce':nonce});expect(r.status).toBe(200);
 expect(await r.json()).toMatchObject({nonce,monitorId,ready:true});expect(r.headers.get('Cache-Control')).toBe('no-store');
});

it('a failed probe update rolls back the inserted witness and reports storage unavailable',async()=>{
 await sql`CREATE FUNCTION hawa.test_probe_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic probe update refusal'; END $$`.execute(owner);
 await sql`CREATE TRIGGER test_probe_refusal BEFORE UPDATE ON hawa.availability_probe_values FOR EACH ROW EXECUTE FUNCTION hawa.test_probe_refusal()`.execute(owner);
 try{expect((await probeOfficeReadiness(db,tenantId,config(),process.env,healthyFetch())).intakeStorage).toBe(false);
  expect((await sql`SELECT * FROM hawa.availability_probe_values`.execute(owner)).rows).toEqual([]);}
 finally{await sql`DROP TRIGGER test_probe_refusal ON hawa.availability_probe_values`.execute(owner);await sql`DROP FUNCTION hawa.test_probe_refusal()`.execute(owner);}
});
it('configuration damage does not silently replace measured history with an unmeasured success response',async()=>{
 const a=await actor();vi.stubEnv('HAWA_AVAILABILITY_MONITOR_ID','broken');
 const response=await createApp({db}).request('/v1/operations/slo',{headers:{Authorization:'Bearer '+a.token}});
 expect(response.status).toBe(503);expect((await response.json()).title).toContain('Misconfigured');
});
