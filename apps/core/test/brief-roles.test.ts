import { describe, it, expect, vi } from 'vitest';
import { runBriefStage, normalizeBriefRoles } from '../src/services/design-studio/stages/brief.stage.js';
import type { CreativeBrief } from '../src/services/design-studio/types.js';

const brief = (roles: CreativeBrief['roles'], readingOrder: number[] = roles.map((r) => r.copyIndex)): CreativeBrief => ({
  occasion: 'Launch of the National Standards',
  audience: 'Officials and partners',
  formality: 5,
  toneWords: ['Formal', 'National', 'Clear'],
  readingOrder,
  roles,
  must: [],
  mustNot: [],
  imageryStrategy: 'none',
  imageryRationale: 'Typography only',
  kurdishLeads: false,
  riskFlags: [],
});
const role = (copyIndex: number, r: CreativeBrief['roles'][number]['role'] = 'body') => ({ copyIndex, role: r, importance: 3 as const });

describe('creative brief roles', () => {
  it('keeps the first role for a block listed twice and drops an index past the end', () => {
    const { brief: fixed, dropped } = normalizeBriefRoles(
      brief([role(0, 'title'), role(1), role(1, 'footer'), role(2, 'date'), role(3, 'venue')], [0, 3, 1, 3, 9]),
      3,
    );
    expect(fixed.roles.map((r) => [r.copyIndex, r.role])).toEqual([[0, 'title'], [1, 'body'], [2, 'date']]);
    expect(fixed.readingOrder).toEqual([0, 1, 2]);
    expect(dropped).toEqual(['copyIndex 1 listed again as footer', 'copyIndex 3 does not exist']);
  });

  it('keeps the reading order the model chose over real blocks, then appends any it left out', () => {
    expect(normalizeBriefRoles(brief([role(0), role(1), role(2)], [2, 0]), 3).brief.readingOrder).toEqual([2, 0, 1]);
  });

  it('still refuses a brief that leaves a block without a role', () => {
    expect(() => normalizeBriefRoles(brief([role(0), role(2)]), 3)).toThrow('missing copy index 1');
  });

  it('lets a design through when the model lists nine roles for eight blocks (task abc59152, gpt-4.1-mini)', async () => {
    const roles = [...Array.from({ length: 8 }, (_, i) => role(i)), role(7, 'footer')];
    const completeJson = vi.fn(async () => ({ data: brief(roles) }));
    const ctx: any = {
      client: { completeJson },
      referencePack: { palette: ['#0A1628'] },
      copyBlocks: Array.from({ length: 8 }, (_, i) => ({ text: `Block ${i}`, script: 'latin' })),
      instructions: 'Invitation',
      width: 1080,
      height: 1350,
      tier: 'premium',
    };
    const result = await runBriefStage(ctx);
    expect(result.roles).toHaveLength(8);
    expect(result.roles[7].role).toBe('body');
    expect(completeJson).toHaveBeenCalledTimes(1);
  });
});
