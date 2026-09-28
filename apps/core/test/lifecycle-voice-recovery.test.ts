import { createHash, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
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

it.skipIf(process.env.HAWA_VOICE_RECOVERY !== '1')('survives actual Core kills without repeating uncertain voice calls or losing reviewed work', async () => {
  assertTestDatabaseEnv(process.env);
  const databaseUrl = process.env.TEST_DATABASE_URL!, ownerUrl = process.env.TEST_DATABASE_OWNER_URL!;
  for (const url of [databaseUrl, ownerUrl]) {
    const target = connectionTargetOf(url);
    expect(['127.0.0.1', 'localhost']).toContain(target.host); expect(Number(target.port)).toBe(55432);
    expect(target.database).toMatch(/^hawa_t_[a-z0-9_]+$/);
  }
  const blobDir = process.env.HAWA_BLOB_DIR!; expect(blobDir.startsWith(join(tmpdir(), 'hawa-test-blobs-'))).toBe(true);
  const tenantId = '00000000-0000-4000-a000-000000000001', userId = randomUUID(), senderId = 297527;
  const workerToken = `fixture-${randomUUID()}`, session = `hawa_sess_${randomUUID().replaceAll('-', '')}`;
  const botToken = ['123456', 'voice-recovery-fixture'].join(':');
  const audio = await readFile(join(root, 'packages/testkit/fixtures/voice/silence-one-second.ogg'));
  const transcript = '  Unreviewed دە دۆلار\noriginal_01  ', copy = '  Confirmed 123\nنرخ ١٢٣\n_____  ';
  const checks: Array<{ name: string; passed: boolean }> = [], events: string[] = [];
  const check = (name: string, value: boolean) => { checks.push({ name, passed: value }); expect(value, name).toBe(true); };
  const started = Date.now(), owner = createDb(ownerUrl);
  const work = await mkdtemp(join(tmpdir(), 'hawa-pdf-recovery-'));
  let child: ChildProcess | undefined, api = '', armed = '', held: ServerResponse | undefined;
  let reached: (() => void) | undefined, downloads = 0, transcriptions = 0, starts = 0, kills = 0, completed = false;
  const bridge = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (req.url === '/telegram/getFile') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result: { file_path: 'sources/fixture.ogg', file_size: audio.length } })); return; }
      if (req.url === '/telegram/file') { downloads++; res.setHeader('Content-Type', 'audio/ogg'); res.end(audio); return; }
      if (req.url === '/transcribe') {
        check(`provider call ${transcriptions + 1} carries original bytes`, bytes.includes(audio));
        transcriptions++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ text: transcript })); return;
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
      const [, actual] = await within(exiting, 10000, () => 'Voice recovery Core did not exit');
      if (signal === 'SIGKILL') check(`kill ${++kills} terminated Core with SIGKILL`, actual === 'SIGKILL');
    } finally { clearTimeout(fallback); held?.destroy(); held = undefined; child = undefined; }
  };
  const start = async () => {
    let stderr = '';
    child = spawn(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), join(root, 'apps/core/test/fixtures/document-recovery-process.ts')], {
      cwd: work, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {
        PATH: process.env.PATH, NODE_ENV: 'production', HAWA_DOCUMENT_RECOVERY: '1', HAWA_SOURCE_RECOVERY: '1', HAWA_VOICE_RECOVERY: '1',
        TEST_DATABASE_URL: databaseUrl, HAWA_BLOB_DIR: blobDir, HAWA_ACTION_HMAC_SECRET: hash(randomUUID()),
        HAWA_CHAOS_CONTROL_URL: bridgeUrl, HAWA_CHAOS_HOLD_LIMIT_MS: '30000',
        HAWA_WORKER_TOKEN: workerToken, OPENAI_API_KEY: randomUUID(),
        TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_WEBHOOK_SECRET: hash(randomUUID()), TELEGRAM_INTAKE_ALLOWED_USERS: String(senderId),
        AUTO_GENERATE_DAILY_CAP_GLOBAL: '1000000', DESIGN_PIPELINE_V3: 'off', DESIGN_STUDIO_V2: 'off',
        HAWA_GOOGLE_OIDC_CLIENT_ID: 'fixture-client', HAWA_GOOGLE_OIDC_CLIENT_SECRET: 'fixture-secret',
        HAWA_GOOGLE_OIDC_REDIRECT_URI: 'https://desk.example.test/v1/auth/google/callback', HAWA_GOOGLE_OIDC_HOSTED_DOMAINS: 'example.test',
      },
    });
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2500); });
    const ready = new Promise<number>((resolve, reject) => {
      child!.once('message', message => resolve((message as { port: number }).port));
      child!.once('exit', () => reject(new Error(`Voice recovery Core exited before ready: ${stderr}`))); child!.once('error', reject);
    });
    api = `http://127.0.0.1:${await within(ready, 15000, () => `Voice recovery startup timed out: ${stderr}`)}`; starts++;
  };
  const internal = (path: string, body: unknown) => fetch(`${api}/v1/internal${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${workerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const intake = (update: unknown) => internal('/telegram/intake', { v: 1, update, mode: 'lifecycle' });
  const desk = (path: string) => fetch(`${api}/v1${path}`, { headers: { Cookie: `hawa_session=${session}` }, signal: AbortSignal.timeout(10000) });
  const interrupt = async (point: string, action: () => Promise<Response>) => {
    armed = point; const waiting = new Promise<void>(resolve => { reached = resolve; });
    const pending = action().then(response => ({ answered: true, status: response.status }), () => ({ answered: false, status: 0 }));
    await within(waiting, 10000, () => `Voice recovery did not reach ${point}`);
    await stop('SIGKILL'); check(`${point}: no HTTP acknowledgement survives`, !(await pending).answered); events.push(point);
  };
  const count = async (account: string) => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM hawa.inbox_events
    WHERE tenant_id=${tenantId}::uuid AND source_account_id=${account}`.execute(owner)).rows[0].n);
  try {
    await sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES (${userId}::uuid,${`${userId}@example.test`},'Voice fixture operator',${`google-${userId}`})`.execute(owner);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active) VALUES (${tenantId}::uuid,${userId}::uuid,'operator',true)`.execute(owner);
    await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
      VALUES (${hash(session)},${tenantId}::uuid,${userId}::uuid,'oidc:voice-fixture','operator','Voice fixture operator',now()+interval '1 hour','google_oidc')`.execute(owner);
    await sql`INSERT INTO hawa.model_deployments(tenant_id,role,provider,exact_model_id,deployment_version,admission,policy_profile)
      VALUES (${tenantId}::uuid,'voice_transcriber','openai','whisper-1','synthetic-voice-kill-v1','canary',
        '{"usdPerMinute":0.006,"maxUsdPerCall":0.1,"dailyUsdBudget":1,"maxCallsPerDay":100}'::jsonb)`.execute(owner);
    await start();
    const points = ['core.source.after-admission','core.voice.after-attempt','core.voice.after-response','core.voice.after-outcome'];
    for (const [i, point] of points.entries()) {
      const clientId = randomUUID(), code = `voice-kill-${randomUUID().slice(0,8)}`, sourceId = 395270 + i, chat = 195270 + i;
      await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES (${clientId}::uuid,${tenantId}::uuid,${code},${code})`.execute(owner);
      const dna = { privacy: { modelEgressMode: 'approved_providers', allowedProviders: ['openai'] } };
      await sql`INSERT INTO hawa.client_dna_versions(tenant_id,client_id,version,status,dna,content_hash,approved_by)
        VALUES (${tenantId}::uuid,${clientId}::uuid,1,'active',${JSON.stringify(dna)}::jsonb,${hash(JSON.stringify(dna))},${userId}::uuid)`.execute(owner);
      const source = { update_id: sourceId, message: { message_id: sourceId, from: { id: senderId, is_bot: false, first_name: 'Fixture' },
        chat: { id: chat, type: 'private' }, caption: `/new\nClient: ${code}\nUse exact editable copy.`,
        voice: { file_id: 'source-fixture', mime_type: 'audio/ogg', duration: 99999, file_size: audio.length } } };
      await interrupt(point, () => intake(source));
      if (i === 0) await sql`UPDATE hawa.clients SET model_egress_policy='{"mode":"local_only"}'::jsonb WHERE id=${clientId}::uuid`.execute(owner);
      await start();
      const review = await (await intake(source)).json();
      const marker = i === 0 ? 'privacy' : i === 1 || i === 2 ? 'outcome is not recorded' : 'Unreviewed دە دۆلار';
      check(`${point}: restart retains the correct review state`, review.intakeStatus === 200 && review.sourceMessage.includes(marker));
      check(`${point}: no extra provider dispatch`, transcriptions === (i < 2 ? 0 : i - 1));
      const sourcePath = `/clients/${clientId}/source-files/${sourceId}`;
      const original = await desk(`${sourcePath}/content`);
      check(`${point}: original audio remains byte-identical in Desk`, original.status === 200 && hash(new Uint8Array(await original.arrayBuffer())) === hash(audio));
      const evidence = await (await desk(`${sourcePath}/review`)).json();
      check(`${point}: Desk shows unknown billed cost`, evidence.actualUsd === null && evidence.audio.durationSeconds === 1);
      const confirmation = { update_id: 495270 + i, message: { message_id: 495270 + i, from: source.message.from,
        chat: source.message.chat, reply_to_message: { message_id: sourceId }, text: `/use_source\n${copy}` } };
      if (i === 3) { await interrupt('core.source.after-confirmation', () => intake(confirmation)); await start(); }
      const opened = await (await intake(confirmation)).json();
      check(`${point}: reviewed exact copy survives`, opened.intakeStatus === 200 && opened.draft.rawText === copy && opened.draft.clientId === clientId);
      const body = { v: 1, expectedRev: 0, rev: 1, key: `${opened.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: opened.draft }] };
      expect((await internal(`/lifecycle/${opened.requestId}/project`, body)).status).toBe(200);
      expect((await internal(`/lifecycle/${opened.requestId}/project`, body)).status).toBe(200);
      const rows = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM hawa.tasks t JOIN hawa.outbox_commands o ON o.aggregate_id=t.id
        WHERE t.client_id=${clientId}::uuid AND o.command_type='task.created'`.execute(owner)).rows;
      check(`${point}: repeated projection has one task/outbox`, Number(rows[0].n) === 1);
    }
    check('four originals are downloaded once each', downloads === 4);
    check('three admitted attempts retain exactly one completed provider outcome', await count('lifecycle_voice_attempt') === 3 && await count('lifecycle_voice_outcome') === 1);
    check('only two synthetic paid requests reached the bridge', transcriptions === 2);
    check('all five kills and six starts completed', kills === 5 && starts === 6);
    completed = true;
  } finally {
    await stop('SIGTERM'); bridge.closeAllConnections(); await new Promise<void>(resolve => bridge.close(() => resolve()));
    await owner.destroy(); await rm(work, { recursive: true, force: true });
    const report = { completed, checkedAt: new Date().toISOString(), durationMs: Date.now()-started,
      downloads, transcriptions, starts, kills, audioSha256: hash(audio), events, checks,
      provider: 'synthetic loopback HTTP; no external calls or real accuracy claim' };
    if (process.env.HAWA_VOICE_PROOF_PATH) await writeFile(process.env.HAWA_VOICE_PROOF_PATH, JSON.stringify(report,null,2)+'\n');
    console.log('VOICE_RECOVERY_PROOF', JSON.stringify(report));
  }
}, 120000);
