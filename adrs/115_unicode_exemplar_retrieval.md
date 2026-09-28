# ADR-115 — Unicode lexical exemplar retrieval with retained evidence

Date: 2026-09-28. Status: accepted; local lexical baseline qualified, multilingual semantic admission pending.
Requirements: FR-011/020/021, NFR-009/011/024. Sources: MASTER_SPEC.md,
docs/08_MEMORY_RAG_CLIENT_DNA.md, docs/09_MESSAGING_AND_OFFICE_INBOX.md,
docs/30_CURRENT_STUDIO_CONTRACT.md and plans/traceability.csv.

## Decision

Replace the fixed English vocabulary and unbound disk vector cache in the small
approved exemplar selector with Unicode-normalized lexical BM25 ranking. Preserve
original copy and descriptors. Search normalization maps Arabic Kaf/Yeh and numeral
variants, removes tatweel/selected Arabic vowel marks, and preserves Sorani letters.
Split punctuation and category separators. No inferred translation or semantic
embedding score is claimed. Requested format is a tie-break among lexical matches;
with no matches, explicitly label format/curator fallback. Bound candidate counts
and break ties deterministically. Remove the hardcoded standards category from the
qualification helper.

Manifest admission occurs before ranking. Explicit pending/dropped/unknown statuses
are excluded. Legacy rows without individual status inherit only the confirmed
manifest's recorded human curation. The in-memory index is keyed by the complete
manifest content, so approval/metadata changes are seen by existing instances.
Read-only filesystems require no cache writes. The unused English-vector export is
removed rather than rebranding it as a multilingual semantic embedding.

Core remains responsible for client authorization before instantiating the packaged
KAAE selector. Use one manifest snapshot for policy and selection, verify candidate
image bytes against approved hashes before ranking, and pin ranking identity/evidence alongside
the actual visual inputs. Existing retained runs keep their original selection;
current admission policy checks still apply. Other clients do not gain access to
this packaged collection. No global corpus or provider call is introduced.

## Alternatives and limits

A larger multilingual embedding/reranker remains an evaluated candidate under the
existing retrieval specification. Introducing it without an authorized bilingual
corpus, measured recall and downstream quality would hide this failure at a new
cost. A hand-authored translation dictionary would introduce unreviewed meaning.
Unicode lexical ranking is the concrete baseline, not completion of hybrid retrieval
or evidence of cross-language semantic understanding. English-only reference
metadata can still produce no Sorani lexical match; that gap must be explicit.

## Acceptance

Prove Sorani/Arabic/English matching and spelling/numeral variants on original
multilingual metadata, exact-copy preservation, deterministic ranking, no fabricated
semantic score for unmatched queries, status/metadata refresh, bounded counts and
no disk writes. Exercise Core client admission and manifest-byte mismatch; retained
selection evidence must survive resume without another retrieval. Record the initial
ASCII-vector probe, affected tests, type/build/security checks and all remaining
native/human/release limits.

## Initial local evidence

The prior vector probe returns zero components for both Sorani and Arabic samples;
the English control returns two. Three of the six curated images are absent from
the package and recorded archive paths. Availability/hash admission now precedes
ranking, with exact exclusions retained. The first connected suite passes 74 tests
across nine files, including fresh runtime-role resume and a non-KAAE client journey.
This does not replace the missing native images or establish semantic retrieval.

Proof: `plans/lean-design-implementation-2026-09-28/UNICODE_RETRIEVAL_PROOF.json`. Final 74/0/0 connected tests; 526 strict roots pass.
