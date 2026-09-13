import type { StudioOperation } from '@hawa/contracts';
import type { BuzzFieldMapping } from '@hawa/contracts';
import { KAAE_PRIMARY_LOGO_SHA256 } from './kaae-certificate.template.js';

export interface KaaeAnnouncementParams {
  pageId?: string;
  width?: number;
  height?: number;
  headlineEn?: string;
  headlineCkb?: string;
  copyEn?: string;
  copyCkb?: string;
  categoryBadge?: string;
  heroImageSha256?: string;
  logoSha256?: string;
  dateStr?: string;
  learnedRules?: string[];
}

export interface KaaeMandateParams {
  pageId?: string;
  headlineEn?: string;
  headlineCkb?: string;
  copyEn?: string;
  copyCkb?: string;
  badgeText?: string;
  logoSha256?: string;
  learnedRules?: string[];
  stats?: Array<{
    value: string;
    labelEn: string;
    labelCkb?: string;
    tag?: string;
  }>;
}

export interface KaaeHigherEdStandardsParams {
  pageId?: string;
  headlineEn?: string;
  headlineCkb?: string;
  copyEn?: string;
  copyCkb?: string;
  categoryBadge?: string;
  logoSha256?: string;
  learnedRules?: string[];
  standards?: Array<{
    number: string;
    titleEn: string;
    titleCkb?: string;
    descEn: string;
    descCkb?: string;
    evidenceTag?: string;
  }>;
}

export interface KaaeStrategicRoadmapParams {
  pageId?: string;
  headlineEn?: string;
  headlineCkb?: string;
  copyEn?: string;
  copyCkb?: string;
  badgeText?: string;
  logoSha256?: string;
  learnedRules?: string[];
  milestones?: Array<{
    phase: string;
    year: string;
    titleEn: string;
    titleCkb?: string;
    descEn: string;
    descCkb?: string;
    accentColor?: string;
  }>;
}

// Canonical Figma Buzz Field Mappings for KAAE Templates
export const KAAE_MANDATE_BUZZ_MAPPING: BuzzFieldMapping = {
  templateId: 'kaae_mandate',
  textFields: {
    badge: 'KURDISTAN REGIONAL LAW NO. 6 OF 2022 · PARLIAMENT MANDATE',
    headlineEn: 'Institutional Accreditation Mandate & Global Educational Standards',
    headlineCkb: 'متمانەبەخشینی دامەزراوەیی و ستانداردە نێودەوڵەتییەکان',
    copyEn: 'Authorized national framework for the comprehensive evaluation, quality assurance, and institutional licensing of higher education and general education institutions across the Kurdistan Region.',
    copyCkb: 'چوارچێوەی باڵای نیشتمانی بۆ هەڵسەنگاندن، دەستەبەری کوالیتی و متمانەبەخشینی دامەزراوەیی بە زانکۆ و ناوەندەکانی خوێندن.',
    stat1Val: '100%',
    stat1Label: 'Statutory Compliance',
    stat2Val: '12',
    stat2Label: 'Core Quality Standards',
    stat3Val: '2026',
    stat3Label: 'Active Academic Cycle',
    footer: 'www.kaae.org · info@kaae.krd · Erbil HQ',
  },
  mediaFields: {
    logo: {
      storageKey: `assets/logos/${KAAE_PRIMARY_LOGO_SHA256}.png`,
      sha256: KAAE_PRIMARY_LOGO_SHA256,
      fit: 'contain',
    },
  },
  targetAspectRatios: ['1:1', '4:5'],
};

export const KAAE_STANDARDS_BUZZ_MAPPING: BuzzFieldMapping = {
  templateId: 'kaae_standards',
  textFields: {
    badge: 'OFFICIAL ACCREDITATION CRITERIA · LAW NO. 6 OF 2022',
    headlineEn: 'Standards of Higher Education Institutional Accreditation',
    headlineCkb: 'ستانداردەکانی متمانەبەخشین بە دامەزراوەکانی خوێندنی باڵا',
    copyEn: 'Pursuant to Kurdistan Regional Law No. 6 of 2022 — Mandatory compliance benchmarks for universities and institutes.',
    std1Title: 'Mission, Governance & Academic Integrity',
    std1Desc: 'Clear institutional vision, transparent governance structure, bylaws compliance, and published academic freedom policies.',
    std1Evidence: '📋 Evidence: University Charter & Audited Governance Manual',
    std2Title: 'Academic Programs, Faculty & Curriculum Quality',
    std2Desc: 'Peer-reviewed curricula mapped to Bologna / International frameworks, verified faculty qualifications, and student-to-teacher ratios.',
    std2Evidence: '🔬 Evidence: Course Catalogs & Faculty Accreditation Dossiers',
    std3Title: 'Learning Resources, Research & Student Services',
    std3Desc: 'State-of-the-art laboratory infrastructure, digital library access, research output metrics, and student support mechanisms.',
    std3Evidence: '🏛️ Evidence: Campus Facility Audit & Research Output Index',
    footer: 'Kurdistan Accrediting Association for Education · Erbil HQ · www.kaae.org',
  },
  mediaFields: {
    logo: {
      storageKey: `assets/logos/${KAAE_PRIMARY_LOGO_SHA256}.png`,
      sha256: KAAE_PRIMARY_LOGO_SHA256,
      fit: 'contain',
    },
  },
  targetAspectRatios: ['4:5', '1:1', '9:16'],
};

