import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '@hawa/db';
import {
  HistoricalDesignMigrator,
  CanvaNativeAdapter,
  type HistoricalDocumentInput,
} from '@hawa/integrations';

describe('CV-19: Historical Design Migration & Archive Subsystem', () => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const db = createDb(connectionString);
  const app = createApp({ db });

  const testBearer = process.env.HAWA_BEARER_TOKEN!;
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${testBearer}`,
  };

  let migrator: HistoricalDesignMigrator;
  let canvaAdapter: CanvaNativeAdapter;

  beforeEach(() => {
    migrator = new HistoricalDesignMigrator();
    canvaAdapter = new CanvaNativeAdapter();
  });

  it('1. Archives original .hyc source immutably with verifiable SHA-256 hash (FR-070, NFR-019)', () => {
    const docInput: HistoricalDocumentInput = {
      documentId: 'doc_hyc_drustee_001',
      taskId: 'task_drustee_active_01',
      clientId: 'c1000000-0000-4000-8000-000000000003',
      title: 'Drustee Vitamin D3 Launch Campaign',
      sourceFormat: 'hycanvas_json',
      lifecycleState: 'active_inflight',
      sourceContent: {
        version: '0.3.9',
        layers: [
          { id: 'l_bg', type: 'frame', fill: '#01585F', width: 1080, height: 1350 },
          { id: 'l_title', type: 'text', text: 'دروستی - تەندروستی خێزانەکەت', fontFamily: 'Vazirmatn' },
          { id: 'l_discl', type: 'text', text: 'بەرهەمێکی باوەڕپێکراو لەلایەن وەزارەتی تەندروستی', fontFamily: 'Vazirmatn' },
        ],
      },
    };

    const { archivedPath, sourceSha256 } = migrator.archiveOriginalSource(docInput);

    expect(archivedPath).toContain('hycanvas_json');
    expect(sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('2. Reconstructs active .hyc design into native Canva document with 100% Kurdish copy fidelity (FR-028, FR-029)', () => {
    const docInput: HistoricalDocumentInput = {
      documentId: 'doc_hyc_kaae_active_02',
      taskId: 'task_kaae_active_02',
      clientId: 'c1000000-0000-4000-8000-000000000002',
      title: 'KAAE Accreditation Announcement',
      sourceFormat: 'hycanvas_json',
      lifecycleState: 'active_inflight',
      sourceContent: {
        version: '0.3.9',
        layers: [
          { id: 'l_bg', type: 'frame', fill: '#0A1628', width: 1080, height: 1350 },
          { id: 'l_head', type: 'text', text: 'کۆنفرانسی نیشتمانی بۆ دڵنیایی جۆری زانکۆکان', fontFamily: 'Vazirmatn' },
          { id: 'l_sub', type: 'text', text: 'دەستەی باڵای متمانەبەخشی بە دامەزراوەکانی خوێندنی باڵا', fontFamily: 'Vazirmatn' },
        ],
      },
      metadata: { primaryColor: '#0A1628' },
    };

    const record = migrator.migrateDocument(docInput, canvaAdapter);

    expect(record.migrationStatus).toBe('MIGRATED_VERIFIED');
    expect(record.targetCanvaId).toMatch(/^DAF_mig_/);
    expect(record.textFidelityScore).toBe(1.0); // 100% exact text preserved
    expect(record.elementsCount).toBeGreaterThanOrEqual(4); // bg + logo + 2 text nodes
    expect(record.reapproved).toBe(false); // Never silently re-approved
    expect(record.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(record.targetSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('3. Reconstructs legacy Polotno scene graph into native Canva document with discrete elements', () => {
    const docInput: HistoricalDocumentInput = {
      documentId: 'doc_polotno_aster_03',
      taskId: 'task_aster_active_03',
      clientId: 'c1000000-0000-4000-8000-000000000004',
      title: 'Aster Resort Weekend Package',
      sourceFormat: 'polotno_json',
      lifecycleState: 'active_inflight',
      sourceContent: {
        pages: [
          {
            id: 'page_polotno_1',
            children: [
              { id: 'p_t1', type: 'text', text: 'ئاستێر ڕیزۆرت - حەوانەوەیەکی بێوێنە لە هەولێر' },
              { id: 'p_t2', type: 'text', text: 'تایبەت بە کۆتایی هەفتە بۆ خێزانەکان' },
            ],
          },
        ],
      },
      metadata: { primaryColor: '#1E293B' },
    };

    const record = migrator.migrateDocument(docInput, canvaAdapter);

    expect(record.migrationStatus).toBe('MIGRATED_VERIFIED');
    expect(record.textFidelityScore).toBe(1.0);
    expect(record.lossNotes).toContain('discrete native Canva nodes');
    expect(record.reapproved).toBe(false);
  });

  it('4. Classifies historical inaccessible Figma sources as a named blocker (FR-032)', () => {
    const docInput: HistoricalDocumentInput = {
      documentId: 'doc_figma_legacy_blocked_04',
      taskId: 'task_figma_blocked_04',
      clientId: 'c1000000-0000-4000-8000-000000000001',
      title: 'Legacy Q1 Campaign in Figma Team Space',
      sourceFormat: 'figma_rest_ref',
      lifecycleState: 'active_inflight',
      sourceContent: {
        figmaFileKey: 'f_key_revoked_4920412',
        nodeId: '0:1',
      },
      metadata: {
        inaccessible: true,
        tokenRevoked: true,
      },
    };

    const record = migrator.migrateDocument(docInput, canvaAdapter);

    expect(record.migrationStatus).toBe('BLOCKED_NEEDS_ACCESS');
    expect(record.targetCanvaId).toBe('NONE_BLOCKED');
    expect(record.lossNotes).toContain('Historical inaccessible Figma reference');
    expect(record.lossNotes).toContain('Named blocker per FR-032');
    expect(record.reapproved).toBe(false);
  });

  it('5. Preserves completed historical designs in read-only archive without editor churn', () => {
    const docInput: HistoricalDocumentInput = {
      documentId: 'doc_archive_fastpay_05',
      taskId: 'task_fastpay_done_05',
      clientId: 'c1000000-0000-4000-8000-000000000005',
      title: 'FastPay 2025 Eid Promo (Delivered)',
      sourceFormat: 'legacy_zip_pack',
      lifecycleState: 'archived',
      sourceContent: {
        packId: 'fastpay_eid_2025_pack',
        manifest: { deliveredAt: '2025-06-10T12:00:00Z' },
      },
    };

    const record = migrator.migrateDocument(docInput, canvaAdapter);

    expect(record.migrationStatus).toBe('ARCHIVED_READ_ONLY');
    expect(record.targetCanvaId).toBe('ARCHIVED_NO_CANVA_BINDING');
    expect(record.lossNotes).toContain('Preserved in read-only archive');
    expect(record.reapproved).toBe(false);
  });

  it('6. Proves sampled reopen test: targeted one-field edit preserves all other elements (FR-031)', () => {
    const docInput: HistoricalDocumentInput = {
      documentId: 'doc_reopen_test_06',
      taskId: 'task_reopen_test_06',
      clientId: 'c1000000-0000-4000-8000-000000000003',
      title: 'Drustee Reopen Sample Document',
      sourceFormat: 'hycanvas_json',
      lifecycleState: 'active_inflight',
      sourceContent: {
        layers: [
          { id: 'head_layer', type: 'text', text: 'سەردێڕی سەرەتایی' },
          { id: 'discl_layer', type: 'text', text: 'تێبینی تەندروستی کۆن' },
        ],
      },
    };

    const record = migrator.migrateDocument(docInput, canvaAdapter);
    expect(record.migrationStatus).toBe('MIGRATED_VERIFIED');

    // Perform sampled reopen edit on headline
    const reopenResult = migrator.testSampledReopen(
      record.targetCanvaId,
      canvaAdapter,
      'headline',
      'سەردێڕی نوێکراوە لە کانڤا'
    );

    expect(reopenResult.reopenSuccessful).toBe(true);
    expect(reopenResult.afterText).toBe('سەردێڕی نوێکراوە لە کانڤا');
    expect(reopenResult.unmodifiedElementsIntact).toBe(true);
    expect(reopenResult.totalElementsPreserved).toBe(record.elementsCount);
  });

  it('7. Proves sampled rollback test: bit-exact original source restoration (FR-070)', () => {
    const originalContent = {
      version: '0.3.9',
      documentId: 'doc_rollback_sample_07',
      layers: [{ id: 'l1', type: 'text', text: 'Text to preserve forever' }],
    };

    const docInput: HistoricalDocumentInput = {
      documentId: 'doc_rollback_sample_07',
      taskId: 'task_rollback_sample_07',
      clientId: 'c1000000-0000-4000-8000-000000000002',
      title: 'Rollback Sample Test Document',
      sourceFormat: 'hycanvas_json',
      lifecycleState: 'active_inflight',
      sourceContent: originalContent,
    };

    const record = migrator.migrateDocument(docInput, canvaAdapter);

    // Rollback test
    const rollbackResult = migrator.testSampledRollback('doc_rollback_sample_07');

    expect(rollbackResult.rollbackSuccessful).toBe(true);
    expect(rollbackResult.sourceSha256Verified).toBe(true);
    expect(rollbackResult.originalSourceRetrieved).toEqual(originalContent);
  });

  it('8. Exports MIGRATION_LEDGER.csv and generates reconciliation summary with zero silent drops', () => {
    migrator.migrateDocument(
      {
        documentId: 'doc_ledger_sample_08',
        taskId: 'task_ledger_08',
        clientId: 'c1000000-0000-4000-8000-000000000002',
        title: 'Ledger Sample Document',
        sourceFormat: 'hycanvas_json',
        lifecycleState: 'active_inflight',
        sourceContent: { layers: [{ id: 't1', type: 'text', text: 'نموونەی دەقی خشتەی کۆچپێکردن' }] },
      },
      canvaAdapter
    );

    // Generate ledger CSV
    const csv = migrator.generateMigrationLedgerCsv();
    expect(csv).toContain('document_id,task_id,client_id,source_format');
    expect(csv).toContain('doc_ledger_sample_08');

    // Check reconciliation
    const summary = migrator.generateReconciliationSummary();
    expect(summary.totalClassified).toBe(1);
    expect(summary.migratedVerified).toBe(1);
    expect(summary.silentlyDroppedCount).toBe(0); // Strictly 0
    expect(summary.unauthorizedReapprovedCount).toBe(0); // Strictly 0
  });

  it('9. Integrates with Core HTTP API for ledger, reconciliation, and sampled verification', async () => {
    // 1. Submit migration via HTTP
    const migRes = await app.request('/v1/migration/migrate', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        documentId: 'doc_http_test_01',
        taskId: 'task_http_01',
        clientId: 'c1000000-0000-4000-8000-000000000003',
        title: 'HTTP Test Campaign Document',
        sourceFormat: 'hycanvas_json',
        lifecycleState: 'active_inflight',
        sourceContent: {
          layers: [
            { id: 'txt1', type: 'text', text: 'دروستی - هەڵمەتی فەرمی ئۆنلاین' },
          ],
        },
      }),
    });
    expect(migRes.status).toBe(200);
    const migJson = await migRes.json();
    expect(migJson.record.migrationStatus).toBe('MIGRATED_VERIFIED');
    const canvaDesignId = migJson.record.targetCanvaId;

    // 2. Query ledger via HTTP
    const ledgerRes = await app.request('/v1/migration/ledger', {
      headers: authHeaders,
    });
    expect(ledgerRes.status).toBe(200);
    const ledgerJson = await ledgerRes.json();
    expect(ledgerJson.count).toBeGreaterThan(0);

    // 3. Query ledger CSV format
    const csvRes = await app.request('/v1/migration/ledger?format=csv', {
      headers: authHeaders,
    });
    expect(csvRes.status).toBe(200);
    const csvText = await csvRes.text();
    expect(csvText).toContain('doc_http_test_01');

    // 4. Query reconciliation summary via HTTP
    const reconRes = await app.request('/v1/migration/reconciliation', {
      headers: authHeaders,
    });
    expect(reconRes.status).toBe(200);
    const reconJson = await reconRes.json();
    expect(reconJson.silentlyDroppedCount).toBe(0);
    expect(reconJson.unauthorizedReapprovedCount).toBe(0);

    // 5. Test reopen sample via HTTP
    const reopenRes = await app.request('/v1/migration/reopen-sample', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        canvaDesignId,
        targetRole: 'headline',
        updatedText: 'دەقی نوێ لە ڕێگەی دەسکەوە',
      }),
    });
    expect(reopenRes.status).toBe(200);
    const reopenJson = await reopenRes.json();
    expect(reopenJson.reopenSuccessful).toBe(true);

    // 6. Test rollback sample via HTTP
    const rollRes = await app.request('/v1/migration/rollback-sample', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        documentId: 'doc_http_test_01',
      }),
    });
    expect(rollRes.status).toBe(200);
    const rollJson = await rollRes.json();
    expect(rollJson.rollbackSuccessful).toBe(true);
    expect(rollJson.sourceSha256Verified).toBe(true);
  });
});
