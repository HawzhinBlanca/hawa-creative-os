import { createHash } from 'node:crypto';

export interface SheetRowScope { tenantId: string; spreadsheetId: string; sheetId: number; taskId: string }
export interface SheetRowResult {
  synced: boolean;
  rowNumber?: number;
  metadataId?: number;
  observedHash?: string;
  expectedRowHash?: string;
  observedRowHash?: string;
  expectedValues?: string[];
  problem?: string;
}
type ObjectValue = Record<string, unknown>;
type Metadata = { row: number; id: number };
type Observation = { metadata?: Metadata; values?: unknown[] };
const KEY = 'hawa.task.v1';
const MAX_ROWS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024;
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SHEETS_RESPONSE_INVALID');
  return value as ObjectValue;
};
export const sheetRowHash = (values: readonly unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
export function sheetRowIdentity(scope: SheetRowScope) {
  const value = JSON.stringify(['hawa.sheet-row.v1', scope.tenantId, scope.spreadsheetId, scope.sheetId, scope.taskId]);
  // The full value is always checked. A 31-bit collision is a refusal, never an alias.
  const id = (createHash('sha256').update(value).digest().readUInt32BE(0) & 0x7fffffff) || 1;
  return { id, value };
}

/** Provider row identity. No mutable process cache and no numeric-row update fallback. */
export class GoogleSheetRow {
  private readonly deadline: number;
  constructor(private readonly baseUrl: string, private readonly token: string, deadline?: string) {
    this.deadline = Math.min(Date.now() + 45_000, deadline ? Date.parse(deadline) : Infinity);
  }

  private async call(scope: SheetRowScope, suffix: string, body?: ObjectValue, missingAllowed = false): Promise<ObjectValue | undefined> {
    const remaining = this.deadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('SHEETS_DEADLINE_EXCEEDED');
    const response = await fetch(`${this.baseUrl}/v4/spreadsheets/${encodeURIComponent(scope.spreadsheetId)}${suffix}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(Math.min(10_000, Math.ceil(remaining))),
      redirect: 'error',
    });
    if (response.status === 404 && missingAllowed) { await response.body?.cancel(); return undefined; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`SHEETS_HTTP_${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('SHEETS_RESPONSE_INVALID');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) throw new Error('SHEETS_RESPONSE_TOO_LARGE');
        chunks.push(chunk.value);
      }
      return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } finally { await reader.cancel().catch(() => undefined); }
  }

  private validateScope(scope: SheetRowScope) {
    if (!scope.tenantId || !scope.spreadsheetId || !scope.taskId || !Number.isSafeInteger(scope.sheetId) || scope.sheetId < 0) {
      throw new Error('SHEETS_SCOPE_INVALID');
    }
  }

  private async metadata(scope: SheetRowScope): Promise<Metadata | undefined> {
    const identity = sheetRowIdentity(scope);
    const data = await this.call(scope, `/developerMetadata/${identity.id}`, undefined, true);
    if (!data) return undefined;
    const range = object(object(data.location).dimensionRange);
    if (data.metadataId !== identity.id || data.metadataKey !== KEY || data.metadataValue !== identity.value ||
        data.visibility !== 'PROJECT' || range.sheetId !== scope.sheetId || range.dimension !== 'ROWS' ||
        !Number.isSafeInteger(range.startIndex) || Number(range.startIndex) < 1 || range.endIndex !== Number(range.startIndex) + 1) {
      throw new Error('SHEETS_ROW_IDENTITY_CONFLICT');
    }
    return { id: identity.id, row: Number(range.startIndex) + 1 };
  }

  private async rows(scope: SheetRowScope): Promise<unknown[][]> {
    const meta = await this.call(scope, ':getByDataFilter?fields=spreadsheetId,sheets(properties(sheetId,gridProperties(rowCount,columnCount)))', {
      dataFilters: [{ gridRange: { sheetId: scope.sheetId } }], includeGridData: false,
    });
    if (meta?.spreadsheetId !== scope.spreadsheetId || !Array.isArray(meta.sheets) || meta.sheets.length !== 1) throw new Error('SHEETS_TAB_UNCONFIRMED');
    const props = object(object(meta.sheets[0]).properties); const grid = object(props.gridProperties);
    if (props.sheetId !== scope.sheetId || !Number.isSafeInteger(grid.rowCount) || Number(grid.rowCount) < 2 ||
        !Number.isSafeInteger(grid.columnCount) || Number(grid.columnCount) < 7) throw new Error('SHEETS_TAB_UNCONFIRMED');
    if (Number(grid.rowCount) > MAX_ROWS) throw new Error('SHEETS_SCAN_LIMIT');
    const result = await this.call(scope, '/values:batchGetByDataFilter', {
      dataFilters: [{ gridRange: { sheetId: scope.sheetId, startRowIndex: 0, endRowIndex: grid.rowCount, startColumnIndex: 0, endColumnIndex: 7 } }],
      majorDimension: 'ROWS', valueRenderOption: 'UNFORMATTED_VALUE',
    });
    if (result?.spreadsheetId !== scope.spreadsheetId || !Array.isArray(result.valueRanges) || result.valueRanges.length !== 1) throw new Error('SHEETS_RESPONSE_INVALID');
    const range = object(object(result.valueRanges[0]).valueRange);
    const filters = object(result.valueRanges[0]).dataFilters;
    if (!Array.isArray(filters) || filters.length !== 1) throw new Error('SHEETS_RESPONSE_INVALID');
    const selected = object(object(filters[0]).gridRange);
    if (selected.sheetId !== scope.sheetId || selected.startRowIndex !== 0 || selected.endRowIndex !== grid.rowCount ||
        selected.startColumnIndex !== 0 || selected.endColumnIndex !== 7) throw new Error('SHEETS_RESPONSE_INVALID');
    if (range.majorDimension !== 'ROWS' || typeof range.range !== 'string' || !/!A1:G\d+$/.test(range.range)) throw new Error('SHEETS_RESPONSE_INVALID');
    const rows: unknown = range.values ?? [];
    if (!Array.isArray(rows) || rows.length > Number(grid.rowCount) || rows.some(row => !Array.isArray(row) || row.length > 7)) throw new Error('SHEETS_RESPONSE_INVALID');
    return rows as unknown[][];
  }

  private async observeOnce(scope: SheetRowScope): Promise<Observation> {
    this.validateScope(scope);
    const before = await this.metadata(scope);
    const rows = await this.rows(scope);
    const positions = rows.flatMap((row, index) => row[0] === scope.taskId ? [index + 1] : []);
    if (positions.length > 1) throw new Error('SHEETS_DUPLICATE_TASK');
    const after = await this.metadata(scope);
    if (before?.id !== after?.id || before?.row !== after?.row) throw new Error('SHEETS_ROW_MOVED_DURING_READ');
    if (!after) {
      if (positions.length) throw new Error('SHEETS_LEGACY_ROW_NEEDS_MIGRATION');
      return {};
    }
    if (positions.length !== 1 || positions[0] !== after.row) throw new Error('SHEETS_ROW_IDENTITY_CONFLICT');
    return { metadata: after, values: rows[after.row - 1] };
  }

  private async observe(scope: SheetRowScope): Promise<Observation> {
    // Concurrent insertions can move an intact row between our reads. Repeat only
    // the read, within the same deadline; never replay a mutation here.
    for (let attempt = 0; ; attempt++) {
      try { return await this.observeOnce(scope); }
      catch (error) {
        if (attempt >= 2 || !(error instanceof Error) || error.message !== 'SHEETS_ROW_MOVED_DURING_READ') throw error;
      }
    }
  }

  private result(observation: Observation, expected: string[]): SheetRowResult {
    const values = observation.values;
    const actual = values ? Array.from({ length: 7 }, (_, i) => values[i] ?? '') : undefined;
    const expectedRowHash = sheetRowHash(expected);
    const observedRowHash = actual ? sheetRowHash(actual) : undefined;
    const synced = Boolean(observation.metadata && observedRowHash === expectedRowHash);
    return {
      synced, rowNumber: observation.metadata?.row, metadataId: observation.metadata?.id,
      expectedRowHash, observedRowHash, expectedValues: expected,
      observedHash: typeof values?.[6] === 'string' ? values[6] : undefined,
      ...(!synced ? { problem: observation.metadata ? 'SHEETS_ROW_VALUES_DIFFER' : 'SHEETS_ROW_NOT_FOUND' } : {}),
    };
  }

  private problem(error: unknown): SheetRowResult {
    // Provider response text and thrown network errors can contain secrets; return only our codes.
    const code = error instanceof Error && /^SHEETS_[A-Z_0-9]+$/.test(error.message) ? error.message : 'SHEETS_READ_OR_WRITE_UNCONFIRMED';
    return { synced: false, problem: code };
  }

  async verify(scope: SheetRowScope, expected: readonly string[]): Promise<SheetRowResult> {
    try {
      if (expected.length !== 7 || expected[0] !== scope.taskId || expected.some(v => typeof v !== 'string')) throw new Error('SHEETS_EXPECTATION_INVALID');
      return this.result(await this.observe(scope), [...expected]);
    } catch (error) { return this.problem(error); }
  }

  async sync(scope: SheetRowScope, values: readonly string[], pinnedTimestamp = false): Promise<SheetRowResult> {
    let expected: string[] | undefined;
    try {
      if (values.length !== 7 || values[0] !== scope.taskId || values.some(v => typeof v !== 'string')) throw new Error('SHEETS_EXPECTATION_INVALID');
      expected = [...values];
      const prior = await this.observe(scope);
      if (!pinnedTimestamp && prior.values?.[6] === expected[6] && typeof prior.values[3] === 'string' && Number.isFinite(Date.parse(prior.values[3]))) {
        expected[3] = prior.values[3];
      }
      if (this.result(prior, expected).synced) return this.result(prior, expected);
      try {
        if (prior.metadata) {
          const identity = sheetRowIdentity(scope);
          await this.call(scope, '/values:batchUpdateByDataFilter', {
            valueInputOption: 'RAW', data: [{ dataFilter: { developerMetadataLookup: {
              metadataId: prior.metadata.id, metadataKey: KEY, metadataValue: identity.value, visibility: 'PROJECT',
              metadataLocation: { sheetId: scope.sheetId }, locationMatchingStrategy: 'INTERSECTING_LOCATION',
            } }, majorDimension: 'ROWS', values: [expected] }],
          });
        } else {
          const identity = sheetRowIdentity(scope);
          await this.call(scope, ':batchUpdate', {
            requests: [
              { insertDimension: { range: { sheetId: scope.sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 2 }, inheritFromBefore: false } },
              { updateCells: { start: { sheetId: scope.sheetId, rowIndex: 1, columnIndex: 0 }, rows: [{ values: expected.map(stringValue => ({ userEnteredValue: { stringValue } })) }], fields: 'userEnteredValue' } },
              { createDeveloperMetadata: { developerMetadata: { metadataId: identity.id, metadataKey: KEY, metadataValue: identity.value, visibility: 'PROJECT', location: { dimensionRange: { sheetId: scope.sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 2 } } } } },
            ],
          });
        }
      } catch {
        // A rejected duplicate ID or lost successful reply needs readback, never an append retry.
      }
      return this.result(await this.observe(scope), expected);
    } catch (error) {
      return { ...this.problem(error), ...(expected ? { expectedValues: expected, expectedRowHash: sheetRowHash(expected) } : {}) };
    }
  }
}
