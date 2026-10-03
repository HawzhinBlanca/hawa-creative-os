import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext, DesignStudioRepository } from '@hawa/db';
import { resolveModel } from '@hawa/domain';
import { CallCostAccountingService } from '../src/services/call-cost-accounting.js';
import { createRequesterIntentModel, intentRequestBody, readOnce } from '../src/services/requester-intent-model.js';
import { createApp } from '../src/app.js';
import type { ChatRequestView } from '../src/services/requester-turn.js';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';

/**
 * ADR-289: every paid model call in one report. The intake router's readings (requester, office and
 * copy readers) were charged to the office day but missing from the call list; there was no view of
 * spend by day. Providers are mocked: no request leaves the process.
 */
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!), db = createDb(process.env.TEST_DATABASE_URL!);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await db.destroy(); await owner.destroy(); });
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const key = () => ['sk', 'ledger', 'fixture'].join('-');
const updateId = () => 1_100_000_000 + Math.floor(Math.random() * 800_000_000);
// gpt-4.1-mini in the reservation price table (packages/creative/src/studio/spending-reservation.ts): $0.40 in, $1.60 out per 1M.
const MINI = { model: 'gpt-4.1-mini', input: 0.4, output: 1.6 };
const priced = (input: number, output: number) => Number(((input * MINI.input + output * MINI.output) / 1_000_000).toFixed(6));

