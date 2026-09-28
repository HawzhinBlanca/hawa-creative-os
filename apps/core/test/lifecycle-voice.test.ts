import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { TelegramBridgeDaemon } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { savedDesignCopy } from '../src/services/canva-design-planner.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

const db = createDb(process.env.TEST_DATABASE_URL!), owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001', userId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId, role: 'operator' as const }, worker = `fixture-${randomUUID()}`;
const headers = { Authorization: `Bearer ${worker}`, 'Content-Type': 'application/json' };
const audio = await readFile(new URL('../../../packages/testkit/fixtures/voice/silence-one-second.ogg', import.meta.url));
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const next = () => Math.floor(Math.random() * 1_000_000_000) + 1;
const instances: ReturnType<typeof createApp>[] = [];
const app = (desk = false) => { const a = createApp({ db, ...(desk ? { testAuth: { principal: scope } } : {}) }); instances.push(a); return a; };
beforeEach(async () => {
  vi.stubEnv('HAWA_WORKER_TOKEN', worker); vi.stubEnv('OPENAI_API_KEY', randomUUID());
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_GLOBAL', '1000000');
  vi.spyOn(TelegramBridgeDaemon.prototype, 'downloadFile').mockResolvedValue(audio);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ text: '  Unreviewed دە دۆلار\nsource_01  ' })));
  await owner.transaction().execute(async tx=>{
    await sql`ALTER TABLE hawa.inbox_events DISABLE TRIGGER enforce_voice_spending`.execute(tx);
    await sql`DELETE FROM hawa.inbox_events WHERE source_account_id LIKE 'lifecycle_voice_%'`.execute(tx);
    await sql`ALTER TABLE hawa.inbox_events ENABLE TRIGGER enforce_voice_spending`.execute(tx);
  });
  await sql`DELETE FROM hawa.model_deployments WHERE tenant_id=${tenantId}::uuid AND role='voice_transcriber'`.execute(owner);
  await sql`INSERT INTO hawa.model_deployments(tenant_id,role,provider,exact_model_id,deployment_version,admission,policy_profile)
    VALUES (${tenantId}::uuid,'voice_transcriber','openai','whisper-1','synthetic-fixture-v1','canary',
      '{"usdPerMinute":0.006,"maxUsdPerCall":0.1,"dailyUsdBudget":1,"maxCallsPerDay":100}'::jsonb)`.execute(owner);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await Promise.all(instances.map(a => a.clientDnaHydrated)); await Promise.all([db.destroy(), owner.destroy()]); });
