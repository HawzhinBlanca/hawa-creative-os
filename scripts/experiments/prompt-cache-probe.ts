/**
 * Does prompt caching engage for this project's key, and is it reported back?
 *
 * Every stage of a design run re-sends the same standing block — the house preamble and the
 * client's reference pack — in front of its own instruction. If the provider caches that prefix it
 * bills the repeats at a tenth of the input rate, which is worth roughly $0.045 of a design's
 * $0.629. But the ledger shows `cached_input_tokens` at 0 on every recent gpt-6-astra call and 8%
 * lifetime, while claude-fable-5-1 rows in the same table show heavy caching. Three possibilities:
 * the prefix never reaches the provider's minimum, it is not stable enough to match, or the usage
 * field is simply not reported for this model.
 *
 * Engineering for a saving before knowing which of those is true would be guesswork, so this asks
 * the provider directly: three calls, same long stable prefix, different one-line suffix. If the
 * second and third report cached input, caching works and restructuring prompts is worth doing.
 * Costs a few cents.
 *
 * Usage: OPENAI_API_KEY=... npx tsx scripts/experiments/prompt-cache-probe.ts [--model gpt-6-astra]
 */
import fs from 'node:fs';
import path from 'node:path';
import { OpenAiStudioClient } from '../../packages/creative/src/studio/openai-studio-client.js';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const MODEL = arg('model', 'gpt-6-astra');

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const referencePack = fs.readFileSync(
  path.join(repoRoot, 'packages/creative/assets/kaae-reference.json'),
  'utf8'
);

// Doubled so the stable prefix is unambiguously past any plausible minimum — the question here is
// whether caching happens at all, not where the threshold sits.
const PREFIX =
  `You are a senior design director working to a client's standing rules. Apply them exactly.\n${referencePack}\n`.repeat(
    2
  );

const client = new OpenAiStudioClient({ apiKey: process.env.OPENAI_API_KEY });
const jsonSchema = {
  name: 'Answer',
  schema: {
    type: 'object',
    properties: { word: { type: 'string' } },
    required: ['word'],
    additionalProperties: false,
  },
  strict: true,
};

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
  console.log(`model ${MODEL}, stable prefix ${PREFIX.length} chars\n`);

  for (const [i, suffix] of [
    'Reply with the word alpha.',
    'Reply with the word beta.',
    'Reply with the word gamma.',
  ].entries()) {
    const res = await client.createStructuredCompletion<{ word: string }>({
      model: MODEL,
      messages: [
        { role: 'system', content: PREFIX },
        { role: 'user', content: suffix },
      ],
      jsonSchema,
      maxTokens: 50,
    });
    const r = res.receipt as any;
    console.log(
      `call ${i + 1}: input=${r.inputTokens} cacheRead=${r.cacheReadTokens ?? 0} ` +
        `cacheWrite=${r.cacheCreationTokens ?? 0} output=${r.outputTokens} $${r.costUsd}`
    );
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
