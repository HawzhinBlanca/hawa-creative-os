import type { RouteContext } from './types.js';

/**
 * The historical design migration ledger and its sample checks. Moved out of app.ts by group G1
 * (leaves) of the split (architecture programme 1.3, SPLIT_PLAN.md section 2).
 */
export function registerMigrationRoutes(ctx: RouteContext): void {
  const {
    registerRoute,
    verifyRequestAuth,
    problem,
    historicalMigrator: globalHistoricalMigrator,
    globalCanvaNativeAdapter,
    broadcastEvent: broadcast,
  } = ctx;

  // --- Historical Design Migration & Archive Subsystem (CV-19, FR-028, FR-029, FR-032, FR-070, FR-075, FR-077, FR-080) ---
  registerRoute('get', '/migration/ledger', (c: any) => {
    const format = c.req.query('format');
    if (format === 'csv') {
      return c.text(globalHistoricalMigrator.generateMigrationLedgerCsv(), 200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="MIGRATION_LEDGER.csv"',
      });
    }
    return c.json({
      records: globalHistoricalMigrator.getLedgerRecords(),
      count: globalHistoricalMigrator.getLedgerRecords().length,
    }, 200);
  });

  registerRoute('get', '/migration/reconciliation', (c: any) => {
    const summary = globalHistoricalMigrator.generateReconciliationSummary();
    return c.json(summary, 200);
  });

  registerRoute('post', '/migration/archive', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to archive historical document');
    }
    const body = await c.req.json().catch(() => ({}));
    if (!body.documentId || !body.taskId || !body.clientId || !body.sourceFormat) {
      return c.json({ error: 'Missing required document fields (documentId, taskId, clientId, sourceFormat)' }, 400);
    }
    const result = globalHistoricalMigrator.archiveOriginalSource(body);
    return c.json(result, 201);
  });

  registerRoute('post', '/migration/migrate', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to migrate historical document');
    }
    const body = await c.req.json().catch(() => ({}));
    if (!body.documentId || !body.taskId || !body.clientId || !body.sourceFormat) {
      return c.json({ error: 'Missing required document fields (documentId, taskId, clientId, sourceFormat)' }, 400);
    }
    const record = globalHistoricalMigrator.migrateDocument(body, globalCanvaNativeAdapter);
    broadcast('migration:document_processed', {
      documentId: record.documentId,
      status: record.migrationStatus,
      targetCanvaId: record.targetCanvaId,
    });
    return c.json({ record }, 200);
  });

  registerRoute('post', '/migration/reopen-sample', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to test reopen sample');
    }
    const body = await c.req.json().catch(() => ({}));
    const { canvaDesignId, targetRole, updatedText } = body;
    if (!canvaDesignId || !targetRole || !updatedText) {
      return c.json({ error: 'Missing required fields (canvaDesignId, targetRole, updatedText)' }, 400);
    }
    try {
      const result = globalHistoricalMigrator.testSampledReopen(canvaDesignId, globalCanvaNativeAdapter, targetRole, updatedText);
      return c.json(result, 200);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  registerRoute('post', '/migration/rollback-sample', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to test rollback sample');
    }
    const body = await c.req.json().catch(() => ({}));
    const { documentId } = body;
    if (!documentId) {
      return c.json({ error: 'Missing documentId' }, 400);
    }
    try {
      const result = globalHistoricalMigrator.testSampledRollback(documentId);
      return c.json(result, 200);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });
}