async function fixture(localOnly = false) {
  const clientId = randomUUID(), code = `voice-${next()}`, chat = next(), id = next();
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES (${clientId}::uuid,${tenantId}::uuid,${code},${code})`.execute(owner);
  const dna = { privacy: { modelEgressMode: localOnly ? 'local_only' : 'approved_providers', allowedProviders: ['openai'] } };
  await sql`INSERT INTO hawa.client_dna_versions(tenant_id,client_id,version,status,dna,content_hash,approved_by)
    VALUES (${tenantId}::uuid,${clientId}::uuid,1,'active',${JSON.stringify(dna)}::jsonb,${hash(JSON.stringify(dna))},${userId}::uuid)`.execute(owner);
  const update = { update_id: id, message: { message_id: id, from: { id: next(), is_bot: false, first_name: 'Fixture' },
    chat: { id: chat, type: 'private' }, caption: `/new\nClient: ${code}\nUse editable typography.`,
    voice: { file_id: 'original-voice', mime_type: 'audio/ogg', file_size: audio.length, duration: 999_999 } } };
  const confirm = (copy = '  Reviewed 123\nنرخ ١٢٣\n_____  ') => ({ update_id: next(), message: {
    message_id: next(), from: update.message.from, chat: update.message.chat,
    reply_to_message: { message_id: id }, text: `/use_source\n${copy}` } });
  return { clientId, code, update, confirm };
}
async function intake(update: unknown, instance = app()) {
  const response = await instance.request('/v1/internal/telegram/intake', { method: 'POST', headers,
    body: JSON.stringify({ v: 1, update, mode: 'lifecycle' }) });
  expect(response.status, await response.clone().text()).toBe(200); return response.json();
}
async function project(open: { requestId: string; draft: unknown }) {
  return app().request(`/v1/internal/lifecycle/${open.requestId}/project`, { method: 'POST', headers,
    body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1, key: `${open.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: open.draft }] }) });
}
const count = async (kind: string) => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM hawa.inbox_events
  WHERE tenant_id=${tenantId}::uuid AND source_account_id=${kind}`.execute(owner)).rows[0].n);

describe('retained voice admission and reviewed request', () => {
  it('refuses shared client-budget admission and still permits exact manual copy review',async()=>{
    const f=await fixture();
    await withRlsContext(owner,scope,tx=>sql`INSERT INTO hawa.studio_spending_policies(tenant_id,version,reason,limits)
      SELECT ${tenantId}::uuid,coalesce(max(version),0)+1,'Synthetic client stop',
      ${JSON.stringify({officeUsd:30,clientUsd:30,roleUsd:30,clients:{[f.clientId]:0},roles:{}})}::jsonb
      FROM hawa.studio_spending_policies WHERE tenant_id=${tenantId}::uuid`.execute(tx));
    const held=await intake(f.update);
    expect(held.sourceMessage).toContain('shared');expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(await count('lifecycle_voice_attempt')).toBe(0);
    expect((await project(await intake(f.confirm()))).status).toBe(200);
  });
  it('retains real audio, reserves its actual packet timing, preserves raw transcript and creates one reviewed request', async () => {
    const f = await fixture(); const received = await intake(f.update);
    expect(received).toMatchObject({ lifecycleAction: 'source-message', intakeStatus: 200 });
    expect(received.sourceMessage).toContain('Unreviewed دە دۆلار');
    expect(received.sourceMessage).toContain('$0.006'); expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const reader = app(true), path = `/v1/clients/${f.clientId}/source-files/${f.update.update_id}`;
    const original = await reader.request(`${path}/content`);
    expect(original.status).toBe(200); expect(original.headers.get('Content-Type')).toBe('audio/ogg');
    expect(hash(new Uint8Array(await original.arrayBuffer()))).toBe(hash(audio));
    const review = await reader.request(`${path}/review`); expect(review.status).toBe(200);
    expect(await review.json()).toMatchObject({ clientId: f.clientId, state: 'received', actualUsd: null,
      estimatedUsd: 0.006, transcript: '  Unreviewed دە دۆلار\nsource_01  ', audio: { durationSeconds: 1 } });
    const confirmation = f.confirm(), copy = confirmation.message.text.slice('/use_source\n'.length);
    const opened = await intake(confirmation); expect((await project(opened)).status).toBe(200);
    expect((await project(await intake(confirmation))).status).toBe(200);
    const rows = (await sql<{ payload: Record<string, unknown> }>`SELECT o.payload FROM hawa.tasks t
      JOIN hawa.outbox_commands o ON o.aggregate_id=t.id AND o.command_type='task.created' WHERE t.client_id=${f.clientId}::uuid`.execute(owner)).rows;
    expect(rows).toHaveLength(1); expect(savedDesignCopy(rows[0].payload, 'fallback').copy).toEqual([copy]);
    expect(rows[0].payload.reviewedSource).toMatchObject({ kind: 'voice', clientId: f.clientId, sourceSha256: hash(audio) });
  });

  it('makes zero provider calls for local-only DNA and keeps the original available for manual reviewed copy', async () => {
    const f = await fixture(true); const held = await intake(f.update);
    expect(held.sourceMessage).toContain('privacy'); expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(await count('lifecycle_voice_attempt')).toBe(0);
    const opened = await intake(f.confirm()); expect((await project(opened)).status).toBe(200);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('a saved manual decision remains manual after policy, key and enrolment changes', async () => {
    const f = await fixture(true); const first = await intake(f.update);
    await sql`UPDATE hawa.client_dna_versions SET dna=jsonb_set(dna,'{privacy,modelEgressMode}','"approved_providers"') WHERE client_id=${f.clientId}::uuid`.execute(owner);
    expect(await intake(f.update)).toEqual(first); expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('concurrent processes and duplicate source updates share one paid attempt and outcome', async () => {
    const f = await fixture();
    const answers = await Promise.all([intake(f.update, app()), intake(f.update, app())]);
    expect(answers.every(a => a.lifecycleAction === 'source-message')).toBe(true);
    const another = structuredClone(f.update); another.update_id = next(); another.message.message_id = another.update_id;
    expect((await intake(another)).sourceMessage).toContain('Unreviewed دە دۆلار');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(await count('lifecycle_voice_attempt')).toBe(1); expect(await count('lifecycle_voice_outcome')).toBe(1);
  });

  it('unknown provider acceptance survives restart and original-message resend without a second call', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('lost response'));
    const f = await fixture(); const held = await intake(f.update);
    expect(held.sourceMessage).toContain('uncertain'); expect(await intake(f.update, app())).toEqual(held);
    const another = structuredClone(f.update); another.update_id = next(); another.message.message_id = another.update_id;
    expect((await intake(another)).sourceMessage).toContain('uncertain'); expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const opened = await intake(f.confirm()); expect((await project(opened)).status).toBe(200);
    expect(await count('lifecycle_voice_attempt')).toBe(1);
  });

  it('an admitted attempt with no outcome remains held after app restart and can be manually reviewed', async () => {
    const f = await fixture(); await intake(f.update);
    await owner.transaction().execute(async tx=>{
      await sql`ALTER TABLE hawa.inbox_events DISABLE TRIGGER enforce_voice_spending`.execute(tx);
      await sql`DELETE FROM hawa.inbox_events WHERE source_account_id='lifecycle_voice_outcome'`.execute(tx);
      await sql`ALTER TABLE hawa.inbox_events ENABLE TRIGGER enforce_voice_spending`.execute(tx);
    });
    const held = await intake(f.update, app()); expect(held.sourceMessage).toContain('outcome is not recorded');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect((await project(await intake(f.confirm()))).status).toBe(200);
  });

  it.each(['client policy','no deployment','missing key','budget'])('holds %s before paid transport', async reason => {
    const f = await fixture();
    if (reason === 'client policy') await sql`UPDATE hawa.clients SET model_egress_policy='{"mode":"local_only"}'::jsonb WHERE id=${f.clientId}::uuid`.execute(owner);
    if (reason === 'no deployment') await sql`UPDATE hawa.model_deployments SET admission='candidate' WHERE role='voice_transcriber'`.execute(owner);
    if (reason === 'missing key') vi.stubEnv('OPENAI_API_KEY', '');
    if (reason === 'budget') await sql`UPDATE hawa.model_deployments SET policy_profile=jsonb_set(policy_profile,'{dailyUsdBudget}','0.001') WHERE role='voice_transcriber'`.execute(owner);
    const result = await intake(f.update); expect(result.lifecycleAction).toBe('source-message');
    expect(globalThis.fetch).not.toHaveBeenCalled(); expect(await count('lifecycle_voice_attempt')).toBe(0);
    expect((await project(await intake(f.confirm()))).status).toBe(200);
  });

  it('refuses malformed bytes durably before transcription or task creation', async () => {
    vi.mocked(TelegramBridgeDaemon.prototype.downloadFile).mockResolvedValue(Buffer.from('not voice'));
    const f = await fixture(); const rejected = await intake(f.update);
    expect(rejected.intakeStatus).toBe(422); expect(await intake(f.update)).toEqual(rejected);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('serializes the daily reservation limit across different clients and app instances', async () => {
    await sql`UPDATE hawa.model_deployments SET policy_profile=jsonb_set(policy_profile,'{maxCallsPerDay}','1') WHERE role='voice_transcriber'`.execute(owner);
    const first = await fixture(), second = await fixture();
    const answers = await Promise.all([intake(first.update, app()), intake(second.update, app())]);
    expect(answers.filter(a => a.sourceMessage.includes('daily transcription'))).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); expect(await count('lifecycle_voice_attempt')).toBe(1);
  });

  it('transcript inspection and original download cannot cross current client membership', async () => {
    const f = await fixture(); await intake(f.update); const readerId = randomUUID();
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES (${readerId}::uuid,${`${readerId}@example.test`},'Voice reader')`.execute(owner);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active) VALUES (${tenantId}::uuid,${readerId}::uuid,'designer',true)`.execute(owner);
    await expect(withRlsContext(db, { ...scope, userId: readerId }, trx =>
      sql`SELECT * FROM hawa.lock_voice_deployments()`.execute(trx))).rejects.toMatchObject({ code: '42501' });
    const reader = createApp({ db, testAuth: { principal: { ...scope, userId: readerId } } }); instances.push(reader);
    const path = `/v1/clients/${f.clientId}/source-files/${f.update.update_id}`;
    expect((await reader.request(`${path}/review`)).status).toBe(404);
    await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role,active) VALUES (${tenantId}::uuid,${f.clientId}::uuid,${readerId}::uuid,'designer',true)`.execute(owner);
    expect((await reader.request(`${path}/review`)).status).toBe(200);
    await sql`UPDATE hawa.client_memberships SET active=false WHERE user_id=${readerId}::uuid`.execute(owner);
    expect((await reader.request(`${path}/review`)).status).toBe(404);
    expect((await reader.request(`${path}/content`)).status).toBe(404);
  });

  it('a voice revision retains the existing client/format and uses exact corrected copy only once', async () => {
    const f = await fixture(true), requestId = randomUUID(), noticeId = next();
    const original = await persistChatIntake(db, { platform: 'telegram', sourceEventId: `voice-seed-${requestId}`,
      sourceChannelId: String(f.update.message.chat.id), clientId: f.clientId, rawText: 'Original', title: 'Original',
      exactCopy: [{ text: 'Old copy' }], designInstructions: 'Keep approved brand assets.', variant: { width: 1080, height: 1920 },
      autoGenerate: false }, { outboxState: 'recorded' });
    const taskId = String(original.task.id);
    await sql`INSERT INTO hawa.requests(request_id,tenant_id,root_task_id,current_task_id,owner,stage,rev,chat_id)
      VALUES (${requestId}::uuid,${tenantId}::uuid,${taskId}::uuid,${taskId}::uuid,'restate','manual',3,${String(f.update.message.chat.id)})`.execute(owner);
    await sql`UPDATE hawa.tasks SET request_id=${requestId}::uuid WHERE id=${taskId}::uuid`.execute(owner);
    await sql`INSERT INTO hawa.inbox_events(tenant_id,source_account_id,source_event_id,event_kind,payload,payload_hash,verified)
      VALUES (${tenantId}::uuid,'telegram_delivery',${`lc:${requestId}:3:office-revision-notify:send`},'telegram_message_sent',
      ${JSON.stringify({ messageId: noticeId })}::jsonb,${hash('voice-notice')},true)`.execute(owner);
    f.update.message.caption = 'Use this revised copy.'; Object.assign(f.update.message, { reply_to_message: { message_id: noticeId } });
    expect((await intake(f.update)).intakeStatus).toBe(200);
    const confirmation = f.confirm('  Corrected 123\n_____  '), revised = await intake(confirmation);
    expect(revised).toMatchObject({ intakeStatus: 200, lifecycleAction: 'requester-revision', requestId, priorTaskId: taskId });
    const row = (await sql<{ payload: Record<string, unknown> }>`SELECT payload FROM hawa.outbox_commands
      WHERE aggregate_id=${revised.newTaskId}::uuid AND command_type='task.created'`.execute(owner)).rows[0];
    expect(savedDesignCopy(row.payload, 'fallback').copy).toEqual(['  Corrected 123\n_____  ']);
    expect(row.payload.variant).toEqual({ width: 1080, height: 1920 });
    expect((await intake(confirmation)).newTaskId).toBe(revised.newTaskId);
    const stale = structuredClone(f.update); stale.update_id = next(); stale.message.message_id = next();
    expect((await intake(stale)).intakeStatus).toBe(409);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
