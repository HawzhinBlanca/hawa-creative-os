import { describe, it, expect } from 'vitest';
import { hardQaContextFor } from '../src/services/design-studio/stages/v3.stage.js';

/**
 * The video-thumbnail playbook reaches hard QA through the stage context (ADR-127, ported from
 * studio-v2's 1d07664b). studio-v2's other half of this test, the client's logo in the judge's
 * renders, is this branch's ADR-047/ADR-109 and is covered by their own tests.
 */
const base = {
  width: 1280,
  height: 720,
  copyBlocks: [{ text: 'Why cities flood', script: 'latin' as const }],
  latinFont: 'Inter',
  arabicFont: 'Noto Sans Arabic',
  referencePack: { palette: ['#101820', '#FFFFFF'] } as any,
  logoAspect: 1,
  photos: [],
};

describe('the stage context of a thumbnail client', () => {
  it('hands its playbook to hard QA, and none for a client without one', () => {
    expect(hardQaContextFor({ ...base, playbook: 'video-thumbnail' }).playbook).toBe('video-thumbnail');
    expect(hardQaContextFor(base)).not.toHaveProperty('playbook');
  });
});
