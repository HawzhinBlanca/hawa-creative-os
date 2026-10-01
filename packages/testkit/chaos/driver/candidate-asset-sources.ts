/** Actual deployed upload/download checks; all files and actors are synthetic. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, fakes, query, secrets, sql } from './stack.js';
import { KAAE_CLIENT_ID } from './provision.js';
import type { InvariantResult } from './scenario.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Asset = { assetId: string; sha256: string; sourceSha256: string; sizeBytes: number };
type Source = { filename: string; mimeType: string; original: Buffer; admitted: Buffer };

export async function retainCandidateAssetSources(origin: string, token: string, checks: InvariantResult[]) {
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    if (!ok) throw new Error(`${name}: ${detail}`);
  };
  const get = (path: string, credential = token) => fetch(`${origin}/v1${path}`, {
    headers: { Authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(15_000),
  });
  const clean = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="19" height="17"><rect width="19" height="17" fill="#34ef59"/></svg>');
  const original = (n: number) => Buffer.from(clean.toString().replace('</svg>', `<script>alert(${n})</script></svg>`));
  const sources: Source[] = [
    { filename: 'candidate-original-one.svg', mimeType: 'image/svg+xml', original: original(1), admitted: clean },
    { filename: 'candidate-original-two.svg', mimeType: 'image/svg+xml', original: original(2), admitted: clean },
    { filename: 'candidate-pixel.png', mimeType: 'image/png', original: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6uoAAAAASUVORK5CYII=', 'base64'), admitted: Buffer.alloc(0) },
    { filename: 'candidate-pixel.webp', mimeType: 'image/webp', original: Buffer.from('UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=', 'base64'), admitted: Buffer.alloc(0) },
    ...[['Inter-Regular.ttf', 'font/ttf'], ['inter-latin.woff2', 'font/woff2']].map(([filename, mimeType]) => ({
      filename, mimeType, original: readFileSync(join(REPO_ROOT, 'packages/creative/assets/fonts', filename)), admitted: Buffer.alloc(0),
    })),
  ];
  const beforeModels = (await fakes.modelLedger()).ledger.length;
  const [before] = await query<{ dna: string; approvals: string }>(sql`SELECT
    (SELECT content_hash FROM hawa.client_dna_versions WHERE client_id=${KAAE_CLIENT_ID}::uuid AND status='active') AS dna,
    (SELECT count(*) FROM hawa.approvals) AS approvals`);
  const records: Array<{ asset: Asset; source: Source }> = [];
  const upload = async (source: Source) => {
    const response = await fetch(`${origin}/v1/assets/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: KAAE_CLIENT_ID, filename: source.filename, mimeType: source.mimeType,
        category: 'qualification-source', contentBase64: source.original.toString('base64') }),
      signal: AbortSignal.timeout(20_000),
    });
    check(`deployed upload admits actual ${source.filename} bytes`, response.status === 201, `HTTP ${response.status}`);
    return await response.json() as Asset;
  };
  for (const source of sources) {
    if (!source.admitted.length) source.admitted = source.original;
    const asset = await upload(source);
    check(`deployed ${source.filename} hashes and measures actual bytes`, asset.sha256 === hash(source.admitted) &&
      asset.sourceSha256 === hash(source.original) && asset.sizeBytes === source.admitted.length,
    `admitted=${source.admitted.length} bytes; original=${source.original.length} bytes`);
    records.push({ asset, source });
  }
  const repeated = await upload(sources[0]);
  check('deployed source retry and distinct SVG originals reconcile one admitted identity',
    repeated.assetId === records[0].asset.assetId && records[1].asset.assetId === records[0].asset.assetId,
    'same asset; separate originals');
  const [after] = await query<{ dna: string; approvals: string }>(sql`SELECT
    (SELECT content_hash FROM hawa.client_dna_versions WHERE client_id=${KAAE_CLIENT_ID}::uuid AND status='active') AS dna,
    (SELECT count(*) FROM hawa.approvals) AS approvals`);
  check('deployed upload neither activates DNA nor creates approval/model evidence',
    before.dna === after.dna && before.approvals === after.approvals &&
    (await fakes.modelLedger()).ledger.length === beforeModels, 'no model call or authority promotion');

  const identity = async () => (await query(sql`SELECT asset_id,source_sha256,filename,uploaded_by,created_at
    FROM hawa.uploaded_asset_sources WHERE client_id=${KAAE_CLIENT_ID}::uuid
      AND asset_id=ANY(${[...new Set(records.map(r => r.asset.assetId))]}::uuid[])
    ORDER BY asset_id,source_sha256`));
  const receipts = await identity();
  check('deployed originals have six actual immutable source receipts', receipts.length === sources.length,
    `${receipts.length} source receipts`);
  const originalIdentity = JSON.stringify(receipts);
  const verify = async (phase: string) => {
    for (const { asset, source } of records) {
      for (const original of [false, true]) {
        const path = `/assets/${asset.assetId}/${original ? `sources/${asset.sourceSha256}/` : ''}content`;
        const response = await get(path), expected = original ? source.original : source.admitted;
        check(`${phase}: ${source.filename} ${original ? 'original' : 'admitted'} survives verified download`,
          response.status === 200 && hash(Buffer.from(await response.arrayBuffer())) === hash(expected) &&
          response.headers.get('X-Content-SHA256') === hash(expected), `HTTP ${response.status}; ${expected.length} bytes`);
        check(`${phase}: ${source.filename} download retains private sandbox headers through nginx`,
          response.headers.get('Content-Security-Policy')?.includes('sandbox') === true &&
          response.headers.get('Cache-Control')?.includes('no-store') === true &&
          response.headers.get('Content-Disposition')?.startsWith('attachment;') === true &&
          (!original || response.headers.get('Content-Type') === 'application/octet-stream'), 'attachment / sandbox / no-store');
      }
    }
    check(`${phase}: immutable source receipts retain identity and original actors/timestamps`,
      JSON.stringify(await identity()) === originalIdentity, `${records.length} original-source receipts`);
    const response = await get(`/assets/${records[0].asset.assetId}/sources/${'a'.repeat(64)}/content`);
    check(`${phase}: an unknown source hash grants no content access`, response.status === 404, `HTTP ${response.status}`);
    const denied = await get(`/assets/${records[0].asset.assetId}/content`, secrets().CHAOS_DESIGN_WORKER_TOKEN);
    check(`${phase}: the restricted worker cannot use the office asset download route`,
      [401, 403].includes(denied.status), `HTTP ${denied.status}`);
  };
  await verify('before restore');
  return verify;
}
