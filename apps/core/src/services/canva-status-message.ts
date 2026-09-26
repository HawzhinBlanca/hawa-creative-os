import { escapeTelegramHtml } from '@hawa/integrations';
import { requesterButtons, questionButtons, type InlineButton } from './requester-actions.js';

export interface CanvaStatusMessageInput {
  taskId: string;
  title?: string | null;
  /** Terminal workflow status reported by the worker, e.g. CANVA_DRAFT_READY_FOR_VISUAL_REVIEW. */
  status: string;
  /** Optional rejection code from Core, e.g. COPY_UNSUPPORTED or CLIENT_REFERENCE_REQUIRED. */
  code?: string;
  canvaUrl?: string;
  /** Server-built Desk link; navigation never records a decision. */
  reviewUrl?: string;
  /** Honest caveats about this particular draft, e.g. a provisional Kurdish typeface. Plain text; escaped here. */
  notes?: string[];
  /** What a change asked for that no edit of the design can make (code CHANGE_NOT_SUPPORTED). Plain text; escaped here. */
  notPossible?: Array<{ ask: string; reason?: string }>;
  /** The question asked before a change is made (code NEEDS_CLARIFICATION), with its answers. Plain text; escaped here. */
  question?: { question: string; options: string[] };
}

export interface TelegramHtmlMessage {
  text: string;
  parse_mode: 'HTML';
  reply_markup?: { inline_keyboard: InlineButton[][] };
}

