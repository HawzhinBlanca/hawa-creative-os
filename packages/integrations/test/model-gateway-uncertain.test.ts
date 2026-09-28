import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResilientModelGateway } from '../src/model-gateway.js';
import type { RequestContext, StructuredModelRequest } from '@hawa/contracts';
import { createServer } from 'node:http';
import { once } from 'node:events';

const ctx: RequestContext = { tenantId:'gateway-hold-test',actor:{type:'workflow',id:'test'},correlationId:'test',
  deadline:new Date(Date.now()+60_000).toISOString(),idempotencyKey:'test' };
const request: StructuredModelRequest = {role:'intake_router',inputs:[{kind:'text',text:'Private office brief'}],
  systemPromptVersion:'test',responseSchema:{type:'object',required:['decision'],properties:{decision:{type:'string'}}},
  budget:{maxAttempts:4,maxCostUsd:1,maxLatencyMs:5000},egressPolicy:{mode:'approved_providers',allowedProviders:['google','anthropic','openai','local']},cachePolicy:'disabled'};
const privateBody='PRIVATE_PROVIDER_BODY_DO_NOT_EXPOSE';
function setup(provider:string){
  for(const key of ['GEMINI_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY'])vi.stubEnv(key,'synthetic-gateway-key');
  const gateway=new ResilientModelGateway();
  if(provider!=='google')gateway.setDeploymentAdmission('gemini-3.8-flash','blocked');
  if(provider==='openai')gateway.setDeploymentAdmission('claude-sonnet-5','blocked');
  return gateway;
}
const body=(provider:string,text:string)=>provider==='google'?{candidates:[{content:{parts:[{text}]}}]}:
  provider==='anthropic'?{content:[{type:'text',text}]}:{choices:[{message:{content:text}}]};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});

describe.each(['google','anthropic','openai'])('%s shared gateway acceptance boundary',provider=>{
  it.each([null,false,0])('does not call another provider after a valid falsy JSON value (%s)',async value=>{
    const gateway=setup(provider);
    const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(body(provider,JSON.stringify(value))),{status:200}));
    const result=await gateway.generateStructured(ctx,{...request,responseSchema:{}});
    expect(result).toMatchObject({ok:true,value:{deployment:{provider},value,attempts:1}});
    expect(fetcher.mock.calls.filter(([url])=>/googleapis\.com|api\.anthropic\.com|api\.openai\.com/.test(String(url)))).toHaveLength(1);
  });
  it.each(['network','timeout','http_500','http_408','unreadable'])('holds %s after one attempt, preserving unknown spend',async failure=>{
    const gateway=setup(provider);
    const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{
      if(failure==='network')throw new Error(privateBody);
      if(failure==='timeout')throw new DOMException(privateBody,'AbortError');
      if(failure==='unreadable')return new Response(privateBody,{status:200,headers:{'x-request-id':'test-request'}});
      return new Response(privateBody,{status:failure==='http_500'?500:408,headers:{'x-request-id':'test-request'}});
    });
    const result=await gateway.generateStructured(ctx,request);
    expect(result).toMatchObject({ok:false,error:{retryable:false,detail:{provider,attempts:1,estimatedCostUsd:null,requiresReconciliation:true}}});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(privateBody);
  });
  it.each(['invalid_json','wrong_schema','empty','truncated'])('does not pay a fallback after %s successful output',async failure=>{
    const gateway=setup(provider);
    const envelope:any=body(provider,failure==='invalid_json'?privateBody:JSON.stringify(failure==='wrong_schema'?{private:privateBody}:{decision:'route_matched'}));
    if(failure==='empty')Object.assign(envelope,provider==='google'?{candidates:[]}:provider==='anthropic'?{content:[]}:{choices:[]});
    if(failure==='truncated'){
      if(provider==='google')envelope.candidates[0].finishReason='MAX_TOKENS';
      else if(provider==='anthropic')envelope.stop_reason='max_tokens';
      else envelope.choices[0].finish_reason='length';
    }
    const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(envelope),{status:200}));
    const result=await gateway.generateStructured(ctx,request);
    expect(result).toMatchObject({ok:false,error:{retryable:false,detail:{provider,attempts:1,estimatedCostUsd:null,requiresReconciliation:true}}});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(privateBody);
  });
});

it('retains the real request-header identifier for an uncertain server response',async()=>{
  const gateway=setup('google');
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(privateBody,{status:503,headers:{'x-request-id':'provider-request-123'}}));
  expect(await gateway.generateStructured(ctx,request)).toMatchObject({ok:false,error:{code:'MODEL_ACCEPTANCE_UNKNOWN',detail:{httpStatus:503,providerRequestId:'provider-request-123',acceptance:'unknown'}}});
});

it.each(['anthropic','openai'])('holds a reported model mismatch from %s without a fallback',async provider=>{
  const gateway=setup(provider);
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({...body(provider,'{"decision":"route_matched"}'),model:'unrequested-model'}),{status:200}));
  expect(await gateway.generateStructured(ctx,request)).toMatchObject({ok:false,error:{code:'MODEL_MISMATCH',retryable:false,detail:{acceptance:'response_received',requiresReconciliation:true}}});
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('still permits an authorized fallback after an explicit rate rejection',async()=>{
  const gateway=setup('google');
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('',{status:429}))
    .mockResolvedValue(new Response(JSON.stringify(body('anthropic','{"decision":"route_matched"}')),{status:200}));
  const result=await gateway.generateStructured(ctx,request);
  expect(result).toMatchObject({ok:true,value:{deployment:{provider:'anthropic'},attempts:2}});
  expect(fetcher.mock.calls.filter(([url])=>String(url).includes('googleapis.com')||String(url).includes('api.anthropic.com'))).toHaveLength(2);
});

it('a real local HTTP response lost mid-body causes one request and a hold',async()=>{
  const gateway=setup('google');
  let accepted=0;
  const server=createServer((req,res)=>{
    accepted++;
    req.resume();
    req.on('end',()=>{
      res.writeHead(200,{'content-type':'application/json','x-request-id':'local-wire-receipt'});
      res.write('{"candidates":');
      res.flushHeaders();
      setImmediate(()=>res.destroy());
    });
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const address=server.address();
  if(!address||typeof address==='string')throw new Error('Local test listener unavailable');
  const actualFetch=globalThis.fetch;
  vi.spyOn(globalThis,'fetch').mockImplementation((_url,init)=>actualFetch(`http://127.0.0.1:${address.port}/provider`,init));
  try{
    const result=await gateway.generateStructured(ctx,request);
    expect(result).toMatchObject({ok:false,error:{retryable:false,detail:{requiresReconciliation:true,estimatedCostUsd:null}}});
    expect(accepted).toBe(1);
  }finally{
    server.closeAllConnections();
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
