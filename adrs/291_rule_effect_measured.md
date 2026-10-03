# ADR-291: What an Office Rule Does to the Next Draft, Measured

**Date:** 2026-10-03
**Status:** Implemented on branch `claude/ruleeffect` (from `claude/release-3` 46c55973). Not deployed.
**Requirements:**
- FR-017: versioned authoritative brand identity per client.
- FR-053: corrections may create scoped candidate rules.
- FR-054: only authorized humans activate, retire or supersede a Client DNA rule. An activated rule should then do something.

**Changes a foundation:** no. There is no migration, no new dependency and no model call.

**Number:** 291. It was checked free on 2026-10-03:
- `git log --all -- adrs` shows nothing above 290 on any local or remote branch;
- no file `adrs/29[1-9]*` exists in the main checkout or in any worktree under `.claude/worktrees`;
- no commit message names ADR-291 or higher.

Claude's block is 287–299.

## 1. Question

`APP_SECTION_RATINGS.md` section 14 (2026-10-02), gap 3: "Measure rule effect (does an active rule change the next draft?)". Nothing measured it.

This ADR answers it from the code and from a free harness that runs the real stage code with a recording client in place of the models.

## 2. The path, traced

### Where a rule is stored

| Store | Written by | Shape |
|---|---|---|
| `hawa.client_rules` (standing rules) | `/rules` and chat (`telegram-rules-intake.ts`), guideline PDFs (`ClientRulesRepository.save`) | The office's words. `machine_rule` holds only `{source}`: nothing writes structured parts. |
| DNA `guidelines.layoutRules` | The Desk's DNA Rules tab (`DnaScreen.tsx` `handleAddLayoutRule`), and governed-learning promotion (`learning-governance.ts:179`, a new DNA version plus a `client_rule.promoted` audit row) | Words |
| DNA structured values | DNA save | `colors[].hex`, `fonts[]`, `assets[logo_primary].minimumWidthPx/clearSpacePx` |

### How a run reads them

Run start: `design-studio-service.ts:1523` → `createStageContext` → `withClientRules(…, run.created_at)`.

**`createStageContext`:**

- **The packaged reference (KAAE).** `client-design-reference.ts:66` returns `kaae-reference.json` and never reads the DNA row.
  - `promotedRules` is the reference's `colorUsage` (`design-studio-service.ts:1269`).
  - The palette, fonts and logo rules come from the packaged file.
- **A DNA client.** `promotedRules = JSON.stringify(layoutRules)` (`:1292`).
  - The palette, fonts and logo constraints go to `referencePack` (`client-design-reference.ts:130-145`).

**`withClientRules` (`:973`):**

1. It takes the standing rules in force at run start (`listInForceAt`).
2. ADR-291 adds the learned rules described in section 5.
3. `formatClientRulesForPrompt` (`client-rules.repository.ts:165`) quotes each rule as data.
4. The result goes to `ctx.clientRules` and is appended to `ctx.promotedRules`.

### Who reads `promotedRules` / `clientRules` on the v3 production path

