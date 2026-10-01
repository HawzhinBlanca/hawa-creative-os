import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { projectLifecycleDesignOutcome, projectLifecycleOpen } from '../src/services/lifecycle-projection.js';
import { STALE_AFTER_MS, sweepStaleLifecycleRequests } from '../src/services/lifecycle-stale-sweep.js';
import { createRestateInvocationProbe } from '../src/services/restate-invocations.js';

/**
 * ADR-155 (2026-09-30 audit, durability of the one request path), Core's side: a design's office alert
 * reaches every office member, the requester too when they are one, and the requester is told only
 * what was sent; a request that waits too long at a stage only a person moves on is alerted once per
 * stage; health counts request-path invocations that ended failed.
 */
const db = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => db.destroy());
afterEach(() => vi.unstubAllEnvs());

const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };

async function failedDesign(chat: string) {
  const requestId = randomUUID();
  const opened = await projectLifecycleOpen(db, {
    requestId, tenantId, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
    draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: chat,
      rawText: 'Autumn workshop poster', title: 'Autumn workshop poster', designInstructions: 'Use the exact copy',
      exactCopy: ['Autumn workshop poster'], clientId, autoGenerate: true, designStudio: false },
  });
  const runId = `dr-${opened.taskId}`;
  const result = await projectLifecycleDesignOutcome(db, {
    requestId, tenantId, taskId: opened.taskId, runId, expectedRev: 1, rev: 2,
    key: `${requestId}:2:designFinished:${runId}`, report: { status: 'DESIGN_FAILED', code: 'STUDIO_FAILED' },
  });
  return { requestId, taskId: opened.taskId, result };
}

describe('D5: a design\'s office alert reaches every office member', () => {
  it('the requester\'s own request still alerts the office (they are a member), and the others with them', async () => {
    const chat = String(64_000_000 + Math.floor(Math.random() * 8_000_000));
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', `${chat},91000077`);
    const { taskId, result } = await failedDesign(chat);
    expect(result.stage).toBe('manual');
    // ADR-233: the requester who is a member hears one message about it (their line, then the office's
    // sentence) instead of two a second apart; the other members get the alert.
    expect(result.officeAlerts?.map((a) => a.chatId)).toEqual(['91000077']);
    expect(result.officeAlerts?.[0].text.endsWith(`\nDesk search: ${taskId.slice(0, 8)}`)).toBe(true);
    // Told what was sent: the office will finish it (someone was alerted).
    expect(result.message?.text).toContain('The office will finish');
    expect(result.message?.text).toContain('stopped without a draft');
  });

  it('with the requester the only member, the alert is still sent to them rather than to nobody', async () => {
    const chat = String(64_000_000 + Math.floor(Math.random() * 8_000_000));
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', chat);
    const { result } = await failedDesign(chat);
    // ADR-233: within their one message, after their own line.
    expect(result.officeAlerts).toBeUndefined();
    expect(result.message?.text).toContain('stopped without a draft. Open it in Hawa Desk');
  });

  it('with no office at all, nobody is alerted and the requester is told so', async () => {
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', '');
    const { result } = await failedDesign(String(64_000_000 + Math.floor(Math.random() * 8_000_000)));
    expect(result.officeAlert).toBeUndefined();
    expect(result.officeAlerts).toBeUndefined();
    expect(result.message?.text).toContain('Someone from the office will follow up here.');
  });
});

const staleKeys = (requestId: string) => withRlsContext(db, scope, async (trx) =>
  (await sql<{ idempotency_key: string; payload: { chatId: string; message: { text: string } } }>`
    SELECT idempotency_key, payload FROM hawa.outbox_commands
     WHERE tenant_id = ${tenantId}::uuid AND idempotency_key LIKE ${`notify.office:lifecycle-stale:${requestId}:%`}
     ORDER BY idempotency_key`.execute(trx)).rows);
const setRequest = (requestId: string, set: { stage?: string; rev?: number; updatedAt: Date }) => withRlsContext(db, scope, (trx) =>
  sql`UPDATE hawa.requests SET updated_at = ${set.updatedAt}
        ${set.stage ? sql`, stage = ${set.stage}` : sql``} ${set.rev ? sql`, rev = ${set.rev}` : sql``}
      WHERE tenant_id = ${tenantId}::uuid AND request_id = ${requestId}::uuid`.execute(trx));

