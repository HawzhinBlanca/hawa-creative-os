import { normalizeKurdishIncomingText } from '@hawa/integrations';
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

/**
 * A line that introduces the copy is an instruction, never copy (production, 2026-09-29).
 *
 * A Telegram album caption ended its instructions with "Here is the text and the photos:" on a line
 * of its own. Intake took that line for copy: the task was titled "KAAE: Here is the text and the
 * photos:…" and the line became copy block 0 of the design. The rule: a line that ends with a colon,
 * speaks of the text (text, copy, wording, words, content; Sorani دەق, نووسین, ناوەڕۆک, وشە) and is
 * addressed to the designer — it opens with here/below/this/please/use/"I want"…, or ئەمە/ئەمانە/ئەم/
 * تکایە…, or it is the bare noun ("Text:", "Text to use:", "دەقەکە:", "دەق و وێنەکان:") — introduces
 * the copy. A line of real copy that ends with a colon ("Speakers:", "Date:", "Mission:",
 * "Content Strategy Workshop:", "وشەی سەرۆک:") names no text, or names it with other words after it,
 * and is not one.
 */
const EN_TEXT_WORD = String.raw`(?:texts?|copy|wording|words|contents?)`;
const EN_COPY_INTRODUCER = new RegExp(
  String.raw`^(?:and\s+|so\s+)?(?:` +
    // "Here is the text and the photos:", "Please use this text:", "Below is the copy:"
    String.raw`(?:here|below|following|this|these|please|kindly|use|add|put|write|include|(?:i|we)\s+(?:want|need|would\s+like|have))\b` +
    String.raw`[^\n:]{0,60}?\b${EN_TEXT_WORD}\b[^\n:]{0,60}` +
    `|` +
    // "Text:", "The text:", "Text to use:", "Copy for the poster:", "The text and the photos:"
    String.raw`(?:the\s+|our\s+|my\s+)?(?:following\s+)?${EN_TEXT_WORD}` +
    String.raw`(?:\s+(?:and|&)\s+(?:the\s+)?(?:photos?|pictures?|images?|pics?|logos?))?` +
    String.raw`(?:\s+(?:to|for|below|here|is|are|goes|of\s+(?:the|this|our|my))\b[^\n:]{0,50})?` +
  String.raw`)\s*[:：]$`,
  'iu'
);
const CKB_COPY_INTRODUCER = new RegExp(
  `^(?:` +
    // "ئەمە دەقەکەیە:", "ئەمانە دەقەکانن:", "ئەم دەقە بنووسە:", "تکایە ئەم نووسینە دابنێ:"
    String.raw`(?:ئەمەش|ئەمە|ئەمانە|ئەم|ئەوە|ئەوانە|ئەو|تکایە|لێرەدا|لێرە|لەخوارەوە|لە\s+خوارەوە)(?![\p{L}\p{M}])` +
    String.raw`[^\n:]{0,60}?(?:دەق|نووسین|ناوەڕۆک|وشە)[^\n:]{0,40}` +
    `|` +
    // "دەقەکە:", "نووسینەکە:", "دەقەکان:", "دەق:", "دەق و وێنەکان:"
    String.raw`(?:دەق|نووسین|ناوەڕۆک)(?:ەکە|ەکان)?(?:\s+و\s+وێنە[\p{L}\p{M}]*)?` +
    `|` +
    // "دەقەکەی خوارەوە:", "دەقی پۆستەرەکە:"; not "وشەی سەرۆک:" (the president's word), a heading
    String.raw`(?:دەق|نووسین)(?:ەکەی|ەکانی|ی)\s+[^\n:]{1,40}` +
  String.raw`)\s*[:：]$`,
  'u'
);

export function isCopyIntroducer(line: string): boolean {
  const text = normalizeKurdishIncomingText(String(line || '')).replace(/[​-‏‪-‮⁦-⁩]/g, '').trim();
  if (!text || text.length > 120) return false;
  return EN_COPY_INTRODUCER.test(text) || CKB_COPY_INTRODUCER.test(text);
}
