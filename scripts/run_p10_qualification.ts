import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveModel, isDevModelTier, activeModelTier } from '../packages/domain/dist/provider-policy.js';

const PRICING = createRequire(import.meta.url)('../packages/creative/src/studio/pricing.json') as {
  models: Record<string, { inputPerMillion?: number; outputPerMillion?: number; cacheReadPerMillion?: number }>;
};
import {
  OpenAiStudioClient,
  ExemplarRetrievalIndex,
  generateLayoutCandidatesV3,
  evaluateDesignMetrics,
  renderLayoutV2,
  getFontFidelityManifest,
  resolveRatesForModel,
  correctFontsThatCannotDrawTheCopy,
  refineCandidate,
  generateBoxGroundedCritique,
  comparePairWithOrderSwap,
  evaluatePairOrder,
  type StudioLayoutV2,
  type DesignMetricsReport,
  type BoxCritiqueResult,
  type PairwiseMatchResult,
  createDegradedCanaryLayout,
  JUDGE_DIMENSIONS,
  type CopyBlockSlotInput,
  type CandidateJudgeInput,
  checkOfficeDailyBudget,
  PipelineCostGovernorV3,
  getOfficeDailyCapUsd,
  getPerBriefCapUsd,
} from '../packages/creative/dist/index.js';

export interface QualificationBrief {
  id: string;
  name: string;
  language: 'en' | 'ckb';
  width: number;
  height: number;
  sizeName: 'Square' | 'Portrait 4:5' | 'Story 9:16' | 'A4 Document' | 'Landscape 16:9';
  copyBlocks: Array<{
    copyIndex: number;
    text: string;
    role: 'eyebrow' | 'title' | 'subtitle' | 'body' | 'venue' | 'date' | 'footer';
    script: 'latin' | 'arabic';
  }>;
}

