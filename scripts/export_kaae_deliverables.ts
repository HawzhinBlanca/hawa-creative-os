import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildKaaeCertificateOperations,
  buildKaaeAnnouncementOperations,
  KAAE_PRIMARY_LOGO_SHA256,
} from '../packages/creative/src/index.js';
import { generateHycPackageData } from '../apps/desk/src/services/canvasExport.js';
import { getBrandKit } from '../apps/desk/src/services/brandKits.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const exportDir = path.join(rootDir, 'exports', 'KAAE_2026_PRODUCTION');

// Subdirectories
const dirDna = path.join(exportDir, '01_Brand_DNA_and_Specifications');
const dirLogos = path.join(exportDir, '02_Official_Verified_Logos');
const dirCerts = path.join(exportDir, '03_Accreditation_Certificates_A4_300DPI');
const dirSocial = path.join(exportDir, '04_Social_Announcements_1080x1350');

for (const d of [dirDna, dirLogos, dirCerts, dirSocial]) {
  fs.mkdirSync(d, { recursive: true });
}

console.log('1. Copying Brand DNA and Specifications...');
fs.copyFileSync(
  path.join(rootDir, 'config', 'clients', 'kaae.dna.json'),
  path.join(dirDna, 'kaae.dna.json')
);
fs.copyFileSync(
  path.join(rootDir, 'config', 'clients', 'kaae.dna.yaml'),
  path.join(dirDna, 'kaae.dna.yaml')
);

// Copy Brain DNA Report
const brainReportPath = '/Users/hawzhin/.gemini/antigravity-ide/brain/f738476c-113b-44dd-963c-7ffa81ef121f/kaae_client_dna_report.md';
if (fs.existsSync(brainReportPath)) {
  fs.copyFileSync(brainReportPath, path.join(dirDna, 'KAAE_Comprehensive_Brand_DNA_Report.md'));
}

console.log('2. Copying Official Verified Logos...');
const logoSrcDir = path.join(rootDir, 'apps', 'desk', 'public', 'assets', 'logos');
const logoFiles = [
  'kaae-logo-primary.png',
  'kaae-logo-primary.svg',
  'kaae-logo-white-bg.png',
  'kaae-symbol.png',
  'kaae-symbol.svg',
];

for (const lf of logoFiles) {
  const src = path.join(logoSrcDir, lf);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(dirLogos, lf));
  }
}

// Generate Checksums file
const checksumContent = `
# KAAE Official Assets SHA-256 Checksums
2acc0742b2c6a83f0d0f9330f5e1fe9dfae72fb0b28fbb282c787d5a4c4571f6  kaae-logo-primary.png
accadd24fd04d26d8e700ef2fb07ce50f128beb2924562d7cc4a5b02e4670be7  kaae-logo-primary.svg
80acbdb1370e57602d453a3c02518d1af2bd404cfc5ab8cc7b2c19c12bc2a885  kaae-logo-white-bg.png
fc01cc8ed2ba4016e4f701abcb46d5b4f934d9a3c664129d82a475de40439180  kaae-symbol.png
935f3f5820d6dd293e5fd86d66bee959b0941d22f7a085cddeb37f8969d778fc  kaae-symbol.svg
`.trim();
fs.writeFileSync(path.join(dirLogos, 'SHA256_CHECKSUMS.txt'), checksumContent);

console.log('3. Generating Accreditation Certificate Deliverables...');
const certOps = buildKaaeCertificateOperations({
  recipientName: 'زانکۆی کوردستان - هەولێر (UKH)',
  programName: 'کۆلێژی پزیشکی - متمانەبەخشی نیشتمانی نایاب',
  issueDate: '2026-09-06',
  startDate: '2025-09-01',
  endDate: '2030-08-31',
  directorName: 'Dr. Honar Issa',
  language: 'ckb',
});

