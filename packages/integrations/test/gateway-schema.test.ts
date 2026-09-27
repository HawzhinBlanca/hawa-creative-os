import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ResilientModelGateway, validateJsonSchema } from '../src/model-gateway.js';
import type { RequestContext, StructuredModelRequest } from '@hawa/contracts';
import { compileGatewaySchema } from '../src/gateway-schema.js';

const ctx: RequestContext = { tenantId:'schema-test',actor:{type:'workflow',id:'test'},correlationId:'schema-test',
  deadline:'2026-11-01T00:00:00Z',idempotencyKey:'schema-test' };
const schema = {type:'object',required:['count'],properties:{count:{type:'integer',minimum:0}},additionalProperties:false};
const request: StructuredModelRequest = {role:'intake_router',inputs:[{kind:'text',text:'Count the supplied items'}],
  systemPromptVersion:'test',responseSchema:schema,maxOutputTokens:2048,
  budget:{maxAttempts:4,maxCostUsd:1,maxLatencyMs:5000},egressPolicy:{mode:'approved_providers',allowedProviders:['google','anthropic','openai','local']},cachePolicy:'disabled'};
const models = {google:'gemini-3.8-flash',anthropic:'claude-sonnet-5',openai:'gpt-4o'};
type Provider = keyof typeof models;
function setup(provider: Provider) {
  vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
  for (const key of ['GEMINI_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY']) vi.stubEnv(key,'synthetic-gateway-key');
  const gateway=new ResilientModelGateway();
  if(provider!=='google')gateway.setDeploymentAdmission(models.google,'blocked');
  if(provider==='openai')gateway.setDeploymentAdmission(models.anthropic,'blocked');
  return gateway;
}
function response(provider:Provider,text:string) {
  return new Response(JSON.stringify(provider==='google'
    ? {modelVersion:models.google,candidates:[{content:{parts:[{text}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,totalTokenCount:120}}
    : provider==='anthropic' ? {model:models.anthropic,content:[{type:'text',text}],usage:{input_tokens:100,output_tokens:20}}
      : {model:models.openai,choices:[{message:{content:text}}],usage:{prompt_tokens:100,completion_tokens:20}}),
  {status:200,headers:{'x-request-id':'schema-test-receipt'}});
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();});

it.each([
  [1.5,{type:'integer'}], [Infinity,{type:'number'}], [NaN,{}],
  [{extra:true},{type:'object',additionalProperties:false}],
  ['too long',{type:'string',maxLength:3}], ['bad',{type:'string',pattern:'^[A-Z]+$'}],
  [[1,1],{type:'array',uniqueItems:true}], [[1,2,3],{type:'array',maxItems:2}],
  [2,{enum:[1,3]}], [false,{const:true}], [true,false],
  [{x:'wrong'},{$defs:{n:{type:'number'}},type:'object',properties:{x:{$ref:'#/$defs/n'}}}],
  ['bad',{anyOf:[{type:'number'},{type:'null'}]}],
  [2,{oneOf:[{type:'number'},{type:'integer'}]}],
  [{x:true},{type:'object',if:{required:['x']},then:{required:['y']}}],
  ['invalid',{type:'string',format:'uuid'}],
])('rejects invalid JSON/schema data %#',(value,testSchema)=>{
  expect(validateJsonSchema(value,testSchema).valid).toBe(false);
});

it.each([
  [null,{type:['string','null']}], [false,{const:false}], [0,true],
  [{x:3},{$defs:{n:{type:'integer'}},type:'object',properties:{x:{$ref:'#/$defs/n'}}}],
  [{x:3},{$schema:'https://json-schema.org/draft/2019-09/schema',type:'object',properties:{x:{type:'integer'}},unevaluatedProperties:false}],
  [[3,'a'],{$schema:'https://json-schema.org/draft/2020-12/schema',type:'array',prefixItems:[{type:'integer'},{type:'string'}],items:false}],
  ['00000000-0000-4000-8000-000000000001',{type:'string',format:'uuid'}],
])('accepts valid values with the declared schema dialect %#',(value,testSchema)=>{
  expect(validateJsonSchema(value,testSchema)).toEqual({valid:true});
});

it('keeps compiled schemas isolated, immutable, and bounded across repeated calls',()=>{
  const firstSchema={$id:'https://office.invalid/schema',type:'integer'};
  const first=compileGatewaySchema(firstSchema);
  firstSchema.type='string';
  const second=compileGatewaySchema(firstSchema);
  expect(first.valid && first.validate(1).valid).toBe(true);
  expect(second.valid && second.validate(1).valid).toBe(false);
  expect(second.valid && second.validate('copy').valid).toBe(true);
  for(let n=0;n<140;n++)expect(validateJsonSchema(n,{const:n})).toEqual({valid:true});
  expect(first.valid && first.validate(1).valid).toBe(true);
});

it('never coerces, removes additional fields, fills defaults, or executes getters',()=>{
  const value={count:'2',extra:true};
  expect(validateJsonSchema(value,{...schema,properties:{count:{type:'integer'},added:{default:true}}}).valid).toBe(false);
  expect(value).toEqual({count:'2',extra:true});
  const getter=vi.fn(()=>2), accessor=Object.defineProperty({},'count',{get:getter,enumerable:true});
  expect(validateJsonSchema(accessor,schema).valid).toBe(false);expect(getter).not.toHaveBeenCalled();
  expect(validateJsonSchema(Object.create({count:2}),schema).valid).toBe(false);
  expect(validateJsonSchema({count:undefined},{}).valid).toBe(false);
  expect(validateJsonSchema(Object.assign(new Array(1),{extra:1}),{}).valid).toBe(false);
});

it('refuses circular, excessively deep and oversized schemas without throwing',()=>{
  const circular:Record<string,unknown>={type:'object'};circular.properties=circular;
  let deep:unknown={type:'string'};for(let n=0;n<70;n++)deep={properties:{next:deep}};
  for(const invalid of [circular,deep,{description:'x'.repeat(128*1024)},undefined,[],{$schema:'https://unknown.invalid/draft'},
    {type:'string',format:'unreviewed'},{$async:true,type:'object'}]){
    expect(compileGatewaySchema(invalid).valid).toBe(false);
  }
});

it('validates local execution and records its provenance outside the answer',async()=>{
  const gateway=setup('google');
  const local={...request,role:'feedback_classifier' as const,responseSchema:{type:'object',properties:{status:{const:'success'}},required:['status'],additionalProperties:false},
    egressPolicy:{mode:'local_only' as const,allowedProviders:['local']}};
  const fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No transport'));
  expect(await gateway.generateStructured(ctx,local)).toMatchObject({ok:true,value:{value:{status:'success'},provenance:'deterministic_fallback'}});
  expect(await gateway.generateStructured(ctx,{...local,responseSchema:schema})).toMatchObject({ok:false,error:{code:'SCHEMA_VALIDATION_FAILED'}});
  expect(fetcher).not.toHaveBeenCalled();
});

describe.each(['google','anthropic','openai'] as const)('%s schema boundary',provider=>{
  it.each(['{"count":1.5}','{"count":1,"extra":"PRIVATE_OUTPUT"}','{"count":1e400}'])('holds invalid paid output %s',async text=>{
    const gateway=setup(provider),fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(provider,text));
    const result=await gateway.generateStructured(ctx,request);
    expect(result).toMatchObject({ok:false,error:{code:'SCHEMA_VALIDATION_FAILED',retryable:false,
      detail:{requiresReconciliation:true,acceptance:'response_received',providerRequestId:'schema-test-receipt',costBasis:'usage'}}});
    if(!result.ok)expect(result.error.detail?.estimatedCostUsd).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_OUTPUT');
  });
  it.each([{type:'unknown'},{type:'object',additionalPropertiez:false},{$ref:'https://untrusted.invalid/schema'},{$async:true,type:'object'}])('refuses invalid/unsupported schema before any transport %#',async responseSchema=>{
    const gateway=setup(provider),fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(provider,'{"count":1}'));
    const result=await gateway.generateStructured(ctx,{...request,responseSchema});
    expect(result).toMatchObject({ok:false,error:{code:'MODEL_SCHEMA_INVALID',retryable:false,
      detail:{acceptance:'not_dispatched',requiresReconciliation:false,estimatedCostUsd:0}}});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns the exact validated answer, with a matching hash and envelope provenance',async()=>{
    const gateway=setup(provider);vi.spyOn(globalThis,'fetch').mockResolvedValue(response(provider,'{"count":2}'));
    const result=await gateway.generateStructured(ctx,request);
    expect(result).toMatchObject({ok:true,value:{provenance:'live_provider'}});
    if(result.ok){
      expect(result.value.value).toEqual({count:2});
      expect(validateJsonSchema(result.value.value,schema).valid).toBe(true);
      expect(result.value.responseHash).toBe(`sha256_${createHash('sha256').update('{"count":2}').digest('hex')}`);
      expect(result.value.responseSchemaSha256).toBe(createHash('sha256').update(JSON.stringify(schema)).digest('hex'));
    }
  });
});
