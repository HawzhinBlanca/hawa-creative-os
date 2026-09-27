import {expect,it,vi} from 'vitest';
import {reserveStudioText} from '@hawa/creative';
import {executePlannerCall} from '../src/services/canva-planner-call.js';
const model='gpt-4.1-mini';
const body=JSON.stringify({model,messages:[{role:'user',content:'synthetic layout'}],response_format:{type:'text'},max_completion_tokens:4000,service_tier:'default'});
const reservation=reserveStudioText(body);
const layout={width:1000,height:1000,background:'#ffffff',text:[{x:10,y:10,width:300,height:100,copyIndex:0,role:'headline',bold:false,fontSize:32,fontFamily:'Verdana',color:'#000000',align:'left'}],shapes:[],logo:{x:700,y:700,width:100,height:100}};
const payload=()=>({id:'synthetic-layout-1',model,usage:{prompt_tokens:100,completion_tokens:200,total_tokens:300},choices:[{finish_reason:'stop',message:{content:JSON.stringify(layout)}}]});
const run=(fetcher:typeof fetch)=>executePlannerCall('synthetic-key',body,model,reservation,fetcher);
it('sends the exact quoted bytes once and retains typed layout, actual usage and native receipt',async()=>{
 const fetcher=vi.fn<typeof fetch>(async()=>Response.json(payload(),{headers:{'x-request-id':'request-1'}}));
 const result=await run(fetcher);
 expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][1]?.body).toBe(body);expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
 expect(result).toMatchObject({acceptance:'response_received',costBasis:'usage',requiresReconciliation:false,layout,responseId:'synthetic-layout-1',providerRequestId:'request-1',inputTokens:100,outputTokens:200,diagnostic:'LAYOUT_SAVED'});
 expect(result.costUsd).toBeGreaterThan(0);expect(result.responseSha256).toMatch(/^[a-f0-9]{64}$/);
});
it.each([408,500,502,503])('retains uncertainty on HTTP %s, never treating it as a zero-cost rejection',async status=>{
 const result=await run(vi.fn(async()=>Response.json({error:{message:'private-body'}},{status})));
 expect(result).toMatchObject({acceptance:'unknown',costBasis:'unavailable',costUsd:null,requiresReconciliation:true,layout:null});
 expect(JSON.stringify(result)).not.toContain('private-body');
});
it.each([400,401,403,422,429])('records definite HTTP %s nonacceptance without retaining provider error text',async status=>{
 const result=await run(vi.fn(async()=>Response.json({error:{message:'secret-provider-error'}},{status})));
 expect(result).toMatchObject({acceptance:'not_accepted',costBasis:'not_accepted',costUsd:0,requiresReconciliation:false});
 expect(JSON.stringify(result)).not.toContain('secret-provider-error');
});
it.each(['missing','negative','fraction','wrong-total'])('keeps %s usage unknown while preserving the valid layout',async mode=>{
 const p:Record<string,unknown>=payload();
 if(mode==='missing')delete p.usage;
 else p.usage={prompt_tokens:100,completion_tokens:mode==='negative'?-1:mode==='fraction'?1.5:200,total_tokens:1};
 expect(await run(vi.fn(async()=>Response.json(p)))).toMatchObject({costUsd:null,inputTokens:null,outputTokens:null,requiresReconciliation:true,layout,diagnostic:'MODEL_USAGE_INCOMPLETE'});
});
it('holds an overrun with its observed charge and typed layout',async()=>{
 const p=payload();p.usage={prompt_tokens:100,completion_tokens:5000,total_tokens:5100};
 expect(await run(vi.fn(async()=>Response.json(p)))).toMatchObject({costBasis:'usage',requiresReconciliation:true,layout,diagnostic:'MODEL_RESERVATION_EXCEEDED'});
});
it.each(['model','missing-id','prose','extra-field','missing-role','truncated','missing-finish'])('does not accept %s as a usable strict reply',async mode=>{
 const p=payload();
 if(mode==='model')p.model='different-model';
 if(mode==='missing-id')p.id='';
 if(mode==='prose')p.choices[0].message.content='```json\n'+JSON.stringify(layout)+'\n```';
 if(mode==='extra-field')p.choices[0].message.content=JSON.stringify({...layout,instructions:'do something else'});
 if(mode==='missing-role')p.choices[0].message.content=JSON.stringify({...layout,text:layout.text.map(({role,...rest})=>rest)});
 if(mode==='truncated')p.choices[0].finish_reason='length';
 if(mode==='missing-finish')delete (p.choices[0] as {finish_reason?:string}).finish_reason;
 expect((await run(vi.fn(async()=>Response.json(p)))).layout).toBeNull();
});
it('bounds response bytes and sanitizes transport exceptions',async()=>{
 expect(await run(vi.fn(async()=>new Response('x'.repeat(512*1024+1))))).toMatchObject({requiresReconciliation:true,layout:null});
 const result=await run(vi.fn(async()=>{throw new Error('credential-and-private-prompt');}));
 expect(result).toMatchObject({costUsd:null,requiresReconciliation:true});expect(JSON.stringify(result)).not.toContain('private');
});

it('retains the allowance when a layout claims zero output tokens',async()=>{
 const p=payload();p.usage={prompt_tokens:100,completion_tokens:0,total_tokens:100};
 expect(await run(vi.fn(async()=>Response.json(p)))).toMatchObject({requiresReconciliation:true,outputTokens:0});
});