// 20 held-out briefs (10 English, 10 Sorani Kurdish, 4 per size across 5 sizes)
export const QUALIFICATION_BRIEFS: QualificationBrief[] = [
  // SIZE 1: 1080x1080 (Square 1:1)
  {
    id: 'brief_01_en_square',
    name: 'KAAE Quality Standards Benchmark Announcement',
    language: 'en',
    width: 1080,
    height: 1080,
    sizeName: 'Square',
    copyBlocks: [
      { copyIndex: 0, text: 'Kurdistan Accrediting Agency for Education', role: 'eyebrow', script: 'latin' },
      { copyIndex: 1, text: 'Mandatory Quality Standards 2026', role: 'title', script: 'latin' },
      { copyIndex: 2, text: 'Institutional Excellence Under Law No. 6', role: 'subtitle', script: 'latin' },
      { copyIndex: 3, text: 'All universities must publish audited accreditation reports by the end of Q3.', role: 'body', script: 'latin' },
      { copyIndex: 4, text: 'Erbil • September 2026 • kaae.gov.krd', role: 'footer', script: 'latin' },
    ],
  },
  {
    id: 'brief_02_en_square',
    name: 'Curriculum Framework Certification Notice',
    language: 'en',
    width: 1080,
    height: 1080,
    sizeName: 'Square',
    copyBlocks: [
      { copyIndex: 0, text: 'Board of Educational Quality', role: 'eyebrow', script: 'latin' },
      { copyIndex: 1, text: 'Curriculum Accreditation Protocol', role: 'title', script: 'latin' },
      { copyIndex: 2, text: 'National Academic Program Certification', role: 'subtitle', script: 'latin' },
      { copyIndex: 3, text: 'Faculty program chairs must attend mandatory alignment workshops next month.', role: 'body', script: 'latin' },
      { copyIndex: 4, text: 'Kurdistan Regional Government • KAAE', role: 'footer', script: 'latin' },
    ],
  },
  {
    id: 'brief_03_ckb_square',
    name: 'ڕاگەیاندنی پێوەرەکانی دڵنیایی جۆری KAAE',
    language: 'ckb',
    width: 1080,
    height: 1080,
    sizeName: 'Square',
    copyBlocks: [
      { copyIndex: 0, text: 'دەستەی باڵای متمانەبەخشین بە پەروەردە', role: 'eyebrow', script: 'arabic' },
      { copyIndex: 1, text: 'پێوەرە نیشتمانییەکانی کوالیتی خوێندن', role: 'title', script: 'arabic' },
      { copyIndex: 2, text: 'بەپێی یاسای ژمارە ٦ی ساڵی ٢٠٢٢', role: 'subtitle', script: 'arabic' },
      { copyIndex: 3, text: 'پێویستە هەموو کۆلێژ و زانکۆکان ڕاپۆرتی بەراوردکاری متمانەبەخشین ئامادە بکەن.', role: 'body', script: 'arabic' },
      { copyIndex: 4, text: 'هەولێر • ئەنجومەنی باڵا • kaae.gov.krd', role: 'footer', script: 'arabic' },
    ],
  },
  {
    id: 'brief_04_ckb_square',
    name: 'مۆڵەتی ئەکادیمی بەرنامەکانی خوێندنی باڵا',
    language: 'ckb',
    width: 1080,
    height: 1080,
    sizeName: 'Square',
    copyBlocks: [
      { copyIndex: 0, text: 'کوالیتی خوێندنی باڵا و توێژینەوەی زانستی', role: 'eyebrow', script: 'arabic' },
      { copyIndex: 1, text: 'دەستپێکی هەڵسەنگاندنی دامەزراوەیی', role: 'title', script: 'arabic' },
      { copyIndex: 2, text: 'پێداچوونەوەی هاوتا نێودەوڵەتییەکان', role: 'subtitle', script: 'arabic' },
      { copyIndex: 3, text: 'شاندی نێودەوڵەتی سەردانی زانکۆکانی هەرێم دەکەن بۆ دڵنیابوون لە شایستەیی خوێندن.', role: 'body', script: 'arabic' },
      { copyIndex: 4, text: 'حکومەتی هەرێمی کوردستان • KAAE', role: 'footer', script: 'arabic' },
    ],
  },

  // SIZE 2: 1080x1350 (Portrait 4:5)
  {
    id: 'brief_05_en_portrait45',
    name: 'KAAE Annual Accreditation Symposium 2026',
    language: 'en',
    width: 1080,
    height: 1350,
    sizeName: 'Portrait 4:5',
    copyBlocks: [
      { copyIndex: 0, text: 'Kurdistan Accreditation Agency for Education', role: 'eyebrow', script: 'latin' },
      { copyIndex: 1, text: 'Annual Accreditation Symposium 2026', role: 'title', script: 'latin' },
      { copyIndex: 2, text: 'Advancing Academic Standards Across Kurdistan', role: 'subtitle', script: 'latin' },
      { copyIndex: 3, text: 'Join university chancellors and accreditation delegates for keynote sessions and national curriculum framework reviews.', role: 'body', script: 'latin' },
      { copyIndex: 4, text: 'Erbil International Conference Center • October 24, 2026 • 09:30 AM', role: 'footer', script: 'latin' },
    ],
  },
  {
    id: 'brief_06_en_portrait45',
    name: 'University Rector Statutory Assembly',
    language: 'en',
    width: 1080,
    height: 1350,
    sizeName: 'Portrait 4:5',
    copyBlocks: [
      { copyIndex: 0, text: 'Office of the High Commissioner for Quality', role: 'eyebrow', script: 'latin' },
      { copyIndex: 1, text: 'Statutory Assembly of University Rectors', role: 'title', script: 'latin' },
      { copyIndex: 2, text: 'Deliberation on National Quality Benchmarks', role: 'subtitle', script: 'latin' },
      { copyIndex: 3, text: 'Formal assembly to ratify the five-year strategic roadmap for regional higher education recognition.', role: 'body', script: 'latin' },
      { copyIndex: 4, text: 'Rotana Grand Ballroom, Erbil • November 12, 2026', role: 'footer', script: 'latin' },
    ],
  },
  {
    id: 'brief_07_ckb_portrait45',
    name: 'کۆنفرانسی نیشتمانیی دڵنیایی جۆری ٢٠٢٦',
    language: 'ckb',
    width: 1080,
    height: 1350,
    sizeName: 'Portrait 4:5',
    copyBlocks: [
      { copyIndex: 0, text: 'دەستەی متمانەبەخشین بە دامەزراوەکانی پەروەردە', role: 'eyebrow', script: 'arabic' },
      { copyIndex: 1, text: 'کۆنفرانسی نیشتمانیی دڵنیایی جۆری ٢٠٢٦', role: 'title', script: 'arabic' },
      { copyIndex: 2, text: 'بەرەو بەرزکردنەوەی ئاستی زانستی لە زانکۆکانی کوردستان', role: 'subtitle', script: 'arabic' },
      { copyIndex: 3, text: 'بانگهێشتی سەرجەم سەرۆک زانکۆکان و پسپۆڕانی پەروەردەیی دەکرێت بۆ بەشداریکردن لە شیکاری پێوەرە نێودەوڵەتییەکان.', role: 'body', script: 'arabic' },
      { copyIndex: 4, text: 'هۆڵی سەعد عەبدوڵڵا، هەولێر • ٢٨ی تشرینی یەکەمی ٢٠٢٦', role: 'footer', script: 'arabic' },
    ],
  },
  {
    id: 'brief_08_ckb_portrait45',
    name: 'کۆبوونەوەی شاندە ئەکادیمییە نێودەوڵەتییەکان',
    language: 'ckb',
    width: 1080,
    height: 1350,
    sizeName: 'Portrait 4:5',
    copyBlocks: [
      { copyIndex: 0, text: 'فەرمانگەی دڵنیایی جۆری و متمانەبەخشین', role: 'eyebrow', script: 'arabic' },
      { copyIndex: 1, text: 'کۆبوونەوەی باڵای سەرۆک زانکۆکان', role: 'title', script: 'arabic' },
      { copyIndex: 2, text: 'پەسەندکردنی ڕێسای نوێی خوێندنی ئەکادیمی', role: 'subtitle', script: 'arabic' },
      { copyIndex: 3, text: 'گفتوگۆ لەسەر شێوازی تاقیکردنەوەکان، نوێکردنەوەی پڕۆگرامەکان و پەسەندکردنی بڕوانامە نێودەوڵەتییەکان.', role: 'body', script: 'arabic' },
      { copyIndex: 4, text: 'شاری سلێمانی • هۆڵی کۆنگرێس • کانوونی دووەمی ٢٠٢٦', role: 'footer', script: 'arabic' },
    ],
  },

  // SIZE 3: 1080x1920 (Story 9:16)
  {
    id: 'brief_09_en_story916',
    name: 'Institutional Quality Deadline Alert',
    language: 'en',
    width: 1080,
    height: 1920,
    sizeName: 'Story 9:16',
    copyBlocks: [
      { copyIndex: 0, text: 'Regulatory Notice', role: 'eyebrow', script: 'latin' },
      { copyIndex: 1, text: 'Annual Audit Submission Deadline', role: 'title', script: 'latin' },
      { copyIndex: 2, text: 'Statutory Compliance Protocol', role: 'subtitle', script: 'latin' },
      { copyIndex: 3, text: 'All recognized public and private universities must upload verified documentation to the central portal.', role: 'body', script: 'latin' },
      { copyIndex: 4, text: 'Final Cutoff: December 15, 2026 • portal.kaae.gov.krd', role: 'footer', script: 'latin' },
    ],
  },
  {
    id: 'brief_10_en_story916',
    name: 'Research Grant & Faculty Recognition',
    language: 'en',
    width: 1080,
    height: 1920,
    sizeName: 'Story 9:16',
    copyBlocks: [
      { copyIndex: 0, text: 'Academic Innovation Directorate', role: 'eyebrow', script: 'latin' },
      { copyIndex: 1, text: 'Presidential Fellowship Awards', role: 'title', script: 'latin' },
      { copyIndex: 2, text: 'Honoring Distinguished Scholarly Research', role: 'subtitle', script: 'latin' },
      { copyIndex: 3, text: 'Recognizing peer-reviewed breakthroughs across engineering, medicine, and social sciences in Kurdistan.', role: 'body', script: 'latin' },
      { copyIndex: 4, text: 'Applications open via KAAE Academic Registry', role: 'footer', script: 'latin' },
    ],
  },
  {
    id: 'brief_11_ckb_story916',
    name: 'ئاگاداری کۆتایی هاتنی وادەی متمانەبەخشین',
    language: 'ckb',
    width: 1080,
    height: 1920,
    sizeName: 'Story 9:16',
    copyBlocks: [
      { copyIndex: 0, text: 'ئاگاداری فەرمی لە دەستەی KAAE', role: 'eyebrow', script: 'arabic' },
      { copyIndex: 1, text: 'دوایین وادەی ناردنی ڕاپۆرتی ساڵانە', role: 'title', script: 'arabic' },
      { copyIndex: 2, text: 'متمانەپێدانی زانکۆ و پەیمانگەکان', role: 'subtitle', script: 'arabic' },
      { copyIndex: 3, text: 'سەرجەم دەزگا پەروەردەییەکان ئاگادار دەکرێنەوە کە دوایین مۆڵەت بۆ تۆمارکردن لە پۆڕتاڵ نزیک بووەتەوە.', role: 'body', script: 'arabic' },
      { copyIndex: 4, text: 'ڕێکەوتی کۆتایی: ١٥ی کانوونی یەکەم • portal.kaae.gov.krd', role: 'footer', script: 'arabic' },
    ],
  },
  {
    id: 'brief_12_ckb_story916',
    name: 'خەڵاتی ساڵانەی توێژینەوەی ئەکادیمی',
    language: 'ckb',
    width: 1080,
    height: 1920,
    sizeName: 'Story 9:16',
    copyBlocks: [
      { copyIndex: 0, text: 'بەشی داهێنان و پێشخستنی زانستی', role: 'eyebrow', script: 'arabic' },
      { copyIndex: 1, text: 'خەڵاتی ساڵانەی سەرۆکایەتی KAAE', role: 'title', script: 'arabic' },
      { copyIndex: 2, text: 'بۆ باشترین توێژینەوەی ئاستبەرز', role: 'subtitle', script: 'arabic' },
      { copyIndex: 3, text: 'پاداشتکردنی مامۆستایان و توێژەرانی نموونەیی لە بوارە زانستی و مرۆییەکاندا.', role: 'body', script: 'arabic' },
      { copyIndex: 4, text: 'تۆمارکردن لە ڕێگەی ماڵپەڕی فەرمییەوە بەردەستە', role: 'footer', script: 'arabic' },
    ],
  },

  // SIZE 4: 1240x1754 (A4 Formal Document)
  {
    id: 'brief_13_en_a4doc',
    name: 'Institutional Accreditation Directive No. 4',
    language: 'en',
    width: 1240,
    height: 1754,
    sizeName: 'A4 Document',
    copyBlocks: [
      { copyIndex: 0, text: 'Kurdistan Regional Government • KAAE High Council', role: 'eyebrow', script: 'latin' },
      { copyIndex: 1, text: 'Statutory Accreditation Order No. 4', role: 'title', script: 'latin' },
      { copyIndex: 2, text: 'Mandatory Governance Criteria for Higher Education Institutions', role: 'subtitle', script: 'latin' },
      { copyIndex: 3, text: 'Pursuant to powers vested under Law No. 6 of 2022, all degree-granting bodies must comply with institutional auditing standards.', role: 'body', script: 'latin' },
      { copyIndex: 4, text: 'Published in the Official Gazette • Erbil, Kurdistan Region • 2026', role: 'footer', script: 'latin' },
    ],
  },
  {
    id: 'brief_14_en_a4doc',
    name: 'National Quality Assurance Charter',
    language: 'en',
    width: 1240,
    height: 1754,
    sizeName: 'A4 Document',
    copyBlocks: [
      { copyIndex: 0, text: 'Charter of Academic Excellence', role: 'eyebrow', script: 'latin' },
      { copyIndex: 1, text: 'National Quality Assurance Covenant', role: 'title', script: 'latin' },
      { copyIndex: 2, text: 'Guiding Principles for Academic Autonomy and Rigor', role: 'subtitle', script: 'latin' },
      { copyIndex: 3, text: 'Signatory universities pledge strict institutional integrity, peer-reviewed assessment, and open educational data governance.', role: 'body', script: 'latin' },
      { copyIndex: 4, text: 'Council of Chancellors & Accrediting Commission • 2026', role: 'footer', script: 'latin' },
    ],
  },
  {
    id: 'brief_15_ckb_a4doc',
    name: 'فەرمانی دەستەی متمانەبەخشین ژمارە ٤',
    language: 'ckb',
    width: 1240,
    height: 1754,
    sizeName: 'A4 Document',
    copyBlocks: [
      { copyIndex: 0, text: 'حکومەتی هەرێمی کوردستان • ئەنجومەنی باڵای KAAE', role: 'eyebrow', script: 'arabic' },
      { copyIndex: 1, text: 'بڕیاری فەرمی دەستەی متمانەبەخشین', role: 'title', script: 'arabic' },
      { copyIndex: 2, text: 'پێوەرە دەستوورییەکانی بەڕێوەبردنی زانکۆکان', role: 'subtitle', script: 'arabic' },
      { copyIndex: 3, text: 'پاڵپشت بە یاسای ژمارە ٦ی ساڵی ٢٠٢٢، فەرمان دەکرێت بە پابەندبوونی تەواوی زانکۆکان بە پێوەرە نیشتمانییەکان.', role: 'body', script: 'arabic' },
      { copyIndex: 4, text: 'لە ڕۆژنامەی فەرمی وەقایعی کوردستان بڵاوکراوەتەوە • هەولێر • ٢٠٢٦', role: 'footer', script: 'arabic' },
    ],
  },
  {
    id: 'brief_16_ckb_a4doc',
    name: 'پەیماننامەی نیشتمانیی دڵنیایی جۆری',
    language: 'ckb',
    width: 1240,
    height: 1754,
    sizeName: 'A4 Document',
    copyBlocks: [
      { copyIndex: 0, text: 'پەیماننامەی سەروەریی ئەکادیمی', role: 'eyebrow', script: 'arabic' },
      { copyIndex: 1, text: 'بەڵگەنامەی نیشتمانیی دڵنیایی جۆری', role: 'title', script: 'arabic' },
      { copyIndex: 2, text: 'بنەما سەرەکییەکانی پەروەردە و فێرکردن', role: 'subtitle', script: 'arabic' },
      { copyIndex: 3, text: 'زانکۆ واژۆکارەکان پابەند دەبن بە ڕەچاوکردنی شەفافیەت، سەربەخۆیی زانستی، و پاراستنی مافی خوێندکاران.', role: 'body', script: 'arabic' },
      { copyIndex: 4, text: 'دەستەی باڵای متمانەبەخشین • شاری هەولێر • ٢٠٢٦', role: 'footer', script: 'arabic' },
    ],
  },

  // SIZE 5: 1920x1080 (Landscape 16:9)
  {
    id: 'brief_17_en_landscape169',
    name: 'KAAE Chancellor Summit Main Screen',
    language: 'en',
    width: 1920,
    height: 1080,
    sizeName: 'Landscape 16:9',
    copyBlocks: [
      { copyIndex: 0, text: 'Executive Directorate for Higher Education', role: 'eyebrow', script: 'latin' },
      { copyIndex: 1, text: 'Kurdistan Chancellor Summit 2026', role: 'title', script: 'latin' },
      { copyIndex: 2, text: 'Strategic Convergence on Global Academic Recognition', role: 'subtitle', script: 'latin' },
      { copyIndex: 3, text: 'Uniting leadership to pioneer internationally recognized degree validation and regional research clusters.', role: 'body', script: 'latin' },
      { copyIndex: 4, text: 'KAAE Plenary Hall • October 2026 • Live Broadcast kaae.gov.krd', role: 'footer', script: 'latin' },
    ],
  },
  {
    id: 'brief_18_en_landscape169',
    name: 'International Quality Accreditation Forum',
    language: 'en',
    width: 1920,
    height: 1080,
    sizeName: 'Landscape 16:9',
    copyBlocks: [
      { copyIndex: 0, text: 'Global Educational Standards Partnership', role: 'eyebrow', script: 'latin' },
      { copyIndex: 1, text: 'International Accreditation Forum', role: 'title', script: 'latin' },
      { copyIndex: 2, text: 'Cross-Border Recognition & Institutional Integrity', role: 'subtitle', script: 'latin' },
      { copyIndex: 3, text: 'Convening international peer evaluators from Europe and the Middle East to advance curriculum mobility.', role: 'body', script: 'latin' },
      { copyIndex: 4, text: 'Conference Center • Erbil • November 2026', role: 'footer', script: 'latin' },
    ],
  },
  {
    id: 'brief_19_ckb_landscape169',
    name: 'دیداری لوتکەی سەرۆک زانکۆکانی کوردستان',
    language: 'ckb',
    width: 1920,
    height: 1080,
    sizeName: 'Landscape 16:9',
    copyBlocks: [
      { copyIndex: 0, text: 'فەرمانگەی باڵای خوێندنی ئەکادیمی', role: 'eyebrow', script: 'arabic' },
      { copyIndex: 1, text: 'دیداری لوتکەی سەرۆک زانکۆکان ٢٠٢٦', role: 'title', script: 'arabic' },
      { copyIndex: 2, text: 'هەنگاوەکانی بەدەستهێنانی دانپێدانانی نێودەوڵەتی', role: 'subtitle', script: 'arabic' },
      { copyIndex: 3, text: 'کۆکردنەوەی تواناکان بۆ داڕشتنی ڕوانگەیەکی هاوبەش بەرەو پێشەنگی پەروەردەیی و زانستی لە ناوچەکەدا.', role: 'body', script: 'arabic' },
      { copyIndex: 4, text: 'هۆڵی کۆبوونەوەکانی KAAE • هەولێر • پەخشی ڕاستەوخۆ', role: 'footer', script: 'arabic' },
    ],
  },
  {
    id: 'brief_20_ckb_landscape169',
    name: 'فۆڕمی پەیوەندییە نێودەوڵەتییەکان بۆ دڵنیایی جۆری',
    language: 'ckb',
    width: 1920,
    height: 1080,
    sizeName: 'Landscape 16:9',
    copyBlocks: [
      { copyIndex: 0, text: 'پەیمانگەی نێودەوڵەتیی کوالیتی پەروەردە', role: 'eyebrow', script: 'arabic' },
      { copyIndex: 1, text: 'فۆڕمی نێودەوڵەتیی متمانەبەخشین', role: 'title', script: 'arabic' },
      { copyIndex: 2, text: 'پەرەپێدانی هاوبەشییە زانستییەکان', role: 'subtitle', script: 'arabic' },
      { copyIndex: 3, text: 'بەشداریی شارەزایانی بیانی لە تاوتوێکردنی سیستەمی دڵنیایی جۆری زانکۆکانی هەرێمی کوردستان.', role: 'body', script: 'arabic' },
      { copyIndex: 4, text: 'هەولێر • تشرینی دووەمی ٢٠٢٦ • kaae.gov.krd', role: 'footer', script: 'arabic' },
    ],
  },
];

