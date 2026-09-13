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
});
const url=process.env.HAWA_ISOLATED_TEST_DB;
if(url&&new URL(url).pathname!=='/hawa_repair')throw new Error('Isolated database required');
describe.skipIf(!url)('durable design planner, real PostgreSQL and mocked model/Canva',()=>{
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
    {copyIndex:0,x:100,y:600,width:1000,height:100,fontSize:32,fontFamily:'Minion Variable Concept',color:'#fff2db',align:'center'},
    {copyIndex:1,x:100,y:750,width:1000,height:100,fontSize:24,fontFamily:'Minion Variable Concept',color:'#fff2db',align:'left'}]};
  const intake=async()=> (await persistChatIntake(db,{platform:'telegram',sourceEventId:randomUUID(),sourceChannelId:'isolated-planner',clientId,title:'[TEST] Plan',rawText:'Use navy.\n---\nEXACT TITLE\n\nExact body. Never rewrite it.',designInstructions:'Use navy.',exactCopy:[]})).task.id;
  const make=(fetcher:any)=>{const api={importEditableDesign:vi.fn().mockResolvedValue({operationId:randomUUID(),status:'submitted'})} as unknown as CanvaConnectService;return {api,planner:new CanvaDesignPlanner(db,api,{apiKey:'test-only',fetcher})};};
  const response=(model='claude-opus-5',value:any=plan)=>Response.json({id:'msg-real-shaped-test',model,stop_reason:'end_turn',usage:{input_tokens:123,output_tokens:456},content:[{type:'text',text:JSON.stringify(value)}]});
  beforeAll(async()=>{await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${scope.actorId}::uuid,'isolated-operator@example.test','Test') ON CONFLICT DO NOTHING`.execute(db);
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${scope.tenantId}::uuid,'kaae','KAAE') ON CONFLICT DO NOTHING`.execute(db);});
  afterAll(()=>db.destroy());
  it('makes one paid call across simultaneous clicks and resumes immutable bytes after replacement',async()=>{
    const id=await intake(),remote=vi.fn(async()=>{await new Promise(r=>setTimeout(r,30));return response();}),{api,planner}=make(remote);
    await Promise.all([planner.generate(scope,id,'plan-key-001',1200,1697),planner.generate(scope,id,'plan-key-002',1200,1697)]);
    expect(remote).toHaveBeenCalledTimes(1);
    const saved=(await sql<any>`SELECT * FROM hawa.canva_design_plans WHERE task_id=${id}::uuid`.execute(db)).rows[0];
    expect(saved.status).toBe('planned');expect(saved.result.manifest.copy).toEqual(['EXACT TITLE','Exact body. Never rewrite it.']);
    expect(saved.result.receipt.returnedModel).toBe('claude-opus-5');
    await new CanvaDesignPlanner(db,api,{apiKey:'test-only',fetcher:remote}).resume(scope,id,saved.id);
    expect(remote).toHaveBeenCalledTimes(1);expect(api.importEditableDesign).toHaveBeenCalledWith(scope,id,'plan-'+saved.id,expect.objectContaining({sha256:saved.source_sha256}));
    await expect(sql`UPDATE hawa.canva_design_plans SET request='{}'::jsonb WHERE id=${saved.id}::uuid`.execute(db)).rejects.toThrow('immutable');
    await expect(planner.resume({...scope,actorId:randomUUID()},id,saved.id)).rejects.toThrow('not found');
    await expect(sql`UPDATE hawa.tasks SET client_id=NULL WHERE id=${id}::uuid`.execute(db)).rejects.toThrow();
  });
  it('sets Sorani blocks right-to-left in the provisional script typeface and records it in the manifest',async()=>{
    const id=(await persistChatIntake(db,{platform:'telegram',sourceEventId:randomUUID(),sourceChannelId:'isolated-planner',clientId,title:'[TEST] Sorani plan',
      rawText:'Use navy.\n---\nEXACT TITLE\n\nوۆرکشۆپی دڵنیایی جۆری بۆ بەرپرسانی زانکۆکان، ٢٨ی ئەیلوول ٢٠٢٦',designInstructions:'Use navy.',exactCopy:[]})).task.id;
    const remote=vi.fn(async()=>response('claude-opus-5',plan)); // the model returns the reference font for every block; the server decides script font and direction
    const {api,planner}=make(remote);
    const result=await planner.generate(scope,id,'sorani-key-01',1200,1697);
    expect(result.status).toBe('submitted');expect(remote).toHaveBeenCalledTimes(1);
    const sent=JSON.parse(remote.mock.calls[0][1].body);expect(sent.system).toContain('Sorani Kurdish');
    expect(JSON.parse(sent.messages[0].content).copyScripts).toEqual(['latin','arabic']);
    const saved=(await sql<any>`SELECT * FROM hawa.canva_design_plans WHERE task_id=${id}::uuid`.execute(db)).rows[0];
    expect(saved.status).toBe('planned');
    expect(saved.result.manifest).toMatchObject({copyScripts:['latin','arabic'],rtlFont:'Noto Sans Arabic',rtlFontProvisional:true,rtlBlocks:1,rtlBlocks:1});
    expect(saved.result.manifest.plan.text[1]).toMatchObject({rtl:true,align:'right',fontFamily:'Noto Sans Arabic'});
    expect(saved.result.manifest.plan.text[0]).toMatchObject({fontFamily:'Minion Variable Concept'});
    const check=checkCanvaPptx(new Uint8Array(saved.source_content),saved.result.manifest.copy,'Minion Variable Concept',{scriptFonts:{arabic:'Noto Sans Arabic'}});
    expect(check).toMatchObject({copyPass:true,fontPass:true,rtlPass:true,arabicTextObjectCount:1,rtlTextObjectCount:1});
  });
  it('refuses copy in a script the transfer cannot set, before any paid call',async()=>{
    const id=(await persistChatIntake(db,{platform:'telegram',sourceEventId:randomUUID(),sourceChannelId:'isolated-planner',clientId,title:'[TEST] CJK plan',
      rawText:'Use navy.\n---\nEXACT TITLE\n\n质量保证研讨会',designInstructions:'Use navy.',exactCopy:[]})).task.id;
    const remote=vi.fn(async()=>response());const {api,planner}=make(remote);
    await expect(planner.generate(scope,id,'cjk-key-01',1200,1697)).rejects.toMatchObject({code:'COPY_UNSUPPORTED'});
    expect(remote).not.toHaveBeenCalled();expect(api.importEditableDesign).not.toHaveBeenCalled();
  });
  it.each(['wrong-model','rewritten-copy','overlap','missing-block'])('rejects %s without a Canva side effect',async(mode)=>{
    const id=await intake(),bad=structuredClone(plan) as any;
    if(mode==='rewritten-copy')bad.text[0].text='forged copy';
    if(mode==='overlap')bad.text[1].y=bad.text[0].y;
    if(mode==='missing-block')bad.text.pop();
    const {api,planner}=make(vi.fn(async()=>response(mode==='wrong-model'?'another-model':'claude-opus-5',bad)));
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
      id:'msg-conversational-test',
      model:'claude-opus-5',
      stop_reason:'end_turn',
      usage:{input_tokens:120,output_tokens:450},
      content:[{type:'text',text:conversationalText}]
    }));
    const {api,planner}=make(remote);
    const result=await planner.generate(scope,id,'conv-key-001',1200,1697);
    expect(result.status).toBe('submitted');
    expect(api.importEditableDesign).toHaveBeenCalled();
  });
});
