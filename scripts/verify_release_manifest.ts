import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
