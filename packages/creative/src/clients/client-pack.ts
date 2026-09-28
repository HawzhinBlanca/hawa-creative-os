import { readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { creativeAssetPath } from '../studio/asset-paths.js';

/**
 * Client packs (ADR-127, from studio-v2's client packs): one JSON file per client in
 * packages/creative/assets/clients, saying who the client is, which chats and words name it, which
 * formats it orders, and whether it is live or still being set up. Adding a client is a pack file,
 * not a code change.
 *
 * A pack carries no brand authority. The palette, type, logo and rules a design is made with come
 * from the client's active, versioned Client DNA (apps/core/src/services/client-design-reference.ts),
 * which refuses a client without one; KAAE's packaged transitional reference stays KAAE-only there.
 * A pack decides routing, the default canvas and whether an automatic draft may start.
 */

/** Named canvas sizes a client orders. The studio accepts 640..2400 px on each side. */
export const FORMAT_PRESETS = {
  'social-portrait': { width: 1080, height: 1350, aspect: '4:5', label: 'Social post (portrait)' },
  'social-square': { width: 1080, height: 1080, aspect: '1:1', label: 'Social post (square)' },
  'story-reel': { width: 1080, height: 1920, aspect: '9:16', label: 'Story, reel or short' },
  'youtube-thumbnail': { width: 1280, height: 720, aspect: '16:9', label: 'YouTube thumbnail' },
  'landscape-hd': { width: 1920, height: 1080, aspect: '16:9', label: 'Landscape banner' },
} as const;

export type FormatPresetName = keyof typeof FORMAT_PRESETS;
const formatPresetName = z.enum(Object.keys(FORMAT_PRESETS) as [FormatPresetName, ...FormatPresetName[]]);

/** What an onboarding client still needs before it can go live. */
const onboardingItem = z.enum([
  'logo',
  'palette',
  'fonts',
  'client-dna',
  'telegram-chats',
  'language',
  'kurdish-aliases',
  'proof-set',
]);

const lowerCaseWord = z
  .string()
  .min(2)
  .refine((s) => s === s.toLowerCase() && s.trim() === s, 'aliases are lower case with no outer spaces');

export const clientPackSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** The hawa.clients row. Stable forever: tasks, DNA and publications point at it. */
    id: z.string().uuid(),
    code: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
    status: z.enum(['live', 'onboarding']),
    kind: z.enum(['institution', 'podcast', 'news', 'brand']),
    /** What the requester is shown, and the row's name. */
    displayName: z.string().min(2),
    names: z.object({ en: z.string().min(2), ckb: z.string().min(1).optional(), ar: z.string().min(1).optional() }),
    /** Languages the client's copy is written in, main one first. Empty until the office says. */
    languages: z.array(z.enum(['ckb', 'ar', 'en'])),
    routing: z.object({
      /** Telegram chat ids (as strings) whose requests are this client's, before any word is read. */
      telegramChatIds: z.array(z.string().regex(/^-?\d{3,20}$/)),
      /** Latin words or phrases that name the client, matched as whole words. */
      latinAliases: z.array(lowerCaseWord.refine((s) => /^[a-z0-9 .&'-]+$/.test(s), 'latin aliases use a-z, digits and spaces')),
      /** Kurdish or Arabic words that name the client, matched as whole words with a Sorani suffix allowed. */
      scriptAliases: z.array(z.string().min(2)),
      /** Exact phrases that name the client wherever they appear in the message. */
      phrases: z.array(z.string().min(3)),
    }),
    formats: z.array(formatPresetName).min(1),
    defaultFormat: formatPresetName,
    playbook: z.enum(['institutional-announcement', 'video-thumbnail']),
    onboarding: z.object({ missing: z.array(onboardingItem) }),
  })
  .strict()
  .superRefine((pack, ctx) => {
    if (!pack.formats.includes(pack.defaultFormat)) {
      ctx.addIssue({ code: 'custom', path: ['defaultFormat'], message: `defaultFormat ${pack.defaultFormat} is not one of the pack's formats` });
    }
    if (pack.status === 'live' && pack.onboarding.missing.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['status'], message: 'a live client lists nothing missing' });
    }
    if (pack.status === 'onboarding' && pack.onboarding.missing.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['onboarding'], message: 'an onboarding client lists what it still needs' });
    }
  });

export type ClientPack = z.infer<typeof clientPackSchema>;

export class ClientPackError extends Error {}

/** Checks that hold across packs: nothing that names or identifies a client may name two. */
export function assertPacksConsistent(packs: ClientPack[]): void {
  const owners = new Map<string, string>();
  const claim = (kind: string, value: string, code: string) => {
    const key = `${kind}:${value}`;
    const previous = owners.get(key);
    if (previous && previous !== code) throw new ClientPackError(`${kind} "${value}" is claimed by both ${previous} and ${code}`);
    owners.set(key, code);
  };
  for (const pack of packs) {
    claim('id', pack.id, pack.code);
    claim('code', pack.code, pack.code);
    for (const chat of pack.routing.telegramChatIds) claim('telegram chat', chat, pack.code);
    for (const alias of [...pack.routing.latinAliases, ...pack.routing.scriptAliases, ...pack.routing.phrases]) {
      claim('alias', alias.toLowerCase(), pack.code);
    }
  }
}

