import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local HTTP server that behaves like Google Drive where delivery depends on it: it parses the
 * multipart upload, keeps each file's parents, properties and real SHA-256, answers the
 * `properties has { ... }` query, and reads a file back by id. Sheets answers just enough for the
 * publisher to finish (no row is reported, so a receipt ends at drive_complete).
 */
export interface StoredFile { id: string; name: string; mimeType: string; parents: string[]; properties: Record<string, string>; bytes: Buffer; createdTime: string }

export interface FakeDrive {
  base: string;
  files: StoredFile[];
  uploadsReceived: number;
  generatedIdsIssued: number;
  /** dropUploadReply: keep the file but cut the connection. searchStatus/searchBody: break the lookup. uploadDelayMs: slow uploads. */
  fault: { dropUploadReply: number; searchStatus: number; searchBody: string | undefined; uploadDelayMs: number; hideSearches: number };
  reset(): void;
  close(): Promise<void>;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const view = (f: StoredFile) => ({
  id: f.id, name: f.name, mimeType: f.mimeType, size: String(f.bytes.length), sha256Checksum: sha(f.bytes),
  properties: f.properties, parents: f.parents, createdTime: f.createdTime, webViewLink: `https://drive.google.com/file/d/${f.id}/view`,
});

export async function startFakeDrive(): Promise<FakeDrive> {
  const state: FakeDrive = {
    base: '', files: [], uploadsReceived: 0, generatedIdsIssued: 0,
    fault: { dropUploadReply: 0, searchStatus: 0, searchBody: undefined, uploadDelayMs: 0, hideSearches: 0 },
    reset() {
      state.files.length = 0;
      state.uploadsReceived = 0;
      state.generatedIdsIssued = 0;
      Object.assign(state.fault, { dropUploadReply: 0, searchStatus: 0, searchBody: undefined, uploadDelayMs: 0, hideSearches: 0 });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  const server = http.createServer((req, res) => {
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
        state.uploadsReceived++;
        const boundary = /boundary=(.+)$/.exec(String(req.headers['content-type']))![1];
        const parts = body.toString('latin1').split(`--${boundary}`).filter((p) => p.includes('\r\n\r\n'));
        const payload = (part: string) => Buffer.from(part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''), 'latin1');
        const metadata = JSON.parse(payload(parts[0]).toString('utf8'));
        if (metadata.id && state.files.some((f) => f.id === metadata.id)) return send(409, { error: { code: 409 } });
        const stored: StoredFile = {
          id: metadata.id || `file_${state.files.length + 1}`, name: metadata.name, mimeType: metadata.mimeType, parents: metadata.parents || [],
          properties: metadata.properties || {}, bytes: payload(parts[1]),
          createdTime: new Date(Date.UTC(2026, 8, 21, 0, 0, state.files.length)).toISOString(),
        };
        const finish = () => {
          if (metadata.id && state.files.some((f) => f.id === metadata.id)) {
            send(409, { error: { code: 409 } });
            return;
          }
          state.files.push(stored);
          // Drive has the file. The reply never arrives: a cut connection, or a killed process.
          if (state.fault.dropUploadReply > 0) { state.fault.dropUploadReply--; req.socket.destroy(); return; }
          send(200, { id: stored.id });
        };
        if (state.fault.uploadDelayMs > 0) setTimeout(finish, state.fault.uploadDelayMs);
        else finish();
        return;
      }

      if (req.method === 'GET' && url.pathname === '/drive/v3/files/generateIds') {
        state.generatedIdsIssued++;
        return send(200, { ids: [`reserved_file_${state.generatedIdsIssued}`], space: 'drive' });
      }

      if (req.method === 'GET' && url.pathname === '/drive/v3/files') {
        if (state.fault.searchStatus) return send(state.fault.searchStatus, { error: { code: state.fault.searchStatus } });
        if (state.fault.searchBody !== undefined) return send(200, state.fault.searchBody);
        if (state.fault.hideSearches > 0) { state.fault.hideSearches--; return send(200, { files: [] }); }
        const q = url.searchParams.get('q') || '';
        const parent = /^'([^']+)' in parents/.exec(q)?.[1];
        const props = [...q.matchAll(/properties has \{ key='([^']+)' and value='([^']+)' \}/g)].map((m) => [m[1], m[2]]);
        const found = state.files.filter((f) => (!parent || f.parents.includes(parent)) && props.every(([k, v]) => f.properties[k] === v));
        return send(200, { files: found.map(view) });
      }

      const byId = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && byId) {
        const f = state.files.find((x) => x.id === byId[1]);
        return f ? send(200, view(f)) : send(404, { error: { code: 404 } });
      }

      if (req.method === 'GET' && url.pathname.includes('/values/')) return send(200, { values: [] });
      if (req.method === 'POST' && url.pathname.includes(':append')) return send(200, { updates: {} });
      return send(404, { error: `unexpected ${req.method} ${url.pathname}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}