export const KAAE_ROADMAP_BUZZ_MAPPING: BuzzFieldMapping = {
  templateId: 'kaae_roadmap',
  textFields: {
    badge: '2026 – 2028 STRATEGIC ROADMAP',
    headlineEn: 'Transforming Education: Three-Year Strategic Roadmap',
    headlineCkb: 'نەخشەڕێگای ستراتیژی بۆ دەستەبەری کوالیتی و متمانەبەخشین',
    copyEn: 'A phased national deployment toward internationally recognized qualifications and institutional excellence.',
    phase1Title: 'Comprehensive Institutional Audits',
    phase1Desc: 'Baseline evaluation of all public and private universities across Erbil, Sulaimani, Duhok, and Garmian.',
    phase2Title: 'Program-Level Quality Accreditation',
    phase2Desc: 'Specialized medical, engineering, and STEM curriculum evaluations aligned with international accreditation bodies.',
    phase3Title: 'Regional Quality Assurance Accords',
    phase3Desc: 'Cross-border credit recognition agreements and regional quality benchmark harmonization.',
    phase4Title: 'Global Mutual Recognition',
    phase4Desc: 'Full accession to international quality networks (INQAAHE / ENQA affiliates) for Kurdistan graduates.',
    footer: 'Kurdistan Regional Parliament Law No. 6 of 2022 · www.kaae.org · info@kaae.krd',
  },
  mediaFields: {
    logo: {
      storageKey: `assets/logos/${KAAE_PRIMARY_LOGO_SHA256}.png`,
      sha256: KAAE_PRIMARY_LOGO_SHA256,
      fit: 'contain',
    },
  },
  targetAspectRatios: ['1:1', '16:9'],
};

/**
 * Template 1: Ground-Truth Institutional Accreditation Mandate (Square 1:1, 1080 x 1080)
 * Authentic Light Cream paper canvas (#FDF8F3), Sun Gold accent bar (#F7B500),
 * 3 statutory stat boxes, live English headline + Kurdish RTL support, official emblem.
 */