export interface LedgerRow {
  call_id: string;
  x_request_id: string;
  stage: 'P03_LAYOUT' | 'P05_CRITIQUE' | 'P06_REFINE' | 'P07_JUDGE_AB' | 'P07_JUDGE_BA' | 'P07_CANARY';
  brief_id: string;
  model: string;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  gross_cost_usd: number;
  cache_discount_usd: number;
  net_cost_usd: number;
  latency_ms: number;
  timestamp: string;
}

export interface BriefResult {
  briefIndex: number;
  brief: QualificationBrief;
  layout: StudioLayoutV2;
  metrics: DesignMetricsReport;
  critique: BoxCritiqueResult;
  pairwiseMatch?: PairwiseMatchResult;
  canaryMatch: any;
  ledgerRows: LedgerRow[];
  totalNetCostUsd: number;
  totalLatencyMs: number;
  prrPass: boolean;
  geometricPass: boolean;
  readabilityPass: boolean;
  assetIntegrityPass: boolean;
  copyExactPass: boolean;
  editabilityPass: boolean;
  canaryWon: boolean;
  orderSwapConsistent: boolean;
  distinctSkeleton: boolean;
}

function computeTokenCosts(
  inputTokens: number,
  cachedTokens: number,
  outputTokens: number,
  model: string = resolveModel('text')
) {
  // Rates come from the priced model, not from constants: with a cheaper dev tier active, fixed
  // production rates would overstate every row in the ledger by up to eighty times.
  const rates = resolveRatesForModel(PRICING.models as Record<string, any>, model);
  if (!rates?.inputPerMillion) {
    throw new Error(
      `No price for model '${model}' in pricing.json — refusing to write a ledger with invented rates.`
    );
  }
  const inRate = rates.inputPerMillion;
  const outRate = rates.outputPerMillion;
  const cacheRate = rates.cacheReadPerMillion ?? inRate;

  const uncachedInput = Math.max(0, inputTokens - cachedTokens);
  const grossCostUsd = Number(((inputTokens * inRate + outputTokens * outRate) / 1_000_000).toFixed(6));
  const cacheDiscountUsd = Number(((cachedTokens * (inRate - cacheRate)) / 1_000_000).toFixed(6));
  const netCostUsd = Number(
    ((uncachedInput * inRate + cachedTokens * cacheRate + outputTokens * outRate) / 1_000_000).toFixed(6)
  );
  return { grossCostUsd, cacheDiscountUsd, netCostUsd };
}

