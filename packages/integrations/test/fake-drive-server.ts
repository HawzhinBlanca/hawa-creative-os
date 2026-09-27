import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { FakeSheets } from './fake-sheets.ts';

export interface StoredDriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: string;
  sha256Checksum: string;
  webViewLink: string;
  parents: string[];
  properties: Record<string, string>;
  content: Buffer;
}

export interface FakeDriveServer {
  url: string;
  port: number;
  close: () => Promise<void>;
  reset: () => void;
  getUploadedFiles: () => StoredDriveFile[];
  getFileById: (id: string) => StoredDriveFile | undefined;
  getSheetRows: (spreadsheetId: string) => any[][];
  setSheetRows: (spreadsheetId: string, rows: any[][]) => void;
  moveSheetRow: (spreadsheetId: string, from: number, to: number) => void;
  insertSheetRow: (spreadsheetId: string, index: number, row: any[]) => void;
}

export async function startFakeDriveServer(): Promise<FakeDriveServer> {
  const files = new Map<string, StoredDriveFile>();
  const sheets = new Map<string, FakeSheets>();
  const sheetFor = (id: string) => { let value = sheets.get(id); if (!value) { value = new FakeSheets(); value.tabs.set(1, [['header']]); value.tabs.set(2, [['header']]); sheets.set(id, value); } return value; };
  let fileIdCounter = 1;

  const server = http.createServer(async (req, res) => {
    const fullUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = fullUrl.pathname;
    const method = req.method?.toUpperCase() || 'GET';

    // Collect request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const bodyBuffer = Buffer.concat(chunks);

    const sendJson = (statusCode: number, data: any) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    try {
      if (method === 'GET' && pathname === '/drive/v3/files/generateIds') {
        return sendJson(200, { ids: [`drive_file_${fileIdCounter++}_${Date.now()}`], space: 'drive' });
      }

      // 1. Google Drive Multipart Upload: POST /drive/v3/files?uploadType=multipart
      if (method === 'POST' && pathname === '/drive/v3/files' && fullUrl.searchParams.get('uploadType') === 'multipart') {
        const bodyStr = bodyBuffer.toString('utf8');
        const boundaryMatch = (req.headers['content-type'] || '').match(/boundary=([^;]+)/);
        const boundary = boundaryMatch ? boundaryMatch[1].trim() : '';

        let metadata: any = {};
        let fileContentBuffer = Buffer.alloc(0);

        if (boundary && bodyStr.includes(boundary)) {
          const parts = bodyStr.split(`--${boundary}`);
          for (const part of parts) {
            if (part.includes('Content-Type: application/json')) {
              const jsonStart = part.indexOf('{');
              const jsonEnd = part.lastIndexOf('}');
              if (jsonStart !== -1 && jsonEnd !== -1) {
                try {
                  metadata = JSON.parse(part.substring(jsonStart, jsonEnd + 1));
                  break;
                } catch {}
              }
            }
          }
          // Extract binary content between second and third boundary
          const boundaryBytes = Buffer.from(`--${boundary}`);
          const firstBoundaryIdx = bodyBuffer.indexOf(boundaryBytes);
          const secondBoundaryIdx = bodyBuffer.indexOf(boundaryBytes, firstBoundaryIdx + boundaryBytes.length);
          if (secondBoundaryIdx !== -1) {
            const afterSecond = secondBoundaryIdx + boundaryBytes.length;
            const thirdBoundaryIdx = bodyBuffer.indexOf(boundaryBytes, afterSecond);
            if (thirdBoundaryIdx !== -1) {
              const partData = bodyBuffer.subarray(afterSecond, thirdBoundaryIdx);
              const headerEnd = partData.indexOf('\r\n\r\n');
              if (headerEnd !== -1) {
                fileContentBuffer = partData.subarray(headerEnd + 4);
                // Strip trailing \r\n if present
                if (fileContentBuffer.length >= 2 && fileContentBuffer[fileContentBuffer.length - 2] === 13 && fileContentBuffer[fileContentBuffer.length - 1] === 10) {
                  fileContentBuffer = fileContentBuffer.subarray(0, fileContentBuffer.length - 2);
                }
              }
            }
          }
        }

        const fileId = metadata.id || `drive_file_${fileIdCounter++}_${Date.now()}`;
        if (files.has(fileId)) return sendJson(409, { error: { code: 409 } });
        const sha256Checksum = crypto.createHash('sha256').update(fileContentBuffer).digest('hex');
        const stored: StoredDriveFile = {
          id: fileId,
          name: metadata.name || 'unnamed_file',
          mimeType: metadata.mimeType || 'application/octet-stream',
          size: String(fileContentBuffer.length),
          sha256Checksum,
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
          parents: metadata.parents || [],
          properties: metadata.properties || {},
          content: fileContentBuffer,
        };
        files.set(fileId, stored);

        return sendJson(200, {
          id: fileId,
          name: stored.name,
          mimeType: stored.mimeType,
          size: stored.size,
          webViewLink: stored.webViewLink,
          sha256Checksum,
        });
      }

      // 2. Google Drive File Lookup / Query: GET /drive/v3/files?q=...
      if (method === 'GET' && pathname === '/drive/v3/files') {
        const q = fullUrl.searchParams.get('q') || '';
        const matching: any[] = [];
        for (const file of files.values()) {
          // Check taskId in query if present
          const taskMatch = q.match(/key='taskId' and value='([^']+)'/);
          if (taskMatch && file.properties.taskId !== taskMatch[1]) {
            continue;
          }
          // Check artifactId in query if present
          const artMatch = q.match(/key='artifactId' and value='([^']+)'/);
          if (artMatch && file.properties.artifactId !== artMatch[1]) {
            continue;
          }
          matching.push({
            id: file.id,
            name: file.name,
            size: file.size,
            mimeType: file.mimeType,
            webViewLink: file.webViewLink,
          properties: file.properties,
          parents: file.parents,
          sha256Checksum: file.sha256Checksum,
          });
        }
        return sendJson(200, { files: matching });
      }

      // 3. Google Drive Readback / Metadata: GET /drive/v3/files/:id
      const driveFileMatch = pathname.match(/^\/drive\/v3\/files\/([^/?]+)$/);
      if (method === 'GET' && driveFileMatch) {
        const fileId = driveFileMatch[1];
        const file = files.get(fileId);
        if (file) {
          return sendJson(200, {
            id: file.id,
            name: file.name,
            size: file.size,
            mimeType: file.mimeType,
            webViewLink: file.webViewLink,
            sha256Checksum: file.sha256Checksum,
            properties: file.properties,
            parents: file.parents,
          });
        }
        // Could be folder verification
        return sendJson(200, {
          id: fileId,
          name: 'Fake Folder',
          mimeType: 'application/vnd.google-apps.folder',
        });
      }

      // New row-identity protocol, exercised over actual HTTP.
      const spreadsheetId = pathname.match(/^\/v4\/spreadsheets\/([^/:]+)/)?.[1];
      if (spreadsheetId) {
        const response = await sheetFor(decodeURIComponent(spreadsheetId)).fetch(fullUrl, {
          method, ...(method === 'GET' ? {} : { body: bodyBuffer.toString('utf8') }),
        });
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(await response.text()); return;
      }

      // Default fallback
      return sendJson(404, { error: { message: `Not found: ${method} ${pathname}` } });
    } catch (err: any) {
      return sendJson(500, { error: { message: err.message } });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    port: addr.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
    reset: () => {
      files.clear();
      sheets.clear();
    },
    getUploadedFiles: () => Array.from(files.values()),
    getFileById: (id: string) => files.get(id),
    getSheetRows: (spreadsheetId: string) => sheetFor(spreadsheetId).tabs.get(0)!,
    moveSheetRow: (spreadsheetId, from, to) => sheetFor(spreadsheetId).move(0, from, to),
    insertSheetRow: (spreadsheetId, index, row) => {
      const sheet = sheetFor(spreadsheetId); sheet.tabs.get(0)!.splice(index, 0, row);
      for (const m of sheet.metadata.values()) {
        const d = m.location.dimensionRange;
        if (d.sheetId === 0 && d.startIndex >= index) { d.startIndex++; d.endIndex++; }
      }
    },
    setSheetRows: (spreadsheetId: string, rows: any[][]) => {
      sheetFor(spreadsheetId).tabs.set(0, [...rows]);
    },
  };
}
