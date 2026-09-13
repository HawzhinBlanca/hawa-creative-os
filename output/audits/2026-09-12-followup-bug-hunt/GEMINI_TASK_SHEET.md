# Gemini implementation contract — trustworthy Canva production

**Copy this entire task sheet to the implementation agent.**

You are repairing Hawa in `/Users/hawzhin/Hawdesign`. The app can be exercised, but the fresh audit has reproduced serious contract failures. Your job is to complete and prove the repairs below. Do not treat an attractive screenshot, green test count or previous completion statement as evidence that the production chain works.

Read [the fresh audit](./REPORT.md), its executable probes and raw evidence first. This task sheet supersedes earlier unsupported qualification claims, while preserving fixes that now pass. It does not authorize deleting production records, changing real client designs or sending real-client messages for testing. Use a clearly isolated test client, test chat and test designs. Preserve existing uncommitted work.

## Outcome and constraints

The user sends an instruction through Telegram, WhatsApp or Hawa. Hawa binds the correct client, preserves exact copy and original approved references, produces an intelligent editable design, opens Canva for all manual editing, captures the reviewed bytes, runs genuine QA, records authorized human approval and delivers those exact bytes once. Corrections improve the current task immediately; persistent learning is deliberate, client-scoped and reversible.

Keep the architecture lean: Hawa owns task identity, PostgreSQL state, one durable workflow, references, policy, QA, approval and delivery records. Canva owns native manual editing and supported exports. Do not introduce another writable editor, Figma runtime, agent framework, visual automation builder, parallel source master or replacement database. Original brand files stay independently stored. A Canva URL or outlined SVG is not full native editable-source recovery; document the actual supported recovery boundary.

The requested creative roles are **GPT-6 Astra for planning and Claude Opus 5 for independent visual critique**. Treat these as requested account capabilities. Verify exact available provider IDs and successful inference before admission. Do not silently substitute Sol, GPT-4.1, Sonnet or another model while displaying Astra/Opus. If access is unavailable, report the blocker with redacted provider evidence and a clearly disclosed optional fallback. No model name alone proves design quality.

Read the repository AGENTS.md and Obsidian project memory first. Read `AI_BUILD_PROMPT.md`, `MASTER_SPEC.md`, the applicable Canva migration ADRs/admission records and each linked source in `plans/traceability.csv`. Before implementation, map each task below to existing requirement IDs. Relevant starting points include FR-032/033/038, FR-043/045, FR-052–057, FR-064/073/075/078 and the existing CV-xx migration gates. Confirm exact mappings; do not reuse a requirement ID merely because a source comment uses it. Add an ADR for a foundation change.

## Execution order

1. Freeze evidence and make the desk truthful: H01, H02, H03.
2. Connect one real Canva path and close scope leaks: H04, H05, H10.
3. Make intelligence and content reliable: H06, H07, H08.
4. Verify immutable exports and governed learning: H09, H11.
5. Prove the deployed chain and finish the lean interface: H12, H13.
6. Run independent acceptance, fault recovery and quality qualification: H14.

Use the dependency order without splitting repairs into disconnected demonstration scripts. Deliver complete vertical slices. Every row begins **NOT_STARTED**; change status only with linked evidence. Discoveries outside this list become additional tracked tasks, not silent omissions.

## H01 — Restore authenticated canonical task loading

**Implement:** one typed API client using the actual reverse-proxy routes and legitimate session; no baked-in development bearer fallback. Separate loading, signed-out, unauthorized, failed, stale and truly empty views. Paginate or bound the work queue; do not download an unbounded task history. Never silently fall back from a database failure to an apparently complete memory list.

**Required proof:** clean browser through the deployed proxy loads a known persisted test task. Reload and a second authenticated session show the same task/revision. 401 prompts sign-in, 403 explains access, 500/offline shows failure with retry; none shows “zero tasks” as if successful. Record HTTP status, content type, request ID and screenshot. Assert the tested deployment/image/source identifiers.

## H02 — Remove all fabricated UI success and receipts

**Implement:** remove generated capture hashes, fixed file metadata, automatic QA pass, local approval IDs and static delivery URLs. Hawa UI renders server-owned state. Local draft caching may aid recovery but cannot certify capture, approval or delivery. An uncertain provider response becomes `RECONCILING`; no duplicate send to guess the outcome. Use one event contract and invalidate stale state after reconnect.

