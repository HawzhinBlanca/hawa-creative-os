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
