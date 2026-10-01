/**
 * Uploaded assets as Postgres keeps them: one hawa.brand_assets row per client and content hash
 * (FR-018: hashed and indexed with provenance). They were kept in a map in the process that received
 * them, so the asset list and search forgot them at every restart and no other Core ever had them
 * (architecture programme 1.3, the cleanup step of SPLIT_PLAN.md section 7). ADR218 retains verified
 * admitted bytes and append-only original receipts in the existing content-addressed store.
 */
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { searchWords } from './search-history.js';
import { blobRelPath, type BlobRef } from '@hawa/contracts';

type Scope = { tenantId: string; userId?: string; role?: string };

/** An uploaded asset as the asset routes answer with it. */
export interface UploadedAsset {
  assetId: string;
  clientId: string;
  category: string;
  filename: string;
  mimeType: string;
  sha256: string;
  storageKey: string | null;
  sanitized: boolean;
  createdAt: string;
  sizeBytes?: number;
}

interface AssetRow {
  id: string;
  client_id: string;
  kind: string;
  name: string;
  mime_type: string;
  sha256: string;
  storage_key: string | null;
  metadata: unknown;
  created_at: Date | string;
  blob_sha256: string | null;
  size_bytes?: string | number | null;
}

const COLUMNS = sql.raw('a.id, a.client_id, a.kind, a.name, a.mime_type, a.sha256, a.storage_key, a.metadata, a.created_at, a.blob_sha256, b.size AS size_bytes');

