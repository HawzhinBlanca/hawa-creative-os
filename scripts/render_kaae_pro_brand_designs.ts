import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'exports', 'KAAE_PRO_BRAND_SYSTEM');
const artifactDir = '/Users/hawzhin/.gemini/antigravity-ide/brain/f738476c-113b-44dd-963c-7ffa81ef121f/showcase';
const tmpDir = path.join(rootDir, '.tmp_kaae_pro_render');

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

console.log('🏛️ Generating KAAE Pro Brand Identity & Design System Deliverables (English First)...');

// Read verified KAAE SVG symbol
const kaaeSymbolSvgPath = path.join(rootDir, 'exports', 'KAAE_2026_PRODUCTION', '02_Official_Verified_Logos', 'kaae-symbol.svg');
const kaaeSymbolSvg = fs.existsSync(kaaeSymbolSvgPath)
  ? fs.readFileSync(kaaeSymbolSvgPath, 'utf8')
  : '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#F7B500"/></svg>';

// ============================================================================
// 1. KAAE INSTITUTIONAL ACCREDITATION CHARTER (A4 Landscape 3508 x 2480 - 300 DPI)
// Modern Academic Luxury · Pro Studio Grade (Pentagram / Oxford / Bologna style)
// ============================================================================
const design1_CharterA4 = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>KAAE Institutional Accreditation Charter — University of Kurdistan Hewlêr</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400;1,600&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 3508px;
      height: 2480px;
      background-color: #FAF9F6;
      color: #111827;
      font-family: 'Plus Jakarta Sans', sans-serif;
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 120px 160px;
    }

    /* Subtle Security Watermark Emblem in Background */
    .bg-watermark {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 1400px;
      height: 1400px;
      opacity: 0.035;
      pointer-events: none;
      filter: grayscale(100%);
    }

    /* Architectural High-Precision Double Border */
    .outer-border {
      position: absolute;
      top: 48px;
      left: 48px;
      right: 48px;
      bottom: 48px;
      border: 2px solid #1E3A5F;
      pointer-events: none;
    }
    .inner-border {
      position: absolute;
      top: 60px;
      left: 60px;
      right: 60px;
      bottom: 60px;
      border: 1px solid #D4A94C;
      pointer-events: none;
    }
    .corner-notch {
      position: absolute;
      width: 24px;
      height: 24px;
      background: #FAF9F6;
      border: 2px solid #D4A94C;
    }
    .cn-tl { top: 46px; left: 46px; }
    .cn-tr { top: 46px; right: 46px; }
    .cn-bl { bottom: 46px; left: 46px; }
    .cn-br { bottom: 46px; right: 46px; }

    /* Header Zone */
    .header-zone {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      position: relative;
      z-index: 10;
    }
    .kaae-logo-container {
      width: 150px;
      height: 150px;
      margin-bottom: 24px;
    }
    .org-title {
      font-size: 34px;
      font-weight: 800;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #1E3A5F;
      margin-bottom: 8px;
    }
    .commission-title {
      font-family: 'JetBrains Mono', monospace;
      font-size: 19px;
      font-weight: 600;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: #D4A94C;
      margin-bottom: 14px;
    }
    .statute-cite {
      font-size: 18px;
      font-weight: 500;
      letter-spacing: 0.08em;
      color: #64748B;
      text-transform: uppercase;
    }

    /* Certificate Title Core */
    .diploma-title-block {
      text-align: center;
      margin: 40px 0 20px 0;
      position: relative;
      z-index: 10;
    }
    .diploma-title-kicker {
      font-family: 'JetBrains Mono', monospace;
      font-size: 16px;
      letter-spacing: 0.25em;
      text-transform: uppercase;
      color: #D4A94C;
      margin-bottom: 16px;
    }
    .diploma-main-title {
      font-family: 'Cinzel', serif;
      font-size: 88px;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: #1E3A5F;
      line-height: 1.05;
      text-transform: uppercase;
    }

    /* Recipient & Standing Presentation */
    .recipient-zone {
      text-align: center;
      position: relative;
      z-index: 10;
      max-width: 2400px;
      margin: 0 auto;
    }
    .conferral-formula {
      font-family: 'Playfair Display', serif;
      font-style: italic;
      font-size: 32px;
      color: #475569;
      margin-bottom: 24px;
    }
    .institution-name {
      font-family: 'Cinzel', serif;
      font-size: 96px;
      font-weight: 700;
      color: #0F172A;
      letter-spacing: -0.02em;
      line-height: 1.1;
      margin-bottom: 28px;
    }

    /* Standing Badge */
    .standing-pill {
      display: inline-flex;
      align-items: center;
      gap: 16px;
      background: rgba(212, 169, 76, 0.08);
      border: 1.5px solid #D4A94C;
      padding: 16px 40px;
      border-radius: 100px;
      font-family: 'Plus Jakarta Sans', sans-serif;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #1E3A5F;
      margin-bottom: 36px;
    }

    .statutory-statement {
      font-size: 26px;
      font-weight: 400;
      line-height: 1.65;
      color: #334155;
      max-width: 2100px;
      margin: 0 auto;
    }

    /* Bottom Signatures & Gold Seal Medallion */
    .footer-zone {
      display: grid;
      grid-template-columns: 1fr 340px 1fr;
      align-items: flex-end;
      position: relative;
      z-index: 10;
      padding-top: 40px;
    }

    .sig-block {
      display: flex;
      flex-direction: column;
    }
    .sig-line {
      width: 100%;
      max-width: 600px;
      height: 1.5px;
      background: #CBD5E1;
      margin-bottom: 18px;
      position: relative;
    }
    .sig-svg {
      position: absolute;
      bottom: 8px;
      left: 30px;
      width: 320px;
      height: 90px;
    }
    .sig-name {
      font-size: 28px;
      font-weight: 700;
      color: #0F172A;
      margin-bottom: 6px;
    }
    .sig-title {
      font-size: 19px;
      font-weight: 500;
      color: #64748B;
      letter-spacing: 0.04em;
    }

    /* Center 3D Gold Embossed Seal Medallion */
    .seal-medallion-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .gold-seal-disc {
      width: 220px;
      height: 220px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 35%, #FFF6DB 0%, #F5C755 35%, #D4A94C 70%, #946C15 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 16px 40px rgba(148, 108, 21, 0.35), inset 0 2px 4px rgba(255, 255, 255, 0.8);
      position: relative;
      border: 3px solid #FBF0CC;
    }
    .seal-inner-ring {
      width: 184px;
      height: 184px;
      border-radius: 50%;
      border: 2px dashed #946C15;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
    }
    .seal-text-top {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      font-weight: 700;
      color: #644505;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .seal-text-center {
      font-family: 'Cinzel', serif;
      font-size: 32px;
      font-weight: 700;
      color: #1E3A5F;
      letter-spacing: 0.05em;
    }
    .seal-text-bottom {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      font-weight: 700;
      color: #644505;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      margin-top: 4px;
    }

    /* Bottom Technical Registry Ledger */
    .registry-bar {
      position: absolute;
      bottom: 22px;
      left: 160px;
      right: 160px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: 'JetBrains Mono', monospace;
      font-size: 14px;
      color: #94A3B8;
      letter-spacing: 0.08em;
    }
  </style>
