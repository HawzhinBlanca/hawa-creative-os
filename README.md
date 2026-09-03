# Hawa Creative OS

**Private, office-owned AI creative operations system**  
Specification version: **1.0.0**  
Research freeze: **2026-09-03**

This repository-ready package defines the system that converts messages and office requests into **editable, client-aware, quality-gated graphic designs**, then routes approvals, publishes to Google Drive, updates Google Sheets, and learns from governed feedback.

It deliberately rejects the generic pattern of “Slack + SaaS workflow + flat image generator.” It is centered on an office-owned inbox, an open editable design document, durable execution, direct model adapters, and replaceable components.

## Final recommendation

> Build **Hawa Desk + Restate + PostgreSQL Client DNA + a pinned HyCanvas studio + an Editable-Design-style creative runner + ComfyUI asset workflows + Phoenix evaluations**, with Telegram and optional WAHA as adapters and Google Drive/Sheets as publication targets.

## Non-negotiable caveat

HyCanvas is the strongest current fit discovered, but it is a young v0.x project. It is **not accepted into live production by this document alone**. Phase 0 must prove real-browser Sorani/Arabic layout, `.hyc` round trips, export parity, API/MCP control, interruption recovery, and migration safety. The surrounding architecture remains valid if the studio is replaced.

## Start here

1. [`DECISION_SUMMARY.md`](DECISION_SUMMARY.md)
2. [`MASTER_SPEC.md`](MASTER_SPEC.md)
3. [`docs/00_EXECUTIVE_VERDICT.md`](docs/00_EXECUTIVE_VERDICT.md)
4. [`docs/21_HYCANVAS_PROOF_SPRINT.md`](docs/21_HYCANVAS_PROOF_SPRINT.md)
5. [`AI_BUILD_PROMPT.md`](AI_BUILD_PROMPT.md)
6. [`AGENTS.md`](AGENTS.md)
7. [`DOCUMENT_INDEX.md`](DOCUMENT_INDEX.md)

## Package guarantees

- Requirements and acceptance criteria are traceable.
- Side effects have idempotency rules.
- Editable design is a hard requirement.
- Client isolation is enforced before retrieval.
- Model/provider changes require evaluation and canary rollout.
- Every dependency with material architectural risk has a fallback.
- The package contains schemas, SQL, API contracts, prompt contracts, test matrices, wireframes, deployment examples, and runbooks.

## What this package does not claim

It does not claim the application has already been built or that repository CI proves Sorani rendering. It is a complete build specification and verification system. The executable proof sprint and acceptance gates determine whether each component is admitted.
