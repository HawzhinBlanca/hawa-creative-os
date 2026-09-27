# Operations qualification — 2026-09-27

## 2026-09-27 — Operations evidence qualified locally (ADR-102)

Source e69ef71, private-cache correction 0172771, mobile correction c0dd9ca, tested and fresh runtime
**d5a5e7d**. Full suite: **4114 passed, zero failed, 59 skipped**,
492 passing and 7 skipped files; 116.94 seconds. All 500 strict test
roots and source/scripts compile; lint 977/1053 with nine existing egress exceptions,
Desk build and security checks pass. Initial 115 affected tests/10 files, 15 selected
reload checks/3 files and 63 cache checks/6 files overlap and are not added together.

Fresh matching Core/worker/Desk images have no changed source. The selected
synthetic scenario passes 63 invariants; 43 scenarios are unselected and
two unmatched fake Gemini paths remain. Chrome passes 27 checks,
including current named PostgreSQL policy controls, retired fixture endpoints,
stored-receipt audit labels, failed reads, active service-worker legacy-cache purge,
no replay of warm private API data offline, and 390px metric/panel/field bounds plus opening and closing failure inspection. Temporary synthetic
session revoked; screenshots visually inspected. No real provider call or production
change. Health at 2026-09-27T14:10:44.403Z remains degraded; live integrations
unverified and design flags off.

The first candidate passed 4113 tests but Chrome exposed private API cache replay.
The corrected service worker caches only public shell/assets and fonts; private API
reads use network/HTTP no-store. The earlier full result is retained for its own
source. Other initial failures included missing synthetic test authority, a retired
button assertion, selected accounting details hidden by reload order, and a browser
assertion that needed to distinguish authentication stream tickets from operational
mutations. Screenshot review then found mobile cards/actions clipped by inner grids despite a passing document-width assertion. A stronger element-bounds check reproduced that failure. Responsive grids, labelled failure cards and a viewport-bounded inspection dialog correct it; 44 affected Desk tests and production build pass. The final browser check opens and closes the actual inspection. The first final regression hit the tracked-output integrity guard because the harness wrote its log to a tracked path during testing; the complete rerun uses a temporary log copied only after completion. The full-page mobile capture repeated viewport tiles, so actual scrolled viewport images provide the inspected evidence. All failure and correction evidence remains recorded.

Operations no longer presents fixture benchmarks or seeded monthly balances as
production evidence. Missing availability/latency remains null; spending uses the
existing named daily policy and original paid-call ledger. Failed/malformed reads
clear stale results, and late older replies cannot replace newer evidence. Audits
show their real basis, timestamp and anomalies without claiming external repairs.

Remaining: independent durable availability monitoring (NFR-002 still unmeasured),
durable scope-bound audit history and external storage verification; other typed
result recovery; live office/provider/native Canva and pending after-preview
approval; human multilingual/design and held-out quality/retrieval/cost admission;
independent-host restore and controlled rollout. Whole-app goal remains active.
See R02_OPERATIONS_EVIDENCE_PROOF.json and runbooks/OPERATIONS_EVIDENCE.md.

