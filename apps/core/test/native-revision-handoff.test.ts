import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext, DesignStudioRepository } from '@hawa/db';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { CanvaDesignPlanner } from '../src/services/canva-design-planner.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { nativeRevisionHandoff, confirmNativeRevisionCopy } from '../src/services/native-revision-handoff.js';
import { resolveManualExportPolicy } from '../src/services/canva-export-policy.js';
import { recordManualCanvaReview } from '../src/services/manual-canva-review.js';
import { createApp } from '../src/app.js';
import { computeDnaHash, evaluateCanvaExportQc } from '../src/core-helpers.js';
import { checkedCanvaExportFixture } from '../../../packages/testkit/src/canva-export-fixture.js';
import { createSyntheticValidPng } from '../../../packages/integrations/src/canva-capture-pipeline.js';
import { projectLifecycleNativeReview } from '../src/services/lifecycle-native-review.js';
import { recordNativeReview, recordOfficeRevision, type AutomaticLifecycleState, type AutomaticOpenContext } from '../../worker/src/lifecycle/request-lifecycle.js';
import { checkSignedNativeReview, checkSignedOfficeDecision } from '../../worker/src/lifecycle/office-decision-gateway.js';
import type { NativeReviewSubmission } from '@hawa/domain';
import { lockNativeRecovery } from '../src/services/lifecycle-native-scope.js';

