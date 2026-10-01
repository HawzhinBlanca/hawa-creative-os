/**
 * Photos, albums, voice notes, PDFs, videos, SVG files and edits (ADR-182).
 */
import { expect } from 'vitest';
import type { Script } from '../conversation-script.js';
import { KAAE_EVENING, NO_QUESTION } from './briefs.js';

export const MEDIA_SCRIPTS: Script[] = [
  {
    id: 'S100', title: 'three photos first (an album, no words), the text three minutes later', kinds: ['photo', 'album', 'photos-first'],
    natural: 'One request with the three photos and the text; at most one short question in between.',
    async play(p) {
      await p.album([1, 2, 3]);
      await p.say(KAAE_EVENING, { after: 3 * 60_000 });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(await p.h.photosOf(p.request(0))).toBe(3);
    },
  },
  {
    id: 'S101', title: 'one photo with no words, the text twenty seconds later', kinds: ['photo', 'photos-first'],
    natural: 'One request with the photo and the text.',
    async play(p) {
      await p.photo(4, { quiet: true });
      await p.say(KAAE_EVENING, { after: 20_000 });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(await p.h.photosOf(p.request(0))).toBe(1);
    },
  },
  {
    id: 'S102', title: 'the text, then an album five seconds later', kinds: ['photo', 'album', 'text-first'],
    natural: 'One request with the text and the photos.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.album([5, 6], { after: 5_000, quiet: true });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(await p.h.photosOf(p.request(0))).toBe(2);
    },
  },
  {
    id: 'S103', title: 'the text, then one photo five seconds later', kinds: ['photo', 'text-first'],
    natural: 'One request with the text and the photo.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.photo(8, { after: 5_000, quiet: true });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(await p.h.photosOf(p.request(0))).toBe(1);
    },
  },
  {
    id: 'S104', title: 'an album with the brief as its caption', kinds: ['photo', 'album'],
    natural: 'One request with the photos and the words.',
    async play(p) {
      await p.album([9, 10, 11], { caption: KAAE_EVENING });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(await p.h.photosOf(p.request(0))).toBe(3);
    },
  },
  {
    id: 'S105', title: 'a photo with "use this photo" and nothing else', kinds: ['photo'],
    natural: 'The photo is kept and the bot asks, in words, what to design with it.',
    async play(p) {
      const photo = await p.photo(12, { caption: 'use this photo' });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(0);
      expect(p.answer(photo)).toMatch(/design|text/i);
    },
  },
  {
    id: 'S106', title: 'four photos one by one, the brief as the last one\'s caption', kinds: ['photo', 'burst'],
    natural: 'One request with the four photos.',
    async play(p) {
      for (const n of [13, 14, 15]) await p.photo(n, { after: 1_000, quiet: true });
      await p.photo(16, { caption: KAAE_EVENING, after: 1_000 });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(await p.h.photosOf(p.request(0))).toBe(4);
    },
  },
  {
    id: 'S107', title: 'a photo "use this logo" while the design is being made', kinds: ['photo', 'material'],
    natural: 'The photo becomes that design\'s material; no second request.',
    async play(p) {
      await p.say(KAAE_EVENING);
      const logo = await p.photo(17, { caption: 'use this logo please', after: 60_000 });
      await p.wait(30_000);
      expect(p.opened).toHaveLength(1);
      expect(p.answer(logo)).toMatch(/photo|added|kept/i);
    },
  },
  {
    id: 'S108', title: 'a photo sent as a reply to the draft notice while the office checks it', kinds: ['photo', 'in-review', 'reply'],
    natural: 'Passed to the office with the photo; the requester is told so.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.draftReady(0);
      const draft = p.lastBotMessage();
      const photo = await p.photo(18, { caption: 'please use this picture', replyTo: draft, after: 60_000 });
      expect(p.answer(photo)).toMatch(/office/i);
      expect(p.opened).toHaveLength(1);
    },
  },
  {
    id: 'S109', title: 'a PDF brief with a caption naming the organisation', kinds: ['pdf'],
    natural: 'The bot shows the text it read and asks if it is exact; "yes" opens one request with it.',
    async play(p) {
      const pdf = await p.pdf('KAAE Annual Conference\n15 November 2026, 9 am\nRotana Hotel, Erbil', { caption: 'poster from this for KAAE please' });
      expect(p.answer(pdf)).toMatch(/Is this exactly the text/i);
      await p.say('yes', { after: 60_000 });
      await p.wait(30_000);
      expect(p.opened).toHaveLength(1);
      expect(p.brief()).toContain('Rotana Hotel');
    },
  },
  {
    id: 'S110', title: 'a PDF, then a new unrelated brief before answering "is this the text?"', kinds: ['pdf', 'two-requests'],
    natural: 'The new brief is a brief of its own, not the PDF\'s confirmed words.',
    async play(p) {
      await p.pdf('KAAE Annual Conference\n15 November 2026, 9 am\nRotana Hotel, Erbil', { caption: 'poster from this for KAAE please' });
      await p.say('Also a poster for the KAAE staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium.', { after: 60_000 });
      await p.wait(60_000);
      expect(p.opened.map((o) => o.draft.rawText).join('\n')).toContain('football');
      expect(p.opened.map((o) => o.draft.rawText).join('\n')).not.toMatch(/Rotana Hotel[\s\S]*football|football[\s\S]*Rotana Hotel/);
    },
  },
  {
    id: 'S111', title: 'a PDF, then the corrected text instead of "yes"', kinds: ['pdf', 'correction'],
    natural: 'The corrected text is the brief.',
    async play(p) {
      await p.pdf('KAAE Annual Conference\n15 November 2026, 9 am\nRotana Hotel, Erbil', { caption: 'poster from this for KAAE please' });
      await p.say('KAAE Annual Conference\n16 November 2026, 9 am\nRotana Hotel, Erbil', { after: 60_000 });
      await p.wait(30_000);
      expect(p.opened).toHaveLength(1);
      expect(p.brief()).toContain('16 November');
    },
  },
  {
    id: 'S112', title: 'a voice note with the brief', kinds: ['voice'],
    natural: 'The bot shows what it heard (or says it could not, and asks for the words), never a format; a confirmed text opens one request.',
    async play(p) {
      const voice = await p.voice('KAAE members evening, 4 December 2026 at 7 pm, Erbil International Hotel');
      expect(p.answer(voice)).toMatch(/Which organisation/);
      const org = await p.say("it's for KAAE", { after: 30_000 });
      // Heard and shown back, or (transcription not allowed for this organisation) asked for in words.
      expect(p.answer(org)).toMatch(/Here is what I heard|type the words/);
      expect(p.words).not.toMatch(/Client:/);
    },
  },
  {
    id: 'S113', title: 'a Sorani voice note while a design waits for changes', kinds: ['voice', 'ckb', 'change'],
    natural: 'Kept for that design; never a question about commands or formats.',
    async play(p) {
      await p.say(KAAE_EVENING);
      await p.draftReady(0);
      await p.officeReplies('the logo is too small');
      // "Make the logo bigger"
      const voice = await p.voice('لۆگۆکە گەورەتر بکە', { after: 120_000 });
      expect(p.answer(voice)).not.toMatch(/\/new|reply to/i);
    },
  },
  {
    id: 'S114', title: 'a video with no words', kinds: ['video'],
    natural: 'A plain explanation that videos cannot go on a design, asking for a photo.',
    async play(p) {
      const video = await p.h.post(p.chatId, p.me, 'video', { video: { file_id: 'video-1', duration: 5, width: 640, height: 360, mime_type: 'video/mp4' } });
      expect(p.answer(video)).toMatch(/video/i);
    },
  },
  {
    id: 'S115', title: 'an SVG logo file while a design is being made', kinds: ['file', 'svg'],
    natural: 'Passed to the office for that design; never "send it again".',
    async play(p) {
      await p.say(KAAE_EVENING);
      const svg = await p.h.post(p.chatId, p.me, 'svg', { document: { file_id: 'logo-svg', file_name: 'logo.svg', mime_type: 'image/svg+xml', file_size: 2000 },
        caption: 'our logo' }, 60_000);
      expect(p.answer(svg)).toMatch(/office/i);
      expect(p.answer(svg)).not.toMatch(/send it again/i);
    },
  },
  {
    id: 'S116', title: 'editing the brief while it is still held for photos', kinds: ['edit'],
    natural: 'The new words are used.',
    async play(p) {
      const brief = await p.say(KAAE_EVENING);
      await p.edit(brief, KAAE_EVENING.replace('4 December', '5 December'), { after: 5_000 });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(p.brief()).toContain('5 December');
    },
  },
  {
    id: 'S117', title: 'editing the brief after it opened', kinds: ['edit'],
    natural: 'The new wording is passed to the office for that design; the requester is told so.',
    async play(p) {
      const brief = await p.say(KAAE_EVENING);
      const edited = await p.edit(brief, KAAE_EVENING.replace('4 December', '5 December'), { after: 2 * 60_000 });
      expect(p.answer(edited)).toMatch(/edit/i);
      expect(p.opened).toHaveLength(1);
    },
  },
  {
    id: 'S118', title: 'editing "thanks" into "thank you"', kinds: ['edit'],
    natural: 'Nothing changes, nothing is opened, and the thanks is not answered a second time.',
    async play(p) {
      await p.say(KAAE_EVENING);
      const thanks = await p.say('thanks', { after: 30_000 });
      const edited = await p.edit(thanks, 'thank you', { after: 10_000, quiet: true });
      expect(p.opened).toHaveLength(1);
      expect(p.kept).toHaveLength(0);
      expect(p.answer(edited)).toBe('');
    },
  },
  {
    id: 'S119', title: 'photos first, then a Sorani brief a minute later', kinds: ['photo', 'photos-first', 'ckb'],
    natural: 'One request with the photos and the words, answered in Sorani.',
    async play(p) {
      await p.album([21, 22]);
      // "Make a poster with these photos for KAAE's graduation, 12 October, Rotana hotel"
      await p.say('پۆستەرێک بەم وێنانە دروست بکە بۆ دەرچوونی KAAE، ١٢ی تشرینی یەکەم، هۆتێلی ڕۆتانا', { after: 60_000 });
      await p.wait(60_000);
      expect(p.opened).toHaveLength(1);
      expect(await p.h.photosOf(p.request(0))).toBe(2);
      expect(p.words).not.toMatch(NO_QUESTION);
    },
  },
];
