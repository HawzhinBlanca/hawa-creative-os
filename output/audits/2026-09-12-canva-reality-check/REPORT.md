# Hawa / Canva reality check — 12 September 2026

**Verdict: NOT production-qualified. Not 10/10. The audited Canva workflow is still partly a simulation.**

The observed problems explain the user's experience. Changing the editor name to Canva has not connected the full system to Canva, and changing model labels has not made the generation path use Astra and Opus. A better-looking invitation cannot compensate for invented exports, unrecorded approvals, or missing prompt content.

This is an independent, bounded inspection of the current working tree, deployed Core code, live Desk at localhost:8080, production database counts, isolated adversarial probes, and one local invitation artifact. Current HEAD and working changes are recorded in `RUNTIME_EVIDENCE.json`; source hashes are in `PROBES.json`. The working tree already contained uncommitted changes. No application code was changed. No real task was approved, delivered, deleted, or restarted. One sample UI capture was exercised and disappeared on reload. Provider requests in the adversarial probe were intercepted locally; they were not live inference.

## What genuinely improved

- The main desk now has three navigation destinations: Work, Clients, Settings. The older full editor is no longer the main review screen.
- Worker handlers now pass the Restate context to the runner. That source-level improvement is real, although end-to-end durable delivery still has defects.
- PostgreSQL contains 1,449 task rows and 173 design revision rows. It would be wrong to say nothing is persisted.
- The invitation work separates some content roles and uses a navy institutional direction. Its presentation has a recognizable hierarchy.

These improvements do not satisfy the migration acceptance contract.

## Confirmed release blockers

### A01 — Canva is simulated at the production studio boundary — critical

`packages/integrations/src/canva-native-adapter.ts:118` explicitly describes its backing store as simulating Canva cloud. `canva-design-studio-adapter.ts:73` makes a random local `DAF_...` ID, registers an object, and returns a Canva-shaped URL. There is no Canva create request in that operation. Core selects this adapter at `apps/core/src/app.ts:309`.

**Fresh reproduction:** with all networking blocked, create returned success; a repeated request with the same idempotency key produced a different design ID. A fresh adapter returned an empty manifest with `ok: true`. Rendering a never-existing document also returned success. The deployed container's adapter contains the same fabricated ID and render patterns; this is not merely an unused test file.

Production database read: **0 Canva bindings, 0 Canva capture sets, 0 design briefs, 0 model invocations; all 173 persisted design revisions identify as `hycanvas`.** These counts alone do not prove nothing happened in external accounts; they do prove the claimed canonical Canva/model records are absent from this production database.

### A02 — The visible review workflow invents captures, approvals, and delivery — critical

`apps/desk/src/screens/WorkScreen.tsx:71` seeds three sample tasks. State initializes from those samples at line 218. Capture waits 600 ms, generates random bytes as a checksum, inserts a fixed file size, and marks every QA check passed. Approve and Deliver likewise update browser state; Deliver constructs fixed Drive/Sheet URLs. None of these handlers calls the backend (`367`, `456`, `494`).

**Live UI reproduction:** Capture changed KAAE revision v2 to v3 and changed the displayed checksum. Reload reverted to v2 and the original checksum. Screenshots 05–07 and the two AX recordings preserve the transition. The displayed creative is HTML under `mock-creative-render`, not a decoded captured Canva export.

The live-event contract is also mismatched: Work expects `data.task` and `data.toStatus`; the inspected ingress broadcasts the task object directly and uses `status`. A new messaging task therefore cannot be assumed to reach this queue correctly. There is no canonical task-list load in this Work component.

### A03 — Astra/Opus do not drive the inspected design-generation path — critical

The Telegram ingress builds a plan and chooses coded templates through `CreativeDirectorRunner` (`apps/core/src/app.ts:1243–1283`). The `/tasks/:taskId/generate` route also uses that runner. Neither inspected path calls the model gateway for creative planning or critique. The runner stamps `modelSnapshot: 'gemini-3.8-flash'` into a locally computed plan.

The gateway's creative-director cascade starts with **GPT-5.6 Sol**, not Astra (`packages/integrations/src/model-gateway.ts:83`). Settings displays Sol. Opus appears in the visual-judge registry, but a registry entry is not an execution receipt. The deployed gateway contains no `gpt-6-astra` string.

The migration's own CV-03 receipt reports Astra lookup 404, and successful inference only for GPT-4o-mini and Sonnet 5. That older receipt is not a current entitlement test, nor proof that Astra can never be available. **Current requested-model execution is unproved and not wired into the inspected creative route.**

