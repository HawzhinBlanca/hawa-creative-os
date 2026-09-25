# R02 — Honest operational health and individual task aging

**Date:** 2026-09-25. **Status:** in progress. This is a focused implementation slice, not G0 admission.

## Behavior changed

- `/v1/integrations/health` separates local configuration from provider reachability and paid verification. A set environment variable now reports `configured`; it does not imply a working provider. The Canva breaker only proves a local failure state, so a closed breaker reports `unknown` until a real check can support more.
- `/v1/health` reports Canva `unverified` after a closed breaker. A configured model with its paid probe disabled or never run reports `unverified`, not `connected`; a scheduled probe older than twice its interval reports `stale` in dependency health. In production, unverified or stale provider status degrades health. The probe's last observed result and time remain visible separately.
- A failed or unavailable funnel query reports `unknown` with null counts rather than inventing an idle zero. An eligible automatic task older than two hours with no Canva binding makes the funnel `stalled` even if another task has a draft. Manual tasks and recent briefs without drafts are `in_progress`, not an outage. Stage timing now reports task-weighted sample counts and p50/p95 for brief→draft, draft→approval, and approval→delivery; zero-sample stages show null durations.
- The funnel GET now returns a readable 200 response for a measured stall and 503 for unknown, with the oldest task ID and a safe inspection action. Hawa Desk shows this status, task age, and stage timing. Reading the funnel no longer sends an unbounded Telegram alert on each refresh.
- The opt-in OpenAI paid probe now writes append-only, schema-versioned observations to PostgreSQL. Each result is tied to a fingerprint of the exact credential and model, so a restart can use a recent matching receipt while a changed key/model, disabled probe, unsupported version, or stale timestamp cannot reuse it. The health and integrations endpoints read this evidence without making a paid call. A successful HTTP response must include a completion receipt with positive token usage before it is called `paid_verified`; raw provider errors and the credential fingerprint are never returned. Production enables the recurring expense only when `HAWA_BILLING_PROBE_ENABLED=on` is set.

## Verification

- Focused Core and Desk tests: 6 files, **89 passed** (`/private/tmp/hawdesign-r02-6.log`). These cover unrun paid probe truth, integration-state truth, a stalled automatic task alongside a completed draft, manual-task control, unavailable-DB control, route behavior, and Desk API authentication.
- A clean-commit `pnpm test` on `4636c53` passed **400 files / 3,011 tests**, with 4 files / 48 tests skipped (`/private/tmp/hawdesign-r02-full-suite.log`). Typecheck and blueprint validation passed. The release script passed stages 1–5 and stage 6 database isolation, then stopped at missing remote tracking (`/private/tmp/hawdesign-r02-release-gate.log`); stage 7 was not reached in that script.
- One earlier parallel targeted run failed the health 200 assertion while test databases were being terminated; the same fault-recovery file passed all seven tests isolated. No production conclusion is drawn from that transient run.
- The new isolated PostgreSQL controls cover an actual scheduled probe with fake provider response, a second Core instance reading the saved result, billing failure overriding success, key/model rotation, disabled probing, controlled-clock staleness, future/unknown-version evidence, a malformed successful HTTP body, and append-only storage. The final focused run passed **6 files / 56 tests** (`/private/tmp/hawdesign-r02-durable-focused.log`); TypeScript and blueprint validation (**741 pass / 0 warn / 0 fail**) passed.
- The first full suite after adding migration 024 had **3,091 passing tests and 4 failures**: two tests pinned the prior migration list, one policy did not hoist its membership check, and the release manifest still described the prior source. The first three were fixed and the focused run passed; the manifest is resealed only after the source commit. This first suite is not a green gate (`/private/tmp/hawdesign-r02-durable-full-suite.log`).

## Remaining before R02 acceptance

- Record durable reachability receipts for Canva, Telegram and other adapters. Their integration items still reflect local configuration and switches; they are not verified by the OpenAI probe.
- Test operational health with representative production observations. Validate stage-duration interpretation against a real cohort and add a deduplicated alert sender if paging is required.
- Run the complete suite and release checks on the final candidate. The branch still has no remote tracking branch, so the seven-stage gate cannot be called green.