const url=process.env.HAWA_ISOLATED_TEST_DB;
describe.skipIf(!url)('native revision admission and human copy handoff (synthetic Canva transport)',()=>{
  const db=createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId='00000000-0000-4000-a000-000000000001',actorId='00000000-0000-4000-b000-000000000001';
  const scope={tenantId,actorId,role:'operator'};
  let clientId:string, taskId:string, parentTaskId:string, designId:string, canva:CanvaConnectService;
  let pptx:Buffer, exports:number, jobs:Map<string,string>;
  const tx=<T>(fn:Parameters<typeof withRlsContext<T>>[2])=>withRlsContext(db,{tenantId,userId:actorId,role:'operator'},fn);
  const remote=vi.fn<typeof fetch>(async(input,init)=>{
    const u=String(input);
    if(u.endsWith('/oauth/token'))return Response.json({access_token:randomUUID(),refresh_token:randomUUID(),expires_in:3600});
    if(u.includes('/designs/'))return Response.json({design:{id:designId,created_at:100,updated_at:200,page_count:1,
      urls:{edit_url:`https://www.canva.com/design/${designId}/edit`,view_url:`https://www.canva.com/design/${designId}/view`}}});
    if(u.endsWith('/exports')&&init?.method==='POST'){
      const id=randomUUID();jobs.set(id,JSON.parse(String(init.body)).format.type);exports++;
      return Response.json({job:{id,status:'in_progress'}});
    }
    if(u.includes('/exports/'))return Response.json({job:{id:u.split('/').at(-1),status:'success',urls:[`https://export-download.canva.com/${u.split('/').at(-1)}`]}});
    if(u.startsWith('https://export-download.canva.com/'))return new Response(new Uint8Array(jobs.get(u.split('/').at(-1)!)==='pptx'?pptx:createSyntheticValidPng(64,64)));
    throw new Error(`Unexpected transport: ${new URL(u).pathname}`);
  });
  const options={clientId:'synthetic',clientSecret:'synthetic',encryptionKey:'a1'.repeat(32),
    redirectUri:'http://localhost:8772/v1/integrations/canva/callback',fetcher:remote};
  async function bind(id:string,nativeId:string){
    await sql`INSERT INTO hawa.canva_bindings(id,tenant_id,task_id,client_id,canva_design_id,edit_url,status,version)
      VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${id}::uuid,${clientId}::uuid,${nativeId},${`https://www.canva.com/design/${nativeId}/edit`},'bound',1)`.execute(db);
  }
  beforeEach(async()=>{
    clientId=randomUUID();taskId=randomUUID();parentTaskId=randomUUID();designId=`copy_${randomUUID()}`;
    jobs=new Map();exports=0;remote.mockClear();pptx=(await checkedCanvaExportFixture('New exact date 2026')).bytes;
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Revision fixture')`.execute(db);
    for(const id of [parentTaskId,taskId]){
      await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title,description,state,version)
        VALUES(${id}::uuid,${tenantId}::uuid,${clientId}::uuid,'Revision fixture','','failed_operator',1)`.execute(db);
      const data={studioOptions:id===taskId?{parentTaskId,revisionDirective:'Change date only. Preserve the manual photo crop.'}:{},exactCopy:[{text:'Original exact date 2025'}]};
      await sql`INSERT INTO hawa.task_events(tenant_id,task_id,event_type,aggregate_version,actor_type,actor_id,correlation_id,data)
        VALUES(${tenantId}::uuid,${id}::uuid,'task.created',1,'user',${actorId},${randomUUID()}::uuid,${JSON.stringify(data)}::jsonb)`.execute(db);
    }
    await bind(parentTaskId,`parent_${randomUUID()}`);
    const dna={tenantId,clientId,version:1,status:'active',fonts:[{family:'Verdana',license:'test fixture',supportedLocales:['en']}]};
    await sql`INSERT INTO hawa.client_dna_versions(tenant_id,client_id,version,status,dna,content_hash,created_by)
      VALUES(${tenantId}::uuid,${clientId}::uuid,1,'active',${JSON.stringify(dna)}::jsonb,${computeDnaHash(dna)},${actorId}::uuid)`.execute(db);
    canva=new CanvaConnectService(db,options);
    const auth=await canva.startAuthorization(scope);await canva.finishAuthorization(auth.state,auth.state,'test-code');remote.mockClear();
  });
  afterAll(()=>db.destroy());
  afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
  async function input(){
    const h=await tx(trx=>nativeRevisionHandoff(trx,tenantId,taskId));
    if(!h?.available)throw new Error('Expected scoped handoff');
    return {expectedTaskVersion:h.taskVersion,basisSha256:h.basisSha256,copy:['New exact date 2026'],reviewedCurrentDesign:true,preservedUnrequestedChanges:true};
  }
  const confirm=async(key=randomUUID(),body?:Awaited<ReturnType<typeof input>>)=>{
    const request=body??await input();return tx(trx=>confirmNativeRevisionCopy(trx,scope,taskId,key,request));
  };
  const app=()=>createApp({db,canvaOptions:options,extraBearerTokens:{test_operator_bearer:{role:'operator',sub:actorId}}});
  const post=async(path:string,body:unknown,key=randomUUID(),headers:Record<string,string>={})=>app().request(path,{method:'POST',
    headers:{'content-type':'application/json',Authorization:'Bearer test_operator_bearer','Idempotency-Key':key,...headers},body:JSON.stringify(body)});

  async function own(){
    const requestId=randomUUID();
    await sql`INSERT INTO hawa.requests(request_id,tenant_id,root_task_id,current_task_id,owner,stage,rev,chat_id)
      VALUES(${requestId}::uuid,${tenantId}::uuid,${parentTaskId}::uuid,${taskId}::uuid,'restate','manual',4,'73004000')`.execute(db);
    await sql`UPDATE hawa.tasks SET request_id=${requestId}::uuid WHERE id=${taskId}::uuid`.execute(db);
    return {requestId,headers:{'X-Hawa-Manual-Request-Id':requestId,'X-Hawa-Manual-Request-Rev':'4'},nativeRecovery:{requestId,rev:4}};
  }
  async function ownedCaptures(){
    const owned=await own();
    const linked=await post(`/tasks/${taskId}/canva-binding`,{editUrl:`https://www.canva.com/design/${designId}/edit`},randomUUID(),owned.headers);
    expect(linked.status,await linked.clone().text()).toBe(201);
    const response=await post(`/tasks/${taskId}/canva/revision-copy`,await input(),randomUUID(),owned.headers);
    expect(response.status,await response.clone().text()).toBe(200);
    const {confirmationEventId}=await response.json() as {confirmationEventId:string};
    const artifacts:string[]=[];
    for(const format of ['png','pptx']){
      const start=await post(`/tasks/${taskId}/canva/exports`,{format,expectedVersion:1},randomUUID(),owned.headers);
      expect(start.status,await start.clone().text()).toBe(202);
      const {operationId}=await start.json() as {operationId:string};
      const result=await post(`/tasks/${taskId}/canva/exports/${operationId}/resume`,{},randomUUID(),owned.headers);
      expect(result.status,await result.clone().text()).toBe(200);
      const value=await result.json() as {artifact:{id:string};review?:{status:string}};
      artifacts.push(value.artifact.id);
      if(format==='pptx')expect(value.review?.status).toBe('blocked');
    }
    const body={requestId:owned.requestId,expectedRev:4,expectedTaskVersion:(await input()).expectedTaskVersion,
      artifactId:artifacts[1],confirmationEventId};
    const actionId=randomUUID();
    const event:NativeReviewSubmission={...body,v:1,kind:'native_review',eventId:`desk:${actionId}`,actionId,taskId,actor:{userId:actorId,role:'operator'}};
    return {...owned,artifacts,body,event,actionId};
  }

  it('completes request-owned preparation, signed review recovery and explicit approval with retained native bytes',async()=>{
    const prepared=await ownedCaptures();
    expect((await sql`SELECT id FROM hawa.design_revisions WHERE task_id=${taskId}::uuid`.execute(db)).rows).toHaveLength(0);
    expect((await sql<{stage:string;rev:number}>`SELECT stage,rev FROM hawa.requests WHERE request_id=${prepared.requestId}::uuid`.execute(db)).rows[0]).toMatchObject({stage:'manual',rev:'4'});
    const secret=['native','review','fixture'].join('_');vi.stubEnv('HAWA_WORKER_TOKEN',secret);vi.stubEnv('RESTATE_INGRESS_URL','http://native-review.test');
    let state:AutomaticLifecycleState={v:1,requestId:prepared.requestId,tenantId,chatId:'73004000',owner:'restate',stage:'manual',rev:4,
      taskId,openEventId:'fixture-open',openSha256:'a'.repeat(64),runId:`dr-${taskId}`,round:1,
      designInput:{v:1,taskId,tenantId,clientId,rawText:'Change date',sourcePlatform:'telegram',idempotencyKey:'fixture',canvaAutoGenerate:true,
        lifecycle:{requestId:prepared.requestId,round:1,runId:`dr-${taskId}`}}};
    const context:AutomaticOpenContext={key:prepared.requestId,get:async()=>state,run:async(_name,action)=>action(),
      set:(_name,value)=>{state=value as AutomaticLifecycleState;},send:()=>{},startDesign:()=>{throw new Error('No generation');}};
    let loseCoreReply=true;
    const core={post:async<T>(path:string,body:unknown):Promise<T>=>{
      const response=await app().request(`/v1${path}`,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify(body)});
      if(!response.ok)throw new Error(await response.text());
      if(path.endsWith('/native-review')&&loseCoreReply){loseCoreReply=false;throw new Error('Lost Core projection reply');}
      return await response.json() as T;
    }};
    let loseReply=true;
    const gateway=vi.fn<typeof fetch>(async(url,init)=>{
      const signed=JSON.parse(String(init?.body));
      if(String(url).endsWith('/nativeReview')){
        expect(checkSignedNativeReview(signed,secret)).toBe('ok');
        const result=await recordNativeReview(context,core,signed.event);
        if(loseReply){loseReply=false;throw new Error('Lost gateway reply after durable state save');}
        return Response.json(result);
      }
      expect(checkSignedOfficeDecision(signed,secret)).toBe('ok');
      return Response.json(await recordOfficeRevision(context,core,signed.event));
    });vi.stubGlobal('fetch',gateway);
    expect((await post(`/tasks/${taskId}/native-review`,prepared.body,prepared.actionId)).status).toBe(503);
    expect(state.stage).toBe('manual');
    expect((await post(`/tasks/${taskId}/native-review`,prepared.body,prepared.actionId)).status).toBe(503);
    expect(state.stage).toBe('in_review');expect(state.rev).toBe(5);
    const replay=await post(`/tasks/${taskId}/native-review`,prepared.body,prepared.actionId);
    expect(replay.status,await replay.clone().text()).toBe(200);
    const review=await replay.json() as {revisionId:string;qaPassed:boolean};expect(review.qaPassed).toBe(true);
    expect(gateway).toHaveBeenCalledTimes(3);
    expect((await sql`SELECT id FROM hawa.design_revisions WHERE task_id=${taskId}::uuid`.execute(db)).rows).toHaveLength(1);
    expect((await sql`SELECT id FROM hawa.approvals WHERE task_id=${taskId}::uuid`.execute(db)).rows).toHaveLength(0);
    const approval=await post(`/tasks/${taskId}/revisions/${review.revisionId}/decisions`,
      {action:'approve',reason:'Synthetic reviewer checked this fixture.',pinnedExportIds:prepared.artifacts},randomUUID(),{Authorization:'Bearer test_art_director_bearer'});
    expect(approval.status,await approval.clone().text()).toBe(201);expect(state.stage).toBe('approved');
    const old=await post(`/tasks/${taskId}/native-review`,prepared.body,prepared.actionId);expect(old.status).toBe(200);
    expect(state.stage).toBe('approved');
    const altered=await post(`/tasks/${taskId}/native-review`,{...prepared.body,expectedRev:6},prepared.actionId);
    expect(altered.status).toBe(409);
    expect(exports).toBe(2);
  });
  it('replays a committed projection on a fresh runtime connection without recreating review or QA',async()=>{
    const p=await ownedCaptures(),runtimeUrl=new URL(url!);runtimeUrl.searchParams.set('options','-c role=hawa_app');
    const first=createDb(runtimeUrl.toString());
    const result=await projectLifecycleNativeReview(first,tenantId,p.event);await first.destroy();
    const second=createDb(runtimeUrl.toString());
    try{
      expect(await projectLifecycleNativeReview(second,tenantId,p.event)).toEqual(result);
      await expect(projectLifecycleNativeReview(second,tenantId,{...p.event,expectedRev:5})).rejects.toMatchObject({code:'NATIVE_REVIEW_CONFLICT'});
    }finally{await second.destroy();}
    expect((await sql`SELECT id FROM hawa.qc_runs WHERE task_id=${taskId}::uuid`.execute(db)).rows).toHaveLength(1);
  });
  it('serializes manual preparation with owner transitions and rechecks scope before export dispatch',async()=>{
    const owned=await own();await bind(taskId,designId);
    await tx(async trx=>{
      await lockNativeRecovery(trx,{...scope,nativeRecovery:owned.nativeRecovery},taskId);
      await expect(db.transaction().execute(async peer=>{
        await sql`SET LOCAL lock_timeout='100ms'`.execute(peer);
        await sql`UPDATE hawa.requests SET rev=5,stage='in_review' WHERE request_id=${owned.requestId}::uuid`.execute(peer);
      })).rejects.toThrow('lock timeout');
    });
    await tx(async trx=>confirmNativeRevisionCopy(trx,{...scope,nativeRecovery:owned.nativeRecovery},taskId,randomUUID(),await input()));
    const original=remote.getMockImplementation()!;
    remote.mockImplementationOnce(async(url,init)=>{
      await sql`UPDATE hawa.requests SET rev=5,stage='in_review' WHERE request_id=${owned.requestId}::uuid`.execute(db);
      return original(url,init);
    });
    const response=await post(`/tasks/${taskId}/canva/exports`,{format:'png',expectedVersion:1},randomUUID(),owned.headers);
    expect(response.status).toBe(409);expect(exports).toBe(0);
  });
  it('rejects a disabled submitter before projection and keeps human approval separate',async()=>{
    const p=await ownedCaptures();
    await sql`UPDATE hawa.users SET disabled_at=now() WHERE id=${actorId}::uuid`.execute(db);
    try{await expect(projectLifecycleNativeReview(db,tenantId,p.event)).rejects.toMatchObject({code:'HUMAN_REVIEW_REQUIRED'});}
    finally{await sql`UPDATE hawa.users SET disabled_at=NULL WHERE id=${actorId}::uuid`.execute(db);}
    expect((await sql`SELECT id FROM hawa.design_revisions WHERE task_id=${taskId}::uuid`.execute(db)).rows).toHaveLength(0);
  });
  it.each(['confirmation','parent','task','capture'])('refuses a changed %s before owned review without advancing the request',async kind=>{
    const prepared=await ownedCaptures();
    // New valid confirmation increments task version; pin its current version to isolate confirmation identity.
    if(kind==='confirmation'){
      await tx(async trx=>confirmNativeRevisionCopy(trx,{...scope,nativeRecovery:prepared.nativeRecovery},taskId,randomUUID(),await input()));
      prepared.event.expectedTaskVersion=(await input()).expectedTaskVersion;
    }
    if(kind==='parent')await sql`UPDATE hawa.tasks SET version=version+1 WHERE id=${parentTaskId}::uuid`.execute(db);
    if(kind==='task')prepared.event.expectedTaskVersion++;
    if(kind==='capture')prepared.event.artifactId=randomUUID();
    await expect(projectLifecycleNativeReview(db,tenantId,prepared.event)).rejects.toBeInstanceOf(Error);
    expect((await sql`SELECT id FROM hawa.design_revisions WHERE task_id=${taskId}::uuid`.execute(db)).rows).toHaveLength(0);
    expect((await sql<{stage:string}>`SELECT stage FROM hawa.requests WHERE request_id=${prepared.requestId}::uuid`.execute(db)).rows[0].stage).toBe('manual');
  });
  it('fences preparation to the current manual request and never delegates new generation',async()=>{
    const owned=await own();
    const base=`/tasks/${taskId}`;
    for(const route of ['/canva/design','/canva/generate','/canva/studio'])
      expect((await post(`${base}${route}`,{},randomUUID(),owned.headers)).status).toBe(409);
    const body={editUrl:`https://www.canva.com/design/${designId}/edit`};
    expect((await post(`${base}/canva-binding`,body,randomUUID(),{...owned.headers,'X-Hawa-Manual-Request-Rev':'3'})).status).toBe(409);
    await sql`UPDATE hawa.requests SET stage='in_review',rev=5 WHERE request_id=${owned.requestId}::uuid`.execute(db);
    expect((await post(`${base}/canva-binding`,body,randomUUID(),owned.headers)).status).toBe(409);
    expect(remote).not.toHaveBeenCalled();
    expect((await sql`SELECT id FROM hawa.canva_bindings WHERE task_id=${taskId}::uuid`.execute(db)).rows).toHaveLength(0);
  });

  it('refuses both generation paths, blank creation and fresh import without paid/native calls',async()=>{
    const studio=new DesignStudioService(db,canva,{apiKey:'synthetic',fetcher:remote});
    const refusal={code:'NATIVE_REVISION_HANDOFF_REQUIRED'};
    await expect(studio.createOrGetRun(scope,taskId,randomUUID(),{width:1080,height:1350})).rejects.toMatchObject(refusal);
    await expect(new CanvaDesignPlanner(db,canva,{apiKey:'synthetic',fetcher:remote}).generate(scope,taskId,randomUUID(),1080,1350)).rejects.toMatchObject(refusal);
    await expect(canva.createDesign(scope,taskId,randomUUID(),1080,1350)).rejects.toMatchObject(refusal);
    await expect(canva.importEditableDesign(scope,taskId,randomUUID(),{bytes:pptx,sha256:createHash('sha256').update(pptx).digest('hex'),manifest:{copy:['Old'],plan:{}}})).rejects.toMatchObject(refusal);
    expect(remote).not.toHaveBeenCalled();
    expect((await sql`SELECT id FROM hawa.design_studio_runs WHERE task_id=${taskId}::uuid`.execute(db)).rows).toHaveLength(0);
  });
  it('holds fresh exports and old imported policy until the current native copy is confirmed',async()=>{
    await bind(taskId,designId);
    const opId=randomUUID(),sourceId=randomUUID();
    await sql`INSERT INTO hawa.canva_remote_operations(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,kind,status,design_id,binding_version)
      VALUES(${opId}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,${actorId},${randomUUID()},'fixture','create','retrieved',${designId},1)`.execute(db);
    await sql`INSERT INTO hawa.canva_editable_sources(id,tenant_id,task_id,client_id,actor_id,operation_id,sha256,content,manifest)
      VALUES(${sourceId}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,${actorId},${opId}::uuid,
        ${createHash('sha256').update(pptx).digest('hex')},${pptx},'{}'::jsonb)`.execute(db);
    const result=await tx(trx=>sql<{ok:boolean}>`SELECT hawa.canva_export_policy_current(${tenantId}::uuid,${clientId}::uuid,
      ${JSON.stringify({checkingPolicy:{kind:'imported_source',sourceId}})}::jsonb) ok`.execute(trx));
    expect(result.rows[0].ok).toBe(false);
    const legacy=await tx(trx=>sql<{ok:boolean}>`SELECT hawa.canva_export_policy_current(${tenantId}::uuid,${clientId}::uuid,
      ${JSON.stringify({taskId})}::jsonb) ok`.execute(trx));
    expect(legacy.rows[0].ok).toBe(false);
    await expect(canva.startExport(scope,taskId,randomUUID(),'pptx',1)).rejects.toMatchObject({code:'NATIVE_REVISION_HANDOFF_REQUIRED'});
    expect(exports).toBe(0);
    expect(await tx(trx=>recordManualCanvaReview(trx,evaluateCanvaExportQc,{tenantId,taskId,actorId,artifactId:randomUUID()})))
      .toMatchObject({status:'blocked',reason:expect.stringContaining('Confirm the exact revised copy')});
  });
  it.each(['briefing','laying_out','awaiting_selection','transferring'])('holds historical %s runs before any replacement work',async status=>{
    const run=await new DesignStudioRepository(db).createRun({id:randomUUID(),tenantId,taskId,clientId,actorId,requestKey:randomUUID(),requestHash:'synthetic',
      request:{directed:{parentTaskId},pipelineV3:true},tier:'standard',budget:{maxUsd:2,maxCalls:24,spentUsd:0,calls:0}});
    await sql`UPDATE hawa.design_studio_runs SET status=${status} WHERE id=${run.id}::uuid`.execute(db);
    await expect(new DesignStudioService(db,canva,{apiKey:'synthetic',fetcher:remote}).resume(scope,taskId,run.id))
      .rejects.toMatchObject({code:'NATIVE_REVISION_HANDOFF_REQUIRED'});
    expect(remote).not.toHaveBeenCalled();
    expect((await sql<{status:string}>`SELECT status FROM hawa.design_studio_runs WHERE id=${run.id}::uuid`.execute(db)).rows[0].status).toBe(status);
  });
  it('requires a separate linked copy and explicit human checks, with optimistic concurrency and keyed replay',async()=>{
    await expect(confirm()).rejects.toMatchObject({code:'NATIVE_COPY_REQUIRED'});
    await bind(taskId,designId);
    const body=await input();
    await expect(confirm(randomUUID(),{...body,preservedUnrequestedChanges:false})).rejects.toMatchObject({code:'REVISION_COPY_REVIEW_REQUIRED'});
    const key=randomUUID(),outcomes=await Promise.all([confirm(key,body),confirm(key,body)]);
    expect(new Set(outcomes.map(o=>o.confirmationEventId)).size).toBe(1);
    await expect(confirm(key,{...body,copy:['Changed']})).rejects.toMatchObject({code:'REVISION_REVIEW_CONFLICT'});
    await expect(confirm(randomUUID(),body)).rejects.toMatchObject({code:'REVISION_BASIS_CHANGED'});
    expect((await tx(trx=>nativeRevisionHandoff(trx,tenantId,taskId)))).toMatchObject({confirmedEventId:outcomes[0].confirmationEventId,copy:body.copy});
    expect(remote).not.toHaveBeenCalled();
  });
  it('uses the public confirmation and export routes to record actual revised PPTX bytes for review',async()=>{
    await bind(taskId,designId);
    const response=await post(`/tasks/${taskId}/canva/revision-copy`,await input());
    expect(response.status,await response.clone().text()).toBe(200);
    const confirmed=await response.json() as {confirmationEventId:string};
    const artifacts:string[]=[];
    let revisionId='';
    for(const format of ['png','pptx']){
      const start=await post(`/tasks/${taskId}/canva/exports`,{format,expectedVersion:1});
      expect(start.status,await start.clone().text()).toBe(202);
      const op=await start.json() as {operationId:string};
      const result=await post(`/tasks/${taskId}/canva/exports/${op.operationId}/resume`,{});
      expect(result.status,await result.clone().text()).toBe(200);
      const value=await result.json() as {artifact:{id:string;content_check?:unknown};review?:{status:string;revisionId:string;qaPassed:boolean}};
      artifacts.push(value.artifact.id);
      if(format==='pptx'){
        expect(value.artifact.content_check).toMatchObject({copyPass:true,fontPass:true,expectedCopy:['New exact date 2026'],checkingPolicy:{kind:'revision_client_dna',confirmationEventId:confirmed.confirmationEventId}});
        expect(value.review).toMatchObject({status:'recorded',qaPassed:true});revisionId=value.review!.revisionId;
      }
    }
    expect(exports).toBe(2);
    const state=await canva.taskState(scope,taskId);
    expect(state.artifacts).toHaveLength(2);
    expect(state.artifacts.every((artifact:{confirmation_event_id:string})=>artifact.confirmation_event_id===confirmed.confirmationEventId)).toBe(true);
    const revision=(await sql<{neutral_manifest:Record<string,unknown>}>`SELECT neutral_manifest FROM hawa.design_revisions WHERE id=${revisionId}::uuid`.execute(db)).rows[0];
    expect(revision.neutral_manifest).toMatchObject({copy:['New exact date 2026'],nativeVerification:'unverified',nativeRevisionHandoff:{nativePreservationVerified:false,preservation:'operator_reviewed'}});
    expect((await sql`SELECT id FROM hawa.approvals WHERE task_id=${taskId}::uuid`.execute(db)).rows).toHaveLength(0);
    expect(artifacts).toHaveLength(2);
    const approval=await app().request(`/tasks/${taskId}/revisions/${revisionId}/decisions`,{
      method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer test_art_director_bearer'},
      body:JSON.stringify({decision:'approved',pinnedExportIds:artifacts})});
    expect(approval.status,await approval.clone().text()).toBe(201);
    const approved=(await sql<{id:string}>`SELECT id FROM hawa.approvals WHERE task_id=${taskId}::uuid`.execute(db)).rows[0];
    const publicationBasis={tenantId,taskId,approvalId:approved.id,artifactIds:artifacts};
    expect(await canva.verifyApprovedDesignVersion(publicationBasis)).toMatchObject({ok:true});
    // A new human confirmation invalidates the previously approved capture, even for identical copy.
    await confirm();
    expect(await canva.verifyApprovedDesignVersion(publicationBasis)).toMatchObject({ok:false,code:'CANVA_CAPTURE_UNVERIFIED'});
    const replay=await tx(trx=>recordManualCanvaReview(trx,evaluateCanvaExportQc,{tenantId,taskId,actorId,artifactId:artifacts[1]}));
    expect(replay).toMatchObject({status:'blocked'});
  });
  it('cannot pair a preview from a previous confirmation with a new checked source at the same native timestamp',async()=>{
    await bind(taskId,designId);await confirm();
    const png=await canva.startExport(scope,taskId,randomUUID(),'png',1);
    const oldPng=await canva.exportStatus(scope,taskId,png.operationId);
    await confirm();
    const source=await canva.startExport(scope,taskId,randomUUID(),'pptx',1);
    const checked=await canva.exportStatus(scope,taskId,source.operationId);
    const record=()=>tx(trx=>recordManualCanvaReview(trx,evaluateCanvaExportQc,{tenantId,taskId,actorId,artifactId:checked.artifact.id}));
    expect(await record()).toMatchObject({status:'blocked'});
    const fresh=await canva.startExport(scope,taskId,randomUUID(),'png',1);
    await canva.exportStatus(scope,taskId,fresh.operationId);
    const review=await record();expect(review).toMatchObject({status:'recorded',qaPassed:true});
    if(review.status!=='recorded')throw new Error('Expected recorded review');
    const mixedApproval=await app().request(`/tasks/${taskId}/revisions/${review.revisionId}/decisions`,{
      method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer test_art_director_bearer'},
      body:JSON.stringify({decision:'approved',pinnedExportIds:[oldPng.artifact.id,checked.artifact.id]})});
    expect(mixedApproval.status,await mixedApproval.clone().text()).toBe(412);
  });
  it('rejects malformed confirmation and changed or closed task bases without remote work',async()=>{
    const malformed=await post(`/tasks/${taskId}/canva/revision-copy`,null);
    expect(malformed.status).toBe(422);
    await bind(taskId,designId);const body=await input();
    await sql`UPDATE hawa.canva_bindings SET version=version+1 WHERE task_id=${taskId}::uuid`.execute(db);
    await expect(confirm(randomUUID(),body)).rejects.toMatchObject({code:'REVISION_BASIS_CHANGED'});
    await sql`UPDATE hawa.tasks SET state='cancelled' WHERE id=${taskId}::uuid`.execute(db);
    await expect(confirm()).rejects.toMatchObject({code:'REVISION_HANDOFF_UNAVAILABLE'});
    expect(remote).not.toHaveBeenCalled();
  });
  it('invalidates old export policy after a new copy confirmation or changed parent basis',async()=>{
    await bind(taskId,designId);await confirm();
    const policy=await tx(trx=>resolveManualExportPolicy(trx,tenantId,taskId,clientId));
    const current=()=>tx(async trx=>(await sql<{ok:boolean}>`SELECT hawa.canva_export_policy_current(${tenantId}::uuid,${clientId}::uuid,${JSON.stringify({checkingPolicy:policy})}::jsonb) ok`.execute(trx)).rows[0].ok);
    expect(await current()).toBe(true);
    await confirm(randomUUID(),{...await input(),copy:['Next exact date 2027']});
    expect(await current()).toBe(false);
    const body=await input();
    await sql`UPDATE hawa.tasks SET version=version+1 WHERE id=${parentTaskId}::uuid`.execute(db);
    await expect(confirm(randomUUID(),body)).rejects.toMatchObject({code:'REVISION_BASIS_CHANGED'});
    await expect(tx(trx=>resolveManualExportPolicy(trx,tenantId,taskId,clientId))).rejects.toMatchObject({code:'REVISION_BASIS_CHANGED'});
  });
  it('refuses nonhuman and cross-client parent confirmation without exposing its design link',async()=>{
    await bind(taskId,designId);const body=await input();
    await expect(tx(trx=>confirmNativeRevisionCopy(trx,{...scope,actorId:'00000000-0000-4000-b000-000000000011'},taskId,randomUUID(),body)))
      .rejects.toMatchObject({code:'HUMAN_REVIEW_REQUIRED'});
    // Move the fixture's parent and binding together; preserve the real scoped FK.
    await db.transaction().execute(async trx=>{
      await sql`DELETE FROM hawa.canva_bindings WHERE task_id=${parentTaskId}::uuid`.execute(trx);
      await sql`UPDATE hawa.tasks SET client_id='c1000000-0000-4000-8000-000000000002'::uuid WHERE id=${parentTaskId}::uuid`.execute(trx);
      await sql`INSERT INTO hawa.canva_bindings(id,tenant_id,task_id,client_id,canva_design_id,edit_url,status,version)
        VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${parentTaskId}::uuid,'c1000000-0000-4000-8000-000000000002'::uuid,
          ${`foreign_${randomUUID()}`},'https://www.canva.com/design/foreign/edit','bound',1)`.execute(trx);
    });
    const h=await tx(trx=>nativeRevisionHandoff(trx,tenantId,taskId));
    expect(h).toMatchObject({available:false});expect(h).not.toHaveProperty('parentEditUrl');
    await expect(confirm(randomUUID(),body)).rejects.toMatchObject({code:'NATIVE_COPY_REQUIRED'});
  });
  it('confirms and resolves policy across fresh restricted runtime-role connections',async()=>{
    await bind(taskId,designId);const body=await input();
    const runtimeUrl=new URL(url!);runtimeUrl.searchParams.set('options','-c role=hawa_app');
    const runtime=createDb(runtimeUrl.toString());
    try {
      await withRlsContext(runtime,{tenantId,userId:actorId,role:'operator'},trx=>confirmNativeRevisionCopy(trx,scope,taskId,randomUUID(),body));
    } finally {await runtime.destroy();}
    const peer=createDb(runtimeUrl.toString());
    try {
      const policy=await withRlsContext(peer,{tenantId,userId:actorId,role:'operator'},trx=>resolveManualExportPolicy(trx,tenantId,taskId,clientId));
      expect(policy).toMatchObject({kind:'revision_client_dna',copy:body.copy});
    } finally {await peer.destroy();}
  });
  it('keeps the admitted parent basis locked until the policy-check transaction commits',async()=>{
    await bind(taskId,designId);await confirm();
    const policy=await tx(trx=>resolveManualExportPolicy(trx,tenantId,taskId,clientId));
    await tx(async trx=>{
      const result=await sql<{ok:boolean}>`SELECT hawa.canva_export_policy_current(${tenantId}::uuid,${clientId}::uuid,
        ${JSON.stringify({checkingPolicy:policy})}::jsonb) ok`.execute(trx);
      expect(result.rows[0].ok).toBe(true);
      await expect(db.transaction().execute(async peer=>{
        await sql`SET LOCAL lock_timeout='100ms'`.execute(peer);
        await sql`UPDATE hawa.tasks SET version=version+1 WHERE id=${parentTaskId}::uuid`.execute(peer);
      })).rejects.toThrow('lock timeout');
    });
    await sql`UPDATE hawa.tasks SET version=version+1 WHERE id=${parentTaskId}::uuid`.execute(db);
    const current=await tx(trx=>sql<{ok:boolean}>`SELECT hawa.canva_export_policy_current(${tenantId}::uuid,${clientId}::uuid,
      ${JSON.stringify({checkingPolicy:policy})}::jsonb) ok`.execute(trx));
    expect(current.rows[0].ok).toBe(false);
  });
});
