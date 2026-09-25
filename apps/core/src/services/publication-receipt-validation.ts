import type { PackageFile, PublicationReceipt } from '@hawa/contracts';

/** Check the publisher's answer against the exact approved package before Core records any receipt. */
export function validatePublicationReceipt(
  receipt: PublicationReceipt,
  expected: { publicationKey: string; taskId: string; packageHash: string; spreadsheetId: string; files: readonly PackageFile[] },
): { ok: true } | { ok: false; reason: string } {
  if ((receipt.emulated !== undefined && receipt.emulated !== false) ||
      !receipt.publicationId || !receipt.driveFolderId ||
      receipt.publicationKey !== expected.publicationKey) {
    return { ok: false, reason: 'Publisher returned an emulated or different publication' };
  }
  if (receipt.state !== 'complete' && receipt.state !== 'drive_complete') {
    return { ok: false, reason: 'Publisher did not confirm a deliverable archive state' };
  }
  if (!Array.isArray(receipt.driveFiles) || expected.files.length === 0 ||
      receipt.driveFiles.length !== expected.files.length) {
    return { ok: false, reason: 'Drive receipts do not cover the approved package exactly' };
  }
  const approved = new Map(expected.files.map((file) => [file.artifactId, file]));
  if (approved.size !== expected.files.length) {
    return { ok: false, reason: 'Approved package contains a repeated artifact identity' };
  }
  const seen = new Set<string>();
  const seenFileIds = new Set<string>();
  for (const file of receipt.driveFiles) {
    const source = approved.get(file.artifactId);
    if (!source || seen.has(file.artifactId) || seenFileIds.has(file.fileId) || file.verified !== true ||
        !file.fileId || !file.folderId || !file.name || file.mimeType !== source.mimeType ||
        file.expectedSha256 !== source.sha256 || file.observedSize !== source.byteSize) {
      return { ok: false, reason: 'A Drive receipt is missing, duplicated, unverified, or differs from the approved bytes' };
    }
    seen.add(file.artifactId);
    seenFileIds.add(file.fileId);
  }
  const sheet = receipt.sheet;
  if (!sheet || sheet.spreadsheetId !== expected.spreadsheetId || sheet.rowKey !== expected.taskId ||
      sheet.expectedHash !== expected.packageHash) {
    return { ok: false, reason: 'Sheet receipt does not name the approved task and package' };
  }
  if (receipt.state === 'complete' && (sheet.synced !== true || sheet.observedHash !== expected.packageHash ||
      !Number.isSafeInteger(sheet.rowNumber) || Number(sheet.rowNumber) < 1)) {
    return { ok: false, reason: 'Publisher claimed completion without a confirmed matching Sheet row' };
  }
  if (receipt.state === 'drive_complete' && sheet.synced !== false) {
    return { ok: false, reason: 'Publisher marked the Sheet synced but left the publication incomplete' };
  }
  return { ok: true };
}
