import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

export const DEFAULT_ADMITTED_FONTS = [
  'Cinzel',
  'Playfair Display',
  'Montserrat',
  'Lora',
  'Bodoni Moda',
  'Cairo',
  'Plus Jakarta Sans',
  'Vazirmatn',
  'Inter',
  'Verdana',
  'Noto Sans Arabic',
];

export interface OffendingFontObject {
  index: number;
  text: string;
  role?: string;
  observedFont: string;
  expectedFont?: string;
  reason: string;
}

/** Addressable live text observed in the retained PPTX; not a native Canva layer map. */
export interface PptxTextObject {
  id: string;
  type: 'text';
  text: string;
  source: { format: 'pptx'; part: string; shapeId: string };
}

export interface PptxCheckOptions {
  /** Explicit block directions frozen from the imported plan. null means unspecified. */
  directionsByIndex?: Array<'ltr' | 'rtl' | null>;
  /** Manual designs: explicit active Client DNA families, with no inferred block roles. */
  allowedFontsByScript?: { latin: string[]; arabic: string[] };
  /** Typeface expected on Arabic-script (Sorani) text objects; Latin objects must use requiredFont. */
  scriptFonts?: { arabic?: string };
  /** Intake classification: 'formal_document' (letters, certificates, agendas) or 'design_piece' (invitations, posters) */
  documentKind?: 'formal_document' | 'design_piece';
  /** Role per text block matching expectedCopy indices (e.g. 'body', 'headline', 'title', 'subtitle', 'date') */
  roles?: string[];
  /** Allowed Canva-native families for general design text */
  admittedFonts?: string[];
  /** Role-based body fonts for formal documents */
  formalBodyFonts?: { latin?: string; arabic?: string };
  /**
   * The typeface each text object was sent in, in shape order. A studio design chooses a face per
   * block (Cinzel, Playfair Display, Amiri, Noto Sans Arabic, Verdana), so after a Canva round-trip
   * the question is whether Canva kept each one, not whether they all match one brand font.
   */
  fontsByIndex?: string[];
}

const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** ADR207: validate before the decoder can erase controls or accept a numeric prefix. */
function canonicalXmlCharacterReferences(xml: string): string {
  const chunks: string[] = [];
  let from = 0, references = 0;
  for (let i = 0; i < xml.length; i++) {
    // These XML regions contain literals, not character references. indexOf skips each once.
    const literalEnd = xml.startsWith('<![CDATA[', i) ? ']]>'
      : xml.startsWith('<!--', i) ? '-->' : xml.startsWith('<?', i) ? '?>' : undefined;
    if (literalEnd) {
      const end = xml.indexOf(literalEnd, i + (literalEnd === ']]>' ? 9 : literalEnd === '-->' ? 4 : 2));
      if (end < 0) throw new Error('Unterminated PPTX XML literal');
      i = end + literalEnd.length - 1;
      continue;
    }
    if (xml[i] !== '&' || xml[i + 1] !== '#') continue;
    if (++references > 100000) throw new Error('XML character reference inspection limit exceeded');
    const end = xml.indexOf(';', i + 2);
    const token = end < 0 ? '' : xml.slice(i + 2, end);
    if (!/^(?:[0-9]+|x[0-9a-fA-F]+)$/.test(token)) throw new Error('Invalid XML character reference');
    const code = token[0] === 'x' ? Number.parseInt(token.slice(1), 16) : Number(token);
    const valid = code === 9 || code === 10 || code === 13 ||
      code >= 0x20 && code <= 0xD7FF || code >= 0xE000 && code <= 0xFFFD || code >= 0x10000 && code <= 0x10FFFF;
    if (!valid) throw new Error('Invalid XML character reference');
    // Retain lexical equivalence while avoiding the pinned decoder's token-length window.
    const canonical = `&#${code};`;
    if (xml.slice(i, end + 1) !== canonical) {
      chunks.push(xml.slice(from, i), canonical);
      from = end + 1;
    }
    i = end;
  }
  return chunks.length ? chunks.join('') + xml.slice(from) : xml;
}

