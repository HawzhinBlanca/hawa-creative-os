import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCanvaDraft } from '../src/canva-draft-workflow.js';
import type { WorkflowInput } from '../src/design-input.js';

const input:WorkflowInput={taskId:'00000000-0000-4000-c000-000000000002',tenantId:'tenant',clientId:'client',
  rawText:'Synthetic held design',sourcePlatform:'telegram',idempotencyKey:'key',canvaAutoGenerate:true,designStudio:true};
afterEach(()=>vi.unstubAllEnvs());
function recording(journal=new Map<string,unknown>(),sleep=async(_ms:number)=>{}) {
  const sleeps:number[]=[],steps:string[]=[];
  return {journal,sleeps,steps,ctx:{key:'hold-fixture',async run<T>(name:string,action:()=>Promise<T>):Promise<T>{
    steps.push(name);if(journal.has(name))return journal.get(name) as T;
    const value=await action();journal.set(name,value);return value;
  },async sleep(ms:number){sleeps.push(ms);await sleep(ms);}}};
}
function core(holdAt:'start'|'resume',holds=1,code='TASK_PAUSED') {
  vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN','test-only-hold');
  return vi.fn(async(url:unknown,init?:RequestInit)=>{
    const target=String(url),start=target.endsWith('/canva/studio'),resume=target.endsWith('/resume');
    if((holdAt==='start'?start:resume)&&holds-->0)return Response.json({code},{status:409});
    if(start)return Response.json({runId:'run-held',status:'briefing'},{status:202});
    if(resume)return Response.json({runId:'run-held',status:'transferred',designId:'DA_held'});
    if(target.endsWith('/canva/exports'))return Response.json(JSON.parse(String(init?.body)).format==='pptx'
      ?{status:'retrieved',artifact:{content_check:{copyPass:true,fontPass:true}}}:{status:'retrieved',artifact:{id:'preview'}});
    if(target.includes('/canva/parity-check'))return Response.json({parity:'match'});
    if(target.endsWith('/canva'))return Response.json({binding:{designId:'DA_held',version:1}});
    if(target.includes('/notifications/'))return Response.json({ok:true});
    return Response.json({tenantId:'tenant',clientId:'client'});
  });
}
const calls=(remote:ReturnType<typeof core>,suffix:string)=>remote.mock.calls.filter(call=>String(call[0]).endsWith(suffix));
describe('a paused design waits durably',()=>{
  it.each(['start','resume'] as const)('waits at %s, retaining run identity and replaying without another paid request',async holdAt=>{
    const remote=core(holdAt,3),one=recording();
    const output=await runCanvaDraft(input,one.ctx,remote);
    expect(output.status).toBe('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW');
    expect(one.sleeps.filter(ms=>ms>=30_000)).toEqual([30_000,60_000,120_000]);
    expect(calls(remote,'/abandon')).toEqual([]);
    expect(calls(remote,'/notifications/canva-status')).toHaveLength(1);
    if(holdAt==='resume')expect(calls(remote,'/canva/studio')).toHaveLength(1);
    const keys=calls(remote,holdAt==='start'?'/canva/studio':'/resume').map(call=>(call[1]?.headers as Record<string,string>)['Idempotency-Key']);
    expect(new Set(keys).size).toBe(1);
    const replayRemote=core(holdAt,3),replay=recording(one.journal);
    expect(await runCanvaDraft(input,replay.ctx,replayRemote)).toEqual(output);
    expect(replayRemote).not.toHaveBeenCalled();expect(replay.sleeps).toEqual(one.sleeps);
  });
  it('survives a stop after the saved pause answer without abandoning or reporting failure',async()=>{
    const remote=core('resume'),first=recording(undefined,async()=>{throw new Error('synthetic process stop at timer');});
    await expect(runCanvaDraft(input,first.ctx,remote)).rejects.toThrow('synthetic process stop');
    expect(calls(remote,'/abandon')).toEqual([]);expect(calls(remote,'/notifications/canva-status')).toEqual([]);
    const restart=recording(first.journal);
    expect((await runCanvaDraft(input,restart.ctx,remote)).status).toBe('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW');
    expect(calls(remote,'/canva/studio')).toHaveLength(1);
    expect(calls(remote,'/resume')).toHaveLength(2);
  });
  it('caps a prolonged hold at five-minute durable checks',async()=>{
    const remote=core('start',7),one=recording();await runCanvaDraft(input,one.ctx,remote);
    expect(one.sleeps.filter(ms=>ms>=30_000)).toEqual([30_000,60_000,120_000,240_000,300_000,300_000,300_000]);
  });
  it('keeps a hold pending when a context has no durable timer',async()=>{
    const remote=core('start');const ctx={run:async<T>(_name:string,action:()=>Promise<T>)=>action()};
    await expect(runCanvaDraft(input,ctx,remote)).rejects.toMatchObject({code:'TASK_PAUSED',terminal:false});
    expect(calls(remote,'/notifications/canva-status')).toEqual([]);
  });
  it('still treats a cancelled task as a terminal refusal',async()=>{
    const remote=core('start',1,'TASK_GENERATION_BLOCKED'),one=recording();
    expect((await runCanvaDraft(input,one.ctx,remote)).status).toBe('DESIGN_REJECTED');
    expect(one.sleeps).toEqual([]);
    expect(calls(remote,'/notifications/canva-status')).toHaveLength(1);
  });
});
