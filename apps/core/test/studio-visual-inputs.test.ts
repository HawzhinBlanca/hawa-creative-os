import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext, DesignStudioRepository, StudioVisualInputsRepository, StudioVisualInputsError, blobStoreFromEnv } from '@hawa/db';
import { ExemplarRetrievalIndex, renderMotifPng, captureRenderFontInputs } from '@hawa/creative';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { PhotoCutouts } from '../src/services/design-studio/photo-cutouts.js';
import { resolveClientDesignReference } from '../src/services/client-design-reference.js';
import { captureVisualInputs, restoreVisualInputs } from '../src/services/design-studio/visual-inputs.js';
import { layoutVisualInputs } from '../src/services/design-studio/stages/asset-inputs.js';
import type { StageContext } from '../src/services/design-studio/types.js';

vi.mock('@hawa/creative', async original => {
  const actual=await original<typeof import('@hawa/creative')>();
  return {...actual,captureRenderFontInputs:vi.fn(actual.captureRenderFontInputs)};
});

const boundary = vi.hoisted(() => ({ layout: vi.fn(), critique: vi.fn() }));
vi.mock('../src/services/design-studio/stages/index.js', async original => ({
  ...await original<typeof import('../src/services/design-studio/stages/index.js')>(), runLayoutsStage: boundary.layout, runCritiqueStageV3: boundary.critique,
}));
const url = process.env.HAWA_ISOLATED_TEST_DB;
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const photo = renderMotifPng('gradient-wash',{width:16,height:16,palette:['#1E3A5F'],seed:1});
const oldCut = renderMotifPng('gradient-wash',{width:16,height:16,palette:['#FFFFFF'],seed:2});
const newCut = renderMotifPng('gradient-wash',{width:16,height:16,palette:['#000000'],seed:3});
const dataUrl = (bytes:Buffer)=>`data:image/png;base64,${bytes.toString('base64')}`;

