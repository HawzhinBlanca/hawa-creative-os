import { AsyncLocalStorage } from 'node:async_hooks';
import { isStudioSubstepKey, studioSubstepKey } from '@hawa/domain';

/**
 * ADR-122: the semantic substep a Studio model call belongs to. Stage code declares it around
 * the work (`layout/concept-1`, `art/candidate-2`); the ledger records it with the call's
 * attempt and binding, and recovery consumes retained results per substep, not by run order.
 * Undeclared calls fall back to one ordered substep per stage, `sequence/<stage>`.
 */
const scope = new AsyncLocalStorage<string>();

export function inStudioSubstep<T>(key: string, work: () => Promise<T>): Promise<T> {
  if (!isStudioSubstepKey(key)) throw new TypeError(`Invalid Studio substep key: ${key}`);
  return scope.run(key, work);
}

export function currentStudioSubstep(stage: string): string {
  return scope.getStore() ?? studioSubstepKey('sequence', stage);
}

/**
 * Calls whose inputs come from the local renderer or font measurement also bind the retained font
 * basis. Brief, concept and artwork requests do not depend on local font bytes, so a font or copy
 * change elsewhere does not invalidate them.
 */
export function substepBindsRenderer(substep: string, stage: string): boolean {
  const family = substep.split('/')[0];
  if (family === 'sequence') return !['briefing', 'conceiving', 'art'].includes(stage);
  return !['brief', 'concepts', 'art'].includes(family);
}

/**
 * Artwork binds only its own request, provider, model and capability policy: a copy or policy
 * change elsewhere does not invalidate an image. The art verifier runs in the same substep and
 * also binds no authority: it asks a fixed compliance question about the image bytes and reads
 * no client policy, so its request digest is its whole input. Every other call binds the current
 * authority (client reference, exemplar approvals, standing rules), so a withdrawn approval is
 * rechecked even when the bytes sent to the provider are unchanged.
 */
export function substepBindsAuthority(substep: string, stage: string): boolean {
  const family = substep.split('/')[0];
  return !(family === 'art' || (family === 'sequence' && stage === 'art'));
}
