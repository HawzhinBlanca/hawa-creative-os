import { describe, it, expect } from 'vitest';
import {
  ReconciliationService,
  type TaskRecord,
  type DriveRecord,
  type SheetRowRecord,
} from '../src/reconciliation-service.js';

describe('ReconciliationService (FR-049, FR-050)', () => {
  it('detects clean state when PostgreSQL, Drive, and Sheets are perfectly synced', () => {
    const service = new ReconciliationService();
    const tasks: TaskRecord[] = [
      { id: 'task-1', status: 'COMPLETE', packageHash: 'hash-1', updatedAt: new Date().toISOString() },
      { id: 'task-2', status: 'AWAITING_APPROVAL', updatedAt: new Date().toISOString() },
    ];
    const drive: DriveRecord[] = [
      { taskId: 'task-1', fileId: 'f-1', folderId: 'folder-1', sha256: 'hash-1', byteSize: 1024 },
    ];
    const sheets: SheetRowRecord[] = [
      { taskId: 'task-1', rowNumber: 1, status: 'COMPLETE', packageHash: 'hash-1', syncedAt: new Date().toISOString() },
    ];

    const report = service.auditAndReconcile(tasks, drive, sheets, false);
    expect(report.status).toBe('clean');
    expect(report.driftCount).toBe(0);
    expect(report.inSyncCount).toBe(2);
  });

  it('detects missing Drive deliverable and automatically repairs it idempotently', () => {
    const service = new ReconciliationService();
    const tasks: TaskRecord[] = [
      { id: 'task-drift-1', status: 'COMPLETE', packageHash: 'hash-drift-1', updatedAt: new Date().toISOString() },
    ];
    const drive: DriveRecord[] = []; // Missing deliverable!
    const sheets: SheetRowRecord[] = [
      { taskId: 'task-drift-1', rowNumber: 1, status: 'COMPLETE', packageHash: 'hash-drift-1', syncedAt: new Date().toISOString() },
    ];

    // Audit with autoRepair
    const report = service.auditAndReconcile(tasks, drive, sheets, true);
    expect(report.status).toBe('repaired');
    expect(report.driftCount).toBe(1);
    expect(report.repairedCount).toBe(1);
    expect(report.anomalies[0].kind).toBe('MISSING_DRIVE_ASSET');
    expect(report.anomalies[0].repaired).toBe(true);

    // Verify Drive deliverable was created idempotently
    expect(drive.length).toBe(1);
    expect(drive[0].taskId).toBe('task-drift-1');
  });

  it('detects status divergence and updates Sheet row by immutable task ID', () => {
    const service = new ReconciliationService();
    const tasks: TaskRecord[] = [
      { id: 'task-diverged', status: 'COMPLETE', packageHash: 'hash-div', updatedAt: new Date().toISOString() },
    ];
    const drive: DriveRecord[] = [
      { taskId: 'task-diverged', fileId: 'f-div', folderId: 'folder-1', sha256: 'hash-div', byteSize: 2048 },
    ];
    const sheets: SheetRowRecord[] = [
      { taskId: 'task-diverged', rowNumber: 42, status: 'AWAITING_APPROVAL', packageHash: 'hash-div', syncedAt: '2026-09-01T00:00:00Z' },
    ];

    const report = service.auditAndReconcile(tasks, drive, sheets, true);
    expect(report.status).toBe('repaired');
    expect(report.anomalies[0].kind).toBe('STATUS_DIVERGENCE');
    expect(report.anomalies[0].repaired).toBe(true);

    // Verify Sheet row status was updated without creating duplicate rows (FR-049)
    expect(sheets.length).toBe(1);
    expect(sheets[0].status).toBe('COMPLETE');
    expect(sheets[0].rowNumber).toBe(42);
  });
});
