/**
 * ADR-274 addendum: does the poster vote still beat its own degraded canary? Paid, small, owner-approved.
 *
 * Production trusts a judge pick only when the chosen design beats a degraded copy of itself in both
 * orders (`createDegradedCanaryLayout`: body at half size with squashed leading, the title smaller
 * and shifted into the margin). The five-vote judge caught it through legibility, typographic craft
 * and hierarchy. The poster vote has no text votes: it must catch it through the legibility gate,
 * impact and composition, or every KAAE pick would be marked unreliable. This runs the production
 * judge (`comparePairWithOrderSwap` with `posterImpact`, KAAE's house rules and profile) on three
 * composed KAAE posters against their canaries: 3 pairs, 6 calls, about $0.07.
 *
 * Usage (paid): OPENAI_API_KEY=... HAWA_JUDGE_CALIBRATION_APPROVED="<approval>" \
 *   npx tsx scripts/experiments/poster-vote-canary.ts --execute [--max-usd 0.3] [--out <report.json>]
 * Without --execute, the approval and a key it prints the plan and sends nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { composePosterLayout, type PosterVariant } from '../../packages/creative/src/studio/poster-grammar.js';
import { guidelineFidelityRule, pageGrammarFromRaw } from '../../packages/creative/src/studio/page-grammar.js';
import { artDirectionRulesFromRaw } from '../../packages/creative/src/studio/hard-qa.js';
import { renderLayoutV2 } from '../../packages/creative/src/studio/render-layout-v2.js';
import { measureDesignV3 } from '../../packages/creative/src/studio/pipeline-v3.js';
import { comparePairWithOrderSwap, createDegradedCanaryLayout } from '../../packages/creative/src/studio/pairwise-judge-v3.js';
import { OpenAiStudioClient } from '../../packages/creative/src/studio/openai-studio-client.js';

const ROOT = resolve(import.meta.dirname, '../..');
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const BRIEFS: Array<{ id: string; lines: string[]; roles: string[]; variant: PosterVariant }> = [
  { id: 'workshop', variant: 'navy', lines: ['Quality Assurance Workshop', 'For university deans', '15 October 2026 · 9:30 AM', 'Rotana Hotel, Erbil', 'Registration is free'], roles: ['title', 'subtitle', 'date', 'venue', 'cta'] },
  { id: 'peer call', variant: 'cream', lines: ['Call for Peer Evaluators', 'K-12 and Higher Education'], roles: ['title', 'subtitle'] },
  { id: 'Sorani workshop', variant: 'band', lines: ['وۆرکشۆپی دڵنیایی جۆری', 'بۆ ڕاگرانی زانکۆکان', '١٥ی تشرینی یەکەمی ٢٠٢٦', 'هوتێل ڕۆتانا، هەولێر', 'تۆمارکردن بەخۆڕاییە'], roles: ['title', 'subtitle', 'date', 'venue', 'cta'] },
];

async function main(): Promise<void> {
  const model = arg('model') ?? 'gpt-6.1-sol';
  const maxUsd = Number(arg('max-usd') ?? 0.3);
  console.log(JSON.stringify({ plan: { model, pairs: BRIEFS.length, calls: 2 * BRIEFS.length, expectedUsd: { low: 0.06, high: 0.08 }, maxUsd } }));
  const approval = process.env.HAWA_JUDGE_CALIBRATION_APPROVED?.trim();
  const renders = arg('renders');
  const execute = process.argv.includes('--execute') && Boolean(approval) && Boolean(process.env.OPENAI_API_KEY);
  if (!execute && !renders) {
    console.log('Plan only: nothing was sent. --renders <dir> writes each poster and its canary, free.');
    return;
  }
  const raw = JSON.parse(readFileSync(resolve(ROOT, 'packages/creative/assets/kaae-reference.json'), 'utf8'));
  const grammar = pageGrammarFromRaw(raw)!;
  const logo = readFileSync(resolve(ROOT, 'packages/creative/assets/logos/kaae-official-logo.png'));
  const clientProfile = (JSON.parse(readFileSync(resolve(ROOT, 'packages/creative/assets/clients/kaae.json'), 'utf8')) as { profile?: string }).profile;
  // As production: the client's art-direction rules, then the guideline-fidelity rule (houseRulesFor).
  const houseRules = [...artDirectionRulesFromRaw(raw), guidelineFidelityRule(grammar)];
  const client = execute ? new OpenAiStudioClient({ primaryModel: model }) : undefined;
  let spent = 0;
  const rows = [];
  for (const b of BRIEFS) {
    if (spent + 0.06 > maxUsd) throw new Error(`Stopped before a pair: $${spent.toFixed(4)} spent, cap $${maxUsd}.`);
    const copyText = Object.fromEntries(b.lines.map((t, i) => [i, t]));
    const layout = composePosterLayout({
      width: 1080, height: 1350, grammar, copy: { text: copyText }, roles: Object.fromEntries(b.roles.map((r, i) => [i, r])),
      logoAspect: 1, logoMinimumWidthPx: 80, logoClearSpaceShare: 0.15, tone: 'page' as const,
      fonts: { arabicDisplay: 'IBM Plex Sans Arabic', arabicBody: 'Noto Sans Arabic' }, variant: b.variant,
    });
    const renderOptions = { copyText, logoDataUri: `data:image/png;base64,${logo.toString('base64')}` };
    const canary = createDegradedCanaryLayout(layout);
    const chosenPng = renderLayoutV2(layout, renderOptions).png;
    const canaryPng = renderLayoutV2(canary, renderOptions).png;
    if (chosenPng.equals(canaryPng)) throw new Error(`${b.id}: the canary renders identically; nothing to test.`);
    const slug = b.id.replace(/\W+/g, '_');
    if (renders) {
      writeFileSync(resolve(renders, `${slug}__chosen.png`), chosenPng);
      writeFileSync(resolve(renders, `${slug}__canary.png`), canaryPng);
    }
    if (!execute) continue;
    const match = await comparePairWithOrderSwap(
      { id: 'chosen', layout, deterministicMetrics: measureDesignV3(layout, { text: copyText }), renderedPng: chosenPng },
      { id: 'degraded_canary', layout: canary, deterministicMetrics: measureDesignV3(canary, { text: copyText }), renderedPng: canaryPng },
      { client: client!, model, posterImpact: true, houseRules, clientProfile, renderOptions }
    );
    spent += match.totalCostUsd;
    const order = (o: typeof match.orderAB) => ({ candidateA: o.candidateAId, winner: o.winnerCandidateId, votes: o.votes,
      weighted: [o.weightedVotesA, o.weightedVotesB], legibilityGate: o.legibilityGate, legibilityVeto: o.legibilityVeto,
      responseId: o.receipt.responseId, costUsd: o.receipt.costUsd });
    rows.push({ brief: b.id, variant: b.variant, canaryPassed: match.winnerId === 'chosen', winnerId: match.winnerId,
      orderAB: order(match.orderAB), orderBA: order(match.orderBA), rationalesAB: match.orderAB.rationales });
    console.log(`${b.id} (${b.variant}): canary ${match.winnerId === 'chosen' ? 'passed' : 'FAILED'} (${match.winnerId}), spent $${spent.toFixed(4)}`);
  }
  if (!execute) {
    console.log(`Renders written to ${renders}; nothing was sent.`);
    return;
  }
  const report = { model, approval, ranAt: new Date().toISOString(), spentUsd: Math.round(spent * 10000) / 10000,
    passed: rows.filter((r) => r.canaryPassed).length, pairs: rows.length, rows };
  const out = arg('out');
  if (out) writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ spentUsd: report.spentUsd, passed: report.passed, pairs: report.pairs }));
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err).replace(/\bsk-[A-Za-z0-9_*.-]+/g, 'sk-[redacted]'));
  process.exitCode = 1;
});
