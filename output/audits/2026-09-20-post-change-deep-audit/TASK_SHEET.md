# Proof-gated next tasks — Hawdesign, 20 September 2026

Companion to REPORT.md and ROOT_RESULTS.json. These are recommended work items, not implementation authorization. Preserve current architecture and unrelated edits. Map the cited requirements to `plans/traceability.csv` before coding. Never call a task complete because its happy-path unit test passes.

## P01 — Secure and bind release identity

F1/F2; FR-074, NFR-012/013/024/025. Validate manifest schema before access, require exact commit syntax, use shell-free subprocess arguments, and bind actual build context/image digests, required source coverage, model configuration and migration set. A self-authored checksum is integrity metadata, not an independent attestation.

Proof: malicious commit field never executes; malformed/old commit, fabricated image/model, omitted component, README-only coverage, source drift, dirty tree and missing evidence all refuse. Include one valid current release control. Test production configuration without `VITEST`; document any exceptions instead of exporting a blanket bypass.

## P02 — Make deployment depend on real normative gates

F2; FR-074 and docs/29 A–H. Compute every status from a current, typed, scope-matching evidence artifact; include NOT_RUN/FAILED/STALE. Do not rename normative gates or hardcode PASS/refusal success. Check the attestation in the actual apply path. Failed SLO evidence must return a failing CLI status too.

Proof: delete, alter, age, or replace each artifact with another candidate's result; fail one requirement; skip each stage; use failed/empty SLO results. Every path refuses before build/apply/provider effects. Restore a legitimate packet and verify the positive control. Preserve failures in reports.

## P03 — Durable publication and identity-safe Sheet writes

F3; FR-047/049/050/060, NFR-014/020. One persisted immutable command/destination hash, execution ownership, reloadable effect receipts and remote reconciliation. Reject changed payload/destination for the same key. Missing checksum/identity is unverified, not success. Resolve explicit Sheet tab identity; avoid positional overwrites during row movement.

Proof: independent worker processes; crash before/after each upload, row write and receipt commit; lost replies; concurrent retries; multi-file partial success; Drive lookup outage; row insertion/sort/move/delete; duplicate IDs; second tab; changed folder; absent checksum. Inspect the isolated remote namespace independently: one logical package and row, unrelated sentinel rows unchanged, durable truthful receipt. No production/customer destinations or paid effects without explicit approval.

## P04 — Exact evaluator semantics and separate live admission

F4; FR-020/021/056/057/058, Gate D. Keep offline/--live refusal intact until a genuinely live dependency graph exists. Exact canonical scoped identities, strict schema/boolean/enum validation, protected fact comparisons and real image input when claiming visual evaluation. Separate scoring calibration from sealed acceptance data.

Proof: same answer naming all clients/projects, sentinels, wrong-but-present identities, missing fields, string booleans, invalid decisions, out-of-range scores and absent image each fail appropriately. Then run an approved live holdout with model/config hashes, all attempts/costs/errors and provider receipts; fake/offline outputs can never confer admission.

## P05 — Exact output-copy contract and native editable acceptance

F5; Gates A/E, NFR-009. Compare all exported logical text blocks to the authorized input, including count/order and extras. Keep input orthography, output text equality, rendered glyph quality and native editor fidelity as separate measurements.

Proof: baseline pass; replacement, appended unapproved claim, omitted/duplicated/reordered block, changed digit/date/URL, wrong asset/font, and flattened text each fail. Reopen/edit/save/export actual current-release native Canva designs. Review Sorani and Arabic with qualified human reviewers; keep identities/ratings genuine, consented and not AI-filled.

## P06 — Complete authoritative scope and governance boundary tests

F6 plus repaired-local controls; FR-017/054/068/069, NFR-006/020. Tenant/client membership must constrain every Studio read/write and provider effect. Persist lifecycle, DNA version and audit state atomically; caches derive from committed state. Define whether metadata belongs in the hashed DNA payload and verify that canonical contract.

Proof: actual `hawa_app` role, populated positive/negative clients and tenants, every relevant principal/stage, revoked access and mismatched URL/task/run. Reproduce missing-client and failed-transaction controls against real isolated PostgreSQL. Two Core processes and restart must agree on versions/rules/snapshots; rejected operations leave all representations unchanged. Authorized SSE receives events; unauthorized/revoked clients receive no bytes.

## P07 — Finish durable notification proof and verify deployment

FR-051/060. Keep repaired local 503 propagation and uncertain receipt classification. Preserve successful provider message identity and make crash-after-acceptance uncertainty visible without automatic unsafe resend. Do not confuse exactly-once durable execution with exactly-once physical delivery.

Proof: actual Restate/production consumer wiring in isolation; transient 503/429, permanent 4xx, malformed/lost success receipt, kill before/after acceptance/ledger commit, then engine/worker restart. No regenerated paid design; eventual delivery or explicit actionable uncertainty. After separately authorized deployment, verify immutable images and exact source/config plus a safe end-to-end smoke check.

## P08 — Whole-office recovery and genuine pilot qualification

F7; Gate H, NFR-025 and human/model gates. Back up and restore PostgreSQL, durable engine state, editable assets, canonical topology, model configuration and recoverable secrets through the intended supported recovery mechanisms. Use independently stored encrypted backups and a clean independent host/failure domain. Start with nonzero unfinished workflows/outbox work.

Proof: timestamped last acknowledged and last recovered business events for real RPO; clock from incident to usable recovered office for RTO; real requests, asset open/edit/export, access positive/negative controls, workflow continuation and independently enumerated effect counts. Run destructive/fault tests only with explicit authorization and isolated scope. Then execute the genuine multi-client operational pilot and blinded, preregistered creative comparison; no global superiority claim from the existing reused fixture set.

## Required completion packet for each task

1. Requirement IDs, exact changed files/commit, source and image/config hashes, and deployed-vs-local status.
2. Reproduction command and environment; full raw stdout/stderr and exit codes, including initial failures.
3. Positive control plus adversarial cases and a mutation showing the test would detect regression.
4. Explicit evidence class: static / injected component / real isolated integration / live provider / human. Never promote one class into another.
5. Test-fixture isolation and cleanup proof; no credentials or personal/customer records in artifacts.
6. Actual observed outcome versus threshold; FAILED, BLOCKED, NOT_RUN and STALE remain visible.
7. Independent replay on the locked candidate and a traceability update. Only then mark the scoped task complete.
