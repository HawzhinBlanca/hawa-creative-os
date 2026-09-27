import crypto from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database, PublicationsTable, DriveRefsTable, SheetSyncsTable } from '../types.js';
import { currentTraceId } from '../trace-context.js';

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
  publicationArtifactId?: string | null;
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
  metadataId?: number | null;
  expectedValues?: string[] | null;
  expectedRowHash?: string | null;
  observedRowHash?: string | null;
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

  /** Record an archive outcome that cannot yet be proved either present or absent. */
  async markArchiveUnconfirmed(params: { tenantId: string; publicationId: string; taskId: string; code: string }, trx?: Kysely<Database>) {
    const runner = async (dbClient: Kysely<Database>) => {
      const pub = await dbClient.selectFrom('publications').select(['state', 'error_class', 'error_detail'])
        .where('tenant_id', '=', params.tenantId).where('id', '=', params.publicationId).where('task_id', '=', params.taskId)
        .forUpdate().executeTakeFirst();
      if (!pub || pub.state === 'complete') return false;
      const detail = params.code.slice(0, 100);
      if (pub.error_class === 'ARCHIVE_UNCONFIRMED' && pub.error_detail === detail) return true;
      const task = await dbClient.selectFrom('tasks').select('version')
        .where('tenant_id', '=', params.tenantId).where('id', '=', params.taskId).forUpdate().executeTakeFirstOrThrow();
      const version = Number(task.version) + 1;
      await dbClient.updateTable('publications').set({ error_class: 'ARCHIVE_UNCONFIRMED', error_detail: detail, updated_at: new Date() })
        .where('tenant_id', '=', params.tenantId).where('id', '=', params.publicationId).executeTakeFirstOrThrow();
      await dbClient.updateTable('tasks').set({ version, updated_at: new Date() })
        .where('tenant_id', '=', params.tenantId).where('id', '=', params.taskId).executeTakeFirstOrThrow();
      await dbClient.insertInto('task_events').values({
        tenant_id: params.tenantId, task_id: params.taskId, event_type: 'publication.archive_unconfirmed',
        aggregate_version: version, actor_type: 'workflow', actor_id: 'publisher',
        correlation_id: crypto.randomUUID(), trace_id: currentTraceId(),
        data: { publicationId: params.publicationId, code: detail },
      }).executeTakeFirstOrThrow();
      return true;
    };
    return trx ? runner(trx) : this.db.transaction().execute(runner);
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
          trace_id: currentTraceId(),
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
          publication_artifact_id: params.publicationArtifactId || null,
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
        // Core may repeat the prepare step after its answer is lost. Adopt the same verified file
        // without creating a second receipt; a reused Drive id with different bytes or destination
        // is a conflict, never evidence that the approved package was archived.
        .onConflict((oc) => oc.columns(['publication_id', 'file_id']).doUpdateSet({
          status: sql`CASE WHEN drive_refs.status = 'verified' THEN 'verified' ELSE excluded.status END`,
          verified_at: sql`COALESCE(drive_refs.verified_at, excluded.verified_at)`,
        } as any).where(sql<boolean>`drive_refs.tenant_id = excluded.tenant_id
          AND drive_refs.shared_drive_id = excluded.shared_drive_id
          AND drive_refs.folder_id = excluded.folder_id
          AND drive_refs.publication_artifact_id IS NOT DISTINCT FROM excluded.publication_artifact_id
          AND drive_refs.file_name = excluded.file_name
          AND drive_refs.mime_type = excluded.mime_type
          AND drive_refs.expected_sha256 IS NOT DISTINCT FROM excluded.expected_sha256
          AND drive_refs.observed_size IS NOT DISTINCT FROM excluded.observed_size`))
        .returningAll()
        .executeTakeFirst();
      if (!driveRef) throw new Error(`Drive file ${params.fileId} conflicts with its stored publication receipt`);

      // Update publication state to drive_complete if not already complete
      await dbClient
        .updateTable('publications')
        .set({
          state: 'drive_complete',
          updated_at: new Date(),
        })
        .where('id', '=', params.publicationId)
        .where('tenant_id', '=', params.tenantId)
        .where('state', '!=', 'complete')
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
      // Only a delayed pending answer for this exact publication can retain confirmed evidence.
      // A failed observation or another publication must expose its own uncertainty.
      const keepConfirmed = sql<boolean>`sheet_syncs.status = 'synced' AND excluded.status = 'pending'
        AND sheet_syncs.publication_id = excluded.publication_id
        AND sheet_syncs.expected_hash = excluded.expected_hash
        AND (excluded.expected_row_hash IS NULL OR sheet_syncs.expected_row_hash = excluded.expected_row_hash)`;
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
          metadata_id: params.metadataId ?? null,
          expected_values: params.expectedValues ? sql`${JSON.stringify(params.expectedValues)}::jsonb` : null,
          expected_row_hash: params.expectedRowHash ?? null,
          observed_row_hash: params.observedRowHash ?? null,
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
              row_number: sql`CASE WHEN ${keepConfirmed} THEN sheet_syncs.row_number ELSE excluded.row_number END`,
              expected_hash: sql`excluded.expected_hash`,
              observed_hash: sql`CASE WHEN ${keepConfirmed} THEN sheet_syncs.observed_hash ELSE excluded.observed_hash END`,
              metadata_id: sql`CASE WHEN ${keepConfirmed} THEN sheet_syncs.metadata_id ELSE excluded.metadata_id END`,
              expected_values: sql`CASE WHEN ${keepConfirmed} THEN sheet_syncs.expected_values ELSE excluded.expected_values END`,
              expected_row_hash: sql`CASE WHEN ${keepConfirmed} THEN sheet_syncs.expected_row_hash ELSE excluded.expected_row_hash END`,
              observed_row_hash: sql`CASE WHEN ${keepConfirmed} THEN sheet_syncs.observed_row_hash ELSE excluded.observed_row_hash END`,
              status: sql`CASE WHEN ${keepConfirmed} THEN sheet_syncs.status ELSE excluded.status END`,
              attempts: sql`sheet_syncs.attempts + 1`,
              last_error: sql`CASE WHEN ${keepConfirmed} THEN sheet_syncs.last_error ELSE excluded.last_error END`,
              synced_at: sql`CASE WHEN ${keepConfirmed} THEN sheet_syncs.synced_at ELSE excluded.synced_at END`,
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
      // The publication lock is acquired before the task lock in all delivery paths. Refuse a
      // mismatched task or a late completion after cancellation instead of rewriting task truth.
      const existing = await dbClient
        .selectFrom('publications')
        .selectAll()
        .where('id', '=', params.publicationId)
        .where('tenant_id', '=', params.tenantId)
        .where('task_id', '=', params.taskId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const task = await dbClient
        .selectFrom('tasks')
        .select(['version', 'state', 'completed_at'])
        .where('id', '=', params.taskId)
        .where('tenant_id', '=', params.tenantId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (existing.state === 'complete') {
        if (task.state !== 'complete') throw new Error(`Publication ${params.publicationId} is complete but task ${params.taskId} is ${task.state}`);
        return existing;
      }
      // Workflow finish already changed the task to complete in this transaction. Core's own
      // delivery reaches here while publishing. Any other state means a concurrent decision won.
      if (task.state !== 'publishing' && task.state !== 'complete') {
        throw new Error(`Task ${params.taskId} is ${task.state}; publication completion requires publishing or complete`);
      }

      const updatedTask = await dbClient
        .updateTable('tasks')
        .set({
          state: 'complete',
          version: Number(task.version) + 1,
          completed_at: task.completed_at || now,
          updated_at: now,
        })
        .where('id', '=', params.taskId)
        .where('tenant_id', '=', params.tenantId)
        .where('state', '=', task.state)
        .where('version', '=', task.version)
        .returning('id')
        .executeTakeFirst();
      if (!updatedTask) throw new Error(`Task ${params.taskId} changed while its publication was completing`);

      const pub = await dbClient
        .updateTable('publications')
        .set({
          state: 'complete',
          error_class: null,
          error_detail: null,
          completed_at: now,
          updated_at: now,
        })
        .where('id', '=', params.publicationId)
        .where('tenant_id', '=', params.tenantId)
        .where('task_id', '=', params.taskId)
        .where('state', '=', existing.state)
        .returningAll()
        .executeTakeFirst();
      if (!pub) throw new Error(`Publication ${params.publicationId} changed while completing`);

      // Append a versioned publication event in the same transaction.
      await dbClient
        .insertInto('task_events')
        .values({
          tenant_id: params.tenantId,
          task_id: params.taskId,
          event_type: 'publication.completed',
          aggregate_version: Number(task.version) + 1,
          actor_type: 'workflow',
          actor_id: 'publisher',
          trace_id: currentTraceId(),
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
          trace_id: currentTraceId(),
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