| Reader | Reads | Location | Code or model |
|---|---|---|---|
| Brief, system prompt | `promotedRules` | `prompts.ts:16` (`<<<PROMOTED_RULES>>>`) via `brief.stage.ts:171` | model |
| Brief, user prompt | Only when `clientRules` is set: "fill styleSpec from the rule … list each rule you applied in `must`" | `brief.stage.ts:207` | model |
| Brief, deterministic tone | `tonePreferenceFromWords(ctx.instructions)`, the request's words only | `brief.stage.ts:232` | code (the request, not the rules) |
| Brief contract | `rule/client` as a hash, `enforcedBy: ['model_instruction_only']` | `packages/domain/src/brief-contract.ts:189`, `:337` | none |
| Layout model | "Client house rules (…): promotedRules" | `layouts.stage.ts:628` (`layoutBriefV3`) | model. **Not called** for a KAAE text-only poster: three composed candidates suffice (`layouts.stage.ts:239`, ADR-271). |
| Style values | `ctx.style` = the brief's `styleSpec` → `prepareGeneratedLayoutV3` → `conformToStyleSpec` (`pipeline-v3.ts:1429`) → `applyStyleSpec` (`style-spec.ts:170`) | | code, for model-drawn layouts. A ladder drops a movement decision that adds a defect. |
| Composed poster | `composedGrammarCandidates` prepares with no `style` (`layouts.stage.ts:549`); `prepareGeneratedLayoutV3` returns early for a composed layout (`pipeline-v3.ts:863`). Only `requestedBackground` reaches it, through `grammarChoices` (`layouts.stage.ts:487`). | | code: background only |
| Visual review (Sol) | `[promotedRules, clientRules]` | `v3.stage.ts:505` → `visual-review-v3.ts:277` "Client design rules" | model |
| v3 judge | `houseRulesFor` (`v3.stage.ts:408`): the art-direction rules and the guideline-fidelity rule, **no client rule** | `v3.stage.ts:446` | model, without the rules |
| Refinement (`refineCandidateV3`) | No rules | `v3.stage.ts:379` | |

**The DNA structured values** are enforced by code:
- The palette: preparation snaps every colour to it (`conformToHouseRules` / `conformColoursOnly`), and hard QA's PALETTE rule checks it.
- The logo minimum width: the composer sets the logo at it (`poster-grammar.ts:264`). Hard QA's LOGO rule refuses a model layout under it.

## 3. Finding: no code reads a rule's words

Every office rule changes a draft only as far as a model reads it.

The one path from words to an enforced value runs through the brief model. The brief turns a rule into a `StyleSpec` value, and preparation then enforces that value. Preparation has no deterministic reader for a rule's words, of the kind `tonePreferenceFromWords` is for the request's words.

So every standing rule, learned rule and DNA layout rule is **prompt-only up to the brief**. Whether the brief model follows it is unverifiable without a model.

## 4. Measured: the harness

The harness is `apps/core/test/rule-effect-harness.test.ts`. It has 14 tests, takes about 30 s and makes no model call. The measured table is in `plans/rule-effect-2026-10-03/rule-effect.json`; set `HAWA_RULE_EFFECT_OUT` to rewrite it.

For each rule kind:

1. **Reach, with and without the rule.** The harness runs `runBriefStage`, `buildRunBriefContract`, `layoutBriefV3`, `runLayoutsStage`, `runRenderStage`, `runVisualReviewStageV3` and `houseRulesFor` with a recording client.
   - Without the rule, every reader is clean.
   - With it:
     - brief system prompt: yes
     - brief asked for style values: yes
     - brief contract `rule/client`: yes
     - layout prompt: yes, but no layout call is made for the composed poster
     - visual review prompt: yes
     - judge: **no**
2. **Code reading.** With a brief model that ignores the rule, no code applies it: the `styleSpec` stays neutral, there is no tone and no ground.
3. **Enforcement of the value a faithful brief sets.** This is measured against the same run without it, on the two text-only paths:
   - model-drawn layouts (a client without a page grammar);
   - KAAE's composed poster (page grammar with poster rules).

Each cell shows candidates with the rule / without the rule, of 3.

