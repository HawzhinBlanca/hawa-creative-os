import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { checkCanvaPptx } from '../src/canva-pptx-check.js';

const make = (text = 'Exact copy &amp; facts', font = 'Verdana') =>
  zipSync({
    'ppt/presentation.xml': strToU8('<p:presentation/>'),
    'ppt/slides/slide1.xml': strToU8(
      `<p:sld><p:sp><p:txBody><a:p><a:r><a:rPr><a:latin typeface="${font}"/></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:sld>`
    ),
  });

describe('Canva native round-trip inspection', () => {
  it('checks explicit client fonts for every script in a mixed run without a default or prefix match', () => {
    const deck=(latin:string,arabic:string)=>zipSync({'ppt/presentation.xml':strToU8('<p:presentation/>'),
      'ppt/slides/slide1.xml':strToU8(`<p:sld><p:sp><p:txBody><a:p><a:r><a:rPr><a:latin typeface="${latin}"/><a:cs typeface="${arabic}"/></a:rPr><a:t>Hello سڵاو</a:t></a:r></a:p></p:txBody></p:sp></p:sld>`)});
    const options={allowedFontsByScript:{latin:['Verdana'],arabic:['Noto Sans Arabic']}};
    expect(checkCanvaPptx(deck('Verdana','Noto Sans Arabic'),['Hello سڵاو'],options).fontPass).toBe(true);
    for(const [latin,arabic] of [['Arial','Noto Sans Arabic'],['Verdana','Arial'],['Verdana Fake','Noto Sans Arabic'],['Verdana','']])
      expect(checkCanvaPptx(deck(latin,arabic),['Hello سڵاو'],options).fontPass).toBe(false);
    expect(checkCanvaPptx(make(),['Exact copy & facts'],{allowedFontsByScript:{latin:[],arabic:[]}}).fontPass).toBe(false);
  });
  it('maps only observed live text with unique source identities, preserving source whitespace', () => {
    const shape = (id: string, text: string) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}"/></p:nvSpPr><p:txBody><a:p><a:r><a:rPr><a:latin typeface="Verdana"/></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
    const deck = (xml: string) => zipSync({'ppt/presentation.xml':strToU8('<p:presentation/>'),
      'ppt/slides/slide1.xml':strToU8(`<p:sld>${xml}</p:sld>`)});
    const checked = checkCanvaPptx(deck(shape('7', '  Real &amp; live  ')), ['Real & live']);
    expect(checked.sourceTextObjects).toEqual([{id:'ppt/slides/slide1.xml#7',type:'text',text:'  Real & live  ',
      source:{format:'pptx',part:'ppt/slides/slide1.xml',shapeId:'7'}}]);
    expect(checked.fullReleasePass).toBe(false);
    expect(checkCanvaPptx(make(), ['Exact copy & facts']).sourceTextObjects).toBeNull();
    expect(checkCanvaPptx(deck(shape('7','one')+shape('7','two')), ['one','two']).sourceTextObjects).toBeNull();
    expect(checkCanvaPptx(deck(shape('7','one')+'<p:pic><p:nvPicPr><p:cNvPr id="7"/></p:nvPicPr></p:pic>'), ['one']).sourceTextObjects).toBeNull();
    expect(checkCanvaPptx(deck('<p:pic><p:nvPicPr><p:cNvPr id="7"/></p:nvPicPr></p:pic>'), []).sourceTextObjects).toEqual([]);
  });
  it('decodes exact live text and the actual per-run font without claiming full release', () => {
    const r = checkCanvaPptx(make(), ['Exact copy & facts'], 'Verdana');
    expect(r.copyPass).toBe(true);
    expect(r.fontPass).toBe(true);
    expect(r.fullReleasePass).toBe(false);
  });

  it('catches the observed Canva Arimo font substitution', () => {
    const r = checkCanvaPptx(make(undefined, 'Arimo'), ['Exact copy & facts'], 'Verdana');
    expect(r.copyPass).toBe(true);
    expect(r.fontPass).toBe(false);
    expect(r.offendingObjects.length).toBeGreaterThan(0);
    expect(r.offendingObjects[0].observedFont).toBe('Arimo');
  });

  it('checks each block of a studio design against the face it was sent in', () => {
    const two = (titleFont: string, soraniFont: string) =>
      zipSync({
        'ppt/presentation.xml': strToU8('<p:presentation/>'),
        'ppt/slides/slide1.xml': strToU8(
          '<p:sld>' +
            `<p:sp><p:txBody><a:p><a:r><a:rPr><a:latin typeface="${titleFont}"/></a:rPr><a:t>KAAE Summit</a:t></a:r></a:p></p:txBody></p:sp>` +
            `<p:sp><p:txBody><a:p><a:pPr rtl="1"/><a:r><a:rPr><a:cs typeface="${soraniFont}"/></a:rPr><a:t>کۆنفرانسی نیشتمانی</a:t></a:r></a:p></p:txBody></p:sp>` +
            '</p:sld>'
        ),
      });
    const copy = ['KAAE Summit', 'کۆنفرانسی نیشتمانی'];
    const sent = { fontsByIndex: ['Cinzel', 'Amiri'] };
    expect(checkCanvaPptx(two('Cinzel', 'Amiri'), copy, sent).fontPass).toBe(true);
    const substituted = checkCanvaPptx(two('Cinzel', 'Arimo'), copy, sent);
    expect(substituted.fontPass).toBe(false);
    expect(substituted.offendingObjects).toEqual([
      expect.objectContaining({ index: 1, expectedFont: 'Amiri', observedFont: 'Arimo' }),
    ]);
    // A text object Canva returns that was never sent fails too.
    expect(checkCanvaPptx(two('Cinzel', 'Amiri'), copy, { fontsByIndex: ['Cinzel'] }).fontPass).toBe(false);
  });

  it('fails changed punctuation, omitted copy, and missing font evidence', () => {
    expect(checkCanvaPptx(make('Exact copy and facts'), ['Exact copy & facts'], 'Verdana').copyPass).toBe(false);
    expect(checkCanvaPptx(make(), ['Exact copy & facts', 'Another block'], 'Verdana').copyPass).toBe(false);
    expect(checkCanvaPptx(make(undefined, ''), ['Exact copy & facts'], 'Verdana').fontPass).toBe(false);
  });

  it('rejects compressed oversized XML and entity declarations before parsing', () => {
    const big = zipSync({ 'ppt/slides/slide1.xml': new Uint8Array(9 * 1024 * 1024) });
    expect(() => checkCanvaPptx(big, ['x'], 'Verdana')).toThrow('inspection limit');
    const entity = zipSync({
      'ppt/presentation.xml': strToU8('<p/>'),
      'ppt/slides/slide1.xml': strToU8('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///private">]><p/>'),
    });
    expect(() => checkCanvaPptx(entity, ['x'], 'Verdana')).toThrow('entities');
  });

  it('detects Kurdish complex script font in a:cs run properties', () => {
    const kurdishPptx = zipSync({
      'ppt/presentation.xml': strToU8('<p:presentation/>'),
      'ppt/slides/slide1.xml': strToU8(
        `<p:sld><p:sp><p:txBody><a:p><a:r><a:rPr><a:cs typeface="Noto Sans Arabic"/></a:rPr><a:t>سڵاو جیهان</a:t></a:r></a:p></p:txBody></p:sp></p:sld>`
      ),
    });
    const r = checkCanvaPptx(kurdishPptx, ['سڵاو جیهان'], 'Noto Sans Arabic');
    expect(r.copyPass).toBe(true);
    expect(r.fontPass).toBe(true);
    expect(r.observedFonts).toContain('Noto Sans Arabic');
  });
});

