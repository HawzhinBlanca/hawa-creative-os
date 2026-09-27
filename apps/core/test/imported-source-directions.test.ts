import { describe, expect, it } from 'vitest';
import { importedSourceDirections } from '../src/services/canva-connect-service.js';

describe('captured import direction policy', () => {
  it('binds explicit booleans by canonical copy index and leaves old metadata unspecified', () => {
    expect(importedSourceDirections({ copy: ['A', 'B', 'C'], plan: { text: [
      { copyIndex: 2, fontFamily: 'Noto Sans Arabic', align: 'right' },
      { copyIndex: 0, rtl: false }, { copyIndex: 1, rtl: true },
    ] } })).toEqual(['ltr', 'rtl', null]);
  });
  it('does not borrow metadata from duplicate, missing or misindexed blocks', () => {
    for (const text of [[{ copyIndex: 0 }, { copyIndex: 0 }], [{ copyIndex: 0 }],
      [null, { copyIndex: 1 }], [{ copyIndex: '0' }, { copyIndex: 1 }]]) {
      expect(importedSourceDirections({ copy: ['A', 'B'], plan: { text } })).toBeUndefined();
    }
    expect(importedSourceDirections(null)).toBeUndefined();
  });
});
