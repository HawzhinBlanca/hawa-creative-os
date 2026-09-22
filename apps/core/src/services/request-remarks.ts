/**
 * A closing remark addressed to the designer is not copy.
 *
 * On 2026-09-22 a request ended with "I attached the panelists pictures and a reference for the
 * graphic". Intake kept it as the last copy block and the design printed it under the event
 * details. The opening "I need a graphic with these texts…" was already read as an instruction;
 * the closing one had no rule. A final paragraph that talks about the attachments, or asks the
 * designer to use them, moves to the instructions. Nothing else is touched: a line of real copy
 * that happens to mention a photo ("Photo exhibition opening") does not start this way.
 */
const REMARK = new RegExp(
  [
    String.raw`^i\s*(?:'ve|\s+have)?\s+(?:attached|sent|added|included|shared)\b`,
    String.raw`^(?:please\s+)?(?:find|see|check)\s+(?:the\s+)?attached\b`,
    String.raw`^attached\s+(?:are|is|you'?ll\s+find)\b`,
    String.raw`^(?:here\s+(?:are|is)|these\s+are)\s+the\s+(?:photos?|pictures?|images?|pics?|portraits?|reference|logos?)\b`,
    String.raw`^(?:the\s+)?(?:photos?|pictures?|images?|pics?|portraits?)\s+(?:are|is)\s+attached\b`,
    String.raw`^(?:please\s+)?use\s+(?:the\s+)?(?:attached|these|those|my)\s+(?:photos?|pictures?|images?|pics?|portraits?|reference)\b`,
    // Sorani: "I attached / here are the pictures / the pictures are attached"
    String.raw`^(?:وێنەکانم|وێنەکان|وێنەی)\s*.*(?:هاوپێچ|ناردووە|دانا)`,
    String.raw`^هاوپێچ`,
  ].join('|'),
  'iu'
);

export function isDesignerRemark(paragraph: string): boolean {
  return REMARK.test(paragraph.trim());
}

/** Splits trailing designer remarks off the copy. Returns the copy and the remarks, in order. */
export function peelTrailingRemarks(text: string): { copy: string; remarks: string } {
  const paragraphs = text.trim().split(/\n\s*\n/);
  const remarks: string[] = [];
  while (paragraphs.length > 1 && isDesignerRemark(paragraphs[paragraphs.length - 1])) {
    remarks.unshift(paragraphs.pop()!.trim());
  }
  return { copy: paragraphs.join('\n\n').trim(), remarks: remarks.join('\n') };
}
