import { LIFECYCLE_MESSAGES, OUTCOME_MESSAGES, escapeTelegramHtml, requesterLang, say, type Phrase, type RequesterLang } from '@hawa/integrations';
import { requesterButtons, questionButtons, type InlineButton } from './requester-actions.js';
import { designName, shortTitle } from './requester-turn.js';
import { nextOfficeDayStart } from '@hawa/domain';

/**
 * The office's alert line for a design stopped by the shared daily allowance (ADR-159): what stopped
 * it, that nothing was sent, and when the office day resets (midnight in Baghdad).
 */
export function officeDayExhaustedNote(now: number = Date.now()): string {
  const reset = nextOfficeDayStart(now).toISOString().slice(0, 16).replace('T', ' ');
  return ` The office's daily model allowance is used up and nothing was sent for this design. It resets at midnight ` +
    `Baghdad time (${reset} UTC); retry the design then, or raise the daily limit in the spending policy.`;
}

/**
 * ADR-233: the office's alert for a request-owned design that ended without a draft. It read
 * "Automatic design needs an operator in Hawa Desk. Task cdfadbf0-…: DESIGN_REJECTED
 * (NATIVE_REVISION_HANDOFF_REQUIRED)." (live test L13), and reached the requester's chat as well when
 * the requester is an office member. In ADR-231's style: who and which design, what happened and what
 * to do in plain sentences, and the task's short id on one last line for the Desk's search. The code
 * stays in the task's history in the Desk. Plain text (no parse mode).
 */
export function composeNoDraftOfficeAlert(input: { taskId: string; title: string; requester?: string | null; status: string; code?: string;
  now?: number }): string {
  const who = input.requester?.trim() ? Array.from(input.requester.trim()).slice(0, 60).join('') : 'the requester';
  const design = `"${shortTitle(input.title)}"`;
  const code = (input.code || '').toUpperCase();
  const body = code === 'NATIVE_REVISION_HANDOFF_REQUIRED'
    ? `The change ${who} asked for on ${design} has to be made by hand: the automatic studio does not edit a design that someone may have changed in Canva. ` +
      'Open it in Hawa Desk, make the change on a copy of the Canva design, confirm its words and send it for review.'
    : code === 'OFFICE_DAY_EXHAUSTED'
      ? `The automatic design of ${design} for ${who} did not start.${officeDayExhaustedNote(input.now)}`
      : code === 'STUDIO_RUN_LIMIT_TOO_SMALL'
        ? `The automatic design of ${design} for ${who} stopped before it made a draft: its next step needs more than one design may spend. ` +
          'Raise the per-design limit and retry it from Hawa Desk, or make it by hand.'
        : input.status === 'DESIGN_UNCERTAIN'
          ? `The automatic design of ${design} for ${who} may or may not have made a draft. Check it in Hawa Desk before retrying, so it is not made twice.`
          : `The automatic design of ${design} for ${who} stopped without a draft. Open it in Hawa Desk to see why, then retry it or make it by hand.`;
  return [body, '', `Desk search: ${input.taskId.slice(0, 8)}`].join('\n');
}

export interface CanvaStatusMessageInput {
  taskId: string;
  title?: string | null;
  /** Terminal workflow status reported by the worker, e.g. CANVA_DRAFT_READY_FOR_VISUAL_REVIEW. */
  status: string;
  /** Optional rejection code from Core, e.g. COPY_UNSUPPORTED or CLIENT_REFERENCE_REQUIRED. */
  code?: string;
  /** The draft's Canva link: its presence says a draft exists. The requester is never shown it (ADR-145). */
  canvaUrl?: string;
  /** Server-built Desk link, for the office's own alerts; the requester is never shown it (ADR-145). */
  reviewUrl?: string;
  /** Honest caveats about this particular draft, e.g. a provisional Kurdish typeface. Plain text; escaped here. */
  notes?: string[];
  /** What a change asked for that no edit of the design can make (code CHANGE_NOT_SUPPORTED). Plain text; escaped here. */
  notPossible?: Array<{ ask: string; reason?: string }>;
  /** The question asked before a change is made (code NEEDS_CLARIFICATION), with its answers. Plain text; escaped here. */
  question?: { question: string; options: string[] };
  /** The language to answer in; without it, the brief's own words decide (requesterLang), then the title. */
  lang?: RequesterLang;
  /** The request's own words (the task's description), which decide the language when `lang` is not given. */
  briefText?: string | null;
  /**
   * Whether the office was alerted about an outcome that needs a person (default true). Without an
   * office chat to alert, the requester hears that someone will follow up instead of that the office
   * will finish it.
   */
  officeAlerted?: boolean;
}

