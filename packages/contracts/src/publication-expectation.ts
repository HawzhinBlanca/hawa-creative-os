import type { PackageFile, PublishRequest } from './publisher.js';

export interface PublicationExpectation {
  schemaVersion: 1;
  tenantId: string; publicationId: string; taskId: string; clientId: string; projectId: string | null;
  designRevisionId: string; approvalId: string; publicationKey: string; packageHash: string;
  destination: PublishRequest['destination'];
  files: Omit<PackageFile, 'content'>[];
  publishedAt: string;
}
export interface PublicationSheetExpectation {
  schemaVersion: 1;
  tenantId: string; publicationId: string; taskId: string; clientId: string;
  spreadsheetId: string; sheetId: number; metadataId: number; metadataValue: string;
  expectedValues: string[];
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, limit = 500): v is string => typeof v === 'string' && v.length > 0 && v.length <= limit && !v.includes('\0');
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function parsePublicationExpectation(value: unknown): PublicationExpectation | null {
  if (!object(value) || value.schemaVersion !== 1 ||
    !['tenantId','publicationId','taskId','clientId','designRevisionId','approvalId'].every(k => uuid(value[k])) ||
    !(value.projectId === null || uuid(value.projectId)) || !text(value.publicationKey) || !sha(value.packageHash) ||
    typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt)) ||
    new Date(value.publishedAt).toISOString() !== value.publishedAt || !object(value.destination)) return null;
  const d = value.destination;
  if (typeof d.sharedDriveId !== 'string' || d.sharedDriveId.length > 500 || !text(d.productionRootFolderId) ||
    typeof d.spreadsheetId !== 'string' || d.spreadsheetId.length > 500 || !Number.isSafeInteger(d.sheetId) || Number(d.sheetId) < 0 ||
    !Array.isArray(d.relativeFolderParts) || d.relativeFolderParts.length > 20 || !d.relativeFolderParts.every(p => text(p))) return null;
  if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > 100 || !value.files.every(f => object(f) &&
    uuid(f.artifactId) && text(f.relativePath, 2000) && text(f.storageKey, 2000) && text(f.filename) && text(f.mimeType, 200) &&
    Number.isSafeInteger(f.byteSize) && Number(f.byteSize) > 0 && sha(f.sha256) && !('content' in f)) ||
    new Set(value.files.map(f => f.artifactId)).size !== value.files.length) return null;
  return value as unknown as PublicationExpectation;
}

/** Reuse frozen names/destinations; only bytes come from the newly checked approved artifacts. */
export function publicationRequestFromExpectation(expectation: PublicationExpectation, current: PublishRequest,
  sheet?: PublicationSheetExpectation | null): PublishRequest {
  if (expectation.taskId !== current.taskId || expectation.clientId !== current.clientId ||
    (current.projectId !== undefined && expectation.projectId !== current.projectId) ||
    expectation.approvalId !== current.approvalId || expectation.designRevisionId !== current.designRevisionId ||
    expectation.publicationKey !== current.publicationKey || expectation.packageHash !== current.packageHash ||
    expectation.files.length !== current.files.length) throw new Error('PUBLICATION_EXPECTATION_CONFLICT');
  if (sheet && (sheet.schemaVersion !== 1 || sheet.tenantId !== expectation.tenantId ||
    sheet.publicationId !== expectation.publicationId || sheet.taskId !== expectation.taskId || sheet.clientId !== expectation.clientId ||
    !text(sheet.spreadsheetId) || !Number.isSafeInteger(sheet.sheetId) || sheet.sheetId < 0 ||
    !Number.isSafeInteger(sheet.metadataId) || sheet.metadataId < 1 || sheet.metadataId > 0x7fffffff ||
    sheet.metadataValue !== JSON.stringify(['hawa.sheet-row.v1', sheet.tenantId, sheet.spreadsheetId, sheet.sheetId, sheet.taskId]) ||
    !Array.isArray(sheet.expectedValues) || sheet.expectedValues.length !== 7 || !sheet.expectedValues.every(v => text(v, 2000)) ||
    sheet.expectedValues[0] !== expectation.taskId || sheet.expectedValues[1] !== expectation.clientId ||
    sheet.expectedValues[2] !== expectation.destination.productionRootFolderId || sheet.expectedValues[3] !== expectation.publishedAt ||
    sheet.expectedValues[4] !== 'COMPLETE' || sheet.expectedValues[6] !== expectation.packageHash ||
    (expectation.destination.spreadsheetId !== '' && (sheet.spreadsheetId !== expectation.destination.spreadsheetId ||
      sheet.sheetId !== expectation.destination.sheetId)))) throw new Error('SHEET_EXPECTATION_CONFLICT');
  const files = expectation.files.map(file => {
    const matches = current.files.filter(f => f.artifactId === file.artifactId);
    if (matches.length !== 1 || matches[0].sha256 !== file.sha256 || matches[0].byteSize !== file.byteSize ||
      matches[0].mimeType !== file.mimeType) throw new Error('PUBLICATION_EXPECTATION_CONFLICT');
    return { ...file, content: matches[0].content };
  });
  return { taskId: expectation.taskId, clientId: expectation.clientId,
    ...(expectation.projectId ? { projectId: expectation.projectId } : {}),
    designRevisionId: expectation.designRevisionId, approvalId: expectation.approvalId,
    publicationKey: expectation.publicationKey, packageHash: expectation.packageHash, files,
    destination: { ...expectation.destination,
      // An originally absent Sheet may be bound on its first configured attempt.
      ...(!expectation.destination.spreadsheetId ? { spreadsheetId: current.destination.spreadsheetId, sheetId: current.destination.sheetId } : {}),
      ...(sheet ? { spreadsheetId: sheet.spreadsheetId, sheetId: sheet.sheetId } : {}) },
    sheetRow: { taskId: expectation.taskId, client: expectation.clientId, status: 'COMPLETE', publishedAt: expectation.publishedAt },
  };
}
