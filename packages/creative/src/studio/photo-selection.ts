import type { CustomerPhotoPolicy } from '@hawa/contracts';
import { normaliseSorani } from './copy-completeness.js';

/**
 * Whether a design must place every photo the client sent, or may choose among them (ADR-157).
 *
 * The validator refused any design that did not place every content photo, so "choose the best
 * photos" could not be honoured: six field-visit photos became a six-photo grid however the
 * requester phrased it. The mode is read from the requester's own words, deterministically and
 * with no model call; anything not clearly a choice is `all`, which is what every design did.
 */
export interface PhotoSelection {
  mode: 'all' | 'choose';
  /** The fewest photos a design may place. Equal to the photo count in `all` mode. */
  minimum: number;
  /** Explicit structured requester count, when exactly this many photos are required. */
  maximum?: number;
  /** The phrase that set `choose`, for the record. */
  matched?: string;
  /**
   * The requester explicitly said every photo ("use all the photos", or a count that covers them all).
   * ADR-180: only then must an art-direction recipe place every photo.
   */
  insisted?: boolean;
  /**
   * The requester stated how many ("pick 3"). ADR-180: that count binds an art-direction recipe; the
   * half-the-photos guess made when none is stated does not.
   */
  counted?: boolean;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const PHOTO = '(?:photos?|pictures?|pics?|images?|shots?|ones)';
/** What follows "all" or "the best" when photos are meant: a photo word, "them", or the clause's end. */
const TAIL = `(?:\\s+(?:of\\s+)?(?:the\\s+|these\\s+|those\\s+|my\\s+)?(?:${PHOTO}|them)\\b|\\s*(?:$|[.,;!]))`;

/**
 * English phrases that give the designer the choice. Each is specific to photos or to choosing:
 * "use the best colours" or "pick a date" do not match.
 */
const ENGLISH_CHOICE: RegExp[] = [
  new RegExp(`\\b(?:do not|don'?t|dont|no need to|not necessary to|needn'?t|doesn'?t have to|does not have to)\\s+(?:have to\\s+|need to\\s+)?(?:use|include|put|place|add)\\s+(?:all|every|each)${TAIL}`, 'i'),
  new RegExp(`\\bnot\\s+(?:all|every)\\s+(?:of\\s+)?(?:the\\s+|these\\s+|those\\s+|my\\s+)?${PHOTO}`, 'i'),
  new RegExp(`\\b(?:choose|pick|select|use)\\s+(?:only\\s+)?(?:the\\s+)?(?:best|nicest|strongest|good|better)${TAIL}`, 'i'),
  new RegExp(`\\b(?:choose|pick|select)\\s+(?:from|among|between|some\\s+of)\\s+(?:the\\s+|these\\s+|those\\s+|my\\s+)?(?:${PHOTO}|them)\\b`, 'i'),
  new RegExp(`\\b(?:some|a few|any)\\s+of\\s+(?:the|these|those|my)\\s+${PHOTO}`, 'i'),
  new RegExp(`\\b(?:whichever|which ever)\\s+${PHOTO}`, 'i'),
];

/** "pick 3", "use four of them", "choose 2 photos". */
const ENGLISH_COUNT = new RegExp(
  `\\b(?:choose|pick|select|use|only|just)\\s+(?:the\\s+best\\s+)?(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\\b(?:\\s+(?:of|from)\\s+(?:the|these|those|them|my)\\b|\\s+${PHOTO}|\\s*(?:$|[.,;!]))`,
  'i'
);

/**
 * Sorani phrases, in the form `normaliseSorani` produces: choose (هەڵبژێر…) with photo or best,
 * "the best" photos or ones, "not necessary … all", "some of the photos". Listed for native review
 * in SORANI_REVIEW.md.
 */
const SORANI_CHOICE: RegExp[] = [
  /هەڵبژێر[^.!\u061F\n]{0,40}(?:وێنە|باشترین)|(?:وێنە|باشترین)[^.!\u061F\n]{0,40}هەڵبژێر/u,
  /باشترین\s*(?:وێنە|یەکان|ەکان|دانە)/u,
  /(?:پێویست\s*(?:نییە|ناکات)|مەرج\s*نییە|پێویست\s*نیە)[^.!\u061F\n]{0,40}هەموو/u,
  /هەموو\s*وێنەکان[^.!\u061F\n]{0,30}(?:مەخە|دامەنێ|بەکار\s*مەهێنە|پێویست\s*نییە)/u,
  /هەندێک\s*(?:لە\s*)?وێنە/u,
];

/** A count in Arabic-Indic or Extended Arabic-Indic digits, before a photo word: "٣ وێنە". */
const SORANI_COUNT = /([0-9\u0660-\u0669\u06F0-\u06F9]{1,2})\s*(?:دانە\s*)?(?:وێنە|لە\s*وێنەکان)/u;

function digitsToNumber(text: string): number {
  return Number(text.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0)));
}

