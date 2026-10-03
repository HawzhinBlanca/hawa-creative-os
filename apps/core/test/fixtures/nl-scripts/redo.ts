/**
 * ADR-200 addendum (incident 2026-10-01 12:33Z): redo words. The owner, who is both an office member
 * and a requester, had been sent the final KAAE K-12 Pilot Study design four hours before and wrote
 * "do a better design thats similar to earlier ones", replying to nothing. Production opened a new
 * request for a designer, named with that sentence. A thoughtful assistant redoes the latest design.
 */
import { expect } from 'vitest';
import type { Inbound } from '../conversation-harness.js';
import type { Play, Script } from '../conversation-script.js';
import { KAAE_EVENING } from './briefs.js';

const K12 = 'KAAE K-12 Pilot Study\n\nDate: 12 October 2026, 10 am\nVenue: KAAE main hall\nPlease make a poster.';
const FOOTBALL = 'Another poster please: KAAE staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium.';
const INCIDENT = 'do a better design thats similar to earlier ones';

const saidTo = (p: Play, inbound: Inbound) => p.h.saidFor(inbound).map((s) => s.text).join('\n');

/** The owner (office member A) asks for a design in their own chat, approves it and is sent it. */
async function ownerDelivered(p: Play, brief = K12): Promise<{ own: string; request: string }> {
  const owner = p.office[0];
  const own = String(owner.id);
  await p.h.post(own, owner, 'text', { text: brief }, 20_000, 'owner: brief');
  await p.h.wait(60_000);
  const request = p.h.t.opened.find((o) => o.chatId === own)!.requestId;
  await p.h.draftReady(request);
  await p.h.officeSays(owner, 'send it');
  await p.h.delivered(request);
  return { own, request };
}

/** Sewa's design, delivered. */
async function delivered(p: Play, brief = KAAE_EVENING): Promise<void> {
  await p.say(brief);
  await p.draftReady(0);
  await p.delivered(0);
}

