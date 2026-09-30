import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { OutboundMessage } from '@hawa/contracts';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { signLifecycleOfficeEvent } from '@hawa/integrations';
import { checkSignedOfficeDecision, type SignedOfficeDecision } from '../src/lifecycle/office-decision-gateway.js';
import { officeAlertKey } from '../src/lifecycle/office-chats.js';
import { handleSend, type SenderContext, type TelegramSenderDeps } from '../src/lifecycle/telegram-sender.js';

/**
 * ADR-040 addendum (owner decision 2026-09-30): office members approve a draft in Telegram by replying to
 * its photo alert in plain words. The worker's part: TelegramSender records, on the sent mark of every
 * office alert, the chat it went to beside Telegram's message id (a message id is unique only in its
 * chat), so Core maps a member's reply to the request and revision; and the signed gateway admits an
 * office decision whose actor is an office member's private Telegram chat, and nothing looser.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const db = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => db.destroy());
const OFFICE = ['9420001', '9420002'];
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('TelegramSender: the office alert\'s mark names its chat and message', () => {
  it('records chat and message id for each member\'s photo alert, per revision key', async () => {
    const png = Buffer.from('draft picture for the reply map');
    let next = 811;
    const deps: TelegramSenderDeps = {
      db, botToken: () => 'test-bot-token',
      bridge: () => ({
        dispatchOutboundMessage: async () => ({ success: true, messageId: String(next++) }),
        dispatchOutboundDocument: async () => ({ success: true, messageId: String(next++) }),
        dispatchOutboundPhoto: async () => ({ success: true, messageId: String(next++) }),
      }) as never,
      readExportBytes: async () => null,
      readDraftImage: async () => new Uint8Array(png),
      officeChatIds: () => OFFICE, markRetryDelaysMs: [1],
    };
    const ctx: SenderContext = { run: (_n, action) => action(), sleep: async () => {}, sendTo: () => {} };
    const requestId = randomUUID();
    const base = `${requestId}:2:office-alert`;
    for (const [index, chatId] of OFFICE.entries()) {
      const message: OutboundMessage = { v: 1, key: officeAlertKey(base, index, chatId), chatId, kind: 'photo',
        imageRef: { source: 'canva_export', tenantId, taskId: randomUUID(), id: randomUUID(), sha256: sha(png) },
        caption: 'A new draft is ready', text: 'A new draft is ready', class: 'critical', tenantId };
      await handleSend(ctx, deps, message);
    }
    const marks = await withRlsContext(db, { tenantId, userId: '00000000-0000-4000-b000-000000000011', role: 'operator' },
      (trx) => sql<{ source_event_id: string; payload: Record<string, unknown> }>`SELECT source_event_id, payload FROM hawa.inbox_events
        WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'telegram_delivery' AND event_kind = 'telegram_message_sent'
          AND source_event_id LIKE ${`lc:${requestId}:%`} ORDER BY received_at, id`.execute(trx));
    expect(marks.rows.map((row) => [row.source_event_id, row.payload.chatId, row.payload.messageId])).toEqual([
      [`lc:${base}:send`, OFFICE[0], '811'],
      [`lc:${base}:${OFFICE[1]}:send`, OFFICE[1], '812'],
    ]);
  });
});

describe('OfficeDecisionGateway: an office member\'s Telegram chat as the actor', () => {
  const secret = ['gateway', 'telegram', 'fixture'].join('-');
  const proof = { qcRunId: randomUUID(), qcReportHash: 'a'.repeat(64),
    pinnedExports: [{ artifactId: randomUUID(), format: 'png' as const, sha256: 'b'.repeat(64), byteSize: 10 }] };
  const signed = (actor: Record<string, unknown>): SignedOfficeDecision => {
    const actionId = randomUUID();
    const event = { v: 1 as const, eventId: `desk:${actionId}`, requestId: randomUUID(), taskId: randomUUID(),
      revisionId: randomUUID(), actionId, expectedRev: 2, kind: 'approve' as const,
      actor: actor as SignedOfficeDecision['event']['actor'], reason: 'Approved in Telegram by office member 9420001',
      approvalProof: proof, deskRequestFingerprint: 'c'.repeat(64) };
    return { v: 1, event, signature: signLifecycleOfficeEvent(secret, event) };
  };
  const team = { userId: '00000000-0000-4000-b000-000000000002', role: 'administrator' };

  it('admits a signed decision by an office member\'s private chat', () => {
    expect(checkSignedOfficeDecision(signed({ ...team, authMethod: 'telegram_office', telegramChatId: '9420001' }), secret)).toBe('ok');
    // The Desk's own actors are unchanged.
    expect(checkSignedOfficeDecision(signed(team), secret)).toBe('ok');
    expect(checkSignedOfficeDecision(signed({ ...team, authMethod: 'google_oidc', sessionHash: 'd'.repeat(64) }), secret)).toBe('ok');
  });

  it.each([
    ['no chat id', { authMethod: 'telegram_office' }],
    ['a group chat id', { authMethod: 'telegram_office', telegramChatId: '-1009420001' }],
    ['a session hash beside it', { authMethod: 'telegram_office', telegramChatId: '9420001', sessionHash: 'd'.repeat(64) }],
    ['a chat id on a Desk actor', { telegramChatId: '9420001' }],
    ['an unknown method', { authMethod: 'telegram', telegramChatId: '9420001' }],
  ])('refuses %s', (_why, extra) => {
    expect(checkSignedOfficeDecision(signed({ ...team, ...extra }), secret)).toBe('invalid');
  });
});
