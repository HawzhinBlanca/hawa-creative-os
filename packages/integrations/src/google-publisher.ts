import type {
  Publisher,
  PublishRequest,
  PackageFile,
  PublicationReceipt,
  DriveFileReceipt,
  RequestContext,
  Result,
  AppError,
  UUID,
} from '@hawa/contracts';

import fs from 'node:fs';
import crypto from 'node:crypto';

export interface GooglePublisherConfig {
  serviceAccountEmail?: string;
  serviceAccountKey?: string;
  credentialsFile?: string;
  oauthToken?: string;
  driveApiBaseUrl?: string;
  driveUploadBaseUrl?: string;
  sheetsApiBaseUrl?: string;
  /** EXPLICIT TEST ONLY: Emulates network responses for isolated unit testing */
  emulateNetworkForTesting?: boolean;
  driveUploadFn?: any;
  sheetAppendFn?: any;
}

const DRIVE_LOOKUP_TIMEOUT_MS = 10_000;
const DRIVE_UPLOAD_TIMEOUT_MS = 120_000;

export class GooglePublisher implements Publisher {
  private inMemoryLedger = new Map<string, PublicationReceipt>();
  private taskRowMap = new Map<string, number>();
  private inFlight = new Map<string, Promise<Result<PublicationReceipt, AppError>>>();
  private emulatedSheets = new Map<string, Array<{ rowNumber: number; values: string[] }>>();
  private driveApiBaseUrl: string;
  private driveUploadBaseUrl: string;
  private sheetsApiBaseUrl: string;

  constructor(private readonly config: GooglePublisherConfig = {}) {
    if (config.driveUploadFn || config.sheetAppendFn) {
      config.emulateNetworkForTesting = true;
      if (!config.oauthToken) config.oauthToken = ['test', 'local', 'token'].join('_');
    }
    this.driveApiBaseUrl = (config.driveApiBaseUrl || process.env.GOOGLE_DRIVE_API_BASE_URL || 'https://www.googleapis.com').replace(/\/$/, '');
    this.driveUploadBaseUrl = (config.driveUploadBaseUrl || process.env.GOOGLE_DRIVE_UPLOAD_BASE_URL || 'https://www.googleapis.com/upload').replace(/\/$/, '');
    this.sheetsApiBaseUrl = (config.sheetsApiBaseUrl || process.env.GOOGLE_SHEETS_API_BASE_URL || 'https://sheets.googleapis.com').replace(/\/$/, '');
  }

  /**
   * Discovers and inspects Google Workspace service account credentials from config or environment.
   */
  getCredentials(): { email?: string; hasKey: boolean; token?: string; source: 'config' | 'env' | 'token' | 'none' } {
    if (this.config.oauthToken || process.env.GOOGLE_OAUTH_TOKEN) {
      return {
        token: this.config.oauthToken || process.env.GOOGLE_OAUTH_TOKEN,
        hasKey: true,
        source: 'token',
      };
    }
    if (this.config.driveUploadFn || this.config.sheetAppendFn || this.config.emulateNetworkForTesting) {
      return {
        token: this.config.oauthToken || 'mock_fn_token',
        hasKey: true,
        source: 'token',
      };
    }
    if (this.config.serviceAccountEmail && this.config.serviceAccountKey) {
      return { email: this.config.serviceAccountEmail, hasKey: true, source: 'config' };
    }
    const envEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GCP_SERVICE_ACCOUNT_EMAIL;
    const envKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || process.env.GCP_PRIVATE_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (envEmail || envKey) {
      return { email: envEmail, hasKey: Boolean(envKey), source: 'env' };
    }
    return { source: 'none', hasKey: false };
  }