export const REDO_SCRIPTS: Script[] = [
  {
    id: 'S151', title: 'the incident: the owner, office member and requester, "do a better design thats similar to earlier ones" four hours after delivery',
    kinds: ['redo', 'owner', 'delivered', 'en'],
    natural: 'The delivered K-12 design is redone: a new round of that request with the words as the change, answered "I\'ll redo …"; no new request, no designer, no sentence as a title.',
    async play(p) {
      const { own, request } = await ownerDelivered(p);
      await p.h.wait(4 * 60 * 60_000);
      const redo = await p.h.post(own, p.office[0], 'text', { text: INCIDENT }, 0, 'owner: redo');
      expect(p.h.t.opened.filter((o) => o.chatId === own)).toHaveLength(1);
      expect(p.h.t.revisions.map((r) => [r.requestId, r.directive])).toEqual([[request, INCIDENT]]);
      expect(saidTo(p, redo)).toMatch(/^I'll redo <b>KAAE K-12 Pilot Study/);
      expect(saidTo(p, redo)).not.toMatch(/designer will make|do a better design/);
      expect((await p.h.requests(own)).map((r) => r.stage)).toEqual(['designing']);
      expect(p.h.t.designs.filter((d) => d.requestId === request)).toHaveLength(2);
    },
  },
  {
    id: 'S152', title: 'the owner says "try again" while another requester\'s draft waits for the office', kinds: ['redo', 'owner', 'office'],
    natural: 'The owner\'s own delivered design is redone; Dara\'s waiting draft is not sent back.',
    async play(p) {
      const { own, request } = await ownerDelivered(p);
      const dara = p.h.chat('private', p.colleague.id);
      await p.h.post(dara, p.colleague, 'text', { text: FOOTBALL }, 30_000, 'Dara: football poster');
      await p.h.wait(60_000);
      const daras = p.h.t.opened.find((o) => o.chatId === dara)!.requestId;
      await p.h.draftReady(daras);
      const redo = await p.h.officeSays(p.office[0], 'try again');
      expect(p.h.t.revisions.map((r) => r.requestId)).toEqual([request]);
      expect(saidTo(p, redo)).toMatch(/^I'll redo /);
      expect((await p.h.requests(dara)).map((r) => r.stage)).toEqual(['in_review']);
      expect((await p.h.requests(own)).map((r) => r.stage)).toEqual(['designing']);
    },
  },
  {
    id: 'S153', title: 'a requester: "redo it" two hours after delivery', kinds: ['redo', 'delivered', 'en'],
    natural: 'A new round of the delivered design, named in the answer.',
    async play(p) {
      await delivered(p);
      const redo = await p.say('redo it', { after: 2 * 60 * 60_000 });
      expect(p.revisions.map((r) => r.requestId)).toEqual([p.request(0)]);
      expect(p.answer(redo)).toMatch(/^I'll redo <b>KAAE members evening/);
      expect(p.opened).toHaveLength(1);
    },
  },
  {
    id: 'S154', title: 'Sorani: "make a better design, like the previous ones"', kinds: ['redo', 'delivered', 'ckb'],
    natural: 'Redone, answered in Sorani; the style note goes with the words.',
    async play(p) {
      await delivered(p);
      // "Make a better design like the previous ones"
      const redo = await p.say('دیزاینێکی باشتر بکە وەک ئەوانەی پێشوو', { after: 60 * 60_000 });
      expect(p.revisions).toHaveLength(1);
      expect(p.revisions[0].directive).toContain('وەک ئەوانەی پێشوو');
      expect(p.answer(redo)).toMatch(/دووبارە دەکەمەوە/);
      expect(p.opened).toHaveLength(1);
    },
  },
  {
    id: 'S155', title: 'Sorani: "not good, redo it"', kinds: ['redo', 'delivered', 'ckb', 'refusal'],
    natural: '"Not good" with redo words is a redo, not only a complaint.',
    async play(p) {
      await delivered(p);
      // "It's not good, redo it"
      await p.say('باش نییە، دووبارەی بکەرەوە', { after: 30 * 60_000 });
      expect(p.revisions.map((r) => r.requestId)).toEqual([p.request(0)]);
    },
  },
  {
    id: 'S156', title: 'two designs delivered a minute apart; "try again"', kinds: ['redo', 'two-requests'],
    natural: 'One plain question naming both; "the second one" redoes the football poster.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.say(FOOTBALL, { after: 20 * 60_000 });
      await p.draftReady(0);
      await p.draftReady(1);
      await p.delivered(0);
      await p.delivered(1);
      const asked = await p.say('try again', { after: 30 * 60_000 });
      expect(p.answer(asked)).toMatch(/^Which one should I redo\?\n1\. <b>KAAE members evening.*\n2\. <b>.*football/is);
      // ADR-284 addendum: the football poster is now titled "KAAE Staff Football Tournament" (no date in the name).
      expect(p.revisions).toHaveLength(0);
      await p.say('the second one', { after: 30_000 });
      expect(p.revisions.map((r) => r.requestId)).toEqual([p.request(1)]);
      expect(p.revisions[0].directive).toBe('try again');
    },
  },
  {
    id: 'S157', title: 'a new brief that looks like redo words: "do a poster for the conference on the 5th"', kinds: ['redo', 'brief'],
    natural: 'A new request opens; the delivered design is not redone.',
    async play(p) {
      await delivered(p);
      await p.say('do a KAAE poster for the conference on the 5th', { after: 60 * 60_000 });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(2);
      expect(p.revisions).toHaveLength(0);
    },
  },
  {
    id: 'S158', title: '"do a better design for the conference": redo or new?', kinds: ['redo', 'ask'],
    natural: 'Asked once, naming the design: "Do you mean redo …, or a new design?"; "redo it" redoes it.',
    async play(p) {
      await delivered(p);
      const asked = await p.say('do a better design for the conference', { after: 60 * 60_000 });
      expect(p.answer(asked)).toMatch(/^Do you mean redo <b>KAAE members evening.*<\/b>, or a new design\?$/);
      expect(p.revisions).toHaveLength(0);
      await p.say('redo it', { after: 30_000 });
      expect(p.revisions.map((r) => r.directive)).toEqual(['do a better design for the conference']);
      expect(p.opened).toHaveLength(1);
    },
  },
  {
    id: 'S159', title: '"make another version" while the draft is with the office', kinds: ['redo', 'in-review'],
    // ADR-231: "I'll redo …" only when a round starts; here the requester hears the words went to the office.
    natural: 'Kept on the design for the office; told no new version started and the office has the words; no paid round by itself.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.draftReady(0);
      const redo = await p.say('make another version', { after: 5 * 60_000 });
      expect(p.kept.map((k) => k.requestId)).toEqual([p.request(0)]);
      expect(p.revisions).toHaveLength(0);
      expect(p.answer(redo)).toMatch(/^<b>KAAE members evening.*<\/b> is with the office for a final check, so I haven't started a new version\. I've passed what you said to them/);
      expect(p.answer(redo)).not.toMatch(/I'll redo/);
    },
  },
  {
    id: 'S160', title: 'the incident\'s words with no earlier design', kinds: ['redo', 'title'],
    natural: 'A designer takes it, named neutrally; the requester hears "your design", never their sentence as a name.',
    async play(p) {
      await p.say(INCIDENT);
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(String(p.opened[0].draft.title)).toMatch(/New design request from Sewa$/);
      expect(String(p.opened[0].draft.rawText)).toBe(INCIDENT);
      expect(p.words).not.toMatch(/<b>do a better design/);
      expect(p.words).toMatch(/your design/);
    },
  },
];
