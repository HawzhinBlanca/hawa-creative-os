import { assert, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { encodeEditableTransfer } from '@hawa/creative';
import { createSyntheticValidPng } from '../../../packages/integrations/src/canva-capture-pipeline.js';
import { checkedCanvaExportFixture } from '../../../packages/testkit/src/canva-export-fixture.js';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { computeDnaHash, evaluateCanvaExportQc } from '../src/core-helpers.js';
import { recordManualCanvaReview } from '../src/services/manual-canva-review.js';
import { createApp } from '../src/app.js';

const url=process.env.HAWA_ISOLATED_TEST_DB;
describe.skipIf(!url)('blank Canva checked export with frozen client policy',()=>{
  const db=createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId='00000000-0000-4000-a000-000000000001', actorId='00000000-0000-4000-b000-000000000001';
  const scope={tenantId,actorId,role:'operator'};
  let clientId:string,taskId:string,designId:string,service:CanvaConnectService,pptx:Buffer;
  let exportCalls:number,designVersion:number,jobStatus:string,requests:Map<string,string>;
  let dna:Record<string,unknown>;
  const remote:typeof fetch=async(input,init)=>{
    const u=String(input);
    if(u.endsWith('/oauth/token'))return Response.json({access_token:randomUUID(),refresh_token:randomUUID(),expires_in:3600});
    if(u.includes('/designs/'))return Response.json({design:{id:designId,created_at:100,updated_at:designVersion,page_count:1,
      urls:{edit_url:`https://www.canva.com/design/${designId}/edit`,view_url:`https://www.canva.com/design/${designId}/view`}}});
    if(u.endsWith('/exports')&&init?.method==='POST'){
      const id=randomUUID(),format=JSON.parse(String(init.body)).format.type;requests.set(id,format);exportCalls++;
      return Response.json({job:{id,status:'in_progress'}});
    }
    if(u.includes('/exports/')){
      const id=u.split('/').at(-1)!;
      return Response.json({job:{id,status:jobStatus,...(jobStatus==='success'?{urls:[`https://export-download.canva.com/${id}`]}:{})}});
    }
    if(u.startsWith('https://export-download.canva.com/'))return new Response(new Uint8Array(requests.get(u.split('/').at(-1)!)==='pptx'?pptx:createSyntheticValidPng(64,64)));
    throw new Error(`Unexpected synthetic Canva path: ${new URL(u).pathname}`);
  };
  const options={clientId:'synthetic',clientSecret:'synthetic',encryptionKey:'a1'.repeat(32),
    redirectUri:'http://localhost:8772/v1/integrations/canva/callback',fetcher:remote};
  const tx=<T>(fn:Parameters<typeof withRlsContext<T>>[2])=>withRlsContext(db,{tenantId,userId:actorId,role:'operator'},fn);
  async function saveDna(overrides:Record<string,unknown>={}){
    dna={...dna,...overrides};
    await sql`INSERT INTO hawa.client_dna_versions(tenant_id,client_id,version,status,dna,content_hash,created_by)
      VALUES(${tenantId}::uuid,${clientId}::uuid,${Number(dna.version)},'active',${JSON.stringify(dna)}::jsonb,${computeDnaHash(dna)},${actorId}::uuid)`.execute(db);
  }
  async function supersede(){
    await sql`UPDATE hawa.client_dna_versions SET status='superseded' WHERE tenant_id=${tenantId}::uuid AND client_id=${clientId}::uuid`.execute(db);
    await saveDna({version:2,fonts:[{family:'Arial',license:'synthetic fixture',supportedLocales:['en']}]});
  }
  beforeEach(async()=>{
    clientId=randomUUID();taskId=randomUUID();designId=`blank_${randomUUID()}`;
    requests=new Map();exportCalls=0;designVersion=200;jobStatus='success';
    pptx=(await checkedCanvaExportFixture('Exact copy 123.45')).bytes;
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Synthetic blank client')`.execute(db);
    await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title,state) VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Not factual copy','received')`.execute(db);
    await sql`INSERT INTO hawa.task_events(id,tenant_id,task_id,aggregate_version,event_type,actor_type,actor_id,correlation_id,data)
      VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${taskId}::uuid,1,'task.created','user',${actorId},${randomUUID()}::uuid,
      ${JSON.stringify({payload:{body:{workflow:'canva_manual',copyEn:'Exact copy 123.45',copyCkb:''}}})}::jsonb)`.execute(db);
    await sql`INSERT INTO hawa.canva_bindings(id,tenant_id,task_id,client_id,canva_design_id,edit_url,status,version)
      VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,${designId},${`https://www.canva.com/design/${designId}/edit`},'bound',1)`.execute(db);
    dna={tenantId,clientId,version:1,status:'active',fonts:[{family:'Verdana',license:'synthetic fixture',supportedLocales:['en']}]};
    service=new CanvaConnectService(db,options);
    const auth=await service.startAuthorization(scope);await service.finishAuthorization(auth.state,auth.state,'synthetic-code');
  });
  afterAll(()=>db.destroy());
  const start=()=>service.startExport(scope,taskId,'blank-check-0001','pptx',1);
  async function importedSource(manifest:Record<string,unknown>){
    const operationId=randomUUID(),sourceId=randomUUID();
    await sql`INSERT INTO hawa.canva_remote_operations(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,kind,status,design_id,binding_version)
      VALUES(${operationId}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,${actorId},${randomUUID()},'synthetic-source','create','retrieved',${designId},1)`.execute(db);
    await sql`INSERT INTO hawa.canva_editable_sources(id,tenant_id,task_id,client_id,actor_id,operation_id,sha256,content,manifest)
      VALUES(${sourceId}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,${actorId},${operationId}::uuid,
        ${createHash('sha256').update(pptx).digest('hex')},${pptx},${JSON.stringify(manifest)}::jsonb)`.execute(db);
    return sourceId;
  }
  it('freezes the actual planner faces without reinterpreting an older rejected operation',async()=>{
    const copy=['Exact copy 123.45'];
    const plan={width:640,height:640,background:'#FFFFFF',shapes:[],
      text:[{copyIndex:0,x:20,y:20,width:600,height:100,fontSize:24,fontFamily:'Cinzel',color:'#000000',align:'left' as const,rtl:false}]};
    pptx=Buffer.from((await encodeEditableTransfer(plan,copy)).bytes);
    const sourceId=await importedSource({copy,plan,reference:{rules:{fontFamily:'Verdana'}}});
    const oldId=randomUUID(),jobId=randomUUID();requests.set(jobId,'pptx');
    const oldPolicy={version:1,kind:'imported_source',sourceId,copy,requiredFont:'Verdana'};
    await sql`INSERT INTO hawa.canva_remote_operations(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,kind,status,design_id,binding_version,remote_job_id,metadata)
      VALUES(${oldId}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,${actorId},${randomUUID()},'synthetic-old-policy','export','submitted',${designId},1,${jobId},
        ${JSON.stringify({format:'pptx',designUpdatedAt:designVersion,checkingPolicy:oldPolicy})}::jsonb)`.execute(db);
    const old=await service.exportStatus(scope,taskId,oldId);
    expect(old.artifact.content_check).toMatchObject({copyPass:true,fontPass:false,checkingPolicy:oldPolicy});
    const operation=await start(),checked=await new CanvaConnectService(db,options).exportStatus(scope,taskId,operation.operationId);
    expect(checked.artifact.content_check).toMatchObject({copyPass:true,fontPass:true,fullReleasePass:false,
      checkingPolicy:{kind:'imported_source',sourceId,options:{fontsByIndex:['Cinzel']}}});
    const replay=await service.startExport(scope,taskId,'blank-check-0001','pptx',1);
    assert('artifact' in replay && replay.artifact);expect(replay.artifact.id).toBe(checked.artifact.id);
    const oldReplay=await service.exportStatus(scope,taskId,oldId);
    expect(oldReplay.artifact.content_check.fontPass).toBe(false);expect(exportCalls).toBe(1);
  });
  it.each([
    {name:'missing family',text:[{copyIndex:0}]},
    {name:'foreign index',text:[{copyIndex:4,fontFamily:'Verdana'}]},
  ])('refuses a declared imported plan with $name before an export is dispatched',async({text})=>{
    await importedSource({copy:['Exact copy 123.45'],plan:{text},reference:{rules:{fontFamily:'Verdana'}}});
    await expect(start()).rejects.toMatchObject({code:'SOURCE_REQUIRED'});expect(exportCalls).toBe(0);
  });
  it('retains the explicit reference-only policy for a historical source with no plan',async()=>{
    await importedSource({copy:['Exact copy 123.45'],reference:{rules:{fontFamily:'Verdana'}}});
    const operation=await start(),checked=await service.exportStatus(scope,taskId,operation.operationId);
    expect(checked.artifact.content_check).toMatchObject({copyPass:true,fontPass:true,
      checkingPolicy:{kind:'imported_source',requiredFont:'Verdana'}});
  });
  async function capture(){
    const pngOp=await service.startExport(scope,taskId,'blank-preview-01','png',1);
    const png=await service.exportStatus(scope,taskId,pngOp.operationId);
    const operation=await start(),checked=await new CanvaConnectService(db,options).exportStatus(scope,taskId,operation.operationId);
    return {operation,checked,png};
  }
  const record=(id:string)=>tx(trx=>recordManualCanvaReview(trx,evaluateCanvaExportQc,{tenantId,taskId,actorId,artifactId:id}));
  const approve=(revisionId:string,ids:string[])=>createApp({db,testAuth:{roleHeader:true}}).request(`/tasks/${taskId}/revisions/${revisionId}/decisions`,{
    method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer test_art_director_bearer'},
    body:JSON.stringify({decision:'approved',pinnedExportIds:ids})});
  it('captures, records review and approves actual editable bytes with no imported source',async()=>{
    await saveDna();const {operation,checked,png}=await capture();
    expect(checked.artifact.content_check).toMatchObject({copyPass:true,fontPass:true,fullReleasePass:false,
      checkingPolicy:{kind:'manual_client_dna',clientId,dnaVersion:1,dnaContentHash:computeDnaHash(dna)}});
    const result=await record(checked.artifact.id);expect(result).toMatchObject({status:'recorded',qaPassed:true});
    expect((await sql`SELECT id FROM hawa.canva_editable_sources WHERE task_id=${taskId}::uuid`.execute(db)).rows).toHaveLength(0);
    if(result.status!=='recorded')throw new Error('Missing recorded review');
    const response=await approve(result.revisionId,[png.artifact.id,checked.artifact.id]);
    expect(response.status,await response.text()).toBe(201);
    const replay = await service.startExport(scope,taskId,'blank-check-0001','pptx',1);
    assert('artifact' in replay && replay.artifact); expect(replay.artifact.id).toBe(checked.artifact.id);
    expect(exportCalls).toBe(2);
    await expect(sql`UPDATE hawa.canva_remote_operations SET metadata=metadata-'checkingPolicy' WHERE id=${operation.operationId}::uuid`.execute(db)).rejects.toThrow('immutable');
  });
  it('admits one export under concurrent identical requests and service replacement',async()=>{
    await saveDna();jobStatus='in_progress';const outcomes=await Promise.all([start(),start()]);
    expect(new Set(outcomes.map(o=>o.operationId)).size).toBe(1);expect(exportCalls).toBe(1);
    await supersede();jobStatus='success';
    const checked=await new CanvaConnectService(db,options).startExport(scope,taskId,'blank-check-0001','pptx',1);
    assert('artifact' in checked && checked.artifact);
    expect(checked.artifact.content_check).toMatchObject({fontPass:true,checkingPolicy:{dnaVersion:1}});expect(exportCalls).toBe(1);
    const next=await service.startExport(scope,taskId,'blank-check-0002','pptx',1);
    expect((await service.exportStatus(scope,taskId,next.operationId)).artifact.content_check).toMatchObject({fontPass:false,checkingPolicy:{dnaVersion:2}});
  });
  it('records manual review through the restricted runtime database role',async()=>{
    if(!process.env.HAWA_ISOLATED_RUNTIME_DB)throw new Error('An isolated runtime role is required for this test');
    await saveDna();const runtime=createDb(process.env.HAWA_ISOLATED_RUNTIME_DB);
    try {
      service=new CanvaConnectService(runtime,options);
      const {checked}=await capture();
      const review=await withRlsContext(runtime,{tenantId,userId:actorId,role:'operator'},trx=>
        recordManualCanvaReview(trx,evaluateCanvaExportQc,{tenantId,taskId,actorId,artifactId:checked.artifact.id}));
      expect(review).toMatchObject({status:'recorded',qaPassed:true});
    } finally {await runtime.destroy();}
  });
  it.each(['missing','draft','corrupt','other_client','no_fonts','unattributed','automation'])('refuses %s DNA before a provider export',async mode=>{
    if(mode!=='missing')await saveDna(mode==='other_client'?{clientId:randomUUID()}:mode==='no_fonts'?{fonts:[]}:{});
    if(mode==='draft')await sql`UPDATE hawa.client_dna_versions SET status='draft' WHERE client_id=${clientId}::uuid`.execute(db);
    if(mode==='corrupt')await sql`UPDATE hawa.client_dna_versions SET content_hash='sha256_invalid' WHERE client_id=${clientId}::uuid`.execute(db);
    if(mode==='unattributed')await sql`UPDATE hawa.client_dna_versions SET created_by=NULL WHERE client_id=${clientId}::uuid`.execute(db);
    if(mode==='automation')await sql`UPDATE hawa.client_dna_versions SET created_by='00000000-0000-4000-b000-000000000011'::uuid WHERE client_id=${clientId}::uuid`.execute(db);
    await expect(start()).rejects.toThrow();expect(exportCalls).toBe(0);
  });
  it.each([{workflow:'canva',copyEn:'Exact copy'}, {workflow:'canva_manual',copyEn:''},
    {workflow:'canva_manual',copyEn:'Unsupported 漢字'}])('refuses unqualified saved requests: %j',async body=>{
    await saveDna();taskId=randomUUID();designId=`blank_${randomUUID()}`;
    await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Not copy')`.execute(db);
    await sql`INSERT INTO hawa.task_events(id,tenant_id,task_id,aggregate_version,event_type,actor_type,actor_id,correlation_id,data)
      VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${taskId}::uuid,1,'task.created','user',${actorId},${randomUUID()}::uuid,
        ${JSON.stringify({payload:{body}})}::jsonb)`.execute(db);
    await sql`INSERT INTO hawa.canva_bindings(id,tenant_id,task_id,client_id,canva_design_id,edit_url,status,version)
      VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,${designId},${`https://www.canva.com/design/${designId}/edit`},'bound',1)`.execute(db);
    await expect(start()).rejects.toThrow();expect(exportCalls).toBe(0);
  });
  it('cannot fall back to manual policy when this imported source belongs to another actor',async()=>{
    await saveDna();const operationId=randomUUID(), source=await checkedCanvaExportFixture();
    await sql`INSERT INTO hawa.canva_remote_operations(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,kind,status,design_id,binding_version)
      VALUES(${operationId}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,'another-actor',${randomUUID()},'test','create','retrieved',${designId},1)`.execute(db);
    await sql`INSERT INTO hawa.canva_editable_sources(id,tenant_id,task_id,client_id,actor_id,operation_id,sha256,content,manifest)
      VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,'another-actor',${operationId}::uuid,
        ${createHash('sha256').update(source.bytes).digest('hex')},${source.bytes},'{}'::jsonb)`.execute(db);
    await expect(start()).rejects.toMatchObject({code:'SOURCE_FORBIDDEN'});expect(exportCalls).toBe(0);
  });
  it.each(['copy','font'])('keeps a failed %s check visible and refuses approval',async kind=>{
    await saveDna();
    pptx=Buffer.from((await encodeEditableTransfer({width:640,height:640,background:'#FFFFFF',shapes:[],
      text:[{copyIndex:0,x:20,y:20,width:600,height:100,fontSize:24,fontFamily:kind==='font'?'Arial':'Verdana',color:'#000000',align:'left'}]},
      [kind==='copy'?'Changed price 678.90':'Exact copy 123.45'])).bytes);
    const {checked,png}=await capture(),review=await record(checked.artifact.id);
    expect(review).toMatchObject({status:'recorded',qaPassed:false});
    if(review.status!=='recorded')throw new Error('Missing failed review');
    const response=await approve(review.revisionId,[png.artifact.id,checked.artifact.id]);expect(response.status).toBe(412);
  });
  it('retains historical evidence but refuses review after policy supersession',async()=>{
    await saveDna();const {checked}=await capture();await supersede();
    expect(await record(checked.artifact.id)).toMatchObject({status:'blocked',reason:expect.stringContaining('policy changed')});
    const replay = await start(); assert('artifact' in replay && replay.artifact); expect(replay.artifact.id).toBe(checked.artifact.id);
  });
  it('refuses approval after policy supersession even with a passing current review',async()=>{
    await saveDna();const {checked,png}=await capture(),review=await record(checked.artifact.id);
    if(review.status!=='recorded')throw new Error('Missing review');await supersede();
    const response=await approve(review.revisionId,[png.artifact.id,checked.artifact.id]);
    expect(response.status,await response.text()).toBe(412);
  });
  it('refuses publication after policy supersession and isolates export evidence by actor',async()=>{
    await saveDna();const {checked,png}=await capture(),review=await record(checked.artifact.id);
    if(review.status!=='recorded')throw new Error('Missing review');
    const response=await approve(review.revisionId,[png.artifact.id,checked.artifact.id]);expect(response.status).toBe(201);
    const approval=(await sql<{id:string}>`SELECT id FROM hawa.approvals WHERE task_id=${taskId}::uuid AND decision='approved'`.execute(db)).rows[0];
    const input={tenantId,taskId,approvalId:approval.id,artifactIds:[png.artifact.id,checked.artifact.id]};
    expect(await service.verifyApprovedDesignVersion(input)).toMatchObject({ok:true});
    await supersede();expect(await service.verifyApprovedDesignVersion(input)).toMatchObject({ok:false,retryable:false});
    await expect(service.exportStatus({...scope,actorId:randomUUID()},taskId,checked.operationId)).rejects.toThrow('not found');
  });
});
