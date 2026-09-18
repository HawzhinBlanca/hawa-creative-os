import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveModel, isDevModelTier, activeModelTier } from '../packages/domain/dist/provider-policy.js';

// Prices come from the compiled package the runner imports its code from. Reading src/ instead
// meant that in the image — where only dist/ is mounted — the runner priced from the image's
// stale copy, which had no dev-tier models: every brief paid for its layout call, then failed.
const PRICING = createRequire(import.meta.url)('../packages/creative/dist/studio/pricing.json') as {
  models: Record<string, { inputPerMillion?: number; outputPerMillion?: number; cacheReadPerMillion?: number }>;
};
import {
  OpenAiStudioClient,
  ExemplarRetrievalIndex,
  generateLayoutCandidatesV3,
  renderLayoutV2,
  getFontFidelityManifest,
  resolveRatesForModel,
  retrieveExemplarsV3,
  prepareGeneratedLayoutV3,
  rankCandidatesV3,
  critiqueCandidateV3,
  refineCandidateV3,
  selectWinnerV3,
  evaluateHardQa,
  studioReferenceFromRaw,
  recordOfficeDailySpend,
  type StudioLayoutV2,
  type DesignMetricsReport,
  type BoxCritiqueResult,
  type PairwiseMatchResult,
  type CopyBlockSlotInput,
  type PipelineV3Copy,
  type HardQaContext,
  type RefinementOutcomeV3,
  type WinnerSelectionV3,
  checkOfficeDailyBudget,
  getOfficeDailyCapUsd,
  getPerBriefCapUsd,
} from '../packages/creative/dist/index.js';

