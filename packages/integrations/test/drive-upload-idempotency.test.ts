import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PackageFile, PublishRequest, RequestContext } from '@hawa/contracts';
import { GooglePublisher } from '../src/google-publisher.js';

/**
 * One logical delivery, one file in the client's folder.
 *
 * The publisher remembered what it had uploaded in a process-memory Map. An upload whose reply was
 * lost, or a process killed between the upload and the database record, left a file nothing
 * remembered, and the next process uploaded a second copy. A Drive lookup existed but ran only for
 * requests flagged isRetry or reconcileFirst, which no caller set, or for ids starting "synthetic".
 *
 * Every test here uses a NEW GooglePublisher for the second attempt, which is what a restart is, and
 * a local HTTP server that behaves like Drive: it parses the multipart upload, keeps the file's
 * properties and real SHA-256, and answers the properties query.
 */

interface StoredFile { id: string; name: string; mimeType: string; parents: string[]; properties: Record<string, string>; bytes: Buffer; createdTime: string }

let server: http.Server;
let base = '';
let drive: StoredFile[] = [];
let uploadsReceived = 0;
const fault = { dropUploadReply: 0, searchStatus: 0, searchBody: undefined as string | undefined };

const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex');
const view = (f: StoredFile) => ({
  id: f.id, name: f.name, mimeType: f.mimeType, size: String(f.bytes.length), sha256Checksum: sha(f.bytes),
  properties: f.properties, createdTime: f.createdTime, webViewLink: `https://drive.google.com/file/d/${f.id}/view`,
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);

      if (req.method === 'POST' && url.pathname === '/drive/v3/files' && url.searchParams.get('uploadType') === 'multipart') {
        uploadsReceived++;
        const boundary = /boundary=(.+)$/.exec(String(req.headers['content-type']))![1];
        const raw = body.toString('latin1');
        const parts = raw.split(`--${boundary}`).filter((p) => p.includes('\r\n\r\n'));
        const metadata = JSON.parse(Buffer.from(parts[0].slice(parts[0].indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''), 'latin1').toString('utf8'));
        const bytes = Buffer.from(parts[1].slice(parts[1].indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''), 'latin1');
        const stored: StoredFile = {
          id: `file_${drive.length + 1}`, name: metadata.name, mimeType: metadata.mimeType, parents: metadata.parents || [],
          properties: metadata.properties || {}, bytes, createdTime: new Date(Date.UTC(2026, 8, 21, 0, 0, drive.length)).toISOString(),
        };
        drive.push(stored);
        // Drive has the file. The reply never arrives: a cut connection, or a killed process.
        if (fault.dropUploadReply > 0) { fault.dropUploadReply--; req.socket.destroy(); return; }
        return send(200, { id: stored.id });
      }

      if (req.method === 'GET' && url.pathname === '/drive/v3/files') {
        if (fault.searchStatus) return send(fault.searchStatus, { error: { code: fault.searchStatus } });
        if (fault.searchBody !== undefined) return send(200, fault.searchBody);
        const q = url.searchParams.get('q') || '';
        const parent = /^'([^']+)' in parents/.exec(q)?.[1];
        const props = [...q.matchAll(/properties has \{ key='([^']+)' and value='([^']+)' \}/g)].map((m) => [m[1], m[2]]);
        const files = drive.filter((f) => (!parent || f.parents.includes(parent)) && props.every(([k, v]) => f.properties[k] === v));
        return send(200, { files: files.map(view) });
      }

      const byId = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && byId) {
        const f = drive.find((x) => x.id === byId[1]);
        return f ? send(200, view(f)) : send(404, { error: { code: 404 } });
      }

      // Sheets: enough for the publisher to finish. No row is reported, so the receipt is drive_complete.
      if (req.method === 'GET' && url.pathname.includes('/values/')) return send(200, { values: [] });
      if (req.method === 'POST' && url.pathname.includes(':append')) return send(200, { updates: {} });
      return send(404, { error: `unexpected ${req.method} ${url.pathname}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

beforeEach(() => {
  drive = [];
  uploadsReceived = 0;
  fault.dropUploadReply = 0;
  fault.searchStatus = 0;
  fault.searchBody = undefined;
});

const ctx: RequestContext = {
  tenantId: 'tenant-default', taskId: 'task-idem', actor: { type: 'workflow', id: 'publisher' },
  correlationId: 'corr-idem', deadline: new Date(Date.now() + 60000).toISOString(), idempotencyKey: 'idem-drive',
};

function file(text: string, overrides: Partial<PackageFile> = {}): PackageFile {
  const content = new TextEncoder().encode(text);
  return {
    artifactId: 'art-poster', relativePath: 'poster.png', storageKey: 'memory:poster.png', filename: 'poster.png',
    mimeType: 'image/png', byteSize: content.length, sha256: sha(content), content, ...overrides,
  };
}

const request = (files: PackageFile[], key = 'pub-idem'): PublishRequest => ({
  taskId: 'task-idem', clientId: 'client-kaae', designRevisionId: 'rev-1', approvalId: 'approval-1',
  publicationKey: key, packageHash: 'package-hash', files,
  destination: { sharedDriveId: '', productionRootFolderId: 'folder-kaae', relativeFolderParts: [], spreadsheetId: 'sheet-kaae', sheetId: 0 },
  sheetRow: { taskId: 'task-idem' },
});

/** A process that has just started: no memory of anything. */
const freshProcess = () => new GooglePublisher({ oauthToken: 'live-token', driveApiBaseUrl: base, driveUploadBaseUrl: base, sheetsApiBaseUrl: base });

describe('Drive delivery: one logical delivery, one file', () => {
  it('a restart after a successful delivery adopts the file instead of uploading it again', async () => {
    const f = file('approved poster bytes');
    const first = await freshProcess().publish(ctx, request([f]));
    expect(first.ok).toBe(true);
    const second = await freshProcess().publish(ctx, request([f]));
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(drive).toHaveLength(1);
    expect(uploadsReceived).toBe(1);
    expect(second.value.driveFiles[0].fileId).toBe(first.value.driveFiles[0].fileId);
    expect(second.value.driveFiles[0].verified).toBe(true);
  });

  it('an upload whose reply was lost is found by the next process, not repeated', async () => {
    const f = file('approved poster bytes');
    fault.dropUploadReply = 1;
    let firstOutcome: 'threw' | 'failed' | 'ok' = 'ok';
    try {
      const first = await freshProcess().publish(ctx, request([f]));
      firstOutcome = first.ok ? 'ok' : 'failed';
    } catch {
      firstOutcome = 'threw';
    }
    expect(firstOutcome).not.toBe('ok');
    expect(drive).toHaveLength(1); // Drive kept the file although nobody was told

    const second = await freshProcess().publish(ctx, request([f]));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(drive).toHaveLength(1);
    expect(uploadsReceived).toBe(1);
    expect(second.value.driveFiles[0]).toMatchObject({ fileId: 'file_1', verified: true });
  });

  it('uploads nothing when Drive cannot say whether the file is already there', async () => {
    for (const status of [500, 503, 429, 403]) {
      fault.searchStatus = status;
      const res = await freshProcess().publish(ctx, request([file('approved poster bytes')], `pub-${status}`));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect((res.error as any).code).toBe('DRIVE_LOOKUP_FAILED');
      expect((res.error as any).retryable).toBe(true);
    }
    expect(uploadsReceived).toBe(0);
    expect(drive).toHaveLength(0);
  });

  it('treats an answer without a file list as no answer', async () => {
    for (const body of ['{}', '{"files":null}', '[]', 'not json']) {
      fault.searchBody = body;
      const res = await freshProcess().publish(ctx, request([file('approved poster bytes')], `pub-${body.length}`));
      expect(res.ok).toBe(false);
    }
    expect(uploadsReceived).toBe(0);
  });

  it('uploads a changed revision of the same artifact beside the old one, and adopts neither wrongly', async () => {
    await freshProcess().publish(ctx, request([file('revision one')], 'pub-rev-1'));
    const second = await freshProcess().publish(ctx, request([file('revision two, edited in Canva')], 'pub-rev-2'));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(drive).toHaveLength(2);
    expect(second.value.driveFiles[0].fileId).toBe('file_2');
    expect(second.value.driveFiles[0].verified).toBe(true);
  });

  it("does not adopt a stranger's file that merely has the same name and size", async () => {
    const f = file('approved poster bytes');
    drive.push({
      id: 'someone_elses_file', name: f.filename, mimeType: f.mimeType, parents: ['folder-kaae'], properties: {},
      bytes: Buffer.from('x'.repeat(f.byteSize)), createdTime: new Date(Date.UTC(2026, 8, 1)).toISOString(),
    });
    const res = await freshProcess().publish(ctx, request([f]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.driveFiles[0].fileId).not.toBe('someone_elses_file');
    expect(uploadsReceived).toBe(1);
    expect(drive).toHaveLength(2);
  });

  it('decides each file of a package on its own: one already delivered, one not', async () => {
    const poster = file('approved poster bytes');
    const story = file('approved story bytes', { artifactId: 'art-story', filename: 'story.png', relativePath: 'story.png', storageKey: 'memory:story.png' });
    await freshProcess().publish(ctx, request([poster], 'pub-multi'));
    expect(drive).toHaveLength(1);

    const res = await freshProcess().publish(ctx, request([poster, story], 'pub-multi'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(drive).toHaveLength(2);
    expect(uploadsReceived).toBe(2);
    expect(res.value.driveFiles.map((d) => d.fileId)).toEqual(['file_1', 'file_2']);
    expect(res.value.driveFiles.every((d) => d.verified)).toBe(true);
  });
});
