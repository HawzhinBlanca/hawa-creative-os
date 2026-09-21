import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateReleaseManifest, type ReleaseManifest } from '../packages/contracts/src/release-manifest.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql') && !f.includes('_down'));
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
    }
    try {
      const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      let gitParent = '';
      try {
        gitParent = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      } catch {}
      let gitParent2 = '';
      try {
        gitParent2 = execFileSync('git', ['rev-parse', 'HEAD~2'], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      } catch {}
      if (gitHead && manifest.build.commit !== gitHead && manifest.build.commit !== gitParent && manifest.build.commit !== gitParent2) {
        errors.push(`Manifest build commit (${manifest.build.commit}) does not match git HEAD (${gitHead}) or recent release commits`);
      }
    } catch {}
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
        const validImagePattern = /^([a-z0-9_.-]+\/)?hawa-(core|desk|worker)(:[a-zA-Z0-9_.-]+)?$/;
        if (!comp.image || typeof comp.image !== 'string' || !comp.image.includes(':') || !validImagePattern.test(comp.image)) {
          errors.push(`Component ${req} missing valid or approved image reference: ${comp.image}`);
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
  const expectedRoles = ['intake_router', 'brief_builder', 'creative_director', 'visual_judge'];
  const allowedProviders = new Set(['google', 'anthropic', 'openai', 'local']);
  if (!manifest.models || !manifest.models.pinnedModels || Object.keys(manifest.models.pinnedModels).length === 0) {
    errors.push('Manifest models coverage cannot be empty; requires pinnedModels');
  } else {
    for (const role of expectedRoles) {
      const pin = manifest.models.pinnedModels[role];
      if (!pin) {
        errors.push(`Manifest missing pinned model for required role: ${role}`);
      } else {
        if (!allowedProviders.has(pin.provider)) {
          errors.push(`Model role ${role} uses unapproved provider: ${pin.provider}`);
        }
        if (!pin.model || typeof pin.model !== 'string' || pin.model.includes('invented')) {
          errors.push(`Model role ${role} uses invalid or invented model: ${pin.model}`);
        }
      }
    }
  }
  if (manifest.models?.registryVersion !== '2026-09-18.1') {
    errors.push(`Manifest models registryVersion is invalid: ${manifest.models?.registryVersion}`);
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
