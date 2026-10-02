import type { OverlayElement, PhotoElement, RecipeId, ShapeElement, StudioLayoutV2, TextElement } from '../../../src/studio/layout-v2.js';

/**
 * ADR-273: the office's own published KAAE posts, hand-annotated as StudioLayoutV2 layouts so the
 * studio's gates can be calibrated on what the office actually publishes. Measured from
 * `packages/creative/assets/exemplars/photo*.jpg` (see README.md here): each post scaled to the
 * studio canvas (864x1080 -> 1080x1350, 1080x864 -> 1350x1080, 1080x1080 unchanged) and every box
 * read off a 50px grid. The copy is placeholder copy of the same length and line count; the Sorani
 * placeholders are strings already in this repository's tests (README.md lists where), never new
 * Sorani. No client photo is copied: a photo is only a box with its treatment.
 *
 * `conformance` lists every place where the fixture departs from the measured post to keep a house
 * safety rule (safe margin, line height, logo clear space, a carrier under text on a photo,
 * contrast, nothing under copy). Those rules were not recalibrated, so the fixture says what the
 * office does and what the house requires instead. `omitted` lists what the layout model cannot
 * express (icons, grid-paper texture, the wordmark lockup image).
 */

export interface OfficePostFixture {
  id: string;
  /** The exemplar file the annotation was measured from. */
  source: string;
  /** The ADR-170 recipe the exemplar is catalogued under (PHOTO_EXEMPLARS.md). */
  recipe: Exclude<RecipeId, 'typographic'>;
  language: 'en' | 'ckb' | 'bilingual';
  /** Placeholder copy by copyIndex. */
  copy: string[];
  /** The layout as the studio's recipe path would carry it (artDirection set). */
  layout: StudioLayoutV2;
  conformance: string[];
  omitted: string[];
}

const NAVY = '#0A1628';
const ROYAL = '#1E3A5F';
const KAAE_BLUE = '#4770A3';
const GOLD = '#F7B500';
const CREAM = '#FDF8F3';
const WHITE = '#FFFFFF';
const LATIN_DISPLAY = 'Inter';
const SORANI_DISPLAY = 'IBM Plex Sans Arabic';
const SORANI_BODY = 'Noto Sans Arabic';
const MARGIN = 64;
const GRID = { margin: MARGIN, columns: 12 as const, gutter: 20, baseline: 8 };

type T = Omit<TextElement, 'lineHeight' | 'fontFamily'> & { lineHeight?: number; fontFamily?: string };
const latin = (t: T): TextElement => ({ lineHeight: 1.2, fontFamily: LATIN_DISPLAY, ...t });
const sorani = (t: T): TextElement => ({ lineHeight: 1.6, fontFamily: t.role === 'title' || t.bold ? SORANI_DISPLAY : SORANI_BODY, rtl: true, ...t });
const panel = (s: Omit<ShapeElement, 'role' | 'kind'> & Partial<Pick<ShapeElement, 'kind'>>): ShapeElement => ({ kind: 'rect', role: 'panel', ...s });
const fade = (o: Omit<OverlayElement, 'kind'>): OverlayElement => ({ kind: 'gradient', ...o });
const photo = (p: PhotoElement): PhotoElement => p;

