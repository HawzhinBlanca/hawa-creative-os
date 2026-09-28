import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublishRequest, RequestContext } from '@hawa/contracts';
import { GooglePublisher, type SheetWriteIdentity } from '../src/google-publisher.js';
import { FakeSheets, fakePublicationFetch } from './fake-sheets.js';
import { GoogleSheetRow, sheetRowIdentity } from '../src/google-sheet-row.js';

const ctx: RequestContext = { tenantId: 'tenant-a', actor: { type: 'workflow', id: 'publisher' }, correlationId: 'corr', deadline: '2030-01-01T00:00:00.000Z', idempotencyKey: 'test' };
const request = (sheetId = 7): PublishRequest => ({
  taskId: 'task-a', clientId: 'client-a', approvalId: 'approval-a', designRevisionId: 'revision-a', publicationKey: 'pub-a',
  packageHash: createHash('sha256').update('package').digest('hex'),
  destination: { sharedDriveId: '', productionRootFolderId: 'folder-a', relativeFolderParts: [], spreadsheetId: 'spreadsheet-a', sheetId },
  files: [{ artifactId: 'artifact-a', filename: 'a.png', relativePath: 'a.png', storageKey: 'memory:a', mimeType: 'image/png', byteSize: 3, content: Buffer.from('abc'), sha256: createHash('sha256').update('abc').digest('hex') }],
  sheetRow: { publishedAt: '2026-09-27T16:00:00.000Z' },
});
const publisher = () => new GooglePublisher({ oauthToken: 'synthetic', driveApiBaseUrl: 'https://drive.test', driveUploadBaseUrl: 'https://upload.test', sheetsApiBaseUrl: 'https://sheets.test' });
function setup() {
  const sheets = new FakeSheets(); sheets.tabs.set(7, [['header']]);
  vi.stubGlobal('fetch', vi.fn(fakePublicationFetch(sheets)));
  return sheets;
}
afterEach(() => vi.unstubAllGlobals());

describe('FR-049 stable Google Sheet identity', () => {
  it('leaves Sheets untouched when its durable expectation cannot be recorded', async () => {
    const sheets = setup();
    const prepare = vi.fn(async () => { throw new Error('Synthetic database failure'); });
    const p = new GooglePublisher({ oauthToken: 'synthetic', driveApiBaseUrl: 'https://drive.test', driveUploadBaseUrl: 'https://upload.test', sheetsApiBaseUrl: 'https://sheets.test', sheetExpectationStore: { prepare } });
    const result = await p.publish(ctx, request());
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(result.ok && result.value.driveFiles[0].verified).toBe(true);
    expect(result.ok && result.value.sheet.synced).toBe(false);
    expect(result.ok && result.value.detail.sheetProblem).toBe('SHEETS_EXPECTATION_NOT_RECORDED');
    expect(sheets.calls).toHaveLength(0);
    expect(sheets.metadata.size).toBe(0);
  });

  it('records exact row identity and values before its first Sheets request', async () => {
    const sheets = setup(); let recorded: SheetWriteIdentity | undefined;
    const p = new GooglePublisher({ oauthToken: 'synthetic', driveApiBaseUrl: 'https://drive.test', driveUploadBaseUrl: 'https://upload.test', sheetsApiBaseUrl: 'https://sheets.test', sheetExpectationStore: { prepare: async input => {
      expect(sheets.calls).toHaveLength(0); recorded = structuredClone(input);
    } } });
    const result = await p.publish(ctx, request());
    expect(result.ok && result.value.sheet.synced).toBe(true);
    expect(recorded).toMatchObject({ tenantId: ctx.tenantId, taskId: 'task-a', clientId: 'client-a', publicationKey: 'pub-a', spreadsheetId: 'spreadsheet-a', sheetId: 7 });
    expect(recorded?.expectedValues).toEqual(sheets.tabs.get(7)?.[1]);
    expect(recorded?.expectedValues[3]).toBe(request().sheetRow.publishedAt);
    expect(sheets.metadata.get(recorded!.metadataId)?.metadataValue).toBe(recorded?.metadataValue);
  });

  it('publishes to the configured nonzero tab and leaves the first tab unchanged', async () => {
    const sheets = setup(); const initial = structuredClone(sheets.tabs.get(0));
    const result = await publisher().publish(ctx, request());
    expect(result.ok && result.value.sheet.synced).toBe(true);
    expect(sheets.tabs.get(0)).toEqual(initial);
    expect(sheets.tabs.get(7)?.[1]?.[0]).toBe('task-a');
    expect(sheets.metadata.size).toBe(1);
  });

  it('refuses duplicate task IDs instead of overwriting the first match', async () => {
    const sheets = setup(); const row = ['task-a', 'client-a'];
    sheets.tabs.set(0, [['header'], [...row], [...row]]);
    const result = await publisher().publish(ctx, request(0));
    expect(result.ok && result.value.sheet.synced).toBe(false);
    expect(sheets.calls.filter(c => c.path.endsWith(':append') || c.method === 'PUT' || c.path.endsWith(':batchUpdate') || c.path.endsWith(':batchUpdateByDataFilter'))).toHaveLength(0);
  });

  it('detects a changed Drive link even when the package-hash cell still matches', async () => {
    const sheets = setup(); const p = publisher();
    const first = await p.publish(ctx, request(0)); expect(first.ok).toBe(true); if (!first.ok) return;
    sheets.tabs.get(0)![1][5] = 'https://wrong.example/file';
    const checked = await p.reconcile(ctx, first.value.publicationId);
    expect(checked.ok && checked.value.sheet.synced).toBe(false);
  });

  it('binds the tab ID to a cached publication key', async () => {
    setup(); const p = publisher(); await p.publish(ctx, request(0));
    const changed = await p.publish(ctx, request(7));
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('refuses a changed tab while the same publication is still in flight', async () => {
    setup(); const p = publisher();
    const first = p.publish(ctx, request(0));
    const conflict = await p.publish(ctx, request(7));
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await first).ok).toBe(true);
  });

  it('recovers an accepted create with a lost response, including a fresh publisher', async () => {
    const sheets = setup(); sheets.loseCreateResponse = true;
    const first = await publisher().publish(ctx, request());
    expect(first.ok && first.value.sheet.synced).toBe(true);
    const second = await publisher().publish(ctx, request());
    expect(second.ok && second.value.sheet.synced).toBe(true);
    expect(sheets.tabs.get(7)?.filter(r => r[0] === 'task-a')).toHaveLength(1);
    expect(sheets.calls.filter(c => c.path.endsWith(':batchUpdate'))).toHaveLength(1);
  });

  it('retains expected values after an accepted write whose verification is unavailable', async () => {
    const sheets = setup(); const p = publisher();
    sheets.afterWrite = () => { sheets.failRead = true; };
    const written = await p.publish(ctx, request()); expect(written.ok).toBe(true); if (!written.ok) return;
    expect(written.value.sheet.synced).toBe(false);
    expect(written.value.sheet.expectedValues).toHaveLength(7);
    expect(written.value.sheet.observedHash).toBeUndefined();
    sheets.failRead = false;
    const reconciled = await p.reconcile(ctx, written.value.publicationId);
    expect(reconciled.ok && reconciled.value.sheet.synced).toBe(true);
    expect(sheets.calls.filter(c => c.path.endsWith(':batchUpdate'))).toHaveLength(1);
  });
});

