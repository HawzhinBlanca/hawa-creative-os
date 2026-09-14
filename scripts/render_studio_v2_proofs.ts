import fs from 'node:fs';
import path from 'node:path';
import {
  renderLayoutV2,
  comparePngBuffers,
  type RenderLayoutV2Result,
} from '../packages/creative/src/studio/render-layout-v2.js';
import type { StudioLayoutV2 } from '../packages/creative/src/studio/layout-v2.js';
import { validateLayoutV2 } from '../packages/creative/src/studio/validate-layout-v2.js';

export const LATIN_LAYOUT: StudioLayoutV2 = {
  version: 2,
  width: 1080,
  height: 1350,
  grid: { margin: 86, columns: 6, gutter: 20, baseline: 8 },
  background: { color: '#0A1628' },
  shapes: [
    { x: 86, y: 280, width: 908, height: 2, kind: 'line', color: '#F7B500', role: 'rule' },
  ],
  logo: { x: 86, y: 86, width: 120, height: 120 },
  text: [
    {
      copyIndex: 0,
      role: 'eyebrow',
      x: 86,
      y: 310,
      width: 908,
      height: 30,
      fontSize: 18,
      lineHeight: 1.3,
      fontFamily: 'EB Garamond',
      color: '#D4E2F0',
      align: 'left',
    },
    {
      copyIndex: 1,
      role: 'title',
      x: 86,
      y: 360,
      width: 908,
      height: 110,
      fontSize: 46,
      lineHeight: 1.2,
      fontFamily: 'EB Garamond',
      color: '#F7B500',
      align: 'left',
      bold: true,
    },
    {
      copyIndex: 2,
      role: 'subtitle',
      x: 86,
      y: 490,
      width: 908,
      height: 50,
      fontSize: 26,
      lineHeight: 1.3,
      fontFamily: 'EB Garamond',
      color: '#FFFFFF',
      align: 'left',
    },
    {
      copyIndex: 3,
      role: 'body',
      x: 86,
      y: 570,
      width: 908,
      height: 120,
      fontSize: 20,
      lineHeight: 1.4,
      fontFamily: 'EB Garamond',
      color: '#FDF8F3',
      align: 'left',
    },
    {
      copyIndex: 4,
      role: 'date',
      x: 86,
      y: 720,
      width: 908,
      height: 40,
      fontSize: 22,
      lineHeight: 1.3,
      fontFamily: 'EB Garamond',
      color: '#D4E2F0',
      align: 'left',
    },
  ],
};

export const LATIN_COPY: Record<number, string> = {
  0: 'ACADEMIC EXCELLENCE & ACCREDITATION',
  1: 'The Annual Higher Education Forum',
  2: 'Kurdistan Accrediting Association for Education',
  3: 'Join leaders from academia, industry, and government to establish world-class benchmarks for educational quality and institutional trust across the region.',
  4: 'September 24, 2026 | Erbil International Rotana',
};

export const SORANI_LAYOUT: StudioLayoutV2 = {
  version: 2,
  width: 1080,
  height: 1350,
  grid: { margin: 86, columns: 6, gutter: 20, baseline: 8 },
  background: { color: '#0A1628' },
  shapes: [
    { x: 86, y: 280, width: 908, height: 2, kind: 'line', color: '#F7B500', role: 'rule' },
  ],
  logo: { x: 874, y: 86, width: 120, height: 120 },
  text: [
    {
      copyIndex: 0,
      role: 'eyebrow',
      x: 86,
      y: 310,
      width: 908,
      height: 40,
      fontSize: 18,
      lineHeight: 1.7,
      fontFamily: 'Noto Sans Arabic',
      color: '#D4E2F0',
      align: 'right',
      rtl: true,
    },
    {
      copyIndex: 1,
      role: 'title',
      x: 86,
      y: 370,
      width: 908,
      height: 120,
      fontSize: 44,
      lineHeight: 1.7,
      fontFamily: 'Noto Sans Arabic',
      color: '#F7B500',
      align: 'right',
      bold: true,
      rtl: true,
    },
    {
      copyIndex: 2,
      role: 'subtitle',
      x: 86,
      y: 510,
      width: 908,
      height: 60,
      fontSize: 26,
      lineHeight: 1.7,
      fontFamily: 'Noto Sans Arabic',
      color: '#FFFFFF',
      align: 'right',
      rtl: true,
    },
    {
      copyIndex: 3,
      role: 'body',
      x: 86,
      y: 590,
      width: 908,
      height: 140,
      fontSize: 20,
      lineHeight: 1.7,
      fontFamily: 'Noto Sans Arabic',
      color: '#FDF8F3',
      align: 'right',
      rtl: true,
    },
    {
      copyIndex: 4,
      role: 'date',
      x: 86,
      y: 750,
      width: 908,
      height: 50,
      fontSize: 22,
      lineHeight: 1.7,
      fontFamily: 'Noto Sans Arabic',
      color: '#D4E2F0',
      align: 'right',
      rtl: true,
    },
  ],
};

