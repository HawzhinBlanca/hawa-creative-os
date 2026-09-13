# Gemini execution contract — a real Canva-only Hawa workflow

Issued 12 September 2026. Intended implementer: the user's Gemini agent. This is a task sheet, not a claim that work is complete.

## Mission

Make Hawa genuinely accept the user's Telegram, WhatsApp, and Desk brief, understand the exact request and correct client references, use **GPT-6 Astra for creative planning and Claude Opus 5 for independent visual critique**, create an **actually editable native Canva design**, let the human edit in Canva, capture and verify real output files, obtain approval for those exact bytes, and deliver them reliably. Preserve Hawa's client knowledge, messaging, durable job, approval, storage, and governed-learning structure. Canva is the sole manual design editor.

Read the attached `REPORT.md`, `PROBES.json`, and the original Canva migration task sheet before changing code. The previous “all verified” claim is rejected by fresh counterexamples. Do not try to satisfy this contract by renaming adapters, writing expected output into JSON, adding success badges, adjusting assertions to accept the defect, or producing a beautiful one-off image outside the application.

The target is evidence-backed readiness for a defined workload. Do not promise universal 10/10, superiority to every human designer, or zero future failures.

## Execution rules

1. Read repository and Obsidian instructions, `AI_BUILD_PROMPT.md`, `MASTER_SPEC.md`, admission records, and `plans/traceability.csv`. Map every repair below to the exact existing requirement IDs and linked normative text. Add an ADR before changing a selected foundation. Preserve concurrent working changes; record commit, dirty diff identity, image digests, and migration version.
2. Keep this a focused repair. No new agent framework, second editor, generic automation builder, redundant database, or second workflow engine. Reuse existing PostgreSQL, Restate, storage, and approved channel integrations.
3. Keep fake implementations only in clearly isolated test/demo modules. Production composition must refuse to load them. No seed task, fake hash, fabricated receipt, default success, guessed brand identity, or synthetic preview may represent real work.
4. Maintain statuses `NOT_STARTED`, `IN_PROGRESS`, `IMPLEMENTED_UNVERIFIED`, `BLOCKED_EXTERNAL`, `FAILED`, `VERIFIED`. A missing credential, unavailable account feature, missing human reviewer, or unexecuted crash test is a blocker, never a pass.
5. Verify one production-shaped vertical slice before scaling to many clients or qualifying a pilot. Use an isolated deployment with separate database, storage namespace, test Canva copies, and authorized messaging destinations. Never wipe/restart production or send client messages as a drill.
6. External purchases, wider permissions, public release, and client delivery require the user's applicable authorization. Ordinary local fixes and isolated tests should proceed without repeated permission questions. Finish everything independent of any external blocker and identify the exact remaining blocker.

## Target architecture and authority

```text
Telegram / WhatsApp / Desk
         ↓ authenticated, deduplicated durable ingress
PostgreSQL task + immutable brief + client scope + outbox
         ↓ one Restate workflow
Verified client references → Astra structured creative plan
         ↓ native text, exact official assets, bounded image ingredients
Canva working design ← human manual editing in Canva
         ↓ capture with source-change detection
Stored immutable file set → deterministic QA + Opus visual critique
         ↓ authorized approval bound to exact file-set hash
Drive / Sheets / channel delivery → independently verified receipts
         ↓ attributed feedback → proposed client rule → human-approved learning
```

PostgreSQL owns task state, client scope, approvals, and provenance. Canva owns the editable working document. Immutable storage owns captured release bytes. The workflow coordinates effects. Models advise on layout and critique; they do not authorize approval, invent facts, alter client scope, or waive hard QA. A native Canva cloud document and exported files are different assets; do not claim a PDF/SVG is a fully editable vendor-independent source backup without proving that property.

## R00 — Retract false qualification and establish a clean baseline

Preserve the old completion packet as historical evidence. Publish a correction identifying which claims are contradicted, unverified, or genuinely passed. Remove hardcoded production admission, quality, uptime, and connection claims from user-visible state. Replace them with observed state or an explicit unknown/unavailable status.

