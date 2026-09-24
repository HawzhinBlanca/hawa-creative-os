import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ReleaseManifest } from '../packages/contracts/src/release-manifest.js';
import { PRODUCTION_MODELS } from '../packages/domain/src/provider-policy.js';
import { PROMPT_VERSION } from '../apps/core/src/services/design-studio/prompts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch (err: any) {
    return '';
  }
}

function hashFile(relPath: string): string {
  const fullPath = path.join(root, relPath);
  if (!fs.existsSync(fullPath)) return '';
  return crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
}

export function generateReleaseManifest(): ReleaseManifest {
  const commit = git(['rev-parse', 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const commitTimestamp = git(['log', '-1', '--format=%cI']);
  const statusPorcelain = git(['status', '--porcelain']);

  const uncommittedFiles = statusPorcelain
    ? statusPorcelain
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.endsWith('RELEASE_MANIFEST.json') && !line.endsWith('MANIFEST.json') && !line.endsWith('SHA256SUMS.txt'))
    : [];

  const migrationsDir = path.join(root, 'packages/db/migrations');
  const migrationFiles = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql') && !f.includes('_down'))
    : [];
  migrationFiles.sort();
  const latestMigrationFile = migrationFiles[migrationFiles.length - 1] || 'none';
  const targetVersion = latestMigrationFile.replace('.sql', '');

  const manifest: Omit<ReleaseManifest, 'sha256'> = {
    manifestVersion: '2.0.0',
    evidenceKind: 'source_candidate',
    // The commit timestamp makes the source candidate reproducible for the same checkout.
    generatedAt: commitTimestamp,
    targetEnvironment: 'production',
    topology: {
      canonical: 'infra/docker/docker-compose.prod.yml',
      description: 'Canonical production multi-service container topology (Core, Desk UI, Worker, PostgreSQL, Nginx)',
      activeLanes: [
        'canva-first',
        'core-api',
        'desk-ui',
        'durable-worker',
        'postgres',
        'nginx',
      ],
      retiredLanes: [
        'legacy-hycanvas (ADR 025: retired with 410 Gone responses)',
        'dormant-single-container (deployment/docker-compose.yml: archived alternative)',
      ],
    },
    build: {
      commit,
      treeClean: uncommittedFiles.length === 0,
      commitTimestamp,
      branch,
    },
    migrations: {
      targetVersion,
      latestMigrationFile,
      totalMigrations: migrationFiles.length,
    },
    flags: {
      DESIGN_PIPELINE_V3: 'off',
      DESIGN_STUDIO_V2: 'off',
    },
    components: {
      core: {
        service: 'core',
        imageStatus: 'unbuilt',
        sourceFileHashes: {
          'apps/core/src/app.ts': hashFile('apps/core/src/app.ts'),
          'apps/core/src/index.ts': hashFile('apps/core/src/index.ts'),
          'packages/integrations/src/google-publisher.ts': hashFile('packages/integrations/src/google-publisher.ts'),
        },
      },
      desk: {
        service: 'desk',
        imageStatus: 'unbuilt',
        sourceFileHashes: {
          'apps/desk/src/App.tsx': hashFile('apps/desk/src/App.tsx'),
          'apps/desk/src/main.tsx': hashFile('apps/desk/src/main.tsx'),
        },
      },
      worker: {
        service: 'worker',
        imageStatus: 'unbuilt',
        sourceFileHashes: {
          'apps/worker/src/index.ts': hashFile('apps/worker/src/index.ts'),
        },
      },
    },
    models: {
      policySourceSha256: hashFile('packages/domain/src/provider-policy.ts'),
      productionDefaults: { ...PRODUCTION_MODELS },
      runtimeOverrides: 'unobserved',
      promptVersion: PROMPT_VERSION,
      promptSourcesSha256: Object.fromEntries([
        'apps/core/src/services/design-studio/prompts.ts',
        'apps/core/src/services/canva-design-planner.ts',
        'packages/creative/src/studio/layout-generator-v3.ts',
        'packages/creative/src/studio/pairwise-judge-v3.ts',
        'packages/creative/src/studio/box-critique-v3.ts',
      ].map((source) => [source, hashFile(source)])),
    },
    qa: {
      versionStatus: 'unobserved',
      sourceHashes: Object.fromEntries([
        'packages/qa/src/engine.ts',
        'packages/qa/src/vision-rubric.ts',
        'packages/qa/src/canva-pptx-check.ts',
        'packages/qa/src/rtl-validator.ts',
        'packages/qa/src/contrast.ts',
        'packages/qa/src/copy-validator.ts',
      ].map((source) => [source, hashFile(source)])),
    },
  };

  const serialized = JSON.stringify(manifest, null, 2);
  const sha256 = crypto.createHash('sha256').update(serialized).digest('hex');

  const fullManifest: ReleaseManifest = {
    ...(manifest as any),
    sha256,
  };

  return fullManifest;
}

export function main() {
  const manifest = generateReleaseManifest();
  const outputPath = path.join(root, 'RELEASE_MANIFEST.json');
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`Generated release manifest at ${outputPath} (sha256: ${manifest.sha256})`);
  console.log(`Commit: ${manifest.build.commit} (Clean: ${manifest.build.treeClean})`);
  console.log(`Topology: ${manifest.topology.canonical}`);
  console.log(`Flags: DESIGN_PIPELINE_V3=${manifest.flags.DESIGN_PIPELINE_V3}, DESIGN_STUDIO_V2=${manifest.flags.DESIGN_STUDIO_V2}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
