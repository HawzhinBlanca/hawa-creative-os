import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readPptxTextLayout } from '../src/canva-pptx-layout.js';

/** ADR-257: the text frames the export QC measures on the shipped PNG. */
const deck = (tree: string, size = '<p:sldSz cx="1000" cy="2000"/>') => zipSync({
  'ppt/presentation.xml': strToU8(`<p:presentation>${size}</p:presentation>`),
  'ppt/slides/slide1.xml': strToU8(`<p:sld><p:cSld><p:spTree>${tree}</p:spTree></p:cSld></p:sld>`),
});
const sp = (xfrm: string, rPr = '<a:rPr sz="2400"><a:solidFill><a:srgbClr val="14253d"/></a:solidFill></a:rPr>', id = 2) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="t"/></p:nvSpPr><p:spPr>${xfrm}</p:spPr><p:txBody><a:p><a:r>${rPr}<a:t>Title</a:t></a:r></a:p></p:txBody></p:sp>`;

describe('readPptxTextLayout (ADR-257)', () => {
  it('reads the slide size, a frame box, and its run colour, size and weight', () => {
    const layout = readPptxTextLayout(deck(sp('<a:xfrm><a:off x="100" y="200"/><a:ext cx="300" cy="50"/></a:xfrm>')));
    expect(layout.slideWidth).toBe(1000);
    expect(layout.slideHeight).toBe(2000);
    expect(layout.frames).toEqual([{ shapeId: '2', text: 'Title', box: { x: 100, y: 200, width: 300, height: 50 }, scale: 1,
      runs: [{ text: 'Title', color: '#14253D', fontSizePt: 24, bold: false }] }]);
  });

  it('places a frame through a scaled, offset group and scales its type with it', () => {
    const group = '<p:grpSp><p:grpSpPr><a:xfrm><a:off x="100" y="100"/><a:ext cx="400" cy="200"/><a:chOff x="0" y="0"/><a:chExt cx="800" cy="400"/></a:xfrm></p:grpSpPr>' +
      sp('<a:xfrm><a:off x="200" y="0"/><a:ext cx="400" cy="100"/></a:xfrm>') + '</p:grpSp>';
    const [frame] = readPptxTextLayout(deck(group)).frames;
    expect(frame.box).toEqual({ x: 200, y: 100, width: 200, height: 50 });
    expect(frame.scale).toBe(0.5);
  });

  it('takes the bounds of a frame turned a quarter about its centre', () => {
    const [frame] = readPptxTextLayout(deck(sp('<a:xfrm rot="5400000"><a:off x="100" y="200"/><a:ext cx="300" cy="50"/></a:xfrm>'))).frames;
    expect(frame.box.x).toBeCloseTo(225, 6);
    expect(frame.box.y).toBeCloseTo(75, 6);
    expect(frame.box.width).toBeCloseTo(50, 6);
    expect(frame.box.height).toBeCloseTo(300, 6);
  });

  it('inherits a colour from the list style, names theme and modified colours, and reports a frame with no position', () => {
    const listed = '<p:sp><p:nvSpPr><p:cNvPr id="3" name="t"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm></p:spPr>' +
      '<p:txBody><a:lstStyle><a:lvl1pPr><a:defRPr sz="1200" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle>' +
      '<a:p><a:r><a:t>Listed</a:t></a:r></a:p></p:txBody></p:sp>';
    const themed = sp('<a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm>', '<a:rPr><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:rPr>', 4);
    const tinted = sp('<a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm>', '<a:rPr><a:solidFill><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:solidFill></a:rPr>', 5);
    const placeholder = '<p:sp><p:nvSpPr><p:cNvPr id="6" name="p"/></p:nvSpPr><p:spPr/><p:txBody><a:p><a:r><a:t>Inherited</a:t></a:r></a:p></p:txBody></p:sp>';
    const layout = readPptxTextLayout(deck(listed + themed + tinted + placeholder));
    expect(layout.frames.map((f) => f.runs[0])).toEqual([
      { text: 'Listed', color: '#FFFFFF', fontSizePt: 12, bold: true },
      { text: 'Title', color: null, colorNote: 'theme colour tx1', fontSizePt: null, bold: false },
      { text: 'Title', color: null, colorNote: 'colour modified by a:alpha', fontSizePt: null, bold: false },
    ]);
    expect(layout.unplaced).toEqual([{ shapeId: '6', text: 'Inherited', reason: 'no position of its own (inherited from a layout placeholder)' }]);
  });

  it('refuses a deck with no slide size or more than one slide', () => {
    expect(() => readPptxTextLayout(deck(sp(''), ''))).toThrow(/slide size/);
    const two = zipSync({ 'ppt/presentation.xml': strToU8('<p:presentation><p:sldSz cx="1" cy="1"/></p:presentation>'),
      'ppt/slides/slide1.xml': strToU8('<p:sld/>'), 'ppt/slides/slide2.xml': strToU8('<p:sld/>') });
    expect(() => readPptxTextLayout(two)).toThrow(/one-page/);
  });
});
