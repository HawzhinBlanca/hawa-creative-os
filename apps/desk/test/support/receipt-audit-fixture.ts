import type {StoredReceiptAudit,ReceiptAuditState,ReceiptAuditAction} from '@hawa/contracts';
export const receiptAudit:StoredReceiptAudit={auditId:'00000000-0000-4000-a000-000000000010',actorUserId:'00000000-0000-4000-a000-000000000011',
 timestamp:'2026-09-27T12:00:00.000Z',basis:'Stored PostgreSQL receipts. External services were not read.',simulated:false,revision:1,reason:'Review stored receipts',
 scopeSha256:'a'.repeat(64),inputsSha256:'b'.repeat(64),reportSha256:'c'.repeat(64),totalTasksAudited:0,totalDriveDeliverablesChecked:0,totalSheetRowsAudited:0,
 inSyncCount:0,pendingTaskCount:0,driftCount:0,status:'clean',anomalies:[]};
export const receiptAuditState=(audit:StoredReceiptAudit|null=receiptAudit):ReceiptAuditState=>({schemaVersion:1,tenantId:'00000000-0000-4000-a000-000000000001',
 userId:receiptAudit.actorUserId,scope:{sha256:receiptAudit.scopeSha256,clientIds:['00000000-0000-4000-a000-000000000012'],includesUnassigned:true},
 latest:audit,history:audit?[audit]:[],nextBeforeRevision:null});
export const receiptAuditAction:ReceiptAuditAction={actionId:receiptAudit.auditId,expectedScopeSha256:receiptAudit.scopeSha256,expectedLatestAuditId:null,reason:receiptAudit.reason};
