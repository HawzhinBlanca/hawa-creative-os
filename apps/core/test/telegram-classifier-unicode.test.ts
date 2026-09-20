import { describe, expect, it } from 'vitest';
import { classifyWithHeuristics } from '../src/services/telegram-classifier.js';

/**
 * Intake read Kurdish with ASCII word boundaries and matched keywords as substrings, so real chat
 * traffic was routed wrongly: "سڵاو" on its own became a design task, and any short brief carrying
 * a styling word ("frame" inside "FRAMEWORK", "background", "navy") was answered as an instruction
 * with no copy and never drafted. These are the cases the audit found.
 */
describe('classifier: Kurdish greetings are not briefs', () => {
  const greetings: Array<[string, string]> = [
    ['سڵاو', 'bare Sorani greeting'],
    ['سڵاو بەخێربێن', 'Sorani greeting with a second word'],
    ['چۆنی', 'Sorani "how are you"'],
    ['hello', 'English greeting'],
    ['hey there', 'English greeting with a second word'],
  ];

  for (const [text, label] of greetings) {
    it(`treats ${label} as chatter, not a new brief`, () => {
      const res = classifyWithHeuristics(text, false);
      expect(res.intent).toBe('question_or_other');
      expect(res.kind).not.toBe('new_brief');
      expect(res.isInstructionOnly).toBe(false);
    });
  }

  it('does not treat a word that merely starts with a greeting as a greeting', () => {
    // "help" is a greeting-list word; "helpful" is not, and a brief must survive it.
    const res = classifyWithHeuristics('helpful layout for the launch poster copy below', false);
    expect(res.intent).toBe('new_brief');
  });
});

describe('classifier: whole-word keyword matching', () => {
  const briefs: Array<[string, string]> = [
    [
      'K-12 STANDARDS FRAMEWORK\nNational launch announcement for schools across the Kurdistan Region.',
      '"frame" inside FRAMEWORK',
    ],
    [
      'The coloured edition of the quality report goes to every partner university this month.',
      '"colour" inside coloured',
    ],
  ];

  for (const [text, label] of briefs) {
    it(`does not read ${label} as instruction-only`, () => {
      const res = classifyWithHeuristics(text, false);
      expect(res.isInstructionOnly).toBe(false);
      expect(res.intent).toBe('new_brief');
    });
  }

  it('still reads a genuine whole-word revision directive as feedback', () => {
    const res = classifyWithHeuristics('move the frame down a little', true);
    expect(res.intent).toBe('revision_feedback');
    expect(res.isInstructionOnly).toBe(true);
  });

  it('still reads a revision directive that uses the plural as feedback', () => {
    // The keyword list is written in the singular; clients are not.
    const res = classifyWithHeuristics('the colors are too dark for print', true);
    expect(res.intent).toBe('revision_feedback');
  });

  it('still reads a Kurdish revision directive as feedback', () => {
    const res = classifyWithHeuristics('ڕەنگەکە تۆختر بکە', true);
    expect(res.intent).toBe('revision_feedback');
  });
});

describe('classifier: a multi-paragraph message is never chatter or instruction-only', () => {
  it('keeps a short two-paragraph brief with styling words as a brief', () => {
    const text = 'KAAE STRATEGIC ROADMAP 2026\n\nFive priorities for the coming year. Use the navy background from the last one.';
    expect(text.length).toBeLessThan(200);
    const res = classifyWithHeuristics(text, false);
    expect(res.isInstructionOnly).toBe(false);
    expect(res.intent).toBe('new_brief');
  });

  it('keeps a brief that opens with a Kurdish greeting as a brief', () => {
    const text = 'سڵاو\n\nکۆنفرانسی ساڵانەی متمانەبەخشین\n\n٩ی ئەیلوولی ٢٠٢٦، هۆڵی سەعد عەبدوڵا';
    const res = classifyWithHeuristics(text, false);
    expect(res.intent).toBe('new_brief');
    expect(res.isInstructionOnly).toBe(false);
  });

  it('keeps a multi-paragraph brief out of the instruction-only refusal even with an active task', () => {
    const text = 'Annual report cover\n\nPlease change nothing in the wording below.\n\nQuality assurance in the Kurdistan Region, 2026 edition.';
    const res = classifyWithHeuristics(text, true);
    expect(res.isInstructionOnly).toBe(false);
  });

  // The multi-paragraph rule belongs to the instruction-only refusal alone. Gating the revision
  // branch on it too turned "Thanks!" followed by a correction into a whole new design.
  it('routes a revision written in two paragraphs to feedback, in English and in Kurdish', () => {
    for (const text of [
      'Thanks!\n\nplease change the background to navy',
      'ڕەنگەکە تۆختر بکە\n\nلۆگۆکە بەرزتر بکە',
    ]) {
      const res = classifyWithHeuristics(text, true);
      expect(res.intent).toBe('revision_feedback');
    }
  });

  it('still refuses to draft from a one-paragraph styling directive', () => {
    const res = classifyWithHeuristics('make it more gold and less crowded', false);
    expect(res.isInstructionOnly).toBe(true);
  });

  it('preserves a single-paragraph brief that starts with a greeting when it carries event details or design copy', () => {
    const text = 'سڵاو کاکە تکایە پۆستەرێکمان بۆ دروست بکەن بۆ سیمیناری ددان لە ٢٥ی مانگ لە هۆڵی سەعد عەبدوڵڵا';
    const res = classifyWithHeuristics(text, false);
    expect(res.intent).toBe('new_brief');
    expect(res.kind).toBe('new_brief');
    expect(res.isInstructionOnly).toBe(false);
  });

  it('preserves a single-paragraph brief phrased as a question when it carries substantial event copy', () => {
    const text = 'Can we design a poster for our dental workshop on September 25 at City Hall?';
    const res = classifyWithHeuristics(text, false);
    expect(res.intent).toBe('new_brief');
    expect(res.kind).toBe('new_brief');
    expect(res.isInstructionOnly).toBe(false);
  });
});

