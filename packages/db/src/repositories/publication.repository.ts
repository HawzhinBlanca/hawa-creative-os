import crypto from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database, PublicationsTable, DriveRefsTable, SheetSyncsTable } from '../types.js';

export interface CreatePublicationParams {
  tenantId: string;
  taskId: string;
  designRevisionId: string;
  approvalId: string;
  publicationKey: string;
  packageManifest: Record<string, unknown>;
  packageSha256: string;
  initialState?: 'pending' | 'staging' | 'drive_pending' | 'drive_complete' | 'sheet_pending' | 'complete' | 'failed' | 'cancelled';
}

export interface RecordDriveRefParams {
  tenantId: string;
  publicationId: string;
  artifactId?: string | null;
  sharedDriveId: string;
  folderId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  expectedSha256?: string | null;
  observedSize?: number | null;
  permissionDigest?: string | null;
  verifiedAt?: Date | null;
  status: 'uploaded' | 'verified' | 'missing' | 'mismatch' | 'deleted';
}

export interface RecordSheetSyncParams {
  tenantId: string;
  publicationId: string;
  spreadsheetId: string;
  sheetId: number;
  taskId: string;
  rowKey: string;
  rowNumber?: number | null;
  expectedHash: string;
  observedHash?: string | null;
  status: 'pending' | 'synced' | 'stale' | 'missing' | 'failed';
  lastError?: string | null;
}

