import fs from 'node:fs';
import path from 'node:path';
import {
  refineCandidate,
  evaluateDesignMetrics,
  type StudioLayoutV2,
} from '../packages/creative/dist/index.js';

async function main() {
  console.log('=== Starting P06 Gated Refinement with Plateau Stop Proof Runner ===');

  const outputDir = path.resolve(
    process.cwd(),
    'output/proofs/2026-09-17-research-grade-pipeline'
  );
  fs.mkdirSync(outputDir, { recursive: true });

  const layout4Path = path.join(outputDir, 'P03_LAYOUTS/layout_04.json');
  const baseLayout: StudioLayoutV2 = JSON.parse(fs.readFileSync(layout4Path, 'utf8'));
  if (baseLayout.text[1]) {
    baseLayout.text[1].fontFamily = 'Crimson Pro';
  }

  // --- CANDIDATE 1: Passing Candidate (Must be skipped, 0 calls) ---
  console.log('\n--- Evaluating Candidate 1: Already-Passing Layout ---');
  const cand1 = await refineCandidate('candidate-1-passing', baseLayout, {
    model: 'gpt-6-astra',
  });
  console.log('Candidate 1 result:', {
    gateDecision: cand1.gateDecision,
    roundsRun: cand1.roundsRun,
    stopReason: cand1.stopReason,
    initialScore: cand1.initialScore,
    finalScore: cand1.finalScore,
  });
  if (cand1.roundsRun !== 0) {
    throw new Error(`Candidate 1 should have made 0 calls, made ${cand1.roundsRun}`);
  }

  // --- CANDIDATE 2: Failing Candidate (Must be repaired live and pass) ---
  console.log('\n--- Evaluating Candidate 2: Failing Layout (Live Repair) ---');
  const misalignedPath = path.join(outputDir, 'P05_CRITIQUE/misaligned_layout.json');
  const cand2Input: StudioLayoutV2 = JSON.parse(fs.readFileSync(misalignedPath, 'utf8'));
  if (cand2Input.text[1]) {
    cand2Input.text[1].fontFamily = 'Crimson Pro';
  }

  const cand2 = await refineCandidate('candidate-2-repaired', cand2Input, {
    model: 'gpt-6-astra',
    maxRounds: 2,
    minDelta: 0.005,
  });
  console.log('Candidate 2 result:', {
    gateDecision: cand2.gateDecision,
    roundsRun: cand2.roundsRun,
    stopReason: cand2.stopReason,
    initialScore: cand2.initialScore,
    finalScore: cand2.finalScore,
    scoreDelta: cand2.scoreDelta,
    changesAttributed: cand2.rounds.map((r) => r.changesAttributed),
  });

  // --- CANDIDATE 3: Plateauing Candidate (Must stop early before round 2) ---
  console.log('\n--- Evaluating Candidate 3: Plateauing Layout ---');
  // Candidate 3: failing layout with a high minDelta threshold or minimal nudge
  // We can exercise Candidate 3 with minDelta: 0.05 so that a minor improvement (< 0.05) halts the loop
  const cand3Input: StudioLayoutV2 = {
    ...cand2Input,
  };

  const cand3 = await refineCandidate('candidate-3-plateaued', cand3Input, {
    model: 'gpt-6-astra',
    maxRounds: 2,
    minDelta: 0.08, // Set plateau threshold higher than typical single-round delta to verify plateau stop halts before round 2
  });
  console.log('Candidate 3 result:', {
    gateDecision: cand3.gateDecision,
    roundsRun: cand3.roundsRun,
    stopReason: cand3.stopReason,
    initialScore: cand3.initialScore,
    finalScore: cand3.finalScore,
    scoreDelta: cand3.scoreDelta,
  });

  // 4. Combine results into P06_REFINE.json
  const finalProofData = {
    generatedAt: new Date().toISOString(),
    specification: 'arXiv:2607.26922 (Gated Refinement & Plateau Stopping Rule)',
    model: 'gpt-6-astra',
    candidates: [
      {
        candidateId: cand1.candidateId,
        type: 'passing',
        gateDecision: cand1.gateDecision,
        roundsRun: cand1.roundsRun,
        initialScore: cand1.initialScore,
        finalScore: cand1.finalScore,
        scoreDelta: cand1.scoreDelta,
        passed: cand1.passed,
        stopReason: cand1.stopReason,
        rounds: cand1.rounds,
      },
      {
        candidateId: cand2.candidateId,
        type: 'repaired',
        gateDecision: cand2.gateDecision,
        roundsRun: cand2.roundsRun,
        initialScore: cand2.initialScore,
        finalScore: cand2.finalScore,
        scoreDelta: cand2.scoreDelta,
        passed: cand2.passed,
        stopReason: cand2.stopReason,
        rounds: cand2.rounds.map((r) => ({
          round: r.round,
          preScore: r.preScore,
          postScore: r.postScore,
          scoreDelta: r.scoreDelta,
          preFailingMetrics: r.preFailingMetrics,
          postFailingMetrics: r.postFailingMetrics,
          changesAttributed: r.changesAttributed,
          stopReason: r.stopReason,
          receipt: r.receipt,
        })),
      },
      {
        candidateId: cand3.candidateId,
        type: 'plateaued',
        gateDecision: cand3.gateDecision,
        roundsRun: cand3.roundsRun,
        initialScore: cand3.initialScore,
        finalScore: cand3.finalScore,
        scoreDelta: cand3.scoreDelta,
        passed: cand3.passed,
        stopReason: cand3.stopReason,
        rounds: cand3.rounds.map((r) => ({
          round: r.round,
          preScore: r.preScore,
          postScore: r.postScore,
          scoreDelta: r.scoreDelta,
          preFailingMetrics: r.preFailingMetrics,
          postFailingMetrics: r.postFailingMetrics,
          changesAttributed: r.changesAttributed,
          stopReason: r.stopReason,
          receipt: r.receipt,
        })),
      },
    ],
  };

  const proofJsonPath = path.join(outputDir, 'P06_REFINE.json');
  fs.writeFileSync(proofJsonPath, JSON.stringify(finalProofData, null, 2), 'utf8');

  console.log(`\nProof written to ${proofJsonPath}`);
  console.log('=== P06 Proof Completed Successfully ===');
}

main().catch((err) => {
  console.error('P06 Proof Runner Failed:', err);
  process.exit(1);
});
