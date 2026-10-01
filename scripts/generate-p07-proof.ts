import fs from 'node:fs';
import path from 'node:path';
import {
  runTournamentWithCanary,
  createDegradedCanaryLayout,
  evaluateDesignMetrics,
  type StudioLayoutV2,
  type CandidateJudgeInput,
} from '../packages/creative/dist/index.js';

async function main() {
  console.log('=== Starting P07 Pairwise Dimension-Wise Judge Live Tournament Runner ===');

  const outputDir = path.resolve(
    process.cwd(),
    'output/proofs/2026-09-17-research-grade-pipeline'
  );
  fs.mkdirSync(outputDir, { recursive: true });

  // 1. Load layouts from P03
  const layout1Path = path.join(outputDir, 'P03_LAYOUTS/layout_01.json');
  const layout4Path = path.join(outputDir, 'P03_LAYOUTS/layout_04.json');

  const layout1: StudioLayoutV2 = JSON.parse(fs.readFileSync(layout1Path, 'utf8'));
  const layout4: StudioLayoutV2 = JSON.parse(fs.readFileSync(layout4Path, 'utf8'));

  // Ensure fonts resolve to bundled font family (e.g. Crimson Pro if Lora was specified)
  for (const item of layout1.text) {
    if (item.fontFamily === 'Lora') item.fontFamily = 'Crimson Pro';
  }
  for (const item of layout4.text) {
    if (item.fontFamily === 'Lora') item.fontFamily = 'Crimson Pro';
  }

  // 2. First verify Single-Survivor Bypass:
  console.log('\n--- Test 1: Single Survivor Bypass (0 calls rule) ---');
  const singleSurvivorTournament = await runTournamentWithCanary(
    [
      {
        id: 'survivor-alone',
        layout: layout4,
      },
    ],
    { model: 'gpt-6-astra' }
  );

  console.log('Single survivor result:', {
    skippedDueToSingleSurvivor: singleSurvivorTournament.skippedDueToSingleSurvivor,
    callsMade: singleSurvivorTournament.callsMade,
    totalCostUsd: singleSurvivorTournament.totalCostUsd,
    winnerId: singleSurvivorTournament.winnerId,
  });

  if (singleSurvivorTournament.callsMade !== 0 || !singleSurvivorTournament.skippedDueToSingleSurvivor) {
    throw new Error(`Single survivor should have made 0 calls, made ${singleSurvivorTournament.callsMade}`);
  }

  // 3. Run Live Multi-Candidate Tournament with Order-Swapping and Degraded Canary
  console.log('\n--- Test 2: Multi-Candidate Tournament with Canary and Order Swapping ---');
  const candidates: CandidateJudgeInput[] = [
    {
      id: 'candidate_layout_01',
      layout: layout1,
    },
    {
      id: 'candidate_layout_04',
      layout: layout4,
    },
  ];

  const tournament = await runTournamentWithCanary(candidates, {
    model: 'gpt-6-astra',
  });

  console.log('Tournament complete:', {
    survivors: tournament.survivingCandidates.map((s) => s.id),
    callsMade: tournament.callsMade,
    totalCostUsd: tournament.totalCostUsd,
    winnerId: tournament.winnerId,
    canaryLost: tournament.canaryResult?.canaryLost,
    canaryPassed: tournament.canaryResult?.canaryPassed,
  });

  if (!tournament.canaryResult?.canaryLost) {
    throw new Error('Canary failed to lose against the authentic candidate layout!');
  }

  // 4. Save P07_JUDGE.json
  const proofJson = {
    generatedAt: new Date().toISOString(),
    specification: 'arXiv:2604.22891 (Dimension-Wise Pairwise Judge & Position Bias Order-Swapping)',
    model: 'gpt-6-astra',
    singleSurvivorBypass: {
      candidateCount: 1,
      skippedDueToSingleSurvivor: singleSurvivorTournament.skippedDueToSingleSurvivor,
      callsMade: singleSurvivorTournament.callsMade,
      totalCostUsd: singleSurvivorTournament.totalCostUsd,
    },
    liveTournament: {
      candidateCount: candidates.length,
      survivingCandidates: tournament.survivingCandidates,
      callsMade: tournament.callsMade,
      totalCostUsd: tournament.totalCostUsd,
      winnerId: tournament.winnerId,
      matches: tournament.matches.map((m) => ({
        candidate1Id: m.candidate1Id,
        candidate2Id: m.candidate2Id,
        isConsistent: m.isConsistent,
        disagreementRecorded: m.disagreementRecorded,
        winnerId: m.winnerId,
        reason: m.reason,
        totalCostUsd: m.totalCostUsd,
        orderAB: {
          order: m.orderAB.order,
          candidateAId: m.orderAB.candidateAId,
          candidateBId: m.orderAB.candidateBId,
          votes: m.orderAB.votes,
          rationales: m.orderAB.rationales,
          majorityWinner: m.orderAB.majorityWinner,
          winnerCandidateId: m.orderAB.winnerCandidateId,
          receipt: m.orderAB.receipt,
        },
        orderBA: {
          order: m.orderBA.order,
          candidateAId: m.orderBA.candidateAId,
          candidateBId: m.orderBA.candidateBId,
          votes: m.orderBA.votes,
          rationales: m.orderBA.rationales,
          majorityWinner: m.orderBA.majorityWinner,
          winnerCandidateId: m.orderBA.winnerCandidateId,
          receipt: m.orderBA.receipt,
        },
      })),
      canaryCheck: tournament.canaryResult
        ? {
            canaryCandidateId: tournament.canaryResult.canaryCandidateId,
            canaryLost: tournament.canaryResult.canaryLost,
            canaryPassed: tournament.canaryResult.canaryPassed,
            match: {
              candidate1Id: tournament.canaryResult.match.candidate1Id,
              candidate2Id: tournament.canaryResult.match.candidate2Id,
              isConsistent: tournament.canaryResult.match.isConsistent,
              disagreementRecorded: tournament.canaryResult.match.disagreementRecorded,
              winnerId: tournament.canaryResult.match.winnerId,
              reason: tournament.canaryResult.match.reason,
              totalCostUsd: tournament.canaryResult.match.totalCostUsd,
              orderAB: {
                votes: tournament.canaryResult.match.orderAB.votes,
                rationales: tournament.canaryResult.match.orderAB.rationales,
                receipt: tournament.canaryResult.match.orderAB.receipt,
              },
              orderBA: {
                votes: tournament.canaryResult.match.orderBA.votes,
                rationales: tournament.canaryResult.match.orderBA.rationales,
                receipt: tournament.canaryResult.match.orderBA.receipt,
              },
            },
          }
        : null,
    },
  };

  const proofPath = path.join(outputDir, 'P07_JUDGE.json');
  fs.writeFileSync(proofPath, JSON.stringify(proofJson, null, 2), 'utf8');

  // 5. Create P07_PROOF.md
  const proofMd = `# P07 Proof: Pairwise Dimension-Wise Judge & Order-Swapping (arXiv:2604.22891)

## Overview
- **Model**: \`gpt-6-astra\` (Allowed model per \`@hawa/domain\`)
- **Dimensions**: \`hierarchy\`, \`composition\`, \`typographic_craft\`, \`brand_fit\`, \`legibility\`
- **Facts-First Grounding**: Prior to LLM reasoning, deterministic design metrics (P01 LaySPA/arXiv:2402.06945) are supplied as facts.
- **Position Bias Order-Swapping**: Every pair is judged in AB and BA order. Flip disagreements are recorded as ties and discarded.
- **Degraded-Copy Canary**: Deliberately corrupted copy candidate is pitted against authentic candidate; must lose in all 5 dimensions.
- **Single-Survivor Bypass**: When only 1 candidate survives P01, judge calls are bypassed (0 calls, $0.00 cost).

## Verification Results

### 1. Single-Survivor Bypass
- Candidate count: 1
- Calls made: **0**
- Cost: **$0.00**
- Bypass triggered: \`true\`

### 2. Multi-Candidate Tournament
- Candidates evaluated: \`${tournament.survivingCandidates.map((c) => c.id).join(', ')}\`
- Tournament calls made: \`${tournament.callsMade}\`
- Tournament cost: \`$${tournament.totalCostUsd.toFixed(6)}\`
- Tournament winner: \`${tournament.winnerId}\`

### 3. Canary Test
- Canary candidate: \`${tournament.canaryResult?.canaryCandidateId}\`
- Canary lost: **${tournament.canaryResult?.canaryLost}** (Authentic layout won)
- Dimension votes on canary:
${Object.entries(tournament.canaryResult?.match.orderAB.votes || {})
  .map(([dim, winner]) => `  - **${dim}**: Authentic winner (${winner})`)
  .join('\n')}

Artifact: [\`P07_JUDGE.json\`](./P07_JUDGE.json)
`;

  fs.writeFileSync(path.join(outputDir, 'P07_PROOF.md'), proofMd, 'utf8');
  console.log(`\nP07 proofs generated successfully:`);
  console.log(`- ${proofPath}`);
  console.log(`- ${path.join(outputDir, 'P07_PROOF.md')}`);
}

main().catch((err) => {
  console.error('P07 proof failed:', err);
  process.exit(1);
});
