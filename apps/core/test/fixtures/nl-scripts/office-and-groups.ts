/**
 * Approval words from the requester and from the office (ADR-040 addendum: an office member approves in
 * their private Telegram chat), and group chats with two people (ADR-182).
 */
import { expect } from 'vitest';
import type { Play, Script } from '../conversation-script.js';
import { KAAE_EVENING } from './briefs.js';

const mention = (text: string) => ({ text: `@hawa_office_bot ${text}`, entities: [{ type: 'mention', offset: 0, length: 16 }] });

async function inReview(p: Play): Promise<void> {
  await p.say(KAAE_EVENING);
  await p.draftReady(0);
}

export const OFFICE_AND_GROUP_SCRIPTS: Script[] = [
  {
    id: 'S120', title: 'the requester says "approved" while the office checks the draft', kinds: ['approval', 'requester'],
    natural: 'Nothing is approved: the office is told the requester is happy; the requester hears so.',
    async play(p) {
      await inReview(p);
      const ok = await p.say('approved', { after: 60_000 });
      expect(p.h.t.deliveries).toHaveLength(0);
      expect(p.answer(ok)).toMatch(/office/i);
      expect(p.officeHeard.some((s) => /happy/.test(s.text))).toBe(true);
    },
  },
  {
    id: 'S121', title: 'the requester says "looks good, send it"', kinds: ['approval', 'requester'],
    natural: 'Passed to the office; nothing is approved or sent.',
    async play(p) {
      await inReview(p);
      await p.say('looks good, send it', { after: 60_000 });
      expect(p.h.t.deliveries).toHaveLength(0);
      expect(await p.stages()).toEqual(['in_review']);
    },
  },
  {
    id: 'S122', title: 'the requester says "approved" in Sorani', kinds: ['approval', 'requester', 'ckb'],
    natural: 'Passed to the office, answered in Sorani.',
    async play(p) {
      await inReview(p);
      // "It is approved"
      const ok = await p.say('پەسەندە', { after: 60_000 });
      expect(p.h.t.deliveries).toHaveLength(0);
      expect(p.answer(ok)).toMatch(/ئۆفیس/);
    },
  },
  {
    id: 'S123', title: 'the office member replies "approved" to the draft', kinds: ['approval', 'office'],
    natural: 'Asked once, naming the draft and its requester (ADR-200); "yes" approves; delivery starts; the member is told.',
    async play(p) {
      await inReview(p);
      const ok = await p.officeReplies('approved');
      expect(p.h.saidFor(ok).map((s) => s.text).join()).toMatch(/^Send <b>.+<\/b> to <b>Sewa<\/b> now\?$/);
      expect(p.h.t.deliveries).toHaveLength(0);
      const yes = await p.h.officeSays(p.office[0], 'yes');
      expect(p.h.saidFor(yes).map((s) => s.text).join()).toMatch(/Approved/);
      expect(p.h.t.deliveries).toHaveLength(1);
    },
  },
  {
    id: 'S124', title: 'the office member writes "ok send it" without replying, one draft waiting', kinds: ['approval', 'office'],
    natural: 'The one waiting draft is asked about by name (ADR-200), then approved on "yes".',
    async play(p) {
      await inReview(p);
      await p.h.officeSays(p.office[0], 'ok send it');
      expect(p.h.t.deliveries).toHaveLength(0);
      await p.h.officeSays(p.office[0], 'yes');
      expect(p.h.t.deliveries).toHaveLength(1);
    },
  },
  {
    id: 'S125', title: 'the office member replies "👍 send" in Sorani-English mix', kinds: ['approval', 'office', 'emoji'],
    natural: 'Asked once in Sorani (ADR-200); approved on a Sorani "yes".',
    async play(p) {
      await inReview(p);
      await p.officeReplies('👍 باشە بینێرە');
      expect(p.h.t.deliveries).toHaveLength(0);
      await p.h.officeSays(p.office[0], 'بەڵێ');
      expect(p.h.t.deliveries).toHaveLength(1);
    },
  },
  {
    id: 'S126', title: 'the office member replies with a change to the draft', kinds: ['office', 'change'],
    natural: 'The draft goes back to the requester with the office\'s words; nothing is approved.',
    async play(p) {
      await inReview(p);
      await p.officeReplies('make the title bigger and use the new logo');
      expect(p.words).toMatch(/make the title bigger/);
      expect(p.h.t.deliveries).toHaveLength(0);
    },
  },
  {
    id: 'S127', title: 'the office member says "thanks" in their chat with no reply', kinds: ['office', 'thanks'],
    natural: 'Not a decision: nothing is approved.',
    async play(p) {
      await inReview(p);
      await p.h.officeSays(p.office[0], 'thanks');
      expect(p.h.t.deliveries).toHaveLength(0);
      expect(await p.stages()).toEqual(['in_review']);
    },
  },
  {
    id: 'S128', title: 'the office member, with a design of their own on the way, says "ok send it" with no reply', kinds: ['office', 'approval', 'owner'],
    natural: 'It could be about their own design or the waiting draft: the bot asks, or approves only what they clearly mean; it never approves another requester\'s draft by guess.',
    async play(p) {
      await inReview(p);
      const own = String(p.office[0].id);
      await p.h.post(own, p.office[0], 'text', { text: 'Poster for the KAAE staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium.' });
      await p.h.wait(60_000);
      const said = await p.h.officeSays(p.office[0], 'ok send it when it is ready');
      expect(p.h.t.deliveries).toHaveLength(0);
      expect(p.h.saidFor(said).map((s) => s.text).join()).not.toBe('');
    },
  },
  {
    id: 'S129', title: 'the office member approves a draft while the requester just wrote a change', kinds: ['office', 'approval', 'late'],
    natural: 'The member is shown the requester\'s words before anything is sent.',
    async play(p) {
      await inReview(p);
      await p.say('the date should be 5 December, not 4', { after: 60_000 });
      const ok = await p.officeReplies('approved');
      expect(p.h.saidFor(ok).map((s) => s.text).join()).toMatch(/5 December/);
      expect(p.h.t.deliveries).toHaveLength(0);
    },
  },

  // --- groups --------------------------------------------------------------------------------
  {
    id: 'S130', title: 'group chatter that mentions an event, not addressed to the bot', kinds: ['group'],
    natural: 'The bot stays silent and opens nothing.',
    async play(p) {
      await p.say('Colleagues, the KAAE dinner is on Monday at the Rotana hotel, please be on time.', { quiet: true });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(0);
      expect(p.said).toHaveLength(0);
    },
  },
  {
    id: 'S131', title: 'a brief in a group, addressed to the bot by name', kinds: ['group', 'brief'],
    natural: 'One request opens.',
    async play(p) {
      const m = mention(KAAE_EVENING);
      await p.say(m.text, { entities: m.entities });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      // The bot's name addresses it: it is neither the brief's copy nor the design's name.
      expect(p.brief()).not.toContain('@hawa_office_bot');
      expect(p.words).not.toContain('@hawa_office_bot');
    },
  },
  {
    id: 'S132', title: 'two people in a group each send a photo and a brief to the bot', kinds: ['group', 'photo', 'two-people'],
    natural: 'Two requests, each with its own sender\'s photo; photos never mixed.',
    async play(p) {
      await p.photo(31, { quiet: true });
      await p.photo(32, { from: p.colleague, after: 2_000, quiet: true });
      const a = mention('Poster for the KAAE members evening, 4 December 2026 at 7 pm, Erbil International Hotel');
      await p.say(a.text, { entities: a.entities, after: 10_000 });
      const b = mention('Poster for the KAAE staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium');
      await p.say(b.text, { entities: b.entities, from: p.colleague, after: 5_000 });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(2);
      expect(await p.h.photosOf(p.request(0))).toBe(1);
      expect(await p.h.photosOf(p.request(1))).toBe(1);
    },
  },
  {
    id: 'S133', title: 'in a group, a colleague asks the bot how someone else\'s design is going', kinds: ['group', 'status'],
    natural: 'Where the design stands (status is safe to share in the group); nothing changes.',
    async play(p) {
      const m = mention(KAAE_EVENING);
      await p.say(m.text, { entities: m.entities });
      const q = mention('is the poster ready?');
      const asked = await p.say(q.text, { entities: q.entities, from: p.colleague, after: 120_000 });
      expect(p.answer(asked)).toMatch(/being designed/i);
      expect(p.kept).toHaveLength(0);
    },
  },
  {
    id: 'S134', title: 'in a group, a colleague tries to change someone else\'s design', kinds: ['group', 'change'],
    natural: 'Only the requester (or the office) changes it: nothing is kept or started from the colleague\'s words.',
    async play(p) {
      const m = mention(KAAE_EVENING);
      await p.say(m.text, { entities: m.entities });
      const c = mention('make the logo bigger on that poster');
      await p.say(c.text, { entities: c.entities, from: p.colleague, after: 120_000, quiet: true });
      expect(p.kept).toHaveLength(0);
    },
  },
  {
    id: 'S135', title: 'an office member says "approved" in the requester\'s group', kinds: ['group', 'office', 'approval'],
    natural: 'Not a decision in a group: nothing is approved.',
    async play(p) {
      const m = mention(KAAE_EVENING);
      await p.say(m.text, { entities: m.entities });
      await p.draftReady(0);
      await p.say('approved', { from: p.office[0], after: 60_000, quiet: true });
      expect(p.h.t.deliveries).toHaveLength(0);
    },
  },
  {
    id: 'S136', title: 'a group photo from a member, not addressed to the bot', kinds: ['group', 'photo'],
    natural: 'Kept as group conversation: nothing opens, nothing is said.',
    async play(p) {
      await p.photo(33, { from: p.colleague, quiet: true });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(0);
      expect(p.said).toHaveLength(0);
    },
  },
];
