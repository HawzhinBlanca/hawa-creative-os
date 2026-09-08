/**
 * Kurdish WebFont Ingestion & Diacritic Coverage Inspector (B-040, FR-037)
 * Implements Google Fonts / Font Bakery / HarfBuzz inspection standards
 * for Kurdish Sorani (ckb) typography compliance.
 */

export interface KurdishGlyphDefinition {
  char: string;
  codePoint: number;
  name: string;
  category: 'primary_vowel' | 'primary_consonant' | 'extended_consonant' | 'bidi_token' | 'digit';
  requiredForSorani: boolean;
}

export const KURDISH_SORANI_GLYPH_TABLE: KurdishGlyphDefinition[] = [
  // Primary Distinctive Kurdish Consonants & Vowels
  { char: 'ک', codePoint: 0x06A9, name: 'Arabic Letter Keheh', category: 'primary_consonant', requiredForSorani: true },
  { char: 'گ', codePoint: 0x06AF, name: 'Arabic Letter Gaf', category: 'primary_consonant', requiredForSorani: true },
  { char: 'ڵ', codePoint: 0x06B5, name: 'Arabic Letter Lam with Small V', category: 'primary_consonant', requiredForSorani: true },
  { char: 'ۆ', codePoint: 0x06C6, name: 'Arabic Letter Oe', category: 'primary_vowel', requiredForSorani: true },
  { char: 'ڕ', codePoint: 0x0695, name: 'Arabic Letter Reh with Small V Below', category: 'primary_consonant', requiredForSorani: true },
  { char: 'ێ', codePoint: 0x06CE, name: 'Arabic Letter Yeh with Small V', category: 'primary_vowel', requiredForSorani: true },
  { char: 'ە', codePoint: 0x06D5, name: 'Arabic Letter Ae', category: 'primary_vowel', requiredForSorani: true },
  { char: 'ژ', codePoint: 0x0698, name: 'Arabic Letter Jeh', category: 'extended_consonant', requiredForSorani: true },
  { char: 'پ', codePoint: 0x067E, name: 'Arabic Letter Peh', category: 'extended_consonant', requiredForSorani: true },
  { char: 'چ', codePoint: 0x0686, name: 'Arabic Letter Tcheh', category: 'extended_consonant', requiredForSorani: true },
  { char: 'ڤ', codePoint: 0x06A4, name: 'Arabic Letter Veh', category: 'extended_consonant', requiredForSorani: true },

  // Base Arabic Alphabet Shared in Kurdish
  { char: 'ا', codePoint: 0x0627, name: 'Arabic Letter Alef', category: 'primary_vowel', requiredForSorani: true },
  { char: 'ب', codePoint: 0x0628, name: 'Arabic Letter Beh', category: 'primary_consonant', requiredForSorani: true },
  { char: 'ت', codePoint: 0x062A, name: 'Arabic Letter Teh', category: 'primary_consonant', requiredForSorani: true },
  { char: 'ح', codePoint: 0x062D, name: 'Arabic Letter Hah', category: 'primary_consonant', requiredForSorani: true },
  { char: 'خ', codePoint: 0x062E, name: 'Arabic Letter Khah', category: 'primary_consonant', requiredForSorani: true },
  { char: 'د', codePoint: 0x062F, name: 'Arabic Letter Dal', category: 'primary_consonant', requiredForSorani: true },
  { char: 'ر', codePoint: 0x0631, name: 'Arabic Letter Reh', category: 'primary_consonant', requiredForSorani: true },
  { char: 'ز', codePoint: 0x0632, name: 'Arabic Letter Zain', category: 'primary_consonant', requiredForSorani: true },
  { char: 'س', codePoint: 0x0633, name: 'Arabic Letter Seen', category: 'primary_consonant', requiredForSorani: true },
  { char: 'ش', codePoint: 0x0634, name: 'Arabic Letter Sheen', category: 'primary_consonant', requiredForSorani: true },
  { char: 'ع', codePoint: 0x0639, name: 'Arabic Letter Ain', category: 'primary_consonant', requiredForSorani: true },
  { char: 'غ', codePoint: 0x063A, name: 'Arabic Letter Ghain', category: 'primary_consonant', requiredForSorani: true },
  { char: 'ف', codePoint: 0x0641, name: 'Arabic Letter Feh', category: 'primary_consonant', requiredForSorani: true },
  { char: 'ق', codePoint: 0x0642, name: 'Arabic Letter Qaf', category: 'primary_consonant', requiredForSorani: true },
  { char: 'ل', codePoint: 0x0644, name: 'Arabic Letter Lam', category: 'primary_consonant', requiredForSorani: true },
  { char: 'م', codePoint: 0x0645, name: 'Arabic Letter Meem', category: 'primary_consonant', requiredForSorani: true },
  { char: 'ن', codePoint: 0x0646, name: 'Arabic Letter Noon', category: 'primary_consonant', requiredForSorani: true },
  { char: 'و', codePoint: 0x0648, name: 'Arabic Letter Waw', category: 'primary_vowel', requiredForSorani: true },
  { char: 'ی', codePoint: 0x06CC, name: 'Arabic Letter Farsi Yeh', category: 'primary_vowel', requiredForSorani: true },
  { char: 'ھ', codePoint: 0x06BE, name: 'Arabic Letter Heh Doachashmee', category: 'primary_consonant', requiredForSorani: true },

  // Bidi and Morphological Control Tokens
  { char: '\u200C', codePoint: 0x200C, name: 'Zero Width Non-Joiner (ZWNJ)', category: 'bidi_token', requiredForSorani: true },
  { char: 'ـ', codePoint: 0x0640, name: 'Arabic Tatweel', category: 'bidi_token', requiredForSorani: false }
];

