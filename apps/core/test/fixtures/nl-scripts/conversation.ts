/**
 * Conversation around a design: asking how it is going, "send it again", thanks and emojis, cancelling,
 * questions the bot cannot answer, frustration and rudeness, stickers and buttons (ADR-182).
 */
import { expect } from 'vitest';
import type { Play, Script } from '../conversation-script.js';
import { KAAE_EVENING, NO_QUESTION } from './briefs.js';

async function deliveredDesign(p: Play): Promise<number> {
  await p.say(KAAE_EVENING);
  await p.draftReady(0);
  await p.officeReplies('approved');
  await p.delivered(0);
  return p.botMessage(/^dl-.*:notice$/);
}

const THANKS = /thank|🙏|سوپاس/i;

export const CONVERSATION_SCRIPTS: Script[] = [
  // --- where it stands ---------------------------------------------------------------------
  {
    id: 'S050', title: '"is it ready?" while the draft is being made', kinds: ['status', 'en'],
    natural: 'The bot says the design is being made and the office checks it first.',
    async play(p) {
      await p.say(KAAE_EVENING);
      const asked = await p.say('is it ready?', { after: 120_000 });
      expect(p.answer(asked)).toMatch(/being designed/i);
      expect(p.opened).toHaveLength(1);
    },
  },
  {
    id: 'S051', title: 'Sorani "is it ready?" while it is being made', kinds: ['status', 'ckb'],
    natural: 'The same answer, in Sorani.',
    async play(p) {
      await p.say(KAAE_EVENING);
      // "Is it ready?"
      const asked = await p.say('ئامادەیە؟', { after: 120_000 });
      expect(p.answer(asked)).toMatch(/دیزاین دەکرێت/);
    },
  },
  {
    id: 'S052', title: '"any update?" while the office checks the draft', kinds: ['status'],
    natural: 'The bot says the office is giving it a final check.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.draftReady(0);
      const asked = await p.say('any update?', { after: 30 * 60_000 });
      expect(p.answer(asked)).toMatch(/final check/i);
    },
  },
  {
    id: 'S053', title: '"when will it be ready?" with nothing asked for yet', kinds: ['status'],
    natural: 'The bot says nothing is in progress and invites a brief.',
    async play(p) {
      const asked = await p.say('when will it be ready?');
      expect(p.answer(asked)).toMatch(/don't have a design in progress|Tell me what/i);
      expect(p.opened).toHaveLength(0);
    },
  },
  {
    id: 'S054', title: 'Sorani "when will it be finished?"', kinds: ['status', 'ckb'],
    natural: 'Where the design stands, in Sorani.',
    async play(p) {
      await p.say(KAAE_EVENING);
      // "When will it be finished?"
      const asked = await p.say('کەی تەواو دەبێت؟', { after: 120_000 });
      expect(p.answer(asked)).toMatch(/دیزاین دەکرێت/);
    },
  },
  {
    id: 'S055', title: '"??" after a long wait', kinds: ['status', 'frustration'],
    natural: 'Read as "where is it?": the bot says where the design stands.',
    async play(p) {
      await p.say(KAAE_EVENING);
      const asked = await p.say('??', { after: 40 * 60_000 });
      expect(p.answer(asked)).toMatch(/being designed|office/i);
    },
  },
  {
    id: 'S056', title: '"hello??" after a long wait', kinds: ['status', 'frustration'],
    natural: 'The bot says where the design stands (not a welcome as if nothing was asked).',
    async play(p) {
      await p.say(KAAE_EVENING);
      const asked = await p.say('hello??', { after: 40 * 60_000 });
      expect(p.answer(asked)).toMatch(/being designed|office/i);
    },
  },
  {
    id: 'S057', title: '"why is it taking so long??"', kinds: ['status', 'frustration'],
    natural: 'Where it stands, plainly.',
    async play(p) {
      await p.say(KAAE_EVENING);
      const asked = await p.say('why is it taking so long??', { after: 40 * 60_000 });
      expect(p.answer(asked)).toMatch(/being designed|office/i);
    },
  },
  {
    id: 'S058', title: 'a rude, frustrated message', kinds: ['frustration', 'rude'],
    natural: 'Answered calmly with where the design stands; no canned welcome; nothing opens.',
    async play(p) {
      await p.say(KAAE_EVENING);
      const angry = await p.say('this is useless, where is my poster???', { after: 40 * 60_000 });
      expect(p.opened).toHaveLength(1);
      expect(p.answer(angry)).toMatch(/being designed|office/i);
    },
  },
  {
    id: 'S059', title: 'Sorani "what happened to it?"', kinds: ['status', 'ckb'],
    natural: 'Where it stands, in Sorani.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.draftReady(0);
      // "What happened to the poster?"
      const asked = await p.say('پۆستەرەکە چی بوو؟', { after: 20 * 60_000 });
      expect(p.answer(asked)).toMatch(/ئۆفیس/);
    },
  },

  {
    id: 'S098', title: '"where is my poster?" after an hour', kinds: ['status', 'frustration', 'slow'],
    natural: 'The bot does not say "it usually takes a few minutes": it says it is taking longer than usual and the office is looking into it; the office is told.',
    async play(p) {
      await p.say(KAAE_EVENING);
      const asked = await p.say('where is my poster?', { after: 60 * 60_000 });
      expect(p.answer(asked)).toMatch(/longer than usual/);
      expect(p.officeHeard.some((s) => /taking longer than usual/.test(s.text))).toBe(true);
    },
  },
  {
    id: 'S099', title: 'Sorani "when will it be ready?" after an hour', kinds: ['status', 'ckb', 'slow'],
    natural: 'Where it stands, in Sorani, saying it is slow and the office is looking.',
    async play(p) {
      await p.say(KAAE_EVENING);
      // "When will it be ready?" (an hour later)
      const asked = await p.say('کەی ئامادە دەبێت؟', { after: 60 * 60_000 });
      expect(p.answer(asked)).toMatch(/لە ئاسایی زیاتر دەخایەنێت/);
    },
  },

  // --- "send it again" ---------------------------------------------------------------------
  {
    id: 'S060', title: '"send it again please" after delivery', kinds: ['delivery-request'],
    natural: 'Never read as approval; the office is told to send the files again; the requester hears so.',
    async play(p) {
      await deliveredDesign(p);
      const again = await p.say('send it again please', { after: 10 * 60_000 });
      expect(p.answer(again)).toMatch(/passed|office/i);
      expect(p.officeHeard.some((s) => s.text.includes('send it again'))).toBe(true);
    },
  },
  {
    id: 'S061', title: '"it didn\'t arrive" as a reply to the delivery message', kinds: ['delivery-request', 'reply'],
    natural: 'The office is told; no "which design?".',
    async play(p) {
      const notice = await deliveredDesign(p);
      const lost = await p.say("it didn't arrive", { replyTo: notice, after: 10 * 60_000 });
      expect(p.answer(lost)).not.toMatch(NO_QUESTION);
      expect(p.officeHeard.some((s) => s.text.includes("didn't arrive"))).toBe(true);
    },
  },
  {
    id: 'S062', title: 'Sorani "it did not reach me, send it again"', kinds: ['delivery-request', 'ckb'],
    natural: 'The office is told; the answer is in Sorani.',
    async play(p) {
      await deliveredDesign(p);
      // "It did not reach me, send it again"
      const again = await p.say('پێم نەگەیشت، دووبارە بینێرەوە', { after: 10 * 60_000 });
      expect(p.answer(again)).toMatch(/[؀-ۿ]/);
      expect(p.officeHeard.some((s) => s.text.includes('نەگەیشت'))).toBe(true);
    },
  },
  {
    id: 'S063', title: '"can you send it as a PDF?"', kinds: ['delivery-request'],
    natural: 'The office is told; nothing is approved or redesigned.',
    async play(p) {
      await deliveredDesign(p);
      const pdf = await p.say('can you send it as a PDF?', { after: 10 * 60_000 });
      expect(p.answer(pdf)).toMatch(/passed|office/i);
      expect(p.h.t.designs).toHaveLength(1);
    },
  },
  {
    id: 'S064', title: '"send it to my email sewa@example.com"', kinds: ['delivery-request'],
    natural: 'The office is told; the address is not put in a design.',
    async play(p) {
      await deliveredDesign(p);
      const mail = await p.say('please send it to my email sewa@example.com', { after: 10 * 60_000 });
      expect(p.answer(mail)).toMatch(/passed|office/i);
      expect(p.kept).toHaveLength(0);
    },
  },
  {
    id: 'S065', title: '"send it again" while the office is still checking it', kinds: ['delivery-request', 'in-review'],
    natural: 'Never read as approval: the bot says the office is checking it and will send it.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.draftReady(0);
      const again = await p.say('send it again', { after: 10 * 60_000 });
      expect(p.answer(again)).not.toMatch(/Thank you\.$/);
      expect(p.h.t.deliveries).toHaveLength(0);
    },
  },

  // --- thanks and emojis ---------------------------------------------------------------------
  {
    id: 'S070', title: 'a 👍 sticker after the acknowledgement', kinds: ['thanks', 'sticker'],
    natural: 'Taken as thanks; nothing opens.',
    async play(p) {
      await p.say(KAAE_EVENING);
      const sticker = await p.sticker('👍', { after: 30_000, quiet: true });
      expect(p.opened).toHaveLength(1);
      expect(p.answer(sticker)).not.toMatch(/What would you like designed/i);
    },
  },
  {
    id: 'S071', title: 'just "❤️"', kinds: ['thanks', 'emoji'],
    natural: 'A short thanks; nothing opens.',
    async play(p) {
      await p.say(KAAE_EVENING);
      const heart = await p.say('❤️', { after: 30_000 });
      expect(p.opened).toHaveLength(1);
      expect(p.answer(heart)).toMatch(THANKS);
    },
  },
  {
    id: 'S072', title: 'Sorani "thank you very much"', kinds: ['thanks', 'ckb'],
    natural: 'Thanks back in Sorani.',
    async play(p) {
      await p.say(KAAE_EVENING);
      // "Thank you very much"
      const thanks = await p.say('زۆر سوپاس', { after: 30_000 });
      expect(p.answer(thanks)).toMatch(/سوپاس/);
    },
  },
  {
    id: 'S073', title: '"ok" while the office checks the draft', kinds: ['thanks', 'in-review'],
    natural: 'Not a change and not an approval: a short answer; nothing kept for the office.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.draftReady(0);
      await p.say('ok', { after: 60_000 });
      expect(p.kept).toHaveLength(0);
      expect(p.h.t.deliveries).toHaveLength(0);
    },
  },
  {
    id: 'S074', title: 'a sticker as a reply to the draft message', kinds: ['thanks', 'sticker', 'reply'],
    natural: 'Thanks; no button or Desk is named; nothing approved.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.draftReady(0);
      const draft = p.lastBotMessage();
      await p.sticker('😍', { replyTo: draft, after: 60_000, quiet: true });
      expect(p.words).not.toMatch(/Approve design/);
      expect(p.h.t.deliveries).toHaveLength(0);
    },
  },
  {
    id: 'S075', title: 'a sticker with nothing asked for yet', kinds: ['sticker'],
    natural: 'A sticker is not a message that needs an answer (ADR-156): nothing is said and nothing opens; no canned welcome.',
    async play(p) {
      await p.sticker('👋', { quiet: true });
      expect(p.said).toHaveLength(0);
      expect(p.opened).toHaveLength(0);
    },
  },
  {
    id: 'S076', title: '"thanks a lot, great work!" after delivery', kinds: ['thanks', 'delivered'],
    natural: 'Thanks back; the office is not asked to act.',
    async play(p) {
      await deliveredDesign(p);
      const thanks = await p.say('thanks a lot, great work!', { after: 10 * 60_000 });
      expect(p.answer(thanks)).toMatch(THANKS);
      expect(p.kept).toHaveLength(0);
    },
  },

  // --- cancelling ----------------------------------------------------------------------------
  {
    id: 'S080', title: '"cancel that" while it is being made', kinds: ['cancel'],
    natural: 'The cancellation is passed to the office; the requester is told so.',
    async play(p) {
      await p.say(KAAE_EVENING);
      const cancel = await p.say('cancel that', { after: 60_000 });
      expect(p.answer(cancel)).toMatch(/cancel|stop/i);
      expect(p.kept).toHaveLength(1);
    },
  },
  {
    id: 'S081', title: '"no need anymore, thanks"', kinds: ['cancel'],
    natural: 'Read as a cancellation, not as thanks.',
    async play(p) {
      await p.say(KAAE_EVENING);
      const cancel = await p.say('no need anymore, thanks', { after: 60_000 });
      expect(p.answer(cancel)).toMatch(/cancel|stop/i);
    },
  },
  {
    id: 'S082', title: 'Sorani "not needed, cancel it"', kinds: ['cancel', 'ckb'],
    natural: 'Read as a cancellation, answered in Sorani.',
    async play(p) {
      await p.say(KAAE_EVENING);
      // "Not needed, cancel it"
      const cancel = await p.say('پێویست ناکات، هەڵیبوەشێنەوە', { after: 60_000 });
      expect(p.kept).toHaveLength(1);
      expect(p.answer(cancel)).toMatch(/[؀-ۿ]/);
    },
  },
  {
    id: 'S083', title: '"cancel it" with two designs on the way', kinds: ['cancel', 'two-requests'],
    natural: 'The bot asks which one, once.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.say('Another poster please: KAAE staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium.', { after: 60_000 });
      const cancel = await p.say('cancel it', { after: 60_000 });
      expect(p.answer(cancel)).toMatch(/Which design/);
    },
  },
  {
    id: 'S084', title: '"stop" on its own', kinds: ['cancel'],
    natural: 'Read as a cancellation of the one design.',
    async play(p) {
      await p.say(KAAE_EVENING);
      const stop = await p.say('stop', { after: 60_000 });
      expect(p.answer(stop)).toMatch(/cancel|stop/i);
    },
  },
  {
    id: 'S085', title: '"wait, don\'t make it yet, we are changing the date"', kinds: ['cancel', 'mind'],
    natural: 'Kept for the office on the design (a hold or a change), never a new request.',
    async play(p) {
      await p.say(KAAE_EVENING);
      const hold = await p.say("wait, don't make it yet, we are changing the date", { after: 60_000 });
      expect(p.opened).toHaveLength(1);
      expect(p.answer(hold)).toMatch(/office|cancel|stop/i);
    },
  },
  {
    id: 'S086', title: '"wait, don\'t make it yet" is heard as "hold it", not as an added change', kinds: ['cancel', 'mind'],
    natural: 'The requester hears the office will hold the design for the new date; the office is asked to hold it (the automatic draft is not left running as if nothing was said).',
    open: 'a request to hold a design is kept as a change note ("I have added that to ..."); the automatic draft carries on',
    async play(p) {
      await p.say(KAAE_EVENING);
      const hold = await p.say("wait, don't make it yet, we are changing the date", { after: 60_000 });
      expect(p.answer(hold)).toMatch(/hold|wait|pause/i);
    },
  },
  {
    id: 'S087', title: 'Sorani "no, cancel it"', kinds: ['cancel', 'ckb'],
    natural: 'Read as a cancellation, in Sorani.',
    async play(p) {
      await p.say(KAAE_EVENING);
      // "No, cancel it"
      const cancel = await p.say('نا، هەڵیبوەشێنەوە', { after: 60_000 });
      expect(p.kept).toHaveLength(1);
      expect(p.answer(cancel)).toMatch(/هەڵبوەشێنێتەوە/);
    },
  },

  // --- questions the bot cannot answer, commands, buttons ------------------------------------
  {
    id: 'S090', title: '"how much does a poster cost?"', kinds: ['question'],
    natural: 'The bot cannot answer prices: it says the office will (or passes the question), never a canned brief prompt only.',
    async play(p) {
      const asked = await p.say('how much does a poster cost?');
      expect(p.answer(asked)).toMatch(/office/i);
      expect(p.opened).toHaveLength(0);
    },
  },
  {
    id: 'S091', title: '"can you make videos?"', kinds: ['question'],
    natural: 'The office answers what the office does; nothing opens, and no prompt for a brief instead of an answer.',
    async play(p) {
      const asked = await p.say('can you make videos?');
      expect(p.opened).toHaveLength(0);
      expect(p.answer(asked)).toMatch(/office/i);
    },
  },
  {
    id: 'S092', title: 'Sorani "how much is a poster?"', kinds: ['question', 'ckb'],
    natural: 'The office answers prices; in Sorani.',
    async play(p) {
      // "How much is a poster?"
      const asked = await p.say('نرخی پۆستەرێک چەندە؟');
      expect(p.answer(asked)).toMatch(/ئۆفیس/);
      expect(p.opened).toHaveLength(0);
    },
  },
  {
    id: 'S093', title: '"/start"', kinds: ['command'],
    natural: 'A welcome in plain words.',
    async play(p) {
      const start = await p.say('/start');
      expect(p.answer(start)).toMatch(/Tell me what/i);
    },
  },
  {
    id: 'S094', title: '"hello" on its own', kinds: ['greeting'],
    natural: 'A friendly invitation to say what to design.',
    async play(p) {
      const hi = await p.say('hello');
      expect(p.answer(hi)).toMatch(/What would you like designed/i);
    },
  },
  {
    id: 'S095', title: 'a button under an old message', kinds: ['button'],
    natural: 'Plain words; no button or command is asked for.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.h.press(p.chatId, p.me, 50, 'approve:old-task', 60_000);
      expect(p.words).not.toMatch(/tap|button/i);
    },
  },
  {
    id: 'S096', title: '"who am I talking to?"', kinds: ['question'],
    natural: 'A short honest answer; nothing opens.',
    async play(p) {
      const asked = await p.say('who am I talking to?');
      expect(p.opened).toHaveLength(0);
      expect(p.answer(asked)).not.toBe('');
    },
  },
  {
    id: 'S097', title: '"do you have our logo already?" while a design is being made', kinds: ['question'],
    natural: 'Not a change and not a new request; the office can answer.',
    async play(p) {
      await p.say(KAAE_EVENING);
      const asked = await p.say('do you have our logo already?', { after: 60_000 });
      expect(p.opened).toHaveLength(1);
      expect(p.answer(asked)).not.toMatch(NO_QUESTION);
    },
  },
];
