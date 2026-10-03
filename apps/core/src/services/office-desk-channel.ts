/**
 * The Desk as a request channel (ADR-287). A request typed into the Desk's "New task" form is opened on
 * RequestLifecycle like a Telegram brief; its channel is `desk:<office member's user id>`. Nothing is
 * ever sent to that channel: the requester is the office member, who follows the request in the Desk.
 * TelegramSender answers a message for it `desk_only`, the Delivery workflow sends no files to it, and
 * a request on it is delivered once its Drive archive and Sheet row are confirmed.
 */
export const DESK_CHANNEL = /^desk:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const deskChannelFor = (userId: string): string => `desk:${userId.toLowerCase()}`;

export const isDeskChannel = (chatId: unknown): chatId is string => typeof chatId === 'string' && DESK_CHANNEL.test(chatId);
