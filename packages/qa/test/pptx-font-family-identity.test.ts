import { describe, expect, it } from 'vitest';
import { checkCanvaPptx, type PptxCheckOptions } from '../src/canva-pptx-check.js';
import { scriptFontRun as run, scriptFontDeck as deck } from './fixtures/script-font-deck.js';

describe('captured font family identity', () => {
  it.each<{name: string; text: string; face: string; options: PptxCheckOptions}>([
    {name:'generated Latin',text:'Hello',face:'Verdana Fake',options:{fontsByIndex:['Verdana']}},
    {name:'generated Sorani',text:'سڵاو',face:'Noto Sans Arabic Fake',options:{fontsByIndex:['Noto Sans Arabic']}},
    {name:'legacy Latin',text:'Hello',face:'Verdana Fake',options:{}},
    {name:'legacy Sorani',text:'سڵاو',face:'Noto Sans Arabic Fake',options:{scriptFonts:{arabic:'Noto Sans Arabic'}}},
    {name:'formal body Latin',text:'Hello',face:'Verdana Fake',options:{documentKind:'formal_document',roles:['body']}},
    {name:'formal body Sorani',text:'سڵاو',face:'Noto Sans Arabic Fake',options:{documentKind:'formal_document',roles:['body']}},
    {name:'formal display',text:'Hello',face:'Cinzel Fake',options:{documentKind:'formal_document',roles:['title']}},
    {name:'design display',text:'Hello',face:'Cinzel Fake',options:{documentKind:'design_piece'}},
    {name:'distinct width',text:'Hello',face:'Verdana Narrow',options:{fontsByIndex:['Verdana']}},
    {name:'unmeasured custom style',text:'Hello',face:'Office Sans Bold',options:{fontsByIndex:['Office Sans']}},
    {name:'trailing unknown token',text:'Hello',face:'Verdana Bold Fake',options:{fontsByIndex:['Verdana']}},
    {name:'extra style on exact face',text:'Hello',face:'Cinzel SemiBold Bold',options:{fontsByIndex:['Cinzel SemiBold']}},
    {name:'Crimson unverified family',text:'Hello',face:'Crimson Pro Fake',options:{fontsByIndex:['Crimson Pro']}},
    {name:'Crimson extra token',text:'Hello',face:'Crimson Pro Bold Fake',options:{fontsByIndex:['Crimson Pro']}},
    {name:'Crimson distinct width',text:'Hello',face:'Crimson Pro Narrow',options:{fontsByIndex:['Crimson Pro']}},
  ])('refuses unverified family extension: $name', ({text,face,options}) => {
    const result=checkCanvaPptx(deck(run(text,face,face)),[text],options);
    expect(result.copyPass).toBe(true);
    expect(result.fontPass).toBe(false);
    expect(result.offendingObjects[0]?.observedFont).toBe(face);
    expect(result.fullReleasePass).toBe(false);
  });

  it.each([
    ['Verdana','Verdana Bold'], ['Verdana','Verdana Italic'], ['Verdana','Verdana Bold Italic'],
    ['Cinzel','Cinzel SemiBold'], ['Playfair Display','Playfair Display SemiBold'],
    ['Playfair Display','Playfair Display SemiBold Italic'], ['Plus Jakarta Sans','Plus Jakarta Sans Medium'],
    ['Noto Sans Arabic','Noto Sans Arabic Regular'], ['Noto Sans Arabic','Noto Sans Arabic Bold'],
    ['Amiri','Amiri Regular'], ['IBM Plex Sans Arabic','IBM Plex Sans Arabic Bold'], ['Vazirmatn','Vazirmatn Regular'],
    ['Crimson Pro','Crimson Pro Bold'],
  ])('preserves measured family/full-name equivalence: %s / %s', (expected,face) => {
    expect(checkCanvaPptx(deck(run('Hello',face)),['Hello'],{fontsByIndex:[expected]}).fontPass).toBe(true);
  });

  it('keeps exact custom and explicitly selected width/style families', () => {
    for(const face of ['Office Sans','Arial Narrow','Cinzel SemiBold']) {
      expect(checkCanvaPptx(deck(run('Hello',face)),['Hello'],{fontsByIndex:[face]}).fontPass).toBe(true);
    }
  });

  it.each(['constructor','__proto__'])('refuses an unknown family extension without inheriting object properties: %s', expected => {
    expect(checkCanvaPptx(deck(run('Hello',expected+' Bold')),['Hello'],{fontsByIndex:[expected]}).fontPass).toBe(false);
  });

  it('preserves generated case folding and legacy case sensitivity', () => {
    expect(checkCanvaPptx(deck(run('Hello','verdana bold')),['Hello'],{fontsByIndex:['VERDANA']}).fontPass).toBe(true);
    expect(checkCanvaPptx(deck(run('Hello','verdana bold')),['Hello'],'Verdana').fontPass).toBe(false);
    expect(checkCanvaPptx(deck(run('Hello','Verdana Bold')),['Hello'],'Verdana').fontPass).toBe(true);
  });

  it('does not broaden exact manual Client DNA membership', () => {
    const options={allowedFontsByScript:{latin:['Verdana'],arabic:['Noto Sans Arabic']}};
    expect(checkCanvaPptx(deck(run('Hello','Verdana Bold')),['Hello'],options).fontPass).toBe(false);
    expect(checkCanvaPptx(deck(run('Hello','Verdana')),['Hello'],options).fontPass).toBe(true);
  });
});
