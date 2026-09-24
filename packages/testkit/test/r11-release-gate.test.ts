import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { verifyReleaseManifest } from '../../../scripts/verify_release_manifest.js';

describe('Task R11: Master Release Gate Reproducibility & Refusal Controls (FR-074, NFR-012, NFR-013, NFR-024, NFR-025)', () => {
  const root = path.resolve(__dirname, '../../..');

  it('1. Release manifest passes cryptographic verification and canonical topology check', () => {
    const res = verifyReleaseManifest();
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('2. Refusal Control: Fails closed when manifest flag is tampered with', () => {
    const tempManifest = path.join(root, 'RELEASE_MANIFEST.tampered.json');
    const original = JSON.parse(fs.readFileSync(path.join(root, 'RELEASE_MANIFEST.json'), 'utf8'));

    try {
      const tampered = { ...original, flags: { ...original.flags, DESIGN_PIPELINE_V3: 'on' } };
      fs.writeFileSync(tempManifest, JSON.stringify(tampered, null, 2));

      const res = verifyReleaseManifest(tempManifest);
      expect(res.ok).toBe(false);
      expect(res.errors.some((e) => e.includes("DESIGN_PIPELINE_V3 flag must be 'off'"))).toBe(true);
    } finally {
      if (fs.existsSync(tempManifest)) fs.unlinkSync(tempManifest);
    }
  });

  it('3. Refusal Control: Fails closed when component file hash mismatch occurs', () => {
    const tempManifest = path.join(root, 'RELEASE_MANIFEST.tampered_hash.json');
    const original = JSON.parse(fs.readFileSync(path.join(root, 'RELEASE_MANIFEST.json'), 'utf8'));

    try {
      const tampered = {
        ...original,
        components: {
          ...original.components,
          core: {
            ...original.components.core,
            sourceFileHashes: {
              ...original.components.core.sourceFileHashes,
              'apps/core/src/app.ts': '0000000000000000000000000000000000000000000000000000000000000000',
            },
          },
        },
      };
      fs.writeFileSync(tempManifest, JSON.stringify(tampered, null, 2));

      const res = verifyReleaseManifest(tempManifest);
      expect(res.ok).toBe(false);
      expect(res.errors.some((e) => e.includes('File hash mismatch'))).toBe(true);
    } finally {
      if (fs.existsSync(tempManifest)) fs.unlinkSync(tempManifest);
    }
  });

  it('rejects a self-consistent source manifest that invents an image or model choice', () => {
    const tempManifest = path.join(root, 'RELEASE_MANIFEST.synthetic-claim.json');
    const original = JSON.parse(fs.readFileSync(path.join(root, 'RELEASE_MANIFEST.json'), 'utf8'));
    try {
      for (const mutate of [
        (m: any) => { m.components.core.image = 'hawa-core:latest'; },
        (m: any) => { m.models.productionDefaults.layout = 'invented-model'; },
        (m: any) => { m.qa.versionStatus = 'qualified'; },
      ]) {
        const synthetic = structuredClone(original);
        mutate(synthetic);
        delete synthetic.sha256;
        synthetic.sha256 = crypto.createHash('sha256').update(JSON.stringify(synthetic, null, 2)).digest('hex');
        fs.writeFileSync(tempManifest, JSON.stringify(synthetic, null, 2));
        const result = verifyReleaseManifest(tempManifest);
        expect(result.ok).toBe(false);
      }
    } finally {
      if (fs.existsSync(tempManifest)) fs.unlinkSync(tempManifest);
    }
  });

  it('4. Production Isolation Guard: Proves test environment cannot touch production database', () => {
    const testDb = process.env.TEST_DATABASE_URL || '';
    expect(testDb).not.toContain(':54332'); // Must never target live production port
    expect(testDb).toContain(':55432');     // Must target isolated test container
  });

  it('5. Enforces release gate shell script refusal drill', () => {
    const output = execSync(`${path.join(root, 'scripts/enforce_release_gate.sh')} --test-refusal`, {
      cwd: root,
      encoding: 'utf8',
    });
    expect(output).toContain('[REFUSAL DRILL PASSED]');
    expect(output).toContain('non-bypassable admission proven');
  });
});