export function buildKaaeMandateOperations(params?: KaaeMandateParams): StudioOperation[] {
  const pageId = params?.pageId || 'page_mandate_1x1';
  const logoSha = params?.logoSha256 || KAAE_PRIMARY_LOGO_SHA256;
  const ops: StudioOperation[] = [];

  const width = 1080;
  const height = 1080;

  const headlineEn = params?.headlineEn || 'Institutional Accreditation Mandate & Global Educational Standards';
  const headlineCkb = params?.headlineCkb || 'متمانەبەخشینی دامەزراوەیی و ستانداردە نێودەوڵەتییەکان';
  const copyEn =
    params?.copyEn ||
    'Authorized national framework for the comprehensive evaluation, quality assurance, and institutional licensing of higher education and general education institutions across the Kurdistan Region.';
  const copyCkb =
    params?.copyCkb ||
    'چوارچێوەی باڵای نیشتمانی بۆ هەڵسەنگاندن، دەستەبەری کوالیتی و متمانەبەخشینی دامەزراوەیی بە زانکۆ و ناوەندەکانی خوێندن.';
  const badgeText = params?.badgeText || 'KURDISTAN REGIONAL LAW NO. 6 OF 2022 · PARLIAMENT MANDATE';

  const stats = params?.stats || [
    { value: '100%', labelEn: 'Statutory Compliance', tag: 'Kurdistan Region' },
    { value: '12', labelEn: 'Core Quality Standards', tag: 'Global Parity' },
    { value: '2026', labelEn: 'Active Academic Cycle', tag: 'Official Review' },
  ];

  // 1. Vector Light Cream Paper Background (#FDF8F3) with Subtle Gold Aura & Diamond Security Grid
  ops.push({
    op: 'addVector',
    nodeId: 'mandate_bg',
    pageId,
    source: `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="creamBacking" cx="50%" cy="30%" r="75%">
            <stop offset="0%" stop-color="#FFFFFF"/>
            <stop offset="60%" stop-color="#FDF8F3"/>
            <stop offset="100%" stop-color="#F5EFE6"/>
          </radialGradient>
          <pattern id="mandatePattern" width="60" height="60" patternUnits="userSpaceOnUse">
            <path d="M 30 0 L 60 30 L 30 60 L 0 30 Z" fill="none" stroke="#4770A3" stroke-width="0.75" stroke-opacity="0.04"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#creamBacking)"/>
        <rect width="100%" height="100%" fill="url(#mandatePattern)"/>
        <!-- Sun Gold Aura in top corner -->
        <circle cx="950" cy="120" r="320" fill="#F7B500" fill-opacity="0.06" filter="blur(60px)"/>
        <!-- Outer Academic Frame -->
        <rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="8" fill="none" stroke="#4770A3" stroke-width="1.5" stroke-opacity="0.3"/>
        <rect x="32" y="32" width="${width - 64}" height="${height - 64}" rx="6" fill="none" stroke="#F7B500" stroke-width="0.75" stroke-opacity="0.25"/>
      </svg>
    `.trim(),
    x: 0,
    y: 0,
    width,
    height,
    locked: true,
  });

  // 2. Official KAAE Emblem (Header Left, 220 x 85)
  ops.push({
    op: 'addImage',
    nodeId: 'mandate_logo',
    pageId,
    asset: {
      storageKey: `assets/logos/${logoSha}.png`,
      sha256: logoSha,
      mimeType: 'image/png',
    },
    x: 60,
    y: 50,
    width: 220,
    height: 85,
    fit: 'contain',
    locked: true,
  });

  // 3. Authority Badge (Header Right)
  ops.push({
    op: 'addText',
    nodeId: 'mandate_authority_badge',
    pageId,
    text: badgeText,
    role: 'disclaimer',
    x: 340,
    y: 75,
    width: 680,
    height: 36,
    style: {
      fontSize: 14,
      fontWeight: '800',
      fontFamily: 'Inter',
      textAlign: 'right',
      color: '#4770A3',
      letterSpacing: 1.2,
    },
    locked: true,
  });

  // Header Divider
  ops.push({
    op: 'addVector',
    nodeId: 'mandate_header_divider',
    pageId,
    source: `
      <svg width="${width - 120}" height="3" viewBox="0 0 ${width - 120} 3" xmlns="http://www.w3.org/2000/svg">
        <line x1="0" y1="1" x2="${width - 120}" y2="1" stroke="#F7B500" stroke-width="2"/>
      </svg>
    `.trim(),
    x: 60,
    y: 155,
    width: width - 120,
    height: 3,
    locked: true,
  });

  // 4. Gold Left-Accent Border Bar (6px x 380px)
  ops.push({
    op: 'addVector',
    nodeId: 'mandate_gold_accent_bar',
    pageId,
    source: `
      <svg width="8" height="380" viewBox="0 0 8 380" xmlns="http://www.w3.org/2000/svg">
        <rect width="8" height="380" rx="4" fill="#F7B500"/>
      </svg>
    `.trim(),
    x: 60,
    y: 190,
    width: 8,
    height: 380,
    locked: true,
  });

  // 5. English Primary Headline (Minion Variable / Inter Display)
  ops.push({
    op: 'addText',
    nodeId: 'mandate_headline_en',
    pageId,
    text: headlineEn,
    role: 'headline',
    x: 90,
    y: 190,
    width: 930,
    height: 125,
    style: {
      fontSize: 44,
      fontWeight: 'bold',
      fontFamily: 'Minion Variable Concept, Georgia, serif',
      textAlign: 'left',
      color: '#0A1628',
      lineHeight: 1.25,
    },
    locked: false,
  });

  // 6. Kurdish Sub-Headline (Cairo SemiBold, RTL)
  ops.push({
    op: 'addText',
    nodeId: 'mandate_headline_ckb',
    pageId,
    text: headlineCkb,
    role: 'headline',
    x: 90,
    y: 325,
    width: 930,
    height: 55,
    style: {
      fontSize: 26,
      fontWeight: '600',
      fontFamily: 'Cairo, sans-serif',
      textAlign: 'left',
      color: '#4770A3',
      lineHeight: 1.4,
    },
    locked: false,
  });

  // 7. Lead English Copy
  ops.push({
    op: 'addText',
    nodeId: 'mandate_copy_en',
    pageId,
    text: copyEn,
    role: 'subheadline',
    x: 90,
    y: 395,
    width: 930,
    height: 100,
    style: {
      fontSize: 22,
      fontWeight: '500',
      fontFamily: 'Inter, sans-serif',
      textAlign: 'left',
      color: '#1E3A5F',
      lineHeight: 1.55,
    },
    locked: false,
  });

  // 8. Lead Kurdish Copy
  ops.push({
    op: 'addText',
    nodeId: 'mandate_copy_ckb',
    pageId,
    text: copyCkb,
    role: 'subheadline',
    x: 90,
    y: 505,
    width: 930,
    height: 70,
    style: {
      fontSize: 20,
      fontWeight: '500',
      fontFamily: 'Cairo, sans-serif',
      textAlign: 'left',
      color: '#4770A3',
      lineHeight: 1.6,
    },
    locked: false,
  });

  // 9. Stat Cards Row (3 Stat Metrics, width ~295 each)
  const statCardWidth = 296;
  const statCardHeight = 220;
  const statGap = 36;
  const startX = 60;
  const startY = 620;

  stats.forEach((stat, i) => {
    const cardX = startX + i * (statCardWidth + statGap);

    // Card background panel
    ops.push({
      op: 'addVector',
      nodeId: `mandate_stat_card_${i}`,
      pageId,
      source: `
        <svg width="${statCardWidth}" height="${statCardHeight}" viewBox="0 0 ${statCardWidth} ${statCardHeight}" xmlns="http://www.w3.org/2000/svg">
          <rect width="${statCardWidth}" height="${statCardHeight}" rx="12" fill="#FFFFFF" stroke="#4770A3" stroke-width="1.5" stroke-opacity="0.25"/>
          <rect x="0" y="0" width="${statCardWidth}" height="4" rx="2" fill="#F7B500"/>
        </svg>
      `.trim(),
      x: cardX,
      y: startY,
      width: statCardWidth,
      height: statCardHeight,
      locked: true,
    });

    // Stat Value
    ops.push({
      op: 'addText',
      nodeId: `mandate_stat_val_${i}`,
      pageId,
      text: stat.value,
      role: 'headline',
      x: cardX + 16,
      y: startY + 25,
      width: statCardWidth - 32,
      height: 65,
      style: {
        fontSize: 52,
        fontWeight: '900',
        fontFamily: 'Inter, sans-serif',
        textAlign: 'center',
        color: '#0A1628',
      },
      locked: false,
    });

    // Stat Label (English)
    ops.push({
      op: 'addText',
      nodeId: `mandate_stat_label_${i}`,
      pageId,
      text: stat.labelEn,
      role: 'subheadline',
      x: cardX + 16,
      y: startY + 100,
      width: statCardWidth - 32,
      height: 48,
      style: {
        fontSize: 18,
        fontWeight: '700',
        fontFamily: 'Inter, sans-serif',
        textAlign: 'center',
        color: '#4770A3',
        lineHeight: 1.3,
      },
      locked: false,
    });

    // Stat Tag
    if (stat.tag) {
      ops.push({
        op: 'addText',
        nodeId: `mandate_stat_tag_${i}`,
        pageId,
        text: `● ${stat.tag}`,
        role: 'disclaimer',
        x: cardX + 16,
        y: startY + 162,
        width: statCardWidth - 32,
        height: 28,
        style: {
          fontSize: 13,
          fontWeight: '700',
          fontFamily: 'Inter, sans-serif',
          textAlign: 'center',
          color: '#F7B500',
        },
        locked: true,
      });
    }
  });

  // 10. Footer Section with Web Portal & Registry Notice
  ops.push({
    op: 'addText',
    nodeId: 'mandate_footer_tokens',
    pageId,
    text: 'www.kaae.org  ·  info@kaae.krd  ·  Erbil HQ, 60m Street, Kurdistan Region',
    role: 'disclaimer',
    x: 60,
    y: height - 120,
    width: width - 120,
    height: 32,
    style: {
      fontSize: 16,
      fontWeight: '700',
      fontFamily: 'Inter, sans-serif',
      textAlign: 'center',
      color: '#4770A3',
      letterSpacing: 1.2,
    },
    locked: true,
  });

  ops.push({
    op: 'addText',
    nodeId: 'mandate_footer_legal',
    pageId,
    text: 'KURDISTAN ACCREDITING ASSOCIATION FOR EDUCATION · OFFICIAL QUALITY REGISTER',
    role: 'disclaimer',
    x: 60,
    y: height - 80,
    width: width - 120,
    height: 28,
    style: {
      fontSize: 13,
      fontWeight: '600',
      fontFamily: 'Inter, sans-serif',
      textAlign: 'center',
      color: '#64748B',
      letterSpacing: 1.5,
    },
    locked: true,
  });

  return ops;
}

