import { describe, it, expect } from 'vitest';
import { splitBilingualRequest } from '../src/services/chat-intake.js';
import { savedDesignCopy } from '../src/services/canva-design-planner.js';

// Task 89c242f2 (2026-09-19): the English copy sat under "Here is text to add on each of the kurdish
// and English graphics:" above the divider and was read as instructions; one Kurdish design was
// made. The owner wants one graphic per language.
const message = `Create a clean, professional bilingual KAAE graphic in English and Kurdish. Add a small gold CTA box near the bottom.
And only use Verdana font.

Here is text to add on each of the kurdish and English graphics:

K-12 STANDARDS FRAMEWORK
EDITION 2.0


Advancing quality and continuous improvement across K-12 education in the Kurdistan Region.


Now available at kaae.org.
_____________________________________
چوارچێوەی ستانداردەکانی پەروەردە (K-12)
چاپی 2.0


بەرزکردنەوەی کوالێتی و بەردەوامی پەرەپێدانی پەروەردە (K-12) لە هەرێمی کوردستان.


ئێستا لە kaae.org بەردەستە`;

describe('one graphic per language', () => {
  it('splits the English copy above the divider from the Kurdish copy below it', () => {
    const split = splitBilingualRequest(message)!;
    const en = savedDesignCopy({ rawRequestText: split.en }, '');
    const ckb = savedDesignCopy({ rawRequestText: split.ckb }, '');
    expect(en.copy).toEqual([
      'K-12 STANDARDS FRAMEWORK\nEDITION 2.0',
      'Advancing quality and continuous improvement across K-12 education in the Kurdistan Region.',
      'Now available at kaae.org.',
    ]);
    expect(ckb.copy).toHaveLength(3);
    expect(ckb.copy.every((b) => /[؀-ۿ]/.test(b))).toBe(true);
    for (const side of [en, ckb]) {
      expect(side.instructions).toContain('only use Verdana font');
      expect(side.instructions).not.toContain('K-12 STANDARDS');
    }
    expect(en.instructions).toContain('English copy only');
    expect(ckb.instructions).toContain('Kurdish copy only');
  });

  it('leaves every other request alone', () => {
    expect(splitBilingualRequest('Make it navy.\n_____\nچوارچێوەی ستانداردەکانی پەروەردە')).toBeNull();
    expect(splitBilingualRequest('Here is the text:\nTitle\n_____\nMore English copy')).toBeNull();
    expect(splitBilingualRequest('No divider here\nHere is the text:\nTitle')).toBeNull();
  });
});