### A04 — Gateway success and visual criticism are unreliable — critical

**Fresh isolated probes:** with credentials removed, a required-layout request returned `ok: true` and `{status:'success', provenance:'deterministic_fallback'}`. It still attributed the deployment to OpenAI/Sol and recorded 520 input tokens, 140 output tokens, and a cost. It did not enforce the required output schema.

With a nonfunctional sentinel credential and locally intercepted transport, a request permitting **local-only, zero attempts, zero budget** attempted an Anthropic call. Its image input was omitted: only text was serialized. A fake response whose returned model differed from the requested model was still attributed to Opus. This is an isolated boundary test, not a claim of actual data leakage or actual Opus inference.

The source also supplies constant embedding vectors and ranks candidates by their original position (`model-gateway.ts:437,455`). Those methods cannot substantiate intelligent retrieval or learning quality.

### A05 — Exact-copy and asset fidelity are violated before judging aesthetics — critical

The current invitation template adds “OFFICIAL INVITATION,” “OFFICIAL LAUNCH & MINISTERIAL COOPERATION,” a parliamentary-law/authority statement, and website/email/footer content that were absent from the supplied invitation (`kaae-invitation.template.ts:104–107,731,752`). A fresh parser probe appended a legitimate accessibility paragraph; the parser discarded it silently. Styling also decorates the access phrase with extra symbols.

The new Telegram renderer (`packages/creative/src/operations-to-svg.ts:157`) treats image paths containing **any `logo`** as KAAE, inserts a fixed embedded emblem, and substitutes rectangles for other images. It does not resolve and verify the exact supplied asset bytes. This is a direct risk of putting a KAAE emblem into another client's output. If both render programs fail, it returns a synthetic valid PNG (`:277`) instead of failure. A file can therefore decode correctly while containing the wrong design.

### A06 — Corrupt files pass “strict” export qualification — critical

`CanvaDesignStudioAdapter.render` reports a fixed byte count and a manufactured checksum without writing or retrieving an export (`:413`). Separately, `CanvaCapturePipeline.validateArtifactBytes` relies on superficial headers/keywords. It assigns print DPI=300 without measuring effective image resolution.

**Fresh negative controls:** a 40-byte PNG signature with dimensions but no valid chunks passed. A text string starting `%PDF-` and containing `/DeviceCMYK`, with no actual PDF structure, passed as print-ready. Independent Pillow and pypdf decoders rejected both. See `PROBES.json`, `INDEPENDENT_DECODERS.json`, and the retained deliberately invalid files.

### A07 — Client isolation fails inside the active adapter — critical

An object created under tenant A was successfully modified under tenant B using the correct current hash. Adapter `apply` ignores the request context. Create hardcodes a client ID and invents a task ID instead of preserving the real binding. This test establishes an adapter authorization defect; it does **not** establish that an arbitrary unauthenticated network caller can exploit every route. Endpoint and repository checks still require their own adversarial coverage.

### A08 — Durable delivery remains incomplete — high

Worker context wiring improved, and task dispatch has a dispatcher. However the default `publish.drive`, `notify.telegram`, and `notify.whatsapp` handlers only log (`apps/worker/src/outbox-consumer.ts:106–125`), while successful handlers are marked delivered at line 174. A durable queue cannot make a log statement a delivered external effect. Ingress also performs its own template/render/send path, so the code has multiple execution paths to reconcile.

### A09 — Qualification evidence contradicts itself — critical trust failure

The completion report says all 24 tasks and 105 requirements are verified. Its pilot claims a mean 4.84 and 98/100 completion without rescue. Recomputing its 100 task rows gives **4.9062 and 100/100**, respectively. The pilot uses locally patterned IDs such as `DAF_pilot_pilot_kaae_001`. The inspected packet does not establish real Canva documents and independent human scoring for those rows. Do not treat it as a real-office quality trial until independently traced.

The report even expands KAAE as “Kurdistan Association of Accountants & Experts,” inconsistent with the user's “Kurdistan Accrediting Association for Education.” This is evidence that the brand claims were not carefully checked.

Hashing a report only proves its bytes stayed unchanged. It does not prove its events occurred. This audit does not infer the author's intent; it rejects the unsupported qualification.

## UX and visual audit

User goal: submit a real brief, see its actual result, edit in native Canva, and approve the exact files to be delivered. Accessibility target: readable, keyboard-operable review with narrow-screen reflow; no full WCAG certification is claimed.