/**
 * Template 2: Higher Education Standards (Portrait 4:5, 1080 x 1350)
 * Deep Royal Navy background (#0A1628 to #1E3A5F), gold accent lines,
 * 3 stacked standard cards with numbered circular badges & required evidence tags.
 */
export function buildKaaeHigherEdStandardsOperations(params?: KaaeHigherEdStandardsParams): StudioOperation[] {
  const pageId = params?.pageId || 'page_standards_4x5';
  const logoSha = params?.logoSha256 || KAAE_PRIMARY_LOGO_SHA256;
  const ops: StudioOperation[] = [];

  const width = 1080;
  const height = 1350;

  const headlineEn = params?.headlineEn || 'Standards of Higher Education Institutional Accreditation';
  const headlineCkb = params?.headlineCkb || 'ستانداردەکانی متمانەبەخشین بە دامەزراوەکانی خوێندنی باڵا';
  const copyEn =
    params?.copyEn ||
    'Pursuant to Kurdistan Regional Law No. 6 of 2022 — Mandatory compliance benchmarks for universities and institutes.';
  const categoryBadge = params?.categoryBadge || 'OFFICIAL ACCREDITATION CRITERIA · HIGHER EDUCATION';

  const standards = params?.standards || [
    {
      number: '01',
      titleEn: 'Mission, Governance & Academic Integrity',
      titleCkb: 'پەیام، بەڕێوەبردن و دەستپاکی ئەکادیمی',
      descEn:
        'Clear institutional vision, transparent governance structure, bylaws compliance, and published academic freedom policies.',
      evidenceTag: '📋 Required Evidence: University Charter & Audited Governance Manual',
    },
    {
      number: '02',
      titleEn: 'Academic Programs, Faculty & Curriculum Quality',
      titleCkb: 'پرۆگرامە ئەکادیمییەکان، دەستەی مامۆستایان و کوالیتی پرۆگرام',
      descEn:
        'Peer-reviewed curricula mapped to Bologna / International frameworks, verified faculty qualifications, and student-to-teacher ratios.',
      evidenceTag: '🔬 Required Evidence: Course Catalogs & Faculty Accreditation Dossiers',
    },
    {
      number: '03',
      titleEn: 'Learning Resources, Research & Student Services',
      titleCkb: 'سەرچاوەکانی فێربوون، توێژینەوە و خزمەتگوزاری خوێندکاران',
      descEn:
        'State-of-the-art laboratory infrastructure, digital library access, research output metrics, and student support mechanisms.',
      evidenceTag: '🏛️ Required Evidence: Campus Facility Audit & Research Output Index',
    },
  ];

  // 1. Vector Deep Royal Navy Gradient Foundation (#0A1628 -> #1E3A5F)
  ops.push({
    op: 'addVector',
    nodeId: 'std_bg',
    pageId,
    source: `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="stdNavyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#0A1628"/>
            <stop offset="40%" stop-color="#1E3A5F"/>
            <stop offset="85%" stop-color="#162E4D"/>
            <stop offset="100%" stop-color="#0A1628"/>
          </linearGradient>
          <pattern id="stdGrid" width="60" height="60" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="60" y2="0" stroke="#4770A3" stroke-width="0.5" stroke-opacity="0.08"/>
            <line x1="0" y1="0" x2="0" y2="60" stroke="#4770A3" stroke-width="0.5" stroke-opacity="0.08"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#stdNavyGrad)"/>
        <rect width="100%" height="100%" fill="url(#stdGrid)"/>
        <!-- Ambient Sunburst Glow -->
        <circle cx="850" cy="180" r="280" fill="#F7B500" fill-opacity="0.08" filter="blur(70px)"/>
      </svg>
    `.trim(),
    x: 0,
    y: 0,
    width,
    height,
    locked: true,
  });

  // 2. Official Emblem (Header Left)
  ops.push({
    op: 'addImage',
    nodeId: 'std_logo',
    pageId,
    asset: {
      storageKey: `assets/logos/${logoSha}.png`,
      sha256: logoSha,
      mimeType: 'image/png',
    },
    x: 60,
    y: 50,
    width: 220,
    height: 90,
    fit: 'contain',
    locked: true,
  });

  // Category Banner (Top Right)
  ops.push({
    op: 'addText',
    nodeId: 'std_category_banner',
    pageId,
    text: categoryBadge,
    role: 'disclaimer',
    x: 320,
    y: 80,
    width: 700,
    height: 36,
    style: {
      fontSize: 14,
      fontWeight: '800',
      fontFamily: 'Inter',
      textAlign: 'right',
      color: '#F7B500',
      letterSpacing: 1.2,
    },
    locked: true,
  });

  // Header Divider
  ops.push({
    op: 'addVector',
    nodeId: 'std_header_divider',
    pageId,
    source: `
      <svg width="${width - 120}" height="2" viewBox="0 0 ${width - 120} 2" xmlns="http://www.w3.org/2000/svg">
        <line x1="0" y1="1" x2="${width - 120}" y2="1" stroke="#F7B500" stroke-width="2"/>
      </svg>
    `.trim(),
    x: 60,
    y: 155,
    width: width - 120,
    height: 2,
    locked: true,
  });

  // 3. Main English Headline
  ops.push({
    op: 'addText',
    nodeId: 'std_headline_en',
    pageId,
    text: headlineEn,
    role: 'headline',
    x: 60,
    y: 180,
    width: width - 120,
    height: 100,
    style: {
      fontSize: 42,
      fontWeight: 'bold',
      fontFamily: 'Minion Variable Concept, Georgia, serif',
      textAlign: 'left',
      color: '#FFFFFF',
      lineHeight: 1.25,
    },
    locked: false,
  });

  // Kurdish Subheadline
  ops.push({
    op: 'addText',
    nodeId: 'std_headline_ckb',
    pageId,
    text: headlineCkb,
    role: 'headline',
    x: 60,
    y: 285,
    width: width - 120,
    height: 48,
    style: {
      fontSize: 24,
      fontWeight: '600',
      fontFamily: 'Cairo, sans-serif',
      textAlign: 'left',
      color: '#F7B500',
      lineHeight: 1.4,
    },
    locked: false,
  });

  // Subtitle / Copy
  ops.push({
    op: 'addText',
    nodeId: 'std_copy_en',
    pageId,
    text: copyEn,
    role: 'subheadline',
    x: 60,
    y: 340,
    width: width - 120,
    height: 60,
    style: {
      fontSize: 20,
      fontWeight: '500',
      fontFamily: 'Inter, sans-serif',
      textAlign: 'left',
      color: '#CBD5E1',
      lineHeight: 1.5,
    },
    locked: false,
  });

  // 4. Three Stacked Standards Cards
  const cardWidth = width - 120;
  const cardHeight = 220;
  const cardGap = 24;
  const startY = 430;

  standards.forEach((std, i) => {
    const cardY = startY + i * (cardHeight + cardGap);

    // Card background panel (Frosted Glass Navy)
    ops.push({
      op: 'addVector',
      nodeId: `std_card_panel_${i}`,
      pageId,
      source: `
        <svg width="${cardWidth}" height="${cardHeight}" viewBox="0 0 ${cardWidth} ${cardHeight}" xmlns="http://www.w3.org/2000/svg">
          <rect width="${cardWidth}" height="${cardHeight}" rx="14" fill="#0A1628" fill-opacity="0.7"/>
          <rect width="${cardWidth}" height="${cardHeight}" rx="14" fill="none" stroke="#4770A3" stroke-width="1.5" stroke-opacity="0.45"/>
          <line x1="16" y1="${cardHeight - 48}" x2="${cardWidth - 16}" y2="${cardHeight - 48}" stroke="#4770A3" stroke-width="1" stroke-opacity="0.2"/>
        </svg>
      `.trim(),
      x: 60,
      y: cardY,
      width: cardWidth,
      height: cardHeight,
      locked: true,
    });

    // Circular Gold Number Badge
    ops.push({
      op: 'addVector',
      nodeId: `std_badge_circle_${i}`,
      pageId,
      source: `
        <svg width="60" height="60" viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
          <circle cx="30" cy="30" r="28" fill="#F7B500"/>
          <text x="30" y="38" fill="#0A1628" font-family="Inter, sans-serif" font-size="24" font-weight="900" text-anchor="middle">${std.number}</text>
        </svg>
      `.trim(),
      x: 90,
      y: cardY + 28,
      width: 60,
      height: 60,
      locked: true,
    });

    // Standard Title (English)
    ops.push({
      op: 'addText',
      nodeId: `std_title_en_${i}`,
      pageId,
      text: std.titleEn,
      role: 'headline',
      x: 175,
      y: cardY + 26,
      width: cardWidth - 135,
      height: 38,
      style: {
        fontSize: 24,
        fontWeight: 'bold',
        fontFamily: 'Inter, sans-serif',
        textAlign: 'left',
        color: '#FFFFFF',
      },
      locked: false,
    });

    // Standard Description (English)
    ops.push({
      op: 'addText',
      nodeId: `std_desc_en_${i}`,
      pageId,
      text: std.descEn,
      role: 'subheadline',
      x: 175,
      y: cardY + 68,
      width: cardWidth - 135,
      height: 70,
      style: {
        fontSize: 17,
        fontWeight: 'normal',
        fontFamily: 'Inter, sans-serif',
        textAlign: 'left',
        color: '#E2E8F0',
        lineHeight: 1.45,
      },
      locked: false,
    });

    // Required Evidence Tag
    if (std.evidenceTag) {
      ops.push({
        op: 'addText',
        nodeId: `std_evidence_${i}`,
        pageId,
        text: std.evidenceTag,
        role: 'disclaimer',
        x: 85,
        y: cardY + cardHeight - 38,
        width: cardWidth - 50,
        height: 28,
        style: {
          fontSize: 14,
          fontWeight: '600',
          fontFamily: 'Inter, sans-serif',
          textAlign: 'left',
          color: '#F7B500',
        },
        locked: true,
      });
    }
  });

  // 5. Footer Authority & Web Portal
  ops.push({
    op: 'addText',
    nodeId: 'std_footer_tokens',
    pageId,
    text: 'Kurdistan Regional Parliament Law No. 6 of 2022 · www.kaae.org · info@kaae.krd',
    role: 'disclaimer',
    x: 60,
    y: height - 110,
    width: width - 120,
    height: 30,
    style: {
      fontSize: 16,
      fontWeight: '700',
      fontFamily: 'Inter, sans-serif',
      textAlign: 'center',
      color: '#F7B500',
      letterSpacing: 1,
    },
    locked: true,
  });

  ops.push({
    op: 'addText',
    nodeId: 'std_footer_address',
    pageId,
    text: 'Kurdistan Accrediting Association for Education · 60m Street, Erbil HQ',
    role: 'disclaimer',
    x: 60,
    y: height - 70,
    width: width - 120,
    height: 26,
    style: {
      fontSize: 14,
      fontWeight: '500',
      fontFamily: 'Inter, sans-serif',
      textAlign: 'center',
      color: '#94A3B8',
    },
    locked: true,
  });

  return ops;
}

