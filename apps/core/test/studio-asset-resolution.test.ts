import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';

/**
 * The production image runs core with cwd /app/apps/core and the compiled service at
 * /app/apps/core/dist/services/design-studio, while the client's assets sit at
 * /app/packages/creative/assets. Every cwd-relative and apps/core-relative candidate missed, so
 * the stage context briefed every design with the placeholder rule and no exemplars. These tests
 * move cwd away from the repository root to reproduce that, leaving resolution from the module's
 * own location as the only way through.
 */
const hidden = vi.hoisted(() => ({ referencePack: false }));

vi.mock('@hawa/creative', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hawa/creative')>();
  return {
    ...actual,
    creativeAssetPath: (relativePath: string, options?: { optional?: boolean }) => {
      if (hidden.referencePack && relativePath.includes('kaae-reference.json')) {
        throw new Error(
          `Creative asset not found: ${relativePath}. Tried:\n  /app/apps/core/packages/creative/assets/${relativePath}`
        );
      }
      return (actual as any).creativeAssetPath(relativePath, options);
    },
  };
});

const scope = { tenantId: randomUUID(), actorId: randomUUID() };

const studioRun = () => ({
  id: randomUUID(),
  task_id: randomUUID(),
  client_id: 'c1000000-0000-4000-8000-000000000002',
  tier: 'standard',
  status: 'brief',
  stages: '{}',
  request: JSON.stringify({
    width: 1080,
    height: 1350,
    instructions: 'KAAE accreditation ceremony invitation',
    copyBlocks: [{ text: 'KAAE Accreditation Ceremony', script: 'latin' }],
    logoAspect: 1,
  }),
});

const stageContext = () => {
  const service = new DesignStudioService({} as any);
  return (service as any).createStageContext(
    scope,
    studioRun(),
    'brief',
    { maxUsd: 1, maxCalls: 4, spentUsd: 0, calls: 0 },
    async () => {}
  );
};

const awayFromRepoRoot = () => {
  vi.spyOn(process, 'cwd').mockReturnValue(mkdtempSync(join(tmpdir(), 'hawa-studio-cwd-')));
};

describe('design studio asset resolution', () => {
  afterEach(() => {
    hidden.referencePack = false;
    vi.restoreAllMocks();
  });

  it("briefs with the client's own colour rules when cwd is not the repository root", () => {
    awayFromRepoRoot();
    const ctx = stageContext();
    expect(ctx.promotedRules.startsWith('For dark institutional invitations')).toBe(true);
    expect(ctx.promotedRules).not.toContain('Keep title clear and centered');
    expect(ctx.latinFont).toBe('Verdana');
    expect(ctx.arabicFont).toBe('Noto Sans Arabic');
    expect(ctx.referencePack.palette).toContain('#F7B500');
  });

  it('conditions the layout model on exemplar images when cwd is not the repository root', () => {
    awayFromRepoRoot();
    const ctx = stageContext();
    expect(ctx.exemplars.length).toBeGreaterThan(0);
    for (const exemplar of ctx.exemplars) {
      expect(exemplar.bytes?.length).toBeGreaterThan(0);
    }
  });

  it('stops the run when the reference pack cannot be read, naming the paths tried', () => {
    awayFromRepoRoot();
    hidden.referencePack = true;
    let thrown: any;
    try {
      stageContext();
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'a missing reference pack must not fall back to the placeholder rule').toBeDefined();
    expect(String(thrown?.message)).toContain('kaae-reference.json');
    expect(String(thrown?.message)).toContain('/app/apps/core/packages/creative/assets');
  });
});
