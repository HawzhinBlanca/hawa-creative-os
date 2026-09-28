import { afterAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID, parsePublicationInspectionState, type PublicationExternalObservation, type PublicationInspector } from '@hawa/contracts';
import { PublicationInspectionService, readPublicationInspections } from '../src/services/publication-inspections.js';
import { publishedReceiptTask } from './fixtures/published-receipt-task.js';
import { createApp } from '../src/app.js';

const db=createDb(process.env.TEST_DATABASE_URL!),owner=createDb(process.env.TEST_DATABASE_OWNER_URL!);
afterAll(async()=>{await db.destroy();await owner.destroy();});
const tenantId='00000000-0000-4000-a000-000000000001',automation={tenantId,userId:SYSTEM_AUTOMATION_USER_ID,role:'operator'};
const observation=():PublicationExternalObservation=>({schemaVersion:1,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),folder:null,files:[],
  duplicates:{status:'unavailable',fileIds:[],code:'GOOGLE_HTTP_403'},sheet:null});
const inspector:PublicationInspector={inspectPublication:async()=>observation()};
const service=()=>new PublicationInspectionService(db,inspector);
async function fixture(){
  const f=await publishedReceiptTask(db);
  const p=(await sql<{id:string}>`SELECT id FROM hawa.publications WHERE task_id=${f.taskId}::uuid ORDER BY created_at DESC,id DESC LIMIT 1`.execute(owner)).rows[0];
  return {...f,publicationId:p.id};
}

it('freezes a durable input and retains the independently unverified result across service instances',async()=>{
  const f=await fixture(),s=service(),claim=await s.claim(tenantId,f.publicationId);expect(claim).not.toBeNull();if(!claim)return;
  expect(claim.inputs.original?.taskId).toBe(f.taskId);expect(claim.inputs.files[0].fileId).toBeTruthy();
  expect((await sql<{valid:boolean}>`SELECT inputs_sha256=encode(sha256(convert_to(inputs::text,'UTF8')),'hex') AS valid FROM hawa.publication_inspections WHERE id=${claim.id}::uuid`.execute(owner)).rows[0].valid).toBe(true);
  expect(await new PublicationInspectionService(db,inspector).finish(claim,observation())).toBe(true);
  expect(await s.claim(tenantId,f.publicationId)).toBeNull();
  const view=await readPublicationInspections(db,automation,true),row=view.items.find(item=>item.publicationId===f.publicationId)!;
  expect(parsePublicationInspectionState(view)).not.toBeNull();expect(row).toMatchObject({state:'finished',status:'unverified',inspectionId:claim.id,stale:false});
  expect(row.findings.some(finding=>finding.code==='PERMISSIONS_BASELINE_UNAVAILABLE')).toBe(true);
  expect((await sql<{valid:boolean}>`SELECT result_sha256=encode(sha256(convert_to(jsonb_build_object('observation',observation,'report',report)::text,'UTF8')),'hex') AS valid
    FROM hawa.publication_inspections WHERE id=${claim.id}::uuid`.execute(owner)).rows[0].valid).toBe(true);
  expect(await s.finish(claim,observation())).toBe(false);
});

