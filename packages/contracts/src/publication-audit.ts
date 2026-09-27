export interface TaskRecord {
  id: string;
  status: string;
  publicationErrorClass?: string | null;
  clientId?: string;
  latestRevisionId?: string;
  packageHash?: string;
  updatedAt: string;
  expectedFiles?: Array<{name:string;sha256:string;size:number}> | null;
}

export interface DriveRecord {
  taskId: string;
  fileId: string;
  folderId: string;
  sha256: string | null;
  byteSize: number | null;
  name?: string;
}

export interface SheetRowRecord {
  taskId: string;
  rowNumber: number;
  status: string;
  packageHash: string;
  syncedAt: string;
  expectedRowHash?: string;
  observedRowHash?: string | null;
}

export type DriftAnomalyKind =
  | 'ARCHIVE_OUTCOME_UNCONFIRMED'
  | 'INCOMPLETE_PUBLICATION_EVIDENCE'
  | 'RECEIPT_HASH_UNCONFIRMED'
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
  pendingTaskCount: number;
  driftCount: number;
  anomalies: DriftAnomaly[];
  status: 'clean' | 'divergent';
}


export interface ReceiptAuditScope { sha256:string; clientIds:string[]; includesUnassigned:true }
export interface ReceiptAuditAction { actionId:string; expectedScopeSha256:string; expectedLatestAuditId:string|null; reason:string }
export interface StoredReceiptAudit extends ReconciliationReport {
  simulated:false; revision:number; actorUserId:string; reason:string; scopeSha256:string;
  inputsSha256:string; reportSha256:string;
}
export interface ReceiptAuditState {
  schemaVersion:1; tenantId:string; userId:string; scope:ReceiptAuditScope;
  latest:StoredReceiptAudit|null; history:StoredReceiptAudit[]; nextBeforeRevision:number|null;
}
export type ReceiptAuditResult = StoredReceiptAudit & {replayed:boolean};

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function parseReceiptAuditAction(value:unknown):ReceiptAuditAction|null {
  if(!object(value)||Object.keys(value).length!==4||!uuid(value.actionId)||!digest(value.expectedScopeSha256)||
    !(value.expectedLatestAuditId===null||uuid(value.expectedLatestAuditId))||typeof value.reason!=='string'||
    value.reason.trim().length<1||value.reason.trim().length>500)return null;
  return {actionId:value.actionId,expectedScopeSha256:value.expectedScopeSha256,expectedLatestAuditId:value.expectedLatestAuditId,reason:value.reason.trim()};
}

export function parseStoredReceiptAudit(value:unknown):StoredReceiptAudit|null {
  if(!object(value)||!uuid(value.auditId)||!uuid(value.actorUserId)||value.simulated!==false||
    typeof value.timestamp!=='string'||!Number.isFinite(Date.parse(value.timestamp))||typeof value.basis!=='string'||!value.basis||
    typeof value.reason!=='string'||!value.reason||!digest(value.scopeSha256)||!digest(value.inputsSha256)||!digest(value.reportSha256)||
    !Number.isSafeInteger(value.revision)||Number(value.revision)<1||!['clean','divergent'].includes(String(value.status)))return null;
  const counts=['totalTasksAudited','totalDriveDeliverablesChecked','totalSheetRowsAudited','inSyncCount','pendingTaskCount','driftCount'];
  if(counts.some(k=>!Number.isSafeInteger(value[k])||Number(value[k])<0)||
    Number(value.inSyncCount)+Number(value.pendingTaskCount)>Number(value.totalTasksAudited)||
    (value.status==='clean')!==(value.driftCount===0)||!Array.isArray(value.anomalies)||value.anomalies.length!==value.driftCount)return null;
  if(!value.anomalies.every(a=>object(a)&&uuid(a.taskId)&&['ARCHIVE_OUTCOME_UNCONFIRMED','INCOMPLETE_PUBLICATION_EVIDENCE',
    'RECEIPT_HASH_UNCONFIRMED','MISSING_DRIVE_ASSET','MISSING_SHEET_ROW','CHECKSUM_MISMATCH','STATUS_DIVERGENCE'].includes(String(a.kind))&&
    ['high','medium'].includes(String(a.severity))&&typeof a.description==='string'&&a.description&&a.detectedAt===value.timestamp))return null;
  return value as unknown as StoredReceiptAudit;
}
export function parseReceiptAuditState(value:unknown):ReceiptAuditState|null {
  if(!object(value)||value.schemaVersion!==1||!uuid(value.tenantId)||!uuid(value.userId)||!object(value.scope)||
    !digest(value.scope.sha256)||value.scope.includesUnassigned!==true||!Array.isArray(value.scope.clientIds)||
    !value.scope.clientIds.every(uuid)||new Set(value.scope.clientIds).size!==value.scope.clientIds.length||
    !Array.isArray(value.history)||value.history.length>20||
    !(value.nextBeforeRevision===null||Number.isSafeInteger(value.nextBeforeRevision)&&Number(value.nextBeforeRevision)>0))return null;
  const scope=value.scope;
  const reports=[...(value.latest===null?[]:[value.latest]),...value.history].map(parseStoredReceiptAudit);
  if(reports.some(r=>!r||r.actorUserId!==value.userId||r.scopeSha256!==scope.sha256))return null;
  const history=value.history as StoredReceiptAudit[];
  if(history.some((r,i)=>i>0&&r.revision>=history[i-1].revision))return null;
  const latest=value.latest as StoredReceiptAudit|null;
  if(latest===null&&(history.length>0||value.nextBeforeRevision!==null)||
    new Set(history.map(r=>r.auditId)).size!==history.length||
    history.some(r=>!latest||r.revision>latest.revision||
      r.revision===latest.revision&&(r.auditId!==latest.auditId||r.reportSha256!==latest.reportSha256))||
    value.nextBeforeRevision!==null&&(history.length!==20||history[19].revision!==value.nextBeforeRevision))return null;
  return value as unknown as ReceiptAuditState;
}
