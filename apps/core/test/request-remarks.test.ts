import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, withRlsContext } from '@hawa/db';
import { createChatCampaignIntake } from '../src/services/chat-campaign-intake.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { isDesignerRemark, peelTrailingRemarks } from '../src/services/request-remarks.js';

// The message Sewa sent four times on 2026-09-22; the last line was printed on the design.
const SEWA = "I need a graphic with these texts and two pictures in it for KAAE, make sure its nice and professional and goes with KAAE’s brand guidelines   \n\nMEET KAAE AT SAGACON 2026  \n\nHER PATH, HER POWER: LESSONS FROM WOMEN WHO LEAD  \n\nSeptember 25, 2026 \nThe International School of Choueifat – Erbil\n\nI attached the panelists pictures and a reference for the graphic";

describe('a closing remark to the designer is not copy', () => {
  it('recognises remarks about attachments, and leaves real copy alone', () => {
    for (const r of ['I attached the panelists pictures and a reference for the graphic', "I've attached the photos", 'Please find attached the logo', 'Here are the pictures of the speakers', 'The photos are attached', 'use the attached photos please']) {
      expect(isDesignerRemark(r)).toBe(true);
    }
    for (const c of ['Photo exhibition opening', 'The International School of Choueifat – Erbil', 'Attached to excellence since 2010', 'Images of Kurdistan: a travelling show']) {
      expect(isDesignerRemark(c)).toBe(false);
    }
  });

  it('peels only trailing remark paragraphs', () => {
    const { copy, remarks } = peelTrailingRemarks('TITLE\n\nDate\n\nI attached the pictures');
    expect(copy).toBe('TITLE\n\nDate');
    expect(remarks).toBe('I attached the pictures');
    expect(peelTrailingRemarks('I attached the pictures')).toEqual({ copy: 'I attached the pictures', remarks: '' });
  });

  it("Sewa's request: the attachment line goes to instructions, the event text stays copy", async () => {
    // ADR-135 stage 2: a new Telegram request is the draft prepareChatCampaignDraft builds for the
    // lifecycle, persisted by its projection through persistChatIntake.
    const draft = await createChatCampaignIntake({ telegramBridge: {} } as any).prepareChatCampaignDraft({
      platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: '5150', senderName: 'Sewa',
      rawText: SEWA, rawJson: { message: { message_id: 1, chat: { id: 5150, type: 'private' }, text: SEWA } },
      autoGenerate: true, isInstructionOnly: false,
    });
    const copyText = JSON.stringify(draft.exactCopy);
    expect(copyText).toMatch(/MEET KAAE AT SAGACON 2026/);
    expect(copyText).toMatch(/Choueifat/);
    expect(copyText).not.toMatch(/I attached/);
    expect(copyText).not.toMatch(/I need a graphic/);
    const db = createDb(process.env.TEST_DATABASE_URL!);
    try {
      const { task } = await persistChatIntake(db, draft);
      const created = await withRlsContext(db, { tenantId: '00000000-0000-4000-a000-000000000001', userId: '00000000-0000-4000-b000-000000000001', role: 'operator' }, (trx) =>
        trx.selectFrom('task_events').select('data').where('task_id', '=', task.id).where('event_type', '=', 'task.created').executeTakeFirstOrThrow());
      const payload = (created.data as any).payload;
      expect(payload.designInstructions).toMatch(/I need a graphic/);
      expect(payload.designInstructions).toMatch(/I attached the panelists pictures and a reference/);
      expect(JSON.stringify(payload.exactCopy)).not.toMatch(/I attached/);
    } finally {
      await db.destroy();
    }
  });
});

import { savedDesignCopy } from '../src/services/canva-design-planner.js';
describe('requests saved before the rule', () => {
  it('a stored last copy block that is a remark is read as an instruction', () => {
    const { copy, instructions } = savedDesignCopy(
      { designInstructions: 'I need a graphic with these texts and two pictures', exactCopy: [
        { text: 'MEET KAAE AT SAGACON 2026' }, { text: 'HER PATH, HER POWER' }, { text: 'September 25, 2026' },
        { text: 'I attached the panelists pictures and a reference for the graphic' },
      ] },
      ''
    );
    expect(copy).toEqual(['MEET KAAE AT SAGACON 2026', 'HER PATH, HER POWER', 'September 25, 2026']);
    expect(instructions).toMatch(/two pictures\nI attached the panelists pictures/);
  });
});
