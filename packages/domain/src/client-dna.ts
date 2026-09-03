import type { UUID, SHA256, ISODateTime, Result, AppError } from '@hawa/contracts';

export interface BrandColor {
  name: string;
  hex: string;
  role: 'primary' | 'secondary' | 'accent' | 'background' | 'surface' | 'text';
  cmyk?: string;
  pantone?: string;
}

export interface BrandFont {
  family: string;
  style: string;
  weight: number | string;
  role: 'display' | 'body' | 'caption' | 'code';
  storageKey?: string;
  sha256?: SHA256;
  license: string;
  supportedLocales: string[];
}

export interface OfficialAsset {
  assetId: UUID;
  name: string;
  role: 'logo_primary' | 'logo_secondary' | 'logo_symbol' | 'badge' | 'watermark' | 'pattern';
  storageKey: string;
  sha256: SHA256;
  mimeType: string;
  minimumWidthPx?: number;
  clearSpacePx?: number;
  allowedBackgrounds?: string[];
  prohibitedModifications?: string[];
}

export interface ClientDNA {
  tenantId: UUID;
  clientId: UUID;
  name: string;
  code: string;
  version: number;
  status: 'active' | 'archived' | 'draft';
  defaultLocale: 'ckb' | 'ar' | 'en';
  defaultDirection: 'rtl' | 'ltr';
  colors: BrandColor[];
  fonts: BrandFont[];
  assets: OfficialAsset[];
  guidelines: {
    voiceAndTone: string;
    prohibitedPhrases: string[];
    requiredDisclaimers: string[];
    layoutRules: string[];
  };
  destinations: {
    googleSharedDriveId: string;
    productionFolderId: string;
    archiveFolderId: string;
    spreadsheetId: string;
    sheetId: number;
  };
  approvalPolicy: {
    requiredRoles: string[];
    allowAutoApproval: boolean;
    autoApprovalEligibleTemplates: string[];
  };
  updatedAt: ISODateTime;
}

export function validateClientDna(dna: ClientDNA): Result<ClientDNA, AppError> {
  if (!dna.tenantId || !dna.clientId || !dna.name || !dna.code) {
    return {
      ok: false,
      error: {
        code: 'INVALID_CLIENT_DNA',
        message: 'Missing required Client DNA identity fields (tenantId, clientId, name, code)',
        retryable: false,
        safeAction: 'Fill missing fields in Client DNA Editor in Hawa Desk',
      },
    };
  }

  if (!dna.destinations.googleSharedDriveId || !dna.destinations.productionFolderId) {
    return {
      ok: false,
      error: {
        code: 'MISSING_CLIENT_DESTINATIONS',
        message: 'Client DNA must specify a Google Shared Drive and Production folder ID',
        retryable: false,
        safeAction: 'Configure publishing destinations before creating creative tasks',
      },
    };
  }

  const hasPrimaryLogo = dna.assets.some((a) => a.role === 'logo_primary');
  if (!hasPrimaryLogo) {
    return {
      ok: false,
      error: {
        code: 'MISSING_PRIMARY_LOGO',
        message: 'Client DNA requires at least one official primary logo asset with verified sha256',
        retryable: false,
        safeAction: 'Upload official logo asset to client creative library',
      },
    };
  }

  return { ok: true, value: dna };
}
