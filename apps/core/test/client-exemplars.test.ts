import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { creativeAssetPath } from '@hawa/creative';
import { clientExemplarManifestOf } from '../src/services/client-packs.js';

/**
 * A design is conditioned on its own client's confirmed exemplars (ADR-127, ported from studio-v2's
 * 24a787cd). The pack names the manifest; Core still reads it only where ADR-115 admits exemplar
 * conditioning (KAAE's packaged reference). studio-v2's planner-palette half is this branch's
 * buildPlannerSystemPrompt/correctPlannerPalette, tested in canva-design-planner.test.ts.
 */
const KAAE_ID = 'c1000000-0000-4000-8000-000000000002';
const ZAR_ID = 'c1000000-0000-4000-8000-000000000011';

describe("the exemplars a client's designs are shown", () => {
  it("are KAAE's own manifest for KAAE, the file its policy hash already covered", () => {
    const path = clientExemplarManifestOf(KAAE_ID)!;
    expect(path).toBe(creativeAssetPath('kaae-exemplars.json'));
    expect(JSON.parse(readFileSync(path, 'utf8')).exemplars.length).toBeGreaterThan(0);
  });

  it("are none, never KAAE's, for a client with no confirmed set or no pack", () => {
    expect(clientExemplarManifestOf(ZAR_ID)).toBeUndefined();
    expect(clientExemplarManifestOf('c1000000-0000-4000-8000-00000000ffff')).toBeUndefined();
    expect(clientExemplarManifestOf(null)).toBeUndefined();
  });

  it('are not named in the studio or planner code any more', () => {
    for (const file of ['../src/services/design-studio/design-studio-service.ts', '../src/services/canva-design-planner.ts']) {
      const code = readFileSync(new URL(file, import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      expect(code, file).not.toContain("'kaae-exemplars.json'");
    }
  });
});
