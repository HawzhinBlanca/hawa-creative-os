# ADR276 — Freeze display-copy allowances before export

Date: 2026-10-03. Status: selected; qualified locally; hosted/native/human admission pending.
Requirements: FR-015/017 (docs/08_MEMORY_RAG_CLIENT_DNA.md), FR-028
(docs/07_MODEL_REGISTRY_AND_EVALUATION.md), FR-029/032
(docs/05_CREATIVE_ENGINE.md), NFR-009/011 (MASTER_SPEC.md).
Amends ADR077/113/126/275. ADR265/266 remain binding.

## Finding

ADR275 export retrieval could augment a previously frozen checking policy with
capitalization allowances read from today's source. Equal block counts did not
prove that confirmed copy indexes still referred to the same original content.
The QC recheck also preferred receipt-level options over the frozen policy.
This could make staff and independent customer checks disagree and reinterpret
an older failed capture.

## Decision

All new PPTX operations reserve their display-copy allowances before dispatch,
alongside the existing immutable copy/font policy. Imported-source policies keep
their explicit indexed source plan. A human native-copy confirmation may retain
an imported capitalization allowance only for an unchanged string at the same
index in a complete uniquely indexed plan of equal length. A changed or reordered
string receives no inferred allowance. Its final visible wording must be confirmed
exactly; a matching count alone never transfers a title style to other content.
Record the retained source ID when an allowance is inherited.

Retrieval uses only the reserved policy. A retry retains the first reservation.
QC uses that same policy and rejects copy that no longer matches its reserved
basis; duplicated receipt fields cannot expand its allowances. Historical
operations without a frozen policy retain their existing explicit legacy path.
No migration, dependency, model call, global case folding or new approval power.

## Required evidence

Exercise real isolated SQL and synthetic Canva dispatch/readback: capitalization
allowed at reservation, old strict receipts refused despite a current capitals
source, source arriving after admission refused, human confirmation retained only
for exact indexed source copy, changed/reordered copy refused, and QC unable to
weaken a policy through receipt-level fields. Native Canva and Sorani visual proof
remain independent release gates.

## Joint qualification finding — size-aware display style

The first full merged qualification retained 8,272 passes, four failures and
67 skips. ADR275's solver wiring gave even compact multi-photo titles display
leading of 0.98, conflicting with the unchanged size-aware house rules. Applying
the client display style must take the actual canvas width and clamp leading and
tracking through the existing role/size ranges before measurement. Large display
titles keep their tight leading; compact titles keep the same client face/weight/
case with normal leading and label tracking. No hard-QA threshold changes.
The old photo-report serif expectation must follow the owner's explicit ADR275
poster face; document-page serif expectations remain intact. Remaining failures
must be diagnosed and qualified rather than waived.

The two album failures were traced to the pre-import transfer check: the deck
correctly emitted live typed copy with `cap="all"`, but that local checker did
not receive the generated manifest's indexed display policy. It must use the same
explicit source allowances before import. It still rejects changes to factual
wording and retains the existing copy check; no globally relaxed comparison.

## Latest design-lane integration

Merged Claude a7beb434 CTA containment and geometric controls after the corrected
106ca001 full checkpoint passed8,277/0/67. Kept the shared size-aware helper: the
recipe fitter reconstructs each text element for each measured scale, so its
current canvas share can retain tight display leading safely at large sizes.
Kept manifest-derived transfer policy rather than duplicating layout flags.
The CTA and surrounding copy remain independently editable.77 affected controls
pass; the final sealed combined full qualification is pending.

## Final local qualification

Sealed5b063787 passes8,277/0/67 with all latest design/support/customer changes.
Policy100, customer112, corrected design48 and latest CTA77 focused controls pass.
Three adversarial controls fail against the merged pre-repair baseline as expected.
757 strict test roots, native build, types/scripts/any/egress/scanner, source seal
and blueprint1,975/0/0 pass. Failed attempts remain in JOINT_DESIGN_PROOF.json.
Website56d9aaf adds seven passing production-build Chromium member/performance/
anonymous controls with unchanged budgets. Existing product source and its prior
863 unit/nine customer-browser controls are unchanged. Real hosted/customer/native
Canva/Sorani/human quality, coverage/reviewed visuals/live RLS/Linux and public
hosting/HTTPS/restore remain open. No deployment or public activation is proven.
