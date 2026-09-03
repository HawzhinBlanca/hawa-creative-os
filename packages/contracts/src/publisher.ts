import type { AppError, ISODateTime, JsonObject, RequestContext, Result, SHA256, UUID } from './common.js';

export interface PackageFile {
  artifactId: UUID;
  relativePath: string;
  storageKey: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: SHA256;
}

export interface PublishRequest {
  taskId: UUID;
  clientId: UUID;
  projectId?: UUID;
  designRevisionId: UUID;
  approvalId: UUID;
  publicationKey: string;
  packageHash: SHA256;
  files: PackageFile[];
  destination: {
    sharedDriveId: string;
    productionRootFolderId: string;
    relativeFolderParts: string[];
    spreadsheetId: string;
    sheetId: number;
  };
  sheetRow: Record<string, string | number | boolean | null>;
}

export interface DriveFileReceipt {
  artifactId: UUID;
  fileId: string;
  folderId: string;
  name: string;
  mimeType: string;
  observedSize: number;
  expectedSha256: SHA256;
  verified: boolean;
  webViewLink?: string;
}

export interface PublicationReceipt {
  publicationId: UUID;
  publicationKey: string;
  driveFolderId: string;
  driveFiles: DriveFileReceipt[];
  sheet: { spreadsheetId: string; sheetId: number; rowKey: string; rowNumber?: number; expectedHash: SHA256; observedHash?: SHA256; synced: boolean };
  completedAt?: ISODateTime;
  state: 'drive_complete' | 'complete' | 'failed';
  detail: JsonObject;
}

export interface Publisher {
  publish(ctx: RequestContext, request: PublishRequest): Promise<Result<PublicationReceipt, AppError>>;
  reconcile(ctx: RequestContext, publicationId: UUID): Promise<Result<PublicationReceipt>>;
  verify(ctx: RequestContext, publicationId: UUID): Promise<Result<{ consistent: boolean; differences: JsonObject[] }>>;
}
