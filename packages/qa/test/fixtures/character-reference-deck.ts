import { zipSync, strToU8 } from 'fflate';

/** Synthetic one-page source bytes; character references remain raw until the actual inspector. */
export function characterReferenceDeck(text: string, attributes = 'id="2"', paragraph = '', font = 'Verdana') {
  return zipSync({
    'ppt/presentation.xml': strToU8('<p:presentation/>'),
    'ppt/slides/slide1.xml': strToU8(`<p:sld><p:sp><p:nvSpPr><p:cNvPr ${attributes}/></p:nvSpPr><p:txBody><a:p>${paragraph}<a:r><a:rPr><a:latin typeface="${font}"/><a:cs typeface="${font}"/></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:sld>`),
  });
}
