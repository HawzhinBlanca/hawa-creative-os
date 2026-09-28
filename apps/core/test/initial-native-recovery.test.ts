import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext, DesignStudioRepository } from '@hawa/db';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { createApp } from '../src/app.js';
import { computeDnaHash } from '../src/core-helpers.js';
import { checkedCanvaExportFixture } from '../../../packages/testkit/src/canva-export-fixture.js';
import { createSyntheticValidPng } from '../../../packages/integrations/src/canva-capture-pipeline.js';
import { projectLifecycleNativeReview } from '../src/services/lifecycle-native-review.js';
import { projectLifecycleOfficeDecision } from '../src/services/lifecycle-projection.js';
import { lockNativeRecovery } from '../src/services/lifecycle-native-scope.js';
import { recordNativeReview, recordOfficeRevision, type AutomaticOpenContext } from '../../worker/src/lifecycle/request-lifecycle.js';
import { checkSignedNativeReview, checkSignedOfficeDecision } from '../../worker/src/lifecycle/office-decision-gateway.js';
import type { NativeReviewSubmission } from '@hawa/domain';

type OwnerState = Awaited<ReturnType<AutomaticOpenContext['get']>>;

/**
 * ADR-126: an initial manual RequestLifecycle request (opened with autoGenerate false, no design run)
 * gets the same owner-controlled native journey as ADR-114's linked revisions. Real isolated
 * PostgreSQL and retained bytes; synthetic Canva transport; in-memory request owner harness.
 */
