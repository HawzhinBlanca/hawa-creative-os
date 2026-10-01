import { hexToLuminance } from '../composite-contrast.js';
import { brandTones } from './solver.js';

/**
 * ADR-236, re-pointed by ADR-238: the tone of a design's ground. The client's guideline is light
 * first: KAAE's 2025 Excellence Edition sets its pages on white. A dark ground (KAAE: the navy
 * gradient of its cover, KAAE Blue to Midnight) is for what calls for one: a cover or announcement,
 * an evening or dark invitation, a keynote or stage screen, a dark photo, or a requester who asks for
 * dark or navy in so many words.
 *
 * The requester's own words are read here, with no model call: "white background", "on cream",
 * "as per the brand guideline", "dark", "navy", "an evening reception". The brief records what was
 * read and the studio honours it over the layout model's own choice.
 */

export interface TonePreference {
  tone: 'light' | 'dark';
  /** For a light ground, which paper the words named: white, or cream. */
  ground?: 'white' | 'cream';
  /** The words that decided it, as written. */
  words: string;
  /** `colour`: the requester named a colour or a tone; `occasion`: the occasion calls for it. */
  basis: 'colour' | 'occasion';
}

/** `weak`: a word with other common senses ("light refreshments", "research paper"), read as a tone only next to a ground or a colour word. */
type Term = { re: RegExp; tone: 'light' | 'dark'; ground?: 'white' | 'cream'; basis: TonePreference['basis']; weak?: boolean };

// Latin terms match whole words. Sorani and Arabic ones match a whole word with the suffixes Sorani
// adds (-ی, -ە, -ەکە, -ێکی ...), which a plain \b cannot do for Arabic script.
const AR_END = '(?=$|[\\s،؛.,:!?؟"\'()«»\\-])';
const ar = (stem: string, suffixes = '[یێەکانوت]{0,5}') => new RegExp(`(?:^|[\\s،؛.,:!?؟"'()«»\\-])(${stem}${suffixes})${AR_END}`, 'u');
const en = (words: string) => new RegExp(`\\b(${words})\\b`, 'i');

const TERMS: Term[] = [
  // The client's brand guideline itself ("as per the brand guidelines"; requesters also call it the
  // brand's book): its pages are white.
  { re: en("(?:like|as in|as per|follow(?:ing)?|per) (?:the |our |its |kaae'?s? )?brand ?(?:guide(?:line)?s?|bo{2}k)|brand ?(?:guide(?:line)?s?|bo{2}k) (?:style|look|colou?rs?)"), tone: 'light', ground: 'white', basis: 'colour' },
  { re: ar('(?:ڕێنمایی|ڕێنماییەکانی) ?براند', ''), tone: 'light', ground: 'white', basis: 'colour' },
  { re: ar('براند ?بووک', ''), tone: 'light', ground: 'white', basis: 'colour' },
  { re: en('white|off-white'), tone: 'light', ground: 'white', basis: 'colour' },
  { re: en('cream|ivory|beige'), tone: 'light', ground: 'cream', basis: 'colour' },
  { re: en('paper'), tone: 'light', ground: 'cream', basis: 'colour', weak: true },
  { re: en('light|bright|pale'), tone: 'light', basis: 'colour', weak: true },
  { re: ar('سپی'), tone: 'light', ground: 'white', basis: 'colour' },
  { re: ar('کرێم'), tone: 'light', ground: 'cream', basis: 'colour' },
  { re: ar('ڕووناک'), tone: 'light', basis: 'colour', weak: true },
  { re: ar('کاڵ', '[یە]{0,2}'), tone: 'light', basis: 'colour', weak: true },
  { re: ar('(?:أبيض|بيضاء)', ''), tone: 'light', ground: 'white', basis: 'colour' },
  { re: en('dark|navy|midnight|deep blue|dark blue'), tone: 'dark', basis: 'colour' },
  { re: en('black'), tone: 'dark', basis: 'colour', weak: true },
  { re: ar('(?:تاریک|تۆخ|سورمەیی|نێڤی)'), tone: 'dark', basis: 'colour' },
  { re: ar('ڕەش'), tone: 'dark', basis: 'colour', weak: true },
  { re: ar('(?:داكن|داكنة|كحلي)', ''), tone: 'dark', basis: 'colour' },
  { re: ar('أسود', ''), tone: 'dark', basis: 'colour', weak: true },
  // Occasions the guideline sets on its navy gradient: its cover (p.0), and the evening and the stage.
  { re: en('evening|night|gala|dinner|banquet|keynote|on stage|stage screen|led screen|cover page|cover design|as a cover|announcement cover'), tone: 'dark', basis: 'occasion' },
  { re: ar('(?:ئێوارە|شەو|شەوێک|ئاهەنگی ?شەو)', '[یێەکان]{0,4}'), tone: 'dark', basis: 'occasion' },
  { re: ar('(?:مسائي|مسائية|عشاء|حفل ?عشاء)', ''), tone: 'dark', basis: 'occasion' },
];

