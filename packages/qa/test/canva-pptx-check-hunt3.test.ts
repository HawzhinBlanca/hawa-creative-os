import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { checkCanvaPptx } from '../src/canva-pptx-check.js';
import { readPptxTextLayout } from '../src/canva-pptx-layout.js';
import { scriptFontRun, scriptFontDeck } from './fixtures/script-font-deck.js';

/**
 * Hunt 3 (2026-10-03): verdicts of the Canva PPTX copy and font check on export shapes the earlier
 * tests did not build. Each case is a Canva-style text body: runs split by direction, list styles,
 * soft line breaks and tables.
 */
const run = (text: string, face: string, cap?: string) =>
  `<a:r><a:rPr lang="en-US"${cap ? ` cap="${cap}"` : ''}><a:latin typeface="${face}"/></a:rPr><a:t>${text}</a:t></a:r>`;
const shape = (id: number, paragraphs: string, listStyle = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle>${listStyle}</a:lstStyle>${paragraphs}</p:txBody></p:sp>`;
const p = (...runs: string[]) => `<a:p>${runs.join('')}</a:p>`;
const deck = (...shapes: string[]) => zipSync({
  'ppt/presentation.xml': strToU8('<p:presentation/>'),
  'ppt/slides/slide1.xml': strToU8(`<p:sld><p:cSld><p:spTree>${shapes.join('')}</p:spTree></p:cSld></p:sld>`),
});

const COPY = ['Peer Review Week', 'Join us.'];
const POLICY = { fontsByIndex: ['Inter', 'Inter'], uppercaseByIndex: [true, false] };

describe('a block set in capitals is drawn in capitals (ADR-275 section 4)', () => {
  it('passes the copy typed under cap="all", and the capitals written into the text', () => {
    expect(checkCanvaPptx(deck(shape(2, p(run('Peer Review Week', 'Inter', 'all'))), shape(3, p(run('Join us.', 'Inter')))), COPY, POLICY).copyPass).toBe(true);
    expect(checkCanvaPptx(deck(shape(2, p(run('PEER REVIEW WEEK', 'Inter'))), shape(3, p(run('Join us.', 'Inter')))), COPY, POLICY).copyPass).toBe(true);
  });

  it('fails a capitals block Canva hands back without its capitals', () => {
    // cap="all" dropped: the title is drawn as typed, in mixed case.
    expect(checkCanvaPptx(deck(shape(2, p(run('Peer Review Week', 'Inter'))), shape(3, p(run('Join us.', 'Inter')))), COPY, POLICY).copyPass).toBe(false);
    // lower case drawn as lower case.
    expect(checkCanvaPptx(deck(shape(2, p(run('peer review week', 'Inter'))), shape(3, p(run('Join us.', 'Inter')))), COPY, POLICY).copyPass).toBe(false);
    // cap kept on one run of a split block only.
    expect(checkCanvaPptx(deck(shape(2, p(run('Peer ', 'Inter', 'all'), run('Review Week', 'Inter'))), shape(3, p(run('Join us.', 'Inter')))), COPY, POLICY).copyPass).toBe(false);
  });

  it('takes capitals from the frame\'s list style unless the run sets its own', () => {
    const listCaps = '<a:lvl1pPr><a:defRPr cap="all"/></a:lvl1pPr>';
    // A list style drawing the untransformed block in capitals the requester did not type.
    const shown = checkCanvaPptx(deck(shape(2, p(run('PEER REVIEW WEEK', 'Inter'))), shape(3, p(run('Join us.', 'Inter')), listCaps)), COPY, POLICY);
    expect(shown.shownTexts[1]).toBe('JOIN US.');
    expect(shown.copyPass).toBe(false);
    // The capitals block drawn in capitals by its list style passes.
    expect(checkCanvaPptx(deck(shape(2, p(run('Peer Review Week', 'Inter')), listCaps), shape(3, p(run('Join us.', 'Inter')))), COPY, POLICY).copyPass).toBe(true);
    // A run's own cap="none" overrides the list style.
    const none = checkCanvaPptx(deck(shape(2, p(run('PEER REVIEW WEEK', 'Inter'))), shape(3, p(run('Join us.', 'Inter', 'none')), listCaps)), COPY, POLICY);
    expect(none.copyPass).toBe(true);
    // A second-level paragraph reads its own level.
    const level2 = shape(3, `<a:p><a:pPr lvl="1"/>${run('Join us.', 'Inter')}</a:p>`, listCaps);
    expect(checkCanvaPptx(deck(shape(2, p(run('PEER REVIEW WEEK', 'Inter'))), level2), COPY, POLICY).copyPass).toBe(true);
  });

  it('keeps a mixed Latin and Sorani block exact, since capitals do not apply to it', () => {
    const copy = ['Week هەفتە', 'Join us.'];
    const sent = deck(shape(2, p(run('Week هەفتە', 'Inter'))), shape(3, p(run('Join us.', 'Inter'))));
    expect(checkCanvaPptx(sent, copy, POLICY).copyPass).toBe(true);
  });
});

describe('soft line breaks and text outside shapes', () => {
  it('reads <a:br/> as a line break, as PowerPoint and Canva draw it', () => {
    const broken = deck(shape(2, p(run('PEER REVIEW', 'Inter'), '<a:br><a:rPr lang="en-US"/></a:br>', run('WEEK', 'Inter'))), shape(3, p(run('Join us.', 'Inter'))));
    const r = checkCanvaPptx(broken, COPY, POLICY);
    expect(r.copyPass).toBe(true);
    expect(r.shownTexts[0]).toBe('PEER REVIEW\nWEEK');
    expect(r.sourceTextObjects?.[0]?.text).toBe('PEER REVIEW\nWEEK');
    // Two words drawn on two lines are not one word.
    const split = deck(shape(2, p(run('Peer', 'Inter'), '<a:br/>', run('Review', 'Inter'))));
    expect(checkCanvaPptx(split, ['PeerReview'], { fontsByIndex: ['Inter'] }).copyPass).toBe(false);
  });

  it('the layout reader keeps the soft break in the frame text', () => {
    const placed = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/>${p(run('PEER', 'Inter'), '<a:br/>', run('WEEK', 'Inter'))}</p:txBody></p:sp>`;
    const bytes = zipSync({
      'ppt/presentation.xml': strToU8('<p:presentation><p:sldSz cx="10287000" cy="12858750"/></p:presentation>'),
      'ppt/slides/slide1.xml': strToU8(`<p:sld><p:cSld><p:spTree>${placed}</p:spTree></p:cSld></p:sld>`),
    });
    expect(readPptxTextLayout(bytes).frames[0].text).toBe('PEER\nWEEK');
  });
});