export interface FontMetadata {
  family: string;
  subfamily: string;
  fullName: string;
  version?: string;
  copyright?: string;
  format: 'TrueType' | 'OpenType' | 'WOFF' | 'WOFF2' | 'Unknown';
}

export interface FontCoverageResult {
  fontName: string;
  format: string;
  metadata: FontMetadata;
  totalRequired: number;
  presentCount: number;
  missingCount: number;
  coveragePercentage: number;
  status: 'AAA_COMPLIANT' | 'PARTIAL_COMPLIANT' | 'INCOMPATIBLE';
  presentGlyphs: Array<{ char: string; hex: string; name: string }>;
  missingGlyphs: Array<{ char: string; hex: string; name: string }>;
  hasZwnj: boolean;
  diacriticClearanceRatio: number; // Recommended line-height (1.52 for Kurdish)
  specimenText: string;
  samplePhrases: string[];
}

/**
 * Parses TrueType / OpenType binary data to inspect unicode character map (cmap)
 * and extract glyph presence.
 */
export function extractGlyphSetFromBuffer(buffer: Uint8Array | ArrayBuffer): {
  supportedCodePoints: Set<number>;
  metadata: FontMetadata;
} {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const supported = new Set<number>();
  const metadata: FontMetadata = {
    family: 'Custom Font',
    subfamily: 'Regular',
    fullName: 'Custom Font Regular',
    format: 'Unknown'
  };

  if (bytes.length < 12) {
    return { supportedCodePoints: supported, metadata };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);

  if (tag === 'wOFF') {
    metadata.format = 'WOFF';
  } else if (tag === 'wOF2') {
    metadata.format = 'WOFF2';
  } else if (tag === 'OTTO') {
    metadata.format = 'OpenType';
  } else if (bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) {
    metadata.format = 'TrueType';
  }

  // TrueType / OpenType offset table parsing
  const numTables = view.getUint16(4);
  let cmapOffset = 0;
  let nameOffset = 0;

  for (let i = 0; i < numTables; i++) {
    const recordOffset = 12 + i * 16;
    if (recordOffset + 16 > bytes.length) break;

    const tableTag = String.fromCharCode(
      bytes[recordOffset],
      bytes[recordOffset + 1],
      bytes[recordOffset + 2],
      bytes[recordOffset + 3]
    );

    const offset = view.getUint32(recordOffset + 8);

    if (tableTag === 'cmap') {
      cmapOffset = offset;
    } else if (tableTag === 'name') {
      nameOffset = offset;
    }
  }

  // Parse `name` table for font metadata if present
  if (nameOffset > 0 && nameOffset + 6 <= bytes.length) {
    try {
      const nameCount = view.getUint16(nameOffset + 2);
      const stringStorageOffset = nameOffset + view.getUint16(nameOffset + 4);

      for (let i = 0; i < nameCount; i++) {
        const recordOffset = nameOffset + 6 + i * 12;
        if (recordOffset + 12 > bytes.length) break;

        const platformId = view.getUint16(recordOffset);
        const nameId = view.getUint16(recordOffset + 6);
        const length = view.getUint16(recordOffset + 8);
        const strOffset = stringStorageOffset + view.getUint16(recordOffset + 10);

        if (strOffset + length <= bytes.length) {
          let str = '';
          if (platformId === 0 || platformId === 3) {
            // UTF-16BE encoding
            for (let j = 0; j < length; j += 2) {
              if (j + 1 < length) {
                str += String.fromCharCode(view.getUint16(strOffset + j));
              }
            }
          } else {
            // Mac / Roman 1-byte encoding
            for (let j = 0; j < length; j++) {
              str += String.fromCharCode(bytes[strOffset + j]);
            }
          }

          if (str.trim()) {
            if (nameId === 1) metadata.family = str.trim();
            if (nameId === 2) metadata.subfamily = str.trim();
            if (nameId === 4) metadata.fullName = str.trim();
            if (nameId === 5) metadata.version = str.trim();
          }
        }
      }
    } catch {
      // Gracefully continue if name table parsing fails
    }
  }

  // Parse `cmap` table for character coverage
  if (cmapOffset > 0 && cmapOffset + 4 <= bytes.length) {
    try {
      const numSubtables = view.getUint16(cmapOffset + 2);
      for (let i = 0; i < numSubtables; i++) {
        const subtableEntry = cmapOffset + 4 + i * 8;
        if (subtableEntry + 8 > bytes.length) break;

        const subtableOffset = cmapOffset + view.getUint32(subtableEntry + 4);
        if (subtableOffset + 6 > bytes.length) continue;

        const format = view.getUint16(subtableOffset);

        if (format === 4) {
          // Format 4: Segment mapping to delta values
          if (subtableOffset + 14 > bytes.length) continue;
          const segCountX2 = view.getUint16(subtableOffset + 6);
          const segCount = segCountX2 / 2;
          const endCodeOffset = subtableOffset + 14;
          const startCodeOffset = endCodeOffset + segCountX2 + 2;

          if (startCodeOffset + segCountX2 <= bytes.length) {
            for (let seg = 0; seg < segCount; seg++) {
              const endCode = view.getUint16(endCodeOffset + seg * 2);
              const startCode = view.getUint16(startCodeOffset + seg * 2);

              if (startCode <= endCode && endCode !== 0xFFFF) {
                for (let cp = startCode; cp <= endCode; cp++) {
                  supported.add(cp);
                  if (supported.size > 65535) break;
                }
              }
            }
          }
        } else if (format === 12) {
          // Format 12: Segmented coverage for 32-bit characters
          if (subtableOffset + 16 > bytes.length) continue;
          const nGroups = Math.min(view.getUint32(subtableOffset + 12), 4096);
          const groupsOffset = subtableOffset + 16;

          for (let g = 0; g < nGroups; g++) {
            const entryOffset = groupsOffset + g * 12;
            if (entryOffset + 12 > bytes.length) break;
            const startCharCode = view.getUint32(entryOffset);
            const endCharCode = view.getUint32(entryOffset + 4);

            // Defend against corrupted or malicious huge ranges (OOM attack prevention)
            if (
              startCharCode <= endCharCode &&
              endCharCode <= 0x10FFFF &&
              endCharCode - startCharCode <= 0x10000
            ) {
              for (let cp = startCharCode; cp <= endCharCode; cp++) {
                supported.add(cp);
                if (supported.size > 65535) break;
              }
            }
          }
        }
      }
    } catch {
      // Gracefully continue
    }
  }

  return { supportedCodePoints: supported, metadata };
}

