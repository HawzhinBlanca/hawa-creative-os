import { describe, expect, it } from 'vitest';
import {
  checkCopyCompleteness,
  danglingFinalWord,
  instructionLanguageFindings,
  normaliseSorani,
  splitCopyByLineScript,
  unbalancedMarks,
} from '../src/studio/copy-completeness.js';

describe('copy completeness (ADR-157, audit #16)', () => {
  it('flags the KAAE subtitle that ends on "toward"', () => {
    expect(danglingFinalWord('Insights from KAAE school field visits and next steps toward')).toBe('toward');
    const findings = checkCopyCompleteness({ 0: 'KAAE K-12 Pilot Study', 1: 'Field Visit Report', 2: 'Insights from KAAE school field visits and next steps toward' });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'COPY_DANGLING_END', severity: 'warning', copyIndex: 2 });
  });

  it('reads trailing punctuation as not a word, and still flags the word before it', () => {
    expect(danglingFinalWord('Join us for the launch of the')).toBe('the');
    expect(danglingFinalWord('Education and innovation, and.')).toBe('and');
    expect(danglingFinalWord('A future built with —')).toBe('with');
  });

  it('leaves finished copy, phrasal verbs and questions alone', () => {
    for (const text of ['KAAE K-12 Pilot Study', 'Sign in', 'Log on', 'Stop by', 'Find out', 'What are you waiting for?', 'Register now.', '12 October 2026', '(Draft)', 'Education and\nInnovation']) {
      expect(danglingFinalWord(text), text).toBeNull();
    }
  });

  it('flags a Sorani block ending on a conjunction or preposition, in either keyboard spelling', () => {
    expect(danglingFinalWord('کۆنفرانسی پەروەردە و')).toBe('و');
    expect(danglingFinalWord('هەنگاوەکانی داهاتوو بەرەو')).toBe('بەرەو');
    // Arabic keyboard: kaf and yeh for keheh and Farsi yeh.
    expect(danglingFinalWord('بەرنامەكە لەگەڵ')).toBe('لەگەڵ');
    expect(danglingFinalWord('ئەمە بۆ ئێوەیە كە')).toBe('كە');
    expect(normaliseSorani('كوردي')).toBe('کوردی');
    expect(danglingFinalWord('کۆنفرانسی پەروەردە')).toBeNull();
    expect(danglingFinalWord('ئایا ئامادەن بۆ؟')).toBeNull();
  });

  it('finds brackets and quotes that do not pair', () => {
    expect(unbalancedMarks('Pilot study (phase one')).toEqual(['"(" is never closed']);
    expect(unbalancedMarks('phase one) report')).toEqual(['")" closes nothing']);
    expect(unbalancedMarks('He said "welcome')).toEqual(['an odd number of " marks']);
    expect(unbalancedMarks('“Welcome')).toEqual(['“ and ” do not pair']);
    expect(unbalancedMarks('(K-12) "Pilot" “study” «تاقیکردنەوە» [1]')).toEqual([]);
    // Right-to-left copy typed with the guillemets the other way round still pairs.
    expect(unbalancedMarks('»تاقیکردنەوە«')).toEqual([]);
    expect(checkCopyCompleteness({ 0: 'Pilot study (phase one' })[0]).toMatchObject({ code: 'COPY_UNBALANCED', copyIndex: 0 });
  });

  it('flags copy that arrived as a caption at the messenger limit, only when the origin is known', () => {
    expect(checkCopyCompleteness({ 0: 'Finished.' }, { origin: { kind: 'caption', length: 1024 } }).map((f) => f.code)).toEqual(['COPY_AT_CAPTION_LIMIT']);
    expect(checkCopyCompleteness({ 0: 'Finished.' }, { origin: { kind: 'caption', length: 400 } })).toEqual([]);
    expect(checkCopyCompleteness({ 0: 'Finished.' })).toEqual([]);
  });

  it('is pure: the same copy gives the same findings and is not changed', () => {
    const copy = { 0: 'next steps toward', 1: '(open' };
    const snapshot = JSON.stringify(copy);
    expect(checkCopyCompleteness(copy)).toEqual(checkCopyCompleteness(copy));
    expect(JSON.stringify(copy)).toBe(snapshot);
  });
});

describe('instruction language findings (ADR-157, audit P2 mixed script)', () => {
  const kurdishOnly = ['کۆنفرانسی پەروەردە', 'KAAE'];
  it('finds English asked for over copy that has none', () => {
    const findings = instructionLanguageFindings('Please make it in English and Kurdish', kurdishOnly);
    expect(findings.map((f) => f.code)).toEqual(['LANGUAGE_MISSING']);
    expect(findings[0].message).toContain('English');
  });

  it('reads the language names in Sorani too', () => {
    expect(instructionLanguageFindings('بە ئینگلیزی و کوردی بینووسە', kurdishOnly).map((f) => f.message)).toEqual([
      expect.stringContaining('English'),
    ]);
    expect(instructionLanguageFindings('بە کوردی', ['KAAE K-12 Pilot Study'])[0].message).toContain('Kurdish');
  });

  it('says nothing when the copy has the language, or the language is excluded', () => {
    expect(instructionLanguageFindings('English and Kurdish please', ['کۆنفرانسی پەروەردە', 'KAAE Education Conference'])).toEqual([]);
    expect(instructionLanguageFindings('no English please, only Kurdish', kurdishOnly)).toEqual([]);
    expect(instructionLanguageFindings(undefined, kurdishOnly)).toEqual([]);
    expect(instructionLanguageFindings('make it gold', kurdishOnly)).toEqual([]);
  });
});

describe('mixed-script copy split by line script (ADR-157, audit P2)', () => {
  it('splits a Sorani block with an English line into parts of one script each', () => {
    expect(splitCopyByLineScript('کۆنفرانسی پەروەردە\nKAAE Education Conference\n12/10/2026')).toEqual([
      { text: 'کۆنفرانسی پەروەردە', script: 'arabic' },
      { text: 'KAAE Education Conference\n12/10/2026', script: 'latin' },
    ]);
  });

  it('keeps a block of one script whole, byte for byte, numbers and blank lines included', () => {
    const latin = 'KAAE K-12 Pilot Study\n\n12 October 2026';
    expect(splitCopyByLineScript(latin)).toEqual([{ text: latin, script: 'latin' }]);
    const sorani = 'کۆنفرانسی پەروەردە\n٢٠٢٦';
    expect(splitCopyByLineScript(sorani)).toEqual([{ text: sorani, script: 'arabic' }]);
  });

  it('keeps a line that mixes both scripts with the Sorani text, as the block rule always did', () => {
    const line = 'ئەکادیمیای KAAE';
    expect(splitCopyByLineScript(line)).toEqual([{ text: line, script: 'arabic' }]);
  });
});
