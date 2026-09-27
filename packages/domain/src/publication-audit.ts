import {RECONCILIATION_BASIS,type TaskRecord,type DriveRecord,type SheetRowRecord,type ReconciliationReport,type DriftAnomaly} from '@hawa/contracts';

/** Pure comparison of a stated snapshot; no network, storage, clock or retained report. */
export function auditPublicationReceipts(tasks:readonly TaskRecord[],driveFiles:readonly DriveRecord[],sheetRows:readonly SheetRowRecord[],options:{auditId:string;timestamp:string;simulated?:boolean}):ReconciliationReport {
  const {auditId,timestamp}=options;
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

    let inSyncCount = 0, pendingTaskCount = 0;

    for (const task of tasks) {
      if (task.status === 'ARCHIVE_RECONCILIATION' || task.publicationErrorClass === 'ARCHIVE_UNCONFIRMED') {
        anomalies.push({ taskId: task.id, kind: 'ARCHIVE_OUTCOME_UNCONFIRMED', severity: 'high',
          description: `Task ${task.id} (${task.status}) has an unresolved Drive outcome. Core cannot prove whether the file exists until the reserved identity is rechecked against Drive.`,
          detectedAt: timestamp });
        continue;
      }
      // Only tasks that should already have been delivered can drift. PUBLISH_RECONCILIATION is a task
      // whose files were delivered while its Sheets row was not confirmed.
      if (['COMPLETE', 'PUBLISH_RECONCILIATION'].includes(task.status)) {
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
            description: `Task ${task.id} is ${task.status} but no Drive delivery is recorded for it`,
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

        if (task.expectedFiles === null) {
          taskHasDrift = true;
          anomalies.push({taskId:task.id,kind:'INCOMPLETE_PUBLICATION_EVIDENCE',severity:'high',description:'The current publication has no usable artifact manifest.',detectedAt:timestamp});
        } else if (task.expectedFiles) {
          for (const expected of task.expectedFiles) {
            if (!driveEntries.some(f=>f.name===expected.name&&f.sha256===expected.sha256&&f.byteSize===expected.size)) {
              taskHasDrift = true;
              anomalies.push({taskId:task.id,kind:'CHECKSUM_MISMATCH',severity:'high',description:`No verified current-publication receipt matches artifact ${expected.name}, its hash and size.`,detectedAt:timestamp});
            }
          }
        }
        if (sheetEntry && task.packageHash && sheetEntry.packageHash !== task.packageHash) {
          taskHasDrift = true;
          anomalies.push({taskId:task.id,kind:'CHECKSUM_MISMATCH',severity:'high',description:'The stored Sheet receipt belongs to a different publication package.',detectedAt:timestamp});
        }
        if (sheetEntry && sheetEntry.expectedRowHash !== undefined && sheetEntry.observedRowHash !== sheetEntry.expectedRowHash) {
          taskHasDrift = true;
          anomalies.push({taskId:task.id,kind:'RECEIPT_HASH_UNCONFIRMED',severity:'medium',description:'The stored Sheet receipt has no matching observed row hash.',detectedAt:timestamp});
        }
        if (!taskHasDrift) {
          inSyncCount++;
        }
      } else {
        pendingTaskCount++;
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
      pendingTaskCount,
      driftCount: anomalies.length,
      anomalies,
      status: anomalies.length === 0 ? 'clean' : 'divergent',
    };

    return report;
}
