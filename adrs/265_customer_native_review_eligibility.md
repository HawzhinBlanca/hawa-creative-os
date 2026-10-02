# ADR265 — Customer review of current native files

Date: 2026-10-02. Status: selected; implementation qualification pending.
Requirements: FR-029/032 (docs/05_CREATIVE_ENGINE.md), FR-043
(docs/11_QA_RTL_MULTILINGUAL.md), FR-069 (docs/14_SECURITY_THREAT_MODEL.md),
NFR-006/008/011/015 (MASTER_SPEC.md). ADR256/259–264 remain binding.

## Decision

Use a separate customer review eligibility boundary before customer acceptance
and downloads. A captured preview does not establish current native state or
editable export quality. The existing publication verifier requires a staff
approval; borrowing that approval would misattribute the customer's decision.

A narrow app-only database function resolves live ownership and grants, current
request/task/primary binding, exact reviewed PNG, paired PPTX/native capture,
current revision's latest QC, imported editable source and frozen checking policy.
Pending customer actions withhold readiness. The active brand version must match
the immutable creation brief; a brand change cannot inherit old capture eligibility.
It returns bounded bytes only on an explicit review check. Metadata rechecks
avoid returning file bytes. Customer and worker raw native-table permissions
stay closed. Current exact requester copy remains authoritative.

Core rehashes all bytes, parses the PNG and PPTX, reapplies requested dimensions and copy/font/direction
checks and compares source pictures/logo. Unmeasured or pending native RTL review
cannot qualify. It then reads Canva's version through the capture's existing
server-side actor connection, outside the database transaction, and rechecks live
scope and the entire canonical evidence fingerprint before reporting readiness.
No provider ID, actor, URL, source text, credential or raw QC diagnostics crosses
the customer API. Two complete checks may run concurrently.

Readiness is an observed snapshot. Canva updated_at has second precision and
cannot guarantee absence of every same-second edit. A subsequent acceptance and
each download must repeat the freshness check and bind the reviewed preview,
source/export hashes and current evidence fingerprint. This slice does not issue
an approval, change workflow state, publish, waive QA or enable public generation.

Customer acceptance will be an independent append-only, attributable canonical
RequestLifecycle action. It must never fabricate staff approval or office delivery.
A later task/revision/binding/capture/policy change invalidates its eligibility.
The customer UI may display a ready check only for the exact current preview;
selection changes or failed checks clear it. Browser cancellation is not evidence
that a server check or later action did not happen.

## Qualification

Actual restricted-role database and mounted HTTP controls, native transport
controls and website stale-response/cancellation tests are required. Synthetic
fixtures do not qualify hosted customers, Canva native language quality or launch.
Results and original failures will be recorded in CUSTOMER_REVIEW_PROOF.json.