/**
 * The photo mode the requester's instructions ask for. `choose` needs a choice phrase; a count
 * given with it ("pick the best 3") is the minimum, else half the photos, rounded up. A request
 * with fewer than two photos has nothing to choose between.
 */
/**
 * "Use all the photos", "include every picture", "all 6 photos", and the Sorani "all the photos"
 * with a verb of using or putting: the requester wants each photo on the design (ADR-170).
 */
const ENGLISH_ALL = new RegExp(
  `\\b(?:use|include|put|place|add|show|with|keep)\\s+(?:all|every|each)\\s+(?:of\\s+)?(?:the\\s+|these\\s+|those\\s+|my\\s+)?(?:\\d{1,2}\\s+|two\\s+|three\\s+|four\\s+|five\\s+|six\\s+)?${PHOTO}|\\ball\\s+(?:\\d{1,2}|two|three|four|five|six)\\s+${PHOTO}|\\b(?:every|each)\\s+(?:photo|picture|image)\\s+(?:must|should|has to|needs to)\\b`,
  'i'
);
const SORANI_ALL = /هەموو\s*(?:ئەم\s*)?وێنەکان[^.!\u061F\n]{0,30}(?:بەکار\s*بهێنە|دابنێ|بخە|تێدا\s*بێت|دانێ)/u;

export function photoSelectionFromInstructions(instructions: string | undefined, photoCount: number): PhotoSelection {
  const all: PhotoSelection = { mode: 'all', minimum: Math.max(0, photoCount) };
  if (!instructions?.trim() || photoCount < 2) return all;
  const text = normaliseSorani(instructions);
  const phrase = [...ENGLISH_CHOICE, ...SORANI_CHOICE].map((p) => text.match(p)?.[0]).find(Boolean);
  const count = text.match(ENGLISH_COUNT) ?? text.match(SORANI_COUNT);
  // Asked for every photo, and nothing gives the design a choice: a recipe must place them all.
  if (!phrase && !count) return ENGLISH_ALL.test(text) || SORANI_ALL.test(text) ? { ...all, insisted: true } : all;
  const stated = count ? NUMBER_WORDS[count[1].toLowerCase()] ?? digitsToNumber(count[1]) : NaN;
  // A count alone ("use 3 of them") is a choice; "use all 6" never matches the count pattern.
  const minimum = Number.isFinite(stated) && stated >= 1 ? Math.min(photoCount, stated) : Math.ceil(photoCount / 2);
  // "Pick 6" of six photos is every photo, in so many words.
  if (minimum >= photoCount) return Number.isFinite(stated) && stated >= 1 ? { ...all, insisted: true } : all;
  return { mode: 'choose', minimum, matched: (phrase ?? count![0]).trim(), ...(Number.isFinite(stated) && stated >= 1 ? { counted: true } : {}) };
}

