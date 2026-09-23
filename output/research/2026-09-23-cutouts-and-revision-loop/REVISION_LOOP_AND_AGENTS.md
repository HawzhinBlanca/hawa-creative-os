I researched this on the web and wrote nothing to the repository or the vault. I did read two vault notes from 2026-09-23 (`_raw/2026-09-23-hawdesign-directed-edits-voice-and-drive-fallback.md` and `…-telegram-understanding-rules-delivery.md`) so the advice builds on fixes that already exist. Claims marked **[vendor]** come from the maker's own marketing. Claims marked **[inferred]** are my own reasoning.

# Hawa revision loop: research report (2026-09-23)

## Summary

- **No product documents what it does with a request it cannot fulfil, or tracks each request until approval.** The nearest are Figma Make's plan mode (asks questions, then waits for you to click Build), Photoshop's assistant (proposes steps and waits for confirmation) and Figma's published list of what its agent can't do.
- **Research agrees on one design.** An editable structured layout, an explicit list of what may change and what must stay, deterministic checks on the rendered result, and repairs limited to the failed element.
- **LLMs make assumptions and over-edit. Reasoning models are more likely to call tools that don't exist.** "Unsupported" has to be an allowed output in the schema, and the status message has to come from checked results, never from what the model says it did.
- **Hawa's 2026-09-23 failure is four separate faults:**
  1. The capability gap was written only in free-text notes.
  2. Changes outside the request were not reverted. The restore step added that day covers colour, accent, font, weight, spacing and opacity, but not position or size **[inferred]**.
  3. The "your change was made" message was not tied to anything that was checked.
  4. State was lost across rounds (the photos).

## 1. How current products handle revisions and their limits

