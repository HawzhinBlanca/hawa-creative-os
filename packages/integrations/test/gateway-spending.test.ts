import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { RequestContext, StructuredModelRequest } from '@hawa/contracts';
import { ResilientModelGateway } from '../src/model-gateway.js';
import { gatewayUsage, quoteGatewayRequest } from '../src/gateway-spending.js';

const ctx: RequestContext = { tenantId:'spending-test',actor:{type:'workflow',id:'test'},correlationId:'test',
  deadline:'2026-11-01T00:00:00Z',idempotencyKey:'test' };
const request: StructuredModelRequest = {role:'intake_router',inputs:[{kind:'text',text:'Route this brief'}],
  systemPromptVersion:'test',responseSchema:{type:'object'},maxOutputTokens:2048,
  budget:{maxAttempts:3,maxCostUsd:1,maxLatencyMs:5000},egressPolicy:{mode:'approved_providers',allowedProviders:['google','anthropic','openai']},cachePolicy:'disabled'};
const model = {google:'gemini-3.8-flash',anthropic:'claude-sonnet-5',openai:'gpt-4o'};
type Provider = keyof typeof model;
function setup(provider: Provider) {
  vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
  for (const key of ['GEMINI_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY']) vi.stubEnv(key,'synthetic-gateway-key');
  const gateway=new ResilientModelGateway();
  if (provider !== 'google') gateway.setDeploymentAdmission(model.google,'blocked');
  if (provider === 'openai') gateway.setDeploymentAdmission(model.anthropic,'blocked');
  return gateway;
}
function response(provider: Provider, usage?: unknown) {
  const value='{"decision":"route_matched"}';
  return new Response(JSON.stringify(provider === 'google'
    ? {modelVersion:model.google,candidates:[{content:{parts:[{text:value}]}}],usageMetadata:usage}
    : provider === 'anthropic' ? {model:model.anthropic,content:[{type:'text',text:value}],usage}
      : {model:model.openai,choices:[{message:{content:value}}],usage}),{status:200,headers:{'x-request-id':'test-receipt'}});
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();});