const url=process.env.HAWA_ISOLATED_TEST_DB;
describe.skipIf(!url)('initial manual request native recovery (synthetic Canva transport)',()=>{
  const db=createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId='00000000-0000-4000-a000-000000000001',actorId='00000000-0000-4000-b000-000000000001';
  const scope={tenantId,actorId,role:'operator'};
  let clientId:string,taskId:string,requestId:string,designId:string,pptx:Buffer,exports:number,jobs:Map<string,string>;
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
  const app=()=>createApp({db,canvaOptions:options,extraBearerTokens:{test_operator_bearer:{role:'operator',sub:actorId}}});
  const headers=(rev=1)=>({'X-Hawa-Manual-Request-Id':requestId,'X-Hawa-Manual-Request-Rev':String(rev)});
  const post=async(path:string,body:unknown,key=randomUUID(),extra:Record<string,string>={})=>app().request(path,{method:'POST',
    headers:{'content-type':'application/json',Authorization:'Bearer test_operator_bearer','Idempotency-Key':key,...extra},body:JSON.stringify(body)});
  const state=async()=>{
    const response=await app().request(`/tasks/${taskId}/canva`,{headers:{Authorization:'Bearer test_operator_bearer'}});
    expect(response.status,await response.clone().text()).toBe(200);
    return (await response.json() as {revisionHandoff?:Record<string,any>}).revisionHandoff;
  };
  const input=async()=>{
    const h=await state();
    if(!h?.available)throw new Error(`Expected an available initial handoff: ${JSON.stringify(h)}`);
    return {expectedTaskVersion:h.taskVersion as number,basisSha256:h.basisSha256 as string,copy:['Initial exact date 2026'],
      reviewedCurrentDesign:true,separateRequestDesign:true};
  };
  const requestRow=async()=>(await sql<{stage:string;rev:string}>`SELECT stage,rev FROM hawa.requests WHERE request_id=${requestId}::uuid`.execute(db)).rows[0];
  const revisions=async()=>(await sql`SELECT id FROM hawa.design_revisions WHERE task_id=${taskId}::uuid`.execute(db)).rows.length;

  /** The persisted first projection is the authority that this request was opened without a run. */
  async function openRequest(opts:{autoGenerate?:boolean;stage?:string;rev?:number}={}){
    const autoGenerate=opts.autoGenerate??false;
    await sql`INSERT INTO hawa.requests(request_id,tenant_id,root_task_id,current_task_id,owner,stage,rev,chat_id)
      VALUES(${requestId}::uuid,${tenantId}::uuid,${taskId}::uuid,${taskId}::uuid,'restate',${opts.stage??(autoGenerate?'designing':'manual')},${opts.rev??1},'73006000')`.execute(db);
    await sql`UPDATE hawa.tasks SET request_id=${requestId}::uuid WHERE id=${taskId}::uuid`.execute(db);
    const result={requestId,rev:1,taskId,stage:autoGenerate?'designing':'manual',autoGenerate};
    await sql`INSERT INTO hawa.lifecycle_projections(tenant_id,request_id,rev,idempotency_key,payload_sha256,result)
      VALUES(${tenantId}::uuid,${requestId}::uuid,1,${`${requestId}:1:open`},${'c'.repeat(64)},${JSON.stringify(result)}::jsonb)`.execute(db);
  }
  async function preparedCaptures(){
    await openRequest();
    const linked=await post(`/tasks/${taskId}/canva-binding`,{editUrl:`https://www.canva.com/design/${designId}/edit`},randomUUID(),headers());
    expect(linked.status,await linked.clone().text()).toBe(201);
    const confirmed=await post(`/tasks/${taskId}/canva/revision-copy`,await input(),randomUUID(),headers());
    expect(confirmed.status,await confirmed.clone().text()).toBe(200);
    const {confirmationEventId}=await confirmed.json() as {confirmationEventId:string};
    const artifacts:string[]=[];
    for(const format of ['png','pptx']){
      const start=await post(`/tasks/${taskId}/canva/exports`,{format,expectedVersion:1},randomUUID(),headers());
      expect(start.status,await start.clone().text()).toBe(202);
      const {operationId}=await start.json() as {operationId:string};
      const result=await post(`/tasks/${taskId}/canva/exports/${operationId}/resume`,{},randomUUID(),headers());
      expect(result.status,await result.clone().text()).toBe(200);
      const value=await result.json() as {artifact:{id:string;content_check?:unknown};review?:{status:string}};
      artifacts.push(value.artifact.id);
      if(format==='pptx'){
        expect(value.artifact.content_check).toMatchObject({copyPass:true,fontPass:true,expectedCopy:['Initial exact date 2026'],
          checkingPolicy:{kind:'initial_client_dna',confirmationEventId}});
        expect(value.review?.status).toBe('blocked');
      }
    }
    const body={requestId,expectedRev:1,expectedTaskVersion:(await input()).expectedTaskVersion,artifactId:artifacts[1],confirmationEventId};
    const actionId=randomUUID();
    const event:NativeReviewSubmission={...body,v:1,kind:'native_review',eventId:`desk:${actionId}`,actionId,taskId,actor:{userId:actorId,role:'operator'}};
    return {artifacts,body,event,actionId,confirmationEventId};
  }

  beforeEach(async()=>{
    clientId=randomUUID();taskId=randomUUID();requestId=randomUUID();designId=`initial_${randomUUID()}`;
    jobs=new Map();exports=0;remote.mockClear();pptx=(await checkedCanvaExportFixture('Initial exact date 2026')).bytes;
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Initial manual fixture')`.execute(db);
    await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title,description,state,version)
      VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Initial manual fixture','','received',1)`.execute(db);
    const source={payload:{sourcePlatform:'telegram',sourceChannelId:'73006000',lifecycleOwner:'restate',autoGenerate:false,exactCopy:[{text:'Initial exact date 2026'}]}};
    await sql`INSERT INTO hawa.task_events(tenant_id,task_id,event_type,aggregate_version,actor_type,actor_id,correlation_id,data)
      VALUES(${tenantId}::uuid,${taskId}::uuid,'task.created',1,'system',null,${randomUUID()}::uuid,${JSON.stringify(source)}::jsonb)`.execute(db);
    const dna={tenantId,clientId,version:1,status:'active',fonts:[{family:'Verdana',license:'test fixture',supportedLocales:['en']}]};
    await sql`INSERT INTO hawa.client_dna_versions(tenant_id,client_id,version,status,dna,content_hash,created_by)
      VALUES(${tenantId}::uuid,${clientId}::uuid,1,'active',${JSON.stringify(dna)}::jsonb,${computeDnaHash(dna)},${actorId}::uuid)`.execute(db);
    const canva=new CanvaConnectService(db,options);
    const auth=await canva.startAuthorization(scope);await canva.finishAuthorization(auth.state,auth.state,'test-code');remote.mockClear();
  });
  afterAll(()=>db.destroy());
  afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

  it('completes preparation, signed owner review recovery and explicit approval without rewinding a later stage',async()=>{
    const prepared=await preparedCaptures();
    expect(await revisions()).toBe(0);
    expect(await requestRow()).toMatchObject({stage:'manual',rev:'1'});
    const secret=['initial','native','fixture'].join('_');vi.stubEnv('HAWA_WORKER_TOKEN',secret);vi.stubEnv('RESTATE_INGRESS_URL','http://initial-native.test');
    // The owner state RequestLifecycle.open saves for a manual request: no run, no design input.
    let owner:OwnerState={v:1,requestId,tenantId,chatId:'73006000',owner:'restate',stage:'manual',rev:1,taskId,
      openEventId:`open:${requestId}`,openSha256:'a'.repeat(64)};
    const context:AutomaticOpenContext={key:requestId,get:async()=>owner,run:async(_name,action)=>action(),
      set:(_name,value)=>{owner=value;},send:()=>{throw new Error('No requester notice');},startDesign:()=>{throw new Error('No generation');}};
    let loseCoreReply=true;
    const core={post:async<T>(path:string,body:unknown):Promise<T>=>{
      const response=await app().request(`/v1${path}`,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify(body)});
      if(!response.ok)throw new Error(await response.text());
      if(path.endsWith('/native-review')&&loseCoreReply){loseCoreReply=false;throw new Error('Lost Core projection reply');}
      return await response.json() as T;
    }};
    let loseReply=true;
    const gateway=vi.fn<typeof fetch>(async(target,init)=>{
      const signed=JSON.parse(String(init?.body));
      if(String(target).endsWith('/nativeReview')){
        expect(checkSignedNativeReview(signed,secret)).toBe('ok');
        const result=await recordNativeReview(context,core,signed.event);
        if(loseReply){loseReply=false;throw new Error('Lost gateway reply after durable state save');}
        return Response.json(result);
      }
      expect(checkSignedOfficeDecision(signed,secret)).toBe('ok');
      return Response.json(await recordOfficeRevision(context,core,signed.event));
    });vi.stubGlobal('fetch',gateway);
    expect((await post(`/tasks/${taskId}/native-review`,prepared.body,prepared.actionId)).status).toBe(503);
    expect(owner?.stage).toBe('manual');expect(await requestRow()).toMatchObject({stage:'in_review',rev:'2'});
    expect((await post(`/tasks/${taskId}/native-review`,prepared.body,prepared.actionId)).status).toBe(503);
    expect(owner).toMatchObject({stage:'in_review',rev:2,origin:'manual'});expect(owner).not.toHaveProperty('runId');
    const replay=await post(`/tasks/${taskId}/native-review`,prepared.body,prepared.actionId);
    expect(replay.status,await replay.clone().text()).toBe(200);
    const review=await replay.json() as {revisionId:string;qaPassed:boolean;rev:number};expect(review).toMatchObject({qaPassed:true,rev:2});
    expect(gateway).toHaveBeenCalledTimes(3);expect(await revisions()).toBe(1);
    const manifest=(await sql<{neutral_manifest:Record<string,unknown>}>`SELECT neutral_manifest FROM hawa.design_revisions WHERE id=${review.revisionId}::uuid`.execute(db)).rows[0].neutral_manifest;
    expect(manifest).toMatchObject({copy:['Initial exact date 2026'],nativeVerification:'unverified',
      nativeInitialHandoff:{confirmationEventId:prepared.confirmationEventId,requestId,separateDesign:'operator_reviewed'}});
    expect(manifest).not.toHaveProperty('nativeRevisionHandoff');
    expect((await sql`SELECT id FROM hawa.approvals WHERE task_id=${taskId}::uuid`.execute(db)).rows).toHaveLength(0);
    // A revision request would route requester replies into automatic generation; it is refused.
    const revise=await post(`/tasks/${taskId}/revisions/${review.revisionId}/decisions`,{action:'revision_requested',
      revisionRequest:{scope:'layout',category:'aesthetic_preference',targetNodes:['date'],priority:'medium',isReusableFeedback:false,comment:'Move the date lower.'}},randomUUID(),
      {Authorization:'Bearer test_art_director_bearer'});
    expect(revise.status,await revise.clone().text()).toBe(409);expect(owner?.stage).toBe('in_review');
    expect(await requestRow()).toMatchObject({stage:'in_review',rev:'2'});
    const approval=await post(`/tasks/${taskId}/revisions/${review.revisionId}/decisions`,
      {action:'approve',reason:'Synthetic reviewer checked this fixture.',pinnedExportIds:prepared.artifacts},randomUUID(),{Authorization:'Bearer test_art_director_bearer'});
    expect(approval.status,await approval.clone().text()).toBe(201);expect(owner?.stage).toBe('approved');
    expect(await requestRow()).toMatchObject({stage:'approved',rev:'3'});
    const old=await post(`/tasks/${taskId}/native-review`,prepared.body,prepared.actionId);expect(old.status).toBe(200);
    expect(owner?.stage).toBe('approved');expect(await requestRow()).toMatchObject({stage:'approved',rev:'3'});
    const altered=await post(`/tasks/${taskId}/native-review`,{...prepared.body,expectedTaskVersion:prepared.body.expectedTaskVersion+1},prepared.actionId);
    expect(altered.status).toBe(409);
    expect(exports).toBe(2);expect(await revisions()).toBe(1);
  });

  it('replays a committed projection on fresh restricted runtime connections without a second review or QA',async()=>{
    const p=await preparedCaptures(),runtimeUrl=new URL(url!);runtimeUrl.searchParams.set('options','-c role=hawa_app');
    const first=createDb(runtimeUrl.toString());
    const result=await projectLifecycleNativeReview(first,tenantId,p.event);await first.destroy();
    expect(result).toMatchObject({accepted:true,rev:2,stage:'in_review',qaPassed:true});
    const second=createDb(runtimeUrl.toString());
    try{
      expect(await projectLifecycleNativeReview(second,tenantId,p.event)).toEqual(result);
      await expect(projectLifecycleNativeReview(second,tenantId,{...p.event,expectedTaskVersion:p.event.expectedTaskVersion+1}))
        .rejects.toMatchObject({code:'NATIVE_REVIEW_CONFLICT'});
    }finally{await second.destroy();}
    expect((await sql`SELECT id FROM hawa.qc_runs WHERE task_id=${taskId}::uuid`.execute(db)).rows).toHaveLength(1);
    expect(await requestRow()).toMatchObject({stage:'in_review',rev:'2'});
  });

  it('confirms and resolves the initial policy across fresh restricted runtime connections',async()=>{
    await openRequest();
    expect((await post(`/tasks/${taskId}/canva-binding`,{editUrl:`https://www.canva.com/design/${designId}/edit`},randomUUID(),headers())).status).toBe(201);
    const body=await input(),runtimeUrl=new URL(url!);runtimeUrl.searchParams.set('options','-c role=hawa_app');
    const { confirmNativeCopy }=await import('../src/services/initial-native-handoff.js');
    const { resolveManualExportPolicy }=await import('../src/services/canva-export-policy.js');
    const runtime=createDb(runtimeUrl.toString());
    let confirmationEventId='';
    try{
      confirmationEventId=(await withRlsContext(runtime,{tenantId,userId:actorId,role:'operator'},trx=>
        confirmNativeCopy(trx,{...scope,nativeRecovery:{requestId,rev:1}},taskId,randomUUID(),body))).confirmationEventId;
    }finally{await runtime.destroy();}
    const peer=createDb(runtimeUrl.toString());
    try{
      const policy=await withRlsContext(peer,{tenantId,userId:actorId,role:'operator'},trx=>
        resolveManualExportPolicy(trx,tenantId,taskId,clientId,{...scope,nativeRecovery:{requestId,rev:1}}));
      expect(policy).toMatchObject({kind:'initial_client_dna',copy:body.copy,confirmationEventId,taskId});
    }finally{await peer.destroy();}
  });

  it('requires explicit human checks, keyed replay and the current basis before recording copy',async()=>{
    await openRequest();
    await expect(post(`/tasks/${taskId}/canva/revision-copy`,{expectedTaskVersion:1,basisSha256:'a'.repeat(64),copy:['x'],reviewedCurrentDesign:true,separateRequestDesign:true},randomUUID(),headers()))
      .resolves.toMatchObject({status:409});
    expect((await post(`/tasks/${taskId}/canva-binding`,{editUrl:`https://www.canva.com/design/${designId}/edit`},randomUUID(),headers())).status).toBe(201);
    const body=await input();
    for(const patch of [{separateRequestDesign:false},{reviewedCurrentDesign:false},{copy:[]},{separateRequestDesign:undefined}]){
      const response=await post(`/tasks/${taskId}/canva/revision-copy`,{...body,...patch},randomUUID(),headers());
      expect(response.status,JSON.stringify(patch)).toBe(422);
    }
    // Without the explicit manual request scope, a lifecycle-owned task stays closed.
    expect((await post(`/tasks/${taskId}/canva/revision-copy`,body)).status).toBe(409);
    const key=randomUUID();
    const outcomes=await Promise.all([post(`/tasks/${taskId}/canva/revision-copy`,body,key,headers()),post(`/tasks/${taskId}/canva/revision-copy`,body,key,headers())]);
    expect(outcomes.map(r=>r.status)).toEqual([200,200]);
    const ids=await Promise.all(outcomes.map(async r=>(await r.json() as {confirmationEventId:string}).confirmationEventId));
    expect(new Set(ids).size).toBe(1);
    expect((await post(`/tasks/${taskId}/canva/revision-copy`,{...body,copy:['Changed']},key,headers())).status).toBe(409);
    expect((await post(`/tasks/${taskId}/canva/revision-copy`,body,randomUUID(),headers())).status).toBe(409);
    expect(await state()).toMatchObject({kind:'initial',confirmedEventId:ids[0],copy:body.copy,nativeRecovery:{requestId,rev:1}});
    expect(exports).toBe(0);
  });

  it('refuses export before copy confirmation and a design already bound to another task',async()=>{
    await openRequest();
    const otherTask=randomUUID(),taken=`taken_${randomUUID()}`;
    await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title,description,state,version)
      VALUES(${otherTask}::uuid,${tenantId}::uuid,${clientId}::uuid,'Other fixture','','received',1)`.execute(db);
    await sql`INSERT INTO hawa.canva_bindings(id,tenant_id,task_id,client_id,canva_design_id,edit_url,status,version)
      VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${otherTask}::uuid,${clientId}::uuid,${taken},${`https://www.canva.com/design/${taken}/edit`},'bound',1)`.execute(db);
    expect((await post(`/tasks/${taskId}/canva-binding`,{editUrl:`https://www.canva.com/design/${taken}/edit`},randomUUID(),headers())).status).toBe(409);
    expect((await post(`/tasks/${taskId}/canva-binding`,{editUrl:`https://www.canva.com/design/${designId}/edit`},randomUUID(),headers())).status).toBe(201);
    for(const format of ['png','pptx'])
      expect((await post(`/tasks/${taskId}/canva/exports`,{format,expectedVersion:1},randomUUID(),headers())).status).toBe(409);
    expect(exports).toBe(0);
  });

  it.each([
    ['an automatic request',{autoGenerate:true}],
    ['an automatic request that fell back to manual after its run',{autoGenerate:true,stage:'manual',rev:2}],
    ['a stale request revision header',{}],
    ['a request past the manual stage',{stage:'in_review',rev:2}],
  ])('fences preparation for %s without remote work',async(label,opts)=>{
    await openRequest(opts);
    const rev=label.startsWith('a stale')?2:(opts as {rev?:number}).rev??1;
    const response=await post(`/tasks/${taskId}/canva-binding`,{editUrl:`https://www.canva.com/design/${designId}/edit`},randomUUID(),headers(rev));
    expect(response.status,label).toBe(409);
    for(const route of ['/canva/design','/canva/generate','/canva/studio'])
      expect((await post(`/tasks/${taskId}${route}`,{},randomUUID(),headers(rev))).status).toBe(409);
    expect(remote).not.toHaveBeenCalled();
    expect((await sql`SELECT id FROM hawa.canva_bindings WHERE task_id=${taskId}::uuid`.execute(db)).rows).toHaveLength(0);
  });

  it('refuses a task that already has Studio run state rather than adopting it',async()=>{
    await openRequest();
    await new DesignStudioRepository(db).createRun({id:randomUUID(),tenantId,taskId,clientId,actorId,requestKey:randomUUID(),requestHash:'synthetic',
      request:{pipelineV3:true},tier:'standard',budget:{maxUsd:2,maxCalls:24,spentUsd:0,calls:0}});
    await expect(tx(trx=>lockNativeRecovery(trx,{...scope,nativeRecovery:{requestId,rev:1}},taskId))).rejects.toMatchObject({code:'NATIVE_RECOVERY_STALE'});
    expect((await post(`/tasks/${taskId}/canva-binding`,{editUrl:`https://www.canva.com/design/${designId}/edit`},randomUUID(),headers())).status).toBe(409);
    expect(remote).not.toHaveBeenCalled();
  });

  it('serializes preparation with owner transitions and rechecks scope before export dispatch',async()=>{
    await openRequest();
    await tx(async trx=>{
      await lockNativeRecovery(trx,{...scope,nativeRecovery:{requestId,rev:1}},taskId);
      await expect(db.transaction().execute(async peer=>{
        await sql`SET LOCAL lock_timeout='100ms'`.execute(peer);
        await sql`UPDATE hawa.requests SET rev=2,stage='in_review' WHERE request_id=${requestId}::uuid`.execute(peer);
      })).rejects.toThrow('lock timeout');
    });
    expect((await post(`/tasks/${taskId}/canva-binding`,{editUrl:`https://www.canva.com/design/${designId}/edit`},randomUUID(),headers())).status).toBe(201);
    expect((await post(`/tasks/${taskId}/canva/revision-copy`,await input(),randomUUID(),headers())).status).toBe(200);
    const original=remote.getMockImplementation()!;
    remote.mockImplementationOnce(async(target,init)=>{
      await sql`UPDATE hawa.requests SET rev=2,stage='in_review' WHERE request_id=${requestId}::uuid`.execute(db);
      return original(target,init);
    });
    expect((await post(`/tasks/${taskId}/canva/exports`,{format:'png',expectedVersion:1},randomUUID(),headers())).status).toBe(409);
    expect(exports).toBe(0);
  });

  it.each(['confirmation','binding','task','capture','disabled actor'])('refuses a changed %s before owned review without advancing the request',async kind=>{
    const prepared=await preparedCaptures();
    if(kind==='confirmation'){
      expect((await post(`/tasks/${taskId}/canva/revision-copy`,await input(),randomUUID(),headers())).status).toBe(200);
      prepared.event.expectedTaskVersion=(await input()).expectedTaskVersion;
    }
    if(kind==='binding')await sql`UPDATE hawa.canva_bindings SET version=version+1 WHERE task_id=${taskId}::uuid`.execute(db);
    if(kind==='task')prepared.event.expectedTaskVersion++;
    if(kind==='capture')prepared.event.artifactId=randomUUID();
    if(kind==='disabled actor')await sql`UPDATE hawa.users SET disabled_at=now() WHERE id=${actorId}::uuid`.execute(db);
    try{await expect(projectLifecycleNativeReview(db,tenantId,prepared.event)).rejects.toBeInstanceOf(Error);}
    finally{await sql`UPDATE hawa.users SET disabled_at=NULL WHERE id=${actorId}::uuid`.execute(db);}
    expect(await revisions()).toBe(0);expect(await requestRow()).toMatchObject({stage:'manual',rev:'1'});
  });

  it('invalidates frozen initial policy after a new confirmation or changed binding and holds policy-less captures',async()=>{
    await openRequest();
    expect((await post(`/tasks/${taskId}/canva-binding`,{editUrl:`https://www.canva.com/design/${designId}/edit`},randomUUID(),headers())).status).toBe(201);
    const { resolveManualExportPolicy }=await import('../src/services/canva-export-policy.js');
    const current=(metadata:unknown)=>tx(async trx=>(await sql<{ok:boolean}>`SELECT hawa.canva_export_policy_current(${tenantId}::uuid,${clientId}::uuid,${JSON.stringify(metadata)}::jsonb) ok`.execute(trx)).rows[0].ok);
    expect((await post(`/tasks/${taskId}/canva/revision-copy`,await input(),randomUUID(),headers())).status).toBe(200);
    const policy=await tx(trx=>resolveManualExportPolicy(trx,tenantId,taskId,clientId,{...scope,nativeRecovery:{requestId,rev:1}}));
    expect(await current({checkingPolicy:policy,taskId})).toBe(true);
    expect(await current({taskId})).toBe(false);
    expect(await current({checkingPolicy:{...policy,kind:'manual_client_dna'},taskId})).toBe(false);
    expect((await post(`/tasks/${taskId}/canva/revision-copy`,{...await input(),copy:['Next exact date 2027']},randomUUID(),headers())).status).toBe(200);
    expect(await current({checkingPolicy:policy,taskId})).toBe(false);
    const next=await tx(trx=>resolveManualExportPolicy(trx,tenantId,taskId,clientId,{...scope,nativeRecovery:{requestId,rev:1}}));
    expect(await current({checkingPolicy:next,taskId})).toBe(true);
    await sql`UPDATE hawa.canva_bindings SET version=version+1 WHERE task_id=${taskId}::uuid`.execute(db);
    expect(await current({checkingPolicy:next,taskId})).toBe(false);
  });

  it('refuses a Core revision request for a request opened without a run',async()=>{
    const p=await preparedCaptures();
    const review=await projectLifecycleNativeReview(db,tenantId,p.event);
    if(!review.accepted)throw new Error('Expected native review');
    await expect(projectLifecycleOfficeDecision(db,{requestId,tenantId,taskId,revisionId:review.revisionId,actionId:randomUUID(),
      actor:{userId:actorId,role:'art_director'},reason:'Move the date lower.',expectedRev:2,rev:3,key:`${requestId}:3:officeDecision:desk:${randomUUID()}`}))
      .rejects.toMatchObject({code:'WRONG_STAGE'});
    expect(await requestRow()).toMatchObject({stage:'in_review',rev:'2'});
  });

});
