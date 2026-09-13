import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const width = 1080;
const height = 1350;

// Read official KAAE logo SVG and clean up
const logoSvgPath = path.resolve('apps/desk/public/assets/logos/kaae-logo-primary.svg');
const rawLogoSvg = fs.readFileSync(logoSvgPath, 'utf8')
  .replace(/<\?xml.*?\?>/g, '')
  .replace(/<!DOCTYPE.*?>/g, '');

// Extract inner content of the SVG
const logoInner = rawLogoSvg
  .replace(/<svg[^>]*>/, '')
  .replace(/<\/svg>/, '');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- KAAE Brand Palette Definitions (Excellence Edition 2025) -->
    <!-- Royal Midnight Navy Radial Illumination (Matches Cover Page 01 & Post 3) -->
    <radialGradient id="kaaeRadialBackground" cx="50%" cy="20%" r="85%">
      <stop offset="0%" stop-color="#1B3B66"/>
      <stop offset="28%" stop-color="#122847"/>
      <stop offset="60%" stop-color="#0A1628"/>
      <stop offset="100%" stop-color="#050C17"/>
    </radialGradient>

    <!-- KAAE Sun Gold Linear Accent (Pantone 7549 C) -->
    <linearGradient id="kaaeGoldAccent" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#F7B500"/>
      <stop offset="100%" stop-color="#FFD700"/>
    </linearGradient>

    <!-- Card Top Border Radiant Gold Accent (from Post 3) -->
    <linearGradient id="cardTopGoldBorder" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#F7B500" stop-opacity="0.9"/>
      <stop offset="50%" stop-color="#FFD700" stop-opacity="0.6"/>
      <stop offset="100%" stop-color="#4770A3" stop-opacity="0.2"/>
    </linearGradient>

    <!-- Subtle Diagonal Sun Rays (Brand DNA Motif from Post 1 & Page 15) -->
    <linearGradient id="rayFade" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#F7B500" stop-opacity="0.07"/>
      <stop offset="45%" stop-color="#4770A3" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="#0A1628" stop-opacity="0"/>
    </linearGradient>

    <!-- Subtle Brand Halftone Triangle Pattern (from Page 14 & 15) -->
    <pattern id="kaaeTriangles" width="36" height="36" patternUnits="userSpaceOnUse">
      <polygon points="18,4 32,28 4,28" fill="none" stroke="#4770A3" stroke-width="0.5" stroke-opacity="0.04"/>
    </pattern>
  </defs>

  <style>
    .minion-bold {
      font-family: "Minion Pro", "Minion Variable Concept", Georgia, serif;
      font-weight: 700;
    }
    .minion-regular {
      font-family: "Minion Pro", "Minion Variable Concept", Georgia, serif;
      font-weight: 400;
    }
    .minion-italic {
      font-family: "Minion Pro", "Minion Variable Concept", Georgia, serif;
      font-style: italic;
    }
    .sans-bold {
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-weight: 700;
    }
    .sans-medium {
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-weight: 500;
    }
    .sans-regular {
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-weight: 400;
    }
  </style>

  <!-- 1. Background Foundation -->
  <rect width="${width}" height="${height}" fill="url(#kaaeRadialBackground)"/>

  <!-- Brand Motif: Diagonal Sunburst Rays streaming from top-right corner (as in Post 1) -->
  <g fill="url(#rayFade)">
    <polygon points="1080,0 1080,180 580,0"/>
    <polygon points="1080,240 1080,440 400,0 520,0"/>
    <polygon points="1080,500 1080,720 220,0 340,0"/>
    <polygon points="1080,780 1080,1020 40,0 160,0"/>
  </g>

  <!-- Brand Subtle Geometric Pattern overlay at bottom -->
  <rect x="0" y="700" width="${width}" height="650" fill="url(#kaaeTriangles)"/>

  <!-- Minimal Brand Edge Border (Clean, Non-ornamental, Modern Academic) -->
  <rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="8" fill="none" stroke="#234674" stroke-width="1.2" stroke-opacity="0.4"/>
  <rect x="28" y="28" width="${width - 56}" height="${height - 56}" rx="6" fill="none" stroke="#F7B500" stroke-width="0.75" stroke-opacity="0.25"/>

  <!-- 2. Header Area: Official KAAE Emblem & Clear Space (Page 6 & 7 Compliance) -->
  <!-- Official Vector Logo scaled with exact aspect ratio (850x600 -> 170x120), centered at X: 540, Y: 46 -->
  <!-- Note: Zero filters, zero drop-shadows, zero distortions, 100% original brand vectors -->
  <g transform="translate(455, 46) scale(0.2)">
    ${logoInner}
  </g>

  <!-- Institutional Title below emblem -->
  <text x="540" y="186" text-anchor="middle" class="sans-bold" font-size="12" fill="#F7B500" letter-spacing="3.5">
    KURDISTAN ACCREDITING ASSOCIATION FOR EDUCATION
  </text>
  <text x="540" y="206" text-anchor="middle" class="sans-medium" font-size="10.5" fill="#94A3B8" letter-spacing="2">
    STATUTORY QUALITY ASSURANCE &amp; ACCREDITATION AUTHORITY · LAW NO. 6 OF 2022
  </text>

  <!-- 3. Main Title Section -->
  <text x="540" y="246" text-anchor="middle" class="sans-bold" font-size="11" fill="#F7B500" letter-spacing="3">
    OFFICIAL PRESIDENTIAL &amp; MINISTERIAL CONVOCATION
  </text>

  <text x="540" y="282" text-anchor="middle" class="minion-bold" font-size="28" fill="#FFFFFF" letter-spacing="0.5">
    The National Standards for Quality Assurance in Education
  </text>

  <!-- Signature KAAE Brand Gold Accent Bar (Underline Anchor from Page 1 & Page 5) -->
  <rect x="440" y="298" width="200" height="4" rx="2" fill="#F7B500"/>

  <text x="540" y="324" text-anchor="middle" class="minion-italic" font-size="17" fill="#E2E8F0">
    Advancing Institutional Rigor &amp; Academic Excellence Across the Kurdistan Region
  </text>

  <!-- 4. Honored Recipient Plinth Card -->
  <g transform="translate(180, 344)">
    <rect width="720" height="48" rx="8" fill="#0E1E34" stroke="#254A78" stroke-width="1"/>
    <!-- Gold top border highlight -->
    <path d="M 0,8 Q 0,0 8,0 L 712,0 Q 720,0 720,8" fill="none" stroke="#F7B500" stroke-width="1.8"/>
    <text x="360" y="31" text-anchor="middle" class="minion-italic" font-size="22" font-weight="700" fill="#FFF2D1">
      Mr. / Ms. / Dr. [Full Name]
    </text>
  </g>

  <!-- Formal Invitation Prose -->
  <text x="540" y="420" text-anchor="middle" class="minion-regular" font-size="17" fill="#CBD5E1">
    The Kurdistan Accrediting Association for Education cordially requests the honor of your presence
  </text>
  <text x="540" y="444" text-anchor="middle" class="minion-regular" font-size="17" fill="#CBD5E1">
    at this landmark national convocation and official presentation.
  </text>

  <!-- 5. Card 1: Keynote Announcement (His Excellency Prime Minister Masrour Barzani) -->
  <!-- Designed strictly in KAAE Modern Executive Card language (Post 3 Style) -->
  <g transform="translate(60, 470)">
    <rect width="960" height="216" rx="12" fill="#0C1B30" stroke="#1D385C" stroke-width="1"/>
    <!-- Glowing gold top border accent -->
    <path d="M 0,12 Q 0,0 12,0 L 948,0 Q 960,0 960,12" fill="none" stroke="url(#cardTopGoldBorder)" stroke-width="2.5"/>

    <!-- Keynote Tag Badge -->
    <rect x="36" y="24" width="190" height="24" rx="4" fill="#142844" stroke="#F7B500" stroke-width="0.8"/>
    <circle cx="48" cy="36" r="3.5" fill="#F7B500"/>
    <text x="58" y="40" class="sans-bold" font-size="10" fill="#F7B500" letter-spacing="1.5">KEYNOTE ANNOUNCEMENT</text>

    <!-- Keynote Speaker Headline -->
    <text x="36" y="78" class="minion-bold" font-size="22" fill="#FFFFFF">
      His Excellency Prime Minister Masrour Barzani
    </text>

    <!-- Complete Verbatim User Copy (Independent clean typography) -->
    <text x="36" y="108" class="sans-regular" font-size="15" fill="#F1F5F9">
      will officially announce the National Standards for Quality Assurance in Education,
    </text>
    <text x="36" y="132" class="sans-regular" font-size="15" fill="#F1F5F9">
      marking a defining moment in the advancement of educational quality across the Kurdistan Region.
    </text>

    <text x="36" y="168" class="sans-regular" font-size="14.5" fill="#94A3B8">
      The occasion will bring together government, educational institutions, and international partners
    </text>
    <text x="36" y="192" class="sans-regular" font-size="14.5" fill="#94A3B8">
      around a shared national vision for excellence, accountability, and continuous improvement.
    </text>
  </g>

  <!-- 6. Card 2: Ministerial Accord (MoU Signing Section) -->
  <g transform="translate(60, 706)">
    <rect width="960" height="172" rx="12" fill="#0C1B30" stroke="#1D385C" stroke-width="1"/>
    <!-- Glowing gold top border accent -->
    <path d="M 0,12 Q 0,0 12,0 L 948,0 Q 960,0 960,12" fill="none" stroke="url(#cardTopGoldBorder)" stroke-width="2.5"/>

    <!-- MoU Tag Badge -->
    <rect x="36" y="24" width="280" height="24" rx="4" fill="#142844" stroke="#4A90E2" stroke-width="0.8"/>
    <circle cx="48" cy="36" r="3.5" fill="#4A90E2"/>
    <text x="58" y="40" class="sans-bold" font-size="10" fill="#7DD3FC" letter-spacing="1.5">MINISTERIAL COOPERATION ACCORD</text>

    <!-- Section Headline -->
    <text x="36" y="76" class="minion-bold" font-size="20" fill="#FFFFFF">
      Official Launch &amp; Bilateral Ministerial MoU Signing
    </text>

    <!-- Complete Verbatim User Copy -->
    <text x="36" y="106" class="sans-regular" font-size="15" fill="#F1F5F9">
      As part of the official launch, the Minister of Education and the Minister of Higher Education
    </text>
    <text x="36" y="130" class="sans-regular" font-size="15" fill="#F1F5F9">
      and Scientific Research will sign a Memorandum of Understanding (MoU),
    </text>
    <text x="36" y="154" class="sans-regular" font-size="14" fill="#94A3B8">
      marking a significant commitment to cooperation and the advancement of quality assurance across the sector.
    </text>
  </g>

  <!-- 7. Logistics Section: Date & Time and Venue Cards (Paired Cards from Post 1 & 3) -->
  <!-- Date & Time Card -->
  <g transform="translate(60, 900)">
    <rect width="465" height="106" rx="10" fill="#0E1F36" stroke="#224673" stroke-width="1"/>
    <path d="M 0,10 Q 0,0 10,0 L 455,0 Q 465,0 465,10" fill="none" stroke="#F7B500" stroke-width="2"/>

    <text x="32" y="32" class="sans-bold" font-size="11" fill="#F7B500" letter-spacing="2">DATE &amp; TIME</text>
    <text x="32" y="64" class="minion-bold" font-size="21" fill="#FFFFFF">Wednesday, September 9, 2026</text>
    <text x="32" y="90" class="sans-medium" font-size="14.5" fill="#7DD3FC">2:30 PM <tspan fill="#94A3B8" font-size="13">· (Guests to be seated by 2:00 PM)</tspan></text>
  </g>

  <!-- Venue & Location Card -->
  <g transform="translate(555, 900)">
    <rect width="465" height="106" rx="10" fill="#0E1F36" stroke="#224673" stroke-width="1"/>
    <path d="M 0,10 Q 0,0 10,0 L 455,0 Q 465,0 465,10" fill="none" stroke="#F7B500" stroke-width="2"/>

    <text x="32" y="32" class="sans-bold" font-size="11" fill="#F7B500" letter-spacing="2">VENUE &amp; LOCATION</text>
    <text x="32" y="64" class="minion-bold" font-size="20" fill="#FFFFFF">Saad Abdullah Conference Hall</text>
    <text x="32" y="90" class="sans-medium" font-size="14" fill="#94A3B8">Erbil · Kurdistan Region</text>
  </g>

  <!-- 8. Protocol & Access Section -->
  <g transform="translate(390, 1032)">
    <rect width="300" height="42" rx="21" fill="#0A1628" stroke="#F7B500" stroke-width="1.2"/>
    <circle cx="36" cy="21" r="3" fill="#F7B500"/>
    <circle cx="264" cy="21" r="3" fill="#F7B500"/>
    <text x="150" y="26" text-anchor="middle" class="sans-bold" font-size="12" fill="#F7B500" letter-spacing="3">
      BY INVITATION ONLY
    </text>
  </g>

  <text x="540" y="1100" text-anchor="middle" class="minion-italic" font-size="14" fill="#94A3B8">
    This invitation is personal, non-transferable, and strictly required for hall accreditation and admission.
  </text>

  <!-- 9. Institutional Statutory Footer (Matches Post 1 & 3 Footer Standard) -->
  <line x1="60" y1="1240" x2="1020" y2="1240" stroke="#1E3A5F" stroke-width="1"/>

  <!-- Left Footer: Statutory Quality Authority Credential -->
  <text x="60" y="1272" class="minion-bold" font-size="14" fill="#FFFFFF">
    Kurdistan Accrediting Association for Education (KAAE)
  </text>
  <text x="60" y="1294" class="sans-medium" font-size="11.5" fill="#64748B" letter-spacing="0.5">
    Statutory Quality Authority · Enacted under Law No. 6 of 2022 · Erbil, Kurdistan Region
  </text>

  <!-- Right Footer: Official Portal & Protocol Contact -->
  <g transform="translate(850, 1256)">
    <rect width="170" height="34" rx="6" fill="#0E1F36" stroke="#2A5080" stroke-width="1"/>
    <text x="85" y="22" text-anchor="middle" class="sans-bold" font-size="12" fill="#F7B500" letter-spacing="0.5">
      www.kaae.org
    </text>
  </g>
  <text x="1020" y="1306" text-anchor="end" class="sans-regular" font-size="10.5" fill="#64748B">
    Protocol: protocol@kaae.krd · info@kaae.krd
  </text>
</svg>
`;

fs.writeFileSync('exports/kaae_brand_dna_invitation.svg', svg, 'utf8');
execSync('/opt/homebrew/bin/rsvg-convert -f png -w 1080 -h 1350 exports/kaae_brand_dna_invitation.svg -o exports/kaae_brand_dna_invitation.png');
console.log('Rendered exports/kaae_brand_dna_invitation.png');