**Proof:** run the supplied audit probes unchanged on the baseline, retaining their failures and source hashes. Record deployed version separately from repository HEAD. Produce a manifest of actual live routes, worker effects, databases, storage, and current template/model transports. Recompute all pilot summary metrics from raw rows and flag missing source events. Do not destroy old task/history/assets to make counts agree.

## R01 — Make the Canva transport real before building on it

Identify the supported account-specific path: Connect APIs, Canva MCP/connector through an authorized runtime, or an Apps SDK action inside native Canva. Prove the selected route's creation, element editing, reopen, and export capabilities. Record its current documentation, scopes, licensing restrictions, quotas, unattended/attended requirements, and session recovery. A connector available in an assistant conversation is not automatically a callable backend service. Do not invent REST endpoints or transplant print-partner/Enterprise capabilities into an unavailable API.

Implement an explicit provider boundary that returns vendor-issued design IDs and persists tenant/client/task/design/team ownership. Resolve and read back the new design with a separate request/session. Reject unknown documents and unavailable transports. Remove production `Map` storage, locally fabricated Canva IDs, and constant capabilities. Capability health must expire when its observation becomes stale.

**Proof:** one isolated design created from the app has redacted request/response receipts, a real account-visible URL, a persisted binding, and independently read native text/image nodes. Reopen from a fresh session and change one word and one asset position without flattening or recreating unrelated content. Disconnect Canva: creation/edit/export must fail truthfully with no completed state. Repeat the same job after a lost response: reconcile to one design, or expose an unresolved outcome if the vendor cannot establish it.

**Blocker rule:** if a required native operation is unavailable on the actual account, name that operation and the measured supported manual handoff. Do not quietly reinstate Figma or call a flat SVG import “editable.” Do not mark unattended operation qualified when it requires a logged-in human session.

## R02 — Wire the requested models into the actual job path

Route the real creative plan through Astra and the actual captured render through Opus. Store requested model, provider-observed returned model, provider request ID, prompt/schema version, input/reference hashes, output hash, timing, and actual usage. Verify exact available model IDs and endpoint compatibility with official provider documentation and the production credential context. Successful model lookup or a generic “OK” response does not qualify visual design performance.

The planner must return schema-valid layout decisions and a constraint-to-element mapping. The critic must receive the actual image bytes plus the brief and relevant reference images; a storage key or sentence saying “attached image” is insufficient. Parse text blocks correctly even when provider content contains other block types. Use bounded requests, deadlines, token budgets, permitted-provider checks, and rate-limit/circuit-breaker handling before egress. Reject unknown/unadmitted deployments by default. A fallback requires an explicit configured policy and visible provenance; it may not claim Astra/Opus ran.

Image generation is a separate ingredient capability. Admit the actual accessible image model with receipts and quality tests; do not describe Astra/Opus model-name selection as proof of image generation. Keep protected text and official logos out of generated pixels.

**Proof:** a fresh normal Telegram job, WhatsApp job, and Desk job each show genuine Astra planning and Opus image critique receipts tied to the same task. Negative tests: missing credentials, denied Astra, Opus unavailable, response-model mismatch, thinking-first response, malformed JSON, missing required fields, empty response, 429, timeout, zero budget, local-only policy, and missing image. Every test must produce the intended failure/retry state, no invented usage, no silent model substitution, and no claim that unseen pixels were judged.

## R03 — Compile the brief without losing or inventing content

Persist the raw user message and attachments before acknowledgement. Separate design instructions from factual copy, but account for every source span. Store exact copy blocks with stable IDs and source offsets; preserve punctuation, names, numbers, placeholders, date/time, and paragraphs. Unknown paragraphs must remain protected or trigger a clear clarification, not disappear. Preserve explicit requested dimensions, language, background preference, and attachment selection; do not default every invitation to one social card.

Remove unsolicited laws, authority statements, dates, slogans, contact details, and footers. Brand guidance may choose style; it does not grant permission to add factual text. Resolve the correct client through authoritative channel/task binding and verified reference records. Lock scope before retrieval. Use the original supplied logo bytes or an explicitly approved official variant; never reconstruct the logo because a path contains `logo`.

