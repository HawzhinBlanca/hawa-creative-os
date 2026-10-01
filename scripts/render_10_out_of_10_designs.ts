import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { generateHycPackageData } from '../apps/desk/src/services/canvasExport.js';
import { getBrandKit } from '../apps/desk/src/services/brandKits.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const exportDir = path.join(rootDir, 'exports', 'KAAE_2026_PRODUCTION');
const tmpDir = path.join(rootDir, '.tmp_render');

fs.mkdirSync(tmpDir, { recursive: true });

// Subdirectories
const dirCerts = path.join(exportDir, '03_Accreditation_Certificates_A4_300DPI');
const dirSocial = path.join(exportDir, '04_Social_Announcements_1080x1350');
const dirQuote = path.join(exportDir, '05_Executive_Statements_1080x1080');
const dirBanner = path.join(exportDir, '06_Conference_Keynote_Banner_1920x1080');
const dirAssets = path.join(exportDir, '00_Creative_Visual_Assets');

for (const d of [dirCerts, dirSocial, dirQuote, dirBanner, dirAssets]) {
  fs.mkdirSync(d, { recursive: true });
}

// Load Official SVGs & Brand Assets
const logoSvgRaw = fs.readFileSync(path.join(exportDir, '02_Official_Verified_Logos', 'kaae-logo-primary.svg'), 'utf-8');
const symbolSvgRaw = fs.readFileSync(path.join(exportDir, '02_Official_Verified_Logos', 'kaae-symbol.svg'), 'utf-8');

// Load Generated 3D & Photographic Assets as Base64
const stageTexturePath = path.join(dirAssets, 'stage_texture.jpg');
const goldMedalPath = path.join(dirAssets, 'gold_medal.jpg');
const campusPhotoPath = path.join(dirAssets, 'campus_architecture.jpg');

const stageTextureBase64 = fs.existsSync(stageTexturePath) ? fs.readFileSync(stageTexturePath).toString('base64') : '';
const goldMedalBase64 = fs.existsSync(goldMedalPath) ? fs.readFileSync(goldMedalPath).toString('base64') : '';
const campusPhotoBase64 = fs.existsSync(campusPhotoPath) ? fs.readFileSync(campusPhotoPath).toString('base64') : '';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function renderHtmlToPng(htmlContent: string, outputPath: string, width: number, height: number, scaleFactor: number = 1) {
  const tempHtmlPath = path.join(tmpDir, `render_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.html`);
  fs.writeFileSync(tempHtmlPath, htmlContent);

  const cmd = `"${chromePath}" --headless=new --screenshot="${outputPath}" --window-size=${width},${height} --force-device-scale-factor=${scaleFactor} --hide-scrollbars "file://${tempHtmlPath}"`;
  execSync(cmd, { stdio: 'ignore' });

  try {
    fs.unlinkSync(tempHtmlPath);
  } catch {}
}

/**
 * Generate mathematical guilloche rosette path in SVG
 */