| Rule kind (example words) | StyleSpec value | Model-drawn layouts | Composed KAAE poster | Status |
|---|---|---|---|---|
| Logo placement ("logo in the bottom-right corner") | `logoCorner` | 1 / 0, enforced on 1 | 0 / 0, **ignored** | prompt-only, then partly enforced |
| Typeface ("sans-serif only") | `typeface` | 3 / 0, enforced | 3 / 3, already sans (ADR-275), unchanged | prompt-only, then enforced |
| Type weight ("titles regular, not bold") | `titleWeight` | 3 / 0, enforced | 0 / 0, **ignored** | prompt-only, then enforced on model layouts only |
| Alignment ("centre every line") | `alignment` | 3 / 1, enforced | 0 / 0, **ignored** | same |
| Title colour ("titles in darkest navy") | `titleColor` | 2 / 0, enforced on 2 (contrast guard on the navy band) | 0 / 0, **ignored** | same |
| Forbidden element: dividers | `dividers` | 3 / 0, enforced | 0 / 0, **ignored** | same |
| Forbidden element: cards behind copy | `panels` | 3 / 0, enforced | 1 / 1, **ignored** | same |
| Background colour ("always cream") | `requestedBackground` | 3 / 1, enforced | 3 / 1, **enforced** (the cream poster is offered first) | prompt-only, then enforced on both |
| Type case ("titles in capitals") | none | n/a | n/a | **prompt-only; unverifiable without a model** |
| Forbidden colour pairing ("never gold text on white") | none | n/a | n/a | **prompt-only; unverifiable without a model** |
| Wording ("never use exclamation marks") | none | n/a | n/a | **prompt-only; unverifiable without a model**. The copy is the requester's exact text. |
| Imagery ("no stock photos of people") | none | n/a | n/a | **prompt-only; unverifiable without a model** |
| DNA palette | `referencePack.palette` | every colour in it; a narrower palette changes the draft | same | **applied deterministically** |
| DNA logo minimum width | `logoConstraints.minimumWidthPx` | not resized; hard QA refuses an undersized logo (LOGO) | set at the minimum | **applied deterministically** |

**Where the unverifiable rules reach a model.** These are the exact prompt locations:
- the brief system prompt (`prompts.ts:16`);
- the brief user prompt (`brief.stage.ts:207`);
- the layout prompt (`layouts.stage.ts:628`), when it is sent;
- the visual review (`visual-review-v3.ts:277`).

The harness pins every number above. A change to any path flips a test and must update this table.

## 5. Decision: rules learned from feedback reach a packaged-reference client's next draft

**The drop.** A promotion (Desk candidate list → Promote) writes the rule into the DNA row's `layoutRules`, and records `client_rule.promoted`. The studio reads the DNA row only for a DNA client. For KAAE the row is never read (`client-design-reference.ts:66`). A promoted KAAE rule was therefore:
- stored;
- shown in the Desk as active;
- read by no design.

`apps/core/test/rule-effect-learned-rules.test.ts` failed 4 of 4 before the fix.

**The fix.**
- `withClientRules` now also reads, for a run whose reference pack is the packaged one, the promotions in force at the run's start. This uses `listLearnedRulesInForceAt` in `apps/core/src/services/rule-effect.ts`:
  - the latest moderation of each candidate at or before the run's start, as `learning-recovery.ts` orders them (rule revision, then time);
  - kept when it is `client_rule.promoted`.
- They merge with the standing rules into one list, oldest first, so the later rule wins. The same words said twice appear once.
- They go into `clientRules` and `promotedRules`, so the brief is asked to turn them into style values, the brief contract names them and the visual review reads them.
- A DNA client already has its promotions in its reference and is unchanged.
- `contextWithClientRules` is the one place both reach the context.

**Why the promotion record, not the whole DNA list.** KAAE's DNA list (`config/clients/kaae.dna.json`) holds nine pack-era rules:
- two demand copy the studio must never invent: the slogan, and a legal citation;
- one sets Crimson Pro serif titles, which ADR-275 superseded for posters.

Feeding the whole list would change every KAAE design in ways nobody has reviewed. That is section 14's gap 1 ("make the DB DNA row the studio's input"), an owner decision. A promotion is a rule an authorized reviewer activated deliberately (FR-054).

**Consequence.** A KAAE run already pinned (ADR-112) before deployment, if production has KAAE promotions in force, resumes with a different visual policy and holds `STUDIO_VISUAL_INPUTS_UNSAFE`. This is the same trade-off ADR-127 recorded for standing rules. Production's KAAE promotions are unknown here: no production SQL was run. The ops metric (section 7) lists them before deployment.

## 6. Gaps left open, for the owner

