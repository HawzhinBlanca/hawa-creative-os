/**
 * Changes: while the design is being made, after the office sent it back, while the office checks it,
 * after delivery; changing one's mind; two designs at once; a reply to an old bot message (ADR-182).
 */
import { expect } from 'vitest';
import type { Play, Script } from '../conversation-script.js';
import { KAAE_EVENING, NO_QUESTION } from './briefs.js';

/** A request whose draft the office sent back with a note: it waits for the requester's changes. */
export async function sentBack(p: Play, note = 'The logo is too small, please check the date too'): Promise<void> {
  await p.say(KAAE_EVENING);
  await p.draftReady(0);
  await p.officeReplies(note);
}

const NOTE = /office has a note|تێبینییەکی/;

export const CHANGE_SCRIPTS: Script[] = [
  {
    id: 'S030', title: 'the office sends the draft back; the requester writes the change', kinds: ['change', 'office', 'en'],
    natural: 'The requester is told the office\'s note; their plain answer starts the next round.',
    async play(p) {
      await sentBack(p);
      expect(p.words).toMatch(NOTE);
      await p.say('make the logo bigger and the date is 5 December', { after: 120_000 });
      expect(p.revisions).toHaveLength(1);
      expect(p.revisions[0].directive).toContain('logo bigger');
    },
  },
  {
    id: 'S031', title: 'the office sends it back; the requester replies to the office\'s note', kinds: ['change', 'reply'],
    natural: 'The reply starts the next round.',
    async play(p) {
      await sentBack(p);
      const note = p.botMessage(/office-revision-notify/);
      await p.say('ok, change the date to 5 December please', { after: 120_000, replyTo: note });
      expect(p.revisions).toHaveLength(1);
    },
  },
  {
    id: 'S032', title: 'the office sends it back; the requester just says "thanks"', kinds: ['change', 'thanks'],
    natural: 'Thanks is not a change: nothing starts; the bot says it waits for what to change.',
    async play(p) {
      await sentBack(p);
      const thanks = await p.say('thanks', { after: 120_000 });
      expect(p.revisions).toHaveLength(0);
      expect(p.answer(thanks)).toMatch(/thank/i);
    },
  },
  {
    id: 'S033', title: 'the office sends it back; the requester says "ok"', kinds: ['change', 'ack'],
    natural: '"ok" is not a change: nothing starts.',
    async play(p) {
      await sentBack(p);
      await p.say('ok', { after: 120_000 });
      expect(p.revisions).toHaveLength(0);
    },
  },
  {
    id: 'S034', title: 'the office sends it back; the requester answers in Sorani', kinds: ['change', 'ckb'],
    natural: 'The Sorani change starts the next round.',
    async play(p) {
      await sentBack(p);
      // "Make the logo bigger and change the date to the 5th"
      await p.say('لۆگۆکە گەورەتر بکە و بەروارەکە بگۆڕە بۆ ٥', { after: 120_000 });
      expect(p.revisions).toHaveLength(1);
    },
  },
  {
    id: 'S035', title: 'a change while the draft is with the office', kinds: ['change', 'in-review'],
    natural: 'Kept for the office, who sees it before approving; the requester is told so.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.draftReady(0);
      const change = await p.say('can you make the title bigger?', { after: 60_000 });
      expect(p.kept).toHaveLength(1);
      expect(p.answer(change)).toMatch(/office/i);
      expect(p.revisions).toHaveLength(0);
    },
  },
  {
    id: 'S036', title: 'a change after delivery, replying to the delivered design', kinds: ['change', 'delivered', 'reply'],
    natural: 'The office hears it for that design; the requester is told it was passed on, without being asked which design.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.draftReady(0);
      await p.officeReplies('approved');
      await p.delivered(0);
      const notice = p.botMessage(/^dl-.*:notice$/);
      const change = await p.say('can you change the date to 6 December?', { replyTo: notice, after: 300_000 });
      expect(p.answer(change)).not.toMatch(NO_QUESTION);
      expect(p.officeHeard.some((s) => s.text.includes('6 December'))).toBe(true);
    },
  },
  {
    id: 'S037', title: 'changing one\'s mind while it is being made ("actually, make it green instead of blue")', kinds: ['change', 'mind'],
    natural: 'Kept on the design for the office; one request.',
    async play(p) {
      await p.say(`${KAAE_EVENING}\nUse blue colours.`);
      const change = await p.say('actually, make it green instead of blue', { after: 90_000 });
      expect(p.opened).toHaveLength(1);
      expect(p.kept).toHaveLength(1);
      expect(p.answer(change)).toMatch(/added|office/i);
    },
  },
  {
    id: 'S038', title: 'a Sorani correction while it is being made', kinds: ['change', 'ckb'],
    natural: 'Kept on the design; answered in Sorani.',
    async play(p) {
      await p.say(KAAE_EVENING);
      // "Sorry, make its colour green"
      const change = await p.say('ببورە، ڕەنگەکەی بکە بە سەوز', { after: 90_000 });
      expect(p.kept).toHaveLength(1);
      expect(p.answer(change)).toMatch(/[؀-ۿ]/);
    },
  },
  {
    id: 'S039', title: 'two designs on the way; "change the date to the 5th"', kinds: ['change', 'two-requests'],
    natural: 'Kept for the newer design (sent twenty minutes later, ADR-144 recency for notes), or the bot asks which; never both, never a paid round.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.say('Another poster please: KAAE staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium.', { after: 20 * 60_000 });
      await p.wait(2 * 60_000);
      const change = await p.say('change the date to the 5th', { after: 60_000 });
      if (/Which design/.test(p.answer(change))) await p.say('the second one', { after: 30_000 });
      expect(p.kept).toHaveLength(1);
      expect(p.kept[0].requestId).toBe(p.request(1));
      expect(p.revisions).toHaveLength(0);
    },
  },
  {
    id: 'S040', title: 'two designs; the change names one ("on the football poster, make the logo bigger")', kinds: ['change', 'two-requests'],
    natural: 'Applied to the design it names, without a question.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.say('Another poster please: KAAE staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium.', { after: 20 * 60_000 });
      await p.wait(2 * 60_000);
      const change = await p.say('on the football poster, make the logo bigger', { after: 60_000 });
      expect(p.answer(change)).not.toMatch(NO_QUESTION);
      expect(p.kept.map((k) => k.requestId)).toEqual([p.request(1)]);
    },
  },
  {
    id: 'S041', title: 'a reply to a bot message of a design delivered days ago, with a change', kinds: ['change', 'old-reply'],
    natural: 'The office hears it; the requester is told so; no new design is started.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.draftReady(0);
      await p.officeReplies('approved');
      await p.delivered(0);
      const ack = p.botMessage(/:1:ack$/);
      await p.wait(4 * 24 * 60 * 60_000);
      const change = await p.say('the phone number on this is wrong, it should be 0750 123 4567', { replyTo: ack });
      expect(p.opened).toHaveLength(1);
      expect(p.h.t.designs).toHaveLength(1);
      expect(p.answer(change)).toMatch(/office/i);
    },
  },
  {
    id: 'S042', title: 'a new brief sent as a reply to an old delivered design\'s message', kinds: ['brief', 'old-reply'],
    natural: 'A new request opens with the new brief.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.draftReady(0);
      await p.officeReplies('approved');
      await p.delivered(0);
      const notice = p.botMessage(/^dl-.*:notice$/);
      await p.say('New poster please: KAAE staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium.', { replyTo: notice, after: 2 * 24 * 60 * 60_000 });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(2);
    },
  },
  {
    id: 'S043', title: 'the office sends it back; the requester changes it twice in a row', kinds: ['change', 'mind'],
    natural: 'The first message starts the round; the second, a minute later, is kept for that round (never a second request).',
    async play(p) {
      await sentBack(p);
      await p.say('make the logo bigger', { after: 120_000 });
      const second = await p.say('and the date is 5 December, not 4', { after: 60_000 });
      expect(p.revisions).toHaveLength(1);
      expect(p.opened).toHaveLength(1);
      expect(p.answer(second)).toMatch(/added|office/i);
    },
  },
  {
    id: 'S044', title: 'the office sends it back; the requester changes their mind: "never mind, cancel it"', kinds: ['cancel', 'mind'],
    natural: 'No round starts; the request (sent back for changes, nothing approved) is withdrawn (ADR-230).',
    async play(p) {
      await sentBack(p);
      const cancel = await p.say('never mind, cancel it', { after: 120_000 });
      expect(p.revisions).toHaveLength(0);
      expect(p.answer(cancel)).toMatch(/^Cancelled <b>.+<\/b>\. Nothing more will be made for it\.$/);
      expect(await p.h.taskState(p.request())).toMatchObject({ state: 'cancelled' });
    },
  },
  {
    id: 'S045', title: 'the office sends it back; the requester sends a photo with "use this logo"', kinds: ['change', 'photo'],
    natural: 'The next round starts with the photo.',
    async play(p) {
      await sentBack(p);
      await p.photo(7, { caption: 'use this logo instead', after: 120_000 });
      await p.wait(30_000);
      expect(p.revisions).toHaveLength(1);
    },
  },
];
