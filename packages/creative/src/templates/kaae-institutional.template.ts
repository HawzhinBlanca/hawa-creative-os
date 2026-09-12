import type { StudioOperation } from '@hawa/contracts';
import { KAAE_PRIMARY_LOGO_SHA256 } from './kaae-certificate.template.js';

export interface KaaeEligibilityDecreeParams {
  pageId?: string;
  institutionNameEn: string;
  institutionNameCkb?: string;
  decreeStatusEn?: string;
  decreeStatusCkb?: string;
  collegialAdvicesCount?: number;
  recommendationsCount?: number;
  requirementsCount?: number;
  presidentName?: string;
  secGenName?: string;
  dateStr?: string;
  logoSha256?: string;
}

export interface KaaeGlobalMilestoneParams {
  pageId?: string;
  milestoneTitleEn: string;
  milestoneTitleCkb?: string;
  networkNameEn: string;
  networkNameCkb?: string;
  membershipTypeEn?: string;
  membershipTypeCkb?: string;
  scopeEn?: string;
  scopeCkb?: string;
  dateStr?: string;
  logoSha256?: string;
}

export interface KaaeEvaluatorCallParams {
  pageId?: string;
  headlineEn?: string;
  headlineCkb?: string;
  targetCount?: number;
  cheEvaluatorTarget?: number;
  k12EvaluatorTarget?: number;
  criteriaPoints?: string[];
  deadlineStr?: string;
  portalUrl?: string;
  logoSha256?: string;
}

export interface KaaeMetricsReportParams {
  pageId?: string;
  titleEn?: string;
  titleCkb?: string;
  socialViews?: string;
  socialReach?: string;
  pilotSchoolsCount?: number;
  pilotUniversitiesCount?: number;
  volunteerCount?: number;
  periodStr?: string;
  logoSha256?: string;
}

/**
 * 1. KaaeEligibilityDecreeTemplate (4:5 Feed & A4 Announcement)
 * Official decree conferring institutional eligibility status to universities (AUK, CUE).
 */