| Product | Multi-turn edits and scope | Asks questions, plans, shows options | When it can't do something | Tracks requests until approval |
|---|---|---|---|---|
| **Canva** (Design Model, [30 Oct 2025](https://techcrunch.com/2025/10/30/canva-launches-its-own-design-model-adds-new-ai-features-to-the-platform/); AI 2.0, [16 Apr 2026](https://www.siliconreport.com/canva-pushes-ai-up-the-stack-with-editable-layers-and-tool-orchestration-e58e52c879613d2e)) | Layered, editable output. Prompts can target specific images, text or fonts. Keeps a memory of styles. | Not documented | Not documented | Not documented |
| **Adobe Express assistant** ([28 Oct 2025](https://news.adobe.com/news/2025/10/adobe-max-2025-express-ai-assistant)) | Edits any single layer "while keeping the rest intact". | Offers follow-up suggestions. | The FAQ reportedly says it does not support every feature and does not hold a back-and-forth dialogue. The page blocked me, so this comes from a search summary only. | Not documented |
| **Photoshop assistant** (beta, [12 Mar 2026](https://www.photoshopnews.com/2026/03/12/adobe-photoshop-ai-assistant-public-beta)) | Chains existing tools. | For complex edits it proposes a sequence of steps and waits for confirmation. | Cannot use tools missing from the web version. What the user sees then is not documented. | Not documented |
| **Firefly AI Assistant** ("Project Moonlight"; [15 Apr 2026](https://blog.adobe.com/en/publish/2026/04/15/introducing-firefly-ai-assistant-new-way-create-with-our-creative-agent), public beta [27 Apr](https://blog.adobe.com/en/publish/2026/04/27/firefly-ai-assistant-public-beta)) | Orchestrates 60+ tools across apps, including Remove Background. Output stays in editable native formats. | The user "stays in the loop" and can step in. | Not documented | [TheNextWeb](https://thenextweb.com/news/adobe-firefly-ai-assistant-creative-cloud-agentic-workflows) says Frame.io approval workflows feed into it. |
| **Figma agent / Make** (help pages, undated) | Works on selected layers; undo from chat. | Make's [plan mode](https://help.figma.com/hc/en-us/articles/40830441709719-Use-plan-mode-in-Figma-Make) asks clarifying questions and writes an editable plan. Nothing is built until the user clicks Build. | [Publishes a list](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files) of unsupported features (vector editing, prototyping, asset export) | Not documented |
| **Lovart** ([28 Jul 2025](https://www.lovart.ai/news/lovart-design-agent-public-launch-chatcanvas)) | "Touch Edit updates only the named element" **[vendor]** | Asks clarifying questions **[vendor, [blog](https://www.lovart.ai/blog/ai-design-agent-explained)]** | Not documented | Clients can comment on specific elements through a share link **[vendor, [blog](https://www.lovart.ai/blog/03-career-chatcanvas-client-review)]** |
| **Recraft** ([8 Dec 2025](https://www.recraft.ai/blog/introducing-chat-mode-create-through-conversation)) | Chat plus manual editing; shows variations side by side. | Suggests next steps. | Not documented | Not documented |
| **Kittl** (Jul/Aug 2026; the two sources give different dates, [blog](https://www.kittl.com/blogs/agentic-ai-is-live-in-kittl/)) | Up to 4 variations; Edit Area uses a brush to mark the part to change. | Fills gaps on its own; no questions documented. | Not documented | Not documented |
| **Pomelli** ([Google, Oct 2025](https://blog.google/innovation-and-ai/models-and-research/google-labs/pomelli/)) | Manual edits to text and images; builds a "Business DNA" profile of the brand. | Not documented | Not documented | Not documented |
| **Manus Design View** ([docs, ~Dec 2025](https://manus.im/docs/features/design-view)) | A Mark tool selects a region, then you type or speak the change. | Not documented | Not documented | Not documented |
| **Genspark AI Designer** ([guide](https://app.therundown.ai/guides/create-inspiring-designs-with-genspark-ai-designer)) | Edit by clicking an element or by describing the change. | Not documented | Not documented | Not documented |
| **Microsoft Designer** ([FAQ](https://support.microsoft.com/en-us/designer/frequently-asked-questions-about-microsoft-designer)) | Conversational editing not documented. | Not documented | The FAQ only warns generated text may be misspelled. | Not documented |

**What the products share:** they make scope visible (layer or region selection, marking an element), they show options, and they either run a plan-then-confirm step or leave the design editable by hand as the escape route. None publishes a per-request status, an "I can't do this yet" behaviour, or a hand-off to a human. Hawa can do better than all of them on this point.

## 2. Research on generating and editing designs as structured layouts

**Representation.** The strongest systems output an editable structured specification, not pixels:
- Layout as code or JSON: [LayoutGPT](https://arxiv.org/abs/2305.15393) (May 2023), [LayoutNUWA](https://arxiv.org/abs/2309.09506) (Sep 2023), [PosterLlama](https://arxiv.org/abs/2404.00995) (Apr 2024), [Graphist](https://arxiv.org/abs/2404.14368) (Apr 2024) and [MarkupDM](https://arxiv.org/abs/2409.19051) (Sep 2024).
- [COLE](https://arxiv.org/abs/2311.16974) (Nov 2023) and [OpenCOLE](https://arxiv.org/abs/2406.08232) (Jun 2024) generate multi-layer designs in stages.
- [CreatiPoster](https://arxiv.org/abs/2506.10890) (Jun 2025) produces a JSON spec for every layer, then generates the background to fit the rendered foreground. Hawa already works this way.
- [LaDeCo](https://arxiv.org/abs/2412.19712) (Dec 2024, CVPR 2025) plans layers first and feeds the rendered earlier layers back into the model.
- [BannerAgency](https://arxiv.org/abs/2503.11060) (EMNLP 2025) outputs editable Figma or SVG components.
- On the pixel side, [DesignEdit](https://arxiv.org/abs/2403.14487) (Mar 2024) splits the image into layers before editing it.

**Patterns that best keep edits to what was asked:**
1. **Declare what may change and what must stay, before editing.** [SlideForge](https://arxiv.org/html/2609.03109) (2 Sep 2026) grounds each instruction to a "target scope" and a "preservation scope", edits with native slide operations, checks the rendered result, and repairs only the failing parts. It beats direct prompting, screenshot agents and generic code agents on preservation and editability.
2. **Review against the rendered image, in a loop.**
   - [VASCAR](https://arxiv.org/abs/2412.04237) (Dec 2024) refines layouts from renders.
   - [VFLM](https://arxiv.org/abs/2603.22187) (Mar 2026, CVPR 2026) finds that generating layout code without seeing the render leaves the model blind to the outcome.
   - [DesignLab](https://arxiv.org/abs/2507.17202) (Jul 2025) splits the work into a reviewer that finds problems and a contributor that fixes them.
3. **Deterministic checks first, a VLM second, repair capped.** [PosterMELD](https://arxiv.org/abs/2608.02218) (3 Aug 2026) sends failures to bounded repair and reaches an 81.3% print-ready rate at $0.38 per request. It also points out that many systems "hide request-level failures by scoring only completed outputs". Count failures per request.
4. **Let the user decide.** [PROS](https://arxiv.org/abs/2609.01813) (1 Sep 2026) lets users choose which detected problems to fix. 87.6% of accepted targets were resolved, yet 14.8% got worse. Record "resolved" and "outcome improved" as separate measurements.
5. **Learn procedures from real traffic.** [Designer-RSI](https://arxiv.org/abs/2609.22086) (Sep 2026) raised execution success from 72.7% to 99.3% using a memory of design procedures drawn from user traffic.

**Caveats:**
- Splitting a complex edit into sequential steps made results worse on the Complex-Edit pixel-editing benchmark ([Apr 2025](https://arxiv.org/abs/2504.13143)), because errors compound. A [May 2026 follow-up](https://arxiv.org/abs/2605.09233) found that doing everything in one pass causes unwanted edits. Hawa applies deterministic operations to JSON, so pixel errors should not compound the same way **[inferred]**.
- VLM judges miss small details:
  - [GPT evaluation of design principles](https://arxiv.org/abs/2410.08885) (Oct 2024) correlates reasonably with humans, but the models "cannot distinguish small details".
  - [VIEScore](https://arxiv.org/abs/2312.14867) (Dec 2023) struggles on editing tasks.

  Geometry, contrast and copy checks should stay deterministic.

## 3. Agent patterns for capability gaps and honesty

- **Models misjudge whether a task is possible, and invent tools or outputs.**
  - On [ToolBeHonest](https://arxiv.org/abs/2406.20015) (Jun 2024) GPT-4o scored 37/100. The main error was judging whether the task could be solved at all.
  - [When2Call](https://arxiv.org/abs/2504.18851) (NAACL 2025) tests when to call a tool, when to ask, and when to say the tools can't do it.
  - ["The Reasoning Trap"](https://arxiv.org/abs/2510.22977) (Oct 2025) found that stronger reasoning increases tool hallucination.
  - [ToolFailBench](https://arxiv.org/abs/2607.04686) (Jul 2026) labels "Output-Fabrication" as a failure type of its own.
  - [OpenAI's Kalai et al.](https://arxiv.org/abs/2509.04664) (Sep 2025) argue that evaluations reward guessing over saying "I don't know". [Abstention survey](https://arxiv.org/abs/2407.18418) (Jul 2024).
  - **Implication:** make "unsupported" a first-class, scored output.
- **A strict schema guarantees shape, not truth.** [Structured Outputs](https://openai.com/index/introducing-structured-outputs-in-the-api/) (6 Aug 2024) guarantees schema adherence. If the schema has no cutout field and no "unsupported" field, the model can only do something else and stay silent, which is what happened **[inferred]**.
- **Typed tools, gates and stopping rules.**
  - Anthropic's [*Building effective agents*](https://www.anthropic.com/engineering/building-effective-agents) (19 Dec 2024): programmatic "gates" between steps, ground truth from the environment, stopping conditions, and mistake-proof ("poka-yoke") tool design.
  - Anthropic's [*Writing tools for agents*](https://www.anthropic.com/engineering/writing-tools-for-agents) (11 Sep 2025): actionable error messages, consolidated tools.
  - OpenAI's [*Practical guide to building agents*](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf) (17 Apr 2025): escalate to a human after repeated failures or before high-risk actions.
  - OpenAI's [Model Spec](https://model-spec.openai.com/2026-08-18.html) (2026-08-18 version): state assumptions, ask when appropriate, stay within the agreed scope of autonomy, keep side effects to a minimum (paraphrased).
- **Over-editing is measurable.** [Minimal code edits](https://arxiv.org/abs/2609.04061) (Sep 2026): over-editing is widespread even in frontier models. An instruction to preserve the rest cut excess edit distance from 0.195 to 0.131, but it does not remove the problem. A structural diff with automatic revert does **[inferred]**.
- **Multi-turn drift.**
  - [*LLMs Get Lost in Multi-Turn Conversation*](https://arxiv.org/abs/2505.06120) (May 2025): performance is 39% lower when the instruction arrives spread over several turns. Giving everything in one turn restores 95.1%. A final recap lifted GPT-4o from 59.1% to 76.6%.
  - [DriftBench](https://arxiv.org/abs/2604.28031) (Apr 2026): models violate constraints they can still restate (8–99% depending on model).
  - **Implication:** keep a consolidated list of requirements and send it with every edit, instead of chat history.
- **Check each request against a checklist.** [TICK](https://arxiv.org/abs/2410.03608) (Oct 2024) breaks an instruction into yes/no questions and improves agreement with humans (46.4% to 52.2%). [InFoBench's DRFR](https://arxiv.org/abs/2401.03601) (Jan 2024) scores decomposed requirements.
- **When to ask.** Models tend to assume one reading of an ambiguous request instead of asking ([Oct 2024](https://arxiv.org/abs/2410.13788)). [τ-bench](https://arxiv.org/abs/2406.12045) (Jun 2024) found agents inconsistent over repeated runs (pass^8 below 25%), so measure reliability over repeats, not a single success.

## 4. A revision loop that stays with the requester until approval

- **Rounds.** Practitioner sources treat 2–3 revision rounds as normal ([2026 guide](https://www.themplsegotist.com/how-to-price-graphic-design-revisions-in-a-contract/)). Ziflow cites "eight days across three rounds" from a third party ([Ziflow](https://www.ziflow.com/blog/creative-approval-audit-trail-compliance)). Both are low-confidence vendor or blog figures. I could not confirm that the [AIGA standard agreement](https://www.aiga.org/resources/aiga-standard-form-of-agreement-for-design-services) sets a number.
- **First-time-right** (approved without revisions) is the usual quality measure in creative operations ([Rocketium](https://rocketium.ai/academy/all/creative-ops-metrics), vendor).
- **Time-outs, borrowed from customer support.** Zendesk's standard automations include optional requester reminders at 24 hours and 5 days, and closing a ticket 4 days after it is solved ([Zendesk](https://support.zendesk.com/hc/en-us/articles/4408835051546-About-the-standard-Support-automations)).
- **Reading satisfaction from replies.** LLM rubrics beat embeddings at detecting satisfaction in free-text replies ([SPUR, ACL 2024](https://arxiv.org/abs/2403.12388)). An explicit button should still be the only thing that closes a request **[inferred]**.

**Suggested state machines [inferred]:**
- **Thread:** `DRAFTING → AWAITING_REQUESTER ⇄ REVISING`, with side states `CLARIFYING`, `ESCALATED_TO_DESIGNER` and `PARKED` (time-out, never auto-approved). Then `REQUESTER_APPROVED → AD_REVIEW → DELIVERED`.
- **Each change request:** `OPEN → (NEEDS_CLARIFICATION) → PLANNED → APPLIED → VERIFIED | FAILED (one retry) → ESCALATED`. Other paths: `UNSUPPORTED → ESCALATED | WITHDRAWN`, and `VERIFIED → CONFIRMED` (on approval) `| REOPENED`.

## 5. Proving "better than a human designer"

- **Designers disagree with each other a lot.** In [DesignPref](https://arxiv.org/abs/2511.20513) (Nov 2025), 20 professional designers over 12,000 comparisons reached Krippendorff's α = 0.25.
- **VLM judges don't match designer panels.** In [TASTE](https://arxiv.org/abs/2605.20731) (May 2026) they failed to reach majority agreement with the panel. LLM judges also show position, verbosity and self-preference bias ([Zheng 2023](https://arxiv.org/abs/2306.05685)). A VLM cannot be the judge for the headline claim.
- **Published methods to copy:**
  - [UI-Bench](https://arxiv.org/abs/2508.20410) (Aug 2025): 4,000+ blinded expert pairwise judgments, ranked with TrueSkill and confidence intervals.
  - [AutoDesign](https://arxiv.org/abs/2608.13560) (Aug 2026): a system-blind human study.
  - [Hartmann et al.](https://www.sciencedirect.com/science/article/pii/S0167811624000843) (IJRM 2025): AI images beat human-made ones on quality, realism and aesthetics, with up to 50% higher click-through over 173,000+ impressions. These were single images, not layouts.
- **Protocol:**
  - Replay about 100 or more real office briefs. Both the pipeline and the designer run the full loop, including revisions, with the same requester simulated or replayed.
  - Blind, randomised left/right, ties allowed, judged by requesters plus outside designers.
  - Pre-register a primary endpoint: preference win rate or non-inferiority.
- **Sample sizes** (two-sided α = 0.05, 80% power, my calculation):
  - About **194** decisive judgments to detect a 60/40 preference.
  - About **783** for 55/45.
  - About **155** to show non-inferiority with a 10-point margin.
  - Inflate these for clustering by brief.
- **Secondary measures:** rounds to approval, first-time-right (about 97 briefs per arm to detect 40% vs 60%), time to approval, brand-rule and copy violations from deterministic QA, and cost per approved design.

## 6. Recommendations for Hawa, in priority order

**P0: honesty and scope. No new models needed.**

1. **Decompose each reply into a ledger of requests, and make "unsupported" a legal answer.** The edit-stage schema becomes a list of requests. Each one carries:
   - `quote`
   - `op` (an enum from the operation catalogue), or `unsupported` or `needs_clarification`
   - `targets`, `params` and `reason`

   The model proposes operations; deterministic code applies them. The model never rewrites the whole layout JSON.
2. **Enforce an edit budget with a structural diff.** Compare parent and child layouts. Any change to an element outside `targets` is reverted: position, size, z-order, crop, asset reference, colour. House-rule settling may touch only targeted elements; otherwise it is reported to the requester as a side effect.

   Two invariants hold unless a request says otherwise: the child keeps every photo asset the parent had, and the reference images are carried forward.
3. **Status messages come only from verified ledger rows.** Drop the blanket "your change was made". Example:

   > Draft 3:
   > ✅ Logo moved to top-right
   > ⚠️ Photo cut-outs: I can't do this yet. Sent to [designer], expected by [time]. Nothing else changed.
   > ❓ "Less empty space": A (bigger photos) or B (tighter text)?
   > [Approve as final] [More changes] [Talk to a designer]

4. **Persist the ledger per design lineage, in PostgreSQL.** Send the full list of open and verified requirements with every edit call, instead of chat history.

**P1: verification, clarification, escalation.**

5. **Operation catalogue with checks.** Each operation has preconditions, a parameter schema and deterministic post-conditions. Add a TICK-style yes/no VLM check per request on before-and-after crops, used only for semantic questions. If the same request fails verification twice, escalate it.
6. **Add a `photo.cutout` operation. This needs an ADR.** OpenAI's image edit endpoint can output transparent backgrounds on `gpt-image-2.5-*` models (2026-09-08 snapshots); on `gpt-image-2` it is in preview ([API ref](https://developers.openai.com/api/reference/python/resources/images/methods/edit)).
   - It is a generative edit, and I found no documentation that the original pixels or the person's likeness are preserved.
   - SlideForge (Sep 2026) reports GPT-Image-2 lacking alpha output. That conflicts with the preview note **[ambiguous]**.
   - Safer approach **[inferred]**: use the model's alpha channel only as a mask over the original pixels, and verify that pixels inside the mask are unchanged.
   - Until this ships, route cutout requests to the designer.
7. **When to ask.** Ask only when the request is ambiguous about the target, maps to two or more visibly different outcomes, or would be costly. Ask at most one question per round, with buttons or two thumbnails. Otherwise act and state the assumption.
8. **Approval and escalation.**
   - Only the Approve button closes a request. "Thanks" is classified as acknowledgement, not approval.
   - Escalate on: an unsupported operation, two failed verifications, three rounds without approval, or signs of frustration. The designer gets a hand-off packet: the ledger, the quotes, the reference image, parent and child renders, the diff, and the Canva link. The requester is told who is handling it and by when.
   - Send reminders at 24 hours and 5 days, then park the thread.

**P2: measurement.**

9. **Dashboard per request:** verified success rate, and the rate at which the system claims "done" but verification says "not done" (target 0). Also out-of-scope change rate, rounds to approval, first-time-right and escalation rate. Rank unsupported operations by how often they are requested; that ranking is the catalogue roadmap.
10. **Then run the blinded head-to-head against the designer** from section 5, and feed resolved ledgers into client rules as procedural memory.

The weakest-sourced claims are the agency revision statistics and several vendor feature descriptions. Canva's newsroom and Adobe's help pages returned 403 errors, so those rows rely on press coverage.
