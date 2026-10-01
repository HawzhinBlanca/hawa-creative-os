/**
 * Briefs: in one message or several, forwarded, corrected, in Sorani, in Latin letters, with
 * Arabic-Indic digits, a deadline in words, two at once, another organisation (ADR-182). Every
 * Sorani or Kurmanji line has its meaning in the comment beside it.
 */
import { expect } from 'vitest';
import type { Script } from '../conversation-script.js';

export const KAAE_EVENING = 'KAAE members evening\n\nDate: 4 December 2026, 7 pm\nVenue: Erbil International Hotel\nPlease make a poster.';
/** No question to the requester of the "change or new?" kind, and no "which design?". */
export const NO_QUESTION = /change” or “new|Which design is this for|گۆڕانکاری» یان «نوێ|بۆ کام دیزاینە/;

export const BRIEF_SCRIPTS: Script[] = [
  {
    id: 'S001', title: 'a complete brief in one message', kinds: ['brief', 'en'],
    natural: 'One request opens with every word; the requester hears once that a first draft is being made.',
    async play(p) {
      const brief = await p.say(KAAE_EVENING);
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.brief()).toContain('Erbil International Hotel');
      expect(p.answer(brief)).toMatch(/first draft/i);
      expect(p.said).toHaveLength(1);
    },
  },
  {
    id: 'S002', title: 'a brief typed as three messages a few seconds apart', kinds: ['brief', 'split', 'en'],
    natural: 'The three messages are one brief: one request with all the details, one acknowledgement, no question.',
    async play(p) {
      await p.say('Hi, we need a poster for the KAAE graduation ceremony');
      await p.say('Date: 12 October 2026 at 5 pm', { after: 6_000, quiet: true });
      await p.say('Venue: University of Kurdistan main hall', { after: 7_000, quiet: true });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.brief()).toContain('12 October 2026');
      expect(p.brief()).toContain('main hall');
      expect(p.words).not.toMatch(NO_QUESTION);
      expect(p.said).toHaveLength(1);
    },
  },
  {
    id: 'S003', title: 'a Sorani brief with Arabic-Indic digits', kinds: ['brief', 'ckb', 'digits'],
    natural: 'One request opens; the acknowledgement is in Sorani; the digits are kept as written.',
    async play(p) {
      // "Hello, we want a poster for KAAE's graduation ceremony / Date: 12/10/2026 at 5 in the evening / Place: Rotana hotel"
      const brief = await p.say('سڵاو، پۆستەرێکمان دەوێت بۆ ئاهەنگی دەرچوونی KAAE\nبەروار: ١٢/١٠/٢٠٢٦ کاتژمێر ٥ی ئێوارە\nشوێن: هۆتێلی ڕۆتانا');
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.brief()).toContain('١٢/١٠/٢٠٢٦');
      expect(p.answer(brief)).toMatch(/[؀-ۿ]/);
    },
  },
  {
    id: 'S004', title: 'a correction 40 seconds after the brief ("sorry, the date is the 5th")', kinds: ['brief', 'correction', 'en'],
    natural: 'Still one request; the correction reaches that design (kept for it, the office told); never a second request.',
    async play(p) {
      await p.say(KAAE_EVENING);
      const fix = await p.say('sorry, the date is the 5th not the 4th', { after: 40_000 });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.kept).toHaveLength(1);
      expect(p.answer(fix)).toMatch(/add that to|kept that|passed/i);
    },
  },
  {
    id: 'S008', title: 'a greeting, then the brief ten seconds later', kinds: ['brief', 'greeting', 'en'],
    natural: 'The greeting may be answered; the brief opens one request.',
    async play(p) {
      await p.say('Hello');
      await p.say(KAAE_EVENING, { after: 10_000 });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.brief()).toContain('Erbil International Hotel');
    },
  },
  {
    id: 'S009', title: 'a request phrased as a question with a greeting', kinds: ['brief', 'question', 'en'],
    natural: 'It is a request: one opens (the office or a first draft), never a canned "how can I help".',
    async play(p) {
      const asked = await p.say('Hello, can you make a poster for the KAAE Nawroz party on 20 March 2027 at Sami Abdulrahman Park?');
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.answer(asked)).not.toMatch(/What would you like designed/i);
    },
  },
  {
    id: 'S010', title: 'a Sorani request phrased as a question', kinds: ['brief', 'question', 'ckb'],
    natural: 'It is a request: one opens, answered in Sorani.',
    async play(p) {
      // "Hello, can you make us a poster for KAAE's Nawroz celebration on 20 March at the park?"
      const asked = await p.say('سڵاو، دەتوانن پۆستەرێکمان بۆ دروست بکەن بۆ ئاهەنگی نەورۆزی KAAE لە ٢٠ی ئازار لە پارکی سامی عەبدولڕەحمان؟');
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.answer(asked)).toMatch(/[؀-ۿ]/);
    },
  },
  {
    id: 'S011', title: 'a colleague\'s brief forwarded as it is', kinds: ['brief', 'forward', 'en'],
    natural: 'The forwarded words are the brief: one request opens with them.',
    async play(p) {
      await p.forward('Dear team, please prepare an invitation card for the KAAE annual conference.\nDate: 15 November 2026, 9 am\nVenue: Rotana Hotel, Erbil', { originalSender: 'Dr. Karwan' });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.brief()).toContain('15 November 2026');
    },
  },
  {
    id: 'S012', title: 'two forwarded messages sent together make one brief', kinds: ['brief', 'forward', 'split'],
    natural: 'Forwards sent together are one brief: one request with both.',
    async play(p) {
      await p.forward('Please make a poster for the KAAE accreditation workshop', { originalSender: 'Dr. Karwan' });
      await p.forward('Date: 22 November 2026, 10 am\nVenue: KAAE hall, Erbil', { originalSender: 'Dr. Karwan', after: 1_000, quiet: true });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.brief()).toContain('22 November 2026');
    },
  },
  {
    id: 'S031a', title: 'a forwarded brief whose first line is an instruction is named after its event', kinds: ['brief', 'title'],
    natural: 'The requester hears the design named after the event ("the KAAE accreditation workshop"), not after its date line.',
    async play(p) {
      await p.forward('Please make a poster for the KAAE accreditation workshop', { originalSender: 'Dr. Karwan' });
      await p.forward('Date: 22 November 2026, 10 am\nVenue: KAAE hall, Erbil', { originalSender: 'Dr. Karwan', after: 1_000, quiet: true });
      await p.wait(60_000);
      expect(p.words).toMatch(/accreditation workshop/);
      expect(p.opened[0].draft.title).toMatch(/accreditation workshop/);
      expect(p.opened[0].draft.title).not.toMatch(/Date:/);
    },
  },
  {
    id: 'S013', title: 'a forward, then the requester\'s own line "make a poster from this" five seconds later', kinds: ['brief', 'forward'],
    natural: 'One request: the forwarded words with the instruction.',
    async play(p) {
      await p.forward('KAAE Quality Assurance Seminar\n3 December 2026, 11 am\nKAAE main hall', { originalSender: 'Shwan' });
      await p.say('please make a poster from this', { after: 5_000, quiet: true });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.brief()).toContain('Quality Assurance Seminar');
      expect(p.words).not.toMatch(NO_QUESTION);
    },
  },
  {
    id: 'S014', title: '"can you make a poster from the message below", then the forward', kinds: ['brief', 'forward'],
    natural: 'One request with the forwarded words.',
    async play(p) {
      await p.say('Can you make a poster from the message below?');
      await p.forward('KAAE Open Day\nSaturday 7 November 2026, 10 am to 2 pm\nKAAE campus, 100m Street', { originalSender: 'Shwan', after: 4_000, quiet: true });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.brief()).toContain('Open Day');
      expect(p.words).not.toMatch(NO_QUESTION);
    },
  },
  {
    id: 'S015', title: 'a long message Telegram split in two', kinds: ['brief', 'split', 'long'],
    natural: 'One request with the whole text.',
    async play(p) {
      const body = 'KAAE annual report cover. ' + 'The report summarises the accreditation visits of the year and the lessons learned for every faculty. '.repeat(45);
      await p.say(body.slice(0, 4096));
      await p.say(`${body.slice(4096)}\nClosing line: Towards better education for everyone`, { after: 1_000, quiet: true });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.brief()).toContain('Closing line');
    },
  },
  {
    id: 'S016', title: 'a brief full of misspellings', kinds: ['brief', 'misspelling', 'en'],
    natural: 'It is a brief: one request opens.',
    async play(p) {
      await p.say('plz mak a postr for KAAE confrence on 5 novmber at rotana hotell, 10 am');
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
    },
  },
  {
    id: 'S017', title: 'a Sorani brief written in Latin letters', kinds: ['brief', 'latin-kurdish'],
    natural: 'One request opens (a person can read it); never "what would you like designed".',
    async play(p) {
      // "Hello, make a poster for KAAE for the graduation ceremony, 12 October at the Rotana hotel, at 5 in the evening"
      const brief = await p.say('slaw, postereki bo KAAE drust bka bo ahangi derchwn, 12i october la hotel rotana, katjmer 5i ewara');
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.answer(brief)).not.toMatch(/What would you like designed/i);
    },
  },
  {
    id: 'S018', title: 'a Kurmanji brief in Latin letters', kinds: ['brief', 'latin-kurdish', 'kmr'],
    natural: 'One request opens; never "what would you like designed".',
    async play(p) {
      // "Hello, please make a poster for KAAE, the annual conference on 5 November at the Rotana hotel"
      const brief = await p.say('Silav, ji kerema xwe posterekê ji bo KAAE çêbike, konferansa salane 5ê Mijdarê li otêla Rotana');
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.answer(brief)).not.toMatch(/What would you like designed/i);
    },
  },
  {
    id: 'S019', title: 'a Sorani deadline in words a minute after the brief ("next Thursday")', kinds: ['deadline', 'ckb'],
    natural: 'No second request; the deadline is passed to the office on the design, in Sorani.',
    async play(p) {
      await p.say(KAAE_EVENING);
      // "We need it by next Thursday"
      const when = await p.say('تا پێنجشەممەی داهاتوو پێویستمانە', { after: 60_000 });
      await p.wait(30_000);
      expect(p.opened).toHaveLength(1);
      expect(p.answer(when)).toMatch(/[؀-ۿ]/);
      expect(p.officeHeard.some((s) => s.text.includes('پێنجشەممە'))).toBe(true);
    },
  },
  {
    id: 'S020', title: 'a brief with its deadline in the same message ("needed by next Thursday")', kinds: ['brief', 'deadline', 'en'],
    natural: 'One request with every word, deadline included.',
    async play(p) {
      await p.say('Poster for the KAAE staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium. We need it by next Thursday.');
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.brief()).toContain('next Thursday');
    },
  },
  {
    id: 'S021', title: 'one brief in English and Sorani together', kinds: ['brief', 'mixed'],
    natural: 'It opens (one design per language, as the office works); no question.',
    async play(p) {
      // Sorani lines: "KAAE annual conference / 15 November 2026 / Rotana hotel"
      await p.say('KAAE Annual Conference\n15 November 2026, Rotana Hotel\n\nکۆنفرانسی ساڵانەی KAAE\n١٥ی تشرینی دووەمی ٢٠٢٦، هۆتێلی ڕۆتانا');
      await p.wait(60_000);
      expect(p.opened.length).toBeGreaterThanOrEqual(1);
      expect(p.words).not.toMatch(NO_QUESTION);
    },
  },
  {
    id: 'S022', title: 'two designs asked for in one message', kinds: ['brief', 'two-requests', 'en'],
    natural: 'Two independent requests and automatic design runs, with the requested formats and no mixed event facts.',
    async play(p) {
      await p.say('We need 2 designs for KAAE: a poster for the graduation on 12 October 2026 at the Rotana hotel, and an Instagram story for the open day on 20 October 2026 at the campus.');
      await p.wait(60_000);
      expect(p.opened).toHaveLength(2);
      expect(p.h.t.designs).toHaveLength(2);
      expect(p.opened[0].draft.variant).toEqual({width:1080,height:1350});
      expect(p.opened[1].draft.variant).toEqual({width:1080,height:1920});
      expect(p.brief(0)).toContain('12 October 2026');
      expect(p.brief(0)).not.toContain('20 October 2026');
      expect(p.brief(1)).toContain('20 October 2026');
      expect(p.brief(1)).not.toContain('12 October 2026');
    },
  },
  {
    id: 'S023', title: 'two complete briefs a minute apart', kinds: ['brief', 'two-requests', 'en'],
    natural: 'Two requests, each with its own words; each acknowledged once.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.say('Another poster please: KAAE staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium.', { after: 60_000 });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(2);
      expect(p.brief(1)).toContain('football');
      expect(p.words).not.toMatch(NO_QUESTION);
    },
  },
  {
    id: 'S024', title: 'a brief for another organisation this office works with', kinds: ['brief', 'client'],
    natural: 'The request opens for that organisation, not for the chat\'s usual one.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.say('This one is for ZAR Podcast, not KAAE: poster for the ZAR Podcast season launch, 3 November 2026 at 6 pm, Divan Hotel.', { after: 120_000 });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(2);
      expect(p.opened[1].draft.clientId).not.toBe(p.opened[0].draft.clientId);
    },
  },
  {
    id: 'S025', title: 'a brief for an organisation the office does not know', kinds: ['brief', 'client'],
    natural: 'ADR-235: nothing names an organisation the office works with, so the brief is kept and the requester is asked who it is for; "not sure" opens it for a designer, and the requester is told plainly.',
    async play(p) {
      const brief = await p.say('Poster for the Erbil Chess Club tournament, 8 November 2026 at 3 pm, Family Mall.');
      await p.wait(60_000);
      expect(p.opened).toHaveLength(0);
      expect(p.answer(brief)).toMatch(/Who is this design for\?/);
      expect(p.answer(brief)).not.toMatch(/KAAE/);
      await p.say('not sure');
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.words).toMatch(/passed it to the office/);
    },
  },
  {
    id: 'S026', title: '"make me a nice poster" with no details', kinds: ['brief', 'vague'],
    natural: 'Nothing is drafted from nothing: the bot asks what it is for and the words, or a designer takes it; never a paid draft.',
    async play(p) {
      await p.say('make me a nice poster');
      await p.wait(60_000);
      expect(p.h.t.designs).toHaveLength(0);
    },
  },
  {
    id: 'S027', title: 'a second brief for another event while the first is being made', kinds: ['brief', 'two-requests'],
    natural: 'A second request opens; the first is untouched.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.say('and another poster for the KAAE open day on 20 October 2026 at the campus, 10 am', { after: 90_000 });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(2);
      expect(p.kept).toHaveLength(0);
    },
  },
  {
    id: 'S028', title: 'a Sorani brief in several short messages', kinds: ['brief', 'split', 'ckb'],
    natural: 'One request with all the details, answered in Sorani, no question.',
    async play(p) {
      // "Hello, we want a poster for KAAE"
      await p.say('سڵاو، پۆستەرێکمان دەوێت بۆ KAAE');
      // "for the teachers' day celebration"
      await p.say('بۆ ئاهەنگی ڕۆژی مامۆستا', { after: 5_000, quiet: true });
      // "on 1 March at 10 in the morning, at the university hall"
      await p.say('ڕۆژی ١ی ئازار کاتژمێر ١٠ی بەیانی لە هۆڵی زانکۆ', { after: 6_000, quiet: true });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.brief()).toContain('هۆڵی زانکۆ');
      expect(p.words).not.toMatch(NO_QUESTION);
    },
  },
  {
    id: 'S029', title: 'a brief then "and use our blue colours" five seconds later', kinds: ['brief', 'split', 'style'],
    natural: 'The style line belongs to the brief the draft is made from.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.say('and use our blue colours please', { after: 5_000, quiet: true });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.brief()).toContain('blue colours');
    },
  },
];