export function createKaaeEligibilityDecreeTemplate(params: KaaeEligibilityDecreeParams): StudioOperation[] {
  const pageId = params.pageId || 'kaae_eligibility_page';
  const width = 1080;
  const height = 1350;
  const logoSha = params.logoSha256 || KAAE_PRIMARY_LOGO_SHA256;
  const ops: StudioOperation[] = [];

  // Vector Background Ground (Deep Cobalt frame with Parchment plinth)
  ops.push({
    op: 'addVector',
    nodeId: `${pageId}_bg`,
    pageId,
    source: `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#002050"/>
        <!-- Parchment inner card -->
        <rect x="40" y="40" width="1000" height="1270" rx="16" fill="#FDF8F3" stroke="#E8B85C" stroke-width="3"/>
        <!-- Header ribbon -->
        <rect x="40" y="40" width="1000" height="130" rx="16" fill="#160874"/>
        <rect x="40" y="150" width="1000" height="20" fill="#160874"/>
        <!-- Institution Box -->
        <rect x="80" y="440" width="920" height="160" rx="12" fill="#FFFFFF" stroke="#160874" stroke-width="2"/>
        <!-- Advisory Panel Box -->
        <rect x="80" y="630" width="920" height="250" rx="10" fill="#F4F1EA"/>
      </svg>
    `.trim(),
    x: 0,
    y: 0,
    width,
    height,
    locked: true,
  });

  // Official Logo Emblem
  ops.push({
    op: 'addImage',
    nodeId: `${pageId}_seal`,
    pageId,
    asset: {
      storageKey: `assets/logos/${logoSha}.png`,
      sha256: logoSha,
      mimeType: 'image/png',
    },
    x: 490,
    y: 190,
    width: 100,
    height: 100,
    fit: 'contain',
    locked: true,
  });

  // Law citation badge
  ops.push({
    op: 'addText',
    nodeId: `${pageId}_badge_law`,
    pageId,
    text: 'KURDISTAN REGIONAL PARLIAMENT LAW NO. 6 OF 2022 · DECREE NO. 11 OF 2022',
    role: 'disclaimer',
    x: 80,
    y: 65,
    width: 920,
    height: 25,
    style: {
      fontSize: 14,
      fontWeight: '700',
      fontFamily: 'Minion Variable Concept',
      color: '#E8B85C',
      letterSpacing: 1.0,
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_header_ckb`,
    pageId,
    text: 'دەستەی متمانەبەخشینی کوردستان بۆ پەروەردە و خوێندن — بڕیاری فەرمی',
    role: 'headline',
    x: 80,
    y: 100,
    width: 920,
    height: 35,
    style: {
      fontSize: 18,
      fontWeight: '700',
      fontFamily: 'Cairo',
      color: '#FFFFFF',
      textAlign: 'right',
      direction: 'rtl',
    },
  });

  // Status Titles
  const statusEn = params.decreeStatusEn || 'ELIGIBILITY STATUS GRANTED';
  const statusCkb = params.decreeStatusCkb || 'پێدانی پێگەی شیاوبوون (ELIGIBILITY)';

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_status_en`,
    pageId,
    text: statusEn,
    role: 'headline',
    x: 80,
    y: 320,
    width: 920,
    height: 45,
    style: {
      fontSize: 28,
      fontWeight: '800',
      fontFamily: 'Minion Variable Concept',
      color: '#160874',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_status_ckb`,
    pageId,
    text: statusCkb,
    role: 'subheadline',
    x: 80,
    y: 375,
    width: 920,
    height: 40,
    style: {
      fontSize: 24,
      fontWeight: '700',
      fontFamily: 'Cairo',
      color: '#E8B85C',
      textAlign: 'right',
      direction: 'rtl',
    },
  });

  // Institution Names
  ops.push({
    op: 'addText',
    nodeId: `${pageId}_inst_name_en`,
    pageId,
    text: params.institutionNameEn,
    role: 'headline',
    x: 120,
    y: 470,
    width: 840,
    height: 50,
    style: {
      fontSize: 32,
      fontWeight: '800',
      fontFamily: 'Minion Variable Concept',
      color: '#160874',
    },
  });

  if (params.institutionNameCkb) {
    ops.push({
      op: 'addText',
      nodeId: `${pageId}_inst_name_ckb`,
      pageId,
      text: params.institutionNameCkb,
      role: 'headline',
      x: 120,
      y: 530,
      width: 840,
      height: 45,
      style: {
        fontSize: 26,
        fontWeight: '700',
        fontFamily: 'Cairo',
        color: '#35309B',
        textAlign: 'right',
        direction: 'rtl',
      },
    });
  }

  // Panel details
  ops.push({
    op: 'addText',
    nodeId: `${pageId}_panel_title`,
    pageId,
    text: 'EVALUATION PANEL & ADVISORY FINDINGS',
    role: 'subheadline',
    x: 110,
    y: 650,
    width: 860,
    height: 30,
    style: {
      fontSize: 16,
      fontWeight: '700',
      fontFamily: 'Minion Variable Concept',
      color: '#160874',
    },
  });

  const adviceText = `• External Review: 3 MSCHE-Trained International Evaluators + 1 Local Observer\n• Collegial Advices: ${params.collegialAdvicesCount ?? 13} | Recommendations: ${params.recommendationsCount ?? 0} | Requirements: ${params.requirementsCount ?? 0}\n• Governance Pathway: Applicant Committee (3) → Commission (7) → Board of Trustees`;
  ops.push({
    op: 'addText',
    nodeId: `${pageId}_panel_body`,
    pageId,
    text: adviceText,
    role: 'body',
    x: 110,
    y: 690,
    width: 860,
    height: 160,
    style: {
      fontSize: 18,
      fontWeight: '500',
      fontFamily: 'Noto Naskh Arabic',
      color: '#2C3E50',
    },
  });

  // Kurdish statutory statement
  ops.push({
    op: 'addText',
    nodeId: `${pageId}_statutory_ckb`,
    pageId,
    text: 'بەپێی بڕیاری دەستەی متمانەبەخشین و بە پشتبەستن بە ٢١ پێوەری شیاوبوونی خوێندنی باڵا (FCE)، ئەم دامەزراوەیە هەنگاوی یەکەمی پرۆسەی متمانەبەخشینی بە سەرکەوتوویی بڕی.',
    role: 'body',
    x: 80,
    y: 910,
    width: 920,
    height: 80,
    style: {
      fontSize: 19,
      fontWeight: '600',
      fontFamily: 'Cairo',
      color: '#160874',
      textAlign: 'right',
      direction: 'rtl',
    },
  });

  // Signatures
  const presName = params.presidentName || 'Dr. Boushra Rahal Alameh';
  const secName = params.secGenName || 'Dr. Honar Issa';

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_sig_pres_name`,
    pageId,
    text: `${presName}\nPresident, KAAE`,
    role: 'body',
    x: 120,
    y: 1120,
    width: 350,
    height: 60,
    style: {
      fontSize: 16,
      fontWeight: '700',
      fontFamily: 'Minion Variable Concept',
      color: '#160874',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_sig_sec_name`,
    pageId,
    text: `${secName}\nSecretary-General, KAAE`,
    role: 'body',
    x: 650,
    y: 1120,
    width: 350,
    height: 60,
    style: {
      fontSize: 16,
      fontWeight: '700',
      fontFamily: 'Minion Variable Concept',
      color: '#160874',
    },
  });

  // Slogan Footer
  ops.push({
    op: 'addText',
    nodeId: `${pageId}_footer_slogan`,
    pageId,
    text: 'Empowering Education, Inspiring the Future · www.kaae.org',
    role: 'disclaimer',
    x: 80,
    y: 1240,
    width: 920,
    height: 30,
    style: {
      fontSize: 15,
      fontWeight: '600',
      fontFamily: 'Minion Variable Concept',
      color: '#E8B85C',
      textAlign: 'center',
    },
  });

  return ops;
}

/**
 * 2. KaaeGlobalMilestoneTemplate (4:5 Feed & 1:1 Square)
 * Official announcement for international accreditation memberships (CHEA CIQG, INQAAHE, UNESCO).
 */
export function createKaaeGlobalMilestoneTemplate(params: KaaeGlobalMilestoneParams): StudioOperation[] {
  const pageId = params.pageId || 'kaae_milestone_page';
  const width = 1080;
  const height = 1350;
  const logoSha = params.logoSha256 || KAAE_PRIMARY_LOGO_SHA256;
  const ops: StudioOperation[] = [];

  ops.push({
    op: 'addVector',
    nodeId: `${pageId}_bg`,
    pageId,
    source: `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#160874"/>
        <rect x="30" y="30" width="1020" height="1290" rx="12" fill="none" stroke="#E8B85C" stroke-width="2"/>
        <!-- Pill Badge -->
        <rect x="340" y="210" width="400" height="44" rx="22" fill="#E8B85C"/>
        <!-- Network Center Card -->
        <rect x="80" y="460" width="920" height="380" rx="16" fill="rgba(255, 255, 255, 0.08)" stroke="#E8B85C" stroke-width="1.5"/>
        <!-- Impact Card -->
        <rect x="80" y="880" width="920" height="240" rx="12" fill="#0A1628"/>
      </svg>
    `.trim(),
    x: 0,
    y: 0,
    width,
    height,
    locked: true,
  });

  ops.push({
    op: 'addImage',
    nodeId: `${pageId}_top_logo`,
    pageId,
    asset: {
      storageKey: `assets/logos/${logoSha}.png`,
      sha256: logoSha,
      mimeType: 'image/png',
    },
    x: 490,
    y: 70,
    width: 100,
    height: 100,
    fit: 'contain',
    locked: true,
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_badge_text`,
    pageId,
    text: 'NEW GLOBAL MILESTONE',
    role: 'disclaimer',
    x: 340,
    y: 220,
    width: 400,
    height: 30,
    style: {
      fontSize: 16,
      fontWeight: '800',
      fontFamily: 'Minion Variable Concept',
      color: '#160874',
      textAlign: 'center',
    },
  });

  const headEn = params.milestoneTitleEn || 'Approved for International Membership';
  ops.push({
    op: 'addText',
    nodeId: `${pageId}_head_en`,
    pageId,
    text: headEn,
    role: 'headline',
    x: 80,
    y: 310,
    width: 920,
    height: 50,
    style: {
      fontSize: 34,
      fontWeight: '800',
      fontFamily: 'Minion Variable Concept',
      color: '#FFFFFF',
      textAlign: 'center',
    },
  });

  if (params.milestoneTitleCkb) {
    ops.push({
      op: 'addText',
      nodeId: `${pageId}_head_ckb`,
      pageId,
      text: params.milestoneTitleCkb,
      role: 'subheadline',
      x: 80,
      y: 375,
      width: 920,
      height: 45,
      style: {
        fontSize: 28,
        fontWeight: '700',
        fontFamily: 'Cairo',
        color: '#FFF2DB',
        textAlign: 'center',
        direction: 'rtl',
      },
    });
  }

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_network_name_en`,
    pageId,
    text: params.networkNameEn,
    role: 'headline',
    x: 120,
    y: 530,
    width: 840,
    height: 60,
    style: {
      fontSize: 40,
      fontWeight: '800',
      fontFamily: 'Minion Variable Concept',
      color: '#E8B85C',
      textAlign: 'center',
    },
  });

  if (params.networkNameCkb) {
    ops.push({
      op: 'addText',
      nodeId: `${pageId}_network_name_ckb`,
      pageId,
      text: params.networkNameCkb,
      role: 'headline',
      x: 120,
      y: 610,
      width: 840,
      height: 45,
      style: {
        fontSize: 26,
        fontWeight: '700',
        fontFamily: 'Cairo',
        color: '#FFFFFF',
        textAlign: 'center',
        direction: 'rtl',
      },
    });
  }

  const membershipDesc = params.membershipTypeEn || 'Global Recognition Network for Quality Assurance in Higher Education';
  ops.push({
    op: 'addText',
    nodeId: `${pageId}_membership_desc`,
    pageId,
    text: membershipDesc,
    role: 'body',
    x: 120,
    y: 685,
    width: 840,
    height: 60,
    style: {
      fontSize: 20,
      fontWeight: '500',
      fontFamily: 'Minion Variable Concept',
      color: '#D0D8E8',
      textAlign: 'center',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_impact_ckb`,
    pageId,
    text: 'چەسپاندنی پێگەی نێودەوڵەتیی هەرێمی کوردستان لە بواری دڵنیایی جۆریدا هاوتەریب لەگەڵ دیدگای «نەتەوەی زانست» و بەرزکردنەوەی متمانەی گشتی بە خوێندنی باڵا.',
    role: 'body',
    x: 120,
    y: 930,
    width: 840,
    height: 120,
    style: {
      fontSize: 22,
      fontWeight: '600',
      fontFamily: 'Cairo',
      color: '#FFFFFF',
      textAlign: 'right',
      direction: 'rtl',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_footer_url`,
    pageId,
    text: 'www.kaae.org · info@kaae.org',
    role: 'disclaimer',
    x: 80,
    y: 1220,
    width: 920,
    height: 30,
    style: {
      fontSize: 18,
      fontWeight: '600',
      fontFamily: 'Minion Variable Concept',
      color: '#E8B85C',
      textAlign: 'center',
    },
  });

  return ops;
}

/**
 * 3. KaaeEvaluatorCallTemplate (4:5 Feed)
 * Recruitment campaign for peer evaluators across CHE and K-12.
 */
export function createKaaeEvaluatorCallTemplate(params: KaaeEvaluatorCallParams): StudioOperation[] {
  const pageId = params.pageId || 'kaae_evaluator_call_page';
  const width = 1080;
  const height = 1350;
  const logoSha = params.logoSha256 || KAAE_PRIMARY_LOGO_SHA256;
  const ops: StudioOperation[] = [];

  ops.push({
    op: 'addVector',
    nodeId: `${pageId}_bg`,
    pageId,
    source: `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#FDF8F3"/>
        <!-- Top Navy authority banner -->
        <rect x="0" y="0" width="1080" height="180" fill="#160874"/>
        <!-- CHE Target card -->
        <rect x="60" y="370" width="460" height="140" rx="12" fill="#FFFFFF" stroke="#160874" stroke-width="2"/>
        <!-- K12 Target card -->
        <rect x="560" y="370" width="460" height="140" rx="12" fill="#FFFFFF" stroke="#160874" stroke-width="2"/>
        <!-- Criteria card -->
        <rect x="60" y="540" width="960" height="490" rx="16" fill="#FFFFFF" stroke="#E0D9CC" stroke-width="1.5"/>
        <!-- CTA Banner -->
        <rect x="60" y="1060" width="960" height="190" rx="16" fill="#160874"/>
      </svg>
    `.trim(),
    x: 0,
    y: 0,
    width,
    height,
    locked: true,
  });

  ops.push({
    op: 'addImage',
    nodeId: `${pageId}_logo`,
    pageId,
    asset: {
      storageKey: `assets/logos/${logoSha}.png`,
      sha256: logoSha,
      mimeType: 'image/png',
    },
    x: 60,
    y: 40,
    width: 100,
    height: 100,
    fit: 'contain',
    locked: true,
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_header_title`,
    pageId,
    text: 'KURDISTAN ACCREDITING ASSOCIATION FOR EDUCATION',
    role: 'subheadline',
    x: 180,
    y: 75,
    width: 840,
    height: 30,
    style: {
      fontSize: 18,
      fontWeight: '700',
      fontFamily: 'Minion Variable Concept',
      color: '#E8B85C',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_header_ckb`,
    pageId,
    text: 'دەستەی متمانەبەخشینی کوردستان بۆ پەروەردە و خوێندن',
    role: 'headline',
    x: 180,
    y: 115,
    width: 840,
    height: 35,
    style: {
      fontSize: 20,
      fontWeight: '700',
      fontFamily: 'Cairo',
      color: '#FFFFFF',
      textAlign: 'right',
      direction: 'rtl',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_call_headline`,
    pageId,
    text: 'CALL FOR PEER EVALUATORS',
    role: 'headline',
    x: 60,
    y: 230,
    width: 960,
    height: 55,
    style: {
      fontSize: 38,
      fontWeight: '900',
      fontFamily: 'Minion Variable Concept',
      color: '#160874',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_call_ckb`,
    pageId,
    text: 'بانگەواز بۆ هەڵسەنگێنەرانی هاوتا: شارەزایی تۆ، ستانداردەکانی ئێمە، پەروەردەی شایستە',
    role: 'subheadline',
    x: 60,
    y: 295,
    width: 960,
    height: 45,
    style: {
      fontSize: 24,
      fontWeight: '700',
      fontFamily: 'Cairo',
      color: '#E8B85C',
      textAlign: 'right',
      direction: 'rtl',
    },
  });

  // Target Numbers
  ops.push({
    op: 'addText',
    nodeId: `${pageId}_target_che_val`,
    pageId,
    text: `${params.cheEvaluatorTarget ?? 30}`,
    role: 'headline',
    x: 80,
    y: 400,
    width: 100,
    height: 70,
    style: {
      fontSize: 48,
      fontWeight: '800',
      fontFamily: 'Minion Variable Concept',
      color: '#160874',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_target_che_lbl`,
    pageId,
    text: 'Higher Education Evaluators\n(Commission on Higher Education)',
    role: 'body',
    x: 170,
    y: 405,
    width: 320,
    height: 60,
    style: {
      fontSize: 16,
      fontWeight: '600',
      fontFamily: 'Minion Variable Concept',
      color: '#2C3E50',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_target_k12_val`,
    pageId,
    text: `${params.k12EvaluatorTarget ?? 30}`,
    role: 'headline',
    x: 580,
    y: 400,
    width: 100,
    height: 70,
    style: {
      fontSize: 48,
      fontWeight: '800',
      fontFamily: 'Minion Variable Concept',
      color: '#160874',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_target_k12_lbl`,
    pageId,
    text: 'K-12 School Evaluators\n(Commission on K-12 Education)',
    role: 'body',
    x: 670,
    y: 405,
    width: 320,
    height: 60,
    style: {
      fontSize: 16,
      fontWeight: '600',
      fontFamily: 'Minion Variable Concept',
      color: '#2C3E50',
    },
  });

  // Criteria
  ops.push({
    op: 'addText',
    nodeId: `${pageId}_crit_title`,
    pageId,
    text: 'QUALIFICATION & ELIGIBILITY REQUIREMENTS',
    role: 'subheadline',
    x: 100,
    y: 570,
    width: 880,
    height: 35,
    style: {
      fontSize: 20,
      fontWeight: '800',
      fontFamily: 'Minion Variable Concept',
      color: '#160874',
    },
  });

  const criteria = params.criteriaPoints || [
    '• Terminal degree (PhD / Master) from an accredited institution',
    '• Minimum 5 years in higher education leadership, curriculum design, or QA',
    '• Experience in peer review, institutional self-study, or program assessment',
    '• Commitment to complete the 40-hour KAAE Certification Program with MHE',
    '• Fluent in English and Kurdish (Arabic is an advantage)',
  ];

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_crit_body`,
    pageId,
    text: criteria.join('\n\n'),
    role: 'body',
    x: 100,
    y: 620,
    width: 880,
    height: 270,
    style: {
      fontSize: 17,
      fontWeight: '500',
      fontFamily: 'Noto Naskh Arabic',
      color: '#333333',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_kurdish_box`,
    pageId,
    text: 'بەشداربە لە داڕشتنی داهاتووی کوالیتیی پەروەردە لە هەرێمی کوردستان لە چوارچێوەی پلانی ستراتیژیی (ELEVATE ٢٠٢٦-٢٠٢٩).',
    role: 'body',
    x: 100,
    y: 930,
    width: 880,
    height: 70,
    style: {
      fontSize: 19,
      fontWeight: '700',
      fontFamily: 'Cairo',
      color: '#160874',
      textAlign: 'right',
      direction: 'rtl',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_cta_apply`,
    pageId,
    text: 'SUBMIT APPLICATION ONLINE AT KAAE PORTAL',
    role: 'subheadline',
    x: 100,
    y: 1100,
    width: 880,
    height: 35,
    style: {
      fontSize: 22,
      fontWeight: '800',
      fontFamily: 'Minion Variable Concept',
      color: '#E8B85C',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_cta_url`,
    pageId,
    text: 'www.kaae.org/evaluators · info@kaae.org · Erbil, KRI',
    role: 'disclaimer',
    x: 100,
    y: 1150,
    width: 880,
    height: 30,
    style: {
      fontSize: 18,
      fontWeight: '600',
      fontFamily: 'Minion Variable Concept',
      color: '#FFFFFF',
    },
  });

  return ops;
}

/**
 * 4. KaaeMetricsReportTemplate (4:5 Feed & 16:9 Stage Card)
 * High-impact numerical intelligence card: 4.24M views, 1.09M reach, 138 MSCHE volunteers.
 */
export function createKaaeMetricsReportTemplate(params: KaaeMetricsReportParams): StudioOperation[] {
  const pageId = params.pageId || 'kaae_metrics_report_page';
  const width = 1080;
  const height = 1350;
  const logoSha = params.logoSha256 || KAAE_PRIMARY_LOGO_SHA256;
  const ops: StudioOperation[] = [];

  ops.push({
    op: 'addVector',
    nodeId: `${pageId}_bg`,
    pageId,
    source: `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#0A1628"/>
        <rect x="30" y="30" width="1020" height="1290" rx="16" fill="none" stroke="rgba(232, 184, 92, 0.4)" stroke-width="1.5"/>
        <!-- 4 Grid cards -->
        <rect x="80" y="310" width="440" height="220" rx="16" fill="#160874" stroke="#35309B" stroke-width="2"/>
        <rect x="560" y="310" width="440" height="220" rx="16" fill="#160874" stroke="#35309B" stroke-width="2"/>
        <rect x="80" y="570" width="440" height="220" rx="16" fill="#160874" stroke="#35309B" stroke-width="2"/>
        <rect x="560" y="570" width="440" height="220" rx="16" fill="#160874" stroke="#35309B" stroke-width="2"/>
        <!-- Geo footer card -->
        <rect x="80" y="830" width="920" height="320" rx="16" fill="rgba(22, 8, 116, 0.6)" stroke="#E8B85C" stroke-width="1"/>
      </svg>
    `.trim(),
    x: 0,
    y: 0,
    width,
    height,
    locked: true,
  });

  ops.push({
    op: 'addImage',
    nodeId: `${pageId}_top_logo`,
    pageId,
    asset: {
      storageKey: `assets/logos/${logoSha}.png`,
      sha256: logoSha,
      mimeType: 'image/png',
    },
    x: 490,
    y: 60,
    width: 100,
    height: 100,
    fit: 'contain',
    locked: true,
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_top_title`,
    pageId,
    text: 'OVERALL TOTALS ACROSS PLATFORMS',
    role: 'headline',
    x: 100,
    y: 190,
    width: 880,
    height: 40,
    style: {
      fontSize: 28,
      fontWeight: '800',
      fontFamily: 'Minion Variable Concept',
      color: '#E8B85C',
      textAlign: 'center',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_top_ckb`,
    pageId,
    text: 'ئاماری سەرەکی و دەستکەوتەکانی دەستەی متمانەبەخشین',
    role: 'subheadline',
    x: 100,
    y: 240,
    width: 880,
    height: 40,
    style: {
      fontSize: 24,
      fontWeight: '700',
      fontFamily: 'Cairo',
      color: '#FFFFFF',
      textAlign: 'center',
      direction: 'rtl',
    },
  });

  const views = params.socialViews || '4.24M';
  const reach = params.socialReach || '1.09M';
  const volunteers = params.volunteerCount ? `${params.volunteerCount}` : '138';
  const institutions = (params.pilotSchoolsCount && params.pilotUniversitiesCount)
    ? `${params.pilotSchoolsCount + params.pilotUniversitiesCount}`
    : '23';

  // Card 1: Views
  ops.push({
    op: 'addText',
    nodeId: `${pageId}_card_views_num`,
    pageId,
    text: views,
    role: 'headline',
    x: 110,
    y: 350,
    width: 380,
    height: 80,
    style: {
      fontSize: 64,
      fontWeight: '900',
      fontFamily: 'Minion Variable Concept',
      color: '#E8B85C',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_card_views_lbl`,
    pageId,
    text: 'Public Views Across Platforms\n(LinkedIn, FB, IG, YouTube, X)',
    role: 'body',
    x: 110,
    y: 440,
    width: 380,
    height: 50,
    style: {
      fontSize: 16,
      fontWeight: '600',
      fontFamily: 'Minion Variable Concept',
      color: '#D0D8E8',
    },
  });

  // Card 2: Reach
  ops.push({
    op: 'addText',
    nodeId: `${pageId}_card_reach_num`,
    pageId,
    text: reach,
    role: 'headline',
    x: 590,
    y: 350,
    width: 380,
    height: 80,
    style: {
      fontSize: 64,
      fontWeight: '900',
      fontFamily: 'Minion Variable Concept',
      color: '#FFFFFF',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_card_reach_lbl`,
    pageId,
    text: 'Unique Regional & Global Reach\n(Over 13 International Markets)',
    role: 'body',
    x: 590,
    y: 440,
    width: 380,
    height: 50,
    style: {
      fontSize: 16,
      fontWeight: '600',
      fontFamily: 'Minion Variable Concept',
      color: '#D0D8E8',
    },
  });

  // Card 3: MSCHE Volunteers
  ops.push({
    op: 'addText',
    nodeId: `${pageId}_card_vol_num`,
    pageId,
    text: volunteers,
    role: 'headline',
    x: 110,
    y: 610,
    width: 380,
    height: 80,
    style: {
      fontSize: 64,
      fontWeight: '900',
      fontFamily: 'Minion Variable Concept',
      color: '#E8B85C',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_card_vol_lbl`,
    pageId,
    text: 'Higher Ed Volunteers (MSCHE)\n(72% Senior Leadership & Deans)',
    role: 'body',
    x: 110,
    y: 700,
    width: 380,
    height: 50,
    style: {
      fontSize: 16,
      fontWeight: '600',
      fontFamily: 'Minion Variable Concept',
      color: '#D0D8E8',
    },
  });

  // Card 4: Pilot Institutions
  ops.push({
    op: 'addText',
    nodeId: `${pageId}_card_inst_num`,
    pageId,
    text: institutions,
    role: 'headline',
    x: 590,
    y: 610,
    width: 380,
    height: 80,
    style: {
      fontSize: 64,
      fontWeight: '900',
      fontFamily: 'Minion Variable Concept',
      color: '#FFFFFF',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_card_inst_lbl`,
    pageId,
    text: 'Pilot Institutions Engaged\n(12 K-12 Schools + 11 Universities)',
    role: 'body',
    x: 590,
    y: 700,
    width: 380,
    height: 50,
    style: {
      fontSize: 16,
      fontWeight: '600',
      fontFamily: 'Minion Variable Concept',
      color: '#D0D8E8',
    },
  });

  // Geo Footprint
  ops.push({
    op: 'addText',
    nodeId: `${pageId}_geo_title`,
    pageId,
    text: 'VERIFIED GLOBAL AUDIENCE & CONSULAR ENGAGEMENT',
    role: 'subheadline',
    x: 120,
    y: 870,
    width: 840,
    height: 30,
    style: {
      fontSize: 18,
      fontWeight: '700',
      fontFamily: 'Minion Variable Concept',
      color: '#E8B85C',
    },
  });

  const geoList = 'United Kingdom · United States · Germany · France · Norway · Sweden · Canada · Finland · Turkey · Egypt · Lebanon · UAE';
  ops.push({
    op: 'addText',
    nodeId: `${pageId}_geo_list`,
    pageId,
    text: geoList,
    role: 'body',
    x: 120,
    y: 915,
    width: 840,
    height: 40,
    style: {
      fontSize: 18,
      fontWeight: '500',
      fontFamily: 'Minion Variable Concept',
      color: '#FFFFFF',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_geo_ckb`,
    pageId,
    text: 'دەستەی متمانەبەخشین، دەنگی متمانەپێکراوی پەروەردە و خوێندنی باڵای کوردستانە لە سەرتاسەری جیهاندا.',
    role: 'body',
    x: 120,
    y: 990,
    width: 840,
    height: 80,
    style: {
      fontSize: 20,
      fontWeight: '600',
      fontFamily: 'Cairo',
      color: '#FFF2DB',
      textAlign: 'right',
      direction: 'rtl',
    },
  });

  ops.push({
    op: 'addText',
    nodeId: `${pageId}_footer`,
    pageId,
    text: 'Empowering Education, Inspiring the Future · www.kaae.org',
    role: 'disclaimer',
    x: 80,
    y: 1220,
    width: 920,
    height: 30,
    style: {
      fontSize: 16,
      fontWeight: '600',
      fontFamily: 'Minion Variable Concept',
      color: '#E8B85C',
      textAlign: 'center',
    },
  });

  return ops;
}
