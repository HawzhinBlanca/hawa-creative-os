/** ADR-148/149: matched synthetic briefs; qualification only, maximum USD5, durable no-repeat admission. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { OpenAiStudioClient, generateLayoutCandidatesV3, reserveStudioText, checkOfficeDailyBudget,
  recordOfficeDailySpend, evaluateHardQa, evaluateDesignMetrics, renderLayoutV2, admittedFontFaces, prepareGeneratedLayoutV3,
  type CopyBlockSlotInput, type OpenAiStructuredResponse } from '../../packages/creative/dist/index.js';

const root = path.resolve('plans/model-migration-2026-09-30/layout-comparison');
fs.mkdirSync(root, { recursive: true });
const cap = 5;
const key = fs.readFileSync('infra/docker/.env.production', 'utf8').match(/^OPENAI_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
if (!key) throw new Error('Authorized existing key absent.');
if (!fs.readFileSync('packages/creative/src/studio/pricing.json').equals(fs.readFileSync('packages/creative/dist/studio/pricing.json'))) throw new Error('Rebuild pricing assets first.');
process.env.HAWA_MODEL_TIER = 'dev';
process.env.HAWA_LAYOUT_REASONING_EFFORT = 'low';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const palette = ['#0A1628', '#C5A059', '#1E3A5F', '#FDF8F3'];
class SavedCompletion extends Error {
  constructor(readonly response: OpenAiStructuredResponse<unknown>, readonly accountedUsd: number) { super('Retained synthetic completion'); }
}
const briefs: Array<{ id: string; instruction: string; rtl: boolean; blocks: CopyBlockSlotInput[] }> = [
  { id: 'english', rtl: false, instruction: 'A restrained office learning day announcement. Clear hierarchy and generous space. No imagery, invented facts or additional copy.', blocks: [
    { index: 0, role: 'eyebrow', script: 'latin', text: 'OFFICE LEARNING DAY' },
    { index: 1, role: 'title', script: 'latin', text: 'Better ideas, together' },
    { index: 2, role: 'body', script: 'latin', text: 'Share a useful technique with the team.' },
    { index: 3, role: 'footer', script: 'latin', text: '30 September 2026 • 10:00 • Studio room' },
  ] },
  { id: 'sorani', rtl: true, instruction: 'A restrained Sorani office learning announcement. Preserve right-to-left reading, exact supplied copy, hierarchy and generous space. No invented facts or additional copy.', blocks: [
    { index: 0, role: 'eyebrow', script: 'arabic', text: 'ڕۆژی فێربوونی تیم' },
    { index: 1, role: 'title', script: 'arabic', text: 'بیرۆکەی باشتر، پێکەوە' },
    { index: 2, role: 'body', script: 'arabic', text: 'ڕێگایەکی بەسوود لەگەڵ تیمەکە هاوبەش بکە.' },
    { index: 3, role: 'footer', script: 'arabic', text: '٣٠ی ئەیلوولی ٢٠٢٦ • ١٠:٠٠ • هۆڵی ستۆدیۆ' },
  ] },
];

async function main(): Promise<void> {
  let accounted = 0;
  let transportCalls = 0;
  const rows: object[] = [];
  for (const [briefIndex, brief] of briefs.entries()) {
    // Alternate order to avoid always giving one arm the first call. This is still a tiny screen.
    const models = briefIndex === 0 ? ['gpt-6.1-sol', 'gpt-6-astra'] : ['gpt-6-astra', 'gpt-6.1-sol'];
    for (const [armIndex, model] of models.entries()) {
      const id = `${brief.id}-${armIndex + 1}`, dir = path.join(root, id);
      fs.mkdirSync(dir, { recursive: true });
      const admission = path.join(dir, 'admission.json'), responsePath = path.join(dir, 'response.json');
      const client = new OpenAiStudioClient({ apiKey: key, timeoutMs: 240000,
        fetcher: async (url, init) => { transportCalls++; return fetch(url, init); } });
      const original = client.createStructuredCompletion.bind(client);
      client.createStructuredCompletion = async <T>(options: Parameters<OpenAiStudioClient['createStructuredCompletion']>[0]): Promise<OpenAiStructuredResponse<T>> => {
        let quote: ReturnType<typeof reserveStudioText> | undefined;
        try {
          const result = await original<T>({ ...options, beforeDispatch: async (body, count) => {
            const current = reserveStudioText(body, count);
            // Rebuild the exact request before reuse; changed prompts/profiles/schema hold without transport.
            if (fs.existsSync(admission)) {
              if (!fs.existsSync(responsePath)) throw new Error('Unresolved admitted request; automatic retry refused.');
              const prior = JSON.parse(fs.readFileSync(admission, 'utf8')) as { reservation: { requestSha256: string } };
              const saved = JSON.parse(fs.readFileSync(responsePath, 'utf8')) as { status: string; response?: OpenAiStructuredResponse<T>; accountedUsd: number; model: string; briefSha256: string };
              if (prior.reservation.requestSha256 !== current.requestSha256 || saved.status !== 'accepted' || !saved.response ||
                  saved.model !== model || saved.briefSha256 !== sha(JSON.stringify(brief))) throw new Error('Retained response cannot be reused.');
              throw new SavedCompletion(saved.response, saved.accountedUsd);
            }
            quote = current;
            if (accounted + quote.usd > cap || !checkOfficeDailyBudget(quote.usd).allowed) { quote = undefined; throw new Error('Budget refused qualification.'); }
            const payload = JSON.parse(body) as Record<string, unknown>;
            delete payload.model;
            fs.writeFileSync(admission, JSON.stringify({ checkedAt: new Date().toISOString(), model,
              briefSha256: sha(JSON.stringify(brief)), matchedBodySha256: sha(JSON.stringify(payload)),
              reservation: quote, syntheticOnly: true }, null, 2), { flag: 'wx' });
          } });
          const cost = result.receipt.costUsd;
          recordOfficeDailySpend(cost); accounted += cost;
          const accepted = result.receipt.costBasis === 'usage' && result.receipt.servedModel === model &&
            cost <= quote!.usd && result.receipt.inputTokens <= quote!.inputTokens && result.receipt.outputTokens <= quote!.outputTokens;
          fs.writeFileSync(responsePath, JSON.stringify({ status: accepted ? 'accepted' : 'held', model,
            briefSha256: sha(JSON.stringify(brief)), accountedUsd: cost, response: result }, null, 2), { flag: 'wx' });
          if (!accepted) throw new Error('Usage or identity outside qualified bounds.');
          return result;
        } catch (error) {
          if (error instanceof SavedCompletion) { accounted += error.accountedUsd; return error.response as OpenAiStructuredResponse<T>; }
          if (quote && fs.existsSync(admission) && !fs.existsSync(responsePath)) {
            const status = (error as { status?: number }).status;
            const knownRejection = typeof status === 'number' && status >= 400 && status < 500;
            const held = knownRejection ? 0 : quote.usd;
            if (held) recordOfficeDailySpend(held);
            accounted += held;
            fs.writeFileSync(responsePath, JSON.stringify({ status: knownRejection ? 'not_accepted' : 'uncertain', model,
              briefSha256: sha(JSON.stringify(brief)), accountedUsd: held }, null, 2), { flag: 'wx' });
          }
          throw error;
        }
      };
      const generated = await generateLayoutCandidatesV3({ client, model, brief: brief.instruction, copyBlocks: brief.blocks,
        palette, canvasWidth: 1080, canvasHeight: 1350, isRtl: brief.rtl, logoAspect: 1,
        clientProfile: 'Synthetic office learning studio; restrained typography, navy and cream with gold rules.', exemplars: [] });
      const copyText = Object.fromEntries(brief.blocks.map(block => [block.index, block.text]));
      const candidates = generated.layouts.map((rawLayout, index) => {
        const layout = prepareGeneratedLayoutV3(rawLayout, { text: copyText,
          scripts: Object.fromEntries(brief.blocks.map(block => [block.index, block.script])) },
        { width: 1080, height: 1350, logoAspect: 1, palette, allowArt: false });
        const hardQa = evaluateHardQa(layout, { width: 1080, height: 1350, copyText,
          copyScripts: brief.blocks.map(block => block.script), latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic',
          admittedDisplayFonts: { latin: admittedFontFaces({ script: 'latin', role: 'display' }).map(face => face.name),
            arabic: admittedFontFaces({ script: 'arabic', role: 'display' }).map(face => face.name) }, palette, logoAspect: 1 });
        const checked = hardQa.layout;
        fs.writeFileSync(path.join(dir, `candidate-${index + 1}.json`), JSON.stringify(checked, null, 2));
        const logo = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><circle cx="64" cy="64" r="55" fill="#C5A059"/><path d="M40 84V44h20v40zm28 0V44h20v40z" fill="#0A1628"/></svg>';
        const rendered = renderLayoutV2(checked, { copyText, logoDataUri: `data:image/svg+xml;base64,${Buffer.from(logo).toString('base64')}` });
        fs.writeFileSync(path.join(dir, `candidate-${index + 1}.png`), rendered.png);
        return { index: index + 1, hardQaPassed: hardQa.passed, defectCodes: hardQa.defectCodes,
          messages: hardQa.messages, metrics: evaluateDesignMetrics(checked), preview: `${id}/candidate-${index + 1}.png` };
      });
      fs.writeFileSync(path.join(dir, 'QA.json'), JSON.stringify(candidates, null, 2));
      rows.push({ id, brief: brief.id, model, costUsd: generated.costUsd, latencyMs: generated.latencyMs,
        inputTokens: generated.inputTokens, outputTokens: generated.outputTokens, degeneracy: generated.degeneracyCheck, candidates });
      console.log(JSON.stringify({ id, model, costUsd: generated.costUsd, latencyMs: generated.latencyMs,
        candidates: candidates.length, hardQaPassed: candidates.filter(candidate => candidate.hardQaPassed).length }));
    }
  }
  const evidence = { completedAt: new Date().toISOString(), status: 'SCREEN_ONLY', capUsd: cap, accountedUsd: accounted,
    syntheticOnly: true, matchedPrompts: true, productionPromoted: false, humanReviewed: false, rows };
  fs.writeFileSync(path.join(root, 'COMPARISON.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: 'SCREEN_ONLY', transportCalls, accountedUsd: accounted }));
}
main().catch(() => { console.error('Comparison stopped; retain admission and inspect evidence before retry.'); process.exitCode = 1; });
