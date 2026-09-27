import { createHash } from 'node:crypto';
import { studioUsdMicros, type StudioCallReservation } from '@hawa/domain';
import { dataUriPixelSize } from './photo-crop.js';

/** Versioned conservative policy, researched 2026-09-27; see ADR-091 for assumptions. */
const POLICY = 'studio-2026-09-27-v2';
export class StudioReservationError extends Error {
  readonly code = 'STUDIO_BUDGET_UNQUOTABLE';
  constructor(message: string) { super(message); this.name = 'StudioReservationError'; }
}
const refuse = (message: string): never => { throw new StudioReservationError(message); };
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : refuse('Invalid provider payload.');
const str = (v: unknown): string => typeof v === 'string' ? v : refuse('Invalid provider text input.');
const positiveInt = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
  ? v : refuse('A positive integer output limit is required.');
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const onlyKeys = (p: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(p).some(k => !keys.includes(k))) refuse('Unqualified provider request option.');
};

function quote(body: string, inputTokens: number, outputTokens: number, inputRate: number, outputRate: number): StudioCallReservation {
  const usd = studioUsdMicros((inputTokens * inputRate + outputTokens * outputRate) / 1_000_000) / 1_000_000;
  return { version: 1, policy: POLICY, requestSha256: createHash('sha256').update(body).digest('hex'),
    usd, inputTokens, outputTokens };
}

// Worst standard-tier input (including cache writing) and output rates.
// The conservative input bound chooses the context tier; cache discounts never enlarge admission.
const TEXT_RATES: Record<string, [number, number]> = {
  'gpt-6-astra': [45, 75], 'gpt-4.1-mini': [0.4, 1.6], 'gpt-4o-mini': [0.15, 0.6], 'o4-mini': [1.1, 4.4],
};
function family(model: string): string {
  return Object.keys(TEXT_RATES).find(m => model === m ||
    (model.startsWith(m + '-') && /^\d{4}-\d{2}-\d{2}$/.test(model.slice(m.length + 1))))
    ?? refuse('No reservation policy exists for the requested model.');
}

