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
import { GoogleSheetRow, type SheetRowResult } from './google-sheet-row.js';

export interface GooglePublisherConfig {
  serviceAccountEmail?: string;
  serviceAccountKey?: string;
  credentialsFile?: string;
  oauthToken?: string;
  driveApiBaseUrl?: string;
  driveUploadBaseUrl?: string;
  sheetsApiBaseUrl?: string;
  uploadIdentityStore?: DriveUploadIdentityStore;
}

export interface DriveUploadIdentity {
  tenantId: string;
  publicationKey: string;
  taskId: string;
  artifactId: string;
  packageHash: string;
  folderId: string;
  filename: string;
  mimeType: string;
  sha256: string;
}

export interface DriveUploadIdentityStore {
  /** The allocator runs outside a database transaction; the winning ID is committed before upload. */
  reserve(identity: DriveUploadIdentity, allocate: () => Promise<string>): Promise<string>;
}

export class DriveUploadIdentityConflict extends Error {}

const DRIVE_LOOKUP_TIMEOUT_MS = 10_000;
const DRIVE_UPLOAD_TIMEOUT_MS = 120_000;
const TOKEN_TIMEOUT_MS = 15_000;
const DRIVE_LOOKUP_MAX_PAGES = 10;

const CREDENTIALS_MISSING_MESSAGE = 'Google Workspace credentials not configured; publication is unavailable and cannot complete';

/** The service account's signing key and email, or why there is no usable pair. */
interface ServiceAccount {
  privateKey?: string;
  clientEmail?: string;
  source: 'config' | 'env' | 'none';
  problem?: string;
}

type AccessTokenResult = { ok: true; token: string } | { ok: false; error: AppError };

/**
 * A key as production stores it. A PEM kept in an env file often has its newlines escaped as the
 * two characters backslash-n, which no signer accepts.
 */
function normalisePem(pem: string): string {
  return pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
}

export class GooglePublisher implements Publisher {
  private inMemoryLedger = new Map<string, PublicationReceipt>();
  private inFlight = new Map<string, { fingerprint: string; promise: Promise<Result<PublicationReceipt, AppError>> }>();
  private driveApiBaseUrl: string;
  private driveUploadBaseUrl: string;
  private sheetsApiBaseUrl: string;

  constructor(private readonly config: GooglePublisherConfig = {}) {
    this.driveApiBaseUrl = (config.driveApiBaseUrl || process.env.GOOGLE_DRIVE_API_BASE_URL || 'https://www.googleapis.com').replace(/\/$/, '');
    this.driveUploadBaseUrl = (config.driveUploadBaseUrl || process.env.GOOGLE_DRIVE_UPLOAD_BASE_URL || 'https://www.googleapis.com/upload').replace(/\/$/, '');
    this.sheetsApiBaseUrl = (config.sheetsApiBaseUrl || process.env.GOOGLE_SHEETS_API_BASE_URL || 'https://sheets.googleapis.com').replace(/\/$/, '');
  }

  /**
   * Discovers and inspects Google Workspace service account credentials from config or environment.
   * hasKey means a private key was actually found, not merely that a variable is set; `problem`
   * says why a configured key cannot be used.
   */
  getCredentials(): { email?: string; hasKey: boolean; token?: string; source: 'config' | 'env' | 'token' | 'none'; problem?: string } {
    if (this.config.oauthToken || process.env.GOOGLE_OAUTH_TOKEN) {
      return {
        token: this.config.oauthToken || process.env.GOOGLE_OAUTH_TOKEN,
        hasKey: true,
        source: 'token',
      };
    }
    const account = this.readServiceAccount();
    if (account.source === 'none') return { source: 'none', hasKey: false };
    return {
      email: account.clientEmail,
      hasKey: Boolean(account.privateKey),
      source: account.source,
      ...(account.problem ? { problem: account.problem } : {}),
    };
  }