describe.each(['google','anthropic','openai'] as const)('%s gateway spending admission',provider=>{
  it('refuses a positive but unaffordable budget before any transport or cheaper fallback',async()=>{
    const gateway=setup(provider), fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(provider));
    const result=await gateway.generateStructured(ctx,{...request,budget:{...request.budget,maxCostUsd:.000001}});
    expect(result).toMatchObject({ok:false,error:{code:'MODEL_BUDGET_EXHAUSTED',retryable:false,detail:{acceptance:'not_dispatched',requiresReconciliation:false}}});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sends the declared output cap and returns the hash of those exact bytes',async()=>{
    const gateway=setup(provider), fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(provider));
    const result=await gateway.generateStructured(ctx,{...request,maxOutputTokens:3333});
    expect(result.ok).toBe(true);
    const body=String(fetcher.mock.calls[0]?.[1]?.body), payload=JSON.parse(body);
    expect(provider === 'google' ? payload.generationConfig.maxOutputTokens
      : provider === 'anthropic' ? payload.max_tokens : payload.max_completion_tokens).toBe(3333);
    if (result.ok) expect(result.value.spending).toMatchObject({requestSha256:createHash('sha256').update(body).digest('hex'),
      outputTokens:3333,providerRequestId:'test-receipt',servedModelId:model[provider]});
  });
  it('keeps missing usage unknown instead of inventing tokens or cost',async()=>{
    const gateway=setup(provider); vi.spyOn(globalThis,'fetch').mockResolvedValue(response(provider));
    const result=await gateway.generateStructured(ctx,request);
    expect(result.ok).toBe(true);
    if(result.ok){
      expect(result.value.usage).toEqual({costBasis:'unknown'});
      expect(result.value.spending?.usd).toBeGreaterThan(0);
    }
  });
  it('preserves observed overrun cost and stops without a paid fallback',async()=>{
    const gateway=setup(provider);
    const usage=provider === 'google' ? {promptTokenCount:1_000_000,candidatesTokenCount:100,totalTokenCount:1_000_100}
      : provider === 'anthropic' ? {input_tokens:1_000_000,output_tokens:100} : {prompt_tokens:1_000_000,completion_tokens:100};
    const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(provider,usage));
    const result=await gateway.generateStructured(ctx,request);
    expect(result).toMatchObject({ok:false,error:{code:'MODEL_SPENDING_BOUND_EXCEEDED',detail:{requiresReconciliation:true}}});
    if(!result.ok) expect(result.error.detail?.estimatedCostUsd).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it.each([NaN,Infinity,-1])('refuses malformed dollar limits (%s) without transport',async maxCostUsd=>{
  const gateway=setup('google'), fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(response('google'));
  expect(await gateway.generateStructured(ctx,{...request,budget:{...request.budget,maxCostUsd}})).toMatchObject({ok:false,error:{code:'MODEL_BUDGET_INVALID'}});
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([{maxOutputTokens:0},{maxOutputTokens:1.5},{maxOutputTokens:Infinity},
  {budget:{...request.budget,maxAttempts:Infinity}},{budget:{...request.budget,maxLatencyMs:0}}])('refuses unbounded request controls',async changes=>{
  const gateway=setup('google'), fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(response('google'));
  expect(await gateway.generateStructured(ctx,{...request,...changes})).toMatchObject({ok:false,error:{code:'MODEL_BUDGET_INVALID'}});
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not dispatch using an expired pricing policy',async()=>{
  const gateway=setup('google');vi.setSystemTime(new Date('2026-11-22T00:00:00Z'));
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(response('google'));
  expect(await gateway.generateStructured({...ctx,deadline:'2027-01-01T00:00:00Z'},request)).toMatchObject({ok:false,error:{code:'MODEL_BUDGET_UNQUOTABLE'}});
  expect(fetcher).not.toHaveBeenCalled();
});
it('quotes the full non-Latin input and refuses oversized inputs without dispatch',async()=>{
  const gateway=setup('google'),fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(response('google'));
  expect(await gateway.generateStructured(ctx,{...request,inputs:[{kind:'text',text:'ڕێکخستن'.repeat(200000)}]})).toMatchObject({ok:false,error:{code:'MODEL_BUDGET_UNQUOTABLE'}});
  expect(fetcher).not.toHaveBeenCalled();
});
it('counts Google thoughts even when the provider omits the separate thought count',()=>{
  expect(gatewayUsage('google',model.google,{promptTokenCount:100,candidatesTokenCount:20,totalTokenCount:320}))
    .toEqual({inputTokens:100,outputTokens:220,estimatedCostUsd:.0009});
  expect(gatewayUsage('google',model.google,{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:10,totalTokenCount:320})).toBeNull();
});
it.each([{}, {promptTokenCount:100,candidatesTokenCount:20},
  {promptTokenCount:100,candidatesTokenCount:20,totalTokenCount:110},
  {promptTokenCount:-1,candidatesTokenCount:20,totalTokenCount:120},
  {promptTokenCount:100,candidatesTokenCount:'20',totalTokenCount:120}])('rejects incomplete/invalid Google usage',usage=>{
  expect(gatewayUsage('google',model.google,usage)).toBeNull();
});
it('accounts for Anthropic cache work and rejects nonnumeric usage',()=>{
  const usage={input_tokens:100,output_tokens:20,cache_creation_input_tokens:40,cache_read_input_tokens:50};
  expect(gatewayUsage('anthropic',model.anthropic,usage)).toEqual({inputTokens:190,outputTokens:20,estimatedCostUsd:.00066});
  expect(gatewayUsage('anthropic',model.anthropic,{...usage,output_tokens:Infinity})).toBeNull();
  expect(gatewayUsage('anthropic',model.anthropic,{...usage,cache_creation_input_tokens:null})).toBeNull();
});
it('shares one time allowance across explicitly rejected provider attempts',async()=>{
  const gateway=setup('google'), timeout=vi.spyOn(AbortSignal,'timeout');
  let n=0;
  vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{
    if (++n === 1) { vi.setSystemTime(new Date('2026-09-27T12:00:03Z')); return new Response('',{status:429}); }
    return response('anthropic');
  });
  expect(await gateway.generateStructured(ctx,request)).toMatchObject({ok:true,value:{attempts:2}});
  expect(timeout.mock.calls.map(c=>c[0])).toEqual([5000,2000]);
});
it('does not dispatch a second provider after the shared deadline expires',async()=>{
  const gateway=setup('google');
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{
    vi.setSystemTime(new Date('2026-09-27T12:00:06Z'));return new Response('',{status:429});
  });
  expect(await gateway.generateStructured(ctx,request)).toMatchObject({ok:false,error:{code:'MODEL_DEADLINE_EXCEEDED',detail:{requiresReconciliation:false}}});
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('freezes the original allowance while waiting for a rejected provider',async()=>{
  const gateway=setup('google');
  const mutable={...request,maxOutputTokens:100,budget:{...request.budget,maxCostUsd:.002}};
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{
    mutable.budget.maxCostUsd=10;mutable.maxOutputTokens=9999;
    return new Response('',{status:429});
  });
  expect(await gateway.generateStructured(ctx,mutable)).toMatchObject({ok:false,error:{code:'MODEL_BUDGET_EXHAUSTED',detail:{spending:{outputTokens:100}}}});
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('includes structured JSON facts in the priced provider input',async()=>{
  const gateway=setup('google'),fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(response('google'));
  expect(await gateway.generateStructured(ctx,{...request,inputs:[{kind:'json',json:{protected:'EXACT OFFICE FACT'}}]})).toMatchObject({ok:true});
  const payload=JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(payload.contents[0].parts[0].text).toContain('EXACT OFFICE FACT');
});
it('does not accept an unpriced model merely because its name shares a prefix',async()=>{
  const gateway=setup('openai'),fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({
    model:'gpt-4o-unpriced',choices:[{message:{content:'{}'}}],usage:{prompt_tokens:1,completion_tokens:1},
  }),{status:200}));
  expect(await gateway.generateStructured(ctx,request)).toMatchObject({ok:false,error:{code:'MODEL_MISMATCH',detail:{requiresReconciliation:true}}});
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('covers extreme image aspect ratios with the documented maximum tile fit',()=>{
  const png=Buffer.alloc(24);png.writeUInt32BE(0x89504e47);png.writeUInt32BE(0x0d0a1a0a,4);png.write('IHDR',12);
  png.writeUInt32BE(10000,16);png.writeUInt32BE(10,20);
  const body=JSON.stringify({model:'gpt-4o',service_tier:'default',max_completion_tokens:2048,response_format:{type:'json_object'},
    messages:[{role:'user',content:[{type:'image_url',image_url:{url:`data:image/png;base64,${png.toString('base64')}`}}]}]});
  expect(quoteGatewayRequest('openai','gpt-4o',body,Date.parse('2026-09-27')).inputTokens).toBeGreaterThanOrEqual(85 + 170 * 16);
});
it('prices exact models and context tiers, rejecting unreviewed paid options',()=>{
  const body=(text:string, extra:Record<string,unknown>={})=>JSON.stringify({model:'gpt-5.6-sol',messages:[{role:'user',content:text}],max_completion_tokens:1000,
    service_tier:'default',response_format:{type:'json_object'},...extra});
  const now=Date.parse('2026-09-27T00:00:00Z');
  const short=quoteGatewayRequest('openai','gpt-5.6-sol',body('short'),now);
  const long=quoteGatewayRequest('openai','gpt-5.6-sol',body('x'.repeat(140000)),now);
  expect(long.usd).toBeGreaterThan(long.inputTokens * 18 / 1_000_000);
  expect(short.usd).toBeLessThan(.04);
  expect(()=>quoteGatewayRequest('openai','gpt-5.6-sol',body('short',{tools:[{}]}),now)).toThrow('Unqualified');
  expect(()=>quoteGatewayRequest('openai','gpt-5.6-sol-cheap',body('short'),now)).toThrow('exact provider/model');
});
