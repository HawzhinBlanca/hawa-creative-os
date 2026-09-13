import { describe, it, expect } from 'vitest';
import { composeCanvaStatusMessage } from '../src/services/canva-status-message.js';

const taskId = '00000000-0000-4000-c000-000000000001';

describe('requester-facing Canva outcome messages', () => {
  it('sends the Canva link only when a design actually exists', () => {
    const ready = composeCanvaStatusMessage({ taskId, title: 'Invitation', status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', canvaUrl: 'https://www.canva.com/design/DA_x/edit' });
    expect(ready.text).toContain('draft is ready');
    expect(ready.reply_markup?.inline_keyboard[0][0].url).toBe('https://www.canva.com/design/DA_x/edit');
    const noDesign = composeCanvaStatusMessage({ taskId, title: 'Invitation', status: 'DRAFT_READY' });
    expect(noDesign.text).not.toContain('draft is ready');
    expect(noDesign.reply_markup).toBeUndefined();
  });
  it('tells the truth about each rejection reason instead of a generic "queued"', () => {
    expect(composeCanvaStatusMessage({ taskId, status: 'DESIGN_REJECTED', code: 'COPY_UNSUPPORTED' }).text).toContain('English copy only');
    expect(composeCanvaStatusMessage({ taskId, status: 'DESIGN_REJECTED', code: 'CLIENT_REFERENCE_REQUIRED' }).text).toContain('verified brand reference');
    expect(composeCanvaStatusMessage({ taskId, status: 'CLIENT_REQUIRED' }).text).toContain('No client could be identified');
    expect(composeCanvaStatusMessage({ taskId, status: 'DESIGN_UNCERTAIN' }).text).toContain('will not be retried automatically');
    expect(composeCanvaStatusMessage({ taskId, status: 'CANVA_FONT_MISMATCH', canvaUrl: 'https://www.canva.com/design/DA_x/edit' }).text).toContain('substituted the brand font');
    expect(composeCanvaStatusMessage({ taskId, status: 'CANVA_PREVIEW_FAILED', canvaUrl: 'https://www.canva.com/design/DA_x/edit' }).text).toContain('preview export could not be captured');
  });
  it('escapes user-controlled text so Telegram never rejects the message', () => {
    const msg = composeCanvaStatusMessage({ taskId, title: 'A <b>bold</b> & "quoted" title', status: 'DESIGN_FAILED', code: 'MODEL_HTTP_500' });
    expect(msg.parse_mode).toBe('HTML');
    expect(msg.text).toContain('A &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot; title');
    expect(msg.text).not.toContain('<b>bold</b>');
  });
});
