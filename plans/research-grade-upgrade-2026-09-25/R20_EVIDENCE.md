# R20 — Model egress and execution-truth slice

**Date:** 2026-09-25. **Status:** in progress. **Source:** `3364a21` on `codex/research-grade-design-system`. **Requirements exercised:** FR-056, FR-065, FR-066, FR-067, NFR-007. Linked contracts: `docs/07_MODEL_REGISTRY_AND_EVALUATION.md`, `docs/14_SECURITY_THREAT_MODEL.md`, `MASTER_SPEC.md`.

## Failure and change

Three new negative tests first failed. A policy-governed request whose only allowed cloud provider had no credentials returned a synthetic success labeled with that cloud model. An empty allowlist acted like permission to try every provider. The embedding and reranking adapters returned fixed vectors/scores while claiming Qwen invocations. Those are false execution and quality receipts.

The gateway now rejects an empty provider allowlist, filters every fallback candidate against an explicit allowlist, skips cloud candidates without credentials, and permits deterministic fallback only as an identified local deployment. Cloud candidates cannot silently execute the local heuristic and keep a cloud label after an empty response. The unwired embedding and reranking methods return `LOCAL_MODEL_UNAVAILABLE` rather than fabricated results. The old resilience tests use explicit fake provider HTTP responses, so their provider, attempt, circuit and cost assertions still exercise the real dispatch path; production source has no `NODE_ENV` test branch.

The repository egress linter scans `apps/*/src` and `packages/*/src`, detects literal provider endpoints and direct SDK imports, and no longer skips a production file merely because its name contains `test` or `fixtures`. Its regression tests prove these cases. Nine existing direct-call files remain explicit exceptions, so a passing lint is a migration ratchet, not proof that all calls use one policy.

## Verification

- Initial focused negative run: **3 failed / 1 passed**; it showed the fabricated cloud result, empty allowlist escape and fabricated local model calls. The full suite then found and rejected a test-only production branch; that branch was removed.
- Focused controls passed **4 files / 24 tests**, including the no-test-backdoor control. The full suite passed **408 files / 3,073 tests** with **4 files / 48 tests skipped**. After that full run, the commit security hook required only a fake-key construction change in a test; the two affected gateway test files were rerun and passed **17 tests**. No production code changed after the full run.
- Application and script TypeScript checks passed. Egress lint passed with **9 named existing exceptions**. Blueprint validation passed **739 checks / 0 warnings / 0 failures** after manifest refresh. The commit security scan passed.
- Network-negative tests spy on `fetch` for policy-governed text, image metadata and audio metadata. They show zero external requests through `ResilientModelGateway`; they are **not** a seeded end-to-end task with real photo and voice ingestion.

## Admission limits and next proof

R20 is **not accepted**. `KurdishVoiceTranscriber` can call OpenAI directly during Telegram media intake before a verified client egress policy is resolved. Direct calls also remain in the planner, classifier, image generator, Studio client and Core health/settings probes. The nine linter exceptions must be migrated or sharply classified as non-task probes. The gateway's `budget.maxCostUsd` has no reliable reservation or post-call enforcement, and the fallback registry is not yet a per-client admitted model/prompt/schema decision. Image and evaluation calls have not been proven to share the same typed scope/data-class/budget authorization. Local embedding/reranking availability now fails truthfully; an actual admitted adapter and measured relevance study remain to be built.

The next R20 slice should establish a scope-bound authorization object before each task egress, including voice, image and evaluations; move direct calls behind registered adapters; and run a seeded local-only text/photo/voice task under network-deny instrumentation. No production flag, deployment or external provider call was used for this slice.
