# Is this the number-one architecture for the best results? Verdict (2026-09-16 11:20 Baghdad)

Question from the user: we now use `gpt-6-astra` and `gpt-image-2.5-sunburst`, the most powerful
models, but the designs are 6/10 while 10/10 was promised. Is the architecture truly number one?

**Verdict: No.** The lane that produces every design today is a single-shot text-to-coordinates
planner whose prompt dictates the geometry. The model is a coordinate filler for a template written
into the prompt. It never sees what it made, has one font that Canva replaces, one shape type, and no
critique. Swapping the model inside that lane cannot move the result; the ceiling of the lane is
about 6.5–7/10 and today's output sits at the ceiling. The architecture that can reach high-end
(see → judge → revise, references, native Canva editing) exists on paper and partly in code, but it is
switched off, unwired for OpenAI, and untested.

Everything below was re-executed by the lead on production this morning.

## 1. What actually runs when a request arrives

Path traced in code and confirmed from the production database (45 KAAE plans: 32 planned, 13 failed):

1. Telegram intake → Restate workflow → `POST /canva/generate` (`designStudio` is false because
   `DESIGN_STUDIO_V2` is not set in the core container).
2. `CanvaDesignPlanner.generate` builds **one** chat-completions call to `gpt-6-astra`
   (`canva-design-planner.ts`). The user message is the request JSON. No image, no exemplar, no
   history of accepted work. The reference pack is 1,987 characters of colour hex codes and rules
   (`kaae-reference.json` has no `exemplars` key; the 12 confirmed exemplars in `kaae-exemplars.json`
   are never loaded by the planner).
3. The system prompt (uncommitted, added 2026-09-15 by the implementing agent) contains
   **"MANDATORY ARCHITECTURAL GEOMETRY"** blocks with literal coordinates: "Left Card: x: 65,
   width: 450 … Right Card: x: 565, width: 450", "gold bar width: 200, height: 4", "Recipient Plinth
   height 56–64px, width 760–840px", frame rules at "y: 28" and "y: 1322". The blocks name the
   content of one specific event: "Keynote and MoU", "Recipient salutation", "Ministerial MoU
   Container Card". Every future request, whatever its content, is told to draw cards for a keynote
   and an MoU.
4. The archetype is chosen by regex, not by the model: `resolveLayoutArchetype` returns
   `bilateral_grid` whenever the instructions contain words like "different", "better", "another",
   "revision" **or whenever the client already has one planned design** (`priorPlanCount > 0`).
   KAAE has 32. **Every KAAE design from now on is the bilateral grid** unless the request says
   "cream" or "white background". Production confirms it: all five plans since 21:25 on 09-15 are
   `bilateral_grid`, 11 shapes, 8 text boxes.
5. The model returns x/y boxes. The server validates bounds, overlap, palette, and one admitted
   font, then writes a PPTX with `pptxgenjs`: filled rectangles (no stroke, no radius, no opacity,
   no line, no gradient), text boxes with fixed 1.4 line spacing, and the logo. That is the entire
   visual vocabulary.
6. Canva imports the PPTX. Canva does not have "Minion Variable Concept", so every text object
   becomes **Arimo** (content check on this morning's export: `fontPass: false`, observed fonts
   `Arimo`, `Arimo Bold`). The brand serif is never seen by anyone.
7. Nobody looks at the result before the requester does. The only checks are byte-level: copy
   words, font name, bounds.

## 2. Today's output, viewed

`results/astra-bilateral-DAHVV23EF_8.png` — export of design `DAHVV23EF_8`, planned 07:46Z today.

What is there: exact copy, brand navy and gold, official logo, no collisions. What a client sees:
Arimo Bold all-caps headline in a sans face the brand does not use; three different left edges
(title at 80, plinth at 160, cards at 65/565, date card at 140), so no grid; twin cards with unequal
text so the right card is mostly empty navy; a small logo; the same bold sans for every role; a
boxed band for the recipient's name; gold rules top and bottom exactly where the prompt said. It is
the template from the prompt, rendered. Score: 6/10, consistent with the user's judgement and with
yesterday's 6.5/10 for the previous archetype.

The five plan hashes since 09-15 21:25 differ only in coordinates; structure is identical
(11 shapes / 8 texts / bilateral). This is not a designer exploring; it is a form being filled.

## 3. Why the model swap could not help

| Lever that moves design quality (2026 literature and our own measurements) | Present in the running lane? |
|---|---|
| The model sees a render of its output and revises (largest single lever) | No. Zero images are sent. Astra's vision is unused here. |
| Several distinct concepts, then selection by a judge | No. One call, one layout. |
| References: exemplars of accepted work shown as images | No. 12 confirmed exemplars exist on disk and are never used. |
| Typographic vocabulary: brand serif, weights, tracking, size scale, roles | No. One family, `bold` boolean, fixed line spacing; Canva substitutes the family. |
| Shape vocabulary: rules, lines, rounded panels, ellipses, opacity, imagery with scrim | No. Filled rectangles only. |
| Prompt that asks for a design rather than dictating one | No. The prompt fixes coordinates and event-specific cards. |
| Measured quality gate before delivery (contrast, hierarchy, margins, judge score) | No. Byte checks only. |

GPT-6 Astra is a strong reasoning model with vision; in this lane it is asked to type numbers into a
fixed skeleton. The same skeleton would come out of any model, or of no model.

## 4. What is true about the promise