describe('Role-based typography validation (F12)', () => {
  it('passes formal document with Verdana for English body and Noto Sans Arabic for Sorani body', () => {
    const formalPptx = zipSync({
      'ppt/presentation.xml': strToU8('<p:presentation/>'),
      'ppt/slides/slide1.xml': strToU8(
        `<p:sld>
          <p:sp><p:txBody><a:p><a:r><a:rPr><a:latin typeface="Cinzel"/></a:rPr><a:t>ACADEMIC ACCREDITATION CERTIFICATE</a:t></a:r></a:p></p:txBody></p:sp>
          <p:sp><p:txBody><a:p><a:r><a:rPr><a:latin typeface="Verdana"/></a:rPr><a:t>This certifies that the academic institution meets all statutory accreditation standards.</a:t></a:r></a:p></p:txBody></p:sp>
          <p:sp><p:txBody><a:p><a:r><a:rPr><a:cs typeface="Noto Sans Arabic"/></a:rPr><a:t>ئەم بەڵگەنامەیە دەسەلمێنێت کە دامەزراوەکە مەرجەکانی بەدەستهێناوە</a:t></a:r></a:p></p:txBody></p:sp>
        </p:sld>`
      ),
    });

    const copy = [
      'ACADEMIC ACCREDITATION CERTIFICATE',
      'This certifies that the academic institution meets all statutory accreditation standards.',
      'ئەم بەڵگەنامەیە دەسەلمێنێت کە دامەزراوەکە مەرجەکانی بەدەستهێناوە',
    ];

    const r = checkCanvaPptx(formalPptx, copy, 'Verdana', {
      documentKind: 'formal_document',
      roles: ['title', 'body', 'body'],
      scriptFonts: { arabic: 'Noto Sans Arabic' },
    });

    expect(r.copyPass).toBe(true);
    expect(r.fontPass).toBe(true);
    expect(r.offendingObjects).toHaveLength(0);
    expect(r.observedFonts).toContain('Cinzel');
    expect(r.observedFonts).toContain('Verdana');
    expect(r.observedFonts).toContain('Noto Sans Arabic');
  });

  it('fails formal document when Latin body does not use Verdana', () => {
    const badFormalPptx = zipSync({
      'ppt/presentation.xml': strToU8('<p:presentation/>'),
      'ppt/slides/slide1.xml': strToU8(
        `<p:sld>
          <p:sp><p:txBody><a:p><a:r><a:rPr><a:latin typeface="Cinzel"/></a:rPr><a:t>ACADEMIC ACCREDITATION CERTIFICATE</a:t></a:r></a:p></p:txBody></p:sp>
          <p:sp><p:txBody><a:p><a:r><a:rPr><a:latin typeface="Playfair Display"/></a:rPr><a:t>This certifies that the academic institution meets all standards.</a:t></a:r></a:p></p:txBody></p:sp>
        </p:sld>`
      ),
    });

    const copy = [
      'ACADEMIC ACCREDITATION CERTIFICATE',
      'This certifies that the academic institution meets all standards.',
    ];

    const r = checkCanvaPptx(badFormalPptx, copy, 'Verdana', {
      documentKind: 'formal_document',
      roles: ['title', 'body'],
    });

    expect(r.copyPass).toBe(true);
    expect(r.fontPass).toBe(false);
    expect(r.offendingObjects).toHaveLength(1);
    expect(r.offendingObjects[0].observedFont).toBe('Playfair Display');
    expect(r.offendingObjects[0].reason).toContain('Verdana');
  });

  it('passes general design piece with admitted Canva-native display fonts (Cinzel, Playfair Display)', () => {
    const invitationPptx = zipSync({
      'ppt/presentation.xml': strToU8('<p:presentation/>'),
      'ppt/slides/slide1.xml': strToU8(
        `<p:sld>
          <p:sp><p:txBody><a:p><a:r><a:rPr><a:latin typeface="Cinzel"/></a:rPr><a:t>ANNUAL DIPLOMATIC GALA</a:t></a:r></a:p></p:txBody></p:sp>
          <p:sp><p:txBody><a:p><a:r><a:rPr><a:latin typeface="Playfair Display"/></a:rPr><a:t>Cordially invites you to the annual assembly</a:t></a:r></a:p></p:txBody></p:sp>
        </p:sld>`
      ),
    });

    const copy = ['ANNUAL DIPLOMATIC GALA', 'Cordially invites you to the annual assembly'];

    const r = checkCanvaPptx(invitationPptx, copy, 'Cinzel', {
      documentKind: 'design_piece',
      roles: ['headline', 'subtitle'],
    });

    expect(r.copyPass).toBe(true);
    expect(r.fontPass).toBe(true);
    expect(r.offendingObjects).toHaveLength(0);
    expect(r.observedFonts).toEqual(['Cinzel', 'Playfair Display']);
  });

  it('fails design piece when a font is outside the admitted Canva-native list or substituted', () => {
    const badInvitationPptx = zipSync({
      'ppt/presentation.xml': strToU8('<p:presentation/>'),
      'ppt/slides/slide1.xml': strToU8(
        `<p:sld>
          <p:sp><p:txBody><a:p><a:r><a:rPr><a:latin typeface="Comic Sans MS"/></a:rPr><a:t>ANNUAL DIPLOMATIC GALA</a:t></a:r></a:p></p:txBody></p:sp>
        </p:sld>`
      ),
    });

    const copy = ['ANNUAL DIPLOMATIC GALA'];

    const r = checkCanvaPptx(badInvitationPptx, copy, 'Cinzel', {
      documentKind: 'design_piece',
      roles: ['headline'],
    });

    expect(r.copyPass).toBe(true);
    expect(r.fontPass).toBe(false);
    expect(r.offendingObjects).toHaveLength(1);
    expect(r.offendingObjects[0].observedFont).toBe('Comic Sans MS');
  });
});

