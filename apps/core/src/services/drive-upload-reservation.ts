import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { type Database, type Kysely, sql, withRlsContext } from '@hawa/db';
import { DriveUploadIdentityConflict, type DriveUploadIdentity, type DriveUploadIdentityStore } from '@hawa/integrations';

interface PublicationRow { id: string; task_id: string; package_sha256: string }
interface ReservationRow {
  drive_file_id: string;
  task_id: string;
  package_sha256: string;
  folder_id: string;
  file_name: string;
  mime_type: string;
  expected_sha256: string;
}

/** Commits one provider-generated ID before Google sees any upload request. */
export class PostgresDriveUploadIdentityStore implements DriveUploadIdentityStore {
  constructor(private readonly db: Kysely<Database>) {}

  async reserve(identity: DriveUploadIdentity, allocate: () => Promise<string>): Promise<string> {
    const scope = { tenantId: identity.tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' as const };
    const read = async (trx: Kysely<Database>) => {
      const publication = (await sql<PublicationRow>`SELECT id, task_id, package_sha256
        FROM hawa.publications WHERE tenant_id = ${identity.tenantId}::uuid
        AND publication_key = ${identity.publicationKey}`.execute(trx)).rows[0];
      if (!publication || publication.task_id !== identity.taskId || publication.package_sha256 !== identity.packageHash) {
        throw new DriveUploadIdentityConflict('Publication identity does not match the upload');
      }
      const reservation = (await sql<ReservationRow>`SELECT drive_file_id, task_id, package_sha256,
          folder_id, file_name, mime_type, expected_sha256
        FROM hawa.drive_upload_reservations WHERE tenant_id = ${identity.tenantId}::uuid
        AND publication_id = ${publication.id}::uuid AND artifact_id = ${identity.artifactId}::uuid`.execute(trx)).rows[0];
      return { publication, reservation };
    };
    const check = (row: ReservationRow): string => {
      if (row.task_id !== identity.taskId || row.package_sha256 !== identity.packageHash ||
        row.folder_id !== identity.folderId || row.file_name !== identity.filename ||
        row.mime_type !== identity.mimeType || row.expected_sha256.toLowerCase() !== identity.sha256.toLowerCase()) {
        throw new DriveUploadIdentityConflict('An existing upload ID is bound to different bytes or destination');
      }
      return row.drive_file_id;
    };

    const first = await withRlsContext(this.db, scope, read);
    if (first.reservation) return check(first.reservation);

    // Network I/O is deliberately outside both database transactions.
    const generatedId = await allocate();
    if (!generatedId) throw new Error('Google did not generate a file ID');
    const winner = await withRlsContext(this.db, scope, async (trx) => {
      const current = await read(trx);
      if (current.reservation) return current.reservation;
      await sql`INSERT INTO hawa.drive_upload_reservations
        (tenant_id, publication_id, artifact_id, task_id, package_sha256, folder_id,
         file_name, mime_type, expected_sha256, drive_file_id)
        VALUES (${identity.tenantId}::uuid, ${current.publication.id}::uuid, ${identity.artifactId}::uuid,
          ${identity.taskId}::uuid, ${identity.packageHash}, ${identity.folderId},
          ${identity.filename}, ${identity.mimeType}, ${identity.sha256.toLowerCase()}, ${generatedId})
        ON CONFLICT (publication_id, artifact_id) DO NOTHING`.execute(trx);
      const saved = (await sql<ReservationRow>`SELECT drive_file_id, task_id, package_sha256,
          folder_id, file_name, mime_type, expected_sha256
        FROM hawa.drive_upload_reservations WHERE tenant_id = ${identity.tenantId}::uuid
        AND publication_id = ${current.publication.id}::uuid AND artifact_id = ${identity.artifactId}::uuid`.execute(trx)).rows[0];
      if (!saved) throw new Error('Drive upload ID reservation was not committed');
      return saved;
    });
    return check(winner);
  }
}
