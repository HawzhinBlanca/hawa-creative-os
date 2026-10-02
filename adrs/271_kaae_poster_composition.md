# ADR-271: KAAE Posters Are Composed Like the Office's Posts, Not Like the Guideline's Pages

**Date:** 2026-10-02
**Status:** Implemented on branch `claude/design-retarget` (from `claude/hawzhin-support`); not deployed. Needs the owner's visual sign-off (section 6).
**Requirements:** FR-017 (authoritative brand identity), FR-013 (the brief carries the request), FR-038 (hard QA gates what ships).
**Changes a foundation:** no. No migration, no dependency, no new model call. One fewer model call per KAAE text-only design (section 3).
**Amends:** ADR-238 sections 4-5 (composition and who uses the grammar) and section 11 (the guideline prior). ADR-238's palette, faces, logo rules, brand elements and light-first logic stand.

## 1. Context

The design review of 2026-10-02 scored shipped KAAE designs about 3/10. A text-only brief got the guideline's document page at poster size: a white page about 84% empty, a 64-78px title on a 1080 canvas, a logo at 0.12 of the width, and two of three candidates the same layout. The office's own published posts are bold: big display type, navy or cream grounds, a clear focal point.

Root causes (base `5b3828d8`):

- `kaae-reference.json` `colorUsage` (line 56) took the guideline's interior pages as the poster composition. `artDirection` (line 259) said "With no photo, type, cards and rules are the design".
- The title was capped at `title.sizeShare` 0.08 and could only shrink (`page-grammar.ts:296`, "restrained, never shouted"). Room left over went to the foot (`:600`). The header logo was 0.12 of the width (`kaae-reference.json:77`).
- `layouts.stage.ts:485` composed only the two page variants (or two covers).
- `guidelinePrior` (`prior.ts:82`) overruled any judge pick short of 0.75 of the votes in both orders (`GUIDELINE_CLEAR_MARGIN`, `:106`; wired at `pipeline-v3.ts:1941-1948`).
- The typographic judge (`pairwise-judge-v3.ts:234-246`) rewarded restraint and had no criterion for impact, thumbnail reading or fit to the request.
- The negative-space band passes up to about 0.84 empty (`negative-space-policy.ts:45`).
- Typographic retrieval saw only the owner-confirmed set (`exemplar-retrieval.ts:271-273`), never the office's bold posts.

## 2. Decision: the guideline sets the brand, the office's posts set the poster

`rules.pageGrammar.poster` (new, admitted with the grammar, every colour in the palette):

- the title's range, 0.10-0.18 of the width; the logo at 0.16 (the house's 100px minimum and the K clear space still apply); the gold bar at 0.16; a negative-space ceiling of 0.65;
- three compositions (`poster-grammar.ts`, `composePosterLayout`):
  - **navy:** the cover's gradient, a big white serif title, a Sun lead, white details, a gold pill for the call to action, a Sky sunburst at 0.35;
  - **cream:** a cream ground, a Royal serif title, the details on a Royal card with a Sun first line, a KAAE Blue pill, a gold sunburst at 0.32;
  - **band:** the white page with a full-width navy-gradient band holding the white title, the gold bar bridging its edge, details on a KAAE Blue card, the foot rule.

The title takes the largest size, within the range, at which the copy fits and the measured negative space stays between the studio's floor (0.40) and the ceiling (0.65). The sunburst takes the first free corner that holds a third of the short side. A poster keeps the guideline's own clear space (the height of the K), as a cover does.

The guideline's page stays as an option. With poster rules, its title also grows within the range (falling back to the grammar's own size only when nothing fits) and its logo is 0.16. A page with a photo keeps the grammar's own title size, so the photo stays the focal point; at poster size the title halved the photo in the proof.

`colorUsage` and `artDirection` now say this. Light first stays the default.

## 3. Decision: who gets which composition

`grammarChoices` sets the order, and the stage takes the first three feasible, each a different composition:

| Brief | Compositions offered |
|---|---|
| no tone named | band, cream, navy, then the page |
| white named | band, page (KAAE Blue card), page (white cards) |
| cream named | cream, band, page |
| dark | navy, cover (pattern), cover (sunburst) |

With three composed, the layout model is not called; its restyled layouts were the ones cut. A grammar without poster rules behaves as under ADR-238.

## 4. Decision: selection

- **The guideline prior is a tie-break only.** It is consulted where the judge did not decide or failed its canary. A reliable judge's pick stands.
- **The judge reads posters as posters.** `posterImpact` is set for a grammar with poster rules. It adds three criteria:
  - hierarchy: one dominant display moment that still reads at a 300px thumbnail;
  - composition: a clear focal point, with a near-empty or document-like poster counted as weak;
  - brand_fit: fit to the request.