| Captured step | Health | Observed result / evidence |
|---|---|---|
| 1. Work queue, narrow viewport | Poor | White sample cards, not the user's real task history; low-contrast connection text. `01-work-queue.png`. |
| 2. KAAE review, narrow and desktop | Poor | Clear Canva CTA, but five competing actions, fake preview/file metadata, and four detail tabs. `02-task-review.png`, `05-desktop-review.png`. |
| 3. Settings, narrow and desktop | Poor | Figma remains visibly listed as retired; Sol is displayed; contradictory Telegram/health indicators and technical internal labels. Narrow table clips actions. `03-settings.png`, `08-desktop-settings.png`. |
| 4. Capture and reopen | Failed | v3/checksum claimed, then v2 restored after reload. `06-simulated-capture.png`, `07-capture-after-reload.png`. |

`04-settings-full.png` was captured, opened, and **rejected as unreliable capture evidence** because its stitched output has blank/duplicated regions. Those regions are not counted as a product defect. Every other listed screenshot was saved and visually inspected. Screenshots are under this report's `screenshots/` directory.

The three-destination structure is a good direction. The result still conflicts with the user's preference for a restrained dark interface, fewer tabs, and Canva-only editing. Put retired-provider history in an administrator migration record; do not show Figma as an everyday design choice. Keep the thin Hawa operator screen, but show only real tasks, one next action, and the real captured image. Do not rebuild Photoshop controls inside Hawa.

The local `exports/kaae_presidential_invitation_master.png` was opened and inspected. It uses navy and a formal hierarchy, but repeated bordered panels, gold treatments, and very small body copy make it crowded at messaging size. It also visibly adds unrequested copy. This is a subjective visual critique plus an objective copy defect. Its separate render script is not evidence that this exact file came from the user's latest Telegram job. That provenance could not be established in this audit.

## Platform constraints the next implementation must respect

Canva documents a real authenticated asynchronous export workflow with expiring download URLs; a local URL-shaped string is not a receipt. Its Connect PDF request does not expose the full native print dialog's CMYK/bleed controls. Use a measured native export handoff where required, rather than claiming those options from a different API. [Canva export reference](https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/).

Canva's Connect documentation distinguishes public reviewed integrations from private Enterprise-team integrations. Choose and prove the transport available to this account; Canva Pro features in the editor do not automatically establish backend API permission. The Apps SDK is a separate surface inside Canva. [Canva integration overview](https://www.canva.dev/docs/connect/), [Autofill guide](https://www.canva.dev/docs/connect/autofill-guide/). Sources checked 12 September 2026.

## Qualification decision and limits

No defensible overall numeric score can replace these failed hard gates. **Current status: prototype/incomplete migration; release qualification rejected.** The inspected local invitation may be visually usable as a draft, but exact-copy, actual Canva storage, real model execution, capture, and durable delivery are not demonstrated together.

I did not run the full monorepo suite, initiate paid model jobs, conduct a real-client pilot, or crash production. The file/adapter/gateway/parser probes are fresh executable evidence. Database counts and deployed-code fingerprints are read-only runtime evidence. Historical completion reports are claims under review, not accepted facts. Use the companion `GEMINI_CORRECTIVE_TASK_SHEET.md` for the implementation and independent acceptance contract.

## Direct source links

- [Active studio](/Users/hawzhin/Hawdesign/packages/integrations/src/canva-design-studio-adapter.ts:73)
- [Simulated Canva backing store](/Users/hawzhin/Hawdesign/packages/integrations/src/canva-native-adapter.ts:118)
- [Mock review actions](/Users/hawzhin/Hawdesign/apps/desk/src/screens/WorkScreen.tsx:367)
- [Model gateway](/Users/hawzhin/Hawdesign/packages/integrations/src/model-gateway.ts:173)
- [Capture validator](/Users/hawzhin/Hawdesign/packages/integrations/src/canva-capture-pipeline.ts:97)
- [Invitation parser and defaults](/Users/hawzhin/Hawdesign/packages/creative/src/templates/kaae-invitation.template.ts:22)
- [Asset substitution and synthetic fallback](/Users/hawzhin/Hawdesign/packages/creative/src/operations-to-svg.ts:157)
- [Actual ingress generation](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:1243)
- [Log-only effect handlers](/Users/hawzhin/Hawdesign/apps/worker/src/outbox-consumer.ts:106)
