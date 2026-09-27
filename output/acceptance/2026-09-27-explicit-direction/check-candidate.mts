import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../../../', import.meta.url);
const proof = JSON.parse(readFileSync(new URL('packages/testkit/chaos/.run/last-run.json', root), 'utf8'));
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (proof.deployment.commit !== source || Object.keys(proof.deployment.sourceChanges).length
    || proof.scenarios.length !== 1 || proof.scenarios[0].name !== 'R1.S3.SOURCES'
    || proof.scenarios[0].invariants.some((entry: any) => !entry.ok)) throw new Error('Candidate rehearsal not current or not passing');
const env = Object.fromEntries(readFileSync(new URL('packages/testkit/chaos/.run/chaos.env', root), 'utf8')
  .trim().split('\n').map(line => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)]; }));
const get = async (path: string) => {
  const response = await fetch(`http://127.0.0.1:56081/v1${path}`, {
    headers: { Authorization: `Bearer ${env.CHAOS_BEARER_TOKEN}` }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Candidate read refused: HTTP ${response.status}`);
  return response.json();
};
const list = await get('/tasks?limit=200');
const reviewed = list.items.filter((item: any) => item.qaReport);
if (!reviewed.length) throw new Error('No checked candidate tasks');
const checks = [];
for (const item of reviewed) {
  const detail = await get(`/tasks/${item.id}`);
  if (item.qaReport.fontCoverage !== null || detail.qaReport.fontCoverage !== null
      || item.qaReport.fontFamilyPass !== detail.qaReport.fontFamilyPass
      || item.qaReport.rtlVisualReviewRequired !== detail.qaReport.rtlVisualReviewRequired) throw new Error('Deployed font or RTL evidence disagrees');
  checks.push({ taskId: item.id, status: detail.status, fontCoverage: null,
    fontFamilyPass: detail.qaReport.fontFamilyPass, rtlVisualReviewRequired: detail.qaReport.rtlVisualReviewRequired,
    listDetailAgree: true });
}
const images = ['core','desk','worker-blue'].map(service => {
 const raw=execFileSync('docker',['inspect','--format','{{.Image}}|{{index .Config.Labels \"org.opencontainers.image.revision\"}}',`hawa-chaos-${service}-1`],{encoding:'utf8'}).trim();
 const [imageId,buildCommit]=raw.split('|');
 if(buildCommit!==source)throw new Error('Live candidate image identity changed');
 return {service,imageId,buildCommit};
});
writeFileSync(new URL('candidate-rehearsal.json', import.meta.url), JSON.stringify(proof, null, 2) + '\n');
const result = { checkedAt: new Date().toISOString(), sourceCommit: source,
  fullWorkflowInvariants: proof.scenarios[0].invariants.length,
  fontQaChecks: checks, providerScope: 'synthetic external providers and synthetic office identities',
  images,
  sourceHashes: Object.fromEntries(['packages/creative/src/studio/transfer-v2.ts', 'packages/qa/src/canva-pptx-check.ts', 'apps/core/src/core-helpers.ts', 'apps/core/src/routes/tasks.routes.ts',
    'apps/core/src/services/canva-font-evidence.ts', 'apps/desk/src/screens/WorkScreen.tsx', 'packages/db/src/repositories/task.repository.ts']
    .map(path => [path, createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex')])),
  productionChanged: false, liveProviderAcceptance: false };
writeFileSync(new URL('candidate-font-qa.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ sourceCommit: source, fullWorkflowInvariants: result.fullWorkflowInvariants,
  checkedTasks: checks.length, allGlyphClaimsUnknown: true, imagesMatch: true, liveProviderAcceptance: false }));
