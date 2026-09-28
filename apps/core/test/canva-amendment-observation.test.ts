import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql } from '@hawa/db';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { createApp } from '../src/app.js';

const url=process.env.HAWA_ISOLATED_TEST_DB;
describe.skipIf(!url)('scoped native amendment observations, synthetic Canva and real PostgreSQL',()=>{
  const db=createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId='00000000-0000-4000-a000-000000000001',actorId='00000000-0000-4000-b000-000000000001';
  const scope={tenantId,actorId,role:'operator'};
  let clientId:string,taskId:string,bindingId:string,designId:string,service:CanvaConnectService;
  let capabilitiesStatus:number,datasetStatus:number,updatedAt:number,afterDataset:(()=>Promise<void>)|undefined;
  const remote=vi.fn<typeof fetch>(async input=>{
    const u=String(input);
    if(u.endsWith('/oauth/token'))return Response.json({access_token:randomUUID(),refresh_token:randomUUID(),expires_in:3600});
    if(u.endsWith('/users/me/capabilities'))return capabilitiesStatus===200?Response.json({capabilities:['autofill']}):new Response('private provider body',{status:capabilitiesStatus});
    if(u.endsWith('/dataset')){
      await afterDataset?.();
      return datasetStatus===200?Response.json({dataset:{'Event date':{type:'text'},Portrait:{type:'image'}}}):new Response('private provider body',{status:datasetStatus});
    }
    if(u.endsWith(`/designs/${designId}`))return Response.json({design:{id:designId,created_at:100,updated_at:updatedAt,page_count:1,
      urls:{edit_url:`https://www.canva.com/design/${designId}/edit`,view_url:`https://www.canva.com/design/${designId}/view`}}});
    throw new Error('Unexpected synthetic request');
  });
  const options={clientId:'synthetic',clientSecret:'synthetic',encryptionKey:'a1'.repeat(32),
    redirectUri:'http://localhost:8772/v1/integrations/canva/callback',fetcher:remote,retryDelaysMs:{read:[]}};
  beforeEach(async()=>{
    clientId=randomUUID();taskId=randomUUID();bindingId=randomUUID();designId=`DA_${randomUUID()}`;
    capabilitiesStatus=200;datasetStatus=200;updatedAt=200;afterDataset=undefined;
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Native capability fixture')`.execute(db);
    await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title,description,state,version)
      VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Native capability fixture','','failed_operator',1)`.execute(db);
    await sql`INSERT INTO hawa.canva_bindings(id,tenant_id,task_id,client_id,canva_design_id,edit_url,status,version)
      VALUES(${bindingId}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,${designId},${`https://www.canva.com/design/${designId}/edit`},'bound',1)`.execute(db);
    service=new CanvaConnectService(db,options);
    const auth=await service.startAuthorization(scope);await service.finishAuthorization(auth.state,auth.state,'test-code');remote.mockClear();
  });
  afterAll(()=>db.destroy());
  it('observes exact fields on the app connection without qualifying or writing a design',async()=>{
    const observed=await service.amendmentObservation(scope,taskId);
    expect(observed.nativeAmendmentQualified).toBe(false);
    expect(observed.basis).toMatchObject({taskId,clientId,taskVersion:1,bindingId,bindingVersion:1,designId,nativeUpdatedAt:200});
    expect(observed.capabilities).toEqual({status:'observed',data:['autofill']});
    expect(observed.dataset).toEqual({status:'observed',data:{'Event date':{type:'text'},Portrait:{type:'image'}}});
    expect(remote).toHaveBeenCalledTimes(4);
    expect(remote.mock.calls.every(([,init])=>!init?.method || init.method==='GET')).toBe(true);
    expect(Number((await sql<{version:string}>`SELECT version FROM hawa.tasks WHERE id=${taskId}::uuid`.execute(db)).rows[0].version)).toBe(1);
  });
  it('keeps capability scope failures unknown and dataset access failures separate',async()=>{
    capabilitiesStatus=403;
    const observed=await service.amendmentObservation(scope,taskId);
    expect(observed.capabilities).toMatchObject({status:'unknown',code:'CANVA_CAPABILITIES_SCOPE_OR_ACCESS'});
    expect(observed.dataset.status).toBe('observed');
    expect(JSON.stringify(observed)).not.toContain('private provider body');
    capabilitiesStatus=200;datasetStatus=403;
    const second=await service.amendmentObservation(scope,taskId);
    expect(second.capabilities.status).toBe('observed');expect(second.dataset.status).toBe('forbidden');
  });
  it('reports throttling without qualifying capabilities or hiding the available dataset',async()=>{
    capabilitiesStatus=429;
    const observed=await service.amendmentObservation(scope,taskId);
    expect(observed.capabilities).toMatchObject({status:'unavailable',code:'CANVA_OBSERVATION_RATE_LIMITED'});
    expect(observed.dataset.status).toBe('observed');expect(observed.nativeAmendmentQualified).toBe(false);
  });
  it.each(['task','binding','native'] as const)('refuses a changed %s basis during observation',async change=>{
    afterDataset=async()=>{
      if(change==='task')await sql`UPDATE hawa.tasks SET version=version+1 WHERE id=${taskId}::uuid`.execute(db);
      if(change==='binding')await sql`UPDATE hawa.canva_bindings SET version=version+1 WHERE id=${bindingId}::uuid`.execute(db);
      if(change==='native')updatedAt++;
    };
    await expect(service.amendmentObservation(scope,taskId)).rejects.toMatchObject({status:409,code:'CANVA_OBSERVATION_STALE'});
  });
  it('refuses a foreign tenant before provider access',async()=>{
    await expect(service.amendmentObservation({...scope,tenantId:randomUUID()},taskId)).rejects.toMatchObject({status:404});
    expect(remote).not.toHaveBeenCalled();
  });
  it('the database refuses a cross-client link before any provider operation',async()=>{
    const other=randomUUID();
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${other}::uuid,${tenantId}::uuid,${other},'Other fixture')`.execute(db);
    await expect(sql`UPDATE hawa.canva_bindings SET client_id=${other}::uuid WHERE id=${bindingId}::uuid`.execute(db))
      .rejects.toMatchObject({constraint:'canva_binding_task_client_fk'});
    expect(remote).not.toHaveBeenCalled();
    expect((await service.amendmentObservation(scope,taskId)).basis.clientId).toBe(clientId);
  });
  it('refuses an unbound task before provider access',async()=>{
    await sql`DELETE FROM hawa.canva_bindings WHERE id=${bindingId}::uuid`.execute(db);
    await expect(service.amendmentObservation(scope,taskId)).rejects.toMatchObject({status:409,code:'CANVA_BINDING_REQUIRED'});
    expect(remote).not.toHaveBeenCalled();
  });
  it('exposes only an authenticated, non-cacheable observation route',async()=>{
    const app=createApp({db,canvaOptions:options,extraBearerTokens:{test_operator_bearer:{role:'operator',sub:actorId},test_reviewer_bearer:{role:'reviewer',sub:actorId}}});
    const path=`/v1/tasks/${taskId}/canva/amendment-observation`;
    expect((await app.request(path)).status).toBe(401);expect(remote).not.toHaveBeenCalled();
    expect((await app.request(path,{headers:{Authorization:'Bearer test_reviewer_bearer'}})).status).toBe(403);expect(remote).not.toHaveBeenCalled();
    const response=await app.request(path,{headers:{Authorization:'Bearer test_operator_bearer'}});
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({nativeAmendmentQualified:false});
  });
});
