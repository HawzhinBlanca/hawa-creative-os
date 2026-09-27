import { createHash } from 'node:crypto';

type Row = (string | number | boolean | null)[];
type Metadata = { metadataId: number; metadataKey: string; metadataValue: string; visibility: string; location: { dimensionRange: { sheetId: number; dimension: string; startIndex: number; endIndex: number } } };

/** Protocol fake: explicit tabs, row movement, unique metadata and atomic create batches. */
export class FakeSheets {
  tabs = new Map<number, Row[]>([[0, [['task', 'client', 'folder', 'time', 'status', 'link', 'hash']]]]);
  metadata = new Map<number, Metadata>();
  calls: { path: string; method: string; body: Record<string, any> }[] = [];
  beforeWrite?: () => void;
  loseCreateResponse = false;
  failCreate = false;
  failRead = false;
  afterWrite?: () => void;

  move(sheetId: number, from: number, to: number) {
    const rows = this.tabs.get(sheetId)!;
    const [row] = rows.splice(from, 1); rows.splice(to, 0, row);
    for (const metadata of this.metadata.values()) {
      const d = metadata.location.dimensionRange;
      if (d.sheetId !== sheetId) continue;
      const i = d.startIndex;
      d.startIndex = i === from ? to : from < to && i > from && i <= to ? i - 1 : to < from && i >= to && i < from ? i + 1 : i;
      d.endIndex = d.startIndex + 1;
    }
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    const spreadsheetId = path.match(/\/spreadsheets\/([^/:]+)/)?.[1];
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    this.calls.push({ path, method, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (this.failRead && !path.endsWith(':batchUpdate') && !path.endsWith(':batchUpdateByDataFilter')) return json({}, 503);
    const metadataId = Number(path.match(/\/developerMetadata\/(\d+)$/)?.[1]);
    if (metadataId) return this.metadata.has(metadataId) ? json(this.metadata.get(metadataId)) : json({}, 404);
    if (path.endsWith(':getByDataFilter')) {
      const sheetId = body.dataFilters[0].gridRange.sheetId;
      const rows = this.tabs.get(sheetId);
      return json({ spreadsheetId, sheets: rows ? [{ properties: { sheetId, gridProperties: { rowCount: Math.max(100, rows.length), columnCount: 7 } } }] : [] });
    }
    if (path.endsWith('/values:batchGetByDataFilter')) {
      const grid = body.dataFilters[0].gridRange;
      const rows = this.tabs.get(grid.sheetId);
      return rows ? json({ spreadsheetId, valueRanges: [{ dataFilters: body.dataFilters, valueRange: { range: `'Tab ${grid.sheetId}'!A1:G${Math.max(100, rows.length)}`, majorDimension: 'ROWS', values: rows } }] }) : json({}, 400);
    }
    if (path.endsWith(':batchUpdate')) {
      const metadata: Metadata = body.requests[2].createDeveloperMetadata.developerMetadata;
      if (this.failCreate) return json({}, 500);
      // Google validates the entire batch before applying any request.
      if (this.metadata.has(metadata.metadataId)) return json({}, 400);
      const dimension = body.requests[0].insertDimension.range;
      const rows = this.tabs.get(dimension.sheetId);
      if (!rows) return json({}, 400);
      this.beforeWrite?.(); this.beforeWrite = undefined;
      for (const m of this.metadata.values()) {
        const d = m.location.dimensionRange;
        if (d.sheetId === dimension.sheetId && d.startIndex >= dimension.startIndex) { d.startIndex++; d.endIndex++; }
      }
      rows.splice(dimension.startIndex, 0, body.requests[1].updateCells.rows[0].values.map((v: any) => v.userEnteredValue.stringValue));
      this.metadata.set(metadata.metadataId, structuredClone(metadata));
      this.afterWrite?.();
      if (this.loseCreateResponse) { this.loseCreateResponse = false; throw new Error('simulated lost successful response'); }
      return json({ spreadsheetId, replies: [{}, {}, { createDeveloperMetadata: { developerMetadata: metadata } }] });
    }
    if (path.endsWith('/values:batchUpdateByDataFilter')) {
      this.beforeWrite?.(); this.beforeWrite = undefined;
      const metadata = this.metadata.get(body.data[0].dataFilter.developerMetadataLookup.metadataId);
      if (!metadata) return json({ spreadsheetId, totalUpdatedRows: 0 });
      const d = metadata.location.dimensionRange;
      const filter = body.data[0].dataFilter.developerMetadataLookup;
      if (filter.metadataKey !== metadata.metadataKey || filter.metadataValue !== metadata.metadataValue || filter.metadataLocation.sheetId !== d.sheetId || filter.visibility !== metadata.visibility) return json({ spreadsheetId, totalUpdatedRows: 0 });
      this.tabs.get(d.sheetId)![d.startIndex].splice(0, 7, ...body.data[0].values[0]);
      this.afterWrite?.();
      return json({ spreadsheetId, totalUpdatedRows: 1 });
    }
    // The old protocol is modelled too: it always hits the first tab and writes by index.
    const rows = this.tabs.get(0)!;
    const range = path.split('/values/')[1];
    if (range === 'A:A') return json({ values: rows.map(row => [row[0]]) });
    if (range?.endsWith(':append')) {
      rows.push(body.values[0]);
      if (this.loseCreateResponse) { this.loseCreateResponse = false; throw new Error('lost append response'); }
      return json({ updates: { updatedRange: `Sheet1!A${rows.length}:G${rows.length}` } });
    }
    const match = range?.match(/^A(\d+):([AG])\d+$/);
    if (match) {
      const i = Number(match[1]) - 1;
      if (method === 'PUT') { this.beforeWrite?.(); this.beforeWrite = undefined; rows[i] = body.values[0]; return json({ updatedRows: 1 }); }
      return json({ values: rows[i] ? [match[2] === 'A' ? rows[i].slice(0, 1) : rows[i]] : [] });
    }
    throw new Error(`Unexpected Sheets fake request: ${method} ${path}`);
  }
}

export function fakePublicationFetch(sheets: FakeSheets) {
  const files = new Map<string, Record<string, unknown>>();
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body));
    if (url.includes('/v4/spreadsheets/')) return sheets.fetch(input, init);
    if (url.includes('/drive/v3/files?q=')) return json({ files: Array.from(files.values()) });
    if (url.startsWith('https://upload.test')) {
      const body = String(init?.body);
      const boundary = /boundary=([^;]+)/.exec(String((init?.headers as Record<string, string>)?.['Content-Type']))?.[1];
      const parts = body.split(`--${boundary}`);
      const metadata = JSON.parse(parts[1].slice(parts[1].indexOf('{'), parts[1].lastIndexOf('}') + 1));
      const content = parts[2].split('\r\n\r\n')[1].replace(/\r\n$/, '');
      const id = `drive-${files.size + 1}`;
      files.set(id, { ...metadata, id, size: String(Buffer.byteLength(content)), sha256Checksum: createHash('sha256').update(content).digest('hex'), webViewLink: `https://drive.google.com/file/d/${id}/view` });
      return json({ id });
    }
    if (url.includes('/drive/v3/files/')) return json(files.get(new URL(url).pathname.split('/').pop()!) || {});
    throw new Error(`Unexpected Google fake request ${url}`);
  };
}
