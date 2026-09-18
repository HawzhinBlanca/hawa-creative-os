import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { prepareGeneratedLayoutV3, evaluateHardQa, type StudioLayoutV2 } from '../src/index.js';

// The cheap-tier winner of task 1f392e16 (2026-09-18): 317px of empty space inside its text boxes,
// yet its last two blocks overlapped at the bottom margin, and the date sat at 16px under 20px body
// copy. QA refused it and no design was delivered.
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/cheap-tier-overflow-1f392e16.json', import.meta.url), 'utf8')
) as { copy: string[]; layout: StudioLayoutV2 };
const copy = {
  text: Object.fromEntries(fixture.copy.map((b, i) => [i, b])),
  script: Object.fromEntries(fixture.copy.map((_, i) => [i, 'latin' as const])),
};
const PALETTE = ['#0A1628', '#1E3A5F', '#4770A3', '#D4E2F0', '#F7B500', '#FDF8F3', '#2C5282', '#FFFFFF', '#1A1A1A'];
const qa = {
  width: 1080,
  height: 1350,
  copyScripts: fixture.copy.map(() => 'latin' as const),
  latinFont: 'Verdana',
  arabicFont: 'Noto Sans Arabic',
  palette: PALETTE,
  logoAspect: 1,
  copyText: copy.text,
};
const prepare = (layout: StudioLayoutV2) =>
  prepareGeneratedLayoutV3(JSON.parse(JSON.stringify(layout)), copy, { width: 1080, height: 1350, logoAspect: 1, palette: PALETTE });

describe('preparation delivers a layout the generator over-sized', () => {
  it('fails QA as stored: the last two blocks overlap', () => {
    expect(evaluateHardQa(fixture.layout, qa).defectCodes).toContain('OVERLAP');
  });

  it('passes QA once prepared: empty box space is given back and the type ladder holds', () => {
    const prepared = prepare(fixture.layout);
    const outcome = evaluateHardQa(prepared, qa);
    expect(outcome.messages).toEqual([]);
    const size = (role: string) => Math.max(...prepared.text.filter((t) => t.role === role).map((t) => t.fontSize));
    expect(size('date')).toBeGreaterThanOrEqual(size('body'));
    // Blocks keep the order the client wrote them in, top to bottom.
    const ys = [...prepared.text].sort((a, b) => a.copyIndex - b.copyIndex).map((t) => t.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  it('never trims a layout that already fits', () => {
    const fits = prepare(fixture.layout);
    const again = prepare(fits);
    expect(again.text.map((t) => [t.y, t.height])).toEqual(fits.text.map((t) => [t.y, t.height]));
  });
});
