import { escapeTelegramHtml } from '@hawa/integrations';

/**
 * The requester's buttons under a draft (ADR-032 §2.4) and the office's designer hand-off.
 *
 * Only Core's own Canva outcome message for a task outside RequestLifecycle attaches these buttons
 * (canva-status-message.ts); RequestLifecycle's messages carry none. Since stage 2 of ADR-135 no
 * intake reads a press: every button press is answered as a stale reply
 * (routes/lifecycle-internal.routes.ts), so these are composed only for such tasks, of which no new
 * one is made from Telegram.
 */
export type RequesterAction = 'ok' | 'chg' | 'dsg' | 'a1' | 'a2' | 'a3' | 'sst' | 'ssq' | 'sls';

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

/** The size buttons for a design of this size: every other size, one row. */
export function sizeButtons(taskId: string, current?: { width?: number; height?: number }): InlineButton[][] {
  const others = (Object.keys(OTHER_SIZES) as SizeAction[]).filter((k) => !(OTHER_SIZES[k].width === current?.width && OTHER_SIZES[k].height === current?.height));
  return others.length ? [others.map((k) => ({ text: OTHER_SIZES[k].button, callback_data: `rq:${k}:${taskId}` }))] : [];
}

/** One button per answer to a question, then Ask a designer. */
export function questionButtons(taskId: string, options: string[]): InlineButton[][] {
  return [
    ...options.slice(0, 3).map((o, i) => [{ text: o.length > 60 ? `${o.slice(0, 59)}…` : o, callback_data: `rq:a${i + 1}:${taskId}` }]),
    [{ text: '🧑‍🎨 Ask a designer', callback_data: `rq:dsg:${taskId}` }],
  ];
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
