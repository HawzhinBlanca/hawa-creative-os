import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createChatCampaignIntake } from '../src/services/chat-campaign-intake.js';
import { composeOfficeDraftAlert } from '../src/services/office-draft-alert.js';
import { startsWithName, withoutRepeatedClient } from '../src/core-helpers.js';
import { shortTitle } from '../src/services/requester-turn.js';
import { cleanDraftTitle } from '../src/services/draft-title.js';

/**
 * ADR-180 (owner report, 2026-09-30). The office's photo alert for the KAAE K-12 draft read
 * `"KAAE: ‏KAAE K-12 Pilot Study…"`: intake titled the task "<Client>: <first line>" when the first
 * line already started with the client's acronym, behind the right-to-left mark a Sorani keyboard
 * types before Latin text. And the caption still ended "Approve or send it back in Hawa Desk on the
 * office computer" although office members now approve in Telegram by replying to the picture.
 */
const RLM = '‏';

function prepare(text: string, senderName = 'Office') {
  return createChatCampaignIntake({ telegramBridge: {} } as any).prepareChatCampaignDraft({
    platform: 'telegram', sourceEventId: `title-${randomUUID()}`, sourceChannelId: `title-${randomUUID()}`,
    senderName, rawText: text, rawJson: { message: { text } }, autoGenerate: true, isInstructionOnly: false,
  });
}

describe('a task title names the client once (ADR-180)', () => {
  it('does not prefix a first line that already starts with the client, even behind a right-to-left mark', async () => {
    const draft = await prepare(`Please design a KAAE report cover.\n\nHere is the text:\n${RLM}KAAE K-12 Pilot Study\nField Visit Report`);
    expect(draft.title).toBe('KAAE K-12 Pilot Study');
    expect(draft.title).not.toContain(RLM);
    // The copy itself is never changed: the mark stays in the block as the requester typed it.
    expect((draft.exactCopy as Array<{ text: string }>)[0].text).toBe(`${RLM}KAAE K-12 Pilot Study`);
    // The requester's name of the design is the same.
    expect(shortTitle(draft.title)).toBe('KAAE K-12 Pilot Study');
  });

  it('keeps the prefix when the first line does not start with the client as a word', async () => {
    const other = await prepare('Please design a KAAE poster.\n\nHere is the text:\nNational Accreditation Forum\nErbil');
    expect(other.title).toBe('KAAE: National Accreditation Forum');
    const joined = await prepare('Please design a KAAE poster.\n\nHere is the text:\nKAAESTRA Forum\nErbil');
    expect(joined.title).toBe('KAAE: KAAESTRA Forum');
  });

  it('reads names as whole words, case aside, behind direction marks', () => {
    expect(startsWithName(`${RLM}kaae K-12`, 'KAAE')).toBe(true);
    expect(startsWithName('KAAE', 'KAAE')).toBe(true);
    expect(startsWithName('KAAEs', 'KAAE')).toBe(false);
    expect(startsWithName('The KAAE', 'KAAE')).toBe(false);
    expect(withoutRepeatedClient(`KAAE: ${RLM}KAAE K-12 Pilot Study…`)).toBe('KAAE K-12 Pilot Study…');
    expect(withoutRepeatedClient('KAAE: Standards launch')).toBe('KAAE: Standards launch');
    expect(withoutRepeatedClient('Autumn workshop poster')).toBe('Autumn workshop poster');
  });
});

describe('the office draft photo alert (ADR-180)', () => {
  const base = { title: `KAAE: ${RLM}KAAE K-12 Pilot Study…`, clientName: 'KAAE', canvaUrl: 'https://www.canva.com/design/DA1/edit' };

  it('a task titled before the fix is named once in the caption', () => {
    const caption = composeOfficeDraftAlert({ ...base, telegramDecision: true });
    expect(caption.split('\n')[0]).toBe('A new draft is ready for office review: "KAAE K-12 Pilot Study…"');
    expect(caption).not.toContain('KAAE: ');
  });

  it('says, in plain words and in English and Sorani, that "approved" sends it, or what to change, or Hawa Desk', () => {
    const caption = composeOfficeDraftAlert({ ...base, requestedBy: 'Shilan', telegramDecision: true });
    const lines = caption.split('\n');
    // ADR-239 (changed deliberately): plain chat, no reply target.
    expect(lines.at(-2)).toBe('Just say “approved” to send it to Shilan, or tell me what to change. You can also decide in Hawa Desk.');
    expect(lines.at(-1)).toContain('«پەسەندە»');
    expect(lines.at(-1)).toContain('Shilan');
    expect(caption).not.toMatch(/office computer|(?:^|\s)\/[a-z_]{2,}/m);
    // Short: the name, who it is for, where to edit it, and how to decide.
    expect(lines).toHaveLength(5);
  });

  it('without the picture (the text alert), approval stays in Hawa Desk', () => {
    const text = composeOfficeDraftAlert(base);
    expect(text).toContain('Approve or send it back in Hawa Desk on the office computer.');
    expect(text).not.toContain('Just say “approved”');
  });
});

/**
 * ADR-040 addendum (2026-10-01): titles stored before ADR-180 and ADR-142 are cleaned when they are
 * read, wherever the bot names a draft, so the office's "which draft?" list, its confirmations and
 * alerts, and the requester's own lists show them as a new title would be shown.
 */
describe('stored titles are shown cleaned (ADR-040 addendum, 2026-10-01)', () => {
  const INTRO = 'KAAE: Here is the text and the photos:…';
  const COPY = [{ text: 'Here is the text and the photos:' }, { text: `${RLM}KAAE K-12 Pilot Study\nField Visit Report` }];

  it('names a draft titled from its introducer by its first line of copy, and drops direction marks', () => {
    expect(cleanDraftTitle(INTRO, COPY)).toBe('KAAE K-12 Pilot Study');
    expect(cleanDraftTitle(INTRO)).toBe('KAAE');
    expect(cleanDraftTitle(`KAAE: ${RLM}KAAE K-12 Pilot Study…`)).toBe('KAAE K-12 Pilot Study…');
    expect(cleanDraftTitle(`KAAE: ${RLM}National Forum`)).toBe('KAAE: National Forum');
    expect(cleanDraftTitle('Autumn workshop poster')).toBe('Autumn workshop poster');
    expect(cleanDraftTitle('   ')).toBeNull();
  });

  it('the office alert names it by its copy', () => {
    const caption = composeOfficeDraftAlert({ title: INTRO, copy: COPY, clientName: 'KAAE', telegramDecision: true });
    expect(caption.split('\n')[0]).toBe('A new draft is ready for office review: "KAAE K-12 Pilot Study"');
  });

  it('the requester hears no introducer and no direction mark', () => {
    expect(shortTitle(`KAAE: ${RLM}KAAE K-12 Pilot Study…`)).toBe('KAAE K-12 Pilot Study');
    expect(shortTitle(INTRO)).toBe('your design');
    expect(shortTitle('KAAE: Standards launch')).toBe('Standards launch');
  });
});