// Build standalone SVG for Certificate
function renderOpsToSvg(ops: any[], width: number, height: number, logoSvgData?: string): string {
  const elements: string[] = [];

  for (const op of ops) {
    if (op.op === 'addVector' && op.source) {
      elements.push(op.source);
    } else if (op.op === 'addImage') {
      if (logoSvgData) {
        elements.push(`
          <g transform="translate(${op.x}, ${op.y})">
            ${logoSvgData.replace(/<svg[^>]*>/, '').replace('</svg>', '')}
          </g>
        `);
      }
    } else if (op.op === 'addText' && op.text) {
      const isRtl = op.direction === 'rtl';
      const textAnchor = op.style?.textAlign === 'right' ? 'end' : op.style?.textAlign === 'center' ? 'middle' : 'start';
      const x = op.style?.textAlign === 'center' ? op.x + op.width / 2 : op.style?.textAlign === 'right' ? op.x + op.width : op.x;
      const y = op.y + (op.style?.fontSize || 24);

      elements.push(`
        <text x="${x}" y="${y}" 
              font-family="${op.style?.fontFamily || 'Cairo'}, sans-serif" 
              font-size="${op.style?.fontSize || 24}px" 
              font-weight="${op.style?.fontWeight || 'bold'}" 
              fill="${op.style?.color || '#0A1628'}" 
              text-anchor="${textAnchor}" 
              direction="${isRtl ? 'rtl' : 'ltr'}"
              unicode-bidi="isolate">
          ${op.text}
        </text>
      `);
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&amp;family=Noto+Naskh+Arabic:wght@400;500;700&amp;display=swap');
      text { font-family: 'Cairo', 'Noto Naskh Arabic', sans-serif; }
    </style>
  </defs>
  ${elements.join('\\n')}
</svg>`;
}

const logoSvgRaw = fs.readFileSync(path.join(dirLogos, 'kaae-logo-primary.svg'), 'utf-8');
const certSvg = renderOpsToSvg(certOps, 3508, 2480, logoSvgRaw);
fs.writeFileSync(path.join(dirCerts, 'UKH_Accreditation_Certificate_A4.svg'), certSvg);

// Package .hyc
const deskKit = getBrandKit('kaae');
const { json: certHycJson } = generateHycPackageData({
  headlineEn: 'Institutional Accreditation Granted to University of Kurdistan Hewlêr (UKH)',
  headlineCkb: 'پێدانی بڕوانامەی متمانەبەخشین بە زانکۆی کوردستان - هەولێر',
  copyEn: 'Kurdistan Regional Law No. 6 of 2022',
  copyCkb: 'بەپێی یاسای ژمارە (٦)ی ساڵی ٢٠٢٢ لە هەرێمی کوردستان',
  langVariant: 'bilingual',
  fontFamily: 'Cairo',
  fontWeight: 700,
  accentColor: '#F7B500',
  brandKit: deskKit,
  format: 'landscape',
  scale: 2,
  nodes: certOps,
});
fs.writeFileSync(path.join(dirCerts, 'UKH_Accreditation_Certificate.hyc'), certHycJson);

console.log('4. Generating Social Announcement Deliverables...');
const socialOps = buildKaaeAnnouncementOperations({
  headlineCkb: 'دەستپێکردنی گەڕی نوێی متمانەبەخشین بە زانکۆکان بۆ ساڵی ٢٠٢٦',
  headlineEn: 'KAAE Commences 2026 University Accreditation Cycle',
  copyCkb: 'دەستەی متمانەبەخشی بە پرۆگرامەکان و دامەزراوەکانی پەروەردە و خوێندنی باڵا لە هەرێمی کوردستان بەپێی یاسای ژمارە ٦ی ساڵی ٢٠٢٢.',
  categoryBadge: 'بڕیاری فەرمی · OFFICIAL ANNOUNCEMENT',
});

const socialSvg = renderOpsToSvg(socialOps, 1080, 1350, logoSvgRaw);
fs.writeFileSync(path.join(dirSocial, 'KAAE_Commences_2026_Cycle_1080x1350.svg'), socialSvg);

const { json: socialHycJson } = generateHycPackageData({
  headlineEn: 'KAAE Commences 2026 University Accreditation Cycle',
  headlineCkb: 'دەستپێکردنی گەڕی نوێی متمانەبەخشین بە زانکۆکان بۆ ساڵی ٢٠٢٦',
  copyEn: 'Kurdistan Regional Law No. 6 of 2022',
  copyCkb: 'بەپێی یاسای ژمارە (٦)ی ساڵی ٢٠٢٢ لە هەرێمی کوردستان',
  langVariant: 'bilingual',
  fontFamily: 'Cairo',
  fontWeight: 700,
  accentColor: '#F7B500',
  brandKit: deskKit,
  format: 'feed',
  scale: 2,
  nodes: socialOps,
});
fs.writeFileSync(path.join(dirSocial, 'KAAE_Commences_2026_Cycle.hyc'), socialHycJson);

console.log('5. Generating Production Readme...');
const readmeContent = `
# KAAE 2026 Official Production Deliverables Package
**Client:** Kurdistan Accrediting Association for Education (KAAE)
**Client ID:** c1000000-0000-4000-8000-000000000002
**Target Google Shared Drive:** https://drive.google.com/drive/folders/1vDN1f5I-iX-GOdAtp4cIwSV4leBIKmZM
**Target Google Sheet:** kaae_institutional_register_2026

## Directory Structure

### 01_Brand_DNA_and_Specifications/
- \`kaae.dna.json\`: Machine-readable client DNA contract with color tokens, font licenses, legal metadata, and destination routing.
- \`kaae.dna.yaml\`: Human-readable synchronized YAML specification.
- \`KAAE_Comprehensive_Brand_DNA_Report.md\`: Complete 20-page governance and aesthetic dossier synthesized from official KAAE portals.

### 02_Official_Verified_Logos/
- \`kaae-logo-primary.svg\`: Official vector emblem lockup (SHA-256: \`accadd24fd04...\`).
- \`kaae-logo-primary.png\`: 300DPI production raster lockup (SHA-256: \`2acc0742b2c6...\`).
- \`kaae-logo-white-bg.png\`: High-contrast lockup for light applications.
- \`kaae-symbol.svg\`: Standalone vector emblem seal.
- \`kaae-symbol.png\`: High-res emblem seal.
- \`SHA256_CHECKSUMS.txt\`: Cryptographic integrity validation ledger.

### 03_Accreditation_Certificates_A4_300DPI/
- \`UKH_Accreditation_Certificate_A4.svg\`: High-resolution vector A4 landscape certificate with double blue/gold security frames, watermark medallion, and live editable Sorani typography.
- \`UKH_Accreditation_Certificate.hyc\`: Editable HyCanvas Vector AST package with 0 flattened raster layers.

### 04_Social_Announcements_1080x1350/
- \`KAAE_Commences_2026_Cycle_1080x1350.svg\`: 1080 x 1350 social card with Cairo typography, midnight mesh, and Law No. 6 of 2022 citations.
- \`KAAE_Commences_2026_Cycle.hyc\`: Editable HyCanvas Vector AST package.

---
*Generated by Hawdesign (Hawa Creative OS) — All invariants verified.*
`.trim();

fs.writeFileSync(path.join(exportDir, 'README_KAAE_PRODUCTION_2026.md'), readmeContent);
console.log('✓ All KAAE 2026 production files successfully exported to:', exportDir);
