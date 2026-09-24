import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildDeploymentReceipt, type ImageObservation } from '../../../scripts/record_deployment_receipt.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationDir = path.join(root, 'packages/db/migrations');
const migrationName = fs.readdirSync(migrationDir).filter((name) => /^\d{3}_.+\.sql$/.test(name) && !name.includes('_down')).sort().at(-1)!;
const migrationSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(migrationDir, migrationName))).digest('hex');
const commit = 'a'.repeat(40);
const images: ImageObservation[] = (['core', 'desk', 'worker'] as const).map((service, i) => ({
  service,
  container: `hawa-production-${service}-1`,
  imageRef: `hawa-${service}:mutable-tag`,
  imageId: `sha256:${String(i + 1).repeat(64)}`,
  revisionLabel: commit,
}));
const manifest = { build: { commit: 'b'.repeat(40) }, migrations: { targetVersion: migrationName.slice(0, -4) } };
const health = {
  status: 'degraded',
  buildCommit: commit,
  flags: { DESIGN_PIPELINE_V3: 'off', DESIGN_STUDIO_V2: 'off' },
  dependencies: { postgres: 'connected' },
  models: {
    tier: 'production', text: 'text-real', layout: 'layout-real', critique: 'critique-real',
    judge: 'judge-real', image: { model: 'image-real', key: 'present', secret: 'never-copy-me' },
  },
  lastPaidProbe: { detail: { message: 'never-copy-provider-details' } },
};

const build = (changes: Record<string, unknown> = {}) => buildDeploymentReceipt({
  buildCommit: commit,
  manifest,
  manifestBytes: Buffer.from(JSON.stringify(manifest)),
  workerColour: 'blue',
  observations: images,
  health,
  observedMigration: { name: migrationName, sha256: migrationSha256 },
  observedAt: '2026-09-25T00:00:00.000Z',
  ...changes,
});

describe('observed deployment receipt', () => {
  it('records immutable inspected IDs, effective non-secret runtime choices, and applied migration hash', () => {
    const receipt = build();
    expect(receipt.images.core.imageId).toBe(images[0].imageId);
    expect(receipt.runtime.models.layout).toBe('layout-real');
    expect(receipt.status).toBe('image_runtime_migration_verified');
    expect(receipt.migration.observedApplied).toEqual({ name: migrationName, sha256: migrationSha256 });
    expect(JSON.stringify(receipt)).not.toContain('never-copy');
  });

  it('refuses a tag that points to the wrong image revision or lacks an immutable ID', () => {
    expect(() => build({ observations: images.map((i) => i.service === 'core' ? { ...i, revisionLabel: 'c'.repeat(40) } : i) }))
      .toThrow(/core image identity/);
    expect(() => build({ observations: images.map((i) => i.service === 'worker' ? { ...i, imageId: 'hawa-worker:latest' } : i) }))
      .toThrow(/worker image identity/);
  });

  it('refuses a mismatched Core build stamp and unknown flags or models', () => {
    expect(() => build({ health: { ...health, buildCommit: 'c'.repeat(40) } })).toThrow(/Core runtime build commit/);
    expect(() => build({ health: { ...health, flags: {} } })).toThrow(/flags are unknown/);
    expect(() => build({ health: { ...health, models: { ...health.models, layout: null } } })).toThrow(/layout model is unknown/);
  });

  it('refuses an unapplied target or a database checksum different from the source migration', () => {
    expect(() => build({ observedMigration: { name: '000_wrong.sql', sha256: migrationSha256 } }))
      .toThrow(/Applied migration does not match/);
    expect(() => build({ observedMigration: { name: migrationName, sha256: '0'.repeat(64) } }))
      .toThrow(/checksum does not match/);
  });
});
