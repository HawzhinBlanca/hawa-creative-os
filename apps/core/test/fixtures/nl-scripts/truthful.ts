/**
 * ADR-231 (live Telegram test, production b83c9f1d, 2026-10-01): what the bot says matches what
 * happens. The live sequences, played end to end: redo words while a request opened by mistake for a
 * designer is the most recent (L2, L4), a status question with two designs of one name and a delivered
 * one (L5), and "can you also make videos?" while a draft is with the office (L11).
 */
import { expect } from 'vitest';
import type { Script } from '../conversation-script.js';
import { KAAE_EVENING } from './briefs.js';

const LIVE_REDO = "do a better design that's similar to the earlier ones, use more of the photos";

export const TRUTHFUL_SCRIPTS: Script[] = [
  {
    id: 'S161', title: 'redo words an hour after a request was opened for a designer (live L2)', kinds: ['redo', 'delivered', 'manual', 'en'],
    natural: 'The delivered design is redone (a round starts, and only then "I\'ll redo …"); the designer\'s request, which has no draft, is left alone.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.draftReady(0);
      await p.delivered(0);
      // Opened for a designer: a request with no copy, so no draft.
      await p.say('Can you make a poster for our team?', { after: 3 * 60 * 60_000 });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(2);
      const redo = await p.say(LIVE_REDO, { after: 60 * 60_000 });
      expect(p.revisions.map((r) => [r.requestId, r.directive])).toEqual([[p.request(0), LIVE_REDO]]);
      expect(p.kept.filter((k) => k.requestId === p.request(1))).toHaveLength(0);
      expect(p.answer(redo)).toMatch(/^I'll redo <b>KAAE members evening/);
    },
  },
  {
    id: 'S162', title: '"can you also make videos?" while the draft is with the office (live L11)', kinds: ['question', 'in-review', 'en'],
    natural: 'A question for the office, told so; nothing is kept on the design, and Deliver is not held.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.draftReady(0);
      const asked = await p.say('can you also make videos?', { after: 4 * 60_000 });
      expect(p.kept).toHaveLength(0);
      expect(p.answer(asked)).toMatch(/passed your question to the office/);
      expect(p.answer(asked)).not.toMatch(/your change/);
      expect(p.officeHeard.some((s) => /asked a question the bot cannot answer/.test(s.text) && s.text.includes('can you also make videos?'))).toBe(true);
    },
  },
  {
    id: 'S163', title: '"what\'s the status of my designs?" with two designs of one name (live L5)', kinds: ['status', 'en'],
    natural: 'Each design once, each line true for its stage, the two of one name told apart by when they were asked for.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.draftReady(0);
      await p.delivered(0);
      await p.say(KAAE_EVENING, { after: 2 * 60 * 60_000 });
      await p.draftReady(1);
      const asked = await p.say("what's the status of my designs?", { after: 10 * 60_000 });
      const lines = p.answer(asked).split('\n\n').filter((l) => l.includes('KAAE members evening'));
      expect(lines).toHaveLength(2);
      expect(new Set(lines.map((l) => l.replace(/ (?:has been|is with).*/s, ''))).size).toBe(2);
      expect(lines.every((l) => /\(asked for [^)]+\)/.test(l))).toBe(true);
      expect(p.answer(asked)).not.toMatch(/being sent to you now/);
    },
  },
];
