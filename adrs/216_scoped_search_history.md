# ADR216 — Complete scoped search over stored office history

Date: 2026-10-01. Status: connected and seven-stage engineering verified; production-dump/native/human/product admission pending.
Requirements: FR-077, FR-011, NFR-012.
Sources: docs/17_UI_UX.md, docs/08_MEMORY_RAG_CLIENT_DNA.md, docs/09_MESSAGING_AND_OFFICE_INBOX.md, MASTER_SPEC.

## Evidence and reason

Eight actual Core/PostgreSQL regressions fail on published 7f17a09d. A registered
client without active DNA cannot be found. Persisted ledger/Studio feedback,
historical revisions and their exact copy are not indexed, despite FR-077.
Unsupported category values silently return an empty successful result.
Missing office history obstructs inspection of earlier designs and corrections;
a warm process projection cannot replace stored records.

## Decision

Keep the existing lexical engine and request-scoped PostgreSQL/RLS authority.
Index registered client identity independently of optional DNA. Add feedback and
revision categories, and exact stored copy from requests and revision manifests.
Only named copy fields and text nodes are eligible; arbitrary manifest JSON,
provider metadata, credentials and asset URLs are not a search corpus.

Apply tenant/client scope and normalized OR-token matching in SQL before bounded
history reads. Preserve original text; normalization is for matching only.
Every source with a task/revision must agree with its stored client and task;
contradictory bindings are excluded. Taskless client notes open that client's DNA
page; bound history opens the actual task/revision through the existing strict
Desk navigation contract. Category validation precedes storage access.
Truncated history is explicit. Missing reads refuse the response rather than
using another process's state. No embedding/model call, label creation, learning
promotion, schema migration, dependency or workflow topology is added.

## Required qualification

Keep actual original failures. Verify cold Core reads, no-DNA identity/aliases,
ledger and Studio notes, historical revisions, exact source copy and normalized
Sorani matching, allowed-field-only indexing, correct navigation, taskless notes,
contradictory bindings, unauthorized clients/tenants, category validation and
matching before truncation. Run connected search/retrieval/learning controls,
strict compilation/build/lint and the exact engineering gate. No claim of human
taste calibration, native Canva, deployment or whole-product admission follows.

## Connected evidence

16 actual Core/PostgreSQL history checks and connected five-file42pass/0fail/0skip qualify this slice. Strict696 roots, build/lint and diff checks pass. Original8 failures plus additional instruction/empty-copy reds and introduced build/type failures remain retained. An operator sees peer history while a scoped designer cannot retrieve it via an all-client query. W6_SCOPED_SEARCH_HISTORY_PROOF.json binds source and evidence. Exact clean gate pending; production/native/human/product admission open.

First exact seal14cf1d53 is retained:6890pass/1fail/67skip. The sole failure was an existing Desk test still asserting “matching tasks” after the supported history notice broadened to all matches. Updated its assertion/description; no runtime behavior changed. Expanded6files47pass/0fail/0skip and696 strict roots pass. Corrected exact gate remains pending.

Exact clean seal a3e38867 passes seven engineering stages: 6891 passed / 0 failed / 67 skipped across 689 passed files / 6 skipped; 696 strict roots and 1774 package checks. Mandatory negative-flag refusal passes. Raw production-dump Stage 3 remains skipped: previous automatic approval review requires explicit transfer authorization, still pending. No all-eight qualification, deployment or native/human/product admission claim. W6_SCOPED_SEARCH_HISTORY_GATE_EVIDENCE.json retains actual receipts.