export interface TelegramHtmlMessage {
  text: string;
  parse_mode: 'HTML';
  reply_markup?: { inline_keyboard: InlineButton[][] };
}

const READY = new Set(['DRAFT_READY', 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW']);
const DRAFT_EXISTS_BUT_UNVERIFIED = new Set(['CANVA_CHECK_REQUIRED', 'CANVA_COPY_MISMATCH', 'CANVA_FONT_MISMATCH', 'CANVA_PREVIEW_FAILED']);

/** "• ask (reason)" lines, escaped. */
const askLines = (asks: Array<{ ask: string; reason?: string }>) => asks
  .map((a) => `• ${escapeTelegramHtml(a.ask.trim())}${a.reason && a.reason.trim() ? ` (${escapeTelegramHtml(a.reason.trim().replace(/\.$/, ''))})` : ''}`)
  .join('\n');

/**
 * Turns a worker outcome into an honest requester-facing Telegram message.
 * Pure function: no network, no database. Every branch states what actually happened and
 * what happens next; nothing claims a draft exists unless a Canva design ID was returned.
 *
 * ADR-145: the requester hears it in their own language and in plain words: the design's name, what
 * happens next, and nothing of the office's (no task id, no review or Canva link, no check or code
 * names, no reviewer's title). Every caller sends it to the requester's chat.
 */
export function composeCanvaStatusMessage(input: CanvaStatusMessageInput): TelegramHtmlMessage {
  const status = input.status.toUpperCase();
  const code = (input.code || '').toUpperCase();
  const lang = input.lang ?? requesterLang(input.briefText || input.title || '', 'en');
  const title = designName(input.title, lang);
  const line = (phrase: Phrase, params: Record<string, string> = {}) => say(phrase, lang, { title, ...params });
  // A ready draft carries the requester's three buttons (requester-actions.ts): approve, change, a designer.
  const readyRows = READY.has(status) && input.canvaUrl ? requesterButtons(input.taskId) : [];
  const asking = code === 'NEEDS_CLARIFICATION' && input.question && input.question.question.trim() && input.question.options.length >= 2 ? input.question : undefined;
  const answerRows = asking ? questionButtons(input.taskId, asking.options) : [];
  const rows = [...readyRows, ...answerRows];
  const button = rows.length ? { inline_keyboard: rows } : undefined;
  const asks = (input.notPossible || []).filter((a) => a && typeof a.ask === 'string' && a.ask.trim()).slice(0, 5);
  const officeFinishes = () => (input.officeAlerted === false ? say(LIFECYCLE_MESSAGES.officeWillFollowUp, lang) : line(OUTCOME_MESSAGES.officeWillFinish));

  let body: string;
  if (READY.has(status) && input.canvaUrl) {
    body = line(OUTCOME_MESSAGES.draftReady);
  } else if (DRAFT_EXISTS_BUT_UNVERIFIED.has(status) && input.canvaUrl) {
    // Which check (the copy, the font, the preview) is the office's to know; the Desk shows it.
    body = line(OUTCOME_MESSAGES.draftBeingFixed);
  } else if (status === 'CLIENT_REQUIRED') {
    body = line(OUTCOME_MESSAGES.organisationUnknown);
  } else if (status === 'MANUAL_DESIGN_REQUIRED') {
    body = line(OUTCOME_MESSAGES.designerMakes);
  } else if (code === 'NATIVE_REVISION_HANDOFF_REQUIRED') {
    body = line(OUTCOME_MESSAGES.designerMakesChange);
  } else if (status === 'DESIGN_REJECTED' && code === 'COPY_REQUIRED') {
    // No text was made up: the words to print are asked for.
    body = line(OUTCOME_MESSAGES.textNeeded);
  } else if (status === 'DESIGN_REJECTED' && code === 'COPY_UNSUPPORTED') {
    body = line(OUTCOME_MESSAGES.designerSetsText);
  } else if (status === 'DESIGN_REJECTED' && code === 'CLIENT_REFERENCE_REQUIRED') {
    body = line(OUTCOME_MESSAGES.designerMakes);
  } else if (status === 'DESIGN_REJECTED' && (code === 'CANVA_ALREADY_BOUND' || code === 'GENERATION_CONFLICT')) {
    body = line(OUTCOME_MESSAGES.alreadyInProgress);
  } else if (status === 'DESIGN_UNCERTAIN') {
    // Not retried automatically, to avoid a duplicate: the office checks the result.
    body = line(OUTCOME_MESSAGES.officeCheckingDraft);
  } else if (asking) {
    // Nothing was made or paid for: the change waits for the answer, and the previous draft stands.
    body = line(OUTCOME_MESSAGES.questionWithButtons, {
      question: `<b>${escapeTelegramHtml(asking.question.trim())}</b>`,
      options: asking.options.slice(0, 3).map((o, i) => `${i + 1}. ${escapeTelegramHtml(o.trim())}`).join('\n'),
    }) + (asks.length ? `\n\n${line(OUTCOME_MESSAGES.designerMakesPart, { list: askLines(asks) })}` : '');
  } else if ((code === 'STUDIO_RUN_LIMIT_TOO_SMALL' || code === 'OFFICE_DAY_EXHAUSTED') && input.officeAlerted !== false) {
    // ADR-142: nothing was made and nothing is wrong with the request; the office runs it again. So
    // for the office's daily allowance (ADR-159): the office runs it once the day resets.
    body = line(OUTCOME_MESSAGES.designTakingLonger);
  } else if (code === 'CHANGE_NOT_SUPPORTED') {
    // The run stopped before anything was paid for the edit: nothing it could do was asked for.
    body = asks.length ? line(OUTCOME_MESSAGES.changeByDesignerList, { list: askLines(asks) }) : line(OUTCOME_MESSAGES.changeByDesigner);
  } else {
    // A safety stop (DESIGN_BLOCKED) and every other ending (a failed or stuck run, a server error, a
    // refused export). The code behind it (HARD_QA_REFUSED, STUCK_IN_QA, HTTP_500 …) is for the
    // task's history in the Desk and the logs; printed here, it told the requester nothing and read
    // like a crash.
    body = officeFinishes();
  }
  // Notes describe a draft (its typeface, the studio run that made it). With no draft they are
  // internal detail: model names and scores of a run that produced nothing.
  const draftExists = Boolean(input.canvaUrl) && (READY.has(status) || DRAFT_EXISTS_BUT_UNVERIFIED.has(status));
  // A note that opens with its own sign (✅ done, ⚠️ not done) keeps it; any other gets ℹ️.
  const notes = (draftExists ? input.notes || [] : [])
    .filter((n) => typeof n === 'string' && n.trim())
    .map((n) => `${/^\p{Extended_Pictographic}/u.test(n.trim()) ? '' : 'ℹ️ '}${escapeTelegramHtml(n.trim())}\n`)
    .join('');
  return { text: body + (notes ? `\n\n${notes}`.replace(/\n$/, '') : ''), parse_mode: 'HTML', ...(button ? { reply_markup: button } : {}) };
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
