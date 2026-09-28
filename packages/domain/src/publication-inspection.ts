import type { PublicationInspectionInput, PublicationExternalObservation, PublicationInspectionComparison,
  PublicationInspectionFinding, PermissionObservation, DriveItemObservation } from '@hawa/contracts';

/** Compare immutable input with observations; neither SDKs nor persistence decide truth here. */
export function comparePublicationInspection(input: PublicationInspectionInput, observed: PublicationExternalObservation): PublicationInspectionComparison {
  const findings: PublicationInspectionFinding[] = [];
  const add = (code: PublicationInspectionFinding['code'], resource: PublicationInspectionFinding['resource'], resourceId: string | null,
    status: PublicationInspectionFinding['status'] = 'unverified') => findings.push({ code, resource, resourceId, status });
  const permissions = (baseline: string | null, actual: PermissionObservation | undefined,
    resource: PublicationInspectionFinding['resource'], id: string | null) => {
    if (!actual || actual.status !== 'observed' || !actual.sha256) add('PERMISSIONS_READ_UNAVAILABLE', resource, id);
    if (!baseline) add('PERMISSIONS_BASELINE_UNAVAILABLE', resource, id);
    else if (actual?.status === 'observed' && actual.sha256 && actual.sha256 !== baseline) add('PERMISSIONS_CHANGED', resource, id, 'divergent');
    if (!baseline && id && input.priorPermissionSha256[id] && actual?.status === 'observed' && actual.sha256 &&
      actual.sha256 !== input.priorPermissionSha256[id]) add('PERMISSIONS_CHANGED', resource, id, 'divergent');
  };
  const original = input.original;
  if (!original) return { status: 'unverified', findings: [{ code: 'ORIGINAL_INPUT_UNAVAILABLE', resource: 'publication', resourceId: input.publicationId, status: 'unverified' }], checkedFiles: 0 };
  const folderId = original.destination.productionRootFolderId;
  const folder = observed.folder;
  if (!folder || folder.resourceId !== folderId || folder.status !== 'observed' || !folder.item) add('DRIVE_READ_UNAVAILABLE', 'folder', folderId);
  else if (folder.item.id !== folderId || folder.item.trashed || folder.item.mimeType !== 'application/vnd.google-apps.folder' ||
    original.destination.sharedDriveId && folder.item.sharedDriveId !== original.destination.sharedDriveId) add('DRIVE_METADATA_CHANGED', 'folder', folderId, 'divergent');
  permissions(input.folderPermissionSha256, folder?.permissions, 'folder', folderId);
  let checkedFiles = 0;
  for (const expected of original.files) {
    const saved = input.files.filter(file => file.artifactId === expected.artifactId);
    if (saved.length !== 1 || !saved[0].fileId) { add('DRIVE_ID_UNRESERVED', 'file', null); continue; }
    const id = saved[0].fileId;
    const reads = observed.files.filter(file => file.resourceId === id);
    const file: DriveItemObservation | undefined = reads.length === 1 ? reads[0] : undefined;
    if (!file || file.status !== 'observed' || !file.item) add('DRIVE_READ_UNAVAILABLE', 'file', id);
    else {
      checkedFiles++;
      const actual = file.item;
      if (actual.id !== id || actual.trashed || actual.name !== expected.filename || actual.mimeType !== expected.mimeType ||
        actual.size !== expected.byteSize || actual.parents.length !== 1 || actual.parents[0] !== folderId ||
        original.destination.sharedDriveId && actual.sharedDriveId !== original.destination.sharedDriveId ||
        folder?.item && actual.sharedDriveId !== folder.item.sharedDriveId ||
        actual.properties.taskId !== input.taskId || actual.properties.artifactId !== expected.artifactId ||
        actual.properties.packageHash !== original.packageHash) add('DRIVE_METADATA_CHANGED', 'file', id, 'divergent');
      if (!actual.sha256) add('DRIVE_CHECKSUM_UNAVAILABLE', 'file', id);
      else if (actual.sha256 !== expected.sha256) add('DRIVE_CHECKSUM_CHANGED', 'file', id, 'divergent');
    }
    permissions(saved[0].permissionSha256, file?.permissions, 'file', id);
  }
  if (observed.duplicates.status !== 'observed') add('DRIVE_DUPLICATES_UNVERIFIED', 'folder', folderId);
  else {
    const reserved = new Set(input.files.flatMap(file => file.fileId ? [file.fileId] : []));
    for (const id of observed.duplicates.fileIds) if (!reserved.has(id)) add('DRIVE_DUPLICATES_FOUND', 'file', id, 'divergent');
  }
  const sheet = observed.sheet;
  if (!input.sheet || !input.sheetRowSha256) add('SHEET_EXPECTATION_UNAVAILABLE', 'sheet', original.destination.spreadsheetId || null);
  else {
    const id = input.sheet.spreadsheetId;
    if (!sheet || sheet.status !== 'observed') add('SHEET_READ_UNAVAILABLE', 'sheet', id);
    else if (sheet.metadataId !== input.sheet.metadataId || sheet.rowSha256 !== input.sheetRowSha256 || !sheet.rowNumber || sheet.rowNumber < 2)
      add('SHEET_ROW_CHANGED', 'sheet', id, 'divergent');
    permissions(input.sheetPermissionSha256, sheet?.permissions, 'sheet', id);
  }
  return { status: findings.some(f => f.status === 'divergent') ? 'divergent' : findings.length ? 'unverified' : 'consistent', findings, checkedFiles };
}
