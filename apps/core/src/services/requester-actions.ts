import { escapeTelegramHtml } from '@hawa/integrations';

/**
 * The requester's side of a draft (ADR-032 §2.4): three buttons under every draft they receive.
 *
 * - Approve records that the requester is happy with the draft and tells the office. It does not
 *   approve the design: the art director's approval in Hawa Desk still gates delivery (ADR-022).
 * - Change something asks for the change as a reply, so it reaches this design.
 * - Ask a designer hands the design to the office's designer, with what was asked so far.
 *
 * `rq:<action>:<task id>` fits Telegram's 64-byte callback data.
 */
export type RequesterAction = 'ok' | 'chg' | 'dsg';

const DATA = /^rq:(ok|chg|dsg):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function parseRequesterAction(data: unknown): { action: RequesterAction; taskId: string } | null {
  const m = String(data ?? '').match(DATA);
  return m ? { action: m[1].toLowerCase() as RequesterAction, taskId: m[2].toLowerCase() } : null;
}

export type InlineButton = { text: string; url: string } | { text: string; callback_data: string };

export function requesterButtons(taskId: string): InlineButton[][] {
  return [
    [
      { text: '✅ Approve design', callback_data: `rq:ok:${taskId}` },
      { text: '✏️ Change something', callback_data: `rq:chg:${taskId}` },
    ],
    [{ text: '🧑‍🎨 Ask a designer', callback_data: `rq:dsg:${taskId}` }],
  ];
}

export interface TelegramReply {
  text: string;
  parse_mode: 'HTML';
  reply_markup?: { force_reply: true; input_field_placeholder?: string };
}

const taskLine = (taskId: string, title?: string | null) =>
  `📌 <b>Task ID:</b> <code>${escapeTelegramHtml(taskId)}</code>\n📜 <b>Title:</b> ${escapeTelegramHtml(title || 'Campaign Design')}\n`;

/** To the requester, after Approve. */
export function composeRequesterApproved(taskId: string): TelegramReply {
  return {
    text:
      `✅ <b>Thank you, you approved this design.</b>\n\n` +
      `The art director does a final check in Hawa Desk and the final files come to this chat.\n\n` +
      `🆔 Task ID: <code>${escapeTelegramHtml(taskId)}</code>`,
    parse_mode: 'HTML',
  };
}

/** To the requester, after Change something: a reply to this message reaches this design. */
export function composeChangePrompt(taskId: string): TelegramReply {
  return {
    text:
      `✏️ <b>What should change?</b>\n\n` +
      `Reply to this message with everything you want changed. Several changes in one message is fine, and ` +
      `you can attach a picture with them.\n\n🆔 Task ID: <code>${escapeTelegramHtml(taskId)}</code>`,
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: 'For example: make the title bigger' },
  };
}

/** To the requester, after Ask a designer. */
export function composeDesignerTakesOver(taskId: string): TelegramReply {
  return {
    text:
      `🧑‍🎨 <b>A designer from the office takes over this design.</b>\n\n` +
      `They have everything you asked for so far and will reply to you here. You do not need to send it again.\n\n` +
      `🆔 Task ID: <code>${escapeTelegramHtml(taskId)}</code>`,
    parse_mode: 'HTML',
  };
}

/** To the requester, when the button is on a draft that a newer one replaced. */
export function composeReplacedDraft(newerTaskId: string): TelegramReply {
  return {
    text:
      `ℹ️ <b>A newer version of this design exists.</b>\n\n` +
      `Use the buttons on the newest draft.\n\n🆔 Newest Task ID: <code>${escapeTelegramHtml(newerTaskId)}</code>`,
    parse_mode: 'HTML',
  };
}

export interface AskRecord {
  ask: string;
  status: string;
  reason?: string;
}

const askLines = (asks: AskRecord[]) =>
  asks
    .slice(-12)
    .map((a) => {
      const sign = a.status === 'done' ? '✅' : a.status === 'not_possible' ? '❌' : '⚠️';
      return `${sign} ${escapeTelegramHtml(a.ask)}${a.reason ? ` (${escapeTelegramHtml(a.reason)})` : ''}`;
    })
    .join('\n');

/** To the office, after the requester approved a draft. */
export function composeRequesterApprovedAlert(input: { taskId: string; title?: string | null; canvaUrl?: string }): { text: string; parse_mode: 'HTML' } {
  return {
    text:
      `✅ <b>The requester approved a draft</b>\n\n${taskLine(input.taskId, input.title)}` +
      (input.canvaUrl ? `✏️ <b>Canva:</b> ${escapeTelegramHtml(input.canvaUrl)}\n` : '') +
      `\nApprove it in Hawa Desk to deliver the final files.`,
    parse_mode: 'HTML',
  };
}

/** To the office, when a requester asks for a designer, or a design needs one after several rounds. */
export function composeDesignerHandoff(input: {
  taskId: string;
  title?: string | null;
  canvaUrl?: string;
  asks: AskRecord[];
  rounds: number;
  why: 'asked' | 'rounds';
}): { text: string; parse_mode: 'HTML' } {
  const head =
    input.why === 'asked'
      ? `🧑‍🎨 <b>The requester asked for a designer</b>`
      : `🧑‍🎨 <b>Round ${input.rounds} of changes on one design</b>\n<i>The requester may need a designer to take over.</i>`;
  return {
    text:
      `${head}\n\n${taskLine(input.taskId, input.title)}` +
      (input.canvaUrl ? `✏️ <b>Canva:</b> ${escapeTelegramHtml(input.canvaUrl)}\n` : '') +
      `🔁 <b>Rounds of changes:</b> ${input.rounds}\n` +
      (input.asks.length ? `\n<b>What they asked for so far:</b>\n${askLines(input.asks)}\n` : '') +
      `\nReply to them in their chat; the design is in Hawa Desk.`,
    parse_mode: 'HTML',
  };
}
