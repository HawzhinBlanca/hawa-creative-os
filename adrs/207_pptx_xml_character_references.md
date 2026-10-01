# ADR207 — Exact PPTX XML character references

Date: 2026-10-01. Status: connected source qualified; exact engineering gate pending.
Requirements: FR-028, FR-034, FR-038, FR-041, NFR-012, NFR-024.
Sources: docs/05_CREATIVE_ENGINE.md, docs/11_QA_RTL_MULTILINGUAL.md,
docs/30_CURRENT_STUDIO_CONTRACT.md; W5_PPTX_CHARACTER_REFERENCE_FINDING.json.

## Evidence and decision

The pinned fast-xml-parser5.11.1 retains valid decimal/hexadecimal character
references as literal copy with `htmlEntities:false`. Independent XML decoding
matches the exact intended text, but the actual PPTX copy checker refuses it.
The library's numeric decoder can also silently remove forbidden XML controls
and surrogates or parse the numeric prefix of a malformed reference. Neither
behavior is factual-copy authority.

Use the pinned parser's runtime-supported explicit map of only the five XML
predefined named entities to enable numeric references. Do not enable HTML-only
named entities, manually decode already-parsed text or change whitespace/copy
comparison, font/direction/identity rules. The pinned TypeScript declaration
mistakenly limits that runtime option to boolean; one documented expect-error
keeps the discrepancy visible and will require removal if the upstream type is
corrected. No dependency or version is added.

Before decoding, scan bounded XML for numeric references outside CDATA, comments
and processing instructions. Require exact XML decimal/lowercase-x hexadecimal
syntax and XML1.0 valid character ranges; refuse invalid controls, surrogates,
malformed values and out-of-range code points rather than erasing them.
Canonicalize valid numbers to equivalent short decimal references so padded
valid numbers do not exceed the decoder's32-character token window. This is
lexical XML equivalence, not changing facts or retained source bytes/hashes.
Escaped ampersands are not rescanned after decoding, preserving literal
entity-looking copy. CDATA is literal, including entity-looking text.

Bound the canonicalizer to100,000 numeric references per inspected XML part;
larger inputs refuse before building additional replacement chunks or invoking
the parser. Preserve already-canonical decimal text without replacement chunks.
The initial expansion fixture assumed the library's100,000 positive expanded
length guard counted numeric references. Actual pinned source and the failing
control show numeric references shrink their encoding and do not increment that
guard. This explicit inspection budget addresses work/allocation rather than
relaxing an existing guard;100,000 is accepted and100,001 is refused.

Keep compressed/expanded ZIP, entry-count and parser expansion/nesting bounds,
DTD/entity-declaration refusal and all existing authority gates. Bump observed
checker version6→7. A decoded attribute may now reveal an existing identity
collision or explicit font/direction conflict; such evidence still refuses.
Unknown HTML-only entities do not become their characters or receive authority.

## Required qualification

Retain original red controls and verify actual copy/source objects for decimal,
hex, padded references, newline/tab, supplementary Unicode and Arabic/Sorani.
Preserve escaped numeric/named text and CDATA; refuse malformed/invalid refs,
DTD and oversized expansion. Verify decoded identities, collisions, font and
direction conflicts without granting visual/native approval. Run connected
actual Core capture/manual review and strict source engineering gates.
Real Canva export/native preservation, glyph/bidi visual evidence and human
quality remain open; synthetic parser fixtures do not certify those gates.
