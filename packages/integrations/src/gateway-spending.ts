import { createHash } from 'node:crypto';
import { studioUsdMicros } from '@hawa/domain';
import type { GatewaySpendingReservation } from '@hawa/contracts';

/** Provider-native bounds and published standard rates; rationale and sources: ADR-093. */
export const GATEWAY_SPENDING_POLICY = 'gateway-2026-09-27-v1';
export const GATEWAY_DEFAULT_OUTPUT_TOKENS = 2048;
const EXPIRES_AT = Date.parse('2026-11-22T00:00:00Z');
type ModelRate = { input: number; output: number; imageTokens: number; context: number; maxOutput: number };
const RATES: Record<string, Record<string, ModelRate>> = {
  google: { 'gemini-3.8-flash': { input: .75, output: 3.75, imageTokens: 2240, context: 1_000_000, maxOutput: 65536 } },
  anthropic: {
    'claude-sonnet-5': { input: 2, output: 10, imageTokens: 4784, context: 1_000_000, maxOutput: 128000 },
    'claude-opus-5': { input: 5, output: 25, imageTokens: 4784, context: 1_000_000, maxOutput: 128000 },
  },
  openai: {
    // Base input plus a full cache write: discounts never expand admission.
    'gpt-5.6-sol': { input: 9, output: 20, imageTokens: 36002, context: 1_000_000, maxOutput: 128000 },
    'gpt-4.1': { input: 2, output: 8, imageTokens: 2805, context: 1_047_576, maxOutput: 32768 },
    'gpt-4o': { input: 2.5, output: 10, imageTokens: 2805, context: 128000, maxOutput: 16384 },
  },
};
const SNAPSHOTS: Record<string, string> = {
  'gpt-4.1-2025-04-14': 'gpt-4.1', 'gpt-4o-2024-08-06': 'gpt-4o', 'gpt-4o-2024-11-20': 'gpt-4o',
};
export class GatewaySpendingError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'GatewaySpendingError'; }
}
function refuse(message: string): never { throw new GatewaySpendingError('MODEL_BUDGET_UNQUOTABLE', message); }
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v)
  ? v as Record<string, unknown> : refuse('Invalid provider payload.');
const text = (v: unknown): string => typeof v === 'string' ? v : refuse('Unbounded provider text.');
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const keys = (v: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(v).some(k => !allowed.includes(k))) refuse('Unqualified provider request option.');
};
const list = (v: unknown): unknown[] => Array.isArray(v) && v.length <= 200 ? v : refuse('Invalid provider part count.');
const bytes = (v: unknown) => 2 * Buffer.byteLength(text(v), 'utf8');
function rate(provider: string, model: string): ModelRate {
  return RATES[provider]?.[SNAPSHOTS[model] ?? model] ?? refuse('No spending policy for this exact provider/model.');
}
export function gatewayServedModelMatches(provider: string, requested: string, served: string): boolean {
  return Boolean(RATES[provider]?.[SNAPSHOTS[served] ?? served]) &&
    (requested === served || (!SNAPSHOTS[requested] && SNAPSHOTS[served] === requested));
}
function price(provider: string, model: string, input: number, output: number): number {
  const r = rate(provider, model);
  const long = model === 'gpt-5.6-sol' && input > 272000;
  return studioUsdMicros((input * r.input * (long ? 2 : 1) + output * r.output * (long ? 1.5 : 1)) / 1_000_000) / 1_000_000;
}