export interface QualificationBrief {
  id: string;
  name: string;
  language: 'en' | 'ckb' | 'mixed';
  width: number;
  height: number;
  sizeName: string;
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
  stage:
    | 'P03_LAYOUT'
    | 'P05_CRITIQUE'
    | 'P06_REFINE_CRITIQUE'
    | 'P06_REFINE'
    | 'P07_JUDGE_AB'
    | 'P07_JUDGE_BA'
    | 'P07_CANARY_AB'
    | 'P07_CANARY_BA';
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
  canaryMatch: WinnerSelectionV3['canary'];
  ledgerRows: LedgerRow[];
  totalNetCostUsd: number;
  totalLatencyMs: number;
  prrPass: boolean;
  geometricPass: boolean;
  readabilityPass: boolean;
  assetIntegrityPass: boolean;
  copyExactPass: boolean;
  editabilityPass: boolean;
  /** Production's hard QA on the delivered design — whether production would ship it. */
  hardQaPassed: boolean;
  hardQaDefects: string[];
  decidedBy: WinnerSelectionV3['decidedBy'];
  judgeReliable: boolean | null;
  canaryWon: boolean;
  orderSwapConsistent: boolean;
  distinctSkeleton: boolean;
  rawArchetype: string;
  fontStandIns: string[];
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

/**
 * Which briefs a run designs. The 20 held-out qualification briefs by default; with
 * HAWA_QUALIFICATION_BRIEF_SET=compare, the ten compare briefs the owner's v1 baselines were made
 * from, so the T8 blind test can pair each v1 design with a v3 design of the same brief.
 */
function loadBriefSet(): { set: 'qualification' | 'compare'; briefs: QualificationBrief[] } {
  const set = process.env.HAWA_QUALIFICATION_BRIEF_SET || 'qualification';
  if (set === 'qualification') return { set, briefs: QUALIFICATION_BRIEFS };
  if (set !== 'compare') throw new Error(`HAWA_QUALIFICATION_BRIEF_SET must be 'qualification' or 'compare', not '${set}'.`);
  const dir = new URL('../packages/evals/src/design-studio/briefs/', import.meta.url);
  const briefs = fs
    .readdirSync(dir)
    .filter((f) => /^compare-\d+\.json$/.test(f))
    .sort()
    .map((f) => {
      const b = JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'));
      return {
        id: b.id,
        name: b.name,
        language: b.language,
        width: b.width,
        height: b.height,
        sizeName: `${b.width}x${b.height}`,
        copyBlocks: b.copyBlocks.map((c: any) => ({ copyIndex: c.copyIndex, text: c.text, role: c.role, script: c.script })),
      } as QualificationBrief;
    });
  if (briefs.length !== 10) throw new Error(`Expected the 10 compare briefs, found ${briefs.length}.`);
  return { set, briefs };
}

/** The client's reference pack, read exactly as production's studio reads it. */
const KAAE_REFERENCE = studioReferenceFromRaw(
  JSON.parse(fs.readFileSync(new URL('../packages/creative/assets/kaae-reference.json', import.meta.url), 'utf8'))
);

/** The official logo's width over height, from its PNG header, as the studio computes it. */
const KAAE_LOGO_ASPECT = (() => {
  const png = fs.readFileSync(new URL('../packages/creative/assets/logos/kaae-official-logo.png', import.meta.url));
  return png.readUInt32BE(16) / (png.readUInt32BE(20) || 1);
})();

/**
 * Wraps the client so every model call lands in the ledger as it completes — including calls made
 * inside refinement, the judge and the canary, and calls that succeed before a later one throws.
 * Recording per stage at the call sites missed those, and the refinement receipt merged two calls
 * with no token counts.
 */
function recordingClient(
  client: OpenAiStudioClient,
  briefId: string,
  fallbackModel: string,
  phase: () => 'P05' | 'P06' | 'P07',
  record: (row: LedgerRow) => void
): OpenAiStudioClient {
  const judgeStages: LedgerRow['stage'][] = ['P07_JUDGE_AB', 'P07_JUDGE_BA', 'P07_CANARY_AB', 'P07_CANARY_BA'];
  let judgeCalls = 0;
  const stageFor = (schema: string | undefined): LedgerRow['stage'] => {
    if (schema === 'layout_v3_candidates') return 'P03_LAYOUT';
    if (schema === 'layout_v3_repair') return 'P06_REFINE';
    if (schema === 'DesignCritiqueReport') return phase() === 'P05' ? 'P05_CRITIQUE' : 'P06_REFINE_CRITIQUE';
    if (schema === 'PairwiseDimensionVerdict') return judgeStages[Math.min(judgeCalls++, judgeStages.length - 1)];
    throw new Error(`Unrecorded model call with schema '${schema}': add it to the ledger before spending on it.`);
  };
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'createStructuredCompletion') {
        return async (params: any) => {
          const stage = stageFor(params?.jsonSchema?.name);
          const res = await target.createStructuredCompletion(params);
          const r = res.receipt;
          const requested = params?.model || fallbackModel;
          let model = r.model || requested;
          let costs;
          try {
            costs = computeTokenCosts(r.inputTokens, r.cacheReadTokens ?? 0, r.outputTokens, model);
          } catch {
            // The call is already paid for, so it must reach the ledger. The requested model was
            // checked against the price table before any spend; price the call at its rates.
            console.warn(`[P10 LEDGER] No price for echoed model '${model}'; recording at '${requested}' rates.`);
            model = requested;
            costs = computeTokenCosts(r.inputTokens, r.cacheReadTokens ?? 0, r.outputTokens, model);
          }
          record({
            call_id: r.responseId,
            x_request_id: r.xRequestId || '',
            stage,
            brief_id: briefId,
            model,
            input_tokens: r.inputTokens,
            cached_tokens: r.cacheReadTokens ?? 0,
            output_tokens: r.outputTokens,
            gross_cost_usd: costs.grossCostUsd,
            cache_discount_usd: costs.cacheDiscountUsd,
            net_cost_usd: costs.netCostUsd,
            latency_ms: r.latencyMs,
            timestamp: new Date().toISOString(),
          });
          return res;
        };
      }
      const value = (target as any)[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * One brief through the v3 pipeline — the same shared functions production's studio calls, in
 * the same order: generate, prepare, rank with production's hard QA, critique the top candidate,
 * refine it if it fails a gate, then judge the top two with the canary. The design delivered is
 * the pipeline's winner, and production's hard QA is applied to it.
 */
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
  const briefLedgerRows: LedgerRow[] = [];
  const record = (row: LedgerRow) => {
    briefLedgerRows.push(row);
    // The office's daily cap counts real spend. It used to be fed only by tests.
    recordOfficeDailySpend(row.net_cost_usd, {
      callId: row.call_id,
      stage: row.stage,
      model: row.model,
      inputTokens: row.input_tokens,
      cachedTokens: row.cached_tokens,
      outputTokens: row.output_tokens,
      grossCostUsd: row.gross_cost_usd,
      cacheDiscountUsd: row.cache_discount_usd,
      netCostUsd: row.net_cost_usd,
      timestamp: row.timestamp,
    } as any);
  };

  // One model per stage role, so the cheap tier spends where the design is decided.
  const layoutModel = resolveModel('layout');
  const critiqueModel = resolveModel('critique');
  const judgeModel = resolveModel('judge');

  let phase: 'P05' | 'P06' | 'P07' = 'P05';
  const recording = recordingClient(client, brief.id, layoutModel, () => phase, record);

  const copy: PipelineV3Copy = { text: {}, scripts: {} };
  for (const b of brief.copyBlocks) {
    copy.text[b.copyIndex] = b.text;
    copy.scripts![b.copyIndex] = b.script;
  }
  const copyMap = copy.text;
  const isRtl = brief.language === 'ckb';
  const canvas = { width: brief.width, height: brief.height, logoAspect: KAAE_LOGO_ASPECT, palette: KAAE_REFERENCE.palette };
  const copyScripts: Array<'latin' | 'arabic'> = [];
  for (const b of brief.copyBlocks) copyScripts[b.copyIndex] = b.script;
  const qa: HardQaContext = {
    width: brief.width,
    height: brief.height,
    copyScripts,
    latinFont: KAAE_REFERENCE.latinFont,
    arabicFont: KAAE_REFERENCE.arabicFont,
    palette: KAAE_REFERENCE.palette,
    logoAspect: KAAE_LOGO_ASPECT,
  };

  console.log(`[P10 LIVE] Starting Brief ${briefIndex + 1}/20: ${brief.id} (${brief.sizeName})...`);

  // 1. P02 exemplar retrieval (free)
  const exemplars = retrieveExemplarsV3({ text: brief.name, width: brief.width, height: brief.height }, retrievalIndex);

  // 2. P03 generation: the client's own palette and the logo's real shape, as production passes them
  const slotInputs: CopyBlockSlotInput[] = brief.copyBlocks.map((b) => ({
    index: b.copyIndex,
    text: b.text,
    role: b.role,
    script: b.script,
  }));
  const genResult = await generateLayoutCandidatesV3({
    client: recording,
    brief: `${brief.name}: ${brief.copyBlocks.map((c) => c.text).join(' - ')}`,
    copyBlocks: slotInputs,
    palette: KAAE_REFERENCE.palette,
    canvasWidth: brief.width,
    canvasHeight: brief.height,
    exemplars,
    isRtl,
    logoAspect: KAAE_LOGO_ASPECT,
    model: layoutModel,
  });

  // 3. Production's preparation, then ranking with production's hard QA as a filter
  const candidates = genResult.layouts.map((layout, i) => ({
    sourceIndex: i,
    layout: prepareGeneratedLayoutV3(layout, copy, canvas),
  }));
  let ranked = rankCandidatesV3(candidates, copy, qa);

  // 4. P05 critique of the top-ranked candidate
  phase = 'P05';
  const critiqueResult = await critiqueCandidateV3(ranked[0], copy, { client: recording, model: critiqueModel });

  // 5. P06 gated refinement of the top-ranked candidate
  phase = 'P06';
  let refinement: RefinementOutcomeV3 | null = null;
  let refinementError: string | null = null;
  try {
    refinement = await refineCandidateV3(ranked[0], copy, { client: recording, model: layoutModel, canvas, qa });
    if (refinement.adopted) {
      const refinedIndex = ranked[0].sourceIndex;
      const slot = candidates.find((c) => c.sourceIndex === refinedIndex)!;
      slot.layout = refinement.layout;
      ranked = rankCandidatesV3(candidates, copy, qa);
    }
  } catch (err: any) {
    // Production keeps the unrefined candidate and records why; so does the qualification.
    refinementError = err?.message || String(err);
    console.warn(`[P10 LIVE] Brief ${brief.id}: refinement failed (${refinementError}); keeping the unrefined candidate.`);
  }

  // 6. P07 judge of the top two, with the canary
  phase = 'P07';
  const selection = await selectWinnerV3(ranked, copy, { client: recording, model: judgeModel });
  const winner = selection.winner;
  const layout = winner.layout;
  const metrics = winner.metrics;
  const hardQa = winner.hardQa ?? evaluateHardQa(layout, qa);
  const matchResult = selection.match;
  const orderSwapConsistent = matchResult ? matchResult.isConsistent : false;
  const canaryWon = selection.canary?.passed ?? false;

  // 7. PosterMELD PRR 4 structural checks, on the design the pipeline delivers
  const geometricPass =
    metrics.metrics.occlusion.passed &&
    metrics.metrics.balance.passed &&
    metrics.metrics.alignment.passed &&
    metrics.metrics.negativeSpace.passed;
  const readabilityPass = metrics.metrics.textLegibility.passed && metrics.metrics.typeScale.passed;
  const assetIntegrityPass =
    layout.logo.width > 0 && layout.logo.height > 0 && layout.background.color.startsWith('#');
  const copyExactPass = layout.text.every((t) => copyMap[t.copyIndex] !== undefined);
  const prrPass = geometricPass && readabilityPass && assetIntegrityPass && copyExactPass;

  // 8. Measured editability: the layout re-renders with every block's copy changed
  const editabilityPass = (() => {
    if (!layout.text || layout.text.length === 0) return false;
    const validNodes = layout.text.every((t) => t.width > 0 && t.height > 0 && t.fontSize > 0 && Boolean(t.fontFamily));
    if (!validNodes) return false;
    try {
      const mutatedCopyMap: Record<number, string> = {};
      for (const b of brief.copyBlocks) mutatedCopyMap[b.copyIndex] = b.text + ' [EDITED]';
      const mutatedRender = renderLayoutV2(layout, { copyText: mutatedCopyMap });
      return Boolean(mutatedRender && mutatedRender.png && mutatedRender.png.length > 0);
    } catch (err: any) {
      console.warn(`[P10 LIVE] Brief ${brief.id}: editability re-render threw (${err?.message || err}).`);
      return false;
    }
  })();

  // 9. The delivered design's archetype
  const currentArchetype = genResult.rawCandidates[winner.sourceIndex]?.compositionArchetype || 'unknown';
  const distinctSkeleton = previousArchetype === null || currentArchetype !== previousArchetype;

  const totalNetCostUsd = Number(briefLedgerRows.reduce((acc, row) => acc + row.net_cost_usd, 0).toFixed(6));
  const totalLatencyMs = Date.now() - startTime;

  const rendered = renderLayoutV2(layout, { copyText: copyMap });
  // Measured, not assumed: families this layout uses that the renderer silently substituted.
  const familiesUsed = [...new Set(layout.text.map((t: any) => t.fontFamily).filter(Boolean))] as string[];
  const fontStandIns = familiesUsed.filter((f) => rendered.fontFidelity?.[f] === 'stand-in');
  if (fontStandIns.length) {
    console.warn(
      `[P10 FONT] Brief ${brief.id}: renderer substituted ${fontStandIns.join(', ')} — the preview does not show the specified typography.`
    );
  }
  fs.writeFileSync(path.join(briefFolder, 'preview.png'), rendered.png);
  fs.writeFileSync(path.join(briefFolder, 'preview.svg'), rendered.svg, 'utf8');

  const { annotatedPng, ...critiqueRecord } = critiqueResult;
  fs.writeFileSync(path.join(briefFolder, 'critique.annotated.png'), annotatedPng);
  fs.writeFileSync(path.join(briefFolder, 'brief.json'), JSON.stringify(brief, null, 2), 'utf8');
  fs.writeFileSync(path.join(briefFolder, 'layout.json'), JSON.stringify(layout, null, 2), 'utf8');
  fs.writeFileSync(path.join(briefFolder, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8');
  fs.writeFileSync(path.join(briefFolder, 'hard_qa.json'), JSON.stringify({ passed: hardQa.passed, defectCodes: hardQa.defectCodes, metrics: hardQa.metrics }, null, 2), 'utf8');
  fs.writeFileSync(path.join(briefFolder, 'critique.json'), JSON.stringify(critiqueRecord, null, 2), 'utf8');
  fs.writeFileSync(path.join(briefFolder, 'judge_match.json'), JSON.stringify(matchResult, null, 2), 'utf8');
  fs.writeFileSync(path.join(briefFolder, 'canary_match.json'), JSON.stringify(selection.canary, null, 2), 'utf8');

  const refinementRecord = refinement
    ? {
        candidate: refinement.result.candidateId,
        gate: refinement.result.gateDecision,
        adopted: refinement.adopted,
        reason: refinement.reason,
        stopReason: refinement.result.stopReason,
        rounds: refinement.result.rounds.length,
      }
    : { error: refinementError };

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
    hardQaPassed: hardQa.passed,
    hardQaDefects: hardQa.defectCodes,
    decidedBy: selection.decidedBy,
    judgeReliable: selection.judgeReliable,
    winnerSourceIndex: winner.sourceIndex,
    canaryWon,
    orderSwapConsistent,
    orderSwapWinnerAB: matchResult?.orderAB.winnerCandidateId ?? null,
    orderSwapWinnerBA: matchResult?.orderBA.winnerCandidateId ?? null,
    refinement: refinementRecord,
    distinctSkeleton,
    archetypes: genResult.rawCandidates.map((c) => c.compositionArchetype),
    // Recorded so the degeneracy threshold can be calibrated from real runs.
    candidatePairwiseDistances: genResult.degeneracyCheck?.pairwiseDistances ?? [],
    candidateSetDegenerate: genResult.degeneracyCheck?.isDegenerate ?? null,
    compositeScore: metrics.compositeScore,
    fontStandIns,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(briefFolder, 'journal.json'), JSON.stringify(journalData, null, 2), 'utf8');

  const orderLine = (o: PairwiseMatchResult['orderAB'] | undefined) =>
    o ? `${o.winnerCandidateId} (${o.winnerVotesA}-${o.winnerVotesB})` : 'not run';
  const journalMd = `# Brief Journal: ${brief.id} (${brief.name})
- **Dimensions**: ${brief.width}x${brief.height} (${brief.sizeName})
- **Language**: ${brief.language}
- **Total Model Calls**: ${briefLedgerRows.length} calls
- **Total Net Cost**: $${totalNetCostUsd.toFixed(6)} | **Total Latency**: ${totalLatencyMs}ms
- **Composite Score**: ${metrics.compositeScore.toFixed(3)} (Passed: ${metrics.passed})
- **Production hard QA**: ${hardQa.passed ? 'PASS' : `FAIL — ${hardQa.defectCodes.join(', ')}`}
- **Winner**: candidate ${winner.sourceIndex} (${currentArchetype}), decided by ${selection.decidedBy}

## 1. Multi-Stage Receipts
| Stage | Call ID | Model | In / Out Tokens | Cached | Net Cost |
| :--- | :--- | :--- | :--- | :--- | :--- |
${briefLedgerRows.map((r) => `| ${r.stage} | \`${r.call_id}\` | ${r.model} | ${r.input_tokens} / ${r.output_tokens} | ${r.cached_tokens} | $${r.net_cost_usd.toFixed(6)} |`).join('\n')}

## 2. Vision Critique (P05)
- **Status**: ${critiqueResult.status}
- **Overall Assessment**: ${critiqueResult.overallAssessment}
- **Comments**: ${critiqueResult.comments.length} accepted comments

## 3. Refinement (P06)
- ${refinement ? `Gate ${refinement.result.gateDecision}; ${refinement.adopted ? 'adopted' : 'not adopted'} (${refinement.reason}); ${refinement.result.rounds.length} round(s)` : `Failed: ${refinementError}`}

## 4. Pairwise LLM Judge (P07)
- **Consistency**: ${orderSwapConsistent ? 'ORDER_CONSISTENT' : 'ORDER_FLIPPED'}
- **Order AB Winner**: ${orderLine(matchResult?.orderAB)}
- **Order BA Winner**: ${orderLine(matchResult?.orderBA)}

## 5. Degraded Canary, both orders (P07)
- **Canary Defeated by Judge**: **${canaryWon ? 'YES (BEATEN IN BOTH ORDERS)' : 'NO (FAILED)'}**
`;
  fs.writeFileSync(path.join(briefFolder, 'journal.md'), journalMd, 'utf8');

  return {
    briefIndex,
    brief,
    layout,
    metrics,
    critique: critiqueResult,
    pairwiseMatch: matchResult ?? undefined,
    canaryMatch: selection.canary,
    ledgerRows: briefLedgerRows,
    totalNetCostUsd,
    totalLatencyMs,
    prrPass,
    geometricPass,
    readabilityPass,
    assetIntegrityPass,
    copyExactPass,
    editabilityPass,
    hardQaPassed: hardQa.passed,
    hardQaDefects: hardQa.defectCodes,
    decidedBy: selection.decidedBy,
    judgeReliable: selection.judgeReliable,
    canaryWon,
    orderSwapConsistent,
    distinctSkeleton,
    rawArchetype: currentArchetype,
    fontStandIns,
  };
}

/**
 * A dry run points the runner at a local stand-in for the model API, so the whole flow — every
 * stage, the ledger, the report — can be exercised before any money is spent. Only a localhost
 * URL is accepted and the real key is never sent: the key is replaced, so a mistyped URL cannot
 * carry it anywhere. A dry run keeps its spend ledger apart from the office's.
 */
const DRY_RUN_URL = process.env.HAWA_QUALIFICATION_DRY_RUN_URL;
if (DRY_RUN_URL !== undefined) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(DRY_RUN_URL)) {
    throw new Error(`HAWA_QUALIFICATION_DRY_RUN_URL must be a localhost http URL, not '${DRY_RUN_URL}'.`);
  }
  if (!process.env.HAWA_SPEND_STATE_DIR) {
    throw new Error('A dry run needs HAWA_SPEND_STATE_DIR, so its pretend spend stays out of the office ledger.');
  }
}

async function main() {
  const { set: briefSet, briefs: BRIEFS } = loadBriefSet();
  console.log(`=== Starting P10 Live Run: ${BRIEFS.length} ${briefSet} briefs ===`);
  if (DRY_RUN_URL) console.log(`[P10 DRY RUN] Model calls go to ${DRY_RUN_URL}; nothing is spent and nothing here is evidence.`);

  const dailyCap = getOfficeDailyCapUsd();
  const perBriefCap = getPerBriefCapUsd();
  console.log(
    `[Cost Governor] Active Caps: Per-Brief = $${perBriefCap.toFixed(2)} | Office Daily = $${dailyCap.toFixed(2)}`
  );

  // Pre-flight: every model this run will call must have a price, checked before any spend. The
  // first cheap-tier run paid for four layout calls before discovering it could not price them.
  const unpriced = (['layout', 'critique', 'judge'] as const)
    .map((role) => resolveModel(role))
    .filter((model) => !resolveRatesForModel(PRICING.models as Record<string, any>, model)?.inputPerMillion);
  if (unpriced.length) {
    console.error(`No price for ${[...new Set(unpriced)].join(', ')} in packages/creative/dist/studio/pricing.json; refusing to spend.`);
    process.exit(1);
  }

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
  // Required: the old default was the 2026-09-17 T5 evidence folder, which a bare run overwrote.
  if (!customOutDir) {
    console.error('Set HAWA_QUALIFICATION_OUT_DIR to a fresh directory (or a checkpointed one to resume).');
    process.exit(2);
  }
  const outputDir = path.resolve(process.cwd(), customOutDir);
  const briefsDir = path.join(outputDir, 'briefs');
  const journalsDir = path.join(outputDir, 'JOURNALS');
  fs.mkdirSync(briefsDir, { recursive: true });
  // What produced this directory, for anyone — or any tool, like the T8 packager — reading it later.
  fs.writeFileSync(
    path.join(outputDir, 'RUN_MANIFEST.json'),
    JSON.stringify(
      {
        briefSet,
        briefs: BRIEFS.map((b) => b.id),
        dryRun: Boolean(DRY_RUN_URL),
        modelTier: activeModelTier(),
        models: { layout: resolveModel('layout'), critique: resolveModel('critique'), judge: resolveModel('judge') },
        startedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf8'
  );
  fs.mkdirSync(journalsDir, { recursive: true });

  const client = new OpenAiStudioClient({
    timeoutMs: 180000,
    ...(DRY_RUN_URL ? { baseUrl: DRY_RUN_URL.replace(/\/$/, ''), apiKey: 'dry-run-no-key' } : {}),
  });
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
        const briefIdx = BRIEFS.findIndex((b) => b.id === id);
        if (briefIdx < 0) {
          console.warn(`[P10 RESUME] Checkpoint row ${id} is not a known brief; it will be re-run.`);
          continue;
        }
        results.push({
          ...row,
          brief: BRIEFS[briefIdx],
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

  for (let i = 0; i < BRIEFS.length; i += concurrency) {
    const batch = BRIEFS.slice(i, i + concurrency);
    console.log(
      `\n--- Dispatching Batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(
        BRIEFS.length / concurrency
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
            hardQaPassed: r.hardQaPassed,
            hardQaDefects: r.hardQaDefects,
            decidedBy: r.decidedBy,
            judgeReliable: r.judgeReliable,
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

  // Hard-QA escapes: briefs the qualification declared print-ready that production's own hard QA
  // rejects — the designs a client would not have received. Before, this compared print-ready
  // against the four checks that define print-ready, which is always zero.
  const hardQaEscapes = results.filter((r) => r.prrPass && r.hardQaPassed === false);
  const hardQaPassCount = results.filter((r) => r.hardQaPassed === true).length;
  const hardQaPassRate = totalBriefs > 0 ? (hardQaPassCount / totalBriefs) * 100 : 0;
  const decidedByJudge = results.filter((r) => r.decidedBy === 'judge').length;

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

  // Per brief at least: layout, critique, both judge orderings and both canary orderings.
  // Refinement adds two calls a round when its gate opens.
  const expectedCalls = totalBriefs * 6;
  const allGatesPass =
    prrRate >= 81.3 &&
    medianCostUsd < 0.38 &&
    canaryWinRate >= 95.0 &&
    orderSwapRate >= 80.0 &&
    copyFontRate >= 90.0 &&
    hardQaEscapes.length === 0 &&
    hardQaPassRate === 100 &&
    editabilityRate === 100.0 &&
    briefsWithStandIns.length === 0 &&
    allLedgerRows.length >= expectedCalls;
  const devTier = isDevModelTier();
  const qualificationVerdict = briefSet === 'compare'
    ? `**T8 DESIGN RUN — NOT A QUALIFICATION RUN.** v3 designs of the ten compare briefs, for the owner's blind test. The qualification gates below do not apply to this set.${DRY_RUN_URL ? ' It was also a dry run: the designs came from a stand-in.' : ''}`
    : DRY_RUN_URL
    ? `**DRY RUN — NOT A QUALIFICATION RUN.** Every model call went to a local stand-in at ${DRY_RUN_URL}. This proves the runner's plumbing, not the pipeline's quality.`
    : devTier
    ? `**NOT A QUALIFICATION RUN.** This ran on the ${activeModelTier()} model tier (${resolveModel('layout')}), not the production model. Its scores describe the cheap tier and cannot be read as production evidence.`
    : failures.length > 0
      ? `**PARTIAL — NOT A QUALIFICATION PASS.** ${failures.length} of ${BRIEFS.length} briefs never ran.`
      : allGatesPass
        ? `**PASS** — all ${BRIEFS.length} briefs completed and every gate met.`
        : `**FAIL** — all ${BRIEFS.length} briefs completed but at least one gate was not met.`;

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
  const mdReport = `# P10 Full Qualification Report: ${BRIEFS.length} Held-Out Briefs (Multi-Stage Live Run)

**Briefs attempted:** ${BRIEFS.length} · **completed:** ${results.length} · **failed:** ${failures.length}${failures.length ? ' — ' + failures.map((f) => f.briefId + ': ' + f.reason).join('; ') : ''}

Verdict: ${qualificationVerdict}

> Rates below are computed over the ${results.length} completed briefs. A partial run is reported as partial and does NOT constitute a qualification pass.

## 1. Headline Results & Comparative Benchmarks

| Metric | Target / Published Benchmark | Pipeline Result (Multi-Stage Live Run) | Status |
| :--- | :--- | :--- | :--- |
| **Total Model Calls Recorded** | at least 6 calls x ${totalBriefs} completed briefs = ${expectedCalls} | **${allLedgerRows.length} calls** | **${allLedgerRows.length >= expectedCalls ? 'PASS' : 'FAIL'}** |
| **Print-Ready Rate (PRR)** | 81.3% (PosterMELD, arXiv:2608.02218) | **${prrRate.toFixed(1)}%** (${prrPassCount}/${totalBriefs}) | **${prrRate >= 81.3 ? 'PASS' : 'FAIL'}** |
| **Median Cost per Brief** | USD 0.380 (Published Comparison) | **$${medianCostUsd.toFixed(6)}** | **${medianCostUsd < 0.38 ? 'PASS' : 'FAIL'}** |
| **Canary Win Rate (Real Judge)** | >= 95.0% of completed briefs | **${canaryWinRate.toFixed(1)}%** (${canaryWinCount}/${totalBriefs}) | **${canaryWinRate >= 95.0 ? 'PASS' : 'FAIL'}** |
| **Order-Swap Consistency** | >= 80.0% | **${orderSwapRate.toFixed(1)}%** (${orderSwapConsistentCount}/${totalBriefs}) | **${orderSwapRate >= 80.0 ? 'PASS' : 'FAIL'}** |
| **Mean Composite Score** | Measured Mean Score | **${avgCompositeScore.toFixed(3)}** | **${avgCompositeScore >= 0.70 ? 'PASS' : 'FAIL'}** |
| **Canva Copy & Font Checks**| >= 90.0% of completed briefs | **${copyFontRate.toFixed(1)}%** (${copyFontPassCount}/${totalBriefs}) | **${copyFontRate >= 90.0 ? 'PASS' : 'FAIL'}** |
| **Hard-QA Escapes** | Exactly 0 | **${hardQaEscapes.length}**${hardQaEscapes.length ? ' — ' + hardQaEscapes.map((r) => r.brief.id).join(', ') : ''} | **${hardQaEscapes.length === 0 ? 'PASS' : 'FAIL'}** |
| **Production Hard-QA Pass Rate** | 100% of completed briefs | **${hardQaPassRate.toFixed(1)}%** (${hardQaPassCount}/${totalBriefs}) | **${hardQaPassRate === 100 ? 'PASS' : 'FAIL'}** |
| **Winners Chosen by the Judge** | Reported | ${decidedByJudge}/${totalBriefs}; the rest by composite after a tie, an unreliable judge or a single candidate | — |
| **Distinct Skeletons** | No published threshold | **${distinctArchetypeCount} distinct archetypes** over ${totalBriefs} briefs (${archetypeHistogram}) | **MEASURED** |
| **Editability Rate** | 100.0% Verified Mutation Test | **${editabilityRate.toFixed(1)}%** (${editabilityCount}/${totalBriefs}) | **${editabilityRate === 100.0 ? 'PASS' : 'FAIL'}** |
| **Font Fidelity (measured at render)** | Every specified family renders exactly | **${briefsWithStandIns.length === 0 ? 'every family used renders exactly on this host' : `${briefsWithStandIns.length}/${totalBriefs} briefs rendered with a substituted face — ${standInFamilies.join(', ')}`}** | **${briefsWithStandIns.length === 0 ? 'PASS' : 'FAIL'}** |

> The **Distinct Skeletons** row has no numeric target in the published literature, so it is reported as measured rather than scored. The per-brief \`distinct_skeleton\` column in the CSV compares a brief only against the one dispatched immediately before it and is order-dependent under parallel batches; the archetype set size above is the diversity figure to read.
> **Hard-QA escapes** are briefs this report marks print-ready that production's own hard QA (the studio's QA stage, shared code) rejects. The design measured is the pipeline's winner, produced by the same shared functions production's studio calls.
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
