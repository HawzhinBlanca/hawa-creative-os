/**
 * The Telegram poller's offset store moved to packages/db (architecture programme Phase 2.1), so
 * Core's poller and the worker's share one implementation and one row. Kept here for Core's imports.
 */
export { PostgresTelegramPollState, telegramBotKey, type TelegramPollScope } from '@hawa/db';