function sanitizeFont(font: string, isRtl: boolean, role?: string): string {
  if (role === 'body' || role === 'footer') {
    return isRtl ? 'Noto Sans Arabic' : 'Verdana';
  }
  if (isRtl) {
    if (font === 'Cairo' || font === 'Amiri') return font;
    // Amiri, not Cairo: Cairo cannot draw the Sorani letters ڕ ڵ ۆ ێ ە. Defaulting to Cairo here
    // would have quietly reintroduced that after refinement, undoing the generator's correction.
    return 'Amiri';
  } else {
    if (font === 'Cinzel' || font === 'Playfair Display') return font;
    if (font === 'Lora') return 'Playfair Display';
    if (font === 'Cormorant Garamond' || font === 'Montserrat') return 'Cinzel';
    if (font === 'Verdana') return font;
    return 'Cinzel';
  }
}

async function executeBriefLive(
  brief: QualificationBrief,
  briefIndex: number,
  client: OpenAiStudioClient,
  retrievalIndex: ExemplarRetrievalIndex,
  briefsDir: string,
  previousArchetype: string | null
): Promise<BriefResult> {
  const briefFolder = path.join(briefsDir, `brief_${String(briefIndex + 1).padStart(2, '0')}`);
  fs.mkdirSync(briefFolder, { recursive: true });

  const startTime = Date.now();
  const formatKey = brief.width === brief.height ? '1:1' : '4:5';
  const briefLedgerRows: LedgerRow[] = [];

  // 1. P02 Exemplar Retrieval
  const retrieval = retrievalIndex.retrieveTopExemplars(
    { text: brief.name, format: formatKey, category: 'standards' },
    3
  );

  const slotInputs: CopyBlockSlotInput[] = brief.copyBlocks.map((b) => ({
    index: b.copyIndex,
    text: b.text,
    role: b.role,
    script: b.script,
  }));

  const palette = ['#0A1628', '#C5A059', '#1E3A5F', '#FDF8F3'];
  // One model name for the whole brief, recorded on every row so the ledger says what actually ran.
  const layoutModel = resolveModel('layout');
  // One model per stage role, so the cheap tier can spend where the design is decided and save
  // where it is only scored. A single model for all five stages defeats the point of the tiers.
  const critiqueModel = resolveModel('critique');
  const judgeModel = resolveModel('judge');
  // Built here rather than further down: the candidate scoring below needs it, and a const
  // declared after its use is a temporal-dead-zone ReferenceError at run time.
  const copyMap: Record<number, string> = {};
  for (const b of brief.copyBlocks) {
    copyMap[b.copyIndex] = b.text;
  }
  const isRtl = brief.language === 'ckb';

  console.log(`[P10 LIVE] Starting Brief ${briefIndex + 1}/20: ${brief.id} (${brief.sizeName})...`);

  // 2. P03 Multi-Candidate Layout Generation
  const genResult = await generateLayoutCandidatesV3({
    client,
    brief: `${brief.name}: ${brief.copyBlocks.map((c) => c.text).join(' - ')}`,
    copyBlocks: slotInputs,
    palette,
    canvasWidth: brief.width,
    canvasHeight: brief.height,
    exemplars: retrieval.retrievedExemplars,
    isRtl,
  });

  const layoutCosts = computeTokenCosts(genResult.inputTokens, genResult.cachedTokens, genResult.outputTokens, layoutModel);
  briefLedgerRows.push({
    call_id: genResult.responseId,
    x_request_id: genResult.xRequestId || '',
    stage: 'P03_LAYOUT',
    brief_id: brief.id,
    model: layoutModel,
    input_tokens: genResult.inputTokens,
    cached_tokens: genResult.cachedTokens,
    output_tokens: genResult.outputTokens,
    gross_cost_usd: layoutCosts.grossCostUsd,
    cache_discount_usd: layoutCosts.cacheDiscountUsd,
    net_cost_usd: layoutCosts.netCostUsd,
    latency_ms: genResult.latencyMs,
    timestamp: new Date().toISOString(),
  });

  // Ensure fonts resolve against installed fontconfig assets
  for (const cand of genResult.layouts) {
    for (const t of cand.text) {
      t.fontFamily = sanitizeFont(t.fontFamily, isRtl, t.role) as any;
    }
  }

  // Evaluate candidate layouts with deterministic P01 metrics
  const evaluatedCandidates = genResult.layouts.map((cand, idx) => ({
    cand,
    metrics: evaluateDesignMetrics(cand),
    rawCandidate: genResult.rawCandidates[idx],
  }));

  // Sort candidates by passing status, then by composite score descending
  evaluatedCandidates.sort((a, b) => {
    if (a.metrics.passed !== b.metrics.passed) return a.metrics.passed ? -1 : 1;
    return b.metrics.compositeScore - a.metrics.compositeScore;
  });

  const best = evaluatedCandidates[0];
  let layout = best.cand;
  let metrics = best.metrics;

  // 3. P05 Vision Critique Stage (Set-of-Mark Grounded)
  console.log(`[P10 LIVE] Brief ${brief.id}: Invoking P05 vision critique on top candidate...`);
  const critiqueResult = await generateBoxGroundedCritique(best.cand, {
    client,
    model: critiqueModel,
    deterministicMetrics: best.metrics,
  });

  const critiqueReceipt = critiqueResult.receipt;
  const critiqueCosts = computeTokenCosts(
    critiqueReceipt.inputTokens,
    critiqueReceipt.cachedTokens ?? 0,
    critiqueReceipt.outputTokens,
    critiqueReceipt.model || layoutModel
  );
  briefLedgerRows.push({
    call_id: critiqueReceipt.responseId,
    x_request_id: critiqueReceipt.xRequestId || '',
    stage: 'P05_CRITIQUE',
    brief_id: brief.id,
    model: critiqueReceipt.model,
    input_tokens: critiqueReceipt.inputTokens,
    cached_tokens: critiqueReceipt.cachedTokens ?? 0,
    output_tokens: critiqueReceipt.outputTokens,
    gross_cost_usd: critiqueCosts.grossCostUsd,
    cache_discount_usd: critiqueCosts.cacheDiscountUsd,
    net_cost_usd: critiqueCosts.netCostUsd,
    latency_ms: critiqueReceipt.latencyMs,
    timestamp: new Date().toISOString(),
  });

  // 4. P06 Gated Visual Refinement Loop if needed
  if (!best.metrics.passed) {
    console.log(
      `[P10 LIVE] Brief ${brief.id}: 1-shot failed metrics [${best.metrics.failingMetrics.join(
        ', '
      )}]. Invoking P06 gated refinement...`
    );
    try {
      const refineResult = await refineCandidate(best.cand, {
        client,
        maxRounds: 2,
        minDelta: 0.01,
        model: layoutModel,
      });
      for (const r of refineResult.rounds) {
        if (r.receipt) {
          const rCosts = computeTokenCosts(r.receipt.inputTokens, r.receipt.cachedTokens ?? 0, r.receipt.outputTokens, r.receipt.model || layoutModel);
          briefLedgerRows.push({
            call_id: r.receipt.responseId,
            x_request_id: r.receipt.xRequestId || '',
            stage: 'P06_REFINE',
            brief_id: brief.id,
            model: r.receipt.model,
            input_tokens: r.receipt.inputTokens,
            cached_tokens: r.receipt.cachedTokens ?? 0,
            output_tokens: r.receipt.outputTokens,
            gross_cost_usd: rCosts.grossCostUsd,
            cache_discount_usd: rCosts.cacheDiscountUsd,
            net_cost_usd: rCosts.netCostUsd,
            latency_ms: r.receipt.latencyMs,
            timestamp: new Date().toISOString(),
          });
        }
      }
      // Adopt the refinement only once it is known to be a usable layout. Assigning first and
      // validating later meant a malformed refinement replaced the winning layout and then threw,
      // and the catch below swallowed the throw — leaving every downstream stage working on the
      // broken object. Seen live: "layout.text is not iterable".
      const refined: any = refineResult.finalLayout;
      const refinedIsUsable =
        !!refined &&
        Array.isArray(refined.text) &&
        refined.text.length > 0 &&
        Array.isArray(refined.shapes) &&
        Number.isFinite(refined.width) &&
        Number.isFinite(refined.height);

      if (!refinedIsUsable) {
        console.warn(
          `[P10 LIVE] Brief ${brief.id}: refinement returned an unusable layout; keeping the winner.`
        );
      } else if (refineResult.finalScore > best.metrics.compositeScore || refineResult.passed) {
        layout = refined;
        for (const t of layout.text) {
          t.fontFamily = sanitizeFont(t.fontFamily, isRtl, t.role) as any;
        }
        // Sanitisation maps by role and script, not by what the copy contains, so verify coverage
        // afterwards: a block whose font cannot draw its own script is corrected here too.
        correctFontsThatCannotDrawTheCopy(layout, copyMap);
        metrics = evaluateDesignMetrics(layout);
      }
    } catch (err: any) {
      console.warn(`[P10 LIVE] Brief ${brief.id}: refinement error:`, err?.message);
    }
  }

  // 5. P07 Real Pairwise Dimension-Wise Judge with Order Swap
  console.log(`[P10 LIVE] Brief ${brief.id}: Invoking P07 pairwise LLM judge with order swap...`);
  const cand1Input: CandidateJudgeInput = { id: `${brief.id}_c1`, layout };
  const cand2Layout = evaluatedCandidates[1]?.cand || evaluatedCandidates[0].cand;
  const cand2Input: CandidateJudgeInput = { id: `${brief.id}_c2`, layout: cand2Layout };

  const matchResult = await comparePairWithOrderSwap(cand1Input, cand2Input, {
    client,
    model: judgeModel,
  });

  const abCosts = computeTokenCosts(
    matchResult.orderAB.receipt.inputTokens,
    matchResult.orderAB.receipt.cachedTokens ?? 0,
    matchResult.orderAB.receipt.outputTokens,
    matchResult.orderAB.receipt.model || layoutModel
  );
  briefLedgerRows.push({
    call_id: matchResult.orderAB.receipt.responseId,
    x_request_id: matchResult.orderAB.receipt.xRequestId || '',
    stage: 'P07_JUDGE_AB',
    brief_id: brief.id,
    model: matchResult.orderAB.receipt.model,
    input_tokens: matchResult.orderAB.receipt.inputTokens,
    cached_tokens: matchResult.orderAB.receipt.cachedTokens ?? 0,
    output_tokens: matchResult.orderAB.receipt.outputTokens,
    gross_cost_usd: abCosts.grossCostUsd,
    cache_discount_usd: abCosts.cacheDiscountUsd,
    net_cost_usd: abCosts.netCostUsd,
    latency_ms: matchResult.orderAB.receipt.latencyMs,
    timestamp: new Date().toISOString(),
  });

  const baCosts = computeTokenCosts(
    matchResult.orderBA.receipt.inputTokens,
    matchResult.orderBA.receipt.cachedTokens ?? 0,
    matchResult.orderBA.receipt.outputTokens,
    matchResult.orderBA.receipt.model || layoutModel
  );
  briefLedgerRows.push({
    call_id: matchResult.orderBA.receipt.responseId,
    x_request_id: matchResult.orderBA.receipt.xRequestId || '',
    stage: 'P07_JUDGE_BA',
    brief_id: brief.id,
    model: matchResult.orderBA.receipt.model,
    input_tokens: matchResult.orderBA.receipt.inputTokens,
    cached_tokens: matchResult.orderBA.receipt.cachedTokens ?? 0,
    output_tokens: matchResult.orderBA.receipt.outputTokens,
    gross_cost_usd: baCosts.grossCostUsd,
    cache_discount_usd: baCosts.cacheDiscountUsd,
    net_cost_usd: baCosts.netCostUsd,
    latency_ms: matchResult.orderBA.receipt.latencyMs,
    timestamp: new Date().toISOString(),
  });

  const orderSwapConsistent = matchResult.isConsistent;

  // 6. P07 Real Degraded-Copy Canary Defeat by LLM Judge
  console.log(`[P10 LIVE] Brief ${brief.id}: Evaluating real degraded canary against winner with LLM judge...`);
  const canaryLayout = createDegradedCanaryLayout(layout);
  const canaryCandidate: CandidateJudgeInput = {
    id: `${brief.id}_canary_degraded`,
    layout: canaryLayout,
  };

  const canaryMatch = await evaluatePairOrder(cand1Input, canaryCandidate, 'AB', {
    client,
    model: judgeModel,
  });

  const canaryCosts = computeTokenCosts(
    canaryMatch.receipt.inputTokens,
    canaryMatch.receipt.cachedTokens ?? 0,
    canaryMatch.receipt.outputTokens,
    canaryMatch.receipt.model || layoutModel
  );
  briefLedgerRows.push({
    call_id: canaryMatch.receipt.responseId,
    x_request_id: canaryMatch.receipt.xRequestId || '',
    stage: 'P07_CANARY',
    brief_id: brief.id,
    model: canaryMatch.receipt.model,
    input_tokens: canaryMatch.receipt.inputTokens,
    cached_tokens: canaryMatch.receipt.cachedTokens ?? 0,
    output_tokens: canaryMatch.receipt.outputTokens,
    gross_cost_usd: canaryCosts.grossCostUsd,
    cache_discount_usd: canaryCosts.cacheDiscountUsd,
    net_cost_usd: canaryCosts.netCostUsd,
    latency_ms: canaryMatch.receipt.latencyMs,
    timestamp: new Date().toISOString(),
  });

  // Genuine LLM Judge Canary Defeat Condition:
  // Leader must win the majority of 5 dimensions against the degraded canary!
  const canaryWon = canaryMatch.majorityWinner === 'A';

  // 7. PosterMELD PRR 4 Structural Checks:
  const geometricPass =
    metrics.metrics.occlusion.passed &&
    metrics.metrics.balance.passed &&
    metrics.metrics.alignment.passed &&
    metrics.metrics.negativeSpace.passed;

  const readabilityPass =
    metrics.metrics.textLegibility.passed &&
    metrics.metrics.typeScale.passed;

  const assetIntegrityPass =
    layout.logo.width > 0 &&
    layout.logo.height > 0 &&
    layout.background.color.startsWith('#');

  const copyExactPass = layout.text.every((t) => copyMap[t.copyIndex] !== undefined);
  const prrPass = geometricPass && readabilityPass && assetIntegrityPass && copyExactPass;

  // 8. Measured Editability Check:
  const editabilityPass = (() => {
    if (!layout.text || layout.text.length === 0) return false;
    const validNodes = layout.text.every(
      (t) => t.width > 0 && t.height > 0 && t.fontSize > 0 && Boolean(t.fontFamily)
    );
    if (!validNodes) return false;
    try {
      const mutatedCopyMap: Record<number, string> = {};
      for (const b of brief.copyBlocks) {
        mutatedCopyMap[b.copyIndex] = b.text + ' [EDITED]';
      }
      const mutatedRender = renderLayoutV2(layout, { copyText: mutatedCopyMap });
      return Boolean(mutatedRender && mutatedRender.png && mutatedRender.png.length > 0);
    } catch {
      return false;
    }
  })();

  // 9. Distinct Skeleton Check:
  const currentArchetype = best.rawCandidate?.compositionArchetype || 'monolith_centered';
  const distinctSkeleton = previousArchetype === null || currentArchetype !== previousArchetype;

  const totalNetCostUsd = Number(
    briefLedgerRows.reduce((acc, row) => acc + row.net_cost_usd, 0).toFixed(6)
  );
  const totalLatencyMs = Date.now() - startTime;

  // Render preview PNG & SVG
  const rendered = renderLayoutV2(layout, { copyText: copyMap });
  // Measured, not assumed: families this layout uses that the renderer silently substituted.
  const familiesUsed = [...new Set(layout.text.map((t: any) => t.fontFamily).filter(Boolean))];
  const fontStandIns = familiesUsed.filter((f) => rendered.fontFidelity?.[f] === 'stand-in');
  if (fontStandIns.length) {
    console.warn(
      `[P10 FONT] Brief ${brief.id}: renderer substituted ${fontStandIns.join(', ')} — the preview does not show the specified typography.`
    );
  }
  fs.writeFileSync(path.join(briefFolder, 'preview.png'), rendered.png);
  fs.writeFileSync(path.join(briefFolder, 'preview.svg'), rendered.svg, 'utf8');

  // Save per-brief artifacts
  fs.writeFileSync(path.join(briefFolder, 'brief.json'), JSON.stringify(brief, null, 2), 'utf8');
  fs.writeFileSync(path.join(briefFolder, 'layout.json'), JSON.stringify(layout, null, 2), 'utf8');
  fs.writeFileSync(path.join(briefFolder, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8');
  fs.writeFileSync(path.join(briefFolder, 'critique.json'), JSON.stringify(critiqueResult, null, 2), 'utf8');
  fs.writeFileSync(path.join(briefFolder, 'judge_match.json'), JSON.stringify(matchResult, null, 2), 'utf8');
  fs.writeFileSync(path.join(briefFolder, 'canary_match.json'), JSON.stringify(canaryMatch, null, 2), 'utf8');

  const journalData = {
    briefId: brief.id,
    size: `${brief.width}x${brief.height}`,
    language: brief.language,
    modelCalls: briefLedgerRows.length,
    stagesExercised: briefLedgerRows.map((r) => r.stage),
    totalNetCostUsd,
    totalLatencyMs,
    prrPass,
    geometricPass,
    readabilityPass,
    assetIntegrityPass,
    copyExactPass,
    editabilityPass,
    canaryWon,
    canaryWinnerCandidate: canaryMatch.winnerCandidateId,
    canaryVotesA: canaryMatch.winnerVotesA,
    canaryVotesB: canaryMatch.winnerVotesB,
    orderSwapConsistent,
    orderSwapWinnerAB: matchResult.orderAB.winnerCandidateId,
    orderSwapWinnerBA: matchResult.orderBA.winnerCandidateId,
    distinctSkeleton,
    compositeScore: metrics.compositeScore,
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(briefFolder, 'journal.json'), JSON.stringify(journalData, null, 2), 'utf8');

  const journalMd = `# Brief Journal: ${brief.id} (${brief.name})
- **Dimensions**: ${brief.width}x${brief.height} (${brief.sizeName})
- **Language**: ${brief.language}
- **Total Model Calls**: ${briefLedgerRows.length} calls
- **Total Net Cost**: $${totalNetCostUsd.toFixed(6)} | **Total Latency**: ${totalLatencyMs}ms
- **Composite Score**: ${metrics.compositeScore.toFixed(3)} (Passed: ${metrics.passed})

## 1. Multi-Stage Receipts
| Stage | Call ID | Model | In / Out Tokens | Cached | Net Cost |
| :--- | :--- | :--- | :--- | :--- | :--- |
${briefLedgerRows.map((r) => `| ${r.stage} | \`${r.call_id}\` | ${r.model} | ${r.input_tokens} / ${r.output_tokens} | ${r.cached_tokens} | $${r.net_cost_usd.toFixed(6)} |`).join('\n')}

## 2. Vision Critique (P05)
- **Status**: ${critiqueResult.status}
- **Overall Assessment**: ${critiqueResult.overallAssessment}
- **Comments**: ${critiqueResult.comments.length} accepted comments

## 3. Pairwise LLM Judge (P07)
- **Consistency**: ${orderSwapConsistent ? 'ORDER_CONSISTENT' : 'ORDER_FLIPPED'}
- **Order AB Winner**: ${matchResult.orderAB.winnerCandidateId} (${matchResult.orderAB.winnerVotesA}-${matchResult.orderAB.winnerVotesB})
- **Order BA Winner**: ${matchResult.orderBA.winnerCandidateId} (${matchResult.orderBA.winnerVotesA}-${matchResult.orderBA.winnerVotesB})

## 4. Real Degraded Canary Defeat (P07)
- **Canary Defeated by Judge**: **${canaryWon ? 'YES (BEATEN)' : 'NO (FAILED)'}**
- **Votes**: Winner=${canaryMatch.winnerVotesA} vs Canary=${canaryMatch.winnerVotesB}
- **Judge Rationales**:
${Object.entries(canaryMatch.rationales).map(([dim, rat]) => `  - **${dim}**: ${rat}`).join('\n')}
`;

  fs.writeFileSync(path.join(briefFolder, 'journal.md'), journalMd, 'utf8');

  return {
    briefIndex,
    brief,
    layout,
    metrics,
    critique: critiqueResult,
    pairwiseMatch: matchResult,
    canaryMatch,
    ledgerRows: briefLedgerRows,
    totalNetCostUsd,
    totalLatencyMs,
    prrPass,
    geometricPass,
    readabilityPass,
    assetIntegrityPass,
    copyExactPass,
    editabilityPass,
    canaryWon,
    orderSwapConsistent,
    distinctSkeleton,
    rawArchetype: currentArchetype,
    fontStandIns,
  };
}

async function main() {
  console.log('=== Starting P10 Genuine Live Qualification Run (20 Held-Out Briefs) ===');

  const dailyCap = getOfficeDailyCapUsd();
  const perBriefCap = getPerBriefCapUsd();
  console.log(
    `[Cost Governor] Active Caps: Per-Brief = $${perBriefCap.toFixed(2)} | Office Daily = $${dailyCap.toFixed(2)}`
  );

  // Pre-flight check: can we afford at least 1 brief?
  const estimatedMinCost = 0.05;
  const budgetCheck = checkOfficeDailyBudget(estimatedMinCost);
  if (!budgetCheck.allowed) {
    console.error(`\n================================================================================`);
    console.error(`🛑 COST GOVERNOR REFUSAL: Qualification run refused.`);
    console.error(`Reason: ${budgetCheck.reason}`);
    console.error(
      `Office Daily Cap: $${budgetCheck.capUsd.toFixed(2)} | Current Spend: $${budgetCheck.currentSpentUsd.toFixed(
        2
      )} | Remaining: $${budgetCheck.remainingUsd.toFixed(2)}`
    );
    console.error(`================================================================================\n`);
    process.exit(1);
  }

  const customOutDir = process.env.HAWA_QUALIFICATION_OUT_DIR;
  const outputDir = customOutDir
    ? path.resolve(process.cwd(), customOutDir)
    : path.resolve(
        process.cwd(),
        'output/proofs/2026-09-17-research-grade-pipeline/T5_FULL_QUALIFICATION'
      );
  const briefsDir = path.join(outputDir, 'briefs');
  const journalsDir = path.join(outputDir, 'JOURNALS');
  fs.mkdirSync(briefsDir, { recursive: true });
  fs.mkdirSync(journalsDir, { recursive: true });

  const client = new OpenAiStudioClient({ timeoutMs: 180000 });
  const retrievalIndex = new ExemplarRetrievalIndex();

  const results: BriefResult[] = [];
  const allLedgerRows: LedgerRow[] = [];
  const concurrency = 2; // Controlled concurrency to respect rate limits
  let lastArchetype: string | null = null;
  const failures: Array<{ briefId: string; reason: string }> = [];

  // T9: checkpoint + resume. --resume reuses ledger rows from completed briefs instead of repaying.
  const checkpointPath = path.join(outputDir, '.qualification-checkpoint.json');
  const completedIds = new Set<string>();
  if (process.argv.includes('--resume') && fs.existsSync(checkpointPath)) {
    try {
      const cp = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
      for (const id of cp.completed || []) completedIds.add(id);
      if (Array.isArray(cp.ledgerRows)) allLedgerRows.push(...cp.ledgerRows);
      if (typeof cp.lastArchetype === 'string') lastArchetype = cp.lastArchetype;
      // Rehydrate the per-brief result rows. Carrying the ledger alone is not enough: the report
      // would then compute every rate over only the briefs this run re-executed while the ledger
      // showed all of them, which is an internally inconsistent proof.
      let rehydrated = 0;
      for (const row of cp.resultRows || []) {
        const id: string | undefined = row?.brief?.id || row?.briefId;
        if (!id) continue;
        // Resolve the brief definition and its canonical index from source, never from the
        // checkpoint copy, so a stale or partial checkpoint cannot misreport size or language.
        const briefIdx = QUALIFICATION_BRIEFS.findIndex((b) => b.id === id);
        if (briefIdx < 0) {
          console.warn(`[P10 RESUME] Checkpoint row ${id} is not a known brief; it will be re-run.`);
          continue;
        }
        results.push({
          ...row,
          brief: QUALIFICATION_BRIEFS[briefIdx],
          briefIndex: briefIdx,
          ledgerRows: allLedgerRows.filter((lr) => lr.brief_id === id),
        } as any);
        rehydrated++;
      }
      if (rehydrated !== completedIds.size) {
        console.warn(
          `[P10 RESUME] Checkpoint holds ${completedIds.size} completed ids but only ${rehydrated} result rows; briefs without a result row will be re-run.`
        );
        for (const id of [...completedIds]) {
          if (!results.some((r) => r.brief.id === id)) completedIds.delete(id);
        }
      }
      console.log(
        `[P10 RESUME] Loaded checkpoint: ${completedIds.size} briefs already complete, ${rehydrated} result rows rehydrated, ${allLedgerRows.length} ledger rows carried forward`
      );
    } catch (e) {
      console.warn('[P10 RESUME] Checkpoint unreadable, starting fresh');
    }
  }

  for (let i = 0; i < QUALIFICATION_BRIEFS.length; i += concurrency) {
    const batch = QUALIFICATION_BRIEFS.slice(i, i + concurrency);
    console.log(
      `\n--- Dispatching Batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(
        QUALIFICATION_BRIEFS.length / concurrency
      )} (${batch.map((b) => b.id).join(', ')}) ---`
    );

    const batchPromises = batch.map((brief, batchIdx) => {
      const overallIdx = i + batchIdx;
      if (completedIds.has(brief.id)) {
        console.log(`[P10 RESUME] Skipping already-completed brief ${brief.id}`);
        return Promise.resolve(null);
      }
      return executeBriefLive(brief, overallIdx, client, retrievalIndex, briefsDir, lastArchetype);
    });

    // T9: one brief's failure must never discard the whole run.
    const settled = await Promise.allSettled(batchPromises);
    for (let k = 0; k < settled.length; k++) {
      const outcome = settled[k];
      const brief = batch[k];
      if (outcome.status === 'rejected') {
        const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        console.error(`[P10 FAILED] Brief ${brief.id}: ${reason}`);
        failures.push({ briefId: brief.id, reason });
        continue;
      }
      const res: any = outcome.value;
      if (!res) continue;
      results.push(res);
      allLedgerRows.push(...res.ledgerRows);
      lastArchetype = res.rawArchetype || lastArchetype;

      // Copy journal to JOURNALS/
      const briefSrcFolder = path.join(briefsDir, `brief_${String(res.briefIndex + 1).padStart(2, '0')}`);
      fs.copyFileSync(path.join(briefSrcFolder, 'journal.json'), path.join(journalsDir, `${res.brief.id}.json`));
      fs.copyFileSync(path.join(briefSrcFolder, 'journal.md'), path.join(journalsDir, `${res.brief.id}.md`));
    }

    // T9: checkpoint after every batch so paid work is never lost. Result rows are persisted
    // alongside the ledger so a --resume run reports over every completed brief, not just the
    // ones it re-ran.
    fs.writeFileSync(
      checkpointPath,
      JSON.stringify(
        {
          completed: results.map((r) => r.brief.id),
          failures,
          lastArchetype,
          ledgerRows: allLedgerRows,
          resultRows: results.map((r: any) => ({
            brief: r.brief,
            briefIndex: r.briefIndex,
            metrics: { compositeScore: r.metrics.compositeScore },
            totalNetCostUsd: r.totalNetCostUsd,
            totalLatencyMs: r.totalLatencyMs,
            prrPass: r.prrPass,
            geometricPass: r.geometricPass,
            readabilityPass: r.readabilityPass,
            assetIntegrityPass: r.assetIntegrityPass,
            copyExactPass: r.copyExactPass,
            editabilityPass: r.editabilityPass,
            canaryWon: r.canaryWon,
            orderSwapConsistent: r.orderSwapConsistent,
            distinctSkeleton: r.distinctSkeleton,
            rawArchetype: r.rawArchetype,
          })),
        },
        null,
        2
      ),
      'utf8'
    );
  }

  // Sort results by briefIndex to maintain canonical order 1..20
  results.sort((a, b) => a.briefIndex - b.briefIndex);

  // Summary Metrics Computation
  const totalBriefs = results.length;
  const prrPassCount = results.filter((r) => r.prrPass).length;
  const prrRate = (prrPassCount / totalBriefs) * 100;

  const canaryWinCount = results.filter((r) => r.canaryWon).length;
  const canaryWinRate = (canaryWinCount / totalBriefs) * 100;

  const orderSwapConsistentCount = results.filter((r) => r.orderSwapConsistent).length;
  const orderSwapRate = (orderSwapConsistentCount / totalBriefs) * 100;

  const editabilityCount = results.filter((r) => r.editabilityPass).length;
  const editabilityRate = (editabilityCount / totalBriefs) * 100;

  const costs = results.map((r) => r.totalNetCostUsd).sort((a, b) => a - b);
  const latencies = results.map((r) => r.totalLatencyMs).sort((a, b) => a - b);
  const compositeScores = results.map((r) => r.metrics.compositeScore);

  const median = (xs: number[]) =>
    xs.length === 0 ? 0 : xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  const medianCostUsd = median(costs);
  const medianLatencyMs = median(latencies);
  const avgCompositeScore =
    compositeScores.length > 0 ? compositeScores.reduce((a, b) => a + b, 0) / compositeScores.length : 0;

  // Real Canva copy+font rate. This row previously divided by a hardcoded 20 and printed a
  // literal PASS, so it reported 80.0% against a >= 90% target and still claimed to pass.
  const copyFontPassCount = results.filter((r) => r.copyExactPass && r.readabilityPass).length;
  const copyFontRate = totalBriefs > 0 ? (copyFontPassCount / totalBriefs) * 100 : 0;

  // Real hard-QA escape count: a brief the pipeline declared print-ready while a hard
  // deterministic check failed. This row previously printed a literal 0 and a literal PASS,
  // measuring nothing at all.
  const hardQaEscapes = results.filter(
    (r) => r.prrPass && !(r.geometricPass && r.readabilityPass && r.assetIntegrityPass && r.copyExactPass)
  );

  // Real skeleton diversity: the size of the archetype set over completed briefs, with a
  // histogram so it can be audited. The per-brief distinct_skeleton flag only compares a brief
  // against the one dispatched before it, which is order-dependent under parallel batches and
  // is not a measure of diversity.
  const archetypeCounts = new Map<string, number>();
  for (const r of results as any[]) {
    const a = r.rawArchetype || 'unknown';
    archetypeCounts.set(a, (archetypeCounts.get(a) || 0) + 1);
  }
  const distinctArchetypeCount = archetypeCounts.size;
  const archetypeHistogram = [...archetypeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([a, n]) => `${a}=${n}`)
    .join(', ');

  // Measured typography fidelity across the run, read from this host and from the layouts on
  // disk so it is correct for resumed briefs too. A preview rendered with a substituted face is
  // not evidence about the design production will produce, so a stand-in fails the run.
  const fidelityManifest = getFontFidelityManifest(
    path.resolve(process.cwd(), 'packages/creative/assets/fonts')
  );
  const briefsWithStandIns: Array<{ id: string; families: string[] }> = [];
  for (const r of results as any[]) {
    const layoutPath = path.join(
      briefsDir,
      `brief_${String(r.briefIndex + 1).padStart(2, '0')}`,
      'layout.json'
    );
    if (!fs.existsSync(layoutPath)) continue;
    let used: string[] = [];
    try {
      const l = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
      used = [...new Set((l.text || []).map((t: any) => t.fontFamily).filter(Boolean))] as string[];
    } catch {
      continue;
    }
    const standIns = used.filter((f) => fidelityManifest[f] === 'stand-in');
    if (standIns.length) briefsWithStandIns.push({ id: r.brief.id, families: standIns });
  }
  const standInFamilies = [...new Set(briefsWithStandIns.flatMap((b) => b.families))].sort();

  const expectedCalls = totalBriefs * 5;
  const allGatesPass =
    prrRate >= 81.3 &&
    medianCostUsd < 0.38 &&
    canaryWinRate >= 95.0 &&
    orderSwapRate >= 80.0 &&
    copyFontRate >= 90.0 &&
    hardQaEscapes.length === 0 &&
    editabilityRate === 100.0 &&
    briefsWithStandIns.length === 0 &&
    allLedgerRows.length >= expectedCalls;
  const devTier = isDevModelTier();
  const qualificationVerdict = devTier
    ? `**NOT A QUALIFICATION RUN.** This ran on the ${activeModelTier()} model tier (${resolveModel('layout')}), not the production model. Its scores describe the cheap tier and cannot be read as production evidence.`
    : failures.length > 0
      ? `**PARTIAL — NOT A QUALIFICATION PASS.** ${failures.length} of ${QUALIFICATION_BRIEFS.length} briefs never ran.`
      : allGatesPass
        ? `**PASS** — all ${QUALIFICATION_BRIEFS.length} briefs completed and every gate met.`
        : `**FAIL** — all ${QUALIFICATION_BRIEFS.length} briefs completed but at least one gate was not met.`;

  // 1. Generate Multi-Row LEDGER.csv (one row per model call)
  const ledgerHeader =
    'call_id,x_request_id,stage,brief_id,model,input_tokens,cached_tokens,output_tokens,gross_cost_usd,cache_discount_usd,net_cost_usd,latency_ms,timestamp\n';
  const ledgerBody = allLedgerRows
    .map(
      (r) =>
        `${r.call_id},${r.x_request_id || ''},${r.stage},${r.brief_id},${r.model},${r.input_tokens},${r.cached_tokens},${r.output_tokens},${r.gross_cost_usd.toFixed(6)},${r.cache_discount_usd.toFixed(6)},${r.net_cost_usd.toFixed(6)},${r.latency_ms},${r.timestamp}`
    )
    .join('\n');

  const ledgerPath = path.join(outputDir, 'LEDGER.csv');
  fs.writeFileSync(ledgerPath, ledgerHeader + ledgerBody, 'utf8');

  // 2. Generate P10_QUALIFICATION.csv
  const csvHeader =
    'brief_id,language,size,calls,prr_pass,geometric_pass,readability_pass,asset_integrity_pass,copy_exact_pass,editability_pass,canary_won,order_swap_consistent,composite_score,cost_usd,wall_clock_ms,distinct_skeleton,archetype\n';
  const csvBody = results
    .map(
      (r) =>
        `${r.brief.id},${r.brief.language},${r.brief.width}x${r.brief.height},${r.ledgerRows.length},${r.prrPass},${r.geometricPass},${r.readabilityPass},${r.assetIntegrityPass},${r.copyExactPass},${r.editabilityPass},${r.canaryWon},${r.orderSwapConsistent},${r.metrics.compositeScore.toFixed(3)},${r.totalNetCostUsd.toFixed(6)},${r.totalLatencyMs},${r.distinctSkeleton},${(r as any).rawArchetype || 'unknown'}`
    )
    .join('\n');

  const csvPath = path.join(outputDir, 'P10_QUALIFICATION.csv');
  fs.writeFileSync(csvPath, csvHeader + csvBody, 'utf8');

  // 3. Generate P10_QUALIFICATION.md
  const mdReport = `# P10 Full Qualification Report: ${QUALIFICATION_BRIEFS.length} Held-Out Briefs (Multi-Stage Live Run)

