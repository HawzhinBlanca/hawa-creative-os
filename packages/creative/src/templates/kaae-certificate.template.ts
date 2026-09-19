import type { StudioOperation } from '@hawa/contracts';

export interface KaaeCertificateParams {
  pageId?: string;
  recipientName: string;
  programName: string;
  startDate?: string;
  endDate?: string;
  issueDate?: string;
  directorName?: string;
  directorTitle?: string;
  logoSha256?: string;
  language?: 'en' | 'ckb' | 'ar';
  learnedRules?: string[];
}

export const KAAE_PRIMARY_LOGO_SHA256 = '40dab5f8ca1fe647e8bb1a443b3c9934408a8f177e79b430616e14f41fdb2ebc';
export const KAAE_SYMBOL_SHA256 = 'fc01cc8ed2ba4016e4f701abcb46d5b4f934d9a3c664129d82a475de40439180';

/**
 * Generates an authoritative A4 landscape accreditation certificate (3508 x 2480 @ 300DPI)
 * Grounded in official KAAE brand guidelines and verified KaaeCert3.pdf layout.
 * Invariant 1: Fully editable vector and live typography operations.
 * Invariant 3: Live text for names, programs, and statutory citations.
 * Invariant 4: Official verified cryptographic emblem asset.
 */
export function buildKaaeCertificateOperations(params: KaaeCertificateParams): StudioOperation[] {
  const pageId = params.pageId || 'page_certificate';
  const logoSha = params.logoSha256 || KAAE_PRIMARY_LOGO_SHA256;
  const isKurdish = params.language === 'ckb';
  const ops: StudioOperation[] = [];

  let recipientFont = isKurdish ? 'Cairo' : 'Playfair Display';
  let programFont = isKurdish ? 'Cairo' : 'Verdana';

  if (params.learnedRules && params.learnedRules.length > 0) {
    for (const rule of params.learnedRules) {
      const lr = rule.toLowerCase();
      if (!isKurdish) {
        if (/cinzel/i.test(lr)) {
          recipientFont = '"Cinzel", serif';
        } else if (/playfair/i.test(lr)) {
          recipientFont = '"Playfair Display", serif';
        }
        if (/playfair/i.test(lr)) {
          programFont = '"Playfair Display", serif';
        }
      }
    }
  }

  const width = 3508;
  const height = 2480;

  // 1. Certificate Background Ground
  ops.push({
    op: 'addVector',
    nodeId: 'cert_bg',
    pageId,
    source: `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="certBacking" cx="50%" cy="50%" r="70%">
            <stop offset="0%" stop-color="#FFFFFF"/>
            <stop offset="85%" stop-color="#FCFAF5"/>
            <stop offset="100%" stop-color="#F7F1E6"/>
          </radialGradient>
          <pattern id="certDiamondPattern" width="70" height="70" patternUnits="userSpaceOnUse">
            <path d="M 35 0 L 70 35 L 35 70 L 0 35 Z" fill="none" stroke="#4770A3" stroke-width="0.75" stroke-opacity="0.04"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#certBacking)"/>
        <rect width="100%" height="100%" fill="url(#certDiamondPattern)"/>
      </svg>
    `.trim(),
    x: 0,
    y: 0,
    width,
    height,
    locked: true,
  });

  // 2. Double Security Frame (Outer KAAE Blue 60px inset, Inner Sun Gold 80px inset)
  ops.push({
    op: 'addVector',
    nodeId: 'cert_borders',
    pageId,
    source: `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <!-- Outer Blue Frame -->
        <rect x="60" y="60" width="${width - 120}" height="${height - 120}" fill="none" stroke="#4770A3" stroke-width="6"/>
        <!-- Inner Gold Accent Frame -->
        <rect x="80" y="80" width="${width - 160}" height="${height - 160}" fill="none" stroke="#D4A94C" stroke-width="2"/>
        <!-- Corner Medallions -->
        <circle cx="80" cy="80" r="10" fill="#D4A94C"/>
        <circle cx="${width - 80}" cy="80" r="10" fill="#D4A94C"/>
        <circle cx="80" cy="${height - 80}" r="10" fill="#D4A94C"/>
        <circle cx="${width - 80}" cy="${height - 80}" r="10" fill="#D4A94C"/>
      </svg>
    `.trim(),
    x: 0,
    y: 0,
    width,
    height,
    locked: true,
  });

  // 3. Official KAAE Emblem (Top Center, 420 x 340)
  const logoWidth = 460;
  const logoHeight = 360;
  const logoX = (width - logoWidth) / 2;
  const logoY = 160;

  ops.push({
    op: 'addImage',
    nodeId: 'cert_official_logo',
    pageId,
    asset: {
      storageKey: `assets/logos/${logoSha}.png`,
      sha256: logoSha,
      mimeType: 'image/png',
    },
    x: logoX,
    y: logoY,
    width: logoWidth,
    height: logoHeight,
    fit: 'contain',
    locked: true,
  });

  // 4. Official Seal Watermark / Emboss Placeholder (Top Right)
  ops.push({
    op: 'addVector',
    nodeId: 'cert_seal_watermark',
    pageId,
    source: `
      <svg width="340" height="340" viewBox="0 0 340 340" xmlns="http://www.w3.org/2000/svg">
        <circle cx="170" cy="170" r="160" fill="none" stroke="#D4A94C" stroke-width="3" stroke-dasharray="8 6" stroke-opacity="0.6"/>
        <circle cx="170" cy="170" r="145" fill="none" stroke="#4770A3" stroke-width="1.5" stroke-opacity="0.4"/>
        <text x="170" y="160" font-family="'Cinzel', serif" font-size="20" font-weight="700" fill="#D4A94C" text-anchor="middle" letter-spacing="3">OFFICIAL SEAL</text>
        <text x="170" y="190" font-family="'Inter', sans-serif" font-size="14" font-weight="600" fill="#4770A3" text-anchor="middle" letter-spacing="2">KAAE · 2022/6</text>
      </svg>
    `.trim(),
    x: width - 520,
    y: 180,
    width: 340,
    height: 340,
    locked: true,
  });

  // 5. Certificate Header Titles
  const titleY = 600;
  ops.push({
    op: 'addText',
    nodeId: 'cert_title',
    pageId,
    text: isKurdish ? 'بڕوانامەی دەرچوون و متمانەبەخشین' : 'CERTIFICATE OF COMPLETION',
    role: 'headline',
    x: 200,
    y: titleY,
    width: width - 400,
    height: 140,
    style: {
      fontSize: isKurdish ? 96 : 108,
      fontWeight: 'bold',
      fontFamily: isKurdish ? 'Cairo' : 'Cinzel',
      textAlign: 'center',
      color: '#4770A3',
      letterSpacing: isKurdish ? 2 : 10,
    },
    locked: false,
  });

  ops.push({
    op: 'addText',
    nodeId: 'cert_subtitle',
    pageId,
    text: isKurdish
      ? 'دەستەی متمانەبەخشی بە پرۆگرامەکان و دامەزراوەکانی پەروەردە و خوێندنی باڵا'
      : 'KURDISTAN ACCREDITING ASSOCIATION FOR EDUCATION',
    role: 'subheadline',
    x: 200,
    y: titleY + 140,
    width: width - 400,
    height: 60,
    style: {
      fontSize: 40,
      fontWeight: '600',
      fontFamily: isKurdish ? 'Noto Naskh Arabic' : 'Inter',
      textAlign: 'center',
      color: '#D4A94C',
      letterSpacing: isKurdish ? 1 : 6,
    },
    locked: false,
  });

  // 6. "This is to certify that"
  const preambleY = titleY + 260;
  ops.push({
    op: 'addText',
    nodeId: 'cert_preamble',
    pageId,
    text: isKurdish ? 'ئەمە بۆ سەلماندنی ئەوەیە کە بەڕێز' : 'This is to certify that',
    role: 'disclaimer',
    x: 300,
    y: preambleY,
    width: width - 600,
    height: 60,
    style: {
      fontSize: 48,
      fontStyle: 'italic',
      fontFamily: isKurdish ? 'Noto Sans Arabic' : 'Verdana',
      textAlign: 'center',
      color: '#1A202C',
    },
    locked: false,
  });

  // 7. Recipient Full Name + Gold Rule
  const recipientY = preambleY + 90;
  ops.push({
    op: 'addText',
    nodeId: 'cert_recipient',
    pageId,
    text: params.recipientName,
    role: 'headline',
    x: 400,
    y: recipientY,
    width: width - 800,
    height: 110,
    style: {
      fontSize: 88,
      fontWeight: 'bold',
      fontFamily: recipientFont,
      textAlign: 'center',
      color: '#2D4A73',
      lineHeight: 1.2,
    },
    locked: false,
  });

  // Gold decorative underline under recipient name
  ops.push({
    op: 'addVector',
    nodeId: 'cert_recipient_underline',
    pageId,
    source: `
      <svg width="1000" height="12" viewBox="0 0 1000 12" xmlns="http://www.w3.org/2000/svg">
        <line x1="0" y1="6" x2="1000" y2="6" stroke="#D4A94C" stroke-width="4"/>
        <polygon points="500,0 508,6 500,12 492,6" fill="#D4A94C"/>
      </svg>
    `.trim(),
    x: (width - 1000) / 2,
    y: recipientY + 115,
    width: 1000,
    height: 12,
    locked: true,
  });

  // 8. "has successfully completed the"
  const programPreambleY = recipientY + 160;
  ops.push({
    op: 'addText',
    nodeId: 'cert_program_preamble',
    pageId,
    text: isKurdish ? 'بە سەرکەوتوویی بەشداری کردووە لە' : 'has successfully completed the',
    role: 'disclaimer',
    x: 300,
    y: programPreambleY,
    width: width - 600,
    height: 60,
    style: {
      fontSize: 48,
      fontStyle: 'normal',
      fontFamily: isKurdish ? 'Noto Sans Arabic' : 'Verdana',
      textAlign: 'center',
      color: '#1A202C',
    },
    locked: false,
  });

  // 9. Program Name (Italicized Royal/Steel Blue)
  const programY = programPreambleY + 70;
  ops.push({
    op: 'addText',
    nodeId: 'cert_program_name',
    pageId,
    text: params.programName,
    role: 'headline',
    x: 300,
    y: programY,
    width: width - 600,
    height: 90,
    style: {
      fontSize: 64,
      fontWeight: '600',
      fontStyle: 'italic',
      fontFamily: programFont,
      textAlign: 'center',
      color: '#4770A3',
    },
    locked: false,
  });

  // 10. Dates (Start Date to End Date, Issued on Date)
  const datesY = programY + 110;
  const dateStr =
    params.startDate && params.endDate
      ? isKurdish
        ? `لە ڕێکەوتی ${params.startDate} تاوەکو ${params.endDate}`
        : `from ${params.startDate} to ${params.endDate}`
      : '';

  if (dateStr) {
    ops.push({
      op: 'addText',
      nodeId: 'cert_dates',
      pageId,
      text: dateStr,
      role: 'disclaimer',
      x: 400,
      y: datesY,
      width: width - 800,
      height: 50,
      style: {
        fontSize: 40,
        fontFamily: isKurdish ? 'Noto Naskh Arabic' : 'Inter',
        textAlign: 'center',
        color: '#4A4A4A',
      },
      locked: false,
    });
  }

  if (params.issueDate) {
    ops.push({
      op: 'addText',
      nodeId: 'cert_issue_date',
      pageId,
      text: isKurdish ? `دەرکراوە لە: ${params.issueDate}` : `Issued on ${params.issueDate}`,
      role: 'disclaimer',
      x: 400,
      y: datesY + 60,
      width: width - 800,
      height: 50,
      style: {
        fontSize: 38,
        fontWeight: '500',
        fontFamily: isKurdish ? 'Noto Naskh Arabic' : 'Inter',
        textAlign: 'center',
        color: '#666666',
      },
      locked: false,
    });
  }

  // 11. Signatures Section (Left Director, Right Statutory Authority Citation)
  const signY = height - 420;
  // Signature Line
  ops.push({
    op: 'addVector',
    nodeId: 'cert_sign_line',
    pageId,
    source: `<line x1="0" y1="0" x2="520" y2="0" stroke="#1A202C" stroke-width="2.5"/>`,
    x: 400,
    y: signY + 30,
    width: 520,
    height: 4,
    locked: true,
  });

  ops.push({
    op: 'addText',
    nodeId: 'cert_sign_name',
    pageId,
    text: params.directorName || 'Dr. Honar Issa',
    role: 'subheadline',
    x: 400,
    y: signY + 45,
    width: 520,
    height: 55,
    style: {
      fontSize: 46,
      fontWeight: 'bold',
      fontFamily: isKurdish ? 'Cairo' : 'Verdana',
      textAlign: 'left',
      color: '#2D4A73',
    },
    locked: false,
  });

  ops.push({
    op: 'addText',
    nodeId: 'cert_sign_title',
    pageId,
    text: params.directorTitle || 'KAAE – Director',
    role: 'disclaimer',
    x: 400,
    y: signY + 105,
    width: 520,
    height: 40,
    style: {
      fontSize: 34,
      fontWeight: '500',
      fontFamily: isKurdish ? 'Noto Naskh Arabic' : 'Inter',
      textAlign: 'left',
      color: '#666666',
    },
    locked: false,
  });

  // Right Side: Statutory Authority Citation Rule (Kurdistan Law No. 6 of 2022)
  ops.push({
    op: 'addText',
    nodeId: 'cert_statutory_badge',
    pageId,
    text: isKurdish
      ? 'دامەزراوە بەپێی یاسای ژمارە (٦)ی ساڵی ٢٠٢٢ لە هەرێمی کوردستان'
      : 'Statutory Authority: Kurdistan Regional Law No. 6 of 2022',
    role: 'disclaimer',
    x: width - 920,
    y: signY + 70,
    width: 520,
    height: 60,
    style: {
      fontSize: 26,
      fontFamily: isKurdish ? 'Noto Naskh Arabic' : 'Inter',
      textAlign: isKurdish ? 'right' : 'right',
      color: '#8A8A8A',
      letterSpacing: 1,
    },
    locked: true,
  });

  return ops;
}
