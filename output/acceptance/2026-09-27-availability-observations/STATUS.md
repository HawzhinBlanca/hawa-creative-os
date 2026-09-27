# Independent availability observations — locally qualified, 2026-09-27

ADR-104 / migration 058; NFR-002, FR-064, NFR-006.

Source **c35d6415**; deployed **1f07c9b3**; inventory-only test correction and final full-suite source **684540dd**. Executable Core/Desk/worker/package/collector source is identical between deployment and final full-suite commits.

## Delivered

- Independent Python collector with an exclusively locked FULL-synchronous SQLite transport spool. Durable preclaim, interrupted unknowns, exact retries, bounded transport and no backfill.
- Distinct monitor authentication, rolled-back actual storage witness, all eight workflow registrations and a live worker. No office tasks, approvals, publications, messages or model calls from monitoring.
- Immutable PostgreSQL observations, SQL hashes, cross-language receipt hash verification, current RLS and scope/slot identity conflicts.
- Baghdad monthly coverage, known success ratio, missing/unknown bounds, null provisional compliance and successful readiness-probe latency. Desk refreshes each minute, clears failed evidence and rejects stale or mismatched-month replies.

## Evidence

- **4169 passed, 0 failed, 59 skipped**; 499 passing/7 skipped files; 121.07 seconds. All 507 active strict test roots and source/scripts compile.
- 53 focused tests/9 files and overlapping final UI 9/2; correction 36/2. Python wrapper separately runs **14 controls**, including actual killed process, lost successful response, disk-write refusal, HTTP redirects and byte caps. These are overlapping counts, not an additive total.
- Fresh isolated candidate: **63 selected synthetic workflow invariants**, 43 scenarios unselected; two unmatched fake Gemini paths remain disclosed.
- **26 deployed runtime/Chrome checks**: killed collector after accepted upload, exact original replay; dead worker with persistent registration; actual Core and PostgreSQL outage records retained locally and uploaded once; database hashes; zero retained probe rows; named read/current revocation; historical month unknown; failed-refresh clearing; 390px content/field bounds.
- Desktop/mobile screenshots inspected. Temporary synthetic session revoked. Monitoring added zero model calls and zero office tasks/requests/approvals/outbox commands.
- Lint 975/1053 and 9 existing egress exceptions; production Desk build; zero-secret scan and 11-pattern self-test; blueprint 1025/0/0 before final evidence documentation.

## Failure history

First full suite had 4168 passing tests, one failed route-inventory assertion and 59 skipped. The two monitoring endpoints' eight aliases were absent from the fixture. Corrected fixture passed 36 affected tests, then the full 4169-test run passed. Earlier unused React import, sandbox loopback refusal, constant synthetic credential scan rejection and stale pre-refresh manifest checks are retained in their original logs. No runtime behavior was changed to suppress a failing acceptance assertion.

## Limits and next work

This is a **same-host isolated mechanics qualification with fake providers**. Four real readiness observations across deliberate service outages do not establish monthly production availability. The collector job is not installed on an independent host. It measures sampled readiness, not complete user journeys or creative quality.

Production is unchanged. General health remains degraded: PostgreSQL/Restate connected, live integrations unverified, design flags off. Full FR-050 scheduled external Drive/Sheets reconciliation, remaining result recovery, real Workspace/model/Telegram/Canva and pending native after-preview approval, human multilingual/design and held-out quality/cost evaluation, independent-host restore and controlled rollout remain open. Whole-app goal remains active.
