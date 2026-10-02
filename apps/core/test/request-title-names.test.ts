import { describe, expect, it } from 'vitest';
import { requestTitle, spokenTitle } from '../src/services/request-title.js';

// Live 2026-10-02 (canary chat): "Hi, could you please make a Canary Test poster for the Autumn Fair on 1 November
// 2026 …" was titled "Canary Test poster for the Autumn Fair on 1 N…".
describe('a design named after a client name and "for the"', () => {
  it.each([
    ['Hi, could you please make a Canary Test poster for the Autumn Fair on 1 November 2026 at 10 AM in the Main Hall, Erbil', 'Autumn Fair'],
    ['a KAAE poster for the Graduation Day', 'Graduation Day'],
    ['Please make a Canary Test poster for Science Week on 3 November 2026 at 9 AM in the Main Hall, Erbil. Size: 3508x4961', 'Science Week'],
    ['Can you make a poster for the Quality Assurance Workshop on 15 October 2026 at 9:30 AM?', 'Quality Assurance Workshop'],
  ])('"%s" → "%s"', (line, name) => {
    expect(spokenTitle(line)).toBe(name);
  });
  it('a lower-case subject keeps its words ("Poster for the graduation ceremony")', () => {
    expect(spokenTitle('Hi, we need a poster for the graduation ceremony')).toBe('Poster for the graduation ceremony');
  });
  it('the request title carries the client label once', () => {
    expect(requestTitle({ headline: 'Hi, could you please make a Canary Test poster for the Autumn Fair on 1 November 2026 at 10 AM', label: 'Canary', clientLabel: true }))
      .toBe('Canary: Autumn Fair…');
  });
});
