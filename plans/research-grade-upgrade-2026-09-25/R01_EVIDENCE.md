# R01 — Release failure triage and intake boundary

**Date:** 2026-09-25. **Status:** in progress; full seven-stage release gate has not passed.

## Baseline and diagnosis

The 2026-09-25 baseline in `output/audits/2026-09-25-architecture-design-reality/REPORT.md` recorded 9 failed tests in 4 files, with 2,991 passing. A fresh focused replay found 8 failures: `core.test.ts`, `delivery-notification.test.ts` and `r07-outbox-terminal-state.test.ts` expected passive Telegram text to create tasks; the earlier Kurdish failure did not reproduce. The contract in `docs/09_MESSAGING_AND_OFFICE_INBOX.md` says imported group messages default to `MESSAGE_ONLY`. The shared `evaluateIngressIntent` knew this, but the actual Telegram webhook bypassed it and could promote ordinary text through the model or a permissive fallback.

## Repair at commit `ddf7c50`

- Explicit design briefs replaced passive strings in tests whose purpose was deduplication, delivery or terminal outbox behavior. A FastPay group-generation fixture now uses `/task`.
- The Telegram route records passive group updates as durable inbox events before media downloads or model calls, and requires explicit command/prefix for a new group task. Replays acknowledge the same event. Unknown task IDs quoted in group replies cannot fall through to a new brief.
- Very short unstructured private-chat text is handled deterministically before a model call. The guard preserves named clients, event indicators, structured briefs, design requests, Sorani conference text and actual revision directives.
- A tracked-output test stopped counting untracked temporary art created by unrelated concurrent tests. Its assertion remains about tracked output files.

## Verification and limits

- Focused original/adjacent tests: 4 files, 85 passed before the durable replay case was added; `core.test.ts` then passed 32 tests including passive group, explicit promotion, replay, and forged-reply controls.
- A full-suite exploration found 6 additional failures; 5 affected files passed all 39 tests after correcting the guard and fixture. `pnpm typecheck` passed, including tests.
- `scripts/enforce_release_gate.sh` passed stages 1–4 on `ddf7c50`, then refused at stage 5: `RELEASE_MANIFEST.json` still names old commit `f3d3cbb7...` and branch `claude/reliability`. The new branch also has no remote tracking and would fail stage 6. The gate did **not** run stage 7; R01 is not accepted. See `/private/tmp/hawdesign-r01-release-gate.log` on the working host.
- The approval fixture now uses `/task`. After stamping the research branch manifest at `5eea852`, a clean-commit `pnpm test` run passed **400 files / 3,007 tests**, with 4 files / 48 tests skipped (102.06 seconds). The seven-stage release script passed stages 1–5; stage 6 passed its production database isolation check and then stopped because this local branch has **no remote tracking branch**. Stage 7 was not reached in that script. The full release gate is therefore still open. Brief interpretation outside the group gate also needs the broader human false-positive/false-negative evaluation in G1/G6.