describe('D7: a request waiting too long for a person is alerted once per stage', () => {
  it('a failed design handed to the office, then approved and not sent: each wait alerted once, to every member', async () => {
    const chat = String(65_000_000 + Math.floor(Math.random() * 8_000_000));
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', chat);
    const { requestId, taskId } = await failedDesign(chat);
    const now = Date.now();
    const office = ['91000081', '91000082'];
    // Not yet: 23 hours in `manual`.
    await setRequest(requestId, { updatedAt: new Date(now - STALE_AFTER_MS.manual + 60 * 60_000) });
    const early = await sweepStaleLifecycleRequests(db, { tenantId, officeChatIds: office, nowMs: now, limit: 50 });
    expect(early.find((r) => r.requestId === requestId)).toBeUndefined();
    // Past its day: alerted, to both members, once.
    await setRequest(requestId, { updatedAt: new Date(now - STALE_AFTER_MS.manual - 60_000) });
    const due = await sweepStaleLifecycleRequests(db, { tenantId, officeChatIds: office, nowMs: now, limit: 50 });
    expect(due.find((r) => r.requestId === requestId)).toMatchObject({ stage: 'manual', rev: 2, taskId });
    let rows = await staleKeys(requestId);
    expect(rows.map((r) => r.payload.chatId)).toEqual(['91000081', '91000082']);
    expect(rows[0].payload.message.text).toContain(taskId);
    expect(rows[0].payload.message.text).toContain('ended without a draft');
    await sweepStaleLifecycleRequests(db, { tenantId, officeChatIds: office, nowMs: now + 60 * 60_000, limit: 50 });
    expect(await staleKeys(requestId)).toHaveLength(2);
    // A new stage (a new revision) is a new wait: approved and not sent for five hours.
    await setRequest(requestId, { stage: 'approved', rev: 4, updatedAt: new Date(now - STALE_AFTER_MS.approved - 60_000) });
    await sweepStaleLifecycleRequests(db, { tenantId, officeChatIds: office, nowMs: now, limit: 50 });
    rows = await staleKeys(requestId);
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.idempotency_key.includes(`${requestId}:4`))[0].payload.message.text).toContain('approved but has not been sent');
  });

  it('a wait older than the horizon is left alone, and without office members nothing is written', async () => {
    const chat = String(65_000_000 + Math.floor(Math.random() * 8_000_000));
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', chat);
    const { requestId } = await failedDesign(chat);
    const now = Date.now();
    await setRequest(requestId, { updatedAt: new Date(now - 20 * 24 * 60 * 60_000) });
    await sweepStaleLifecycleRequests(db, { tenantId, officeChatIds: ['91000083'], nowMs: now, limit: 50 });
    expect(await staleKeys(requestId)).toEqual([]);
    await setRequest(requestId, { updatedAt: new Date(now - 2 * 24 * 60 * 60_000) });
    expect(await sweepStaleLifecycleRequests(db, { tenantId, officeChatIds: [], nowMs: now, limit: 50 })).toEqual([]);
    expect(await staleKeys(requestId)).toEqual([]);
  });
});

describe('health: request-path invocations that ended failed are counted', () => {
  it('asks Restate for completed failures of the request path and reports them', async () => {
    const queries: string[] = [];
    const fetcher = vi.fn(async (_url: string, init: any) => {
      const query: string = JSON.parse(init.body).query;
      queries.push(query);
      if (/sys_inbox/.test(query)) return Response.json({ rows: [{ n: 0 }] });
      return Response.json({ rows: [{ status: 'paused', n: 1 }, { status: 'failed', n: 3 }] });
    });
    const probe = createRestateInvocationProbe({ env: { RESTATE_INGRESS_URL: 'http://restate:8080' } as NodeJS.ProcessEnv, fetcher: fetcher as any, now: () => 0 });
    expect(await probe()).toMatchObject({ status: 'ok', paused: 1, backingOff: 0, failed: 3, inbox: 0 });
    const status = queries.find((q) => /sys_invocation/.test(q))!;
    expect(status).toContain("completion_result = 'failure'");
    expect(status).toContain("'RequestLifecycle'");
    expect(status).not.toContain('OfficeDecisionGateway');
  });
});
