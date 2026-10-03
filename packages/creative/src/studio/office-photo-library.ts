import { z } from 'zod';
import { PHOTO_SHOTS, QUIET_AREAS } from './art-direction/recipes.js';
import { normaliseSorani } from './copy-completeness.js';

/**
 * ADR-280: the office photo library. A client's own archive photographs (real people at real
 * events, never generated), kept outside git in a folder per client with a `library.json` manifest,
 * so a text-only request can be designed with one of the office's photographs through the existing
 * photo recipes. This module is the manifest's strict schema, the eligibility rules and the
 * deterministic retrieval. It reads no file and calls no model.
 *
 * The 2026-10-02 blind panel scored text-only posters at about 5.8/10 with imagery at 3.0/10; every
 * post the office publishes uses a photograph (DESIGN_PIPELINE_AUDIT.md section 4 item 9).
 */

export const OFFICE_PHOTO_LIBRARY_VERSION = 1 as const;
/** Bumped when the deterministic features change; ingestion recomputes features of an older version. */
export const OFFICE_PHOTO_FEATURES_VERSION = 1 as const;
/** The manifest's file name inside a client's library folder. */
export const OFFICE_PHOTO_LIBRARY_MANIFEST = 'library.json';
/** The image types the renderer, the Canva transfer and the studio's ContentPhoto accept. */
export const OFFICE_PHOTO_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type OfficePhotoMimeType = (typeof OFFICE_PHOTO_ALLOWED_TYPES)[number];

export const OFFICE_PHOTO_LIMITS = {
  /** A source file larger than this is skipped at ingestion and never loaded. */
  maxFileBytes: 25 * 1024 * 1024,
  /** A manifest larger than this is refused unread. */
  maxManifestBytes: 20 * 1024 * 1024,
  maxPhotos: 5000,
  maxSide: 16000,
  /** A photo whose short side is below this looks soft on a 1080x1350 design; it is never used. */
  minShortSide: 720,
  /** Under this sharpness (photo-analysis scale) a photo reads blurred; it is never used. */
  minSharpness: 0.3,
  /** Under this a photo reads soft; it ranks lower. */
  softSharpness: 0.45,
  /** The most photos one brief receives. */
  maxPicks: 3,
} as const;

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);
/** A human tag: short, one line, no markup. Matching ignores case. */
const TAG = z.string().trim().min(1).max(60).regex(/^[^\u0000-\u001f<>{}]+$/u);
const TEXT = z.string().trim().max(300).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f<>]*$/u);
const SHARE = z.number().min(0).max(1);

export const OFFICE_PHOTO_CONSENT = ['granted', 'not_required', 'not_granted', 'unknown'] as const;
export type OfficePhotoConsent = (typeof OFFICE_PHOTO_CONSENT)[number];

/** What a person at the office says about a photo. Every field is optional until someone reviews it. */
export const officePhotoTagsSchema = z.object({
  /** An English description for the art director (who, where, what is happening). Never copy. */
  description: TEXT.optional(),
  subjects: z.array(TAG).max(20).default([]),
  /** Event types or names: workshop, conference, field visit, signing, ceremony, ... */
  events: z.array(TAG).max(10).default([]),
  keywords: z.array(TAG).max(40).default([]),
  shot: z.enum(PHOTO_SHOTS).optional(),
  /** Whether recognisable people are in the photo. Unset means nobody has looked. */
  peoplePresent: z.boolean().optional(),
  /**
   * Whether the people shown agreed to the office publishing it (or none is needed: a public
   * ceremony the office was invited to photograph). A photo with people needs `granted` or `not_required`.
   */
  consent: z.enum(OFFICE_PHOTO_CONSENT).default('unknown'),
  /** The office's review: true means a person looked at it and it may be used. */
  usable: z.boolean().optional(),
  /** True when the image is generated or composited by a model. Such an image is never used. */
  generated: z.boolean().optional(),
  date: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).optional(),
  note: TEXT.optional(),
}).strict();
export type OfficePhotoTags = z.infer<typeof officePhotoTagsSchema>;

