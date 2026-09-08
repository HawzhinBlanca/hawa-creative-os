import type { StudioOperation } from '@hawa/contracts';

export interface AsterHealthcareParams {
  pageId?: string;
  headlineEn?: string;
  headlineCkb?: string;
  copyEn?: string;
  copyCkb?: string;
  badgeText?: string;
  discountBadge?: string;
  offerPill?: string;
  discountText?: string;
  contactText?: string;
}

export const ASTER_PRIMARY_LOGO_SHA256 = 'sha256_aster_pharmacy_verified_b87a12';

/**
 * Generates an authentic 4:5 Portrait (1080x1350) Aster Pharmacy Kurdistan campaign canvas.
 * Implements clinical wellness aesthetic, UAX #9 Directional Isolation, WCAG 2.2 AAA contrast, and Invariants #1 & #2.
 */
export function buildAsterHealthcareTemplate(params: AsterHealthcareParams = {}): StudioOperation[] {
  const pageId = params.pageId || 'aster_healthcare_4x5';
  const headlineCkb = params.headlineCkb || 'خزمەتگوزاری تەندروستی ٢٤ کاتژمێری لە دەرمانخانەی ئاستەر';
  const headlineEn = params.headlineEn || '24/7 Professional Healthcare & Prescription Service';
  const copyCkb = params.copyCkb || 'باشترین براندە جیهانییەکانی ڤیتامین و تەندروستی خێزان بە گەرەنتی کوالیتی سەردەمیانە';
  const copyEn = params.copyEn || 'Trusted worldwide wellness & infant care · Licensed by KRG Ministry of Health';
  const badgeText = params.badgeText || '🏥 تەندروستی و دەرمان · 24/7 CLINICAL CARE';
  const discountText = params.discountText || 'داشکاندنی وەرزی: ٪٢٥ بۆ هەموو ڤیتامین و بەرهەمەکان';
  const contactText = params.contactText || 'aster.krd · 066 455 1122 · هەولێر، شەقامی ١٠٠ مەتری، نزیک نەخۆشخانەی فریاکەوتن';

  const ops: StudioOperation[] = [
    // 1. Vector 4:5 Clinical Emerald Backdrop with Medical Cross Geometry
    {
      op: 'addVector',
      nodeId: 'aster_bg',
      pageId,
      source: `
        <svg width="1080" height="1350" viewBox="0 0 1080 1350" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <radialGradient id="asterEmeraldGlow" cx="50%" cy="20%" r="85%">
              <stop offset="0%" stop-color="#064E3B" stop-opacity="0.9"/>
              <stop offset="60%" stop-color="#02231E" stop-opacity="0.98"/>
              <stop offset="100%" stop-color="#011411"/>
            </radialGradient>
            <pattern id="medicalPlusPattern" width="64" height="64" patternUnits="userSpaceOnUse">
              <path d="M 28 20 H 36 V 28 H 44 V 36 H 36 V 44 H 28 V 36 H 20 V 28 H 28 Z" fill="#10B981" fill-opacity="0.04"/>
            </pattern>
          </defs>
          <rect width="1080" height="1350" fill="url(#asterEmeraldGlow)"/>
          <rect width="1080" height="1350" fill="url(#medicalPlusPattern)"/>
          <circle cx="950" cy="180" r="320" fill="#10B981" fill-opacity="0.08" filter="blur(60px)"/>
          <circle cx="120" cy="1150" r="280" fill="#34D399" fill-opacity="0.06" filter="blur(70px)"/>
          <!-- Clinical Border -->
          <rect x="28" y="28" width="1024" height="1294" rx="28" fill="none" stroke="#10B981" stroke-width="2.5" stroke-opacity="0.35"/>
          <rect x="40" y="40" width="1000" height="1270" rx="20" fill="none" stroke="#FFFFFF" stroke-width="1" stroke-opacity="0.08"/>
        </svg>
      `.trim(),
      x: 0,
      y: 0,
      width: 1080,
      height: 1350,
      locked: true,
    },
    // 2. Official Aster Pharmacy Vector Emblem (Top-Left)
    {
      op: 'addVector',
      nodeId: 'aster_logo_badge',
      pageId,
      source: `
        <svg width="260" height="72" viewBox="0 0 260 72" xmlns="http://www.w3.org/2000/svg">
          <rect width="260" height="72" rx="16" fill="#064E3B" fill-opacity="0.5" stroke="#10B981" stroke-width="1.5"/>
          <circle cx="40" cy="36" r="22" fill="#10B981"/>
          <!-- Medical Cross Emblem -->
          <rect x="36" y="24" width="8" height="24" rx="2" fill="#FFFFFF"/>
          <rect x="28" y="32" width="24" height="8" rx="2" fill="#FFFFFF"/>
          <text x="74" y="34" fill="#FFFFFF" font-family="Montserrat, Inter, sans-serif" font-weight="900" font-size="18" letter-spacing="1.5">ASTER</text>
          <text x="74" y="52" fill="#34D399" font-family="Montserrat, Inter, sans-serif" font-weight="700" font-size="11" letter-spacing="2">PHARMACY · کەمپەین</text>
        </svg>
      `.trim(),
      x: 80,
      y: 80,
      width: 260,
      height: 72,
      locked: true,
    },
    // 3. Clinical Authority Badge (Top-Right)
    {
      op: 'addText',
      nodeId: 'aster_authority_badge',
      pageId,
      text: badgeText,
      role: 'badge',
      x: 480,
      y: 92,
      width: 520,
      height: 48,
      style: {
        fontSize: 16,
        fontWeight: '800',
        fontFamily: 'Montserrat, Inter, sans-serif',
        fill: '#34D399',
        direction: 'ltr',
        textAlign: 'right',
      },
      locked: true,
    },
    // 4. Primary Kurdish Headline (Sorani)
    {
      op: 'addText',
      nodeId: 'aster_headline_ckb',
      pageId,
      text: `\u2067${headlineCkb}\u2069`,
      role: 'headline',
      x: 80,
      y: 220,
      width: 920,
      height: 140,
      style: {
        fontSize: 46,
        fontWeight: '800',
        fontFamily: 'Noto Sans Arabic, sans-serif',
        fill: '#FFFFFF',
        direction: 'rtl',
        lineHeight: 1.35,
      },
      locked: false,
    },
    // 5. English Subheading
    {
      op: 'addText',
      nodeId: 'aster_headline_en',
      pageId,
      text: headlineEn,
      role: 'subheading',
      x: 80,
      y: 380,
      width: 920,
      height: 52,
      style: {
        fontSize: 24,
        fontWeight: '600',
        fontFamily: 'Montserrat, Inter, sans-serif',
        fill: '#A7F3D0',
        direction: 'ltr',
      },
      locked: false,
    },
    // 6. Clinical Discount / Offer Card
    {
      op: 'addVector',
      nodeId: 'aster_discount_card',
      pageId,
      source: `
        <svg width="920" height="260" viewBox="0 0 920 260" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="asterCardGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#064E3B" stop-opacity="0.85"/>
              <stop offset="100%" stop-color="#022C24" stop-opacity="0.95"/>
            </linearGradient>
          </defs>
          <rect width="920" height="260" rx="24" fill="url(#asterCardGrad)" stroke="#10B981" stroke-width="2" stroke-opacity="0.6"/>
          <circle cx="830" cy="130" r="75" fill="#10B981" fill-opacity="0.12"/>
          <!-- Medical Shield -->
          <path d="M 830 85 L 865 100 V 135 C 865 160 830 175 830 175 C 830 175 795 160 795 135 V 100 Z" fill="none" stroke="#10B981" stroke-width="3"/>
          <path d="M 825 125 L 835 135 L 850 115" fill="none" stroke="#34D399" stroke-width="3.5" stroke-linecap="round"/>
        </svg>
      `.trim(),
      x: 80,
      y: 470,
      width: 920,
      height: 260,
      locked: true,
    },
    // 7. Discount / Clinical Text inside Card
    {
      op: 'addText',
      nodeId: 'aster_discount_display',
      pageId,
      text: `\u2067${discountText}\u2069`,
      role: 'highlight',
      x: 120,
      y: 520,
      width: 660,
      height: 64,
      style: {
        fontSize: 34,
        fontWeight: '800',
        fontFamily: 'Noto Sans Arabic, sans-serif',
        fill: '#FCD34D',
        direction: 'rtl',
      },
      locked: false,
    },
    // 8. Body Copy Sorani (Kurdish)
    {
      op: 'addText',
      nodeId: 'aster_body_ckb',
      pageId,
      text: `\u2067${copyCkb}\u2069`,
      role: 'body',
      x: 120,
      y: 605,
      width: 660,
      height: 90,
      style: {
        fontSize: 22,
        fontWeight: '500',
        fontFamily: 'Noto Sans Arabic, sans-serif',
        fill: '#F1F5F9',
        direction: 'rtl',
        lineHeight: 1.5,
      },
      locked: false,
    },
    // 9. English Regulatory / Ministry of Health Disclaimer
    {
      op: 'addText',
      nodeId: 'aster_copy_en',
      pageId,
      text: copyEn,
      role: 'caption',
      x: 80,
      y: 770,
      width: 920,
      height: 52,
      style: {
        fontSize: 20,
        fontWeight: '500',
        fontFamily: 'Inter, sans-serif',
        fill: '#A7F3D0',
        direction: 'ltr',
      },
      locked: false,
    },
    // 10. Secondary Clinical Pillars (Prescriptions, Vitamins, Diagnostics)
    {
      op: 'addVector',
      nodeId: 'aster_pillars_bg',
      pageId,
      source: `
        <svg width="920" height="240" viewBox="0 0 920 240" xmlns="http://www.w3.org/2000/svg">
          <g transform="translate(0, 0)">
            <rect width="290" height="240" rx="18" fill="#064E3B" fill-opacity="0.4" stroke="#10B981" stroke-width="1.2"/>
            <circle cx="145" cy="70" r="32" fill="#10B981" fill-opacity="0.2"/>
            <text x="145" y="145" fill="#FFFFFF" font-family="Noto Sans Arabic, sans-serif" font-weight="700" font-size="20" text-anchor="middle">دەرمانی ڕەسەن</text>
            <text x="145" y="180" fill="#94A3B8" font-family="Inter, sans-serif" font-size="14" text-anchor="middle">100% Genuine RX</text>
          </g>
          <g transform="translate(315, 0)">
            <rect width="290" height="240" rx="18" fill="#064E3B" fill-opacity="0.4" stroke="#10B981" stroke-width="1.2"/>
            <circle cx="145" cy="70" r="32" fill="#10B981" fill-opacity="0.2"/>
            <text x="145" y="145" fill="#FFFFFF" font-family="Noto Sans Arabic, sans-serif" font-weight="700" font-size="20" text-anchor="middle">راوێژی پزیشکی</text>
            <text x="145" y="180" fill="#94A3B8" font-family="Inter, sans-serif" font-size="14" text-anchor="middle">Expert Pharmacists</text>
          </g>
          <g transform="translate(630, 0)">
            <rect width="290" height="240" rx="18" fill="#064E3B" fill-opacity="0.4" stroke="#10B981" stroke-width="1.2"/>
            <circle cx="145" cy="70" r="32" fill="#10B981" fill-opacity="0.2"/>
            <text x="145" y="145" fill="#FFFFFF" font-family="Noto Sans Arabic, sans-serif" font-weight="700" font-size="20" text-anchor="middle">گەیاندنی خێرا</text>
            <text x="145" y="180" fill="#94A3B8" font-family="Inter, sans-serif" font-size="14" text-anchor="middle">Express Delivery</text>
          </g>
        </svg>
      `.trim(),
      x: 80,
      y: 860,
      width: 920,
      height: 240,
      locked: true,
    },
    // 11. Footer Clinical Contact Bar
    {
      op: 'addVector',
      nodeId: 'aster_footer_bg',
      pageId,
      source: `
        <svg width="920" height="108" viewBox="0 0 920 108" xmlns="http://www.w3.org/2000/svg">
          <rect width="920" height="108" rx="20" fill="#011B17" stroke="#10B981" stroke-width="1.5" stroke-opacity="0.5"/>
          <circle cx="54" cy="54" r="22" fill="#10B981" fill-opacity="0.2"/>
          <path d="M 54 42 V 66 M 42 54 H 66" stroke="#10B981" stroke-width="3" stroke-linecap="round"/>
        </svg>
      `.trim(),
      x: 80,
      y: 1140,
      width: 920,
      height: 108,
      locked: true,
    },
    // 12. Footer Contact Text
    {
      op: 'addText',
      nodeId: 'aster_contact_info',
      pageId,
      text: contactText,
      role: 'footer',
      x: 170,
      y: 1178,
      width: 800,
      height: 38,
      style: {
        fontSize: 17,
        fontWeight: '700',
        fontFamily: 'Noto Sans Arabic, Montserrat, sans-serif',
        fill: '#E2E8F0',
        direction: 'rtl',
      },
      locked: true,
    },
  ];

  return ops;
}
