import crypto from 'node:crypto';
import { kaaeClientDNA, type ClientDNA } from '@hawa/domain';
import type { ClientDnaSnapshot } from '../../src/routes/types.js';

/**
 * Test fixtures: six invented offices and the KAAE DNA, with one snapshot each. They were inline in
 * createApp and were seeded on every start, production included, until PostgreSQL replaced them
 * (architecture programme 1.3, SPLIT_PLAN.md section 6). Stage 2 (SPLIT_PLAN G2) moved them here:
 * Core seeds nothing, and a test that needs an invented office asks for one through
 * createAppWithClientFixtures (app-with-client-fixtures.ts), which passes this function as
 * CreateAppOptions.seedClientDna.
 *
 * `computeDnaHash` is passed in so that this file imports nothing from Core but types.
 */
export function seedClientDnaFixtures(
  clientDnas: Map<string, ClientDNA>,
  clientSnapshots: Map<string, ClientDnaSnapshot[]>,
  computeDnaHash: (dna: unknown) => string
): void {
  // The same fixture id app.ts uses as its defaultClientId.
  const defaultClientId = 'client-office-1';
  if (clientDnas.size === 0) {
  clientDnas.set(defaultClientId, {
    tenantId: 'tenant-default',
    clientId: defaultClientId,
    name: 'Hawa Creative',
    code: 'HAWA',
    version: 1,
    status: 'active',
    defaultLocale: 'ckb',
    defaultDirection: 'rtl',
    colors: [
      { name: 'Dark Slate', hex: '#0B0F19', role: 'background' },
      { name: 'Sky Accent', hex: '#38BDF8', role: 'accent' },
    ],
    fonts: [
      {
        family: 'Noto Sans Arabic',
        style: 'Regular',
        weight: 400,
        role: 'body',
        license: 'OFL',
        supportedLocales: ['ckb', 'ar'],
      },
    ],
    assets: [
      {
        assetId: crypto.randomUUID(),
        name: 'Primary Logo',
        role: 'logo_primary',
        storageKey: 'assets/logo.png',
        sha256: 'sha256_logo_verified_primary',
        mimeType: 'image/png',
      },
    ],
    guidelines: {
      voiceAndTone: 'Sophisticated Kurdish visual studio',
      prohibitedPhrases: ['cheap', 'guaranteed'],
      requiredDisclaimers: [],
      layoutRules: ['Always align brand logo to the top right in RTL'],
    },
    destinations: {
      googleSharedDriveId: 'drive_office_main',
      productionFolderId: 'folder_prod_root',
      archiveFolderId: 'folder_archive',
      spreadsheetId: 'sheet_tracker_123',
      sheetId: 0,
    },
    approvalPolicy: {
      requiredRoles: ['art_director'],
      allowAutoApproval: false,
      autoApprovalEligibleTemplates: [],
    },
    updatedAt: new Date().toISOString(),
  });

  // Seed Drustee Evidence-First Health DNA
  clientDnas.set('client-drustee', {
    tenantId: 'tenant-drustee',
    clientId: 'client-drustee',
    name: 'Drustee Evidence-First Health',
    code: 'DRUSTEE',
    version: 1,
    status: 'active',
    defaultLocale: 'ckb',
    defaultDirection: 'rtl',
    colors: [
      { name: 'Botanical Deep Emerald', hex: '#0D5C3A', role: 'primary' },
      { name: 'Forest Pine', hex: '#062E1D', role: 'background' },
      { name: 'Warm Amber Gold', hex: '#D4AF37', role: 'accent' },
    ],
    fonts: [
      {
        family: 'Vazirmatn',
        style: 'ExtraBold',
        weight: 800,
        role: 'display',
        license: 'OFL',
        supportedLocales: ['ckb', 'ar'],
      },
      {
        family: 'Noto Sans Arabic',
        style: 'SemiBold',
        weight: 600,
        role: 'body',
        license: 'OFL',
        supportedLocales: ['ckb', 'ar'],
      },
    ],
    assets: [
      {
        assetId: 'asset_drustee_logo_1',
        name: 'Official Drustee Wordmark & Leaf Seal',
        role: 'logo_primary',
        storageKey: 'assets/drustee/logo_official.svg',
        sha256: 'sha256_d892a01fc348be91',
        mimeType: 'image/svg+xml',
      },
      {
        assetId: 'asset_drustee_vitd3_1',
        name: 'Vitamin D3 + K2 Amber Dropper Bottle Vector',
        role: 'logo_secondary',
        storageKey: 'assets/drustee/vit_d3_bottle.svg',
        sha256: 'sha256_e1098b1c4320987a',
        mimeType: 'image/svg+xml',
      },
      {
        assetId: 'asset_drustee_omega3_1',
        name: 'Wild Alaskan Omega-3 Softgels Bottle Vector',
        role: 'badge',
        storageKey: 'assets/drustee/omega3_bottle.svg',
        sha256: 'sha256_f9018237cb1092e4',
        mimeType: 'image/svg+xml',
      },
      {
        assetId: 'asset_drustee_gmp_seal',
        name: 'GMP Certified Manufacturing Badge',
        role: 'badge',
        storageKey: 'assets/drustee/badge_gmp.svg',
        sha256: 'sha256_g88123490bca1123',
        mimeType: 'image/svg+xml',
      },
      {
        assetId: 'asset_drustee_lab_seal',
        name: 'Third-Party Independent Lab Tested Badge',
        role: 'badge',
        storageKey: 'assets/drustee/badge_lab.svg',
        sha256: 'sha256_h77123908fca9944',
        mimeType: 'image/svg+xml',
      },
    ],
    guidelines: {
      voiceAndTone: 'Evidence-first clinical rigor in Sorani Kurdish; transparent dosages and preventative wellness without medical disease cure claims.',
      prohibitedPhrases: [
        'معجزة',
        'دەرمانی هەموو دەردێک',
        'بێ وێنە لە جیهان',
        '١٠٠٪ گەرەنتی',
        'چارەسەری نەخۆشی',
        'miracle cure',
        'cure-all',
      ],
      requiredDisclaimers: [
        'تەواوکەری خۆراکی جێگرەوەی ژەمی خۆراکی تەندروست و ڕاوێژی پزیشک نییە.',
      ],
      layoutRules: [
        'Always preserve UAX #9 bidi isolation for Sorani Kurdish typography',
        'Maintain minimum 10% safe zone margins on all export aspect ratios',
        'Display Third-Party Lab Tested and GMP Certification badges prominently',
      ],
    },
    destinations: {
      googleSharedDriveId: 'drive_drustee_main',
      productionFolderId: 'folder_drustee_prod_verified',
      archiveFolderId: 'folder_drustee_archive',
      spreadsheetId: 'sheet_drustee_campaigns_456',
      sheetId: 0,
    },
    approvalPolicy: {
      requiredRoles: ['art_director', 'pharmacist_reviewer'],
      allowAutoApproval: false,
      autoApprovalEligibleTemplates: [],
    },
    updatedAt: new Date().toISOString(),
  });

  // Seed Aster Hotel DNA
  clientDnas.set('client-aster', {
    tenantId: 'tenant-aster',
    clientId: 'client-aster',
    name: 'Aster Hotel & Resort',
    code: 'ASTER',
    version: 12,
    status: 'active',
    defaultLocale: 'ckb',
    defaultDirection: 'rtl',
    colors: [
      { name: 'Forest Green', hex: '#164a3a', role: 'primary' },
      { name: 'Warm Cream', hex: '#f4ecdd', role: 'background' },
      { name: 'Warm Gold', hex: '#e9b666', role: 'accent' },
    ],
    fonts: [
      {
        family: 'Vazirmatn',
        style: 'Bold',
        weight: 700,
        role: 'display',
        license: 'OFL',
        supportedLocales: ['ckb', 'ar'],
      },
    ],
    assets: [
      {
        assetId: 'asset_aster_logo_1',
        name: 'White Official Logo',
        role: 'logo_primary',
        storageKey: 'assets/aster/logo_white.svg',
        sha256: 'sha256_a81f3b90214c718d',
        mimeType: 'image/svg+xml',
      },
    ],
    guidelines: {
      voiceAndTone: 'Luxury Kurdish hospitality with understated elegance',
      prohibitedPhrases: ['budget', 'discount', 'cheap'],
      requiredDisclaimers: ['بە گەرەنتی خزمەتگوزاری تایبەت'],
      layoutRules: [
        'Use the white official logo; minimum clear space equals cap height',
        'Preserve source numeral system; never normalize final copy silently',
        'Maintain minimum 32px safe margins on 4:5 Meta feed format',
      ],
    },
    destinations: {
      googleSharedDriveId: 'drive_aster_hospitality',
      productionFolderId: 'folder_aster_prod',
      archiveFolderId: 'folder_aster_archive',
      spreadsheetId: 'sheet_aster_deliverables',
      sheetId: 0,
    },
    approvalPolicy: {
      requiredRoles: ['art_director'],
      allowAutoApproval: false,
      autoApprovalEligibleTemplates: [],
    },
    updatedAt: new Date().toISOString(),
  });

  // Seed Nova Tech DNA
  clientDnas.set('client-nova', {
    tenantId: 'tenant-nova',
    clientId: 'client-nova',
    name: 'Nova Tech Systems',
    code: 'NOVA',
    version: 8,
    status: 'active',
    defaultLocale: 'en',
    defaultDirection: 'ltr',
    colors: [
      { name: 'Deep Navy', hex: '#0b192c', role: 'background' },
      { name: 'Slate Blue', hex: '#1e3e62', role: 'secondary' },
      { name: 'Safety Orange', hex: '#ff6500', role: 'accent' },
    ],
    fonts: [
      {
        family: 'Noto Sans Arabic',
        style: 'Bold',
        weight: 700,
        role: 'display',
        license: 'OFL',
        supportedLocales: ['ckb', 'ar', 'en'],
      },
    ],
    assets: [
      {
        assetId: 'asset_nova_logo_1',
        name: 'Nova Symbol Primary',
        role: 'logo_primary',
        storageKey: 'assets/nova/symbol.svg',
        sha256: 'sha256_7f41d3b9e2810a9c',
        mimeType: 'image/svg+xml',
      },
    ],
    guidelines: {
      voiceAndTone: 'Cutting-edge tech minimalism, precise and assertive',
      prohibitedPhrases: ['slow', 'legacy', 'deprecated'],
      requiredDisclaimers: [],
      layoutRules: [
        'Maintain generous padding (minimum 64px); max 2 focal elements per artboard',
        'CTA elements must use safety orange with WCAG AAA contrast against background',
      ],
    },
    destinations: {
      googleSharedDriveId: 'drive_nova_systems',
      productionFolderId: 'folder_nova_prod',
      archiveFolderId: 'folder_nova_archive',
      spreadsheetId: 'sheet_nova_campaigns',
      sheetId: 0,
    },
    approvalPolicy: {
      requiredRoles: ['creative_director'],
      allowAutoApproval: false,
      autoApprovalEligibleTemplates: [],
    },
    updatedAt: new Date().toISOString(),
  });

  // Seed Rona Couture DNA
  clientDnas.set('client-rona', {
    tenantId: 'tenant-rona',
    clientId: 'client-rona',
    name: 'Rona Haute Couture',
    code: 'RONA',
    version: 4,
    status: 'active',
    defaultLocale: 'ckb',
    defaultDirection: 'rtl',
    colors: [
      { name: 'Royal Plum', hex: '#4a154b', role: 'primary' },
      { name: 'Off White', hex: '#f8f5fa', role: 'background' },
      { name: 'Warm Amber', hex: '#ecb22e', role: 'accent' },
    ],
    fonts: [
      {
        family: 'Vazirmatn',
        style: 'Regular',
        weight: 400,
        role: 'body',
        license: 'OFL',
        supportedLocales: ['ckb', 'ar'],
      },
    ],
    assets: [
      {
        assetId: 'asset_rona_logo_1',
        name: 'Rona Signature Crest',
        role: 'logo_primary',
        storageKey: 'assets/rona/signature.svg',
        sha256: 'sha256_e39a174c81b2901a',
        mimeType: 'image/svg+xml',
      },
    ],
    guidelines: {
      voiceAndTone: 'Haute couture luxury, poetic Kurdish Sorani phrasing',
      prohibitedPhrases: ['cheap', 'standard', 'mass-produced'],
      requiredDisclaimers: [],
      layoutRules: [
        'Headline scale must be at least 2.5x body text with open leading',
        'Product photography must use smooth organic masks rather than sharp rectangular borders',
      ],
    },
    destinations: {
      googleSharedDriveId: 'drive_rona_fashion',
      productionFolderId: 'folder_rona_prod',
      archiveFolderId: 'folder_rona_archive',
      spreadsheetId: 'sheet_rona_lookbook',
      sheetId: 0,
    },
    approvalPolicy: {
      requiredRoles: ['art_director'],
      allowAutoApproval: false,
      autoApprovalEligibleTemplates: [],
    },
    updatedAt: new Date().toISOString(),
  });

  // Seed FastPay Mobile Wallet DNA
  clientDnas.set('client-fastpay', {
    tenantId: 'tenant-fastpay',
    clientId: 'client-fastpay',
    name: 'FastPay Mobile Wallet',
    code: 'FASTPAY',
    version: 1,
    status: 'active',
    defaultLocale: 'ckb',
    defaultDirection: 'rtl',
    colors: [
      { name: 'Electric Cobalt', hex: '#0045F5', role: 'primary' },
      { name: 'Midnight Navy', hex: '#071033', role: 'background' },
      { name: 'Fintech Magenta', hex: '#F72585', role: 'accent' },
    ],
    fonts: [
      {
        family: 'Vazirmatn',
        style: 'ExtraBold',
        weight: 800,
        role: 'display',
        license: 'OFL',
        supportedLocales: ['ckb', 'ar'],
      },
      {
        family: 'Inter',
        style: 'Bold',
        weight: 700,
        role: 'body',
        license: 'OFL',
        supportedLocales: ['en'],
      },
    ],
    assets: [
      {
        assetId: 'asset_fastpay_logo_1',
        name: 'Official FastPay Vector Wordmark & Lightning Bolt',
        role: 'logo_primary',
        storageKey: 'assets/fastpay/logo_official.svg',
        sha256: 'sha256_fastpay_fintech_verified_c89b21',
        mimeType: 'image/svg+xml',
      },
    ],
    guidelines: {
      voiceAndTone: 'Dynamic, high-trust Kurdish fintech messaging with Central Bank compliance',
      prohibitedPhrases: ['hidden fees', 'delayed', 'unlicensed'],
      requiredDisclaimers: ['مۆڵەتپێدراو لەلایەن بانکی ناوەندی عێراق (CBI)'],
      layoutRules: [
        'Central Bank regulatory badge must be pinned top-right',
        'Fintech badge 0% fee must use high-contrast cyan/magenta glow',
        'Official 1:1 format requires 32px safe margins',
      ],
    },
    destinations: {
      googleSharedDriveId: 'drive_fastpay_fintech',
      productionFolderId: 'folder_fastpay_prod',
      archiveFolderId: 'folder_fastpay_archive',
      spreadsheetId: 'sheet_fastpay_deliverables',
      sheetId: 0,
    },
    approvalPolicy: {
      requiredRoles: ['compliance_officer', 'art_director'],
      allowAutoApproval: false,
      autoApprovalEligibleTemplates: [],
    },
    updatedAt: new Date().toISOString(),
  });

  // Seed KAAE (Kurdistan Accrediting Association for Education)
  clientDnas.set('c1000000-0000-4000-8000-000000000002', kaaeClientDNA);
  clientDnas.set('kaae', kaaeClientDNA);

  const drusteeDna = clientDnas.get('client-drustee')!;
  if (drusteeDna) {
    clientDnas.set('c1000000-0000-4000-8000-000000000003', drusteeDna);
    clientDnas.set('drustee', drusteeDna);
    clientSnapshots.set('c1000000-0000-4000-8000-000000000003', [
      {
        snapshotId: 'snap_init_drustee_1',
        clientId: 'c1000000-0000-4000-8000-000000000003',
        version: 1,
        sha256: computeDnaHash(drusteeDna),
        commitMessage: 'Initial baseline Drustee health DNA with clinical green palette',
        createdBy: 'art_director',
        createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
        dna: drusteeDna,
      },
    ]);
  }

  const fastpayDna = clientDnas.get('client-fastpay')!;
  if (fastpayDna) {
    clientDnas.set('c1000000-0000-4000-8000-000000000004', fastpayDna);
    clientDnas.set('fastpay', fastpayDna);
    clientSnapshots.set('c1000000-0000-4000-8000-000000000004', [
      {
        snapshotId: 'snap_init_fastpay_1',
        clientId: 'c1000000-0000-4000-8000-000000000004',
        version: 1,
        sha256: computeDnaHash(fastpayDna),
        commitMessage: 'Initial baseline FastPay FinTech DNA',
        createdBy: 'art_director',
        createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
        dna: fastpayDna,
      },
    ]);
  }
  }

  if (!clientSnapshots.has('client-office-1')) {
  clientSnapshots.set('c1000000-0000-4000-8000-000000000002', [
    {
      snapshotId: 'snap_init_kaae_1',
      clientId: 'c1000000-0000-4000-8000-000000000002',
      version: 1,
      sha256: computeDnaHash(kaaeClientDNA),
      commitMessage: 'Initial baseline KAAE institutional DNA: 2025 guideline, Crimson Pro/Inter and KAAE Blue/Gold',
      createdBy: 'art_director',
      createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
      dna: kaaeClientDNA,
    },
  ]);
  clientSnapshots.set('kaae', clientSnapshots.get('c1000000-0000-4000-8000-000000000002')!);

  // Seed baseline governance snapshots for all clients
  clientSnapshots.set('client-office-1', [
    {
      snapshotId: 'snap_init_office_1',
      clientId: 'client-office-1',
      version: 1,
      sha256: computeDnaHash(clientDnas.get('client-office-1')!),
      commitMessage: 'Initial baseline studio DNA with verified Kurdish typography registry',
      createdBy: 'art_director',
      createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
      dna: structuredClone(clientDnas.get('client-office-1')!),
    },
  ]);

  clientSnapshots.set('client-drustee', [
    {
      snapshotId: 'snap_init_drustee_1',
      clientId: 'client-drustee',
      version: 1,
      sha256: computeDnaHash(clientDnas.get('client-drustee')!),
      commitMessage: 'Initial canonical Drustee DNA lock: Emerald/Gold palette, Kurdish medical disclaimers, and Vitamin D3 / Omega-3 assets',
      createdBy: 'art_director',
      createdAt: new Date(Date.now() - 3600000 * 2).toISOString(),
      dna: structuredClone(clientDnas.get('client-drustee')!),
    },
  ]);

  clientSnapshots.set('client-aster', [
    {
      snapshotId: 'snap_init_aster_12',
      clientId: 'client-aster',
      version: 12,
      sha256: computeDnaHash(clientDnas.get('client-aster')!),
      commitMessage: 'Promoted numeral preservation rule and gold brand asset registry',
      createdBy: 'art_director',
      createdAt: new Date(Date.now() - 3600000 * 4).toISOString(),
      dna: structuredClone(clientDnas.get('client-aster')!),
    },
    {
      snapshotId: 'snap_init_aster_11',
      clientId: 'client-aster',
      version: 11,
      sha256: 'sha256_8291ba4c9201f8e2',
      commitMessage: 'Added Kurdish Sorani hospitality tone and Meta 4:5 safe margins',
      createdBy: 'operator',
      createdAt: new Date(Date.now() - 86400000 * 5).toISOString(),
      dna: { ...structuredClone(clientDnas.get('client-aster')!), version: 11 },
    },
  ]);

  clientSnapshots.set('client-nova', [
    {
      snapshotId: 'snap_init_nova_8',
      clientId: 'client-nova',
      version: 8,
      sha256: computeDnaHash(clientDnas.get('client-nova')!),
      commitMessage: 'Enforced WCAG AAA contrast ratio on high-impact safety orange CTA targets',
      createdBy: 'creative_director',
      createdAt: new Date(Date.now() - 3600000 * 8).toISOString(),
      dna: structuredClone(clientDnas.get('client-nova')!),
    },
    {
      snapshotId: 'snap_init_nova_7',
      clientId: 'client-nova',
      version: 7,
      sha256: 'sha256_3fa90812bca01e74',
      commitMessage: 'Registered Noto Sans Arabic typography and deep navy background token',
      createdBy: 'art_director',
      createdAt: new Date(Date.now() - 86400000 * 7).toISOString(),
      dna: { ...structuredClone(clientDnas.get('client-nova')!), version: 7 },
    },
  ]);

  clientSnapshots.set('client-rona', [
    {
      snapshotId: 'snap_init_rona_4',
      clientId: 'client-rona',
      version: 4,
      sha256: computeDnaHash(clientDnas.get('client-rona')!),
      commitMessage: 'Haute couture luxury voice guidelines and organic product masking invariants',
      createdBy: 'art_director',
      createdAt: new Date(Date.now() - 3600000 * 12).toISOString(),
      dna: structuredClone(clientDnas.get('client-rona')!),
    },
  ]);

  clientSnapshots.set('client-fastpay', [
    {
      snapshotId: 'snap_init_fastpay_1',
      clientId: 'client-fastpay',
      version: 1,
      sha256: computeDnaHash(clientDnas.get('client-fastpay')!),
      commitMessage: 'Initial FastPay DNA lock: Electric Cobalt, CBI compliance, and 1:1 fintech promo layout',
      createdBy: 'art_director',
      createdAt: new Date(Date.now() - 3600000 * 2).toISOString(),
      dna: structuredClone(clientDnas.get('client-fastpay')!),
    },
  ]);

  clientSnapshots.set('c1000000-0000-4000-8000-000000000002', [
    {
      snapshotId: 'snap_init_kaae_1',
      clientId: 'c1000000-0000-4000-8000-000000000002',
      version: 1,
      sha256: computeDnaHash(kaaeClientDNA),
      commitMessage: 'Official KAAE Brand DNA lock: Law No. 6 of 2022 statutory authority, 21-ray sunburst emblem, and the 2025 guideline Crimson Pro/Inter typography',
      createdBy: 'autonomous_creative_director',
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      dna: structuredClone(kaaeClientDNA),
    },
  ]);
  clientSnapshots.set('kaae', clientSnapshots.get('c1000000-0000-4000-8000-000000000002')!);
  }
}
