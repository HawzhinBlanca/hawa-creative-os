import type { PublicationExpectation, PublicationSheetExpectation } from './publication-expectation.js';
import type { RequestContext } from './common.js';

export interface PublicationInspectionInput {
  schemaVersion: 1;
  tenantId: string; publicationId: string; taskId: string; clientId: string;
  original: PublicationExpectation | null;
  sheet: PublicationSheetExpectation | null;
  sheetRowSha256: string | null;
  files: Array<{ artifactId: string; fileId: string | null; permissionSha256: string | null }>;
  folderPermissionSha256: string | null;
  sheetPermissionSha256: string | null;
  /** Change detection from a previous read; this does not establish authorized access. */
  priorPermissionSha256: Record<string, string>;
}
export interface PermissionObservation {
  status: 'observed' | 'unavailable'; sha256: string | null; count: number | null; code?: string;
}
export interface DriveItemObservation {
  resourceId: string; status: 'observed' | 'unavailable'; code?: string;
  item?: { id: string; name: string; mimeType: string; size: number | null; sha256: string | null;
    trashed: boolean; parents: string[]; sharedDriveId: string; version: string;
    properties: Record<string, string> };
  permissions: PermissionObservation;
}
export interface PublicationExternalObservation {
  schemaVersion: 1;
  startedAt: string; finishedAt: string;
  folder: DriveItemObservation | null;
  files: DriveItemObservation[];
  duplicates: { status: 'observed' | 'unavailable'; fileIds: string[]; code?: string };
  sheet: { status: 'observed' | 'unavailable'; metadataId: number | null; rowNumber: number | null;
    rowSha256: string | null; code?: string; permissions: PermissionObservation } | null;
}
export type PublicationInspectionCode =
  | 'ORIGINAL_INPUT_UNAVAILABLE' | 'DRIVE_ID_UNRESERVED' | 'DRIVE_READ_UNAVAILABLE'
  | 'DRIVE_METADATA_CHANGED' | 'DRIVE_CHECKSUM_UNAVAILABLE' | 'DRIVE_CHECKSUM_CHANGED'
  | 'DRIVE_DUPLICATES_FOUND' | 'DRIVE_DUPLICATES_UNVERIFIED'
  | 'PERMISSIONS_BASELINE_UNAVAILABLE' | 'PERMISSIONS_READ_UNAVAILABLE' | 'PERMISSIONS_CHANGED'
  | 'SHEET_EXPECTATION_UNAVAILABLE' | 'SHEET_READ_UNAVAILABLE' | 'SHEET_ROW_CHANGED';
export interface PublicationInspectionFinding {
  code: PublicationInspectionCode; resource: 'publication' | 'folder' | 'file' | 'sheet';
  resourceId: string | null; status: 'divergent' | 'unverified';
}
export interface PublicationInspectionComparison {
  status: 'consistent' | 'divergent' | 'unverified';
  findings: PublicationInspectionFinding[];
  checkedFiles: number;
}
export interface PublicationInspector {
  inspectPublication(context: RequestContext, input: PublicationInspectionInput): Promise<PublicationExternalObservation>;
}

export interface PublicationInspectionView {
  publicationId: string; taskId: string; clientId: string;
  inspectionId: string | null; state: 'uninspected' | 'running' | 'finished' | 'interrupted' | 'superseded';
  status: PublicationInspectionComparison['status']; stale: boolean; startedAt: string | null; finishedAt: string | null;
  inputsSha256: string | null; resultSha256: string | null;
  checkedFiles: number; findings: PublicationInspectionFinding[];
}
export interface PublicationInspectionState {
  schemaVersion: 1; tenantId: string; userId: string; checkedAt: string;
  schedule: { enabled: boolean; intervalMinutes: 60 };
  items: PublicationInspectionView[]; nextAfter: string | null;
}

const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
export function parsePublicationInspectionState(value: unknown): PublicationInspectionState | null {
  if (!object(value) || value.schemaVersion !== 1 || !uuid(value.tenantId) || !uuid(value.userId) || !date(value.checkedAt) ||
    !object(value.schedule) || typeof value.schedule.enabled !== 'boolean' || value.schedule.intervalMinutes !== 60 ||
    !(value.nextAfter === null || uuid(value.nextAfter)) || !Array.isArray(value.items) || value.items.length > 50) return null;
  const codes: PublicationInspectionCode[] = ['ORIGINAL_INPUT_UNAVAILABLE','DRIVE_ID_UNRESERVED','DRIVE_READ_UNAVAILABLE','DRIVE_METADATA_CHANGED',
    'DRIVE_CHECKSUM_UNAVAILABLE','DRIVE_CHECKSUM_CHANGED','DRIVE_DUPLICATES_FOUND','DRIVE_DUPLICATES_UNVERIFIED','PERMISSIONS_BASELINE_UNAVAILABLE',
    'PERMISSIONS_READ_UNAVAILABLE','PERMISSIONS_CHANGED','SHEET_EXPECTATION_UNAVAILABLE','SHEET_READ_UNAVAILABLE','SHEET_ROW_CHANGED'];
  for (const r of value.items) {
    if (!object(r) || !uuid(r.publicationId) || !uuid(r.taskId) || !uuid(r.clientId) || !(r.inspectionId === null || uuid(r.inspectionId)) ||
      !['uninspected','running','finished','interrupted','superseded'].includes(String(r.state)) || !['consistent','divergent','unverified'].includes(String(r.status)) ||
      typeof r.stale !== 'boolean' || !(r.startedAt === null || date(r.startedAt)) || !(r.finishedAt === null || date(r.finishedAt)) ||
      !(r.inputsSha256 === null || sha(r.inputsSha256)) || !(r.resultSha256 === null || sha(r.resultSha256)) ||
      !Number.isSafeInteger(r.checkedFiles) || Number(r.checkedFiles) < 0 || Number(r.checkedFiles) > 100 ||
      !Array.isArray(r.findings) || r.findings.length > 2000 || !r.findings.every(f => object(f) && codes.includes(f.code as PublicationInspectionCode) &&
        ['publication','folder','file','sheet'].includes(String(f.resource)) && (f.resourceId === null || typeof f.resourceId === 'string' && f.resourceId.length <= 2000) &&
        ['divergent','unverified'].includes(String(f.status)))) return null;
    if (r.state === 'uninspected' && (r.inspectionId !== null || r.startedAt !== null || r.finishedAt !== null || r.status !== 'unverified') ||
      r.state !== 'uninspected' && (!uuid(r.inspectionId) || !date(r.startedAt) || !sha(r.inputsSha256)) ||
      r.state === 'running' && (r.status !== 'unverified' || r.finishedAt !== null || r.resultSha256 !== null) ||
      ['finished','interrupted','superseded'].includes(String(r.state)) && (!date(r.finishedAt) || !sha(r.resultSha256)) ||
      r.status === 'consistent' && (r.state !== 'finished' || r.stale || r.findings.length > 0) ||
      r.status === 'divergent' && !r.findings.some(f => f.status === 'divergent')) return null;
  }
  if (new Set(value.items.map(r => r.publicationId)).size !== value.items.length ||
    value.nextAfter !== null && (value.items.length !== 50 || value.items[49].publicationId !== value.nextAfter)) return null;
  return value as unknown as PublicationInspectionState;
}
