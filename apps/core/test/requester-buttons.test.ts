import { describe, it, expect } from 'vitest';
import { composeCanvaStatusMessage } from '../src/services/canva-status-message.js';
import { requesterButtons, composeDesignerHandoff } from '../src/services/requester-actions.js';

/**
 * The requester stays with a design until they are happy with it (ADR-032 §2.4): under every draft,
 * Approve, Change something, Ask a designer. None of them approves the design itself; the art
 * director's approval in Hawa Desk still delivers (ADR-022).
 *
 * ADR-135 stage 2: no intake reads a press any more (the lifecycle answers every one as a stale
 * reply), so the cases that pressed the buttons through the legacy webhook went with it. The buttons
 * are still composed on Core's own Canva outcome message.
 */
const taskId = '00000000-0000-4000-c000-000000000001';

describe('the requester buttons', () => {
  it('ride on a ready draft only, with no Canva link (ADR-145: the requester is never sent an edit link)', () => {
    const ready = composeCanvaStatusMessage({ taskId, status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', canvaUrl: 'https://www.canva.com/design/DA_x/edit' });
    const rows = ready.reply_markup!.inline_keyboard;
    expect(JSON.stringify(rows)).not.toContain('canva.com');
    expect(rows.flat().map((b) => ('callback_data' in b ? b.callback_data : ''))).toEqual([`rq:ok:${taskId}`, `rq:chg:${taskId}`, `rq:dsg:${taskId}`]);
    for (const status of ['DESIGN_FAILED', 'CANVA_COPY_MISMATCH', 'MANUAL_DESIGN_REQUIRED']) {
      const msg = composeCanvaStatusMessage({ taskId, status, canvaUrl: 'https://www.canva.com/design/DA_x/edit' });
      expect(JSON.stringify(msg.reply_markup || {})).not.toContain('rq:');
    }
  });

  it('carry data that fits Telegram', () => {
    for (const b of requesterButtons(taskId).flat()) expect(Buffer.byteLength('callback_data' in b ? b.callback_data : '')).toBeLessThanOrEqual(64);
  });

  it('hand the office the history in plain words', () => {
    const handoff = composeDesignerHandoff({ taskId, title: 'KAAE <x>', asks: [{ ask: 'cut the panelists out', status: 'done' }, { ask: 'change the date', status: 'not_possible', reason: 'the text is fixed' }], rounds: 3, why: 'rounds' });
    expect(handoff.text).toContain('Round 3 of changes');
    expect(handoff.text).toContain('✅ cut the panelists out');
    expect(handoff.text).toContain('❌ change the date (the text is fixed)');
    expect(handoff.text).toContain('KAAE &lt;x&gt;');
  });
});
