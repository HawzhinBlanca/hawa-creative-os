import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext, DesignStudioRepository, StudioVisualInputsRepository, StudioVisualInputsError, blobStoreFromEnv } from '@hawa/db';
import { ExemplarRetrievalIndex, renderMotifPng } from '@hawa/creative';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { PhotoCutouts } from '../src/services/design-studio/photo-cutouts.js';
import { resolveClientDesignReference } from '../src/services/client-design-reference.js';
import { captureVisualInputs, restoreVisualInputs } from '../src/services/design-studio/visual-inputs.js';
import { layoutVisualInputs } from '../src/services/design-studio/stages/asset-inputs.js';
import type { StageContext } from '../src/services/design-studio/types.js';

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
  });
});
