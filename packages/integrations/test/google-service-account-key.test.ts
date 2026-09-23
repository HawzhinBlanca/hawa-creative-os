import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishRequest, RequestContext } from '@hawa/contracts';
import { GooglePublisher } from '../src/google-publisher.js';

/**
 * Production is issued a standard service-account JSON key, possibly with the PEM's newlines
 * escaped as backslash-n. Until 2026-09-23 the publisher signed only with a raw PEM plus a separate
 * email: given the JSON it tried to sign with the whole JSON and reported CREDENTIALS_MISSING, a key
 * file path was counted as a key without being read, and a token Google refused was reported as a
 * missing key too.
 */

const { privateKey: pem, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const CLIENT_EMAIL = 'hawa-publisher@hawa-office.iam.gserviceaccount.com';

/** The JSON Google issues, with the key's newlines escaped once more, as env files often hold it. */
const serviceAccountJson = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'service_account',
    project_id: 'hawa-office',
    private_key_id: 'abc123',
    private_key: pem.replace(/\n/g, '\\n'),
    client_email: CLIENT_EMAIL,
    ...fields,
  });

const ctx: RequestContext = {
  tenantId: 'tenant-default',
  taskId: 'task-sa',
  actor: { type: 'workflow', id: 'publisher' },
  correlationId: 'corr-sa',
  deadline: new Date(Date.now() + 60000).toISOString(),
  idempotencyKey: 'idem-sa',
};

function request(): PublishRequest {
  const content = new TextEncoder().encode('png-bytes');
  return {
    taskId: 'task-sa',
    clientId: 'client-kaae',
    designRevisionId: 'rev-1',
    approvalId: 'approval-1',
    publicationKey: `pub-${Math.random()}`,
    packageHash: 'package-hash',
    files: [{
      artifactId: 'art-1',
      relativePath: 'a.png',
      storageKey: 'memory:a.png',
      filename: 'a.png',
      mimeType: 'image/png',
      byteSize: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      content,
    }],
    destination: { sharedDriveId: '', productionRootFolderId: 'folder-kaae', relativeFolderParts: [], spreadsheetId: 'sheet-kaae', sheetId: 0 },
    sheetRow: { taskId: 'task-sa' },
  };
}

const publisher = (config: ConstructorParameters<typeof GooglePublisher>[0] = {}) =>
  new GooglePublisher({ driveApiBaseUrl: 'https://drive.test', driveUploadBaseUrl: 'https://upload.test', sheetsApiBaseUrl: 'https://sheets.test', ...config });

beforeEach(() => {
  // The shared setup file points every suite at a fake Drive with a ready-made OAuth token.
  for (const name of [
    'GOOGLE_OAUTH_TOKEN',
    'MOCK_GOOGLE_TOKEN',
    'GOOGLE_SERVICE_ACCOUNT_KEY',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GCP_PRIVATE_KEY',
    'GCP_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ]) {
    vi.stubEnv(name, '');
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Google's token endpoint answers `token`; the Drive lookup then refuses, which ends the publish. */
function stubGoogle(tokenResponse: Response) {
  const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
    String(url) === 'https://oauth2.googleapis.com/token' ? tokenResponse : new Response('{}', { status: 503 })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('GooglePublisher reads the service-account key production is given', () => {
  it('signs with the private_key of a JSON key whose newlines are escaped, as its client_email', async () => {
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_KEY', serviceAccountJson());
    const fetchMock = stubGoogle(Response.json({ access_token: 'ya29.issued', expires_in: 3599 }));

    const res = await publisher().publish(ctx, request());

    const tokenCall = fetchMock.mock.calls.find(([url]) => String(url) === 'https://oauth2.googleapis.com/token');
    expect(tokenCall).toBeDefined();
    const init = tokenCall![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const form = new URLSearchParams(String(init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = String(form.get('assertion')).split('.');
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({ iss: CLIENT_EMAIL, aud: 'https://oauth2.googleapis.com/token' });
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true);

    // The token was used: the next call is the Drive lookup, with Google's bearer.
    const driveCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith('https://drive.test'));
    expect((driveCall![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer ya29.issued' });
    expect(res.ok).toBe(false);
    if (res.ok === false) expect(res.error.code).toBe('DRIVE_LOOKUP_FAILED');
  });

  it('lets an explicitly configured email win over the JSON key\'s', async () => {
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_KEY', serviceAccountJson());
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'delegate@hawa-office.iam.gserviceaccount.com');
    const fetchMock = stubGoogle(Response.json({ access_token: 'ya29.issued' }));
    await publisher().publish(ctx, request());
    const form = new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const claims = String(form.get('assertion')).split('.')[1];
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString()).iss).toBe('delegate@hawa-office.iam.gserviceaccount.com');
  });

  it('reads a key file named by GOOGLE_APPLICATION_CREDENTIALS', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-sa-'));
    const file = path.join(dir, 'key.json');
    fs.writeFileSync(file, serviceAccountJson());
    try {
      vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', file);
      const fetchMock = stubGoogle(Response.json({ access_token: 'ya29.from-file' }));
      expect(publisher().getCredentials()).toMatchObject({ hasKey: true, email: CLIENT_EMAIL, source: 'env' });
      await publisher().publish(ctx, request());
      expect(String(fetchMock.mock.calls[0][0])).toBe('https://oauth2.googleapis.com/token');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports CREDENTIALS_MISSING, and why, for a JSON key with no private_key, without calling Google', async () => {
    // What production holds today: the project, not the key.
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_KEY', JSON.stringify({ type: 'service_account', project_id: 'hawa-office' }));
    const fetchMock = stubGoogle(Response.json({ access_token: 'never' }));

    expect(publisher().getCredentials()).toMatchObject({ hasKey: false, source: 'env' });
    const res = await publisher().publish(ctx, request());
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.error.code).toBe('CREDENTIALS_MISSING');
      expect(res.error.message).toContain('Google Workspace credentials not configured');
      expect(res.error.message).toContain('no private_key');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a token Google refused as GOOGLE_TOKEN_FAILED with the status, not as a missing key', async () => {
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_KEY', serviceAccountJson());
    const fetchMock = stubGoogle(Response.json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, { status: 400 }));

    const res = await publisher().publish(ctx, request());
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.error.code).toBe('GOOGLE_TOKEN_FAILED');
      expect(res.error.message).toContain('HTTP 400');
      expect(res.error.message).toContain('invalid_grant');
      expect(res.error.message).not.toContain('PRIVATE KEY');
      expect(res.error.retryable).toBe(false);
    }
    // Nothing went to Drive without a token.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a token request that never answered as GOOGLE_TOKEN_FAILED', async () => {
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_KEY', serviceAccountJson());
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }));
    const res = await publisher().publish(ctx, request());
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.error.code).toBe('GOOGLE_TOKEN_FAILED');
      expect(res.error.message).toContain('timed out');
      expect(res.error.retryable).toBe(true);
    }
  });

  it('still takes a raw PEM with a separate email', async () => {
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_KEY', pem.replace(/\n/g, '\\n'));
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', CLIENT_EMAIL);
    const fetchMock = stubGoogle(Response.json({ access_token: 'ya29.issued' }));
    await publisher().publish(ctx, request());
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://oauth2.googleapis.com/token');
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('https://drive.test'))).toBe(true);
  });
});
