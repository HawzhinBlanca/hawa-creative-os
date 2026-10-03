import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateReleaseManifest, type ReleaseManifest } from '../packages/contracts/src/release-manifest.js';
import { PRODUCTION_MODELS } from '../packages/domain/src/provider-policy.js';
import { PROMPT_VERSION } from '../apps/core/src/services/design-studio/prompts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The manifest certifies the tree of its build commit. HEAD may be that commit or any descendant
 * whose only changes since are the manifest files themselves: the "record manifest" commit, or a
 * merge commit that brought both in. Until studio-v2 c2bf4943 (2026-09-27) this required the build
 * commit to be HEAD, HEAD~1 or HEAD~2, which every merge commit failed and a code commit two back
 * passed.
 */
const MANIFEST_FILES = new Set(['MANIFEST.json', 'RELEASE_MANIFEST.json', 'SHA256SUMS.txt']);
export function buildCommitErrors(commit: string, cwd: string): string[] {
  const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  try {
    git(['merge-base', '--is-ancestor', commit, 'HEAD']);
  } catch {
    return [`Manifest build commit (${commit}) is not an ancestor of HEAD`];
  }
  const changed = git(['diff', '--name-only', commit, 'HEAD']).split('\n').filter(Boolean);
  const drift = changed.filter((file) => !MANIFEST_FILES.has(file));
  return drift.length > 0
    ? [`${drift.length} file(s) changed since the manifest build commit (${commit}), e.g. ${drift.slice(0, 5).join(', ')}; record a new manifest`]
    : [];
}

