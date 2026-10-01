import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, BlobStore, runBlobGc } from '@hawa/db';
import { readFileSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/app.js';
const interruption = vi.hoisted(() => ({ point: '', action: undefined as undefined | (() => Promise<void>) }));
vi.mock('@hawa/observability', async importOriginal => ({
  ...await importOriginal<typeof import('@hawa/observability')>(),
  chaosPoint: async (point: string) => {
    if (point === interruption.point && interruption.action) {
      const action = interruption.action; interruption.action = undefined; await action();
    }
  },
}));
const db = createDb(process.env.TEST_DATABASE_URL!), owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenant = '00000000-0000-4000-a000-000000000001', client = randomUUID();
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
const core = () => createApp({ db, testAuth: { principal: { role: 'operator' } } });
const upload = (body: Record<string, unknown>, instance = core()) => instance.request('/v1/assets/upload', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: client, ...body }),
});
type Asset = {assetId:string;sha256:string;sourceSha256:string;storageKey:string;sizeBytes:number;filename:string};
async function saved(body: Record<string,unknown>, instance=core()):Promise<Asset> {
  const response=await upload(body,instance);expect(response.status).toBe(201);return response.json();
}
const svgBody=(name:string,content=svg)=>({filename:name,mimeType:'image/svg+xml',content});
const store=()=>new BlobStore({db,root:process.env.HAWA_BLOB_DIR!});
afterEach(()=>{vi.unstubAllEnvs();interruption.point='';interruption.action=undefined;});
beforeAll(async () => {
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${client}::uuid,${tenant}::uuid,${client},'Source asset fixture')`.execute(owner);
});
afterAll(async () => { await db.destroy(); await owner.destroy(); });
it('does not admit metadata as a content-hashed upload when no bytes were supplied', async () => {
  const response = await upload({ filename: 'no-content.png', mimeType: 'image/png', sizeBytes: 100 });
  expect(response.status).toBe(422);
  const rows = await sql<{ n: string }>`SELECT count(*) AS n FROM hawa.brand_assets WHERE client_id=${client}::uuid AND name='no-content.png'`.execute(owner);
  expect(Number(rows.rows[0].n)).toBe(0);
});
it('retains real SVG bytes and serves their verified content after a cold Core restart', async () => {
  const response = await upload({ filename: 'original-mark.svg', mimeType: 'image/svg+xml', content: svg });
  expect(response.status).toBe(201);
  const record = await response.json() as {assetId:string;sha256:string;storageKey:string|null;sizeBytes:number};
  expect(record.sha256).toBe(digest(svg));
  expect(record.storageKey).not.toBeNull();
  expect(record.sizeBytes).toBe(Buffer.byteLength(svg));
  const reopened = await core().request(`/v1/assets/${record.assetId}/content`);
  expect(reopened.status).toBe(200);
  expect(await reopened.text()).toBe(svg);
  expect(reopened.headers.get('X-Content-SHA256')).toBe(digest(svg));
});
it('hashes the actual supplied binary bytes rather than filename and claimed size', async () => {
  // A real one-pixel PNG, not a magic-header-only placeholder.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6uoAAAAASUVORK5CYII=', 'base64');
  const response = await upload({ filename: 'source-pixel.png', mimeType: 'image/png', contentBase64: png.toString('base64') });
  expect(response.status).toBe(201);
  expect((await response.json()).sha256).toBe(digest(png));
});
it('decodes and recovers real JPEG and WebP source bytes',async()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6uoAAAAASUVORK5CYII=','base64');
  const jpeg=execFileSync('ffmpeg',['-v','error','-i','pipe:0','-frames:v','1','-c:v','mjpeg','-f','image2pipe','pipe:1'],{input:png,timeout:5000,maxBuffer:1024*1024});
  // Synthetic two-pixel red WebP generated once with the bundled Pillow runtime;
  // Core needs the existing decoder, not an optional WebP encoder.
  const webp=Buffer.from('UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=','base64');
  for(const [bytes,mimeType,extension] of [[jpeg,'image/jpeg','jpg'],[webp,'image/webp','webp']] as const) {
    const record=await saved({filename:'pixel.'+extension,mimeType,contentBase64:bytes.toString('base64')});
    expect(record.sha256).toBe(digest(bytes));expect(record.sizeBytes).toBe(bytes.length);
    const response=await core().request(`/v1/assets/${record.assetId}/content`);
    expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  }
});
it('rejects oversized pixel and declared font expansion before storing an asset',async()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6uoAAAAASUVORK5CYII=','base64');
  png.writeUInt32BE(100000,16);png.writeUInt32BE(100000,20);
  png.writeUInt32BE(0x025bc343,29); // Correct CRC for the modified IHDR dimensions.
  const woff=readFileSync(new URL('../../../packages/creative/assets/fonts/inter-latin.woff2',import.meta.url));
  woff.writeUInt32BE(100*1024*1024,16);
  for(const [bytes,mimeType] of [[png,'image/png'],[woff,'font/woff2']] as const)
    expect((await upload({filename:'expansion',mimeType,contentBase64:bytes.toString('base64')})).status).toBe(422);
  const rows=await sql<{n:string}>`SELECT count(*) AS n FROM hawa.blobs WHERE sha256 IN(${digest(png)},${digest(woff)})`.execute(owner);
  expect(rows.rows[0].n).toBe('0');
});
it('denies auditor uploads before writing any bytes',async()=>{
  const user=randomUUID(),bytes=svg.replace('red','cyan');
  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${user}::uuid,${user+'@example.test'},'Read only auditor')`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${user}::uuid,'auditor')`.execute(owner);
  const readonly=createApp({db,testAuth:{principal:{role:'auditor',userId:user}}});
  expect((await upload(svgBody('auditor.svg',bytes),readonly)).status).toBe(404);
  const rows=await sql<{n:string}>`SELECT count(*) AS n FROM hawa.blobs WHERE sha256=${digest(bytes)}`.execute(owner);
  expect(rows.rows[0].n).toBe('0');
});
it('refuses a second upload while inspection is held and admits its retry after release',async()=>{
  let signalReached!:()=>void,release!:()=>void;
  const reached=new Promise<void>(resolve=>{signalReached=resolve;});
  const held=new Promise<void>(resolve=>{release=resolve;});
  interruption.point='core.assets.after-bytes';interruption.action=async()=>{signalReached();await held;};
  const instance=core(),body=svgBody('bounded.svg',svg.replace('red','pink')),pending=upload(body,instance);
  try {await reached;expect((await upload(body,instance)).status).toBe(503);}
  finally {release();}
  const first=await pending;expect(first.status).toBe(201);
  expect((await saved(body,instance)).assetId).toBe((await first.json()).assetId);
});
it('reconciles interrupted responses before and after receipt commit without duplicate admission',async()=>{
  for(const point of ['core.assets.after-bytes','core.assets.after-receipt']) {
    const bytes=svg.replace('red',point.endsWith('bytes')?'lime':'teal'),body=svgBody('interrupted.svg',bytes);
    interruption.point=point;interruption.action=async()=>{throw new Error('Injected response interruption');};
    expect((await upload(body)).status).toBe(503);
    const before=await sql<{n:string}>`SELECT count(*) AS n FROM hawa.brand_assets WHERE client_id=${client}::uuid AND sha256=${digest(bytes)}`.execute(owner);
    expect(before.rows[0].n).toBe(point.endsWith('bytes')?'0':'1');
    const record=await saved(body),retry=await saved(body);expect(retry.assetId).toBe(record.assetId);
    const sources=await (await core().request(`/v1/assets/${record.assetId}/sources`)).json();expect(sources.items).toHaveLength(1);
    expect(await (await core().request(`/v1/assets/${record.assetId}/content`)).text()).toBe(bytes);
  }
});
it('retains each original separately when different SVG originals sanitize to one admitted asset',async()=>{
  const clean=svg.replace('width="10" height="10"','width="11" height="11"');
  const first=clean.replace('</svg>','<script>alert(1)</script></svg>'), second=clean.replace('</svg>','<script>alert(2)</script></svg>');
  const a=await saved(svgBody('source-one.svg',first)),b=await saved(svgBody('source-two.svg',second));
  expect(a.assetId).toBe(b.assetId);expect(a.sha256).toBe(digest(clean));expect(a.sourceSha256).toBe(digest(first));
  const safe=await core().request(`/v1/assets/${a.assetId}/content`);expect(await safe.text()).toBe(clean);
  for(const original of [first,second]) {
    const source=await core().request(`/v1/assets/${a.assetId}/sources/${digest(original)}/content`);
    expect(source.status).toBe(200);expect(await source.text()).toBe(original);
    expect(source.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(source.headers.get('Content-Security-Policy')).toContain('sandbox');
  }
  const sources=await (await core().request(`/v1/assets/${a.assetId}/sources`)).json();
  expect(sources.items.map((s:{sourceSha256:string})=>s.sourceSha256).sort()).toEqual([digest(first),digest(second)].sort());
  expect(sources.truncated).toBe(false);
});
it('reconciles repeated and concurrent cold uploads to one asset and one original receipt',async()=>{
  const original=svg.replace('red','blue');
  const first=await saved(svgBody('first-name.svg',original));
  const repeated=await Promise.all([saved(svgBody('second-name.svg',original)),saved(svgBody('third-name.svg',original))]);
  expect(repeated.map(r=>r.assetId)).toEqual([first.assetId,first.assetId]);
  expect(repeated.map(r=>r.filename)).toEqual(['first-name.svg','first-name.svg']);
  const counts=await sql<{assets:string;sources:string}>`SELECT
    (SELECT count(*) FROM hawa.brand_assets WHERE client_id=${client}::uuid AND sha256=${first.sha256}) AS assets,
    (SELECT count(*) FROM hawa.uploaded_asset_sources WHERE asset_id=${first.assetId}::uuid) AS sources`.execute(owner);
  expect(counts.rows[0]).toEqual({assets:'1',sources:'1'});
});
it('never grants source access by knowing a shared hash or another client asset ID',async()=>{
  const peer=randomUUID(),user=randomUUID(),foreignTenant=randomUUID(),foreignClient=randomUUID();
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${peer}::uuid,${tenant}::uuid,${peer},'Peer asset')`.execute(owner);
  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${user}::uuid,${user+'@example.test'},'Scoped asset designer')`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${user}::uuid,'designer')`.execute(owner);
  await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES(${tenant}::uuid,${client}::uuid,${user}::uuid,'designer')`.execute(owner);
  const own=await saved(svgBody('scope.svg')),other=await saved({...svgBody('peer.svg'),clientId:peer});
  expect(own.assetId).not.toBe(other.assetId);expect(own.sha256).toBe(other.sha256);
  const scoped=createApp({db,testAuth:{principal:{role:'designer',userId:user}}});
  expect((await scoped.request(`/v1/assets/${own.assetId}/content`)).status).toBe(200);
  for(const path of [`/v1/assets/${other.assetId}/content`,`/v1/assets/${other.assetId}/sources`,
    `/v1/assets/${other.assetId}/sources/${other.sourceSha256}/content`])expect((await scoped.request(path)).status).toBe(404);
  expect((await upload({...svgBody('forbidden.svg'),clientId:peer},scoped)).status).toBe(404);
  await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${foreignTenant}::uuid,'Foreign asset',${foreignTenant})`.execute(owner);
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${foreignClient}::uuid,${foreignTenant}::uuid,${foreignClient},'Foreign asset')`.execute(owner);
  const foreign=randomUUID();
  await sql`INSERT INTO hawa.brand_assets(id,tenant_id,client_id,kind,name,mime_type,sha256,blob_sha256)
    VALUES(${foreign}::uuid,${foreignTenant}::uuid,${foreignClient}::uuid,'logo','foreign','image/svg+xml',${own.sha256},${own.sha256})`.execute(owner);
  expect((await core().request(`/v1/assets/${foreign}/content`)).status).toBe(404);
  expect((await core().request(`/v1/assets/${own.assetId}/sources/${'a'.repeat(64)}/content`)).status).toBe(404);
});
it('refuses invalid content, claimed sizes, MIME spoofing and malformed binary data without admitting records',async()=>{
  for(const body of [
    {...svgBody('size.svg'),sizeBytes:1}, {...svgBody('two.svg'),contentBase64:Buffer.from(svg).toString('base64')},
    {filename:'spoof.png',mimeType:'image/png',content:svg}, {filename:'header.png',mimeType:'image/png',contentBase64:'iVBORw0KGgo='},
    {filename:'bad.webp',mimeType:'image/webp',contentBase64:Buffer.from('RIFF0000WEBP').toString('base64')},
    {filename:'bad.ttf',mimeType:'font/ttf',contentBase64:Buffer.alloc(12).toString('base64')},
    {filename:'x.png',mimeType:'image/png',contentBase64:'not base64'}, {filename:'x.svg',mimeType:'image/svg+xml',content:[]},
  ])expect((await upload(body)).status).toBe(422);
});
it('retains real TTF and WOFF2 files without installing or activating them',async()=>{
  for(const [file,mimeType] of [['Inter-Regular.ttf','font/ttf'],['inter-latin.woff2','font/woff2']]) {
    const bytes=readFileSync(new URL('../../../packages/creative/assets/fonts/'+file,import.meta.url));
    const record=await saved({filename:file,mimeType,contentBase64:bytes.toString('base64')});
    const response=await core().request(`/v1/assets/${record.assetId}/content`);
    expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(record.sha256).toBe(digest(bytes));expect(record.sizeBytes).toBe(bytes.length);
  }
});
it('keeps admitted and original files rooted through the actual garbage collector',async()=>{
  const original=svg.replace('red','purple').replace('</svg>','<script>alert(3)</script></svg>');
  const record=await saved(svgBody('retention.svg',original));
  await owner.transaction().execute(async trx=>{
    await sql.raw('SET LOCAL session_replication_role=replica').execute(trx);
    await sql`UPDATE hawa.blobs SET created_at=now()-interval '30 days',unreferenced_since=now()-interval '20 days'
      WHERE sha256 IN(${record.sha256},${record.sourceSha256})`.execute(trx);
  });
  const report=await runBlobGc(store(),db,{graceDays:7});expect(report.cleared).toBeGreaterThanOrEqual(2);
  expect(await store().read(record.sourceSha256,{verify:true})).toEqual(Buffer.from(original));
  expect(await store().read(record.sha256,{verify:true})).not.toEqual(Buffer.from(original));
  const roots=await sql<{sha256:string}>`SELECT sha256 FROM hawa.blob_references WHERE sha256 IN(${record.sha256},${record.sourceSha256})`.execute(owner);
  expect(new Set(roots.rows.map(row=>row.sha256))).toEqual(new Set([record.sha256,record.sourceSha256]));
});
it('rolls back asset admission on receipt failure and reconciles the subsequent retry',async()=>{
  const original=svg.replace('red','green'),body=svgBody('receipt-retry.svg',original);
  await sql.raw('REVOKE INSERT ON hawa.uploaded_asset_sources FROM hawa_app').execute(owner);
  try {expect((await upload(body)).status).toBe(503);}
  finally {await sql.raw('GRANT INSERT ON hawa.uploaded_asset_sources TO hawa_app').execute(owner);}
  const rows=await sql<{n:string}>`SELECT count(*) AS n FROM hawa.brand_assets WHERE client_id=${client}::uuid AND sha256=${digest(original)}`.execute(owner);
  expect(rows.rows[0].n).toBe('0');
  const record=await saved(body),again=await saved(body);expect(again.assetId).toBe(record.assetId);
  expect((await (await core().request(`/v1/assets/${record.assetId}/sources`)).json()).items).toHaveLength(1);
});
it('refuses corrupt bytes even on a conditional or accelerator-mode read',async()=>{
  const record=await saved(svgBody('corruption.svg',svg.replace('red','orange'))),file=store().pathOf({sha256:record.sha256,mediaType:'image/svg+xml'});
  const original=readFileSync(file);chmodSync(file,0o600);writeFileSync(file,Buffer.alloc(original.length,32));
  vi.stubEnv('HAWA_BLOB_ACCEL_PREFIX','/_blobs/');
  try {
    const response=await core().request(`/v1/assets/${record.assetId}/content`,{headers:{'If-None-Match':'*'}});
    expect(response.status).toBe(503);expect(response.headers.get('X-Accel-Redirect')).toBeNull();
  } finally {writeFileSync(file,original);chmodSync(file,0o444);}
});
it('makes historical metadata-only assets explicitly unavailable',async()=>{
  const id=randomUUID();await sql`INSERT INTO hawa.brand_assets(id,tenant_id,client_id,kind,name,mime_type,sha256)
    VALUES(${id}::uuid,${tenant}::uuid,${client}::uuid,'logo','legacy','image/png',${digest(id)})`.execute(owner);
  expect((await core().request(`/v1/assets/${id}/content`)).status).toBe(409);
});
it('preserves append-only source identity at the database boundary',async()=>{
  const record=await saved(svgBody('append-only.svg'));
  await expect(sql`UPDATE hawa.uploaded_asset_sources SET filename='changed' WHERE asset_id=${record.assetId}::uuid`.execute(owner)).rejects.toThrow('append-only');
  await expect(sql`DELETE FROM hawa.uploaded_asset_sources WHERE asset_id=${record.assetId}::uuid`.execute(owner)).rejects.toThrow('append-only');
});
it('refuses an unavailable file store and releases the bounded upload slot after failure',async()=>{
  const root=mkdtempSync(join(tmpdir(),'hawa-unavailable-upload-'));
  try {
    const instance=createApp({db,blobStore:new BlobStore({db,root}),testAuth:{principal:{role:'operator'}}});
    expect((await upload(svgBody('missing-store.svg',svg.replace('red','yellow')),instance)).status).toBe(503);
    expect((await upload(svgBody('missing-store.svg',svg.replace('red','yellow')),instance)).status).toBe(503);
  } finally {rmSync(root,{recursive:true,force:true});}
});