export class PublicationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  private computeSha256(data: string | Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  async findByKey(publicationKey: string, tenantId?: string, trx?: Kysely<Database>) {
    let query = (trx || this.db)
      .selectFrom('publications')
      .selectAll()
      .where('publication_key', '=', publicationKey);
    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }
    return await query.executeTakeFirst();
  }

  async findById(id: string, tenantId?: string, trx?: Kysely<Database>) {
    let query = (trx || this.db)
      .selectFrom('publications')
      .selectAll()
      .where('id', '=', id);
    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }
    return await query.executeTakeFirst();
  }

  async findByTaskId(taskId: string, tenantId?: string, trx?: Kysely<Database>) {
    let query = (trx || this.db)
      .selectFrom('publications')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('created_at', 'desc');
    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }
    return await query.executeTakeFirst();
  }

  async createPublication(params: CreatePublicationParams, trx?: Kysely<Database>) {
    const runner = async (dbClient: Kysely<Database>) => {
      // 1. Check idempotency
      const existing = await dbClient
        .selectFrom('publications')
        .selectAll()
        .where('publication_key', '=', params.publicationKey)
        .where('tenant_id', '=', params.tenantId)
        .executeTakeFirst();

      if (existing) {
        return existing;
      }

      // 2. Insert publication record
      const pub = await dbClient
        .insertInto('publications')
        .values({
          tenant_id: params.tenantId,
          task_id: params.taskId,
          design_revision_id: params.designRevisionId,
          approval_id: params.approvalId,
          publication_key: params.publicationKey,
          state: params.initialState || 'pending',
          package_manifest: params.packageManifest,
          package_sha256: params.packageSha256,
          attempt: 1,
          error_class: null,
          error_detail: null,
          completed_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const task = await dbClient
        .selectFrom('tasks')
        .select(['version'])
        .where('id', '=', params.taskId)
        .where('tenant_id', '=', params.tenantId)
        .executeTakeFirst();
      const nextVer = task ? Number(task.version) + 1 : 1;

      if (task) {
        await dbClient
          .updateTable('tasks')
          .set({
            version: nextVer,
            updated_at: new Date(),
          })
          .where('id', '=', params.taskId)
          .where('tenant_id', '=', params.tenantId)
          .execute();
      }

      // 3. Append task_events
      await dbClient
        .insertInto('task_events')
        .values({
          tenant_id: params.tenantId,
          task_id: params.taskId,
          event_type: 'publication.initiated',
          aggregate_version: nextVer,
          actor_type: 'workflow',
          actor_id: 'publisher',
          data: {
            publicationId: pub.id,
            publicationKey: params.publicationKey,
            revisionId: params.designRevisionId,
            approvalId: params.approvalId,
          },
          correlation_id: crypto.randomUUID(),
        })
        .execute();

      return pub;
    };

    if (trx) {
      return await runner(trx);
    }
    return await this.db.transaction().execute(runner);
  }

  async recordDriveRef(params: RecordDriveRefParams, trx?: Kysely<Database>) {
    const runner = async (dbClient: Kysely<Database>) => {
      const driveRef = await dbClient
        .insertInto('drive_refs')
        .values({
          tenant_id: params.tenantId,
          publication_id: params.publicationId,
          artifact_id: params.artifactId || null,
          shared_drive_id: params.sharedDriveId,
          folder_id: params.folderId,
          file_id: params.fileId,
          file_name: params.fileName,
          mime_type: params.mimeType,
          expected_sha256: params.expectedSha256 || null,
          observed_size: params.observedSize || null,
          permission_digest: params.permissionDigest || null,
          verified_at: params.verifiedAt || (params.status === 'verified' ? new Date() : null),
          status: params.status,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // Update publication state to drive_complete if not already complete
      await dbClient
        .updateTable('publications')
        .set({
          state: 'drive_complete',
          updated_at: new Date(),
        })
        .where('id', '=', params.publicationId)
        .where('tenant_id', '=', params.tenantId)
        .execute();

      return driveRef;
    };

    if (trx) {
      return await runner(trx);
    }
    return await this.db.transaction().execute(runner);
  }

  async recordSheetSync(params: RecordSheetSyncParams, trx?: Kysely<Database>) {
    const runner = async (dbClient: Kysely<Database>) => {
      const sheetSync = await dbClient
        .insertInto('sheet_syncs')
        .values({
          tenant_id: params.tenantId,
          publication_id: params.publicationId,
          spreadsheet_id: params.spreadsheetId,
          sheet_id: params.sheetId,
          task_id: params.taskId,
          row_key: params.rowKey,
          row_number: params.rowNumber || null,
          expected_hash: params.expectedHash,
          observed_hash: params.observedHash || null,
          status: params.status,
          attempts: 1,
          last_error: params.lastError || null,
          synced_at: params.status === 'synced' ? new Date() : null,
        })
        // A row is keyed by (spreadsheet, sheet, row_key), so the second attempt at the same row is
        // an update, not an insert. It used to be a plain insert: the first attempt recorded
        // 'pending', and every retry then died on the unique key, so a sheet that failed once could
        // never be recorded as synced. The update is confined to the same tenant and task, so a
        // clashing key from another task is refused instead of overwritten, and a confirmed sync of
        // the same content is never downgraded by a late 'pending'.
        .onConflict((oc) =>
          oc
            .columns(['spreadsheet_id', 'sheet_id', 'row_key'])
            .doUpdateSet({
              publication_id: sql`excluded.publication_id`,
              row_number: sql`COALESCE(excluded.row_number, sheet_syncs.row_number)`,
              expected_hash: sql`excluded.expected_hash`,
              observed_hash: sql`COALESCE(excluded.observed_hash, sheet_syncs.observed_hash)`,
              status: sql`CASE WHEN sheet_syncs.status = 'synced' AND sheet_syncs.expected_hash = excluded.expected_hash THEN 'synced' ELSE excluded.status END`,
              attempts: sql`sheet_syncs.attempts + 1`,
              last_error: sql`excluded.last_error`,
              synced_at: sql`CASE WHEN excluded.status = 'synced' THEN now() ELSE sheet_syncs.synced_at END`,
            } as any)
            .where(sql<boolean>`sheet_syncs.tenant_id = excluded.tenant_id AND sheet_syncs.task_id = excluded.task_id`)
        )
        .returningAll()
        .executeTakeFirst();

      if (!sheetSync) {
        throw new Error(
          `Sheet row key ${params.rowKey} in ${params.spreadsheetId} already belongs to another task; refusing to overwrite it`
        );
      }
      return sheetSync;
    };

    if (trx) {
      return await runner(trx);
    }
    return await this.db.transaction().execute(runner);
  }

  async markComplete(
    params: {
      tenantId: string;
      publicationId: string;
      taskId: string;
    },
    trx?: Kysely<Database>
  ) {
    const runner = async (dbClient: Kysely<Database>) => {
      const now = new Date();

      // 1. Update publication
      const pub = await dbClient
        .updateTable('publications')
        .set({
          state: 'complete',
          completed_at: now,
          updated_at: now,
        })
        .where('id', '=', params.publicationId)
        .where('tenant_id', '=', params.tenantId)
        .returningAll()
        .executeTakeFirstOrThrow();

      // 2. Update task state
      const task = await dbClient
        .selectFrom('tasks')
        .select(['version', 'state'])
        .where('id', '=', params.taskId)
        .where('tenant_id', '=', params.tenantId)
        .executeTakeFirstOrThrow();

      await dbClient
        .updateTable('tasks')
        .set({
          state: 'complete',
          version: Number(task.version) + 1,
          updated_at: now,
        })
        .where('id', '=', params.taskId)
        .where('tenant_id', '=', params.tenantId)
        .execute();

      // 3. Append task_events
      await dbClient
        .insertInto('task_events')
        .values({
          tenant_id: params.tenantId,
          task_id: params.taskId,
          event_type: 'publication.completed',
          aggregate_version: Number(task.version) + 1,
          actor_type: 'workflow',
          actor_id: 'publisher',
          data: {
            publicationId: params.publicationId,
            completedAt: now.toISOString(),
          },
          correlation_id: crypto.randomUUID(),
        })
        .execute();

      return pub;
    };

    if (trx) {
      return await runner(trx);
    }
    return await this.db.transaction().execute(runner);
  }

  async markFailed(
    params: {
      tenantId: string;
      publicationId: string;
      taskId: string;
      errorClass: string;
      errorDetail: string;
    },
    trx?: Kysely<Database>
  ) {
    const runner = async (dbClient: Kysely<Database>) => {
      const now = new Date();

      // 1. Update publication
      const pub = await dbClient
        .updateTable('publications')
        .set({
          state: 'failed',
          error_class: params.errorClass,
          error_detail: params.errorDetail,
          updated_at: now,
        })
        .where('id', '=', params.publicationId)
        .where('tenant_id', '=', params.tenantId)
        .returningAll()
        .executeTakeFirstOrThrow();

      const task = await dbClient
        .selectFrom('tasks')
        .select(['version'])
        .where('id', '=', params.taskId)
        .where('tenant_id', '=', params.tenantId)
        .executeTakeFirst();
      const nextVer = task ? Number(task.version) + 1 : 1;

      if (task) {
        await dbClient
          .updateTable('tasks')
          .set({
            version: nextVer,
            updated_at: now,
          })
          .where('id', '=', params.taskId)
          .where('tenant_id', '=', params.tenantId)
          .execute();
      }

      // 2. Append task_events
      await dbClient
        .insertInto('task_events')
        .values({
          tenant_id: params.tenantId,
          task_id: params.taskId,
          event_type: 'publication.failed',
          aggregate_version: nextVer,
          actor_type: 'workflow',
          actor_id: 'publisher',
          data: {
            publicationId: params.publicationId,
            errorClass: params.errorClass,
            errorDetail: params.errorDetail,
          },
          correlation_id: crypto.randomUUID(),
        })
        .execute();

      return pub;
    };

    if (trx) {
      return await runner(trx);
    }
    return await this.db.transaction().execute(runner);
  }

  async getPublicationWithRefs(publicationId: string, tenantId?: string, trx?: Kysely<Database>) {
    const dbClient = trx || this.db;
    let pubQuery = dbClient
      .selectFrom('publications')
      .selectAll()
      .where('id', '=', publicationId);
    if (tenantId) pubQuery = pubQuery.where('tenant_id', '=', tenantId);
    const pub = await pubQuery.executeTakeFirst();

    if (!pub) return null;

    let driveQuery = dbClient
      .selectFrom('drive_refs')
      .selectAll()
      .where('publication_id', '=', publicationId);
    if (tenantId) driveQuery = driveQuery.where('tenant_id', '=', tenantId);
    const driveRefs = await driveQuery.execute();

    let sheetQuery = dbClient
      .selectFrom('sheet_syncs')
      .selectAll()
      .where('publication_id', '=', publicationId);
    if (tenantId) sheetQuery = sheetQuery.where('tenant_id', '=', tenantId);
    const sheetSyncs = await sheetQuery.execute();

    return {
      publication: pub,
      driveRefs,
      sheetSyncs,
    };
  }
}