**Required proof:** inject 401, 403, 409, 422, 429, 500, malformed JSON, disconnect before response and timeout into capture/approval/delivery. Assert no success toast, receipt or `COMPLETE`; no locally persisted approval; action can recover. For success, recompute actual downloaded file hashes and resolve actual provider receipts. Reopen on a second device/session to prove state independence from localStorage.

## H03 — Strict approval and durable-state authority

**Implement:** share a strict request/response schema between UI and Core. Use the exact supported approval enum; invalid values return 400. Derive actor identity and client/project reviewer grants from authenticated server records. Ignore client role assertions. Require immutable revision, capture-set, QA-run and expected task-version references; reject absent or mismatched bindings. Never accept client `qaReport` as verified QA. Record decision and state transition atomically. Reject illegal transitions instead of changing status after the state machine rejects them. Refuse production startup/intake when its required database is absent.

**Required proof:** the audit's UI payload no longer silently becomes a revision request. A legitimate reviewer approves the intended revision; operator role spoofing returns 403. Missing/failed QA, stale revision, cross-task revision, wrong capture hash, altered approval and concurrent edit are denied. Two concurrent reviewers yield a consistent result with one canonical event history. Execute against isolated PostgreSQL using production authentication mode and the proxy. Demonstrate client QA cannot bypass the real repository guard. Do not present no-DB test success as durable proof.

## H04 — One authentic Canva adapter

**Implement:** connect the active application adapter to supported Canva operations. Replace client-credentials authentication with user authorization and PKCE where Connect is used; persist and protect tokens, serialize refresh rotation, handle revocation and reauthorization. Inject fakes only in tests. Persist task/client/design/team binding and operation journal. Capability-gate automation that the actual account/API supports. Manual native export handoff is allowed when clearly labelled and verified.

**Required proof:** official current API references, actual account capability results, redacted authorization/refresh evidence and real provider-issued design/job IDs. From one Hawa test task, open the real Canva document, manually edit a specific text node, save, close, reopen and observe it. Restart the isolated worker/Core and recover the same binding. Prove independent editability of headline, body, logo and layout; importing one flattened image fails this criterion. Never call a fabricated DAF ID a Canva receipt. Test revoke/expire/network failure and timeout after remote success, with reconciliation before retry.

## H05 — Scope-aware durable idempotency

**Implement:** key operations by tenant/client/task/operation with a stable key and canonical payload hash. Same operation and payload resolves the same receipt; changed payload returns conflict. Persist results atomically with an operation journal and unique constraints. Verify ownership before returning a replay. Use the same principle for chat ingress, studio operations, exports and publication.

**Required proof:** the audit's cross-tenant shared-key case cannot return A's document to B. Same-key changed name/dimensions/asset fails. Concurrent duplicate delivery and webhook events cause one accepted effect. Crash after provider acceptance but before local receipt persistence recovers by reconciliation, without a second artifact/message. Mark dependencies that cannot provide strong deduplication explicitly; never promise exactly-once transport if it cannot be proved.

## H06 — Real schema validation and honest model provenance

**Implement:** validate provider output against the full schema: required fields, types, enums, constraints and unknown fields as defined. Do not fill required values or invent positive assessments. Bounded repair calls must consume the same budget. Missing credentials and unusable output produce explicit unavailable/failed states. Separate a deterministic layout option from paid/model execution. Record requested and actual provider/model, returned model identity where supplied, prompt/schema version, input/reference hashes, actual or unknown usage, content hash and trace ID. Do not save secrets or unrestricted prompts in logs.

**Required proof:** `{}`, `COMPLETELY_WRONG`, wrong types, missing required booleans, out-of-range scores, refusal, truncated JSON, empty output and mismatched model identity all fail or visibly enter bounded repair. A missing-key request cannot claim provider execution or invented usage. Orange asymmetric landscape and navy formal invitation briefs produce different valid plans with traceable constraints. Recompute response hashes independently. Account access tests must be separate from mocked wrapper tests.

## H07 — Bound inference and verify vision on every route

**Implement:** enforce deadline, cancellation, total attempts and budget reservations across every fallback. Count real HTTP/network failures in circuit breakers; separate retryable from terminal failures. Do not continue past total attempt one. Every visual provider adapter must resolve authorized artifact bytes by storage identity, check format and revision hash and serialize actual images. Do not read arbitrary caller filesystem paths. If there is no verified image, no route may produce a visual pass.

**Required proof:** the audit's attempt-one request performs at most one transport attempt. Timeouts abort, budget exhaustion stops, 429 honors bounded backoff and real repeated 503s open the breaker. Inspect redacted outbound payloads to establish image parts, MIME and input hashes on both primary and fallback. Missing/wrong-client/mismatched-revision image is denied before transport. A poisoned hidden instruction in an image or reference cannot alter policy, exact copy or authorization.

