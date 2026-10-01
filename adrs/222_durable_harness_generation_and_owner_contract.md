# ADR222 — Durable harness follows generation and owner title contracts

Date: 2026-10-01. Status: proposed; qualification pending.
Requirements: FR-004, FR-025, FR-028, FR-056, NFR-014, NFR-024.
Sources: ADR149, ADR180 section4, ADR220; docs/09_MESSAGING_AND_OFFICE_INBOX.md,
docs/11_QA_RTL_MULTILINGUAL.md, docs/30_CURRENT_STUDIO_CONTRACT.md.

## Actual failures and interpretation

On clean3f8dea9b, seven of the original eight failing ordinary durable journeys
pass,110/112 named controls pass, and no model endpoint is uncovered. The cover
retry now produces a draft. Its remaining controls count two native image-count
requests as two generated designs and require a repeated client title prefix.
ADR149 defines image counting as non-generative preflight; all requests still
remain in the ledger. ADR180 explicitly removes the repeated client prefix and
the existing office-caption/title regression requires that removal. Restoring
that prefix would contradict the owner's accepted behavior.

The full source suite separately passes6947 tests and fails one font-negative
fixture. That fixture returns the unchanged Arial source but expects substitution
because its generic reference says Verdana. ADR220 now preserves actual imported
per-block faces. Keep the negative assertions and change the provider export
fixture to genuinely substitute Verdana for the imported Arial face.

## Decision and fences

Use one harness predicate for successful design-generation ledger entries, excluding
only the existing billing probe and the specifically implemented image-count route.
Unknown endpoints remain recorded as unmatched. Preserve every count call, hash,
status and order; report count requests separately in recovery accounting. This
does not assert counting is free or model/price accuracy. Duplicate generation
responses remain counted and are exercised by a negative control.

The cover title check requires the exact ADR180 title and still compares every
copy line exactly. Count preflights are independently required to carry the same
six image hashes in order; first generation refusal and one accepted retry remain
strict. The font-negative test retains false font/approval assertions against a
real substituted export, with its imported source plan unchanged.

No production behavior, client style, paid admission, provider SDK, database grant,
approval or previously failed capture is changed by these harness corrections.
Preserve original failed receipts; current full qualification remains required.
