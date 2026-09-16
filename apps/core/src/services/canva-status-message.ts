import { escapeTelegramHtml } from '@hawa/integrations';

export interface CanvaStatusMessageInput {
  taskId: string;
  title?: string | null;
  /** Terminal workflow status reported by the worker, e.g. CANVA_DRAFT_READY_FOR_VISUAL_REVIEW. */
  status: string;
  /** Optional rejection code from Core, e.g. COPY_UNSUPPORTED or CLIENT_REFERENCE_REQUIRED. */
  code?: string;
  canvaUrl?: string;
  /** Honest caveats about this particular draft, e.g. a provisional Kurdish typeface. Plain text; escaped here. */
  notes?: string[];
}

export interface TelegramHtmlMessage {
  text: string;
  parse_mode: 'HTML';
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; url: string }>> };
}

const READY = new Set(['DRAFT_READY', 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW']);
const DRAFT_EXISTS_BUT_UNVERIFIED = new Set(['CANVA_CHECK_REQUIRED', 'CANVA_COPY_MISMATCH', 'CANVA_FONT_MISMATCH', 'CANVA_PREVIEW_FAILED']);

/**
 * Turns a worker outcome into an honest requester-facing Telegram message.
 * Pure function: no network, no database. Every branch states what actually happened and
 * what happens next; nothing claims a draft exists unless a Canva design ID was returned.
 */
export function composeCanvaStatusMessage(input: CanvaStatusMessageInput): TelegramHtmlMessage {
  const status = input.status.toUpperCase();
  const code = (input.code || '').toUpperCase();
  const header = (line: string) => `${line}\n\n📌 <b>Task ID:</b> <code>${escapeTelegramHtml(input.taskId)}</code>\n📜 <b>Title:</b> ${escapeTelegramHtml(input.title || 'Campaign Design')}\n\n`;
  const footer = `<i>Every design is reviewed by the art director in Hawa Desk before release.</i>`;
  const button = input.canvaUrl ? { inline_keyboard: [[{ text: '🎨 Open & Edit in Canva', url: input.canvaUrl }]] } : undefined;
  const link = input.canvaUrl ? `✏️ <b>Open in Canva:</b> ${escapeTelegramHtml(input.canvaUrl)}\n\n` : '';

  let body: string;
  let title: string;
  if (READY.has(status) && input.canvaUrl) {
    title = '🎨 <b>Your Canva draft is ready</b>';
    body = `${link}Review the layout, font and exact copy in Canva. Automatic copy and font checks passed.\n`;
  } else if (DRAFT_EXISTS_BUT_UNVERIFIED.has(status) && input.canvaUrl) {
    title = '🎨 <b>Your Canva draft was created, with a check to resolve</b>';
    const reason = status === 'CANVA_COPY_MISMATCH'
      ? 'the automatic check found that the copy in the draft differs from your text'
      : status === 'CANVA_FONT_MISMATCH'
        ? 'Canva substituted the brand font'
        : status === 'CANVA_PREVIEW_FAILED'
          ? 'the preview export could not be captured'
          : 'the automatic copy and font check could not be completed';
    body = `${link}The draft exists, but ${reason}. The art director will correct this in Canva before release.\n`;
  } else if (status === 'CLIENT_REQUIRED') {
    title = '📥 <b>Request saved, client assignment needed</b>';
    body = `No client could be identified from your message, so no automatic draft was started. The art director will assign the client in Hawa Desk and design it in Canva.\n`;
  } else if (status === 'MANUAL_DESIGN_REQUIRED') {
    title = '📥 <b>Request queued for manual design</b>';
    body = `This request has been queued in Hawa Desk. The art director will review the brief and create the design manually in Canva.\n`;
  } else if (status === 'DESIGN_REJECTED' && code === 'COPY_UNSUPPORTED') {
    title = '📥 <b>Request saved, manual design</b>';
    body = `Automatic drafting sets English and Sorani Kurdish copy. This request contains text it cannot set safely (another script, symbols or emoji), so it is saved exactly as sent and the art director will design it in Canva manually.\n`;
  } else if (status === 'DESIGN_REJECTED' && code === 'CLIENT_REFERENCE_REQUIRED') {
    title = '📥 <b>Request saved, manual design</b>';
    body = `Automatic drafting is available for clients with a verified brand reference pack only. Your request is saved and the art director will design it in Canva manually.\n`;
  } else if (status === 'DESIGN_REJECTED' && (code === 'CANVA_ALREADY_BOUND' || code === 'GENERATION_CONFLICT')) {
    title = '📥 <b>Request saved, a design already exists</b>';
    body = `${link}A Canva design is already linked to this task, so no second copy was created. The art director will continue from the existing design.\n`;
  } else if (status === 'DESIGN_UNCERTAIN') {
    title = '📥 <b>Request saved, draft not confirmed</b>';
    body = `The automatic draft could not be confirmed and will not be retried automatically to avoid a duplicate. The art director will check the result in Hawa Desk and finish it in Canva.\n`;
  } else {
    title = '📥 <b>Request saved, manual design</b>';
    body = `${link}The automatic Canva draft could not be produced${code ? ` (${escapeTelegramHtml(code)})` : ''}. Your request is saved and the art director will design it in Canva.\n`;
  }
  const notes = (input.notes || []).filter((n) => typeof n === 'string' && n.trim()).map((n) => `ℹ️ ${escapeTelegramHtml(n.trim())}\n`).join('');
  return { text: header(title) + body + (notes ? notes + '\n' : '') + footer, parse_mode: 'HTML', ...(button ? { reply_markup: button } : {}) };
}
