import { describe,it,expect,beforeAll,beforeEach,afterAll,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb,sql,CanvaBindingRepository,withRlsContext } from '@hawa/db';
import { createSyntheticValidPng } from '../../../packages/integrations/src/canva-capture-pipeline.js';
import { CanvaConnectService,CanvaTokenCipher,downloadCanvaExport } from '../src/services/canva-connect-service.js';
import { createApp } from '../src/app.js';
const url=process.env.HAWA_ISOLATED_TEST_DB;
if(url&&new URL(url).pathname!=='/hawa_repair')throw new Error('Disposable hawa_repair database required');
const key='a1'.repeat(32);
describe('Canva token and download security',()=>{
  it('encrypts with actor-bound integrity and rejects wrong key, tampering or another scope',()=>{
    const c=new CanvaTokenCipher(key),v=c.seal({access_token:'not-plaintext'},'tenant:actor');
    expect(v).not.toContain('not-plaintext');expect(c.open(v,'tenant:actor').access_token).toBe('not-plaintext');
    expect(()=>c.open(v,'tenant:other')).toThrow();expect(()=>new CanvaTokenCipher('b2'.repeat(32)).open(v,'tenant:actor')).toThrow();
    const bytes=Buffer.from(v,'base64');bytes[30]^=1;expect(()=>c.open(bytes.toString('base64'),'tenant:actor')).toThrow();
  });
  it.each(['', 'not-a-url', 'javascript:alert(1)', ':::invalid', 'http://export-download.canva.com/a','https://evil.test/a','https://www.canva.com/a','https://export-download.canva.com.evil.test/a','https://user:pass@export-download.canva.com/a'])('rejects untrusted or malformed export URL %s without network',async u=>{
    const f=vi.fn();await expect(downloadCanvaExport(u,f)).rejects.toThrow();expect(f).not.toHaveBeenCalled();
  });
  it('rejects an oversized stream and never adds bearer credentials or follows redirects',async()=>{
    const f=vi.fn(async()=>new Response(new Uint8Array(26*1024*1024)));
    await expect(downloadCanvaExport('https://export-download.canva.com/file',f)).rejects.toThrow('25 MB');
    expect(f.mock.calls[0][1]).toMatchObject({redirect:'error'});expect(f.mock.calls[0][1]).not.toHaveProperty('headers');
  });
});
describe.skipIf(!url)('Canva Connect service: real isolated PostgreSQL, mocked provider transport',()=>{
  const db=createDb(url||'postgres://localhost/hawa_repair');
  const tenant='00000000-0000-4000-a000-000000000001',actor='00000000-0000-4000-b000-000000000001',clientId=randomUUID();
  const scope={tenantId:tenant,actorId:actor};
  let taskId:string,designId:string,updated:number,jobStatus:string,exportCalls:number,createCalls:number,refreshCalls:number,transportMode:string,bytes:Buffer,service:CanvaConnectService;
  const remote=vi.fn(async (input:any,init:any={})=>{
    const u=String(input);
    if(u.endsWith('/oauth/token')) {
      const body=new URLSearchParams(init.body);expect(init.headers.Authorization).toMatch(/^Basic /);expect(body.has('client_secret')).toBe(false);
      if(body.get('grant_type')==='refresh_token'){refreshCalls++;if(transportMode==='refresh_lost')throw new Error('connection lost');await new Promise(r=>setTimeout(r,20));}
      return Response.json({access_token:'token-'+randomUUID(),refresh_token:'refresh-'+randomUUID(),expires_in:3600});
    }
    if(u.endsWith('/designs')&&init.method==='POST'){
      createCalls++;if(transportMode==='create_lost')throw new Error('connection lost');
      return Response.json({design:{id:designId,created_at:100,updated_at:updated,page_count:1,urls:{edit_url:'https://www.canva.com/d/opaque-link',view_url:'https://www.canva.com/d/opaque-view'}}});
    }
    if(u.includes('/designs/'))return Response.json({design:{id:designId,created_at:100,updated_at:updated,page_count:1,urls:{edit_url:'https://www.canva.com/api/design/opaque/edit',view_url:'https://www.canva.com/d/opaque-view'}}});
    if(u.endsWith('/imports')&&init.method==='POST'){
      createCalls++;if(transportMode==='import_lost')throw new Error('connection lost');
      expect(init.headers['Content-Type']).toBe('application/octet-stream');
      expect(init.body).toBeInstanceOf(Uint8Array);
      return Response.json({job:{id:'import_'+taskId,status:'in_progress'}});
    }
    if(u.includes('/imports/'))return Response.json({job:{id:'import_'+taskId,status:jobStatus,...(jobStatus==='success'?{result:{designs:[{id:designId}]}}:{})}});
    if(u.endsWith('/exports')&&init.method==='POST'){
      exportCalls++;if(transportMode==='export_lost')throw new Error('connection lost');
      expect(JSON.parse(init.body).format).toEqual(transportMode==='pptx'?{type:'pptx'}:{type:'png',lossless:true});
      return Response.json({job:{id:'job_'+taskId,status:'in_progress'}});
    }
    if(u.includes('/exports/'))return Response.json({job:{id:'job_'+taskId,status:jobStatus,...(jobStatus==='success'?{urls:['https://export-download.canva.com/test.png']}:{} )}});
    if(u.startsWith('https://export-download.canva.com/'))return new Response(new Uint8Array(bytes));
    throw new Error('Unexpected provider path');
  }) as typeof fetch;
  const options={clientId:'test-client',clientSecret:'test-secret',redirectUri:'http://localhost:8772/v1/integrations/canva/callback',encryptionKey:key,fetcher:remote};
  const tx=<T>(f:(d:any)=>Promise<T>)=>withRlsContext(db,{tenantId:tenant,userId:actor},f);
  beforeAll(async()=>{
    await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES (${tenant}::uuid,'Canva isolated fixture','canva-test') ON CONFLICT DO NOTHING`.execute(db);
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES (${clientId}::uuid,${tenant}::uuid,${clientId},'Isolated client')`.execute(db);
  });
  beforeEach(async()=>{
    taskId=randomUUID();designId='DA'+randomUUID().replaceAll('-','');updated=200;jobStatus='in_progress';exportCalls=0;createCalls=0;refreshCalls=0;transportMode='ok';bytes=createSyntheticValidPng(64,64);
    await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES (${taskId}::uuid,${tenant}::uuid,${clientId}::uuid,'Isolated Canva test')`.execute(db);
    service=new CanvaConnectService(db,options);
    const auth=await service.startAuthorization(scope);await service.finishAuthorization(auth.state,auth.state,'test-code');
  });
  afterAll(()=>db.destroy());
  const bind=()=>tx(d=>new CanvaBindingRepository(d).createBinding({tenantId:tenant,taskId,clientId,canvaDesignId:designId,editUrl:`https://www.canva.com/design/${designId}/edit`}));
  it('imports stored source exactly once under races and binds after service replacement',async()=>{
    const sourceBytes=Buffer.from('Test-only editable source bytes long enough for the transport fixture.');
    const {createHash}=await import('node:crypto');
    const source={bytes:sourceBytes,sha256:createHash('sha256').update(sourceBytes).digest('hex'),manifest:{copy:['Exact test copy']}};
    const results=await Promise.all([service.importEditableDesign(scope,taskId,'import-key-01',source),service.importEditableDesign(scope,taskId,'import-key-01',source)]);
    expect(createCalls).toBe(1);expect(new Set(results.map(r=>r.operationId)).size).toBe(1);
    jobStatus='success';const done=await new CanvaConnectService(db,options).resumeImport(scope,taskId,results[0].operationId);
    expect(done.status).toBe('retrieved');expect((await service.binding(scope,taskId)).canva_design_id).toBe(designId);
    await expect(service.resumeImport({...scope,actorId:'other'},taskId,done.operationId)).rejects.toThrow('not found');
    const stored=(await sql<any>`SELECT content,sha256 FROM hawa.canva_editable_sources WHERE task_id=${taskId}::uuid`.execute(db)).rows[0];
    expect(stored.content).toEqual(sourceBytes);expect(stored.sha256).toBe(source.sha256);
    await expect(sql`UPDATE hawa.canva_editable_sources SET manifest='{}'::jsonb WHERE task_id=${taskId}::uuid`.execute(db)).rejects.toThrow();
  });
  it('retains uncertain imports without replaying the external creation',async()=>{
    const sourceBytes=Buffer.alloc(64,1),{createHash}=await import('node:crypto');
    const source={bytes:sourceBytes,sha256:createHash('sha256').update(sourceBytes).digest('hex'),manifest:{copy:['test']}};
    transportMode='import_lost';expect((await service.importEditableDesign(scope,taskId,'import-key-01',source)).status).toBe('uncertain');
    expect((await new CanvaConnectService(db,options).importEditableDesign(scope,taskId,'import-key-01',source)).status).toBe('uncertain');
    await expect(service.importEditableDesign(scope,taskId,'import-key-02',source)).rejects.toThrow('different creation');expect(createCalls).toBe(1);
  });
  it('stores native copy/font mismatch evidence without creating an approval',async()=>{
    const {encodeEditableTransfer}=await import('@hawa/creative');
    const source=await encodeEditableTransfer({width:640,height:640,background:'#FFFFFF',shapes:[],text:[{copyIndex:0,x:20,y:20,width:600,height:100,fontSize:24,fontFamily:'Arial',color:'#000000',align:'left'}]},['Exact copy']);
    const manifest={...source.manifest,reference:{rules:{fontFamily:'Minion Variable Concept'}}};
    jobStatus='success';await service.importEditableDesign(scope,taskId,'check-source-01',{...source,manifest});
    bytes=source.bytes;transportMode='pptx';const exported=await service.startExport(scope,taskId,'pptx-check-01','pptx',1);
    const checked=await service.exportStatus(scope,taskId,exported.operationId);
    expect(checked.artifact.format).toBe('pptx');expect(checked.artifact.content_check).toMatchObject({copyPass:true,fontPass:false,fullReleasePass:false});
    expect(checked.qaStatus).toBe('not_run');
    const restored=await new CanvaConnectService(db,options).taskState(scope,taskId);
    expect(restored.artifacts[0].content_check.fontPass).toBe(false);
  });
  it('stores encrypted authorization across service instances',async()=>{
    const row=(await sql<any>`SELECT encrypted_tokens FROM hawa.canva_connections WHERE tenant_id=${tenant}::uuid AND actor_id=${actor}`.execute(db)).rows[0];
    expect(row.encrypted_tokens).not.toMatch(/access_token|refresh_token/);
    expect((await new CanvaConnectService(db,options).status(scope)).authorized).toBe(true);
  });
  it('rejects browser mismatch and reuse of consumed authorization state',async()=>{
    const a=await service.startAuthorization(scope);
    await expect(service.finishAuthorization(a.state,'other-browser','code')).rejects.toThrow('another browser');
    await service.finishAuthorization(a.state,a.state,'code');
    await expect(service.finishAuthorization(a.state,a.state,'code')).rejects.toThrow('already used');
  });
  it('rejects expired authorization before token exchange',async()=>{
    const a=await service.startAuthorization(scope);await sql`UPDATE hawa.canva_oauth_states SET expires_at=now()-interval '1 second' WHERE tenant_id=${tenant}::uuid`.execute(db);
    await expect(service.finishAuthorization(a.state,a.state,'code')).rejects.toThrow('expired');
  });
  it('isolates connection access by actor',async()=>{
    await expect(service.authorizedClient({...scope,actorId:'other'})).rejects.toThrow('Connect Canva');
  });
  it('rotates an expired token only once under concurrent requests',async()=>{
    await sql`UPDATE hawa.canva_connections SET expires_at=now()-interval '1 second' WHERE tenant_id=${tenant}::uuid AND actor_id=${actor}`.execute(db);
    const r=await Promise.allSettled([service.authorizedClient(scope),new CanvaConnectService(db,options).authorizedClient(scope)]);
    expect(r.some(x=>x.status==='fulfilled')).toBe(true);expect(refreshCalls).toBe(1);expect((await service.status(scope)).authorized).toBe(true);
  });
  it('does not replay an uncertain refresh after process replacement',async()=>{
    await sql`UPDATE hawa.canva_connections SET expires_at=now()-interval '1 second' WHERE tenant_id=${tenant}::uuid AND actor_id=${actor}`.execute(db);transportMode='refresh_lost';
    await expect(service.authorizedClient(scope)).rejects.toThrow('reconnect');
    await expect(new CanvaConnectService(db,options).authorizedClient(scope)).rejects.toThrow();expect(refreshCalls).toBe(1);
  });
  it('disables local access even if remote revocation fails',async()=>{
    const result=await service.disconnect(scope);expect(result.disconnected).toBe(true);expect(result.providerRevoked).toBe(false);
    await expect(service.authorizedClient(scope)).rejects.toThrow('Connect Canva');
    const row=(await sql<any>`SELECT encrypted_tokens FROM hawa.canva_connections WHERE tenant_id=${tenant}::uuid AND actor_id=${actor}`.execute(db)).rows[0];
    expect(new CanvaTokenCipher(key).open(row.encrypted_tokens,tenant+':'+actor)).toEqual({});
  });
  it('retrieves the fresh opaque provider editor URL for the scoped binding',async()=>{
    await bind();const r=await service.editor(scope,taskId);expect(r.url).toBe('https://www.canva.com/api/design/opaque/edit');expect(r.verification).toBe('provider_metadata_verified');
  });
  it('creates a real-provider-shaped blank design and reuses its durable result',async()=>{
    const r=await service.createDesign(scope,taskId,'create-key-1',1080,1350);
    expect(r.status).toBe('retrieved');expect((await service.binding(scope,taskId)).canva_design_id).toBe(designId);
    await service.createDesign(scope,taskId,'create-key-1',1080,1350);expect(createCalls).toBe(1);
    await expect(service.createDesign(scope,taskId,'new-key-222',1080,1350)).rejects.toThrow('already has');
  });
  it('blocks duplicate create after a lost response, including a new key',async()=>{
    transportMode='create_lost';expect((await service.createDesign(scope,taskId,'create-key-1',1080,1350)).status).toBe('uncertain');
    await expect(service.createDesign(scope,taskId,'create-key-2',1080,1350)).rejects.toThrow('already exists');expect(createCalls).toBe(1);
  });
  it('enforces Canva area limits before transport',async()=>{
    await expect(service.createDesign(scope,taskId,'create-key-1',8000,8000)).rejects.toThrow('dimensions');expect(createCalls).toBe(0);
  });
  it('persists a submitted export, resumes after service replacement, stores real bytes without QA approval',async()=>{
    await bind();const r=await service.startExport(scope,taskId,'export-key-1','png',1);expect(r.status).toBe('submitted');
    await service.startExport(scope,taskId,'export-key-1','png',1);expect(exportCalls).toBe(1);
    jobStatus='success';const reopened=new CanvaConnectService(db,options);const done=await reopened.exportStatus(scope,taskId,r.operationId);
    expect(done.status).toBe('retrieved');expect(done.qaStatus).toBe('not_run');expect(done.semanticCoverage).toBe('unverified');
    const file=await reopened.artifact(scope,taskId,done.artifact.id);expect(Buffer.compare(file.content,bytes)).toBe(0);
    const counts=(await sql<any>`SELECT (SELECT count(*) FROM hawa.canva_capture_sets WHERE task_id=${taskId}::uuid) AS captures,(SELECT count(*) FROM hawa.qc_runs WHERE task_id=${taskId}::uuid) AS qa`.execute(db)).rows[0];
    expect(counts).toEqual({captures:'0',qa:'0'});
  });
  it('concurrent identical exports create just one remote job',async()=>{
    await bind();await Promise.all([service.startExport(scope,taskId,'export-key-1','png',1),service.startExport(scope,taskId,'export-key-1','png',1)]);expect(exportCalls).toBe(1);
  });
  it('rejects changed payload on the same key',async()=>{
    await bind();await service.startExport(scope,taskId,'export-key-1','png',1);
    await expect(service.startExport(scope,taskId,'export-key-1','pdf',1)).rejects.toThrow('different request');expect(exportCalls).toBe(1);
  });
  it('does not repeat an uncertain export submission',async()=>{
    await bind();transportMode='export_lost';const r=await service.startExport(scope,taskId,'export-key-1','png',1);
    expect(r.status).toBe('uncertain');expect((await new CanvaConnectService(db,options).startExport(scope,taskId,'export-key-1','png',1)).status).toBe('uncertain');expect(exportCalls).toBe(1);
  });
  it('rejects a changed design during export without saving artifact bytes',async()=>{
    await bind();const r=await service.startExport(scope,taskId,'export-key-1','png',1);jobStatus='success';updated++;
    expect((await service.exportStatus(scope,taskId,r.operationId)).status).toBe('stale');
    expect((await sql<any>`SELECT count(*) FROM hawa.canva_export_bytes WHERE operation_id=${r.operationId}::uuid`.execute(db)).rows[0].count).toBe('0');
  });
  it('rejects corrupt export data',async()=>{
    await bind();const r=await service.startExport(scope,taskId,'export-key-1','png',1);jobStatus='success';bytes=Buffer.from('not a real PNG export even with more than thirty two bytes');
    await expect(service.exportStatus(scope,taskId,r.operationId)).rejects.toThrow('byte validation');
  });
  it('rejects stale binding and foreign actor/task reads',async()=>{
    await bind();await expect(service.startExport(scope,taskId,'export-key-1','png',2)).rejects.toThrow('Refresh');
    const r=await service.startExport(scope,taskId,'export-key-1','png',1);
    await expect(service.exportStatus({...scope,actorId:'other'},taskId,r.operationId)).rejects.toThrow('not found');
    await expect(service.exportStatus(scope,randomUUID(),r.operationId)).rejects.toThrow('not found');
  });
  it('prevents moving a bound task to another client in PostgreSQL',async()=>{
    await bind();await expect(sql`UPDATE hawa.tasks SET client_id=NULL WHERE id=${taskId}::uuid`.execute(db)).rejects.toThrow();
  });
  it('cannot restart an uncertain export with a different idempotency key',async()=>{
    await bind();transportMode='export_lost';await service.startExport(scope,taskId,'export-key-1','png',1);
    await expect(service.startExport(scope,taskId,'export-key-2','png',1)).rejects.toThrow('already pending');expect(exportCalls).toBe(1);
  });
  it('rolls back stored bytes if the operation receipt update fails, then resumes the same job',async()=>{
    await bind();const r=await service.startExport(scope,taskId,'export-key-1','png',1);jobStatus='success';
    await sql.raw(`CREATE FUNCTION hawa.canva_test_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${r.operationId}' AND NEW.status='retrieved' THEN RAISE EXCEPTION 'injected receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER canva_test_reject_receipt BEFORE UPDATE ON hawa.canva_remote_operations FOR EACH ROW EXECUTE FUNCTION hawa.canva_test_reject_receipt();`).execute(db);
    try {
      await expect(service.exportStatus(scope,taskId,r.operationId)).rejects.toThrow('injected receipt failure');
      expect((await sql<any>`SELECT count(*) FROM hawa.canva_export_bytes WHERE operation_id=${r.operationId}::uuid`.execute(db)).rows[0].count).toBe('0');
    } finally {await sql.raw('DROP TRIGGER canva_test_reject_receipt ON hawa.canva_remote_operations; DROP FUNCTION hawa.canva_test_reject_receipt();').execute(db);}
    expect((await service.exportStatus(scope,taskId,r.operationId)).status).toBe('retrieved');expect(exportCalls).toBe(1);
  });
  it('enforces immutable bytes, DB content hashes and tenant RLS under a non-owner role',async()=>{
    await bind();const r=await service.startExport(scope,taskId,'export-key-1','png',1);jobStatus='success';
    const done=await service.exportStatus(scope,taskId,r.operationId);
    await expect(sql`UPDATE hawa.canva_export_bytes SET sha256=${'0'.repeat(64)} WHERE id=${done.artifact.id}::uuid`.execute(db)).rejects.toThrow();
    await expect(sql`DELETE FROM hawa.canva_export_bytes WHERE id=${done.artifact.id}::uuid`.execute(db)).rejects.toThrow();
    const role='canva_probe_'+randomUUID().replaceAll('-','');
    await sql.raw(`CREATE ROLE ${role}; GRANT USAGE ON SCHEMA hawa TO ${role}; GRANT SELECT ON hawa.canva_connections,hawa.canva_export_bytes TO ${role};`).execute(db);
    try {
      await withRlsContext(db,{tenantId:randomUUID()},async d=>{
        await sql.raw(`SET LOCAL ROLE ${role}`).execute(d);
        expect((await sql<any>`SELECT count(*) FROM hawa.canva_connections`.execute(d)).rows[0].count).toBe('0');
        expect((await sql<any>`SELECT count(*) FROM hawa.canva_export_bytes`.execute(d)).rows[0].count).toBe('0');
      });
    } finally {await sql.raw(`DROP OWNED BY ${role}; DROP ROLE ${role};`).execute(db);}
  });
  it('runs the export path through the non-owner runtime database role',async()=>{
    await bind();const runtimeUrl=new URL(process.env.HAWA_ISOLATED_RUNTIME_DB || url!);
    if(runtimeUrl.pathname!=='/hawa_repair')throw new Error('Disposable runtime database required');
    runtimeUrl.username='hawa_app';if(!process.env.HAWA_ISOLATED_RUNTIME_DB)runtimeUrl.password=process.env.HAWA_APP_PASSWORD || new URL(process.env.TEST_DATABASE_URL!).password;const runtimeDb=createDb(runtimeUrl.href);
    try {
      const runtimeService=new CanvaConnectService(runtimeDb,options);
      expect((await runtimeService.status(scope)).authorized).toBe(true);
      const r=await runtimeService.startExport(scope,taskId,'runtime-export-key','png',1);jobStatus='success';
      expect((await runtimeService.exportStatus(scope,taskId,r.operationId)).status).toBe('retrieved');
    } finally {await runtimeDb.destroy();}
  });
  it('completes the authenticated HTTP native-create to export-download slice against the provider fixture',async()=>{
    const app=createApp({db,canvaOptions:options});const headers={Authorization:'Bearer test_bearer','Content-Type':'application/json'};
    const created=await app.request(`/v1/tasks/${taskId}/canva/design`,{method:'POST',headers:{...headers,'Idempotency-Key':'http-create-1'},body:JSON.stringify({width:1080,height:1350})});
    expect(created.status).toBe(201);expect((await created.json()).contentStatus).toBe('blank_native_canvas');
    const editor=await app.request(`/v1/tasks/${taskId}/canva/editor`,{headers});expect(editor.status).toBe(200);expect((await editor.json()).url).toContain('/api/design/');
    const start=await app.request(`/v1/tasks/${taskId}/canva/exports`,{method:'POST',headers:{...headers,'Idempotency-Key':'http-export-1'},body:JSON.stringify({format:'png',expectedVersion:1})});
    expect(start.status).toBe(202);const pending=await start.json();jobStatus='success';
    const resumed=await app.request(`/v1/tasks/${taskId}/canva/exports/${pending.operationId}/resume`,{method:'POST',headers});
    expect(resumed.status).toBe(200);const captured=await resumed.json();expect(captured.qaStatus).toBe('not_run');
    const file=await app.request(`/v1/tasks/${taskId}/canva/artifacts/${captured.artifact.id}`,{headers});
    expect(file.status).toBe(200);expect(Buffer.compare(Buffer.from(await file.arrayBuffer()),bytes)).toBe(0);
    const anonymous=await app.request(`/v1/tasks/${taskId}/canva/artifacts/${captured.artifact.id}`,{headers:{'x-enforce-auth':'true'}});expect(anonymous.status).toBe(401);
    expect((await app.request(`/v1/tasks/${taskId}/export-package`,{headers})).status).toBe(410);
  });
  it('accepts the correct browser callback once and never includes tokens in its response',async()=>{
    const app=createApp({db,canvaOptions:options});const start=await app.request('/v1/integrations/canva/authorize',{method:'POST',headers:{Authorization:'Bearer test_bearer'}});
    const cookie=start.headers.get('set-cookie')!.split(';')[0], result=await start.json();const state=new URL(result.authorizationUrl).searchParams.get('state');
    const response=await app.request('/v1/integrations/canva/callback?state='+state+'&code=fixture-code',{headers:{Cookie:cookie}});
    expect(response.status).toBe(200);expect(await response.text()).not.toMatch(/access_token|refresh_token|fixture-code/);
    expect((await app.request('/v1/integrations/canva/callback?state='+state+'&code=fixture-code',{headers:{Cookie:cookie}})).status).toBe(400);
  });
  it('exposes authenticated routes and a CSRF-protected callback without leaking tokens',async()=>{
    const app=createApp({db,canvaOptions:options});
    expect((await app.request('/v1/integrations/canva/status',{headers:{'x-enforce-auth':'true'}})).status).toBe(401);
    const auth=await app.request('/v1/integrations/canva/authorize',{method:'POST',headers:{Authorization:'Bearer test_bearer'}});
    expect(auth.status).toBe(200);expect(auth.headers.get('set-cookie')).toContain('HttpOnly');
    const value=await auth.json();expect(value).not.toHaveProperty('codeVerifier');
    const state=new URL(value.authorizationUrl).searchParams.get('state');
    const rejected=await app.request('/v1/integrations/canva/callback?state='+state+'&code=DO_NOT_ECHO');
    expect(rejected.status).toBe(400);expect(await rejected.text()).not.toContain('DO_NOT_ECHO');
  });
});