describe('Sorani Kurdish round-trip evidence', async () => {
  const { encodeEditableTransfer } = await import('../../creative/src/editable-transfer.js');
  const copy = ['Quality Assurance Workshop', 'وۆرکشۆپی دڵنیایی جۆری بۆ بەرپرسانی زانکۆکان'];
  const plan = {
    width: 1080,
    height: 1080,
    background: '#0A1628',
    text: [
      {
        copyIndex: 0,
        x: 80,
        y: 300,
        width: 920,
        height: 120,
        fontSize: 48,
        fontFamily: 'Verdana',
        color: '#F7B500',
        align: 'center' as const,
      },
      {
        copyIndex: 1,
        x: 80,
        y: 480,
        width: 920,
        height: 200,
        fontSize: 36,
        fontFamily: 'Noto Sans Arabic',
        color: '#FDF8F3',
        align: 'right' as const,
        rtl: true,
      },
    ],
    shapes: [],
  };
  const { bytes } = await encodeEditableTransfer(plan, copy, undefined, { extraFonts: ['Noto Sans Arabic'] });

  it('passes fonts per script and reports right-to-left evidence', () => {
    const r = checkCanvaPptx(bytes, copy, 'Verdana', { scriptFonts: { arabic: 'Noto Sans Arabic' } });
    expect(r.copyPass).toBe(true);
    expect(r.fontPass).toBe(true);
    expect(r.rtlPass).toBe(true);
    expect(r.arabicTextObjectCount).toBe(1);
    expect(r.rtlTextObjectCount).toBe(1);
    expect(r.observedFonts.sort()).toEqual(['Noto Sans Arabic', 'Verdana']);
  });

  it('fails the font check when the Kurdish typeface was not admitted', () => {
    const r = checkCanvaPptx(bytes, copy, 'Verdana');
    expect(r.fontPass).toBe(false);
    expect(r.copyPass).toBe(true);
  });
});

