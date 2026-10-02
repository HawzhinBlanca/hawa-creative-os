import { describe, expect, it } from 'vitest';
import type { StudioLayoutV2, TextElement } from '@hawa/creative';
import { applyOp, type OpContext } from '../src/services/design-studio/edit-ops.js';
import { carryOver, keepUntouched } from '../src/services/design-studio/stages/edit.stage.js';
import { importedSourceCapitals } from '../src/services/canva-connect-service.js';

/**
 * ADR-275: a poster title in a named weight and capitals keeps both through a requester's edit,
 * unless the edit asks for a lighter title; and the Canva capture checks learn from the imported
 * plan which blocks were set in capitals.
 */
const title = (over: Partial<TextElement> = {}): TextElement => ({
  copyIndex: 0, role: 'title', x: 65, y: 400, width: 950, height: 700, fontSize: 200, lineHeight: 0.98,
  fontFamily: 'Inter', color: '#0A2A6B', align: 'left', bold: true, fontWeight: 800, textTransform: 'uppercase', letterSpacing: -0.01, ...over,
});
const layout = (t: TextElement): StudioLayoutV2 => ({
  version: 2, width: 1080, height: 1350, grid: { margin: 65, columns: 12, gutter: 24, baseline: 8 },
  background: { color: '#FFFFFF' }, shapes: [], text: [t], logo: { x: 65, y: 65, width: 173, height: 173 },
});
const ctx: OpContext = { palette: ['#0A2A6B', '#FFFFFF'], cutoutAvailable: () => false, copy: ['Peer Review Week'] };

describe('display caps through a requester edit (ADR-275)', () => {
  it('a "not bold" edit drops the weight; a "bold" edit keeps a heavier one', () => {
    const lighter = layout(title());
    expect(applyOp(lighter, 'font_weight_or_style', { text: 0, bold: false }, ctx)).toMatchObject({ ok: true });
    expect(lighter.text[0]).toMatchObject({ bold: false });
    expect(lighter.text[0].fontWeight).toBeUndefined();
    const heavier = layout(title());
    applyOp(heavier, 'font_weight_or_style', { text: 0, bold: true }, ctx);
    expect(heavier.text[0].fontWeight).toBe(800);
    const semi = layout(title({ fontWeight: 600 }));
    applyOp(semi, 'font_weight_or_style', { text: 0, bold: true }, ctx);
    expect(semi.text[0].fontWeight).toBeUndefined();
    expect(semi.text[0].bold).toBe(true);
  });

  it('the edit model\'s answer keeps the weight and the capitals it did not mention', () => {
    const parent = layout(title());
    const { fontWeight: _w, textTransform: _t, ...bare } = title({ color: '#FFFFFF' });
    const carried = carryOver(parent, layout(bare as TextElement));
    expect(carried.text[0]).toMatchObject({ fontWeight: 800, textTransform: 'uppercase' });
    const unbolded = carryOver(parent, layout({ ...(bare as TextElement), bold: false }));
    expect(unbolded.text[0].fontWeight).toBeUndefined();
    expect(unbolded.text[0].textTransform).toBe('uppercase');
    const untouched = keepUntouched(parent, layout({ ...(bare as TextElement), fontWeight: 400 }), ['background']);
    expect(untouched.text[0]).toMatchObject({ fontWeight: 800, textTransform: 'uppercase' });
  });

  it('reads the capitals blocks of an imported plan, and nothing for a plan without them', () => {
    const manifest = (text: unknown[]) => ({ copy: ['Peer Review Week', 'Join us'], plan: { text } });
    expect(importedSourceCapitals(manifest([{ copyIndex: 1 }, { copyIndex: 0, textTransform: 'uppercase' }]))).toEqual([true, false]);
    expect(importedSourceCapitals(manifest([{ copyIndex: 0 }, { copyIndex: 1 }]))).toBeUndefined();
    expect(importedSourceCapitals(manifest([{ copyIndex: 0, textTransform: 'uppercase' }]))).toBeUndefined();
    expect(importedSourceCapitals(null)).toBeUndefined();
  });
});
