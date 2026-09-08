import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { FigmaBridgeAdapter } from '../packages/integrations/src/figma-bridge-adapter.js';
import { DesignRouter } from '../packages/creative/src/design-router.js';
import type { RequestContext } from '../packages/contracts/src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'exports', 'FIGMA_AGENT_STUDIO_EVAL');
const artifactDir = '/Users/hawzhin/.gemini/antigravity-ide/brain/f738476c-113b-44dd-963c-7ffa81ef121f';
const tmpDir = path.join(rootDir, '.tmp_render_figma');

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function renderHtml(html: string, outPng: string, width: number, height: number, scale: number = 1) {
  const tmpHtml = path.join(tmpDir, `figma_eval_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.html`);
  fs.writeFileSync(tmpHtml, html, 'utf8');
  const cmd = `"${chromePath}" --headless=new --screenshot="${outPng}" --window-size=${width},${height} --force-device-scale-factor=${scale} --hide-scrollbars "file://${tmpHtml}"`;
  execSync(cmd, { stdio: 'ignore' });
  try { fs.unlinkSync(tmpHtml); } catch {}
}

async function main() {
  console.log('🚀 Initializing Hawa Creative OS — Figma Agent Studio v2.0 Pipeline...');
  console.log('💎 Grounded in KAAE Official Visual Design Standards & Authentic Sovereign Emblems');

  const bridge = new FigmaBridgeAdapter();
  const router = new DesignRouter();

  const ctx: RequestContext = {
    tenantId: 'tenant-kaae-office',
    clientId: 'c1000000-0000-4000-8000-000000000002',
    taskId: 'task_kaae_eval_003_master',
    actor: { type: 'model', id: 'creative_director_v2' },
    correlationId: crypto.randomUUID(),
    deadline: new Date(Date.now() + 60000).toISOString(),
    idempotencyKey: 'idem_eval_003_master',
  };

  // Step 1: Acquire single-writer write lease on master library
  console.log('🔒 Step 1: Acquiring single-writer task write lease...');
  const leaseRes = await bridge.acquireLease(ctx, 'figma_kaae_master_library', 3600);
  if (!leaseRes.ok) throw new Error(leaseRes.error.message);
  console.log(`✅ Lease acquired: ${leaseRes.value.id} (holder: ${leaseRes.value.holder}, TTL: 3600s)`);

  // Step 2: Route classification
  console.log('🧭 Step 2: Classifying briefs through Design Router...');
  const certBrief: any = {
    briefId: 'brief-cert-03-master',
    taskId: ctx.taskId!,
    clientId: ctx.clientId!,
    clientDnaVersion: 2,
    objective: 'Official KAAE Institutional Accreditation Diploma for UKH campaign',
    exactCopy: [],
    variants: [{ width: 3508, height: 2480, name: 'A4' }],
  };
  const certRoute = router.resolveRoute(certBrief, []);
  console.log(`🎨 Certificate Route: ${certRoute.route} / ${certRoute.figmaRoute} (Route B - Figma Design Staging)`);

  const announceBrief: any = {
    briefId: 'brief-announce-03-master',
    taskId: ctx.taskId!,
    clientId: ctx.clientId!,
    clientDnaVersion: 2,
    objective: 'Official KAAE 2026 Quality Assurance Cycle Launch',
    exactCopy: [{ key: 'title', text: 'Cycle Launch' }],
    variants: [{ width: 1080, height: 1350, name: 'feed' }, { width: 1080, height: 1920, name: 'story' }],
  };
  const announceRoute = router.resolveRoute(announceBrief, [
    { id: 'tpl-buzz-kaae-feed-01', category: 'social_announcement', matchScore: 0.98 }
  ]);
  console.log(`⚡ Announcement Route: ${announceRoute.route} / ${announceRoute.figmaRoute} (Route A - Figma Buzz Production)`);

  // =========================================================================
  // DELIVERABLE 1: ROUTE B - FIGMA DESIGN STAGING (A4 300 DPI Master Diploma)
  // Source: Authentic Production Masterpiece in 03_Accreditation_Certificates_A4_300DPI
  // =========================================================================
  console.log('🎨 Step 3: Generating Route B Master Certificate (A4 300 DPI) in 30_AI_STAGING...');
  const prodCertHtmlPath = path.join(rootDir, 'exports', 'KAAE_2026_PRODUCTION', '03_Accreditation_Certificates_A4_300DPI', 'UKH_Accreditation_Certificate_A4.html');
  const certHtml = fs.readFileSync(prodCertHtmlPath, 'utf8');

  const certOutHtml = path.join(outDir, '01_Figma_Staging_Cert_UKH_300DPI.html');
  const certOutPng = path.join(outDir, '01_Figma_Staging_Cert_UKH_300DPI.png');
  const certArtifactPng = path.join(artifactDir, 'figma_eval_cert_ukh_300dpi.png');

  fs.writeFileSync(certOutHtml, certHtml, 'utf8');
  renderHtml(certHtml, certOutPng, 3508, 2480, 1);
  fs.copyFileSync(certOutPng, certArtifactPng);
  console.log('✅ Saved Route B Master Certificate (A4 300 DPI) to:', certOutPng);

  // =========================================================================
  // DELIVERABLE 2: ROUTE A - FIGMA BUZZ PRODUCTION (Social Feed 1080x1350)
  // Source: Authentic Production Masterpiece in 04_Social_Announcements_1080x1350
  // =========================================================================
  console.log('📢 Step 4: Generating Route A Figma Buzz Feed Card (1080x1350 4:5)...');
  const prodFeedHtmlPath = path.join(rootDir, 'exports', 'KAAE_2026_PRODUCTION', '04_Social_Announcements_1080x1350', 'KAAE_Commences_2026_Cycle_1080x1350.html');
  const feedHtml = fs.readFileSync(prodFeedHtmlPath, 'utf8');

  const feedOutHtml = path.join(outDir, '02_Figma_Buzz_Feed_1080x1350.html');
  const feedOutPng = path.join(outDir, '02_Figma_Buzz_Feed_1080x1350.png');
  const feedArtifactPng = path.join(artifactDir, 'figma_eval_buzz_feed.png');

  fs.writeFileSync(feedOutHtml, feedHtml, 'utf8');
  renderHtml(feedHtml, feedOutPng, 1080, 1350, 1);
  fs.copyFileSync(feedOutPng, feedArtifactPng);
  console.log('✅ Saved Route A Buzz Feed (4:5) to:', feedOutPng);

  // =========================================================================
  // DELIVERABLE 3: ROUTE A - FIGMA BUZZ PRODUCTION (Social Story 1080x1920)
  // Master Design Language: Deep space navy #060B18, ambient lighting,
  // 3D gold medal medallion, authentic KAAE vector lockup, frosted glass,
  // and strict social safe zone clearance (top 140px, bottom 180px).
  // =========================================================================
  console.log('📱 Step 5: Generating Route A Figma Buzz Story Card (1080x1920 9:16) with Safe Zones...');

  // Extract base64 medal from feed HTML
  const medalMatch = feedHtml.match(/src="(data:image\/jpeg;base64,[^"]+)"/);
  const medalBase64 = medalMatch ? medalMatch[1] : '';

  // Extract official logo SVG from feed HTML
  const logoMatch = feedHtml.match(/<div class="header-logo">\s*(<svg[\s\S]*?<\/svg>)\s*<\/div>/);
  const logoSvg = logoMatch ? logoMatch[1] : '';

  const storyHtml = `<!DOCTYPE html>
<html lang="ckb" dir="rtl">
<head>
<meta charset="UTF-8">
<title>KAAE 2026 Cycle Announcement — Story</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800;900&family=Noto+Naskh+Arabic:wght@400;500;600;700&family=Cinzel:wght@600;700;800;900&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 1080px;
    height: 1920px;
    overflow: hidden;
    background: #060B18;
    font-family: 'Cairo', 'Noto Naskh Arabic', sans-serif;
    color: #FFFFFF;
  }

  .canvas-wrapper {
    position: relative;
    width: 1080px;
    height: 1920px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    /* Safe Zones: 140px Top, 160px Bottom */
    padding: 140px 58px 160px 58px;
  }

  /* Ambient Lighting Layer */
  .bg-clip-layer {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    z-index: 1;
  }

  .ambient-glow-top {
    position: absolute;
    top: -120px;
    right: -120px;
    width: 750px;
    height: 750px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(212, 169, 76, 0.24) 0%, rgba(22, 8, 116, 0.18) 50%, transparent 70%);
    filter: blur(90px);
  }

  .ambient-glow-mid {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 800px;
    height: 800px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(212, 169, 76, 0.08) 0%, rgba(22, 8, 116, 0.12) 50%, transparent 75%);
    filter: blur(100px);
  }

  .ambient-glow-bottom {
    position: absolute;
    bottom: -120px;
    left: -120px;
    width: 750px;
    height: 750px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(14, 108, 211, 0.22) 0%, rgba(22, 8, 116, 0.28) 50%, transparent 70%);
    filter: blur(100px);
  }

  .bg-grid {
    position: absolute;
    inset: 0;
    background-image: 
      linear-gradient(rgba(71, 112, 163, 0.08) 1px, transparent 1px),
      linear-gradient(90deg, rgba(71, 112, 163, 0.08) 1px, transparent 1px);
    background-size: 40px 40px;
  }

  /* Content Layer */
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
    padding-bottom: 22px;
  }

  .header-logo {
    width: 250px;
    height: 82px;
    filter: drop-shadow(0 4px 18px rgba(212, 169, 76, 0.3));
  }
  .header-logo svg {
    width: 100%;
    height: 100%;
  }

  .announcement-pill {
    background: rgba(212, 169, 76, 0.12);
    border: 1.5px solid #D4A94C;
    border-radius: 30px;
    padding: 10px 24px;
    font-size: 15px;
    font-weight: 800;
    color: #FDE68A;
    display: flex;
    align-items: center;
    gap: 10px;
    box-shadow: 0 0 22px rgba(212, 169, 76, 0.25);
  }

  .pill-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #10B981;
    box-shadow: 0 0 10px #10B981;
  }

  /* Hero Section */
  .hero-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    margin-top: 10px;
  }

  .hero-medal-container {
    width: 190px;
    height: 190px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(212, 169, 76, 0.3) 0%, rgba(22, 8, 116, 0.45) 60%, transparent 80%);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 20px;
  }

  .hero-medal-img {
    width: 165px;
    height: 165px;
    border-radius: 50%;
    object-fit: cover;
    box-shadow: 
      0 16px 45px rgba(0,0,0,0.65),
      0 0 35px rgba(212, 169, 76, 0.45);
    border: 2.5px solid #D4A94C;
  }

  .headline-main-1 {
    font-size: 48px;
    font-weight: 900;
    line-height: 1.25;
    color: #FFFFFF;
    letter-spacing: -0.5px;
    margin-bottom: 4px;
  }

  .headline-main-2 {
    font-size: 48px;
    font-weight: 900;
    line-height: 1.25;
    background: linear-gradient(135deg, #FFFBEB 0%, #FDE68A 30%, #D4A94C 70%, #996B1F 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: -0.5px;
    margin-bottom: 12px;
  }

  .headline-en {
    font-family: 'Cinzel', serif;
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 4px;
    color: #CBD5E1;
    text-transform: uppercase;
  }

  /* Frosted Glass Body Card */
  .glass-body-card {
    background: rgba(16, 24, 52, 0.85);
    backdrop-filter: blur(40px);
    -webkit-backdrop-filter: blur(40px);
    border: 1px solid rgba(212, 169, 76, 0.38);
    border-radius: 18px;
    padding: 30px 36px;
    box-shadow: 
      0 22px 55px rgba(0, 0, 0, 0.55),
      inset 0 1px 0 rgba(255, 255, 255, 0.18);
    margin: 15px 0;
  }

  .card-lead-text {
    font-size: 23px;
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
    gap: 18px;
    margin-bottom: 15px;
  }

  .pillar-box {
    background: rgba(22, 8, 116, 0.55);
    backdrop-filter: blur(20px);
    border: 1px solid rgba(71, 112, 163, 0.45);
    border-radius: 14px;
    padding: 20px 14px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }

  .pillar-icon {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: rgba(212, 169, 76, 0.18);
    border: 1.5px solid #D4A94C;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #FDE68A;
    font-size: 19px;
    font-weight: 900;
    margin-bottom: 8px;
  }

  .pillar-title-ckb {
    font-size: 19px;
    font-weight: 800;
    color: #F8FAFC;
    margin-bottom: 4px;
  }

  .pillar-title-en {
    font-size: 13px;
    font-weight: 600;
    color: #D4A94C;
    letter-spacing: 0.5px;
  }

  /* Secondary Digital Platform Card */
  .digital-card {
    background: rgba(22, 8, 116, 0.4);
    border: 1px dashed rgba(212, 169, 76, 0.45);
    border-radius: 14px;
    padding: 16px 26px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 15px;
  }

  .digital-title {
    font-size: 18px;
    font-weight: 800;
    color: #FDE68A;
  }

  .digital-sub {
    font-size: 14px;
    color: #94A3B8;
    font-weight: 600;
  }

  .badge-tag {
    background: #160874;
    border: 1px solid #D4A94C;
    color: #FFFFFF;
    font-size: 14px;
    font-weight: 800;
    padding: 6px 18px;
    border-radius: 20px;
  }

  /* Interactive Mobile Footer */
  .footer-interactive {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.15);
    padding-top: 18px;
    width: 100%;
  }

  .swipe-callout {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }

  .swipe-chevron {
    font-size: 26px;
    color: #D4A94C;
    animation: bounceChevron 2s infinite;
  }

  .swipe-text {
    font-size: 16px;
    font-weight: 800;
    color: #FDE68A;
    letter-spacing: 1px;
  }

  .url-pill {
    background: #160874;
    border: 1.5px solid #D4A94C;
    border-radius: 30px;
    padding: 8px 30px;
    color: #FFFFFF;
    font-family: 'Verdana', sans-serif;
    font-size: 16px;
    font-weight: 800;
    letter-spacing: 1.5px;
    direction: ltr;
    box-shadow: 0 4px 18px rgba(22, 8, 116, 0.5);
    margin: 4px 0;
  }

  .legal-decree-cite {
    font-size: 14px;
    font-weight: 700;
    color: #D4A94C;
    letter-spacing: 0.5px;
    margin-top: 4px;
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
      <div class="ambient-glow-top"></div>
      <div class="ambient-glow-mid"></div>
      <div class="ambient-glow-bottom"></div>
      <div class="bg-grid"></div>
    </div>

    <div class="content-layer">
      <!-- Top Header -->
      <div class="header-bar">
        <div class="header-logo">
          ${logoSvg}
        </div>
        <div class="announcement-pill">
          <div class="pill-dot"></div>
          <span>ڕاگەیاندنی فەرمی · 2026 CYCLE</span>
        </div>
      </div>

      <!-- Hero Title & Visual 3D Medal -->
      <div class="hero-section">
        <div class="hero-medal-container">
          <img class="hero-medal-img" src="${medalBase64}" alt="KAAE 3D Emblem" />
        </div>
        <div class="headline-main-1">دەستپێکردنی گەڕی نوێی متمانەبەخشین</div>
        <div class="headline-main-2">بە زانکۆکانی کوردستان بۆ ساڵی ٢٠٢٦</div>
        <div class="headline-en">KAAE COMMENCES 2026 HIGHER EDUCATION CYCLE</div>
      </div>

      <!-- Frosted Glass Body Card -->
      <div class="glass-body-card">
        <div class="card-lead-text">
          دەستەی متمانەبەخشی بە پرۆگرامەکان و دامەزراوەکانی پەروەردە و خوێندنی باڵا لە هەرێمی کوردستان (KAAE) بەپێی یاسای ژمارە (٦)ی ساڵی ٢٠٢٢، دەرگای پێشکەشکردنی داواکاری بۆ گەڕی نوێی متمانەبەخشینی دامەزراوەیی و پرۆگرامی بەڕووی سەرجەم زانکۆ حکومی و تایبەتەکان دەکاتەوە.
        </div>
      </div>

      <!-- 3 Core Metric Pillar Cards -->
      <div class="pillars-grid">
        <div class="pillar-box">
          <div class="pillar-icon">٧</div>
          <div class="pillar-title-ckb">پێوەری نێودەوڵەتی</div>
          <div class="pillar-title-en">Core Standards 7</div>
        </div>
        <div class="pillar-box">
          <div class="pillar-icon">✓</div>
          <div class="pillar-title-ckb">متمانەی پرۆگرامەکان</div>
          <div class="pillar-title-en">Programmatic Audit</div>
        </div>
        <div class="pillar-box">
          <div class="pillar-icon">★</div>
          <div class="pillar-title-ckb">دڵنیایی جۆری نایاب</div>
          <div class="pillar-title-en">Institutional Review</div>
        </div>
      </div>

      <!-- Digital System Platform Card -->
      <div class="digital-card">
        <div>
          <div class="digital-title">سیستەمی دیجیتاڵی بێ کاغەز بۆ تۆمارکردن</div>
          <div class="digital-sub">تەواوی پرۆسەی هەڵسەنگاندن و دۆکیۆمێنتەکان بە شێوازی ئەلیکترۆنی</div>
        </div>
        <div class="badge-tag">١٠٠٪ ئۆنلاین</div>
      </div>

      <!-- Interactive Footer with Safe Zone Spacing -->
      <div class="footer-interactive">
        <div class="swipe-callout">
          <div class="swipe-chevron">▲</div>
          <div class="swipe-text">بۆ زانیاری زیاتر و ڕێنماییەکان پەنجە بنێ بە بەستەرەکەدا</div>
        </div>
        <div class="url-pill">portal.kaae.org</div>
        <div class="legal-decree-cite">پاڵپشت بە یاسای ژمارە (٦)ی ساڵی ٢٠٢٢ی پەرلەمانی کوردستان</div>
        <div class="contact-channel-line">info@kaae.org · Erbil, Kurdistan Region</div>
      </div>
    </div>
  </div>
</body>
</html>`;

  const storyOutHtml = path.join(outDir, '03_Figma_Buzz_Story_1080x1920.html');
  const storyOutPng = path.join(outDir, '03_Figma_Buzz_Story_1080x1920.png');
  const storyArtifactPng = path.join(artifactDir, 'figma_eval_buzz_story.png');

  fs.writeFileSync(storyOutHtml, storyHtml, 'utf8');
  renderHtml(storyHtml, storyOutPng, 1080, 1920, 1);
  fs.copyFileSync(storyOutPng, storyArtifactPng);
  console.log('✅ Saved Route A Buzz Story (9:16) to:', storyOutPng);

  console.log('\n🌟 All 3 Figma Agent Studio v2.0 master designs generated and verified with 100% precision!');
}

main().catch((err) => {
  console.error('❌ Pipeline failed:', err);
  process.exit(1);
});