export function checkCanvaPptx(
  bytes: Uint8Array,
  expectedCopy: string[],
  requiredFontOrOptions?: string | PptxCheckOptions,
  maybeOptions: PptxCheckOptions = {}
) {
  let requiredFont: string;
  let options: PptxCheckOptions;
  if (typeof requiredFontOrOptions === 'object' && requiredFontOrOptions !== null) {
    options = requiredFontOrOptions;
    requiredFont = options.formalBodyFonts?.latin || 'Verdana';
  } else {
    requiredFont = requiredFontOrOptions || 'Verdana';
    options = maybeOptions;
  }
  if (options.directionsByIndex !== undefined && (!Array.isArray(options.directionsByIndex) ||
      options.directionsByIndex.length !== expectedCopy.length ||
      Array.from(options.directionsByIndex).some(direction => direction !== null && direction !== 'ltr' && direction !== 'rtl'))) {
    throw new Error('Invalid captured paragraph direction policy');
  }

  if (bytes.length > 25 * 1024 * 1024) throw new Error('PPTX exceeds import limit');
  let total = 0, count = 0;
  const seen = new Set<string>();
  const files = unzipSync(bytes, {
    filter: (file) => {
      if (++count > 500 || seen.has(file.name) || file.name.includes('..') || file.name.startsWith('/')) {
        throw new Error('Unsupported ZIP directory');
      }
      seen.add(file.name);
      total += file.originalSize;
      if (file.originalSize > 8 * 1024 * 1024 || total > 64 * 1024 * 1024) {
        throw new Error('Expanded PPTX exceeds inspection limit');
      }
      return /^ppt\/slides\/slide\d+\.xml$/.test(file.name) || file.name === 'ppt/presentation.xml' || file.name === 'docProps/core.xml';
    },
  });

  const names = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  if (names.length !== 1 || !files['ppt/presentation.xml']) {
    throw new Error('Only one-page PPTX is admitted');
  }

  let detectedSource: 'canva_exported_pptx' | 'local_transfer_pptx' = 'canva_exported_pptx';
  let canvaDesignId: string | null = null;
  if (files['docProps/core.xml']) {
    const coreText = strFromU8(files['docProps/core.xml']);
    const idMatch = coreText.match(/<dc:identifier>([^<]+)<\/dc:identifier>/i);
    if (idMatch) {
      canvaDesignId = idMatch[1].trim();
      detectedSource = 'canva_exported_pptx';
    } else if (coreText.includes('Editable Canva transfer') || coreText.includes('Hawa')) {
      detectedSource = 'local_transfer_pptx';
    }
  }

  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    trimValues: false,
    parseTagValue: false,
    processEntities: true,
    // @ts-expect-error 5.11.1 accepts an explicit entity map at runtime; its type declares only boolean.
    htmlEntities: { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" },
  });

  const parse = (b: Uint8Array) => {
    const text = strFromU8(b);
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('XML entities are forbidden');
    return parser.parse(canonicalXmlCharacterReferences(text));
  };

  const doc = parse(files[names[0]]);
  const shapes: any[] = [];
  const find = (node: any, tag: string | string[], found: any[]) => {
    if (Array.isArray(node)) {
      for (const item of node) find(item, tag, found);
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (typeof tag === 'string' ? key === tag : tag.includes(key)) found.push(value);
        else if (key !== ':@') find(value, tag, found);
      }
    }
  };

  const findOwners = (node: any, tag: string, found: any[]) => {
    if (Array.isArray(node)) {
      for (const item of node) findOwners(item, tag, found);
    } else if (node && typeof node === 'object') {
      if (Object.prototype.hasOwnProperty.call(node, tag)) found.push(node);
      for (const value of Object.values(node)) findOwners(value, tag, found);
    }
  };

  find(doc, 'p:sp', shapes);

  const texts: string[] = [];
  const sourceTextObjects: PptxTextObject[] = [];
  const identities: Array<{ ':@'?: Record<string, unknown> }> = [];
  findOwners(doc, 'p:cNvPr', identities);
  const identityCounts = new Map<string, number>();
  for (const owner of identities) {
    const id = String(owner?.[':@']?.['@_id'] ?? '');
    identityCounts.set(id, (identityCounts.get(id) || 0) + 1);
  }
  let unaddressableText = false;
  const fonts: string[] = [];
  const fontExpectations: string[] = [];
  const offendingObjects: OffendingFontObject[] = [];
  let unresolvedFont = false;
  let arabicObjects = 0, rtlObjects = 0;
  const paragraphDirections: Array<{ textObjectIndex: number; paragraphIndex: number;
    observed: 'ltr' | 'rtl' | 'absent' | 'invalid'; expected: 'ltr' | 'rtl' | null;
    expectationSource: 'imported_plan' | 'arabic_only' | 'unspecified' }> = [];

  const admitted = (options.admittedFonts || DEFAULT_ADMITTED_FONTS).map((f) => f.toLowerCase());
  const formalBodyLatin = (options.formalBodyFonts?.latin || 'Verdana').toLowerCase();
  const formalBodyArabic = (options.formalBodyFonts?.arabic || options.scriptFonts?.arabic || 'Noto Sans Arabic').toLowerCase();

  for (let shapeIndex = 0; shapeIndex < shapes.length; shapeIndex++) {
    const shape = shapes[shapeIndex];
    const paragraphs: any[] = [];
    find(shape, 'a:p', paragraphs);
    let text = '';
    const paragraphTexts: string[] = [];
    for (const paragraph of paragraphs) {
      const start = text.length;
      const nodes: any[] = [];
      find(paragraph, 'a:t', nodes);
      for (const n of nodes) {
        if (Array.isArray(n)) text += n.map((x: any) => String(x?.['#text'] ?? '')).join('');
        else if (n && typeof n === 'object') text += String(n['#text'] ?? '');
        else if (typeof n === 'string') text += n;
      }
      paragraphTexts.push(text.slice(start));
      text += '\n';
    }
    if (!text.trim()) continue;
    const textIdx = texts.length;
    texts.push(text.trim());
    const owners: Array<{ ':@'?: Record<string, unknown> }> = [];
    findOwners(shape, 'p:cNvPr', owners);
    const shapeId = String(owners[0]?.[':@']?.['@_id'] ?? '');
    if (owners.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(shapeId) || identityCounts.get(shapeId) !== 1) {
      unaddressableText = true;
    } else {
      sourceTextObjects.push({ id: `${names[0]}#${shapeId}`, type: 'text',
        // Drop only the final separator we inserted; retain the source's whitespace and Unicode.
        text: text.slice(0, -1), source: { format: 'pptx', part: names[0], shapeId } });
    }

    const isArabic = ARABIC_SCRIPT.test(text);
    if (isArabic) {
      arabicObjects++;
      const owners: any[] = [];
      findOwners(shape, 'a:pPr', owners);
      if (owners.some((o) => ['1', 'true'].includes(String(o?.[':@']?.['@_rtl'] ?? '').trim()))) rtlObjects++;
    }
    for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
      const value = paragraphTexts[paragraphIndex];
      if (!value.trim()) continue;
      const explicit = options.directionsByIndex?.[textIdx] ?? null;
      if (!ARABIC_SCRIPT.test(value) && explicit === null) continue;
      const owners: Array<{ ':@'?: Record<string, unknown> }> = [];
      findOwners(paragraph, 'a:pPr', owners);
      const attributes = owners.map(owner => owner[':@']?.['@_rtl']).filter(attribute => attribute !== undefined);
      const attribute = attributes.length === 1 ? String(attributes[0]).trim() : null;
      const observed = attributes.length === 0 ? 'absent'
        : attributes.length !== 1 ? 'invalid'
        : attribute === 'true' || attribute === '1' ? 'rtl'
        : attribute === 'false' || attribute === '0' ? 'ltr' : 'invalid';
      // Mixed script has no inferred direction. Digits alone are not strong Arabic letters.
      const arabicOnly = !/\p{Script=Latin}/u.test(value) &&
        [...value].some(character => /\p{Letter}/u.test(character) && ARABIC_SCRIPT.test(character));
      paragraphDirections.push({ textObjectIndex: textIdx, paragraphIndex, observed,
        expected: explicit ?? (arabicOnly ? 'rtl' : null),
        expectationSource: explicit !== null ? 'imported_plan' : arabicOnly ? 'arabic_only' : 'unspecified' });
    }

    const runs: any[] = [];
    find(shape, ['a:r', 'a:fld'], runs);
    if (!runs.length) {
      unresolvedFont = true;
      offendingObjects.push({
        index: textIdx,
        text: text.trim().slice(0, 50),
        observedFont: 'none',
        reason: 'No font runs found in shape textBody',
      });
    }

    for (const run of runs) {
      const runTextNodes: any[] = [];
      find(run, 'a:t', runTextNodes);
      const runText = runTextNodes.flatMap(node => Array.isArray(node) ? node : [node])
        .map(node => typeof node === 'string' ? node : String(node?.['#text'] ?? '')).join('');
      if (!runText.trim()) continue;
      const scripts: Array<'latin' | 'arabic'> = [];
      if (ARABIC_SCRIPT.test(runText)) scripts.push('arabic');
      if (/\p{Script=Latin}/u.test(runText) || !scripts.length) scripts.push('latin');

      const properties: any[] = [];
      find(run, 'a:rPr', properties);
      const facesByTag: Record<string, string[]> = {};
      const inspectChild = (child: any) => {
        if (!child || typeof child !== 'object') return;
        for (const tag of ['a:latin', 'a:cs']) {
          if (child[tag]) {
            const tf = child[':@']?.['@_typeface'] || (child[tag] as any)?.['@_typeface'];
            if (tf && typeof tf === 'string' && tf.trim()) (facesByTag[tag] ||= []).push(tf.trim());
          }
        }
      };
      for (const props of properties) {
        if (Array.isArray(props)) for (const child of props) inspectChild(child);
        else inspectChild(props);
      }

      const role = options.roles?.[textIdx] || 'body';
      for (const script of scripts) {
        const declared = facesByTag[script === 'arabic' ? 'a:cs' : 'a:latin'] || [];
        const observedFont = declared.join(', ') || 'unresolved';
        if (declared.length !== 1) {
          unresolvedFont = true;
          offendingObjects.push({ index: textIdx, text: text.trim().slice(0, 50), role, observedFont,
            reason: `The ${script} run must have one explicit font family declaration` });
          continue;
        }
        const face = declared[0];
        fonts.push(face);
        const familyMatches = (expected: string) => face.toLowerCase() === expected.toLowerCase() ||
          face.toLowerCase().startsWith(expected.toLowerCase() + ' ');
        let expectedFont: string | undefined;
        let matches: boolean;
        let reason: string;
        if (options.allowedFontsByScript) {
          const allowed = options.allowedFontsByScript[script] || [];
          fontExpectations.push(...allowed);
          matches = allowed.some(font => face.toLowerCase() === font.toLowerCase());
          reason = `The ${script} run must explicitly use an approved client font family`;
        } else if (options.fontsByIndex) {
          expectedFont = options.fontsByIndex[textIdx];
          fontExpectations.push(expectedFont || 'none sent');
          matches = expectedFont !== undefined && expectedFont !== '' && familyMatches(expectedFont);
          reason = expectedFont ? `Sent in '${expectedFont}', returned by Canva in '${face}' for ${script} text`
            : 'Canva returned a text object that was not sent';
        } else if (options.documentKind === 'formal_document' && role === 'body') {
          expectedFont = script === 'arabic' ? (options.formalBodyFonts?.arabic || options.scriptFonts?.arabic || 'Noto Sans Arabic')
            : (options.formalBodyFonts?.latin || 'Verdana');
          fontExpectations.push(expectedFont);
          matches = familyMatches(script === 'arabic' ? formalBodyArabic : formalBodyLatin);
          reason = `Formal document body must use ${expectedFont}; observed '${face}' for ${script} text`;
        } else if (options.documentKind === 'formal_document' || options.documentKind === 'design_piece') {
          fontExpectations.push(face);
          matches = admitted.some(familyMatches);
          reason = `Typeface '${face}' is not in the admitted Canva-native font list`;
        } else {
          expectedFont = script === 'arabic' && options.scriptFonts?.arabic ? options.scriptFonts.arabic : requiredFont;
          fontExpectations.push(expectedFont);
          // Retain legacy case-sensitive family/style matching, but only in the used slot.
          matches = face === expectedFont || face.startsWith(expectedFont + ' ');
          reason = `Expected font '${expectedFont}', observed '${face}' (Canva substitution or unlisted font)`;
        }
        if (!matches) offendingObjects.push({ index: textIdx, text: text.trim().slice(0, 50), role,
          observedFont, ...(expectedFont ? {expectedFont} : {}), reason });
      }
    }
  }

  // Word joiners (U+2060) are invisible: the studio deck adds them so Canva keeps "K-12" on one line.
  const normalize = (s: string) => s.replace(/\u2060/g, '').replace(/\s+/g, ' ').trim();
  const copyPass = texts.length === expectedCopy.length && texts.every((t, i) => normalize(t) === normalize(expectedCopy[i]));
  const fontPass = !unresolvedFont && fonts.length > 0 && offendingObjects.length === 0;
  const hasDirectionMetadata = paragraphDirections.some(paragraph => paragraph.observed !== 'absent');
  const directionViolations = paragraphDirections.filter(paragraph => paragraph.observed === 'invalid' ||
    (paragraph.expected !== null && paragraph.observed !== 'absent' && paragraph.observed !== paragraph.expected) ||
    (paragraph.expected === 'rtl' && paragraph.observed === 'absent' &&
      (detectedSource === 'local_transfer_pptx' || hasDirectionMetadata)));
  const rtlMetadataPass: boolean | null = directionViolations.length ? false
    : paragraphDirections.some(paragraph => paragraph.expected === null || paragraph.observed === 'absent') ? null : true;
  // Unknown metadata stays eligible only for the separate required visual review. Explicit
  // conflicts never become an "absent metadata" exception, including rtl="false" and rtl="0".
  const rtlPass = rtlMetadataPass !== false;
  const rtlVisualReviewRequired = arabicObjects > 0;
  const rtlNote = rtlVisualReviewRequired
    ? `${hasDirectionMetadata ? 'Paragraph direction metadata is present' : 'Paragraph direction metadata is unavailable'}; rendered reading direction and isolation must be verified visually.`
    : null;

  return {
    checkVersion: 8,
    sourceTextObjects: unaddressableText ? null : sourceTextObjects,
    source: detectedSource,
    canvaDesignId,
    documentKind: options.documentKind || 'unspecified',
    copyPass,
    fontPass,
    rtlPass,
    rtlNote,
    rtlMetadataPass,
    rtlVisualReviewRequired,
    paragraphDirections,
    directionViolations,
    directionsByIndex: options.directionsByIndex || null,
    requiredFont,
    scriptFonts: options.scriptFonts || null,
    fontsByIndex: options.fontsByIndex || null,
    allowedFontsByScript: options.allowedFontsByScript || null,
    admittedFonts: options.admittedFonts || DEFAULT_ADMITTED_FONTS,
    arabicTextObjectCount: arabicObjects,
    rtlTextObjectCount: rtlObjects,
    observedFonts: [...new Set(fonts)],
    textObjectCount: texts.length,
    expectedTextObjectCount: expectedCopy.length,
    offendingObjects,
    comparisonPolicy: 'exact words and punctuation; layout whitespace folded',
    fullReleasePass: false,
    logoVerification: 'not_qualified',
    layoutVerification: 'visual_review_required',
    printQualified: false,
  };
}
