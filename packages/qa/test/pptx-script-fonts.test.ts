import { describe, expect, it } from 'vitest';
import { checkCanvaPptx, type PptxCheckOptions } from '../src/canva-pptx-check.js';
import { scriptFontRun as run, scriptFontDeck as deck } from './fixtures/script-font-deck.js';

describe('captured PPTX script-specific font evidence', () => {
  it.each<{name: string; text: string; latin: string; arabic: string; options: PptxCheckOptions}>([
    { name: 'generated Sorani', text: 'سڵاو', latin: 'Noto Sans Arabic', arabic: 'Arial', options: {fontsByIndex: ['Noto Sans Arabic']} },
    { name: 'generated Latin', text: 'Hello', latin: 'Arial', arabic: 'Verdana', options: {fontsByIndex: ['Verdana']} },
    { name: 'legacy Sorani', text: 'سڵاو', latin: 'Noto Sans Arabic', arabic: 'Arial', options: {scriptFonts: {arabic: 'Noto Sans Arabic'}} },
    { name: 'legacy Latin', text: 'Hello', latin: 'Arial', arabic: 'Verdana', options: {} },
    { name: 'display Sorani', text: 'سڵاو', latin: 'Verdana', arabic: 'Unapproved Font', options: {documentKind: 'design_piece'} },
    { name: 'formal Sorani', text: 'سڵاو', latin: 'Noto Sans Arabic', arabic: 'Arial', options: {documentKind: 'formal_document', roles: ['body']} },
  ])('refuses a wrong used slot despite an expected unused slot: $name', ({text, latin, arabic, options}) => {
    const result = checkCanvaPptx(deck(run(text, latin, arabic)), [text], options);
    expect(result.copyPass).toBe(true);
    expect(result.fontPass).toBe(false);
    expect(result.offendingObjects[0]?.observedFont).toBe(text === 'Hello' ? latin : arabic);
  });

  it('requires every script actually present in a generated mixed run', () => {
    const options = {fontsByIndex: ['Verdana']};
    expect(checkCanvaPptx(deck(run('Hello سڵاو', 'Verdana', 'Arial')), ['Hello سڵاو'], options).fontPass).toBe(false);
    expect(checkCanvaPptx(deck(run('Hello سڵاو', 'Arial', 'Verdana')), ['Hello سڵاو'], options).fontPass).toBe(false);
    expect(checkCanvaPptx(deck(run('Hello سڵاو', 'Verdana', 'Verdana')), ['Hello سڵاو'], options).fontPass).toBe(true);
  });

  it('checks formal mixed-body runs against their own script instead of the whole shape', () => {
    const result = checkCanvaPptx(deck(run('Hello ', 'Verdana') + run('سڵاو', undefined, 'Noto Sans Arabic')),
      ['Hello سڵاو'], {documentKind: 'formal_document', roles: ['body']});
    expect(result.copyPass).toBe(true);
    expect(result.fontPass).toBe(true);
    expect(result.observedFonts).toEqual(['Verdana', 'Noto Sans Arabic']);
  });

  it('does not infer a missing used slot from another script declaration', () => {
    expect(checkCanvaPptx(deck(run('سڵاو', 'Noto Sans Arabic')), ['سڵاو'], {fontsByIndex: ['Noto Sans Arabic']}).fontPass).toBe(false);
    expect(checkCanvaPptx(deck(run('Hello', undefined, 'Verdana')), ['Hello'], {fontsByIndex: ['Verdana']}).fontPass).toBe(false);
  });

  it('checks field text font declarations even when a normal run supplies approved evidence', () => {
    const options = {allowedFontsByScript: {latin: ['Verdana'], arabic: ['Noto Sans Arabic']}};
    const source = deck(run('Meeting ', 'Verdana') + run('2026', 'Arial', undefined, 'fld'));
    const result = checkCanvaPptx(source, ['Meeting 2026'], options);
    expect(result.copyPass).toBe(true);
    expect(result.fontPass).toBe(false);
    expect(result.sourceTextObjects?.[0]?.text).toBe('Meeting 2026');
  });

  it('inspects field-only live copy without inventing a missing regular run', () => {
    const source = deck(run('2026', 'Verdana', undefined, 'fld'));
    const result = checkCanvaPptx(source, ['2026'], {fontsByIndex: ['Verdana']});
    expect(result.copyPass).toBe(true);
    expect(result.fontPass).toBe(true);
    expect(result.sourceTextObjects?.[0]?.text).toBe('2026');
    expect(result.fullReleasePass).toBe(false);
  });

  it('keeps unused script faces out of observed font evidence', () => {
    const result = checkCanvaPptx(deck(run('سڵاو', 'Unused Latin', 'Noto Sans Arabic')), ['سڵاو'], {fontsByIndex: ['Noto Sans Arabic']});
    expect(result.fontPass).toBe(true);
    expect(result.observedFonts).toEqual(['Noto Sans Arabic']);
  });

  it('ignores empty/whitespace runs without assigning their declarations to visible copy', () => {
    const result = checkCanvaPptx(deck(run(' ', undefined, 'Unused') + run('Hello', 'Verdana')), ['Hello'], {fontsByIndex: ['Verdana']});
    expect(result.fontPass).toBe(true);
    expect(result.observedFonts).toEqual(['Verdana']);
    expect(result.sourceTextObjects?.[0]?.text).toBe(' Hello');
  });

  it('does not allow a conflicting duplicate declaration to qualify the used slot', () => {
    const conflicting = run('Hello', 'Verdana').replace('<a:latin typeface="Verdana"/>', '<a:latin typeface="Verdana"/><a:latin typeface="Arial"/>');
    const result = checkCanvaPptx(deck(conflicting), ['Hello'], {fontsByIndex: ['Verdana']});
    expect(result.copyPass).toBe(true);
    expect(result.fontPass).toBe(false);
    expect(result.offendingObjects[0]?.observedFont).toBe('Verdana, Arial');
  });

  it('recognizes extended Latin letters in mixed manual text', () => {
    const options = {allowedFontsByScript: {latin: ['Verdana'], arabic: ['Noto Sans Arabic']}};
    expect(checkCanvaPptx(deck(run('Ḣ سڵاو', 'Arial', 'Noto Sans Arabic')), ['Ḣ سڵاو'], options).fontPass).toBe(false);
    expect(checkCanvaPptx(deck(run('Ḣ سڵاو', 'Verdana', 'Noto Sans Arabic')), ['Ḣ سڵاو'], options).fontPass).toBe(true);
  });

  it('keeps legitimate family style suffixes and unused declarations under existing policy', () => {
    const result = checkCanvaPptx(deck(run('Hello', 'Verdana Bold', 'Unused')), ['Hello'], {fontsByIndex: ['Verdana']});
    expect(result.fontPass).toBe(true);
    expect(result.observedFonts).toEqual(['Verdana Bold']);
    expect(result.checkVersion).toBe(8);
  });
});