/**
 * Inspects a font buffer or declared supported set against the normative
 * Kurdish Sorani glyph requirements.
 */
export function inspectKurdishFontCoverage(
  fontSource: Uint8Array | ArrayBuffer | Set<number> | string[],
  fontNameHint = 'Vazirmatn Kurdish'
): FontCoverageResult {
  let supportedSet = new Set<number>();
  let metadata: FontMetadata = {
    family: fontNameHint,
    subfamily: 'Regular',
    fullName: fontNameHint,
    format: 'OpenType'
  };

  if (fontSource instanceof Uint8Array || fontSource instanceof ArrayBuffer) {
    const extracted = extractGlyphSetFromBuffer(fontSource);
    supportedSet = extracted.supportedCodePoints;
    metadata = extracted.metadata;
    if (metadata.fullName === 'Custom Font Regular' && fontNameHint) {
      metadata.family = fontNameHint;
      metadata.fullName = fontNameHint;
    }
  } else if (fontSource instanceof Set) {
    supportedSet = fontSource;
  } else if (Array.isArray(fontSource)) {
    // Array of character strings
    fontSource.forEach((char) => {
      if (typeof char === 'string' && char.length > 0) {
        supportedSet.add(char.codePointAt(0)!);
      }
    });
  }

  const presentGlyphs: Array<{ char: string; hex: string; name: string }> = [];
  const missingGlyphs: Array<{ char: string; hex: string; name: string }> = [];

  const requiredGlyphs = KURDISH_SORANI_GLYPH_TABLE.filter((g) => g.requiredForSorani);

  requiredGlyphs.forEach((glyph) => {
    const hasGlyph = supportedSet.has(glyph.codePoint);
    const entry = {
      char: glyph.char,
      hex: 'U+' + glyph.codePoint.toString(16).toUpperCase().padStart(4, '0'),
      name: glyph.name
    };

    if (hasGlyph) {
      presentGlyphs.push(entry);
    } else {
      missingGlyphs.push(entry);
    }
  });

  const totalRequired = requiredGlyphs.length;
  const presentCount = presentGlyphs.length;
  const missingCount = missingGlyphs.length;
  const coveragePercentage = totalRequired > 0 ? Math.round((presentCount / totalRequired) * 100) : 100;

  const hasZwnj = supportedSet.has(0x200C);

  let status: FontCoverageResult['status'] = 'INCOMPATIBLE';
  if (coveragePercentage === 100 && hasZwnj) {
    status = 'AAA_COMPLIANT';
  } else if (coveragePercentage >= 80) {
    status = 'PARTIAL_COMPLIANT';
  }

  return {
    fontName: metadata.fullName || fontNameHint,
    format: metadata.format,
    metadata,
    totalRequired,
    presentCount,
    missingCount,
    coveragePercentage,
    status,
    presentGlyphs,
    missingGlyphs,
    hasZwnj,
    diacriticClearanceRatio: 1.52, // Baseline safety ratio preventing ڵ and ڕ clipping
    specimenText: 'پێشکه‌شکردنی دیاری لە هەولێر و سلێمانی و دهۆک',
    samplePhrases: [
      'دروستی - تەندروستی لە پێشینەیە',
      'ڤیتامین D3+K2 بە بەرزترین کوالێتی',
      'سلێمانی، شەقامی بازنەیی مەلیک مەحمود',
      'هەولێر، گەڕەکی وەزیران نزیک نەخۆشخانەی بەخشین'
    ]
  };
}
