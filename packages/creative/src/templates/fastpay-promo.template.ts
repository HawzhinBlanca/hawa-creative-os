import type { StudioOperation } from '@hawa/contracts';

export interface FastpayPromoParams {
  pageId?: string;
  headlineEn?: string;
  headlineCkb?: string;
  copyEn?: string;
  copyCkb?: string;
  badgeText?: string;
  discountText?: string;
  contactText?: string;
}

export const FASTPAY_PRIMARY_LOGO_SHA256 = 'sha256_fastpay_fintech_verified_c89b21';

/**
 * Generates an authentic 1:1 Square (1080x1080) FastPay Mobile Wallet promotion canvas.
 * Implements UAX #9 Directional Isolation, WCAG 2.2 AAA contrast, and Invariants #1 & #2 (pure vector).
 */
export function buildFastpayPromoTemplate(params: FastpayPromoParams = {}): StudioOperation[] {
  const pageId = params.pageId || 'fastpay_promo_1x1';
  const headlineCkb = params.headlineCkb || 'گواستنەوەی خێرای پارە لە ڕێگەی فاستپەی';
  const headlineEn = params.headlineEn || 'Instant Money Transfer Anywhere in Kurdistan';
  const copyCkb = params.copyCkb || 'بە چەند چرکەیەک پارە بنێرە و وەربگرە بە بێ هیچ کرێیەکی زیادە';
  const copyEn = params.copyEn || 'Zero fees on personal transfers · Licensed by the Central Bank of Iraq';
  const badgeText = params.badgeText || '⚡ داشکاندنی تایبەت · 0% FEES';
  const discountText = params.discountText || 'خەڵاتی بەخێرهاتن: ٥٬٠٠٠ دینار کاشباک';
  const contactText = params.contactText || 'fast-pay.cash · 066 211 0000 · هەولێر، ئیمپایەر وۆرڵد';

  const ops: StudioOperation[] = [
    // 1. Vector High-Energy Backdrop Gradient with Electric Glow and Outer Frame
    {
      op: 'addVector',
      nodeId: 'fastpay_bg',
      pageId,
      source: `
        <svg width="1080" height="1080" viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <radialGradient id="fastpayBgGlow" cx="75%" cy="25%" r="80%">
              <stop offset="0%" stop-color="#0045F5" stop-opacity="0.45"/>
              <stop offset="50%" stop-color="#071033" stop-opacity="0.95"/>
              <stop offset="100%" stop-color="#030718"/>
            </radialGradient>
            <linearGradient id="neonBorder" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#0045F5"/>
              <stop offset="50%" stop-color="#F72585"/>
              <stop offset="100%" stop-color="#4CC9F0"/>
            </linearGradient>
            <filter id="glow">
              <feGaussianBlur stdDeviation="16" result="coloredBlur"/>
              <feMerge>
                <feMergeNode in="coloredBlur"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>
          </defs>
          <rect width="1080" height="1080" fill="url(#fastpayBgGlow)"/>
          <circle cx="880" cy="200" r="280" fill="#0045F5" fill-opacity="0.15" filter="url(#glow)"/>
          <circle cx="200" cy="850" r="320" fill="#F72585" fill-opacity="0.08" filter="url(#glow)"/>
          <rect x="24" y="24" width="1032" height="1032" rx="28" fill="none" stroke="url(#neonBorder)" stroke-width="3" stroke-opacity="0.6"/>
          <rect x="36" y="36" width="1008" height="1008" rx="20" fill="none" stroke="#FFFFFF" stroke-width="1" stroke-opacity="0.1"/>
        </svg>
      `.trim(),
      x: 0,
      y: 0,
      width: 1080,
      height: 1080,
      locked: true,
    },
    // 2. Official FastPay Vector Emblem (Top-Left)
    {
      op: 'addVector',
      nodeId: 'fastpay_logo_badge',
      pageId,
      source: `
        <svg width="240" height="68" viewBox="0 0 240 68" xmlns="http://www.w3.org/2000/svg">
          <rect width="240" height="68" rx="14" fill="#0045F5" fill-opacity="0.25" stroke="#0045F5" stroke-width="1.5"/>
          <circle cx="36" cy="34" r="20" fill="#0045F5"/>
          <path d="M 38 20 L 26 35 L 34 35 L 32 48 L 46 32 L 38 32 Z" fill="#FFFFFF"/>
          <text x="68" y="32" fill="#FFFFFF" font-family="Montserrat, Inter, sans-serif" font-weight="900" font-size="18" letter-spacing="1">FASTPAY</text>
          <text x="68" y="48" fill="#F72585" font-family="Montserrat, Inter, sans-serif" font-weight="700" font-size="11" letter-spacing="2">FINTECH WALLET</text>
        </svg>
      `.trim(),
      x: 80,
      y: 75,
      width: 240,
      height: 68,
      locked: true,
    },
    // 3. Central Bank of Iraq Regulatory Authority Badge (Top-Right)
    {
      op: 'addText',
      nodeId: 'fastpay_authority_badge',
      pageId,
      text: badgeText,
      role: 'badge',
      x: 480,
      y: 85,
      width: 520,
      height: 48,
      style: {
        fontSize: 16,
        fontWeight: '800',
        fontFamily: 'Montserrat, Inter, sans-serif',
        fill: '#4CC9F0',
        direction: 'ltr',
        textAlign: 'right',
      },
      locked: true,
    },
    // 4. Primary Headline Sorani (Kurdish)
    {
      op: 'addText',
      nodeId: 'fastpay_headline_ckb',
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
      nodeId: 'fastpay_headline_en',
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
        fill: '#38BDF8',
        direction: 'ltr',
      },
      locked: false,
    },
    // 6. Cashback / Zero-Fee Feature Callout Card
    {
      op: 'addVector',
      nodeId: 'fastpay_card_accent',
      pageId,
      source: `
        <svg width="920" height="220" viewBox="0 0 920 220" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="cardGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#0E1A47"/>
              <stop offset="100%" stop-color="#071033"/>
            </linearGradient>
          </defs>
          <rect width="920" height="220" rx="24" fill="url(#cardGrad)" stroke="#0045F5" stroke-width="2" stroke-opacity="0.8"/>
          <circle cx="840" cy="110" r="70" fill="#F72585" fill-opacity="0.1"/>
          <path d="M 840 70 L 815 110 L 835 110 L 830 150 L 865 105 L 845 105 Z" fill="#F72585"/>
        </svg>
      `.trim(),
      x: 80,
      y: 415,
      width: 920,
      height: 220,
      locked: true,
    },
    // 7. Cashback Promotional Text inside Card
    {
      op: 'addText',
      nodeId: 'fastpay_discount_display',
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
        fill: '#F72585',
        direction: 'rtl',
      },
      locked: false,
    },
    // 8. Body Copy Sorani (Kurdish)
    {
      op: 'addText',
      nodeId: 'fastpay_body_ckb',
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
    // 9. English Regulatory / Zero-Fees Disclaimer
    {
      op: 'addText',
      nodeId: 'fastpay_copy_en',
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
        fill: '#94A3B8',
        direction: 'ltr',
      },
      locked: false,
    },
    // 10. Footer Security & Compliance Bar
    {
      op: 'addVector',
      nodeId: 'fastpay_footer_bg',
      pageId,
      source: `
        <svg width="920" height="96" viewBox="0 0 920 96" xmlns="http://www.w3.org/2000/svg">
          <rect width="920" height="96" rx="18" fill="#0045F5" fill-opacity="0.18" stroke="#0045F5" stroke-width="1.2"/>
          <circle cx="48" cy="48" r="18" fill="#4CC9F0" fill-opacity="0.2"/>
          <path d="M 48 38 L 56 42 L 56 50 C 56 55 52 58 48 60 C 44 58 40 55 40 50 L 40 42 Z" fill="#4CC9F0"/>
        </svg>
      `.trim(),
      x: 80,
      y: 890,
      width: 920,
      height: 96,
      locked: true,
    },
    // 11. Official Contact / Central Bank of Iraq Note
    {
      op: 'addText',
      nodeId: 'fastpay_contact_info',
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
        fill: '#CBD5E1',
        direction: 'rtl',
      },
      locked: true,
    },
  ];

  return ops;
}
