import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'exports', 'PRO_DESIGNER_SHOWCASE');
const artifactDir = '/Users/hawzhin/.gemini/antigravity-ide/brain/f738476c-113b-44dd-963c-7ffa81ef121f/showcase';
const tmpDir = path.join(rootDir, '.tmp_pro_render');

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(artifactDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function renderHtml(html: string, outPng: string, width: number, height: number, scale: number = 1) {
  const tmpHtml = path.join(tmpDir, `render_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.html`);
  fs.writeFileSync(tmpHtml, html, 'utf8');
  const cmd = `"${chromePath}" --headless=new --screenshot="${outPng}" --window-size=${width},${height} --force-device-scale-factor=${scale} --virtual-time-budget=4000 --hide-scrollbars "file://${tmpHtml}"`;
  execSync(cmd, { stdio: 'ignore' });
  try { fs.unlinkSync(tmpHtml); } catch {}
}

console.log('🎨 Generating Pro Designer Showcase (English First, World-Class Studio Aesthetics)...');

// ============================================================================
// 1. SILICON VALLEY DARK MODE TECH PRODUCT LAUNCH POSTER (1080 x 1350)
// Archetype: Linear / Vercel / Apple Pro / Teenage Engineering
// ============================================================================
const design1_TechPoster = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Synapse OS — Vector Creative Engine</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 1080px;
      height: 1350px;
      background-color: #060709;
      color: #FFFFFF;
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 72px;
    }
    
    /* Background Ambience & Engineering Grid */
    .bg-grid {
      position: absolute;
      inset: 0;
      background-image: 
        linear-gradient(to right, rgba(255, 255, 255, 0.035) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
      background-size: 48px 48px;
      pointer-events: none;
    }
    .bg-radial-1 {
      position: absolute;
      top: -150px;
      right: -150px;
      width: 750px;
      height: 750px;
      background: radial-gradient(circle, rgba(99, 102, 241, 0.28) 0%, rgba(59, 130, 246, 0.12) 40%, transparent 70%);
      filter: blur(60px);
      pointer-events: none;
    }
    .bg-radial-2 {
      position: absolute;
      bottom: 50px;
      left: -120px;
      width: 600px;
      height: 600px;
      background: radial-gradient(circle, rgba(16, 185, 129, 0.15) 0%, rgba(6, 182, 212, 0.08) 50%, transparent 70%);
      filter: blur(70px);
      pointer-events: none;
    }

    /* Top Navigation Header */
    .header {
      position: relative;
      z-index: 10;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 28px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .logo-mark {
      width: 38px;
      height: 38px;
      border-radius: 10px;
      background: linear-gradient(135deg, #6366F1, #3B82F6);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 20px rgba(99, 102, 241, 0.5);
    }
    .logo-mark svg { width: 22px; height: 22px; fill: white; }
    .brand-title {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #F8FAFC;
    }
    .status-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 8px 16px;
      border-radius: 100px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: #94A3B8;
      backdrop-filter: blur(12px);
    }
    .pulse-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #10B981;
      box-shadow: 0 0 10px #10B981;
    }

    /* Hero Headline Zone */
    .hero-zone {
      position: relative;
      z-index: 10;
      margin-top: 40px;
    }
    .category-tag {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #818CF8;
      margin-bottom: 18px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .category-tag::before {
      content: "";
      display: inline-block;
      width: 18px;
      height: 2px;
      background: #818CF8;
    }
    .main-headline {
      font-size: 68px;
      font-weight: 800;
      line-height: 1.05;
      letter-spacing: -0.04em;
      background: linear-gradient(180deg, #FFFFFF 20%, #CBD5E1 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 22px;
    }
    .sub-headline {
      font-size: 20px;
      font-weight: 400;
      line-height: 1.55;
      color: #94A3B8;
      max-width: 780px;
      letter-spacing: -0.01em;
    }

    /* Floating Masterpiece UI Glass Card */
    .glass-stage {
      position: relative;
      z-index: 10;
      margin: 36px 0;
      background: rgba(15, 19, 32, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 24px;
      padding: 32px 36px;
      backdrop-filter: blur(40px);
      box-shadow: 
        0 40px 100px -20px rgba(0, 0, 0, 0.85),
        0 0 60px -10px rgba(99, 102, 241, 0.2),
        inset 0 1px 0 rgba(255, 255, 255, 0.15);
    }
    .glass-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .window-controls {
      display: flex;
      gap: 8px;
    }
    .dot { width: 10px; height: 10px; border-radius: 50%; }
    .dot.red { background: #EF4444; }
    .dot.yellow { background: #F59E0B; }
    .dot.green { background: #10B981; }
    .file-tab {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      color: #94A3B8;
      background: rgba(255, 255, 255, 0.05);
      padding: 4px 14px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }

    /* Vector Wave Visualization inside Card */
    .vector-viz {
      width: 100%;
      height: 180px;
      background: rgba(9, 12, 20, 0.8);
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      position: relative;
      overflow: hidden;
      margin-bottom: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .wave-svg {
      width: 100%;
      height: 100%;
    }

    /* Card Telemetry Row */
    .telemetry-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
    }
    .telemetry-item {
      background: rgba(255, 255, 255, 0.025);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 14px;
      padding: 16px 18px;
    }
    .telem-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: #64748B;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 6px;
    }
    .telem-value {
      font-size: 20px;
      font-weight: 700;
      color: #F8FAFC;
      letter-spacing: -0.02em;
    }
    .telem-value.accent { color: #38BDF8; }
    .telem-value.green { color: #34D399; }

    /* Bottom Information Columns */
    .footer-bar {
      position: relative;
      z-index: 10;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 32px;
      padding-top: 32px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    .col-title {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #818CF8;
      margin-bottom: 8px;
    }
    .col-desc {
      font-size: 14px;
      color: #94A3B8;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="bg-grid"></div>
  <div class="bg-radial-1"></div>
  <div class="bg-radial-2"></div>

  <!-- Header -->
  <header class="header">
    <div class="brand">
      <div class="logo-mark">
        <svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
      </div>
      <span class="brand-title">HAWA STUDIO // RUNTIME OS</span>
    </div>
    <div class="status-badge">
      <span class="pulse-dot"></span>
      <span>ENGINE 3.8 ONLINE // PRO GRADE</span>
    </div>
  </header>

  <!-- Hero Zone -->
  <div class="hero-zone">
    <div class="category-tag">Autonomous Vector Graphics</div>
    <h1 class="main-headline">Precision at scale.<br>Zero degradation.</h1>
    <p class="sub-headline">
      Pure declarative scene-graphs compiled natively into resolution-independent vectors. Built for modern software companies who refuse to compromise on craft.
    </p>
  </div>

  <!-- Floating Glass Telemetry Card -->
  <div class="glass-stage">
    <div class="glass-header">
      <div class="window-controls">
        <div class="dot red"></div>
        <div class="dot yellow"></div>
        <div class="dot green"></div>
      </div>
      <div class="file-tab">engine.kernel.canvas.ts</div>
      <div style="font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #64748B;">SHA256: e8f94...</div>
    </div>

    <!-- Vector Audio / Harmonic Wave Display -->
    <div class="vector-viz">
      <svg class="wave-svg" viewBox="0 0 900 180" preserveAspectRatio="none">
        <defs>
          <linearGradient id="waveGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#6366F1" stop-opacity="0.8"/>
            <stop offset="50%" stop-color="#38BDF8" stop-opacity="0.9"/>
            <stop offset="100%" stop-color="#10B981" stop-opacity="0.8"/>
          </linearGradient>
          <linearGradient id="fillGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#38BDF8" stop-opacity="0.25"/>
            <stop offset="100%" stop-color="#090C14" stop-opacity="0.0"/>
          </linearGradient>
        </defs>
        <path d="M0,90 Q150,10 300,90 T600,90 T900,90 L900,180 L0,180 Z" fill="url(#fillGrad)"/>
        <path d="M0,90 Q150,10 300,90 T600,90 T900,90" fill="none" stroke="url(#waveGrad)" stroke-width="3"/>
        <path d="M0,90 Q180,160 360,90 T720,90 T900,90" fill="none" stroke="#6366F1" stroke-width="1.5" stroke-opacity="0.4" stroke-dasharray="4 4"/>
      </svg>
    </div>

    <!-- Telemetry Badges -->
    <div class="telemetry-row">
      <div class="telemetry-item">
        <div class="telem-label">Render Latency</div>
        <div class="telem-value green">4.2 ms</div>
      </div>
      <div class="telemetry-item">
        <div class="telem-label">Fidelity</div>
        <div class="telem-value accent">300 DPI</div>
      </div>
      <div class="telemetry-item">
        <div class="telem-label">Raster Drift</div>
        <div class="telem-value">0.00%</div>
      </div>
      <div class="telemetry-item">
        <div class="telem-label">Pipeline</div>
        <div class="telem-value">Lossless</div>
      </div>
    </div>
  </div>

  <!-- Bottom Spec Footers -->
  <footer class="footer-bar">
    <div>
      <div class="col-title">01 / DETERMINISTIC</div>
      <p class="col-desc">Bit-for-bit reproducible canvas states across all desktop and cloud workers.</p>
    </div>
    <div>
      <div class="col-title">02 / MULTI-SURFACE</div>
      <p class="col-desc">Simultaneous one-shot compilation to SVG, HTML5 Canvas, WebGL, and 300 DPI CMYK.</p>
    </div>
    <div>
      <div class="col-title">03 / STUDIO-READY</div>
      <p class="col-desc">Designed strictly for senior brand directors and software product engineers.</p>
    </div>
  </footer>
</body>
</html>`;

// ============================================================================
// 2. SWISS INTERNATIONAL MINIMALIST EDITORIAL POSTER (A4 3508 x 2480 - 300 DPI)
// Archetype: Josef Müller-Brockmann / Massimo Vignelli / Pentagram / Zurich
// ============================================================================
const design2_SwissPoster = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>International Typographic Grid — Swiss Style</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 3508px;
      height: 2480px;
      background-color: #F6F5F2;
      color: #111111;
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      position: relative;
      overflow: hidden;
      padding: 140px 180px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }

    /* Swiss Modular Hairlines and Registration Crosshairs */
    .crosshair {
      position: absolute;
      font-family: 'JetBrains Mono', monospace;
      font-size: 24px;
      color: #999999;
      line-height: 1;
    }
    .ch-tl { top: 60px; left: 60px; }
    .ch-tr { top: 60px; right: 60px; }
    .ch-bl { bottom: 60px; left: 60px; }
    .ch-br { bottom: 60px; right: 60px; }

    /* Top Metadata Masthead */
    .masthead {
      display: grid;
      grid-template-columns: 2fr 1fr 1fr 1fr;
      gap: 60px;
      border-bottom: 4px solid #111111;
      padding-bottom: 40px;
    }
    .mast-title {
      font-size: 32px;
      font-weight: 800;
      letter-spacing: -0.02em;
      text-transform: uppercase;
    }
    .mast-meta {
      font-family: 'JetBrains Mono', monospace;
      font-size: 22px;
      line-height: 1.6;
      color: #555555;
    }
    .mast-meta strong {
      color: #111111;
      font-weight: 700;
    }

    /* Main Grid & Massive Typography Zone */
    .main-body {
      display: grid;
      grid-template-columns: 1.4fr 1fr;
      gap: 120px;
      align-items: center;
      margin: 80px 0;
    }

    .headline-column {
      display: flex;
      flex-direction: column;
    }
    .numeral-tag {
      font-family: 'JetBrains Mono', monospace;
      font-size: 40px;
      font-weight: 700;
      color: #FF3B00; /* International Swiss Vermilion Orange */
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      gap: 20px;
    }
    .numeral-tag::after {
      content: "";
      flex: 1;
      height: 3px;
      background: #FF3B00;
    }
    .giant-headline {
      font-size: 152px;
      font-weight: 900;
      line-height: 0.94;
      letter-spacing: -0.05em;
      color: #111111;
      text-transform: uppercase;
      margin-bottom: 60px;
    }
    .lead-paragraph {
      font-size: 38px;
      font-weight: 500;
      line-height: 1.45;
      color: #333333;
      letter-spacing: -0.02em;
      max-width: 1400px;
    }

    /* Visual Architectural Composition on Right */
    .composition-column {
      position: relative;
      height: 1000px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
    }
    .swiss-circle {
      width: 720px;
      height: 720px;
      border-radius: 50%;
      background: #FF3B00;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 40px 100px rgba(255, 59, 0, 0.25);
    }
    .swiss-cutout {
      width: 480px;
      height: 480px;
      background: #111111;
      border-radius: 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 60px;
      color: white;
    }
    .cutout-top {
      font-family: 'JetBrains Mono', monospace;
      font-size: 24px;
      color: #FF3B00;
      font-weight: 700;
    }
    .cutout-bottom {
      font-size: 42px;
      font-weight: 800;
      letter-spacing: -0.03em;
      line-height: 1.1;
    }

    /* Footer Information Ledger */
    .footer-ledger {
      border-top: 2px solid #CCCCCC;
      padding-top: 40px;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 60px;
    }
    .ledger-col h4 {
      font-family: 'JetBrains Mono', monospace;
      font-size: 22px;
      color: #FF3B00;
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .ledger-col p {
      font-size: 26px;
      line-height: 1.5;
      color: #444444;
      font-weight: 500;
    }
  </style>
</head>
<body>
  <div class="crosshair ch-tl">+ 001.A4</div>
  <div class="crosshair ch-tr">+ 300.DPI</div>
  <div class="crosshair ch-bl">+ 53°20'N</div>
  <div class="crosshair ch-br">+ 08°31'E</div>

  <!-- Masthead -->
  <div class="masthead">
    <div class="mast-title">HAWA STUDIO // ARCHIVE NO. 26</div>
    <div class="mast-meta">
      <strong>SYSTEM</strong><br>
      International Typographic
    </div>
    <div class="mast-meta">
      <strong>STANDARD</strong><br>
      DIN EN ISO 216 / A4
    </div>
    <div class="mast-meta">
      <strong>COMPILATION</strong><br>
      Pure Vector Determinism
    </div>
  </div>

  <!-- Main Body -->
  <div class="main-body">
    <div class="headline-column">
      <div class="numeral-tag">SERIES 04 · MODULAR MANIFESTO</div>
      <h1 class="giant-headline">Form<br>Follows<br>Integrity.</h1>
      <p class="lead-paragraph">
        Design is neither decoration nor casual arrangement. It is the disciplined organization of communicative space. By reducing visual noise to mathematical absolute truths, clarity becomes inevitable.
      </p>
    </div>

    <div class="composition-column">
      <div class="swiss-circle">
        <div class="swiss-cutout">
          <div class="cutout-top">RATIO 1:1.414</div>
          <div class="cutout-bottom">Pure<br>Geometric<br>Tension.</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Footer Ledger -->
  <div class="footer-ledger">
    <div class="ledger-col">
      <h4>Grid Logic</h4>
      <p>12-column baseline grid with micro-hairline gutters and absolute vertical rhythm.</p>
    </div>
    <div class="ledger-col">
      <h4>Typography</h4>
      <p>Plus Jakarta Grotesk paired with calibrated monospaced engineering telemetry.</p>
    </div>
    <div class="ledger-col">
      <h4>Chromatic System</h4>
      <p>High-contrast bone white, pitch ink, and authentic Swiss vermilion signal accent.</p>
    </div>
    <div class="ledger-col">
      <h4>Execution</h4>
      <p>Authored in Hawa Creative OS. Rendered natively at 3508 × 2480 300 DPI.</p>
    </div>
  </div>
</body>
</html>`;

// ============================================================================
// 3. LUXURY EDITORIAL / ATELIER LOOKBOOK STATEMENT (1080 x 1080)
// Archetype: Céline / Aesop / Kinfolk / Vogue / Monocle
// ============================================================================
const design3_LuxuryStatement = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Atelier Vendôme — The Architecture of Light</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Plus+Jakarta+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 1080px;
      height: 1080px;
      background-color: #0D0E11;
      color: #E6E4DD;
      font-family: 'Plus Jakarta Sans', sans-serif;
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 80px 88px;
    }

    /* Ambient Warm Gold Illumination */
    .ambient-glow {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 600px;
      height: 600px;
      background: radial-gradient(circle, rgba(200, 168, 130, 0.08) 0%, transparent 65%);
      filter: blur(80px);
      pointer-events: none;
    }

    /* Hairline Luxury Framing */
    .frame-border {
      position: absolute;
      top: 40px;
      left: 40px;
      right: 40px;
      bottom: 40px;
      border: 1px solid rgba(230, 228, 221, 0.08);
      pointer-events: none;
    }

    /* Masthead */
    .masthead {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      border-bottom: 1px solid rgba(230, 228, 221, 0.12);
      padding-bottom: 24px;
      position: relative;
      z-index: 5;
    }
    .edition-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: #C8A882;
    }
    .atelier-name {
      font-size: 13px;
      font-weight: 500;
      letter-spacing: 0.28em;
      text-transform: uppercase;
      color: #E6E4DD;
    }

    /* Quote / Center Editorial Core */
    .quote-block {
      position: relative;
      z-index: 5;
      max-width: 860px;
      margin: 40px 0;
    }
    .quote-mark {
      font-family: 'Instrument Serif', serif;
      font-size: 90px;
      line-height: 0.5;
      color: #C8A882;
      margin-bottom: 20px;
      display: block;
      opacity: 0.85;
    }
    .quote-text {
      font-family: 'Instrument Serif', serif;
      font-style: italic;
      font-size: 58px;
      line-height: 1.18;
      color: #FAF8F5;
      letter-spacing: -0.01em;
      margin-bottom: 32px;
    }
    .manifesto-body {
      font-size: 15px;
      font-weight: 300;
      line-height: 1.8;
      color: #A3A199;
      letter-spacing: 0.02em;
      max-width: 640px;
    }

    /* Minimalist Seal & Sign-off */
    .seal-row {
      position: relative;
      z-index: 5;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      border-top: 1px solid rgba(230, 228, 221, 0.12);
      padding-top: 28px;
    }
    .founder-credit {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .founder-name {
      font-size: 16px;
      font-weight: 600;
      letter-spacing: 0.05em;
      color: #FFFFFF;
    }
    .founder-role {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      letter-spacing: 0.14em;
      color: #8C8A82;
      text-transform: uppercase;
    }

    .monogram-seal {
      width: 54px;
      height: 54px;
      border: 1px solid #C8A882;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #C8A882;
      font-family: 'Instrument Serif', serif;
      font-size: 22px;
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="ambient-glow"></div>
  <div class="frame-border"></div>

  <!-- Top Masthead -->
  <header class="masthead">
    <span class="edition-label">VOL. IV · MONOGRAPH 12</span>
    <span class="atelier-name">ATELIER VENDÔME // PARIS</span>
  </header>

  <!-- Editorial Statement -->
  <div class="quote-block">
    <span class="quote-mark">“</span>
    <h2 class="quote-text">
      True luxury is never excessive. It is the quiet courage to leave beauty undisturbed.
    </h2>
    <p class="manifesto-body">
      When every extraneous layer is stripped away, what endures is pure proportion, immaculate material tension, and the sovereign weight of intentional space.
    </p>
  </div>

  <!-- Sign-off & Seal -->
  <footer class="seal-row">
    <div class="founder-credit">
      <div class="founder-name">Hawa Design Research Institute</div>
      <div class="founder-role">Autumn / Winter Monograph · Limited Archive No. 0842</div>
    </div>
    <div class="monogram-seal">H</div>
  </footer>
</body>
</html>`;

// ============================================================================
// 4. GLOBAL TECH SUMMIT / MAIN STAGE KEYNOTE IDENTITY (1920 x 1080 - 16:9)
// Archetype: Apple WWDC / Figma Config / Stripe Sessions / Semi Permanent
// ============================================================================
const design4_SummitKeynote = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Apex 2026 — Global Design & Intelligence Forum</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 1920px;
      height: 1080px;
      background-color: #030712;
      color: #FFFFFF;
      font-family: 'Plus Jakarta Sans', sans-serif;
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 72px 96px;
    }

    /* Flowing Volumetric Chromatic Aurora Ribbon */
    .aurora-container {
      position: absolute;
      top: -200px;
      right: -200px;
      width: 1400px;
      height: 1400px;
      background: radial-gradient(circle at 60% 40%, 
        rgba(236, 72, 153, 0.22) 0%, 
        rgba(139, 92, 246, 0.28) 25%, 
        rgba(6, 182, 212, 0.18) 50%, 
        transparent 70%);
      filter: blur(90px);
      pointer-events: none;
    }

    /* Ambient Subtle Grid */
    .subtle-grid {
      position: absolute;
      inset: 0;
      background-image: 
        linear-gradient(to right, rgba(255, 255, 255, 0.02) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(255, 255, 255, 0.02) 1px, transparent 1px);
      background-size: 64px 64px;
      pointer-events: none;
    }

    /* Header Navigation */
    .stage-nav {
      position: relative;
      z-index: 10;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .summit-brand {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .brand-cube {
      width: 44px;
      height: 44px;
      background: linear-gradient(135deg, #06B6D4, #8B5CF6);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 30px rgba(6, 182, 212, 0.5);
    }
    .brand-cube svg { width: 24px; height: 24px; fill: white; }
    .summit-title {
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }

    .date-pill {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.12);
      padding: 10px 24px;
      border-radius: 100px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      letter-spacing: 0.06em;
      color: #E2E8F0;
      backdrop-filter: blur(20px);
    }

    /* Main Stage Headline Core */
    .center-stage {
      position: relative;
      z-index: 10;
      max-width: 1380px;
      margin: 40px 0;
    }
    .kicker-tag {
      font-family: 'JetBrains Mono', monospace;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: #38BDF8;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .kicker-tag::before {
      content: "";
      width: 24px;
      height: 2px;
      background: #38BDF8;
    }
    .stage-hero-text {
      font-size: 96px;
      font-weight: 900;
      line-height: 1.0;
      letter-spacing: -0.045em;
      background: linear-gradient(180deg, #FFFFFF 40%, #94A3B8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 28px;
    }
    .stage-subtext {
      font-size: 24px;
      font-weight: 400;
      color: #94A3B8;
      line-height: 1.5;
      max-width: 880px;
      letter-spacing: -0.01em;
    }

    /* 3 Pillar Capsules */
    .capsules-row {
      position: relative;
      z-index: 10;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
      margin-top: 24px;
    }
    .capsule-card {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 20px;
      padding: 24px 30px;
      backdrop-filter: blur(30px);
      box-shadow: 0 20px 50px rgba(0,0,0,0.5);
    }
    .cap-num {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: #818CF8;
      margin-bottom: 8px;
    }
    .cap-title {
      font-size: 20px;
      font-weight: 700;
      color: #F8FAFC;
      margin-bottom: 6px;
    }
    .cap-desc {
      font-size: 14px;
      color: #94A3B8;
      line-height: 1.4;
    }

    /* Bottom Status Bar */
    .stage-footer {
      position: relative;
      z-index: 10;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 24px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: #64748B;
    }
  </style>
</head>
<body>
  <div class="aurora-container"></div>
  <div class="subtle-grid"></div>

  <!-- Stage Navigation -->
  <header class="stage-nav">
    <div class="summit-brand">
      <div class="brand-cube">
        <svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
      </div>
      <span class="summit-title">APEX // GLOBAL DESIGN FORUM</span>
    </div>
    <div class="date-pill">OCTOBER 14–16, 2026 · SAN FRANCISCO & LIVESTREAM</div>
  </header>

  <!-- Center Stage Headline -->
  <div class="center-stage">
    <div class="kicker-tag">KEYNOTE PRESENTATION · HALL A</div>
    <h1 class="stage-hero-text">Shaping the tactile future<br>of creative software.</h1>
    <p class="stage-subtext">
      The inaugural worldwide assembly of principal design engineers, typography architects, and generative systems directors.
    </p>

    <!-- 3 Pillar Capsules -->
    <div class="capsules-row">
      <div class="capsule-card">
        <div class="cap-num">TRACK 01</div>
        <div class="cap-title">Generative Runtimes</div>
        <div class="cap-desc">Compiling AI visual intelligence directly into deterministic vector scene-graphs.</div>
      </div>
      <div class="capsule-card">
        <div class="cap-num">TRACK 02</div>
        <div class="cap-title">Swiss Micro-Typo</div>
        <div class="cap-desc">Revitalizing international typographic grids with modern dynamic responsive containers.</div>
      </div>
      <div class="capsule-card">
        <div class="cap-num">TRACK 03</div>
        <div class="cap-title">Autonomous Studios</div>
        <div class="cap-desc">Multi-agent design pipelines operating at zero pixel drift and true 300 DPI print scale.</div>
      </div>
    </div>
  </div>

  <!-- Stage Footer -->
  <footer class="stage-footer">
    <div>STAGE FIDELITY: 4K ULTRA HD / 60 FPS HDR BROADCAST</div>
    <div>HAWA CREATIVE OS // OFFICIAL KEYNOTE ENGINE</div>
    <div>LIVE BROADCAST FEED // LATENCY &lt; 15MS</div>
  </footer>
</body>
</html>`;

// ============================================================================
// COMPILATION & RENDERING EXECUTION
// ============================================================================
const items = [
  {
    id: '01_tech_product_poster_4_5',
    title: 'Silicon Valley Dark Mode Tech Poster',
    html: design1_TechPoster,
    width: 1080,
    height: 1350,
    scale: 1,
  },
  {
    id: '02_swiss_international_poster_a4',
    title: 'Swiss International Typographic Poster (A4 300 DPI)',
    html: design2_SwissPoster,
    width: 3508,
    height: 2480,
    scale: 1,
  },
  {
    id: '03_luxury_editorial_statement_1_1',
    title: 'Luxury Editorial Brand Monograph (1:1)',
    html: design3_LuxuryStatement,
    width: 1080,
    height: 1080,
    scale: 1,
  },
  {
    id: '04_summit_keynote_stage_16_9',
    title: 'Global Tech Summit Keynote Identity (16:9)',
    html: design4_SummitKeynote,
    width: 1920,
    height: 1080,
    scale: 1,
  },
];

for (const item of items) {
  console.log(`\n⏳ Rendering "${item.title}" (${item.width}x${item.height})...`);
  const outPng = path.join(outDir, `${item.id}.png`);
  const artifactPng = path.join(artifactDir, `${item.id}.png`);
  
  renderHtml(item.html, outPng, item.width, item.height, item.scale);
  fs.copyFileSync(outPng, artifactPng);
  
  const size = fs.statSync(outPng).size;
  console.log(`✅ Completed: ${outPng} (${(size / 1024).toFixed(1)} KB)`);
}

console.log('\n🎉 All 4 Pro Designer English Masterworks rendered successfully!');
