/**
 * Who hears Core's intake alerts to the office (ADR-155 section 6, carried to intake). Every office
 * member (TELEGRAM_ALLOWED_USERS), in the order configured, without repeats. These alerts used to go to
 * the first member only, and to nobody when that member sent the words (the owner's own requests), so
 * the second member never heard of them. The worker reads the same list for its own alerts
 * (apps/worker/src/lifecycle/office-chats.ts).
 */
export function officeChatIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set((env.TELEGRAM_ALLOWED_USERS || '').split(',').map((v) => v.trim()).filter(Boolean))];
}

/** The members to tell about words sent in `fromChat`: every member but that chat, which has the words. */
export function officeChatsFor(fromChat: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  return officeChatIds(env).filter((chat) => chat !== fromChat);
}

/** The member an alert about words from `fromChat` names first (`officeAlert`), or undefined without one. */
export const officeChatFor = (fromChat: string | null | undefined): string | undefined => officeChatsFor(fromChat)[0];

type Alert = { chatId: string; text: string };

/**
 * An intake answer with its office alert sent to every member: `officeAlerts` holds one per member (the
 * first is `officeAlert`, which a worker from before this change still sends alone). A recorded answer
 * replays the same way. Answers without an alert are returned as they are.
 */
export function withOfficeAlerts(extra: Record<string, unknown>): Record<string, unknown> {
  const alert = extra.officeAlert as Partial<Alert> | undefined;
  if (!alert || typeof alert.chatId !== 'string' || typeof alert.text !== 'string' || Array.isArray(extra.officeAlerts)) return extra;
  const from = typeof extra.chatId === 'string' ? extra.chatId : null;
  const text = alert.text;
  const chats = [...new Set([alert.chatId, ...officeChatsFor(from)])];
  return { ...extra, officeAlerts: chats.map((chatId) => ({ chatId, text })) };
}