export function verifyReleaseManifest(manifestPath?: string): { ok: boolean; errors: string[] } {
  const filePath = manifestPath || path.join(root, 'RELEASE_MANIFEST.json');
  const errors: string[] = [];

  if (!fs.existsSync(filePath)) {
    return { ok: false, errors: [`Release manifest not found at: ${filePath}`] };
  }

  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err: any) {
    return { ok: false, errors: [`Failed to parse release manifest JSON: ${err.message}`] };
  }

  const validation = validateReleaseManifest(raw);
  if (!validation.ok) {
    errors.push(`Validation error: ${validation.error}`);
  }

  const manifest = raw as ReleaseManifest;

  // 1. Check SHA-256 integrity
  const expectedSha256 = manifest.sha256;
  const clone = { ...manifest };
  delete clone.sha256;
  const actualSha256 = crypto.createHash('sha256').update(JSON.stringify(clone, null, 2)).digest('hex');

  if (expectedSha256 !== actualSha256) {
    errors.push(`Manifest SHA-256 checksum mismatch: declared ${expectedSha256}, calculated ${actualSha256}`);
  }

  // 2. Canonical topology check
  if (manifest.topology?.canonical !== 'infra/docker/docker-compose.prod.yml') {
    errors.push(`Non-canonical topology in manifest: ${manifest.topology?.canonical}`);
  }

  // 3. Flags check: must remain 'off' until qualification gates pass
  if (manifest.flags?.DESIGN_PIPELINE_V3 !== 'off') {
    errors.push(`DESIGN_PIPELINE_V3 flag must be 'off' (observed '${manifest.flags?.DESIGN_PIPELINE_V3}')`);
  }
  if (manifest.flags?.DESIGN_STUDIO_V2 !== 'off') {
    errors.push(`DESIGN_STUDIO_V2 flag must be 'off' (observed '${manifest.flags?.DESIGN_STUDIO_V2}')`);
  }

  // 4. Source file hash verification for declared components
  for (const [componentName, component] of Object.entries(manifest.components || {})) {
    for (const [relPath, declaredHash] of Object.entries(component.sourceFileHashes || {})) {
      const fullPath = path.join(root, relPath);
      if (!fs.existsSync(fullPath)) {
        errors.push(`Component '${componentName}' referenced missing source file: ${relPath}`);
        continue;
      }
      const actualHash = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
      if (actualHash !== declaredHash) {
        errors.push(`File hash mismatch for ${relPath} (${componentName}): declared ${declaredHash}, actual ${actualHash}`);
      }
    }
  }

  // 5. Database migrations check
  const migrationsDir = path.join(root, 'packages/db/migrations');
  if (fs.existsSync(migrationsDir)) {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'));
    files.sort();
    const currentLatest = files[files.length - 1]?.replace('.sql', '');
    if (currentLatest && manifest.migrations.targetVersion !== currentLatest) {
      errors.push(`Migration targetVersion mismatch: manifest has ${manifest.migrations.targetVersion}, disk has ${currentLatest}`);
    }
  }

  // 6. Build identity and cleanliness checks
  if (!manifest.build?.commit || typeof manifest.build.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(manifest.build.commit)) {
    errors.push(`Manifest build commit is invalid or missing: ${manifest.build?.commit}`);
  } else {
    let commitExists = false;
    try {
      execFileSync('git', ['cat-file', '-e', manifest.build.commit], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
      commitExists = true;
    } catch {}

    if (!commitExists) {
      errors.push(`Manifest build commit (${manifest.build.commit}) does not exist in git repository`);
    } else {
      errors.push(...buildCommitErrors(manifest.build.commit, root));
    }
  }

  let isActuallyClean = false;
  try {
    const gitStatus = execSync('git status --porcelain', { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    isActuallyClean = gitStatus.length === 0;
  } catch {}

  if (manifest.build?.treeClean !== true) {
    errors.push(`Manifest requires a clean tree (manifest declared treeClean: ${manifest.build?.treeClean})`);
  }
  if (!isActuallyClean && !process.env.VITEST) {
    errors.push('Working tree has uncommitted modifications; cannot certify clean release manifest');
  }

  // 7. Component coverage check
  const requiredComponents = ['core', 'desk', 'worker'];
  const components: Record<string, any> = manifest.components || {};
  const compKeys = Object.keys(components);
  if (compKeys.length === 0) {
    errors.push('Manifest components cannot be empty; requires component coverage');
  } else {
    for (const req of requiredComponents) {
      if (!compKeys.includes(req)) {
        errors.push(`Manifest missing required component: ${req}`);
      } else {
        const comp = components[req];
        if (comp.imageStatus !== 'unbuilt' || 'image' in comp || 'digest' in comp) {
          errors.push(`Component ${req} falsely claims an image identity in a source candidate`);
        }
        const fileHashes = comp.sourceFileHashes || {};
        const sourcePaths = Object.keys(fileHashes);
        if (sourcePaths.length === 0) {
          errors.push(`Component ${req} has no source file hashes`);
        } else {
          const hasAppSource = sourcePaths.some((p) => p.startsWith(`apps/${req}/`) || p.startsWith(`packages/`));
          const isReadmeOnly = sourcePaths.every((p) => p.endsWith('.md') || p.endsWith('README.md'));
          if (!hasAppSource || isReadmeOnly) {
            errors.push(`Component ${req} has insufficient source coverage (cannot rely solely on README or external files)`);
          }
        }
      }
    }
  }

  // 8. Model coverage check
  if (!manifest.models || !manifest.models.productionDefaults || Object.keys(manifest.models.productionDefaults).length === 0) {
    errors.push('Manifest models coverage cannot be empty; requires productionDefaults');
  } else {
    for (const [role, model] of Object.entries(PRODUCTION_MODELS)) {
      if (manifest.models.productionDefaults[role as keyof typeof PRODUCTION_MODELS] !== model) {
        errors.push(`Source model default for ${role} differs from provider policy`);
      }
    }
    if (manifest.models.runtimeOverrides !== 'unobserved') {
      errors.push('Runtime model overrides cannot be declared by a source candidate');
    }
  }
  const policySource = 'packages/domain/src/provider-policy.ts';
  if (manifest.models?.policySourceSha256 !== crypto.createHash('sha256').update(fs.readFileSync(path.join(root, policySource))).digest('hex')) {
    errors.push('Model policy source hash mismatch');
  }
  if (manifest.models?.promptVersion !== PROMPT_VERSION) {
    errors.push('Prompt version differs from source');
  }
  const requiredPromptSources = [
    'apps/core/src/services/design-studio/prompts.ts',
    'apps/core/src/services/canva-design-planner.ts',
    'packages/creative/src/studio/layout-generator-v3.ts',
    'packages/creative/src/studio/pairwise-judge-v3.ts',
    'packages/creative/src/studio/box-critique-v3.ts',
  ];
  for (const source of requiredPromptSources) {
    const declared = manifest.models?.promptSourcesSha256?.[source];
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, source))).digest('hex');
    if (!declared || declared !== actual) errors.push(`Prompt source hash mismatch for ${source}`);
  }

  if (manifest.qa?.versionStatus !== 'unobserved') errors.push('QA runtime version cannot be declared by a source candidate');
  for (const source of [
    'packages/qa/src/engine.ts',
    'packages/qa/src/vision-rubric.ts',
    'packages/qa/src/canva-pptx-check.ts',
    'packages/qa/src/rtl-validator.ts',
    'packages/qa/src/contrast.ts',
    'packages/qa/src/copy-validator.ts',
  ]) {
    const declared = manifest.qa?.sourceHashes?.[source];
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, source))).digest('hex');
    if (!declared || declared !== actual) errors.push(`QA source hash mismatch for ${source}`);
  }

  return { ok: errors.length === 0, errors };
}

export function main() {
  const manifestPath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  console.log(`Verifying release manifest...`);
  const result = verifyReleaseManifest(manifestPath);

  if (!result.ok) {
    console.error(`RELEASE MANIFEST VERIFICATION FAILED:`);
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(`RELEASE MANIFEST VERIFIED: All topology, build, hash, migration, and flag invariants pass.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