**Proof:** use the original `KAAE_INVITATION_EXACT_COPY.txt`, plus the user's navy/background/English/logo instructions, as a golden fixture. Show a complete source-span-to-native-node map and final text diff. Zero missing, duplicated, substituted, or extra factual text. Add/reorder an unfamiliar paragraph, change the venue/date, omit a field, include delimiter-like text, and attach two logos with different client ownership. No dropped span, invented default, or cross-client asset is acceptable. Explicitly preserve the source's vertical bar in date/time and non-transferability notice unless the user approves a copy change.

## R04 — Build design intelligence around references and measured constraints

For each client, retrieve a small relevant set of approved guidelines and exemplary designs with version, scope, and provenance. Distinguish rules, examples, and rejected designs. The planner must cite which references support palette, typography, layout, texture, logo variant, clear space, and tone. Do not equate “professional” with adding gold frames or decorative cards to every design.

Use Astra to evaluate the content density and choose a suitable hierarchy and composition. If the copy cannot fit at an acceptable reading size, choose a supported larger/multipage design or ask about dimensions; never silently delete or shrink content until it is unreadable. Assemble native Canva text, logo/image elements, and supported shapes. Optional generated texture/photography remains a separate ingredient. Remove generic logo substitution, image rectangles, and synthetic-valid-PNG fallbacks from production.

Opus should identify visual problems against the actual render and references. Permit at most a small documented repair budget, such as two targeted repair cycles. Each correction must preserve protected content and unrelated manual edits. On disagreement or unresolved defects, return `NEEDS_DESIGN_REVIEW`; do not loop indefinitely or invent a high score.

**Proof:** unseen invitation, dense announcement, minimal design, and commercial asset cases visibly respond to different briefs. Show reference IDs, candidate rationale, final native elements, and before/after targeted corrections. A client reviewer must accept brand fidelity. A designer must assess hierarchy, spacing, typography, readability at intended size, and restraint separately from factual correctness. Changing the prompt must change the relevant design decision, with all unchanged constraints preserved.

## R05 — One durable execution path and real effects

Make all ingress channels dispatch the same durable job instead of maintaining separate ad hoc generation/send paths. Persist briefs, bindings, revisions, capture jobs, workflow identity, and effect attempts. Use stable IDs and transactional outbox writes. Reject mismatched expected revisions. Recover unfinished actions by examining vendor/job receipts and stored state, not by assuming an advanced task status proves delivery.

Replace log-only Drive/Telegram/WhatsApp handlers with real verified transports or explicit unsupported failures. Mark an effect delivered only after its defined confirmation is durably recorded. Treat provider “accepted” separately from user-received where the platform distinguishes them. Bound retries and dead-letter unresolved work with an actionable recovery step.

**Proof:** on the isolated deployed service, kill the worker before/after each side-effect boundary; duplicate the same ingress event 20 times; inject a timeout after the provider accepted a request; restart Core and worker; reconnect SSE. Exactly one canonical task and the intended one logical external effect must remain. If strict exactly-once cannot be guaranteed by a provider, document the residual risk and demonstrate reconciliation rather than making that claim. Restore a real database/storage backup into a fresh test host and reopen the task and Canva binding; measure RPO/RTO from events, not constants.

## R06 — Real capture, real file validation, stable approval inputs

Capture the chosen native Canva document/version into a complete staged file set, download actual bytes, independently decode them, hash them, and atomically publish the set. Persist export job identity and reconcile uncertain responses. Detect source changes during multi-format export; if Canva does not provide an immutable revision pin, enforce a bounded edit/capture procedure and detect drift before accepting the set. Reject mixed-source output sets.

PNG checks must decode chunks/pixels, enforce dimensions, and match the intended page. PDF checks must parse real pages/resources, fonts and text, page boxes, transparency/color profile where required, and effective image resolution at placed size. `300 DPI` metadata and `/CMYK` text do not establish print quality. SVG validity does not establish live editable text. Use native Canva print export with an explicit handoff if the admitted API lacks required controls; qualify the actual delivered file/profile.

