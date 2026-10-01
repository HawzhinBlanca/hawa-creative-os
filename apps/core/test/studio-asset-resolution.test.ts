import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { resolveClientDesignReference } from '../src/services/client-design-reference.js';

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

const stageContext = async () => {
  const service = new DesignStudioService({} as any);
  const run = studioRun();
  const { reference, logo } = await resolveClientDesignReference({} as any, scope, run.client_id);
  run.request = JSON.stringify({ ...JSON.parse(run.request), clientId: run.client_id,
    referenceHash: createHash('sha256').update(JSON.stringify(reference)).digest('hex'),
    logoSha256: createHash('sha256').update(logo).digest('hex') });
  return await (service as any).createStageContext(
    scope,
    run,
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

  it("briefs with the client's own colour rules when cwd is not the repository root", async () => {
    awayFromRepoRoot();
    const ctx = await stageContext();
    expect(ctx.promotedRules.startsWith('KAAE Brand Guidelines, Excellence Edition (2025), light first.')).toBe(true);
    expect(ctx.promotedRules).not.toContain('Keep title clear and centered');
    expect(ctx.latinFont).toBe('Inter');
    expect(ctx.arabicFont).toBe('Noto Sans Arabic');
    expect(ctx.referencePack.palette).toContain('#F7B500');
  });

  it('conditions the layout model on exemplar images when cwd is not the repository root', async () => {
    awayFromRepoRoot();
    const ctx = await stageContext();
    expect(ctx.exemplars.length).toBeGreaterThan(0);
    for (const exemplar of ctx.exemplars) {
      expect(exemplar.bytes?.length).toBeGreaterThan(0);
    }
  });

  it('stops the run when the reference pack cannot be read, naming the paths tried', async () => {
    awayFromRepoRoot();
    hidden.referencePack = true;
    let thrown: any;
    try {
      await stageContext();
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'a missing reference pack must not fall back to the placeholder rule').toBeDefined();
    expect(String(thrown?.message)).toContain('kaae-reference.json');
    expect(String(thrown?.message)).toContain('/app/apps/core/packages/creative/assets');
  });
});
