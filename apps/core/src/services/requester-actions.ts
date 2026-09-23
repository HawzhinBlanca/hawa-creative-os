import { escapeTelegramHtml } from '@hawa/integrations';

/**
 * The requester's side of a draft (ADR-032 §2.4): three buttons under every draft they receive.
 *
 * - Approve records that the requester is happy with the draft and tells the office. It does not
 *   approve the design: the art director's approval in Hawa Desk still gates delivery (ADR-022).
 * - Change something asks for the change as a reply, so it reaches this design.
 * - Ask a designer hands the design to the office's designer, with what was asked so far.
 *
 * A question asked before a change is made (edit stage, NEEDS_CLARIFICATION) carries one button per
 * answer, `a1` to `a3`: the answer is looked up on the run by its number, so no text rides in the
 * button. `rq:<action>:<task id>` fits Telegram's 64-byte callback data.
 */
export type RequesterAction = 'ok' | 'chg' | 'dsg' | 'a1' | 'a2' | 'a3' | 'sst' | 'ssq' | 'sls';

const DATA = /^rq:(ok|chg|dsg|a[1-3]|sst|ssq|sls):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * The other sizes an approved design can be made in (plan 4.3): the same design, laid out again for
 * the format by the edit that makes changes, and checked by the same gates.
 */
export const OTHER_SIZES = {
  sst: { label: 'story', width: 1080, height: 1920, button: '📱 Story 9:16' },
  ssq: { label: 'square post', width: 1080, height: 1080, button: '⬛ Square 1:1' },
  sls: { label: 'landscape banner', width: 1920, height: 1080, button: '🖥 Landscape 16:9' },
} as const;
export type SizeAction = keyof typeof OTHER_SIZES;

export function sizeOf(action: RequesterAction): (typeof OTHER_SIZES)[SizeAction] | undefined {
  return action in OTHER_SIZES ? OTHER_SIZES[action as SizeAction] : undefined;
}

/** The size buttons for a design of this size: every other size, one row. */
export function sizeButtons(taskId: string, current?: { width?: number; height?: number }): InlineButton[][] {
  const others = (Object.keys(OTHER_SIZES) as SizeAction[]).filter((k) => !(OTHER_SIZES[k].width === current?.width && OTHER_SIZES[k].height === current?.height));
  return others.length ? [others.map((k) => ({ text: OTHER_SIZES[k].button, callback_data: `rq:${k}:${taskId}` }))] : [];
}

/** To the requester, when a size was asked for. */
export function composeSizeStarted(label: string, width: number, height: number, sizeTaskId: string): TelegramReply {
  return {
    text:
      `📐 <b>Making the ${escapeTelegramHtml(label)} version (${width}×${height}).</b>\n\n` +
      `The same design, laid out for the new format. It comes to this chat as its own draft, with its own Canva link.\n\n` +
      `🆔 Task ID: <code>${escapeTelegramHtml(sizeTaskId)}</code>`,
    parse_mode: 'HTML',
  };
}

/** The answer a question button stands for: 0 for a1. Undefined for the other actions. */
export function answerIndex(action: RequesterAction): number | undefined {
  const m = action.match(/^a([1-3])$/);
  return m ? Number(m[1]) - 1 : undefined;
}

/** One button per answer to a question, then Ask a designer. */
export function questionButtons(taskId: string, options: string[]): InlineButton[][] {
  return [
    ...options.slice(0, 3).map((o, i) => [{ text: o.length > 60 ? `${o.slice(0, 59)}…` : o, callback_data: `rq:a${i + 1}:${taskId}` }]),
    [{ text: '🧑‍🎨 Ask a designer', callback_data: `rq:dsg:${taskId}` }],
  ];
}

/** To the requester, when their answer to a question was taken and the change is being made. */
export function composeAnswerTaken(answer: string, revisionTaskId: string): TelegramReply {
  return {
    text:
      `👍 <b>Got it:</b> ${escapeTelegramHtml(answer.slice(0, 300))}\n\n` +
      `🎨 <b>Making the change now.</b> The new draft comes to this chat when it is ready; reply to it to change it again.\n\n` +
      `🆔 Task ID: <code>${escapeTelegramHtml(revisionTaskId)}</code>`,
    parse_mode: 'HTML',
  };
}

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
  reply_markup?: { force_reply: true; input_field_placeholder?: string } | { inline_keyboard: InlineButton[][] };
}

const taskLine = (taskId: string, title?: string | null) =>
  `📌 <b>Task ID:</b> <code>${escapeTelegramHtml(taskId)}</code>\n📜 <b>Title:</b> ${escapeTelegramHtml(title || 'Campaign Design')}\n`;

/** To the requester, after Approve. */
export function composeRequesterApproved(taskId: string, current?: { width?: number; height?: number }, offerSizes = true): TelegramReply {
  const sizes = offerSizes ? sizeButtons(taskId, current) : [];
  return {
    text:
      `✅ <b>Thank you, you approved this design.</b>\n\n` +
      `The art director does a final check in Hawa Desk and the final files come to this chat.\n\n` +
      (sizes.length ? `📐 Need it in another size too? Tap one below for the same design in that format.\n\n` : '') +
      `🆔 Task ID: <code>${escapeTelegramHtml(taskId)}</code>`,
    parse_mode: 'HTML',
    ...(sizes.length ? { reply_markup: { inline_keyboard: sizes } } : {}),
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

/**
 * To the office, when a requester asks for a designer, a design needs one after several rounds, or
 * the requester's last message reads as them losing patience.
 */
export function composeDesignerHandoff(input: {
  taskId: string;
  title?: string | null;
  canvaUrl?: string;
  asks: AskRecord[];
  rounds: number;
  why: 'asked' | 'rounds' | 'frustrated';
}): { text: string; parse_mode: 'HTML' } {
  const head =
    input.why === 'asked'
      ? `🧑‍🎨 <b>The requester asked for a designer</b>`
      : input.why === 'frustrated'
        ? `🧑‍🎨 <b>The requester sounds frustrated</b>\n<i>Their last change request reads as losing patience; a designer may want to step in.</i>`
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