const READY = new Set(['DRAFT_READY', 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW']);
const DRAFT_EXISTS_BUT_UNVERIFIED = new Set(['CANVA_CHECK_REQUIRED', 'CANVA_COPY_MISMATCH', 'CANVA_FONT_MISMATCH', 'CANVA_PREVIEW_FAILED']);
/** What happens next when no draft could be made: the task is marked for an operator in Hawa Desk. */
const ALERTED = 'The office has been alerted and will follow up with you here.';

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
  const canvaRow: InlineButton[][] = input.canvaUrl ? [[{ text: '🎨 Open & Edit in Canva', url: input.canvaUrl }]] : [];
  // A ready draft carries the requester's three buttons (requester-actions.ts): approve, change, a designer.
  const readyRows = READY.has(status) && input.canvaUrl ? requesterButtons(input.taskId) : [];
  const asking = code === 'NEEDS_CLARIFICATION' && input.question && input.question.question.trim() && input.question.options.length >= 2 ? input.question : undefined;
  const answerRows = asking ? questionButtons(input.taskId, asking.options) : [];
  const reviewRows: InlineButton[][] = input.reviewUrl ? [[{ text: 'Open review in Hawa Desk', url: input.reviewUrl }]] : [];
  const rows = [...canvaRow, ...readyRows, ...answerRows, ...reviewRows];
  const button = rows.length ? { inline_keyboard: rows } : undefined;
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
  } else if (status === 'DESIGN_REJECTED' && code === 'COPY_REQUIRED') {
    title = '📥 <b>Request saved, copy needed</b>';
    body = `No design copy was found in your request, so no automatic draft was started and no text was made up. Please send the exact text to put on the design, for example below a divider line (---) after your instructions.\n`;
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
  } else if (asking) {
    // Nothing was made or paid for: the change waits for the answer, and the previous draft stands.
    title = '❓ <b>One question before I make your change</b>';
    const asks = (input.notPossible || []).filter((a) => a && typeof a.ask === 'string' && a.ask.trim()).slice(0, 5);
    const list = asks
      .map((a) => `• ${escapeTelegramHtml(a.ask.trim())}${a.reason && a.reason.trim() ? ` (${escapeTelegramHtml(a.reason.trim().replace(/\.$/, ''))})` : ''}\n`)
      .join('');
    body =
      `${escapeTelegramHtml(asking.question.trim())}\n\n` +
      asking.options.slice(0, 3).map((o, i) => `${i + 1}. ${escapeTelegramHtml(o.trim())}\n`).join('') +
      `\nTap an answer below, or reply to this message in your own words. Everything else you asked for is made in the same draft.\n` +
      (asks.length ? `\nThis part cannot be done automatically yet, and the office has been told:\n${list}` : '');
  } else if (code === 'CHANGE_NOT_SUPPORTED') {
    // The run stopped before anything was paid for the edit: nothing it could do was asked for.
    title = '✋ <b>This change needs a designer</b>';
    const asks = (input.notPossible || []).filter((a) => a && typeof a.ask === 'string' && a.ask.trim()).slice(0, 5);
    const list = asks
      .map((a) => `• ${escapeTelegramHtml(a.ask.trim())}${a.reason && a.reason.trim() ? ` (${escapeTelegramHtml(a.reason.trim().replace(/\.$/, ''))})` : ''}\n`)
      .join('');
    body = `${asks.length ? `This cannot be done automatically yet:\n${list}\n` : 'The change you asked for cannot be done automatically yet.\n'}The office has been told, and a designer will make it. Your previous draft stays as it was, and you can still reply to it with any other change.\n`;
  } else if (status === 'DESIGN_BLOCKED') {
    title = '📥 <b>Your request is saved</b>';
    body = `A safety check stopped the automatic draft before anything reached you, so nothing unverified was sent. ${ALERTED}\n`;
  } else {
    // Every other ending (a failed or stuck run, a server error, a refused export). The code behind
    // it (HARD_QA_REFUSED, STUCK_IN_QA, HTTP_500 …) is for the task's history in Hawa Desk and the
    // logs; it used to be printed here, which told the requester nothing and read like a crash.
    title = '📥 <b>Your request is saved</b>';
    body = `${link}We could not make the automatic draft for this request. ${ALERTED}\n`;
  }
  // Notes describe a draft (its typeface, the studio run that made it). With no draft they are
  // internal detail: model names and scores of a run that produced nothing.
  const draftExists = Boolean(input.canvaUrl) && (READY.has(status) || DRAFT_EXISTS_BUT_UNVERIFIED.has(status));
  // A note that opens with its own sign (✅ done, ⚠️ not done) keeps it; any other gets ℹ️.
  const notes = (draftExists ? input.notes || [] : [])
    .filter((n) => typeof n === 'string' && n.trim())
    .map((n) => `${/^\p{Extended_Pictographic}/u.test(n.trim()) ? '' : 'ℹ️ '}${escapeTelegramHtml(n.trim())}\n`)
    .join('');
  const reviewLink = input.reviewUrl ? `\n\n<a href="${escapeTelegramHtml(input.reviewUrl)}">Open review in Hawa Desk</a> (office sign-in required)` : '';
  return { text: header(title) + body + (notes ? notes + '\n' : '') + footer + reviewLink, parse_mode: 'HTML', ...(button ? { reply_markup: button } : {}) };
}

/**
 * The office's alert that a requester asked for a change no edit of the design can make, so a
 * designer makes it. `draftSent` says whether the rest of the change went out as a new draft.
 */
export function composeChangeNeedsDesignerAlert(input: { taskId: string; title?: string | null; asks: Array<{ ask: string; reason?: string }>; draftSent: boolean }): TelegramHtmlMessage {
  const list = input.asks
    .filter((a) => a && typeof a.ask === 'string' && a.ask.trim())
    .slice(0, 5)
    .map((a) => `• ${escapeTelegramHtml(a.ask.trim())}${a.reason && a.reason.trim() ? ` (${escapeTelegramHtml(a.reason.trim().replace(/\.$/, ''))})` : ''}`)
    .join('\n');
  const after = input.draftSent
    ? 'The rest of the change went out as a new draft, now in Hawa Desk. Make the part above in Canva before approving it.'
    : 'Nothing was made; the requester was told a designer will do it, and their previous draft stands.';
  return {
    text:
      `✋ <b>A change needs a designer</b>\n\n📌 <b>Task ID:</b> <code>${escapeTelegramHtml(input.taskId)}</code>\n📜 <b>Title:</b> ${escapeTelegramHtml(input.title || 'Campaign Design')}\n\n` +
      `The requester asked for something the automatic editor cannot do yet:\n${list}\n\n${after}`,
    parse_mode: 'HTML',
  };
}
