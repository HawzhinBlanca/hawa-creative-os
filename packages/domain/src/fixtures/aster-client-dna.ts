import type { ClientDNA } from '../client-dna.js';

export const asterClientDNA: ClientDNA = {
  tenantId: 'a0000000-0000-4000-8000-000000000001',
  clientId: 'c1000000-0000-4000-8000-000000000004',
  name: 'Aster Luxury Resort & Hospitality Erbil',
  code: 'ASTER',
  version: 1,
  status: 'active',
  defaultLocale: 'ckb',
  defaultDirection: 'rtl',
  colors: [
    {
      name: 'Aster Royal Gold',
      hex: '#D4AF37',
      role: 'primary',
      cmyk: '20,30,80,10',
      pantone: 'PANTONE 871 C',
    },
    {
      name: 'Aster Midnight Slate',
      hex: '#0F172A',
      role: 'secondary',
      cmyk: '85,75,45,65',
      pantone: 'PANTONE 433 C',
    },
    {
      name: 'Aster Champagne Silk',
      hex: '#F7F4EA',
      role: 'background',
      cmyk: '2,3,8,0',
    },
    {
      name: 'Aster Pure White',
      hex: '#FFFFFF',
      role: 'surface',
      cmyk: '0,0,0,0',
    },
    {
      name: 'Aster Charcoal Text',
      hex: '#1E293B',
      role: 'text',
      cmyk: '0,0,0,90',
    },
  ],
  fonts: [
    {
      family: 'Playfair Display',
      style: 'Normal',
      weight: '600',
      role: 'display',
      license: 'SIL Open Font License (Luxury Latin Display)',
      supportedLocales: ['en'],
    },
    {
      family: 'Noto Serif Arabic',
      style: 'Normal',
      weight: '700',
      role: 'display',
      license: 'SIL Open Font License (Luxury Kurdish Sorani)',
      supportedLocales: ['ckb', 'ar'],
    },
    {
      family: 'Noto Sans Arabic',
      style: 'Regular',
      weight: '400',
      role: 'body',
      license: 'SIL Open Font License',
      supportedLocales: ['ckb', 'ar'],
    },
  ],
  assets: [
    {
      assetId: 'f2000000-0000-4000-8000-000000000020',
      name: 'Aster Luxury Resort Crest Vector Logo',
      role: 'logo_primary',
      storageKey: 'clients/aster/brand/assets/aster-luxury-logo.svg',
      sha256: '8e1c940562e84120f21469e3498b82103f1a23e98b0461298c4371906a5b78cd',
      mimeType: 'image/svg+xml',
      minimumWidthPx: 160,
      clearSpacePx: 32,
      allowedBackgrounds: ['#0F172A', '#F7F4EA', '#FFFFFF'],
      prohibitedModifications: [
        'Do not alter five-pointed star and mountain crest silhouette',
        'Do not place on high-saturation clashing patterns',
      ],
    },
  ],
  guidelines: {
    voiceAndTone:
      'Refined, welcoming, prestigious, luxurious and discreet. Emphasizes world-class Kurdish hospitality in Erbil with understated elegance.',
    prohibitedPhrases: [
      'Cheap stay',
      'Budget motel',
      'Discount rooms',
      'Fast food dining',
    ],
    requiredDisclaimers: [
      'Aster Resort & Spa Erbil operates under Kurdistan Tourism Board License No. 88/2020.',
      'Reservations subject to hospitality concierge availability.',
    ],
    layoutRules: [
      'Always maintain generous negative space around Aster luxury crest (minimum 32px clear zone).',
      'Display typography must use Noto Serif Arabic / Playfair Display.',
      'High-contrast luxury palette: Royal Gold (#D4AF37) against Midnight Slate (#0F172A).',
    ],
  },
  destinations: {
    googleSharedDriveId: '1XiMeNxKm3ofVSMr4pItZr4NDPltXUjYr_ASTER',
    productionFolderId: '1XiMeNxKm3ofVSMr4pItZr4NDPltXUjYr_ASTER_PROD',
    archiveFolderId: '1XiMeNxKm3ofVSMr4pItZr4NDPltXUjYr_ASTER_ARCHIVE',
    spreadsheetId: '1BXLlHxozjR4KRwEQ-hvNPgvlCtp-6_FQAL7EJ4GZ',
    sheetId: 2,
  },
  canvaMapping: {
    canvaTeamId: 'team_aster_erbil',
    canvaBrandKitId: 'kit_aster_2026',
    canvaTemplateIds: {
      suite_showcase: 'DAF_aster_suite_01',
      event_announcement: 'DAF_aster_event_02',
      gourmet_square: 'DAF_aster_sq_03',
    },
    verifiedAt: '2026-09-11T20:00:00Z',
  },
  approvalPolicy: {
    requiredRoles: ['hospitality_director', 'general_manager'],
    allowAutoApproval: false,
    autoApprovalEligibleTemplates: [],
  },
  updatedAt: '2026-09-11T12:00:00Z',
};
