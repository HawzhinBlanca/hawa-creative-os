# ADR209 — Explicit captured font family identity

Date: 2026-10-01
Status: Accepted; exact source engineering verified on a03387f1; native/product admission open
Requirements: FR-028, FR-034, FR-038, FR-041, NFR-012, NFR-024

## Evidence and reason

ADR208 inspects the used script slot but generated, formal, display and legacy
policies still accept any name beginning with an approved family plus a space.
Fifteen actual regressions fail: twelve checker cases, two Core generated-QC
cases and one retained-source review case. `Verdana Fake` becomes passing review
authority despite unchanged copy. A width or unknown custom family is likewise
accepted through its prefix. Family and subfamily are distinct OpenType names;
arbitrary suffixes are not evidence of family identity.

## Decision

Match the exact requested family or an explicitly listed equivalent name observed
in the pinned office font inventory's family/full-name records. Use typographic
family when present; record both full and legacy family names. Keep this small
table in pure QA, with no font-file I/O, renderer dependency, generic suffix
grammar, provider aliases or new dependency. An unlisted family still matches
itself exactly. Unknown variants require an exact requested name or measured
admission; their prefix grants no authority. This equivalence table does not
admit a family to a client or to the automatic renderer.

Generated/formal/display comparison remains case-insensitive. Legacy comparison
retains its exact family-prefix case requirement and exact-family comparison;
verified style spelling compares case-insensitively. Manual Client DNA membership
remains exact and does not acquire style aliases. Expected full style/width names
match themselves, without recursively stripping or appending styles. Checker
version becomes 9; current Core always rereads retained bytes, including old
passing receipts. Exact copy, source bytes/hash, direction policy, review revision,
human approval and native verification authority are unchanged.

## Qualification

Retain original red results and inventory measurements with file hashes. Verify
negative families through checker, generated Core QC, stored-source review,
idempotent replay and approval refusal. Preserve known legitimate full names,
case behavior and exact custom names; recheck historical real Canva exports
without changing them. Qualify the sealed candidate through the engineering
gate and update scoped traceability. This is declared-name identity only: it
does not certify native font files, glyph shaping, font weight fidelity, other
scripts, human visual quality or full product admission.

Sources inspected 2026-10-01:
- https://learn.microsoft.com/en-us/typography/opentype/spec/name
- https://learn.microsoft.com/en-us/typography/opentype/spec/stat
- `packages/creative/src/studio/render-fonts.json` and its 19 available font files;
  actual `fontkit` metadata retained in the scoped qualification archive.
