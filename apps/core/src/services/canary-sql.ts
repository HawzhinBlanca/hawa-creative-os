import { CANARY_CHAT_ID_MAX, CANARY_CHAT_ID_MIN } from '@hawa/contracts';
import { sql } from '@hawa/db';

type Fragment = ReturnType<typeof sql>;

/**
 * Whether a chat id (text) is in the range no Telegram chat can have, the nightly canary's (ADR-240).
 * The cast only ever sees sixteen digits: Postgres does not promise to test the pattern first in a
 * plain AND. Never null.
 */
export const canaryChatSql = (chat: Fragment) => sql<boolean>`COALESCE(CASE WHEN (${chat}) ~ '^[1-9][0-9]{15}$'
  THEN (${chat})::numeric BETWEEN ${String(CANARY_CHAT_ID_MIN)}::numeric AND ${String(CANARY_CHAT_ID_MAX)}::numeric END, false)`;
