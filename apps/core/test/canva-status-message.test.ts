import { describe, it, expect } from 'vitest';
import { composeCanvaStatusMessage, officeDayExhaustedNote } from '../src/services/canva-status-message.js';

const taskId = '00000000-0000-4000-c000-000000000001';

/** ADR-145: nothing of the office's reaches the requester (the task id, a Desk or Canva link, check names). */
const OFFICE_WORDS = /Task ID|Hawa Desk|\bDesk\b|Canva|art director|reference pack|---|reply to|https?:\/\//i;

describe('requester-facing Canva outcome messages', () => {
  it('says a draft is ready only when a design actually exists, and never shows its Canva link (ADR-145)', () => {
    const ready = composeCanvaStatusMessage({ taskId, title: 'Invitation', status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', canvaUrl: 'https://www.canva.com/design/DA_x/edit' });
    expect(ready.text).toContain('Your draft of <b>Invitation</b> is ready');
    expect(ready.text).not.toMatch(OFFICE_WORDS);
    expect(JSON.stringify(ready.reply_markup)).not.toContain('canva.com');
    const noDesign = composeCanvaStatusMessage({ taskId, title: 'Invitation', status: 'DRAFT_READY' });
    expect(noDesign.text).not.toContain('is ready');
    expect(noDesign.reply_markup).toBeUndefined();
  });
  it('tells the truth about each rejection reason, in plain words (ADR-145 #19-#26)', () => {
    const say = (status: string, code?: string, canvaUrl?: string) => composeCanvaStatusMessage({ taskId, title: 'Poster', status, code, canvaUrl }).text;
    expect(say('DESIGN_REJECTED', 'COPY_UNSUPPORTED')).toBe('A designer will set the text of <b>Poster</b> by hand and send it to you here.');
    // No text was made up: the words to print are asked for, with no format to follow.
    expect(say('DESIGN_REJECTED', 'COPY_REQUIRED')).toBe('What text should go on <b>Poster</b>? Send it just as you would like it to read.');
    expect(say('DESIGN_REJECTED', 'CLIENT_REFERENCE_REQUIRED')).toBe('A designer will make <b>Poster</b> and send it to you here.');
    expect(say('CLIENT_REQUIRED')).toContain("I couldn't tell which organisation <b>Poster</b> is for");
    expect(say('MANUAL_DESIGN_REQUIRED')).toBe('A designer will make <b>Poster</b> and send it to you here.');
    expect(say('DESIGN_REJECTED', 'NATIVE_REVISION_HANDOFF_REQUIRED')).toContain('make this change to <b>Poster</b> by hand');
    expect(say('DESIGN_REJECTED', 'CANVA_ALREADY_BOUND', 'https://www.canva.com/design/DA_x/edit')).toBe("<b>Poster</b> is already being worked on; you'll get it here.");
    expect(say('DESIGN_UNCERTAIN')).toBe('The office is checking the draft of <b>Poster</b> and will send it to you here.');
    for (const status of ['CANVA_FONT_MISMATCH', 'CANVA_PREVIEW_FAILED', 'CANVA_COPY_MISMATCH', 'CANVA_CHECK_REQUIRED']) {
      // Which check failed is the office's to know.
      expect(say(status, undefined, 'https://www.canva.com/design/DA_x/edit')).toBe('Your draft of <b>Poster</b> is made; the office is fixing a small detail before you get it.');
    }
    for (const [status, code] of [['DESIGN_REJECTED', 'COPY_UNSUPPORTED'], ['DESIGN_REJECTED', 'COPY_REQUIRED'], ['DESIGN_REJECTED', 'CLIENT_REFERENCE_REQUIRED'],
      ['CLIENT_REQUIRED', undefined], ['MANUAL_DESIGN_REQUIRED', undefined], ['DESIGN_UNCERTAIN', undefined]] as const) {
      expect(say(status, code)).not.toMatch(OFFICE_WORDS);
    }
  });
  it('explains a failed run in plain words and says what happens next, never with an internal code', () => {
    for (const [status, code] of [['DESIGN_FAILED', 'HARD_QA_REFUSED'], ['DESIGN_STUCK', 'STUCK_IN_QA'], ['DESIGN_SERVER_ERROR', 'HTTP_500'], ['CANVA_PREVIEW_RETRIEVED_LATE', undefined]] as const) {
      const msg = composeCanvaStatusMessage({
        taskId, title: 'Invitation', status, code,
        notes: ['Studio v3 · models: gpt-6-astra · 3 concepts · layout score 0.41/1'],
      });
      expect(msg.text).toBe('The office will finish <b>Invitation</b> and send it to you here.');
      if (code) expect(msg.text).not.toContain(code);
      // Model names and scores of a run that made nothing are internal detail.
      expect(msg.text).not.toContain('Studio v3');
      expect(msg.text).not.toMatch(/\([A-Z0-9_]{4,}\)/);
    }
  });
  it('tells the requester a design that stopped on the run limit needs more time and nothing more from them (ADR-142)', () => {
    const msg = composeCanvaStatusMessage({ taskId, title: 'KAAE: KAAE K-12 Pilot Study', status: 'DESIGN_FAILED', code: 'STUDIO_RUN_LIMIT_TOO_SMALL' });
    expect(msg.text).toBe("<b>KAAE K-12 Pilot Study</b> needs a little more time. The office is on it and will send your draft here; you don't need to send anything again.");
    expect(msg.text).not.toMatch(OFFICE_WORDS);
    expect(msg.text).not.toMatch(/limit|budget|STUDIO_/i);
    expect(composeCanvaStatusMessage({ taskId, title: 'ڕاپۆرت', status: 'DESIGN_FAILED', code: 'STUDIO_RUN_LIMIT_TOO_SMALL', lang: 'ckb' }).text)
      .toBe('<b>ڕاپۆرت</b> کەمێک کاتی زیاتری پێویستە. ئۆفیسەکە کاری لەسەر دەکات و ڕەشنووسەکەت لێرە بۆت دەنێرێت؛ پێویست ناکات هیچ شتێک دووبارە بنێریتەوە.');
    // With no office chat to alert, nobody would run it again: the requester hears the follow-up line instead.
    expect(composeCanvaStatusMessage({ taskId, title: 'Report', status: 'DESIGN_FAILED', code: 'STUDIO_RUN_LIMIT_TOO_SMALL', officeAlerted: false }).text)
      .toBe('Someone from the office will follow up here.');
  });
  it('tells the requester a design stopped by the office day needs more time, and the office when it resets (ADR-159)', () => {
    const msg = composeCanvaStatusMessage({ taskId, title: 'Report', status: 'DESIGN_FAILED', code: 'OFFICE_DAY_EXHAUSTED' });
    expect(msg.text).toBe("<b>Report</b> needs a little more time. The office is on it and will send your draft here; you don't need to send anything again.");
    expect(msg.text).not.toMatch(/limit|budget|allowance|QA|OFFICE_/i);
    const note = officeDayExhaustedNote(Date.parse('2026-09-30T08:00:00Z'));
    expect(note).toContain("daily model allowance is used up and nothing was sent for this design");
    expect(note).toContain('resets at midnight Baghdad time (2026-09-30 21:00 UTC)');
    expect(note).not.toMatch(/hard QA|candidates/i);
  });
  it('says someone will follow up when there is no office chat to alert (#15)', () => {
    expect(composeCanvaStatusMessage({ taskId, title: 'Invitation', status: 'DESIGN_FAILED', officeAlerted: false }).text)
      .toBe('Someone from the office will follow up here.');
  });
  it('explains a safety stop without naming the check', () => {
    for (const code of ['SCOPE_MISMATCH', 'BINDING_MISMATCH']) {
      const msg = composeCanvaStatusMessage({ taskId, status: 'DESIGN_BLOCKED', code });
      expect(msg.text).toBe('The office will finish your design and send it to you here.');
      expect(msg.text).not.toContain(code);
      expect(msg.reply_markup).toBeUndefined();
    }
  });
  it('answers in the language of the brief: Sorani when the brief is written mostly in Arabic script (ADR-145)', () => {
    const msg = composeCanvaStatusMessage({ taskId, title: 'KAAE: Nawroz', briefText: 'پۆستەرێک بۆ نەورۆز دروست بکە بۆ KAAE', status: 'DESIGN_FAILED' });
    expect(msg.text).toBe('ئۆفیسەکە <b>Nawroz</b> تەواو دەکات و لێرە بۆت دەنێرێت.');
    expect(composeCanvaStatusMessage({ taskId, title: 'نەورۆز', status: 'DESIGN_BLOCKED', lang: 'en' }).text).toContain('The office will finish');
  });
  it('escapes user-controlled text so Telegram never rejects the message', () => {
    const msg = composeCanvaStatusMessage({ taskId, title: 'A <b>bold</b> & "quoted" title', status: 'DESIGN_FAILED', code: 'MODEL_HTTP_500' });
    expect(msg.parse_mode).toBe('HTML');
    expect(msg.text).toContain('A &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot; title');
    expect(msg.text).not.toContain('<b>bold</b>');
  });
});

describe('draft caveats', () => {
  it('appends escaped notes after the message and never claims more than the status', () => {
    const msg = composeCanvaStatusMessage({ taskId: '00000000-0000-4000-8000-000000000001', title: 'Sorani test', status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', canvaUrl: 'https://www.canva.com/design/DAHVHsEGaLc/edit',
      notes: ["Kurdish text is set in a provisional typeface (Noto Sans Arabic) until the brand's Kurdish font is confirmed <by> the art director."] });
    expect(msg.text).toContain('ℹ️ Kurdish text is set in a provisional typeface (Noto Sans Arabic)');
    expect(msg.text).toContain('&lt;by&gt;');
    expect(msg.text.indexOf('ℹ️')).toBeGreaterThan(msg.text.indexOf('is ready'));
    expect(composeCanvaStatusMessage({ taskId: '00000000-0000-4000-8000-000000000001', status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', notes: [] }).text).not.toContain('ℹ️');
  });

  it('renders Studio v2 notes line and matches snapshot format', () => {
    const studioNote = 'Studio v2 · 5 concepts · 2 revision rounds · judge 8.7/10 · imagery: generated (SynthID) · typeface: Cinzel, Playfair Display';
    const msg = composeCanvaStatusMessage({
      taskId: '00000000-0000-4000-8000-000000000001',
      title: 'Studio Gala Invitation',
      status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW',
      canvaUrl: 'https://www.canva.com/design/DA_studio_winner/edit',
      notes: [studioNote],
    });

    expect(msg.text).toContain('ℹ️ Studio v2 · 5 concepts · 2 revision rounds · judge 8.7/10 · imagery: generated (SynthID) · typeface: Cinzel, Playfair Display');
    expect(msg.text).toContain('Cinzel, Playfair Display');
  });
});