</head>
<body>
  <div class="outer-border"></div>
  <div class="inner-border"></div>
  <div class="corner-notch cn-tl"></div>
  <div class="corner-notch cn-tr"></div>
  <div class="corner-notch cn-bl"></div>
  <div class="corner-notch cn-br"></div>

  <!-- Subtle Emblem Watermark -->
  <div class="bg-watermark">
    ${kaaeSymbolSvg}
  </div>

  <!-- Header -->
  <header class="header-zone">
    <div class="kaae-logo-container">
      ${kaaeSymbolSvg}
    </div>
    <div class="org-title">Kurdistan Accrediting Association for Education</div>
    <div class="commission-title">Commission on Higher Education (CHE)</div>
    <div class="statute-cite">Established pursuant to Kurdistan Regional Law No. 6 of 2022</div>
  </header>

  <!-- Title -->
  <div class="diploma-title-block">
    <div class="diploma-title-kicker">OFFICIAL STATUTORY DECREE</div>
    <h1 class="diploma-main-title">Certificate of Institutional Accreditation</h1>
  </div>

  <!-- Recipient Presentation -->
  <div class="recipient-zone">
    <div class="conferral-formula">By virtue of statutory peer audit and institutional evaluation, this charter is conferred upon</div>
    <h2 class="institution-name">University of Kurdistan Hewlêr</h2>
    <div class="standing-pill">★ Grade A Institutional Accreditation · Comprehensive Standing (2026–2031) ★</div>
    <p class="statutory-statement">
      Having demonstrated rigorous compliance with the Seven Core Accreditation Standards governing academic governance, faculty scholarship, student learning outcomes, and ethical stewardship established under regional statutory law.
    </p>
  </div>

  <!-- Signatures & Seal -->
  <footer class="footer-zone">
    <!-- Left Signature -->
    <div class="sig-block">
      <div class="sig-line">
        <svg class="sig-svg" viewBox="0 0 320 90">
          <path d="M 20,70 Q 70,10 130,55 T 220,40 Q 280,10 300,60" fill="none" stroke="#1E3A5F" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
      </div>
      <div class="sig-name">Dr. Alan Hama Saeed</div>
      <div class="sig-title">Commissioner on Higher Education · KAAE</div>
    </div>

    <!-- Center 3D Gold Seal -->
    <div class="seal-medallion-container">
      <div class="gold-seal-disc">
        <div class="seal-inner-ring">
          <span class="seal-text-top">OFFICIAL SEAL</span>
          <span class="seal-text-center">KAAE</span>
          <span class="seal-text-bottom">LAW 6 / 2022</span>
        </div>
      </div>
    </div>

    <!-- Right Signature -->
    <div class="sig-block" style="align-items: flex-end; text-align: right;">
      <div class="sig-line">
        <svg class="sig-svg" viewBox="0 0 320 90" style="left: auto; right: 30px;">
          <path d="M 30,65 Q 80,15 150,50 T 240,35 Q 290,20 310,55" fill="none" stroke="#1E3A5F" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
      </div>
      <div class="sig-name">Dr. Boushra Rahal Alameh</div>
      <div class="sig-title">President of the Board of Trustees · KAAE</div>
    </div>
  </footer>

  <!-- Technical Registry Ledger -->
  <div class="registry-bar">
    <span>SERIAL: KAAE-CHE-2026-UKH-00891</span>
    <span>VERIFIED REGISTRY: PORTAL.KAAE.ORG/VERIFY</span>
    <span>CONFERRAL DATE: SEPTEMBER 2026</span>
  </div>