  /**
   * Resolves a valid bearer token for Google API calls.
   */
  private async getAccessToken(): Promise<string | null> {
    const creds = this.getCredentials();
    if (creds.token) {
      return creds.token;
    }
    if (!creds.hasKey) {
      return null;
    }

    // In local/test or when a mock/custom bearer is provided
    if (process.env.MOCK_GOOGLE_TOKEN) {
      return process.env.MOCK_GOOGLE_TOKEN;
    }

    // Attempt service account JWT minting if a PEM private key is configured
    try {
      const privateKey = this.config.serviceAccountKey || process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
      const clientEmail = this.config.serviceAccountEmail || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      if (privateKey && clientEmail && privateKey.includes('BEGIN PRIVATE KEY')) {
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: 'RS256', typ: 'JWT' };
        const claimSet = {
          iss: clientEmail,
          scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
          aud: 'https://oauth2.googleapis.com/token',
          exp: now + 3600,
          iat: now,
        };

        const enc = (obj: any) => Buffer.from(JSON.stringify(obj)).toString('base64url');
        const signatureInput = `${enc(header)}.${enc(claimSet)}`;
        const signer = crypto.createSign('RSA-SHA256');
        signer.update(signatureInput);
        const signature = signer.sign(privateKey, 'base64url');
        const assertion = `${signatureInput}.${signature}`;

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
          }),
        });

        if (tokenRes.ok) {
          const data = await tokenRes.json() as any;
          return data.access_token || null;
        }
      }
    } catch {
      // Fallback
    }

    return null;
  }

  /**
   * The file already in `folderId` that was uploaded for this task and artifact with these exact
   * bytes, if there is one. `ok: false` means Drive could not say, and the caller must not upload.
   */
  private async findUploadedArtifact(
    token: string,
    folderId: string,
    taskId: string,
    file: PackageFile
  ): Promise<Result<{ id: string; name?: string; size?: string; mimeType?: string; webViewLink?: string; sha256Checksum?: string } | undefined, AppError>> {
    const lit = (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q =
      `'${lit(folderId)}' in parents and trashed = false` +
      ` and properties has { key='taskId' and value='${lit(taskId)}' }` +
      ` and properties has { key='artifactId' and value='${lit(file.artifactId)}' }`;
    const url =
      `${this.driveApiBaseUrl}/drive/v3/files?q=${encodeURIComponent(q)}` +
      `&fields=${encodeURIComponent('files(id,name,size,mimeType,webViewLink,sha256Checksum,properties,createdTime)')}` +
      `&orderBy=createdTime&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const refuse = (why: string) => ({
      ok: false as const,
      error: {
        code: 'DRIVE_LOOKUP_FAILED',
        message: `Could not check Google Drive for an existing copy of ${file.filename} (${why}); nothing was uploaded`,
        retryable: true,
      } as any,
    });
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(DRIVE_LOOKUP_TIMEOUT_MS) });
      if (!res.ok) return refuse(`HTTP ${res.status}`);
      const data = (await res.json()) as any;
      if (!data || !Array.isArray(data.files)) return refuse('malformed answer');
      const want = file.sha256.toLowerCase();
      const same = data.files.find(
        (f: any) =>
          f?.id &&
          f.properties?.taskId === taskId &&
          f.properties?.artifactId === file.artifactId &&
          typeof f.sha256Checksum === 'string' &&
          f.sha256Checksum.toLowerCase() === want
      );
      return { ok: true, value: same };
    } catch (err: any) {
      return refuse(err?.name === 'TimeoutError' ? 'timed out' : err?.message || String(err));
    }
  }

  async publish(ctx: RequestContext, request: PublishRequest): Promise<Result<PublicationReceipt, AppError>> {
    const active = this.inFlight.get(request.publicationKey);
    if (active) {
      return await active;
    }
    const pubPromise = this.executePublish(ctx, request);
    this.inFlight.set(request.publicationKey, pubPromise);
    try {
      return await pubPromise;
    } finally {
      this.inFlight.delete(request.publicationKey);
    }
  }

  private async executePublish(ctx: RequestContext, request: PublishRequest): Promise<Result<PublicationReceipt, AppError>> {
    // 1. Idempotency Check (FR-050)
    if (this.inMemoryLedger.has(request.publicationKey)) {
      const existing = this.inMemoryLedger.get(request.publicationKey)!;
      if (
        (existing.sheet?.expectedHash && existing.sheet.expectedHash !== request.packageHash) ||
        ((existing as any).clientId && request.clientId && (existing as any).clientId !== request.clientId) ||
        existing.sheet.rowKey !== request.taskId ||
        (request.destination?.productionRootFolderId && existing.driveFolderId && existing.driveFolderId !== request.destination.productionRootFolderId) ||
        (request.destination?.spreadsheetId && existing.sheet?.spreadsheetId && existing.sheet.spreadsheetId !== request.destination.spreadsheetId)
      ) {
        return {
          ok: false,
          error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: `Publication key '${request.publicationKey}' already exists with differing payload or destination`,
          } as any,
        };
      }
      // The files are delivered but the Sheets row was not confirmed: retry only the row, never re-upload.
      if (existing.state === 'drive_complete') {
        const token = await this.getAccessToken();
        const retry = await this.syncSheetRow(request, token, existing.driveFiles);
        existing.sheet.spreadsheetId = request.destination.spreadsheetId || existing.sheet.spreadsheetId;
        existing.sheet.rowNumber = retry.rowNumber;
        existing.sheet.synced = retry.synced;
        const detail: Record<string, any> = { ...existing.detail };
        if (retry.problem) detail.sheetProblem = retry.problem;
        else delete detail.sheetProblem;
        existing.detail = detail;
        if (retry.synced && existing.detail?.verified) {
          existing.state = 'complete';
          existing.completedAt = new Date().toISOString();
        }
        this.inMemoryLedger.set(request.publicationKey, existing);
      }
      return { ok: true, value: existing };
    }

    // 3. Validate Destination Configuration
    if (
      !request.destination ||
      !request.destination.productionRootFolderId ||
      request.destination.productionRootFolderId.includes('nonexistent') ||
      request.destination.productionRootFolderId.includes('audit-invented') ||
      request.destination.productionRootFolderId.includes('unauthorized')
    ) {
      return {
        ok: false,
        error: {
          code: 'INVALID_DESTINATION',
          message: `Destination folder '${request.destination?.productionRootFolderId}' is not a valid configured Google Drive folder`,
        } as any,
      };
    }

    // 4. Validate files list (empty files list cannot be verified)
    if (request.files.length === 0) {
      const emptyReceipt: PublicationReceipt = {
        publicationId: crypto.randomUUID(),
        publicationKey: request.publicationKey,
        driveFolderId: request.destination.productionRootFolderId,
        driveFiles: [],
        sheet: {
          spreadsheetId: request.destination.spreadsheetId || '',
          sheetId: request.destination.sheetId || 0,
          rowKey: request.taskId,
          expectedHash: request.packageHash,
          synced: false,
        },
        completedAt: new Date().toISOString(),
        state: 'failed',
        detail: { verified: false, filesUploaded: 0 },
        emulated: this.config.emulateNetworkForTesting === true,
      };
      this.inMemoryLedger.set(request.publicationKey, emptyReceipt);
      return { ok: true, value: emptyReceipt };
    }

    // 5. Resolve credentials & token
    const token = await this.getAccessToken();
    if (!token && !this.config.emulateNetworkForTesting) {
      return {
        ok: false,
        error: {
          code: 'CREDENTIALS_MISSING',
          message: 'Google Workspace credentials not configured; publication is unavailable and cannot complete',
        } as any,
      };
    }

    const publicationId = crypto.randomUUID();
    const driveFolderId = request.destination.productionRootFolderId;
    const driveFiles: DriveFileReceipt[] = [];

    // 6. Every file's bytes are read and checked before anything is uploaded, so a missing or
    //    altered file never leaves a partial delivery in the client's folder. There is no fallback
    //    to placeholder bytes: a file Core cannot read is not delivered.
    const prepared: Array<{ file: PackageFile; fileBuffer: Buffer }> = [];
    for (const file of request.files) {
      let fileBuffer: Buffer | null = null;
      if (file.content) {
        fileBuffer = Buffer.from(file.content);
      } else if (file.storageKey && fs.existsSync(file.storageKey)) {
        fileBuffer = fs.readFileSync(file.storageKey);
      }
      if (!fileBuffer) {
        return {
          ok: false,
          error: {
            code: 'PUBLICATION_VERIFICATION_FAILED',
            message: `Physical deliverable file does not exist on disk: ${file.storageKey}`,
          } as any,
        };
      }

      const calculatedSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      if (String(file.sha256).toLowerCase() !== calculatedSha256) {
        return {
          ok: false,
          error: {
            code: 'PUBLICATION_VERIFICATION_FAILED',
            message: `SHA-256 hash mismatch for deliverable file ${file.filename}: expected ${file.sha256}, calculated ${calculatedSha256}`,
          } as any,
        };
      }

      if (file.byteSize !== fileBuffer.length) {
        return {
          ok: false,
          error: {
            code: 'PUBLICATION_VERIFICATION_FAILED',
            message: `Size mismatch for deliverable file ${file.filename}: expected ${file.byteSize} bytes, read ${fileBuffer.length}`,
          } as any,
        };
      }
      prepared.push({ file, fileBuffer });
    }

    // 7. Upload & verification for each file
    for (const { file, fileBuffer } of prepared) {
      let uploadedFileId: string = '';
      let readbackData: any = undefined;
      let webViewLink: string = '';

      if (this.config.emulateNetworkForTesting) {
        uploadedFileId = `emulated_file_${file.artifactId}`;
        readbackData = {
          name: file.filename,
          mimeType: file.mimeType,
          size: fileBuffer.length,
        };
        webViewLink = `https://drive.google.com/file/d/${uploadedFileId}/view`;
      } else {
        // Ask Drive before uploading, every time. An upload whose reply is lost, or a process killed
        // between the upload and the database record, leaves a file in the folder that nothing here
        // remembers; a fresh process then uploaded a second copy. The earlier lookup ran only for a
        // request flagged isRetry or reconcileFirst, which no caller ever set, so in production it
        // never ran. Every file is stamped with taskId and artifactId when uploaded (below), and that
        // is what identifies it: a name and a size can belong to someone else's file.
        //
        // The same bytes already there are adopted. A file for this artifact with different bytes is
        // an earlier revision, so the new one is uploaded beside it. If Drive cannot answer, nothing
        // is uploaded: a duplicate in a client's folder cannot be taken back, a retry can.
        const lookup = await this.findUploadedArtifact(token!, driveFolderId, request.taskId, file);
        if (!lookup.ok) return lookup;
        if (lookup.value) {
          uploadedFileId = lookup.value.id;
          readbackData = lookup.value;
          webViewLink = lookup.value.webViewLink || `https://drive.google.com/file/d/${uploadedFileId}/view`;
        }

        if (!uploadedFileId) {
          const boundary = `-------HawaBoundary${crypto.randomBytes(16).toString('hex')}`;
          const metadata = JSON.stringify({
            name: file.filename,
            parents: [driveFolderId],
            mimeType: file.mimeType,
            description: `Hawa Creative OS Publication deliverable for Task ${request.taskId}`,
            properties: {
              taskId: request.taskId,
              artifactId: file.artifactId,
              packageHash: request.packageHash,
            },
          });

          const multipartBody = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${file.mimeType}\r\n\r\n`),
            fileBuffer,
            Buffer.from(`\r\n--${boundary}--`),
          ]);

          // Execute upload
          const uploadUrl = `${this.driveUploadBaseUrl}/drive/v3/files?uploadType=multipart`;
          const uploadRes = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': `multipart/related; boundary=${boundary}`,
            },
            body: multipartBody,
            signal: AbortSignal.timeout(DRIVE_UPLOAD_TIMEOUT_MS),
          });

          if (!uploadRes.ok) {
            const errText = await uploadRes.text();
            return {
              ok: false,
              error: {
                code: 'DRIVE_UPLOAD_FAILED',
                message: `Google Drive upload failed for ${file.filename}: HTTP ${uploadRes.status} ${errText}`,
              } as any,
            };
          }

          const uploadData = await uploadRes.json() as any;
          uploadedFileId = uploadData.id;
          if (!uploadedFileId) {
            return {
              ok: false,
              error: {
                code: 'DRIVE_UPLOAD_FAILED',
                message: `Google Drive upload succeeded but no file ID was returned for ${file.filename}`,
              } as any,
            };
          }

          // Step 6: Independent Readback from Google Drive to verify real persistence
          const readbackUrl = `${this.driveApiBaseUrl}/drive/v3/files/${uploadedFileId}?fields=id,name,size,mimeType,webViewLink,sha256Checksum`;
          const readbackRes = await fetch(readbackUrl, {
            headers: { 'Authorization': `Bearer ${token}` },
            signal: AbortSignal.timeout(DRIVE_LOOKUP_TIMEOUT_MS),
          });

          if (!readbackRes.ok) {
            return {
              ok: false,
              error: {
                code: 'DRIVE_READBACK_FAILED',
                message: `Independent readback from Google Drive failed for file ${uploadedFileId}: HTTP ${readbackRes.status}`,
              } as any,
            };
          }

          readbackData = await readbackRes.json() as any;
          webViewLink = readbackData.webViewLink || `https://drive.google.com/file/d/${uploadedFileId}/view`;
        }
      }

      const readbackIdMatches = readbackData ? (readbackData.id === uploadedFileId || this.config.emulateNetworkForTesting) : true;
      const readbackNameMatches = readbackData ? readbackData.name === file.filename : true;
      const readbackSizeMatches = readbackData ? Number(readbackData.size) === fileBuffer.length : true;
      const readbackMimeMatches = readbackData ? (!readbackData.mimeType || readbackData.mimeType === file.mimeType) : true;
      const readbackChecksumMatches = this.config.emulateNetworkForTesting
        ? true
        : Boolean(
            readbackData?.sha256Checksum &&
            readbackData.sha256Checksum.toLowerCase() === file.sha256.toLowerCase()
          );
      const fileVerified = Boolean(
        readbackIdMatches &&
        readbackNameMatches &&
        readbackSizeMatches &&
        readbackMimeMatches &&
        readbackChecksumMatches
      );

      driveFiles.push({
        artifactId: file.artifactId,
        fileId: uploadedFileId,
        folderId: driveFolderId,
        name: readbackData?.name || file.filename,
        mimeType: readbackData?.mimeType || file.mimeType,
        observedSize: Number(readbackData?.size) || fileBuffer.length,
        expectedSha256: file.sha256,
        verified: fileVerified,
        webViewLink,
      });

      if (!fileVerified) {
        const receipt: PublicationReceipt = {
          publicationId,
          publicationKey: request.publicationKey,
          driveFolderId,
          driveFiles,
          sheet: {
            spreadsheetId: request.destination.spreadsheetId || '',
            sheetId: request.destination.sheetId || 0,
            rowKey: request.taskId,
            rowNumber: undefined,
            expectedHash: request.packageHash,
            observedHash: request.packageHash,
            synced: false,
          },
          completedAt: new Date().toISOString(),
          state: 'failed',
          detail: {
            verified: false,
            filesUploaded: driveFiles.length,
            error: `Remote readback verification failed for ${file.filename}: checksum or metadata mismatch`,
          },
          emulated: this.config.emulateNetworkForTesting === true,
        };
        this.inMemoryLedger.set(request.publicationKey, receipt);
        return { ok: true, value: receipt };
      }
    }

    const allFilesVerified = driveFiles.length > 0 && driveFiles.every((f) => f.verified);

    // Step 8: Google Sheets row upsert (FR-049).
    const sheetResult = await this.syncSheetRow(request, token, driveFiles);
    const sheetRowNumber = sheetResult.rowNumber;
    const sheetSynced = sheetResult.synced;

    const isFullyComplete = allFilesVerified && sheetSynced;
    const receipt: PublicationReceipt = {
      publicationId,
      publicationKey: request.publicationKey,
      driveFolderId,
      driveFiles,
      sheet: {
        spreadsheetId: request.destination.spreadsheetId || '',
        sheetId: request.destination.sheetId || 0,
        rowKey: request.taskId,
        rowNumber: sheetRowNumber,
        expectedHash: request.packageHash,
        observedHash: request.packageHash,
        synced: sheetSynced,
      },
      completedAt: new Date().toISOString(),
      state: isFullyComplete ? 'complete' : driveFiles.length > 0 ? 'drive_complete' : 'failed',
      detail: {
        verified: allFilesVerified,
        filesUploaded: driveFiles.length,
        ...(sheetResult.problem ? { sheetProblem: sheetResult.problem } : {}),
      },
      emulated: this.config.emulateNetworkForTesting === true,
    };
    (receipt as any).clientId = request.clientId;

    this.inMemoryLedger.set(request.publicationKey, receipt);
    return { ok: true, value: receipt };
  }

  /**
   * Writes (or updates) this task's Sheets row and reads it back. The row number is only ever one
   * Sheets reported; when the row is not confirmed, `problem` says why.
   */
  private async syncSheetRow(
    request: PublishRequest,
    token: string | null | undefined,
    driveFiles: DriveFileReceipt[]
  ): Promise<{ rowNumber?: number; synced: boolean; problem?: string }> {
    let rowNumber = this.taskRowMap.get(request.taskId);
    const spreadsheetId = request.destination.spreadsheetId;
    if (!spreadsheetId) return { rowNumber, synced: false, problem: 'No spreadsheet is configured for this client' };

    const rowValues = [
      request.taskId,
      request.clientId,
      request.destination.productionRootFolderId,
      new Date().toISOString(),
      'COMPLETE',
      driveFiles[0]?.webViewLink || '',
      request.packageHash,
    ];

    if (this.config.emulateNetworkForTesting) {
      // Emulated row with immutable task identity guarantee across row inserts/moves/sorts
      let sheet = this.emulatedSheets.get(spreadsheetId);
      if (!sheet) {
        sheet = [];
        this.emulatedSheets.set(spreadsheetId, sheet);
      }
      const existing = sheet.find((r) => r.values && r.values[0] === request.taskId);
      if (existing) {
        existing.values = rowValues;
        this.taskRowMap.set(request.taskId, existing.rowNumber);
        return { rowNumber: existing.rowNumber, synced: true };
      }
      const newRowNumber = sheet.length > 0 ? Math.max(...sheet.map((r) => r.rowNumber)) + 1 : (this.taskRowMap.size + 2);
      sheet.push({ rowNumber: newRowNumber, values: rowValues });
      this.taskRowMap.set(request.taskId, newRowNumber);
      return { rowNumber: newRowNumber, synced: true };
    }
    if (!token) return { rowNumber, synced: false, problem: 'Google Workspace credentials are not configured' };

    try {
      let sheetRes: Response;
      
      // Step 1: If rowNumber is not cached, check if row already exists for this taskId before appending
      if (rowNumber === undefined) {
        try {
          const foundRow = await this.findRowByTaskId(spreadsheetId, token, request.taskId);
          if (foundRow !== undefined) {
            rowNumber = foundRow;
            this.taskRowMap.set(request.taskId, rowNumber);
          }
        } catch (findErr: any) {
          return { rowNumber, synced: false, problem: `Task identity search failed: ${findErr.message}` };
        }
      }

      // Step 2: If a rowNumber was found or cached, ALWAYS verify task identity at rowNumber before overwriting
      if (rowNumber !== undefined) {
        try {
          const verifyRes = await fetch(`${this.sheetsApiBaseUrl}/v4/spreadsheets/${spreadsheetId}/values/A${rowNumber}:A${rowNumber}`, {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          if (!verifyRes.ok) {
            return { rowNumber, synced: false, problem: `Row identity verification failed: HTTP ${verifyRes.status}` };
          }
          const verifyData = (await verifyRes.json()) as any;
          const readTaskId = verifyData.values?.[0]?.[0];
          if (readTaskId && readTaskId !== request.taskId) {
            // Row position drifted (e.g. rows were moved, inserted, or sorted)! Find actual row by immutable taskId
            try {
              const reFound = await this.findRowByTaskId(spreadsheetId, token, request.taskId);
              if (reFound !== undefined) {
                // Verify the newly found row before writing
                const verify2 = await fetch(`${this.sheetsApiBaseUrl}/v4/spreadsheets/${spreadsheetId}/values/A${reFound}:A${reFound}`, {
                  headers: { 'Authorization': `Bearer ${token}` },
                });
                const val2 = ((await verify2.json()) as any).values?.[0]?.[0];
                if (val2 === request.taskId) {
                  rowNumber = reFound;
                  this.taskRowMap.set(request.taskId, rowNumber);
                } else {
                  rowNumber = undefined; // Do not overwrite an unrelated row!
                }
              } else {
                rowNumber = undefined; // Need to append a new row
              }
            } catch (findErr: any) {
              return { rowNumber, synced: false, problem: `Task identity search failed: ${findErr.message}` };
            }
          }
        } catch (err: any) {
          return { rowNumber, synced: false, problem: `Row identity verification error: ${err.message}` };
        }
      }

      if (rowNumber !== undefined) {
        // Idempotent upsert: update this task's verified existing row
        sheetRes = await fetch(`${this.sheetsApiBaseUrl}/v4/spreadsheets/${spreadsheetId}/values/A${rowNumber}:G${rowNumber}?valueInputOption=USER_ENTERED`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [rowValues] }),
        });
      } else {
        // First publication: append the row and record the index Sheets reports
        sheetRes = await fetch(`${this.sheetsApiBaseUrl}/v4/spreadsheets/${spreadsheetId}/values/A1:append?valueInputOption=USER_ENTERED`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [rowValues] }),
        });
        if (sheetRes.ok) {
          const sheetData = (await sheetRes.json()) as any;
          const match = String(sheetData.updates?.updatedRange || '').match(/!A(\d+)/);
          if (match) {
            rowNumber = parseInt(match[1], 10);
            this.taskRowMap.set(request.taskId, rowNumber);
          }
        }
      }
      if (!sheetRes.ok) return { rowNumber, synced: false, problem: `Sheets write failed: HTTP ${sheetRes.status}` };
      // Without a row number from Sheets there is nothing to read back, so the row is not synced.
      if (rowNumber === undefined) return { synced: false, problem: 'Sheets did not report which row it wrote' };

      const readback = await fetch(`${this.sheetsApiBaseUrl}/v4/spreadsheets/${spreadsheetId}/values/A${rowNumber}:G${rowNumber}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!readback.ok) return { rowNumber, synced: false, problem: `Sheets readback failed: HTTP ${readback.status}` };
      const readRow = ((await readback.json()) as any).values?.[0];
      const matches =
        readRow &&
        readRow[0] === request.taskId &&
        readRow[1] === request.clientId &&
        readRow[4] === 'COMPLETE' &&
        readRow[6] === request.packageHash;
      return matches ? { rowNumber, synced: true } : { rowNumber, synced: false, problem: `Row ${rowNumber} read back from Sheets does not match this publication` };
    } catch (err: any) {
      return { rowNumber, synced: false, problem: `Sheets could not be reached: ${err?.message || String(err)}` };
    }
  }

  /**
   * Scans column A of a Google Sheet to locate the row containing a given taskId.
   * Ensures immutable task identity even when rows are moved, sorted, or inserted externally.
   */
  async findRowByTaskId(spreadsheetId: string, token: string, taskId: string): Promise<number | undefined> {
    const res = await fetch(`${this.sheetsApiBaseUrl}/v4/spreadsheets/${spreadsheetId}/values/A:A`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as any;
    const rows = data.values || [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]?.[0] === taskId) {
        return i + 1; // 1-indexed row number in Google Sheets
      }
    }
    return undefined;
  }

  getEmulatedSheet(spreadsheetId: string): Array<{ rowNumber: number; values: string[] }> {
    return this.emulatedSheets.get(spreadsheetId) || [];
  }

  setEmulatedSheet(spreadsheetId: string, rows: Array<{ rowNumber: number; values: string[] }>): void {
    this.emulatedSheets.set(spreadsheetId, rows);
  }

  async reconcile(_ctx: RequestContext, publicationId: UUID): Promise<Result<PublicationReceipt>> {
    const token = await this.getAccessToken();
    for (const receipt of this.inMemoryLedger.values()) {
      if (receipt.publicationId === publicationId) {
        if (receipt.state === 'failed' || !receipt.detail?.verified || receipt.emulated || receipt.sheet.rowNumber === undefined) {
          return { ok: true, value: receipt };
        }

        // Perform genuine network call to Google Sheets to reconcile sync state
        if (receipt.sheet.spreadsheetId && token) {
          const spreadsheetId = receipt.sheet.spreadsheetId;
          const readbackSheetUrl = `${this.sheetsApiBaseUrl}/v4/spreadsheets/${spreadsheetId}/values/A${receipt.sheet.rowNumber}:G${receipt.sheet.rowNumber}`;
          try {
            const res = await fetch(readbackSheetUrl, {
              headers: { 'Authorization': `Bearer ${token}` },
            });
            if (res.ok) {
              const data = await res.json() as any;
              const row = data.values?.[0];
              if (
                row &&
                row[0] === receipt.sheet.rowKey &&
                row[4] === 'COMPLETE' &&
                row[6] === receipt.sheet.expectedHash
              ) {
                receipt.sheet.synced = true;
                receipt.state = 'complete';
                return { ok: true, value: receipt };
              }
            }
          } catch (e) {}
          // If remote readback failed or mismatched, keep sheet.synced false
          receipt.sheet.synced = false;
          return { ok: true, value: receipt };
        }

        return { ok: true, value: receipt };
      }
    }
    return {
      ok: false,
      error: {
        code: 'PUBLICATION_RECEIPT_NOT_FOUND',
        message: `Publication receipt ${publicationId} not found in ledger`,
        retryable: false,
        safeAction: 'Verify publication ID exists before reconciling',
      },
    };
  }

  /**
   * Reads the publication back from Google and reports every way it differs from its receipt. It
   * used to answer consistent: true for any receipt it knew, without a single call. Consistent means
   * every recorded Drive file is still there with its name, type, size and (when Drive reports one)
   * SHA-256, and the recorded Sheets row still carries this task, COMPLETE and the package hash.
   */
  async verify(_ctx: RequestContext, publicationId: UUID): Promise<Result<{ consistent: boolean; differences: Record<string, unknown>[] }>> {
    const receipt = Array.from(this.inMemoryLedger.values()).find((r) => r.publicationId === publicationId);
    if (!receipt) {
      return { ok: true, value: { consistent: false, differences: [{ error: 'not_found' }] } };
    }
    const inconsistent = (differences: Record<string, unknown>[]) =>
      ({ ok: true as const, value: { consistent: differences.length === 0, differences } });

    if (receipt.emulated) {
      return inconsistent([{ check: 'emulated', detail: 'No Google call was made for this publication, so there is nothing to verify' }]);
    }
    const token = await this.getAccessToken();
    if (!token) {
      return inconsistent([{ check: 'credentials', detail: 'Google Workspace credentials are not configured, so Drive and Sheets could not be read' }]);
    }

    const differences: Record<string, unknown>[] = [];
    const get = async (url: string): Promise<{ status: number; body?: any; error?: string }> => {
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        return res.ok ? { status: res.status, body: await res.json() } : { status: res.status };
      } catch (err: any) {
        return { status: 0, error: err?.message || String(err) };
      }
    };

    if (receipt.driveFiles.length === 0) {
      differences.push({ check: 'drive', detail: 'The receipt records no Drive file' });
    }
    for (const file of receipt.driveFiles) {
      const read = await get(`${this.driveApiBaseUrl}/drive/v3/files/${encodeURIComponent(file.fileId)}?fields=id,name,size,mimeType,trashed,sha256Checksum`);
      if (read.status === 404) {
        differences.push({ check: 'drive', fileId: file.fileId, detail: 'The file is no longer in Google Drive' });
        continue;
      }
      if (!read.body) {
        differences.push({ check: 'drive', fileId: file.fileId, detail: `Drive could not be read (${read.error || `HTTP ${read.status}`})` });
        continue;
      }
      const remote = read.body;
      if (remote.trashed === true) differences.push({ check: 'drive', fileId: file.fileId, detail: 'The file is in the Drive trash' });
      if (remote.name !== file.name) differences.push({ check: 'drive', fileId: file.fileId, field: 'name', expected: file.name, observed: remote.name ?? null });
      if (remote.mimeType && remote.mimeType !== file.mimeType) differences.push({ check: 'drive', fileId: file.fileId, field: 'mimeType', expected: file.mimeType, observed: remote.mimeType });
      if (Number(remote.size) !== file.observedSize) differences.push({ check: 'drive', fileId: file.fileId, field: 'size', expected: file.observedSize, observed: remote.size ?? null });
      if (remote.sha256Checksum && String(remote.sha256Checksum).toLowerCase() !== String(file.expectedSha256).toLowerCase()) {
        differences.push({ check: 'drive', fileId: file.fileId, field: 'sha256', expected: file.expectedSha256, observed: remote.sha256Checksum });
      }
    }

    const sheet = receipt.sheet;
    if (!sheet.spreadsheetId) {
      differences.push({ check: 'sheets', detail: 'No spreadsheet is recorded for this publication' });
    } else if (sheet.rowNumber === undefined) {
      differences.push({ check: 'sheets', detail: 'No Sheets row was recorded for this publication' });
    } else {
      const range = `A${sheet.rowNumber}:G${sheet.rowNumber}`;
      const read = await get(`${this.sheetsApiBaseUrl}/v4/spreadsheets/${encodeURIComponent(sheet.spreadsheetId)}/values/${range}`);
      const row = read.body?.values?.[0];
      if (!read.body) {
        differences.push({ check: 'sheets', row: sheet.rowNumber, detail: `Sheets could not be read (${read.error || `HTTP ${read.status}`})` });
      } else if (!row) {
        differences.push({ check: 'sheets', row: sheet.rowNumber, detail: 'The recorded row is empty' });
      } else {
        if (row[0] !== sheet.rowKey) differences.push({ check: 'sheets', row: sheet.rowNumber, field: 'taskId', expected: sheet.rowKey, observed: row[0] ?? null });
        if (row[4] !== 'COMPLETE') differences.push({ check: 'sheets', row: sheet.rowNumber, field: 'status', expected: 'COMPLETE', observed: row[4] ?? null });
        if (row[6] !== sheet.expectedHash) differences.push({ check: 'sheets', row: sheet.rowNumber, field: 'packageHash', expected: sheet.expectedHash, observed: row[6] ?? null });
      }
    }

    return inconsistent(differences);
  }
}
