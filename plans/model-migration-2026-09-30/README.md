# Sol 6.1 migration and Jev review — 2026-09-30

Requirements: FR-056–060, FR-062, FR-079. Decision: [ADR-148](../../adrs/148_sol61_candidate_and_jev_capability_review.md).

## Current follow-up

Sol access is available using the same key. Native image counting, durable reservation evidence and transport-free retained replay are implemented under [ADR-149](../../adrs/149_sol61_native_image_token_counting.md). Two image/schema cases and a matched two-brief layout screen passed. All12 prepared candidates pass hard QA; this small screen is not creative admission. Production stays on Astra/Mini pending the200-task corpus, native/blinded human review and staged canary.

See FOLLOWUP_VERIFICATION.json, FOLLOWUP_NOTES.md and MATCHED_SCREEN.json. Initial evidence below is retained with its original date/state.

Reproduce only after `pnpm build`:

```sh
pnpm exec tsx scripts/experiments/sol61-vision-smoke.ts
pnpm exec tsx scripts/experiments/sol61-layout-comparison.ts
```

Saved successful responses are reused; unresolved admitted requests or failed results are held. Do not delete receipts to trigger retries. The local sample gallery is layout-comparison/REVIEW.html.

## Initial preparation checkpoint (historical)

Candidate implementation is prepared for text dispatch on the development/evaluation tier;
production model selection has not changed. No paid request, deployment, provider grant,
customer-data transfer or production task was made by this work.

The owner authorized reuse of the existing OpenAI key. The read-only authenticated
probe confirms model catalog200, Sol missing and retrieval404; Astra retrieval200.
See ACCESS.json. Exit2 means blocked access, not a successful qualification.

Jev current stable `jev-1.13.0` is explicitly text only in its official catalog;
it is ineligible for the existing visual judge/parity role. No Jev integration or new key is needed.
Source: https://docs.typesafe.ai/models and https://docs.typesafe.ai/concepts/state (read 2026-09-30).

Sol standard pricing, cache handling, long-context pricing, reasoning defaults and
candidate text reservation are implemented. Its official model card documents vision,
but the current official vision sizing guide omits Sol 6.1's sizing/multiplier entry.
Images refuse reservation before dispatch; inventing an Astra-equivalent bound would
make this preparation unsafe. This is a stated remaining implementation gate.

## Reproduce the access check (now appends access-history receipts)

From the repository root after owner key-reuse authorization:

```sh
pnpm exec tsx scripts/experiments/sol61-access.ts
```

This sends only authenticated model metadata reads to OpenAI and writes safe evidence.
It prints no credential, provider error body, prompt or image. No paid calls are made.

## Initial remaining gates (historical)

1. Enable Sol 6.1 access for the existing OpenAI API project/account; changing a Codex chat model does not enable application API access.
2. Qualify model-specific image budgeting and actual schema+image behavior.
3. Compare the same briefs/assets/fonts/copy against Astra: exact facts, hard QA,
   seeded visual defects, Sorani, actual usage/latency and blinded human judgment.
4. Pass FR-057 offline and human-reviewed 5%/25% canary gates before primary selection.

Neither code tests nor model marketing establish better design accuracy or speed.
The production release and historical tournament receipts are not resealed as Sol evidence.

## Verification

Results are recorded in VERIFICATION.json. Initial 71/73 pass, two failures because
workspace package aliases loaded stale built domain output. After `tsc -b`, all
focused tests passed. The original failed log is retained as tests-initial.log.
