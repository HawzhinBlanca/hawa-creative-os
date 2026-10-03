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