</body>
</html>`;

// ============================================================================
// 2. KAAE NATIONAL QUALITY CYCLE ANNOUNCEMENT (4:5 Social 1080 x 1350)
// Deep Institutional Navy & Gold · Silicon Valley / Pro Studio Grade
// ============================================================================
const design2_AnnouncementSocial = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>KAAE 2026 Institutional Quality Assurance Cycle</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 1080px;
      height: 1350px;
      background: radial-gradient(circle at 85% 15%, #1A2C4B 0%, #0C1526 50%, #060B14 100%);
      color: #FFFFFF;
      font-family: 'Plus Jakarta Sans', sans-serif;
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 72px;
    }

    /* Ambient Gold Caustic Flare */
    .ambient-gold {
      position: absolute;
      top: -120px;
      right: -120px;
      width: 700px;
      height: 700px;
      background: radial-gradient(circle, rgba(247, 181, 0, 0.12) 0%, rgba(30, 58, 95, 0.08) 50%, transparent 70%);
      filter: blur(80px);
      pointer-events: none;
    }

    /* Blueprint Fine Line Grid */
    .bg-grid {
      position: absolute;
      inset: 0;
      background-image: 
        linear-gradient(to right, rgba(255, 255, 255, 0.03) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
      background-size: 44px 44px;
      pointer-events: none;
    }

    /* Header Nav */
    .header {
      position: relative;
      z-index: 10;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 24px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .brand-group {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .logo-emblem {
      width: 44px;
      height: 44px;
    }
    .brand-name {
      font-size: 15px;
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #F8FAFC;
    }
    .badge {
      background: rgba(247, 181, 0, 0.1);
      border: 1px solid rgba(247, 181, 0, 0.3);
      color: #FCD364;
      padding: 8px 16px;
      border-radius: 100px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    /* Hero Core */
    .hero-section {
      position: relative;
      z-index: 10;
      margin-top: 36px;
    }
    .kicker {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: #F7B500;
      margin-bottom: 18px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .kicker::before {
      content: "";
      width: 20px;
      height: 2px;
      background: #F7B500;
    }
    .headline {
      font-size: 64px;
      font-weight: 900;
      line-height: 1.05;
      letter-spacing: -0.04em;
      background: linear-gradient(180deg, #FFFFFF 30%, #CBD5E1 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 20px;
    }
    .subtext {
      font-size: 19px;
      font-weight: 400;
      line-height: 1.55;
      color: #94A3B8;
      max-width: 820px;
    }

    /* 3 Pillar Cards in Glassmorphism */
    .pillars-stack {
      position: relative;
      z-index: 10;
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin: 32px 0;
    }
    .pillar-card {
      background: rgba(18, 28, 48, 0.65);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 18px;
      padding: 22px 28px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      backdrop-filter: blur(30px);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
      transition: all 0.2s;
    }
    .pillar-card:hover {
      border-color: rgba(247, 181, 0, 0.35);
    }
    .pillar-left {
      display: flex;
      align-items: center;
      gap: 22px;
    }
    .pillar-num {
      font-family: 'JetBrains Mono', monospace;
      font-size: 16px;
      font-weight: 700;
      color: #F7B500;
      width: 38px;
      height: 38px;
      border-radius: 10px;
      background: rgba(247, 181, 0, 0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(247, 181, 0, 0.25);
    }
    .pillar-title {
      font-size: 20px;
      font-weight: 700;
      color: #F8FAFC;
      margin-bottom: 4px;
    }
    .pillar-desc {
      font-size: 13.5px;
      color: #94A3B8;
    }
    .pillar-tag {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: #38BDF8;
      background: rgba(56, 189, 248, 0.08);
      padding: 6px 14px;
      border-radius: 100px;
      border: 1px solid rgba(56, 189, 248, 0.2);
    }

    /* Footer Verification */
    .footer {
      position: relative;
      z-index: 10;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 24px;
    }
    .footer-left {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .exec-name {
      font-size: 15px;
      font-weight: 700;
      color: #F8FAFC;
    }
    .exec-title {
      font-size: 12px;
      color: #64748B;
    }
    .portal-link {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.1em;
      color: #F7B500;
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <div class="ambient-gold"></div>
  <div class="bg-grid"></div>

  <!-- Header -->
  <header class="header">
    <div class="brand-group">
      <div class="logo-emblem">
        ${kaaeSymbolSvg}
      </div>
      <span class="brand-name">KAAE // HIGHER EDUCATION</span>
    </div>
    <div class="badge">CYCLE 2026–2027 ACTIVE</div>
  </header>

  <!-- Hero Core -->
  <div class="hero-section">
    <div class="kicker">STATUTORY ACCREDITATION MANDATE</div>
    <h1 class="headline">Elevating Higher Education Standards.</h1>
    <p class="subtext">
      Pursuant to Law No. 6 of 2022 enacted by the Kurdistan Regional Parliament, the Commission on Higher Education formally commences the 2026 comprehensive institutional and programmatic accreditation cycle.
    </p>
  </div>

  <!-- 3 Pillars Stack -->
  <div class="pillars-stack">
    <div class="pillar-card">
      <div class="pillar-left">
        <div class="pillar-num">01</div>
        <div>
          <div class="pillar-title">Curricular Rigor & Outcomes</div>
          <div class="pillar-desc">Peer-benchmarked programs mapped to international qualifications frameworks.</div>
        </div>
      </div>
      <span class="pillar-tag">STANDARDS I–III</span>
    </div>

    <div class="pillar-card">
      <div class="pillar-left">
        <div class="pillar-num">02</div>
        <div>
          <div class="pillar-title">Faculty Research & Capacity</div>
          <div class="pillar-desc">Doctoral ratio verification, scientific output, and continuous academic audit.</div>
        </div>
      </div>
      <span class="pillar-tag">STANDARDS IV–V</span>
    </div>

    <div class="pillar-card">
      <div class="pillar-left">
        <div class="pillar-num">03</div>
        <div>
          <div class="pillar-title">Governance & Institutional Integrity</div>
          <div class="pillar-desc">Transparent administrative stewardship and regional statutory compliance.</div>
        </div>
      </div>
      <span class="pillar-tag">STANDARDS VI–VII</span>
    </div>
  </div>

  <!-- Footer -->
  <footer class="footer">
    <div class="footer-left">
      <span class="exec-name">Dr. Boushra Rahal Alameh</span>
      <span class="exec-title">President, Kurdistan Accrediting Association for Education</span>
    </div>
    <div class="portal-link">PORTAL.KAAE.ORG // VERIFIED DIRECTIVE</div>
  </footer>
</body>
</html>`;