**Proof:** supply genuine PNG and PDF from the normal workflow; verify them with independent tools and visual inspection. The two retained corrupt fixtures must fail. Also reject empty, truncated, wrong MIME, HTML login page, wrong dimensions, unrelated valid image, missing font, low-resolution image, missing page, stale version, and mixed-version exports. No fixed sizes, synthetic images, or inferred hashes. Reopen/download the stored approved set after temporary vendor links expire.

## R07 — Enforce approval, authorization, and delivery on the server

Every read/mutation verifies actor, tenant, client, task, design, expected revision, and permitted role. Derive identity server-side. A correct content hash is not authorization. Bind approval to the immutable file-set hash and QA version. Modification must invalidate eligibility of the affected capture; delivery always reads approved stored bytes, never freshly exports a mutable Canva master. A changed working document can coexist with a previously approved capture only when the UI clearly identifies the approved historical file set.

**Proof:** cross-tenant and cross-client reads/writes; task A approval used for B; same correct hash under a different actor; expired/replayed callback; concurrent manual edits; substituted storage bytes; QA failure; unauthorized reviewer; missed/duplicated channel callback. All rejected without side effects. Successful delivery must include a real Drive object and read-back hash, the correct Sheet row, and channel confirmation appropriate to that platform. Never replace missing destination URLs with generic homepages.

## R08 — Make the thin operator interface honest and lean

Keep Work, Clients, Settings. Canva is the only editing destination. Remove Figma from daily navigation, onboarding, command palette, notifications, and task actions; retain decommission history in a separate administrator record. Remove custom edit/render controls and dead legacy runtime/dependencies after preservation/rollback requirements pass. Do not delete historical source assets or archives.

Fetch the canonical task list and details from the backend. Align SSE event schemas and recover missed events through refetch/cursor handling. Capture, Request Revision, Approve, and Deliver call real server commands and show pending/failed/completed states only from acknowledgements. Preview the actual captured file, not constructed HTML.

Use the user's preferred restrained dark charcoal/navy style for the small Hawa surface, generous readable typography, one prominent next action, and progressive disclosure for metadata. Put everyday work in Canva; Hawa should explain what needs attention and link to the correct design. Avoid badge overload, emoji-heavy controls, piles of tabs, CV/FR/ADR labels, and unsupported confidence percentages in operator flows. Preserve accessibility and visible status beyond color.

**Proof:** a fresh browser session sees the actual Telegram job; Capture survives reload and another browser; a broken server shows a useful error and no false success. Test 390px, 768px, and 1440px widths, keyboard-only task selection, modal focus/escape/return, descriptive labels, screen-reader status announcements, and adequate contrast. Record screens from the deployed build, not a mockup. Search the loaded bundle and reachable UI for active legacy editor imports and user-visible Figma actions. Any retained archive reference must have a documented reason.

## R09 — Govern learning and retrieval

Replace constant embeddings and positional ranking with a measured admitted implementation, or use honest deterministic retrieval until a model is admitted. Learn from attributable accepted/rejected revisions and reviewer reasons, not success booleans or model self-praise. Propose client-specific preferences with provenance, confidence based on evidence, and applicability conditions. Require approval for promotion; preserve versions, rollback, and conflict resolution. Never let a learned preference override protected copy, official logo, or an explicit current request.

**Proof:** a holdout set unknown to the rule-mining run; per-client retrieval relevance; cross-client leakage tests; poisoning via uploaded instructions; conflicting feedback; reversal of an approved preference. Show a measurable improvement in accepted designs or reduced corrections on held-out cases. Until measured, label this as an implemented feedback mechanism, not a proven intelligent learning system.

## R10 — Qualification must be independently falsifiable

After R01–R08 pass one vertical slice, run ten different real test briefs across admitted clients and task classes. Then conduct the original required **100 real-office tasks across at least three admitted clients**. Count operator rescues, failures, retries, abandoned tasks, costs, latency, corrections, and copy/brand escapes. Report all attempted tasks, not only successes. Keep real-office trials, synthetic regression tests, and provider integration tests in separate datasets.

