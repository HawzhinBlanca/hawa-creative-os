import { describe, expect, it } from 'vitest';
import { readIntentByRules, readsAsChange } from '../src/services/requester-turn.js';

// Live 2026-10-02 (L19): edits worded with "take … out", "leave … off" or "get rid of" were not change words,
// so "can you take KAAE's out of the title? just Quality Assurance Workshop" read as a short new brief.
describe('change verbs that remove a part', () => {
  it.each([
    "can you take KAAE's out of the title? just Quality Assurance Workshop",
    'can you take Spring out of the title? just Concert',
    'please leave the date off the poster',
    'get rid of the border around the logo',
    'drop the subtitle',
    'delete the second line of the title',
  ])('"%s" is a change', (words) => {
    expect(readsAsChange(words)).toBe(true);
    expect(readIntentByRules(words).intent).toBe('change');
  });

  it.each(['keep going', 'take care', 'I will get back to you', 'Can you make a poster for the Quality Assurance Workshop on 15 October at 9:30 AM in the Rotana Hotel?'])(
    '"%s" is not a change', (words) => {
      expect(readIntentByRules(words).intent).not.toBe('change');
    });
});
