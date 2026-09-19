import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, withRlsContext, sql } from '@hawa/db';
import { createApp } from '../src/app.js';

/**
 * A real KAAE invitation sent on Telegram was answered 503 and never saved: intake computed the
 * legacy inline template operations before writing anything, and the invitation template refuses
 * copy that does not fit its fixed canvas ("Invitation copy exceeds safe canvas bounds"). Telegram
 * retried the same update and hit the same throw, so the request was lost without a trace in the
 * database. Persistence must come first, and a preview that cannot be drawn must never decide the
 * HTTP status.
 */
const KAAE_TENANT_ID = '00000000-0000-4000-a000-000000000001';

const INSTRUCTIONS = 'KAAE invitation, please keep the brand navy and use the official logo.';

const PARAGRAPHS = [
  'THE NATIONAL STANDARDS FOR QUALITY ASSURANCE IN EDUCATION',
  'Mr. / Ms. / Dr. [Full Name]',
  'The Kurdistan Accrediting Association for Education cordially requests the honour of your presence at the official launch ceremony of the national standards.',
  'His Excellency the Prime Minister will officially announce the National Standards for Quality Assurance in Education, marking a defining moment for educational quality across the Kurdistan Region.',
  'As part of the official launch, the Minister of Education and the Minister of Higher Education and Scientific Research will sign a Memorandum of Understanding on cooperation in quality assurance.',
  'September 9, 2026 | 2:30 PM\nSaad Abdullah Conference Hall, Erbil',
  'Doors open at 1:45 PM and guests are kindly asked to be seated by 2:15 PM. Parking is available at the northern gate of the conference hall.',
  'Agenda item 1: opening remarks by the chair of the association, followed by a reading of the national standards and their scope.',
  'Agenda item 2: a panel on quality assurance practice in the universities, chaired by a member of the board and followed by questions from the floor.',
  'Agenda item 3: the signing of the Memorandum of Understanding, followed by the closing address and a reception in the upper hall.',
  'Accreditation badges are issued at the registration desk on arrival. Kindly bring a form of identification that matches the name on this invitation.',
  'By Invitation Only',
  'This invitation is personal and non-transferable. Kindly do not share this invitation.',
  'بانگهێشتنامەی فەرمی بۆ ئاهەنگی دەستپێکردنی ستانداردە نیشتمانییەکانی دڵنیایی جۆری لە پەروەردەدا.',
];

const LONG_INVITATION = `${INSTRUCTIONS}\n__________\n\n${PARAGRAPHS.join('\n\n')}`;

describe('long KAAE invitation intake', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);

  it('is long enough and structured enough to reproduce the lost request', () => {
    expect(LONG_INVITATION.length).toBeGreaterThan(700);
    expect(PARAGRAPHS.length).toBeGreaterThanOrEqual(8);
  });

  it('saves the task with every paragraph in exactCopy instead of answering 503', async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const app = createApp({ db, telegramBridge: { dispatchOutboundMessage: dispatch } as any });
    const chatId = `long-invitation-${randomUUID()}`;
    const payload = {
      update_id: `long-invitation-${randomUUID()}`,
      message: {
        message_id: 9001,
        from: { id: 987654, first_name: 'KAAE Office' },
        chat: { id: chatId },
        text: LONG_INVITATION,
      },
    };
    const send = () =>
      app.request('/api/webhooks/telegram?generate=true', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET!,
        },
        body: JSON.stringify(payload),
      });

    const res = await send();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const taskId = body.task.id;
    expect(taskId).toBeTruthy();

    const exactCopy = body.task.brief.exactCopy.map((block: any) => block.text);
    for (const paragraph of PARAGRAPHS) {
      expect(exactCopy).toContain(paragraph);
    }

    // The inline preview is the part that cannot be drawn at this size. It is skipped, the request
    // stands, and the sender is told it was received.
    expect(body.task.generatedOps).toEqual([]);
    expect(dispatch).toHaveBeenCalledTimes(1);

    const { rows } = await withRlsContext(
      db,
      { tenantId: KAAE_TENANT_ID, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' },
      async (trx) =>
        sql<{ payload: any }>`SELECT payload FROM hawa.outbox_commands
          WHERE aggregate_id = ${taskId}::uuid AND command_type = 'task.created'`.execute(trx)
    );
    expect(rows).toHaveLength(1);
    const persistedCopy = rows[0].payload.exactCopy.map((block: any) => block.text);
    for (const paragraph of PARAGRAPHS) {
      expect(persistedCopy).toContain(paragraph);
    }
    expect(rows[0].payload.designInstructions).toBe(INSTRUCTIONS);

    // Telegram retries the same update. The second delivery must find the saved task, not repeat
    // the work that lost the first one.
    const replay = await send();
    expect(replay.status).toBe(200);
    expect((await replay.json()).task.id).toBe(taskId);
  });
});
