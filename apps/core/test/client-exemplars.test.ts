import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { creativeAssetPath } from '@hawa/creative';
import { clientExemplarsOf } from '../src/services/client-packs.js';
import { plannerPaletteRule } from '../src/services/canva-design-planner.js';

/**
 * ADR-038: a design is conditioned on its own client's exemplars and drawn in its own client's
 * palette. The studio and the Canva planner used to give every client KAAE's.
 */
const KAAE_ID = 'c1000000-0000-4000-8000-000000000002';
const ZAR_ID = 'c1000000-0000-4000-8000-000000000011';
const KAAE_COLOURS = /#0A1628|#1E3A5F|#4770A3|#F7B500|#FDF8F3/i;

describe("the exemplars a client's designs are shown", () => {
  it("are KAAE's for KAAE", () => {
    const set = clientExemplarsOf(KAAE_ID)!;
    expect(set.code).toBe('kaae');
    expect(set.index.getConfirmedExemplars().length).toBeGreaterThan(0);
  });

  it("are none, never KAAE's, for a client with no confirmed set", () => {
    expect(clientExemplarsOf(ZAR_ID)).toBeUndefined();
    expect(clientExemplarsOf('c1000000-0000-4000-8000-00000000ffff')).toBeUndefined();
  });
});

describe('the palette the Canva planner is told', () => {
  it("is the client's own", () => {
    const kaae = JSON.parse(readFileSync(creativeAssetPath('kaae-reference.json'), 'utf8'));
    expect(plannerPaletteRule(kaae)).toContain(kaae.rules.palette[0]);
    const other = plannerPaletteRule({ rules: { palette: ['#E10600', '#111111', '#FFFFFF'] } });
    expect(other).toContain('#E10600, #111111, #FFFFFF');
    expect(other).not.toMatch(KAAE_COLOURS);
  });

  it('is refused rather than borrowed when the reference names none', () => {
    expect(() => plannerPaletteRule({ rules: {} })).toThrow(/names no palette/);
  });

  it("is not written into the planner's code", () => {
    const code = readFileSync(new URL('../src/services/canva-design-planner.ts', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(KAAE_COLOURS);
  });
});