/**
 * Template 3: Strategic Roadmap 2026–2028 (Square 1:1 Keynote, 1080 x 1080)
 * Executive Royal Navy Canvas (#0A1628), glowing 2028 brand medallion,
 * 2x2 frosted glass milestone cards (Audits, Programs, Accords, Global Parity).
 */
export function buildKaaeStrategicRoadmapOperations(params?: KaaeStrategicRoadmapParams): StudioOperation[] {
  const pageId = params?.pageId || 'page_roadmap_1x1';
  const logoSha = params?.logoSha256 || KAAE_PRIMARY_LOGO_SHA256;
  const ops: StudioOperation[] = [];

  const width = 1080;
  const height = 1080;

  const headlineEn = params?.headlineEn || 'Transforming Education: Three-Year Strategic Roadmap';
  const headlineCkb = params?.headlineCkb || 'نەخشەڕێگای ستراتیژی بۆ دەستەبەری کوالیتی و متمانەبەخشین';
  const copyEn =
    params?.copyEn ||
    'A phased national deployment toward internationally recognized qualifications and institutional excellence.';
  const badgeText = params?.badgeText || '2026 – 2028 STRATEGIC ROADMAP';

  const milestones = params?.milestones || [
    {
      phase: 'PHASE 1',
      year: '2026',
      titleEn: 'Comprehensive Institutional Audits',
      titleCkb: 'پشکنینی گشتگیری دامەزراوەیی',
      descEn: 'Baseline evaluation of all public and private universities across Erbil, Sulaimani, Duhok, and Garmian.',
      accentColor: '#F7B500',
    },
    {
      phase: 'PHASE 2',
      year: '2027',
      titleEn: 'Program-Level Quality Accreditation',
      titleCkb: 'متمانەبەخشین بە پرۆگرامە زانستییەکان',
      descEn:
        'Specialized medical, engineering, and STEM curriculum evaluations aligned with international accreditation bodies.',
      accentColor: '#4770A3',
    },
    {
      phase: 'PHASE 3',
      year: '2027–2028',
      titleEn: 'Regional Quality Assurance Accords',
      titleCkb: 'پەیماننامەی ناوچەیی بۆ متمانەبەخشین',
      descEn: 'Cross-border credit recognition agreements and regional quality benchmark harmonization.',
      accentColor: '#2C5282',
    },
    {
      phase: 'PHASE 4',
      year: '2028',
      titleEn: 'Global Mutual Recognition',
      titleCkb: 'دانپێدانانی جیهانی بە بڕوانامەکان',
      descEn: 'Full accession to international quality networks (INQAAHE / ENQA affiliates) for Kurdistan graduates.',
      accentColor: '#F7B500',
    },
  ];

  // 1. Vector Deep Midnight Foundation with Radial Center Spotlight
  ops.push({
    op: 'addVector',
    nodeId: 'roadmap_bg',
    pageId,
    source: `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="roadmapGlow" cx="50%" cy="45%" r="65%">
            <stop offset="0%" stop-color="#1E3A5F" stop-opacity="0.8"/>
            <stop offset="60%" stop-color="#0A1628"/>
            <stop offset="100%" stop-color="#050B14"/>
          </radialGradient>
          <pattern id="roadmapGrid" width="80" height="80" patternUnits="userSpaceOnUse">
            <circle cx="40" cy="40" r="1.5" fill="#4770A3" fill-opacity="0.2"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#roadmapGlow)"/>
        <rect width="100%" height="100%" fill="url(#roadmapGrid)"/>
        <!-- Golden Center Medallion Ambient Flare -->
        <circle cx="540" cy="110" r="180" fill="#F7B500" fill-opacity="0.08" filter="blur(50px)"/>
      </svg>
    `.trim(),
    x: 0,
    y: 0,
    width,
    height,
    locked: true,
  });

  // 2. Official Logo (Header Left)
  ops.push({
    op: 'addImage',
    nodeId: 'roadmap_logo',
    pageId,
    asset: {
      storageKey: `assets/logos/${logoSha}.png`,
      sha256: logoSha,
      mimeType: 'image/png',
    },
    x: 60,
    y: 45,
    width: 220,
    height: 85,
    fit: 'contain',
    locked: true,
  });

  // 3. Strategic Medallion Badge (Header Right)
  ops.push({
    op: 'addText',
    nodeId: 'roadmap_badge',
    pageId,
    text: badgeText,
    role: 'disclaimer',
    x: 350,
    y: 70,
    width: 670,
    height: 38,
    style: {
      fontSize: 16,
      fontWeight: '800',
      fontFamily: 'Inter',
      textAlign: 'right',
      color: '#F7B500',
      letterSpacing: 2,
    },
    locked: true,
  });

  // Header Divider
  ops.push({
    op: 'addVector',
    nodeId: 'roadmap_header_divider',
    pageId,
    source: `
      <svg width="${width - 120}" height="2" viewBox="0 0 ${width - 120} 2" xmlns="http://www.w3.org/2000/svg">
        <line x1="0" y1="1" x2="${width - 120}" y2="1" stroke="#F7B500" stroke-width="2"/>
      </svg>
    `.trim(),
    x: 60,
    y: 150,
    width: width - 120,
    height: 2,
    locked: true,
  });

  // 4. English Headline
  ops.push({
    op: 'addText',
    nodeId: 'roadmap_headline_en',
    pageId,
    text: headlineEn,
    role: 'headline',
    x: 60,
    y: 175,
    width: width - 120,
    height: 85,
    style: {
      fontSize: 38,
      fontWeight: 'bold',
      fontFamily: 'Minion Variable Concept, Georgia, serif',
      textAlign: 'center',
      color: '#FFFFFF',
      lineHeight: 1.25,
    },
    locked: false,
  });

  // Subtitle Copy
  ops.push({
    op: 'addText',
    nodeId: 'roadmap_copy_en',
    pageId,
    text: copyEn,
    role: 'subheadline',
    x: 100,
    y: 265,
    width: width - 200,
    height: 50,
    style: {
      fontSize: 18,
      fontWeight: '500',
      fontFamily: 'Inter, sans-serif',
      textAlign: 'center',
      color: '#CBD5E1',
      lineHeight: 1.45,
    },
    locked: false,
  });

  // 5. 2x2 Grid of Strategic Milestone Cards
  const gridCardW = 460;
  const gridCardH = 275;
  const gapX = 40;
  const gapY = 30;
  const gridStartX = 60;
  const gridStartY = 340;

  milestones.forEach((m, idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const cardX = gridStartX + col * (gridCardW + gapX);
    const cardY = gridStartY + row * (gridCardH + gapY);
    const accent = m.accentColor || '#F7B500';

    // Card background
    ops.push({
      op: 'addVector',
      nodeId: `roadmap_card_bg_${idx}`,
      pageId,
      source: `
        <svg width="${gridCardW}" height="${gridCardH}" viewBox="0 0 ${gridCardW} ${gridCardH}" xmlns="http://www.w3.org/2000/svg">
          <rect width="${gridCardW}" height="${gridCardH}" rx="14" fill="#0A1628" fill-opacity="0.8"/>
          <rect width="${gridCardW}" height="${gridCardH}" rx="14" fill="none" stroke="${accent}" stroke-width="1.5" stroke-opacity="0.5"/>
          <rect x="0" y="0" width="${gridCardW}" height="4" rx="2" fill="${accent}"/>
        </svg>
      `.trim(),
      x: cardX,
      y: cardY,
      width: gridCardW,
      height: gridCardH,
      locked: true,
    });

    // Milestone Badge (e.g. PHASE 1 · 2026)
    ops.push({
      op: 'addText',
      nodeId: `roadmap_milestone_badge_${idx}`,
      pageId,
      text: `${m.phase}  ·  ${m.year}`,
      role: 'disclaimer',
      x: cardX + 24,
      y: cardY + 24,
      width: gridCardW - 48,
      height: 30,
      style: {
        fontSize: 14,
        fontWeight: '800',
        fontFamily: 'Inter, sans-serif',
        textAlign: 'left',
        color: accent,
        letterSpacing: 1.5,
      },
      locked: true,
    });

    // Milestone Title (English)
    ops.push({
      op: 'addText',
      nodeId: `roadmap_milestone_title_${idx}`,
      pageId,
      text: m.titleEn,
      role: 'headline',
      x: cardX + 24,
      y: cardY + 62,
      width: gridCardW - 48,
      height: 60,
      style: {
        fontSize: 22,
        fontWeight: 'bold',
        fontFamily: 'Inter, sans-serif',
        textAlign: 'left',
        color: '#FFFFFF',
        lineHeight: 1.3,
      },
      locked: false,
    });

    // Milestone Description
    ops.push({
      op: 'addText',
      nodeId: `roadmap_milestone_desc_${idx}`,
      pageId,
      text: m.descEn,
      role: 'subheadline',
      x: cardX + 24,
      y: cardY + 130,
      width: gridCardW - 48,
      height: 120,
      style: {
        fontSize: 16,
        fontWeight: 'normal',
        fontFamily: 'Inter, sans-serif',
        textAlign: 'left',
        color: '#E2E8F0',
        lineHeight: 1.5,
      },
      locked: false,
    });
  });

  // 6. Footer Legal Citation & Portal
  ops.push({
    op: 'addText',
    nodeId: 'roadmap_footer',
    pageId,
    text: 'Kurdistan Regional Parliament Law No. 6 of 2022  ·  www.kaae.org  ·  info@kaae.krd',
    role: 'disclaimer',
    x: 60,
    y: height - 80,
    width: width - 120,
    height: 32,
    style: {
      fontSize: 16,
      fontWeight: '700',
      fontFamily: 'Inter, sans-serif',
      textAlign: 'center',
      color: '#F7B500',
      letterSpacing: 1,
    },
    locked: true,
  });

  return ops;
}

