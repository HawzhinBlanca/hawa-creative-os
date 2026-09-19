/**
 * An image the client sent as a style reference with the request, and what to take from it.
 * A logo is never a style reference: the brand pack already carries the official one.
 */
export interface ClientReference {
  /** data: URL of the image, as saved from Telegram. */
  dataUrl: string;
  /** What the brief read in it: composition, colour placement, ornament, mood. */
  notes: string;
}

/** The instruction every model that sees the reference is given, so they read it the same way. */
export function clientReferenceInstruction(reference: ClientReference): string {
  return [
    'CLIENT REFERENCE IMAGE (the last image attached): the client sent it to show the design they want.',
    'Follow its composition, hierarchy, placement of colour and ornament, and mood as closely as the brand',
    "palette, admitted fonts, logo rules and the client's exact copy allow. Never copy its words, logos or",
    'people. What the brief read in it: ' + (reference.notes || 'no notes') + '.',
  ].join(' ');
}

/** The reference as an image part of a model message. */
export function clientReferencePart(reference: ClientReference) {
  return { type: 'image_url' as const, image_url: { url: reference.dataUrl, detail: 'high' as const } };
}
