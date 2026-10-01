/**
 * ADR-233: a round that is a new design of the request, not an edit of its earlier design. A redo
 * ("do a better design", ADR-200 §6) and a round for changes sent while the first draft was being made
 * (ADR-230 §6) make a new Canva design from the request's copy, photos and format, with the requester's
 * words as art direction. The earlier design, and any manual edit of it, is never opened or overwritten.
 */
export type FreshRoundKind = 'redo' | 'pending_changes';
export interface FreshRoundIntent { parentTaskId: string; kind: FreshRoundKind; directive: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FRESH_KINDS: readonly string[] = ['redo', 'pending_changes'];

function studioOptionsOf(source: unknown): Record<string, unknown> | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const outer = source as Record<string, unknown>;
  const payload = outer.payload && typeof outer.payload === 'object' ? outer.payload as Record<string, unknown> : outer;
  const options = payload.studioOptions;
  return options && typeof options === 'object' && !Array.isArray(options) ? options as Record<string, unknown> : undefined;
}

/**
 * The fresh-round intent a task was created with, exactly as saved; undefined when it has none or when
 * it is malformed or ambiguous (a native parent beside it). `nativeRevisionIntent` refuses those.
 */
export function freshRoundIntent(source: unknown): FreshRoundIntent | undefined {
  const options = studioOptionsOf(source);
  if (!options || !Object.hasOwn(options, 'freshFrom') || Object.hasOwn(options, 'parentTaskId')) return undefined;
  const fresh = options.freshFrom;
  if (!fresh || typeof fresh !== 'object' || Array.isArray(fresh)) return undefined;
  const { parentTaskId, kind, directive, ...rest } = fresh as Record<string, unknown>;
  if (Object.keys(rest).length || typeof parentTaskId !== 'string' || !UUID.test(parentTaskId) ||
      typeof kind !== 'string' || !FRESH_KINDS.includes(kind) ||
      typeof directive !== 'string' || !directive.trim() || directive.length > 2000) return undefined;
  return { parentTaskId, kind: kind as FreshRoundKind, directive };
}

/** Revision intent comes from the saved request, never from a model's reconstruction. */
export function nativeRevisionIntent(source: unknown): { parentTaskId: string; directive: string } | undefined {
  const options = studioOptionsOf(source);
  if (!options) return undefined;
  const { parentTaskId, revisionDirective } = options;
  // ADR-233: a well-formed fresh round is a new design, not a native edit. A malformed or ambiguous
  // one (no valid parent, kind or words, or a native parent beside it) is held as a revision.
  if (Object.hasOwn(options, 'freshFrom') && !Object.hasOwn(options, 'parentTaskId')) {
    return freshRoundIntent(source) ? undefined : { parentTaskId: '__invalid_parent__', directive: '' };
  }
  // Retain malformed parent intent as a refusal too; it must never become a new design.
  if (!Object.hasOwn(options, 'parentTaskId')) return undefined;
  return { parentTaskId: typeof parentTaskId === 'string' ? parentTaskId : '__invalid_parent__',
    directive: typeof revisionDirective === 'string' ? revisionDirective.slice(0, 2000) : '' };
}

export function validReviewedRevisionCopy(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 128 &&
    value.every(part => typeof part === 'string' && part.trim().length > 0 && !part.includes('\u0000')) &&
    value.join('\n').length <= 16000;
}