/** Parses and cross-checks a set of pack documents. */
export function parseClientPacks(documents: Array<{ source: string; json: unknown }>): ClientPack[] {
  const packs = documents.map(({ source, json }) => {
    const parsed = clientPackSchema.safeParse(json);
    if (!parsed.success) {
      throw new ClientPackError(`${source}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(pack)'}: ${i.message}`).join('; ')}`);
    }
    if (!source.endsWith(`${parsed.data.code}.json`)) {
      throw new ClientPackError(`${source}: the file is named after the pack's code (${parsed.data.code}.json)`);
    }
    return parsed.data;
  });
  assertPacksConsistent(packs);
  return packs.sort((a, b) => a.code.localeCompare(b.code));
}

let cached: ClientPack[] | undefined;

/** Every client pack in packages/creative/assets/clients, validated. Read once per process. */
export function loadClientPacks(): ClientPack[] {
  if (cached) return cached;
  const dir = creativeAssetPath('clients');
  const documents = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({ source: `clients/${file}`, json: JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as unknown }));
  cached = parseClientPacks(documents);
  return cached;
}

/** The pack for a client id or code (or the legacy `client-<code>` form), or undefined. */
export function findClientPack(idOrCode: string | null | undefined, packs: ClientPack[] = loadClientPacks()): ClientPack | undefined {
  if (!idOrCode) return undefined;
  const key = idOrCode.toLowerCase();
  return packs.find((p) => p.id === key || p.code === key || `client-${p.code}` === key);
}

/** The pack a Telegram chat is bound to, or undefined. */
export function clientPackForChat(chatId: string | number | null | undefined, packs: ClientPack[] = loadClientPacks()): ClientPack | undefined {
  if (chatId === null || chatId === undefined) return undefined;
  const id = String(chatId);
  return packs.find((p) => p.routing.telegramChatIds.includes(id));
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LETTER = '[\\p{L}\\p{N}\\p{M}_]';
/** Common Sorani suffixes a name carries in running text ("KAAEی", "هەڵوێستەکان"). */
const SORANI_SUFFIX = '(?:ی|یە|ە|یش|ەکان|کان|ەکە|کە)?';

/** Whether a pack's words name the client in this message. */
export function packNamedIn(pack: ClientPack, rawText: string, normalizedText: string = rawText): boolean {
  const lower = rawText.toLowerCase();
  // Latin: the left edge is a Unicode letter class (a Latin name welded into a Kurdish word is not a
  // match); the right edge is ASCII so a Sorani suffix may follow ("KAAEی" is still KAAE).
  const latin = pack.routing.latinAliases.some((alias) =>
    new RegExp(`(?<!${LETTER})${escapeRegex(alias).replace(/ /g, '\\s+')}(?![A-Za-z0-9_])`, 'u').test(lower)
  );
  if (latin) return true;
  const script = pack.routing.scriptAliases.some((alias) =>
    new RegExp(`(?<!${LETTER})${escapeRegex(alias)}${SORANI_SUFFIX}(?!${LETTER})`, 'u').test(normalizedText)
  );
  if (script) return true;
  return pack.routing.phrases.some((phrase) => rawText.includes(phrase) || normalizedText.includes(phrase));
}

export type ClientMatch =
  | { kind: 'chat'; pack: ClientPack }
  | { kind: 'named'; pack: ClientPack }
  | { kind: 'ambiguous'; packs: ClientPack[] }
  | { kind: 'none' };

/**
 * Which client a request belongs to: the chat's bound client first, then the one client its words
 * name. Two named clients is ambiguous and routes nowhere: the office assigns it, because a guess
 * attributes the request, and the brand used to draft it, to the wrong client.
 */
export function matchClientPack(
  input: { chatId?: string | number | null; rawText: string; normalizedText?: string },
  packs: ClientPack[] = loadClientPacks()
): ClientMatch {
  const bound = clientPackForChat(input.chatId, packs);
  if (bound) return { kind: 'chat', pack: bound };
  const named = packs.filter((pack) => packNamedIn(pack, input.rawText, input.normalizedText ?? input.rawText));
  if (named.length === 1) return { kind: 'named', pack: named[0] };
  if (named.length > 1) return { kind: 'ambiguous', packs: named };
  return { kind: 'none' };
}

/** The canvas a client's request gets when it names no size. */
export function defaultCanvasFor(pack: ClientPack): { width: number; height: number; aspect: string; preset: FormatPresetName } {
  const preset = FORMAT_PRESETS[pack.defaultFormat];
  return { width: preset.width, height: preset.height, aspect: preset.aspect, preset: pack.defaultFormat };
}