const assetFromRow = (row: AssetRow): UploadedAsset => {
  const metadata = (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as { sanitized?: unknown };
  return {
    assetId: row.id,
    clientId: row.client_id,
    category: row.kind,
    filename: row.name,
    mimeType: row.mime_type,
    sha256: row.sha256,
    storageKey: row.storage_key,
    sanitized: metadata.sanitized === true,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    ...(row.size_bytes != null ? {sizeBytes:Number(row.size_bytes)} : {}),
  };
};

/**
 * Records an admitted upload for a client (its Postgres id). The same file sent again for the same
 * client is the asset already recorded, not a second one.
 */
export async function saveUploadedAsset(
  db: Kysely<Database>,
  scope: Scope,
  asset: { clientId: string; category: string; filename: string; blob: BlobRef; source: BlobRef; sanitized: boolean; uploadedBy: string }
): Promise<UploadedAsset> {
  const metadata = JSON.stringify({ sanitized: asset.sanitized, uploadedBy: asset.uploadedBy, source: 'assets/upload' });
  return withRlsContext(db, { ...scope, clientId: asset.clientId }, async trx => {
    const allowed = await trx.selectFrom('clients').select('id').where('tenant_id','=',scope.tenantId).where('id','=',asset.clientId)
      .where('status','=','active').where(sql<boolean>`hawa.can_write_client(${scope.tenantId}::uuid,${asset.clientId}::uuid)`)
      .forShare().executeTakeFirst();
    if (!allowed) throw new Error('ASSET_CLIENT_UNAVAILABLE');
    const result = await sql<{id:string}>`INSERT INTO hawa.brand_assets(tenant_id,client_id,kind,name,mime_type,sha256,blob_sha256,storage_key,metadata)
      VALUES(${scope.tenantId}::uuid,${asset.clientId}::uuid,${asset.category},${asset.filename},${asset.blob.mediaType},${asset.blob.sha256},
        ${asset.blob.sha256},${blobRelPath(asset.blob)},${metadata}::jsonb)
      ON CONFLICT(client_id,sha256) DO UPDATE SET blob_sha256=EXCLUDED.blob_sha256,storage_key=EXCLUDED.storage_key,updated_at=now()
      WHERE hawa.brand_assets.tenant_id=EXCLUDED.tenant_id AND hawa.brand_assets.mime_type=EXCLUDED.mime_type RETURNING id`.execute(trx);
    const id=result.rows[0]?.id;
    if (!id) throw new Error('ASSET_IDENTITY_CONFLICT');
    await sql`INSERT INTO hawa.uploaded_asset_sources(tenant_id,client_id,asset_id,source_sha256,filename,uploaded_by)
      VALUES(${scope.tenantId}::uuid,${asset.clientId}::uuid,${id}::uuid,${asset.source.sha256},${asset.filename},${asset.uploadedBy})
      ON CONFLICT(tenant_id,asset_id,source_sha256) DO NOTHING`.execute(trx);
    const row=(await sql<AssetRow>`SELECT ${COLUMNS} FROM hawa.brand_assets a LEFT JOIN hawa.blobs b ON b.sha256=a.blob_sha256
      WHERE a.tenant_id=${scope.tenantId}::uuid AND a.id=${id}::uuid`.execute(trx)).rows[0];
    return assetFromRow(row);
  });
}

/** The tenant's uploaded assets, newest first; only one client's when `clientId` (its Postgres id) is given. */
export async function listUploadedAssets(db: Kysely<Database>, scope: Scope, clientId?: string): Promise<UploadedAsset[]> {
  const rows = await withRlsContext(db, scope, async (trx) =>
    (await sql<AssetRow>`SELECT ${COLUMNS} FROM hawa.brand_assets a LEFT JOIN hawa.blobs b ON b.sha256=a.blob_sha256
      WHERE a.tenant_id = ${scope.tenantId}::uuid AND a.status = 'active'
        ${clientId ? sql`AND a.client_id = ${clientId}::uuid` : sql``}
      ORDER BY a.created_at DESC,a.id DESC LIMIT 500`.execute(trx)).rows);
  return rows.map(assetFromRow);
}

/** Match authorized active assets before the search bound; inventory listing remains separate. */
export async function searchUploadedAssets(db: Kysely<Database>, scope: Scope, query: string, clientId?: string) {
  const configured = Number(process.env.HAWA_SEARCH_ASSET_CEILING);
  const ceiling = Number.isFinite(configured) && configured > 0
    ? Math.max(1, Math.min(20_000, Math.floor(configured))) : 5_000;
  const rows = await withRlsContext(db, { ...scope, ...(clientId ? { clientId } : {}) }, async trx =>
    (await sql<AssetRow>`SELECT ${COLUMNS} FROM hawa.brand_assets a LEFT JOIN hawa.blobs b ON b.sha256=a.blob_sha256
      WHERE a.tenant_id=${scope.tenantId}::uuid AND a.status='active'
        ${clientId ? sql`AND a.client_id=${clientId}::uuid` : sql``}
        AND ${searchWords(sql`concat_ws(' ',a.id::text,a.name,a.mime_type,a.kind,a.sha256)`, query)}
      ORDER BY a.created_at DESC,a.id DESC LIMIT ${ceiling + 1}`.execute(trx)).rows);
  return { items: rows.slice(0, ceiling).map(assetFromRow), truncated: rows.length > ceiling };
}

/** Authorize a stored asset/receipt before resolving a global content-addressed file. */
export async function uploadedAssetContent(db: Kysely<Database>, scope: Scope, id: string, sourceSha256?: string) {
  return withRlsContext(db, scope, async trx => {
    const row=(await sql<{sha256:string|null;media_type:string|null;size:string|null;filename:string}>`
      SELECT ${sourceSha256 ? sql`s.source_sha256` : sql`a.blob_sha256`} AS sha256,b.media_type,b.size,
        ${sourceSha256 ? sql`s.filename` : sql`a.name`} AS filename FROM hawa.brand_assets a
        ${sourceSha256 ? sql`JOIN hawa.uploaded_asset_sources s ON s.tenant_id=a.tenant_id AND s.asset_id=a.id AND s.client_id=a.client_id AND s.source_sha256=${sourceSha256}` : sql``}
        LEFT JOIN hawa.blobs b ON b.sha256=${sourceSha256 ? sql`s.source_sha256` : sql`a.blob_sha256`}
        WHERE a.tenant_id=${scope.tenantId}::uuid AND a.id=${id}::uuid`.execute(trx)).rows[0];
    return row;
  });
}