it('lets exactly one of two Core instances claim a publication without holding a network transaction',async()=>{
  const f=await fixture();const claims=await Promise.all([service().claim(tenantId,f.publicationId),service().claim(tenantId,f.publicationId)]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect((await sql`SELECT * FROM hawa.publication_inspections WHERE publication_id=${f.publicationId}::uuid`.execute(owner)).rows).toHaveLength(1);
  await service().finish(claims.find(Boolean)!,observation());
});

it('refuses changed snapshots, owner edits and removal of terminal evidence',async()=>{
  const f=await fixture(),s=service(),claim=(await s.claim(tenantId,f.publicationId))!;
  await expect(s.finish({...claim,inputs:{...claim.inputs,taskId:randomUUID()}},observation())).rejects.toThrow('PUBLICATION_INSPECTION_INPUT_CONFLICT');
  await s.finish(claim,observation());
  await expect(withRlsContext(owner,automation,tx=>sql`UPDATE hawa.publication_inspections SET report='{}'::jsonb WHERE id=${claim.id}::uuid`.execute(tx))).rejects.toThrow('PUBLICATION_INSPECTION_IMMUTABLE');
  await expect(sql`DELETE FROM hawa.publication_inspections WHERE id=${claim.id}::uuid`.execute(owner)).rejects.toThrow('cannot be removed');
  await expect(sql`TRUNCATE hawa.publication_inspections`.execute(owner)).rejects.toThrow('cannot be removed');
});

it('records a result for a changed current revision as superseded, without qualifying the newer design',async()=>{
  const f=await fixture(),s=service(),claim=(await s.claim(tenantId,f.publicationId))!;
  const response=await f.app.request(`/tasks/${f.taskId}/revisions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({document:{id:'new',pages:[{id:'p',name:'main',width:1080,height:1080,unit:'px'}],nodes:[{id:'copy',type:'text',text:'Changed copy'}]}})});
  expect(response.status).toBe(201);const revision=await response.json();
  await sql`UPDATE hawa.tasks SET current_design_revision_id=${revision.revisionId}::uuid WHERE id=${f.taskId}::uuid`.execute(owner);
  expect(await s.finish(claim,observation())).toBe(false);
  expect((await sql<{state:string}>`SELECT state FROM hawa.publication_inspections WHERE id=${claim.id}::uuid`.execute(owner)).rows[0].state).toBe('superseded');
  expect((await readPublicationInspections(db,automation,true)).items.some(item=>item.publicationId===f.publicationId)).toBe(false);
});

it('applies current client membership to the endpoint and immutable history',async()=>{
  const f=await fixture(),s=service(),claim=(await s.claim(tenantId,f.publicationId))!;await s.finish(claim,observation());
  const userId=randomUUID();
  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${userId}::uuid,${userId+'@example.test'},'Inspection reader')`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'designer')`.execute(owner);
  await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES(${tenantId}::uuid,${f.clientId}::uuid,${userId}::uuid,'designer')`.execute(owner);
  const actor={tenantId,userId,role:'designer'},app=createApp({db,testAuth:{principal:{role:'designer',userId}}});
  const first=await app.request('/v1/operations/publication-inspections');expect(first.status).toBe(200);expect(first.headers.get('Cache-Control')).toBe('no-store');
  expect(parsePublicationInspectionState(await first.json())?.items.some(item=>item.publicationId===f.publicationId)).toBe(true);
  expect((await withRlsContext(db,{...actor,tenantId:randomUUID()},tx=>sql`SELECT * FROM hawa.publication_inspections WHERE id=${claim.id}::uuid`.execute(tx))).rows).toHaveLength(0);
  await sql`UPDATE hawa.client_memberships SET active=false WHERE tenant_id=${tenantId}::uuid AND user_id=${userId}::uuid`.execute(owner);
  expect((await readPublicationInspections(db,actor,true)).items).toHaveLength(0);
  expect((await withRlsContext(db,actor,tx=>sql`SELECT * FROM hawa.publication_inspections WHERE id=${claim.id}::uuid`.execute(tx))).rows).toHaveLength(0);
});

it('records provider failure as uncertainty without retaining its raw error or modifying publication completion',async()=>{
  const f=await fixture(),read=vi.fn(async()=>{throw new Error('provider credential details must not be retained');});
  await new PublicationInspectionService(db,{inspectPublication:read}).runPass(tenantId,10);
  const row=(await readPublicationInspections(db,automation,true)).items.find(item=>item.publicationId===f.publicationId)!;
  expect(read).toHaveBeenCalled();expect(row.status).toBe('unverified');expect(JSON.stringify(row)).not.toContain('credential details');
  expect((await sql<{state:string}>`SELECT state FROM hawa.publications WHERE id=${f.publicationId}::uuid`.execute(owner)).rows[0].state).toBe('complete');
});

it('flags historical publications without making provider calls or inventing original inputs',async()=>{
  const f=await fixture(),id=randomUUID();
  await sql`INSERT INTO hawa.publications(id,tenant_id,task_id,design_revision_id,approval_id,publication_key,package_manifest,package_sha256,state,input_protocol)
    SELECT ${id}::uuid,tenant_id,task_id,design_revision_id,approval_id,${'legacy-'+id},package_manifest,package_sha256,'complete',0 FROM hawa.publications WHERE id=${f.publicationId}::uuid`.execute(owner);
  const read=vi.fn(inspector.inspectPublication),s=new PublicationInspectionService(db,{inspectPublication:read});
  await s.runPass(tenantId,10);expect(read).not.toHaveBeenCalled();
  const row=(await readPublicationInspections(db,automation,true)).items.find(item=>item.publicationId===id)!;
  expect(row.status).toBe('unverified');expect(row.findings.map(f=>f.code)).toEqual(['ORIGINAL_INPUT_UNAVAILABLE']);
});

it.runIf(process.env.HAWA_INSPECTION_CRASH_DRILL==='1')('recovers a committed claim after actual process death and refuses its late result',async()=>{
  const f=await fixture();
  const child=fork(fileURLToPath(new URL('./fixtures/publication-inspection-child.ts',import.meta.url)),[],{
    execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc'],
    env:{...process.env,INSPECTION_TENANT_ID:tenantId,INSPECTION_PUBLICATION_ID:f.publicationId},
  });
  type Claim=NonNullable<Awaited<ReturnType<PublicationInspectionService['claim']>>>;
  try {
    const claim=await new Promise<Claim>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Child claim timed out')),15_000);
      child.once('message',message=>{clearTimeout(timer);resolve(message as Claim);});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Child exited before claim: ${code}`));});
    });
    const exited=new Promise<string|null>(resolve=>child.once('exit',(_code,signal)=>resolve(signal)));
    child.kill('SIGKILL');expect(await exited).toBe('SIGKILL');
    expect(await service().claim(tenantId,f.publicationId)).toBeNull();
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,new Date(claim.lease_until).getTime()-Date.now()+150)));
    const fresh=service(),retry=await fresh.claim(tenantId,f.publicationId);expect(retry).not.toBeNull();expect(retry!.id).not.toBe(claim.id);
    expect((await sql<{state:string}>`SELECT state FROM hawa.publication_inspections WHERE id=${claim.id}::uuid`.execute(owner)).rows[0].state).toBe('interrupted');
    expect(await fresh.finish(claim,observation())).toBe(false);expect(await fresh.finish(retry!,observation())).toBe(true);
  } finally {if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');}
},145_000);
