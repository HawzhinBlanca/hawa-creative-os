import { admittedFontFaces, loadRenderFontRegistry, type FontScript } from '@hawa/creative';

/**
 * A typeface a reviewer asked for by name in chat feedback.
 *
 * The old typography branch of the Telegram feedback handler read only "Playfair" and
 * "Cormorant"; every other font remark, "use Calibri for Kurdish" included, was recorded as the
 * canned rule "Cinzel for headers, Playfair Display for prose, Plus Jakarta Sans for modern copy"
 * and echoed back to the sender as their applied preference. This module reads the face the
 * sender named, says which script they meant, and answers from the font registry whether the
 * studio can draw it, so the handler can apply the request or refuse it out loud, never invent one.
 */
export interface FontRequest {
  /** The family in registry spelling when it is one, else as the sender wrote it. */
  family: string;
  /** What the sender wrote, when the registry reads it as another family (an alias). */
  askedAs?: string;
  /** The text the sender wants it on; 'unspecified' when the message does not say. */
  script: FontScript | 'unspecified';
  /** True when the registry admits this family for the requested script (any script when unspecified). */
  available: boolean;
  /** The script the family is admitted for, when available. */
  admittedFor?: FontScript;
  /** Installed families for the requested script, offered when the asked face is not available. */
  alternatives: string[];
}

/**
 * Families a reviewer is likely to name that the studio does not carry. Detection needs a list
 * because a bare word like "Cairo" or "Amiri" is only a font when we already know it as one.
 */
const COMMONLY_NAMED_FONTS = [
  'Calibri', 'Carlito', 'Arial', 'Helvetica', 'Helvetica Neue', 'Tahoma', 'Segoe UI', 'Times New Roman',
  'Georgia', 'Cambria', 'Garamond', 'Baskerville', 'Futura', 'Gill Sans', 'Comic Sans', 'Trebuchet',
  'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Nunito', 'Raleway', 'Oswald', 'Rubik', 'Inter',
  'Lora', 'Cormorant Garamond', 'Cormorant', 'Bodoni', 'Bodoni Moda', 'Didot', 'Playfair',
  'Dubai', 'Sakkal Majalla', 'Traditional Arabic', 'Simplified Arabic', 'Tajawal', 'Almarai', 'Changa',
  'Markazi Text', 'Scheherazade', 'Harmattan', 'Lateef', 'Noto Naskh Arabic', 'Noto Kufi Arabic',
  'Rabar', 'UniKurd', 'Unikurd Jino', 'Ali K', 'Sarchia', 'Zanest', 'Kurdish Arial', 'NRT',
];

/**
 * Names that are also ordinary words in a design brief: a venue in Dubai, a speaker called Georgia,
 * the NRT logo, "inter alia". These count as a font only when the message also talks about type.
 */
const ORDINARY_WORDS = new Set(
  ['Dubai', 'Inter', 'Georgia', 'Changa', 'Futura', 'NRT', 'Ali K', 'Lora', 'Rubik', 'Oswald', 'Cairo', 'Lateef', 'Tahoma', 'Raleway', 'Nunito', 'Bodoni', 'Didot']
    .map((n) => n.toLowerCase())
);
const TYPE_CUE = /\b(font|fonts|typeface|typefaces|typography|serif|sans|bold|italic)\b|فۆنت|خەت/i;

/** Short forms senders use for registry families the registry itself does not alias. */
const SHORT_FORMS: Record<string, string> = {
  playfair: 'Playfair Display',
  'noto arabic': 'Noto Sans Arabic',
  'noto sans': 'Noto Sans Arabic',
  'ibm plex': 'IBM Plex Sans Arabic',
  plex: 'IBM Plex Sans Arabic',
  jakarta: 'Plus Jakarta Sans',
};

const ARABIC_SCRIPT_WORDS = /\b(kurdish|sorani|arabic|farsi|persian)\b|کوردی|سۆرانی|عەرەبی|عربي|فارسی/i;
const LATIN_SCRIPT_WORDS = /\b(english|latin)\b|ئینگلیزی|إنجليزي/i;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function scriptAskedFor(text: string): FontScript | 'unspecified' {
  const arabic = ARABIC_SCRIPT_WORDS.test(text);
  const latin = LATIN_SCRIPT_WORDS.test(text);
  if (arabic && !latin) return 'arabic';
  if (latin && !arabic) return 'latin';
  return 'unspecified';
}

