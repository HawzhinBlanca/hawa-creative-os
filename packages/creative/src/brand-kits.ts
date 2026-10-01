/**
 * Hawa Creative OS — Canonical Client Brand Kits
 * Brand standards, palettes, typography pairings, and cryptographic proofs for Erbil & Kurdistan commerce.
 */

import { calculateLuminanceContrastRatio, hexToLuminance } from './studio/composite-contrast.js';

export interface BrandPalette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
  cardBg: string;
}

export interface BrandTypography {
  latinFont: string;
  kurdishFont: string;
  /** The title face when it differs from latinFont (KAAE: Crimson Pro titles over Inter body). */
  latinDisplayFont?: string;
  headlineWeight: number;
  copyWeight: number;
}

export interface BrandKitDefinition {
  id: string;
  name: string;
  nameKurdish: string;
  industry: string;
  industryKurdish: string;
  verifiedSha256: string;
  palette: BrandPalette;
  typography: BrandTypography;
  logoText: string;
  logoBadge: string;
  defaultHeadlineEn: string;
  defaultHeadlineCkb: string;
  defaultCopyEn: string;
  defaultCopyCkb: string;
  contactTokens: string[];
}

/** KAAE's official logo and symbol, by checksum, as its verified assets record them. */
export const KAAE_PRIMARY_LOGO_SHA256 = '40dab5f8ca1fe647e8bb1a443b3c9934408a8f177e79b430616e14f41fdb2ebc';
export const KAAE_SYMBOL_SHA256 = 'fc01cc8ed2ba4016e4f701abcb46d5b4f934d9a3c664129d82a475de40439180';

