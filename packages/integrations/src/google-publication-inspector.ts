import { createHash } from 'node:crypto';
import type { PublicationInspectionInput, PublicationExternalObservation, DriveItemObservation, PermissionObservation } from '@hawa/contracts';
import { parsePublicationExpectation } from '@hawa/contracts';
import { GoogleSheetRow, sheetRowIdentity } from './google-sheet-row.js';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 2000;
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const permissionUnknown = (code: string): PermissionObservation => ({ status: 'unavailable', sha256: null, count: null, code });
const safeCode = (error: unknown) => error instanceof Error && /^GOOGLE_[A-Z_0-9]+$/.test(error.message) ? error.message : 'GOOGLE_READ_UNAVAILABLE';

/** A separate read path: never calls publish(), writes a row or trusts a process receipt. */
export class GooglePublicationInspector {
  private deadline: number;
  private calls = 0;
  constructor(private readonly config: { driveBaseUrl: string; sheetsBaseUrl: string; token: string | null; deadline: string }) {
    this.deadline = Math.min(Date.now() + 90_000, Date.parse(config.deadline));
    if (!Number.isFinite(this.deadline)) this.deadline = Date.now();
  }

  private async read(path: string): Promise<Record<string, unknown>> {
    const remaining = this.deadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || ++this.calls > 1000) throw new Error('GOOGLE_INSPECTION_LIMIT');
    if (!this.config.token) throw new Error('GOOGLE_CREDENTIALS_UNAVAILABLE');
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new Error('GOOGLE_READ_TIMEOUT'));
    }, Math.min(10_000, Math.ceil(remaining))); timer.unref?.(); });
    try {
      const response = await Promise.race([fetch(`${this.config.driveBaseUrl}/drive/v3/${path}`, {
        method: 'GET', headers: { Authorization: `Bearer ${this.config.token}` }, redirect: 'error', signal: controller.signal,
      }), timeout]);
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error(`GOOGLE_HTTP_${response.status}`); }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 1024 * 1024)) throw new Error('GOOGLE_RESPONSE_LIMIT');
      reader = response.body?.getReader(); if (!reader) throw new Error('GOOGLE_RESPONSE_INVALID');
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const part = await Promise.race([reader.read(), timeout]); if (part.done) break;
        size += part.value.byteLength; if (size > 1024 * 1024) throw new Error('GOOGLE_RESPONSE_LIMIT'); chunks.push(part.value);
      }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!object(data)) throw new Error('GOOGLE_RESPONSE_INVALID');
      return data;
    } finally { clearTimeout(timer!); controller.abort(); void reader?.cancel().catch(() => undefined); }
  }

  private async permissionPass(id: string): Promise<{ sha256: string; count: number }> {
    const entries: unknown[] = [], ids = new Set<string>(), tokens = new Set<string>(); let token = '';
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({ supportsAllDrives: 'true', pageSize: '100',
        fields: 'nextPageToken,permissions(id,type,role,deleted,allowFileDiscovery,expirationTime,permissionDetails(permissionType,role,inherited,inheritedFrom))',
        ...(token ? { pageToken: token } : {}) });
      const result = await this.read(`files/${encodeURIComponent(id)}/permissions?${query}`);
      if (!Array.isArray(result.permissions) || result.permissions.length > 100) throw new Error('GOOGLE_PERMISSIONS_INVALID');
      for (const p of result.permissions) {
        if (!object(p) || !text(p.id) || ids.has(p.id) || !['user','group','domain','anyone'].includes(String(p.type)) ||
          !['owner','organizer','fileOrganizer','writer','commenter','reader'].includes(String(p.role)) ||
          p.deleted !== undefined && typeof p.deleted !== 'boolean' || p.allowFileDiscovery !== undefined && typeof p.allowFileDiscovery !== 'boolean' ||
          p.expirationTime !== undefined && (typeof p.expirationTime !== 'string' || !Number.isFinite(Date.parse(p.expirationTime)))) throw new Error('GOOGLE_PERMISSIONS_INVALID');
        const details = p.permissionDetails ?? [];
        if (!Array.isArray(details) || details.length > 100 || !details.every(d => object(d) && text(d.permissionType) && text(d.role) &&
          typeof d.inherited === 'boolean' && (d.inheritedFrom === undefined || text(d.inheritedFrom)))) throw new Error('GOOGLE_PERMISSIONS_INVALID');
        const normalized = details.map(d => [d.permissionType, d.role, d.inherited, d.inheritedFrom ?? null]);
        normalized.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
        entries.push([p.id, p.type, p.role, p.deleted ?? false, p.allowFileDiscovery ?? false, p.expirationTime ?? null, normalized]);
        ids.add(p.id);
      }
      if (result.nextPageToken === undefined) {
        entries.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
        return { sha256: hash(entries), count: entries.length };
      }
      if (!text(result.nextPageToken) || tokens.has(result.nextPageToken)) throw new Error('GOOGLE_PERMISSIONS_PAGINATION');
      token = result.nextPageToken; tokens.add(token);
    }
    throw new Error('GOOGLE_PERMISSIONS_LIMIT');
  }

  private async permissions(id: string): Promise<PermissionObservation> {
    try {
      const first = await this.permissionPass(id), second = await this.permissionPass(id);
      if (first.sha256 !== second.sha256) throw new Error('GOOGLE_PERMISSIONS_CHANGED_DURING_READ');
      return { status: 'observed', ...second };
    } catch (error) { return permissionUnknown(safeCode(error)); }
  }

  private async item(id: string): Promise<DriveItemObservation> {
    let permissions = permissionUnknown('GOOGLE_ITEM_UNAVAILABLE');
    try {
      const path = `files/${encodeURIComponent(id)}?${new URLSearchParams({ supportsAllDrives: 'true',
        fields: 'id,name,mimeType,size,sha256Checksum,trashed,parents,driveId,properties,version' })}`;
      const item = await this.read(path);
      const parents = item.parents ?? [];
      if (item.id !== id || !text(item.name) || !text(item.mimeType) || typeof item.trashed !== 'boolean' ||
        !text(item.version) || !/^\d+$/.test(item.version) || !Array.isArray(parents) ||
        !parents.every(text) || item.driveId !== undefined && !text(item.driveId) ||
        item.size !== undefined && (typeof item.size !== 'string' || !/^\d+$/.test(item.size) || !Number.isSafeInteger(Number(item.size))) ||
        item.sha256Checksum !== undefined && !sha(item.sha256Checksum) || !object(item.properties ?? {}) ||
        !Object.values(item.properties ?? {}).every(v => typeof v === 'string')) throw new Error('GOOGLE_ITEM_INVALID');
      permissions = await this.permissions(id);
      const after = await this.read(path);
      const fingerprint = (v: Record<string, unknown>) => hash([v.id,v.name,v.mimeType,v.size ?? null,v.sha256Checksum ?? null,
        v.trashed,v.parents ?? [],v.driveId ?? '',v.version,object(v.properties) ? Object.entries(v.properties).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0) : []]);
      if (fingerprint(after) !== fingerprint(item)) throw new Error('GOOGLE_ITEM_CHANGED_DURING_READ');
      return { resourceId: id, status: 'observed', permissions, item: { id, name: item.name, mimeType: item.mimeType,
        size: item.size === undefined ? null : Number(item.size), sha256: item.sha256Checksum as string | undefined ?? null,
        trashed: item.trashed, parents: (item.parents ?? []) as string[], sharedDriveId: item.driveId as string | undefined ?? '',
        properties: (item.properties ?? {}) as Record<string, string>, version: item.version } };
    } catch (error) { return { resourceId: id, status: 'unavailable', code: safeCode(error), permissions }; }
  }

  private async duplicates(input: PublicationInspectionInput): Promise<PublicationExternalObservation['duplicates']> {
    try {
      const original = input.original!;
      const literal = (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const q = `'${literal(original.destination.productionRootFolderId)}' in parents and trashed=false and ` +
        `properties has { key='taskId' and value='${literal(input.taskId)}' } and properties has { key='packageHash' and value='${literal(original.packageHash)}' }`;
      const ids = new Set<string>(), tokens = new Set<string>(); let token = '';
      for (let page = 0; page < 10; page++) {
        const result = await this.read(`files?${new URLSearchParams({ q, spaces: 'drive', pageSize: '100', supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true', fields: 'nextPageToken,incompleteSearch,files(id)',
          ...(original.destination.sharedDriveId ? { corpora: 'drive', driveId: original.destination.sharedDriveId } : { corpora: 'user' }),
          ...(token ? { pageToken: token } : {}) })}`);
        if (result.incompleteSearch !== false || !Array.isArray(result.files) || result.files.length > 100) throw new Error('GOOGLE_SEARCH_INCOMPLETE');
        for (const file of result.files) {
          if (!object(file) || !text(file.id) || ids.has(file.id)) throw new Error('GOOGLE_SEARCH_INVALID');
          ids.add(file.id);
        }
        if (result.nextPageToken === undefined) return { status: 'observed', fileIds: [...ids].sort() };
        if (!text(result.nextPageToken) || tokens.has(result.nextPageToken)) throw new Error('GOOGLE_SEARCH_PAGINATION');
        token = result.nextPageToken; tokens.add(token);
      }
      throw new Error('GOOGLE_SEARCH_LIMIT');
    } catch (error) { return { status: 'unavailable', fileIds: [], code: safeCode(error) }; }
  }

  async inspect(input: PublicationInspectionInput): Promise<PublicationExternalObservation> {
    const result: PublicationExternalObservation = { schemaVersion: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      folder: null, files: [], duplicates: { status: 'unavailable', fileIds: [], code: 'GOOGLE_INPUT_UNAVAILABLE' }, sheet: null };
    const original = parsePublicationExpectation(input.original);
    if (!original || input.schemaVersion !== 1 || original.tenantId !== input.tenantId || original.publicationId !== input.publicationId ||
      original.taskId !== input.taskId || original.clientId !== input.clientId || input.files.length !== original.files.length ||
      input.files.some(file => !original.files.some(expected => expected.artifactId === file.artifactId) || file.fileId !== null && !text(file.fileId)) ||
      new Set(input.files.map(f => f.artifactId)).size !== input.files.length) return result;
    if (input.sheet) {
      const s = input.sheet, identity = sheetRowIdentity({ tenantId: input.tenantId, taskId: input.taskId, spreadsheetId: s.spreadsheetId, sheetId: s.sheetId });
      if (s.tenantId !== input.tenantId || s.publicationId !== input.publicationId || s.taskId !== input.taskId || s.clientId !== input.clientId ||
        s.metadataId !== identity.id || s.metadataValue !== identity.value || hash(s.expectedValues) !== input.sheetRowSha256) return result;
    }
    result.folder = await this.item(original.destination.productionRootFolderId);
    for (const file of input.files) if (file.fileId) result.files.push(await this.item(file.fileId));
    result.duplicates = await this.duplicates(input);
    if (input.sheet) {
      const s = input.sheet;
      const row = this.config.token ? await new GoogleSheetRow(this.config.sheetsBaseUrl, this.config.token, new Date(this.deadline).toISOString())
        .verify({ tenantId: input.tenantId, taskId: input.taskId, spreadsheetId: s.spreadsheetId, sheetId: s.sheetId }, s.expectedValues) : { synced: false, problem: 'SHEETS_CREDENTIALS_UNAVAILABLE' };
      const definite = row.synced || ['SHEETS_ROW_VALUES_DIFFER','SHEETS_ROW_NOT_FOUND','SHEETS_ROW_IDENTITY_CONFLICT','SHEETS_DUPLICATE_TASK'].includes(row.problem ?? '');
      result.sheet = { status: definite ? 'observed' : 'unavailable', metadataId: row.metadataId ?? null, rowNumber: row.rowNumber ?? null,
        rowSha256: row.observedRowHash ?? null, ...(row.problem ? { code: row.problem } : {}), permissions: await this.permissions(s.spreadsheetId) };
    }
    result.finishedAt = new Date().toISOString(); return result;
  }
}
