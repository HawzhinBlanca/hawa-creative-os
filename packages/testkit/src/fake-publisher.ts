import type {
  Publisher,
  PublishRequest,
  PublicationReceipt,
  DriveFileReceipt,
  RequestContext,
  Result,
  AppError,
  UUID,
} from '@hawa/contracts';

interface StoredPublication {
  receipt: PublicationReceipt;
  request: PublishRequest;
}

export class FakePublisher implements Publisher {
  private publications = new Map<string, StoredPublication>();
  private failureMode: 'none' | 'drive_fail' | 'sheet_fail' = 'none';

  setFailureMode(mode: 'none' | 'drive_fail' | 'sheet_fail') {
    this.failureMode = mode;
  }

  async publish(_ctx: RequestContext, request: PublishRequest): Promise<Result<PublicationReceipt, AppError>> {
    const existing = this.publications.get(request.publicationKey);
    if (existing) {
      return { ok: true, value: existing.receipt };
    }

    if (this.failureMode === 'drive_fail') {
      return {
        ok: false,
        error: {
          code: 'DRIVE_UPLOAD_FAILED',
          message: 'Google Shared Drive returned 503 Service Unavailable',
          retryable: true,
          safeAction: 'Retry publication with same publication key under Restate',
        },
      };
    }

    const publicationId = crypto.randomUUID();
    const driveFolderId = request.destination.productionRootFolderId;

    const driveFiles: DriveFileReceipt[] = request.files.map((f) => ({
      artifactId: f.artifactId,
      fileId: `drive_file_${f.artifactId}`,
      folderId: driveFolderId,
      name: f.filename,
      mimeType: f.mimeType,
      observedSize: f.byteSize,
      expectedSha256: f.sha256,
      verified: true,
      webViewLink: `https://drive.google.com/file/d/drive_file_${f.artifactId}/view`,
    }));

    if (this.failureMode === 'sheet_fail') {
      const receipt: PublicationReceipt = {
        publicationId,
        publicationKey: request.publicationKey,
        driveFolderId,
        driveFiles,
        sheet: {
          spreadsheetId: request.destination.spreadsheetId,
          sheetId: request.destination.sheetId,
          rowKey: request.taskId,
          expectedHash: request.packageHash,
          synced: false,
        },
        state: 'drive_complete',
        detail: { reason: 'Injected sheet failure' },
      };
      this.publications.set(request.publicationKey, { receipt, request });
      return { ok: true, value: receipt };
    }

    const receipt: PublicationReceipt = {
      publicationId,
      publicationKey: request.publicationKey,
      driveFolderId,
      driveFiles,
      sheet: {
        spreadsheetId: request.destination.spreadsheetId,
        sheetId: request.destination.sheetId,
        rowKey: request.taskId,
        rowNumber: 42,
        expectedHash: request.packageHash,
        observedHash: request.packageHash,
        synced: true,
      },
      completedAt: new Date().toISOString(),
      state: 'complete',
      detail: { verified: true },
    };

    this.publications.set(request.publicationKey, { receipt, request });
    return { ok: true, value: receipt };
  }

  async reconcile(_ctx: RequestContext, publicationId: UUID): Promise<Result<PublicationReceipt>> {
    for (const item of this.publications.values()) {
      if (item.receipt.publicationId === publicationId) {
        item.receipt.sheet.synced = true;
        item.receipt.sheet.rowNumber = 42;
        item.receipt.state = 'complete';
        item.receipt.completedAt = new Date().toISOString();
        return { ok: true, value: item.receipt };
      }
    }
    throw new Error(`Publication ${publicationId} not found`);
  }

  async verify(_ctx: RequestContext, publicationId: UUID): Promise<Result<{ consistent: boolean; differences: Record<string, unknown>[] }>> {
    for (const item of this.publications.values()) {
      if (item.receipt.publicationId === publicationId) {
        return { ok: true, value: { consistent: true, differences: [] } };
      }
    }
    return { ok: true, value: { consistent: false, differences: [{ error: 'not_found' }] } };
  }
}