async function fixture(office = false) {
  const tenantId = office ? '00000000-0000-4000-a000-000000000001' : randomUUID(), userId = randomUUID(), clientId = randomUUID();
  const taskId = randomUUID(), runId = randomUUID();
  const token = `hawa_sess_${randomUUID().replaceAll('-', '')}`, sessionHash = hash(token);
  const scope = { tenantId, userId, role: 'administrator', sessionHash };
  await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Ledger fixture',${tenantId}) ON CONFLICT DO NOTHING`.execute(owner);
  await sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES(${userId}::uuid,${userId + '@example.test'},'Named administrator',${userId})`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'administrator')`.execute(owner);
  // Intake readings are admitted as System Automation, an operator of the office (as in production).
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${SYSTEM_AUTOMATION_USER_ID}::uuid,'operator') ON CONFLICT DO NOTHING`.execute(owner);
  const policy = { mode: 'approved_providers', allowedProviders: ['openai'] };
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name,model_egress_policy) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Ledger fixture',${JSON.stringify(policy)}::jsonb)`.execute(owner);
  const dna = { privacy: { modelEgressMode: 'approved_providers', allowedProviders: ['openai'] } };
  await sql`INSERT INTO hawa.client_dna_versions(tenant_id,client_id,version,status,dna,content_hash,approved_by)
    VALUES(${tenantId}::uuid,${clientId}::uuid,1,'active',${JSON.stringify(dna)}::jsonb,${hash(JSON.stringify(dna))},${userId}::uuid)`.execute(owner);
  await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Ledger fixture')`.execute(owner);
  await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
    VALUES(${sessionHash},${tenantId}::uuid,${userId}::uuid,'oidc:ledger-fixture','administrator','Named administrator',now()+interval '1 hour','google_oidc')`.execute(owner);
  const tx = <T>(fn: Parameters<typeof withRlsContext<T>>[2]) => withRlsContext(db, scope, fn);
  const repo = new DesignStudioRepository(db), service = new CallCostAccountingService(db);
  await repo.createRun({ id: runId, tenantId, taskId, clientId, actorId: userId, requestKey: runId, requestHash: hash(runId), request: {}, tier: 'standard' });
  /** A Studio parity call (role visual_judge) with a $0.10 estimate on a $0.50 reservation. */
  async function studio() {
    const id = randomUUID();
    await repo.recordCallStart({ id, tenantId, runId, actorId: userId, stage: 'parity', provider: 'openai', model: 'synthetic', requestedModel: 'synthetic',
      callOrdinal: null, logicalCallSha256: hash(id), reservation: { version: 1, policy: 'synthetic', requestSha256: hash(id), usd: .5, inputTokens: 100, outputTokens: 100 } });
    await repo.finalizeCall({ id, tenantId, status: 'ok', inputTokens: 0, outputTokens: 0, usdEstimate: .1, costBasis: 'estimate', responseId: 'synthetic-reply' });
    return id;
  }
  /** A received transcription: Whisper reports no cost, so its $0.006 reservation stays held. */
  async function voice() {
    const sourceSha = hash(randomUUID()), source = String(updateId()), k = hash(`voice-v1:${clientId}:${sourceSha}`);
    const upload = { clientId, blob: { sha256: sourceSha } };
    const attempt = { key: k, clientId, sourceSha256: sourceSha, sourceUpdateId: source, estimatedMicrousd: 6000, model: 'whisper-1' };
    const outcome = { key: k, sourceSha256: sourceSha, actualUsd: null, result: { providerOutcome: 'received', transcript: 'synthetic' } };
    await tx(q => sql`INSERT INTO hawa.inbox_events(tenant_id,source_account_id,source_event_id,event_kind,payload,payload_hash,verified)
      VALUES(${tenantId}::uuid,'lifecycle_source_upload',${source},'lifecycle_source_upload',${JSON.stringify(upload)}::jsonb,${hash(JSON.stringify(upload))},true)`.execute(q));
    const id = (await tx(q => sql<{ id: string }>`INSERT INTO hawa.inbox_events(tenant_id,source_account_id,source_event_id,event_kind,payload,payload_hash,verified)
      VALUES(${tenantId}::uuid,'lifecycle_voice_attempt',${k},'lifecycle_voice_attempt',${JSON.stringify(attempt)}::jsonb,${hash(JSON.stringify(attempt))},true) RETURNING id`.execute(q))).rows[0].id;
    await tx(q => sql`INSERT INTO hawa.inbox_events(tenant_id,source_account_id,source_event_id,event_kind,payload,payload_hash,verified)
      VALUES(${tenantId}::uuid,'lifecycle_voice_outcome',${k},'lifecycle_voice_outcome',${JSON.stringify(outcome)}::jsonb,${hash(JSON.stringify(outcome))},true)`.execute(q));
    return id;
  }
  /** An intake ledger row written as readOnce writes it, without a provider: admitted, then its outcome. */
  async function intakeRow(outcome: { costUsd: number | null; basis: 'usage' | 'unavailable' } | null, reservationUsd = .01) {
    const id = randomUUID(), body = hash(id);
    await tx(q => sql`INSERT INTO hawa.requester_intent_calls(id,tenant_id,update_id,chat_id,client_id,model,request_sha256,reservation)
      VALUES(${id}::uuid,${tenantId}::uuid,${updateId()},'64000001',${clientId}::uuid,${MINI.model},${body},
        ${JSON.stringify({ usd: reservationUsd, requestSha256: body })}::jsonb)`.execute(q));
    if (outcome) await tx(q => sql`UPDATE hawa.requester_intent_calls SET status='completed',
        acceptance=${outcome.basis === 'usage' ? 'response_received' : 'unknown'},cost_basis=${outcome.basis},cost_usd=${outcome.costUsd}
      WHERE id=${id}::uuid`.execute(q));
    return id;
  }
  const rows = async () => (await sql<{ id: string; update_id: string; status: string; cost_usd: string | null; input_tokens: string | null;
    output_tokens: string | null; served_model: string | null; reservation: any }>`SELECT id,update_id::text,status,cost_usd::text,input_tokens::text,
      output_tokens::text,served_model,reservation FROM hawa.requester_intent_calls WHERE tenant_id=${tenantId}::uuid ORDER BY started_at`.execute(owner)).rows;
  return { tenantId, userId, clientId, token, scope, tx, service, studio, voice, intakeRow, rows };
}

const completion = (decision: Record<string, unknown>, usage = { prompt_tokens: 420, completion_tokens: 30, total_tokens: 450 }) =>
  new Response(JSON.stringify({ id: `chatcmpl-${randomUUID().slice(0, 8)}`, model: MINI.model, usage,
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] }), { headers: { 'x-request-id': 'req_ledger_fixture' } });
const view = (client: string): ChatRequestView => ({ requestId: randomUUID(), stage: 'manual', rev: 1, currentTaskId: randomUUID(), clientId: client,
  title: 'Members evening', activeAt: new Date().toISOString(), createdAt: new Date().toISOString(), question: null, requesterId: null });

it('writes one ledger row per paid reading, none on replay, priced from the model price table, for every intake reader', async () => {
  vi.stubEnv('HAWA_MODEL_TEXT', MINI.model);
  expect(resolveModel('text')).toBe(MINI.model);
  const f = await fixture(), update = updateId(), chatId = '64000002';
  const fetcher = vi.fn(async () => completion({ kind: 'change', design: 1, confidence: 0.9 }));
  const router = createRequesterIntentModel(db, { fetcher: fetcher as any, apiKey: key });
  const input = { tenantId: f.tenantId, updateId: update, chatId, text: 'Members evening, 5 October', requests: [view(f.clientId)], lang: 'en' as const };
  await router.read(input);
  await router.read(input); // a retried Restate step reads the same update again
  const other = (reader: 'office' | 'copy') => readOnce(db, { fetcher: fetcher as any, apiKey: key }, { reader, tenantId: f.tenantId,
    updateId: update, chatId, clientId: f.clientId, egressClients: [f.clientId], body: (model) => intentRequestBody(model, `${reader} reading`, []),
    parse: (v) => (v && typeof v === 'object' ? v as object : null) });
  for (const reader of ['office', 'copy', 'office', 'copy'] as const) await other(reader);
  // Three readers, one paid call each; the replays found their rows and sent nothing.
  expect(fetcher).toHaveBeenCalledTimes(3);
  const rows = await f.rows();
  expect(rows).toHaveLength(3);
  expect(rows.map(r => r.reservation.reader ?? 'requester').sort()).toEqual(['copy', 'office', 'requester']);
  for (const row of rows) {
    expect(row).toMatchObject({ status: 'completed', input_tokens: '420', output_tokens: '30', served_model: MINI.model });
    expect(Number(row.cost_usd)).toBe(priced(420, 30));
  }
  expect(priced(420, 30)).toBe(0.000216);
});

it('lists intake readings with the other paid calls, read-only, charged as the office day charges them', async () => {
  const f = await fixture();
  const studio = await f.studio(), voice = await f.voice();
  const used = await f.intakeRow({ costUsd: 0.000216, basis: 'usage' });
  const unknown = await f.intakeRow({ costUsd: null, basis: 'unavailable' }, .02);
  const stopped = await f.intakeRow(null, .03); // Core stopped before writing the outcome
  const list = await f.service.list(f.scope);
  expect(list.items.map(i => `${i.kind}:${i.id}`).sort()).toEqual(
    [`studio:${studio}`, `voice:${voice}`, `intake_router:${used}`, `intake_router:${unknown}`, `intake_router:${stopped}`].sort());
  const byId = new Map(list.items.map(i => [i.id, i]));
  expect(byId.get(used)).toMatchObject({ kind: 'intake_router', accountedCostUsd: 0.000216, originalCostUsd: 0.000216, reservedUsd: .01,
    status: 'response_received', reader: 'requester', requiresCostEvidence: false, clientId: f.clientId, chatId: '64000001' });
  expect(byId.get(unknown)).toMatchObject({ accountedCostUsd: .02, originalCostUsd: null, status: 'unknown' });
  expect(byId.get(stopped)).toMatchObject({ accountedCostUsd: .03, status: 'started' });
  const detail = await f.service.get(f.scope, 'intake_router', used);
  expect(detail).toMatchObject({ canRecord: false, snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  // An intake reading is never attested: nothing about it is uncertain to the office day.
  await expect(f.service.record(f.scope, 'intake_router', used, randomUUID(), {})).rejects.toMatchObject({ status: 409, code: 'CALL_COST_NOT_ATTESTABLE' });
  await expect(f.service.get(f.scope, 'intake_router', randomUUID())).rejects.toMatchObject({ status: 404 });
  // Another office sees none of it.
  const other = await fixture();
  await expect(other.service.get(other.scope, 'intake_router', used)).rejects.toMatchObject({ status: 404 });
  expect((await other.service.list(other.scope)).items).toHaveLength(0);
});

it('pages intake readings and other calls at equal times without omitting or repeating any', async () => {
  const f = await fixture(), ids: string[] = [];
  for (let i = 0; i < 26; i++) ids.push(await f.voice());
  for (let i = 0; i < 26; i++) ids.push(await f.intakeRow({ costUsd: 0.0001, basis: 'usage' }));
  await owner.transaction().execute(async tx => {
    await sql`ALTER TABLE hawa.inbox_events DISABLE TRIGGER enforce_voice_spending`.execute(tx);
    await sql`ALTER TABLE hawa.requester_intent_calls DISABLE TRIGGER enforce_requester_intent_call`.execute(tx);
    await sql`UPDATE hawa.inbox_events SET received_at='2000-01-01' WHERE tenant_id=${f.tenantId}::uuid AND source_account_id='lifecycle_voice_attempt'`.execute(tx);
    await sql`UPDATE hawa.requester_intent_calls SET started_at='2000-01-01' WHERE tenant_id=${f.tenantId}::uuid`.execute(tx);
    await sql`ALTER TABLE hawa.requester_intent_calls ENABLE TRIGGER enforce_requester_intent_call`.execute(tx);
    await sql`ALTER TABLE hawa.inbox_events ENABLE TRIGGER enforce_voice_spending`.execute(tx);
  });
  const first = await f.service.list(f.scope);
  expect(first.items).toHaveLength(50); expect(first.nextCursor).toBeTruthy();
  const second = await f.service.list(f.scope, first.nextCursor!);
  expect(second.items).toHaveLength(2); expect(second.nextCursor).toBeNull();
  expect([...first.items, ...second.items].map(c => c.id).sort()).toEqual(ids.sort());
  // Same instant: kind descending, so every voice call comes before every intake reading.
  const kinds = [...first.items, ...second.items].map(c => c.kind);
  expect(kinds.lastIndexOf('voice')).toBeLessThan(kinds.indexOf('intake_router'));
});

it('adds up spend by office day and role, intake and voice included, equal to the call list', async () => {
  const f = await fixture();
  await f.studio(); await f.voice();
  await f.intakeRow({ costUsd: 0.000216, basis: 'usage' });
  await f.intakeRow({ costUsd: null, basis: 'unavailable' }, .02);
  const summary = await f.service.summary(f.scope, undefined);
  const today = (await sql<{ d: string }>`SELECT (clock_timestamp() AT TIME ZONE 'Asia/Baghdad')::date::text AS d`.execute(owner)).rows[0].d;
  expect(summary).toMatchObject({ timezone: 'Asia/Baghdad', to: today, calls: 4 });
  expect(summary.days).toHaveLength(1);
  expect(summary.days[0]).toMatchObject({ day: today, calls: 4 });
  const role = (r: string) => summary.roles.find(x => x.role === r);
  expect(role('intake_router')).toEqual({ role: 'intake_router', calls: 2, accountedUsd: 0.020216, awaitingEvidence: 0, heldUsd: 0 });
  expect(role('visual_judge')).toEqual({ role: 'visual_judge', calls: 1, accountedUsd: .1, awaitingEvidence: 1, heldUsd: .4 });
  // Whisper reports no cost: the transcription counts nothing yet and holds its whole reservation.
  expect(role('voice_transcriber')).toEqual({ role: 'voice_transcriber', calls: 1, accountedUsd: 0, awaitingEvidence: 1, heldUsd: .006 });
  const listed = (await f.service.list(f.scope)).items.reduce((n, i) => n + i.accountedCostUsd, 0);
  expect(summary.accountedUsd).toBeCloseTo(listed, 9);
  expect(summary.accountedUsd).toBe(0.120216);
  // Bounds, and membership rather than the session's claim decides who may read every ledger.
  for (const days of ['0', '93', 'x']) await expect(f.service.summary(f.scope, days)).rejects.toMatchObject({ status: 400 });
  await sql`UPDATE hawa.tenant_memberships SET role='auditor' WHERE tenant_id=${f.tenantId}::uuid AND user_id=${f.userId}::uuid`.execute(owner);
  await expect(f.service.summary(f.scope, '14')).rejects.toMatchObject({ status: 403, code: 'SPENDING_SUMMARY_FORBIDDEN' });
});

it('serves the summary to the Desk over HTTP', async () => {
  const f = await fixture(true);
  await f.intakeRow({ costUsd: 0.000216, basis: 'usage' });
  vi.stubEnv('HAWA_GOOGLE_OIDC_CLIENT_ID', 'test-client'); vi.stubEnv('HAWA_GOOGLE_OIDC_CLIENT_SECRET', 'test-client-secret');
  vi.stubEnv('HAWA_GOOGLE_OIDC_REDIRECT_URI', 'https://desk.office.example/v1/auth/google/callback'); vi.stubEnv('HAWA_GOOGLE_OIDC_HOSTED_DOMAINS', 'example.test');
  const app = createApp({ db, skipPaidModelProbe: true, skipTelegramProbe: true });
  const headers = { Cookie: `hawa_session=${f.token}` };
  const res = await app.request('/v1/spending/summary?days=7', { headers });
  expect(res.status, await res.clone().text()).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  const body = await res.json() as any;
  expect(body.roles.find((r: any) => r.role === 'intake_router')).toMatchObject({ calls: 1, accountedUsd: 0.000216 });
  expect((await app.request('/v1/spending/summary?days=400', { headers })).status).toBe(400);
  const listed = await (await app.request('/v1/spending/calls', { headers })).json() as any;
  expect(listed.items.some((i: any) => i.kind === 'intake_router')).toBe(true);
  expect((await app.request('/v1/spending/summary')).status).toBe(401);
});