function generateRosette(cx: number, cy: number, r1: number, r2: number, petals: number): string {
  let d = '';
  const steps = 720;
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * Math.PI * 2;
    const r = r1 + r2 * Math.cos(petals * theta);
    const x = cx + r * Math.cos(theta);
    const y = cy + r * Math.sin(theta);
    d += (i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return d + ' Z';
}

/**
 * Generate Horizontal Guilloche border wave paths
 */
function generateHorizontalGuilloche(startX: number, endX: number, y: number, amplitude: number, freq: number): string {
  let paths = '';
  for (let offset = -2; offset <= 2; offset++) {
    let d = '';
    const length = endX - startX;
    const steps = 360;
    const phase = (offset * Math.PI) / 4;
    for (let i = 0; i <= steps; i++) {
      const x = startX + (i / steps) * length;
      const currentY = y + (amplitude + offset * 1.5) * Math.sin((i / steps) * freq * Math.PI * 2 + phase);
      d += (i === 0 ? `M ${x.toFixed(2)} ${currentY.toFixed(2)}` : ` L ${x.toFixed(2)} ${currentY.toFixed(2)}`);
    }
    paths += `<path d="${d}" fill="none" stroke="#F7B500" stroke-width="0.8" stroke-opacity="0.6"/>\n`;
  }
  return paths;
}

/**
 * Generate Vertical Guilloche border wave paths
 */
function generateVerticalGuilloche(startY: number, endY: number, x: number, amplitude: number, freq: number): string {
  let paths = '';
  for (let offset = -2; offset <= 2; offset++) {
    let d = '';
    const length = endY - startY;
    const steps = 260;
    const phase = (offset * Math.PI) / 4;
    for (let i = 0; i <= steps; i++) {
      const y = startY + (i / steps) * length;
      const currentX = x + (amplitude + offset * 1.5) * Math.sin((i / steps) * freq * Math.PI * 2 + phase);
      d += (i === 0 ? `M ${currentX.toFixed(2)} ${y.toFixed(2)}` : ` L ${currentX.toFixed(2)} ${y.toFixed(2)}`);
    }
    paths += `<path d="${d}" fill="none" stroke="#F7B500" stroke-width="0.8" stroke-opacity="0.6"/>\n`;
  }
  return paths;
}

console.log('=== KAAE 10/10 AGENCY-GRADE DESIGN PRODUCTION PIPELINE ===\n');

// ============================================================================
// DESIGN 1: National Accreditation Certificate (A4 Landscape Print · 3508 x 2480 @ 300DPI)
// ============================================================================
console.log('1. Rendering Design 1: Master Accreditation Certificate (A4 Landscape 300DPI)...');

const rosetteNW = generateRosette(180, 180, 75, 38, 16);
const rosetteNE = generateRosette(3508 - 180, 180, 75, 38, 16);
const rosetteSW = generateRosette(180, 2480 - 180, 75, 38, 16);
const rosetteSE = generateRosette(3508 - 180, 2480 - 180, 75, 38, 16);

const topGuilloche = generateHorizontalGuilloche(300, 3508 - 300, 105, 12, 48);
const bottomGuilloche = generateHorizontalGuilloche(300, 3508 - 300, 2480 - 105, 12, 48);
const leftGuilloche = generateVerticalGuilloche(300, 2480 - 300, 105, 12, 34);
const rightGuilloche = generateVerticalGuilloche(300, 2480 - 300, 3508 - 105, 12, 34);

const certHtml = `<!DOCTYPE html>
<html lang="ckb" dir="rtl">
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Noto+Sans+Arabic:wght@400;500;600;700&family=Crimson+Pro:wght@400;600;700;800;900&display=swap');
  
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 3508px;
    height: 2480px;
    overflow: hidden;
    background: #FAF7F2;
    font-family: 'IBM Plex Sans Arabic', 'Noto Sans Arabic', sans-serif;
    color: #0A1628;
  }

  .viewport-container {
    position: relative;
    width: 3508px;
    height: 2480px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* Archival Paper Texture */
  .paper-canvas {
    position: absolute;
    inset: 0;
    background: 
      radial-gradient(ellipse at 50% 35%, #FFFFFF 0%, #FCFAF5 35%, #F6EFE2 75%, #EADBCA 100%);
    z-index: 1;
  }

  /* Central Watermark Emblem */
  .watermark-sun {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 1600px;
    height: 1600px;
    opacity: 0.042;
    z-index: 2;
    pointer-events: none;
  }

  /* Frame SVG */
  .cert-frame-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 3;
    pointer-events: none;
  }

  /* Content Layout Layer */
  .cert-content {
    position: relative;
    z-index: 10;
    width: 3100px;
    height: 2180px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: 20px 40px 10px;
    text-align: center;
  }

  /* Header Section */
  .krg-super-header {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: 5px;
    color: #4770A3;
    text-transform: uppercase;
    margin-bottom: 10px;
  }

  .official-logo-box {
    width: 420px;
    height: 160px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 12px;
    filter: drop-shadow(0 6px 18px rgba(22, 8, 116, 0.15));
  }
  .official-logo-box svg {
    width: 100%;
    height: 100%;
  }

  .authority-name-ckb {
    font-size: 36px;
    font-weight: 800;
    color: #0A1628;
    letter-spacing: -0.5px;
    margin-bottom: 4px;
  }

  .authority-name-en {
    font-family: 'Crimson Pro', serif;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: 6px;
    color: #996B1F;
    text-transform: uppercase;
    margin-bottom: 20px;
  }

  /* Award Title */
  .cert-award-title-ckb {
    font-size: 82px;
    font-weight: 900;
    background: linear-gradient(135deg, #0A1628 0%, #2C5282 50%, #0A1628 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: -1px;
    line-height: 1.15;
    margin-bottom: 6px;
    filter: drop-shadow(0 3px 6px rgba(22,8,116,0.18));
  }

  .cert-award-title-en {
    font-family: 'Crimson Pro', serif;
    font-size: 28px;
    font-weight: 800;
    letter-spacing: 8px;
    color: #F7B500;
    text-transform: uppercase;
    margin-bottom: 16px;
  }

  /* Recipient Plinth */
  .award-preamble {
    font-size: 28px;
    font-weight: 600;
    color: #4A5568;
    margin-bottom: 14px;
  }

  .recipient-card {
    background: rgba(255, 255, 255, 0.9);
    border: 3px solid #F7B500;
    border-radius: 16px;
    padding: 28px 100px 24px;
    box-shadow: 
      0 12px 35px rgba(212, 169, 76, 0.2),
      inset 0 1px 0 rgba(255,255,255,1);
    margin-bottom: 18px;
    display: flex;
    flex-direction: column;
    align-items: center;
    position: relative;
  }

  .recipient-name-ckb {
    font-size: 88px;
    font-weight: 900;
    color: #0A1628;
    letter-spacing: -1px;
    margin-bottom: 6px;
  }

  .recipient-name-en {
    font-family: 'Crimson Pro', serif;
    font-size: 36px;
    font-weight: 700;
    color: #856404;
    letter-spacing: 3px;
    margin-bottom: 14px;
  }

  .program-pill {
    background: #0A1628;
    color: #FFFFFF;
    font-size: 30px;
    font-weight: 700;
    padding: 10px 48px;
    border-radius: 40px;
    border: 2px solid #F7B500;
    box-shadow: 0 6px 20px rgba(22, 8, 116, 0.3);
  }

  /* Legal Decree Body Paragraph */
  .decree-text-block {
    max-width: 2600px;
    font-size: 34px;
    font-weight: 600;
    line-height: 1.85;
    color: #1E293B;
    text-align: justify;
    text-align-last: center;
    margin-bottom: 20px;
    padding: 0 40px;
  }

  /* Signatures & Seal Row */
  .footer-signatures-row {
    width: 100%;
    display: grid;
    grid-template-columns: 1fr 400px 1fr;
    align-items: end;
    padding: 0 30px 10px;
  }

  .signatory-column {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .cursive-signature-svg {
    width: 340px;
    height: 100px;
    margin-bottom: 6px;
  }

  .sig-separator-line {
    width: 420px;
    height: 3px;
    background: linear-gradient(90deg, transparent, #0A1628, transparent);
    margin-bottom: 12px;
  }

  .signatory-name {
    font-size: 34px;
    font-weight: 800;
    color: #0A1628;
    margin-bottom: 4px;
  }

  .signatory-title {
    font-size: 22px;
    font-weight: 600;
    color: #475569;
  }

  /* 3D Embossed Gold Seal */
  .seal-column {
    display: flex;
    flex-direction: column;
    align-items: center;
    position: relative;
    top: -30px;
  }

  .gold-seal-3d {
    width: 280px;
    height: 280px;
    border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, #FFFDF0 0%, #FDE68A 25%, #F7B500 60%, #854D0E 100%);
    box-shadow: 
      0 18px 45px rgba(133, 77, 14, 0.5),
      inset 0 4px 8px rgba(255,255,255,0.9),
      inset 0 -6px 14px rgba(0,0,0,0.45);
    border: 5px solid #FEF3C7;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    z-index: 5;
  }

  .gold-seal-3d::before {
    content: '';
    position: absolute;
    inset: 14px;
    border-radius: 50%;
    border: 2.5px dashed #78350F;
    opacity: 0.65;
  }

  .seal-emblem-svg {
    width: 170px;
    height: 170px;
    filter: drop-shadow(0 3px 8px rgba(0,0,0,0.35));
  }
  .seal-emblem-svg svg {
    width: 100%;
    height: 100%;
  }

  /* Hanging Satin Ribbons */
  .ribbon-tails {
    position: absolute;
    top: 230px;
    display: flex;
    gap: 20px;
    z-index: 4;
  }

  .ribbon-navy {
    width: 60px;
    height: 130px;
    background: linear-gradient(180deg, #0A1628 0%, #0D0446 100%);
    box-shadow: 0 10px 22px rgba(0,0,0,0.35);
    clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 80%, 0 100%);
  }

  .ribbon-gold {
    width: 60px;
    height: 130px;
    background: linear-gradient(180deg, #F7B500 0%, #996B1F 100%);
    box-shadow: 0 10px 22px rgba(0,0,0,0.35);
    clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 80%, 0 100%);
  }

  .seal-caption {
    font-family: 'Crimson Pro', serif;
    font-size: 15px;
    font-weight: 800;
    letter-spacing: 2px;
    color: #854D0E;
    margin-top: 80px;
    text-align: center;
  }

  /* Sub-Footer */
  .security-metadata-footer {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1.5px solid rgba(212, 169, 76, 0.45);
    padding-top: 14px;
    font-size: 20px;
    font-weight: 600;
    color: #64748B;
  }
  .security-metadata-footer b {
    color: #0F172A;
  }
  .matrix-serial {
    font-family: monospace;
    font-size: 18px;
    letter-spacing: 2px;
    color: #0A1628;
    font-weight: 700;
  }
</style>
</head>
<body>
  <div class="viewport-container">
    <div class="paper-canvas"></div>

    <div class="watermark-sun">
      ${symbolSvgRaw}
    </div>

    <!-- Master Multi-Rule Security Guilloche Frame -->
    <svg class="cert-frame-svg" viewBox="0 0 3508 2480" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="goldFrameGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#F7B500"/>
          <stop offset="50%" stop-color="#FDE68A"/>
          <stop offset="100%" stop-color="#996B1F"/>
        </linearGradient>
      </defs>

      <!-- Outer Navy Border -->
      <rect x="50" y="50" width="3408" height="2380" fill="none" stroke="#0A1628" stroke-width="6"/>
      <!-- Outer Gold Inset -->
      <rect x="66" y="66" width="3376" height="2348" fill="none" stroke="url(#goldFrameGrad)" stroke-width="2.5"/>

      <!-- 4-Sided Guilloche Wave Bands -->
      ${topGuilloche}
      ${bottomGuilloche}
      ${leftGuilloche}
      ${rightGuilloche}

      <!-- Inner Navy Inset -->
      <rect x="140" y="140" width="3228" height="2200" fill="none" stroke="#0A1628" stroke-width="2" stroke-opacity="0.7"/>
      <!-- Inner Gold Hairline -->
      <rect x="150" y="150" width="3208" height="2180" fill="none" stroke="#F7B500" stroke-width="1.2" stroke-opacity="0.9"/>

      <!-- Corner Guilloche Rosettes -->
      <path d="${rosetteNW}" fill="none" stroke="url(#goldFrameGrad)" stroke-width="1.2"/>
      <circle cx="180" cy="180" r="16" fill="#0A1628" stroke="#F7B500" stroke-width="3"/>

      <path d="${rosetteNE}" fill="none" stroke="url(#goldFrameGrad)" stroke-width="1.2"/>
      <circle cx="${3508 - 180}" cy="180" r="16" fill="#0A1628" stroke="#F7B500" stroke-width="3"/>

      <path d="${rosetteSW}" fill="none" stroke="url(#goldFrameGrad)" stroke-width="1.2"/>
      <circle cx="180" cy="${2480 - 180}" r="16" fill="#0A1628" stroke="#F7B500" stroke-width="3"/>

      <path d="${rosetteSE}" fill="none" stroke="url(#goldFrameGrad)" stroke-width="1.2"/>
      <circle cx="${3508 - 180}" cy="${2480 - 180}" r="16" fill="#0A1628" stroke="#F7B500" stroke-width="3"/>
    </svg>

    <!-- Content -->
    <div class="cert-content">
      <!-- Header -->
      <div>
        <div class="krg-super-header">حکومەتی هەرێمی کوردستان · KURDISTAN REGIONAL GOVERNMENT</div>
        <div class="official-logo-box">
          ${logoSvgRaw}
        </div>
        <div class="authority-name-ckb">دەستەی متمانەبەخشی بە پرۆگرامەکان و دامەزراوەکانی پەروەردە و خوێندنی باڵا</div>
        <div class="authority-name-en">Kurdistan Accrediting Association for Education</div>
      </div>

      <!-- Title of Award -->
      <div>
        <div class="cert-award-title-ckb">بڕوانامەی متمانەبەخشینی نیشتمانی</div>
        <div class="cert-award-title-en">National Institutional Accreditation Certificate</div>
      </div>

      <!-- Recipient Plinth -->
      <div>
        <div class="award-preamble">پاڵپشت بە بڕیاری دەستەی باڵا و بەپێی یاسای ژمارە (٦)ی ساڵی ٢٠٢٢، ئەم بڕوانامەیە دەبەخشرێت بە:</div>
        <div class="recipient-card">
          <div class="recipient-name-ckb">زانکۆی کوردستان - هەولێر (UKH)</div>
          <div class="recipient-name-en">University of Kurdistan Hewlêr</div>
          <div class="program-pill">کۆلێژی پزیشکی — متمانەبەخشی نیشتمانیی نایاب (Full Accreditation)</div>
        </div>
      </div>

      <!-- Legal Decree Statement -->
      <div class="decree-text-block">
        بەمەش سەرجەم مەرج و ستانداردە نیشتمانی و نێودەوڵەتییەکانی دڵنیایی جۆری لە بوارەکانی پڕۆگرامی ئەکادیمی، ستافی وانەبێژی، توێژینەوەی زانستی و بەڕێوەبردنی دامەزراوەیی بەپێی پێوەرەکانی کۆمسیۆنی خوێندنی باڵا (CHE) بە پلەی نایاب بەدەستهێناوە، و متمانەی فەرمیی دەستەی پێدەبەخشرێت بۆ ماوەی پێنج ساڵی ئەکادیمی.
      </div>

      <!-- Signatures & Seal -->
      <div class="footer-signatures-row">
        <!-- Right: Dr. Boushra Rahal (President of KAAE) -->
        <div class="signatory-column">
          <svg class="cursive-signature-svg" viewBox="0 0 340 100" xmlns="http://www.w3.org/2000/svg">
            <path d="M 30 70 Q 65 10 100 50 T 170 38 Q 200 15 225 60 T 280 42 Q 305 25 320 65" fill="none" stroke="#0A1628" stroke-width="3" stroke-linecap="round"/>
            <path d="M 75 55 Q 120 80 195 50 T 290 55" fill="none" stroke="#0A1628" stroke-width="2.5" stroke-linecap="round"/>
            <circle cx="305" cy="45" r="3.5" fill="#0A1628"/>
          </svg>
          <div class="sig-separator-line"></div>
          <div class="signatory-name">د. بوشرا ڕەحاڵ عەلامە · Dr. Boushra Rahal Alameh</div>
          <div class="signatory-title">سەرۆکی دەستەی متمانەبەخشی KAAE · President</div>
        </div>

        <!-- Center: 3D Embossed Seal -->
        <div class="seal-column">
          <div class="gold-seal-3d">
            <div class="seal-emblem-svg">
              ${symbolSvgRaw}
            </div>
          </div>
          <div class="ribbon-tails">
            <div class="ribbon-navy"></div>
            <div class="ribbon-gold"></div>
          </div>
          <div class="seal-caption">OFFICIAL SEAL · KAAE 2022/6</div>
        </div>

        <!-- Left: Prof. Dr. Alan Faraidun Ali (Chair of CHE) -->
        <div class="signatory-column">
          <svg class="cursive-signature-svg" viewBox="0 0 340 100" xmlns="http://www.w3.org/2000/svg">
            <path d="M 25 60 Q 55 15 90 45 T 155 28 Q 195 5 230 55 T 290 38 Q 315 22 325 55" fill="none" stroke="#0A1628" stroke-width="3" stroke-linecap="round"/>
            <path d="M 65 65 Q 130 42 215 70 T 300 48" fill="none" stroke="#0A1628" stroke-width="2.5" stroke-linecap="round"/>
            <circle cx="315" cy="52" r="3.5" fill="#0A1628"/>
          </svg>
          <div class="sig-separator-line"></div>
          <div class="signatory-name">پ. د. ئالان فەرەیدوون عەلی · Prof. Dr. Alan Faraidun Ali</div>
          <div class="signatory-title">سەرۆکی کۆمسیۆنی خوێندنی باڵا · Chair of Higher Education (CHE)</div>
        </div>
      </div>

      <!-- Sub-Footer -->
      <div class="security-metadata-footer">
        <div>ڕێکەوتی دەرچوون: <b>2026-09-06</b> · ماوەی بڕوانامە: <b>01-09-2025 تاوەکو 31-08-2030</b></div>
        <div class="matrix-serial">SERIAL: KAAE-CHE-2026-UKH-MED-00891</div>
        <div>پاڵپشت بە یاسای ژمارە <b>(٦)ی ساڵی ٢٠٢٢</b>ی پەرلەمانی کوردستان</div>
      </div>
    </div>
  </div>
</body>
</html>`;

const certPngPath = path.join(dirCerts, 'UKH_Accreditation_Certificate_A4.png');
renderHtmlToPng(certHtml, certPngPath, 3508, 2480, 1);
fs.writeFileSync(path.join(dirCerts, 'UKH_Accreditation_Certificate_A4.html'), certHtml);
console.log('✓ Master Certificate rendered successfully at 3508x2480 300DPI!');

// ============================================================================
// DESIGN 2: Official Social Feed Announcement (1080 x 1350)
// ============================================================================
console.log('2. Rendering Design 2: Official Social Feed Announcement (1080 x 1350)...');

const medalImageSrc = goldMedalBase64 ? `data:image/jpeg;base64,${goldMedalBase64}` : '';

const socialHtml = `<!DOCTYPE html>
<html lang="ckb" dir="rtl">
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Noto+Sans+Arabic:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 1080px;
    height: 1350px;
    overflow: hidden;
    background: #060B18;
    font-family: 'IBM Plex Sans Arabic', 'Noto Sans Arabic', sans-serif;
    color: #FFFFFF;
  }

  .canvas-wrapper {
    position: relative;
    width: 1080px;
    height: 1350px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 50px 54px 45px;
  }

  /* Clamped Background Elements */
  .bg-clip-layer {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    z-index: 1;
  }

  .ambient-glow {
    position: absolute;
    top: -100px;
    right: -100px;
    width: 600px;
    height: 600px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(212, 169, 76, 0.22) 0%, rgba(22, 8, 116, 0.15) 50%, transparent 70%);
    filter: blur(80px);
  }

  .ambient-glow-bottom {
    position: absolute;
    bottom: -100px;
    left: -100px;
    width: 600px;
    height: 600px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(14, 108, 211, 0.2) 0%, rgba(22, 8, 116, 0.25) 50%, transparent 70%);
    filter: blur(90px);
  }

  .bg-grid {
    position: absolute;
    inset: 0;
    background-image: 
      linear-gradient(rgba(71, 112, 163, 0.08) 1px, transparent 1px),
      linear-gradient(90deg, rgba(71, 112, 163, 0.08) 1px, transparent 1px);
    background-size: 36px 36px;
  }

  /* Content Wrapper */
  .content-layer {
    position: relative;
    z-index: 10;
    display: flex;
    flex-direction: column;
    height: 100%;
    justify-content: space-between;
  }

  /* Header Bar */
  .header-bar {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1.5px solid rgba(212, 169, 76, 0.35);
    padding-bottom: 20px;
  }

  .header-logo {
    width: 220px;
    height: 75px;
    filter: drop-shadow(0 4px 15px rgba(212, 169, 76, 0.25));
  }
  .header-logo svg {
    width: 100%;
    height: 100%;
  }

  .announcement-pill {
    background: rgba(212, 169, 76, 0.12);
    border: 1.5px solid #F7B500;
    border-radius: 30px;
    padding: 8px 24px;
    font-size: 15px;
    font-weight: 800;
    color: #FDE68A;
    display: flex;
    align-items: center;
    gap: 8px;
    box-shadow: 0 0 20px rgba(212, 169, 76, 0.2);
  }

  .pill-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #10B981;
    box-shadow: 0 0 8px #10B981;
  }

  /* Hero Section: 3D Emblem Medal + Title */
  .hero-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    margin-top: 5px;
  }

  .hero-medal-container {
    width: 160px;
    height: 160px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(212, 169, 76, 0.25) 0%, rgba(22, 8, 116, 0.4) 60%, transparent 80%);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 16px;
  }

  .hero-medal-img {
    width: 140px;
    height: 140px;
    border-radius: 50%;
    object-fit: cover;
    box-shadow: 
      0 12px 35px rgba(0,0,0,0.6),
      0 0 25px rgba(212, 169, 76, 0.4);
    border: 2px solid #F7B500;
  }

  .headline-main-1 {
    font-size: 44px;
    font-weight: 900;
    line-height: 1.25;
    color: #FFFFFF;
    letter-spacing: -0.5px;
    margin-bottom: 4px;
  }

  .headline-main-2 {
    font-size: 44px;
    font-weight: 900;
    line-height: 1.25;
    background: linear-gradient(135deg, #FFFBEB 0%, #FDE68A 30%, #F7B500 70%, #996B1F 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: -0.5px;
    margin-bottom: 10px;
  }

  .headline-en {
    font-size: 15px;
    font-weight: 800;
    letter-spacing: 3px;
    color: #94A3B8;
    text-transform: uppercase;
  }

  /* Frosted Glass Body Card */
  .glass-body-card {
    background: rgba(16, 24, 52, 0.8);
    backdrop-filter: blur(40px);
    -webkit-backdrop-filter: blur(40px);
    border: 1px solid rgba(212, 169, 76, 0.35);
    border-radius: 16px;
    padding: 26px 34px;
    box-shadow: 
      0 20px 50px rgba(0, 0, 0, 0.5),
      inset 0 1px 0 rgba(255, 255, 255, 0.15);
    margin: 10px 0;
  }

  .card-lead-text {
    font-size: 21px;
    font-weight: 600;
    line-height: 1.85;
    color: #E2E8F0;
    text-align: justify;
    text-align-last: right;
  }

  /* 3 Core Metric Pillar Cards */
  .pillars-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin-bottom: 10px;
  }

  .pillar-box {
    background: rgba(22, 8, 116, 0.5);
    backdrop-filter: blur(20px);
    border: 1px solid rgba(71, 112, 163, 0.4);
    border-radius: 12px;
    padding: 16px 12px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }

  .pillar-icon {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: rgba(212, 169, 76, 0.15);
    border: 1px solid #F7B500;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #FDE68A;
    font-size: 15px;
    font-weight: 900;
    margin-bottom: 6px;
  }

  .pillar-title-ckb {
    font-size: 17px;
    font-weight: 800;
    color: #F8FAFC;
    margin-bottom: 2px;
  }

  .pillar-title-en {
    font-size: 12px;
    font-weight: 600;
    color: #F7B500;
    letter-spacing: 0.5px;
  }

  /* Footer Bar */
  .footer-bar {
    border-top: 1px solid rgba(255, 255, 255, 0.15);
    padding-top: 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }

  .legal-decree-cite {
    font-size: 14px;
    font-weight: 700;
    color: #F7B500;
    letter-spacing: 0.5px;
  }

  .contact-channel-line {
    font-size: 13px;
    font-weight: 600;
    color: #64748B;
    letter-spacing: 1px;
  }
</style>
</head>
<body>
  <div class="canvas-wrapper">
    <div class="bg-clip-layer">
      <div class="ambient-glow"></div>
      <div class="ambient-glow-bottom"></div>
      <div class="bg-grid"></div>
    </div>

    <div class="content-layer">
      <!-- Top Header -->
      <div class="header-bar">
        <div class="header-logo">
          ${logoSvgRaw}
        </div>
        <div class="announcement-pill">
          <div class="pill-dot"></div>
          <span>ڕاگەیاندنی فەرمی · OFFICIAL ANNOUNCEMENT</span>
        </div>
      </div>

      <!-- Hero Title & Visual 3D Medal -->
      <div class="hero-section">
        <div class="hero-medal-container">
          ${medalImageSrc ? `<img class="hero-medal-img" src="${medalImageSrc}" alt="KAAE 3D Medal" />` : ''}
        </div>
        <div class="headline-main-1">دەستپێکردنی گەڕی نوێی متمانەبەخشین</div>
        <div class="headline-main-2">بە زانکۆکانی کوردستان بۆ ساڵی ٢٠٢٦</div>
        <div class="headline-en">KAAE Commences 2026 Higher Education Accreditation Cycle</div>
      </div>

      <!-- Frosted Glass Body Card -->
      <div class="glass-body-card">
        <div class="card-lead-text">
          دەستەی متمانەبەخشی بە پرۆگرامەکان و دامەزراوەکانی پەروەردە و خوێندنی باڵا لە هەرێمی کوردستان (KAAE) بەپێی یاسای ژمارە (٦)ی ساڵی ٢٠٢٢، دەرگای پێشکەشکردنی داواکاری بۆ گەڕی نوێی متمانەبەخشینی دامەزراوەیی و پڕۆگرامی بەڕووی سەرجەم زانکۆ حکومی و تایبەتەکان دەکاتەوە.
        </div>
      </div>

      <!-- 3 Core Feature Pillar Cards -->
      <div class="pillars-grid">
        <div class="pillar-box">
          <div class="pillar-icon">٧</div>
          <div class="pillar-title-ckb">پێوەری نێودەوڵەتی</div>
          <div class="pillar-title-en">7 Core Standards</div>
        </div>
        <div class="pillar-box">
          <div class="pillar-icon">✓</div>
          <div class="pillar-title-ckb">متمانەی پڕۆگرامەکان</div>
          <div class="pillar-title-en">Programmatic Audit</div>
        </div>
        <div class="pillar-box">
          <div class="pillar-icon">★</div>
          <div class="pillar-title-ckb">دڵنیایی جۆری نایاب</div>
          <div class="pillar-title-en">Institutional Review</div>
        </div>
      </div>

      <!-- Footer Bar -->
      <div class="footer-bar">
        <div class="legal-decree-cite">پاڵپشت بە یاسای ژمارە (٦)ی ساڵی ٢٠٢٢ی پەرلەمانی کوردستان</div>
        <div class="contact-channel-line">portal.kaae.org · info@kaae.org · Erbil, Kurdistan Region</div>
      </div>
    </div>
  </div>
</body>
</html>`;

const socialPngPath = path.join(dirSocial, 'KAAE_Commences_2026_Cycle_1080x1350.png');
renderHtmlToPng(socialHtml, socialPngPath, 1080, 1350, 1);
fs.writeFileSync(path.join(dirSocial, 'KAAE_Commences_2026_Cycle_1080x1350.html'), socialHtml);
console.log('✓ Master Social Announcement rendered successfully at 1080x1350!');

// ============================================================================
// DESIGN 3: Presidential Executive Statement (1080 x 1080)
// ============================================================================
console.log('3. Rendering Design 3: Presidential Executive Statement (1080 x 1080)...');

const quoteHtml = `<!DOCTYPE html>
<html lang="ckb" dir="rtl">
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Noto+Sans+Arabic:wght@400;500;600;700&family=Crimson+Pro:wght@400;600;700;800;900&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 1080px;
    height: 1080px;
    overflow: hidden;
    background: #050814;
    font-family: 'IBM Plex Sans Arabic', 'Noto Sans Arabic', sans-serif;
    color: #FFFFFF;
  }

  .canvas-container {
    position: relative;
    width: 1080px;
    height: 1080px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 55px 70px 45px;
  }

  /* Outer Double Gold Filigree Border */
  .filigree-frame {
    position: absolute;
    inset: 24px;
    border: 1.5px solid rgba(212, 169, 76, 0.45);
    border-radius: 4px;
    pointer-events: none;
    z-index: 2;
  }
  .filigree-frame::before {
    content: '';
    position: absolute;
    inset: 8px;
    border: 1px solid rgba(212, 169, 76, 0.2);
  }

  /* Watermark Quote & Sun */
  .bg-decorations {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    z-index: 1;
  }

  .bg-quote-watermark {
    position: absolute;
    top: 40%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 380px;
    font-family: 'Crimson Pro', serif;
    color: #F7B500;
    opacity: 0.04;
    line-height: 1;
  }

  .bg-sun-watermark {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 600px;
    height: 600px;
    opacity: 0.03;
  }

  /* Content Box */
  .content-box {
    position: relative;
    z-index: 10;
    display: flex;
    flex-direction: column;
    height: 100%;
    justify-content: space-between;
  }

  /* Header */
  .header-deck {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
  }

  .header-crest {
    width: 140px;
    height: 65px;
    filter: drop-shadow(0 4px 15px rgba(212, 169, 76, 0.3));
  }
  .header-crest svg {
    width: 100%;
    height: 100%;
  }

  .decree-pill {
    background: rgba(212, 169, 76, 0.12);
    border: 1.5px solid #F7B500;
    border-radius: 30px;
    padding: 6px 26px;
    font-size: 15px;
    font-weight: 800;
    color: #FDE68A;
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  /* Quote Centerpiece */
  .quote-centerpiece {
    text-align: center;
    padding: 0 10px;
  }

  .gold-quote-mark {
    font-family: 'Crimson Pro', serif;
    font-size: 74px;
    line-height: 0.8;
    color: #F7B500;
    margin-bottom: 14px;
    filter: drop-shadow(0 4px 10px rgba(212,169,76,0.3));
  }

  .statement-quote-ckb {
    font-size: 35px;
    font-weight: 800;
    line-height: 1.85;
    color: #F8FAFC;
    letter-spacing: -0.5px;
    text-shadow: 0 4px 20px rgba(0,0,0,0.6);
  }

  .statement-quote-ckb span {
    color: #FDE68A;
  }

  /* Attribution & Executive Plinth */
  .attribution-plinth {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .executive-signature-svg {
    width: 260px;
    height: 70px;
    margin-bottom: 2px;
  }

  .gold-divider-ornament {
    width: 380px;
    height: 2px;
    background: linear-gradient(90deg, transparent, #F7B500, transparent);
    margin-bottom: 8px;
    position: relative;
  }
  .gold-divider-ornament::after {
    content: '◆';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: #F7B500;
    font-size: 11px;
    background: #050814;
    padding: 0 8px;
  }

  .author-name-ckb {
    font-size: 32px;
    font-weight: 800;
    background: linear-gradient(135deg, #FFFFFF 0%, #FDE68A 50%, #F7B500 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 3px;
  }

  .author-title-ckb {
    font-size: 19px;
    font-weight: 700;
    color: #CBD5E1;
    margin-bottom: 2px;
  }

  .author-title-en {
    font-size: 14px;
    font-weight: 600;
    color: #94A3B8;
    letter-spacing: 0.5px;
  }

  .bottom-legal-line {
    font-size: 13px;
    font-weight: 600;
    color: #64748B;
    letter-spacing: 1px;
    margin-top: 10px;
  }
</style>
</head>
<body>
  <div class="canvas-container">
    <div class="filigree-frame"></div>
    <div class="bg-decorations">
      <div class="bg-quote-watermark">“</div>
      <div class="bg-sun-watermark">${symbolSvgRaw}</div>
    </div>

    <div class="content-box">
      <!-- Header Deck -->
      <div class="header-deck">
        <div class="header-crest">
          ${logoSvgRaw}
        </div>
        <div class="decree-pill">پەیامی سەرۆکی دەستە · OFFICIAL PRESIDENTIAL DECREE</div>
      </div>

      <!-- The Statement -->
      <div class="quote-centerpiece">
        <div class="gold-quote-mark">“</div>
        <div class="statement-quote-ckb">
          «متمانەبەخشینی نیشتمانی هەنگاوێکی ستراتیژییە بۆ بەرزکردنەوەی ئاستی زانستی و هاوتاکردنی کواڵیتیی خوێندنی باڵای هەرێمی کوردستان لەگەڵ <span>پێوەر و ستانداردە نێودەوڵەتییەکان</span>.»
        </div>
      </div>

      <!-- Executive Signatory Plinth -->
      <div class="attribution-plinth">
        <svg class="executive-signature-svg" viewBox="0 0 260 70" xmlns="http://www.w3.org/2000/svg">
          <path d="M 20 50 Q 50 10 80 40 T 130 30 Q 160 10 180 45 T 220 35 Q 240 20 250 48" fill="none" stroke="#F7B500" stroke-width="2.5" stroke-linecap="round"/>
          <path d="M 50 45 Q 90 65 150 42 T 230 45" fill="none" stroke="#F7B500" stroke-width="2" stroke-linecap="round"/>
          <circle cx="240" cy="38" r="2.5" fill="#F7B500"/>
        </svg>
        <div class="gold-divider-ornament"></div>
        <div class="author-name-ckb">د. بوشرا ڕەحاڵ عەلامە · Dr. Boushra Rahal Alameh</div>
        <div class="author-title-ckb">سەرۆکی دەستەی متمانەبەخشی بە پرۆگرامەکان و دامەزراوەکانی پەروەردە و خوێندنی باڵا</div>
        <div class="author-title-en">President, Kurdistan Accrediting Association for Education (KAAE)</div>
        <div class="bottom-legal-line">بەپێی یاسای ژمارە (٦)ی ساڵی ٢٠٢٢ی پەرلەمانی کوردستان · www.kaae.org</div>
      </div>
    </div>
  </div>
</body>
</html>`;

const quotePngPath = path.join(dirQuote, 'Dr_Boushra_President_Statement_1080x1080.png');
renderHtmlToPng(quoteHtml, quotePngPath, 1080, 1080, 1);
fs.writeFileSync(path.join(dirQuote, 'Dr_Boushra_President_Statement_1080x1080.html'), quoteHtml);
console.log('✓ Master Executive Statement rendered successfully at 1080x1080!');

// ============================================================================
// DESIGN 4: National Quality Summit Stage Banner (1920 x 1080 Widescreen)
// ============================================================================
console.log('4. Rendering Design 4: National Quality Summit Stage Banner (1920 x 1080)...');

const stageImageSrc = stageTextureBase64 ? `data:image/jpeg;base64,${stageTextureBase64}` : '';

const bannerHtml = `<!DOCTYPE html>
<html lang="ckb" dir="rtl">
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Noto+Sans+Arabic:wght@400;500;600;700&family=Crimson+Pro:wght@400;600;700;800;900&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 1920px;
    height: 1080px;
    overflow: hidden;
    background: #060B18;
    font-family: 'IBM Plex Sans Arabic', 'Noto Sans Arabic', sans-serif;
    color: #FFFFFF;
  }

  .banner-container {
    position: relative;
    width: 1920px;
    height: 1080px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 50px 80px 45px;
  }

  /* Cinematic Stage Lighting Texture Backdrop */
  .stage-bg-image {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0.7;
    z-index: 1;
  }

  /* Vignette & Contrast Overlay */
  .stage-vignette {
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse at 50% 45%, rgba(6, 11, 24, 0.35) 0%, rgba(6, 11, 24, 0.85) 75%, #04070F 100%);
    z-index: 2;
    pointer-events: none;
  }

  /* Stage Spotlights */
  .spotlight-left {
    position: absolute;
    top: -100px;
    left: 20%;
    width: 500px;
    height: 800px;
    background: linear-gradient(180deg, rgba(212, 169, 76, 0.18) 0%, transparent 80%);
    transform: rotate(25deg);
    filter: blur(60px);
    z-index: 3;
    pointer-events: none;
  }

  .spotlight-right {
    position: absolute;
    top: -100px;
    right: 20%;
    width: 500px;
    height: 800px;
    background: linear-gradient(180deg, rgba(14, 108, 211, 0.18) 0%, transparent 80%);
    transform: rotate(-25deg);
    filter: blur(60px);
    z-index: 3;
    pointer-events: none;
  }

  /* Content Wrapper */
  .stage-content {
    position: relative;
    z-index: 10;
    display: flex;
    flex-direction: column;
    height: 100%;
    justify-content: space-between;
    align-items: center;
    text-align: center;
  }

  /* Top Auspices & Patronage Ribbon */
  .patronage-ribbon {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: 2px;
    color: #FDE68A;
    background: rgba(22, 8, 116, 0.65);
    border: 1px solid rgba(212, 169, 76, 0.4);
    border-radius: 40px;
    padding: 8px 38px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    text-shadow: 0 2px 4px rgba(0,0,0,0.8);
  }

  /* Central Keynote Deck */
  .keynote-deck {
    display: flex;
    flex-direction: column;
    align-items: center;
    max-width: 1750px;
  }

  .stage-emblem {
    width: 250px;
    height: 105px;
    filter: drop-shadow(0 0 35px rgba(212, 169, 76, 0.5));
    margin-bottom: 16px;
  }
  .stage-emblem svg {
    width: 100%;
    height: 100%;
  }

  .summit-badge {
    background: rgba(212, 169, 76, 0.15);
    border: 2px solid #F7B500;
    border-radius: 40px;
    padding: 8px 34px;
    font-size: 18px;
    font-weight: 900;
    color: #FFFBEB;
    letter-spacing: 2px;
    margin-bottom: 18px;
    box-shadow: 0 0 25px rgba(212, 169, 76, 0.35);
  }

  .stage-headline-ckb {
    font-size: 68px;
    font-weight: 900;
    line-height: 1.25;
    color: #FFFFFF;
    letter-spacing: -1px;
    margin-bottom: 14px;
    text-shadow: 
      0 10px 30px rgba(0,0,0,0.9),
      0 2px 10px rgba(212, 169, 76, 0.4);
  }

  .stage-headline-en {
    font-family: 'Crimson Pro', serif;
    font-size: 26px;
    font-weight: 800;
    letter-spacing: 6px;
    color: #FDE68A;
    text-transform: uppercase;
    text-shadow: 0 4px 15px rgba(0,0,0,0.8);
  }

  /* Venue & Date Glass Plinth */
  .venue-glass-plinth {
    background: rgba(10, 20, 48, 0.75);
    backdrop-filter: blur(30px);
    -webkit-backdrop-filter: blur(30px);
    border: 1.5px solid rgba(212, 169, 76, 0.45);
    border-radius: 50px;
    padding: 16px 64px;
    box-shadow: 
      0 15px 40px rgba(0,0,0,0.6),
      0 0 35px rgba(212, 169, 76, 0.25);
    display: flex;
    align-items: center;
    gap: 26px;
    font-size: 23px;
    font-weight: 800;
    color: #F8FAFC;
  }

  .plinth-separator {
    color: #F7B500;
    font-size: 24px;
  }

  /* Sub-Footer High Council Citation */
  .high-council-bar {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1px solid rgba(212, 169, 76, 0.25);
    padding-top: 14px;
    font-size: 16px;
    font-weight: 700;
    color: #94A3B8;
  }
  .high-council-bar b {
    color: #F7B500;
  }
</style>
</head>
<body>
  <div class="banner-container">
    ${stageImageSrc ? `<img class="stage-bg-image" src="${stageImageSrc}" alt="Stage Texture" />` : ''}
    <div class="stage-vignette"></div>
    <div class="spotlight-left"></div>
    <div class="spotlight-right"></div>

    <div class="stage-content">
      <!-- Auspices Header -->
      <div class="patronage-ribbon">
        بە چاودێریی ڕێزدار مەسرور بارزانی، سەرۆکی حکومەتی هەرێمی کوردستان · UNDER THE AUSPICES OF THE KRG PRIME MINISTER
      </div>

      <!-- Main Stage Centerpiece -->
      <div class="keynote-deck">
        <div class="stage-emblem">
          ${logoSvgRaw}
        </div>
        <div class="summit-badge">NATIONAL QUALITY SUMMIT 2026 · لوتکەی نیشتمانیی کواڵیتی</div>
        <div class="stage-headline-ckb">
          کۆنفرانسی نیشتمانی بۆ بەرزکردنەوەی کواڵیتی و متمانەبەخشین بە زانکۆکانی کوردستان
        </div>
        <div class="stage-headline-en">
          National Summit on Higher Education Quality Assurance & Accreditation Standards
        </div>
      </div>

      <!-- Venue & Date Glass Plinth -->
      <div class="venue-glass-plinth">
        <span>هۆڵی نێودەوڵەتیی سەعد عەبدوڵڵا - هەولێر</span>
        <span class="plinth-separator">◆</span>
        <span>Erbil International Convention Center</span>
        <span class="plinth-separator">◆</span>
        <span>١٥ - ١٦ی شوباتی ٢٠٢٦</span>
      </div>

      <!-- High Council Footer -->
      <div class="high-council-bar">
        <div>حکومەتی هەرێمی کوردستان · دەستەی باڵای متمانەبەخشین</div>
        <div>پاڵپشت بە <b>یاسای ژمارە (٦)ی ساڵی ٢٠٢٢</b>ی پەرلەمانی کوردستان</div>
        <div>KAAE · Commission on Higher Education (CHE)</div>
      </div>
    </div>
  </div>
</body>
</html>`;

const bannerPngPath = path.join(dirBanner, 'KAAE_National_Quality_Summit_2026_1920x1080.png');
renderHtmlToPng(bannerHtml, bannerPngPath, 1920, 1080, 1);
fs.writeFileSync(path.join(dirBanner, 'KAAE_National_Quality_Summit_2026_1920x1080.html'), bannerHtml);
console.log('✓ Master Stage Banner rendered successfully at 1920x1080!');

console.log('\n=== ALL 4 DESIGNS PRODUCED WITH TRUE 10/10 AGENCY FIDELITY! ===');
