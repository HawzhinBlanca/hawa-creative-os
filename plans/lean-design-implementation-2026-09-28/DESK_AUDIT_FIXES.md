# Product audit repairs — 29 September 2026

## Scope and status

Implements the actionable findings in `output/audits/2026-09-29-product-flow/REPORT.md` on `codex/research-grade-design-system`, base `a7a29c7a`. Locally qualified; not deployed. No foundation or provider change, migration, new dependency or model call.

Requirements: FR-006 (Desk intake), FR-063 (actionable operational state), FR-064 (operations), FR-076 and NFR-021 (keyboard, contrast and semantic accessibility). Read linked messaging, reliability, editable-document and master-spec contracts before editing. Existing Canva-only and one-owner invariants remain applicable.

## Findings addressed

1. **Task entry / stopped preview:** the old `56081` endpoint has no running listener and returns no HTTP response. Existing local deployment `8080/v1/health` returns HTTP 200. The user's old tab now opens the running app and visibly requests sign-in. No navigation rewrite was needed: the current compiled App opens Work Desk and New task in a fresh isolated browser session. Regression coverage confirms routes and form opening after Core becomes unavailable, retains draft content, blocks save when client authority cannot be read, and offers client-list retry. The stale session's original click failure cannot be attributed solely to a particular JavaScript defect.
2. **Narrow navigation:** all four destinations use a two-column wrapping grid below 900px. At the audit's 314px width, measured navigation clientWidth and scrollWidth are both 294px. Touch controls are at least 44px in the repaired header, Operations and dialogs. The task modal is bounded by viewport width/height with internal scrolling.
3. **Operational priority:** actual failures and their recorded reasons appear before summary counts, progress and budget panels. Empty results are explicitly labelled as a snapshot with no reported failures. Removed the unhelpful invariant-number text from each failure row.
4. **Freshness:** Operations refreshes each minute while visible and on return to the tab, clears prior counts during a new read, rejects late results, and labels the snapshot with a full timestamp. Progress explicitly describes workflow timeliness separately from live availability. Failed reads remain unknown.
5. **Useful duration precision:** Core retains fractional-hour percentiles. The UI formats seconds, minutes and hours; null is unknown and sub-second values use <1s. A real isolated PostgreSQL test verifies a 30-second transition remains 30/3600 hours for both percentiles.
6. **Recovery guidance:** the reliability panel has its own retry and explains that local drafts remain available while saving/review require Core. Publication-audit text now describes saved delivery records in user language.
7. **Accessibility:** removed Operations' duplicate h1; gave search a persistent translated accessible name; connected English and Sorani copy labels to their fields; replaced low-contrast language/stream/tour colors with existing bright dark-theme tokens; made dark placeholders use the muted token and supplied the missing --text alias. White text on the primary button was 4.10:1 and is now 5.93:1 using source color calculation (see contrast.json). This is targeted evidence, not a full WCAG certificate.

## Verification

- 9 connected test files: **61 passed, 0 failed, 0 skipped** (includes isolated PostgreSQL and React DOM tests).
- Source TypeScript build and scripts typecheck pass; all 588 active test roots compile.
- Desk production build passes; main JavaScript chunk 481.99 kB before gzip, under the existing 500 kB budget.
- Blueprint validation: **1199 passed, 0 warnings, 0 failures** on an exact copy of included specification files; excluded dependency/worktree directories were linked instead of recursively traversed. The original unpruned scan was explicitly interrupted after several minutes. No validator checks were disabled.
- Any ratchet: 966/1053; provider egress check passes with 9 existing exceptions. Secret scan: zero findings, 48 justified existing allowlist hits.
- Browser: current compiled assets, synthetic read-only HTTP fixture server, no external/provider connections; Work Desk navigation and New task dialog work; all navigation labels fit at 314px; English/Sorani textareas have accessible names; Shift+Tab wraps from first field to Cancel, Escape closes and restores focus to New task.
- Screenshots: desktop Operations, narrow navigation, bounded task form. Viewport override was reset afterward.
- Initial checks exposed two test-harness mistakes (case-sensitive New Task lookup on Operations; wrong reliability route), plus fixture tenant provisioning/cleanup permissions. Corrected the fixtures and reran the final set. An attempted ESLint command was unavailable; the repository's actual TypeScript/ratchet/egress/security gates were used.


## Browser artifacts

The current-run report is `output/audits/2026-09-29-product-flow-fixes/REPORT.md`: local evidence, not in git (the directory is git-ignored, so a clean checkout does not have it). Local UI and isolated-database qualification only; not deployed. Live sign-in and full release/office qualification remain open.

## Release follow-up — 29 September 2026

Source bcbc6078 and seal 862d1934 passed release stages 1–7, including all 588 typed test roots and the migration/invariant rehearsal on a production-dump copy. The full suite returned 4,919 passed, 1 failed, 64 skipped: desk-auth.test.ts retained the previous publication-audit notice wording. Updated that exact-text assertion to the new equivalent notice; all 29 tests in the file then passed. Disabled-action and tenant-onboarding safeguards remain asserted. The failed run is retained at output/audits/2026-09-29-product-flow-fixes/full-suite-first.log. Final full release verification is still required.

The normal specification validator now runs directly in the checkout and passes 1,203 checks, zero warnings/failures, after the separately tested traversal repair described in VALIDATION_TRAVERSAL.md.