- **Other clients' prompts are byte-identical.**
- **The fidelity rule changes.** A poster needs only the gold bar, not the document header (`guidelineDeviations`, `guidelineFidelityRule`).
- **Office exemplars are not shown to the judge.** The judge has one image slot, for the requester's own reference. More images would add vision cost that the reservation does not hold. Left open.

## 5. Decision: retrieval

`officePosters` lets a text-only brief's retrieval include the office's published posts, with at least one in the brief's script. Core sets it for a reference with poster rules. These references reach the critique and, when it runs, the layout model. Photo briefs and other clients are unchanged.

## 6. Proof and what stays open

**Deterministic renders, no paid calls.** Six briefs were rendered: three English, two Sorani and one with a synthetic photo. The montages put BEFORE (the shipped page) beside AFTER and two office posts, in the session scratchpad (`design-retarget/montage_*.png`).

On AFTER, the title is 0.10-0.18 of the width (before 0.072), the logo 0.16 (before 0.12) and the measured negative space 0.41-0.64 (before up to 0.89). Hard QA passes on every AFTER render. The core test `kaae-2025-guideline.test.ts` writes the stage's own renders when `HAWA_KAAE_2025_PROOF_OUT` is set.

**Tests:**

- new `packages/creative/test/kaae-poster-compositions.test.ts` (20 tests);
- updated: the selection, guideline, title-colour and orchestrator tests, and `apps/core/test/kaae-2025-guideline.test.ts`.

The new selection test fails on the base (the prior overruled a 3-2 judge).

**Open:**

- **Owner sign-off.**
  - The navy poster is offered for briefs that name no tone. The owner's light-first rule had kept navy for dark briefs.
  - The cream poster and the band are new compositions, not the guideline's pages.
- The Sorani band is infeasible for short two-block copy (its band is too full for the floor). The stage offers the next composition instead.
- There is no photo or illustration for a text-only brief. The office's posts carry a photo; ours carry the sunburst.
- No live run was made.

## 7. Addendum (2026-10-02): the owner's review, fixes 1-3

The owner reviewed the montages and asked for three fixes on this branch.

**1. The details were small under a poster title.**
- *Problem:* the date, the place and the lead were 38-40px under a 122-191px title (0.035-0.037 of the width). At thumbnail size they nearly disappeared.
- *Fix:* the poster rules gain `detailSizeShareMin` (KAAE 0.04, about 16 points on a phone). The details take the first step of the type scale at or above it, now 44-50px.
- *Fallbacks:*
  - A composition that cannot hold them there keeps the old step rather than dropping out. Today that is the band under a long Sorani title, at 36px.
  - When no title step lands under the 0.65 negative-space ceiling with the larger details, the nearest one over it is kept (a Sorani navy poster, 0.653).
- *Wrapping:* a date or a place is never broken over two lines while the details card can take the content width.

**2. The band left an empty foot, and the Sorani band rarely fit.**
- *Short copy:* with no details, the band's head is set low, and the room above holds the sunburst. Before, the lead ended at 1060px of 1350, over 230px of empty page.
- *Band width:* the band now runs from the edge the title starts at to a margin past its longest line, as the office's title tabs do (from the right in Sorani). It stays full width when only a sliver would remain beside it.
- *Sorani:* the two-block Sorani workshop now fits.
- *Still open:* a three-line Sorani title fills the width, and the full band stays too dense for the studio's floor. The negative-space metric adds a band and the title on it as two areas, and that metric was left unchanged. That brief gets navy and cream.

**3. In Sorani, the middle dot read as a zero.**
- *Problem:* between Eastern Arabic digits, " · " reads as their zero, so "2026 · 9:30" in those digits read as one number.
- *Fix:* `groundLine` (`request-copy-extraction.ts`) joins the spans of an Arabic-script line, or of a line with those digits, with the Arabic comma, through `joinerFor`. Latin lines keep " · ".
- The requester's own characters are unchanged; only the joining mark the system adds changes.
- The native Sorani review should confirm the comma.

**Alignment guard.**
- *Problem:* while fixing 1, one Sorani navy poster measured 0.688 on hard QA's alignment check (limit 0.70). Its gold bar's and pill's free ends lined up with nothing.
- *Fix:* both now end on a grid line. The pill grows to the next line, with its text centred. The composer also refuses a layout that fails `computeLayoutMetrics(...).alignmentScore`, so QA never sees one.

**Proof.** 20 of 21 deterministic renders pass hard QA; the one exception is the Sorani three-line band, which does not compose. Tests: `kaae-poster-compositions.test.ts`, 23 tests (three new), and `request-copy-extraction.test.ts`, one new.
