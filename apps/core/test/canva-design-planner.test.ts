import { describe,it,expect,vi,beforeAll,afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDb,sql } from '@hawa/db';
import { CanvaDesignPlanner,savedDesignCopy } from '../src/services/canva-design-planner.js';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { checkCanvaPptx } from '@hawa/qa';

describe('exact copy selection',()=>{
  it('keeps unfamiliar extra paragraphs and long headings; does not trust a lossy template parse',()=>{
    const heading='A VERY LONG HEADING '.repeat(8),raw=`Use navy.\n---\n${heading}\n\nUnexpected third speaker: J. Example\n\nDo not share.`;
    const result=savedDesignCopy({payload:{rawRequestText:raw,exactCopy:[{text:'WRONG'}]}},'');
    expect(result.copy).toEqual([heading.trim(),'Unexpected third speaker: J. Example','Do not share.']);expect(result.instructions).toBe('Use navy.');
  });
  it('never invents copy for empty or ambiguous instructions',()=>{expect(()=>savedDesignCopy({},'Make something nice')).toThrow('Separate');});
  it.each(['Make a poster in navy.\n---\n','Make a poster in navy.\n___\n   \n\n','Make a poster in navy.\n=====\n\n'])(
    'reports a divider with nothing after it as missing copy, not unsupported copy (%j)',(raw)=>{
      // The worker relays the code to the sender; COPY_UNSUPPORTED would tell them their text used another script.
      let error:any;try{savedDesignCopy({payload:{rawRequestText:raw,exactCopy:[{text:'WRONG'}]}},'');}catch(e){error=e;}
      expect(error).toMatchObject({status:422,code:'COPY_REQUIRED'});expect(error.message).toContain('Nothing follows the divider');
    });
});
const url=process.env.HAWA_ISOLATED_TEST_DB;
if(url&&new URL(url).pathname!=='/hawa_repair')throw new Error('Isolated database required');
describe.skipIf(!url)('durable design planner, real PostgreSQL and mocked model/Canva',()=>{
  // The mocked provider answers as the production model, and the planner rejects a receipt for any
  // model it did not request; so this suite runs the planner on the production tier.
  const priorTier=process.env.HAWA_MODEL_TIER;
  beforeAll(()=>{process.env.HAWA_MODEL_TIER='production';});
  afterAll(()=>{if(priorTier===undefined)delete process.env.HAWA_MODEL_TIER;else process.env.HAWA_MODEL_TIER=priorTier;});
  const db=createDb(url||'postgres://localhost/hawa_repair');
  const scope={tenantId:'00000000-0000-4000-a000-000000000001',actorId:'00000000-0000-4000-b000-000000000001'};
  const clientId='c1000000-0000-4000-8000-000000000002';
  const logoCandidates = [
    'packages/creative/assets/logos/kaae-official-logo.png',
    resolve(process.cwd(), '../../packages/creative/assets/logos/kaae-official-logo.png'),
    resolve(process.cwd(), 'packages/creative/assets/logos/kaae-official-logo.png'),
  ];
  const foundLogo = logoCandidates.find(p => existsSync(p));
  const logo = foundLogo ? readFileSync(foundLogo) : Buffer.alloc(32);
  const ratio = logo.length >= 24 ? (logo.readUInt32BE(16) / (logo.readUInt32BE(20) || 1)) || 1 : 1;
  const plan={width:1200,height:1697,background:'#081F35',shapes:[],logo:{x:500,y:50,width:200,height:200/ratio},text:[
    {copyIndex:0,x:100,y:600,width:1000,height:100,fontSize:32,fontFamily:'Verdana',color:'#fff2db',align:'center'},
    {copyIndex:1,x:100,y:750,width:1000,height:100,fontSize:24,fontFamily:'Verdana',color:'#fff2db',align:'left'}]};
  const intake=async()=> (await persistChatIntake(db,{platform:'telegram',sourceEventId:randomUUID(),sourceChannelId:'isolated-planner',clientId,title:'[TEST] Plan',rawText:'Use navy.\n---\nEXACT TITLE\n\nExact body. Never rewrite it.',designInstructions:'Use navy.',exactCopy:[]})).task.id;
  const make=(fetcher:any)=>{const api={importEditableDesign:vi.fn().mockResolvedValue({operationId:randomUUID(),status:'submitted'})} as unknown as CanvaConnectService;return {api,planner:new CanvaDesignPlanner(db,api,{apiKey:'test-only',fetcher})};};
  const response=(model='gpt-6-astra',value:any=plan)=>Response.json({id:'chatcmpl-real-shaped-test',model,choices:[{message:{content:typeof value==='string'?value:JSON.stringify(value)}}],usage:{prompt_tokens:123,completion_tokens:456}});
  beforeAll(async()=>{await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${scope.actorId}::uuid,'isolated-operator@example.test','Test') ON CONFLICT DO NOTHING`.execute(db);
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${scope.tenantId}::uuid,'kaae','KAAE') ON CONFLICT DO NOTHING`.execute(db);});
  afterAll(()=>db.destroy());
  it('makes one paid call across simultaneous clicks and resumes immutable bytes after replacement',async()=>{
    const id=await intake(),remote=vi.fn(async()=>{await new Promise(r=>setTimeout(r,30));return response();}),{api,planner}=make(remote);
    await Promise.all([planner.generate(scope,id,'plan-key-001',1200,1697),planner.generate(scope,id,'plan-key-002',1200,1697)]);
    expect(remote).toHaveBeenCalledTimes(1);
    const saved=(await sql<any>`SELECT * FROM hawa.canva_design_plans WHERE task_id=${id}::uuid`.execute(db)).rows[0];
    expect(saved.status).toBe('planned');expect(saved.result.manifest.copy).toEqual(['EXACT TITLE','Exact body. Never rewrite it.']);
    expect(saved.result.receipt.returnedModel).toBe('gpt-6-astra');
    await new CanvaDesignPlanner(db,api,{apiKey:'test-only',fetcher:remote}).resume(scope,id,saved.id);
    expect(remote).toHaveBeenCalledTimes(1);expect(api.importEditableDesign).toHaveBeenCalledWith(scope,id,'plan-'+saved.id,expect.objectContaining({sha256:saved.source_sha256}));
    await expect(sql`UPDATE hawa.canva_design_plans SET request='{}'::jsonb WHERE id=${saved.id}::uuid`.execute(db)).rejects.toThrow('immutable');
    await expect(planner.resume({...scope,actorId:randomUUID()},id,saved.id)).rejects.toThrow('not found');
    await expect(sql`UPDATE hawa.tasks SET client_id=NULL WHERE id=${id}::uuid`.execute(db)).rejects.toThrow();
  });
  it('sets Sorani blocks right-to-left in the provisional script typeface and records it in the manifest',async()=>{
    const id=(await persistChatIntake(db,{platform:'telegram',sourceEventId:randomUUID(),sourceChannelId:'isolated-planner',clientId,title:'[TEST] Sorani plan',
      rawText:'Use navy.\n---\nEXACT TITLE\n\nوۆرکشۆپی دڵنیایی جۆری بۆ بەرپرسانی زانکۆکان، ٢٨ی ئەیلوول ٢٠٢٦',designInstructions:'Use navy.',exactCopy:[]})).task.id;
    const modelPlan=structuredClone(plan) as any;modelPlan.text[1].fontFamily='Noto Sans Arabic'; // the model may name the script typeface on the Sorani block; the server decides direction either way
    const remote=vi.fn(async()=>response('gpt-6-astra',modelPlan));
    const {api,planner}=make(remote);
    const result=await planner.generate(scope,id,'sorani-key-01',1200,1697);
    expect(result.status).toBe('submitted');expect(remote).toHaveBeenCalledTimes(1);
    const sent=JSON.parse(remote.mock.calls[0][1].body);expect(sent.messages[0].content).toContain('Sorani Kurdish');
    expect(JSON.parse(sent.messages[1].content).copyScripts).toEqual(['latin','arabic']);
    const saved=(await sql<any>`SELECT * FROM hawa.canva_design_plans WHERE task_id=${id}::uuid`.execute(db)).rows[0];
    expect(saved.status).toBe('planned');
    expect(saved.result.manifest).toMatchObject({copyScripts:['latin','arabic'],rtlFont:'Noto Sans Arabic',rtlFontProvisional:true,rtlBlocks:1});
    expect(saved.result.manifest.plan.text[1]).toMatchObject({rtl:true,align:'right',fontFamily:'Noto Sans Arabic'});
    expect(saved.result.manifest.plan.text[0]).toMatchObject({fontFamily:'Verdana'});
    const check=checkCanvaPptx(new Uint8Array(saved.source_content),saved.result.manifest.copy,'Verdana',{scriptFonts:{arabic:'Noto Sans Arabic'}});
    expect(check).toMatchObject({copyPass:true,fontPass:true,rtlPass:true,arabicTextObjectCount:1,rtlTextObjectCount:1});
  });
  it('refuses copy in a script the transfer cannot set, before any paid call',async()=>{
    const id=(await persistChatIntake(db,{platform:'telegram',sourceEventId:randomUUID(),sourceChannelId:'isolated-planner',clientId,title:'[TEST] CJK plan',
      rawText:'Use navy.\n---\nEXACT TITLE\n\n质量保证研讨会',designInstructions:'Use navy.',exactCopy:[]})).task.id;
    const remote=vi.fn(async()=>response());const {api,planner}=make(remote);
    await expect(planner.generate(scope,id,'cjk-key-01',1200,1697)).rejects.toMatchObject({code:'COPY_UNSUPPORTED'});
    expect(remote).not.toHaveBeenCalled();expect(api.importEditableDesign).not.toHaveBeenCalled();
  });
  it('refuses a divider with nothing after it as missing copy, before any paid call',async()=>{
    const id=(await persistChatIntake(db,{platform:'telegram',sourceEventId:randomUUID(),sourceChannelId:'isolated-planner',clientId,title:'[TEST] No-copy plan',
      rawText:'Make a poster in navy.\n---\n',designInstructions:'Make a poster in navy.',exactCopy:[]})).task.id;
    const remote=vi.fn(async()=>response());const {api,planner}=make(remote);
    await expect(planner.generate(scope,id,'nocopy-key-01',1200,1697)).rejects.toMatchObject({status:422,code:'COPY_REQUIRED'});
    expect(remote).not.toHaveBeenCalled();expect(api.importEditableDesign).not.toHaveBeenCalled();
  });
  it.each(['wrong-model','rewritten-copy','overlap','missing-block'])('rejects %s without a Canva side effect',async(mode)=>{
    const id=await intake(),bad=structuredClone(plan) as any;
    if(mode==='rewritten-copy')bad.text[0].text='forged copy';
    if(mode==='overlap')bad.text[1].y=bad.text[0].y;
    if(mode==='missing-block')bad.text.pop();
    const {api,planner}=make(vi.fn(async()=>response(mode==='wrong-model'?'another-model':'gpt-6-astra',bad)));
    const result=await planner.generate(scope,id,'reject-key-01',1200,1697);expect(result.status).toBe('failed');expect(api.importEditableDesign).not.toHaveBeenCalled();
  });
  it('does not repeat an uncertain model charge after a lost response',async()=>{
    const id=await intake(),remote=vi.fn(async()=>{throw new Error('lost');}),{api,planner}=make(remote);
    expect((await planner.generate(scope,id,'lost-key-001',1200,1697)).status).toBe('uncertain');
    expect((await planner.generate(scope,id,'lost-key-002',1200,1697)).status).toBe('uncertain');
    expect(remote).toHaveBeenCalledTimes(1);expect(api.importEditableDesign).not.toHaveBeenCalled();
  });
  it('lets an operator abandon an uncertain plan so the task can be planned again; evidence stays',async()=>{
    const id=await intake(),lost=vi.fn(async()=>{throw new Error('lost');}),{planner}=make(lost);
    const stuck=await planner.generate(scope,id,'abandon-key-01',1200,1697);expect(stuck.status).toBe('uncertain');
    await expect(planner.abandon(scope,id,stuck.planId,'')).rejects.toThrow('reason');
    const retired=await planner.abandon(scope,id,stuck.planId,'Model outage confirmed; retry.');expect(retired.status).toBe('abandoned');
    await expect(planner.abandon(scope,id,stuck.planId,'twice')).rejects.toThrow('cannot be abandoned');
    await expect(sql`UPDATE hawa.canva_design_plans SET diagnostic='tamper' WHERE id=${stuck.planId}::uuid`.execute(db)).rejects.toThrow('final');
    const good=vi.fn(async()=>response()),{api:api2,planner:planner2}=make(good);
    const fresh=await planner2.generate(scope,id,'abandon-key-02',1200,1697);
    expect(good).toHaveBeenCalledTimes(1);expect(fresh.status).toBe('submitted');expect(api2.importEditableDesign).toHaveBeenCalledTimes(1);
    const rows=(await sql<any>`SELECT status FROM hawa.canva_design_plans WHERE task_id=${id}::uuid ORDER BY created_at`.execute(db)).rows.map(r=>r.status);
    expect(rows).toEqual(['abandoned','planned']);
  });
  it('correctly parses model output wrapped in markdown codeblocks and conversational intro/outro',async()=>{
    const id=await intake();
    const conversationalText = `Here is the academic invitation design layout you requested:\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n\nI have followed all brand rules carefully.`;
    const remote = vi.fn(async() => Response.json({
      id:'chatcmpl-conversational-test',
      model:'gpt-6-astra',
      usage:{prompt_tokens:120,completion_tokens:450},
      choices:[{message:{content:conversationalText}}]
    }));
    const {api,planner}=make(remote);
    const result=await planner.generate(scope,id,'conv-key-001',1200,1697);
    expect(result.status).toBe('submitted');
    expect(api.importEditableDesign).toHaveBeenCalled();
  });
  it('threads prior layout and revision directive into a 4-turn conversational session for revisions',async()=>{
    // 1. First draft creates an initial plan
    const initialTaskId=await intake();
    const remoteInitial=vi.fn(async()=>response('gpt-6-astra',plan));
    const {planner:planner1}=make(remoteInitial);
    const initialResult=await planner1.generate(scope,initialTaskId,'plan-init-001',1200,1697);
    expect(initialResult.status).toBe('submitted');
    expect(remoteInitial).toHaveBeenCalledTimes(1);
    const initialSent=JSON.parse(remoteInitial.mock.calls[0][1].body);
    expect(initialSent.messages).toHaveLength(2);
    expect(initialSent.messages[0].role).toBe('system');
    expect(initialSent.messages[1].role).toBe('user');

    const initialSaved=(await sql<any>`SELECT * FROM hawa.canva_design_plans WHERE task_id=${initialTaskId}::uuid`.execute(db)).rows[0];
    expect(initialSaved.status).toBe('planned');
    expect(initialSaved.result.manifest.conversationalRevision).toBe(false);
    expect(initialSaved.result.manifest.turns).toBe(2);

    // 2. Revision task created with parentTaskId and revision directive
    const revisionDirective='swap the keynote and mou columns and make the gold bar 300px wide';
    const revisionTaskId=(await persistChatIntake(db,{
      platform:'telegram',
      sourceEventId:randomUUID(),
      sourceChannelId:'isolated-planner',
      clientId,
      title:'[TEST] Plan (Revision)',
      rawText:'Use navy.\n---\nEXACT TITLE\n\nExact body. Never rewrite it.',
      designInstructions:`Use navy.\nOperator Revision Directive: ${revisionDirective}`,
      exactCopy:[],
      studioOptions:{
        parentTaskId:initialTaskId,
        revisionRound:1,
      },
    })).task.id;

    // Model returns updated plan
    const updatedPlan=structuredClone(plan);
    updatedPlan.shapes.push({x:400,y:350,width:300,height:4,color:'#F7B500'});
    const remoteRevision=vi.fn(async()=>response('gpt-6-astra',updatedPlan));
    const {planner:planner2}=make(remoteRevision);

    const revisionResult=await planner2.generate(scope,revisionTaskId,'plan-rev-001',1200,1697);
    expect(revisionResult.status).toBe('submitted');
    expect(remoteRevision).toHaveBeenCalledTimes(1);

    const revisionSent=JSON.parse(remoteRevision.mock.calls[0][1].body);
    expect(revisionSent.messages).toHaveLength(2);

    // Turn 0: System with revision mode guidelines
    expect(revisionSent.messages[0].role).toBe('system');
    expect(revisionSent.messages[0].content).toContain('REVISION MODE');

    // Turn 1: User content with directive
    expect(revisionSent.messages[1].role).toBe('user');
    const userContentText = Array.isArray(revisionSent.messages[1].content)
      ? revisionSent.messages[1].content[0].text
      : revisionSent.messages[1].content;
    expect(userContentText).toContain(revisionDirective);

    // Prior layout was NOT forced as an assistant turn constraint
    expect(revisionSent.messages.some((m: any) => m.role === 'assistant')).toBe(false);

    // Verify DB manifest records revision evidence
    const revisionSaved=(await sql<any>`SELECT * FROM hawa.canva_design_plans WHERE task_id=${revisionTaskId}::uuid`.execute(db)).rows[0];
    expect(revisionSaved.status).toBe('planned');
    expect(revisionSaved.result.manifest.isRevision).toBe(true);
    expect(revisionSaved.result.manifest.priorPlanId).toBe(initialSaved.id);
    expect(revisionSaved.result.manifest.turns).toBe(2);
  });

  it('breaks free from previous layout coordinates and supports multimodal reference photo when user requests redesign', async () => {
    // 1. Initial plan
    const initialTaskId = await intake();
    const remoteInitial = vi.fn(async () => response('gpt-6-astra', plan));
    const { planner: planner1 } = make(remoteInitial);
    await planner1.generate(scope, initialTaskId, 'plan-init-rd-001', 1200, 1697);

    // 2. Redesign directive matching user's exact complaint
    const redesignDirective = 'thats designs are bullshot i keep sending feedback but gives me similar design, here its stuck with a design';
    const fakeBase64 = 'data:image/jpeg;base64,VGhpcyBpcyBhIGZha2UgaW1hZ2U=';
    const redesignTaskId = (await persistChatIntake(db, {
      platform: 'telegram',
      sourceEventId: randomUUID(),
      sourceChannelId: 'isolated-planner',
      clientId,
      title: '[TEST] Plan (Redesign)',
      rawText: 'Use navy.\n---\nEXACT TITLE\n\nExact body. Never rewrite it.',
      designInstructions: `Use navy.\nOperator Revision Directive: ${redesignDirective}`,
      exactCopy: [],
      studioOptions: {
        parentTaskId: initialTaskId,
        revisionRound: 1,
        referenceImageBase64: fakeBase64,
      },
    })).task.id;

    const freshPlan = structuredClone(plan);
    freshPlan.background = '#0A1628';
    const remoteRedesign = vi.fn(async () => response('gpt-6-astra', freshPlan));
    const { planner: planner2 } = make(remoteRedesign);

    const result = await planner2.generate(scope, redesignTaskId, 'plan-redesign-001', 1200, 1697);
    expect(result.status).toBe('submitted');
    expect(remoteRedesign).toHaveBeenCalledTimes(1);

    const sent = JSON.parse(remoteRedesign.mock.calls[0][1].body);
    expect(sent.messages).toHaveLength(2);
    // Turn 0: System prompt has redesign directive and vision note
    expect(sent.messages[0].role).toBe('system');
    expect(sent.messages[0].content).toContain('CREATIVE REDESIGN DIRECTIVE');
    expect(sent.messages[0].content).toContain('COMPLETELY BREAK FREE');
    expect(sent.messages[0].content).toContain('REFERENCE IMAGE ATTACHED');

    // Turn 1: User content is multimodal with image_url and critique
    expect(sent.messages[1].role).toBe('user');
    expect(Array.isArray(sent.messages[1].content)).toBe(true);
    expect(sent.messages[1].content[0].type).toBe('text');
    expect(sent.messages[1].content[0].text).toContain(redesignDirective);
    expect(sent.messages[1].content[1].type).toBe('image_url');
    expect(sent.messages[1].content[1].image_url.url).toBe(fakeBase64);

    // Prior layout was NOT forced as an assistant turn constraint
    expect(sent.messages.some((m: any) => m.role === 'assistant')).toBe(false);

    // Verify DB manifest records redesign & reference image
    const redesignSaved = (await sql<any>`SELECT * FROM hawa.canva_design_plans WHERE task_id=${redesignTaskId}::uuid`.execute(db)).rows[0];
    expect(redesignSaved.status).toBe('planned');
    expect(redesignSaved.result.manifest.isRedesign).toBe(true);
    expect(redesignSaved.result.manifest.conversationalRevision).toBe(false);
    expect(redesignSaved.result.manifest.hasReferenceImage).toBe(true);
    expect(redesignSaved.result.manifest.turns).toBe(2);
  });

  it('re-drives a failed design plan without conflict and successfully plans a new design', async () => {
    const taskId = (await persistChatIntake(db, {
      platform: 'telegram',
      sourceEventId: randomUUID(),
      sourceChannelId: 'tg-failed-test',
      rawText: 'Use navy.\n---\nKAAE Gala Dinner Invitation\n\nHonoring Ministers and Delegates.',
      clientId,
      title: 'KAAE Gala Dinner',
      designInstructions: 'Official diplomatic dinner invitation',
      exactCopy: [],
    })).task.id;

    // First attempt fails with MODEL_HTTP_400 (e.g. provider balance or model error)
    const failingFetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Credit exhausted' } }), { status: 400 }));
    const { planner: failingPlanner } = make(failingFetch);

    const firstResult = await failingPlanner.generate(scope, taskId, 'plan-fail-key-01', 1200, 1697);
    expect(firstResult.status).toBe('failed');

    // Verify DB records failed plan
    const failedPlanRow = (await sql<any>`SELECT * FROM hawa.canva_design_plans WHERE task_id=${taskId}::uuid ORDER BY created_at DESC LIMIT 1`.execute(db)).rows[0];
    expect(failedPlanRow.status).toBe('failed');

    // Second attempt (re-drive): provider is working again with gpt-6-astra
    const freshPlan = structuredClone(plan);
    freshPlan.background = '#0A1628';
    const workingFetch = vi.fn(async () => response('gpt-6-astra', freshPlan));
    const { planner: workingPlanner } = make(workingFetch);

    const retryResult = await workingPlanner.generate(scope, taskId, 'plan-fail-key-01', 1200, 1697);
    expect(retryResult.status).toBe('submitted');

    // Verify the prior failed plan was marked abandoned and a new planned row exists
    const allPlans = (await sql<any>`SELECT * FROM hawa.canva_design_plans WHERE task_id=${taskId}::uuid ORDER BY created_at ASC`.execute(db)).rows;
    expect(allPlans).toHaveLength(2);
    expect(allPlans[0].status).toBe('abandoned');
    expect(allPlans[1].status).toBe('planned');
  });
});



