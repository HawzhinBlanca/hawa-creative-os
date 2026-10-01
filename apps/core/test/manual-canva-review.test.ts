import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { checkedCanvaExportFixture } from '../../../packages/testkit/src/canva-export-fixture.js';
import { recordManualCanvaReview } from '../src/services/manual-canva-review.js';
import { evaluateCanvaExportQc } from '../src/core-helpers.js';
import { createApp } from '../src/app.js';
import { characterReferenceDeck } from '../../../packages/qa/test/fixtures/character-reference-deck.js';
import { scriptFontDeck, scriptFontRun } from '../../../packages/qa/test/fixtures/script-font-deck.js';

const url=process.env.HAWA_ISOLATED_TEST_DB;
describe.skipIf(!url)('manual Canva first review from retained evidence',()=>{
  const db=createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId='00000000-0000-4000-a000-000000000001',clientId='c1000000-0000-4000-8000-000000000002';
  const actorId='00000000-0000-4000-b000-000000000001';
  const scope={tenantId,userId:actorId,role:'operator'};
  afterAll(()=>db.destroy());
  const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
  async function fixture(options:{workflow?:string;state?:string;pngVersion?:string;png?:boolean;copy?:string;corrupt?:boolean;pptxBytes?:Buffer;
    target?:{taskId:string;designId:string;bindingId:string}}={}){
    const {taskId,designId,bindingId}=options.target || {taskId:randomUUID(),designId:`manual_${randomUUID()}`,bindingId:randomUUID()};
    const checked=await checkedCanvaExportFixture('Exact copy 123.45');
    // Retain an older passing receipt deliberately; actual review must re-read the new pinned bytes.
    if(options.pptxBytes) checked.bytes=Buffer.from(options.pptxBytes);
    const files={png:randomUUID(),pptx:randomUUID()};
    const operations={png:randomUUID(),pptx:randomUUID()};
    await withRlsContext(db,scope,async trx=>{
      if(!options.target){
      await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title,description,state,priority,version)
        VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Queue title is not copy','',${options.state || 'failed_operator'},3,1)`.execute(trx);
      await sql`INSERT INTO hawa.task_events(id,tenant_id,task_id,aggregate_version,event_type,actor_type,actor_id,correlation_id,data)
        VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${taskId}::uuid,1,'task.created','user',${actorId},${randomUUID()}::uuid,
          ${JSON.stringify({payload:{body:{workflow:options.workflow || 'canva_manual',copyEn:options.copy ?? 'Exact copy 123.45',copyCkb:''}}})}::jsonb)`.execute(trx);
      await sql`INSERT INTO hawa.canva_bindings(id,tenant_id,task_id,client_id,canva_design_id,edit_url,status,version)
        VALUES(${bindingId}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,${designId},${`https://www.canva.com/design/${designId}/edit`},'bound',1)`.execute(trx);
      }
      for(const format of ['png','pptx'] as const){
        if(format==='png'&&options.png===false)continue;
        const operationId=operations[format],bytes=format==='png'?Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'):checked.bytes;
        await sql`INSERT INTO hawa.canva_remote_operations(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,kind,status,design_id,binding_version,metadata)
          VALUES(${operationId}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,${actorId},${randomUUID()},'h','export','retrieved',${designId},1,
            ${JSON.stringify({format,designUpdatedAt:format==='png'?(options.pngVersion || '200'):'200'})}::jsonb)`.execute(trx);
        await sql`INSERT INTO hawa.canva_export_bytes(id,tenant_id,task_id,client_id,operation_id,format,sha256,content,content_check)
          VALUES(${files[format]}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,${operationId}::uuid,${format},${hash(bytes)},
            ${options.corrupt&&format==='png'?Buffer.from('altered preview'):bytes},${format==='pptx'?JSON.stringify(checked.contentCheck):null}::jsonb)`.execute(trx);
      }
    });
    return {taskId,designId,bindingId,files,operations,pptxSha:hash(checked.bytes)};
  }
  const record=(f:Awaited<ReturnType<typeof fixture>>)=>withRlsContext(db,scope,trx=>recordManualCanvaReview(trx,evaluateCanvaExportQc,
    {tenantId,taskId:f.taskId,actorId,artifactId:f.files.pptx}));
  const counts=(taskId:string)=>withRlsContext(db,scope,async trx=>({
    revisions:Number((await sql<{n:string}>`SELECT count(*) n FROM hawa.design_revisions WHERE task_id=${taskId}::uuid`.execute(trx)).rows[0].n),
    checks:Number((await sql<{n:string}>`SELECT count(*) n FROM hawa.qc_runs WHERE task_id=${taskId}::uuid`.execute(trx)).rows[0].n),
  }));
  it('rechecks numeric XML copy into one attributable review while preserving original bytes and source hash',async()=>{
    const bytes=Buffer.from(characterReferenceDeck('&#69;xact copy 123.45'));
    const f=await fixture({pptxBytes:bytes});
    const first=await record(f);
    expect(first).toMatchObject({status:'recorded',qaPassed:true,checkedArtifactId:f.files.pptx});
    expect(await record(f)).toEqual(first); expect(await counts(f.taskId)).toEqual({revisions:1,checks:1});
    const source=await withRlsContext(db,scope,async trx=>(await sql<{source_sha256:string;neutral_manifest:{nativeVerification:string;nodes:Array<{text:string}>};content:Buffer}>`
      SELECT r.source_sha256,r.neutral_manifest,b.content FROM hawa.design_revisions r
      JOIN hawa.canva_export_bytes b ON b.id=${f.files.pptx}::uuid WHERE r.task_id=${f.taskId}::uuid`.execute(trx)).rows[0]);
    expect(source.source_sha256).toBe(hash(bytes)); expect(source.content).toEqual(bytes);
    expect(source.neutral_manifest.nodes.map(n=>n.text)).toEqual(['Exact copy 123.45']);
    expect(source.neutral_manifest.nativeVerification).toBe('unverified');
  });
  it('does not convert forbidden XML numeric controls into review authority despite a stored passing receipt',async()=>{
    const f=await fixture({pptxBytes:Buffer.from(characterReferenceDeck('Ex&#0;act copy 123.45'))});
    expect(await record(f)).toMatchObject({status:'blocked'});
    expect(await counts(f.taskId)).toEqual({revisions:0,checks:0});
  });
  it('rechecks field fonts from retained bytes and refuses approval despite an older passing receipt',async()=>{
    const bytes=Buffer.from(scriptFontDeck(scriptFontRun('Exact copy ', 'Verdana') + scriptFontRun('123.45', 'Arial', undefined, 'fld')));
    const f=await fixture({pptxBytes:bytes});
    const first=await record(f);
    expect(first).toMatchObject({status:'recorded',qaPassed:false,checkedArtifactId:f.files.pptx});
    expect(await record(f)).toEqual(first); expect(await counts(f.taskId)).toEqual({revisions:1,checks:1});
    const response=await createApp({db,testAuth:{roleHeader:true}}).request(`/tasks/${f.taskId}/revisions/${(first as {revisionId:string}).revisionId}/decisions`,{
      method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer test_art_director_bearer'},
      body:JSON.stringify({decision:'approved',pinnedExportIds:[f.files.png,f.files.pptx]})});
    expect(response.status).toBe(412);
    const source=await withRlsContext(db,scope,async trx=>(await sql<{source_sha256:string;neutral_manifest:{nativeVerification:string};content:Buffer}>`
      SELECT r.source_sha256,r.neutral_manifest,b.content FROM hawa.design_revisions r
      JOIN hawa.canva_export_bytes b ON b.id=${f.files.pptx}::uuid WHERE r.task_id=${f.taskId}::uuid`.execute(trx)).rows[0]);
    expect(source.source_sha256).toBe(hash(bytes)); expect(source.content).toEqual(bytes);
    expect(source.neutral_manifest.nativeVerification).toBe('unverified');
  });
  it('refuses prefixed wrong family at review and approval while preserving source and replay',async()=>{
    const bytes=Buffer.from(scriptFontDeck(scriptFontRun('Exact copy 123.45','Verdana Fake')));
    const f=await fixture({pptxBytes:bytes}); const first=await record(f);
    expect(first).toMatchObject({status:'recorded',qaPassed:false,checkedArtifactId:f.files.pptx});
    expect(await record(f)).toEqual(first); expect(await counts(f.taskId)).toEqual({revisions:1,checks:1});
    const response=await createApp({db,testAuth:{roleHeader:true}}).request(`/tasks/${f.taskId}/revisions/${(first as {revisionId:string}).revisionId}/decisions`,{
      method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer test_art_director_bearer'},
      body:JSON.stringify({decision:'approved',pinnedExportIds:[f.files.png,f.files.pptx]})});
    expect(response.status).toBe(412);
    const source=await withRlsContext(db,scope,async trx=>(await sql<{source_sha256:string;neutral_manifest:{nativeVerification:string};content:Buffer}>`
      SELECT r.source_sha256,r.neutral_manifest,b.content FROM hawa.design_revisions r
      JOIN hawa.canva_export_bytes b ON b.id=${f.files.pptx}::uuid WHERE r.task_id=${f.taskId}::uuid`.execute(trx)).rows[0]);
    expect(source.source_sha256).toBe(hash(bytes)); expect(source.content).toEqual(bytes);
    expect(source.neutral_manifest.nativeVerification).toBe('unverified');
  });
  it('records correctly declared field copy once without claiming native or field-update fidelity',async()=>{
    const bytes=Buffer.from(scriptFontDeck(scriptFontRun('Exact copy ', 'Verdana') + scriptFontRun('123.45', 'Verdana', undefined, 'fld')));
    const f=await fixture({pptxBytes:bytes}); const first=await record(f);
    expect(first).toMatchObject({status:'recorded',qaPassed:true,checkedArtifactId:f.files.pptx});
    expect(await record(f)).toEqual(first); expect(await counts(f.taskId)).toEqual({revisions:1,checks:1});
    const row=await withRlsContext(db,scope,async trx=>(await sql<{source_sha256:string;neutral_manifest:{nativeVerification:string;nodes:Array<{text:string}>}}>`
      SELECT source_sha256,neutral_manifest FROM hawa.design_revisions WHERE task_id=${f.taskId}::uuid`.execute(trx)).rows[0]);
    expect(row.source_sha256).toBe(hash(bytes)); expect(row.neutral_manifest.nodes.map(n=>n.text)).toEqual(['Exact copy 123.45']);
    expect(row.neutral_manifest.nativeVerification).toBe('unverified');
  });
  it('creates one attributable first revision and QA run under concurrent/replayed capture, then permits ordinary review approval',async()=>{
    const f=await fixture();
    const outcomes=await Promise.all([record(f),record(f)]);
    expect(outcomes[0]).toMatchObject({status:'recorded',qaPassed:true,checkedArtifactId:f.files.pptx});
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(await record(f)).toEqual(outcomes[0]);
    expect(await counts(f.taskId)).toEqual({revisions:1,checks:1});
    const row=await withRlsContext(db,scope,async trx=>(await sql<any>`SELECT r.*,t.state FROM hawa.design_revisions r
      JOIN hawa.tasks t ON t.id=r.task_id WHERE r.task_id=${f.taskId}::uuid`.execute(trx)).rows[0]);
    expect(row).toMatchObject({author_type:'user',author_id:actorId,source_sha256:f.pptxSha,state:'human_review'});
    expect(row.source_storage_key).toBe(`canva_export_bytes/${f.files.pptx}`);
    expect(row.neutral_manifest).toMatchObject({nativeVerification:'unverified',semanticCoverage:'pptx_live_text_only',copy:['Exact copy 123.45']});
    expect(row.neutral_manifest.nodes).toEqual([expect.objectContaining({type:'text',text:'Exact copy 123.45',
      source:expect.objectContaining({format:'pptx',part:'ppt/slides/slide1.xml'})})]);
    const app=createApp({db,testAuth:{roleHeader:true}});
    const response=await app.request(`/tasks/${f.taskId}/revisions/${row.id}/decisions`,{method:'POST',
      headers:{'content-type':'application/json',Authorization:'Bearer test_art_director_bearer'},
      body:JSON.stringify({decision:'approved',pinnedExportIds:[f.files.png,f.files.pptx]})});
    expect(response.status,await response.text()).toBe(201);
    const fresh=await fixture({target:f});
    const newResult=await record(fresh);
    expect(newResult).toMatchObject({status:'recorded',qaPassed:true,checkedArtifactId:fresh.files.pptx});
    expect(newResult).not.toEqual(outcomes[0]);
    expect(await record(fresh)).toEqual(newResult);
    expect(await record(f)).toMatchObject({status:'blocked'});
    expect(await counts(f.taskId)).toEqual({revisions:2,checks:2});
    const evidence=await withRlsContext(db,scope,async trx=>(await sql<{invalidations:string;source_storage_key:string;neutral_manifest:{capturedSource:{artifactId:string};preview:{artifactId:string}}}>`
      SELECT r.source_storage_key,r.neutral_manifest,(SELECT count(*) FROM hawa.task_events WHERE task_id=t.id AND event_type='approval.invalidated') AS invalidations
      FROM hawa.tasks t JOIN hawa.design_revisions r ON r.id=t.current_design_revision_id WHERE t.id=${f.taskId}::uuid`.execute(trx)).rows[0]);
    expect(evidence).toMatchObject({invalidations:'1',source_storage_key:`canva_export_bytes/${fresh.files.pptx}`,
      neutral_manifest:{capturedSource:{artifactId:fresh.files.pptx},preview:{artifactId:fresh.files.png}}});
  });
  it('records a failed check against submitted copy instead of trusting a passing stored receipt',async()=>{
    const f=await fixture({copy:'Changed submitted copy 678.90'});
    expect(await record(f)).toMatchObject({status:'recorded',qaPassed:false});
    expect(await counts(f.taskId)).toEqual({revisions:1,checks:1});
    const response=await createApp({db,testAuth:{roleHeader:true}}).request(`/tasks/${f.taskId}/revisions/${(await record(f) as {revisionId:string}).revisionId}/decisions`,{
      method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer test_art_director_bearer'},
      body:JSON.stringify({decision:'approved',pinnedExportIds:[f.files.png,f.files.pptx]})});
    expect(response.status).toBe(412);
  });
  it('resuming the retained export through HTTP records one review across new app instances',async()=>{
    const f=await fixture();
    const resume=async()=>{
      const response=await createApp({db,testAuth:{roleHeader:true}}).request(`/tasks/${f.taskId}/canva/exports/${f.operations.pptx}/resume`,{
        method:'POST',headers:{Authorization:'Bearer test_bearer'}});
      expect(response.status,await response.clone().text()).toBe(200);
      return response.json();
    };
    const first=await resume();expect(first.review).toMatchObject({status:'recorded',qaPassed:true,checkedArtifactId:f.files.pptx});
    expect((await resume()).review).toEqual(first.review);expect(await counts(f.taskId)).toEqual({revisions:1,checks:1});
  });
  it.each(['revision_requested','cancelled','complete'])('does not reuse an old capture after %s',async state=>{
    const f=await fixture();await record(f);
    await withRlsContext(db,scope,trx=>sql`UPDATE hawa.tasks SET state=${state}::hawa.task_state,updated_at=clock_timestamp() WHERE id=${f.taskId}::uuid`.execute(trx));
    expect(await record(f)).toMatchObject({status:'blocked'});
    const fresh=await fixture({target:f});
    expect(await record(fresh)).toMatchObject({status:state==='revision_requested'?'recorded':'blocked'});
    expect(await counts(f.taskId)).toEqual(state==='revision_requested'?{revisions:2,checks:2}:{revisions:1,checks:1});
  });
  it.each([{png:false},{pngVersion:'199'},{state:'cancelled'},{state:'complete'}])('refuses incomplete, mismatched or closed evidence: %j',async options=>{
    const f=await fixture(options);expect(await record(f)).toMatchObject({status:'blocked'});
    expect(await counts(f.taskId)).toEqual({revisions:0,checks:0});
  });
  it('the storage constraint rejects corrupt capture bytes before review can use them',async()=>{
    await expect(fixture({corrupt:true})).rejects.toThrow('canva_export_bytes_check');
  });
  it('does not turn automatic workflow input into manual review',async()=>{
    const f=await fixture({workflow:'canva'});expect(await record(f)).toMatchObject({status:'not_applicable'});
    expect(await counts(f.taskId)).toEqual({revisions:0,checks:0});
  });
  it('requires complete live-text evidence from the verifier even with a stored passing check',async()=>{
    const f=await fixture();
    const result=await withRlsContext(db,scope,trx=>recordManualCanvaReview(trx,(row,copy)=>({...evaluateCanvaExportQc(row,copy),sourceTextObjects:null}),
      {tenantId,taskId:f.taskId,actorId,artifactId:f.files.pptx}));
    expect(result).toMatchObject({status:'blocked'});
    expect(await counts(f.taskId)).toEqual({revisions:0,checks:0});
  });
  it('does not expose or record another tenant’s capture',async()=>{
    const f=await fixture(),otherTenant=randomUUID();
    const result=await withRlsContext(db,{...scope,tenantId:otherTenant},trx=>recordManualCanvaReview(trx,evaluateCanvaExportQc,
      {tenantId:otherTenant,taskId:f.taskId,actorId,artifactId:f.files.pptx}));
    expect(result).toMatchObject({status:'not_applicable'});expect(await counts(f.taskId)).toEqual({revisions:0,checks:0});
  });
  it('refuses a binding changed after capture',async()=>{
    const f=await fixture();await withRlsContext(db,scope,trx=>sql`UPDATE hawa.canva_bindings SET version=version+1 WHERE id=${f.bindingId}::uuid`.execute(trx));
    expect(await record(f)).toMatchObject({status:'blocked'});expect(await counts(f.taskId)).toEqual({revisions:0,checks:0});
  });
});
