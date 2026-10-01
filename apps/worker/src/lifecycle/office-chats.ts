import { isReservedCanaryChatId } from '@hawa/contracts';

/**
 * Who hears the office's alerts (ADR-155). Every office member (TELEGRAM_ALLOWED_USERS), in the order
 * configured, without repeats. It used to be the first member only, and nobody at all when that member
 * was the requester (the owner's own requests), so the second member never heard of a failure.
 *
 * Callers read it inside a journaled step (`ctx.run`), never beside one: a replay after the list
 * changed must alert the same people, and only them, under the same keys.
 */
export function officeChatIdsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set((env.TELEGRAM_ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean))];
}

/** The chats in `first`, then the office's, without repeats (a signed claim names one; the rest are read). */
export function officeRecipients(first: string | null | undefined, members: readonly string[]): string[] {
  return [...new Set([...(first ? [first] : []), ...members])];
}

/**
 * The key of the alert to one recipient: the first keeps the key a single-recipient alert always had,
 * so an alert already sent before this change is never sent to them again; the others add their chat.
 */
export const officeAlertKey = (base: string, index: number, chatId: string) => (index === 0 ? base : `${base}:${chatId}`);

/**
 * ADR-240: where an office alert about a request goes. A request from the nightly canary's chat (an id
 * no Telegram chat can have, isReservedCanaryChatId) is never the office's business: its alert goes to
 * that chat, where TelegramSender records it, and names the member it was meant for. Decided by the
 * chat id alone, so a replay routes the same way whatever the configuration says by then.
 */
export function officeAlertRoute(alertChatId: string, requestChatId: string | null | undefined): { chatId: string; canaryFor?: string } {
  return requestChatId != null && isReservedCanaryChatId(String(requestChatId)) && String(alertChatId) !== String(requestChatId)
    ? { chatId: String(requestChatId), canaryFor: String(alertChatId) }
    : { chatId: alertChatId };
}