/** Measured on the stored pixels at ingestion, with no model call. Same bytes, same numbers. */
export const officePhotoFeaturesSchema = z.object({
  version: z.literal(OFFICE_PHOTO_FEATURES_VERSION),
  meanLuminance: SHARE,
  /** 0..1, variance of the Laplacian on a log scale (art-direction/photo-analysis.ts). */
  sharpness: SHARE,
  soft: z.boolean(),
  /** The calmest third of the photo, where a title can sit, or none. */
  quietArea: z.enum(QUIET_AREAS),
  quietLuminance: SHARE,
  bands: z.object({ top: z.number().min(0), bottom: z.number().min(0), left: z.number().min(0), right: z.number().min(0) }).strict(),
  salient: z.object({ x: SHARE, y: SHARE }).strict(),
  dominantColors: z.array(z.object({ hex: z.string().regex(/^#[0-9A-F]{6}$/), share: SHARE }).strict()).max(5),
}).strict();
export type OfficePhotoFeatures = z.infer<typeof officePhotoFeaturesSchema>;

export const OFFICE_PHOTO_EXCLUSIONS = [
  'excluded_by_office',
  'not_reviewed',
  'no_consent',
  'people_unknown',
  'consent_not_recorded',
  'generated',
  'too_small',
  'too_soft',
  'type_not_allowed',
] as const;
export type OfficePhotoExclusion = (typeof OFFICE_PHOTO_EXCLUSIONS)[number];

export const officePhotoEntrySchema = z.object({
  /** olp_ and the first 16 hex digits of the source file's sha256. */
  id: z.string().regex(/^olp_[0-9a-f]{16}$/),
  /** The source file's sha256: its identity, and what makes ingestion idempotent. */
  sha256: SHA256,
  /** The stored (upright, renderable) file's sha256, checked every time it is loaded. */
  storedSha256: SHA256,
  /** The stored file, relative to the client's library folder. */
  file: z.string().regex(/^photos\/[0-9a-f]{64}\.(jpg|png|webp)$/),
  /** The file's path inside the folder it was ingested from, for joining a tag sheet. */
  sourceName: z.string().min(1).max(300).regex(/^[^\u0000-\u001f]+$/u),
  mimeType: z.enum(OFFICE_PHOTO_ALLOWED_TYPES),
  fileBytes: z.number().int().positive().max(OFFICE_PHOTO_LIMITS.maxFileBytes),
  width: z.number().int().positive().max(OFFICE_PHOTO_LIMITS.maxSide),
  height: z.number().int().positive().max(OFFICE_PHOTO_LIMITS.maxSide),
  orientation: z.enum(['portrait', 'landscape', 'square']),
  features: officePhotoFeaturesSchema,
  tags: officePhotoTagsSchema,
  status: z.enum(['usable', 'excluded']),
  excludedReasons: z.array(z.enum(OFFICE_PHOTO_EXCLUSIONS)).max(OFFICE_PHOTO_EXCLUSIONS.length),
  ingestedAt: z.string().datetime(),
}).strict().superRefine((p, issue) => {
  if ((p.status === 'excluded') !== (p.excludedReasons.length > 0)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, message: 'status must be excluded exactly when excludedReasons is not empty' });
  }
  if (p.id !== `olp_${p.sha256.slice(0, 16)}`) issue.addIssue({ code: z.ZodIssueCode.custom, message: 'id must be olp_ and the first 16 hex digits of sha256' });
  if (p.orientation !== orientationOf(p.width, p.height)) issue.addIssue({ code: z.ZodIssueCode.custom, message: 'orientation does not match width and height' });
});
export type OfficePhotoEntry = z.infer<typeof officePhotoEntrySchema>;

export const officePhotoLibrarySchema = z.object({
  version: z.literal(OFFICE_PHOTO_LIBRARY_VERSION),
  clientId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  updatedAt: z.string().datetime(),
  photos: z.array(officePhotoEntrySchema).max(OFFICE_PHOTO_LIMITS.maxPhotos),
}).strict().superRefine((m, issue) => {
  const ids = new Set<string>();
  for (const p of m.photos) {
    if (ids.has(p.id)) issue.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate photo ${p.id}` });
    ids.add(p.id);
  }
});
export type OfficePhotoLibrary = z.infer<typeof officePhotoLibrarySchema>;

/** Parses a manifest strictly; throws a readable error naming the first problems. */
export function parseOfficePhotoLibrary(value: unknown): OfficePhotoLibrary {
  const parsed = officePhotoLibrarySchema.safeParse(value);
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(manifest)'}: ${i.message}`).join('; ');
    throw new Error(`OFFICE_PHOTO_LIBRARY_INVALID: ${problems}`);
  }
  return parsed.data;
}

export function orientationOf(width: number, height: number): 'portrait' | 'landscape' | 'square' {
  const ratio = width / height;
  return ratio > 1.05 ? 'landscape' : ratio < 0.95 ? 'portrait' : 'square';
}

/**
 * Why a photo may not be used, recomputed from its tags and features every time (the stored status is
 * not trusted on its own). Empty means usable. The rules:
 * - a person at the office must have reviewed it and marked it usable;
 * - a photo flagged without consent is never used, and one with people needs consent recorded;
 * - whether people are in it must be stated;
 * - a generated or composited image is never used (real people only, DESIGN_10_RESEARCH.md section 3);
 * - it must be large and sharp enough for a 1080x1350 design, and of an allowed type.
 */
export function officePhotoExclusions(photo: Pick<OfficePhotoEntry, 'tags' | 'width' | 'height' | 'mimeType'> & { features: Pick<OfficePhotoFeatures, 'sharpness'> }): OfficePhotoExclusion[] {
  const out: OfficePhotoExclusion[] = [];
  const t = photo.tags;
  if (t.usable === false) out.push('excluded_by_office');
  else if (t.usable !== true) out.push('not_reviewed');
  if (t.consent === 'not_granted') out.push('no_consent');
  if (t.peoplePresent === undefined) out.push('people_unknown');
  else if (t.peoplePresent && t.consent === 'unknown') out.push('consent_not_recorded');
  if (t.generated === true) out.push('generated');
  if (Math.min(photo.width, photo.height) < OFFICE_PHOTO_LIMITS.minShortSide) out.push('too_small');
  if (photo.features.sharpness < OFFICE_PHOTO_LIMITS.minSharpness) out.push('too_soft');
  if (!(OFFICE_PHOTO_ALLOWED_TYPES as readonly string[]).includes(photo.mimeType)) out.push('type_not_allowed');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------------------------

/** What retrieval reads of a request: its own words only. Nothing here is ever written on a design. */
export interface OfficePhotoBrief {
  /** The request's copy lines, exactly as given. */
  copy: string[];
  /** Event or subject words (the brief's subject tags, its occasion, the request's instructions). */
  eventWords?: string[];
  /** The copy's language, for the record; Sorani text is normalised before matching. */
  language?: string;
  /** A tone word or two (formal, celebratory), matched like a keyword. */
  tone?: string;
  /** Whether the brief is about people (a speaker, a delegation). Read from the words when absent. */
  peopleFocused?: boolean;
  /** The design's size: orientation fit and the cover scale are measured against it. */
  width: number;
  height: number;
  /** At most this many photos (1..3, default 3). */
  max?: number;
}

export interface OfficePhotoScore {
  relevance: number;
  keyword: number;
  event: number;
  people: number;
  quality: number;
  quiet: number;
  orientation: number;
  total: number;
}

export interface OfficePhotoPick {
  id: string;
  sha256: string;
  storedSha256: string;
  file: string;
  score: OfficePhotoScore;
  reasons: string[];
}

export interface OfficePhotoSelection {
  picks: OfficePhotoPick[];
  considered: number;
  eligible: number;
  /** How many photos each exclusion kept out (a photo can have several). */
  excluded: Partial<Record<OfficePhotoExclusion, number>>;
  /** The brief's words that retrieval matched on, after normalising. */
  briefTerms: string[];
  briefEvents: string[];
  peopleFocused: boolean;
}

/** Score weights. Relevance dominates; a photo with no relevance is never picked. */
export const OFFICE_PHOTO_WEIGHTS = { relevance: 0.45, people: 0.15, quality: 0.15, quiet: 0.1, orientation: 0.15 } as const;
/** A second or third photo must score at least this share of the first. */
export const OFFICE_PHOTO_COMPANION_SHARE = 0.85;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'this', 'that', 'these', 'those', 'are', 'was', 'were', 'will', 'our',
  'your', 'their', 'its', 'has', 'have', 'had', 'not', 'but', 'all', 'any', 'can', 'more', 'most', 'about', 'over', 'under',
  'new', 'who', 'what', 'when', 'where', 'which', 'how', 'why', 'you', 'they', 'them', 'his', 'her', 'she', 'him', 'one', 'two',
  'via', 'per', 'upon', 'also', 'than', 'then', 'there', 'here', 'out', 'off', 'only', 'just', 'very', 'such', 'each', 'other',
  'kaae', 'www', 'org', 'com', 'http', 'https', 'design', 'poster', 'graphic', 'post', 'please', 'make', 'use', 'need', 'text',
]);

/**
 * Event types the office posts about, each with the English words that name it. Tags and the brief
 * are both read through this list, so "forum" in the copy meets "conference" on a photo.
 */
export const OFFICE_EVENT_LEXICON: Record<string, string[]> = {
  workshop: ['workshop', 'training', 'bootcamp', 'masterclass', 'session'],
  conference: ['conference', 'forum', 'symposium', 'summit', 'congress', 'convention'],
  field_visit: ['visit', 'field', 'tour', 'inspection', 'site'],
  meeting: ['meeting', 'meet', 'met', 'delegation', 'roundtable', 'consultation'],
  ceremony: ['ceremony', 'graduation', 'award', 'celebration', 'anniversary', 'inauguration', 'launch', 'honour', 'honor'],
  partnership: ['partnership', 'agreement', 'mou', 'memorandum', 'signing', 'cooperation', 'collaboration', 'partner'],
  webinar: ['webinar', 'online', 'virtual', 'livestream'],
  accreditation: ['accreditation', 'accredited', 'evaluation', 'evaluator', 'peer', 'standard', 'quality', 'assurance', 'review'],
  occasion: ['eid', 'nowruz', 'newroz', 'holiday', 'greeting', 'congratulation', 'condolence'],
  call_for_applications: ['call', 'application', 'apply', 'nomination', 'recruitment', 'vacancy', 'registration'],
};

const PEOPLE_WORDS = new Set([
  'speaker', 'panel', 'panelist', 'student', 'teacher', 'guest', 'delegation', 'team', 'graduate', 'participant', 'winner',
  'minister', 'president', 'dean', 'rector', 'professor', 'prof', 'interview', 'welcome', 'keynote', 'host', 'trainer',
  'evaluator', 'member', 'staff', 'expert', 'leader', 'meeting', 'award', 'ceremony', 'people', 'portrait',
]);

/** One word as matching sees it: lowercase, Sorani spellings unified, a plain English plural made singular. */
function stem(word: string): string {
  if (!/^[a-z]+$/.test(word) || word.length <= 4) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ches|shes|xes|sses)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) return word.slice(0, -1);
  return word;
}

