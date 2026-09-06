import type { StudioOperation } from '@hawa/contracts';
import { KAAE_PRIMARY_LOGO_SHA256 } from './kaae-certificate.template.js';

export interface KaaeAnnouncementParams {
  pageId?: string;
  headlineCkb: string;
  headlineEn?: string;
  copyCkb: string;
  copyEn?: string;
  categoryBadge?: string;
  heroImageSha256?: string;
  logoSha256?: string;
  dateStr?: string;
}

/**
 * Generates an authoritative 1080 x 1350 Social Feed Announcement Card for KAAE
 * Invariant 1: Editable vector and live text operations.
 * Invariant 3: Live text with Sorani RTL and Western digit preservation.
 * Invariant 4: Official verified cryptographic emblem asset.
 */
export function buildKaaeAnnouncementOperations(params: KaaeAnnouncementParams): StudioOperation[] {
  const pageId = params.pageId || 'page_announcement';
  const logoSha = params.logoSha256 || KAAE_PRIMARY_LOGO_SHA256;
  const ops: StudioOperation[] = [];

  const width = 1080;
  const height = 1350;

  // 1. Vector Deep Institutional Navy Foundation
  ops.push({
    op: 'addVector',
    nodeId: 'ann_bg',
    pageId,
    source: `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="kaaeMidnightGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#0A1628"/>
            <stop offset="35%" stop-color="#160874"/>
            <stop offset="75%" stop-color="#1E3A5F"/>
            <stop offset="100%" stop-color="#2C5282"/>
          </linearGradient>
          <pattern id="annTriangles" width="80" height="80" patternUnits="userSpaceOnUse">
            <polygon points="40,10 70,70 10,70" fill="none" stroke="#F7B500" stroke-width="0.75" stroke-opacity="0.05"/>
            <polygon points="40,70 70,10 10,10" fill="none" stroke="#4770A3" stroke-width="0.75" stroke-opacity="0.04"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#kaaeMidnightGrad)"/>
        <rect width="100%" height="100%" fill="url(#annTriangles)"/>
        <!-- Soft Golden Ambient Aura at Top Corner -->
        <circle cx="900" cy="150" r="300" fill="#F7B500" fill-opacity="0.08" filter="blur(60px)"/>
      </svg>
    `.trim(),
    x: 0,
    y: 0,
    width,
    height,
    locked: true,
  });

  // 2. Header Container with Gold Border Accent
  ops.push({
    op: 'addVector',
    nodeId: 'ann_header_bar',
    pageId,
    source: `
      <svg width="${width - 120}" height="2" viewBox="0 0 ${width - 120} 2" xmlns="http://www.w3.org/2000/svg">
        <line x1="0" y1="1" x2="${width - 120}" y2="1" stroke="#F7B500" stroke-width="2" stroke-opacity="0.8"/>
      </svg>
    `.trim(),
    x: 60,
    y: 190,
    width: width - 120,
    height: 2,
    locked: true,
  });

  // 3. Official KAAE Emblem (Header Left/Right, 260 x 120)
  ops.push({
    op: 'addImage',
    nodeId: 'ann_logo',
    pageId,
    asset: {
      storageKey: `assets/logos/${logoSha}.png`,
      sha256: logoSha,
      mimeType: 'image/png',
    },
    x: 60,
    y: 60,
    width: 250,
    height: 110,
    fit: 'contain',
    locked: true,
  });

  // Category / Commission Badge (Top Right)
  const categoryBadgeText = params.categoryBadge || 'ڕاگەیەندراوی فەرمی · KAAE OFFICIAL';
  ops.push({
    op: 'addText',
    nodeId: 'ann_category_badge',
    pageId,
    text: categoryBadgeText,
    role: 'disclaimer',
    x: width - 560,
    y: 95,
    width: 500,
    height: 40,
    style: {
      fontSize: 20,
      fontWeight: 'bold',
      fontFamily: 'Cairo',
      textAlign: 'right',
      color: '#F7B500',
      letterSpacing: 2,
    },
    locked: true,
  });

  // 4. Hero Visual Slot (Optional photo or institutional motif)
  let contentY = 220;
  if (params.heroImageSha256) {
    const heroH = 460;
    ops.push({
      op: 'addImage',
      nodeId: 'ann_hero_img',
      pageId,
      asset: {
        storageKey: `assets/imagery/${params.heroImageSha256}.jpg`,
        sha256: params.heroImageSha256,
        mimeType: 'image/jpeg',
      },
      x: 60,
      y: contentY,
      width: width - 120,
      height: heroH,
      fit: 'cover',
      locked: false,
    });

    // Smart Contrast Scrim Plate over hero
    ops.push({
      op: 'addVector',
      nodeId: 'ann_hero_scrim',
      pageId,
      source: `
        <svg width="${width - 120}" height="${heroH}" viewBox="0 0 ${width - 120} ${heroH}" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="heroScrimGrad" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stop-color="#0A1628" stop-opacity="0.1"/>
              <stop offset="60%" stop-color="#0A1628" stop-opacity="0.4"/>
              <stop offset="100%" stop-color="#0A1628" stop-opacity="0.95"/>
            </linearGradient>
          </defs>
          <rect width="100%" height="100%" fill="url(#heroScrimGrad)"/>
          <rect width="100%" height="100%" fill="none" stroke="#4770A3" stroke-width="1.5" stroke-opacity="0.4"/>
        </svg>
      `.trim(),
      x: 60,
      y: contentY,
      width: width - 120,
      height: heroH,
      locked: true,
    });

    contentY += heroH + 40;
  } else {
    // Elegant Content Card Plinth (Parchment white frosted panel)
    ops.push({
      op: 'addVector',
      nodeId: 'ann_card_panel',
      pageId,
      source: `
        <svg width="${width - 120}" height="860" viewBox="0 0 ${width - 120} 860" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" rx="16" fill="#0A1628" fill-opacity="0.6"/>
          <rect width="100%" height="100%" rx="16" fill="none" stroke="#4770A3" stroke-width="2" stroke-opacity="0.3"/>
          <rect x="20" y="20" width="${width - 160}" height="820" rx="12" fill="none" stroke="#F7B500" stroke-width="1" stroke-opacity="0.15"/>
        </svg>
      `.trim(),
      x: 60,
      y: contentY,
      width: width - 120,
      height: 860,
      locked: true,
    });

    contentY += 60;
  }

  // 5. Kurdish Headline (Cairo Bold, RTL aligned, 52px)
  ops.push({
    op: 'addText',
    nodeId: 'ann_headline_ckb',
    pageId,
    text: params.headlineCkb,
    role: 'headline',
    x: 100,
    y: contentY,
    width: width - 200,
    height: 140,
    style: {
      fontSize: 50,
      fontWeight: 'bold',
      fontFamily: 'Cairo',
      textAlign: 'right',
      color: '#FFFFFF',
      lineHeight: 1.4,
    },
    locked: false,
  });
  contentY += 150;

  // 6. Optional English Headline (Minion Variable Bold, 38px)
  if (params.headlineEn) {
    ops.push({
      op: 'addText',
      nodeId: 'ann_headline_en',
      pageId,
      text: params.headlineEn,
      role: 'headline',
      x: 100,
      y: contentY,
      width: width - 200,
      height: 70,
      style: {
        fontSize: 34,
        fontWeight: 'bold',
        fontFamily: 'Minion Variable Concept',
        textAlign: 'left',
        color: '#F7B500',
        lineHeight: 1.3,
      },
      locked: false,
    });
    contentY += 80;
  }

  // Divider Accent
  ops.push({
    op: 'addVector',
    nodeId: 'ann_body_divider',
    pageId,
    source: `
      <svg width="${width - 200}" height="2" viewBox="0 0 ${width - 200} 2" xmlns="http://www.w3.org/2000/svg">
        <line x1="0" y1="1" x2="${width - 200}" y2="1" stroke="#4770A3" stroke-width="1" stroke-opacity="0.4"/>
      </svg>
    `.trim(),
    x: 100,
    y: contentY,
    width: width - 200,
    height: 2,
    locked: true,
  });
  contentY += 30;

  // 7. Kurdish Body Copy (Noto Naskh Arabic, 30px)
  ops.push({
    op: 'addText',
    nodeId: 'ann_copy_ckb',
    pageId,
    text: params.copyCkb,
    role: 'subheadline',
    x: 100,
    y: contentY,
    width: width - 200,
    height: 220,
    style: {
      fontSize: 28,
      fontWeight: '500',
      fontFamily: 'Noto Naskh Arabic',
      textAlign: 'right',
      color: '#E2E8F0',
      lineHeight: 1.6,
    },
    locked: false,
  });
  contentY += 230;

  // 8. Optional English Copy
  if (params.copyEn) {
    ops.push({
      op: 'addText',
      nodeId: 'ann_copy_en',
      pageId,
      text: params.copyEn,
      role: 'subheadline',
      x: 100,
      y: contentY,
      width: width - 200,
      height: 160,
      style: {
        fontSize: 24,
        fontWeight: 'normal',
        fontFamily: 'Inter',
        textAlign: 'left',
        color: '#CBD5E1',
        lineHeight: 1.5,
      },
      locked: false,
    });
  }

  // 9. Statutory Authority Citation Badge (Kurdistan Law No. 6 of 2022)
  ops.push({
    op: 'addText',
    nodeId: 'ann_statutory_rule',
    pageId,
    text: 'یاسای ژمارە (٦)ی ساڵی ٢٠٢٢ · پەرلەمانی کوردستان | Kurdistan Regional Law No. 6 of 2022',
    role: 'disclaimer',
    x: 60,
    y: height - 150,
    width: width - 120,
    height: 35,
    style: {
      fontSize: 18,
      fontWeight: '600',
      fontFamily: 'Cairo',
      textAlign: 'center',
      color: '#D4A94C',
      letterSpacing: 1,
    },
    locked: true,
  });

  // 10. Footer Contact Tokens & Web Address
  ops.push({
    op: 'addText',
    nodeId: 'ann_footer_tokens',
    pageId,
    text: 'www.kaae.org · info@kaae.krd · 60m Street, Erbil, Kurdistan Region',
    role: 'disclaimer',
    x: 60,
    y: height - 95,
    width: width - 120,
    height: 30,
    style: {
      fontSize: 18,
      fontFamily: 'Inter',
      textAlign: 'center',
      color: '#94A3B8',
      letterSpacing: 1,
    },
    locked: true,
  });

  return ops;
}