export const SORANI_COPY: Record<number, string> = {
  0: 'دەستەی متمانەبەخشین بە دامەزراوە و پرۆگرامەکانی پەروەردە و خوێندنی باڵا',
  1: 'ڕاگەیاندنی فەرمیی پێوەرە نیشتمانییەکانی دڵنیایی جۆری',
  2: 'بە ئامادەبوونی ڕێزدار مەسرور بارزانی، سەرۆکی حکومەتی هەرێمی کوردستان',
  3: 'مەراسیمی فەرمیی ڕاگەیاندنی پێوەرە نیشتمانییەکان و واژۆکردنی یاداشتی لێکتێگەیشتن لە نێوان وەزارەتی پەروەردە و وەزارەتی خوێندنی باڵا و توێژینەوەی زانستی.',
  4: '٩ی ئەیلوولی ٢٠٢٦ | کاتژمێر ٢:٣٠ی پاشنیوەڕۆ',
};

export const MIXED_LAYOUT: StudioLayoutV2 = {
  version: 2,
  width: 1080,
  height: 1350,
  grid: { margin: 86, columns: 6, gutter: 20, baseline: 8 },
  background: { color: '#0A1628' },
  shapes: [
    { x: 86, y: 280, width: 908, height: 2, kind: 'line', color: '#F7B500', role: 'rule' },
  ],
  logo: { x: 86, y: 86, width: 120, height: 120 },
  text: [
    {
      copyIndex: 0,
      role: 'eyebrow',
      x: 86,
      y: 310,
      width: 908,
      height: 30,
      fontSize: 18,
      lineHeight: 1.3,
      fontFamily: 'EB Garamond',
      color: '#D4E2F0',
      align: 'left',
    },
    {
      copyIndex: 1,
      role: 'title',
      x: 86,
      y: 360,
      width: 908,
      height: 100,
      fontSize: 46,
      lineHeight: 1.2,
      fontFamily: 'EB Garamond',
      color: '#F7B500',
      align: 'left',
      bold: true,
    },
    {
      copyIndex: 2,
      role: 'subtitle',
      x: 86,
      y: 480,
      width: 908,
      height: 50,
      fontSize: 24,
      lineHeight: 1.7,
      fontFamily: 'Noto Sans Arabic',
      color: '#FFFFFF',
      align: 'right',
      rtl: true,
    },
    {
      copyIndex: 3,
      role: 'body',
      x: 86,
      y: 550,
      width: 908,
      height: 100,
      fontSize: 20,
      lineHeight: 1.4,
      fontFamily: 'EB Garamond',
      color: '#FDF8F3',
      align: 'left',
    },
    {
      copyIndex: 4,
      role: 'venue',
      x: 86,
      y: 670,
      width: 908,
      height: 50,
      fontSize: 22,
      lineHeight: 1.7,
      fontFamily: 'Noto Sans Arabic',
      color: '#D4E2F0',
      align: 'right',
      rtl: true,
    },
  ],
};

export const MIXED_COPY: Record<number, string> = {
  0: 'KAAE STRATEGIC ACCREDITATION',
  1: 'National Quality Framework 2026',
  2: 'پێوەرە نیشتمانییەکانی دڵنیایی جۆری لە پەروەردە و فێرکردن',
  3: 'Establishing standardized evaluation protocols for academic excellence across higher education institutions in Kurdistan.',
  4: 'هۆڵی کۆنفرانسەکانی سەعد عەبدوڵڵا - هەولێر',
};

