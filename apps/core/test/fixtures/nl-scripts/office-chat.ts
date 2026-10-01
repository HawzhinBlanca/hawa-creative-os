/**
 * ADR-200: the office's private chat with the bot, read like a chat. An office member decides on drafts
 * in their own words, the conversation names drafts ("the Dara one", "the earlier one", "the other"),
 * and an approval that sends a draft to someone else is asked about once ("Send <title> to <requester>
 * now?"). The office reading is a fixture here (`officeReads`): no paid call is made.
 */
import { expect } from 'vitest';
import type { OfficeModelDecision, OfficeModelInput } from '../../../src/services/office-intent-model.js';
import type { Play, Script } from '../conversation-script.js';
import { KAAE_EVENING } from './briefs.js';

const FOOTBALL = 'Poster for the KAAE staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium.';

async function inReview(p: Play): Promise<void> {
  await p.say(KAAE_EVENING);
  await p.draftReady(0);
}

/**
 * A second requester (Dara, in a chat of her own) whose draft reaches the office after Sewa's: two
 * drafts wait, Sewa's sent to the office `apart` ms before Dara's.
 */
async function twoDrafts(p: Play, apart = 20 * 60_000): Promise<{ sewa: string; dara: string }> {
  await inReview(p);
  const chat = p.h.chat('private', p.colleague.id);
  await p.h.post(chat, p.colleague, 'text', { text: FOOTBALL }, 30_000, 'Dara: football poster');
  // Her brief opens once she has been quiet for a moment (ADR-182 held briefs).
  await p.h.wait(60_000);
  const dara = p.h.t.opened.find((o) => o.chatId === chat)!.requestId;
  await p.h.draftReady(dara, apart);
  return { sewa: p.request(0), dara };
}

/** The office reading of `text`: `kind`, about the listed draft whose requester is `who`. */
function reads(p: Play, text: string, kind: OfficeModelDecision['kind'], who: string | null, confidence = 0.9): void {
  p.h.officeReads.set(text, (input: OfficeModelInput) => ({ kind, confidence, change: '',
    draft: who ? input.drafts.findIndex((d) => d.requester === who) + 1 : 0 }));
}

const office = (p: Play, text: string) => p.h.officeSays(p.office[0], text);
const said = (p: Play, inbound: Awaited<ReturnType<typeof office>>) => p.h.saidFor(inbound).map((s) => s.text).join('\n');
const stageOf = async (p: Play, requestId: string) => (await p.h.requests(p.h.t.opened.find((o) => o.requestId === requestId)!.chatId))
  .find((r) => r.requestId === requestId)?.stage;

