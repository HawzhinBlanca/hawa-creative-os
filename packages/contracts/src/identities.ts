/**
 * Seeded identities of the office tenant.
 *
 * Every row written through PostgreSQL row-level security carries a user id. Human identities are
 * resolved from credentials in Core. The two service identities exist so that rows nobody pressed a
 * button for are not attributed to a person: channel ingress (Telegram, WhatsApp, unified ingress)
 * and background automation (session bookkeeping, workflow completion, publication audit).
 *
 * Seeded by db/seed.sql for fresh installations and by migration 012_service_identities.sql for
 * existing databases; both grant the service identities the `operator` tenant role, which is what
 * RLS requires for task, event and outbox writes. See ADR-027.
 */
export const SEEDED_TENANT_ID = '00000000-0000-4000-a000-000000000001';
export const PRIMARY_OPERATOR_USER_ID = '00000000-0000-4000-b000-000000000001';
export const ART_DIRECTOR_USER_ID = '00000000-0000-4000-b000-000000000002';
/** Rows created because a message arrived on a channel; no human operator acted. */
export const CHANNEL_INGRESS_USER_ID = '00000000-0000-4000-b000-000000000010';
/** Rows created by Core or the worker on their own initiative. */
export const SYSTEM_AUTOMATION_USER_ID = '00000000-0000-4000-b000-000000000011';

export const SERVICE_USER_IDS: readonly string[] = Object.freeze([
  CHANNEL_INGRESS_USER_ID,
  SYSTEM_AUTOMATION_USER_ID,
]);

export function isServiceUserId(userId: string | null | undefined): boolean {
  return typeof userId === 'string' && SERVICE_USER_IDS.includes(userId);
}
