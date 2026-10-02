/**
 * The nightly live canary's chat (ADR-240). The canary plays a fixed conversation through the real
 * Telegram request path every night, as a chat that no person can own. What the bot says to it, and
 * the office alerts about its requests, are recorded by TelegramSender (`canary_sink`), never sent.
 *
 * Telegram's chat ids have at most 52 significant bits (Bot API: "a signed 64-bit integer or a
 * double-precision float type are safe for storing this identifier"), so no real chat, private or
 * group, is ever at or above 2^52. The canary chat must be a positive whole number in [2^52, 2^53):
 * a configuration naming any other id names no canary at all, so a real person's chat can never be
 * sunk by a typo or a copied id. Both bounds are safe JavaScript integers.
 */
export const CANARY_CHAT_ID_MIN = 2 ** 52;
/**
 * ADR-254: the canary's own client, "Canary Test" (packages/creative/assets/clients/canary-test.json and
 * db/seed.sql). An onboarding pack, so nothing is ever designed for it automatically; it is named only by
 * its two words, and it is never offered to an office member as an organisation to choose.
 */
export const CANARY_TEST_CLIENT_ID = 'c1000000-0000-4000-8000-000000000099';
export const CANARY_CHAT_ID_MAX = 2 ** 53 - 1;

/** True only for an id in the range no Telegram chat can have (written as the plain digits). */
export function isReservedCanaryChatId(value: unknown): boolean {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9][0-9]{15}$/.test(text)) return false;
  const id = Number(text);
  return Number.isSafeInteger(id) && id >= CANARY_CHAT_ID_MIN && id <= CANARY_CHAT_ID_MAX;
}

/**
 * The configured canary chat (HAWA_CANARY_CHAT_ID), or null: unset, or set to an id outside the
 * reserved range, which configures nothing (callers that care log it; see canaryChatProblem).
 */
export function canaryChatIdFromEnv(env: Record<string, string | undefined>): string | null {
  const raw = env.HAWA_CANARY_CHAT_ID?.trim();
  return raw && isReservedCanaryChatId(raw) ? raw : null;
}

/** Why HAWA_CANARY_CHAT_ID configures no canary when it is set, or null when it is unset or valid. */
export function canaryChatProblem(env: Record<string, string | undefined>): string | null {
  const raw = env.HAWA_CANARY_CHAT_ID?.trim();
  if (!raw || isReservedCanaryChatId(raw)) return null;
  return `HAWA_CANARY_CHAT_ID must be a whole number from ${CANARY_CHAT_ID_MIN} to ${CANARY_CHAT_ID_MAX} ` +
    '(a range no Telegram chat can have); it is ignored, and nothing is recorded instead of sent';
}

/** Whether `chatId` is the configured canary chat. Never true for a real Telegram chat. */
export function isCanaryChat(chatId: unknown, env: Record<string, string | undefined>): boolean {
  const canary = canaryChatIdFromEnv(env);
  return canary !== null && String(chatId) === canary;
}