describe.skipIf(!url)('Studio uses one pinned visual basis',()=>{
  const db=createDb(url || 'postgres://localhost/hawa_repair'),runs=new DesignStudioRepository(db),inputs=new StudioVisualInputsRepository(db,blobStoreFromEnv(db));
  const scope={tenantId:'00000000-0000-4000-a000-000000000001',actorId:'',role:'operator' as const};
  const clientId='c1000000-0000-4000-8000-000000000002';
  let taskId:string,runId:string,currentPhoto:Buffer;
  beforeEach(async()=>{
    vi.stubEnv('DESIGN_PIPELINE_V3','on');
    scope.actorId=randomUUID();taskId=randomUUID();runId=randomUUID();boundary.layout.mockReset();boundary.critique.mockReset();
    currentPhoto=renderMotifPng('gradient-wash',{width:16,height:16,palette:['#1E3A5F'],seed:parseInt(taskId.slice(0,8),16)});
    boundary.layout.mockImplementation(async()=>{throw new StudioVisualInputsError('Synthetic pause at the layout provider boundary');});
    boundary.critique.mockImplementation(async()=>{throw new StudioVisualInputsError('Synthetic pause at the critique boundary');});
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${scope.actorId}::uuid,${scope.actorId+'@example.test'},'Visual operator')`.execute(db);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${scope.tenantId}::uuid,${scope.actorId}::uuid,'operator')`.execute(db);
    await withRlsContext(db,{tenantId:scope.tenantId,userId:scope.actorId},async tx=>{
      await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${scope.tenantId}::uuid,'visual-kaae','Synthetic KAAE') ON CONFLICT(id) DO NOTHING`.execute(tx);
      await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${scope.tenantId}::uuid,${clientId}::uuid,'Visual task')`.execute(tx);
    });
    const {reference,logo}=await resolveClientDesignReference(db,scope,clientId);
    const request={clientId,width:1080,height:1350,instructions:'Use the supplied portrait and reference',copyBlocks:[{text:'Exact title',script:'latin'}],referenceHash:hash(JSON.stringify(reference)),logoSha256:hash(logo),pipelineV3:true};
    await runs.createRun({id:runId,taskId,tenantId:scope.tenantId,clientId,actorId:scope.actorId,requestKey:runId,requestHash:hash(JSON.stringify(request)),request,tier:'premium'});
    await runs.updateRunStatus(runId,scope.tenantId,'laying_out',{stages:{cutoutsWanted:true,concepts:[],brief:{imageryStrategy:'none',referenceSeen:true,
      imageRoles:[{index:0,role:'content_photo',notes:'Speaker looking left'},{index:1,role:'style_reference',notes:'Quiet blue geometry'}]}}});
    await sql`INSERT INTO hawa.photo_cutouts(tenant_id,source_sha256,model,model_sha256,passed,png,width,height,report)
      VALUES(${scope.tenantId}::uuid,${hash(currentPhoto)},'old-model',${hash(runId)},true,${oldCut},16,16,'{"people":1,"faceHeight":6}'::jsonb)`.execute(db);
  });
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
  afterAll(()=>db.destroy());
  function service(connection=db) {
    const fetcher=vi.fn<typeof fetch>(async()=>{throw new Error('No paid transport');});
    const svc=new DesignStudioService(connection,undefined,{fetcher,apiKey:'synthetic-key'});
    const images=vi.fn(async()=>[dataUrl(currentPhoto),dataUrl(currentPhoto)]);
    const local=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({ok:true,orientation:1,height:16,focus:{x:.4,y:.2},faces:[{height:6}]})));
    Object.assign(svc,{imagesForRun:images,attachedImage:vi.fn(async()=>undefined),cutouts:new PhotoCutouts({url:'http://synthetic-cutout',fetcher:local})});
    return {svc,images,local,fetcher};
  }

  it('retains exact cutouts, photos, reference and thumbnails before layout, ignoring a later derivation',async()=>{
    const first=service();
    await expect(first.svc.resume(scope,taskId,runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
    expect(boundary.layout).toHaveBeenCalledTimes(1);
    const original=boundary.layout.mock.calls[0][0] as StageContext;
    const saved=await inputs.get(scope,runId);
    expect(saved).not.toBeNull();expect(original.photoCutouts?.[0]?.png).toEqual(oldCut);
    expect(original.exemplarRetrieval).toMatchObject({algorithm:'unicode-bm25-v1'});
    expect(original.exemplarRetrieval?.loadedIds.length).toBe(original.exemplars?.length);
    expect(original.exemplarRetrieval?.unavailableIds).toContain('AUK002_kurdi_jpg');
    expect(saved?.manifest).toMatchObject({exemplarRetrieval:original.exemplarRetrieval});
    expect(original.cutoutOutcomes?.[0].derivation).toMatchObject({sourceSha256:hash(currentPhoto),model:'old-model'});
    expect(original.visualInputs).toHaveLength(Math.min(2,original.exemplars?.length ?? 0)+1);
    expect(original.visualInputs?.some(v=>v.kind==='approved_example')).toBe(true);
    await sql`INSERT INTO hawa.photo_cutouts(tenant_id,source_sha256,model,model_sha256,passed,png,width,height,report,created_at)
      VALUES(${scope.tenantId}::uuid,${hash(currentPhoto)},'new-model',${hash(runId+'new')},true,${newCut},16,16,'{}'::jsonb,now()+interval '1 hour')`.execute(db);
    const runtimeUrl=new URL(url!);runtimeUrl.searchParams.set('options','-c role=hawa_app');
    const peer=createDb(runtimeUrl.toString());
    try {
      const second=service(peer);
      second.images.mockRejectedValue(new Error('Image sources must not be reread'));
      second.local.mockRejectedValue(new Error('Cutout/focus processing must not repeat'));
      const retrieval=vi.spyOn(ExemplarRetrievalIndex.prototype,'retrieveTopExemplars').mockImplementation(()=>{throw new Error('Retrieval must not repeat');});
      await expect(second.svc.resume(scope,taskId,runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
      expect(boundary.layout).toHaveBeenCalledTimes(2);
      const recovered=boundary.layout.mock.calls[1][0] as StageContext;
      expect(recovered.photoCutouts).toEqual(original.photoCutouts);
      expect(recovered.photos).toEqual(original.photos);
      expect(recovered.exemplarRetrieval).toEqual(original.exemplarRetrieval);
      expect(recovered.reference).toEqual(original.reference);
      expect(recovered.visualInputs).toEqual(original.visualInputs);
      expect(await layoutVisualInputs(recovered)).toBe(recovered.visualInputs);
      expect(second.images).not.toHaveBeenCalled();expect(second.local).not.toHaveBeenCalled();expect(retrieval).not.toHaveBeenCalled();expect(second.fetcher).not.toHaveBeenCalled();
      await runs.insertCandidate({id:randomUUID(),runId,tenantId:scope.tenantId,ordinal:0,concept:{},status:'active',
        layouts:[{version:2,width:1080,height:1350,text:[],shapes:[],background:{color:'#FFFFFF'},grid:{margin:60,columns:6,gutter:24,baseline:8},logo:{x:50,y:50,width:100,height:100}}]});
      await runs.updateRunStatus(runId,scope.tenantId,'critiquing');
      await expect(second.svc.resume(scope,taskId,runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
      expect(boundary.critique).toHaveBeenCalledTimes(1);
      const critiqueContext=boundary.critique.mock.calls[0][0] as StageContext;
      expect(critiqueContext.photoCutouts).toEqual(original.photoCutouts);
      expect(critiqueContext.photos).toEqual(original.photos);
      expect(critiqueContext.reference).toEqual(original.reference);
      expect(second.images).not.toHaveBeenCalled();expect(second.local).not.toHaveBeenCalled();expect(retrieval).not.toHaveBeenCalled();
      expect(await inputs.get(scope,runId)).toEqual(saved);
    }finally{await peer.destroy();}
  });

  it('excludes changed image hashes before selection and retains the reason',async()=>{
    const get = ExemplarRetrievalIndex.prototype.getConfirmedExemplars;
    vi.spyOn(ExemplarRetrievalIndex.prototype,'getConfirmedExemplars').mockImplementation(function(this:ExemplarRetrievalIndex){
      return get.call(this).map(e=>({...e,sha256:'0'.repeat(64)}));
    });
    const f=service();await expect(f.svc.resume(scope,taskId,runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
    expect(boundary.layout).toHaveBeenCalledTimes(1);
    const context=boundary.layout.mock.calls[0][0] as StageContext;
    expect(context.exemplars).toEqual([]);
    expect(context.exemplarRetrieval).toMatchObject({mode:'empty',eligibleCount:0,loadedIds:[]});
    expect(context.exemplarRetrieval?.warnings).toContain('EXEMPLAR_BYTES_UNVERIFIED:post1_accreditation_mandate');
    expect((await inputs.get(scope,runId))?.manifest).toMatchObject({exemplarRetrieval:context.exemplarRetrieval});
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('retains explicit retrieval failure instead of an invented match',async()=>{
    vi.spyOn(ExemplarRetrievalIndex.prototype,'retrieveTopExemplars').mockImplementation(()=>{throw new Error('Synthetic retrieval failure');});
    const f=service();await expect(f.svc.resume(scope,taskId,runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
    const context=boundary.layout.mock.calls[0][0] as StageContext;
    expect(context.exemplarRetrieval).toMatchObject({mode:'empty',loadedIds:[],warnings:['EXEMPLAR_RETRIEVAL_FAILED: no verified selection was available.']});
    expect((await inputs.get(scope,runId))?.manifest).toMatchObject({exemplarRetrieval:context.exemplarRetrieval});
  });

  it('holds a pinned run on changed font bytes and resumes after the original basis is restored',async()=>{
    const f=service();await expect(f.svc.resume(scope,taskId,runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
    expect(boundary.layout).toHaveBeenCalledTimes(1);
    const original=await inputs.get(scope,runId);
    expect(original?.manifest).toMatchObject({version:3,fonts:{version:2,renderer:{version:1}}});
    const actual=captureRenderFontInputs();
    vi.mocked(captureRenderFontInputs).mockReturnValueOnce({...actual,sha256:'0'.repeat(64)});
    const second=service();
    await expect(second.svc.resume(scope,taskId,runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
    expect(boundary.layout).toHaveBeenCalledTimes(1);expect(second.fetcher).not.toHaveBeenCalled();
    expect((await runs.getRunById(runId,scope.tenantId))?.status).toBe('laying_out');
    expect(await inputs.get(scope,runId)).toEqual(original);
    await expect(second.svc.resume(scope,taskId,runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
    expect(boundary.layout).toHaveBeenCalledTimes(2);
  });

  it('holds a pinned run when the renderer runtime changed and resumes after it is restored',async()=>{
    const f=service();await expect(f.svc.resume(scope,taskId,runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
    expect(boundary.layout).toHaveBeenCalledTimes(1);
    const original=await inputs.get(scope,runId);
    const actual=captureRenderFontInputs();
    expect(actual.renderer).toMatchObject({version:1,rsvg:{version:expect.stringMatching(/rsvg-convert version/)},os:{platform:process.platform}});
    // Same fonts, another rasteriser build: the basis the run pinned is no longer the one that would draw.
    const renderer={...(actual.renderer as {rsvg:Record<string,string>}),rsvg:{...(actual.renderer as {rsvg:Record<string,string>}).rsvg,version:'rsvg-convert version 0.0.0-synthetic'}};
    const real=vi.mocked(captureRenderFontInputs).getMockImplementation()!;
    vi.mocked(captureRenderFontInputs).mockImplementation(()=>({...actual,renderer:renderer as typeof actual.renderer,sha256:'1'.repeat(64)}));
    const second=service();
    await expect(second.svc.resume(scope,taskId,runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE',message:expect.stringMatching(/renderer/)});
    expect(boundary.layout).toHaveBeenCalledTimes(1);expect(second.fetcher).not.toHaveBeenCalled();expect(second.local).not.toHaveBeenCalled();
    expect((await runs.getRunById(runId,scope.tenantId))?.status).toBe('laying_out');
    expect(await inputs.get(scope,runId)).toEqual(original);
    vi.mocked(captureRenderFontInputs).mockImplementation(real);
    await expect(second.svc.resume(scope,taskId,runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
    expect(boundary.layout).toHaveBeenCalledTimes(2);
  });

  it('pins the cut-out service runtime and face-detector identity with each derivation it used',async()=>{
    await sql`DELETE FROM hawa.photo_cutouts WHERE tenant_id=${scope.tenantId}::uuid AND source_sha256=${hash(currentPhoto)}`.execute(db);
    const runtime={implementation:'hawa-cutout/2',codeSha256:'c'.repeat(64),python:'3.12.7',packages:{numpy:'2.1.3',onnxruntime:'1.20.1'},faceModelSha256:'f'.repeat(64)};
    const digest=(value:unknown)=>hash(JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v));
    const f=service();
    f.local.mockImplementation(async(input)=>String(input).endsWith('/v1/cutout')
      ? new Response(JSON.stringify({ok:true,passed:true,png:oldCut.toString('base64'),width:16,height:16,bbox:[0,0,16,16],faces:[{x:2,y:2,width:6,height:6}],
        gates:{},stats:{people:1},model:'synthetic.onnx',modelSha256:'a'.repeat(64),runtime}))
      : new Response(JSON.stringify({ok:true,orientation:1,height:16,focus:{x:.4,y:.2},faces:[{height:6}],runtime})));
    await expect(f.svc.resume(scope,taskId,runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
    const manifest=(await inputs.get(scope,runId))!.manifest as {outcomes:Array<{derivation:Record<string,unknown>}>;preparation:{photoFocus:Array<Record<string,unknown>>}};
    expect(manifest.outcomes[0].derivation).toEqual({sourceSha256:hash(currentPhoto),model:'synthetic.onnx',modelSha256:'a'.repeat(64),
      reportSha256:expect.stringMatching(/^[a-f0-9]{64}$/),pngSha256:hash(oldCut),runtimeSha256:digest(runtime),faceModelSha256:'f'.repeat(64)});
    expect(manifest.preparation.photoFocus[0]).toMatchObject({x:.4,y:.2,derivation:{sourceSha256:hash(currentPhoto),runtimeSha256:digest(runtime)}});
    // After pinning the service is not asked again, whatever it now reports.
    const second=service();second.local.mockRejectedValue(new Error('A pinned run must not reach the cut-out service'));
    await expect(second.svc.resume(scope,taskId,runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
    expect(boundary.layout).toHaveBeenCalledTimes(2);expect(second.local).not.toHaveBeenCalled();
    expect((boundary.layout.mock.calls[1][0] as StageContext).photoCutouts?.[0]?.png).toEqual(oldCut);
  });

  it('refuses changed client policy before layout or a new model call',async()=>{
    const first=service();await expect(first.svc.resume(scope,taskId,runId)).rejects.toThrow();
    const second=service();
    Object.assign(second.svc,{withClientRules:async(_s:unknown,ctx:StageContext)=>({...ctx,clientRules:'A new approved client restriction'})});
    await expect(second.svc.resume(scope,taskId,runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
    expect(boundary.layout).toHaveBeenCalledTimes(1);expect(second.fetcher).not.toHaveBeenCalled();
  });

  it('keeps a pinned run recoverable when its current policy cannot be loaded',async()=>{
    const first=service();await expect(first.svc.resume(scope,taskId,runId)).rejects.toThrow();
    const second=service();Object.assign(second.svc,{createStageContext:async()=>{throw new Error('Synthetic missing policy file');}});
    await expect(second.svc.resume(scope,taskId,runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
    expect((await runs.getRunById(runId,scope.tenantId))?.status).toBe('laying_out');
    expect(boundary.layout).toHaveBeenCalledTimes(1);expect(second.fetcher).not.toHaveBeenCalled();
  });

  it('does not reach layout when saving its visual basis fails',async()=>{
    const f=service();Object.assign(f.svc,{visualInputRepo:{get:async()=>null,pin:async()=>{throw new Error('Synthetic failed pin');}}});
    await expect(f.svc.resume(scope,taskId,runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
    expect(boundary.layout).not.toHaveBeenCalled();expect(f.fetcher).not.toHaveBeenCalled();
    expect((await runs.getRunById(runId,scope.tenantId))?.status).toBe('laying_out');
  });

  it('holds historical post-layout runs with no pinned visual evidence',async()=>{
    await runs.updateRunStatus(runId,scope.tenantId,'rendering');
    const f=service();await expect(f.svc.resume(scope,taskId,runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
    expect(f.images).not.toHaveBeenCalled();expect(f.fetcher).not.toHaveBeenCalled();expect(boundary.layout).not.toHaveBeenCalled();
  });
});

describe('visual bundle interpretation',()=>{
  const ctx=():StageContext=>({runId:'run',taskId:'task',tenantId:'tenant',clientId:'client',actorId:'actor',width:100,height:100,tier:'standard',instructions:'',copyBlocks:[],referencePack:{clientId:'client',palette:[]},promotedRules:'',latinFont:'Verdana',arabicFont:'Noto Sans Arabic',client:{} as StageContext['client'],
    photos:[{bytes:photo,dataUrl:dataUrl(photo),mimeType:'image/png',notes:'Keep the original'}],photoCutouts:[undefined],cutoutOutcomes:[{photoIndex:0,passed:false,reason:'No qualified cutout'}]});
  it('pins a negative cutout outcome and rejects scope, policy and missing asset changes',async()=>{
    const original=ctx();const bundle=await captureVisualInputs(original,{cutoutsWanted:true,photoFocus:[null]});
    const recovered=ctx();recovered.photoCutouts=[{png:newCut,width:16,height:16}];
    const stages:Record<string,unknown>={};restoreVisualInputs(recovered,stages,bundle);
    expect(recovered.photoCutouts).toEqual([undefined]);expect(stages).toMatchObject({cutoutsWanted:true,photoFocus:[null]});
    expect(recovered.cutoutOutcomes).toEqual(original.cutoutOutcomes);
    expect(()=>restoreVisualInputs({...ctx(),clientId:'other'}, {}, bundle)).toThrow(/currently authorized/);
    expect(()=>restoreVisualInputs({...ctx(),promotedRules:'changed'}, {}, bundle)).toThrow(/currently authorized/);
    expect(()=>restoreVisualInputs({...ctx(),pipelineV3:true}, {}, bundle)).toThrow(/currently authorized/);
    expect(()=>restoreVisualInputs(ctx(), {}, {...bundle,assets:[]})).toThrow(/missing/);
    expect(()=>restoreVisualInputs(ctx(), {}, {...bundle,manifest:{...(bundle.manifest as Record<string,unknown>),version:1}})).toThrow(/currently authorized/);
    expect(()=>restoreVisualInputs(ctx(), {}, {...bundle,manifest:{...(bundle.manifest as Record<string,unknown>),fonts:undefined}})).toThrow(/currently authorized/);
  });
  it('holds bundles without renderer attestation and cut-out derivations that do not match their pinned bytes',async()=>{
    const bundle=await captureVisualInputs(ctx(),{cutoutsWanted:true,photoFocus:[null]});
    expect(bundle.manifest).toMatchObject({version:3,fonts:{version:2}});
    expect(()=>restoreVisualInputs(ctx(), {}, {...bundle,manifest:{...(bundle.manifest as Record<string,unknown>),version:2}})).toThrow(/renderer/);
    const cut=ctx();cut.photoCutouts=[{png:oldCut,width:16,height:16}];
    cut.cutoutOutcomes=[{photoIndex:0,passed:true,derivation:{sourceSha256:hash(photo),model:'m',modelSha256:'a'.repeat(64),reportSha256:'b'.repeat(64),pngSha256:hash(oldCut)}}];
    const pinned=await captureVisualInputs(cut,{cutoutsWanted:true,photoFocus:[{x:.4,y:.2,derivation:{sourceSha256:hash(photo)}}]});
    const restored=ctx();restoreVisualInputs(restored,{},pinned);expect(restored.photoCutouts?.[0]?.png).toEqual(oldCut);
    const m=pinned.manifest as {outcomes:Array<{derivation:Record<string,unknown>}>;preparation:{photoFocus:Array<Record<string,unknown>>}};
    const altered=(change:(copy:typeof m)=>void)=>{const copy=structuredClone(m);change(copy);return {...pinned,manifest:copy};};
    expect(()=>restoreVisualInputs(ctx(),{},altered(c=>{c.outcomes[0].derivation.pngSha256=hash(newCut);}))).toThrow(/derivation/);
    expect(()=>restoreVisualInputs(ctx(),{},altered(c=>{c.outcomes[0].derivation.sourceSha256=hash(newCut);}))).toThrow(/derivation/);
    expect(()=>restoreVisualInputs(ctx(),{},altered(c=>{c.preparation.photoFocus[0].derivation={sourceSha256:hash(newCut)};}))).toThrow(/derivation/);
    await expect(captureVisualInputs({...cut,cutoutOutcomes:[{...cut.cutoutOutcomes![0],derivation:{...cut.cutoutOutcomes![0].derivation!,pngSha256:hash(newCut)}}]},{})).rejects.toThrow(/derivation/);
  });
});