/** The selection a stored or inherited record states, checked, or undefined when it is not one. */
export function photoSelectionOrUndefined(value: unknown, photoCount: number): PhotoSelection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { mode, minimum, maximum, matched, insisted, counted } = value as Record<string, unknown>;
  if (mode === 'all') return { mode: 'all', minimum: photoCount, ...(insisted === true ? { insisted: true } : {}) };
  if (mode !== 'choose' || typeof minimum !== 'number' || !Number.isInteger(minimum) || minimum < 1) return undefined;
  if(maximum!==undefined && (typeof maximum!=='number' || !Number.isInteger(maximum) || maximum<minimum || maximum>photoCount))return undefined;
  return { mode: 'choose', minimum: Math.min(photoCount, minimum), ...(maximum!==undefined ? {maximum:maximum as number} : {}), ...(typeof matched === 'string' ? { matched } : {}), ...(counted === true ? { counted: true } : {}) };
}

/**
 * ADR-180 (owner decision, 2026-09-30: designs follow the "office house style"): the fewest photos an
 * art-direction recipe must place. Only the requester's own words bind it: "use all the photos"
 * binds every photo, and a stated count ("pick 3") binds that count. "Choose the best ones" with no
 * count, or photos sent with nothing said about them, leaves the composition free to choose
 * one or several meaningful photos (owner clarification, ADR-181). The photos left out are
 * recorded for office review. This supersedes ADR-171's default minimum (half the photos, or all of
 * them) for recipes; a layout outside a recipe keeps ADR-157's rule.
 */
export function recipePhotoMinimum(selection: PhotoSelection | undefined, photoCount: number): number {
  if (photoCount <= 0) return 0;
  if (selection?.mode === 'all' && selection.insisted) return photoCount;
  if (selection?.mode === 'choose' && selection.counted) return Math.max(1, Math.min(photoCount, selection.minimum));
  return 1;
}

/** The photos a design leaves out, by photoIndex, in order. */
export function omittedPhotoIndices(placed: Array<{ photoIndex: number }> | undefined, photoCount: number): number[] {
  const used = new Set((placed ?? []).map((p) => p.photoIndex));
  return Array.from({ length: Math.max(0, photoCount) }, (_, i) => i).filter((i) => !used.has(i));
}

/** The line the layout model reads about choosing, or '' when every photo is placed. */
export function photoSelectionPrompt(selection: PhotoSelection | undefined, photoCount: number): string {
  if (!selection || selection.mode !== 'choose') return '';
  if(selection.maximum!==undefined)return `The requester requires exactly ${selection.minimum} photos. Choose the strongest ${selection.minimum} of ${photoCount}; each chosen photo appears once and all other photos are left out.`;
  return (
    `The client lets you choose among the photographs: place at least ${selection.minimum} of the ${photoCount}, ` +
    `the ones that make the strongest design, each chosen photo once with its own photoIndex, and leave the others out. ` +
    `Placing all ${photoCount} is allowed only when the composition is genuinely better for it.`
  );
}

/** Explicit website controls outrank descriptive words; models cannot drop a source photo by reclassifying it. */
export function customerPhotoSelection(policy:CustomerPhotoPolicy|undefined,instructions:string,photoCount:number):PhotoSelection {
  if(!policy) return photoSelectionFromInstructions(instructions,photoCount);
  if(policy.photoCount!==photoCount) throw new Error('The admitted customer photo set changed');
  if(policy.usage.mode==='auto') {
    const selected=photoSelectionFromInstructions(instructions,photoCount);
    // Website automatic use follows the owner's flexible-composition direction.
    // Preserve an explicit all/count phrase; a legacy implicit-all default must
    // not force every upload into a non-recipe standard composition.
    return selected.mode==='all' && !selected.insisted
      ? {mode:'choose',minimum:Math.min(1,photoCount),matched:'Automatic website composition'} : selected;
  }
  if(policy.usage.mode==='all')return {mode:'all',minimum:photoCount,insisted:true};
  if(policy.usage.mode!=='count')throw new Error('Invalid customer photo use');
  const count=policy.usage.count;
  if(!Number.isInteger(count) || count<1 || count>photoCount)throw new Error('Invalid customer photo count');
  return count===photoCount ? {mode:'all',minimum:photoCount,insisted:true} :
    {mode:'choose',minimum:count,maximum:count,counted:true,matched:'Explicit website photo count'};
}
