# R02 — Honest operational health and individual task aging

**Date:** 2026-09-25. **Status:** in progress. This is a focused implementation slice, not G0 admission.

## Behavior changed

- `/v1/integrations/health` separates local configuration from provider reachability and paid verification. A set environment variable now reports `configured`; it does not imply a working provider. The Canva breaker only proves a local failure state, so a closed breaker reports `unknown` until a real check can support more.
- `/v1/health` reports Canva `unverified` after a closed breaker. A configured model with its paid probe disabled or never run reports `unverified`, not `connected`; a scheduled probe older than twice its interval reports `stale` in dependency health. In production, unverified or stale provider status degrades health. The probe's last observed result and time remain visible separately.
- A failed or unavailable funnel query reports `unknown` with null counts rather than inventing an idle zero. An eligible automatic task older than two hours with no Canva binding makes the funnel `stalled` even if another task has a draft. Manual tasks and recent briefs without drafts are `in_progress`, not an outage. Stage timing now reports task-weighted sample counts and p50/p95 for brief→draft, draft→approval, and approval→delivery; zero-sample stages show null durations.
- The funnel GET now returns a readable 200 response for a measured stall and 503 for unknown, with the oldest task ID and a safe inspection action. Hawa Desk shows this status, task age, and stage timing. Reading the funnel no longer sends an unbounded Telegram alert on each refresh.

## Verification

- Focused Core and Desk tests: 6 files, **89 passed** (`/private/tmp/hawdesign-r02-6.log`). These cover unrun paid probe truth, integration-state truth, a stalled automatic task alongside a completed draft, manual-task control, unavailable-DB control, route behavior, and Desk API authentication.
- A clean-commit `pnpm test` on `4636c53` passed **400 files / 3,011 tests**, with 4 files / 48 tests skipped (`/private/tmp/hawdesign-r02-full-suite.log`). Typecheck and blueprint validation passed. The release script passed stages 1–5 and stage 6 database isolation, then stopped at missing remote tracking (`/private/tmp/hawdesign-r02-release-gate.log`); stage 7 was not reached in that script.
- One earlier parallel targeted run failed the health 200 assertion while test databases were being terminated; the same fault-recovery file passed all seven tests isolated. No production conclusion is drawn from that transient run.

## Remaining before R02 acceptance

- Confirm adapter-specific recent reachability and paid-verification receipts through a durable, versioned observation record; do not mark any provider `paid_verified` from configuration or a closed breaker.
- Exercise stale-probe aging under a controlled clock and test operational health with actual representative production observations. Validate stage-duration interpretation against a real cohort and add a deduplicated alert sender if paging is required.
- Run the complete suite and release checks on the final candidate. The branch still has no remote tracking branch, so the seven-stage gate cannot be called green.
