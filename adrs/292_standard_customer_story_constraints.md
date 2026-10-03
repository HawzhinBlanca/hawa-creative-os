# ADR292 — Carry customer photo intent and story bounds into standard composition

Date: 2026-10-03. Status: implementation, qualification pending.
Requirements: FR-006/018/028/068, NFR-018/024/025.
Sources: MASTER_SPEC.md; docs/09_MESSAGING_AND_OFFICE_INBOX.md;
docs/11_QA_RTL_MULTILINGUAL.md; ADR261/279; website ADR0025.

The actual native browser six-photo request reached eight real GPT-6.1 Sol calls
and failed before rendering. All three proposals and their repairs violated story
safe bounds. The standard prompt advertised uniform margins, and normalization
clamped logos/text to those margins although validation uses the existing story
safe rectangle. A default logo at y=96 cannot pass its own 269px story top bound.

Use the existing getSafeZoneBox policy for prompt constraints and normalization.
Keep full-bleed backgrounds, shapes and photos unchanged; clamp only text and
logos that fit. Oversized elements must remain refused rather than shrunk or
cropped. Do not weaken validation or reflow exact copy silently.

The retained browser source policy required all six images, and typed context
preserved them, but the brief was asked to infer their purpose and the standard
layout prompt omitted photosBrief entirely. Carry the admitted web source role
and all/count/automatic policy into briefing and the existing typed photo directive
into standard layout prompts. Automatic choice must remain flexible. References
and inferred roles from other channels keep their existing behavior. This does
not admit an unqualified client to v3 or change brand preferences.

Retain the failed real run and transport controls as failure evidence, add genuine
red regressions, and repeat the affected native journey only after source gates.
No native Canva, human quality or customer release admission is implied.

Automatic website photo use also avoids the legacy implicit-all default in
standard layouts: one or several is allowed, while explicit all/count language
still binds. ADR292 is reserved after Claude release-3 ADR291; do not collide
with its parallel ADR280–291 work. Current isolated source still awaits that
release merge and its independently introduced Sorani shaping dependency.

## Real-model repeat — 2026-10-03

Sealed source06ed25a8 passes the full suite8297/0/67. A fresh real browser/Core/
worker/Restate/Sol repeat passes56 transport controls but still produces no preview
or editable source: all three layouts and repairs collide with the logo or its
clear space. This is retained as a design failure, not a generation pass.

The standard repair packet supplied only the first validation message, without
the rejected layout. Include the actual normalized proposal as untrusted JSON in
the single already bounded repair call. State absolute pixel units and the logo's
expanded clear-space rectangle explicitly. Preserve flexible logo placement and
all copy/photo constraints; do not add calls or weaken validation. The output
schema's unconditional all-photo description also contradicted automatic/count
policy; bind it to the admitted photo-selection directive instead. The prompt
version changes to2026-10-03.2 so retained calls cannot silently adopt new wording.
Three genuine red controls record the missing repair geometry, units and policy.

## Combine with Claude release-3b — 2026-10-03

The repaired real-model repeat produces one locally checked winner and an editable
PPTX: two exact live-copy blocks, all six original photo hashes and ordered placements,
seven independent pictures. Native Canva delivery remains unqualified because the
isolated fixture has no grant. Keep that terminal failure and saved source visible.

Merge pinned Claude release-3b b56020bf under its existing ADR285/287 foundations.
Its shared openDraft helper must carry ADR279's bounded website-only photo manifest.
ADR285 always marks website requests, including `{v:1,images:[]}` when no photos
were supplied. Preserve that empty marker through HTTP; stored owner receipts still
refuse an empty manifest for a request that actually has photos. A mounted real
HTTP/one-connection regression fails409 without the preservation,81 other checks
pass after rebuilding the new package exports. No role/source/ownership guard or
office intake may be removed to resolve the source move. Merge both traceability
histories and regenerate release metadata after the source commit.
