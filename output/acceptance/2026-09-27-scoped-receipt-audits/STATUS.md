# Scoped receipt audit qualification — 2026-09-27

## 2026-09-27 — Durable scoped receipt audits qualified locally (ADR-103)

Source **19627b4**, content/UUID correction **1700682**, tested and deployed
**9cdeb25**. Final full regression: **4139 passed, zero failed, 59 skipped**;
495 passing and 7 skipped files, 124.52 seconds. Source/scripts and all **503**
strict test roots compile. Lint 976/1053, nine existing provider-egress exceptions,
Desk build, security scan and 11-pattern self-test pass; blueprint 1019/0/0.
Affected groups (123/11, 18/3, 40/6 and corrected 31/4) overlap and are not summed.

Fresh matching Core/worker/Desk images have no changed source. The selected
synthetic scenario passes 63 invariants; 43 scenarios remain unselected and two
fake Gemini paths remain unmatched. Actual Chrome passes **27 checks**, including
lost successful response, saved action across reload, exact replay, one original
hashed row, real Core restart, older replay after a newer report, cross-actor and
client-revocation isolation, inactive office refusal, cookie CSRF/header/fixture
refusal, failed-read clearing and 390px field/action/counter bounds. Screenshots
were visually inspected. Both synthetic staff sessions were revoked. No real
provider call or production change.

The first candidate passed 4137 tests and 26 Chrome checks. Its stored audit then
exposed a false filename mismatch: Lifecycle intent uses a stable client-ID prefix
while the archive uses a human-readable client name for identical bytes. The final
comparison matches the hash/size multiset, consuming one receipt per artifact and
refusing missing or surplus copies. The corrected deployed audit flags only the
intentionally damaged synthetic task. A second regression reproduced accepted
uppercase UUIDs causing SQL refusal; action/predecessor IDs now canonicalize before
binding. Original failing tests and first candidate evidence are preserved under
before-content-correction. Other retained failures cover an initially unauthorized
fixture, obsolete assertions, timestamp precision, stale compiled contracts and a
test helper's too-narrow UUID type.

Audits are immutable PostgreSQL snapshots for one actor and exact current client
scope. Reads and append share one serializable transaction, hashes are computed by
SQL, and retry identities bind scope/predecessor/reason. Current RLS hides another
actor or revoked scope; no report is broadcast tenant-wide. Current-revision
receipts cannot be replaced by older design evidence; not-yet-due tasks are counted
separately. Reports remain stored across Core restarts; the Desk retains uncertainty
and exact saved actions, and rejects failed/malformed evidence.

Remaining: full FR-050 scheduled external Drive/Sheets verification and staffed
repair; independent availability monitoring (NFR-002 remains unmeasured); other
typed result recovery; real office/model/Telegram/Workspace/Canva and pending native
after-preview approval; human multilingual/design and held-out quality/retrieval/
cost evidence; independent-host restore and controlled rollout. Whole-app goal
remains active. Health at 2026-09-27T15:27:23Z is still degraded with live provider
checks unverified and design flags off. See R02_SCOPED_RECEIPT_AUDITS_PROOF.json
and runbooks/SCOPED_RECEIPT_AUDITS.md.