## H08 — Preserve every request and approved text block

**Implement:** keep immutable source text and attachment hashes before interpretation. Separate instructions, factual copy and references in the brief. Preserve source spans and IDs; category assignment never overwrites text. Require every instruction to be satisfied, explicitly rejected or surfaced for clarification. Brand-reference retrieval occurs after immutable client selection, using actual approved documents/assets and versioned citations. No silently fabricated facts or template defaults for absent event details.

**Required proof:** exact original KAAE invitation survives into native editable text and the captured export, including salutation placeholder, both long paragraphs, date/time, venue and transfer restriction. Add a second Prime Minister paragraph: neither may disappear. Test repeated headings, extra instructions, nonstandard date, long copy, one-line input, duplicate blocks, conflicting dates, missing logo, fabricated fee/RSVP and multilingual mixtures. Unapproved additions, omissions and duplicate factual copy fail deterministic QA. Test another client to prove KAAE content and logo never leak into it.

**Intelligence proof:** provide a constraint-to-element map plus cited brand sources for each design. The model may choose composition, spacing, typography and visual ingredients; it cannot rewrite protected copy. Test real reference-driven plans instead of merely placing learned strings in an unused object.

## H09 — Decode and capture real immutable artifacts

**Implement:** bounded PNG decoding, real PDF parsing/rendering and format-specific checks. Validate page count, dimensions, usable pixel data, font programs, actual color spaces/output intents and requested print settings. Apply decompression/resource limits. Do not infer font embedding from a name or CMYK from a comment. Preserve immutable export bytes before QA and bind the whole capture set to one source revision. An edit during capture invalidates/retries the set safely. Deliver exactly the reviewed bytes, never re-export a changed live document under an old approval.

**Required proof:** both new corrupt specimens and old specimens are rejected by production QA; independent decoders agree. Positive fixtures from real Canva decode/render correctly. Test truncated streams, wrong MIME, missing page, huge declared dimensions, decompression limits, Unicode font substitution and partial multi-format sets. Recompute bytes/hashes outside the application. Demonstrate a concurrent Canva edit cannot mix formats or retain old approval. Where a print requirement cannot be measured automatically, require verified manual preflight and state the limitation.

## H10 — Correct assets for every client

**Implement:** resolve images/logos from the supplied approved asset identity and immutable client scope. Verify checksum and asset authorization. Do not substitute KAAE based on “logo” in a node name; do not replace commercial images with rectangles. Missing assets block production output with an actionable reason. Reference logos must remain official assets, not regenerated approximations.

**Required proof:** rerun `renderer-probes.ts`; another client's logo never becomes KAAE. Test two clients with identical node names but different assets, wrong checksum, missing asset, revoked approval and changed brand version. Decode exported image and inspect native Canva elements and asset provenance. Pixel checks supplement, not replace, provenance.

## H11 — Learning with scope, authority and rollback

**Implement:** store structured feedback in PostgreSQL, tied to authenticated actor, task, client, before/after revision and scope. Temporary corrections remain task-scoped. A persistent rule requires explicit authorized activation, conflict detection, source rights and immutable versioning. Do not hardcode `creative_director` as approving authority. Resolve each client configuration by identity; never write a fixed KAAE path for arbitrary feedback. Unknown reply UUIDs must resolve through authorized durable records or be rejected. Keep original client-owned material separate from Canva-derived data; apply the already documented usage boundary.

**Required proof:** with fixture client directories/storage only, another client's feedback cannot change KAAE bytes or version. “Make this one brighter” changes this task only. An authorized “Use this as a future client rule” creates a reviewable version and only affects the intended scope after activation. Conflicting rules stay pending. Unauthorized actor, replayed reply and unknown task ID fail. Restore/restart retains rule history; rollback reproduces prior behavior. Held-out briefs show whether the promoted rule actually improves outcomes. No production client configuration writes during these negative tests.

## H12 — One traceable live vertical slice and truthful health

**Implement:** connect admitted model planning/critique to the real design workflow; record input provenance, brief, provider invocation, Canva binding, capture, QA, approval and delivery in the canonical store. Health distinguishes configured, authenticated, recently verified, degraded, expired and unknown. An untripped circuit does not mean connected. Derive UI model names from actual configuration. Remove “100%,” “production active” and other unsupported claims. New Canva revisions explicitly use the correct studio identity; historical migration records remain historical.

