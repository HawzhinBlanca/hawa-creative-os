import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { EvaluationRunner } from '../src/runner.js';
import { FakeModelGateway } from '@hawa/testkit';
import { LiveRunner } from '../src/design-studio/live-runner.js';
import { generateMarkdownReport } from '../src/design-studio/report-generator.js';
import { verifyReleaseManifest } from '../../../scripts/verify_release_manifest.js';

describe('Proof Machinery Negative Controls & Qualification Honesty (W01)', () => {
  it('strictly rejects decisions missing required client and project identity', async () => {
    class MissingIdentityGateway extends FakeModelGateway {
      async generateStructured(ctx: any, req: any) {
        const result = await super.generateStructured(ctx, req);
        if (result.ok && result.value?.value) {
          result.value.value = {
            decision: (result.value.value as any).decision,
            confidence: (result.value.value as any).confidence,
          } as any;
        }
        return result;
      }
    }

    const runner = new EvaluationRunner(new MissingIdentityGateway());
    const res = await runner.runRoutingAndBriefTournament();
    expect(res.passedCases).toBeLessThanOrEqual(5); // Only genuine abstention cases should pass
    expect(res.failedCases).toBeGreaterThanOrEqual(195);
    expect(res.passRate).toBeLessThanOrEqual(5.0);
  });

  it('strictly fails tournament swap consistency when measurements are partially missing', async () => {
    const liveRunner = new LiveRunner({ bearerToken: 'test-token', baseUrl: 'http://localhost:3000' });
    let runIndex = 0;
    liveRunner.runBrief = async () => ({
      briefId: `test-brief-${++runIndex}`,
      briefName: 'Test Brief',
      language: 'en',
      dimensions: '1080x1080',
      status: 'transferred',
      ladderRung: 0,
      rungsTriggered: [],
      callsCount: 1,
      spentUsd: 0.1,
      durationMs: 100,
      winnerScore: 9,
      canary: { passed: true, verdict: 'RELIABLE', winnerId: 'concept-1' },
      tournament: {
        winnerId: 'concept-1',
        candidateScores: {},
        swapConsistencyRate: runIndex === 1 ? 1.0 : undefined,
        pairwiseRounds: runIndex === 1 ? 4 : 0,
      },
      hardQaEscapes: 0,
      canvaDesignId: 'design-1',
      previewSha256: 'hash-1',
      parity: { parity: 'match', divergences: [], fontSubstituted: false, textReflowed: false, copyVisibleIdentical: true },
      fontFidelity: 'exact',
    });

    const report = await liveRunner.runAll(Array.from({ length: 24 }, (_, i) => ({ id: `b-${i}`, name: `b-${i}` } as any)));
    expect(report.tournamentSwapConsistencyRate).toBeLessThan(0.1);

    const markdown = generateMarkdownReport(report);
    expect(markdown).toContain('| Tournament Swap Consistency | 4.2% | ≥ 80.0% | FAIL |');
  });

  it('strictly refuses release manifest with fabricated commit, dirty tree, or missing components', () => {
    const root = path.resolve(__dirname, '../../..');
    const manifestPath = path.join(root, 'RELEASE_MANIFEST.json');
    const original = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    const synthetic = structuredClone(original);
    synthetic.build.commit = 'f'.repeat(40);
    synthetic.build.treeClean = false;
    synthetic.components = {};
    synthetic.models = { registryVersion: 'not-the-runtime-registry', pinnedModels: {}, promptVersions: {} };
    delete synthetic.sha256;
    synthetic.sha256 = crypto.createHash('sha256').update(JSON.stringify(synthetic, null, 2)).digest('hex');

    const tempPath = path.join(root, 'RELEASE_MANIFEST.test-synthetic.json');
    fs.writeFileSync(tempPath, JSON.stringify(synthetic, null, 2));

    try {
      const result = verifyReleaseManifest(tempPath);
      expect(result.ok).toBe(false);
      expect(result.errors.some(e => e.includes('clean tree'))).toBe(true);
      expect(result.errors.some(e => e.includes('components cannot be empty'))).toBe(true);
      expect(result.errors.some(e => e.includes('models coverage cannot be empty'))).toBe(true);
    } finally {
      fs.unlinkSync(tempPath);
    }
  });
});
