import { creativeAssetPath, findClientPack, loadClientExemplars, loadClientPacks, matchClientPack, type ClientExemplars, type ClientMatch, type ClientPack } from '@hawa/creative';
import { log } from '../logging.js';

/**
 * Core's view of the client packs (ADR-038). A pack set that fails to load is logged once and read
 * as empty, so intake falls back to its legacy client detection instead of refusing every message;
 * the packs are validated by packages/creative/test/client-packs.test.ts before they ship.
 */
let reported = false;

export function clientPacks(): ClientPack[] {
  try {
    return loadClientPacks();
  } catch (err) {
    if (!reported) {
      reported = true;
      log.error('[client-packs] The client packs did not load; routing falls back to legacy detection:', err);
    }
    return [];
  }
}

/** The pack for a client id, code or `client-<code>`, or undefined. */
export function clientPackOf(idOrCode: string | null | undefined): ClientPack | undefined {
  return findClientPack(idOrCode, clientPacks());
}

/** Which client a chat request belongs to by its chat and its words (see matchClientPack). */
export function matchRequestClient(input: { chatId?: string | null; rawText: string; normalizedText?: string }): ClientMatch {
  return matchClientPack(input, clientPacks());
}

/**
 * Whether a request for this client may start an automatic draft. A client still being set up has
 * no verified reference pack, so the studio would refuse it: the request is saved for the art
 * director instead of spending the requester's daily allowance on a refusal.
 */
export function autoDraftAllowedFor(clientId: string | null | undefined): boolean {
  return clientPackOf(clientId)?.status !== 'onboarding';
}

/**
 * Where a client's verified reference pack and official logo are, or why it has none. The studio and
 * the planner used to read KAAE's for every task and refuse any other client; each client now reads
 * its own, and a client still being set up is refused with what it is missing.
 */
export function clientReferenceOf(clientId: string | null | undefined):
  | { referencePath: string; logoPath: string; code: string }
  | { refusal: string } {
  const pack = clientPackOf(clientId);
  if (!pack?.reference) {
    return {
      refusal: pack
        ? `${pack.displayName} is still being set up and has no verified reference pack yet (missing: ${pack.onboarding.missing.join(', ')}). Design it by hand until then.`
        : 'This client needs its own verified reference pack. Another client\'s references cannot be used for it.',
    };
  }
  return { referencePath: creativeAssetPath(pack.reference.pack), logoPath: creativeAssetPath(pack.reference.logo), code: pack.code };
}

/**
 * The client's own confirmed exemplars, or undefined when it has none yet (ADR-038). Every client's
 * designs used to be conditioned on KAAE's; a client without its own set is conditioned on none.
 * Throws when the pack names a set recorded for another client.
 */
export function clientExemplarsOf(clientId: string | null | undefined): ClientExemplars | undefined {
  const pack = clientPackOf(clientId);
  return pack ? loadClientExemplars(pack) : undefined;
}
