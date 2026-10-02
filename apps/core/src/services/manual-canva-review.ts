import { createHash } from 'node:crypto';
import { sql, RevisionRepository, TaskRepository, type Kysely, type Database } from '@hawa/db';
import { savedDesignCopy } from './saved-design-copy.js';
import { resolveQcProfileId, type CanvaQcEvaluation, type ExportRow } from './canva-task-outcome.js';
import { latestNativeCopy } from './initial-native-handoff.js';
import { nativeRevisionIntent } from '@hawa/domain';
import type { NativeRecoveryScope } from '@hawa/domain';
import { lockNativeRecovery } from './lifecycle-native-scope.js';

export type CaptureReview =
  | { status: 'recorded'; revisionId: string; qaPassed: boolean; checkedArtifactId: string }
  | { status: 'blocked' | 'not_applicable'; reason: string; retryable?: boolean };

/** Called inside the actor's RLS transaction after a checked export has been retained. */
export async function recordManualCanvaReview(
  trx: Kysely<Database>, evaluate: (row: ExportRow, copy: string[]) => CanvaQcEvaluation,
  p: { tenantId: string; taskId: string; actorId: string; artifactId: string;
    lifecycle?: NativeRecoveryScope; role?: string },
): Promise<CaptureReview> {
  const blocked = (reason: string): CaptureReview => ({ status: 'blocked', reason, retryable: false });
  if (p.lifecycle) await lockNativeRecovery(trx,{tenantId:p.tenantId,actorId:p.actorId,role:p.role,nativeRecovery:p.lifecycle},p.taskId);
  const task = (await sql<{ client_id: string; request_id: string | null; state: string; version: number; updated_at: Date; current_design_revision_id: string | null; source: unknown }>`
    SELECT t.client_id,t.request_id,t.state,t.version,t.updated_at,t.current_design_revision_id,
      (SELECT e.data FROM hawa.task_events e WHERE e.tenant_id=t.tenant_id AND e.task_id=t.id
        AND e.event_type='task.created' ORDER BY e.aggregate_version LIMIT 1) AS source
    FROM hawa.tasks t WHERE t.tenant_id=${p.tenantId}::uuid AND t.id=${p.taskId}::uuid FOR UPDATE OF t`.execute(trx)).rows[0];
  const source = task?.source as { payload?: { body?: { workflow?: string } }; body?: { workflow?: string } } | undefined;
  const revisionCopy = await latestNativeCopy(trx, p.tenantId, p.taskId);
  if (nativeRevisionIntent(task?.source) && revisionCopy?.kind !== 'revision')
    return blocked('Confirm the exact revised copy against the current native design before recording review.');
  if (!task || (task.request_id && !p.lifecycle) || (!revisionCopy && (source?.payload?.body || source?.body)?.workflow !== 'canva_manual'))
    return { status: 'not_applicable', reason: 'The task is not a manual Desk request.' };
  if (!['received', 'failed_operator', 'human_review', 'revision_requested', 'approved'].includes(task.state))
    return blocked('This task is no longer accepting manual design captures for review.');
  const binding = (await sql<{ id: string; canva_design_id: string; version: number }>`SELECT id,canva_design_id,version
    FROM hawa.canva_bindings WHERE tenant_id=${p.tenantId}::uuid AND task_id=${p.taskId}::uuid
      AND client_id=${task.client_id}::uuid AND status='bound' FOR SHARE`.execute(trx)).rows[0];
  if (!binding) return blocked('Link the current client’s Canva design before recording review.');
  const rows = (await sql<ExportRow & { created_at: Date; confirmation_event_id: string | null }>`SELECT b.id,b.sha256,b.format,b.content,b.content_check,b.created_at,
      o.metadata->>'designUpdatedAt' AS capture_version,
      o.metadata->'checkingPolicy'->>'confirmationEventId' AS confirmation_event_id FROM hawa.canva_export_bytes b
    JOIN hawa.canva_remote_operations o ON o.id=b.operation_id AND o.tenant_id=b.tenant_id
    WHERE b.tenant_id=${p.tenantId}::uuid AND b.task_id=${p.taskId}::uuid AND b.client_id=${task.client_id}::uuid
      AND o.design_id=${binding.canva_design_id} AND o.binding_version=${binding.version} AND o.status='retrieved'
      AND (b.id=${p.artifactId}::uuid OR b.format='png') ORDER BY b.created_at DESC`.execute(trx)).rows;
  const checked = rows.find(row => row.id === p.artifactId && row.format === 'pptx' && row.content_check);
  const png = checked?.capture_version ? rows.find(row => row.format === 'png' && row.capture_version === checked.capture_version &&
    (!revisionCopy || row.confirmation_event_id === revisionCopy.id)) : undefined;
  if (!checked || !png) return blocked('Capture PNG and check copy and fonts from the same saved Canva version before review.');
  if (revisionCopy) {
    const policy = (checked.content_check as { checkingPolicy?: { kind?: string; confirmationEventId?: string } })?.checkingPolicy;
    if (policy?.kind !== `${revisionCopy.kind}_client_dna` || policy.confirmationEventId !== revisionCopy.id)
      return blocked('Capture and check this design against the latest confirmed revised copy before review.');
  }
  const policyCurrent=(await sql<{current:boolean}>`SELECT hawa.canva_export_policy_current(o.tenant_id,o.client_id,COALESCE(o.metadata,'{}'::jsonb) || jsonb_build_object('taskId',o.task_id)) AS current
    FROM hawa.canva_remote_operations o JOIN hawa.canva_export_bytes b ON b.operation_id=o.id AND b.tenant_id=o.tenant_id
    WHERE b.id=${checked.id}::uuid AND b.tenant_id=${p.tenantId}::uuid`.execute(trx)).rows[0];
  if (!policyCurrent?.current) return blocked('The revision basis or client font policy changed. Capture and check the current design before review.');
  const priorQc = task.current_design_revision_id ? (await sql<{ critical_pass: boolean; status: string; artifact_id: string; started_at: Date }>`
    SELECT critical_pass,status,report->>'exportArtifactId' AS artifact_id,started_at FROM hawa.qc_runs
    WHERE tenant_id=${p.tenantId}::uuid AND design_revision_id=${task.current_design_revision_id}::uuid
    ORDER BY started_at DESC LIMIT 1`.execute(trx)).rows[0] : undefined;
  if (priorQc?.artifact_id === checked.id && task.state !== 'revision_requested')
    return { status: 'recorded', revisionId: task.current_design_revision_id!,
      qaPassed: priorQc.status === 'passed' && priorQc.critical_pass, checkedArtifactId: checked.id };
  if ((priorQc && new Date(checked.created_at) <= new Date(priorQc.started_at)) ||
      (['revision_requested', 'approved'].includes(task.state) && new Date(checked.created_at) <= new Date(task.updated_at)))
    return blocked('This capture predates the latest review or decision. Capture the current saved design before review.');
  if ([checked, png].some(row => !row.content?.length || !/^[0-9a-f]{64}$/.test(row.sha256) ||
      createHash('sha256').update(row.content).digest('hex') !== row.sha256))
    return blocked('The stored capture failed its integrity check. Capture fresh files before review.');
  let copy: string[];
  try { copy = revisionCopy?.copy ?? savedDesignCopy(task.source, '').copy; }
  catch { return blocked('The saved request has no valid exact copy. Review the request before capture.'); }
  // ADR-256: the PNG captured with it is the picture that ships; contrast and the safe area are measured on it.
  const qc = evaluate({ ...checked, preview_png: png.content, preview_sha256: png.sha256 }, copy);
  if (!qc.sourceTextObjects?.length)
    return blocked('The captured source has no complete map of addressable live text. Inspect the source in Canva and capture a valid editable export.');
  const profileId = await resolveQcProfileId(trx, p.tenantId);
  if (task.state !== 'human_review') await new TaskRepository(trx).transitionState({ taskId: p.taskId, tenantId: p.tenantId,
    expectedVersion: Number(task.version), fromState: task.state as 'received' | 'failed_operator' | 'revision_requested' | 'approved',
    toState: 'human_review', actorType: 'user', actorId: p.actorId,
    reason: 'The operator captured a manual Canva design and its checked source for review.',
    data: { exportArtifactId: checked.id, previewArtifactId: png.id, captureVersion: checked.capture_version },
  }, trx);
  const revision = await new RevisionRepository(trx).createRevision({
    tenantId: p.tenantId, taskId: p.taskId, studio: 'canva', sourceSha256: checked.sha256,
    // This is the retained database source locator, not an invented filesystem file.
    sourceStorageKey: `canva_export_bytes/${checked.id}`, previewSha256: png.sha256,
    neutralManifest: { studio: 'canva', documentId: binding.canva_design_id, designId: binding.canva_design_id,
      copy, nodes: qc.sourceTextObjects, semanticCoverage: 'pptx_live_text_only', nativeVerification: 'unverified',
      checkingPolicy: (checked.content_check as {checkingPolicy?: unknown})?.checkingPolicy || null,
      ...(revisionCopy?.kind === 'revision' ? { nativeRevisionHandoff: { confirmationEventId: revisionCopy.id,
        parentTaskId: revisionCopy.confirmation.parentTaskId, parentDesignId: revisionCopy.confirmation.parentDesignId,
        preservation: revisionCopy.confirmation.preservation, nativePreservationVerified: false } } : {}),
      ...(revisionCopy?.kind === 'initial' ? { nativeInitialHandoff: { confirmationEventId: revisionCopy.id,
        requestId: revisionCopy.confirmation.requestId, separateDesign: revisionCopy.confirmation.separateDesign } } : {}),
      capturedSource: { artifactId: checked.id, sha256: checked.sha256, format: 'pptx', captureVersion: checked.capture_version },
      preview: { artifactId: png.id, sha256: png.sha256 }, bindingId: binding.id, bindingVersion: binding.version,
      ...(task.current_design_revision_id ? { revisedFrom: task.current_design_revision_id } : {}) },
    authorType: 'user', authorId: p.actorId, status: 'review',
  }, trx);
  const report = { ...qc.qaReport, exportArtifactId: checked.id, captureVersion: checked.capture_version,
    previewArtifactId: png.id, previewSha256: png.sha256 };
  await trx.insertInto('qc_runs').values({ tenant_id: p.tenantId, task_id: p.taskId,
    design_revision_id: revision.id, qc_profile_id: profileId, status: qc.status as 'passed' | 'failed',
    critical_pass: qc.criticalPass, report,
    report_sha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'),
  }).execute();
  return { status: 'recorded', revisionId: revision.id, qaPassed: qc.status === 'passed' && qc.criticalPass,
    checkedArtifactId: checked.id };
}