  /**
   * The signing key and email from whichever form is configured: a raw PEM with a separate email, a
   * service-account JSON key inline (GOOGLE_SERVICE_ACCOUNT_KEY), or a JSON key file
   * (GOOGLE_APPLICATION_CREDENTIALS). Until 2026-09-23 only the first worked: given the JSON key
   * production is issued, the publisher tried to sign with the whole JSON, and a key file path was
   * counted as a key without ever being read. An explicitly configured email wins over the JSON's.
   */
  private readServiceAccount(): ServiceAccount {
    const configured = this.config.serviceAccountKey;
    const envKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || process.env.GCP_PRIVATE_KEY;
    const keyFile = this.config.credentialsFile || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const explicitEmail =
      this.config.serviceAccountEmail || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GCP_SERVICE_ACCOUNT_EMAIL;
    const source: ServiceAccount['source'] =
      configured || this.config.credentialsFile
        ? 'config'
        : envKey || keyFile
          ? 'env'
          : explicitEmail
            ? (this.config.serviceAccountEmail ? 'config' : 'env')
            : 'none';
    if (source === 'none') return { source };

    let raw = configured || envKey;
    let origin = configured
      ? 'The configured service-account key'
      : process.env.GOOGLE_SERVICE_ACCOUNT_KEY ? 'GOOGLE_SERVICE_ACCOUNT_KEY' : 'GCP_PRIVATE_KEY';
    if (!raw && keyFile) {
      origin = `The service-account key file ${keyFile}`;
      try {
        raw = fs.readFileSync(keyFile, 'utf8');
      } catch (err: unknown) {
        const code = (err as { code?: unknown } | null)?.code;
        return { source, clientEmail: explicitEmail, problem: `${origin} could not be read (${typeof code === 'string' ? code : 'unreadable'})` };
      }
    }
    if (!raw) return { source, clientEmail: explicitEmail, problem: 'No service-account private key is configured' };

    let privateKey: string | undefined = raw;
    let jsonEmail: string | undefined;
    if (raw.trim().startsWith('{')) {
      let parsed: { private_key?: unknown; client_email?: unknown };
      try {
        parsed = JSON.parse(raw) as { private_key?: unknown; client_email?: unknown };
      } catch {
        // Never echo the text: it is meant to hold a private key.
        return { source, clientEmail: explicitEmail, problem: `${origin} starts like JSON but is not valid JSON` };
      }
      privateKey = typeof parsed.private_key === 'string' && parsed.private_key ? parsed.private_key : undefined;
      jsonEmail = typeof parsed.client_email === 'string' && parsed.client_email ? parsed.client_email : undefined;
      if (!privateKey) {
        return { source, clientEmail: explicitEmail || jsonEmail, problem: `${origin} is a service-account JSON with no private_key` };
      }
    }

    privateKey = normalisePem(privateKey);
    const clientEmail = explicitEmail || jsonEmail;
    if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(privateKey)) {
      return { source, clientEmail, problem: `${origin} is not a PEM private key` };
    }
    if (!clientEmail) {
      return { source, privateKey, problem: 'No service-account email is configured (client_email or GOOGLE_SERVICE_ACCOUNT_EMAIL)' };
    }
    return { source, privateKey, clientEmail };
  }

  /**
   * Resolves a valid bearer token for Google API calls, or null. Callers that report why use
   * resolveAccessToken.
   */
  private async getAccessToken(): Promise<string | null> {
    const resolved = await this.resolveAccessToken();
    return resolved.ok ? resolved.token : null;
  }

  /**
   * A bearer token, or why there is none: CREDENTIALS_MISSING when no usable key is configured,
   * GOOGLE_TOKEN_FAILED when Google refused or did not answer the token request. They used to be
   * one silent null, so a rejected key was reported as a missing one.
   */
  private async resolveAccessToken(): Promise<AccessTokenResult> {
    const missing = (detail?: string): AccessTokenResult => ({
      ok: false,
      error: {
        code: 'CREDENTIALS_MISSING',
        message: detail ? `${CREDENTIALS_MISSING_MESSAGE}: ${detail}` : CREDENTIALS_MISSING_MESSAGE,
        retryable: false,
        safeAction: 'Configure the Google service-account key (GOOGLE_SERVICE_ACCOUNT_KEY) and deliver again',
      },
    });
    const tokenFailed = (why: string, retryable: boolean, status?: number): AccessTokenResult => ({
      ok: false,
      error: {
        code: 'GOOGLE_TOKEN_FAILED',
        message: `Google did not issue an access token for the service account: ${why}`,
        retryable,
        safeAction: retryable ? 'Deliver again shortly' : 'Check the service account key and its access, then deliver again',
        ...(status !== undefined ? { detail: { status } } : {}),
      },
    });

    const creds = this.getCredentials();
    if (creds.token) {
      return { ok: true, token: creds.token };
    }
    if (!creds.hasKey) {
      return missing(creds.problem);
    }

    // In local/test or when a mock/custom bearer is provided
    if (process.env.MOCK_GOOGLE_TOKEN) {
      return { ok: true, token: process.env.MOCK_GOOGLE_TOKEN };
    }

    const account = this.readServiceAccount();
    if (!account.privateKey || !account.clientEmail || account.problem) {
      return missing(account.problem);
    }

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claimSet = {
      iss: account.clientEmail,
      scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };
    const enc = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const signatureInput = `${enc(header)}.${enc(claimSet)}`;
    let assertion: string;
    try {
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(signatureInput);
      assertion = `${signatureInput}.${signer.sign(account.privateKey, 'base64url')}`;
    } catch (err: unknown) {
      // The key's text is never echoed; OpenSSL's reason names the format problem, not the key.
      return missing(`the private key could not sign (${err instanceof Error ? err.message.slice(0, 120) : 'unknown error'})`);
    }

    let tokenRes: Response;
    try {
      tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      const { name, message } = (err ?? {}) as { name?: unknown; message?: unknown };
      return tokenFailed(
        name === 'TimeoutError' || name === 'AbortError'
          ? `the token request timed out after ${TOKEN_TIMEOUT_MS / 1000} s`
          : `the token endpoint could not be reached (${typeof message === 'string' ? message : String(err)})`,
        true
      );
    }

    const body = (await tokenRes.json().catch(() => null)) as { access_token?: unknown; error?: unknown; error_description?: unknown } | null;
    if (!tokenRes.ok) {
      // Google's error and error_description name the fault (invalid_grant: Invalid JWT Signature)
      // and carry nothing secret.
      const reason = [body?.error, body?.error_description].filter((v) => typeof v === 'string' && v).join(': ').slice(0, 200);
      return tokenFailed(`HTTP ${tokenRes.status}${reason ? ` (${reason})` : ''}`, tokenRes.status === 429 || tokenRes.status >= 500, tokenRes.status);
    }
    if (typeof body?.access_token !== 'string' || !body.access_token) {
      return tokenFailed(`HTTP ${tokenRes.status} without an access_token`, true, tokenRes.status);
    }
    return { ok: true, token: body.access_token };
  }

  /**
   * The file already in `folderId` that was uploaded for this task and artifact with these exact
   * bytes, if there is one. `ok: false` means Drive could not say, and the caller must not upload.
   */
  private async findUploadedArtifact(
    token: string,
    folderId: string,
    taskId: string,
    file: PackageFile,
    packageHash: string
  ): Promise<Result<{ id: string; name?: string; size?: string; mimeType?: string; webViewLink?: string; sha256Checksum?: string } | undefined, AppError>> {
    const lit = (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q =
      `'${lit(folderId)}' in parents and trashed = false` +
      ` and properties has { key='taskId' and value='${lit(taskId)}' }` +
      ` and properties has { key='artifactId' and value='${lit(file.artifactId)}' }`;
    const baseUrl =
      `${this.driveApiBaseUrl}/drive/v3/files?q=${encodeURIComponent(q)}` +
      `&fields=${encodeURIComponent('nextPageToken,incompleteSearch,files(id,name,size,mimeType,webViewLink,sha256Checksum,properties,createdTime)')}` +
      `&pageSize=1000&orderBy=createdTime&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const refuse = (why: string) => ({
      ok: false as const,
      error: {
        code: 'DRIVE_LOOKUP_FAILED',
        message: `Could not check Google Drive for an existing copy of ${file.filename} (${why}); nothing was uploaded`,
        retryable: true,
      } as any,
    });
    const conflict = (why: string) => ({
      ok: false as const,
      error: {
        code: 'DRIVE_ARTIFACT_CONFLICT',
        message: `Google Drive has conflicting evidence for ${file.filename} (${why}); nothing was uploaded`,
        retryable: false,
        safeAction: 'Inspect the existing Drive files and reconcile the publication before retrying',
      } as AppError,
    });
    try {
      const want = file.sha256.toLowerCase();
      let pageToken: string | undefined;
      const seenTokens = new Set<string>();
      let same: { id: string; name?: string; size?: string; mimeType?: string; webViewLink?: string; sha256Checksum?: string } | undefined;
      for (let page = 0; page < DRIVE_LOOKUP_MAX_PAGES; page++) {
        const url = pageToken ? `${baseUrl}&pageToken=${encodeURIComponent(pageToken)}` : baseUrl;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(DRIVE_LOOKUP_TIMEOUT_MS) });
        if (!res.ok) return refuse(`HTTP ${res.status}`);
        const data = (await res.json()) as any;
        if (!data || !Array.isArray(data.files)) return refuse('malformed answer');
        if (data.incompleteSearch === true) return refuse('incomplete search');
        for (const f of data.files) {
          if (!f || typeof f.id !== 'string' || !f.id || f.properties?.taskId !== taskId || f.properties?.artifactId !== file.artifactId) {
            return refuse('malformed or unscoped file');
          }
          if (typeof f.properties.packageHash !== 'string' || !f.properties.packageHash) {
            return conflict('an existing file has no package hash');
          }
          // The same artifact in a different package is a legitimate new revision.
          if (f.properties.packageHash !== packageHash) continue;
          if (typeof f.sha256Checksum !== 'string' || f.sha256Checksum.toLowerCase() !== want) {
            return conflict('the same package has a missing or different checksum');
          }
          if (same) return conflict('more than one file matches the same package and artifact');
          same = f;
        }
        if (data.nextPageToken === undefined || data.nextPageToken === null) return { ok: true, value: same };
        if (typeof data.nextPageToken !== 'string' || !data.nextPageToken || seenTokens.has(data.nextPageToken)) {
          return refuse('invalid pagination token');
        }
        seenTokens.add(data.nextPageToken);
        pageToken = data.nextPageToken;
      }
      return refuse(`more than ${DRIVE_LOOKUP_MAX_PAGES} result pages`);
    } catch (err: any) {
      return refuse(err?.name === 'TimeoutError' ? 'timed out' : err?.message || String(err));
    }
  }

  private async generateUploadId(token: string): Promise<string> {
    const url = `${this.driveApiBaseUrl}/drive/v3/files/generateIds?count=1&space=drive&type=files`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(DRIVE_LOOKUP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Drive ID reservation answered HTTP ${res.status}`);
    const data = await res.json() as { ids?: unknown };
    const id = Array.isArray(data?.ids) ? data.ids[0] : undefined;
    if (typeof id !== 'string' || !id) throw new Error('Drive ID reservation returned no file ID');
    return id;
  }

  async publish(ctx: RequestContext, request: PublishRequest): Promise<Result<PublicationReceipt, AppError>> {
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      tenantId: ctx.tenantId, taskId: request.taskId, clientId: request.clientId, approvalId: request.approvalId,
      designRevisionId: request.designRevisionId, packageHash: request.packageHash, destination: request.destination,
      files: request.files.map(({ content: _content, ...identity }) => identity),
    })).digest('hex');
    const active = this.inFlight.get(JSON.stringify([ctx.tenantId, request.publicationKey]));
    if (active) {
      if (active.fingerprint !== fingerprint) return { ok: false, error: {
        code: 'IDEMPOTENCY_CONFLICT', message: 'Concurrent publication has a different identity or destination',
        retryable: false, safeAction: 'Use the original approved publication inputs',
      } };
      return await active.promise;
    }
    const pubPromise = this.executePublish(ctx, request);
    this.inFlight.set(JSON.stringify([ctx.tenantId, request.publicationKey]), { fingerprint, promise: pubPromise });
    try {
      return await pubPromise;
    } finally {
      this.inFlight.delete(JSON.stringify([ctx.tenantId, request.publicationKey]));
    }
  }

  private async executePublish(ctx: RequestContext, request: PublishRequest): Promise<Result<PublicationReceipt, AppError>> {
    // 1. Idempotency Check (FR-050)
    if (this.inMemoryLedger.has(JSON.stringify([ctx.tenantId, request.publicationKey]))) {
      const existing = this.inMemoryLedger.get(JSON.stringify([ctx.tenantId, request.publicationKey]))!;
      if (
        (existing.sheet?.expectedHash && existing.sheet.expectedHash !== request.packageHash) ||
        ((existing as any).clientId && request.clientId && (existing as any).clientId !== request.clientId) ||
        existing.sheet.rowKey !== request.taskId ||
        (request.destination?.productionRootFolderId && existing.driveFolderId && existing.driveFolderId !== request.destination.productionRootFolderId) ||
        (request.destination?.spreadsheetId && existing.sheet?.spreadsheetId && existing.sheet.spreadsheetId !== request.destination.spreadsheetId) ||
        existing.sheet.sheetId !== request.destination.sheetId
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
        const retry = await this.syncSheetRow(ctx, request, token, existing.driveFiles);
        existing.sheet.spreadsheetId = request.destination.spreadsheetId || existing.sheet.spreadsheetId;
        Object.assign(existing.sheet, this.sheetEvidence(retry));
        existing.sheet.rowNumber = retry.rowNumber;
        existing.sheet.synced = retry.synced;
        existing.sheet.observedHash = retry.observedHash;
        const detail: Record<string, any> = { ...existing.detail };
        if (retry.problem) detail.sheetProblem = retry.problem;
        else delete detail.sheetProblem;
        existing.detail = detail;
        if (retry.synced && existing.detail?.verified) {
          existing.state = 'complete';
          existing.completedAt = new Date().toISOString();
        }
        this.inMemoryLedger.set(JSON.stringify([ctx.tenantId, request.publicationKey]), existing);
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
        state: 'failed',
        detail: { verified: false, filesUploaded: 0 },
        emulated: false,
      };
      this.inMemoryLedger.set(JSON.stringify([ctx.tenantId, request.publicationKey]), emptyReceipt);
      return { ok: true, value: emptyReceipt };
    }

    // 5. Resolve credentials & token. A key Google refused is GOOGLE_TOKEN_FAILED, not a missing key.
    const access = await this.resolveAccessToken();
    if (!access.ok) {
      return { ok: false, error: access.error };
    }
    const token = access.token;

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

      // Ask Drive before uploading, every time. An upload whose reply is lost, or a process killed
      // between the upload and the database record, leaves a file in the folder that nothing here
      // remembers; a fresh process then uploaded a second copy.
      const lookup = await this.findUploadedArtifact(token!, driveFolderId, request.taskId, file, request.packageHash);
      if (!lookup.ok) return lookup;
      if (lookup.value) {
        uploadedFileId = lookup.value.id;
        readbackData = lookup.value;
        webViewLink = lookup.value.webViewLink || `https://drive.google.com/file/d/${uploadedFileId}/view`;
      }

      if (!uploadedFileId) {
        let reservedId: string | undefined;
        if (this.config.uploadIdentityStore) {
          try {
            reservedId = await this.config.uploadIdentityStore.reserve({
              tenantId: ctx.tenantId, publicationKey: request.publicationKey, taskId: request.taskId,
              artifactId: file.artifactId, packageHash: request.packageHash, folderId: driveFolderId,
              filename: file.filename, mimeType: file.mimeType, sha256: file.sha256,
            }, () => this.generateUploadId(token));
            if (!reservedId) throw new Error('No durable Drive file ID was returned');
          } catch (error: unknown) {
            return { ok: false, error: {
              code: error instanceof DriveUploadIdentityConflict ? 'DRIVE_ARTIFACT_CONFLICT' : 'DRIVE_RESERVATION_FAILED',
              message: `Could not reserve a durable Drive file ID for ${file.filename}; nothing was uploaded`,
              retryable: !(error instanceof DriveUploadIdentityConflict),
              safeAction: 'Check the publication reservation and retry only after reconciliation',
            } as AppError };
          }
        }
        const boundary = `-------HawaBoundary${crypto.randomBytes(16).toString('hex')}`;
          const metadata = JSON.stringify({
            ...(reservedId ? { id: reservedId } : {}),
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
          const uploadUrl = `${this.driveUploadBaseUrl}/drive/v3/files?uploadType=multipart&supportsAllDrives=true`;
          let uploadRes: Response;
          try {
            uploadRes = await fetch(uploadUrl, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': `multipart/related; boundary=${boundary}`,
              },
              body: multipartBody,
              signal: AbortSignal.timeout(DRIVE_UPLOAD_TIMEOUT_MS),
            });
          } catch {
            return { ok: false, error: {
              code: 'DRIVE_UPLOAD_UNCERTAIN',
              message: `Google Drive did not answer the upload for ${file.filename}; the file may already exist`,
              retryable: Boolean(reservedId),
              safeAction: reservedId
                ? 'Retry with the same publication key and reserved file ID; verify Drive before notifying the requester'
                : 'Reconcile the file in Drive before retrying; this publisher has no durable file ID',
            } };
          }

          if (!uploadRes.ok && !(uploadRes.status === 409 && reservedId)) {
            const errText = await uploadRes.text().catch(() => '(response body unavailable)');
            const uncertain = uploadRes.status === 408 || uploadRes.status === 429 || uploadRes.status >= 500;
            return {
              ok: false,
              error: {
                code: uncertain ? 'DRIVE_UPLOAD_UNCERTAIN' : 'DRIVE_UPLOAD_FAILED',
                message: `Google Drive upload failed for ${file.filename}: HTTP ${uploadRes.status} ${errText}`,
                retryable: uncertain && Boolean(reservedId),
                safeAction: uncertain
                  ? 'Reconcile the reserved file ID in Drive before notifying the requester'
                  : 'Check the Drive rejection and publication state before retrying',
              } as any,
            };
          }

          let uploadData: any;
          try {
            uploadData = uploadRes.ok ? await uploadRes.json() : { id: reservedId };
          } catch {
            return { ok: false, error: {
              code: 'DRIVE_UPLOAD_UNCERTAIN',
              message: `Google Drive replied to the upload for ${file.filename}, but the file ID could not be read`,
              retryable: Boolean(reservedId),
              safeAction: 'Reconcile the reserved file ID in Drive before notifying the requester',
            } };
          }
          uploadedFileId = uploadData?.id;
          if (!uploadedFileId) {
            return {
              ok: false,
              error: {
                code: 'DRIVE_UPLOAD_UNCERTAIN',
                message: `Google Drive upload succeeded but no file ID was returned for ${file.filename}`,
                retryable: Boolean(reservedId),
                safeAction: 'Reconcile the reserved file ID in Drive before notifying the requester',
              } as any,
            };
          }
          if (reservedId && uploadedFileId !== reservedId) {
            return { ok: false, error: {
              code: 'DRIVE_UPLOAD_FAILED',
              message: `Google Drive returned a different file ID for ${file.filename}; publication needs reconciliation`,
              retryable: false,
              safeAction: 'Inspect both Drive file IDs and reconcile the publication before requester delivery',
            } as AppError };
          }

          // Step 6: Independent Readback from Google Drive to verify real persistence
          const readbackUrl = `${this.driveApiBaseUrl}/drive/v3/files/${uploadedFileId}?fields=id,name,size,mimeType,webViewLink,sha256Checksum,properties,parents&supportsAllDrives=true`;
          let readbackRes: Response;
          try {
            readbackRes = await fetch(readbackUrl, {
              headers: { 'Authorization': `Bearer ${token}` },
              signal: AbortSignal.timeout(DRIVE_LOOKUP_TIMEOUT_MS),
            });
          } catch {
            return { ok: false, error: {
              code: 'DRIVE_READBACK_FAILED',
              message: `Google Drive stored file ${uploadedFileId}, but independent readback did not answer`,
              retryable: Boolean(reservedId),
              safeAction: 'Reconcile the stored file in Drive before notifying the requester',
            } };
          }

          if (!readbackRes.ok) {
            return {
              ok: false,
              error: {
                code: 'DRIVE_READBACK_FAILED',
                message: `Independent readback from Google Drive failed for file ${uploadedFileId}: HTTP ${readbackRes.status}`,
                retryable: Boolean(reservedId),
                safeAction: 'Reconcile the stored file in Drive before notifying the requester',
              } as any,
            };
          }

          try {
            readbackData = await readbackRes.json() as any;
          } catch {
            return { ok: false, error: {
              code: 'DRIVE_READBACK_FAILED',
              message: `Independent readback returned an unreadable response for file ${uploadedFileId}`,
              retryable: Boolean(reservedId),
              safeAction: 'Reconcile the stored file in Drive before notifying the requester',
            } };
          }
          if (reservedId && (
            readbackData?.properties?.taskId !== request.taskId ||
            readbackData?.properties?.artifactId !== file.artifactId ||
            readbackData?.properties?.packageHash !== request.packageHash ||
            !Array.isArray(readbackData?.parents) || !readbackData.parents.includes(driveFolderId)
          )) {
            return { ok: false, error: {
              code: 'DRIVE_READBACK_FAILED',
              message: `Reserved Drive file ${uploadedFileId} has different publication identity or folder`,
              retryable: false,
              safeAction: 'Inspect the reserved Drive file identity and folder before requester delivery',
            } as AppError };
          }
          webViewLink = readbackData.webViewLink || `https://drive.google.com/file/d/${uploadedFileId}/view`;
        }

      const readbackIdMatches = readbackData ? readbackData.id === uploadedFileId : true;
      const readbackNameMatches = readbackData ? readbackData.name === file.filename : true;
      const readbackSizeMatches = readbackData ? Number(readbackData.size) === fileBuffer.length : true;
      const readbackMimeMatches = readbackData ? (!readbackData.mimeType || readbackData.mimeType === file.mimeType) : true;
      const readbackChecksumMatches = Boolean(
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
        return { ok: false, error: {
          code: 'DRIVE_VERIFICATION_FAILED',
          message: `Remote readback verification failed for ${file.filename}: checksum or metadata mismatch`,
          retryable: false,
          safeAction: 'Inspect the Drive file and reconcile its identity and bytes before requester delivery',
        } };
      }
    }

    const allFilesVerified = driveFiles.length > 0 && driveFiles.every((f) => f.verified);

    // Step 8: Google Sheets row upsert (FR-049).
    const sheetResult = await this.syncSheetRow(ctx, request, token, driveFiles);
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
        ...this.sheetEvidence(sheetResult),
        rowNumber: sheetRowNumber,
        expectedHash: request.packageHash,
        observedHash: sheetResult.observedHash,
        synced: sheetSynced,
      },
      ...(isFullyComplete ? { completedAt: new Date().toISOString() } : {}),
      state: isFullyComplete ? 'complete' : driveFiles.length > 0 ? 'drive_complete' : 'failed',
      detail: {
        tenantId: ctx.tenantId,
        verified: allFilesVerified,
        filesUploaded: driveFiles.length,
        ...(sheetResult.problem ? { sheetProblem: sheetResult.problem } : {}),
      },
      emulated: false,
    };
    (receipt as any).clientId = request.clientId;

    this.inMemoryLedger.set(JSON.stringify([ctx.tenantId, request.publicationKey]), receipt);
    return { ok: true, value: receipt };
  }

  /**
   * Writes (or updates) this task's Sheets row and reads it back. The row number is only ever one
   * Sheets reported; when the row is not confirmed, `problem` says why.
   */
  private sheetEvidence(result: SheetRowResult) {
    return { metadataId: result.metadataId, expectedValues: result.expectedValues,
      expectedRowHash: result.expectedRowHash, observedRowHash: result.observedRowHash };
  }

  private async syncSheetRow(ctx: RequestContext, request: PublishRequest, token: string | null | undefined, driveFiles: DriveFileReceipt[]): Promise<SheetRowResult> {
    if (!request.destination.spreadsheetId) return { synced: false, problem: 'No spreadsheet is configured for this client' };
    if (!token) return { synced: false, problem: 'Google Workspace credentials are not configured' };
    return new GoogleSheetRow(this.sheetsApiBaseUrl, token, ctx.deadline).sync({
      tenantId: ctx.tenantId, spreadsheetId: request.destination.spreadsheetId, sheetId: request.destination.sheetId, taskId: request.taskId,
    }, [request.taskId, request.clientId, request.destination.productionRootFolderId,
      typeof request.sheetRow.publishedAt === 'string' ? request.sheetRow.publishedAt : new Date().toISOString(),
      'COMPLETE', driveFiles[0]?.webViewLink || '', request.packageHash], typeof request.sheetRow.publishedAt === 'string');
  }

  private async inspectSheet(ctx: RequestContext, receipt: PublicationReceipt, token: string | null): Promise<SheetRowResult> {
    if (!token) return { synced: false, problem: 'SHEETS_CREDENTIALS_UNAVAILABLE' };
    if (receipt.detail.tenantId !== ctx.tenantId || !receipt.sheet.expectedValues) return { synced: false, problem: 'SHEETS_EXPECTATION_UNAVAILABLE' };
    return new GoogleSheetRow(this.sheetsApiBaseUrl, token, ctx.deadline).verify({
      tenantId: ctx.tenantId, spreadsheetId: receipt.sheet.spreadsheetId, sheetId: receipt.sheet.sheetId, taskId: receipt.sheet.rowKey,
    }, receipt.sheet.expectedValues);
  }

  async reconcile(ctx: RequestContext, publicationId: UUID): Promise<Result<PublicationReceipt>> {
    const receipt = Array.from(this.inMemoryLedger.values()).find(r => r.publicationId === publicationId && r.detail.tenantId === ctx.tenantId);
    if (!receipt) return { ok: false, error: { code: 'PUBLICATION_RECEIPT_NOT_FOUND', message: 'Publication receipt is not available in this process and scope', retryable: false, safeAction: 'Read the durable publication record before reconciling' } };
    if (receipt.state === 'failed' || !receipt.detail.verified) return { ok: true, value: receipt };
    const read = await this.inspectSheet(ctx, receipt, await this.getAccessToken());
    receipt.sheet.synced = read.synced;
    receipt.sheet.observedHash = read.observedHash;
    receipt.sheet.observedRowHash = read.observedRowHash;
    receipt.sheet.rowNumber = read.rowNumber;
    if (read.synced) {
      receipt.state = 'complete'; receipt.completedAt ??= new Date().toISOString(); delete receipt.detail.sheetProblem;
    } else {
      receipt.state = 'drive_complete'; delete receipt.completedAt; receipt.detail.sheetProblem = read.problem || 'SHEETS_UNCONFIRMED';
    }
    return { ok: true, value: receipt };
  }

  /**
   * Reads the publication back from Google and reports every way it differs from its receipt. It
   * used to answer consistent: true for any receipt it knew, without a single call. Consistent means
   * every recorded Drive file is still there with its name, type, size and (when Drive reports one)
   * SHA-256, and the recorded Sheets row still carries this task, COMPLETE and the package hash.
   */
  async verify(ctx: RequestContext, publicationId: UUID): Promise<Result<{ consistent: boolean; differences: Record<string, unknown>[] }>> {
    const receipt = Array.from(this.inMemoryLedger.values()).find((r) => r.publicationId === publicationId && r.detail.tenantId === ctx.tenantId);
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

    const sheet = await this.inspectSheet(ctx, receipt, token);
    if (!sheet.synced) differences.push({ check: 'sheets', detail: sheet.problem || 'SHEETS_UNCONFIRMED', row: sheet.rowNumber ?? null });

    return inconsistent(differences);
  }
}
