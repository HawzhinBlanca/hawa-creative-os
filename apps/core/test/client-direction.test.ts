import { describe, it, expect } from 'vitest';
import { prepareGeneratedLayoutV3, copyOrderViolations, evaluateHardQa, type StudioLayoutV2 } from '@hawa/creative';
import { normalizeBriefRoles, requestedBackgroundFor } from '../src/services/design-studio/stages/brief.stage.js';
import { layoutBriefV3 } from '../src/services/design-studio/stages/layouts.stage.js';
import type { CreativeBrief } from '../src/services/design-studio/types.js';

// Task 3c3a422b (2026-09-18, cheap tier): the client asked for "dark blue navy as a background" and
// "don't change anything from my content". The winner was cream, and all three candidates set the
// guest's name (block 1) above the title (block 0).
const PALETTE = ['#0A1628', '#1E3A5F', '#4770A3', '#D4E2F0', '#F7B500', '#FDF8F3'];
const INSTRUCTIONS = 'Make it nice and professional, in english. It needs to go with kaaes brand guidelines, currently we prefer the dark blue navy as a background';

const block = (copyIndex: number, role: any, y: number, height: number, extra: Partial<StudioLayoutV2['text'][number]> = {}) => ({
  x: 120, y, width: 840, height, copyIndex, role, fontSize: 24, lineHeight: 1.3, fontFamily: 'Verdana', color: '#0A1628', align: 'center' as const, ...extra,
});

const creamLayout = (): StudioLayoutV2 =>
  ({
    version: 2,
    width: 1080,
    height: 1350,
    grid: { margin: 86, columns: 6, gutter: 20, baseline: 8 },
    background: { color: '#FDF8F3' },
    shapes: [],
    text: [block(0, 'title', 420, 140, { fontSize: 48, fontFamily: 'Playfair Display' }), block(1, 'subtitle', 600, 40), block(2, 'body', 700, 200)],
    logo: { x: 470, y: 120, width: 140, height: 140 },
  }) as any;

const brief = (roles: CreativeBrief['roles']): CreativeBrief => ({
  occasion: 'Official launch invitation',
  audience: 'Dignitaries',
  formality: 5,
  toneWords: ['Formal', 'National', 'Clear'],
  readingOrder: roles.map((r) => r.copyIndex),
  roles,
  must: ['Use dark blue navy background from brand palette', 'Keep invited copy exactly as given'],
  mustNot: [],
  imageryStrategy: 'abstract',
  imageryRationale: 'Brand texture',
  kurdishLeads: false,
  riskFlags: [],
  requestedBackground: '#0A1628',
});

describe("the client's direction reaches the design and is enforced", () => {
  it("quotes the client's instructions, the brief's musts and the requested background to the layout generator", () => {
    const text = layoutBriefV3(brief([]), { instructions: INSTRUCTIONS, requestedBackground: '#0A1628' });
    expect(text).toContain('dark blue navy as a background');
    expect(text).toContain('Must: Use dark blue navy background from brand palette');
    expect(text).toContain('Background: #0A1628, as the client asked');
  });

  it('turns the requested background into a brand colour, and ignores anything that is not a colour', () => {
    expect(requestedBackgroundFor({ requestedBackground: '#0a1628' }, PALETTE)).toBe('#0A1628');
    expect(PALETTE).toContain(requestedBackgroundFor({ requestedBackground: '#000080' }, PALETTE));
    expect(requestedBackgroundFor({ requestedBackground: '' }, PALETTE)).toBeUndefined();
    expect(requestedBackgroundFor({ requestedBackground: 'navy' }, PALETTE)).toBeUndefined();
    expect(requestedBackgroundFor(undefined, PALETTE)).toBeUndefined();
  });

  it('sets the requested background on a cream layout and recolours the navy text it would hide', () => {
    const copy = { text: { 0: 'THE NATIONAL STANDARDS', 1: 'Mr. / Ms. / Dr. [Full Name]', 2: 'His Excellency will announce.' }, script: { 0: 'latin', 1: 'latin', 2: 'latin' } } as any;
    const layout = prepareGeneratedLayoutV3(creamLayout(), copy, { width: 1080, height: 1350, palette: PALETTE, background: '#0A1628' });
    expect(layout.background.color).toBe('#0A1628');
    for (const t of layout.text) expect(t.color.toUpperCase()).not.toBe('#0A1628');
  });

  it('never relabels as an eyebrow a line the client wrote after the title', () => {
    const { brief: fixed } = normalizeBriefRoles(
      brief([
        { copyIndex: 0, role: 'title', importance: 5 },
        { copyIndex: 1, role: 'eyebrow', importance: 3 },
        { copyIndex: 2, role: 'body', importance: 3 },
      ]),
      3
    );
    expect(fixed.roles[1].role).toBe('subtitle');
    const leading = normalizeBriefRoles(brief([{ copyIndex: 0, role: 'eyebrow', importance: 3 }, { copyIndex: 1, role: 'title', importance: 5 }]), 2);
    expect(leading.brief.roles[0].role).toBe('eyebrow');
  });

  it("fails QA when a block sits above one the client wrote before it, and not for blocks side by side", () => {
    const reordered = creamLayout();
    reordered.text[1].y = 330; // the guest's name above the title
    expect(copyOrderViolations(reordered)).toEqual(['block 1 (subtitle) sits above block 0 (title)']);
    const qa = evaluateHardQa(reordered, { width: 1080, height: 1350, copyScripts: ['latin', 'latin', 'latin'], latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', palette: PALETTE, logoAspect: 1 });
    expect(qa.defectCodes).toContain('COPY_ORDER');

    const sideBySide = creamLayout();
    sideBySide.text = [block(0, 'title', 420, 140), { ...block(1, 'date', 900, 40), x: 120, width: 380 }, { ...block(2, 'venue', 896, 40), x: 580, width: 380 }];
    expect(copyOrderViolations(sideBySide)).toEqual([]);
    const venueFirst = creamLayout();
    venueFirst.text = [block(0, 'title', 420, 140), { ...block(1, 'date', 900, 40), x: 120, width: 380 }, { ...block(2, 'venue', 850, 40), x: 580, width: 380 }];
    expect(copyOrderViolations(venueFirst)).toEqual([]);
  });
});