For visual quality, use independent human reviewers and randomized blinded comparison against actual accepted prior designs or a qualified designer baseline under comparable briefs/time budgets. Record reviewer-provided scores and comments. Do not generate reviewer identities, scores, timestamps, or Canva URLs. Predeclare the rubric and threshold. Suggested acceptance: at least 95/100 complete without technical rescue, zero critical copy/logo/client/approval/delivery escapes, and mean human quality at least 4.5/5 with no failed hard constraints. Report uncertainty and the weakest task classes. These are proposed scoped thresholds, not proof of being globally number one.

**Proof:** raw task/request/design/capture/model/effect/reviewer records reconstruct every aggregate. A reviewer must be able to pick any five rows and independently open the actual design, inspect native elements, reproduce file hashes, and read real feedback. Recomputed totals and quantiles must exactly match the report. Run invalid/missing-input negative controls against the evaluator: they must fail even when the model returns HTTP 200 or `passed:true`.

## R11 — Evidence package and release decision

For every repair deliver: requirement mapping, implementation paths, exact commit/deployed-image digest, reproducible test command, isolation details, raw observed result, negative controls, known limits, and independent reviewer decision. Tests executed on one tree cannot qualify later untested edits. Preserve redacted provider receipts; never store credentials in evidence. Hashes protect evidence integrity, not truthfulness.

Run the relevant unit, contract, integration, and deployed end-to-end tests, then the full required repository checks on the final tree. Enforce a test-database allowlist and isolated storage before execution; verify production counts/state are unchanged. Report failures and skips separately. A passing test that mocks the very Canva/model/export behavior being qualified is only a unit test, not integration proof. The independent reviewer must deliberately break model selection, asset identity, one protected copy span, capture bytes, and a delivery receipt in the isolated deployment; each corresponding acceptance gate must turn red. Reverting those mutations must restore a green result without editing assertions or expected evidence.

Required final files:

- `STATUS.md`: precise admitted scope, remaining blockers, and genuine readiness decision.
- `TASK_LEDGER.csv`: R00–R11 status, dependencies, requirement IDs, executable evidence, verifier, timestamp.
- `LIVE_VERTICAL_SLICE.md`: original request → actual models → actual Canva master → manual edit/reopen → real capture → QA → approval → verified delivery, with one consistent identity chain.
- `NEGATIVE_CONTROLS.json`: every required failure case, expected behavior, observed behavior, and raw log/artifact paths.
- `MODEL_RECEIPTS.json`, `CANVA_RECEIPTS.json`, `DELIVERY_RECEIPTS.json`: authentic redacted external observations.
- `PILOT_RAW.csv`, `REVIEWER_FEEDBACK/`, and a reproducible metric calculator; no synthetic rows mixed into the real pilot.
- `RECOVERY.md`, `SECURITY.md`, `UI_CAPTURE_INDEX.md`, `CAPABILITY_LIMITS.md`, and hashed artifact manifest.

The final message must state: **what actually works; exact scope; what failed or was not run; which external blockers remain; how a skeptical reviewer can disprove the completion claim.** Do not mark the whole project complete if any critical gate is missing. User acceptance of the actual KAAE result and independent engineering replay are separate required gates.

## First milestone — do this before expanding the work

Deliver one fresh, isolated KAAE invitation from the exact supplied Telegram message through the normal deployed workflow. Show genuine Astra and Opus receipts, exact unchanged copy, the supplied logo resolved by its real hash, a native Canva document, manual edit/save/reopen, real stored PNG/PDF, a surviving review capture, and authorized delivery of the same approved bytes to an authorized test destination. A handwritten render script, staged screenshot, fabricated receipt, or manually assembled evidence file cannot substitute for this identity chain.

If that milestone cannot be completed because account access or supported Canva automation is unavailable, report the narrow blocker with its real response. Continue all independent repairs. That honest outcome is more useful than another “100% verified” report.
