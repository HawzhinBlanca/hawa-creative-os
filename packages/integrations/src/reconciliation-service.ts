import type { UUID } from '@hawa/contracts';

export interface TaskRecord {
  id: string;
  status: string;
  publicationErrorClass?: string | null;
  clientId?: string;
  latestRevisionId?: string;
  packageHash?: string;
  updatedAt: string;
}

export interface DriveRecord {
  taskId: string;
  fileId: string;
  folderId: string;
  sha256: string;
  byteSize: number;
}

export interface SheetRowRecord {
  taskId: string;
  rowNumber: number;
  status: string;
  packageHash: string;
  syncedAt: string;
}

export type DriftAnomalyKind =
  | 'ARCHIVE_OUTCOME_UNCONFIRMED'
  | 'MISSING_DRIVE_ASSET'
  | 'MISSING_SHEET_ROW'
  | 'CHECKSUM_MISMATCH'
  | 'STATUS_DIVERGENCE';

export interface DriftAnomaly {
  taskId: string;
  kind: DriftAnomalyKind;
  severity: 'high' | 'medium';
  description: string;
  detectedAt: string;
}

/** What an audit compares. Core has no Drive or Sheets read path, so it never claims to have read them. */
export const RECONCILIATION_BASIS =
  'PostgreSQL task and publication records against the verified delivery receipts Core stored. Google Drive and Google Sheets were not read, and nothing was repaired.';

export interface ReconciliationReport {
  auditId: string;
  timestamp: string;
  basis: string;
  /** True when the caller supplied or altered the rows being compared; such a report is never kept as the latest audit. */
  simulated: boolean;
  totalTasksAudited: number;
  totalDriveDeliverablesChecked: number;
  totalSheetRowsAudited: number;
  inSyncCount: number;
  driftCount: number;
  anomalies: DriftAnomaly[];
  status: 'clean' | 'divergent';
}

/**
 * Audits task state against the delivery records it is given and reports drift. It repairs
 * nothing: Core has no path that uploads to Drive or writes Sheets from here, and the former
 * "auto-repair" only appended invented rows (drive_repaired_*, sha256_auto_reconciled) that Core
 * then served as publication receipts.
 */
export class ReconciliationService {
  private lastReport: ReconciliationReport | null = null;

  audit(
    tasks: TaskRecord[],
    driveFiles: readonly DriveRecord[],
    sheetRows: readonly SheetRowRecord[],
    options: { simulated?: boolean } = {}
  ): ReconciliationReport {
    const auditId = `audit_${crypto.randomUUID().slice(0, 8)}_${Date.now()}`;
    const timestamp = new Date().toISOString();
    const anomalies: DriftAnomaly[] = [];

    const driveByTask = new Map<string, DriveRecord[]>();
    for (const f of driveFiles) {
      if (!driveByTask.has(f.taskId)) driveByTask.set(f.taskId, []);
      driveByTask.get(f.taskId)!.push(f);
    }

    const sheetByTask = new Map<string, SheetRowRecord>();
    for (const r of sheetRows) {
      sheetByTask.set(r.taskId, r);
    }

    let inSyncCount = 0;

    for (const task of tasks) {
      if (task.status === 'ARCHIVE_RECONCILIATION' || task.publicationErrorClass === 'ARCHIVE_UNCONFIRMED') {
        anomalies.push({ taskId: task.id, kind: 'ARCHIVE_OUTCOME_UNCONFIRMED', severity: 'high',
          description: `Task ${task.id} (${task.status}) has an unresolved Drive outcome. Core cannot prove whether the file exists until the reserved identity is rechecked against Drive.`,
          detectedAt: timestamp });
        continue;
      }
      // Only tasks that should already have been delivered can drift. PUBLISH_RECONCILIATION is a task
      // whose files were delivered while its Sheets row was not confirmed.
      if (['COMPLETE', 'APPROVED', 'PUBLISHING', 'PUBLISH_RECONCILIATION'].includes(task.status)) {
        const driveEntries = driveByTask.get(task.id) || [];
        const sheetEntry = sheetByTask.get(task.id);

        let taskHasDrift = false;

        // Check 1: no Drive delivery recorded
        if ((task.status === 'COMPLETE' || task.status === 'PUBLISH_RECONCILIATION') && driveEntries.length === 0) {
          taskHasDrift = true;
          anomalies.push({
            taskId: task.id,
            kind: 'MISSING_DRIVE_ASSET',
            severity: 'high',
            description: `Task ${task.id} is COMPLETE but no Drive delivery is recorded for it`,
            detectedAt: timestamp,
          });
        }

        // Check 2: no Sheets reporting row recorded (FR-049: keyed by immutable taskId)
        if (!sheetEntry) {
          taskHasDrift = true;
          anomalies.push({
            taskId: task.id,
            kind: 'MISSING_SHEET_ROW',
            severity: 'medium',
            description: `Task ${task.id} has no Sheets reporting row recorded`,
            detectedAt: timestamp,
          });
        } else if (sheetEntry.status !== task.status) {
          // Check 3: status divergence
          taskHasDrift = true;
          anomalies.push({
            taskId: task.id,
            kind: 'STATUS_DIVERGENCE',
            severity: 'medium',
            description: `Task status (${task.status}) disagrees with the recorded Sheets row ${sheetEntry.rowNumber} (${sheetEntry.status})`,
            detectedAt: timestamp,
          });
        }

        if (!taskHasDrift) {
          inSyncCount++;
        }
      } else {
        inSyncCount++;
      }
    }

    const simulated = options.simulated === true;
    const report: ReconciliationReport = {
      auditId,
      timestamp,
      basis: simulated ? `${RECONCILIATION_BASIS} Rows supplied or altered by the caller were included.` : RECONCILIATION_BASIS,
      simulated,
      totalTasksAudited: tasks.length,
      totalDriveDeliverablesChecked: driveFiles.length,
      totalSheetRowsAudited: sheetRows.length,
      inSyncCount,
      driftCount: anomalies.length,
      anomalies,
      status: anomalies.length === 0 ? 'clean' : 'divergent',
    };

    if (!simulated) this.lastReport = report;
    return report;
  }

  /** The latest audit of Core's own state, or null when none has run since Core started. */
  getLastReport(): ReconciliationReport | null {
    return this.lastReport;
  }
}
