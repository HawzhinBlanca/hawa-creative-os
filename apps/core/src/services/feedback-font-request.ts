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

/** Family name -> scripts it is admitted for, from the registry alone (no font files consulted). */
function admittedByRegistry(registryPath?: string): Map<string, FontScript> {
  const registry = loadRenderFontRegistry({ registryPath });
  const out = new Map<string, FontScript>();
  for (const family of Object.values(registry.families || {})) {
    if (family.admitted) out.set(family.name, family.script);
  }
  return out;
}

/**
 * Installed families for a script, display faces first: drawable on this host when the files are
 * present, else by registry flag. Both roles are offered, because the sender did not say which.
 */
function installedFor(script: FontScript, registryPath?: string): string[] {
  try {
    const names = (['display', 'body'] as const).flatMap((role) =>
      admittedFontFaces({ script, role, registryPath }).map((face) => face.name)
    );
    return [...new Set(names)];
  } catch {
    return [...admittedByRegistry(registryPath).entries()].filter(([, s]) => s === script).map(([name]) => name);
  }
}

/**
 * Every typeface named in the message, longest names first so "Noto Sans Arabic" is not read as
 * "Noto" plus "Arabic", each reported once.
 */
export function detectFontRequests(text: string, options: { registryPath?: string } = {}): FontRequest[] {
  const registry = loadRenderFontRegistry({ registryPath: options.registryPath });
  const admitted = admittedByRegistry(options.registryPath);
  const aliases = registry.aliases || {};
  const known = [...new Set([...admitted.keys(), ...Object.keys(registry.families || {}), ...Object.keys(aliases), ...COMMONLY_NAMED_FONTS])]
    .sort((a, b) => b.length - a.length);

  const script = scriptAskedFor(text);
  const seen = new Set<string>();
  const requests: FontRequest[] = [];
  let remaining = text;
  for (const name of known) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'iu');
    if (!pattern.test(remaining)) continue;
    // Blank the match so a shorter name inside it ("Arabic" in "Noto Sans Arabic") is not read again.
    remaining = remaining.replace(new RegExp(pattern.source, 'giu'), (m) => ' '.repeat(m.length));
    const family = aliases[name] ?? name;
    const key = family.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const admittedFor = admitted.get(family);
    const available = admittedFor !== undefined && (script === 'unspecified' || admittedFor === script);
    const alternatives = available
      ? []
      : script === 'unspecified'
        ? [...installedFor('arabic', options.registryPath), ...installedFor('latin', options.registryPath)]
        : installedFor(script, options.registryPath);
    requests.push({ family, script, available, admittedFor: available ? admittedFor : undefined, alternatives });
  }
  return requests;
}

export const scriptLabel = (script: FontScript | 'unspecified'): string =>
  script === 'arabic' ? 'Kurdish and Arabic' : script === 'latin' ? 'English' : 'all';

/** The line a sender is told when the face they asked for is not one the studio can draw. */
export function unavailableFontNotice(request: FontRequest): string {
  const where = request.script === 'unspecified' ? '' : ` for ${scriptLabel(request.script)} text`;
  const offer = request.alternatives.length
    ? `Installed${where}: ${request.alternatives.join(', ')}. Reply with one of these to use it.`
    : `No installed face is available${where}.`;
  return `${request.family} is not installed in the studio, so it was not applied. ${offer}`;
}