export const CANONICAL_BRAND_KITS: Record<string, BrandKitDefinition> = {
  drustee: {
    id: 'drustee',
    name: 'Drustee Evidence-First Health',
    nameKurdish: 'دروستی بۆ تەندروستی و تەواوکەری خۆراکی',
    industry: 'Clinical Supplements & Preventative Health',
    industryKurdish: 'تەواوکەری زانستی و تەندروستی پشتڕاستکراو',
    verifiedSha256: 'sha256_drustee_clinical_evidence_77e81b',
    palette: {
      primary: '#0D5C3A',      // Botanical Deep Emerald
      secondary: '#062E1D',    // Forest Pine
      accent: '#D4AF37',       // Warm Amber Gold
      background: 'linear-gradient(150deg, #062E1D 0%, #0D5C3A 55%, #1B4332 100%)',
      text: '#FFFFFF',
      cardBg: 'rgba(255, 255, 255, 0.95)',
    },
    typography: {
      latinFont: 'Inter',
      kurdishFont: 'Vazirmatn',
      headlineWeight: 800,
      copyWeight: 600,
    },
    logoText: 'DRUSTEE · دروستی',
    logoBadge: '🌿 EVIDENCE FIRST',
    defaultHeadlineEn: 'Pure Active Vitamin D3 + K2',
    defaultHeadlineCkb: 'ڤیتامین D3 + K2 بە ژەمێکی زانستی و بێگەرد',
    defaultCopyEn: '5000 IU High Potency · Third-Party Lab Tested',
    defaultCopyCkb: '٥٠٠٠ یەکەی نێودەوڵەتی · تاقیگەی سەربەخۆ پەسەندی کردووە',
    contactTokens: ['drustee.krd', 'Erbil, Kurdistan Region', 'info@drustee.krd'],
  },
  sebar: {
    id: 'sebar',
    name: 'SEBAR Verified Health',
    nameKurdish: 'سێبەر بۆ تەندروستی',
    industry: 'Supplements & Wellness',
    industryKurdish: 'تەواوکەری خۆراکی و تەندروستی',
    verifiedSha256: 'sha256_sebar_verified_seal_88f92a',
    palette: {
      primary: '#016E7D',      // Mineral Turquoise
      secondary: '#01585F',    // Deep Teal
      accent: '#F59E0B',       // Amber Gold
      background: 'linear-gradient(150deg, #0A1C1F 0%, #01585F 55%, #016E7D 100%)',
      text: '#FFFFFF',
      cardBg: 'rgba(255, 255, 255, 0.94)',
    },
    typography: {
      latinFont: 'Inter',
      kurdishFont: 'Vazirmatn',
      headlineWeight: 800,
      copyWeight: 700,
    },
    logoText: 'SEBAR · سێبەر',
    logoBadge: '🛡️ VERIFIED LOT',
    defaultHeadlineEn: 'Pure Strength, Verified Origin',
    defaultHeadlineCkb: 'هێزی ڕاستەقینە، بەرهەمی پشتڕاستکراو',
    defaultCopyEn: 'Creapure Creatine · $28.00 USD',
    defaultCopyCkb: 'کراتینی بێگەرد · ٣٨٬٠٠٠ دینار',
    contactTokens: ['0750 123 4567', 'Erbil Empire World', 'www.sebar.krd'],
  },
  hawa: {
    id: 'hawa',
    name: 'Hawa Creative OS',
    nameKurdish: 'ئۆفیسی داهێنەری هەوا',
    industry: 'Autonomous Creative Studio',
    industryKurdish: 'ستۆدیۆی بەرهەمهێنانی ڕیکلام',
    verifiedSha256: 'sha256_hawa_core_diamond_33a10b',
    palette: {
      primary: '#38BDF8',      // Electric Sky
      secondary: '#16362E',    // Forest Slate
      accent: '#E9B666',       // Golden Sand
      background: 'linear-gradient(145deg, #16362E 0%, #0F172A 60%, #ECE3CF 100%)',
      text: '#FFFFFF',
      cardBg: 'rgba(255, 255, 255, 0.92)',
    },
    typography: {
      latinFont: 'Plus Jakarta Sans',
      kurdishFont: 'Vazirmatn',
      headlineWeight: 700,
      copyWeight: 700,
    },
    logoText: 'HAWA · هەوا',
    logoBadge: '⚡ STUDIO OS',
    defaultHeadlineEn: 'Summer Chill, Joyful Days',
    defaultHeadlineCkb: 'تامی سارد، ڕۆژی خۆش',
    defaultCopyEn: 'Fresh Mint Soda · $12.00 USD',
    defaultCopyCkb: 'نۆشینی تازە · ١٢٬٠٠٠ دینار',
    contactTokens: ['0750 999 8877', 'Erbil Dream City', 'hawa.office'],
  },
  erbil_express: {
    id: 'erbil_express',
    name: 'Erbil Retail Express',
    nameKurdish: 'گەیاندنی خێرای هەولێر',
    industry: 'Retail & Quick Logistics',
    industryKurdish: 'بازاڕکردن و گەیاندنی بەپەلە',
    verifiedSha256: 'sha256_erbil_express_bolt_99c421',
    palette: {
      primary: '#10B981',      // Emerald Green
      secondary: '#0F172A',    // Midnight Charcoal
      accent: '#FBBF24',       // Sunburst
      background: 'linear-gradient(145deg, #064E3B 0%, #0F172A 55%, #10B981 100%)',
      text: '#FFFFFF',
      cardBg: 'rgba(255, 255, 255, 0.95)',
    },
    typography: {
      latinFont: 'Inter',
      kurdishFont: 'Noto Sans Arabic',
      headlineWeight: 800,
      copyWeight: 700,
    },
    logoText: 'EXPRESS · هەولێر',
    logoBadge: '🚀 2-HOUR DELIVERY',
    defaultHeadlineEn: 'Speed You Can Trust, Every Day',
    defaultHeadlineCkb: 'خێرایی و متمانە، هەموو ڕۆژێک',
    defaultCopyEn: 'Express Delivery · $4.50 USD',
    defaultCopyCkb: 'گەیاندنی خێرا · ٦٬٠٠٠ دینار',
    contactTokens: ['0750 444 3322', 'Bakhtiari, Erbil', 'express.krd'],
  },
  kaae: {
    id: 'kaae',
    name: 'Kurdistan Accrediting Association for Education',
    nameKurdish: 'دەستەی متمانەبەخشی بە پرۆگرامەکان و دامەزراوەکانی پەروەردە و خوێندنی باڵا',
    industry: 'Educational Accreditation & Institutional Quality',
    industryKurdish: 'متمانەبەخشی و ستانداردەکانی خوێندنی باڵا و پەروەردە',
    verifiedSha256: KAAE_PRIMARY_LOGO_SHA256,
    // KAAE Brand Guidelines, Excellence Edition (KAAE_Guidelines4.pdf, 2025): primary palette and
    // gradients p.7, extended palette p.8; titles Crimson Pro Bold, body Inter, Sorani sans (p.10).
    palette: {
      primary: '#4770A3',      // KAAE Blue (Pantone 5415 C)
      secondary: '#0A1628',    // Midnight: body ink, cover gradient end
      accent: '#F7B500',       // KAAE Gold (Pantone 7549 C)
      background: 'linear-gradient(135deg, #4770A3 0%, #0A1628 100%)', // cover: KAAE Blue to Midnight
      text: '#FFFFFF',
      cardBg: 'rgba(253, 248, 243, 0.98)', // Cream #FDF8F3
    },
    typography: {
      latinFont: 'Inter',
      latinDisplayFont: 'Crimson Pro',
      kurdishFont: 'Noto Sans Arabic',
      headlineWeight: 700,
      copyWeight: 400,
    },
    logoText: 'KAAE · دەستەی متمانەبەخشی',
    logoBadge: '🏛️ LAW NO. 6 OF 2022',
    defaultHeadlineEn: 'Institutional & Programmatic Accreditation Standards',
    defaultHeadlineCkb: 'ستانداردەکانی متمانەبەخشین بە خوێندنی باڵا و پەروەردە',
    defaultCopyEn: 'Kurdistan Regional Law No. 6 of 2022 · Independent Review',
    defaultCopyCkb: 'بەپێی یاسای ژمارە (٦)ی ساڵی ٢٠٢٢ · هەڵسەنگاندنی سەربەخۆ',
    contactTokens: ['www.kaae.org', 'info@kaae.krd', '60m Street, Erbil'],
  },
  fastpay: {
    id: 'fastpay',
    name: 'FastPay Mobile Wallet',
    nameKurdish: 'فاستپەی - خێراترین ڕێگای پارەدان',
    industry: 'Digital Payments & Fintech',
    industryKurdish: 'پارەدانی دیجیتاڵی و خزمەتگوزاری دارایی',
    verifiedSha256: 'sha256_fastpay_fintech_verified_c89b21',
    palette: {
      primary: '#0045F5',      // FastPay Electric Cobalt
      secondary: '#071033',    // Midnight Navy
      accent: '#F72585',       // Vibrant Fintech Magenta
      background: 'linear-gradient(150deg, #071033 0%, #0045F5 60%, #4361EE 100%)',
      text: '#FFFFFF',
      cardBg: 'rgba(255, 255, 255, 0.96)',
    },
    typography: {
      latinFont: 'Inter',
      kurdishFont: 'Vazirmatn',
      headlineWeight: 800,
      copyWeight: 700,
    },
    logoText: 'FASTPAY · فاستپەی',
    logoBadge: '⚡ 0% TRANSFER FEE',
    defaultHeadlineEn: 'Instant Money Transfer Anywhere in Kurdistan',
    defaultHeadlineCkb: 'گواستنەوەی خێرای پارە بۆ هەموو شوێنێکی کوردستان',
    defaultCopyEn: 'Send, Receive & Pay in Seconds · Licensed by CBI',
    defaultCopyCkb: 'بە چەند چرکەیەک پارە بنێرە و وەربگرە · مۆڵەتپێدراو لە بانکی ناوەندی',
    contactTokens: ['fast-pay.cash', '066 211 0000', 'Erbil Empire World'],
  },
  aster: {
    id: 'aster',
    name: 'Aster Pharmacy Kurdistan',
    nameKurdish: 'دەرمانخانەی ئاستەر',
    industry: 'Clinical Pharmacy & Healthcare Retail',
    industryKurdish: 'دەرمانخانە و چاودێری تەندروستی پزیشکی',
    verifiedSha256: 'sha256_aster_pharmacy_verified_d91e45',
    palette: {
      primary: '#00875A',      // Clinical Emerald Green
      secondary: '#0B2117',    // Deep Forest Slate
      accent: '#00A3BF',       // Clean Medical Cyan
      background: 'linear-gradient(150deg, #0B2117 0%, #00875A 60%, #00A3BF 100%)',
      text: '#FFFFFF',
      cardBg: 'rgba(255, 255, 255, 0.95)',
    },
    typography: {
      latinFont: 'Plus Jakarta Sans',
      kurdishFont: 'Noto Sans Arabic',
      headlineWeight: 800,
      copyWeight: 600,
    },
    logoText: 'ASTER · دەرمانخانەی ئاستەر',
    logoBadge: '🏥 24/7 EXPRESS CARE',
    defaultHeadlineEn: 'Your Health, Certified Medication & 24/7 Care',
    defaultHeadlineCkb: 'تەندروستی تۆ لە پێشینەمانە · دەرمانی بڕواپێکراو بە درێژایی ٢٤ کاتژمێر',
    defaultCopyEn: 'Original European Standards · Free Home Delivery in Erbil',
    defaultCopyCkb: 'ستانداردی ئەوروپی و دەرمانی ڕەسەن · گەیاندنی بێبەرامبەر لە هەولێر',
    contactTokens: ['0750 700 8899', 'Gulan Street, Erbil', 'asterpharmacy.krd'],
  },
};

export function getCanonicalBrandKit(id: string): BrandKitDefinition {
  return CANONICAL_BRAND_KITS[id] || CANONICAL_BRAND_KITS.hawa;
}

export function validateBrandKitContrast(kit: BrandKitDefinition): { isAccessible: boolean; contrastRatio: number } {
  const textLum = hexToLuminance(kit.palette.text.startsWith('#') ? kit.palette.text : '#FFFFFF');
  const bgLum = hexToLuminance(kit.palette.secondary.startsWith('#') ? kit.palette.secondary : '#0A1628');
  const ratio = calculateLuminanceContrastRatio(textLum, bgLum);
  return {
    isAccessible: ratio >= 7.0, // AAA standard
    contrastRatio: Math.round(ratio * 10) / 10,
  };
}
