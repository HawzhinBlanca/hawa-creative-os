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

export interface PptxCheckOptions {
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
  });

  const parse = (b: Uint8Array) => {
    const text = strFromU8(b);
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('XML entities are forbidden');
    return parser.parse(text);
  };

  const doc = parse(files[names[0]]);
  const shapes: any[] = [];
  const find = (node: any, tag: string, found: any[]) => {
    if (Array.isArray(node)) {
      for (const item of node) find(item, tag, found);
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === tag) found.push(value);
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
  const fonts: string[] = [];
  const fontExpectations: string[] = [];
  const offendingObjects: OffendingFontObject[] = [];
  let unresolvedFont = false;
  let arabicObjects = 0, rtlObjects = 0;

  const admitted = (options.admittedFonts || DEFAULT_ADMITTED_FONTS).map((f) => f.toLowerCase());
  const formalBodyLatin = (options.formalBodyFonts?.latin || 'Verdana').toLowerCase();
  const formalBodyArabic = (options.formalBodyFonts?.arabic || options.scriptFonts?.arabic || 'Noto Sans Arabic').toLowerCase();

  for (let shapeIndex = 0; shapeIndex < shapes.length; shapeIndex++) {
    const shape = shapes[shapeIndex];
    const paragraphs: any[] = [];
    find(shape, 'a:p', paragraphs);
    let text = '';
    for (const paragraph of paragraphs) {
      const nodes: any[] = [];
      find(paragraph, 'a:t', nodes);
      for (const n of nodes) {
        if (Array.isArray(n)) text += n.map((x: any) => String(x?.['#text'] ?? '')).join('');
        else if (n && typeof n === 'object') text += String(n['#text'] ?? '');
        else if (typeof n === 'string') text += n;
      }
      text += '\n';
    }
    if (!text.trim()) continue;
    const textIdx = texts.length;
    texts.push(text.trim());

    const isArabic = ARABIC_SCRIPT.test(text);
    if (isArabic) {
      arabicObjects++;
      const owners: any[] = [];
      findOwners(shape, 'a:pPr', owners);
      if (owners.some((o) => String(o?.[':@']?.['@_rtl'] ?? '') === '1')) rtlObjects++;
    }

    const runs: any[] = [];
    find(shape, 'a:r', runs);
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
      const properties: any[] = [];
      find(run, 'a:rPr', properties);
      const runFaces: string[] = [];
      const inspectChild = (child: any) => {
        if (!child || typeof child !== 'object') return;
        for (const tag of ['a:latin', 'a:cs', 'a:ea']) {
          if (child[tag]) {
            const tf = child[':@']?.['@_typeface'] || (child[tag] as any)?.['@_typeface'];
            if (tf && typeof tf === 'string' && tf.trim()) runFaces.push(tf.trim());
          }
        }
      };

      for (const props of properties) {
        if (Array.isArray(props)) {
          for (const child of props) inspectChild(child);
        } else if (props && typeof props === 'object') {
          inspectChild(props);
        }
      }

      if (!runFaces.length) {
        unresolvedFont = true;
        offendingObjects.push({
          index: textIdx,
          text: text.trim().slice(0, 50),
          observedFont: 'unresolved',
          reason: 'No typeface attribute in run properties',
        });
      } else {
        const observedFace = runFaces[0];
        fonts.push(observedFace);

        // Determine expected font & validate role-based typography
        const role = options.roles?.[textIdx] || 'body';
        const isFormal = options.documentKind === 'formal_document';

        if (options.fontsByIndex) {
          const expectedFont = options.fontsByIndex[textIdx];
          fontExpectations.push(expectedFont || 'none sent');
          const sent = (expectedFont || '').toLowerCase();
          const kept = Boolean(sent) && runFaces.some((f) => f.toLowerCase() === sent || f.toLowerCase().startsWith(sent + ' '));
          if (!kept) {
            offendingObjects.push({
              index: textIdx,
              text: text.trim().slice(0, 50),
              role,
              observedFont: observedFace,
              expectedFont,
              reason: expectedFont
                ? `Sent in '${expectedFont}', returned by Canva in '${observedFace}'`
                : 'Canva returned a text object that was not sent',
            });
          }
        } else if (isFormal && role === 'body') {
          const expected = isArabic ? formalBodyArabic : formalBodyLatin;
          fontExpectations.push(expected);
          const matches = observedFace.toLowerCase() === expected || observedFace.toLowerCase().startsWith(expected + ' ');
          if (!matches) {
            offendingObjects.push({
              index: textIdx,
              text: text.trim().slice(0, 50),
              role,
              observedFont: observedFace,
              expectedFont: isArabic ? (options.formalBodyFonts?.arabic || 'Noto Sans Arabic') : (options.formalBodyFonts?.latin || 'Verdana'),
              reason: `Formal document body must use ${isArabic ? 'Noto Sans Arabic' : 'Verdana'}; observed '${observedFace}'`,
            });
          }
        } else if (options.documentKind === 'formal_document' || options.documentKind === 'design_piece') {
          // Free choice of Canva-native display fonts from admitted list
          const matchesAdmitted = admitted.some(
            (a) => observedFace.toLowerCase() === a || observedFace.toLowerCase().startsWith(a + ' ')
          );
          fontExpectations.push(observedFace);
          if (!matchesAdmitted) {
            offendingObjects.push({
              index: textIdx,
              text: text.trim().slice(0, 50),
              role,
              observedFont: observedFace,
              reason: `Typeface '${observedFace}' is not in the admitted Canva-native font list`,
            });
          }
        } else {
          // Standard / legacy single-font mode (for tests passing requiredFont)
          const expectedFont = isArabic && options.scriptFonts?.arabic
            ? options.scriptFonts.arabic
            : requiredFont;
          fontExpectations.push(expectedFont);
          const matched = runFaces.find((f) => f === expectedFont || f.startsWith(expectedFont + ' '));
          if (!matched) {
            offendingObjects.push({
              index: textIdx,
              text: text.trim().slice(0, 50),
              role,
              observedFont: observedFace,
              expectedFont,
              reason: `Expected font '${expectedFont}', observed '${observedFace}' (Canva substitution or unlisted font)`,
            });
          }
        }
      }
    }
  }

  // Word joiners (U+2060) are invisible: the studio deck adds them so Canva keeps "K-12" on one line.
  const normalize = (s: string) => s.replace(/\u2060/g, '').replace(/\s+/g, ' ').trim();
  const copyPass = texts.length === expectedCopy.length && texts.every((t, i) => normalize(t) === normalize(expectedCopy[i]));
  const fontPass = !unresolvedFont && fonts.length > 0 && offendingObjects.length === 0;
  const rtlPass = arabicObjects === 0 || rtlObjects === arabicObjects;
  const rtlNote = arabicObjects > 0 && rtlObjects === 0
    ? 'Paragraph rtl attribute absent: Canva exports omit it, so reading direction is verified visually, not here.'
    : null;

  return {
    checkVersion: 3,
    source: detectedSource,
    canvaDesignId,
    documentKind: options.documentKind || 'unspecified',
    copyPass,
    fontPass,
    rtlPass,
    rtlNote,
    requiredFont,
    scriptFonts: options.scriptFonts || null,
    fontsByIndex: options.fontsByIndex || null,
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
