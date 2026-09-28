import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { sniffBlobMediaType, taskGenerationBlocker } from '@hawa/contracts';
import type { Database } from '../types.js';
import { withRlsContext } from '../client.js';
import type { BlobStore } from '../blobs/store.js';

export interface StudioVisualAsset { key: string; bytes: Buffer }
export interface StudioVisualBundle { manifest: unknown; assets: StudioVisualAsset[] }
export interface StudioVisualScope { tenantId: string; actorId: string }
export class StudioVisualInputsError extends Error {
  readonly code = 'STUDIO_VISUAL_INPUTS_UNSAFE';
}
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
interface StoredManifest { manifest_text: string; manifest_sha256: string }
interface StoredAsset { asset_key: string; sha256: string; blob_sha256: string | null; bytes: Buffer | null }

/** Immutable visual basis, shared by every rendering/model boundary of one run. */
export class StudioVisualInputsRepository {
  constructor(private readonly db: Kysely<Database>, private readonly store: BlobStore | null = null) {}

  async get(s: StudioVisualScope, runId: string): Promise<StudioVisualBundle | null> {
    const saved = await withRlsContext(this.db, { tenantId: s.tenantId, userId: s.actorId }, async tx => {
      const row = (await sql<StoredManifest>`SELECT manifest_text,manifest_sha256 FROM hawa.studio_visual_inputs
        WHERE tenant_id=${s.tenantId}::uuid AND run_id=${runId}::uuid`.execute(tx)).rows[0];
      if (!row) return null;
      const assets = (await sql<StoredAsset>`SELECT asset_key,sha256,blob_sha256,bytes FROM hawa.studio_visual_input_assets
        WHERE tenant_id=${s.tenantId}::uuid AND run_id=${runId}::uuid ORDER BY asset_key`.execute(tx)).rows;
      return { row, assets };
    });
    if (!saved) return null;
    if (sha(saved.row.manifest_text) !== saved.row.manifest_sha256) throw new StudioVisualInputsError('The saved visual manifest failed its hash check.');
    const envelope = JSON.parse(saved.row.manifest_text) as { manifest: unknown; assets: Array<{ key: string; sha256: string }> };
    if (!Array.isArray(envelope.assets) || envelope.assets.length !== saved.assets.length) throw new StudioVisualInputsError('The visual asset set is incomplete.');
    const assets: StudioVisualAsset[] = [];
    for (const asset of saved.assets) {
      if (!envelope.assets.some(a => a.key === asset.asset_key && a.sha256 === asset.sha256)) throw new StudioVisualInputsError('The visual asset identity changed.');
      if (asset.blob_sha256 && !this.store) throw new StudioVisualInputsError('The pinned visual blob store is unavailable.');
      let bytes: Buffer | null;
      try { bytes = asset.blob_sha256 ? await this.store!.read(asset.blob_sha256, { verify: true }) : asset.bytes; }
      catch { throw new StudioVisualInputsError('Pinned visual bytes could not be read and verified.'); }
      if (!bytes || sha(bytes) !== asset.sha256) throw new StudioVisualInputsError('Pinned visual bytes are missing or corrupt.');
      assets.push({ key: asset.asset_key, bytes });
    }
    return { manifest: envelope.manifest, assets };
  }

  /** Serialize concurrent preparations on the run. Return the first committed bundle to every caller. */
  async pin(s: StudioVisualScope, runId: string, bundle: StudioVisualBundle): Promise<StudioVisualBundle> {
    if (!bundle.manifest || typeof bundle.manifest !== 'object' || Array.isArray(bundle.manifest)) throw new StudioVisualInputsError('Invalid visual manifest.');
    if (bundle.assets.length > 96 || new Set(bundle.assets.map(a => a.key)).size !== bundle.assets.length) throw new StudioVisualInputsError('Invalid visual asset count or duplicate key.');
    let total = 0;
    const prepared: Array<{ key: string; sha256: string; blob: string | null; bytes: Buffer | null }> = [];
    for (const asset of bundle.assets) {
      total += asset.bytes.length;
      const mime = sniffBlobMediaType(asset.bytes);
      if (!/^[a-z0-9/-]{1,80}$/.test(asset.key) || !asset.bytes.length || asset.bytes.length > 33554432 || total > 134217728 || !mime?.startsWith('image/')) {
        throw new StudioVisualInputsError('Visual asset exceeds its bound or has an unsupported format.');
      }
      const digest = sha(asset.bytes);
      const blob = this.store ? (await this.store.put(asset.bytes, mime)).sha256 : null;
      prepared.push({ key: asset.key, sha256: digest, blob, bytes: blob ? null : asset.bytes });
    }
    const manifestText = JSON.stringify({ manifest: bundle.manifest, assets: prepared.map(a => ({ key: a.key, sha256: a.sha256 })).sort((a,b) => a.key.localeCompare(b.key)) });
    if (Buffer.byteLength(manifestText) > 1048576) throw new StudioVisualInputsError('Visual manifest exceeds its bound.');
    await withRlsContext(this.db, { tenantId: s.tenantId, userId: s.actorId }, async tx => {
      const run = (await sql<{ status: string; state: string }>`SELECT r.status,t.state FROM hawa.design_studio_runs r
        JOIN hawa.tasks t ON t.id=r.task_id AND t.tenant_id=r.tenant_id AND t.client_id=r.client_id
        WHERE r.tenant_id=${s.tenantId}::uuid AND r.id=${runId}::uuid FOR UPDATE OF r,t`.execute(tx)).rows[0];
      if (!run || taskGenerationBlocker(run.state)) throw new StudioVisualInputsError('Current task authority does not permit visual preparation.');
      const existing = (await sql`SELECT run_id FROM hawa.studio_visual_inputs WHERE tenant_id=${s.tenantId}::uuid AND run_id=${runId}::uuid`.execute(tx)).rows[0];
      if (existing) return;
      if (run.status !== 'laying_out') throw new StudioVisualInputsError('A new visual basis can only be pinned before layout.');
      await sql`INSERT INTO hawa.studio_visual_inputs(tenant_id,run_id,manifest_text,manifest_sha256)
        VALUES(${s.tenantId}::uuid,${runId}::uuid,${manifestText},${sha(manifestText)})`.execute(tx);
      for (const asset of prepared) await sql`INSERT INTO hawa.studio_visual_input_assets(tenant_id,run_id,asset_key,sha256,blob_sha256,bytes)
        VALUES(${s.tenantId}::uuid,${runId}::uuid,${asset.key},${asset.sha256},${asset.blob},${asset.bytes})`.execute(tx);
    });
    const result = await this.get(s, runId);
    if (!result) throw new StudioVisualInputsError('The pinned visual basis is not accessible.');
    return result;
  }
}
