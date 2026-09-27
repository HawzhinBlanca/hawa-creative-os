import { createHash, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { assert, expect, it } from 'vitest';
import { createDb, sql, blobStoreFromEnv } from '@hawa/db';
import { kaaeClientDNA } from '@hawa/domain';
import { dropClone, withDatabase } from '../../../packages/db/src/test-template.js';
import { assertTestDatabaseEnv, connectionTargetOf } from '../../../packages/db/src/test-database-guard.js';

const root = resolve(import.meta.dirname, '../../..');
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const within = async <T>(promise: Promise<T>, ms: number, message: () => string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message())), ms);
    })]);
  } finally { clearTimeout(timer); }
};
const parserImage = 'hawa-docling:2.130.0-native-v1';
type Check = { name: string; passed: boolean };
type Receipt = { id: string; clientId: string; sourceSha256: string; extractionSha256: string; extractorVersion: string };

it.skipIf(process.env.HAWA_DOCUMENT_RECOVERY !== '1')('recovers real PDF evidence after four Core SIGKILL boundaries and a fresh dump/file restore', async () => {
  assertTestDatabaseEnv(process.env);
  const sourceUrl = process.env.TEST_DATABASE_URL!, ownerUrl = process.env.TEST_DATABASE_OWNER_URL!;
  const sourceTarget = connectionTargetOf(sourceUrl), ownerTarget = connectionTargetOf(ownerUrl);
  for (const target of [sourceTarget, ownerTarget]) {
    expect(['127.0.0.1', 'localhost']).toContain(target.host);
    expect(Number(target.port)).toBe(55432); expect(target.database).toMatch(/^hawa_t_[a-z0-9_]+$/);
  }
  expect(sourceTarget.database).toBe(ownerTarget.database);
  const sourceBlobs = process.env.HAWA_BLOB_DIR!;
  expect(sourceBlobs.startsWith(join(tmpdir(), 'hawa-test-blobs-'))).toBe(true);
  const recoveredName = `hawa_t_pdf_restore_${randomUUID().replaceAll('-', '')}`;
  const restoredUrl = withDatabase(sourceUrl, recoveredName), restoredOwnerUrl = withDatabase(ownerUrl, recoveredName);
  let child: ChildProcess | undefined, api = '', armed = '', resolveReached: (() => void) | undefined;
  let held: ServerResponse | undefined, parserCalls = 0, restarted = 0, kills = 0;
  const checks: Check[] = [], events: string[] = [];
  const check = (name: string, condition: boolean) => { checks.push({ name, passed: condition }); expect(condition, name).toBe(true); };
  const started = Date.now();
  const tenantId = '00000000-0000-4000-a000-000000000001', clientId = randomUUID(), userId = randomUUID();
  const token = `hawa_sess_${randomUUID().replaceAll('-', '')}`, csrf = hash(`${token}:csrf`);
  const headers = { Cookie: `hawa_session=${token}; hawa_csrf=${csrf}`, 'x-hawa-csrf': csrf };
  const pdf = await readFile(join(root, 'services/docling/fixtures/two-pages.pdf'));
  // Parse actual compressed PDF bytes using the pinned offline container; feed its unchanged
  // response to each restarted Core over local HTTP. Recovery is separate from sidecar uptime.
  const imageId = spawnSync('docker', ['image', 'inspect', parserImage, '--format', '{{.Id}}'], { encoding: 'utf8', timeout: 15000 });
  expect(imageId.status, 'Build services/docling/compose.yml before this opt-in drill').toBe(0);
  const parsed = spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--memory', '768m', '--cpus', '1', '--pids-limit', '32',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '-i', imageId.stdout.trim(), 'python', 'extract.py'],
    { input: pdf, timeout: 45000, maxBuffer: 8 * 1024 * 1024 });
  expect(parsed.status, parsed.stderr.toString().slice(-1000)).toBe(0);
  const extraction = JSON.parse(parsed.stdout.toString()) as { sourceSha256: string; version: string;
    blocks: Array<{ text: string; bbox: { x: number; y: number; width: number; height: number } }> };
  check('real parser hashes original PDF and extracts both fixture pages', extraction.sourceSha256 === hash(pdf) && extraction.blocks.length === 2);
  const work = await mkdtemp(join(tmpdir(), 'hawa-pdf-recovery-'));
  let owner = createDb(ownerUrl), runtime = createDb(sourceUrl);
  const bridge = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (req.url === '/parse') {
        if (hash(bytes) !== hash(pdf)) { res.writeHead(422).end(); return; }
        parserCalls++; res.setHeader('Content-Type', 'application/json'); res.end(parsed.stdout); return;
      }
      if (req.url === '/reach') {
        const message = JSON.parse(bytes.toString()) as { point: string };
        if (message.point === armed) { held = res; armed = ''; resolveReached?.(); return; }
        res.end('ok'); return;
      }
      res.writeHead(404).end();
    } catch { res.writeHead(500).end(); }
  });
  bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
  const bridgeUrl = `http://127.0.0.1:${(bridge.address() as { port: number }).port}`;
  const exitChild = async (signal: 'SIGKILL' | 'SIGTERM') => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exiting = once(child, 'exit'); child.kill(signal);
    const fallback = setTimeout(() => child?.kill('SIGKILL'), 5000);
    let actual: unknown;
    try { [, actual] = await within(exiting, 10000, () => 'Recovery Core did not exit'); }
    finally { clearTimeout(fallback); }
    if (signal === 'SIGKILL') { check(`Core kill ${kills + 1} is an actual SIGKILL`, actual === 'SIGKILL'); kills++; }
    held?.destroy(); held = undefined; child = undefined;
  };
  const start = async (databaseUrl = sourceUrl, blobDir = sourceBlobs, parser = true) => {
    let stderr = '';
    child = spawn(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), join(root, 'apps/core/test/fixtures/document-recovery-process.ts')], {
      cwd: work, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {
        PATH: process.env.PATH, NODE_ENV: 'production', HAWA_DOCUMENT_RECOVERY: '1', TEST_DATABASE_URL: databaseUrl,
        HAWA_ACTION_HMAC_SECRET: hash(randomUUID()),
        HAWA_BLOB_DIR: blobDir, HAWA_CHAOS_CONTROL_URL: bridgeUrl, HAWA_CHAOS_HOLD_LIMIT_MS: '30000',
        HAWA_DOCLING_URL: parser ? bridgeUrl : '', DESIGN_PIPELINE_V3: 'off', DESIGN_STUDIO_V2: 'off',
        HAWA_GOOGLE_OIDC_CLIENT_ID: 'fixture-client', HAWA_GOOGLE_OIDC_CLIENT_SECRET: 'fixture-secret',
        HAWA_GOOGLE_OIDC_REDIRECT_URI: 'https://desk.example.test/v1/auth/google/callback',
        HAWA_GOOGLE_OIDC_HOSTED_DOMAINS: 'example.test',
      },
    });
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
    const ready = new Promise<number>((resolve, reject) => {
      child!.once('message', message => resolve((message as { port: number }).port));
      child!.once('exit', () => reject(new Error(`Recovery Core exited before ready: ${stderr}`)));
      child!.once('error', reject);
    });
    const port = await within(ready, 15000, () => `Recovery Core startup timed out: ${stderr}`);
    expect(port).toBeGreaterThan(0); api = `http://127.0.0.1:${port}`; restarted++;
  };
  const request = (path: string, method = 'GET', body?: string | Buffer, key?: string) => fetch(`${api}/v1${path}`, {
    method, headers: { ...headers, ...(body ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/pdf' : 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}) }, body: body as BodyInit | undefined, signal: AbortSignal.timeout(30000),
  });
  const interrupted = async (point: string, send: () => Promise<Response>) => {
    armed = point; const reached = new Promise<void>(resolve => { resolveReached = resolve; });
    const answer = send().then(r => ({ answered: true, status: r.status }), () => ({ answered: false, status: 0 }));
    await within(reached, 10000, () => `Core never reached ${point}`);
    await exitChild('SIGKILL'); const outcome = await answer;
    check(`${point}: no success response survived the crash`, !outcome.answered); events.push(point);
  };
  const count = async (table: string, field: string, id: string) => Number((await sql<{ n: string }>`SELECT count(*) AS n
    FROM ${sql.table(`hawa.${table}`)} WHERE ${sql.ref(field)}=${id}::uuid`.execute(owner)).rows[0].n);
  const documents = `/clients/${clientId}/documents`;
  let report: Record<string, unknown> = {}, completed = false;
  try {
    await sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES (${userId}::uuid,
      ${`${userId}@example.test`},'Recovery fixture administrator',${`google-${userId}`})`.execute(owner);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active) VALUES
      (${tenantId}::uuid,${userId}::uuid,'administrator',true)`.execute(owner);
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES (${clientId}::uuid,${tenantId}::uuid,${clientId},'Recovery fixture client')`.execute(owner);
    await sql`INSERT INTO hawa.client_dna_versions(id,tenant_id,client_id,version,status,content_hash,dna)
      VALUES (${randomUUID()}::uuid,${tenantId}::uuid,${clientId}::uuid,1,'active',${hash('fixture')},${JSON.stringify(kaaeClientDNA)}::jsonb)`.execute(owner);
    await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
      VALUES (${hash(token)},${tenantId}::uuid,${userId}::uuid,'oidc:recovery','administrator','Recovery fixture administrator',now()+interval '1 hour','google_oidc')`.execute(owner);
    await start();
    await interrupted('core.documents.after-bytes', () => request(documents, 'POST', pdf));
    check('bytes-before-receipt crash leaves no invented receipt', await count('client_documents', 'client_id', clientId) === 0);
    await start();
    await interrupted('core.documents.after-receipt', () => request(documents, 'POST', pdf));
    check('receipt-before-response crash commits exactly one receipt', await count('client_documents', 'client_id', clientId) === 1);
    await start(sourceUrl, sourceBlobs, false);
    const uploadReplay = await request(documents, 'POST', pdf); expect(uploadReplay.status).toBe(200);
    const saved = await uploadReplay.json() as { receipt: Receipt; document: { chunks: Array<{
      chunkId: string; pageNumber: number; metadata: { coordinates: unknown; coordinateSystem: string };
    }> } };
    const receipt = saved.receipt, knowledgePath = `${documents}/${receipt.id}/knowledge`;
    check('saved bytes and extraction reopen without a parser or reprocessing', parserCalls === 2 && receipt.sourceSha256 === hash(pdf));
    await sql`SELECT * FROM hawa.blob_gc_mark()`.execute(runtime);
    const blob = (await sql<{ unreferenced_since: string | null }>`SELECT unreferenced_since FROM hawa.blobs WHERE sha256=${hash(pdf)}`.execute(owner)).rows[0];
    check('receipt protects original bytes from orphan collection', blob.unreferenced_since === null);
    const approvalKey = randomUUID(), approval = JSON.stringify({ approved: true, expectedVersion: 0, reviewed: true,
      sourceSha256: receipt.sourceSha256, extractionSha256: receipt.extractionSha256, reason: 'Fixture review of source and limits' });
    await interrupted('core.documents.after-knowledge-commit', () => request(knowledgePath, 'PUT', approval, approvalKey));
    check('approval crash commits one event and both derived chunks atomically',
      await count('client_document_knowledge_events', 'document_id', receipt.id) === 1 && await count('client_document_knowledge_chunks', 'document_id', receipt.id) === 2);
    await start(sourceUrl, sourceBlobs, false);
    const replay = await request(knowledgePath, 'PUT', approval, approvalKey); expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, state: { version: 1, approved: true } });
    check('changed approval under the original key is refused', (await request(knowledgePath, 'PUT', approval.replace('Fixture review', 'Changed review'), approvalKey)).status === 409);
    const searchPath = `/clients/${clientId}/knowledge/search?q=Hawa`;
    const search = await (await request(searchPath)).json();
    check('real page boxes survive the immutable search projection', search.items.length === 2 &&
      saved.document.chunks.every(chunk => {
        const found = search.items.find((item: { citation: { chunkId: string } }) => item.citation.chunkId === chunk.chunkId);
        return found?.citation.pageNumber === chunk.pageNumber && found.citation.coordinateSystem === chunk.metadata.coordinateSystem &&
          JSON.stringify(found.citation.coordinates) === JSON.stringify(chunk.metadata.coordinates);
      }));
    const taskKey = randomUUID(), copyEn = '  Hawa source page one 123.45\n_____\nKeep this exact.  ', copyCkb = 'نرخ ١٢٣';
    const taskBody = JSON.stringify({ clientId, workflow: 'canva_manual', title: 'Recovery request', copyEn, copyCkb,
      description: copyEn, designInstructions: 'Use editable copy.', sourceDocument: { ...receipt, confirmed: true } });
    await interrupted('core.documents.after-task-commit', () => request('/tasks', 'POST', taskBody, taskKey));
    check('task crash leaves one task and one source decision', await count('tasks', 'client_id', clientId) === 1);
    await start(sourceUrl, sourceBlobs, false);
    const taskReplay = await request('/tasks', 'POST', taskBody, taskKey); expect(taskReplay.status).toBe(200);
    const task = await taskReplay.json() as { id: string };
    check('replay cannot duplicate task events or outbox commands', await count('task_events', 'task_id', task.id) === 1 && await count('outbox_commands', 'aggregate_id', task.id) === 1);
    check('changed task body conflicts under its saved identity', (await request('/tasks', 'POST', taskBody.replace('Recovery request', 'Changed request'), taskKey)).status === 409);
    const change = (approved: boolean, expectedVersion: number) => request(knowledgePath, 'PUT',
      JSON.stringify({ ...JSON.parse(approval), approved, expectedVersion, reason: approved ? 'Restore reference use' : 'Superseded reference' }), randomUUID());
    expect((await change(false, 1)).status).toBe(201);
    expect(await (await request(knowledgePath, 'PUT', approval, approvalKey)).json()).toMatchObject({ state: { version: 2, approved: false }, action: { version: 1 } });
    check('old approval replay cannot resurrect a revoked search source', (await (await request(searchPath)).json()).items.length === 0);
    expect((await change(true, 2)).status).toBe(201);
    const beforeState = await (await request(knowledgePath)).json(), beforeSearch = await (await request(searchPath)).json();
    const detailBefore = await (await request(`/tasks/${task.id}`)).json();
    check('reviewed request retains exact bilingual copy and source evidence', detailBefore.copyEn === copyEn && detailBefore.copyCkb === copyCkb && detailBefore.sourceDocument.id === receipt.id);
    await exitChild('SIGTERM');
    const ownerUser = decodeURIComponent(new URL(ownerUrl).username);
    const dump = spawnSync('docker', ['exec', 'hawa-test-postgres', 'pg_dump', '-U', ownerUser, '-Fc', sourceTarget.database!], { timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
    expect(dump.status, dump.stderr.toString().slice(-1000)).toBe(0);
    const backupBlobs = join(work, 'backup-blobs'), restoredBlobs = join(work, 'restored-blobs');
    await cp(sourceBlobs, backupBlobs, { recursive: true });
    await sql.raw(`CREATE DATABASE ${recoveredName} TEMPLATE template0`).execute(owner);
    const restore = spawnSync('docker', ['exec', '-i', 'hawa-test-postgres', 'pg_restore', '-U', ownerUser,
      '--exit-on-error', '--no-owner', '-d', recoveredName], { input: dump.stdout, timeout: 30000, maxBuffer: 1024 * 1024 });
    expect(restore.status, restore.stderr.toString().slice(-1000)).toBe(0);
    await cp(backupBlobs, restoredBlobs, { recursive: true });
    await Promise.all([owner.destroy(), runtime.destroy()]);
    // Remove only this file's disposable original database/store. A successful read now needs the restore.
    await dropClone(ownerUrl, sourceTarget.database!); await rm(sourceBlobs, { recursive: true });
    owner = createDb(restoredOwnerUrl); runtime = createDb(restoredUrl);
    await start(restoredUrl, restoredBlobs, false);
    check('original PDF is byte-identical after fresh database and file restore', hash(new Uint8Array(await (await request(`${documents}/${receipt.id}/content`)).arrayBuffer())) === hash(pdf));
    check('all named approval versions survive restore unchanged', JSON.stringify(await (await request(knowledgePath)).json()) === JSON.stringify(beforeState));
    check('search text and exact citations survive restore unchanged', JSON.stringify(await (await request(searchPath)).json()) === JSON.stringify(beforeSearch));
    const restoredTask = await request('/tasks', 'POST', taskBody, taskKey);
    check('restored task replay adopts original identity', restoredTask.status === 200 && (await restoredTask.json()).id === task.id);
    const detailAfter = await (await request(`/tasks/${task.id}`)).json();
    check('restored request preserves exact bilingual copy and original source', detailAfter.copyEn === copyEn && detailAfter.copyCkb === copyCkb && JSON.stringify(detailAfter.sourceDocument) === JSON.stringify(detailBefore.sourceDocument));
    check('restored outbox remains a single durable command', await count('outbox_commands', 'aggregate_id', task.id) === 1);
    const recoveredStore = blobStoreFromEnv(runtime, { ...process.env, HAWA_BLOB_DIR: restoredBlobs });
    const stat = await recoveredStore.stat(hash(pdf)); assert(stat, "Expected retained source bytes");
    await chmod(stat.path, 0o644); await writeFile(stat.path, Buffer.alloc(pdf.length, 120));
    check('same-size corruption after restore fails original download', (await request(`${documents}/${receipt.id}/content`)).status === 503);
    check('corrupt restored source cannot create another task', (await request('/tasks', 'POST', taskBody, randomUUID())).status === 503);
    expect((await change(false, 3)).status).toBe(201);
    check('revocation remains available even when restored bytes are damaged', (await (await request(searchPath)).json()).items.length === 0);
    expect(await (await request(knowledgePath, 'PUT', approval, approvalKey)).json()).toMatchObject({ replayed: true, state: { version: 4, approved: false } });
    check('replay of the pre-crash action after restore appends no extra event', await count('client_document_knowledge_events', 'document_id', receipt.id) === 4);
    report = { sourcePdfSha256: hash(pdf), parserImageId: imageId.stdout.trim(), parserVersion: extraction.version,
      parserResponseSha256: hash(parsed.stdout), parserCalls, restarts: restarted, processKills: kills,
      restoredFrom: 'PostgreSQL custom-format pg_dump and copied content-addressed blob files; original test DB/store removed',
      databaseDumpSha256: hash(dump.stdout), noWorkerOrModelExecution: true };
    completed = true;
  } finally {
    await exitChild('SIGTERM'); bridge.closeAllConnections(); await new Promise<void>(resolve => bridge.close(() => resolve()));
    await Promise.all([owner.destroy(), runtime.destroy()]); await dropClone(ownerUrl, recoveredName);
    await rm(work, { recursive: true, force: true });
    const output = process.env.HAWA_DOCUMENT_RECOVERY_REPORT;
    if (output) {
      const sources = ['apps/core/src/routes/documents.routes.ts','apps/core/src/routes/document-knowledge.routes.ts','apps/core/src/routes/tasks.routes.ts',
        'apps/core/src/services/client-documents.ts','apps/core/src/services/document-knowledge.ts','packages/db/migrations/041_client_documents.sql',
        'packages/db/migrations/042_document_knowledge.sql','apps/core/test/document-recovery.test.ts','apps/core/test/fixtures/document-recovery-process.ts',
        'services/docling/extract.py','services/docling/Dockerfile','services/docling/requirements.lock',
        'api/openapi.yaml','apps/desk/src/api/client.ts'];
      const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async p => [p, hash(await readFile(join(root, p)))])));
      await writeFile(output, JSON.stringify({ date: new Date().toISOString(), status: completed && checks.length === 31 && checks.every(c => c.passed) && kills === 4 ? 'passed' : 'failed',
        ...report, durationMs: Date.now() - started, events, checks, sourceHashes,
        limits: ['Same-host disposable PostgreSQL; not an off-site/clean-host restore or production RPO/RTO measurement',
          'Real offline parser response replayed through a loopback bridge; sidecar uptime not measured',
          'Actual named session fixtures; no external OIDC login, Restate worker, live provider or human quality admission'] }, null, 2) + '\n');
    }
  }
}, 180000);