/** Complete native usage priced at the same conservative rates as admission, never an invoice. */
export function studioTextUsage(requested: string, served: string | null, raw: unknown): {
  inputTokens: number; outputTokens: number; estimatedCostUsd: number; modelMatches: boolean;
} | null {
  if (!served || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const input = usage.prompt_tokens, output = usage.completion_tokens;
  if (!count(input) || !count(output) || !count(usage.total_tokens) || usage.total_tokens !== input + output) return null;
  try {
    const model = family(served);
    const [inputRate, outputRate] = model === 'gpt-6-astra' && input <= 272000 ? [22.5, 50] : TEXT_RATES[model]!;
    return { inputTokens: input, outputTokens: output,
      estimatedCostUsd: studioUsdMicros((input * inputRate + output * outputRate) / 1_000_000) / 1_000_000,
      modelMatches: requested === served || requested === model };
  } catch { return null; }
}

function visionTokens(model: string, image: Record<string, unknown>): number {
  const detail = image.detail ?? 'auto';
  if (!['auto', 'low', 'high', 'original'].includes(String(detail))) refuse('Unpriced image detail.');
  const dims = dataUriPixelSize(str(image.url));
  const patches = dims && dims.width > 0 && dims.height > 0
    ? Math.ceil(dims.width / 32) * Math.ceil(dims.height / 32) : Infinity;
  if (model === 'gpt-6-astra') {
    const cap = detail === 'low' ? 256 : detail === 'high' ? 2500 : 30000;
    return Math.ceil(Math.min(patches, cap) * 1.2) + 2;
  }
  if (model === 'gpt-4.1-mini') return Math.ceil(Math.min(patches, 6144) * 1.62) + 2;
  if (model === 'o4-mini') return Math.ceil(Math.min(patches, 30000) * 1.72) + 2;
  // Tile models: the documented high-detail fit never exceeds sixteen 512px tiles.
  return detail === 'low' ? 2833 : 2833 + 5667 * 16;
}

/** The serialized body is both quoted here and sent unchanged after database admission. */
export function reserveStudioText(body: string): StudioCallReservation {
  const p = record(JSON.parse(body)), model = family(str(p.model));
  onlyKeys(p, ['model', 'messages', 'response_format', 'max_completion_tokens', 'service_tier', 'reasoning_effort', 'temperature']);
  if (p.service_tier !== 'default' || p.tools || p.n || p.stream) refuse('Unsupported paid request options.');
  const messages = p.messages;
  if (!Array.isArray(messages) || messages.length > 200) return refuse('Invalid message count.');
  const outputTokens = positiveInt(p.max_completion_tokens);
  if (outputTokens > 131072) refuse('Output limit exceeds the qualified reservation range.');
  let inputTokens = 1024 + 128 * messages.length + 2 * bytes(JSON.stringify(p.response_format));
  for (const value of messages) {
    const message = record(value);
    onlyKeys(message, ['role', 'content']);
    if (!['system', 'user', 'assistant'].includes(String(message.role))) refuse('Unqualified message role.');
    if (typeof message.content === 'string') inputTokens += 2 * bytes(message.content);
    else if (Array.isArray(message.content)) for (const raw of message.content) {
      const part = record(raw);
      if (part.type === 'text') inputTokens += 2 * bytes(str(part.text)) + 32;
      else if (part.type === 'image_url') inputTokens += visionTokens(model, record(part.image_url)) + 32;
      else refuse('This media input needs a bounded reservation policy before paid dispatch.');
    }
    else refuse('Invalid message content.');
  }
  const [inputRate, outputRate] = model === 'gpt-6-astra' && inputTokens <= 272000
    ? [22.5, 50] : TEXT_RATES[model]!;
  return quote(body, inputTokens, outputTokens, inputRate, outputRate);
}

export function reserveStudioImage(provider: string, body: string): StudioCallReservation {
  const p = record(JSON.parse(body));
  if (provider === 'google') {
    onlyKeys(p, ['model', 'input', 'response_format']);
    const rates: Record<string, [number, number, number]> = {
      'gemini-3.1-flash-lite-image': [0.25, 30, 4096],
      'gemini-3.1-flash-image': [0.5, 60, 32768],
      'gemini-3-pro-image': [2, 120, 32768],
    };
    const r = rates[str(p.model)];
    if (!r || p.tools || p.previous_interaction_id) refuse('Unpriced image request.');
    if (!Array.isArray(p.input) || !p.input.every(v => record(v).type === 'text')) refuse('Unbounded image input.');
    // No grounding/tools/continuation. Reserve the whole model output at its highest modality rate.
    return quote(body, 1024 + 2 * bytes(JSON.stringify(p.input)), r[2], r[0], r[1]);
  }
  if (provider !== 'openai' || p.model !== 'gpt-image-2.5-sunburst' || p.n !== 1) refuse('Unpriced image request.');
  onlyKeys(p, ['model', 'prompt', 'n', 'size', 'quality']);
  const grid = ({ auto: 96, low: 16, medium: 24, high: 48, xhigh: 64, max: 96 } as Record<string, number>)[str(p.quality)];
  if (!grid) refuse('Unpriced image quality.');
  let pixels = 8294400;
  if (p.size !== 'auto') {
    if (!/^\d{3,4}x\d{3,4}$/.test(str(p.size))) refuse('Invalid image dimensions.');
    const [w, h] = str(p.size).split('x').map(Number) as [number, number];
    pixels = w * h;
    if (w % 16 || h % 16 || Math.max(w, h) > 3840 || Math.max(w / h, h / w) > 3 ||
        pixels < 655360 || pixels > 8294400) refuse('Image dimensions exceed provider bounds.');
  }
  // Square grid overbounds the calculator's aspect-ratio reduction; 2x adds policy headroom.
  const outputTokens = 2 * Math.ceil(grid * grid * (2_000_000 + pixels) / 4_000_000);
  return quote(body, 1024 + 2 * bytes(str(p.prompt)), outputTokens, 5, 30);
}
