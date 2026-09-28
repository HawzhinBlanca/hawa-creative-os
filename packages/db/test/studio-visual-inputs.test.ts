import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, unlink, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { createDb, withRlsContext } from '../src/client.js';
import { DesignStudioRepository } from '../src/repositories/design-studio.repository.js';
import { StudioVisualInputsRepository } from '../src/repositories/studio-visual-inputs.repository.js';
import { BlobStore, initBlobStoreDir } from '../src/blobs/store.js';
const url = process.env.HAWA_ISOLATED_TEST_DB;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1kAAAAASUVORK5CYII=', 'base64');
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
describe.skipIf(!url)('durable Studio visual input bundles', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const runs = new DesignStudioRepository(db), repo = new StudioVisualInputsRepository(db);
  const dirs: string[] = [];
  let tenantId: string, actorId: string, clientId: string, taskId: string, runId: string;
  beforeEach(async () => {
    tenantId=randomUUID();actorId=randomUUID();clientId=randomUUID();taskId=randomUUID();runId=randomUUID();
    await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Visual input fixture',${tenantId})`.execute(db);
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${actorId}::uuid,${actorId+'@example.test'},'Visual input operator')`.execute(db);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${actorId}::uuid,'operator')`.execute(db);
    await withRlsContext(db,{tenantId,userId:actorId}, async tx => {
      await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,'visual','Visual fixture')`.execute(tx);
      await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Visual fixture')`.execute(tx);
    });
    await runs.createRun({id:runId,taskId,tenantId,clientId,actorId,requestKey:runId,requestHash:'a'.repeat(64),request:{},tier:'premium'});
    await runs.updateRunStatus(runId,tenantId,'laying_out');
  });
  afterAll(async()=>{await db.destroy();await Promise.all(dirs.map(d=>rm(d,{recursive:true,force:true})));});
  const proposal=(label='original')=>({manifest:{version:1,label},assets:[{key:'photo/0',bytes:png}]});

  it('returns one immutable winner to concurrent preparations from separate connections',async()=>{
    const peer=createDb(url!);
    try {
      const results=await Promise.all([repo.pin({tenantId,actorId},runId,proposal('first')),new StudioVisualInputsRepository(peer).pin({tenantId,actorId},runId,proposal('second'))]);
      expect(results[0]).toEqual(results[1]);
      expect(results[0].assets[0].bytes).toEqual(png);
      expect(await new StudioVisualInputsRepository(peer).get({tenantId,actorId},runId)).toEqual(results[0]);
      await expect(sql`UPDATE hawa.studio_visual_inputs SET manifest_text='{}' WHERE run_id=${runId}::uuid`.execute(db)).rejects.toThrow(/immutable/);
      await expect(sql`DELETE FROM hawa.studio_visual_input_assets WHERE run_id=${runId}::uuid`.execute(db)).rejects.toThrow(/immutable/);
      await expect(sql`INSERT INTO hawa.studio_visual_input_assets(tenant_id,run_id,asset_key,sha256,bytes)
        VALUES(${tenantId}::uuid,${runId}::uuid,'late',${hash(png)},${png})`.execute(db)).rejects.toThrow(/commit with/);
    }finally{await peer.destroy();}
  });

  it('enforces operator authority and tenant/client isolation under the runtime role',async()=>{
    await withRlsContext(db,{tenantId,userId:actorId},async tx=>{
      await sql`SET LOCAL ROLE hawa_app`.execute(tx);
      const runtime=new StudioVisualInputsRepository(tx);
      expect(await runtime.pin({tenantId,actorId},runId,proposal())).toEqual(proposal());
      expect(await runtime.get({tenantId:randomUUID(),actorId},runId)).toBeNull();
    });
    const outsider=randomUUID();
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${outsider}::uuid,${outsider+'@example.test'},'Scoped designer')`.execute(db);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${outsider}::uuid,'designer')`.execute(db);
    await withRlsContext(db,{tenantId,userId:outsider},async tx=>{
      await sql`SET LOCAL ROLE hawa_app`.execute(tx);
      expect(await new StudioVisualInputsRepository(tx).get({tenantId,actorId:outsider},runId)).toBeNull();
    });
  });

  it('rolls back the manifest if saving an asset fails',async()=>{
    await sql`CREATE FUNCTION hawa.fail_visual_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic asset write failure'; END $$`.execute(db);
    await sql`CREATE TRIGGER fail_visual_fixture BEFORE INSERT ON hawa.studio_visual_input_assets FOR EACH ROW EXECUTE FUNCTION hawa.fail_visual_fixture()`.execute(db);
    try {
      await expect(repo.pin({tenantId,actorId},runId,proposal())).rejects.toThrow(/synthetic asset write/);
      expect(await repo.get({tenantId,actorId},runId)).toBeNull();
    }finally{
      await sql`DROP TRIGGER fail_visual_fixture ON hawa.studio_visual_input_assets`.execute(db);
      await sql`DROP FUNCTION hawa.fail_visual_fixture()`.execute(db);
    }
  });

  it('retains blob roots and refuses missing bytes instead of replacing them',async()=>{
    const root=await mkdtemp(join(tmpdir(),'hawa-visual-'));dirs.push(root);await initBlobStoreDir(root);
    const store=new BlobStore({root,db}), stored=new StudioVisualInputsRepository(db,store);
    await stored.pin({tenantId,actorId},runId,proposal());
    expect((await sql`SELECT * FROM hawa.blob_reference_hashes() AS roots(hash) WHERE hash=${hash(png)}`.execute(db)).rows).toHaveLength(1);
    await expect(repo.get({tenantId,actorId},runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
    const imagePath=store.pathOf({sha256:hash(png),mediaType:'image/png'});
    await chmod(imagePath,0o644);await writeFile(imagePath,Buffer.from('corrupt pinned bytes'));
    await expect(stored.get({tenantId,actorId},runId)).rejects.toMatchObject({code:'STUDIO_VISUAL_INPUTS_UNSAFE'});
    await unlink(imagePath);
    await expect(stored.get({tenantId,actorId},runId)).rejects.toThrow();
  });

  it('refuses cancelled tasks, late first pins and duplicate asset identities',async()=>{
    await expect(repo.pin({tenantId,actorId},runId,{manifest:{},assets:[...proposal().assets,...proposal().assets]})).rejects.toThrow(/duplicate/);
    await runs.updateRunStatus(runId,tenantId,'rendering');
    await expect(repo.pin({tenantId,actorId},runId,proposal())).rejects.toThrow(/before layout/);
    await runs.updateRunStatus(runId,tenantId,'laying_out');
    await sql`UPDATE hawa.tasks SET state='cancelled' WHERE id=${taskId}::uuid`.execute(db);
    await expect(repo.pin({tenantId,actorId},runId,proposal())).rejects.toThrow(/authority/);
    expect(await repo.get({tenantId,actorId},runId)).toBeNull();
  });
});
