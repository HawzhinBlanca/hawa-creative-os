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

/**
 * The reference as an image part of a model message.
 *
 * `detail` defaults to 'high' because the stage that invents the composition has to be able to read
 * the reference properly — this client's direction failing to reach the layout is a defect this
 * project has already had once, and it is not worth risking again to save a fraction of a cent.
 *
 * The judge is the exception and passes 'low'. It compares two candidate renders that are
 * themselves attached at 'low'; its prompt even says so in as many words ("Attached are two images
 * rendered at detail 'low'"), while the reference beside them was the only high-detail image
 * anywhere in the studio. Paying for four times the resolution of the things being compared buys
 * nothing, and the prompt was describing its own contents wrongly.
 */
export function clientReferencePart(
  reference: ClientReference,
  options: { detail?: 'low' | 'high' | 'auto' } = {}
) {
  return {
    type: 'image_url' as const,
    image_url: { url: reference.dataUrl, detail: options.detail ?? ('high' as const) },
  };
}
