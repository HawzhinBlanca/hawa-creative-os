/**
 * Uploaded assets as Postgres keeps them: one hawa.brand_assets row per client and content hash
 * (FR-018: hashed and indexed with provenance). They were kept in a map in the process that received
 * them, so the asset list and search forgot them at every restart and no other Core ever had them
 * (architecture programme 1.3, the cleanup step of SPLIT_PLAN.md section 7). The bytes are not kept:
 * the upload is checked, and an SVG sanitised, and the row records what was admitted.
 */
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { searchWords } from './search-history.js';

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
}

const COLUMNS = sql.raw('id, client_id, kind, name, mime_type, sha256, storage_key, metadata, created_at');

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
  };
};

/**
 * Records an admitted upload for a client (its Postgres id). The same file sent again for the same
 * client is the asset already recorded, not a second one.
 */
export async function saveUploadedAsset(
  db: Kysely<Database>,
  scope: Scope,
  asset: { clientId: string; category: string; filename: string; mimeType: string; sha256: string; sanitized: boolean; uploadedBy: string }
): Promise<UploadedAsset> {
  const metadata = JSON.stringify({ sanitized: asset.sanitized, uploadedBy: asset.uploadedBy, source: 'assets/upload' });
  const row = await withRlsContext(db, { ...scope, clientId: asset.clientId }, async (trx) =>
    (await sql<AssetRow>`INSERT INTO hawa.brand_assets (tenant_id, client_id, kind, name, mime_type, sha256, metadata)
      VALUES (${scope.tenantId}::uuid, ${asset.clientId}::uuid, ${asset.category}, ${asset.filename}, ${asset.mimeType}, ${asset.sha256}, ${metadata}::jsonb)
      ON CONFLICT (client_id, sha256) DO UPDATE SET updated_at = now()
      RETURNING ${COLUMNS}`.execute(trx)).rows[0]);
  return assetFromRow(row);
}

/** The tenant's uploaded assets, newest first; only one client's when `clientId` (its Postgres id) is given. */
export async function listUploadedAssets(db: Kysely<Database>, scope: Scope, clientId?: string): Promise<UploadedAsset[]> {
  const rows = await withRlsContext(db, scope, async (trx) =>
    (await sql<AssetRow>`SELECT ${COLUMNS} FROM hawa.brand_assets
      WHERE tenant_id = ${scope.tenantId}::uuid AND status = 'active'
        ${clientId ? sql`AND client_id = ${clientId}::uuid` : sql``}
      ORDER BY created_at DESC LIMIT 500`.execute(trx)).rows);
  return rows.map(assetFromRow);
}

/** Match authorized active assets before the search bound; inventory listing remains separate. */
export async function searchUploadedAssets(db: Kysely<Database>, scope: Scope, query: string, clientId?: string) {
  const configured = Number(process.env.HAWA_SEARCH_ASSET_CEILING);
  const ceiling = Number.isFinite(configured) && configured > 0
    ? Math.max(1, Math.min(20_000, Math.floor(configured))) : 5_000;
  const rows = await withRlsContext(db, { ...scope, ...(clientId ? { clientId } : {}) }, async trx =>
    (await sql<AssetRow>`SELECT ${COLUMNS} FROM hawa.brand_assets
      WHERE tenant_id=${scope.tenantId}::uuid AND status='active'
        ${clientId ? sql`AND client_id=${clientId}::uuid` : sql``}
        AND ${searchWords(sql`concat_ws(' ',id::text,name,mime_type,kind,sha256)`, query)}
      ORDER BY created_at DESC,id DESC LIMIT ${ceiling + 1}`.execute(trx)).rows);
  return { items: rows.slice(0, ceiling).map(assetFromRow), truncated: rows.length > ceiling };
}