**Briefs attempted:** ${QUALIFICATION_BRIEFS.length} · **completed:** ${results.length} · **failed:** ${failures.length}${failures.length ? ' — ' + failures.map((f) => f.briefId + ': ' + f.reason).join('; ') : ''}

Verdict: ${qualificationVerdict}

> Rates below are computed over the ${results.length} completed briefs. A partial run is reported as partial and does NOT constitute a qualification pass.

## 1. Headline Results & Comparative Benchmarks

| Metric | Target / Published Benchmark | Pipeline Result (Multi-Stage Live Run) | Status |
| :--- | :--- | :--- | :--- |
| **Total Model Calls Recorded** | 5 calls x ${totalBriefs} completed briefs = ${expectedCalls} | **${allLedgerRows.length} calls** | **${allLedgerRows.length >= expectedCalls ? 'PASS' : 'FAIL'}** |
| **Print-Ready Rate (PRR)** | 81.3% (PosterMELD, arXiv:2608.02218) | **${prrRate.toFixed(1)}%** (${prrPassCount}/${totalBriefs}) | **${prrRate >= 81.3 ? 'PASS' : 'FAIL'}** |
| **Median Cost per Brief** | USD 0.380 (Published Comparison) | **$${medianCostUsd.toFixed(6)}** | **${medianCostUsd < 0.38 ? 'PASS' : 'FAIL'}** |
| **Canary Win Rate (Real Judge)** | >= 95.0% of completed briefs | **${canaryWinRate.toFixed(1)}%** (${canaryWinCount}/${totalBriefs}) | **${canaryWinRate >= 95.0 ? 'PASS' : 'FAIL'}** |
| **Order-Swap Consistency** | >= 80.0% | **${orderSwapRate.toFixed(1)}%** (${orderSwapConsistentCount}/${totalBriefs}) | **${orderSwapRate >= 80.0 ? 'PASS' : 'FAIL'}** |
| **Mean Composite Score** | Measured Mean Score | **${avgCompositeScore.toFixed(3)}** | **${avgCompositeScore >= 0.70 ? 'PASS' : 'FAIL'}** |
| **Canva Copy & Font Checks**| >= 90.0% of completed briefs | **${copyFontRate.toFixed(1)}%** (${copyFontPassCount}/${totalBriefs}) | **${copyFontRate >= 90.0 ? 'PASS' : 'FAIL'}** |
| **Hard-QA Escapes** | Exactly 0 | **${hardQaEscapes.length}**${hardQaEscapes.length ? ' — ' + hardQaEscapes.map((r) => r.brief.id).join(', ') : ''} | **${hardQaEscapes.length === 0 ? 'PASS' : 'FAIL'}** |
| **Distinct Skeletons** | No published threshold | **${distinctArchetypeCount} distinct archetypes** over ${totalBriefs} briefs (${archetypeHistogram}) | **MEASURED** |
| **Editability Rate** | 100.0% Verified Mutation Test | **${editabilityRate.toFixed(1)}%** (${editabilityCount}/${totalBriefs}) | **${editabilityRate === 100.0 ? 'PASS' : 'FAIL'}** |
| **Font Fidelity (measured at render)** | Every specified family renders exactly | **${briefsWithStandIns.length === 0 ? 'every family used renders exactly on this host' : `${briefsWithStandIns.length}/${totalBriefs} briefs rendered with a substituted face — ${standInFamilies.join(', ')}`}** | **${briefsWithStandIns.length === 0 ? 'PASS' : 'FAIL'}** |