describe('Sheets row protocol failure boundaries', () => {
  const scope = { tenantId: 'tenant-a', spreadsheetId: 'spreadsheet-a', sheetId: 7, taskId: 'task-a' };
  const values = ['task-a', 'client-a', 'folder-a', '2026-09-27T16:00:00.000Z', 'COMPLETE', 'https://drive.example/a', 'hash-a'];
  const client = () => new GoogleSheetRow('https://sheets.test', 'synthetic');
  function protocol() { const sheets = setup(); vi.stubGlobal('fetch', vi.fn(sheets.fetch.bind(sheets))); return sheets; }
  const writes = (s: FakeSheets) => s.calls.filter(c => c.path.endsWith(':batchUpdate') || c.path.endsWith(':batchUpdateByDataFilter'));

  it('concurrent creates converge to one row and recover after either process restarts', async () => {
    const sheets = protocol();
    await Promise.all([client().sync(scope, values, true), client().sync(scope, values, true)]);
    expect(await client().sync(scope, values, true)).toMatchObject({ synced: true, rowNumber: 2 });
    expect(sheets.metadata.size).toBe(1);
    expect(sheets.tabs.get(7)?.filter(r => r[0] === scope.taskId)).toHaveLength(1);
  });

  it('targets the metadata row when staff move it between read and write', async () => {
    const sheets = protocol(); await client().sync(scope, values, true);
    const bystander = ['another-task', 'do not touch']; sheets.tabs.get(7)!.push(bystander);
    sheets.beforeWrite = () => sheets.move(7, 1, 2);
    const next = [...values]; next[5] = '=literal-not-a-formula'; next[6] = 'hash-b';
    expect(await client().sync(scope, next, true)).toMatchObject({ synced: true, rowNumber: 3 });
    expect(sheets.tabs.get(7)?.[1]).toEqual(bystander);
    expect(sheets.calls.find(c => c.path.endsWith(':batchUpdateByDataFilter'))?.body.valueInputOption).toBe('RAW');
    expect(sheets.tabs.get(7)?.[2][5]).toBe('=literal-not-a-formula');
  });

  it.each([false,true])('repeats only a moved-row read, bounded even when movement continues (%s)', async continuous => {
    const sheets=protocol();await client().sync(scope,values,true);sheets.tabs.get(7)!.push(['other']);sheets.calls.length=0;
    let reads=0;
    vi.stubGlobal('fetch',async (input:string|URL|Request,init?:RequestInit)=>{
      const response=await sheets.fetch(input,init);
      if(String(input).includes('/values:batchGetByDataFilter')) {
        reads++;
        if(continuous||reads===1){const row=sheets.metadata.get(sheetRowIdentity(scope).id)!.location.dimensionRange.startIndex;sheets.move(7,row,row===1?2:1);}
      }
      return response;
    });
    const result=await client().verify(scope,values);
    expect(writes(sheets)).toHaveLength(0);
    if(continuous){expect(result).toMatchObject({synced:false,problem:'SHEETS_ROW_MOVED_DURING_READ'});expect(reads).toBe(3);}
    else {expect(result).toMatchObject({synced:true,rowNumber:3});expect(reads).toBe(2);}
  });

  it('does not follow metadata moved to a different tab between check and update', async () => {
    const sheets = protocol(); await client().sync(scope, values);
    sheets.tabs.get(0)!.push(['another-task', 'protected']);
    sheets.beforeWrite = () => { sheets.metadata.get(sheetRowIdentity(scope).id)!.location.dimensionRange.sheetId = 0; };
    const next = [...values]; next[6] = 'new-hash';
    expect((await client().sync(scope, next)).synced).toBe(false);
    expect(sheets.tabs.get(0)?.[1]).toEqual(['another-task', 'protected']);
  });

  it('refuses a legacy unbound row without an unsafe metadata adoption or write', async () => {
    const sheets = protocol(); sheets.tabs.get(7)!.push([...values]);
    expect(await client().sync(scope, values)).toMatchObject({ synced: false, problem: 'SHEETS_LEGACY_ROW_NEEDS_MIGRATION' });
    expect(writes(sheets)).toHaveLength(0);
  });

  it('refuses a metadata hash collision without changing the other row', async () => {
    const sheets = protocol(); await client().sync(scope, values);
    sheets.metadata.get(sheetRowIdentity(scope).id)!.metadataValue = 'another-identity'; sheets.calls.length = 0;
    expect(await client().sync(scope, values)).toMatchObject({ synced: false, problem: 'SHEETS_ROW_IDENTITY_CONFLICT' });
    expect(writes(sheets)).toHaveLength(0);
  });

  it('refuses moved metadata pointing at another task', async () => {
    const sheets = protocol(); await client().sync(scope, values); sheets.tabs.get(7)!.push(['bystander']);
    const d = sheets.metadata.get(sheetRowIdentity(scope).id)!.location.dimensionRange; d.startIndex = 2; d.endIndex = 3;
    sheets.calls.length = 0;
    expect(await client().sync(scope, values)).toMatchObject({ synced: false, problem: 'SHEETS_ROW_IDENTITY_CONFLICT' });
    expect(writes(sheets)).toHaveLength(0);
  });

  it.each([0, 1, 2, 3, 4, 5, 6])('independent verification detects changed column %s', async column => {
    const sheets = protocol(); await client().sync(scope, values, true); sheets.tabs.get(7)![1][column] = 'tampered';
    sheets.calls.length = 0;
    expect((await client().verify(scope, values)).synced).toBe(false);
    expect(writes(sheets)).toHaveLength(0);
  });

  it('keeps an unavailable read uncertain without writing or leaking network errors', async () => {
    const sheets = protocol(); sheets.failRead = true;
    expect(await client().sync(scope, values)).toMatchObject({ synced: false, problem: 'SHEETS_HTTP_503' });
    expect(writes(sheets)).toHaveLength(0);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private-token-in-provider-message')));
    expect(await client().sync(scope, values)).toMatchObject({ synced: false, problem: 'SHEETS_READ_OR_WRITE_UNCONFIRMED' });
  });

  it('does not report a clean write when a collaborator changes the result before readback', async () => {
    const sheets = protocol(); sheets.afterWrite = () => { sheets.tabs.get(7)![1][5] = 'changed'; };
    expect(await client().sync(scope, values)).toMatchObject({ synced: false, problem: 'SHEETS_ROW_VALUES_DIFFER' });
  });

  it('refuses an oversized tab instead of claiming a partial scan is complete', async () => {
    const sheets = protocol(); sheets.tabs.set(7, Array.from({ length: 20_001 }, () => []));
    expect(await client().sync(scope, values)).toMatchObject({ synced: false, problem: 'SHEETS_SCAN_LIMIT' });
    expect(writes(sheets)).toHaveLength(0);
  });

  it('bounds response bytes and the total operation deadline', async () => {
    protocol(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(8 * 1024 * 1024 + 1))));
    expect(await client().sync(scope, values)).toMatchObject({ synced: false, problem: 'SHEETS_RESPONSE_TOO_LARGE' });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect(await new GoogleSheetRow('https://sheets.test', 'synthetic', '2000-01-01').sync(scope, values)).toMatchObject({ synced: false, problem: 'SHEETS_DEADLINE_EXCEEDED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses malformed tab and row data before any mutation', async () => {
    const sheets = protocol();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => url.includes('/values:batchGet') ? new Response(JSON.stringify({ spreadsheetId: scope.spreadsheetId, valueRanges: [{}] })) : sheets.fetch(url, init)));
    expect(await client().sync(scope, values)).toMatchObject({ synced: false, problem: 'SHEETS_RESPONSE_INVALID' });
    expect(writes(sheets)).toHaveLength(0);
  });
});
