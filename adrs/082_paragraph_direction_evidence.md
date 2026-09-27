# ADR-082 — Paragraph direction evidence and native visual review

Date: 2026-09-27. Status: accepted for implementation; live admission remains open.

Requirements FR-034/035/036/041/043, NFR-020; docs/11 and docs/30.

## Evidence

Actual Canva captures from source aefeabc retain `a:pPr rtl="true"`, but the
checker recognized only `1` and falsely reported absent metadata. A shape-level
`some` check also allowed one correct paragraph to conceal another incorrect one.
The live mixed-language sheet contains a legitimate Latin-leading block without
an RTL attribute. Treating every Arabic-script object as RTL would reject it.
Canva also rewrites source language tags; exported language is not authority.

XML Schema boolean literals are `true`, `false`, `1`, `0`:
https://www.w3.org/TR/xmlschema-2/#boolean (checked 2026-09-27).

## Decision

Read direction per paragraph, including both boolean spellings. Pin explicit
per-block direction from the matching imported source with the existing immutable
export checking policy, and reuse it when rechecking retained bytes. Missing
source direction remains unspecified; do not infer it from a font or alignment.
Without a saved direction, retain the RTL requirement for Arabic-only paragraphs;
mixed-script direction is unspecified and needs visual review. Reject malformed
attributes and explicit conflicts with required direction. Retain the existing
Canva all-metadata-absent visual-review route, but never use it to waive explicit
false direction or malformed metadata. Partial missing required RTL is a failure.

Report parsed paragraph metadata separately from rendered bidi/isolation. Every
otherwise eligible Arabic-script export requires the existing hash-bound human
visual assertion, even when its paragraph flags match. Metadata cannot establish
glyph shaping, number placement, isolate behavior or native-reader approval.
Preserve historical reports and approvals; this changes new checks, not old hashes.

## Acceptance

Use retained real Canva bytes and synthetic negative controls: both true/false
spellings; mixed Latin-leading copy; a second incorrect paragraph; malformed
attributes; frozen per-block directions; and Core refusing explicit failures
while requiring visual review for correctly flagged exports. Exercise the existing
approval gate with a correctly flagged Canva capture and no human visual assertion.
Record language rewriting, style/font survival and remaining native review limits.

The real-file approval test also exposed a copy-shape mismatch at the review bridge:
task events carry canonical `{text, ...}` blocks, while import manifests carry
strings. The byte checker now reads either shape without normalization or dropping
invalid entries. Current task copy still outranks a passing capture receipt; wrong
or malformed task blocks fail. No historical QC report is rewritten.
