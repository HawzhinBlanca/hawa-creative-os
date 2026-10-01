import { zipSync, strToU8 } from 'fflate';

/** Synthetic live DrawingML; no native rendering/editability or field-update claim. */
export function scriptFontRun(text: string, latin?: string, arabic?: string, kind: 'r' | 'fld' = 'r') {
  return `<a:${kind}${kind === 'fld' ? ' id="{00000000-0000-4000-8000-000000000001}" type="datetime1"' : ''}><a:rPr>${latin === undefined ? '' : `<a:latin typeface="${latin}"/>`}${arabic === undefined ? '' : `<a:cs typeface="${arabic}"/>`}</a:rPr><a:t>${text}</a:t></a:${kind}>`;
}
export function scriptFontDeck(runs: string) {
  return zipSync({
    'ppt/presentation.xml': strToU8('<p:presentation/>'),
    'ppt/slides/slide1.xml': strToU8(`<p:sld><p:sp><p:nvSpPr><p:cNvPr id="2"/></p:nvSpPr><p:txBody><a:p><a:pPr rtl="1"/>${runs}</a:p></p:txBody></p:sp></p:sld>`),
  });
}
