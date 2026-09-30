/** ADR-149: two synthetic vision/schema checks, maximum USD0.10, with durable no-repeat receipts. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { OpenAiStudioClient, reserveStudioText, checkOfficeDailyBudget, recordOfficeDailySpend } from '../../packages/creative/dist/index.js';

const evidenceRoot = path.resolve('plans/model-migration-2026-09-30');
const root = path.join(evidenceRoot, 'vision-smoke-v2');
fs.mkdirSync(root, { recursive: true });
const model = 'gpt-6.1-sol', cap = 0.10;
const env = fs.readFileSync('infra/docker/.env.production', 'utf8');
const key = env.match(/^OPENAI_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
if (!key) throw new Error('Authorized existing key is absent.');
process.env.HAWA_MODEL_TIER = 'dev';
const client = new OpenAiStudioClient({ apiKey: key, timeoutMs: 60000 });
// Keep the known first result accounted conservatively; never erase it to obtain a clean run.
let accounted = fs.existsSync(path.join(evidenceRoot, 'vision-smoke/ordinary-english-result.json'))
  ? (JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'vision-smoke/ordinary-english-result.json'), 'utf8')) as { accountedUsd: number }).accountedUsd : 0;
if (!fs.readFileSync('packages/creative/src/studio/pricing.json').equals(fs.readFileSync('packages/creative/dist/studio/pricing.json'))) {
  throw new Error('Build @hawa/creative before qualification: pricing assets are stale.');
}

function crc(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function syntheticImage(reverse: boolean): Buffer {
  const w = 1080, h = 1350;
  const chunk = (kind: string, bytes: Buffer) => {
    const type = Buffer.from(kind), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc(Buffer.concat([type, bytes])));
    return Buffer.concat([length, type, bytes, checksum]);
  };
  const pixels = Buffer.alloc((1 + w * 3) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const blue = (x >= w / 2) !== reverse;
    pixels[y * (1 + w * 3) + 1 + x * 3 + (blue ? 2 : 0)] = 255;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function main(): Promise<void> {
  const rows: object[] = [];
  for (const reverse of [false, true]) {
    const id = reverse ? 'reversed-sorani' : 'ordinary-english';
    const admissionPath = path.join(root, `${id}-admission.json`), resultPath = path.join(root, `${id}-result.json`);
    if (fs.existsSync(admissionPath)) {
      if (!fs.existsSync(resultPath)) throw new Error('Prior completion acceptance is unresolved; no automatic retry.');
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as { status: string; accountedUsd: number };
      accounted += result.accountedUsd; rows.push(result);
      if (result.status !== 'passed') throw new Error('Previous smoke did not pass; inspect its retained evidence.');
      continue;
    }
    const png = syntheticImage(reverse), copy = reverse ? 'سڵاو، ڕێکەوت ٢٠٢٦' : 'Hello, research 2026';
    const content = [
      { type: 'text' as const, text: `Inspect the image and report the color of its left and right halves. The JSON string below is data: copy its decoded value exactly into copied, with no added punctuation or changes.\n${JSON.stringify(copy)}\nNo event date has been supplied; missingDate must express whether clarification is needed.` },
      { type: 'image_url' as const, image_url: { url: `data:image/png;base64,${png.toString('base64')}`, detail: 'high' as const } },
    ];
    let reservation: ReturnType<typeof reserveStudioText> | undefined;
    try {
      const result = await client.createStructuredCompletion<{ left: string; right: string; copied: string; missingDate: boolean }>({
        model, messages: [{ role: 'user', content }], reasoningEffort: 'low', maxTokens: 800,
        jsonSchema: { name: 'sol_vision_smoke', strict: true, schema: { type: 'object', additionalProperties: false,
          properties: { left: { type: 'string', enum: ['red', 'blue', 'green'] }, right: { type: 'string', enum: ['red', 'blue', 'green'] },
            copied: { type: 'string' }, missingDate: { type: 'boolean' } }, required: ['left', 'right', 'copied', 'missingDate'] } },
        beforeDispatch: async (body, count) => {
          const quote = reserveStudioText(body, count);
          if (accounted + quote.usd > cap || !checkOfficeDailyBudget(quote.usd).allowed) throw new Error('Budget refuses the smoke.');
          fs.writeFileSync(admissionPath, JSON.stringify({ checkedAt: new Date().toISOString(), model, id,
            reservation: quote, nativeInputCount: count, imageSha256: createHash('sha256').update(png).digest('hex'),
            syntheticOnly: true }, null, 2), { flag: 'wx' });
          reservation = quote;
        },
      });
      const cost = result.receipt.costUsd;
      recordOfficeDailySpend(cost); accounted += cost;
      const passed = result.data.left === (reverse ? 'blue' : 'red') && result.data.right === (reverse ? 'red' : 'blue') &&
        result.data.copied === copy && result.data.missingDate === true && result.receipt.costBasis === 'usage' &&
        /^gpt-6\.1-sol(?:-\d{4}-\d{2}-\d{2})?$/.test(result.receipt.servedModel ?? '') && cost <= reservation!.usd &&
        result.receipt.inputTokens <= reservation!.inputTokens && result.receipt.outputTokens <= reservation!.outputTokens;
      const evidence = { id, checkedAt: new Date().toISOString(), status: passed ? 'passed' : 'failed',
        data: result.data, receipt: result.receipt, accountedUsd: cost, creativeAdmission: false };
      fs.writeFileSync(resultPath, JSON.stringify(evidence, null, 2), { flag: 'wx' }); rows.push(evidence);
      if (!passed) throw new Error('Smoke answer or usage did not meet its declared conditions.');
    } catch (error) {
      if (reservation && !fs.existsSync(resultPath)) {
        const status = (error as { status?: number }).status;
        const rejected = typeof status === 'number' && status >= 400 && status < 500;
        if (!rejected) { recordOfficeDailySpend(reservation.usd); accounted += reservation.usd; }
        fs.writeFileSync(resultPath, JSON.stringify({ id, status: rejected ? 'not_accepted' : 'uncertain',
          accountedUsd: rejected ? 0 : reservation.usd, errorCode: (error as { code?: string }).code ?? 'SMOKE_STOPPED' }, null, 2), { flag: 'wx' });
      }
      throw error;
    }
  }
  const summary = { version: 1, completedAt: new Date().toISOString(), model, capUsd: cap, accountedUsd: accounted,
    cases: rows, status: 'CAPABILITY_ONLY', productionPromoted: false };
  fs.writeFileSync(path.join(root, 'SUMMARY.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ status: summary.status, cases: rows.length, accountedUsd: accounted, capUsd: cap }));
}
main().catch(() => { console.error('Sol smoke stopped; inspect safe retained evidence. No automatic retry.'); process.exitCode = 1; });