/** The distinct matching terms of some text, in order of first appearance. */
export function officePhotoTerms(texts: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    const words = normaliseSorani(text).toLowerCase().replace(/['’]s\b/g, '').split(/[^\p{L}\p{N}]+/u);
    for (const raw of words) {
      if (!raw || /^\p{N}+$/u.test(raw)) continue;
      const arabic = /[؀-ۿ]/.test(raw);
      if (raw.length < (arabic ? 2 : 3)) continue;
      const term = stem(raw);
      if (STOPWORDS.has(term) || seen.has(term)) continue;
      seen.add(term);
      out.push(term);
    }
  }
  return out;
}

const EVENT_BY_TERM = new Map<string, string>(
  Object.entries(OFFICE_EVENT_LEXICON).flatMap(([event, words]) => words.map((w) => [stem(w), event] as [string, string]))
);

/** The event types some terms name; an event id used as a tag (field_visit) names itself. */
export function officePhotoEvents(terms: string[], rawTags: string[] = []): string[] {
  const out = new Set<string>();
  for (const t of terms) { const e = EVENT_BY_TERM.get(t); if (e) out.add(e); }
  for (const tag of rawTags) {
    const id = tag.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (id in OFFICE_EVENT_LEXICON) out.add(id);
  }
  return [...out].sort();
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** How much the photo must be enlarged to cover the design (1 or less: no enlargement). */
function coverScale(photo: { width: number; height: number }, brief: { width: number; height: number }): number {
  return Math.max(brief.width / photo.width, brief.height / photo.height);
}

/**
 * The library photos for a brief, best first, with the reasons each was chosen. Deterministic: the
 * same manifest and brief give the same picks in the same order. Never returns an excluded,
 * unreviewed, consent-less or generated photo, and never one with nothing in common with the brief:
 * a photo of a different event is not passed off as this one, and with no relevant photo the design
 * stays typographic.
 */
export function selectOfficeLibraryPhotos(library: Pick<OfficePhotoLibrary, 'photos'>, brief: OfficePhotoBrief): OfficePhotoSelection {
  const max = Math.max(1, Math.min(OFFICE_PHOTO_LIMITS.maxPicks, Math.floor(brief.max ?? OFFICE_PHOTO_LIMITS.maxPicks)));
  const briefTerms = officePhotoTerms([...brief.copy, ...(brief.eventWords ?? []), brief.tone]);
  const briefTermSet = new Set(briefTerms);
  const briefEvents = officePhotoEvents(briefTerms, brief.eventWords ?? []);
  const peopleFocused = brief.peopleFocused ?? briefTerms.some((t) => PEOPLE_WORDS.has(t));
  const targetAspect = brief.width / brief.height;
  const excluded: Partial<Record<OfficePhotoExclusion, number>> = {};
  const scored: OfficePhotoPick[] = [];
  let eligible = 0;

  for (const photo of library.photos) {
    // The stored status and the recomputed rules must both allow the photo.
    const reasons = new Set<OfficePhotoExclusion>([...officePhotoExclusions(photo), ...photo.excludedReasons]);
    if (photo.status !== 'usable' && reasons.size === 0) reasons.add('excluded_by_office');
    if (reasons.size) {
      for (const r of reasons) excluded[r] = (excluded[r] ?? 0) + 1;
      continue;
    }
    eligible++;
    const t = photo.tags;
    const tagTerms = new Set(officePhotoTerms([...t.subjects, ...t.events, ...t.keywords, t.description, t.shot?.replace(/_/g, ' ')]));
    const matched = briefTerms.filter((term) => tagTerms.has(term));
    const photoEvents = officePhotoEvents([...tagTerms], [...t.events, ...t.subjects]);
    const sharedEvents = briefEvents.filter((e) => photoEvents.includes(e));
    const keyword = Math.min(1, matched.length / Math.min(4, Math.max(1, briefTermSet.size)));
    const event = sharedEvents.length ? 1 : 0;
    const relevance = round3(0.6 * keyword + 0.4 * event);
    if (relevance <= 0) continue;
    const people = peopleFocused ? (t.peoplePresent ? 1 : 0) : 0.5;
    const scale = coverScale(photo, brief);
    const resolution = scale <= 1 ? 1 : Math.max(0, Math.min(1, (1.6 - scale) / 0.6));
    const sharp = photo.features.sharpness;
    const sharpness = sharp >= OFFICE_PHOTO_LIMITS.softSharpness ? 1 : sharp / OFFICE_PHOTO_LIMITS.softSharpness;
    const quality = round3(0.6 * sharpness + 0.4 * resolution);
    const quiet = photo.features.quietArea === 'none' ? 0.3 : 1;
    const aspect = photo.width / photo.height;
    const orientation = round3(Math.min(aspect, targetAspect) / Math.max(aspect, targetAspect));
    const w = OFFICE_PHOTO_WEIGHTS;
    const total = round3(w.relevance * relevance + w.people * people + w.quality * quality + w.quiet * quiet + w.orientation * orientation);
    const why: string[] = [];
    if (matched.length) why.push(`matches the brief's words: ${matched.slice(0, 6).join(', ')}`);
    if (sharedEvents.length) why.push(`same kind of event: ${sharedEvents.join(', ').replace(/_/g, ' ')}`);
    if (peopleFocused) why.push(t.peoplePresent ? 'shows people, for a brief about people' : 'shows no people, though the brief is about people');
    why.push(photo.features.soft ? `soft (sharpness ${sharp})` : `sharp (sharpness ${sharp})`);
    if (scale > 1) why.push(`enlarged ${scale.toFixed(2)}x to cover ${brief.width}x${brief.height}`);
    why.push(photo.features.quietArea === 'none' ? 'no calm area for text' : `calm ${photo.features.quietArea} area for text`);
    why.push(`${photo.orientation} ${photo.width}x${photo.height}, fit to the format ${orientation}`);
    scored.push({
      id: photo.id, sha256: photo.sha256, storedSha256: photo.storedSha256, file: photo.file,
      score: { relevance, keyword: round3(keyword), event, people, quality, quiet, orientation, total },
      reasons: why,
    });
  }

  scored.sort((a, b) => b.score.total - a.score.total || b.score.relevance - a.score.relevance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const picks: OfficePhotoPick[] = [];
  for (const candidate of scored) {
    if (picks.length >= max) break;
    if (picks.length && candidate.score.total < picks[0].score.total * OFFICE_PHOTO_COMPANION_SHARE) break;
    picks.push(candidate);
  }
  return { picks, considered: library.photos.length, eligible, excluded, briefTerms, briefEvents, peopleFocused };
}
