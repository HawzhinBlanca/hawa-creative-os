import type { StudioOperation } from '@hawa/contracts';

export interface DrusteeClinicalParams {
  pageId?: string;
  headlineEn?: string;
  headlineCkb?: string;
  copyEn?: string;
  copyCkb?: string;
  badgeText?: string;
  potencyBadge?: string;
  lotText?: string;
  discountText?: string;
  contactText?: string;
}

export const DRUSTEE_PRIMARY_LOGO_SHA256 = 'sha256_drustee_health_verified_f93e44';

/**
 * Generates an authentic 1:1 Square (1080x1080) Drustee Health & Supplements showcase canvas.
 * Implements botanical wellness aesthetic, UAX #9 Directional Isolation, WCAG 2.2 AAA contrast, and Invariants #1 & #2.
 */
export function buildDrusteeClinicalTemplate(params: DrusteeClinicalParams = {}): StudioOperation[] {
  const pageId = params.pageId || 'drustee_clinical_1x1';
  const headlineCkb = params.headlineCkb || 'تەواوکەری خۆراکی سروشتی بۆ تەندروستی خێزان';
  const headlineEn = params.headlineEn || 'Premium Organic Nutrition & Clinical Supplements';
  const copyCkb = params.copyCkb || 'بڕوانامەپێدراوی نێودەوڵەتی GMP و تاقیگەی کۆنتڕۆڵی جۆریی هەرێمی کوردستان';
  const copyEn = params.copyEn || 'Certified 100% Organic & Non-GMO · Laboratory Tested for Maximum Potency';
  const badgeText = params.badgeText || '🌿 سروشتی و زانستی · CERTIFIED GMP';
  const discountText = params.discountText || 'پاکێجی تایبەتی ڤیتامین C و زینک بە داشکاندنی ٪٣٠';
  const contactText = params.contactText || 'drustee.krd · 0750 999 4433 · سلێمانی، شەقامی توی مەلیک';

  const ops: StudioOperation[] = [
    // 1. Vector 1:1 Botanical Forest Backdrop with Gold Aura
    {
      op: 'addVector',
      nodeId: 'drustee_bg',
      pageId,
      source: `
        <svg width="1080" height="1080" viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <radialGradient id="drusteeForestGlow" cx="40%" cy="30%" r="85%">
              <stop offset="0%" stop-color="#0B3828" stop-opacity="0.95"/>
              <stop offset="60%" stop-color="#062319" stop-opacity="0.98"/>
              <stop offset="100%" stop-color="#02140D"/>
            </radialGradient>
            <pattern id="botanicalPattern" width="70" height="70" patternUnits="userSpaceOnUse">
              <path d="M 35 15 C 35 15 45 25 45 35 C 45 45 35 55 35 55 C 35 55 25 45 25 35 C 25 25 35 15 35 15 Z" fill="none" stroke="#EAB308" stroke-width="0.8" stroke-opacity="0.06"/>
            </pattern>
          </defs>
          <rect width="1080" height="1080" fill="url(#drusteeForestGlow)"/>
          <rect width="1080" height="1080" fill="url(#botanicalPattern)"/>
          <circle cx="920" cy="180" r="300" fill="#EAB308" fill-opacity="0.06" filter="blur(60px)"/>
          <circle cx="150" cy="900" r="260" fill="#10B981" fill-opacity="0.08" filter="blur(60px)"/>
          <!-- Gold and Emerald Frame -->
          <rect x="24" y="24" width="1032" height="1032" rx="24" fill="none" stroke="#EAB308" stroke-width="2" stroke-opacity="0.4"/>
          <rect x="36" y="36" width="1008" height="1008" rx="16" fill="none" stroke="#10B981" stroke-width="0.8" stroke-opacity="0.25"/>
        </svg>
      `.trim(),
      x: 0,
      y: 0,
      width: 1080,
      height: 1080,
      locked: true,
    },
    // 2. Official Drustee Health Vector Emblem (Top-Left)
    {
      op: 'addVector',
      nodeId: 'drustee_logo_badge',
      pageId,
      source: `
        <svg width="250" height="70" viewBox="0 0 250 70" xmlns="http://www.w3.org/2000/svg">
          <rect width="250" height="70" rx="14" fill="#0B3828" fill-opacity="0.6" stroke="#EAB308" stroke-width="1.5"/>
          <circle cx="38" cy="35" r="20" fill="#EAB308" fill-opacity="0.15"/>
          <!-- Leaf & Drop Emblem -->
          <path d="M 38 20 C 38 20 48 30 48 38 C 48 44 43 49 38 49 C 33 49 28 44 28 38 C 28 30 38 20 38 20 Z" fill="#EAB308"/>
          <text x="70" y="34" fill="#FFFFFF" font-family="Montserrat, Inter, sans-serif" font-weight="900" font-size="18" letter-spacing="1">DRUSTEE</text>
          <text x="70" y="50" fill="#EAB308" font-family="Montserrat, Inter, sans-serif" font-weight="700" font-size="11" letter-spacing="2">HEALTH & WELLNESS</text>
        </svg>
      `.trim(),
      x: 80,
      y: 75,
      width: 250,
      height: 70,
      locked: true,
    },
    // 3. Botanical Quality Badge (Top-Right)
    {
      op: 'addText',
      nodeId: 'drustee_authority_badge',
      pageId,
      text: badgeText,
      role: 'badge',
      x: 480,
      y: 88,
      width: 520,
      height: 48,
      style: {
        fontSize: 16,
        fontWeight: '800',
        fontFamily: 'Montserrat, Inter, sans-serif',
        fill: '#FDE047',
        direction: 'ltr',
        textAlign: 'right',
      },
      locked: true,
    },
    // 4. Primary Kurdish Headline (Sorani)
    {
      op: 'addText',
      nodeId: 'drustee_headline_ckb',
      pageId,
      text: `\u2067${headlineCkb}\u2069`,
      role: 'headline',
      x: 80,
      y: 200,
      width: 920,
      height: 120,
      style: {
        fontSize: 44,
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
      nodeId: 'drustee_headline_en',
      pageId,
      text: headlineEn,
      role: 'subheading',
      x: 80,
      y: 335,
      width: 920,
      height: 48,
      style: {
        fontSize: 22,
        fontWeight: '600',
        fontFamily: 'Montserrat, Inter, sans-serif',
        fill: '#FDE047',
        direction: 'ltr',
      },
      locked: false,
    },
    // 6. Supplement Showcase Card
    {
      op: 'addVector',
      nodeId: 'drustee_card_accent',
      pageId,
      source: `
        <svg width="920" height="220" viewBox="0 0 920 220" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="drusteeCardGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#0B3828" stop-opacity="0.85"/>
              <stop offset="100%" stop-color="#062319" stop-opacity="0.95"/>
            </linearGradient>
          </defs>
          <rect width="920" height="220" rx="24" fill="url(#drusteeCardGrad)" stroke="#EAB308" stroke-width="2" stroke-opacity="0.6"/>
          <circle cx="830" cy="110" r="70" fill="#EAB308" fill-opacity="0.12"/>
          <!-- Sun Seal / GMP Stamp -->
          <circle cx="830" cy="110" r="45" fill="none" stroke="#EAB308" stroke-width="2" stroke-dasharray="4 3"/>
          <text x="830" y="116" fill="#EAB308" font-family="Inter, sans-serif" font-weight="900" font-size="14" text-anchor="middle">GMP</text>
        </svg>
      `.trim(),
      x: 80,
      y: 415,
      width: 920,
      height: 220,
      locked: true,
    },
    // 7. Discount / Promotional Text inside Card
    {
      op: 'addText',
      nodeId: 'drustee_discount_display',
      pageId,
      text: `\u2067${discountText}\u2069`,
      role: 'highlight',
      x: 120,
      y: 460,
      width: 680,
      height: 56,
      style: {
        fontSize: 32,
        fontWeight: '800',
        fontFamily: 'Noto Sans Arabic, sans-serif',
        fill: '#FDE047',
        direction: 'rtl',
      },
      locked: false,
    },
    // 8. Body Copy Sorani (Kurdish)
    {
      op: 'addText',
      nodeId: 'drustee_body_ckb',
      pageId,
      text: `\u2067${copyCkb}\u2069`,
      role: 'body',
      x: 120,
      y: 535,
      width: 680,
      height: 65,
      style: {
        fontSize: 20,
        fontWeight: '500',
        fontFamily: 'Noto Sans Arabic, sans-serif',
        fill: '#E2E8F0',
        direction: 'rtl',
        lineHeight: 1.45,
      },
      locked: false,
    },
    // 9. English Regulatory / Laboratory Disclaimer
    {
      op: 'addText',
      nodeId: 'drustee_copy_en',
      pageId,
      text: copyEn,
      role: 'caption',
      x: 80,
      y: 680,
      width: 920,
      height: 48,
      style: {
        fontSize: 18,
        fontWeight: '500',
        fontFamily: 'Inter, sans-serif',
        fill: '#CBD5E1',
        direction: 'ltr',
      },
      locked: false,
    },
    // 10. Footer Botanical Quality Bar
    {
      op: 'addVector',
      nodeId: 'drustee_footer_bg',
      pageId,
      source: `
        <svg width="920" height="96" viewBox="0 0 920 96" xmlns="http://www.w3.org/2000/svg">
          <rect width="920" height="96" rx="18" fill="#02140D" stroke="#EAB308" stroke-width="1.2" stroke-opacity="0.4"/>
          <circle cx="48" cy="48" r="18" fill="#EAB308" fill-opacity="0.15"/>
          <path d="M 48 38 C 48 38 54 44 54 48 C 54 52 51 55 48 55 C 45 55 42 52 42 48 C 42 44 48 38 48 38 Z" fill="#EAB308"/>
        </svg>
      `.trim(),
      x: 80,
      y: 890,
      width: 920,
      height: 96,
      locked: true,
    },
    // 11. Official Contact / Pharmacy Location
    {
      op: 'addText',
      nodeId: 'drustee_contact_info',
      pageId,
      text: contactText,
      role: 'footer',
      x: 170,
      y: 924,
      width: 800,
      height: 36,
      style: {
        fontSize: 17,
        fontWeight: '700',
        fontFamily: 'Noto Sans Arabic, Montserrat, sans-serif',
        fill: '#F8FAF8',
        direction: 'rtl',
      },
      locked: true,
    },
  ];

  return ops;
}
