import { randomUUID, createHash } from 'node:crypto';
import type { StageContext, CreativeBrief, CandidateState, CanaryResult, PairwiseVerdict } from '../types.js';
import type { StudioLayoutV2 } from '@hawa/creative';
import { renderLayoutV2Async, computeLayoutMetrics } from '@hawa/creative';
import { buildP0SystemPrompt, buildP6Prompt } from '../prompts.js';
import { PAIRWISE_SCHEMA } from './tournament.stage.js';

export function createPerturbation1(layout: StudioLayoutV2): StudioLayoutV2 {
  // Body font size -40% and line-height 1.0
  const clone: StudioLayoutV2 = JSON.parse(JSON.stringify(layout));
  clone.text = clone.text.map((t) => {
    if (t.role === 'body') {
      return {
        ...t,
        fontSize: Math.max(8, Math.round(t.fontSize * 0.6)),
        lineHeight: 1.0,
      };
    }
    return t;
  });
  return clone;
}

export function createPerturbation2(layout: StudioLayoutV2): StudioLayoutV2 {
  // Title box moved to overlap logo by 40% and colour set to background colour (low contrast)
  const clone: StudioLayoutV2 = JSON.parse(JSON.stringify(layout));
  const logo = clone.logo;
  clone.text = clone.text.map((t) => {
    if (t.role === 'title' && logo) {
      return {
        ...t,
        x: logo.x + Math.round(logo.width * 0.2),
        y: logo.y + Math.round(logo.height * 0.2),
        color: clone.background.color,
      };
    }
    return t;
  });
  return clone;
}

export async function runCanaryStage(
  ctx: StageContext,
  brief: CreativeBrief,
  winner: CandidateState
): Promise<CanaryResult> {

  const systemPrompt = buildP0SystemPrompt({
    referencePackJson: JSON.stringify(ctx.referencePack),
    promotedRules: ctx.promotedRules || 'None',
  });

  const copyMap: Record<number, string> = {};
  for (let i = 0; i < ctx.copyBlocks.length; i++) {
    copyMap[i] = ctx.copyBlocks[i].text;
  }

  const artDataUri = winner.artPng
    ? `data:image/png;base64,${winner.artPng.toString('base64')}`
    : undefined;
  const logoDataUri = ctx.logo
    ? `data:${ctx.logo.mimeType};base64,${ctx.logo.bytes.toString('base64')}`
    : undefined;

  // 1 & 2. Render Perturbations concurrently
  const layoutP1 = createPerturbation1(winner.currentLayout);
  const layoutP2 = createPerturbation2(winner.currentLayout);

  const [renderP1, renderP2] = await Promise.all([
    renderLayoutV2Async(layoutP1, {
      copyText: copyMap,
      artImagePath: artDataUri,
      logoDataUri,
    }),
    renderLayoutV2Async(layoutP2, {
      copyText: copyMap,
      artImagePath: artDataUri,
      logoDataUri,
    }),
  ]);

  const metricsP1 = computeLayoutMetrics(layoutP1, {
    copyText: copyMap,
    measuredLines: renderP1.wrappedLines,
  });

  const metricsP2 = computeLayoutMetrics(layoutP2, {
    copyText: copyMap,
    measuredLines: renderP2.wrappedLines,
  });

  const perturbations = [
    { num: 1, previewPng: renderP1.png, metrics: metricsP1 },
    { num: 2, previewPng: renderP2.png, metrics: metricsP2 },
  ];

  const details: CanaryResult['details'] = [];
  let allPassed = true;

  for (const p of perturbations) {
    // Call 1: Winner as A, Perturbation as B
    const promptAB = buildP6Prompt({
      metricsA: JSON.stringify(winner.metrics || {}),
      metricsB: JSON.stringify(p.metrics || {}),
      creativeBriefJson: JSON.stringify(brief),
    });

    const resAB = await ctx.client.completeJson<PairwiseVerdict>({
      system: systemPrompt,
      prompt: promptAB,
      schema: PAIRWISE_SCHEMA,
      schemaName: 'PairwiseVerdict',
      images: [winner.previewPng!, p.previewPng],
    });

    const winnerWonAB = resAB.data.winner === 'A';
    if (!winnerWonAB) allPassed = false;
    details.push({
      perturbation: p.num,
      orderSwapped: false,
      verdict: resAB.data,
      winnerWon: winnerWonAB,
    });

    // Call 2: Perturbation as A, Winner as B (Swapped)
    const promptBA = buildP6Prompt({
      metricsA: JSON.stringify(p.metrics || {}),
      metricsB: JSON.stringify(winner.metrics || {}),
      creativeBriefJson: JSON.stringify(brief),
    });

    const resBA = await ctx.client.completeJson<PairwiseVerdict>({
      system: systemPrompt,
      prompt: promptBA,
      schema: PAIRWISE_SCHEMA,
      schemaName: 'PairwiseVerdict',
      images: [p.previewPng, winner.previewPng!],
    });

    const winnerWonBA = resBA.data.winner === 'B';
    if (!winnerWonBA) allPassed = false;
    details.push({
      perturbation: p.num,
      orderSwapped: true,
      verdict: resBA.data,
      winnerWon: winnerWonBA,
    });

    // Log to ledger
    if (ctx.ledger) {
      await ctx.ledger.insertJudgment({
        id: randomUUID(),
        runId: ctx.runId,
        tenantId: ctx.tenantId,
        kind: 'canary',
        candidateA: winner.id,
        orderSwapped: false,
        verdict: resAB.data as unknown as Record<string, unknown>,
      });
      await ctx.ledger.insertJudgment({
        id: randomUUID(),
        runId: ctx.runId,
        tenantId: ctx.tenantId,
        kind: 'canary',
        candidateA: winner.id,
        orderSwapped: true,
        verdict: resBA.data as unknown as Record<string, unknown>,
      });
    }
  }

  return {
    passed: allPassed,
    judgeStatus: allPassed ? 'RELIABLE' : 'UNRELIABLE',
    details,
  };
}
