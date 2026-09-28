import {
  SYSTEM_AUTOMATION_USER_ID, parsePublicationExpectation, publicationRequestFromExpectation,
  type PublicationExpectation, type PublicationSheetExpectation, type PublishRequest,
} from '@hawa/contracts';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import type { SheetExpectationStore, SheetWriteIdentity } from '@hawa/integrations';

const scope = (tenantId: string) => ({ tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' as const });
export class PublicationExpectationConflict extends Error {}
interface Stored<T> { payload: T; payload_sha256: string }

/** No provider call occurs inside these transactions. */
export class PublicationExpectations {
  constructor(private readonly db: Kysely<Database>) {}

  async read(tenantId: string, publicationKey: string): Promise<{ original: PublicationExpectation; sheet: PublicationSheetExpectation | null } | null> {
    return withRlsContext(this.db, scope(tenantId), async trx => {
      const row = (await sql<Stored<PublicationExpectation> & { sheet: PublicationSheetExpectation | null }>`
        SELECT e.payload,e.payload_sha256,s.payload AS sheet FROM hawa.publication_expectations e
        JOIN hawa.publications p ON p.tenant_id=e.tenant_id AND p.id=e.publication_id
        LEFT JOIN hawa.publication_sheet_expectations s ON s.tenant_id=e.tenant_id AND s.publication_id=e.publication_id
        WHERE e.tenant_id=${tenantId}::uuid AND p.publication_key=${publicationKey}`.execute(trx)).rows[0];
      if (!row) return null;
      const original = parsePublicationExpectation(row.payload);
      if (!original) throw new PublicationExpectationConflict('PUBLICATION_EXPECTATION_INVALID');
      return { original, sheet: row.sheet };
    });
  }

  async freeze(tenantId: string, publicationId: string, proposed: PublishRequest): Promise<PublishRequest> {
    return withRlsContext(this.db, scope(tenantId), async trx => {
      const pub = await trx.selectFrom('publications').selectAll().where('tenant_id','=',tenantId)
        .where('id','=',publicationId).forUpdate().executeTakeFirstOrThrow();
      const task = await trx.selectFrom('tasks').select(['client_id','project_id']).where('tenant_id','=',tenantId)
        .where('id','=',pub.task_id).executeTakeFirstOrThrow();
      if (pub.task_id !== proposed.taskId || pub.approval_id !== proposed.approvalId || pub.design_revision_id !== proposed.designRevisionId ||
        pub.publication_key !== proposed.publicationKey || pub.package_sha256 !== proposed.packageHash || task.client_id !== proposed.clientId) {
        throw new PublicationExpectationConflict('PUBLICATION_EXPECTATION_CONFLICT');
      }
      let row = (await sql<Stored<PublicationExpectation>>`SELECT payload,payload_sha256 FROM hawa.publication_expectations
        WHERE tenant_id=${tenantId}::uuid AND publication_id=${publicationId}::uuid`.execute(trx)).rows[0];
      if (!row) {
        if (Number(pub.input_protocol) !== 1) throw new PublicationExpectationConflict('LEGACY_PUBLICATION_EXPECTATION_UNAVAILABLE');
        const candidate: PublicationExpectation = { schemaVersion: 1, tenantId, publicationId,
          taskId: proposed.taskId, clientId: proposed.clientId, projectId: task.project_id,
          designRevisionId: proposed.designRevisionId, approvalId: proposed.approvalId,
          publicationKey: proposed.publicationKey, packageHash: proposed.packageHash,
          destination: proposed.destination, files: proposed.files.map(({ content: _content, ...file }) => file),
          publishedAt: typeof proposed.sheetRow.publishedAt === 'string' ? proposed.sheetRow.publishedAt : new Date().toISOString() };
        if (!parsePublicationExpectation(candidate)) throw new PublicationExpectationConflict('PUBLICATION_EXPECTATION_INVALID');
        row = (await sql<Stored<PublicationExpectation>>`INSERT INTO hawa.publication_expectations
          (tenant_id,publication_id,task_id,client_id,payload) VALUES (${tenantId}::uuid,${publicationId}::uuid,
          ${proposed.taskId}::uuid,${proposed.clientId}::uuid,${JSON.stringify(candidate)}::jsonb)
          RETURNING payload,payload_sha256`.execute(trx)).rows[0];
      }
      const original = parsePublicationExpectation(row.payload);
      if (!original) throw new PublicationExpectationConflict('PUBLICATION_EXPECTATION_INVALID');
      if (original.projectId !== task.project_id) throw new PublicationExpectationConflict('PUBLICATION_EXPECTATION_SCOPE_CHANGED');
      const sheet = (await sql<Stored<PublicationSheetExpectation>>`SELECT payload,payload_sha256 FROM hawa.publication_sheet_expectations
        WHERE tenant_id=${tenantId}::uuid AND publication_id=${publicationId}::uuid`.execute(trx)).rows[0];
      return publicationRequestFromExpectation(original, proposed, sheet?.payload);
    });
  }
}

/** Called by GooglePublisher after verified Drive readback and before a Sheet mutation. */
export class PostgresSheetExpectationStore implements SheetExpectationStore {
  constructor(private readonly db: Kysely<Database>) {}
  async prepare(input: SheetWriteIdentity): Promise<void> {
    await withRlsContext(this.db, scope(input.tenantId), async trx => {
      const pub = await trx.selectFrom('publications').select(['id','task_id']).where('tenant_id','=',input.tenantId)
        .where('publication_key','=',input.publicationKey).forUpdate().executeTakeFirstOrThrow();
      if (pub.task_id !== input.taskId) throw new PublicationExpectationConflict('PUBLICATION_EXPECTATION_CONFLICT');
      const candidate: PublicationSheetExpectation = { schemaVersion: 1, tenantId: input.tenantId,
        publicationId: pub.id, taskId: input.taskId, clientId: input.clientId, spreadsheetId: input.spreadsheetId,
        sheetId: input.sheetId, metadataId: input.metadataId, metadataValue: input.metadataValue, expectedValues: input.expectedValues };
      const existing = (await sql<{ same: boolean }>`SELECT payload=${JSON.stringify(candidate)}::jsonb AS same
        FROM hawa.publication_sheet_expectations WHERE tenant_id=${input.tenantId}::uuid AND publication_id=${pub.id}::uuid`.execute(trx)).rows[0];
      if (existing) {
        if (!existing.same) throw new PublicationExpectationConflict('SHEET_EXPECTATION_CONFLICT');
        return;
      }
      await sql`INSERT INTO hawa.publication_sheet_expectations (tenant_id,publication_id,task_id,client_id,payload)
        VALUES (${input.tenantId}::uuid,${pub.id}::uuid,${input.taskId}::uuid,${input.clientId}::uuid,${JSON.stringify(candidate)}::jsonb)`.execute(trx);
    });
  }
}