export const MORNING_REQUEST_LAYOUT: StudioLayoutV2 = {
  version: 2,
  width: 1080,
  height: 1350,
  grid: { margin: 86, columns: 6, gutter: 20, baseline: 8 },
  background: { color: '#0A1628' },
  shapes: [
    { x: 86, y: 270, width: 908, height: 2, kind: 'line', color: '#F7B500', role: 'rule' },
  ],
  logo: { x: 86, y: 86, width: 120, height: 120 },
  text: [
    {
      copyIndex: 0,
      role: 'eyebrow',
      x: 86,
      y: 295,
      width: 908,
      height: 30,
      fontSize: 16,
      lineHeight: 1.3,
      fontFamily: 'EB Garamond',
      color: '#D4E2F0',
      align: 'left',
    },
    {
      copyIndex: 1,
      role: 'title',
      x: 86,
      y: 340,
      width: 908,
      height: 80,
      fontSize: 42,
      lineHeight: 1.2,
      fontFamily: 'EB Garamond',
      color: '#F7B500',
      align: 'left',
      bold: true,
    },
    {
      copyIndex: 2,
      role: 'subtitle',
      x: 86,
      y: 435,
      width: 908,
      height: 40,
      fontSize: 24,
      lineHeight: 1.3,
      fontFamily: 'EB Garamond',
      color: '#FFFFFF',
      align: 'left',
    },
    {
      copyIndex: 3,
      role: 'body',
      x: 86,
      y: 490,
      width: 908,
      height: 70,
      fontSize: 19,
      lineHeight: 1.4,
      fontFamily: 'EB Garamond',
      color: '#FDF8F3',
      align: 'left',
    },
    {
      copyIndex: 4,
      role: 'body',
      x: 86,
      y: 580,
      width: 908,
      height: 170,
      fontSize: 18,
      lineHeight: 1.4,
      fontFamily: 'EB Garamond',
      color: '#FDF8F3',
      align: 'left',
    },
    {
      copyIndex: 5,
      role: 'body',
      x: 86,
      y: 770,
      width: 908,
      height: 140,
      fontSize: 18,
      lineHeight: 1.4,
      fontFamily: 'EB Garamond',
      color: '#FDF8F3',
      align: 'left',
    },
    {
      copyIndex: 6,
      role: 'date',
      x: 86,
      y: 935,
      width: 908,
      height: 80,
      fontSize: 20,
      lineHeight: 1.4,
      fontFamily: 'EB Garamond',
      color: '#F7B500',
      align: 'left',
      bold: true,
    },
    {
      copyIndex: 7,
      role: 'footer',
      x: 86,
      y: 1040,
      width: 908,
      height: 60,
      fontSize: 16,
      lineHeight: 1.3,
      fontFamily: 'EB Garamond',
      color: '#D4E2F0',
      align: 'left',
    },
  ],
};

export const MORNING_REQUEST_COPY: Record<number, string> = {
  0: 'THE NATIONAL STANDARDS FOR QUALITY ASSURANCE IN EDUCATION',
  1: 'Official Announcement & Launch Event',
  2: 'Mr. / Ms. / Dr. [Full Name]',
  3: 'The Kurdistan Accrediting Association for Education cordially requests the honor of your presence at this landmark occasion.',
  4: 'His Excellency Prime Minister Masrour Barzani will officially announce the National Standards for Quality Assurance in Education, marking a defining moment in the advancement of educational quality across the Kurdistan Region. The occasion will bring together government, educational institutions, and international partners around a shared national vision for excellence, accountability, and continuous improvement.',
  5: 'As part of the official launch, the Minister of Education and the Minister of Higher Education and Scientific Research will sign a Memorandum of Understanding (MoU), marking a significant commitment to cooperation and the advancement of quality assurance across the education sector.',
  6: 'September 9, 2026 | 2:30 PM\nSaad Abdullah Conference Hall',
  7: 'By Invitation Only • This invitation is personal and non-transferable. Kindly do not share this invitation.',
};

async function main() {
  const outputDir = path.resolve(process.cwd(), 'output/proofs/2026-09-14-design-studio-v2/T04_RENDER');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const jobs = [
    { name: 'latin', layout: LATIN_LAYOUT, copy: LATIN_COPY },
    { name: 'sorani', layout: SORANI_LAYOUT, copy: SORANI_COPY },
    { name: 'mixed', layout: MIXED_LAYOUT, copy: MIXED_COPY },
    { name: 'morning-request', layout: MORNING_REQUEST_LAYOUT, copy: MORNING_REQUEST_COPY },
  ];

  const results: Record<string, { wrappedLines: Record<number, number>; diffPct: number }> = {};
  let fontFidelityReport: Record<string, string> = {};

  for (const job of jobs) {
    console.log(`Rendering ${job.name}...`);
    const res = renderLayoutV2(job.layout, { copyText: job.copy });
    fontFidelityReport = res.fontFidelity;

    const fullPngPath = path.join(outputDir, `${job.name}.png`);
    const noTextPngPath = path.join(outputDir, `${job.name}-no-text.png`);
    const fullSvgPath = path.join(outputDir, `${job.name}.svg`);
    const noTextSvgPath = path.join(outputDir, `${job.name}-no-text.svg`);

    fs.writeFileSync(fullPngPath, res.png);
    fs.writeFileSync(noTextPngPath, res.noTextPng);
    fs.writeFileSync(fullSvgPath, res.svg, 'utf-8');
    fs.writeFileSync(noTextSvgPath, res.noTextSvg, 'utf-8');

    // Run deterministic second render to test stability
    const res2 = renderLayoutV2(job.layout, { copyText: job.copy });
    const diff = comparePngBuffers(res.png, res2.png);

    results[job.name] = {
      wrappedLines: res.wrappedLines,
      diffPct: diff.diffPercentage,
    };
    console.log(`  ${job.name}: diff = ${diff.diffPercentage}%, wrappedLines:`, res.wrappedLines);
  }

  // Write summary json
  fs.writeFileSync(
    path.join(outputDir, 'summary.json'),
    JSON.stringify({ fontFidelity: fontFidelityReport, results }, null, 2),
    'utf-8'
  );

  console.log('T04 renders successfully written to', outputDir);
}

if (process.argv[1] && process.argv[1].endsWith('render_studio_v2_proofs.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