// ============================================================================
// 3. KAAE PRESIDENTIAL EXECUTIVE STATEMENT (1:1 Square 1080 x 1080)
// High-Contrast Editorial Luxury · Dr. Boushra Rahal Alameh Quote
// ============================================================================
const design3_PresidentialStatement = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>KAAE Presidential Directive — Dr. Boushra Rahal Alameh</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;0,700;1,500;1,600&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 1080px;
      height: 1080px;
      background-color: #0B132B;
      color: #F8FAFC;
      font-family: 'Plus Jakarta Sans', sans-serif;
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 80px 88px;
    }

    /* Ambient Warm Gold Glow */
    .glow {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 700px;
      height: 700px;
      background: radial-gradient(circle, rgba(212, 169, 76, 0.09) 0%, transparent 65%);
      filter: blur(90px);
      pointer-events: none;
    }

    /* Fine Gold Perimeter Rule */
    .perimeter {
      position: absolute;
      top: 40px;
      left: 40px;
      right: 40px;
      bottom: 40px;
      border: 1px solid rgba(212, 169, 76, 0.2);
      pointer-events: none;
    }

    /* Top Masthead */
    .masthead {
      position: relative;
      z-index: 10;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding-bottom: 24px;
    }
    .brand-lockup {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .logo-small {
      width: 36px;
      height: 36px;
    }
    .brand-text {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #E2E8F0;
    }
    .directive-tag {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: #D4A94C;
    }

    /* Quote Core */
    .quote-zone {
      position: relative;
      z-index: 10;
      margin: 30px 0;
      max-width: 900px;
    }
    .open-quote {
      font-family: 'Playfair Display', serif;
      font-size: 110px;
      line-height: 0.5;
      color: #D4A94C;
      margin-bottom: 28px;
      display: block;
      opacity: 0.9;
    }
    .quote-text {
      font-family: 'Playfair Display', serif;
      font-style: italic;
      font-size: 50px;
      font-weight: 600;
      line-height: 1.22;
      color: #FAF8F5;
      letter-spacing: -0.01em;
      margin-bottom: 32px;
    }
    .quote-context {
      font-size: 15px;
      font-weight: 300;
      line-height: 1.8;
      color: #94A3B8;
      letter-spacing: 0.02em;
      max-width: 680px;
    }

    /* Sign-off */
    .signoff {
      position: relative;
      z-index: 10;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 28px;
    }
    .leader-info {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .leader-name {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0.02em;
      color: #FFFFFF;
    }
    .leader-role {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11.5px;
      color: #D4A94C;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .legal-statute {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: #64748B;
      text-align: right;
      letter-spacing: 0.06em;
    }
  </style>
</head>
<body>
  <div class="glow"></div>
  <div class="perimeter"></div>

  <!-- Masthead -->
  <header class="masthead">
    <div class="brand-lockup">
      <div class="logo-small">
        ${kaaeSymbolSvg}
      </div>
      <span class="brand-text">KAAE // OFFICIAL DECREE</span>
    </div>
    <span class="directive-tag">PRESIDENTIAL POLICY DIRECTIVE</span>
  </header>

  <!-- Quote -->
  <div class="quote-zone">
    <span class="open-quote">“</span>
    <blockquote class="quote-text">
      Accreditation is not a bureaucratic hurdle; it is the sovereign guarantee of academic integrity and global recognition for our universities.
    </blockquote>
    <p class="quote-context">
      By anchoring regional institutions to verifiable international quality benchmarks, we ensure that every degree conferred in Kurdistan carries unquestioned currency worldwide.
    </p>
  </div>

  <!-- Signoff -->
  <footer class="signoff">
    <div class="leader-info">
      <span class="leader-name">Dr. Boushra Rahal Alameh</span>
      <span class="leader-role">President of the Board of Trustees · KAAE</span>
    </div>
    <div class="legal-statute">
      ESTABLISHED UNDER LAW NO. 6 OF 2022<br>
      KURDISTAN REGIONAL PARLIAMENT
    </div>
  </footer>
</body>
</html>`;

// ============================================================================
// EXECUTION & RENDERING
// ============================================================================
const items = [
  {
    id: '01_kaae_institutional_charter_a4_300dpi',
    title: 'KAAE Institutional Accreditation Charter (A4 300 DPI)',
    html: design1_CharterA4,
    width: 3508,
    height: 2480,
  },
  {
    id: '02_kaae_national_standards_announcement_4_5',
    title: 'KAAE National Quality Cycle Announcement (4:5 Social)',
    html: design2_AnnouncementSocial,
    width: 1080,
    height: 1350,
  },
  {
    id: '03_kaae_presidential_statement_1_1',
    title: 'KAAE Presidential Policy Directive (1:1 Square)',
    html: design3_PresidentialStatement,
    width: 1080,
    height: 1080,
  },
];

for (const item of items) {
  console.log(`\n⏳ Rendering KAAE "${item.title}" (${item.width}x${item.height})...`);
  const outPng = path.join(outDir, `${item.id}.png`);
  const artifactPng = path.join(artifactDir, `${item.id}.png`);

  renderHtml(item.html, outPng, item.width, item.height);
  fs.copyFileSync(outPng, artifactPng);

  const size = fs.statSync(outPng).size;
  console.log(`✅ Completed: ${outPng} (${(size / 1024).toFixed(1)} KB)`);
}

console.log('\n🏛️ All KAAE Pro Brand System designs rendered successfully!');
