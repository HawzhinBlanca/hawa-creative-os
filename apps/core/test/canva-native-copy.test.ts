import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createDb,sql,withRlsContext} from '@hawa/db';
import {CanvaConnectService} from '../src/services/canva-connect-service.js';
import {nativeRevisionHandoff} from '../src/services/native-revision-handoff.js';
import type {NativeActorScope} from '../src/services/lifecycle-native-scope.js';

const url=process.env.HAWA_ISOLATED_TEST_DB;
describe.skipIf(!url)('durable native-copy candidate, runtime PostgreSQL and synthetic Canva',()=>{
  const db=createDb(url||'postgres://localhost/hawa_repair');
  const runtimeUrl=new URL(url||'postgres://localhost/hawa_repair');runtimeUrl.searchParams.set('options','-c role=hawa_app');
  const runtime=createDb(runtimeUrl.toString());
  const tenantId='00000000-0000-4000-a000-000000000001',actorId='00000000-0000-4000-b000-000000000001';
  let clientId:string,parentId:string,taskId:string,requestId:string,sourceId:string,copyId:string;
  let scope:NativeActorScope,service:CanvaConnectService,posts:number,updatedAt:number;
  let send:'pending'|'immediate'|'lost'|'refused'|'server'|'timeout',read:'success'|'failed'|'unavailable'|'pending'|'contradictory';
  let afterDataset:(()=>Promise<void>)|undefined,readHook:(()=>Promise<Response>)|undefined;
  const design=(id:string)=>({id,created_at:100,updated_at:updatedAt,page_count:1,urls:{edit_url:`https://www.canva.com/design/${id}/edit`,view_url:`https://www.canva.com/design/${id}/view`}});
  const remote=vi.fn<typeof fetch>(async(input,init)=>{
    const u=String(input);
    if(u.endsWith('/oauth/token'))return Response.json({access_token:randomUUID(),refresh_token:randomUUID(),expires_in:3600});
    if(u.endsWith('/dataset')){await afterDataset?.();return Response.json({dataset:{'Event date':{type:'text'},Image:{type:'image'}}});}
    if(u.includes('/designs/'))return Response.json({design:design(sourceId)});
    if(u.endsWith('/autofills')&&init?.method==='POST'){
      const claimed=(await sql<{status:string;metadata:{nativeTextCopy:{prepared:{text:Record<string,string>}}}}> `SELECT status,metadata FROM hawa.canva_remote_operations
        WHERE task_id=${taskId}::uuid AND status='creating'`.execute(db)).rows;
      expect(claimed).toHaveLength(1);expect(claimed[0].metadata.nativeTextCopy.prepared.text).toEqual(JSON.parse(String(init.body)).data['Event date']?{'Event date':JSON.parse(String(init.body)).data['Event date'].text}:{});
      posts++;
      if(send==='lost')throw new TypeError('lost after acceptance');
      if(send==='refused')return new Response('private',{status:403});
      if(send==='server')return new Response('private',{status:503});
      if(send==='timeout')return new Response('private',{status:408});
      return Response.json({job:send==='immediate'?{id:'job_one',status:'success',result:{type:'create_design',design:design(copyId)}}:{id:'job_one',status:'in_progress'}});
    }
    if(u.endsWith('/autofills/job_one')){
      if(readHook)return readHook();
      if(read==='unavailable')return new Response('private',{status:404});
      if(read==='contradictory')return Response.json({job:{id:'job_one',status:'failed',result:{type:'create_design',design:design(copyId)},error:{code:'autofill_error'}}});
      return Response.json({job:read==='success'?{id:'job_one',status:'success',result:{type:'create_design',design:design(copyId)}}:
        read==='failed'?{id:'job_one',status:'failed',error:{code:'autofill_error'}}:{id:'job_one',status:'in_progress'}});
    }
    throw new Error('Unexpected synthetic transport');
  });
  const options={clientId:'synthetic',clientSecret:'synthetic',encryptionKey:'a1'.repeat(32),redirectUri:'http://localhost:8772/v1/integrations/canva/callback',fetcher:remote,retryDelaysMs:{read:[],create:[]}};
  beforeEach(async()=>{
    clientId=randomUUID();parentId=randomUUID();taskId=randomUUID();requestId=randomUUID();sourceId=`DA_${randomUUID()}`;copyId=`DA_${randomUUID()}`;
    scope={tenantId,actorId,role:'operator',nativeRecovery:{requestId,rev:4}};
    posts=0;updatedAt=200;send='pending';read='success';afterDataset=undefined;readHook=undefined;remote.mockClear();
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Native candidate fixture')`.execute(db);
    for(const id of [parentId,taskId]){
      await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title,description,state,version)
        VALUES(${id}::uuid,${tenantId}::uuid,${clientId}::uuid,'Native candidate fixture','','failed_operator',1)`.execute(db);
      const data={studioOptions:id===taskId?{parentTaskId:parentId,revisionDirective:'Change date only'}:{}};
      await sql`INSERT INTO hawa.task_events(tenant_id,task_id,event_type,aggregate_version,actor_type,actor_id,correlation_id,data)
        VALUES(${tenantId}::uuid,${id}::uuid,'task.created',1,'user',${actorId},${randomUUID()}::uuid,${JSON.stringify(data)}::jsonb)`.execute(db);
    }
    await sql`INSERT INTO hawa.canva_bindings(id,tenant_id,task_id,client_id,canva_design_id,edit_url,status,version)
      VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${parentId}::uuid,${clientId}::uuid,${sourceId},${`https://www.canva.com/design/${sourceId}/edit`},'bound',1)`.execute(db);
    await sql`INSERT INTO hawa.requests(request_id,tenant_id,root_task_id,current_task_id,owner,stage,rev,chat_id)
      VALUES(${requestId}::uuid,${tenantId}::uuid,${parentId}::uuid,${taskId}::uuid,'restate','manual',4,'73004000')`.execute(db);
    await sql`UPDATE hawa.tasks SET request_id=${requestId}::uuid WHERE id=${taskId}::uuid`.execute(db);
    const root=new CanvaConnectService(db,options),auth=await root.startAuthorization(scope);
    await root.finishAuthorization(auth.state,auth.state,'synthetic-code');
    service=new CanvaConnectService(runtime,options);remote.mockClear();
  });
  afterAll(async()=>{await runtime.destroy();await db.destroy();});
  afterEach(async()=>{await sql`DELETE FROM hawa.canva_remote_operations WHERE task_id=${taskId}::uuid`.execute(db);});
  async function input(){
    const h=await withRlsContext(runtime,{tenantId,userId:actorId,role:'operator'},trx=>nativeRevisionHandoff(trx,tenantId,taskId));
    if(!h?.available)throw new Error('Missing fixture handoff');
    return {expectedTaskVersion:h.taskVersion,basisSha256:h.basisSha256,nativeUpdatedAt:200,text:{'Event date':'ڕۆژ ٢٠٢٦ — 10/02\n'}};
  }
  const create=async(key=randomUUID())=>service.createNativeTextCopyCandidate(scope,taskId,key,await input());

  it('commits before send and reconciles on a fresh runtime without binding or advancing the request',async()=>{
    const first=await create();expect(first.status).toBe('submitted');expect(posts).toBe(1);
    const peer=createDb(runtimeUrl.toString());
    try{
      const resumed=await new CanvaConnectService(peer,options).reconcileNativeTextCopy(scope,taskId,first.operationId);
      expect(resumed).toMatchObject({status:'retrieved',designId:copyId,preservation:'unverified',approvalReady:false});
    }finally{await peer.destroy();}
    expect(posts).toBe(1);
    expect((await sql`SELECT id FROM hawa.canva_bindings WHERE task_id=${taskId}::uuid`.execute(db)).rows).toHaveLength(0);
    const request=(await sql<{stage:string;rev:string}>`SELECT stage,rev FROM hawa.requests WHERE request_id=${requestId}::uuid`.execute(db)).rows[0];
    expect(request.stage).toBe('manual');expect(Number(request.rev)).toBe(4);
    expect(Number((await sql<{version:string}>`SELECT version FROM hawa.tasks WHERE id=${taskId}::uuid`.execute(db)).rows[0].version)).toBe(1);
  });
  it('serializes concurrent same-key claims and refuses changed input under that key',async()=>{
    const body=await input(),key=randomUUID();
    const results=await Promise.all([service.createNativeTextCopyCandidate(scope,taskId,key,body),service.createNativeTextCopyCandidate(scope,taskId,key,body)]);
    expect(new Set(results.map(r=>r.operationId)).size).toBe(1);expect(posts).toBe(1);
    await expect(service.createNativeTextCopyCandidate(scope,taskId,key,{...body,text:{'Event date':'different'}})).rejects.toMatchObject({code:'CANVA_IDEMPOTENCY_CONFLICT'});
    await service.createNativeTextCopyCandidate(scope,taskId,key,body);expect(posts).toBe(1);
  });
  it.each(['lost','server','timeout'] as const)('holds %s results across fresh keys and sweeping',async mode=>{
    send=mode;const first=await create();expect(first.status).toBe('uncertain');
    await expect(create()).rejects.toMatchObject({code:'CANVA_CREATE_CONFLICT'});
    await sql`UPDATE hawa.canva_remote_operations SET updated_at=now()-interval '2 days',created_at=now()-interval '2 days' WHERE id=${first.operationId}::uuid`.execute(db);
    await service.sweepStrandedOperations(scope,{maxAgeMinutes:0,giveUpMinutes:0});
    await expect(create()).rejects.toMatchObject({code:'CANVA_CREATE_CONFLICT'});expect(posts).toBe(1);
  });
  it('a definite refusal permits a fresh key but never resends the old key',async()=>{
    send='refused';const key=randomUUID(),body=await input();
    expect((await service.createNativeTextCopyCandidate(scope,taskId,key,body)).status).toBe('failed');
    send='pending';expect((await service.createNativeTextCopyCandidate(scope,taskId,key,body)).status).toBe('failed');
    expect(posts).toBe(1);expect((await create()).status).toBe('submitted');expect(posts).toBe(2);
  });
  it('keeps the original job after unavailable reads and recovers after the request advances',async()=>{
    const first=await create();read='unavailable';
    expect((await service.reconcileNativeTextCopy(scope,taskId,first.operationId)).status).toBe('uncertain');
    await expect(create()).rejects.toMatchObject({code:'CANVA_CREATE_CONFLICT'});
    await sql`UPDATE hawa.requests SET rev=5 WHERE request_id=${requestId}::uuid`.execute(db);
    read='success';expect((await service.reconcileNativeTextCopy(scope,taskId,first.operationId)).status).toBe('retrieved');expect(posts).toBe(1);
  });
  it('sweeps an original pending native job without creating another copy',async()=>{
    const first=await create();
    await sql`UPDATE hawa.canva_remote_operations SET created_at=now()-interval '2 hours' WHERE id=${first.operationId}::uuid`.execute(db);
    expect((await service.sweepStrandedOperations(scope,{maxAgeMinutes:0})).settled).toContainEqual(expect.objectContaining({id:first.operationId,status:'retrieved',designId:copyId}));expect(posts).toBe(1);
  });
  it.each(['request','binding','native'] as const)('refuses changed %s before admission',async change=>{
    afterDataset=async()=>{
      if(change==='request')await sql`UPDATE hawa.requests SET rev=5 WHERE request_id=${requestId}::uuid`.execute(db);
      if(change==='binding')await sql`UPDATE hawa.canva_bindings SET version=version+1 WHERE task_id=${parentId}::uuid`.execute(db);
      if(change==='native')updatedAt++;
    };
    await expect(create()).rejects.toBeInstanceOf(Error);expect(posts).toBe(0);
    expect((await sql`SELECT id FROM hawa.canva_remote_operations WHERE task_id=${taskId}::uuid`.execute(db)).rows).toHaveLength(0);
  });
  it('refuses unobserved fields and foreign actor/tenant/request scope',async()=>{
    const body=await input();
    await expect(service.createNativeTextCopyCandidate(scope,taskId,randomUUID(),{...body,text:{Missing:'value'}})).rejects.toThrow('not an observed text field');
    await expect(service.createNativeTextCopyCandidate({...scope,nativeRecovery:undefined},taskId,randomUUID(),body)).rejects.toMatchObject({code:'LIFECYCLE_OWNED'});
    await expect(service.createNativeTextCopyCandidate({...scope,tenantId:randomUUID()},taskId,randomUUID(),body)).rejects.toBeInstanceOf(Error);
    expect(posts).toBe(0);
    const first=await create();
    await expect(service.reconcileNativeTextCopy({...scope,actorId:randomUUID()},taskId,first.operationId)).rejects.toMatchObject({status:404});
    await expect(service.reconcileNativeTextCopy({...scope,tenantId:randomUUID()},taskId,first.operationId)).rejects.toMatchObject({status:404});
  });
  it('does not let a late failed read demote a completed result',async()=>{
    const first=await create();let release!:()=>void,entered!:()=>void;
    const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
    readHook=async()=>{entered();await gate;return new Response('',{status:404});};
    const slow=service.reconcileNativeTextCopy(scope,taskId,first.operationId);await ready;readHook=undefined;
    expect((await service.reconcileNativeTextCopy(scope,taskId,first.operationId)).status).toBe('retrieved');release();
    expect((await slow).status).toBe('retrieved');expect(posts).toBe(1);
  });
  it('database guards preserve admitted inputs and acquired identities',async()=>{
    const first=await create();
    await expect(sql`UPDATE hawa.canva_remote_operations SET request_hash='changed' WHERE id=${first.operationId}::uuid`.execute(db)).rejects.toMatchObject({code:'23514'});
    await expect(sql`UPDATE hawa.canva_remote_operations SET metadata=metadata-'nativeTextCopy' WHERE id=${first.operationId}::uuid`.execute(db)).rejects.toMatchObject({code:'23514'});
    await expect(sql`UPDATE hawa.canva_remote_operations SET remote_job_id='other' WHERE id=${first.operationId}::uuid`.execute(db)).rejects.toMatchObject({code:'23514'});
    await service.reconcileNativeTextCopy(scope,taskId,first.operationId);
    await expect(sql`UPDATE hawa.canva_remote_operations SET status='failed' WHERE id=${first.operationId}::uuid`.execute(db)).rejects.toMatchObject({code:'23514'});
  });
  it('retains an immediate completed copy and permits a new attempt only after positive job failure',async()=>{
    const first=await create();read='failed';
    expect((await service.reconcileNativeTextCopy(scope,taskId,first.operationId)).status).toBe('failed');
    send='immediate';const next=await create();expect(next).toMatchObject({status:'retrieved',designId:copyId,approvalReady:false});
    expect(posts).toBe(2);await expect(create()).rejects.toMatchObject({code:'CANVA_CREATE_CONFLICT'});
  });
  it('retains the committed claim when receipt persistence fails after remote acceptance',async()=>{
    await sql.raw(`CREATE FUNCTION hawa.test_copy_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.metadata->>'method'='native_text_copy' AND OLD.remote_job_id IS NULL AND NEW.remote_job_id IS NOT NULL
      THEN RAISE EXCEPTION 'injected receipt persistence failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER test_copy_receipt_failure BEFORE UPDATE ON hawa.canva_remote_operations FOR EACH ROW EXECUTE FUNCTION hawa.test_copy_receipt_failure();`).execute(db);
    const key=randomUUID(),body=await input();
    try {await expect(service.createNativeTextCopyCandidate(scope,taskId,key,body)).rejects.toThrow('injected receipt persistence failure');}
    finally {await sql.raw('DROP TRIGGER test_copy_receipt_failure ON hawa.canva_remote_operations; DROP FUNCTION hawa.test_copy_receipt_failure();').execute(db);}
    const restarted=new CanvaConnectService(runtime,options);
    const replay=await restarted.createNativeTextCopyCandidate(scope,taskId,key,body);
    expect(replay).toMatchObject({status:'creating',remoteJobId:null,designId:null});
    await expect(create()).rejects.toMatchObject({code:'CANVA_CREATE_CONFLICT'});expect(posts).toBe(1);
  });
  it('cannot turn a contradictory failed-with-design response into retry permission',async()=>{
    const first=await create();read='contradictory';
    expect((await service.reconcileNativeTextCopy(scope,taskId,first.operationId)).status).toBe('uncertain');
    await expect(create()).rejects.toMatchObject({code:'CANVA_CREATE_CONFLICT'});expect(posts).toBe(1);
    read='success';expect((await service.reconcileNativeTextCopy(scope,taskId,first.operationId)).status).toBe('retrieved');
  });
});
