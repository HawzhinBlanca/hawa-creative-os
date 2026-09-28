# ADR-041: Preserve missing QA as missing on non-approval decisions

**Date:** 2026-09-25  
**Status:** Accepted for the research-grade branch; no production migration applied.  
**Requirements:** FR-041, FR-044, FR-060, NFR-020; R08 and R18 in `plans/research-grade-upgrade-2026-09-25/WORK_ITEMS.csv`.

## Context

`review_requests.qc_run_id` and `approvals.qc_run_id` were non-null. A reviewer could request a revision before any QA run existed, so `RevisionRepository.recordApproval` inserted a `failed` `qc_runs` row with an empty report merely to satisfy those columns. The row looked like an actual QA result. Code inspection identified this path. A Canva lifecycle test cannot prove missing QA: its draft bridge already records a real failed check before the office decision.

## Decision

Make `qc_run_id` nullable on review requests and decisions. A revision request, rejection or escalation may reference the latest actual QA run or record `null` when none ran. An `approved` decision still requires a real, latest, passing critical QA run, and a database check forbids an approved row without its QA ID. The application must never create a QA run as a side effect of a human decision.

Existing synthetic historical QC rows are retained as historical records; this migration does not guess which were fabricated or rewrite append-only approvals. Reports should treat unverified older QA provenance cautiously.

## Why

The decision ledger must distinguish “not run” from “run and failed.” A reviewer can ask for a change without a QA result, but approval cannot bypass verified QA. Nullable evidence expresses that difference without inventing an event.

## Consequences

Readers of non-approval decisions must accept a null QA ID. A direct revision with no QA can record an honest missing state; the Canva draft bridge still attaches its actual check. Production still needs migration verification, full approval/capture binding and later decision/cutover evidence before admission.