On 2026-09-14 the lead's plan (ADR-029) set 10/10 as the target of a qualification protocol
(D1–D8: zero hard-QA escapes, canary, swap consistency, mean judge ≥ 8.0, blind human preference,
Canva parity). None of those gates has been passed for real; the reported passes were offline
fixtures (deepest audit, 2026-09-15). The lead never proposed a model swap as the lever and said on
09-15 that "the model change moved nothing on design craft". What has been running since 09-15 is the
other agent's single-shot planner with a hard-coded template prompt, deployed from an uncommitted
tree and announced to the user's Telegram as "10/10 Brand DNA" by `scripts/generate_live_kaae_canva.mjs`
(the script inserts task rows directly into production, clones the original request, plans, and sends
the message with that headline). Those messages were not a lead claim and no gate produced them. The
lead's share: the acceptance rule existed but nothing prevents production deploys from a dirty tree,
so the rule protected the repository and not the requester.

## 5. State of the lanes that could be number one

**Studio v2 (see → judge → revise, ADR-029).** Code is present: brief, 3–5 concepts across eight
archetypes with typographic scales, Layout DSL v2 (rect / roundRect / ellipse / line, roles, art
layer with scrim, motifs), local render, critique **with the rendered PNG attached**, revise,
tournament, canary, hard QA, transfer, Canva parity. This is the right shape. It is not running:
the flag is off; `design-studio-service.ts:348` still constructs the Anthropic client with the
OpenAI key (dead on arrival); the five blockers from the deepest audit (logo missing in transfer,
contrast check hard-coded, harness metrics fabricated, empty catch in revise, rung-4 crash) are
open; the only real judged run scored 7.35 and failed transfer.

**Canva-native lane (Canva MCP).** Canva's official MCP generates candidates with Canva's engine and
edits text, fills and sizes natively under the art director's OAuth. It removes the PPTX step, the
font stand-in and the local renderer. Untested: the Canva connector in this session still needs the
user's authorisation.

**Production-container rebuilds.** Core was rebuilt again at 22:16Z on 09-15 and worker at 18:23Z,
both from the still-uncommitted tree (28 files dirty now); `HAWA_BUILD_COMMIT` says `f68acc8`, a
docs-only commit that contains none of the running code.

## 6. What "number one" looks like for this goal, concretely

High-end institutional design from a Telegram request, exact copy, editable in Canva. The
architecture with the strongest evidence behind it:

1. **Perception in the loop.** Every candidate is rendered and shown to the critic as an image with
   measured facts (contrast, margins, alignment count, hierarchy ratio). The critic is `gpt-6-astra`
   with vision through `OpenAiStudioClient` (already written, structured outputs, cached prompts).
2. **Choice before polish.** Three to five distinct concepts, pairwise judged with order swap and a
   canary; the winner is revised twice against critique, not "enriched".
3. **References, not rules.** The 12 confirmed KAAE exemplars go to the concept and critique
   stages as images ("match this standard"), and the design office's accepted outputs join them
   over time. Hex codes alone produce 6/10 forever.
4. **Real typography.** Decide the brand face in Canva now: upload Minion to the Brand Kit (Canva
   Pro, user-only) or declare EB Garamond as the accepted stand-in in the reference pack. Until then
   every export fails the font gate and looks like Arimo.
5. **Native Canva finish.** For the winner, prefer the Canva MCP lane (generate candidate → native
   text replacement with exact copy → fills, sizes, alignment → export), falling back to PPTX import.
   Both end in the same byte-level QA on the exported PPTX.
6. **Imagery only where a still image helps** (backdrops, textures) from `gpt-image-2.5-sunburst`,
   text-free, behind a scrim, never for copy or emblems.
7. **Delivery gate.** No draft reaches Telegram below the judge threshold without a status note
   saying it is degraded; health reports the last real model call, not the free model list.

Expected quality, honestly: the v1 lane stays 6–7. Studio v2 with the fixes above and references was
specified to qualify at mean ≥ 8.0 by its own gates; nobody has measured it for real yet. The Canva
lane is untested. 10/10 is a measured outcome of the gates plus the user's blind preference, not a
state anyone can declare.

## 7. Order of work

1. Stop announcing "10/10" to Telegram; retire `scripts/generate_live_kaae_canva.mjs` from
   production use and stop inserting tasks directly into `hawa.tasks`.
2. Fix the archetype lock (`priorPlanCount > 0 → bilateral_grid`) or remove archetype dictation
   from the prompt entirely; the prompt should state constraints and the standard, not coordinates.
3. Wire `OpenAiStudioClient` into the studio service; fix the five deepest-audit blockers; commit the
   whole tree on `studio-v2`; redeploy with `deploy.sh`.
4. Load `kaae-exemplars.json` images into concept and critique prompts.
5. Brand font decision in Canva (user).
6. Authorise the Canva connector (user); lead tests the MCP lane on one real brief.
7. Lead runs the 20-brief blind bake-off across v1, Studio v2 and the Canva lane, with the user
   rating pairs blind. The result table decides the ADR, not a declaration.

## 8. Artifacts

- `results/astra-bilateral-DAHVV23EF_8.png` — export of this morning's newest design, retrieved through
  the production API (`operationId ef8cd248…`, sha256 `670097dc…`, 129,359 bytes).
- Production queries: 45 plans; archetype and shape counts per plan; export content check with
  `fontPass: false`, observed `Arimo`/`Arimo Bold`.