export const OFFICE_CHAT_SCRIPTS: Script[] = [
  {
    id: 'S137', title: 'office: "looks good" with no reply, one draft waiting, then "ok"', kinds: ['office', 'approval', 'confirm'],
    natural: 'The bot asks once, naming the draft and Sewa; "ok" sends it.',
    async play(p) {
      await inReview(p);
      reads(p, 'looks good', 'approve', 'Sewa');
      const asked = await office(p, 'looks good');
      expect(said(p, asked)).toMatch(/^Send <b>.+<\/b> to <b>Sewa<\/b> now\?$/);
      expect(p.h.t.deliveries).toHaveLength(0);
      await office(p, 'ok');
      expect(p.h.t.deliveries).toHaveLength(1);
    },
  },
  {
    id: 'S138', title: 'office: confirmation, then "wait, change the date to 5 December"', kinds: ['office', 'confirm', 'change'],
    natural: 'Nothing is sent; the draft goes back to Sewa with the office\'s words.',
    async play(p) {
      await inReview(p);
      await office(p, 'approved');
      const changed = await office(p, 'wait, change the date to 5 December');
      expect(said(p, changed)).toMatch(/Sent back for changes/);
      expect(p.h.t.deliveries).toHaveLength(0);
      expect(p.words).toMatch(/change the date to 5 December/);
    },
  },
  {
    id: 'S139', title: 'office: confirmation, "not yet", later "send it", then "yes"', kinds: ['office', 'confirm'],
    natural: 'Nothing is sent on "not yet" and the draft waits; the later "send it" is asked once more, and "yes" sends.',
    async play(p) {
      await inReview(p);
      await office(p, 'send it');
      const no = await office(p, 'not yet');
      expect(said(p, no)).toMatch(/haven't sent/);
      expect(p.h.t.deliveries).toHaveLength(0);
      expect(await p.stages()).toEqual(['in_review']);
      const again = await office(p, 'send it');
      expect(said(p, again)).toMatch(/now\?$/);
      await office(p, 'yes');
      expect(p.h.t.deliveries).toHaveLength(1);
    },
  },
  {
    id: 'S140', title: 'office: two drafts, "the Dara one looks good", then "yes"', kinds: ['office', 'two-drafts', 'model'],
    natural: 'The bot asks about Dara\'s draft by name; "yes" sends Dara\'s; Sewa\'s keeps waiting.',
    async play(p) {
      const { sewa, dara } = await twoDrafts(p);
      reads(p, 'the Dara one looks good', 'approve', 'Dara');
      const asked = await office(p, 'the Dara one looks good');
      expect(said(p, asked)).toMatch(/to <b>Dara<\/b> now\?$/);
      await office(p, 'yes');
      expect(p.h.t.deliveries).toHaveLength(1);
      expect(await stageOf(p, dara)).toBe('delivering');
      expect(await stageOf(p, sewa)).toBe('in_review');
    },
  },
  {
    id: 'S141', title: 'office: two drafts, "make the logo bigger on the earlier one"', kinds: ['office', 'two-drafts', 'change'],
    natural: 'The earlier draft (Sewa\'s) goes back with the words, named in the answer; Dara\'s keeps waiting.',
    async play(p) {
      const { sewa, dara } = await twoDrafts(p);
      const changed = await office(p, 'make the logo bigger on the earlier one');
      expect(said(p, changed)).toMatch(/Sent back for changes/);
      expect(await stageOf(p, sewa)).toBe('manual');
      expect(await stageOf(p, dara)).toBe('in_review');
      expect(p.words).toMatch(/make the logo bigger on the earlier one/);
    },
  },
  {
    id: 'S142', title: 'office: "looks good, send it" asked about the newer draft; "not this one, the other"; "yes"', kinds: ['office', 'two-drafts', 'confirm'],
    natural: 'The question moves to the other draft, by name; "yes" sends that one only.',
    async play(p) {
      const { sewa, dara } = await twoDrafts(p);
      reads(p, 'looks good, send it', 'approve', 'Dara');
      reads(p, 'not this one, the other', 'approve', 'Sewa');
      expect(said(p, await office(p, 'looks good, send it'))).toMatch(/to <b>Dara<\/b> now\?$/);
      expect(said(p, await office(p, 'not this one, the other'))).toMatch(/to <b>Sewa<\/b> now\?$/);
      await office(p, 'yes');
      expect(await stageOf(p, sewa)).toBe('delivering');
      expect(await stageOf(p, dara)).toBe('in_review');
    },
  },
  {
    id: 'S143', title: 'office: the incident sentence, with a reading that misreads it as approval', kinds: ['office', 'refusal', 'model'],
    natural: 'Refusing words never approve: the draft goes back with the words; nothing is sent.',
    async play(p) {
      await inReview(p);
      const words = 'the design is not approved, the images cut with no content awareness, should have more images organized creatively';
      reads(p, words, 'approve', 'Sewa', 0.97);
      await office(p, words);
      expect(p.h.t.deliveries).toHaveLength(0);
      expect(await p.stages()).toEqual(['manual']);
      expect(p.words).toMatch(/content awareness/);
    },
  },
  {
    id: 'S144', title: 'office: "approved" in Sorani, then a Sorani "yes"', kinds: ['office', 'ckb', 'confirm'],
    natural: 'Asked in Sorani, naming the draft and Sewa; the Sorani "yes" sends it.',
    async play(p) {
      await inReview(p);
      // "It is approved"
      const asked = await office(p, 'پەسەندە');
      expect(said(p, asked)).toMatch(/<b>Sewa<\/b> بنێرم؟$/);
      // "Yes"
      await office(p, 'بەڵێ');
      expect(p.h.t.deliveries).toHaveLength(1);
    },
  },
  {
    id: 'S145', title: 'the owner approves their own design: "send it"', kinds: ['office', 'owner', 'approval'],
    natural: 'Sent at once, with no question: the one who asked is the one approving.',
    async play(p) {
      const own = String(p.office[0].id);
      await p.h.post(own, p.office[0], 'text', { text: FOOTBALL }, 20_000, 'owner: football poster');
      await p.h.wait(60_000);
      const request = p.h.t.opened.find((o) => o.chatId === own)!.requestId;
      await p.h.draftReady(request);
      const sent = await office(p, 'send it');
      expect(said(p, sent)).toMatch(/^Approved\. Sending <b>.+<\/b> to you now\.$/);
      expect(p.h.t.deliveries).toHaveLength(1);
    },
  },
  {
    id: 'S146', title: 'office: confirmation, then "yes" in the requester\'s group', kinds: ['office', 'group', 'confirm'],
    natural: 'A "yes" in a group is not the office\'s answer: nothing is sent until the member says yes in their own chat.',
    async play(p) {
      const m = { text: `@hawa_office_bot ${KAAE_EVENING}`, entities: [{ type: 'mention', offset: 0, length: 16 }] };
      await p.say(m.text, { entities: m.entities });
      await p.draftReady(0);
      await p.officeReplies('approved');
      await p.say('yes', { from: p.office[0], after: 30_000, quiet: true });
      expect(p.h.t.deliveries).toHaveLength(0);
      await office(p, 'yes');
      expect(p.h.t.deliveries).toHaveLength(1);
    },
  },
  {
    id: 'S147', title: 'office: two drafts, "the Dara one looks good" while the reading is unavailable', kinds: ['office', 'two-drafts', 'fallback'],
    natural: 'The rules name Dara\'s draft and ask what to do; "approve it" asks once more by name; "yes" sends it.',
    async play(p) {
      const { sewa, dara } = await twoDrafts(p);
      const asked = await office(p, 'the Dara one looks good');
      expect(said(p, asked)).toMatch(/What should I do with <b>/);
      expect(said(p, await office(p, 'approve it'))).toMatch(/to <b>Dara<\/b> now\?$/);
      await office(p, 'yes');
      expect(await stageOf(p, dara)).toBe('delivering');
      expect(await stageOf(p, sewa)).toBe('in_review');
    },
  },
  {
    id: 'S148', title: 'office: "who asked for this one?" after the draft picture', kinds: ['office', 'question', 'model'],
    natural: 'Told who asked for it, when it came and its photos, then asked what to do; nothing is decided.',
    async play(p) {
      await inReview(p);
      reads(p, 'who asked for this one?', 'question', 'Sewa');
      const answer = await office(p, 'who asked for this one?');
      expect(said(p, answer)).toMatch(/is from <b>Sewa<\/b>, sent to you .+ What would you like me to do with it\?$/);
      expect(p.h.t.deliveries).toHaveLength(0);
      expect(await p.stages()).toEqual(['in_review']);
    },
  },
  {
    id: 'S149', title: 'office: confirmation, then a brief of the member\'s own', kinds: ['office', 'brief', 'confirm'],
    natural: 'The brief opens a request of the member\'s own; the waiting draft is not sent.',
    async play(p) {
      await inReview(p);
      await office(p, 'approved');
      reads(p, 'Can you make a poster for our staff football tournament on 14 November at 4 pm?', 'new_request', null);
      await office(p, 'Can you make a poster for our staff football tournament on 14 November at 4 pm?');
      await p.h.wait(60_000);
      expect(p.h.t.deliveries).toHaveLength(0);
      expect(await p.stages()).toEqual(['in_review']);
      expect(p.h.t.opened.filter((o) => o.chatId === String(p.office[0].id))).toHaveLength(1);
    },
  },
  {
    id: 'S150', title: 'office: "thanks" after a draft was sent', kinds: ['office', 'thanks'],
    natural: 'Thanks decide nothing and ask no model.',
    async play(p) {
      await inReview(p);
      await office(p, 'approved');
      await office(p, 'yes');
      await office(p, 'thanks!');
      expect(p.h.t.deliveries).toHaveLength(1);
      expect(p.h.officeAsked.map((i) => i.text)).not.toContain('thanks!');
    },
  },
];
