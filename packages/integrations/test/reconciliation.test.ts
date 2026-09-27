import { assert, describe, it, expect } from 'vitest';
import {
  ReconciliationService,
  RECONCILIATION_BASIS,
  type TaskRecord,
  type DriveRecord,
  type SheetRowRecord,
} from '../src/reconciliation-service.js';
import { GooglePublisher } from '../src/google-publisher.js';

describe('ReconciliationService (FR-049, FR-050)', () => {
  it('flags an uncertain archive without claiming the Drive file is missing', () => {
    const report = new ReconciliationService().audit([
      { id: 'task-uncertain', status: 'ARCHIVE_RECONCILIATION', updatedAt: new Date().toISOString() },
    ], [], []);
    expect(report).toMatchObject({ status: 'divergent', inSyncCount: 0, driftCount: 1 });
    expect(report.anomalies).toEqual([expect.objectContaining({ taskId: 'task-uncertain',
      kind: 'ARCHIVE_OUTCOME_UNCONFIRMED', severity: 'high' })]);
    expect(report.anomalies[0].description).not.toMatch(/missing|absent/i);
  });
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

    const report = service.audit(tasks, drive, sheets);
    expect(report.status).toBe('clean');
    expect(report.driftCount).toBe(0);
    expect(report.inSyncCount).toBe(2);
  });

  it('reports a missing Drive delivery and repairs nothing: no row is invented', () => {
    const service = new ReconciliationService();
    const tasks: TaskRecord[] = [
      { id: 'task-drift-1', status: 'COMPLETE', packageHash: 'hash-drift-1', updatedAt: new Date().toISOString() },
    ];
    const drive: DriveRecord[] = []; // Missing deliverable!
    const sheets: SheetRowRecord[] = [
      { taskId: 'task-drift-1', rowNumber: 1, status: 'COMPLETE', packageHash: 'hash-drift-1', syncedAt: new Date().toISOString() },
    ];

    const report = service.audit(tasks, drive, sheets);
    expect(report.status).toBe('divergent');
    expect(report.driftCount).toBe(1);
    expect(report.anomalies[0]).toMatchObject({ taskId: 'task-drift-1', kind: 'MISSING_DRIVE_ASSET', severity: 'high' });
    expect(report.basis).toBe(RECONCILIATION_BASIS);
    expect(report.basis).toContain('Google Drive and Google Sheets were not read, and nothing was repaired');

    // The former auto-repair pushed drive_repaired_* / sha256_auto_reconciled here and reported it as uploaded.
    expect(drive).toEqual([]);
    expect(report).not.toHaveProperty('repairedCount');
    expect(report.anomalies[0]).not.toHaveProperty('repaired');
    expect(report.anomalies[0]).not.toHaveProperty('repairAction');
    expect(JSON.stringify(report.anomalies)).not.toMatch(/drive_repaired|sha256_auto_reconciled|uploaded/i);

    // A second audit still sees the drift: nothing was papered over.
    expect(service.audit(tasks, drive, sheets).status).toBe('divergent');
  });

  it('reports a status divergence and leaves the recorded Sheet row as it was', () => {
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

    const report = service.audit(tasks, drive, sheets);
    expect(report.status).toBe('divergent');
    expect(report.anomalies[0].kind).toBe('STATUS_DIVERGENCE');
    expect(report.anomalies[0].description).toBe(
      'Task status (COMPLETE) disagrees with the recorded Sheets row 42 (AWAITING_APPROVAL)'
    );
    expect(sheets).toEqual([
      { taskId: 'task-diverged', rowNumber: 42, status: 'AWAITING_APPROVAL', packageHash: 'hash-div', syncedAt: '2026-09-01T00:00:00Z' },
    ]);
  });

  it('has no latest audit until one runs, and never keeps a simulated audit as the latest', () => {
    const service = new ReconciliationService();
    // Formerly an invented clean report (12 tasks, 24 Drive files, all in sync) before any audit ran.
    expect(service.getLastReport()).toBeNull();

    const tasks: TaskRecord[] = [{ id: 'task-1', status: 'COMPLETE', updatedAt: new Date().toISOString() }];
    const simulated = service.audit(tasks, [], [], { simulated: true });
    expect(simulated.simulated).toBe(true);
    expect(simulated.basis).toContain('Rows supplied or altered by the caller were included.');
    expect(service.getLastReport()).toBeNull();

    const real = service.audit(tasks, [], []);
    expect(real.simulated).toBe(false);
    expect(service.getLastReport()).toBe(real);
  });

  it('handles GooglePublisher reconciliation without throwing unhandled exceptions', async () => {
    const publisher = new GooglePublisher();
    const nonExistentId = '00000000-0000-4000-8000-000000000000';
    const ctx = {
      tenantId: 'tenant-default',
      taskId: 'task-test',
      actor: { type: 'workflow' as const, id: 'publisher' },
      correlationId: 'corr-1',
      deadline: new Date().toISOString(),
      idempotencyKey: 'key-1',
    };

    const res = await publisher.reconcile(ctx, nonExistentId);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect((res as any).error.code).toBe('PUBLICATION_RECEIPT_NOT_FOUND');
    }

    const verifyRes = await publisher.verify(ctx, nonExistentId);
    expect(verifyRes.ok).toBe(true); assert(verifyRes.ok);
    expect(verifyRes.value.consistent).toBe(false);
  });
});
