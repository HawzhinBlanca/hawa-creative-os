/** Revision intent comes from the saved request, never from a model's reconstruction. */
export function nativeRevisionIntent(source: unknown): { parentTaskId: string; directive: string } | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const outer = source as Record<string, unknown>;
  const payload = outer.payload && typeof outer.payload === 'object' ? outer.payload as Record<string, unknown> : outer;
  const options = payload.studioOptions;
  if (!options || typeof options !== 'object') return undefined;
  const { parentTaskId, revisionDirective } = options as Record<string, unknown>;
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