/** Words after a colour that make it the colour of the text, not the ground: "white text". */
const TEXT_NOUN = /^(?:text|texts|font|fonts|letters?|lettering|writing|words?|title|titles|headline|type|logo|نووسین|نووسینەکان|فۆنت|پیت|پیتەکان|ناونیشان|لۆگۆ|خط|نص)/iu;
/** Words before a colour that negate it: "not dark", "no white", "without navy". */
const NEGATION = /(?:^|\s)(?:not|no|never|without|avoid|instead of|rather than|isn'?t|don'?t|نا|نەک|نەخێر|بێ|بەبێ|لا|بدون)\s+(?:\S+\s+)?$/iu;
/** Words near a colour that make it the ground: "white background", "on cream", "a dark navy overlay". */
const GROUND_NOUN = /(?:background|backdrop|ground|page|bg|canvas|theme|overlay|gradient|fade|scrim|باکگراوند|باگراوند|پاشبنەما|ڕەنگی ?پشت|خلفية)/iu;
/** Words after a weak tone word that make it a colour: "light colours", "a bright look". */
const COLOUR_NOUN = /^(?:colou?rs?|tones?|theme|version|design|look|style|mode|palette|ڕەنگ)/iu;

/**
 * The tone the requester asked for, or undefined. A colour that names the text ("white text") or is
 * negated ("not dark") is not a ground. When the words name both tones, a colour named with its ground
 * ("on a white background") decides; otherwise colour words beat occasion words, and two colour words
 * that disagree with no ground named decide nothing.
 */
export function tonePreferenceFromWords(text: string | undefined | null): TonePreference | undefined {
  const source = String(text ?? '');
  if (!source.trim()) return undefined;
  const found: Array<TonePreference & { at: number; grounded: boolean }> = [];
  for (const term of TERMS) {
    const re = new RegExp(term.re.source, term.re.flags.includes('g') ? term.re.flags : `${term.re.flags}g`);
    for (const m of source.matchAll(re)) {
      const word = m[1] ?? m[0];
      const at = (m.index ?? 0) + m[0].indexOf(word);
      const before = source.slice(Math.max(0, at - 24), at);
      const after = source.slice(at + word.length, at + word.length + 40).trim();
      if (NEGATION.test(before)) continue;
      const nextWords = after.split(/\s+/).slice(0, 2).join(' ');
      // "white text", "dark blue title", "white and gold letters": the colour of the copy.
      const next = after.split(/\s+/).slice(0, 3);
      const textAt = next.findIndex((w) => TEXT_NOUN.test(w));
      const groundAt = next.findIndex((w) => GROUND_NOUN.test(w));
      if (textAt >= 0 && (groundAt < 0 || textAt < groundAt)) continue;
      const grounded = GROUND_NOUN.test(nextWords) || GROUND_NOUN.test(before.split(/\s+/).slice(-3).join(' '));
      if (term.weak && !grounded && !COLOUR_NOUN.test(after)) continue;
      found.push({ tone: term.tone, ...(term.ground ? { ground: term.ground } : {}), words: word, basis: term.basis, at, grounded });
    }
  }
  if (!found.length) return undefined;
  const pick = (list: typeof found) => {
    const tones = new Set(list.map((f) => f.tone));
    if (tones.size !== 1) return undefined;
    const first = [...list].sort((a, b) => a.at - b.at)[0];
    // A light tone takes the paper any of its words named ("light cream background").
    const ground = first.tone === 'light' ? list.find((f) => f.ground)?.ground : undefined;
    return { tone: first.tone, ...(ground ? { ground } : {}), words: first.words, basis: first.basis } as TonePreference;
  };
  const grounded = found.filter((f) => f.grounded);
  if (grounded.length) return pick(grounded);
  const colours = found.filter((f) => f.basis === 'colour');
  if (colours.length) return pick(colours);
  return pick(found);
}

/** The palette colour a tone preference sets as the ground: the brand's paper, or its darkest blue. */
export function toneGroundHex(preference: Pick<TonePreference, 'tone' | 'ground'>, palette: string[]): string | undefined {
  if (!palette.length) return undefined;
  const tones = brandTones(palette);
  if (preference.tone === 'dark') return hexToLuminance(tones.navy) < 0.2 ? tones.navy : undefined;
  const paper = preference.ground === 'cream' ? tones.cream : tones.white;
  return hexToLuminance(paper) > 0.7 ? paper : undefined;
}

/** A photo's mean luminance (0..1) under which it is a dark hero: its ground may be navy. */
export const DARK_HERO_LUMINANCE = 0.28;

/**
 * The ground a photo recipe sits on (ADR-236). The requester's words decide first; then a dark
 * concept is kept only where the photo is dark; everything else is the light page, white unless the
 * requester named cream (ADR-238: the 2025 guideline's pages are white). The layout model's own
 * choice of navy for a bright photo with nothing asking for it is the habit the guideline corrects
 * (46 of 46 drafts before 2026-10-01 were navy).
 */
export function resolveSurfaceTone(input: {
  /** The concept's own choice, when the model made one. */
  requested?: 'navy' | 'cream';
  preference?: Pick<TonePreference, 'tone' | 'ground'>;
  /** The hero's mean luminance, when measured. */
  heroLuminance?: number;
}): { surfaceTone: 'navy' | 'cream'; paper: 'white' | 'cream' } {
  const paper = input.preference?.tone === 'light' && input.preference.ground === 'cream' ? 'cream' : 'white';
  if (input.preference) return { surfaceTone: input.preference.tone === 'dark' ? 'navy' : 'cream', paper };
  const darkHero = typeof input.heroLuminance === 'number' && input.heroLuminance < DARK_HERO_LUMINANCE;
  return { surfaceTone: darkHero && input.requested !== 'cream' ? 'navy' : 'cream', paper };
}