/**
 * Family name -> script it can be drawn in. Measured from the font files when they are present
 * (a family the registry admits but whose file lacks the Kurdish letters, Cairo on 2026-09-20, is
 * not offered), and from the registry flag alone when this host has no font files.
 */
function drawableFamilies(registryPath?: string): Map<string, FontScript> {
  const out = new Map<string, FontScript>();
  let measured = false;
  for (const script of ['arabic', 'latin'] as const) {
    for (const role of ['display', 'body'] as const) {
      try {
        for (const face of admittedFontFaces({ script, role, registryPath })) out.set(face.name, script);
        measured = true;
      } catch {
        // No drawable face for this script and role on this host; the registry flag decides below.
      }
    }
  }
  if (measured) return out;
  const registry = loadRenderFontRegistry({ registryPath });
  for (const family of Object.values(registry.families || {})) {
    if (family.admitted) out.set(family.name, family.script);
  }
  return out;
}

/** Installed families for a script, in registry order. */
function installedFor(script: FontScript, registryPath?: string): string[] {
  return [...drawableFamilies(registryPath).entries()].filter(([, s]) => s === script).map(([name]) => name);
}

/**
 * Every typeface named in the message, longest names first so "Noto Sans Arabic" is not read as
 * "Noto" plus "Arabic", each reported once.
 */
export function detectFontRequests(text: string, options: { registryPath?: string } = {}): FontRequest[] {
  const registry = loadRenderFontRegistry({ registryPath: options.registryPath });
  const drawable = drawableFamilies(options.registryPath);
  const aliases: Record<string, string> = { ...(registry.aliases || {}) };
  for (const [short, family] of Object.entries(SHORT_FORMS)) aliases[short] = family;
  const known = [...new Set([...Object.keys(registry.families || {}), ...Object.keys(aliases), ...COMMONLY_NAMED_FONTS])]
    .sort((a, b) => b.length - a.length);
  // "use Cairo for Kurdish" names no font word, but a verb of choice beside a script word is the
  // same cue; "the venue is in Dubai" has neither.
  const talksAboutType =
    TYPE_CUE.test(text) ||
    (/\b(use|try|switch to|change to|set|put)\b/i.test(text) && (ARABIC_SCRIPT_WORDS.test(text) || LATIN_SCRIPT_WORDS.test(text)));

  const seen = new Set<string>();
  const requests: Array<{ name: string; family: string }> = [];
  let remaining = text;
  for (const name of known) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'iu');
    const match = remaining.match(pattern);
    if (!match) continue;
    if (ORDINARY_WORDS.has(name.toLowerCase()) && !talksAboutType) continue;
    const written = match[0];
    // Blank the match so a shorter name inside it ("Arabic" in "Noto Sans Arabic") is not read again,
    // and so the script words are read from what the sender said around the name, not the name.
    remaining = remaining.replace(new RegExp(pattern.source, 'giu'), (m) => ' '.repeat(m.length));
    const aliasKey = Object.keys(aliases).find((k) => k.toLowerCase() === name.toLowerCase());
    const family = aliasKey ? aliases[aliasKey] : name;
    const key = family.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({ name: written, family });
  }

  const script = scriptAskedFor(remaining);
  return requests.map(({ name, family }) => {
    const admittedFor = drawable.get(family);
    const available = admittedFor !== undefined && (script === 'unspecified' || admittedFor === script);
    const alternatives = available
      ? []
      : script === 'unspecified'
        ? [...installedFor('arabic', options.registryPath), ...installedFor('latin', options.registryPath)]
        : installedFor(script, options.registryPath);
    const askedAs = family.toLowerCase() !== name.toLowerCase() ? name : undefined;
    return { family, ...(askedAs ? { askedAs } : {}), script, available, admittedFor: available ? admittedFor : undefined, alternatives };
  });
}

export const scriptLabel = (script: FontScript | 'unspecified'): string =>
  script === 'arabic' ? 'Kurdish and Arabic' : script === 'latin' ? 'English' : 'all';

/** The line a sender is told when the face they asked for is not one the studio can draw. */
export function unavailableFontNotice(request: FontRequest): string {
  const where = request.script === 'unspecified' ? '' : ` for ${scriptLabel(request.script)} text`;
  const offer = request.alternatives.length
    ? `Installed${where}: ${request.alternatives.join(', ')}. Reply with one of these to use it.`
    : `No installed face is available${where}.`;
  const name = request.askedAs ? `${request.askedAs} (read as ${request.family})` : request.family;
  return `${name} is not installed in the studio, so it was not applied. ${offer}`;
}
