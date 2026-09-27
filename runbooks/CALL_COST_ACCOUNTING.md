# Exact-call accounting

Applies to ADR-097, migration 053, FR-059/060/062/065/079 and NFR-001.

## Review and record

1. In Desk **Operations → Call cost accounting → Review call costs**, locate the
   exact Studio, evaluation or voice call. Older calls use the next page. Original
   unknown cost is shown as **Unknown**, never as a zero invoice.
2. Review its original outcome, provider reference and existing accounting history.
   Retain a final provider receipt or support confirmation in the office evidence
   archive. A timeout or request ID alone does not establish the final cost.
3. Sign in as a current named office administrator. Enter the known final charge,
   provider conclusion, reference, evidence SHA-256 and reason. The optional file
   picker calculates the digest locally; it does not upload the evidence file.
4. Record the evidence. The action UUID and full request are retained in session
   storage before submission. After a lost response, retry **the saved action**.
   Authentication and availability errors retain it; a checked stale-snapshot or
   contradictory-evidence refusal permits correction after reloading.
5. Confirm the new attributed revision and the separate original/attested/accounted
   amounts. Corrections append another revision. A previously recorded higher cost
   continues to count; a lower correction is not a write-off authority.

## Meaning and limits

Terminal evidence releases unused reserved funds, including prior-day obligations.
Per-run Studio and shared office/client/role admission include the retained maximum.
An overrun still triggers its existing pricing/budget hold. A late original receipt
changes the observed snapshot and can expose a disagreement or higher charge.

Accounting never repeats a provider call, restores a lost response, closes a run,
changes an evaluation result or approves a design. Studio/evaluation execution
holds still use their existing stopped-run settlement controls. Voice keeps its
original-source/manual-copy path and never dispatches another attempt on replay.
Unknown costs remain held until terminal evidence is available. Missing entire
historical ledger rows cannot be repaired by inventing a call or a receipt here.

These are named administrator attestations, not automated invoice verification.
Live provider billing, policy administration and typed completed-result recovery
require their separate qualification.

## Verification

Run the accounting Core and Desk tests, shared-office spending tests, existing
Studio/evaluation settlement tests and Studio budget domain tests. Evidence is
retained under `output/acceptance/2026-09-27-call-cost-accounting/`; qualification
status is recorded in `R21_CALL_COST_ACCOUNTING_PROOF.json` when checks finish.