// ---------------------------------------------------------------------------------------------
// photo01 / photo02: the K-12 field visit report (hero_fade_report). A classroom photo over the top,
// a crowd photo blended into a navy fade below it, a two-colour caps title, a lead, a call to action
// over a gold pill, and a gold frame inset round the canvas.
// ---------------------------------------------------------------------------------------------
function fieldVisit(rtl: boolean): StudioLayoutV2 {
  const t = rtl ? sorani : latin;
  return {
    version: 2, width: 1080, height: 1350, grid: GRID, background: { color: NAVY },
    photos: [
      photo({ photoIndex: 0, role: 'hero', x: 0, y: 0, width: 1080, height: 760, fade: { edge: 'bottom', length: 0.25 } }),
      photo({ photoIndex: 1, role: 'texture', x: 0, y: 560, width: 1080, height: 790, opacity: 0.5 }),
    ],
    overlays: [fade({ x: 0, y: 600, width: 1080, height: 750, color: NAVY, direction: 'to-bottom', purpose: 'fade',
      stops: [{ at: 0, opacity: 0 }, { at: 0.2, opacity: 0.6 }, { at: 0.45, opacity: 0.85 }, { at: 1, opacity: 0.95 }] })],
    shapes: [
      { kind: 'rect', role: 'frame', layer: 'overlay', fill: 'none', x: 30, y: 25, width: 1020, height: 1300, color: GOLD, strokeWidth: 4 },
      panel({ kind: 'roundRect', layer: 'overlay', surface: 'pill', x: 405, y: 1236, width: 270, height: 54, radius: 27, color: GOLD }),
    ],
    logo: { x: rtl ? 64 : 64, y: 64, width: 130, height: 130 },
    text: rtl
      ? [
          t({ copyIndex: 0, role: 'title', x: 64, y: 812, width: 952, height: 144, fontSize: 45, bold: true, color: WHITE, align: 'right', accentColor: GOLD, accentParagraph: 'last' }),
          t({ copyIndex: 1, role: 'subtitle', x: 180, y: 990, width: 836, height: 116, fontSize: 36, color: WHITE, align: 'right' }),
          t({ copyIndex: 2, role: 'cta', x: 290, y: 1166, width: 500, height: 58, fontSize: 36, color: WHITE, align: 'center' }),
          latin({ copyIndex: 3, role: 'cta', x: 420, y: 1240, width: 240, height: 46, fontSize: 38, bold: true, color: NAVY, align: 'center' }),
        ]
      : [
          t({ copyIndex: 0, role: 'title', x: 64, y: 760, width: 880, height: 144, fontSize: 60, bold: true, color: WHITE, align: 'left', accentColor: GOLD, accentParagraph: 'last' }),
          t({ copyIndex: 1, role: 'subtitle', x: 64, y: 952, width: 860, height: 150, fontSize: 40, lineHeight: 1.25, color: WHITE, align: 'left' }),
          t({ copyIndex: 2, role: 'cta', x: 290, y: 1182, width: 500, height: 44, fontSize: 36, color: WHITE, align: 'center' }),
          t({ copyIndex: 3, role: 'cta', x: 420, y: 1240, width: 240, height: 46, fontSize: 38, bold: true, color: NAVY, align: 'center' }),
        ],
    artDirection: {
      recipe: 'hero_fade_report', titleZone: { x: 0, y: 740, width: 1080, height: 610 }, heroPhotoIndex: 0, texturePhotoIndex: 1, omittedPhotos: [], rtl,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// photo03 / photo04: "Why accreditation?" (hero_card). A campus photo inside a gold border with a
// thin white inner line, a cream card across the foot holding the title, a keyword line and the
// URL, and a navy wordmark tab bridging the card's top edge.
// ---------------------------------------------------------------------------------------------
function whyCard(rtl: boolean): StudioLayoutV2 {
  const t = rtl ? sorani : latin;
  return {
    version: 2, width: 1080, height: 1350, grid: GRID, background: { color: GOLD },
    photos: [photo({ photoIndex: 0, role: 'hero', x: 30, y: 25, width: 1020, height: 1300 })],
    shapes: [
      { kind: 'rect', role: 'frame', layer: 'overlay', fill: 'none', x: 28, y: 22, width: 1024, height: 1306, color: WHITE, strokeWidth: 3 },
      panel({ layer: 'overlay', surface: 'card', x: 50, y: 995, width: 980, height: 305, color: CREAM }),
      panel({ layer: 'overlay', surface: 'tab', x: 365, y: 963, width: 350, height: 67, color: ROYAL }),
    ],
    logo: { x: 64, y: 64, width: 130, height: 130 },
    text: [
      latin({ copyIndex: 0, role: 'eyebrow', x: 380, y: 974, width: 320, height: 45, fontSize: 30, bold: true, color: WHITE, align: 'center' }),
      t({ copyIndex: 1, role: 'title', x: 120, y: rtl ? 1052 : 1066, width: 840, height: rtl ? 86 : 70, fontSize: rtl ? 52 : 56, bold: !rtl, color: ROYAL, align: 'center' }),
      t({ copyIndex: 2, role: 'subtitle', x: 90, y: rtl ? 1140 : 1142, width: 900, height: rtl ? 78 : 62, fontSize: 24, color: ROYAL, align: 'center', ...(rtl ? { lineHeight: 1.6 } : {}) }),
      latin({ copyIndex: 3, role: 'footer', x: 340, y: 1252, width: 400, height: 30, fontSize: 22, color: ROYAL, align: 'center' }),
    ],
    artDirection: { recipe: 'hero_card', titleZone: { x: 50, y: 995, width: 980, height: 305 }, heroPhotoIndex: 0, omittedPhotos: [], rtl },
  };
}

// ---------------------------------------------------------------------------------------------
// photo05 / photo06: "Global partnership" (hero_plate). KAAE Blue ground, the logo centred at the
// top, a navy plate with a drop shadow holding a one-line title, an aerial photo filling the lower
// three quarters and fading up into the blue, two URL lines at the foot.
// ---------------------------------------------------------------------------------------------
function partnershipPlate(rtl: boolean): StudioLayoutV2 {
  const t = rtl ? sorani : latin;
  return {
    version: 2, width: 1080, height: 1350, grid: GRID, background: { color: KAAE_BLUE },
    photos: [photo({ photoIndex: 0, role: 'hero', x: 0, y: 380, width: 1080, height: 970, fade: { edge: 'top', length: 0.15 } })],
    overlays: [fade({ x: 0, y: 1150, width: 1080, height: 200, color: NAVY, direction: 'to-bottom', purpose: 'scrim',
      stops: [{ at: 0, opacity: 0 }, { at: 0.3, opacity: 0.7 }, { at: 1, opacity: 0.85 }] })],
    shapes: [
      panel({ kind: 'roundRect', layer: 'overlay', surface: 'plate', x: 72, y: 252, width: 935, height: 158, radius: 16, color: ROYAL,
        shadow: { color: NAVY, opacity: 0.4, blur: 24, offsetY: 10 } }),
    ],
    logo: { x: 470, y: 64, width: 140, height: 140 },
    text: [
      t({ copyIndex: 0, role: 'title', x: 110, y: rtl ? 274 : 286, width: 860, height: rtl ? 115 : 96, fontSize: rtl ? 72 : 80, bold: true, color: WHITE, align: 'center' }),
      latin({ copyIndex: 1, role: 'footer', x: 340, y: 1210, width: 400, height: 72, fontSize: 26, lineHeight: 1.35, color: WHITE, align: 'center' }),
    ],
    artDirection: { recipe: 'hero_plate', titleZone: { x: 72, y: 252, width: 935, height: 158 }, heroPhotoIndex: 0, omittedPhotos: [], rtl },
  };
}

// ---------------------------------------------------------------------------------------------
// photo07 / photo08: the Prime Minister meeting (scrim_caption), landscape 5:4. A full-bleed group
// photo, a navy scrim rising from the foot, a bold one-line title, a one-line subtitle and a short
// gold rule under them.
// ---------------------------------------------------------------------------------------------
function meetingScrim(rtl: boolean): StudioLayoutV2 {
  const t = rtl ? sorani : latin;
  const W = 1350;
  return {
    version: 2, width: W, height: 1080, grid: GRID, background: { color: NAVY },
    photos: [photo({ photoIndex: 0, role: 'hero', x: 0, y: 0, width: W, height: 1080 })],
    overlays: [fade({ x: 0, y: 700, width: W, height: 380, color: NAVY, direction: 'to-bottom', purpose: 'scrim',
      stops: [{ at: 0, opacity: 0 }, { at: 0.35, opacity: 0.75 }, { at: 1, opacity: 0.95 }] })],
    shapes: [
      { kind: 'roundRect', role: 'accent', layer: 'overlay', x: rtl ? W - 64 - 630 : 64, y: 988, width: 630, height: 7, radius: 3, color: GOLD },
    ],
    logo: { x: 64, y: 64, width: 120, height: 120 },
    text: [
      t({ copyIndex: 0, role: 'title', x: 64, y: rtl ? 830 : 845, width: 1222, height: rtl ? 68 : 52, fontSize: rtl ? 42 : 43, bold: true, color: WHITE, align: rtl ? 'right' : 'left' }),
      t({ copyIndex: 1, role: 'subtitle', x: 64, y: rtl ? 905 : 907, width: 1222, height: rtl ? 64 : 48, fontSize: rtl ? 34 : 38, color: WHITE, align: rtl ? 'right' : 'left' }),
    ],
    artDirection: { recipe: 'scrim_caption', titleZone: { x: 0, y: 800, width: W, height: 280 }, heroPhotoIndex: 0, omittedPhotos: [], rtl },
  };
}

// ---------------------------------------------------------------------------------------------
// photo09: the Eid al-Adha greeting (sky_title), bilingual. A full-bleed mosque photo inside a thin
// navy border, the Sorani greeting over the English one in the sky, the logo bottom centre.
// ---------------------------------------------------------------------------------------------
function eidSky(): StudioLayoutV2 {
  return {
    version: 2, width: 1080, height: 1350, grid: GRID, background: { color: NAVY },
    photos: [photo({ photoIndex: 0, role: 'hero', x: 8, y: 8, width: 1064, height: 1334 })],
    overlays: [fade({ x: 0, y: 0, width: 1080, height: 520, color: CREAM, direction: 'to-top', purpose: 'scrim',
      stops: [{ at: 0, opacity: 0 }, { at: 0.34, opacity: 0.72 }, { at: 1, opacity: 0.86 }] })],
    shapes: [],
    logo: { x: 475, y: 1150, width: 130, height: 130 },
    text: [
      sorani({ copyIndex: 0, role: 'title', x: 100, y: 178, width: 880, height: 106, fontSize: 66, bold: true, color: NAVY, align: 'center' }),
      latin({ copyIndex: 1, role: 'subtitle', x: 100, y: 296, width: 880, height: 74, fontSize: 60, color: NAVY, align: 'center' }),
    ],
    artDirection: { recipe: 'sky_title', titleZone: { x: 100, y: 178, width: 880, height: 192 }, heroPhotoIndex: 0, omittedPhotos: [], rtl: false },
  };
}

// ---------------------------------------------------------------------------------------------
// photo10: the 4th Kurdistan Educational Forum (cutout_speaker), 1:1. A speaker cut out of her photo
// bleeding off the bottom-left, a gold caps eyebrow, a two-line caps title, a paragraph and the
// date, time and place in a column on navy.
// ---------------------------------------------------------------------------------------------
function forumSpeaker(): StudioLayoutV2 {
  return {
    version: 2, width: 1080, height: 1080, grid: GRID, background: { color: ROYAL },
    photos: [photo({ photoIndex: 0, role: 'portrait', treatment: 'cutout', x: 0, y: 110, width: 388, height: 970 })],
    shapes: [],
    logo: { x: 916, y: 916, width: 100, height: 100 },
    text: [
      latin({ copyIndex: 0, role: 'eyebrow', x: 396, y: 64, width: 620, height: 58, fontSize: 48, bold: true, color: GOLD, align: 'left' }),
      latin({ copyIndex: 1, role: 'title', x: 396, y: 126, width: 620, height: 154, fontSize: 64, color: WHITE, align: 'left' }),
      latin({ copyIndex: 2, role: 'body', x: 396, y: 296, width: 620, height: 212, fontSize: 29, color: WHITE, align: 'left' }),
      latin({ copyIndex: 3, role: 'date', x: 556, y: 900, width: 300, height: 108, fontSize: 30, color: WHITE, align: 'left' }),
    ],
    artDirection: { recipe: 'cutout_speaker', titleZone: { x: 396, y: 64, width: 620, height: 462 }, cutoutPhotoIndex: 0, omittedPhotos: [], rtl: false },
  };
}

// ---------------------------------------------------------------------------------------------
// photo11 / photo12: the call for peer evaluators (fade_to_paper). Cream paper, a navy tab bleeding
// off the start edge with a gold caps eyebrow, a huge two-size caps title, a navy card bleeding off
// the start edge with three lines, two lines of details, a pill, a photo fading into the paper in
// the far bottom corner, and a navy bar along the foot.
// ---------------------------------------------------------------------------------------------
function peerCall(rtl: boolean): StudioLayoutV2 {
  const W = 1080;
  const flip = (x: number, w: number) => (rtl ? W - x - w : x);
  const t = rtl ? sorani : latin;
  const align = rtl ? 'right' : 'left';
  const shapes: ShapeElement[] = rtl
    ? [
        panel({ surface: 'tab', x: 428, y: 68, width: 652, height: 132, color: ROYAL }),
        panel({ kind: 'roundRect', surface: 'card', x: 510, y: 592, width: 570, height: 226, radius: 20, color: ROYAL }),
        panel({ kind: 'roundRect', surface: 'pill', x: 652, y: 1055, width: 398, height: 66, radius: 33, color: ROYAL }),
        panel({ x: 0, y: 1295, width: W, height: 55, color: ROYAL }),
      ]
    : [
        panel({ surface: 'tab', x: 0, y: 104, width: 578, height: 96, color: ROYAL }),
        panel({ kind: 'roundRect', surface: 'card', x: 0, y: 592, width: 606, height: 226, radius: 20, color: ROYAL }),
        panel({ kind: 'roundRect', surface: 'pill', x: 18, y: 1045, width: 275, height: 72, radius: 36, color: ROYAL }),
        panel({ x: 0, y: 1295, width: W, height: 55, color: ROYAL }),
      ];
  const text: TextElement[] = rtl
    ? [
        t({ copyIndex: 0, role: 'eyebrow', x: 440, y: 76, width: 576, height: 115, fontSize: 72, bold: true, color: GOLD, align }),
        t({ copyIndex: 1, role: 'title', x: 300, y: 228, width: 716, height: 222, fontSize: 69, bold: true, color: ROYAL, align }),
        t({ copyIndex: 2, role: 'subtitle', x: 545, y: 606, width: 400, height: 198, fontSize: 41, color: WHITE, align }),
        t({ copyIndex: 3, role: 'other', x: 170, y: 846, width: 846, height: 58, fontSize: 36, bold: true, color: ROYAL, align }),
        t({ copyIndex: 4, role: 'other', x: 548, y: 908, width: 468, height: 58, fontSize: 34, bold: true, color: ROYAL, align }),
        t({ copyIndex: 5, role: 'cta', x: 680, y: 1062, width: 336, height: 52, fontSize: 32, bold: true, color: WHITE, align }),
      ]
    : [
        t({ copyIndex: 0, role: 'eyebrow', x: 64, y: 110, width: 500, height: 84, fontSize: 70, bold: true, color: GOLD, align }),
        t({ copyIndex: 1, role: 'title', x: 64, y: 205, width: 640, height: 190, fontSize: 158, bold: true, color: ROYAL, align }),
        t({ copyIndex: 2, role: 'title', x: 64, y: 398, width: 880, height: 108, fontSize: 90, bold: true, color: ROYAL, align }),
        t({ copyIndex: 3, role: 'subtitle', x: 130, y: 606, width: 440, height: 198, fontSize: 44, lineHeight: 1.5, color: WHITE, align }),
        t({ copyIndex: 4, role: 'other', x: 64, y: 855, width: 780, height: 44, fontSize: 34, bold: true, color: ROYAL, align }),
        t({ copyIndex: 5, role: 'other', x: 64, y: 918, width: 540, height: 44, fontSize: 34, bold: true, color: ROYAL, align }),
        t({ copyIndex: 6, role: 'cta', x: 64, y: 1058, width: 222, height: 46, fontSize: 36, bold: true, color: WHITE, align }),
      ];
  return {
    version: 2, width: W, height: 1350, grid: GRID, background: { color: CREAM },
    photos: [photo({ photoIndex: 0, role: 'hero', x: flip(550, 530), y: 966, width: 530, height: 329, fade: { edge: rtl ? 'right' : 'left', length: 0.6 } })],
    shapes,
    logo: rtl ? { x: 64, y: 64, width: 110, height: 110 } : { x: 896, y: 64, width: 120, height: 120 },
    text,
    artDirection: {
      recipe: 'fade_to_paper', titleZone: rtl ? { x: 300, y: 68, width: 780, height: 382 } : { x: 0, y: 104, width: 944, height: 402 },
      heroPhotoIndex: 0, omittedPhotos: [], rtl,
    },
  };
}

// Sorani placeholders: whole strings from this repository's tests (README.md cites the files).
const CKB = {
  accreditingBody: 'دەستەی متمانەبەخشی بە پرۆگرامەکان و دامەزراوەکانی پەروەردە و خوێندنی باڵا',
  fieldVisitInsights: 'تێڕوانینەکان لە سەردانە مەیدانییەکانی کەی ئەی بۆ قوتابخانەکان و هەنگاوەکانی داهاتوو',
  invitation: 'بانگهێشتی سەرجەم سەرۆک زانکۆکان و پسپۆڕانی پەروەردەیی دەکرێت بۆ بەشداریکردن لە شیکاری پێوەرە نێودەوڵەتییەکان.',
  annualReport: 'ڕاپۆرتی ساڵانە',
  educationQuality: 'کوالیتی خوێندن',
  annualConference: 'کۆنفرانسی ساڵانە',
  announcement: 'ڕاگەیاندن',
  graduation: 'ڕێوڕەسمی دەرچوون',
  peerCall: 'بانگەواز بۆ هەڵسەنگێنەرانی هاوتا',
  basicAndHigher: 'پەروەردەی بنەڕەتی و خوێندنی باڵا',
  freeRegistration: 'تۆمارکردن بەخۆڕاییە',
  forDeans: 'بۆ ڕاگرانی زانکۆکان',
  qaWorkshop: 'وۆرکشۆپی دڵنیایی جۆری',
};

export const OFFICE_POSTS: OfficePostFixture[] = [
  {
    id: 'photo01_k12_field_visit_report_en', source: 'photo01_k12_field_visit_report_en.jpg', recipe: 'hero_fade_report', language: 'en',
    copy: ['KAAE K-12 PILOT REVIEW\nSCHOOL VISIT SUMMARY', 'Findings from school quality visits across the region and the next steps toward better learning outcomes.', 'Read the full summary at', 'kaae.org'],
    layout: fieldVisit(false),
    conformance: [
      'title, lead and call to action start at the 64px house safe margin (office: 60-62px)',
      'title leading 1.2 (house Latin minimum; office caps about 1.16); the box keeps the office line pitch, so the type is 60px for the office 62px',
      'logo moved into the safe area (office: 55,50) and drawn as the official square logo, 130px',
    ],
    omitted: ['the classroom photo and the crowd photo are boxes only'],
  },
  {
    id: 'photo02_k12_field_visit_report_ckb', source: 'photo02_k12_field_visit_report_ckb.jpg', recipe: 'hero_fade_report', language: 'ckb',
    copy: [CKB.accreditingBody, CKB.fieldVisitInsights, CKB.freeRegistration, 'kaae.org'],
    layout: fieldVisit(true),
    conformance: [
      'Sorani leading 1.6 (house minimum; office about 1.15), so the title and lead set at 45px and 36px in the office line boxes, which grow to hold two lines at 1.6',
      'logo moved into the safe area (office: 55,50) and drawn as the official square logo, 130px',
    ],
    omitted: ['the classroom photo and the crowd photo are boxes only'],
  },
  {
    id: 'photo03_why_accreditation_card_en', source: 'photo03_why_accreditation_card_en.jpg', recipe: 'hero_card', language: 'en',
    copy: ['QUALITY BODY', 'Why Standards Matter?', 'Quality Review - Public Confidence - Steady Improvement - Trust\nOpen Reporting - Learner Focused Teaching - New Ideas', 'www.example.krd'],
    layout: whyCard(false),
    conformance: [
      'title colour: the office sets it in an antique gold (not in the KAAE palette, about 3:1 on cream); the fixture uses Royal (#1E3A5F) so the declared contrast check applies unchanged',
      'border: the office antique gold maps to the palette gold (#F7B500)',
      'keyword lines leading 1.2 (office about 1.17)',
      'logo moved into the safe area (office: 55,60), 130px',
    ],
    omitted: ['the KAAE wordmark lockup on the tab is an image; annotated as a tab with an eyebrow line of the same size'],
  },
  {
    id: 'photo04_why_accreditation_card_ckb', source: 'photo04_why_accreditation_card_ckb.jpg', recipe: 'hero_card', language: 'ckb',
    copy: ['QUALITY BODY', CKB.forDeans, CKB.invitation, 'www.example.krd'],
    layout: whyCard(true),
    conformance: [
      'title colour Royal (office antique gold, not in the palette); border gold mapped to #F7B500',
      'Sorani leading 1.6 (office about 1.25): the title box grows from 70px to 86px and the keyword box from 62px to 78px',
      'logo moved into the safe area (office: 55,60), 130px',
    ],
    omitted: ['the KAAE wordmark lockup on the tab is an image; annotated as a tab with an eyebrow line of the same size'],
  },
  {
    id: 'photo05_global_partnership_plate_en', source: 'photo05_global_partnership_plate_en.jpg', recipe: 'hero_plate', language: 'en',
    copy: ['Shared Standards', 'www.example.org\ninfo@example.krd'],
    layout: partnershipPlate(false),
    conformance: [
      'the two URL lines sit bare on the photo in the office post; the fixture puts a navy scrim under them (text over a photo needs a carrier, ADR-170)',
      'the URL lines end at the 64px bottom safe margin (office: 25px from the foot)',
      'logo top at the safe margin (office: 40px), 140px',
    ],
    omitted: [],
  },
  {
    id: 'photo06_global_partnership_plate_ckb', source: 'photo06_global_partnership_plate_ckb.jpg', recipe: 'hero_plate', language: 'ckb',
    copy: [CKB.qaWorkshop, 'www.example.org\ninfo@example.krd'],
    layout: partnershipPlate(true),
    conformance: [
      'the two URL lines sit bare on the photo in the office post; the fixture puts a navy scrim under them (ADR-170)',
      'the URL lines end at the 64px bottom safe margin (office: 25px from the foot)',
      'Sorani title leading 1.6 inside the same plate',
      'logo top at the safe margin (office: 40px), 140px',
    ],
    omitted: [],
  },
  {
    id: 'photo07_prime_minister_meeting_scrim_en', source: 'photo07_prime_minister_meeting_scrim_en.jpg', recipe: 'scrim_caption', language: 'en',
    copy: ['Raising School Quality Across the Kurdistan Region', 'KAAE meeting with senior officials of the regional government'],
    layout: meetingScrim(false),
    conformance: [
      'title, subtitle and gold rule start at the 64px safe margin (office: 50px)',
      'logo moved into the safe area (office: 35,15), 120px',
    ],
    omitted: ['the group photo is a box only'],
  },
  {
    id: 'photo08_prime_minister_meeting_scrim_ckb', source: 'photo08_prime_minister_meeting_scrim_ckb.jpg', recipe: 'scrim_caption', language: 'ckb',
    copy: [CKB.peerCall, CKB.accreditingBody],
    layout: meetingScrim(true),
    conformance: [
      'title, subtitle and gold rule end at the 64px safe margin (office: 50px)',
      'Sorani leading 1.6 (office about 1.3)',
      'logo moved into the safe area (office: 35,15), 120px',
    ],
    omitted: ['the group photo is a box only'],
  },
  {
    id: 'photo09_eid_al_adha_sky_title', source: 'photo09_eid_al_adha_sky_title.jpg', recipe: 'sky_title', language: 'bilingual',
    copy: [CKB.qaWorkshop, "SEASON'S GREETINGS"],
    layout: eidSky(),
    conformance: [
      'the office sets dark navy type bare on a bright sky; the fixture carries it on the cream sky scrim the studio\'s sky_title recipe draws (text over a photo needs a carrier, ADR-170)',
      'logo 130px at the bottom centre inside the safe area (office: 150px wide, its foot 55px from the edge)',
    ],
    omitted: [],
  },
  {
    id: 'photo10_educational_forum_speaker_en', source: 'photo10_educational_forum_speaker_en.jpg', recipe: 'cutout_speaker', language: 'en',
    copy: [
      'MEET KAAE AT THE',
      '5TH REGIONAL\nLEARNING SUMMIT',
      'Join us at this leading meeting of educators,\nbringing together experts, academics and\nleaders in schooling under the theme:\n\nModern Schools: Skills and Quality',
      '12-13 May 2027\n10:30 AM\nCity Fair Hall',
    ],
    layout: forumSpeaker(),
    conformance: [
      'the cut-out box ends where the text column starts (x 388); in the office post the speaker\'s shoulder runs under the column\'s empty lower part',
      'the dark sunburst behind the date is left out: the house keeps brand elements from under copy (ORNAMENT)',
      'logo moved in from the corner to the safe area and kept 50px clear of the date column (office: about 40px, 20px from the edges)',
      'eyebrow, title, paragraph and date start at the office x (396 and 556); leading 1.2 (office about 1.15)',
    ],
    omitted: ['the faint grid on the navy ground', 'the sunburst (see conformance)'],
  },
  {
    id: 'photo11_peer_evaluators_call_en', source: 'photo11_peer_evaluators_call_en.jpg', recipe: 'fade_to_paper', language: 'en',
    copy: ['OPEN CALL', 'TEAM', 'REVIEWERS', 'Your knowledge.\nOur criteria.\nBetter schooling.', "Join KAAE's panel of expert school reviewers.", 'K-12 | UNIVERSITIES', 'Apply today'],
    layout: peerCall(false),
    conformance: [
      'caps leading 1.2 (office about 0.85-1.0): each caps line keeps its office line box and sets at box height / 1.2 (eyebrow 70px for the office 104px, "PEER" 158px for about 225px)',
      'the photo box starts where its pixels show (y 966); its fully faded top runs under two text lines in the office post',
      'logo moved into the safe area (office: 900,40), 120px',
    ],
    omitted: ['the three icons on the card', 'the grid-paper texture of the ground'],
  },
  {
    id: 'photo12_peer_evaluators_call_ckb', source: 'photo12_peer_evaluators_call_ckb.jpg', recipe: 'fade_to_paper', language: 'ckb',
    copy: [
      CKB.announcement,
      CKB.graduation.replace(' ', '\n'),
      [CKB.annualReport, CKB.educationQuality, CKB.annualConference].join('\n'),
      CKB.peerCall,
      CKB.basicAndHigher,
      CKB.freeRegistration,
    ],
    layout: peerCall(true),
    conformance: [
      'Sorani leading 1.6 (office about 1.1 for the display lines): each line keeps its office line box and sets at box height / 1.6',
      'the two-line title is one repository string with a line break between its two words, as the office breaks its title',
      'the photo box starts where its pixels show (y 966)',
      'logo moved into the safe area (office: 30,40), 110px',
    ],
    omitted: ['the three icons on the card', 'the grid-paper texture of the ground'],
  },
];