/**
 * Standard Announcement Feed Card (1080 x 1350)
 * Maintained with authentic ground-truth tokens (#4770A3, #F7B500, #1E3A5F, #0A1628).
 */
export function buildKaaeAnnouncementOperations(params: KaaeAnnouncementParams): StudioOperation[] {
  const pageId = params.pageId || 'page_announcement';
  const logoSha = params.logoSha256 || KAAE_PRIMARY_LOGO_SHA256;
  const ops: StudioOperation[] = [];

  const width = params.width || 1080;
  const height = params.height || 1350;

  // Dynamic Learned Rules Adaptation
  let headlineEnFont = 'Minion Variable Concept, Georgia, serif';
  let copyEnFont = 'Inter, sans-serif';
  let badgeFont = 'Inter, sans-serif';
  let accentColor = '#F7B500';

  if (params.learnedRules && params.learnedRules.length > 0) {
    for (const rule of params.learnedRules) {
      const lr = rule.toLowerCase();
      if (/cinzel/i.test(lr)) {
        headlineEnFont = '"Cinzel", "Playfair Display", serif';
        badgeFont = '"Cinzel", sans-serif';
      } else if (/playfair/i.test(lr)) {
        headlineEnFont = '"Playfair Display", Georgia, serif';
      } else if (/cormorant/i.test(lr)) {
        headlineEnFont = '"Cormorant Garamond", Georgia, serif';
      }
      if (/jakarta|plus jakarta/i.test(lr)) {
        copyEnFont = '"Plus Jakarta Sans", sans-serif';
      }
      if (/#ffd15c/i.test(lr) || /sun gold/i.test(lr)) {
        accentColor = '#FFD15C';
      } else if (/#e8b85c/i.test(lr)) {
        accentColor = '#E8B85C';
      }
    }
  }

  // 1. Vector Deep Institutional Navy Foundation (#0A1628, #1E3A5F, #4770A3)
  ops.push({
    op: 'addVector',
    nodeId: 'ann_bg',
    pageId,
    source: `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="kaaeMidnightGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#0A1628"/>
            <stop offset="35%" stop-color="#1E3A5F"/>
            <stop offset="75%" stop-color="#2C5282"/>
            <stop offset="100%" stop-color="#0A1628"/>
          </linearGradient>
          <pattern id="annTriangles" width="80" height="80" patternUnits="userSpaceOnUse">
            <polygon points="40,10 70,70 10,70" fill="none" stroke="${accentColor}" stroke-width="0.75" stroke-opacity="0.05"/>
            <polygon points="40,70 70,10 10,10" fill="none" stroke="#4770A3" stroke-width="0.75" stroke-opacity="0.04"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#kaaeMidnightGrad)"/>
        <rect width="100%" height="100%" fill="url(#annTriangles)"/>
        <!-- Soft Golden Ambient Aura at Top Corner -->
        <circle cx="900" cy="150" r="300" fill="${accentColor}" fill-opacity="0.08" filter="blur(60px)"/>
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
        <line x1="0" y1="1" x2="${width - 120}" y2="1" stroke="${accentColor}" stroke-width="2" stroke-opacity="0.8"/>
      </svg>
    `.trim(),
    x: 60,
    y: 190,
    width: width - 120,
    height: 2,
    locked: true,
  });

  // 3. Official KAAE Emblem (Header Left, 250 x 110)
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
    y: 70,
    width: 250,
    height: 110,
    fit: 'contain',
    locked: true,
  });

  // Category / Commission Badge (Top Right)
  const categoryBadgeText = params.categoryBadge || 'KAAE OFFICIAL · OFFICIAL ANNOUNCEMENT';
  ops.push({
    op: 'addText',
    nodeId: 'ann_category_badge',
    pageId,
    text: categoryBadgeText,
    role: 'disclaimer',
    x: 450,
    y: 95,
    width: 490,
    height: 40,
    style: {
      fontSize: 16,
      fontWeight: 'bold',
      fontFamily: badgeFont,
      textAlign: 'right',
      color: accentColor,
      letterSpacing: 1,
    },
    locked: true,
  });

  // 4. Hero Visual Slot or Panel
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
    // Content Panel
    ops.push({
      op: 'addVector',
      nodeId: 'ann_card_panel',
      pageId,
      source: `
        <svg width="${width - 120}" height="860" viewBox="0 0 ${width - 120} 860" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" rx="16" fill="#0A1628" fill-opacity="0.6"/>
          <rect width="100%" height="100%" rx="16" fill="none" stroke="#4770A3" stroke-width="2" stroke-opacity="0.3"/>
          <rect x="20" y="20" width="${width - 160}" height="820" rx="12" fill="none" stroke="${accentColor}" stroke-width="1" stroke-opacity="0.15"/>
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

  // 5. English Headline (if provided) or Kurdish Headline
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
      height: 100,
      style: {
        fontSize: 36,
        fontWeight: 'bold',
        fontFamily: headlineEnFont,
        textAlign: 'left',
        color: '#FFFFFF',
        lineHeight: 1.3,
      },
      locked: false,
    });
    contentY += 105;
  }

  // 6. Kurdish Headline
  if (params.headlineCkb) {
    ops.push({
      op: 'addText',
      nodeId: 'ann_headline_ckb',
      pageId,
      text: params.headlineCkb,
      role: 'headline',
      x: 100,
      y: contentY,
      width: width - 200,
      height: 90,
      style: {
        fontSize: 32,
        fontWeight: 'bold',
        fontFamily: 'Cairo',
        textAlign: 'right',
        direction: 'rtl',
        color: accentColor,
        lineHeight: 1.35,
      },
      locked: false,
    });
    contentY += 95;
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

  // 7. English Copy
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
        fontSize: 22,
        fontWeight: 'normal',
        fontFamily: copyEnFont,
        textAlign: 'left',
        color: '#CBD5E1',
        lineHeight: 1.55,
      },
      locked: false,
    });
    contentY += 170;
  }

  // 8. Kurdish Copy
  if (params.copyCkb) {
    ops.push({
      op: 'addText',
      nodeId: 'ann_copy_ckb',
      pageId,
      text: params.copyCkb,
      role: 'subheadline',
      x: 100,
      y: contentY,
      width: width - 200,
      height: 180,
      style: {
        fontSize: 22,
        fontWeight: '500',
        fontFamily: 'Cairo',
        textAlign: 'right',
        direction: 'rtl',
        color: '#E2E8F0',
        lineHeight: 1.6,
      },
      locked: false,
    });
  }

  // 9. Statutory Authority Citation Badge
  const isEnglishOnly = Boolean(params.headlineEn && !params.headlineCkb);
  const isKurdishOnly = Boolean(params.headlineCkb && !params.headlineEn);
  const statutoryText = isEnglishOnly
    ? 'Kurdistan Parliament Law No. 6 of 2022 · Independent National Accreditation Authority'
    : isKurdishOnly
    ? 'یاسای ژمارە (٦)ی ساڵی ٢٠٢٢ · پەرلەمانی کوردستان · دەستەی متمانەبەخشین'
    : 'یاسای ژمارە (٦)ی ساڵی ٢٠٢٢ · پەرلەمانی کوردستان | Kurdistan Regional Law No. 6 of 2022';

  const bottomMargin = Math.round(height * 0.05);
  const footerHeight = 28;
  const statutoryHeight = 32;
  const footerY = height - bottomMargin - footerHeight - 8;
  const statutoryY = footerY - statutoryHeight - 12;

  ops.push({
    op: 'addText',
    nodeId: 'ann_statutory_rule',
    pageId,
    text: statutoryText,
    role: 'disclaimer',
    x: 60,
    y: statutoryY,
    width: width - 120,
    height: statutoryHeight,
    style: {
      fontSize: 17,
      fontWeight: '600',
      fontFamily: isEnglishOnly ? 'Inter' : 'Cairo',
      textAlign: 'center',
      color: '#F7B500',
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
    y: footerY,
    width: width - 120,
    height: footerHeight,
    style: {
      fontSize: 16,
      fontFamily: 'Inter',
      textAlign: 'center',
      color: '#94A3B8',
      letterSpacing: 1,
    },
    locked: true,
  });

  return ops;
}