**Required proof:** one isolated test job travels from authenticated Telegram or Hawa through every stage, with correlated IDs and row counts. A second job tests the admitted WhatsApp route; if quarantined, prove that status honestly and leave its gate blocked. Show actual requested-model inference and independent critique with the rendered image. Download the delivered files and compare hashes with the approved capture. Record elapsed times and cost. Use real provider receipts and redacted traces, not locally constructed IDs or handwritten metrics. Repeat from a clean session after a controlled restart in the isolated environment.

## H13 — Lean Canva-only review UI

**Implement:** retain a small Hawa task queue and detail pane for instructions, references, status and approval. All manual design changes open Canva. Keep technical SVG/code/layer inspectors behind an optional diagnostic view; a separate inspector must not become another editor or export authority. Use a calm dark visual system consistent with user preference. One primary next action, concise status/reason, revision identity and clear return from Canva. Put design instructions, exact copy and reference assets in distinct intake areas. Avoid two competing New Task buttons and large operational dashboards on mobile.

**Required proof:** screenshots and keyboard recordings at 390, 768 and desktop widths; no clipped primary controls or horizontal page overflow. Modal focus trap, Escape/return-focus, labelled controls and screen-reader status announcements. Test measured contrast and 200% zoom. From a clean session, a user can identify what happens next, open Canva, return to the correct task, see an edit requiring recapture, review and approve without code or tool names. Any remaining legacy route is redirected/retired with data-preserving migration evidence. Do not delete historical Figma/HyCanvas data to make a search return zero.

## H14 — Qualification independent of implementation claims

**Implement:** rerun all new and previous relevant negative cases against the final pinned build. Expand the test corpus beyond these exact strings. Use the repository's required 200-task evaluation scope and separate development from holdout data. Evaluate quality by brief adherence, brand accuracy, hierarchy, typography, composition and editability; factual/permission/capture errors are hard failures, not averaged away. Blind reviewers to whether a result came from Hawa or the professional baseline. Record reviewer disagreement, revision count, turnaround, cost and confidence intervals.

**Recovery proof:** in an isolated production-shaped deployment, inject worker/process loss before and after external effects, duplicate/out-of-order events, database outage, expired token, concurrent edits, partial export, storage failure and lost callback. Demonstrate task/revision/approval recovery from backup and actual file restoration. State achieved recovery time and data-loss window. Do not wipe or restart the user's production environment for this test.

**Quality proof:** include the exact KAAE invitation, long-copy variations, repeated entity mentions, altered dimensions, missing references and several clients. Compare with a competent human workflow on the same briefs and constraints. No invented baseline scores. A single successful image cannot qualify intelligence; 200 samples also cannot prove a universal “number one” claim. Report “meets the defined acceptance gates” only when each required gate passes. Long-duration operational SLOs require observations over their actual stated window; mark them unproven until measured.

## Completion evidence contract

For every Hxx task supply:

1. Requirement IDs and linked normative source, changed files, commit/source hashes and deployed image digest.
2. Before-fix reproduction and after-fix commands/tests with actual timestamps and exit codes.
3. Positive case, relevant negative cases, and failure/recovery case. Retain failed logs rather than overwriting them.
4. Machine-readable results linked to raw evidence. For external actions: genuine provider/job IDs, redacted transport metadata, canonical database rows and independently recomputed artifact hashes.
5. A short screen recording/screenshot sequence for UI changes. It must show the tested build and final persisted state; screenshots alone do not prove integrity.
6. Tests **not run**, skipped checks, unavailable capabilities, remaining risks and exact reproducible blockers.

Deliver `COMPLETION_MATRIX.csv`, `FINAL_REPORT.md`, `REPRODUCE.md`, `EVIDENCE_MANIFEST.json`, raw test logs, redacted runtime traces, fixture inventory, before/after UI captures and a durable task ledger. Allowed statuses: NOT_STARTED, IN_PROGRESS, PASS, FAIL, BLOCKED, NOT_RUN. No percentages that treat BLOCKED or NOT_RUN as passed. Recompute aggregates directly from raw rows. Maintain all original audit files unchanged.

Final response must lead with passed/failed/blocked counts and the actual remaining limitations. Do not say “all fixed,” “10/10,” “production qualified” or “better than designers” unless the precisely defined claim is supported by independent evidence. If one gate fails, continue fixing within the authorized scope; if only external access or user action can resolve it, stop the dependent action and identify that exact blocker while completing independent repairs.

**Start now with H01–H03 and then prove the first real Canva vertical slice. Do not return only a plan or another demonstration script.**