1. **The composed KAAE poster ignores every style value but the background.** This covers logo corner, title weight, alignment, title colour, cards and dividers.
   - The brief prompt tells the model these values "are enforced on the design". On KAAE's main path (text-only posters, ADR-271) they are not.
   - Whether an office standing rule overrides the guideline's grammar (the logo top-left in the header, the band, the cards) is a design precedence decision. ADR-271 has the owner's visual sign-off.
   - Options:
     - (a) apply the values the grammar can honour without a defect, with the composer's own checks;
     - (b) when the brief sets a value the grammar cannot honour, also call the layout model so a model-drawn candidate that honours it competes (one more call);
     - (c) keep as is and tell the office.
2. **The v3 judge is not shown client rules.** It picks the winner by the art-direction and guideline rules only. A candidate that honours a rule wins no credit for it. Passing the rules as numbered house rules (`houseRulesBroken` already exists) is a small change, but it changes the judge prompt.
3. **KAAE's DNA list itself.** The Desk Rules tab, and the pack-seeded rules not promoted, are still not read for KAAE. Now the Desk says so (section 7). Gap 1 of section 14 decides it.
4. **A DNA client's layout rules are weaker than standing rules.** They reach the system prompts and the visual review as a JSON list. The brief is not asked to turn them into style values, and the brief contract does not name them. No production client takes this path today (production has DNA for one client, KAAE, which is packaged).
5. **The style-value schema contradicts the rules prompt.** `STYLE_SPEC_SCHEMA` (`style-spec.ts:65`) tells the model a value comes from "the client's instructions only". The brief prompt (`brief.stage.ts:207`) tells it to fill values from standing rules.
6. **Preparation's defect ladder silently drops a logo corner.** On 2 of 3 model layouts it gives up the corner because moving the logo adds a defect. That is by design, but the office is not told.
7. **Structured rule parts.** `client_rules.machine_rule` was meant for "structured parts code can enforce" and is never written. A deterministic reader for a small vocabulary (logo corner, no dividers, no cards, sans or serif, a named ground), like `tonePreferenceFromWords`, would make those kinds "applied deterministically" without the brief model. English-only words would leave Sorani rules prompt-only. Not done here.

## 7. Ops metric

**What is reported.** `clientRuleEffect` (`rule-effect.ts`) reports, per client:
- the reference it designs from (`client_dna`, `packaged` or `none`);
- every active rule, with its source (`standing_rule`, `learned_rule`, `dna_layout_rule`, `dna_brand_value`), a status (`applied_deterministically`, `prompt_only`, `dropped`) and a note saying why;
- the counts.

**Where it is exposed.** It is added to the existing `GET /v1/clients/:clientId/candidate-rules` response as `ruleEffect`, which the Desk's DNA screen already reads. It is null when it cannot be read; the candidate list does not depend on it. It reads under the caller's RLS scope and needs no migration.

**The Desk.** The DNA screen's Rules tab labelled every layout rule "Hard QA Invariant". That was false: no layout rule is checked by QA. The pill now shows Core's status ("Applied by code", "Read by the models only", "Not used in designs", or "Effect not read"), with Core's note as its tooltip.

For KAAE today the report shows:
- every standing rule and promotion as `prompt_only`, with the composed-poster caveat;
- the pack's DNA layout rules as `dropped`;
- the DNA palette as `applied_deterministically` (the packaged reference has the same set).

## 8. Evidence

**Tests:**

| Test file | Tests | What it covers |
|---|---|---|
| `apps/core/test/rule-effect-harness.test.ts` | 14 | Sections 3–4 |
| `apps/core/test/rule-effect-learned-rules.test.ts` | 4 | Section 5 through Core's own propose, promote and roll-back routes, and the endpoint; failed 4/4 before the fix |
| `apps/desk/test/dna-rule-effect.test.ts` | 3 | The pill |

**Related suites, re-run:**
- `client-rules`, `kaae-2025-guideline`, `design-studio-orchestrator`;
- the learning governance, recovery, scope and lifecycle tests;
- `client-pack-rows`, `studio-visual-inputs`;
- the Desk DNA and client tests.

**Measured table:** `plans/rule-effect-2026-10-03/rule-effect.json`.

No model was called, no production database was read, nothing was deployed.