export function quoteGatewayRequest(provider: string, model: string, body: string, now = Date.now()): GatewaySpendingReservation {
  if (!Number.isFinite(now) || now >= EXPIRES_AT) refuse('The gateway price policy requires review before further paid requests.');
  const p = object(JSON.parse(body)), r = rate(provider, model);
  let input = 1024, output: unknown;
  const image = (mime: unknown, data: unknown) => {
    if (!['image/png','image/jpeg','image/webp','image/gif'].includes(String(mime)) || !text(data)) refuse('Unpriced media input.');
    // Tile models fit within 2048px on both axes and never enlarge small dimensions.
    input += r.imageTokens + 128;
  };
  if (provider === 'google') {
    keys(p, ['contents','generationConfig','serviceTier']);
    if (p.serviceTier !== 'standard') refuse('Only standard Google requests have a spending policy.');
    const config = object(p.generationConfig);
    keys(config, ['responseMimeType','maxOutputTokens','candidateCount','temperature']);
    if (config.candidateCount !== 1 || config.responseMimeType !== 'application/json') refuse('Unqualified generation settings.');
    output = config.maxOutputTokens;
    for (const raw of list(p.contents)) {
      const content = object(raw); keys(content, ['role','parts']); input += 128;
      if (content.role !== 'user') refuse('Unqualified message role.');
      for (const rawPart of list(content.parts)) {
        const part = object(rawPart); keys(part, ['text','inline_data']);
        if ('text' in part && !('inline_data' in part)) input += bytes(part.text) + 32;
        else if ('inline_data' in part && !('text' in part)) {
          const data = object(part.inline_data); keys(data, ['mime_type','data']); image(data.mime_type,data.data);
        } else refuse('Unpriced provider content.');
      }
    }
  } else {
    keys(p, provider === 'anthropic' ? ['model','max_tokens','messages','service_tier','temperature']
      : ['model','messages','response_format','max_completion_tokens','service_tier','temperature']);
    if (p.model !== model) refuse('Provider body does not match the priced model.');
    if (p.service_tier !== (provider === 'anthropic' ? 'standard_only' : 'default')) refuse('Unpriced service tier.');
    output = provider === 'anthropic' ? p.max_tokens : p.max_completion_tokens;
    if (provider === 'openai') {
      const format = object(p.response_format); keys(format,['type']);
      if (format.type !== 'json_object') refuse('Unqualified response format.');
      input += bytes(JSON.stringify(format));
    }
    for (const raw of list(p.messages)) {
      const message = object(raw); keys(message,['role','content']); input += 128;
      if (message.role !== 'user') refuse('Unqualified message role.');
      if (typeof message.content === 'string') input += bytes(message.content);
      else for (const rawPart of list(message.content)) {
        const part = object(rawPart);
        if (part.type === 'text') { keys(part,['type','text']); input += bytes(part.text) + 32; }
        else if (part.type === 'image' && provider === 'anthropic') {
          keys(part,['type','source']); const source = object(part.source); keys(source,['type','media_type','data']);
          if (source.type !== 'base64') refuse('Unqualified image source.');
          image(source.media_type,source.data);
        } else if (part.type === 'image_url' && provider === 'openai') {
          keys(part,['type','image_url']); const source = object(part.image_url); keys(source,['url']);
          const uri = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(text(source.url));
          if (!uri) refuse('Unqualified image source.');
          image(uri[1],uri[2]);
        } else refuse('Unpriced provider content.');
      }
    }
  }
  if (!count(output) || output === 0 || output > r.maxOutput) refuse('Output cap exceeds this model policy.');
  if (!count(input) || input + output > r.context) refuse('Conservative token bounds exceed the model context.');
  return { policy:GATEWAY_SPENDING_POLICY,requestSha256:createHash('sha256').update(body).digest('hex'),
    usd:price(provider,model,input,output),inputTokens:input,outputTokens:output };
}

/** Only complete, finite native usage can reduce an outstanding reservation. */
export function gatewayUsage(provider: string, model: string, raw: unknown): {inputTokens:number;outputTokens:number;estimatedCostUsd:number} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const u = raw as Record<string,unknown>;
  let input: unknown, output: unknown, weightedInput: number | undefined;
  if (provider === 'google') {
    input = u.promptTokenCount;
    if (!count(input) || !count(u.candidatesTokenCount) || !count(u.totalTokenCount) ||
      u.totalTokenCount < input + u.candidatesTokenCount ||
      (u.thoughtsTokenCount !== undefined && (!count(u.thoughtsTokenCount) || input + u.candidatesTokenCount + u.thoughtsTokenCount !== u.totalTokenCount)) ||
      (u.toolUsePromptTokenCount !== undefined && u.toolUsePromptTokenCount !== 0)) return null;
    output = u.totalTokenCount - input;
  } else if (provider === 'anthropic') {
    const created = u.cache_creation_input_tokens === undefined ? 0 : u.cache_creation_input_tokens;
    const read = u.cache_read_input_tokens === undefined ? 0 : u.cache_read_input_tokens;
    if (!count(u.input_tokens) || !count(created) || !count(read) || !count(u.output_tokens)) return null;
    // A full one-hour cache write is the most expensive input category (2x base).
    // This request never enables caching; unexpected reported cache work remains conservatively charged.
    input = u.input_tokens + created + read;
    weightedInput = u.input_tokens + 2 * created + read;
    output = u.output_tokens;
  } else if (provider === 'openai') {
    input = u.prompt_tokens; output = u.completion_tokens;
    if (u.total_tokens !== undefined && (!count(input) || !count(output) || u.total_tokens !== input + output)) return null;
  } else return null;
  if (!count(input) || !count(output)) return null;
  return { inputTokens:input,outputTokens:output,estimatedCostUsd:price(provider,model,weightedInput ?? input,output) };
}
