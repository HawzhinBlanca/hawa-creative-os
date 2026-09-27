import {auditPublicationReceipts} from '@hawa/domain';
import type {TaskRecord,DriveRecord,SheetRowRecord,ReconciliationReport} from '@hawa/contracts';
export {RECONCILIATION_BASIS,type TaskRecord,type DriveRecord,type SheetRowRecord,type DriftAnomalyKind,type DriftAnomaly,type ReconciliationReport} from '@hawa/contracts';

/** Compatibility adapter for offline fixture callers; production stores snapshots in PostgreSQL. */
export class ReconciliationService {
  audit(tasks:TaskRecord[],driveFiles:readonly DriveRecord[],sheetRows:readonly SheetRowRecord[],options:{simulated?:boolean}={}):ReconciliationReport {
    return auditPublicationReceipts(tasks,driveFiles,sheetRows,{auditId:crypto.randomUUID(),timestamp:new Date().toISOString(),...options});
  }
}
