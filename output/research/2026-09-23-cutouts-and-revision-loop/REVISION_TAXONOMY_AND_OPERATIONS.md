I found no public dataset that counts the revision requests real clients make on posters or social graphics. The ranking in §1 is therefore inferred from expert-critique datasets and synthetic editing benchmarks. The most useful new fact is in §4: Canva's REST API now has a preview endpoint that removes a photo's background. Sources were retrieved on 2026-09-23. Nothing was written to the repository or the vault. Two pages I couldn't open directly (Canva's MCP help page and its PowerPoint import page) are quoted from search-result snippets.

## 1. What people ask designers to change

| Source | What was counted | Largest categories |
|---|---|---|
| UICrit, Duan et al., UIST 2024 ([arXiv 2407.08850](https://arxiv.org/html/2407.08850v2)) | 3,059 critiques of 983 mobile UI screens, written by 7 designers | layout 696, colour contrast 655, button usability 601, learnability 601, text readability 591 |
| SlideAudit, Zhang et al., UIST 2025 ([arXiv 2508.03630](https://arxiv.org/html/2508.03630v1)) | 2,400 slides; 1,800 of them had flaws inserted on purpose | composition/layout flaw on 70.5% of slides, typography 43.0%, colour 13.7%, imagery 9.6%. Most common single flaws: hidden or overlapped content 15.5%, wrong font size 15.2% |
| Chen et al., CSCW 2025 ([arXiv 2504.09827](https://arxiv.org/html/2504.09827)) | 5,523 comments on r/UI_design | mentions of colour 195, contrast 174, space 140, shape/size 135, layout 130, typography 79 |
| APEX-Bench, Jan 2026 ([arXiv 2601.04794](https://arxiv.org/html/2601.04794)) | 514 academic-poster edit instructions, written by a model and checked by experts | text 79.8%, layout 59.3%, images 47.7%, shapes 33.3% (one instruction can fall in several). 71.6% were concrete, 28.4% abstract |
| CrowdCrit, Luther et al., CSCW 2015 ([project page](http://vis.berkeley.edu/papers/crowdcrit/)) | 70 critique statements grouped under 7 principles | readability, layout, balance, simplicity, emphasis, consistency, appropriateness. No frequencies given |

Voyant ([Xu, Huang & Bailey, CSCW 2014](https://experts.illinois.edu/en/publications/voyant-generating-structured-feedback-on-visual-designs-using-a-c)) structures feedback as what viewers notice first and what impression they form. That is the basis of hierarchy complaints. Krause et al. ([Critique Style Guide, 2017](https://spdow.ucsd.edu/publication/critique-style-guide-improving-crowdsourced-design-feedback-with-a-natural-language-model/)) find that useful feedback is specific, actionable and grounded in design knowledge. Requester messages often are not, so Hawa needs a clarification step.

**Caveat.** Every source above counts expert critique or synthetic instructions, about UIs, slides or academic posters. None counts real client revision requests.
- Agency writing gives no counts. [Boast Image (2026-01-08)](https://boastimage.com/blog/complete-guide-managing-design-feedback-revisions/) only splits revisions into minor (text or image updates) and major (structural) changes.
- "Make the logo bigger" and "make it pop" are the standard examples ([JH Specialty](https://www.jhspecialty.com/blog/make-the-logo-bigger), [Creative Market](https://creativemarket.com/blog/design-clients-make-it-pop)). That is anecdote, not data.
- A survey of 122 designers and clients ([Cornish et al., Design Studies 2015](https://www.repository.cam.ac.uk/items/06aec843-43af-4ccd-abd2-dafeab1afd2e)) found that neither side reliably discusses legibility. Requesters will rarely raise contrast or text-size problems, so Hawa must check these itself.

**Ranked request types** (inferred from how often the sources agree; no real-world frequencies exist):
1. **Copy and content fixes**: dates, names, titles, typos, adding or removing a line. Highest in APEX (79.8%), and agencies treat these as the routine revision.
2. **Spacing, alignment and position**: "too crowded", "dead space", "move this". High in all four datasets.
3. **Text size, weight and hierarchy**: "make the title bigger", "I can't read it". SlideAudit typography 43%; UICrit readability about 19%.
4. **Colour and contrast**: brand colours, background colour, text colour. The top two mention counts in Chen et al.
5. **Photo changes**: swap, crop, zoom, cut out. APEX 47.7%, SlideAudit 9.6%.
6. **Logo size, position and partner logos**: widely reported, no data.
7. **Abstract emphasis or mood** ("make it pop", "more premium"): 28% of APEX instructions were abstract (synthetic).
8. **Overlap**: text over faces or the logo. The most common single flaw in SlideAudit.
9. **Other formats** (story, square, print): no data.
10. **Consistency with a series or brand**: no data.

## 2. Photo treatments

| Treatment | Without AI | With AI | Layout JSON field or pixel step |
|---|---|---|---|
| Background removal (cutout) | Only chroma key, for photos shot on a plain backdrop | [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) (MIT licence; high-resolution and portrait-matting versions released 2024–25); [SAM 3](https://ai.meta.com/research/publications/sam-3-segment-anything-with-concepts/) (Meta, 2025-11-19; custom licence that allows commercial use with restrictions); [RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0) (CC BY-NC 4.0, so commercial use needs a BRIA agreement); Canva's background-removal API (§4) | Pixel step that makes a new transparent image; the original is kept |
| Mask into a shape (circle, arch, blob) | A clip path | – | New JSON field `mask {shape, path}` |
| Duotone or colour overlay | Map brightness onto two colours ([SVG feComponentTransfer, MDN](https://developer.mozilla.org/en-US/docs/Web/SVG/Element/feComponentTransfer); [Codrops 2019](https://tympanus.net/codrops/2019/02/05/svg-filter-effects-duotone-images-with-fecomponenttransfer/)), or an overlay rectangle with a blend mode | – | JSON `filter {duotone:[dark,light]}`, applied by the renderer |
| Gradient fade | Transparency gradient mask | – | JSON `fade {edge, from, to}` |
| Drop or contact shadow | Offset and blur the photo's outline; a contact shadow is a flattened, blurred ellipse under the subject | – | JSON `shadow {...}`. Following the person's silhouette needs a cutout first |
| Outline or glow around a cutout | Expand the cutout's outline and fill it with a colour ([feMorphology](https://tympanus.net/codrops/2019/01/22/svg-filter-effects-outline-text-with-femorphology/)) | – | JSON `outline` / `glow`; needs a cutout |
| Black and white | Desaturate by brightness | – | JSON `adjust.saturation = 0` |
| Colour grade to brand palette | Tint, lookup table, or [Reinhard colour transfer (2001)](https://www.cs.tau.ac.il/~turkel/imagepapers/ColorTransfer.pdf) | Not needed | JSON `grade {mode, palette, strength}`. Watch skin tones |
| Retouching | – | Face-restoration models such as GFPGAN or CodeFormer; CodeFormer lets you trade identity against quality ([Segmind comparison](https://blog.segmind.com/codeformer-vs-esrgan/)) | Pixel step. Should go to a human |
| Upscaling a low-res photo | Standard resampling (adds no detail) | [Real-ESRGAN](https://github.com/xinntao/real-esrgan) (BSD-3 licence) | Pixel step |
| Crop to faces | Crop around the detected face box | Face detection: [YuNet](https://huggingface.co/spaces/opencv/face_detection_yunet) (MIT, 5 landmarks) or [MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) | JSON `crop {focus, zoom}`, with the face box stored once when the photo is uploaded |
| Extend a background (outpainting) | – | Canva Magic Expand, Photoshop Generative Expand. Every added pixel is invented ([Transloadit guide](https://transloadit.com/guides/generative-image-expansion/)) | Pixel step, labelled as generated |
| Several speakers at the same head height | Scale each photo so face height matches, then line up the eyes | Face detection only | JSON `photoGroup {headHeight, eyeLineY}`, turned into each photo's crop |

A caution on automatic cropping. Twitter's saliency-based crop showed 4–8% gaps from demographic parity, and Twitter removed it in May 2021 ([Yee et al.](https://arxiv.org/abs/2105.08667); [Twitter blog](https://blog.x.com/engineering/en_us/topics/insights/2021/sharing-learnings-about-our-image-cropping-algorithm)). Crop from face boxes and let the requester override.

## 3. Typography and layout revisions: what can be measured

| Revision | Automatic measure | Source |
|---|---|---|
| Hierarchy and emphasis | Title-to-body size ratio; a predicted importance map shows which element people see first | [Bylinskii et al., UIST 2017](https://arxiv.org/abs/1708.02660); [Fosco et al., UIST 2020](https://arxiv.org/abs/2008.02912) |
| Dead space and spacing | White-space fraction and how freely it flows | [Harrington et al., DocEng 2004](https://dl.acm.org/doi/10.1145/1030397.1030419) |
| Alignment | Alignment score; grid quality | [Kikuchi et al., ACM MM 2021](https://arxiv.org/pdf/2108.00871); [Miniukovich & De Angeli, CHI 2015](https://dl.acm.org/doi/10.1145/2702123.2702575) |
| Balance | Distance between the visual centre of mass and the canvas centre; symmetry | [Ngo, Teo & Byrne 2003](https://www.sciencedirect.com/science/article/abs/pii/S0020025502004048); [AIM, 2018](https://interfacemetrics.aalto.fi/static/publications/oulasvirta_et_al_2018.pdf) |
| Overlap and text over busy images | Overlap between elements; how much salient image area is covered; how busy the image is under the text | Kikuchi et al.; [CGL-GAN metrics](https://arxiv.org/pdf/2303.15937) |
| Legibility | Contrast ratio: 4.5:1, or 3:1 for large text, measured against the actual pixels behind the text | [WCAG 2.2 SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) |
| Line breaks | Rule checks: no widows, no breaks inside names or dates, balanced line lengths | No standard metric found |

How far to trust these metrics:
- The eight Miniukovich metrics explained at most 49% of aesthetic ratings for web pages and 32% for apps. That is enough to gate a design, not to judge taste.
- Hawa's own notes from 2026-09-17/18: an edge-only alignment metric rejected 3 of the owner's 6 approved exemplars, because it fails centred designs by construction. No metric could see where a separator line sat. Calibrate every metric on approved designs before using it as a gate.

**Right-to-left and mixed-script issues**
- **Direction.** Mixed English, Kurdish and digits are reordered by the Unicode bidi algorithm ([UAX #9](https://www.unicode.org/reports/tr9/)). Store `lang` and `dir` explicitly on each text block. Hawa's own guess from font names missed the Amiri font.
- **Letter-spacing.** Never letter-space Arabic script; it breaks the joins between letters. Justify with kashida, which stretches the joins ([W3C alreq](https://www.w3.org/TR/alreq/)).
- **Sorani glyphs.** Some "Kurdish" fonts lack Sorani letters ([Wikipedia](https://en.wikipedia.org/wiki/Kurdish_typography)).
- **Look-alike characters.** ە (U+06D5) vs heh plus a zero-width non-joiner, and yeh/keheh variants that look the same but are different characters. Removing a zero-width non-joiner changes meaning. Check copy character by character, not by OCR ([r12a Sorani notes, updated 2026-05-04](https://r12a.github.io/scripts/arab/ckb.html)).
- **Digits.** Native Sorani digits exist, but most modern text uses ASCII digits (r12a), so this needs a brand rule.
- **Mixing Latin and Arabic.** Match the visual size, not the point size; Arabic usually needs to be set larger ([TypeTogether](https://www.type-together.com/multiscript-typography-guide)).

## 4. What Canva can do programmatically (checked 2026-09-23)

- **Canva MCP server.**
  - The [developer tools list](https://www.canva.dev/docs/apps/mcp/tools/) covers design generation, autofill, brand templates, resize, import, export, comments and edit transactions. It has no background-removal, effects, crop or frame tool.
  - Editing operations ([schema mirror](https://glama.ai/mcp/connectors/com.canva.mcp/canva/tools/perform-editing-operations)): replace or find-and-replace text, replace or insert media, delete, position, resize, format text, update title, update autofill field. Text formatting covers size, weight and style, but font family cannot be changed. Responsive pages allow only a subset.
  - Conflicting sources: Canva's [help centre](https://www.canva.com/help/mcp-canva-usage/) (search snippet only; the page blocked my fetch) says a new `edit_design` tool replaces the transaction tools and adds text and page insertion. The developer page fetched today still lists the old tools. Check the live tool list when you connect.
- **Canva REST (Connect) API**, from the [OpenAPI spec](https://www.canva.dev/sources/connect/api/latest/api.yml) fetched today:
  - **New: `POST /v1/image-transformations`.** It is a preview. The only transformation is `background_removal`. It needs the `background_removal` capability (Canva Pro or other premium plans), spends the user's AI credits, caps output at 10 MP, and is limited to 20 requests per minute per user. Preview APIs can change without notice and can't pass Canva's review for public apps.
  - Also in preview: `/v1/image-to-design-imports`, which runs Magic Layers to split a flat image into editable layers, and `/v1/merges` for page operations.
  - There are still no endpoints for masks, frames, shadows, duotone or other effects.
- **Apps SDK Design Editing API** ([docs](https://www.canva.dev/docs/apps/design-editing/)):
  - It reads and writes rectangles, shapes, text, groups and embeds, with position, rotation and transparency. Images are rectangles with a media fill; flipping is supported.
  - A shape with an image fill acts as a mask or frame. Limits: 1–30 paths, 2 KB of path data in total ([docs](https://www.canva.dev/docs/apps/creating-shapes/)).
  - No effects or crop properties are documented. Sessions expire after 1 minute and it runs inside the Canva editor in the browser.
  - Apps can replace an image with one they processed elsewhere ([image replacement](https://www.canva.dev/docs/apps/feature-examples/image-replacement/)).
- **Editor-only features** (a person must use them): BG Remover, Shadows including glow (with blur, direction, intensity and colour), [effects and quick styles](https://www.canva.com/help/effects-quick-styles/), Duotone, Magic Grab, Magic Expand.
- **PowerPoint import** ([help page](https://www.canva.com/help/powerpoint-import/), search snippet):
  - Charts, SmartArt, 3D objects, WordArt, animations and audio are dropped; fonts may be substituted.
  - No official statement on transparent PNGs, picture crops, shape-filled pictures or picture effects. Test with fixtures before relying on them.

## 5. Proposed operation catalogue for Hawa

Key: **J** = layout-JSON edit, **P** = pixel operation that makes a new image asset (original kept, with provenance), **D** = deterministic, **M** = uses a model.

| Group | Operation (parameters) | Kind | How to verify it was applied |
|---|---|---|---|
| Copy | `set_text(block, text)`, `add_block(role, text, style_from)`, `remove_block` | J·D | Exact character match in the JSON and after the Canva/PPTX round trip |
| Copy | `set_lang_dir(block, lang, dir)`, `set_line_breaks(block, breaks \| balance)` | J·D | Flag is present; rendered line count; no break inside a name, date or number |
| Copy | `insert_qr(url)` | J·D | Decoding the rendered QR code gives the URL |
| Type | `set_font_size(step)`, `set_weight`, `set_font_family(from approved list)` | J·D | No text overflow; every character is covered by the chosen font, with no fallback font |
| Type | `set_text_color(token)`, `set_alignment(start\|center\|end)`, `set_line_height`, `set_tracking` (Latin only) | J·D | WCAG contrast against sampled background pixels; tracking on Arabic script is rejected |
| Type | `emphasize_span(range, color\|weight)`, `set_hierarchy(ratio)` | J·D | Measured size ratio; importance-map rank |
| Layout | `move`, `align(edge\|center\|axis)`, `distribute`, `resize`, `reorder_z`, `swap` | J·D | JSON change touches only the declared fields; alignment score |
| Layout | `rebalance_whitespace(target)`, `set_margins(safe area)`, `mirror_for_rtl` | J·D | White-space fraction; largest empty band; everything inside the safe area |
| Layout | `reformat(size preset)` | J·D+M | The full QA gate runs again |
| Colour | `set_palette(brand)`, `set_background(color\|gradient)`, `add_scrim(block, opacity)` | J·D | Contrast passes |
| Colour | `regenerate_art(mood delta)` | P·M | OCR finds no text in the art; salient areas not under the text |
| Colour | `adjust_art(blur, darken, desaturate)` | P·D | Pixel statistics |
| Logo | `logo_scale`, `logo_corner`, `logo_variant(color\|mono\|white)`, `partner_strip(logos)` | J·D | Minimum size and clear space; partner logos at equal visual height |
| Photo (JSON) | `photo_replace`, `photo_crop(focus, zoom)`, `crop_to_face(padding)` | J·D (face box detected once at upload) | Face inside the frame and not covered by text |
| Photo (JSON) | `photo_mask(shape)`, `photo_fade`, `photo_shadow`, `photo_outline`, `photo_glow` | J·D | Geometry check; outline, glow and silhouette shadow need a cutout |
| Photo (JSON) | `photo_filter(bw\|duotone\|tint\|grade)` | J·D | Pixel colours sit on the target colour ramp; colour-difference check |
| Photo (JSON) | `align_heads(photos, headHeight, eyeLineY)` | J·D | Faces detected again on the render; spread is within tolerance |
| Photo (pixel) | `remove_background(photo)` | P·M | Share of opaque pixels in a sane range; a face is still detected; no halo. Otherwise send to a human |
| Photo (pixel) | `upscale(factor)`, `extend_canvas(side, px)` | P·M | Effective resolution reaches the target; faces flagged; generated areas labelled |
| Meta | `clarify(options)` for abstract requests, `cannot_do(reason)` | – | "Make it pop" gets 2–3 concrete variants, each built from the operations above |

Rules that apply to every operation:
- Each operation declares which fields it changes, and the validator rejects any other change.
- The full QA gate runs again after each batch of operations.
- Pixel operations never overwrite the original. They record the model, its version and a hash.

**Always send to a human designer:**
1. Retouching people (skin, body, clothing) and restoring low-res faces, where identity can change.
2. Adding or removing people, or combining people into one photo who weren't photographed together.
3. Cutouts that fail the automatic checks (hair, glass, busy backgrounds), and outpainting next to people.
4. Redrawing or vectorising a logo, new marks, custom lettering, Kurdish calligraphy.
5. Final translation and proofreading of Sorani or Arabic copy; flags, emblems, and religious or political imagery.
6. Rights questions (photo licences, sponsor logos) and print production (CMYK colour, bleed).
7. Abstract taste requests still unresolved after one round of variants.
