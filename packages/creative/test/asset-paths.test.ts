import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { creativeAssetPath } from '../src/studio/asset-paths.js';

/**
 * The production image runs the core process with cwd /app/apps/core, where none of the old
 * cwd-relative candidates for the reference pack existed. Every test here moves cwd away from the
 * repository root so that only resolution from the module's own location can succeed.
 */
const awayFromRepoRoot = () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'hawa-asset-cwd-'));
  vi.spyOn(process, 'cwd').mockReturnValue(elsewhere);
  return elsewhere;
};

describe('creativeAssetPath', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves the client's reference pack when cwd is not the repository root", () => {
    awayFromRepoRoot();
    const refPath = creativeAssetPath('kaae-reference.json');
    expect(existsSync(refPath)).toBe(true);
    expect(refPath.endsWith('packages/creative/assets/kaae-reference.json')).toBe(true);
  });

  it('resolves an exemplar image when cwd is not the repository root', () => {
    awayFromRepoRoot();
    const exemplar = creativeAssetPath('exemplars/post1_accreditation_mandate.png');
    expect(existsSync(exemplar)).toBe(true);
  });

  it('names every path it tried when the asset is missing', () => {
    const elsewhere = awayFromRepoRoot();
    let thrown: Error | undefined;
    try {
      creativeAssetPath('no-such-reference.json');
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).toContain('no-such-reference.json');
    expect(thrown?.message).toContain('packages/creative/assets');
    expect(thrown?.message).toContain(elsewhere);
  });

  it('returns undefined for an optional asset that is absent', () => {
    awayFromRepoRoot();
    expect(creativeAssetPath('exemplars/not-a-file.png', { optional: true })).toBeUndefined();
  });

  it('places the assets at the same depth below src/studio and dist/studio', () => {
    // The helper resolves '../../assets' from its own directory. That serves both the repository
    // and the image only because tsc mirrors src into dist with the same layout. The compiled
    // half is exercised for real by apps/core/test/studio-asset-resolution.test.ts, where
    // @hawa/creative is loaded from packages/creative/dist/index.js.
    const packageRoot = resolve(import.meta.dirname, '..');
    const assets = resolve(packageRoot, 'assets');
    expect(relative(resolve(packageRoot, 'src/studio'), assets)).toBe(
      relative(resolve(packageRoot, 'dist/studio'), assets)
    );
  });
});
