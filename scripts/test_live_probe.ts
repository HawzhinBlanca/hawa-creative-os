import { LiveRunner } from '../packages/evals/src/design-studio/live-runner.js';
import { getBriefById } from '../packages/evals/src/design-studio/loader.js';

async function main() {
  const brief = getBriefById('golden-01');
  if (!brief) throw new Error('Could not find golden-01');

  console.log('Testing live runner on brief:', brief.id);
  const runner = new LiveRunner({
    baseUrl: 'http://127.0.0.1:8080',
    tier: 'standard', // test with standard for speed
    pollIntervalMs: 2000,
  });

  const result = await runner.runBrief(brief);
  console.log('Live run result:', {
    briefId: result.briefId,
    status: result.status,
    spentUsd: result.spentUsd,
    callsCount: result.callsCount,
    winnerScore: result.winnerScore,
    canaryVerdict: result.canary.verdict,
    previewSha256: result.previewSha256 ? result.previewSha256.substring(0, 12) + '...' : 'none',
  });
}

main().catch(err => {
  console.error('Probe failed:', err);
  process.exit(1);
});
