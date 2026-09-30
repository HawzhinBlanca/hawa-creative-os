import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imageIdPattern = /^sha256:[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;

export interface ImageObservation {
  service: 'core' | 'desk' | 'worker';
  container: string;
  imageRef: string;
  imageId: string;
  revisionLabel: string;
}

export interface DeploymentReceipt {
  receiptVersion: 1;
  evidenceKind: 'observed_deployment';
  status: 'image_runtime_migration_verified';
  observedAt: string;
  buildCommit: string;
  sourceCandidateCommit: string;
  sourceManifestSha256: string;
  workerColour: 'blue' | 'green';
  images: Record<'core' | 'desk' | 'worker', ImageObservation>;
  runtime: {
    healthStatus: string;
    configurationRevision?: string;
    postgres: string;
    flags: { DESIGN_PIPELINE_V3: string; DESIGN_STUDIO_V2: string };
    modelTier: string;
    models: Record<'text' | 'layout' | 'critique' | 'judge' | 'image', string>;
  };
  migration: { declaredTarget: string; observedApplied: { name: string; sha256: string } };
}

/** Build only from inspected container/image IDs and a live Core response. Never infer an image ID from a tag. */
export function buildDeploymentReceipt(input: {
  buildCommit: string;
  manifest: any;
  manifestBytes: Buffer;
  workerColour: 'blue' | 'green';
  observations: ImageObservation[];
  health: any;
  workerHealth?: any;
  expectedConfigurationRevision?: string;
  observedMigration: { name: string; sha256: string };
  observedAt?: string;
}): DeploymentReceipt {
  if (!commitPattern.test(input.buildCommit)) throw new Error('Invalid checkout commit');
  if (!commitPattern.test(input.manifest?.build?.commit || '')) throw new Error('Source candidate has no valid commit');
  if (!input.manifest?.migrations?.targetVersion) throw new Error('Source candidate has no migration target');
  const expectedMigration = `${input.manifest.migrations.targetVersion}.sql`;
  if (input.observedMigration?.name !== expectedMigration || !/^[0-9a-f]{64}$/.test(input.observedMigration.sha256 || '')) {
    throw new Error('Applied migration does not match source candidate target');
  }
  const migrationFile = path.join(root, 'packages/db/migrations', expectedMigration);
  if (!fs.existsSync(migrationFile) ||
      crypto.createHash('sha256').update(fs.readFileSync(migrationFile)).digest('hex') !== input.observedMigration.sha256) {
    throw new Error('Applied migration checksum does not match the source file');
  }
  if (input.health?.buildCommit !== input.buildCommit) throw new Error('Core runtime build commit differs from deployed checkout');
  if (!['healthy', 'degraded'].includes(input.health?.status)) throw new Error('Core health is unavailable or unhealthy');
  if (input.expectedConfigurationRevision !== undefined) {
    const expected = input.expectedConfigurationRevision;
    if (!/^[a-f0-9]{64}$/.test(expected) || input.health?.configurationRevision !== expected ||
        input.workerHealth?.configurationRevision !== expected || input.workerHealth?.buildCommit !== input.buildCommit ||
        !['healthy','degraded'].includes(input.workerHealth?.status)) {
      throw new Error('Core/worker runtime configuration differs from the canonical deployed configuration');
    }
  }
  const flags = input.health?.flags;
  if (!flags || !['on', 'off'].includes(flags.DESIGN_PIPELINE_V3) || !['on', 'off'].includes(flags.DESIGN_STUDIO_V2)) {
    throw new Error('Runtime design flags are unknown');
  }
  const models = input.health?.models;
  const imageModel = models?.image?.model;
  for (const role of ['text', 'layout', 'critique', 'judge']) {
    if (typeof models?.[role] !== 'string' || !models[role]) throw new Error(`Runtime ${role} model is unknown`);
  }
  if (typeof imageModel !== 'string' || !imageModel || typeof models?.tier !== 'string') {
    throw new Error('Runtime image model or tier is unknown');
  }
  const images = {} as DeploymentReceipt['images'];
  for (const service of ['core', 'desk', 'worker'] as const) {
    const matching = input.observations.filter((o) => o.service === service);
    if (matching.length !== 1) throw new Error(`Expected exactly one inspected ${service} image`);
    const observed = matching[0];
    if (!imageIdPattern.test(observed.imageId) || observed.revisionLabel !== input.buildCommit || !observed.container || !observed.imageRef) {
      throw new Error(`${service} image identity or revision does not match checkout`);
    }
    images[service] = observed;
  }
  return {
    receiptVersion: 1,
    evidenceKind: 'observed_deployment',
    status: 'image_runtime_migration_verified',
    observedAt: input.observedAt || new Date().toISOString(),
    buildCommit: input.buildCommit,
    sourceCandidateCommit: input.manifest.build.commit,
    sourceManifestSha256: crypto.createHash('sha256').update(input.manifestBytes).digest('hex'),
    workerColour: input.workerColour,
    images,
    runtime: {
      healthStatus: input.health.status,
      ...(input.expectedConfigurationRevision ? {configurationRevision:input.expectedConfigurationRevision} : {}),
      postgres: String(input.health?.dependencies?.postgres || 'unknown'),
      flags: { DESIGN_PIPELINE_V3: flags.DESIGN_PIPELINE_V3, DESIGN_STUDIO_V2: flags.DESIGN_STUDIO_V2 },
      modelTier: models.tier,
      models: { text: models.text, layout: models.layout, critique: models.critique, judge: models.judge, image: imageModel },
    },
    migration: { declaredTarget: input.manifest.migrations.targetVersion, observedApplied: input.observedMigration },
  };
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function inspectImage(service: ImageObservation['service'], container: string): ImageObservation {
  const imageId = docker(['inspect', '--format', '{{.Image}}', container]);
  if (!imageIdPattern.test(imageId)) throw new Error(`${container} has no immutable image ID`);
  return {
    service,
    container,
    imageRef: docker(['inspect', '--format', '{{.Config.Image}}', container]),
    imageId,
    revisionLabel: docker(['image', 'inspect', '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}', imageId]),
  };
}

export function main(args = process.argv.slice(2)): void {
  const [commit, colour, output, migrationName, migrationSha256] = args;
  if (!commitPattern.test(commit || '') || (colour !== 'blue' && colour !== 'green') || !output || !migrationName || !migrationSha256) {
    throw new Error('Usage: record_deployment_receipt.ts <checkout-commit> <blue|green> <output-file> <applied-migration-name> <applied-migration-sha256> (Core health JSON on stdin)');
  }
  const manifestBytes = fs.readFileSync(path.join(root, 'RELEASE_MANIFEST.json'));
  const receipt = buildDeploymentReceipt({
    buildCommit: commit,
    workerColour: colour,
    manifest: JSON.parse(manifestBytes.toString('utf8')),
    manifestBytes,
    observations: [
      inspectImage('core', 'hawa-production-core-1'),
      inspectImage('desk', 'hawa-production-desk-1'),
      inspectImage('worker', `hawa-production-worker-${colour}-1`),
    ],
    health: JSON.parse(fs.readFileSync(0, 'utf8')),
    expectedConfigurationRevision: crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'infra/docker/.env.production'))).digest('hex'),
    workerHealth: JSON.parse(docker(['exec', `hawa-production-worker-${colour}-1`, 'node', '-e',
      "fetch('http://localhost:9080/health').then(r=>r.json()).then(d=>console.log(JSON.stringify(d))).catch(()=>process.exit(1))"])),
    observedMigration: { name: migrationName, sha256: migrationSha256 },
  });
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(output, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  console.log(`Observed image/runtime/migration receipt: ${output}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