describe('reading direction in a Canva export', () => {
  // Canva's export writes no rtl attribute; the studio's own deck writes it on every Kurdish paragraph.
  const kurdish = 'ناونیشانی کوردی';
  const deck = (opts: { canva: boolean; rtl: boolean[] }) =>
    zipSync({
      'ppt/presentation.xml': strToU8('<p:presentation/>'),
      'docProps/core.xml': strToU8(
        opts.canva
          ? '<cp:coreProperties><dc:identifier>DAHVtest123</dc:identifier></cp:coreProperties>'
          : '<cp:coreProperties><dc:title>Editable Canva transfer (Hawa)</dc:title></cp:coreProperties>'
      ),
      'ppt/slides/slide1.xml': strToU8(
        `<p:sld>${opts.rtl
          .map((r) => `<p:sp><p:txBody><a:p><a:pPr${r ? ' rtl="1"' : ''}/><a:r><a:rPr><a:cs typeface="Noto Sans Arabic"/><a:latin typeface="Noto Sans Arabic"/></a:rPr><a:t>${kurdish}</a:t></a:r></a:p></p:txBody></p:sp>`)
          .join('')}</p:sld>`
      ),
    });

  it('leaves it to the visual review when a Canva export carries no rtl attribute at all', () => {
    const r = checkCanvaPptx(deck({ canva: true, rtl: [false] }), [kurdish], 'Noto Sans Arabic');
    expect(r.source).toBe('canva_exported_pptx');
    expect(r.rtlPass).toBe(true);
    expect(r.rtlNote).toMatch(/verified visually/);
  });

  it('still fails a studio deck, or a Canva export where only some Kurdish paragraphs carry it', () => {
    expect(checkCanvaPptx(deck({ canva: false, rtl: [false] }), [kurdish], 'Noto Sans Arabic').rtlPass).toBe(false);
    expect(checkCanvaPptx(deck({ canva: true, rtl: [true, false] }), [kurdish, kurdish], 'Noto Sans Arabic').rtlPass).toBe(false);
    expect(checkCanvaPptx(deck({ canva: true, rtl: [true, true] }), [kurdish, kurdish], 'Noto Sans Arabic').rtlPass).toBe(true);
  });
});
