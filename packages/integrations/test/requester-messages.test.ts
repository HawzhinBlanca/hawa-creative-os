import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REQUESTER_CATALOGUE, bold, fill, requesterLang, say, type Phrase } from '../src/requester-messages/index.js';

/**
 * The requester message catalogue (ADR-145): what a requester hears never names a command, never asks
 * them to reply to a particular message, never asks for a format, never shows the office's own words,
 * and always exists in English and Sorani. Every Sorani line is on the native-review list.
 */
const phrases: Array<[string, Phrase]> = Object.entries(REQUESTER_CATALOGUE)
  .flatMap(([section, book]) => Object.entries(book).map(([name, phrase]) => [`${section}.${name}`, phrase as Phrase] as [string, Phrase]));

const placeholders = (text: string) => [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((m) => m[1]).sort();

describe('requester message catalogue', () => {
  it('has phrases in every section', () => {
    expect(phrases.length).toBeGreaterThan(20);
  });

  it.each(phrases)('%s exists in English and Sorani with the same placeholders', (_name, phrase) => {
    expect(phrase.en.trim()).not.toBe('');
    expect(phrase.ckb.trim()).not.toBe('');
    expect(requesterLang(phrase.en)).toBe('en');
    expect(requesterLang(phrase.ckb)).toBe('ckb');
    expect(placeholders(phrase.ckb)).toEqual(placeholders(phrase.en));
  });

  it.each(phrases)('%s asks for no command, reply target, format or office term', (name, phrase) => {
    // ADR-040 addendum: the office section speaks to office members, who may be told of Hawa Desk and
    // Canva; it still names no command, reply target, format, id or internal term.
    const office = name.startsWith('office.');
    for (const text of [phrase.en, phrase.ckb]) {
      // A slash command, anywhere ("/new", "/use_source", "/rules").
      expect(text).not.toMatch(/(?:^|[\s(“"«])\/[a-z_]{2,}/i);
      // "Reply to this message", "reply to its image", "reply directly to the revision notice".
      expect(text).not.toMatch(/\breply\s+(?:directly\s+)?to\b/i);
      // Exact formats: "Client: <code>", "Size: WxH", a divider line.
      expect(text).not.toMatch(/\bClient:|\bSize:|---/);
      // The office's own words.
      expect(text).not.toMatch(office ? /Task ID|task id|request id|\brevision\b|lifecycle|https?:\/\//i
        : /Task ID|task id|request id|\brevision\b|lifecycle|Hawa Desk|\bDesk\b|Canva|https?:\/\//i);
    }
  });

  it('the native-review list names every Sorani line', () => {
    const list = readFileSync(new URL('../../../plans/lean-design-implementation-2026-09-28/SORANI_REVIEW.md', import.meta.url), 'utf8');
    const missing = phrases.filter(([, phrase]) => !list.includes(phrase.ckb.replace(/\n/g, '⏎')));
    expect(missing.map(([name]) => name)).toEqual([]);
  });
});

describe('the language a requester is answered in', () => {
  it.each([
    ['Poster for our open day on Monday', 'en'],
    ['پۆستەرێک بۆ نەورۆز دروست بکە', 'ckb'],
    // Mixed: the script with more letters wins.
    ['KAAE پۆستەرێک بۆ ئاهەنگی دەرچوون دروست بکە', 'ckb'],
    ['Please make the KAAE poster for Nawroz, title: نەورۆز', 'en'],
    // A tie goes to Sorani: names and brands are often written in Latin letters.
    ['ab پێ', 'ckb'],
  ] as const)('"%s" → %s', (text, lang) => {
    expect(requesterLang(text)).toBe(lang);
  });

  it('a message without letters takes the fallback', () => {
    expect(requesterLang('👍')).toBe('en');
    expect(requesterLang('👍', 'ckb')).toBe('ckb');
    expect(requesterLang('12:30 ٢٠٢٦')).toBe('en');
    expect(requesterLang(undefined, 'ckb')).toBe('ckb');
  });

  it('fills placeholders and escapes a design name', () => {
    expect(fill('Hi {name}, {missing}', { name: 'Sara' })).toBe('Hi Sara, {missing}');
    expect(bold('A & <B>')).toBe('<b>A &amp; &lt;B&gt;</b>');
    expect(say({ en: 'Got {title}.', ckb: '{title} وەرگیرا.' }, 'ckb', { title: 'X' })).toBe('X وەرگیرا.');
  });
});