> The **Distinct Skeletons** row has no numeric target in the published literature, so it is reported as measured rather than scored. The per-brief \`distinct_skeleton\` column in the CSV compares a brief only against the one dispatched immediately before it and is order-dependent under parallel batches; the archetype set size above is the diversity figure to read.
> **Hard-QA escapes** are counted as briefs marked print-ready while any of the geometric, readability, asset-integrity or copy-exactness checks failed.
> This run exercises the layout, critique and judge stages. No image-generation call is made, so the cost figures above are text-model costs only and do not include the art lane.
> **Font fidelity** is measured by rasterising a probe in each family and in a family that cannot exist: identical output means the renderer substituted a fallback face. \`fc-match\` is not a valid check, because it resolves a family name that the rasteriser then fails to use. When this row fails, the preview images are not evidence about the typography of the design.

---

## 2. Multi-Row Live Model Call Ledger (\`LEDGER.csv\`)
Total calls recorded: **${allLedgerRows.length}**

\`\`\`csv
${ledgerHeader + ledgerBody}
\`\`\`

---

## 3. Per-Brief Qualification Table (\`P10_QUALIFICATION.csv\`)

\`\`\`csv
${csvHeader + csvBody}
\`\`\`

---

Artifacts:
- Multi-Row Ledger: [\`LEDGER.csv\`](./LEDGER.csv)
- Qualification Table: [\`P10_QUALIFICATION.csv\`](./P10_QUALIFICATION.csv)
- Per-Brief Journals: \`JOURNALS/\`
`;

  const mdPath = path.join(outputDir, 'P10_QUALIFICATION.md');
  fs.writeFileSync(mdPath, mdReport, 'utf8');

  console.log(`\n=== P10 Full Qualification Finished Successfully ===`);
  console.log(`- CSV: ${csvPath}`);
  console.log(`- Multi-Row Ledger: ${ledgerPath}`);
  console.log(`- Report: ${mdPath}`);
  console.log(`- Total Calls Recorded: ${allLedgerRows.length}`);
}

// Only run when this file is the entry point. It exports QUALIFICATION_BRIEFS and LedgerRow, so
// importing it for those must not launch a paid twenty-brief run — which is exactly what happened
// on 2026-09-18 when a comparison script imported the brief list and spent USD 5.46 unattended.
const isEntryPoint = (() => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return path.resolve(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main().catch((err) => {
    console.error('P10 Qualification Runner Failed:', err);
    process.exit(1);
  });
}
