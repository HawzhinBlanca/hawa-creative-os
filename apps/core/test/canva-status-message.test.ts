import { describe, it, expect } from 'vitest';
import { composeCanvaStatusMessage } from '../src/services/canva-status-message.js';

const taskId = '00000000-0000-4000-c000-000000000001';

describe('requester-facing Canva outcome messages', () => {
  it('sends the Canva link only when a design actually exists', () => {
    const ready = composeCanvaStatusMessage({ taskId, title: 'Invitation', status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', canvaUrl: 'https://www.canva.com/design/DA_x/edit' });
    expect(ready.text).toContain('draft is ready');
    expect(ready.reply_markup?.inline_keyboard[0][0]).toMatchObject({ url: 'https://www.canva.com/design/DA_x/edit' });
    const noDesign = composeCanvaStatusMessage({ taskId, title: 'Invitation', status: 'DRAFT_READY' });
    expect(noDesign.text).not.toContain('draft is ready');
    expect(noDesign.reply_markup).toBeUndefined();
  });
  it('tells the truth about each rejection reason instead of a generic "queued"', () => {
    expect(composeCanvaStatusMessage({ taskId, status: 'DESIGN_REJECTED', code: 'COPY_UNSUPPORTED' }).text).toContain('English and Sorani Kurdish');
    const noCopy = composeCanvaStatusMessage({ taskId, status: 'DESIGN_REJECTED', code: 'COPY_REQUIRED' }).text;
    expect(noCopy).toContain('No design copy was found');
    expect(noCopy).toContain('send the exact text');
    expect(noCopy).not.toMatch(/another script|emoji|could not be produced/);
    expect(composeCanvaStatusMessage({ taskId, status: 'DESIGN_REJECTED', code: 'CLIENT_REFERENCE_REQUIRED' }).text).toContain('verified brand reference');
    expect(composeCanvaStatusMessage({ taskId, status: 'CLIENT_REQUIRED' }).text).toContain('No client could be identified');
    expect(composeCanvaStatusMessage({ taskId, status: 'MANUAL_DESIGN_REQUIRED' }).text).toContain('queued in Hawa Desk');
    expect(composeCanvaStatusMessage({ taskId, status: 'DESIGN_UNCERTAIN' }).text).toContain('will not be retried automatically');
    expect(composeCanvaStatusMessage({ taskId, status: 'CANVA_FONT_MISMATCH', canvaUrl: 'https://www.canva.com/design/DA_x/edit' }).text).toContain('substituted the brand font');
    expect(composeCanvaStatusMessage({ taskId, status: 'CANVA_PREVIEW_FAILED', canvaUrl: 'https://www.canva.com/design/DA_x/edit' }).text).toContain('preview export could not be captured');
  });
  it('explains a failed run in plain words and says what happens next, never with an internal code', () => {
    for (const [status, code] of [['DESIGN_FAILED', 'HARD_QA_REFUSED'], ['DESIGN_STUCK', 'STUCK_IN_QA'], ['DESIGN_SERVER_ERROR', 'HTTP_500'], ['CANVA_PREVIEW_RETRIEVED_LATE', undefined]] as const) {
      const msg = composeCanvaStatusMessage({
        taskId, title: 'Invitation', status, code,
        notes: ['Studio v3 · models: gpt-6-astra · 3 concepts · layout score 0.41/1'],
      });
      expect(msg.text).toContain('We could not make the automatic draft for this request.');
      expect(msg.text).toContain('The office has been alerted and will follow up with you here.');
      if (code) expect(msg.text).not.toContain(code);
      // Model names and scores of a run that made nothing are internal detail.
      expect(msg.text).not.toContain('Studio v3');
      expect(msg.text).not.toMatch(/\([A-Z0-9_]{4,}\)/);
    }
  });
  it('explains a safety stop without naming the check', () => {
    for (const code of ['SCOPE_MISMATCH', 'BINDING_MISMATCH']) {
      const msg = composeCanvaStatusMessage({ taskId, status: 'DESIGN_BLOCKED', code });
      expect(msg.text).toContain('A safety check stopped the automatic draft');
      expect(msg.text).toContain('The office has been alerted');
      expect(msg.text).not.toContain(code);
      expect(msg.reply_markup).toBeUndefined();
    }
  });
  it('escapes user-controlled text so Telegram never rejects the message', () => {
    const msg = composeCanvaStatusMessage({ taskId, title: 'A <b>bold</b> & "quoted" title', status: 'DESIGN_FAILED', code: 'MODEL_HTTP_500' });
    expect(msg.parse_mode).toBe('HTML');
    expect(msg.text).toContain('A &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot; title');
    expect(msg.text).not.toContain('<b>bold</b>');
  });
});

describe('draft caveats', () => {
  it('appends escaped notes before the footer and never claims more than the status', () => {
    const msg = composeCanvaStatusMessage({ taskId: '00000000-0000-4000-8000-000000000001', title: 'Sorani test', status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', canvaUrl: 'https://www.canva.com/design/DAHVHsEGaLc/edit',
      notes: ["Kurdish text is set in a provisional typeface (Noto Sans Arabic) until the brand's Kurdish font is confirmed <by> the art director."] });
    expect(msg.text).toContain('ℹ️ Kurdish text is set in a provisional typeface (Noto Sans Arabic)');
    expect(msg.text).toContain('&lt;by&gt;');
    expect(msg.text.indexOf('ℹ️')).toBeLessThan(msg.text.indexOf('Every design is reviewed'));
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

