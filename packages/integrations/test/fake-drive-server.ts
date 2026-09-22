import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

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
}

export async function startFakeDriveServer(): Promise<FakeDriveServer> {
  const files = new Map<string, StoredDriveFile>();
  const sheets = new Map<string, any[][]>();
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

        const fileId = `drive_file_${fileIdCounter++}_${Date.now()}`;
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
          });
        }
        // Could be folder verification
        return sendJson(200, {
          id: fileId,
          name: 'Fake Folder',
          mimeType: 'application/vnd.google-apps.folder',
        });
      }

      // 4. Google Sheets: Spreadsheet metadata GET /v4/spreadsheets/:id
      const sheetMetaMatch = pathname.match(/^\/v4\/spreadsheets\/([^/?:]+)$/);
      if (method === 'GET' && sheetMetaMatch) {
        const spreadsheetId = sheetMetaMatch[1];
        return sendJson(200, {
          spreadsheetId,
          properties: { title: 'Fake Spreadsheet' },
        });
      }

      // 5. Google Sheets: Append Row POST /v4/spreadsheets/:id/values/A1:append or /values/A:G:append
      const sheetAppendMatch = pathname.match(/^\/v4\/spreadsheets\/([^/]+)\/values\/[^:]+:append$/);
      if (method === 'POST' && sheetAppendMatch) {
        const spreadsheetId = sheetAppendMatch[1];
        const body = JSON.parse(bodyBuffer.toString('utf8') || '{}');
        let sheet = sheets.get(spreadsheetId);
        if (!sheet) {
          sheet = [];
          sheets.set(spreadsheetId, sheet);
        }
        const newValues = body.values?.[0] || [];
        sheet.push(newValues);
        const rowNumber = sheet.length;
        return sendJson(200, {
          updates: {
            updatedRange: `Sheet1!A${rowNumber}:G${rowNumber}`,
            updatedRows: 1,
          },
        });
      }

      // 6. Google Sheets: Update Row PUT /v4/spreadsheets/:id/values/A{n}:G{n}
      const sheetPutMatch = pathname.match(/^\/v4\/spreadsheets\/([^/]+)\/values\/A(\d+):[A-Za-z]+(\d+)$/);
      if (method === 'PUT' && sheetPutMatch) {
        const spreadsheetId = sheetPutMatch[1];
        const rowNumber = parseInt(sheetPutMatch[2], 10);
        const body = JSON.parse(bodyBuffer.toString('utf8') || '{}');
        let sheet = sheets.get(spreadsheetId);
        if (!sheet) {
          sheet = [];
          sheets.set(spreadsheetId, sheet);
        }
        while (sheet.length < rowNumber) {
          sheet.push([]);
        }
        sheet[rowNumber - 1] = body.values?.[0] || [];
        return sendJson(200, { updatedRows: 1 });
      }

      // 7. Google Sheets: Get Range GET /v4/spreadsheets/:id/values/:range
      const sheetGetRangeMatch = pathname.match(/^\/v4\/spreadsheets\/([^/]+)\/values\/(.+)$/);
      if (method === 'GET' && sheetGetRangeMatch) {
        const spreadsheetId = sheetGetRangeMatch[1];
        const range = decodeURIComponent(sheetGetRangeMatch[2]);
        const sheet = sheets.get(spreadsheetId) || [];

        // Single cell or column: A:A
        if (range === 'A:A') {
          const colA = sheet.map((row) => [row[0] || '']);
          return sendJson(200, { values: colA });
        }

        // Specific cell: A{n}:A{n}
        const cellMatch = range.match(/^A(\d+):A\1$/);
        if (cellMatch) {
          const rowIdx = parseInt(cellMatch[1], 10) - 1;
          const val = sheet[rowIdx]?.[0] || '';
          return sendJson(200, { values: [[val]] });
        }

        // Specific row range: A{n}:G{n}
        const rowRangeMatch = range.match(/^A(\d+):[A-Za-z]+\1$/);
        if (rowRangeMatch) {
          const rowIdx = parseInt(rowRangeMatch[1], 10) - 1;
          const row = sheet[rowIdx] || [];
          return sendJson(200, { values: [row] });
        }

        return sendJson(200, { values: sheet });
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
    getSheetRows: (spreadsheetId: string) => sheets.get(spreadsheetId) || [],
    setSheetRows: (spreadsheetId: string, rows: any[][]) => {
      sheets.set(spreadsheetId, [...rows]);
    },
  };
}
