/**
 * Hawa Creative OS — Client Brand Kits
 * Canonical brand guidelines and asset profiles for Iraqi Kurdistan and Middle Eastern commercial markets.
 */

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
  headlineWeight: number;
  copyWeight: number;
}

export interface BrandKit {
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

export const BRAND_KITS: Record<string, BrandKit> = {
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
};

export const getBrandKit = (id: string): BrandKit => {
  const custom = getCustomBrandKits();
  return custom[id] || BRAND_KITS[id] || BRAND_KITS.hawa;
};

const CUSTOM_BRAND_KITS_KEY = 'hawa_custom_brand_kits';

/**
 * Retrieves all user-defined brand kits from local persistence
 */
export const getCustomBrandKits = (): Record<string, BrandKit> => {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(CUSTOM_BRAND_KITS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

/**
 * Persists a new or updated custom brand kit
 */
export const saveCustomBrandKit = (kit: BrandKit): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    const current = getCustomBrandKits();
    current[kit.id] = kit;
    localStorage.setItem(CUSTOM_BRAND_KITS_KEY, JSON.stringify(current));
  } catch (err) {
    console.warn('[BrandKits] Failed to save custom brand kit:', err);
  }
};

/**
 * Combines built-in canonical brand kits with custom client brand kits
 */
export const getAllBrandKits = (): Record<string, BrandKit> => {
  return {
    ...BRAND_KITS,
    ...getCustomBrandKits(),
  };
};
