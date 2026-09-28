import { createHash, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { createDb, sql } from '@hawa/db';
import { assertTestDatabaseEnv, connectionTargetOf } from '../../../packages/db/src/test-database-guard.js';

const root = resolve(import.meta.dirname, '../../..');
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
async function within<T>(promise: Promise<T>, ms: number, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message())), ms); })]); }
  finally { clearTimeout(timer); }
}

it.skipIf(process.env.HAWA_SOURCE_RECOVERY !== '1')('recovers a reviewed Telegram PDF through five actual Core kills with immutable client scope and one request', async () => {
  assertTestDatabaseEnv(process.env);
  const databaseUrl = process.env.TEST_DATABASE_URL!, ownerUrl = process.env.TEST_DATABASE_OWNER_URL!;
  for (const url of [databaseUrl, ownerUrl]) {
    const target = connectionTargetOf(url);
    expect(['127.0.0.1', 'localhost']).toContain(target.host); expect(Number(target.port)).toBe(55432);
    expect(target.database).toMatch(/^hawa_t_[a-z0-9_]+$/);
  }
  const blobDir = process.env.HAWA_BLOB_DIR!; expect(blobDir.startsWith(join(tmpdir(), 'hawa-test-blobs-'))).toBe(true);
  const tenantId = '00000000-0000-4000-a000-000000000001', clientId = randomUUID(), otherId = randomUUID(), userId = randomUUID();
  const chatId = 194027, senderId = 294027, sourceId = 394027, confirmationId = 494027, code = `source-${randomUUID()}`;
  const workerToken = `fixture-${randomUUID()}`, session = `hawa_sess_${randomUUID().replaceAll('-', '')}`;
  const botToken = ['123456', 'source-recovery-fixture'].join(':');
  const pdf = await readFile(join(root, 'services/docling/fixtures/two-pages.pdf'));
  const source = { update_id: sourceId, message: { message_id: sourceId, from: { id: senderId, is_bot: false, first_name: 'Fixture' },
    chat: { id: chatId, type: 'private' }, caption: `/new\nClient: ${code}\nSize: 1080x1080\nUse editable copy.`,
    document: { file_id: 'source-fixture', file_name: 'source.pdf', mime_type: 'application/pdf', file_size: pdf.length } } };
  const copy = '  Hawa source page one 123.45\nنرخ ١٢٣\n_____\nKeep this exact.  ';
  const confirmation = { update_id: confirmationId, message: { message_id: confirmationId, from: source.message.from,
    chat: source.message.chat, reply_to_message: { message_id: sourceId }, text: `/use_source\n${copy}` } };
  const image = spawnSync('docker', ['image', 'inspect', 'hawa-docling:2.130.0-native-v1', '--format', '{{.Id}}'], { encoding: 'utf8', timeout: 15000 });
  expect(image.status, 'Build the pinned offline Docling image before this drill').toBe(0);
  const parsed = spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--memory', '768m', '--cpus', '1', '--pids-limit', '32',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '-i', image.stdout.trim(), 'python', 'extract.py'],
    { input: pdf, timeout: 45000, maxBuffer: 8 * 1024 * 1024 });
  expect(parsed.status, parsed.stderr.toString().slice(-1000)).toBe(0);
  const extraction = JSON.parse(parsed.stdout.toString()) as { sourceSha256: string; blocks: Array<{ text: string }>; version: string };
  const checks: Array<{ name: string; passed: boolean }> = [], events: string[] = [];
  const check = (name: string, value: boolean) => { checks.push({ name, passed: value }); expect(value, name).toBe(true); };
  check('offline parser preserves the compressed fixture hash and both source pages', extraction.sourceSha256 === hash(pdf) && extraction.blocks.length === 2);
  const started = Date.now(), owner = createDb(ownerUrl), runtime = createDb(databaseUrl);
  const work = await mkdtemp(join(tmpdir(), 'hawa-pdf-recovery-'));
  let child: ChildProcess | undefined, api = '', armed = '', held: ServerResponse | undefined;
  let reached: (() => void) | undefined, downloads = 0, parses = 0, starts = 0, kills = 0, completed = false;
  const bridge = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (req.url === '/telegram/getFile') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result: { file_path: 'sources/fixture.pdf', file_size: pdf.length } })); return; }
      if (req.url === '/telegram/file') { downloads++; res.setHeader('Content-Type', 'application/pdf'); res.end(pdf); return; }
      if (req.url === '/parse') {
        if (hash(bytes) !== hash(pdf)) { res.writeHead(422).end(); return; }
        parses++; res.setHeader('Content-Type', 'application/json'); res.end(parsed.stdout); return;
      }
      if (req.url === '/reach') {
        const message = JSON.parse(bytes.toString()) as { point: string };
        if (message.point === armed) { held = res; armed = ''; reached?.(); return; }
        res.end('ok'); return;
      }
      res.writeHead(404).end();
    } catch { res.writeHead(500).end(); }
  });
  bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
  const bridgeUrl = `http://127.0.0.1:${(bridge.address() as { port: number }).port}`;
  const stop = async (signal: 'SIGTERM' | 'SIGKILL') => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exiting = once(child, 'exit'); child.kill(signal); const fallback = setTimeout(() => child?.kill('SIGKILL'), 5000);
    try {
      const [, actual] = await within(exiting, 10000, () => 'Source recovery Core did not exit');
      if (signal === 'SIGKILL') { check(`kill ${++kills} terminated Core with SIGKILL`, actual === 'SIGKILL'); }
    } finally { clearTimeout(fallback); held?.destroy(); held = undefined; child = undefined; }
  };
  const start = async (parser: boolean) => {
    let stderr = '';
    child = spawn(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), join(root, 'apps/core/test/fixtures/document-recovery-process.ts')], {
      cwd: work, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {
        PATH: process.env.PATH, NODE_ENV: 'production', HAWA_DOCUMENT_RECOVERY: '1', HAWA_SOURCE_RECOVERY: '1',
        TEST_DATABASE_URL: databaseUrl, HAWA_BLOB_DIR: blobDir, HAWA_ACTION_HMAC_SECRET: hash(randomUUID()),
        HAWA_CHAOS_CONTROL_URL: bridgeUrl, HAWA_CHAOS_HOLD_LIMIT_MS: '30000', HAWA_DOCLING_URL: parser ? bridgeUrl : '',
        HAWA_WORKER_TOKEN: workerToken,
        TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_WEBHOOK_SECRET: hash(randomUUID()), TELEGRAM_INTAKE_ALLOWED_USERS: String(senderId),
        AUTO_GENERATE_DAILY_CAP_GLOBAL: '1000000', DESIGN_PIPELINE_V3: 'off', DESIGN_STUDIO_V2: 'off',
        HAWA_GOOGLE_OIDC_CLIENT_ID: 'fixture-client', HAWA_GOOGLE_OIDC_CLIENT_SECRET: 'fixture-secret',
        HAWA_GOOGLE_OIDC_REDIRECT_URI: 'https://desk.example.test/v1/auth/google/callback', HAWA_GOOGLE_OIDC_HOSTED_DOMAINS: 'example.test',
      },
    });
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
    const ready = new Promise<number>((resolve, reject) => {
      child!.once('message', message => resolve((message as { port: number }).port));
      child!.once('exit', () => reject(new Error(`Source recovery Core exited before ready: ${stderr}`))); child!.once('error', reject);
    });
    api = `http://127.0.0.1:${await within(ready, 15000, () => `Source recovery startup timed out: ${stderr}`)}`; starts++;
  };
  const internal = (path: string, body: unknown) => fetch(`${api}/v1/internal${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${workerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const intake = (update: unknown) => internal('/telegram/intake', { v: 1, update, mode: 'legacy' });
  const desk = (path: string) => fetch(`${api}/v1${path}`, { headers: { Cookie: `hawa_session=${session}` }, signal: AbortSignal.timeout(10000) });
  const interrupt = async (point: string, action: () => Promise<Response>) => {
    armed = point; const waiting = new Promise<void>(resolve => { reached = resolve; });
    const pending = action().then(response => ({ answered: true, status: response.status }), () => ({ answered: false, status: 0 }));
    await within(waiting, 10000, () => `Source recovery did not reach ${point}`);
    await stop('SIGKILL'); check(`${point}: no HTTP acknowledgement survives`, !(await pending).answered); events.push(point);
  };
  const count = async (account: string) => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM hawa.inbox_events
    WHERE tenant_id=${tenantId}::uuid AND source_account_id=${account}`.execute(owner)).rows[0].n);
  try {
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES (${clientId}::uuid,${tenantId}::uuid,${code},${code})`.execute(owner);
    await sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES (${userId}::uuid,${`${userId}@example.test`},'Source fixture operator',${`google-${userId}`})`.execute(owner);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active) VALUES (${tenantId}::uuid,${userId}::uuid,'operator',true)`.execute(owner);
    await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
      VALUES (${hash(session)},${tenantId}::uuid,${userId}::uuid,'oidc:source-fixture','operator','Source fixture operator',now()+interval '1 hour','google_oidc')`.execute(owner);
    await start(true);
    await interrupt('core.source.after-admission', () => intake(source));
    check('client admission commits before any external download', await count('lifecycle_source_admission') === 1 && downloads === 0);
    await sql`UPDATE hawa.clients SET code=${`${code}-old`},name=${`${code}-old`} WHERE id=${clientId}::uuid`.execute(owner);
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES (${otherId}::uuid,${tenantId}::uuid,${code},${code})`.execute(owner);
    await start(true);
    await interrupt('core.source.after-upload', () => intake(source));
    check('original bytes commit exactly once after a restart', await count('lifecycle_source_upload') === 1 && downloads === 1);
    await sql`SELECT * FROM hawa.blob_gc_mark()`.execute(runtime);
    check('pending source protects its original from GC before extraction', (await sql<{ unreferenced_since: unknown }>`SELECT unreferenced_since FROM hawa.blobs WHERE sha256=${hash(pdf)}`.execute(owner)).rows[0].unreferenced_since === null);
    await start(true);
    await interrupt('core.source.after-extraction', () => intake(source));
    check('extraction commits once without downloading the original again', await count('lifecycle_source_extraction') === 1 && downloads === 1 && parses === 1);
    await start(false);
    const review = await (await intake(source)).json();
    check('replay opens the saved real extraction while the parser is off', review.intakeStatus === 200 && review.sourceMessage.includes('Hawa source page one 123.45'));
    const filesPath = `/clients/${clientId}/source-files`, original = await desk(`${filesPath}/${sourceId}/content`);
    check('office can download identical source bytes before copy confirmation', original.status === 200 && hash(new Uint8Array(await original.arrayBuffer())) === hash(pdf));
    check('reassigned code cannot expose the source in another client', (await desk(`/clients/${otherId}/source-files/${sourceId}/content`)).status === 404);
    await interrupt('core.source.after-confirmation', () => intake(confirmation));
    check('confirmation commits once before its response', await count('lifecycle_source_confirmation') === 1 && await count('lifecycle_chat_open') === 1);
    await start(false);
    const open = await (await intake(confirmation)).json();
    check('saved decision keeps original client and exact reviewed strings', open.intakeStatus === 200 && open.draft.clientId === clientId && open.draft.rawText === copy);
    const projection = () => internal(`/lifecycle/${open.requestId}/project`, { v: 1, expectedRev: 0, rev: 1,
      key: `${open.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: open.draft }] });
    await interrupt('core.source.after-projection', projection);
    await start(false);
    const replay = await projection(); expect(replay.status).toBe(200);
    const result = await replay.json(), taskId = result.taskId;
    check('projection replay adopts one task after a lost commit acknowledgement', typeof taskId === 'string' &&
      Number((await sql<{ n: string }>`SELECT count(*) AS n FROM hawa.tasks WHERE client_id=${clientId}::uuid`.execute(owner)).rows[0].n) === 1);
    check('projection leaves one task event and one outbox command',
      Number((await sql<{ n: string }>`SELECT count(*) AS n FROM hawa.task_events WHERE task_id=${taskId}::uuid`.execute(owner)).rows[0].n) === 1 &&
      Number((await sql<{ n: string }>`SELECT count(*) AS n FROM hawa.outbox_commands WHERE aggregate_id=${taskId}::uuid`.execute(owner)).rows[0].n) === 1);
    const task = await (await desk(`/tasks/${taskId}`)).json();
    check('Desk preserves exact mixed-script copy and linked original', task.copyCkb === copy && task.copyEn === '' && task.sourceDocument.sourceSha256 === hash(pdf));
    const changed = structuredClone(confirmation); changed.message.text = '/use_source\nChanged';
    check('changed confirmation body remains a conflict after all restarts', (await (await intake(changed)).json()).intakeStatus === 409);
    check('six Core processes did not repeat download or extraction', starts === 6 && kills === 5 && downloads === 1 && parses === 1);
    check('copy confirmation never promotes source knowledge', Number((await sql<{ n: string }>`SELECT count(*) AS n FROM hawa.client_document_knowledge_events WHERE client_id=${clientId}::uuid`.execute(owner)).rows[0].n) === 0);
    completed = true;
  } finally {
    await stop('SIGTERM'); bridge.closeAllConnections(); await new Promise<void>(resolve => bridge.close(() => resolve()));
    await Promise.all([owner.destroy(), runtime.destroy()]); await rm(work, { recursive: true, force: true });
    if (process.env.HAWA_SOURCE_RECOVERY_REPORT) {
      const files = ['apps/core/test/lifecycle-source-recovery.test.ts','apps/core/test/fixtures/document-recovery-process.ts',
        'apps/core/src/services/lifecycle-source-admission.ts','apps/core/src/services/lifecycle-source-intake.ts',
        'apps/core/src/services/lifecycle-source-store.ts','apps/core/src/services/lifecycle-projection.ts',
        'apps/core/src/routes/lifecycle-internal.routes.ts','apps/core/src/routes/source-files.routes.ts',
        'packages/domain/src/telegram-source-review.ts','packages/integrations/src/telegram-bridge.ts','packages/db/migrations/043_lifecycle_source_retention.sql'];
      await writeFile(process.env.HAWA_SOURCE_RECOVERY_REPORT, JSON.stringify({ date: new Date().toISOString(),
        status: completed && checks.every(check => check.passed) && kills === 5 ? 'passed' : 'failed', durationMs: Date.now() - started,
        sourcePdfSha256: hash(pdf), parserImageId: image.stdout.trim(), parserVersion: extraction.version,
        starts, kills, downloads, parses, events, checks,
        sourceHashes: Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))]))),
        limits: ['Disposable same-host PostgreSQL and blob directory; not clean-host restore or production RPO/RTO',
          'Real offline Docling extraction replayed by local bridge; Telegram transport uses fixed local fixtures',
          'Actual Core HTTP processes and runtime role; no live Telegram, Restate worker, Canva export or human quality admission'],
      }, null, 2) + '\n');
    }
  }
}, 180000);
