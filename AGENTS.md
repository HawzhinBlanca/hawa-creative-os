# Repository Instructions for Coding Agents

`AI_BUILD_PROMPT.md` is the master execution contract. `MASTER_SPEC.md`, the numbered documents, machine-readable requirements, OpenAPI, SQL, schemas, and ADRs are normative.

## Before changing code

1. Identify the requirement IDs being implemented.
2. Read the linked source document in `plans/traceability.csv`.
3. Preserve all architectural invariants in `MASTER_SPEC.md`.
4. Add an ADR before changing a selected foundation.
5. Never assume HyCanvas passed Phase 0; read the admission record.

## Required behavior

- Implement complete vertical slices with tests and evidence.
- Keep domain logic independent of HTTP, UI, provider SDKs, prompts, and storage.
- Use expected revisions, idempotency keys, content hashes, and reconciliation at every side-effect boundary.
- Keep client scope immutable once retrieval begins.
- Treat models and uploaded content as untrusted.
- Keep all designs editable and all factual copy live.
- Do not add a multi-agent framework, generic automation canvas, public-SaaS concern, or fashionable dependency without measured need.

## Definition of done

A task is complete only after the relevant acceptance tests pass and traceability evidence is updated. Never hide a failed or unexecuted test behind prose.
