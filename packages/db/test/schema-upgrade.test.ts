import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { upgradeCanvaSchema } from '../src/upgrade.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;
if (url && !/^\/hawa_(repair|tr_)/.test(new URL(url).pathname)) throw new Error('Isolated hawa_repair database required');
describe('versioned upgrade configuration', () => {
  it('refuses to report success without a target database', async () => {
    await expect(upgradeCanvaSchema('')).rejects.toThrow('DATABASE_URL is required');
  });
});
describe.skipIf(!url)('real PostgreSQL versioned upgrade', () => {
  it('applies once and concurrent retries verify the same recorded migrations', async () => {
    await upgradeCanvaSchema(url!);
    const results = await Promise.all([upgradeCanvaSchema(url!), upgradeCanvaSchema(url!)]);
    for (const result of results) {
      expect(result.applied).toEqual([]);
      expect(result.verified).toEqual(['001_canva_bindings.sql', '002_canva_binding_isolation.sql', '003_canva_connect.sql', '004_canva_task_scope_lock.sql', '005_canva_runtime_permissions.sql', '006_canva_editable_sources.sql', '007_canva_design_plans.sql', '008_canva_roundtrip_checks.sql', '009_correct_kaae_identity.sql', '010_canva_plan_abandon.sql', '011_desk_sessions.sql', '012_service_identities.sql', '013_design_studio.sql', '014_photo_cutouts.sql', '015_comparison_studies.sql', '016_rls_hoisted_membership_checks.sql', '017_comparison_link_reissue.sql', '018_desk_list_indexes.sql', '019_blob_store.sql', '020_inbox_event_dedupe.sql', '021_review_comments.sql', '022_publication_executor.sql', '023_request_lifecycle_projection.sql', '024_paid_model_health_observations.sql', '025_nullable_nonapproval_qa.sql', '026_publication_task_reconciliation_index.sql', '027_drive_upload_reservations.sql', '028_studio_call_admission.sql', '029_studio_provider_receipt_provenance.sql', '030_studio_call_receipt_immutability.sql', '031_task_delivery_executor_pin.sql', '032_lifecycle_photo_retention.sql', '033_lifecycle_revision_photo_retention.sql', '034_request_lifecycle_rejection.sql', '035_office_oidc_sessions.sql', '036_office_oidc_subject_lookup.sql', '037_office_review_assignments.sql', '038_office_review_assignment_audit.sql', '039_office_review_return.sql', '040_lifecycle_album_retention.sql', '041_client_documents.sql', '042_document_knowledge.sql', '043_lifecycle_source_retention.sql', '044_voice_source_admission.sql', '045_canva_review_checkpoints.sql', '046_canva_export_policy.sql', '047_durable_evaluation_calls.sql', '048_evaluation_settlement.sql', '049_studio_call_settlement.sql', '050_studio_spending_reservations.sql', '051_studio_scope_budgets.sql', '052_shared_office_spending.sql', '053_exact_call_cost_accounting.sql', '054_named_spending_policy.sql', '055_durable_paid_health_probes.sql', '056_durable_canva_planner_calls.sql', '057_scoped_receipt_audits.sql','058_availability_observations.sql','059_publication_expectations.sql','060_publication_inspections.sql']);
    }
  });
  it('rejects a changed applied checksum and leaves the receipt intact', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const name = '002_canva_binding_isolation.sql';
    const original = (await client.query('SELECT sha256 FROM hawa.schema_upgrades WHERE name = $1', [name])).rows[0].sha256;
    try {
      await client.query('UPDATE hawa.schema_upgrades SET sha256 = $1 WHERE name = $2', ['test-corruption', name]);
      await expect(upgradeCanvaSchema(url!)).rejects.toThrow('checksum mismatch');
      expect((await client.query('SELECT sha256 FROM hawa.schema_upgrades WHERE name = $1', [name])).rows[0].sha256).toBe('test-corruption');
    } finally {
      await client.query('UPDATE hawa.schema_upgrades SET sha256 = $1 WHERE name = $2', [original, name]);
      await client.end();
    }
  });
});
