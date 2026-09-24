/**
 * What a task's delivery left in Postgres: the publication, its Drive files and its Sheets row.
 *
 * Core used to keep the last delivery of each task in a map (`omnichannelReceipts`), which the
 * receipt, publication-state and reconciliation routes read. A restart emptied it, so a delivered
 * task had no receipt and the reconciliation audit saw nothing delivered; a second Core process
 * never had one (architecture programme 1.3, SPLIT_PLAN.md section 7, group G5). The delivery
 * already records every file and row here (services/omnichannel-delivery.ts); this reads them back
 * in the shape the map held, so the routes answer the same whichever process delivered.
 */
import { withRlsContext, type Database, type Kysely, type PublicationRepository } from '@hawa/db';

export interface ReceiptFile {
  taskId: string;
  fileId: string;
  folderId: string;
  sha256: string;
  byteSize: number;
}

export interface ReceiptSheetRow {
  taskId: string;
  rowNumber: number;
  status: 'COMPLETE';
  packageHash: string;
  syncedAt: string;
}

/** A confirmed Drive file in the publisher's own receipt shape (GooglePublisher's driveFiles). */
export interface ReceiptDriveFile {
  fileId: string;
  folderId: string;
  name: string;
  mimeType: string;
  expectedSha256: string;
  observedSize: number;
  verified: true;
}

export interface StoredPublicationReceipt {
  publicationId: string;
  publicationKey: string;
  /** The publication's state: pending, drive_complete, complete or failed. */
  state: string;
  /** Files Drive confirmed (verified); an upload Drive did not confirm is left out for the audit. */
  files: ReceiptFile[];
  /** The same files as the publisher reported them, so a stored answer has a fresh one's shape. */
  driveFiles: ReceiptDriveFile[];
  /** The Sheets row, only when Sheets confirmed it (synced). */
  sheetRow?: ReceiptSheetRow;
  completedAt: string | null;
  recordedIn: 'postgres';
}

export interface ReceiptScope {
  tenantId: string;
  userId: string;
  role: string;
}

const iso = (value: unknown): string | null => (value ? new Date(value as string | Date).toISOString() : null);

/** The latest publication of a task with its confirmed files and row, or null when it has none. */
export async function readPublicationReceipt(
  db: Kysely<Database>,
  publicationRepo: PublicationRepository,
  scope: ReceiptScope,
  taskId: string
): Promise<StoredPublicationReceipt | null> {
  return withRlsContext(db, scope, async (trx) => {
    const publication = await publicationRepo.findByTaskId(taskId, scope.tenantId, trx);
    if (!publication) return null;
    const full = await publicationRepo.getPublicationWithRefs(String(publication.id), scope.tenantId, trx);
    const syncedRow = full?.sheetSyncs.find((s) => s.status === 'synced' && s.row_number !== null);
    const verified = (full?.driveRefs ?? []).filter((f) => f.status === 'verified');
    return {
      publicationId: String(publication.id),
      publicationKey: publication.publication_key,
      state: String(publication.state),
      files: verified.map((f) => ({
        taskId,
        fileId: f.file_id,
        folderId: f.folder_id,
        sha256: f.expected_sha256 ?? '',
        byteSize: Number(f.observed_size ?? 0),
      })),
      driveFiles: verified.map((f) => ({
        fileId: f.file_id,
        folderId: f.folder_id,
        name: f.file_name,
        mimeType: f.mime_type,
        expectedSha256: f.expected_sha256 ?? '',
        observedSize: Number(f.observed_size ?? 0),
        verified: true as const,
      })),
      ...(syncedRow
        ? {
            sheetRow: {
              taskId,
              rowNumber: Number(syncedRow.row_number),
              status: 'COMPLETE' as const,
              packageHash: syncedRow.expected_hash,
              syncedAt: iso(syncedRow.synced_at) ?? iso(syncedRow.updated_at) ?? '',
            },
          }
        : {}),
      completedAt: iso(publication.completed_at),
      recordedIn: 'postgres' as const,
    };
  });
}

/**
 * Every confirmed file and row of the tenant, for the reconciliation audit (FR-049), which compares
 * what the tasks say with what was delivered.
 */
export async function readDeliveredRecords(
  db: Kysely<Database>,
  scope: ReceiptScope
): Promise<{ driveFiles: ReceiptFile[]; sheetRows: ReceiptSheetRow[] }> {
  return withRlsContext(db, scope, async (trx) => {
    const files = await trx
      .selectFrom('drive_refs')
      .innerJoin('publications', 'publications.id', 'drive_refs.publication_id')
      .select([
        'publications.task_id as task_id',
        'drive_refs.file_id as file_id',
        'drive_refs.folder_id as folder_id',
        'drive_refs.expected_sha256 as expected_sha256',
        'drive_refs.observed_size as observed_size',
      ])
      .where('drive_refs.tenant_id', '=', scope.tenantId)
      .where('drive_refs.status', '=', 'verified')
      .execute();
    const rows = await trx
      .selectFrom('sheet_syncs')
      .select(['task_id', 'row_number', 'expected_hash', 'synced_at', 'updated_at'])
      .where('tenant_id', '=', scope.tenantId)
      .where('status', '=', 'synced')
      .where('row_number', 'is not', null)
      // Oldest first: the audit keeps the last row it sees for a task, which is then its latest sync
      // rather than whichever row Postgres happened to return last.
      .orderBy('synced_at')
      .orderBy('updated_at')
      .orderBy('id')
      .execute();
    return {
      driveFiles: files.map((f) => ({
        taskId: String(f.task_id),
        fileId: f.file_id,
        folderId: f.folder_id,
        sha256: f.expected_sha256 ?? '',
        byteSize: Number(f.observed_size ?? 0),
      })),
      sheetRows: rows.map((r) => ({
        taskId: String(r.task_id),
        rowNumber: Number(r.row_number),
        status: 'COMPLETE' as const,
        packageHash: r.expected_hash,
        syncedAt: iso(r.synced_at) ?? iso(r.updated_at) ?? '',
      })),
    };
  });
}
