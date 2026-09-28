import { clientExemplarManifestPath, findClientPack, loadClientPacks, matchClientPack, type ClientMatch, type ClientPack } from '@hawa/creative';
import { log } from '../logging.js';

/**
 * Core's view of the client packs (ADR-127). A pack set that fails to load is logged once and read
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
 * no active Client DNA to design with, so the studio would refuse it: the request is saved for the
 * art director instead of spending the requester's daily allowance on a refusal.
 */
export function autoDraftAllowedFor(clientId: string | null | undefined): boolean {
  return clientPackOf(clientId)?.status !== 'onboarding';
}

/**
 * The client's own confirmed exemplar manifest, as its pack names it, or undefined (ADR-127). Every
 * client used to be conditioned on KAAE's; callers still read it only for a client whose references
 * are admitted for exemplar conditioning (ADR-115: KAAE's packaged reference).
 */
export function clientExemplarManifestOf(clientId: string | null | undefined): string | undefined {
  const pack = clientPackOf(clientId);
  return pack ? clientExemplarManifestPath(pack) : undefined;
}

/** What an onboarding client still lacks, in words, for a refusal; undefined for any other client. */
export function onboardingGapOf(clientId: string | null | undefined): string | undefined {
  const pack = clientPackOf(clientId);
  if (pack?.status !== 'onboarding') return undefined;
  return `${pack.displayName} is still being set up (missing: ${pack.onboarding.missing.join(', ')}).`;
}
